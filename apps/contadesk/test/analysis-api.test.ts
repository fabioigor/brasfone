import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));

let db: Db;
let app: ReturnType<typeof createServer>;
let tmpDir: string;
let staff: string;
let client: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contadesk-analysis-"));
  db = openDb(":memory:");
  seedDemo(db);
  app = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmpDir });
  const login = async (email: string, password: string) =>
    (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;
  staff = await login("gabinete@demo.pt", "gabinete123");
  client = await login("padaria@demo.pt", "cliente123");
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const S = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);
const C = (r: request.Test) => r.set("Authorization", `Bearer ${client}`);

describe("conferencia de documentos via API", () => {
  it("upload com IVA errado devolve alertas e fica registado", async () => {
    const res = await C(request(app).post("/api/documents").attach("file", fixture("factura-iva-errado.txt"), "factura-iva-errado.txt"));
    expect(res.status).toBe(201);
    const codes = res.body.findings.map((f: any) => f.code);
    expect(codes).toContain("IVA_CALCULO");
    expect(codes).toContain("TAXA_DESADEQUADA");
    const open = await S(request(app).get("/api/findings?company_id=1"));
    expect(open.body.findings.some((f: any) => f.code === "IVA_CALCULO")).toBe(true);
  });

  it("cliente ve os seus alertas de documentos mas nao os de balancete", async () => {
    db.prepare("INSERT INTO findings (company_id, scope, period, code, severity, message) VALUES (1, 'balancete', '2026-07', 'X', 'aviso', 'interno')").run();
    const res = await C(request(app).get("/api/findings"));
    expect(res.status).toBe(200);
    expect(res.body.findings.every((f: any) => f.scope === "documento")).toBe(true);
  });

  it("gabinete resolve alerta; segunda resolucao falha", async () => {
    const f = db.prepare("SELECT id FROM findings WHERE code = 'IVA_CALCULO' LIMIT 1").get() as any;
    const ok = await S(request(app).post(`/api/findings/${f.id}/resolve`).send({ status: "resolvido", note: "Fornecedor emitiu nota de crédito" }));
    expect(ok.status).toBe(200);
    const again = await S(request(app).post(`/api/findings/${f.id}/resolve`).send({ status: "resolvido" }));
    expect(again.status).toBe(404);
  });

  it("reexecutar conferencia da empresa", async () => {
    const res = await S(request(app).post("/api/audit/companies/1"));
    expect(res.status).toBe(200);
    expect(res.body.documents).toBeGreaterThan(0);
  });

  it("segunda opiniao sem chave de IA devolve 409 accionavel", async () => {
    const f = db.prepare("SELECT id FROM findings WHERE scope = 'documento' LIMIT 1").get() as any;
    const res = await S(request(app).post(`/api/findings/${f.id}/second-opinion`));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe("balancetes, padroes e relatorios via API", () => {
  it("importa dois periodos e confere o segundo", async () => {
    const a = await S(request(app).post("/api/balances/1/import").field("period", "2026-06").attach("file", fixture("balancete-2026-06.csv"), "b.csv"));
    expect(a.status).toBe(201);
    const b = await S(request(app).post("/api/balances/1/import").field("period", "2026-07").attach("file", fixture("balancete-2026-07.csv"), "b.csv"));
    expect(b.status).toBe(201);
    const check = await S(request(app).post("/api/balances/1/2026-07/check"));
    expect(check.status).toBe(200);
    expect(check.body.previousPeriod).toBe("2026-06");
    expect(check.body.findings.some((f: any) => f.code === "VARIACAO_ANOMALA")).toBe(true);
  });

  it("periodo invalido e rejeitado", async () => {
    const res = await S(request(app).post("/api/balances/1/import").field("period", "julho").attach("file", fixture("balancete-2026-06.csv"), "b.csv"));
    expect(res.status).toBe(400);
  });

  it("cliente le o balancete da sua empresa mas nao o de outra", async () => {
    const mine = await C(request(app).get("/api/balances/1/2026-07"));
    expect(mine.status).toBe(200);
    expect(mine.body.financials.vendas).toBe(42040);
    const other = await C(request(app).get("/api/balances/2/2026-07"));
    expect(other.status).toBe(403);
  });

  it("padroes: listar, criar, desactivar, apagar", async () => {
    const list = await S(request(app).get("/api/rules"));
    expect(list.body.rules.length).toBeGreaterThanOrEqual(10);
    const created = await S(request(app).post("/api/rules").send({ company_id: 1, name: "Caixa acima de 5.000", type: "saldo_maximo", account_prefixes: ["11"], threshold: 5000, severity: "info" }));
    expect(created.status).toBe(201);
    const patched = await S(request(app).patch(`/api/rules/${created.body.id}`).send({ enabled: false }));
    expect(patched.status).toBe(200);
    const deleted = await S(request(app).delete(`/api/rules/${created.body.id}`));
    expect(deleted.status).toBe(200);
  });

  it("gera relatorio com comparacao sectorial e o cliente consegue ve-lo", async () => {
    const res = await S(request(app).post("/api/reports/1").send({ period: "2026-07" }));
    expect(res.status).toBe(201);
    expect(res.body.template).toBe("restauracao_alimentar");
    const list = await C(request(app).get("/api/reports"));
    expect(list.body.reports.some((r: any) => r.id === res.body.id)).toBe(true);
    const html = await C(request(app).get(`/api/reports/${res.body.id}/html`));
    expect(html.status).toBe(200);
    expect(html.text).toContain("<svg");
    expect(html.text).toContain("Padaria Central Lda");
  });

  it("relatorio sem balancete devolve erro claro", async () => {
    const res = await S(request(app).post("/api/reports/2").send({ period: "2026-07" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/balancete/i);
  });

  it("conhecimento fiscal exposto ao gabinete", async () => {
    const res = await S(request(app).get("/api/knowledge"));
    expect(res.status).toBe(200);
    expect(res.body.vat.territories.continente.normal).toBe(23);
    expect(res.body.status.find((s: any) => s.name === "regras_iva").stale).toBe(false);
  });

  it("dashboard inclui alertas abertos", async () => {
    const res = await S(request(app).get("/api/dashboard?company_id=1"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.openFindings)).toBe(true);
  });
});
