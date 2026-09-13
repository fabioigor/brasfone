/**
 * Cont.ai MCP server (stdio).
 *
 * Exposes the Cont.ai pipeline and the CentralGest integration as MCP
 * tools, so an AI agent can receive documents, review the proposed entries
 * and post them into CentralGest automatically. Writing to CentralGest goes
 * exclusively through the deterministic, idempotent dispatcher: the same
 * entry can never be posted twice.
 *
 * Run: npm run mcp   (from apps/contai)
 * Env: DB_PATH, STORAGE_ROOT, CENTRALGEST_BASE_URL + CENTRALGEST_API_KEY,
 *      or CENTRALGEST_MOCK=1 for the local simulator.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { openDb, Db } from "../db.js";
import { seedDemo } from "../seed.js";
import { buildProvider } from "../ai/provider.js";
import { ingestDocument, reprocessDocument } from "../pipeline.js";
import { OcrEngine, DocumentOcr } from "../ocr/engine.js";
import { buildStructuredExtractor } from "../extraction/analyse.js";
import { learnFromApproval } from "../domain/supplierMemory.js";
import { normaliseAddress } from "../channels/inbound.js";
import { isBalanced, EntryLine } from "../domain/entries.js";
import {
  CentralGestClient,
  CentralGestError,
  dispatchApprovedEntries,
} from "../integrations/centralgest.js";
import { startCentralGestMock } from "../integrations/centralgest-mock.js";
import { auditStoredDocument } from "../domain/vatAudit.js";
import { parseBalanceCsv, deriveBalanceFromEntries, saveTrialBalance, loadTrialBalance, previousPeriod, computeFinancials } from "../domain/trialBalance.js";
import { listRules, evaluateRules, persistBalanceFindings } from "../domain/balanceRules.js";
import { buildReportData } from "../domain/financialReport.js";
import { renderReportHtml } from "../domain/reportHtml.js";
import { knowledgeStatus, loadVatRules } from "../knowledge/index.js";
import { AgentGateway } from "../ai/agents.js";

interface McpContext {
  db: Db;
  storageRoot: string;
  centralgest: CentralGestClient | null;
  ocr?: OcrEngine;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", tif: "image/tiff", tiff: "image/tiff", txt: "text/plain", csv: "text/csv", xml: "application/xml", json: "application/json",
};
const mimeFor = (name: string) => MIME_BY_EXT[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ erro: message }) }],
  isError: true,
});

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "contai", version: "0.3.0" });
  const { db, storageRoot } = ctx;
  const provider = buildProvider();
  const agents = new AgentGateway();
  const ocr = ctx.ocr ?? DocumentOcr.fromEnv();
  const structured = buildStructuredExtractor();

  const requireCentralGest = (): CentralGestClient => {
    if (!ctx.centralgest) {
      throw new CentralGestError(
        "CentralGest nao configurado. Defina CENTRALGEST_BASE_URL e CENTRALGEST_API_KEY (ou CENTRALGEST_MOCK=1 para o simulador local) e reinicie o servidor MCP."
      );
    }
    return ctx.centralgest;
  };

  server.registerTool(
    "contai_estado",
    {
      title: "Estado do Cont.ai e da ligacao CentralGest",
      description:
        "Devolve contagens de documentos e lancamentos por estado e testa a ligacao ao CentralGest (lista de empresas remotas). Use primeiro para perceber o que ha por fazer.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const documents = db.prepare("SELECT status, COUNT(*) AS n FROM documents GROUP BY status").all();
      const entries = db.prepare("SELECT status, COUNT(*) AS n FROM entries GROUP BY status").all();
      const dispatches = db.prepare("SELECT status, COUNT(*) AS n FROM dispatches GROUP BY status").all();
      let centralgest: unknown;
      if (!ctx.centralgest) {
        centralgest = { configurado: false };
      } else {
        try {
          const empresas = await ctx.centralgest.listCompanies();
          centralgest = { configurado: true, ligacao: "ok", empresasRemotas: empresas };
        } catch (e: any) {
          centralgest = { configurado: true, ligacao: "erro", detalhe: e.message };
        }
      }
      const ocrEngines = ocr instanceof DocumentOcr ? ocr.engines : ["personalizado"];
      return ok({ documentos: documents, lancamentos: entries, despachos: dispatches, centralgest, ocr: { motores: ocrEngines } });
    }
  );

  server.registerTool(
    "contai_listar_empresas",
    {
      title: "Listar empresas clientes",
      description:
        "Lista as empresas clientes do gabinete com NIF, regime de IVA e codigo CentralGest (necessario para lancar).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rows = db
        .prepare("SELECT id, name, nif, vat_regime, centralgest_code FROM companies ORDER BY name")
        .all();
      return ok({ empresas: rows });
    }
  );

  server.registerTool(
    "contai_definir_codigo_centralgest",
    {
      title: "Definir codigo CentralGest de uma empresa",
      description:
        "Associa uma empresa cliente ao seu codigo de empresa no CentralGest. Sem este mapeamento nao e possivel lancar documentos dessa empresa.",
      inputSchema: {
        company_id: z.number().int().positive().describe("Id da empresa no Cont.ai"),
        centralgest_code: z.string().min(1).describe("Codigo da empresa no CentralGest, ex.: PADARIA"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ company_id, centralgest_code }) => {
      const r = db
        .prepare("UPDATE companies SET centralgest_code = ? WHERE id = ?")
        .run(centralgest_code.trim(), company_id);
      if (r.changes === 0) return fail(`Empresa ${company_id} inexistente. Use contai_listar_empresas.`);
      return ok({ company_id, centralgest_code: centralgest_code.trim() });
    }
  );

  server.registerTool(
    "contai_listar_documentos",
    {
      title: "Listar documentos",
      description:
        "Lista documentos recebidos, com tipo, estado (recebido|classificado|proposto|validado|exportado|rejeitado), confianca e dados extraidos.",
      inputSchema: {
        company_id: z.number().int().positive().optional().describe("Filtrar por empresa"),
        status: z
          .enum(["recebido", "classificado", "proposto", "validado", "exportado", "rejeitado"])
          .optional()
          .describe("Filtrar por estado"),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company_id, status, limit }) => {
      let sql =
        "SELECT d.id, d.company_id, c.name AS empresa, d.original_name, d.doc_type, d.doc_date, d.status, d.classification_confidence, d.extracted_json FROM documents d JOIN companies c ON c.id = d.company_id WHERE 1=1";
      const params: any[] = [];
      if (company_id) {
        sql += " AND d.company_id = ?";
        params.push(company_id);
      }
      if (status) {
        sql += " AND d.status = ?";
        params.push(status);
      }
      sql += " ORDER BY d.created_at DESC LIMIT ?";
      params.push(limit);
      const rows = (db.prepare(sql).all(...params) as any[]).map((r) => ({
        ...r,
        extracted: r.extracted_json ? JSON.parse(r.extracted_json) : null,
        extracted_json: undefined,
      }));
      return ok({ documentos: rows });
    }
  );

  server.registerTool(
    "contai_processar_documento",
    {
      title: "Processar um documento (classificar e propor lancamento)",
      description:
        "Recebe um documento (caminho de ficheiro local PDF/imagem/texto, OU conteudo em texto), extrai o texto (camada de texto do PDF, ou OCR para digitalizacoes e imagens), arquiva-o, classifica-o, confere-o e, se aplicavel, gera a proposta de lancamento SNC. Devolve tipo, id do lancamento, alertas e metodo/confianca do OCR. Duplicados (mesmo conteudo) sao detectados e nao criam nada.",
      inputSchema: {
        company_id: z.number().int().positive().describe("Empresa a que o documento pertence"),
        file_path: z.string().optional().describe("Caminho absoluto de um ficheiro local a processar (PDF, PNG, JPG, TXT, CSV, XML)"),
        content: z.string().optional().describe("Alternativa: conteudo textual do documento"),
        filename: z.string().optional().describe("Nome do ficheiro quando se usa 'content', ex.: factura.txt"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ company_id, file_path, content, filename }) => {
      let buffer: Buffer;
      let name: string;
      if (file_path) {
        if (!fs.existsSync(file_path)) return fail(`Ficheiro nao encontrado: ${file_path}`);
        buffer = fs.readFileSync(file_path);
        name = path.basename(file_path);
      } else if (content) {
        buffer = Buffer.from(content, "utf8");
        name = filename || "documento.txt";
      } else {
        return fail("Indique file_path ou content.");
      }
      try {
        const outcome = await ingestDocument(db, provider, storageRoot, {
          companyId: company_id,
          uploaderId: 1,
          originalName: name,
          mimeType: file_path ? mimeFor(name) : "text/plain",
          buffer,
          channel: "portal",
        }, ocr, structured);
        return ok(outcome);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "contai_listar_lancamentos",
    {
      title: "Listar lancamentos",
      description:
        "Lista lancamentos contabilisticos com as linhas SNC (conta, debito, credito), confianca e estado (pendente|aprovado|rejeitado|exportado). Os pendentes aguardam decisao; os aprovados podem ser lancados no CentralGest.",
      inputSchema: {
        status: z.enum(["pendente", "aprovado", "rejeitado", "exportado"]).default("pendente"),
        company_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, company_id, limit }) => {
      let sql = `SELECT e.id, e.company_id, c.name AS empresa, e.entry_date, e.journal, e.description,
          e.lines_json, e.confidence, e.status, d.original_name AS documento
        FROM entries e JOIN companies c ON c.id = e.company_id JOIN documents d ON d.id = e.document_id
        WHERE e.status = ?`;
      const params: any[] = [status];
      if (company_id) {
        sql += " AND e.company_id = ?";
        params.push(company_id);
      }
      sql += " ORDER BY e.created_at LIMIT ?";
      params.push(limit);
      const rows = (db.prepare(sql).all(...params) as any[]).map((r) => ({
        ...r,
        linhas: JSON.parse(r.lines_json),
        lines_json: undefined,
      }));
      return ok({ lancamentos: rows });
    }
  );

  server.registerTool(
    "contai_decidir_lancamento",
    {
      title: "Aprovar ou rejeitar um lancamento pendente",
      description:
        "Decide um lancamento pendente. 'aprovar' aceita opcionalmente linhas corrigidas (tem de balancear: total debito = total credito). 'rejeitar' exige motivo. So lancamentos aprovados podem ser enviados ao CentralGest.",
      inputSchema: {
        entry_id: z.number().int().positive(),
        action: z.enum(["aprovar", "rejeitar"]),
        reason: z.string().optional().describe("Motivo, obrigatorio ao rejeitar"),
        lines: z
          .array(
            z.object({
              account: z.string().min(1).describe("Conta SNC, ex.: 62, 2432, 221"),
              description: z.string(),
              debit: z.number().min(0),
              credit: z.number().min(0),
            })
          )
          .optional()
          .describe("Linhas corrigidas (substituem as propostas)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ entry_id, action, reason, lines }) => {
      const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(entry_id) as any;
      if (!entry) return fail(`Lancamento ${entry_id} inexistente. Use contai_listar_lancamentos.`);
      if (entry.status !== "pendente") {
        return fail(`Lancamento ${entry_id} ja esta '${entry.status}'; so pendentes podem ser decididos.`);
      }
      if (action === "rejeitar") {
        if (!reason?.trim()) return fail("A rejeicao exige 'reason' com o motivo.");
        db.prepare(
          "UPDATE entries SET status = 'rejeitado', reviewed_at = datetime('now'), rejection_reason = ? WHERE id = ?"
        ).run(reason.trim(), entry_id);
        db.prepare("UPDATE documents SET status = 'rejeitado' WHERE id = ?").run(entry.document_id);
        return ok({ entry_id, status: "rejeitado" });
      }
      let finalLines: EntryLine[] = JSON.parse(entry.lines_json);
      if (lines) {
        if (!isBalanced(lines)) {
          const d = lines.reduce((s, l) => s + l.debit, 0);
          const c = lines.reduce((s, l) => s + l.credit, 0);
          return fail(`Linhas desbalanceadas: debito ${d.toFixed(2)} != credito ${c.toFixed(2)}. Corrija e repita.`);
        }
        finalLines = lines;
      }
      db.prepare(
        "UPDATE entries SET status = 'aprovado', reviewed_at = datetime('now'), lines_json = ? WHERE id = ?"
      ).run(JSON.stringify(finalLines), entry_id);
      db.prepare("UPDATE documents SET status = 'validado' WHERE id = ?").run(entry.document_id);
      const doc = db.prepare("SELECT d.doc_type, d.extracted_json, c.nif FROM documents d JOIN companies c ON c.id = d.company_id WHERE d.id = ?").get(entry.document_id) as any;
      if (doc?.extracted_json) learnFromApproval(db, entry.company_id, doc.doc_type, JSON.parse(doc.extracted_json), doc.nif, finalLines);
      return ok({ entry_id, status: "aprovado", linhas: finalLines });
    }
  );

  server.registerTool(
    "centralgest_lancar",
    {
      title: "Lancar lancamentos aprovados no CentralGest",
      description:
        "Envia para o CentralGest os lancamentos aprovados de uma empresa (todos, ou apenas entry_id). Idempotente: lancamentos ja despachados ou ja exportados por CSV sao ignorados, e o idExterno impede duplicados no destino. Devolve o resultado por lancamento (lancado | ja_existia | ja_despachado | erro).",
      inputSchema: {
        company_id: z.number().int().positive().describe("Empresa cujos lancamentos aprovados vao ser enviados"),
        entry_id: z.number().int().positive().optional().describe("Enviar apenas este lancamento"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ company_id, entry_id }) => {
      try {
        const client = requireCentralGest();
        const outcomes = await dispatchApprovedEntries(db, client, company_id, null, entry_id);
        if (outcomes.length === 0) {
          return ok({
            resultado: [],
            nota: "Nada por lancar: nao ha lancamentos aprovados pendentes de despacho para esta empresa. Use contai_listar_lancamentos com status 'pendente' para ver o que aguarda aprovacao.",
          });
        }
        return ok({ resultado: outcomes });
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "centralgest_listar_despachos",
    {
      title: "Historico de despachos para o CentralGest",
      description:
        "Lista os despachos feitos ao CentralGest com estado (lancado | ja_existia | erro), numero remoto e detalhe de erro quando aplicavel.",
      inputSchema: {
        company_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company_id, limit }) => {
      let sql = `SELECT dp.id, dp.entry_id, dp.company_id, c.name AS empresa, dp.external_id, dp.remote_id,
          dp.remote_number, dp.status, dp.error_detail, dp.created_at
        FROM dispatches dp JOIN companies c ON c.id = dp.company_id WHERE 1=1`;
      const params: any[] = [];
      if (company_id) {
        sql += " AND dp.company_id = ?";
        params.push(company_id);
      }
      sql += " ORDER BY dp.created_at DESC LIMIT ?";
      params.push(limit);
      return ok({ despachos: db.prepare(sql).all(...params) });
    }
  );


  server.registerTool(
    "contai_texto_documento",
    {
      title: "Texto extraido de um documento (OCR)",
      description:
        "Devolve o texto extraido de um documento arquivado (camada de texto do PDF ou OCR), o metodo usado, a confianca e os dados estruturados extraidos (NIFs, datas, totais, IVA, linhas). Util para verificar um alerta contra o conteudo real.",
      inputSchema: { document_id: z.number().int().positive() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ document_id }) => {
      const doc = db.prepare("SELECT id, original_name, mime_type, ocr_text, ocr_method, ocr_confidence, extracted_json FROM documents WHERE id = ?").get(document_id) as any;
      if (!doc) return fail(`Documento ${document_id} inexistente.`);
      return ok({ document_id, ficheiro: doc.original_name, mime: doc.mime_type, metodo: doc.ocr_method, confianca: doc.ocr_confidence, texto: doc.ocr_text, extraido: doc.extracted_json ? JSON.parse(doc.extracted_json) : null });
    }
  );

  server.registerTool(
    "contai_reprocessar_documento",
    {
      title: "Reprocessar um documento (OCR + classificacao + conferencia)",
      description:
        "Volta a extrair o texto do ficheiro arquivado com os motores actuais (ex.: apos activar Claude visao), reclassifica, refaz a proposta de lancamento se ainda nao foi decidida e reexecuta a conferencia. Lancamentos ja aprovados/rejeitados nao sao alterados.",
      inputSchema: { document_id: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ document_id }) => {
      try {
        return ok(await reprocessDocument(db, provider, storageRoot, document_id, ocr, structured));
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  // ---------- Agentes: conferência, balancetes, relatórios ----------
  server.registerTool(
    "contai_conferir_documentos",
    {
      title: "Conferir lancamentos (IVA, coerencia, duplicados)",
      description:
        "Reexecuta a conferencia automatica sobre os documentos de uma empresa (ou um documento) e devolve os alertas: IVA_CALCULO (valor do IVA nao bate com a taxa), TAXA_INEXISTENTE, TAXA_DESADEQUADA / TAXAS_MISTAS_POSSIVEIS (taxa aplicada nao corresponde ao produto/servico segundo o CIVA), TOTAL_INCOERENTE, DUPLICADO, DATA_FUTURA, AUMENTO_IMPOSTO_ANOMALO, NIF_TERCEIRO_EM_FALTA.",
      inputSchema: {
        company_id: z.number().int().positive(),
        document_id: z.number().int().positive().optional().describe("Conferir apenas este documento"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ company_id, document_id }) => {
      const docs = document_id
        ? [{ id: document_id }]
        : (db.prepare("SELECT id FROM documents WHERE company_id = ? AND extracted_json IS NOT NULL").all(company_id) as any[]);
      const out: any[] = [];
      for (const d of docs) {
        const findings = auditStoredDocument(db, d.id);
        if (findings.length) out.push({ document_id: d.id, alertas: findings });
      }
      return ok({ documentos_conferidos: docs.length, com_alertas: out.length, resultado: out });
    }
  );

  server.registerTool(
    "contai_listar_alertas",
    {
      title: "Listar alertas de conferencia",
      description:
        "Lista alertas abertos (ou resolvidos/ignorados) de documentos e balancetes, ordenados por gravidade (erro > aviso > info).",
      inputSchema: {
        company_id: z.number().int().positive().optional(),
        scope: z.enum(["documento", "balancete"]).optional(),
        status: z.enum(["aberto", "resolvido", "ignorado"]).default("aberto"),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company_id, scope, status, limit }) => {
      let sql = `SELECT f.id, f.company_id, c.name AS empresa, f.scope, f.document_id, d.original_name AS documento, f.period, f.code, f.severity, f.message, f.detail_json, f.created_at
        FROM findings f JOIN companies c ON c.id = f.company_id LEFT JOIN documents d ON d.id = f.document_id WHERE f.status = ?`;
      const params: any[] = [status];
      if (company_id) { sql += " AND f.company_id = ?"; params.push(company_id); }
      if (scope) { sql += " AND f.scope = ?"; params.push(scope); }
      sql += " ORDER BY CASE f.severity WHEN 'erro' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END, f.created_at DESC LIMIT ?";
      params.push(limit);
      const rows = (db.prepare(sql).all(...params) as any[]).map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null, detail_json: undefined }));
      return ok({ alertas: rows });
    }
  );

  server.registerTool(
    "contai_resolver_alerta",
    {
      title: "Resolver ou ignorar um alerta",
      description: "Fecha um alerta aberto como 'resolvido' (corrigido) ou 'ignorado' (falso positivo), com nota opcional.",
      inputSchema: {
        finding_id: z.number().int().positive(),
        status: z.enum(["resolvido", "ignorado"]),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ finding_id, status, note }) => {
      const r = db
        .prepare("UPDATE findings SET status = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ? AND status = 'aberto'")
        .run(status, note ?? null, finding_id);
      if (r.changes === 0) return fail(`Alerta ${finding_id} inexistente ou ja fechado.`);
      return ok({ finding_id, status });
    }
  );

  server.registerTool(
    "contai_segunda_opiniao_iva",
    {
      title: "Segunda opiniao de IA sobre um alerta de IVA",
      description:
        "Pede ao agente fiscal (Claude) uma segunda opiniao sobre um alerta, com base no texto do documento. Devolve {concorda, justificacao, confianca}. Requer ANTHROPIC_API_KEY; sem ela devolve erro accionavel.",
      inputSchema: { finding_id: z.number().int().positive() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ finding_id }) => {
      if (!agents.enabled) return fail("Agente de IA nao configurado: defina ANTHROPIC_API_KEY e reinicie o servidor MCP.");
      const f = db.prepare("SELECT f.*, d.stored_path FROM findings f LEFT JOIN documents d ON d.id = f.document_id WHERE f.id = ?").get(finding_id) as any;
      if (!f) return fail(`Alerta ${finding_id} inexistente.`);
      let excerpt = "";
      if (f.stored_path) {
        const abs = path.join(storageRoot, f.stored_path);
        if (fs.existsSync(abs)) excerpt = fs.readFileSync(abs, "utf8");
      }
      const opinion = await agents.reviewVatFinding({ code: f.code, message: f.message }, excerpt);
      return opinion ? ok({ finding_id, opinion }) : fail("O agente nao devolveu uma opiniao valida.");
    }
  );

  server.registerTool(
    "contai_importar_balancete",
    {
      title: "Importar ou derivar um balancete",
      description:
        "Guarda o balancete de um periodo (AAAA ou AAAA-MM) a partir de CSV (conta;descricao;debito;credito[;saldo]) exportado do software de contabilidade, ou deriva-o dos lancamentos aprovados no Cont.ai quando csv nao e fornecido.",
      inputSchema: {
        company_id: z.number().int().positive(),
        period: z.string().regex(/^\d{4}(-\d{2})?$/),
        csv: z.string().optional().describe("Conteudo CSV; se omitido deriva dos lancamentos aprovados"),
        csv_path: z.string().optional().describe("Alternativa: caminho local do CSV"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ company_id, period, csv, csv_path }) => {
      try {
        let lines;
        let source: "importado" | "derivado";
        if (csv || csv_path) {
          const text = csv ?? fs.readFileSync(csv_path!, "utf8");
          lines = parseBalanceCsv(text);
          source = "importado";
        } else {
          lines = deriveBalanceFromEntries(db, company_id, period);
          source = "derivado";
        }
        if (lines.length === 0) return fail("Balancete vazio: sem linhas no CSV ou sem lancamentos aprovados no periodo.");
        const id = saveTrialBalance(db, { companyId: company_id, period, source, lines }, null);
        return ok({ trial_balance_id: id, period, source, linhas: lines.length, indicadores: computeFinancials(lines) });
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "contai_conferir_balancete",
    {
      title: "Conferir balancete contra os padroes",
      description:
        "Avalia o balancete de um periodo contra os padroes configurados (sinal dos saldos, variacoes anormais face ao periodo anterior, racios) e devolve os alertas, que ficam registados.",
      inputSchema: { company_id: z.number().int().positive(), period: z.string().regex(/^\d{4}(-\d{2})?$/) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ company_id, period }) => {
      const tb = loadTrialBalance(db, company_id, period);
      if (!tb) return fail(`Nao existe balancete ${period} para a empresa ${company_id}. Use contai_importar_balancete primeiro.`);
      const prev = loadTrialBalance(db, company_id, previousPeriod(period));
      const findings = evaluateRules(listRules(db, company_id), tb.lines, prev?.lines ?? null);
      persistBalanceFindings(db, company_id, period, findings);
      return ok({ period, periodo_anterior: prev ? previousPeriod(period) : null, alertas: findings, indicadores: computeFinancials(tb.lines) });
    }
  );

  server.registerTool(
    "contai_listar_padroes",
    {
      title: "Listar padroes de conferencia de balancetes",
      description: "Lista os padroes (globais e da empresa) usados na conferencia de balancetes, com tipo, contas, limiar e gravidade.",
      inputSchema: { company_id: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company_id }) => ok({ padroes: listRules(db, company_id ?? null) })
  );

  server.registerTool(
    "contai_definir_padrao",
    {
      title: "Criar um padrao de conferencia",
      description:
        "Cria um padrao para a conferencia de balancetes. Tipos: saldo_sinal (param 'devedor'|'credor'), variacao_percentual (threshold em %), variacao_absoluta (threshold em euros), saldo_maximo, saldo_minimo, racio (param = prefixos do denominador separados por virgula, threshold em %).",
      inputSchema: {
        company_id: z.number().int().positive().nullable().default(null).describe("null = padrao global do gabinete"),
        name: z.string().min(3),
        type: z.enum(["saldo_sinal", "variacao_percentual", "variacao_absoluta", "saldo_maximo", "saldo_minimo", "racio"]),
        account_prefixes: z.array(z.string().min(1)).min(1),
        param: z.string().nullable().default(null),
        threshold: z.number().nullable().default(null),
        severity: z.enum(["info", "aviso", "erro"]).default("aviso"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      const r = db
        .prepare("INSERT INTO balance_rules (company_id, name, type, account_prefixes, param, threshold, severity, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
        .run(a.company_id, a.name, a.type, a.account_prefixes.join(","), a.param, a.threshold, a.severity);
      return ok({ rule_id: Number(r.lastInsertRowid) });
    }
  );

  server.registerTool(
    "contai_gerar_relatorio",
    {
      title: "Gerar relatorio financeiro para o cliente",
      description:
        "Gera o relatorio financeiro de um periodo a partir do balancete guardado: KPIs, racios comparados com o sector de actividade (CAE da empresa), estrutura de gastos, graficos e memoria descritiva. Com polish=true e ANTHROPIC_API_KEY, a memoria e reescrita pelo agente sem alterar numeros. Devolve o id, o resumo e a memoria; o HTML fica disponivel no portal do cliente.",
      inputSchema: {
        company_id: z.number().int().positive(),
        period: z.string().regex(/^\d{4}(-\d{2})?$/),
        polish: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ company_id, period, polish }) => {
      try {
        const data = buildReportData(db, company_id, period);
        if (polish && agents.enabled) {
          const polished = await agents.polishNarrative(data.narrative);
          if (polished) data.narrative = polished;
        }
        const html = renderReportHtml(data);
        const title = `Relatorio financeiro ${data.companyName} - ${period}`;
        const r = db
          .prepare("INSERT INTO reports (company_id, period, template, title, summary, data_json, html, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
          .run(company_id, period, data.template, title, data.summary, JSON.stringify(data), html);
        return ok({ report_id: Number(r.lastInsertRowid), title, template: data.template, sector: data.sector?.label ?? null, resumo: data.summary, memoria_descritiva: data.narrative, racios: data.ratios });
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "contai_conhecimento_fiscal",
    {
      title: "Estado do conhecimento fiscal (taxas de IVA, listas, benchmarks)",
      description:
        "Devolve a versao e data de verificacao das regras de IVA e dos benchmarks sectoriais, se estao desactualizadas, as taxas por territorio e as categorias de produtos/servicos com base legal. Use para confirmar que o agente esta a aplicar a lei em vigor.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const vat = loadVatRules();
      return ok({ estado: knowledgeStatus(), taxas: vat.territories, fontes: vat.sources, categorias: vat.categories.map((c) => ({ key: c.key, label: c.label, band: c.band, legal_basis: c.legal_basis })) });
    }
  );


  // ---------- Recepção multi-canal ----------
  server.registerTool(
    "contai_listar_recepcoes",
    {
      title: "Listar mensagens recebidas por email/WhatsApp",
      description:
        "Lista as mensagens recebidas pelos canais (email, WhatsApp) com estado: processado (documentos criados), sem_empresa (remetente desconhecido, precisa de associacao), sem_anexos, erro. Use para encontrar remetentes por associar.",
      inputSchema: {
        status: z.enum(["processado", "sem_empresa", "sem_anexos", "erro"]).optional(),
        channel: z.enum(["email", "whatsapp"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, channel, limit }) => {
      let sql = "SELECT m.id, m.channel, m.sender, m.recipient, m.subject, m.body_excerpt, m.company_id, c.name AS empresa, m.status, m.attachments, m.document_ids, m.error_detail, m.received_at FROM inbound_messages m LEFT JOIN companies c ON c.id = m.company_id WHERE 1=1";
      const params: any[] = [];
      if (status) { sql += " AND m.status = ?"; params.push(status); }
      if (channel) { sql += " AND m.channel = ?"; params.push(channel); }
      sql += " ORDER BY m.received_at DESC LIMIT ?";
      params.push(limit);
      return ok({ recepcoes: db.prepare(sql).all(...params) });
    }
  );

  server.registerTool(
    "contai_associar_contacto",
    {
      title: "Associar email ou numero WhatsApp a uma empresa",
      description:
        "Regista um contacto (endereco de email ou numero de telefone em formato internacional, ex.: 351912345678) como remetente autorizado de uma empresa. A partir dai, os documentos que esse remetente enviar entram automaticamente na empresa certa. Nunca cria empresas novas.",
      inputSchema: {
        company_id: z.number().int().positive(),
        channel: z.enum(["email", "whatsapp"]),
        address: z.string().min(5),
        label: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ company_id, channel, address, label }) => {
      if (!db.prepare("SELECT id FROM companies WHERE id = ?").get(company_id)) return fail(`Empresa ${company_id} inexistente.`);
      const norm = normaliseAddress(channel, address);
      const existing = db.prepare("SELECT company_id FROM company_contacts WHERE channel = ? AND address = ?").get(channel, norm) as any;
      if (existing) {
        return existing.company_id === company_id
          ? ok({ company_id, channel, address: norm, nota: "ja estava associado" })
          : fail(`O contacto ${norm} ja esta associado a empresa ${existing.company_id}. Remova-o primeiro.`);
      }
      db.prepare("INSERT INTO company_contacts (company_id, channel, address, label) VALUES (?, ?, ?, ?)").run(company_id, channel, norm, label ?? null);
      db.prepare("UPDATE inbound_messages SET company_id = ? WHERE channel = ? AND sender = ? AND status = 'sem_empresa'").run(company_id, channel, norm);
      return ok({ company_id, channel, address: norm });
    }
  );

  server.registerTool(
    "contai_listar_contactos",
    {
      title: "Listar contactos (email/WhatsApp) das empresas",
      description: "Lista os remetentes autorizados por empresa e canal.",
      inputSchema: { company_id: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company_id }) => {
      let sql = "SELECT k.id, k.company_id, c.name AS empresa, k.channel, k.address, k.label FROM company_contacts k JOIN companies c ON c.id = k.company_id WHERE 1=1";
      const params: any[] = [];
      if (company_id) { sql += " AND k.company_id = ?"; params.push(company_id); }
      return ok({ contactos: db.prepare(sql + " ORDER BY c.name, k.channel").all(...params) });
    }
  );

  server.registerTool(
    "contai_memoria_fornecedores",
    {
      title: "Memoria de fornecedores/clientes (contas aprendidas)",
      description:
        "Mostra, por empresa, os terceiros (NIF) ja vistos e as contas SNC aprendidas das aprovacoes humanas, que passam a ser usadas nas proximas propostas de lancamento.",
      inputSchema: { company_id: z.number().int().positive() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ company_id }) => ok({ terceiros: db.prepare("SELECT nif, name, expense_account, revenue_account, doc_count, last_seen FROM supplier_profiles WHERE company_id = ? ORDER BY doc_count DESC").all(company_id) })
  );

  return server;
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH || path.join("data", "contai.db");
  const storageRoot = process.env.STORAGE_ROOT || path.join("data", "arquivo");
  const db = openDb(dbPath);
  seedDemo(db);

  let centralgest = CentralGestClient.fromEnv();
  if (!centralgest && process.env.CENTRALGEST_MOCK === "1") {
    const mock = await startCentralGestMock("chave-demo");
    centralgest = new CentralGestClient({ baseUrl: mock.baseUrl, apiKey: "chave-demo" });
    console.error(`[contai-mcp] CentralGest simulado em ${mock.baseUrl}`);
  }

  const server = buildMcpServer({ db, storageRoot, centralgest });
  const transport = new StdioServerTransport();
  // Sem cliente ligado nao ha razao para o processo continuar vivo
  // (o mock HTTP interno manteria o event loop activo indefinidamente).
  transport.onclose = () => process.exit(0);
  process.stdin.on("end", () => process.exit(0));
  await server.connect(transport);
  console.error("[contai-mcp] servidor MCP activo (stdio)");
}

const isDirectRun = process.argv[1] && /mcp[\/\\]server\.ts$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
