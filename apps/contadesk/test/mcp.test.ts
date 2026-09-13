import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { CentralGestClient } from "../src/integrations/centralgest.js";
import { startCentralGestMock } from "../src/integrations/centralgest-mock.js";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");

let db: Db;
let client: Client;
let mockServer: http.Server;
let tmpDir: string;

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "{}";
  return { ...JSON.parse(text), _isError: res.isError === true };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contadesk-mcp-"));
  db = openDb(":memory:");
  seedDemo(db);
  const mock = await startCentralGestMock("chave-mcp");
  mockServer = mock.server;
  const cg = new CentralGestClient({ baseUrl: mock.baseUrl, apiKey: "chave-mcp" });

  const server = buildMcpServer({ db, storageRoot: tmpDir, centralgest: cg });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "teste", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  mockServer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("servidor MCP", () => {
  it("expoe as ferramentas esperadas", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const expected of [
      "contadesk_estado",
      "contadesk_listar_empresas",
      "contadesk_definir_codigo_centralgest",
      "contadesk_listar_documentos",
      "contadesk_processar_documento",
      "contadesk_listar_lancamentos",
      "contadesk_decidir_lancamento",
      "centralgest_lancar",
      "centralgest_listar_despachos",
      "contadesk_conferir_documentos",
      "contadesk_listar_alertas",
      "contadesk_resolver_alerta",
      "contadesk_segunda_opiniao_iva",
      "contadesk_importar_balancete",
      "contadesk_conferir_balancete",
      "contadesk_listar_padroes",
      "contadesk_definir_padrao",
      "contadesk_gerar_relatorio",
      "contadesk_conhecimento_fiscal",
      "contadesk_texto_documento",
      "contadesk_reprocessar_documento",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("estado reporta ligacao CentralGest ok", async () => {
    const out = await callTool("contadesk_estado");
    expect(out.centralgest.configurado).toBe(true);
    expect(out.centralgest.ligacao).toBe("ok");
  });

  it("fluxo completo: processar -> aprovar -> lancar no CentralGest", async () => {
    const empresas = await callTool("contadesk_listar_empresas");
    const padaria = empresas.empresas.find((e: any) => e.nif === "506284417");
    expect(padaria).toBeDefined();

    const setCode = await callTool("contadesk_definir_codigo_centralgest", {
      company_id: padaria.id,
      centralgest_code: "PADARIA",
    });
    expect(setCode._isError).toBe(false);

    const processed = await callTool("contadesk_processar_documento", {
      company_id: padaria.id,
      content: fixture("factura-fornecedor.txt"),
      filename: "factura-fornecedor.txt",
    });
    expect(processed.docType).toBe("factura_compra");
    expect(processed.entryId).toBeGreaterThan(0);

    // Duplicado nao cria nada de novo.
    const dup = await callTool("contadesk_processar_documento", {
      company_id: padaria.id,
      content: fixture("factura-fornecedor.txt"),
      filename: "copia.txt",
    });
    expect(dup.duplicate).toBe(true);

    const approved = await callTool("contadesk_decidir_lancamento", {
      entry_id: processed.entryId,
      action: "aprovar",
    });
    expect(approved.status).toBe("aprovado");

    const dispatched = await callTool("centralgest_lancar", { company_id: padaria.id });
    expect(dispatched.resultado).toHaveLength(1);
    expect(dispatched.resultado[0].status).toBe("lancado");
    expect(dispatched.resultado[0].remoteNumber).toBeTruthy();

    // Idempotencia via MCP: repetir nao lanca nada.
    const again = await callTool("centralgest_lancar", { company_id: padaria.id });
    expect(again.resultado).toHaveLength(0);

    const historial = await callTool("centralgest_listar_despachos", { company_id: padaria.id });
    expect(historial.despachos).toHaveLength(1);
    expect(historial.despachos[0].status).toBe("lancado");
  });

  it("aprovar com linhas desbalanceadas devolve erro accionavel", async () => {
    const processed = await callTool("contadesk_processar_documento", {
      company_id: 1,
      content: fixture("factura-venda.txt"),
      filename: "factura-venda.txt",
    });
    const out = await callTool("contadesk_decidir_lancamento", {
      entry_id: processed.entryId,
      action: "aprovar",
      lines: [
        { account: "211", description: "Cliente", debit: 100, credit: 0 },
        { account: "721", description: "Servicos", debit: 0, credit: 90 },
      ],
    });
    expect(out._isError).toBe(true);
    expect(out.erro).toMatch(/desbalanceadas/);
  });

  it("agentes: conferir documento com IVA errado, balancete e relatorio", async () => {
    const processed = await callTool("contadesk_processar_documento", {
      company_id: 1,
      content: fixture("factura-iva-errado.txt"),
      filename: "factura-iva-errado.txt",
    });
    expect(processed.findings.some((f: any) => f.code === "IVA_CALCULO")).toBe(true);

    const alerts = await callTool("contadesk_listar_alertas", { company_id: 1, scope: "documento" });
    expect(alerts.alertas.some((a: any) => a.code === "TAXA_DESADEQUADA")).toBe(true);

    const jun = await callTool("contadesk_importar_balancete", { company_id: 1, period: "2026-06", csv: fixture("balancete-2026-06.csv") });
    expect(jun._isError).toBe(false);
    const jul = await callTool("contadesk_importar_balancete", { company_id: 1, period: "2026-07", csv: fixture("balancete-2026-07.csv") });
    expect(jul.indicadores.vendas).toBe(42040);

    const check = await callTool("contadesk_conferir_balancete", { company_id: 1, period: "2026-07" });
    expect(check.alertas.some((a: any) => a.code === "VARIACAO_ANOMALA")).toBe(true);

    const rule = await callTool("contadesk_definir_padrao", { company_id: 1, name: "Caixa acima de 100", type: "saldo_maximo", account_prefixes: ["11"], threshold: 100, severity: "info" });
    expect(rule.rule_id).toBeGreaterThan(0);
    const check2 = await callTool("contadesk_conferir_balancete", { company_id: 1, period: "2026-07" });
    expect(check2.alertas.some((a: any) => a.code === "SALDO_FORA_DO_PADRAO")).toBe(true);

    const report = await callTool("contadesk_gerar_relatorio", { company_id: 1, period: "2026-07" });
    expect(report.template).toBe("restauracao_alimentar");
    expect(report.memoria_descritiva.length).toBeGreaterThan(2);

    const know = await callTool("contadesk_conhecimento_fiscal");
    expect(know.taxas.continente.normal).toBe(23);

    const missing = await callTool("contadesk_conferir_balancete", { company_id: 2, period: "2026-07" });
    expect(missing._isError).toBe(true);
    expect(missing.erro).toMatch(/importar_balancete/);
  });

  it("processa um PDF por caminho de ficheiro e devolve o texto extraido", async () => {
    const pdfPath = path.join(__dirname, "..", "fixtures", "factura-texto.pdf");
    const processed = await callTool("contadesk_processar_documento", { company_id: 2, file_path: pdfPath });
    expect(processed._isError).toBe(false);
    expect(processed.ocr.method).toBe("pdf_texto");
    expect(processed.docType).toBe("factura_compra");
    const text = await callTool("contadesk_texto_documento", { document_id: processed.documentId });
    expect(text.texto).toContain("658,05");
    expect(text.extraido.totalAmount).toBe(658.05);
    const re = await callTool("contadesk_reprocessar_documento", { document_id: processed.documentId });
    expect(re.ocr.method).toBe("pdf_texto");
  });

  it("rejeitar sem motivo devolve erro accionavel", async () => {
    const pend = await callTool("contadesk_listar_lancamentos", { status: "pendente" });
    expect(pend.lancamentos.length).toBeGreaterThan(0);
    const out = await callTool("contadesk_decidir_lancamento", {
      entry_id: pend.lancamentos[0].id,
      action: "rejeitar",
    });
    expect(out._isError).toBe(true);
    expect(out.erro).toMatch(/motivo/);
  });
});
