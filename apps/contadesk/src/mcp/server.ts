/**
 * ContaDesk MCP server (stdio).
 *
 * Exposes the ContaDesk pipeline and the CentralGest integration as MCP
 * tools, so an AI agent can receive documents, review the proposed entries
 * and post them into CentralGest automatically. Writing to CentralGest goes
 * exclusively through the deterministic, idempotent dispatcher: the same
 * entry can never be posted twice.
 *
 * Run: npm run mcp   (from apps/contadesk)
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
import { ingestDocument } from "../pipeline.js";
import { isBalanced, EntryLine } from "../domain/entries.js";
import {
  CentralGestClient,
  CentralGestError,
  dispatchApprovedEntries,
} from "../integrations/centralgest.js";
import { startCentralGestMock } from "../integrations/centralgest-mock.js";

interface McpContext {
  db: Db;
  storageRoot: string;
  centralgest: CentralGestClient | null;
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ erro: message }) }],
  isError: true,
});

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "contadesk", version: "0.2.0" });
  const { db, storageRoot } = ctx;
  const provider = buildProvider();

  const requireCentralGest = (): CentralGestClient => {
    if (!ctx.centralgest) {
      throw new CentralGestError(
        "CentralGest nao configurado. Defina CENTRALGEST_BASE_URL e CENTRALGEST_API_KEY (ou CENTRALGEST_MOCK=1 para o simulador local) e reinicie o servidor MCP."
      );
    }
    return ctx.centralgest;
  };

  server.registerTool(
    "contadesk_estado",
    {
      title: "Estado do ContaDesk e da ligacao CentralGest",
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
      return ok({ documentos: documents, lancamentos: entries, despachos: dispatches, centralgest });
    }
  );

  server.registerTool(
    "contadesk_listar_empresas",
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
    "contadesk_definir_codigo_centralgest",
    {
      title: "Definir codigo CentralGest de uma empresa",
      description:
        "Associa uma empresa cliente ao seu codigo de empresa no CentralGest. Sem este mapeamento nao e possivel lancar documentos dessa empresa.",
      inputSchema: {
        company_id: z.number().int().positive().describe("Id da empresa no ContaDesk"),
        centralgest_code: z.string().min(1).describe("Codigo da empresa no CentralGest, ex.: PADARIA"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ company_id, centralgest_code }) => {
      const r = db
        .prepare("UPDATE companies SET centralgest_code = ? WHERE id = ?")
        .run(centralgest_code.trim(), company_id);
      if (r.changes === 0) return fail(`Empresa ${company_id} inexistente. Use contadesk_listar_empresas.`);
      return ok({ company_id, centralgest_code: centralgest_code.trim() });
    }
  );

  server.registerTool(
    "contadesk_listar_documentos",
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
    "contadesk_processar_documento",
    {
      title: "Processar um documento (classificar e propor lancamento)",
      description:
        "Recebe um documento (caminho de ficheiro local OU conteudo em texto), arquiva-o, classifica-o e, se aplicavel, gera a proposta de lancamento SNC. Devolve o tipo detectado e o id do lancamento proposto. Duplicados (mesmo conteudo) sao detectados e nao criam nada.",
      inputSchema: {
        company_id: z.number().int().positive().describe("Empresa a que o documento pertence"),
        file_path: z.string().optional().describe("Caminho absoluto de um ficheiro local a processar"),
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
          mimeType: "text/plain",
          buffer,
          channel: "portal",
        });
        return ok(outcome);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "contadesk_listar_lancamentos",
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
    "contadesk_decidir_lancamento",
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
      if (!entry) return fail(`Lancamento ${entry_id} inexistente. Use contadesk_listar_lancamentos.`);
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
            nota: "Nada por lancar: nao ha lancamentos aprovados pendentes de despacho para esta empresa. Use contadesk_listar_lancamentos com status 'pendente' para ver o que aguarda aprovacao.",
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

  return server;
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH || path.join("data", "contadesk.db");
  const storageRoot = process.env.STORAGE_ROOT || path.join("data", "arquivo");
  const db = openDb(dbPath);
  seedDemo(db);

  let centralgest = CentralGestClient.fromEnv();
  if (!centralgest && process.env.CENTRALGEST_MOCK === "1") {
    const mock = await startCentralGestMock("chave-demo");
    centralgest = new CentralGestClient({ baseUrl: mock.baseUrl, apiKey: "chave-demo" });
    console.error(`[contadesk-mcp] CentralGest simulado em ${mock.baseUrl}`);
  }

  const server = buildMcpServer({ db, storageRoot, centralgest });
  const transport = new StdioServerTransport();
  // Sem cliente ligado nao ha razao para o processo continuar vivo
  // (o mock HTTP interno manteria o event loop activo indefinidamente).
  transport.onclose = () => process.exit(0);
  process.stdin.on("end", () => process.exit(0));
  await server.connect(transport);
  console.error("[contadesk-mcp] servidor MCP activo (stdio)");
}

const isDirectRun = process.argv[1] && /mcp[\/\\]server\.ts$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
