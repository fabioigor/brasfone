import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import request from "supertest";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { persistFindings, transitionFinding, findingMetrics, listFpReasons, blockingFindings } from "../src/domain/exceptions.js";
import { parameterAt, addParameterVersion, listParameters, numberAt } from "../src/domain/parameters.js";
import { vatWithinTolerance } from "../src/domain/vatAudit.js";
import { inLearningPeriod } from "../src/domain/balanceRules.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste";
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));
const x = (items: any[] = []) => ({ nifs: [], items, issuerNif: null, docNumber: null, docDate: "2026-07-01", totalAmount: null, vatAmount: null, vatRate: null, netAmount: null, currency: "EUR", sources: [] } as any);

describe("parametros versionados", () => {
  it("semeia os valores da especificacao, versiona por data de eficacia e nunca reescreve o passado", () => {
    const db = openDb(":memory:");
    expect(parameterAt(db, "tolerancia_iva_linha_eur", "2026-07-01")!.value).toBe(0.01);
    expect(numberAt(db, "inexistente", "2026-07-01", 7).value).toBe(7);
    const v = addParameterVersion(db, 1, "tolerancia_iva_linha_eur", 0.02, "2026-09-01", "software X arredonda por linha");
    expect(v.value).toBe(0.02);
    expect(parameterAt(db, "tolerancia_iva_linha_eur", "2026-08-31")!.value).toBe(0.01);
    expect(parameterAt(db, "tolerancia_iva_linha_eur", "2026-09-01")!.value).toBe(0.02);
    expect(listParameters(db, "tolerancia_iva_linha_eur").map((p) => p.validTo)).toEqual([null, "2026-08-31"]);
    expect(() => addParameterVersion(db, 1, "tolerancia_iva_linha_eur", 0.03, "2026-08-01", null)).toThrow(/posterior/);
    expect(() => addParameterVersion(db, 1, "nao_existe", 1, "2026-09-01", null)).toThrow(/desconhecido/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'parameter_version'").get() as any).n).toBe(1);
  });
});

describe("A1.01: arredondamento por linha ou por documento", () => {
  it("aceita qualquer das duas convencoes dentro de 0,01 e rejeita fora", () => {
    const items = [{ description: "a", quantity: 3, unitPrice: 1.115, lineTotal: 3.345 }, { description: "b", quantity: 1, unitPrice: 2.005, lineTotal: 2.005 }];
    const base = 5.35;
    // por documento: 5.35*0.23 = 1.2305 -> 1.23 ; por linha: 0.77 + 0.46 = 1.23 (3.345*0.23=0.769 -> 0.77 ; 2.005*0.23=0.461 -> 0.46)
    expect(vatWithinTolerance(1.23, base, 23, x(items), 0.01)).toBe(true);
    expect(vatWithinTolerance(1.24, base, 23, x(items), 0.01)).toBe(true);   // dentro de 0,01
    expect(vatWithinTolerance(1.26, base, 23, x(items), 0.01)).toBe(false);
    const items2 = [{ description: "a", quantity: 1, unitPrice: 10.004, lineTotal: 10.004 }, { description: "b", quantity: 1, unitPrice: 10.004, lineTotal: 10.004 }, { description: "c", quantity: 1, unitPrice: 10.004, lineTotal: 10.004 }];
    // documento: 30.012*0.06 = 1.80 ; por linha: 3 x round(0.60024)=0.60 -> 1.80 ; declarado 1.82 fora
    expect(vatWithinTolerance(1.82, 30.01, 6, x(items2), 0.01)).toBe(false);
    expect(vatWithinTolerance(1.80, 30.01, 6, x(items2), 0.01)).toBe(true);
  });
});

describe("ciclo de vida das excepcoes", () => {
  it("excepcao reutilizavel aceita automaticamente; recorrencia apos corrigido reabre com severidade maior", () => {
    const db = openDb(":memory:"); seedDemo(db);
    const docId = Number(db.prepare("INSERT INTO documents (company_id, uploader_id, original_name, stored_path, mime_type, size_bytes, sha256) VALUES (1, 1, 'a.pdf', 'a', 'application/pdf', 1, 'h1')").run().lastInsertRowid);
    const f = [{ code: "IVA_CALCULO", severity: "aviso" as const, message: "x" }, { code: "TAXA_DESADEQUADA", severity: "aviso" as const, message: "y" }];
    const r1 = persistFindings(db, { companyId: 1, scope: "documento", documentId: docId, findings: f, counterpartyNif: "501442600" });
    expect(r1).toEqual({ created: 2, reopened: 0, autoAccepted: 0, learning: 0 });
    const open = db.prepare("SELECT id, code, scope_key FROM findings WHERE document_id = ? ORDER BY id").all(docId) as any[];
    expect(open[0].scope_key).toBe("nif:501442600");
    // aceitar com excepcao reutilizavel -> proxima corrida do mesmo alerta fica aceite
    transitionFinding(db, open[1].id, { id: 1, profile: "contabilista" }, { status: "aceite", note: "Fornecedor de restauração: taxa 13% correcta", createException: true });
    // corrigir o outro
    transitionFinding(db, open[0].id, { id: 1, profile: "contabilista" }, { status: "corrigido", note: "linha corrigida" });
    const r2 = persistFindings(db, { companyId: 1, scope: "documento", documentId: docId, findings: f, counterpartyNif: "501442600" });
    expect(r2.autoAccepted).toBe(1); expect(r2.reopened).toBe(1); expect(r2.created).toBe(1);
    const re = db.prepare("SELECT status, severity, reopened_count FROM findings WHERE document_id = ? AND code = 'IVA_CALCULO' AND status = 'reaberto'").get(docId) as any;
    expect(re).toEqual({ status: "reaberto", severity: "erro", reopened_count: 1 });
    const acc = db.prepare("SELECT status, resolution_note FROM findings WHERE document_id = ? AND code = 'TAXA_DESADEQUADA' ORDER BY id DESC").get(docId) as any;
    expect(acc.status).toBe("aceite"); expect(acc.resolution_note).toMatch(/Excepção reutilizada/);
    expect((db.prepare("SELECT reuse_count FROM finding_exceptions").get() as any).reuse_count).toBe(1);
    // reaberto: contabilista nao fecha, toc fecha
    const reId = (db.prepare("SELECT id FROM findings WHERE status = 'reaberto'").get() as any).id;
    expect(() => transitionFinding(db, reId, { id: 1, profile: "contabilista" }, { status: "corrigido" })).toThrow(/TOC/);
    expect(transitionFinding(db, reId, { id: 1, profile: "toc" }, { status: "corrigido" }).status).toBe("corrigido");
    // fechados nao deletados por nova corrida
    expect((db.prepare("SELECT COUNT(*) AS n FROM findings WHERE document_id = ?").get(docId) as any).n).toBe(4);
  });

  it("falso positivo exige motivo da lista; aceite exige justificacao; em_analise atribui; metricas", () => {
    const db = openDb(":memory:"); seedDemo(db);
    expect(listFpReasons(db).map((r) => r.code)).toContain("arredondamento_software");
    persistFindings(db, { companyId: 1, scope: "balancete", period: "2026-07", findings: [{ code: "VARIACAO_ANOMALA", severity: "aviso", message: "a", detail: { rule: "FSE" } }, { code: "SALDO_INVERTIDO", severity: "erro", message: "b", detail: { rule: "Caixa" } }] });
    const ids = (db.prepare("SELECT id FROM findings ORDER BY id").all() as any[]).map((r) => r.id);
    expect(() => transitionFinding(db, ids[0], { id: 1 }, { status: "falso_positivo" })).toThrow(/motivo/);
    expect(() => transitionFinding(db, ids[0], { id: 1 }, { status: "falso_positivo", reason: "inventado" })).toThrow(/motivo/);
    expect(() => transitionFinding(db, ids[1], { id: 1 }, { status: "aceite" })).toThrow(/justificação/);
    expect(transitionFinding(db, ids[1], { id: 1 }, { status: "em_analise" }).assigned_to).toBe(1);
    expect(transitionFinding(db, ids[0], { id: 1 }, { status: "falso_positivo", reason: "sazonalidade_prevista" }).fp_reason).toBe("sazonalidade_prevista");
    expect(transitionFinding(db, ids[1], { id: 1 }, { status: "corrigido" }).status).toBe("corrigido");
    expect(() => transitionFinding(db, ids[1], { id: 1 }, { status: "corrigido" })).toThrow(/já fechado/);
    const m = findingMetrics(db, 1, null);
    expect(m.totals).toMatchObject({ open: 0, closed: 2, corrigido: 1, falso_positivo: 1, precision: 50, fpRate: 50 });
    expect(m.rules.find((r) => r.code === "SALDO_INVERTIDO")!.precision).toBe(100);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('finding_close','finding_assign')").get() as any).n).toBe(3);
  });

  it("periodo de aprendizagem marca variacoes sem as esconder", () => {
    const db = openDb(":memory:"); seedDemo(db);
    expect(inLearningPeriod(db, 1, new Date().toISOString().slice(0, 7))).toBe(true);
    db.prepare("UPDATE companies SET learning_until = '2020-01-31' WHERE id = 1").run();
    expect(inLearningPeriod(db, 1, "2026-07")).toBe(false);
    const r = persistFindings(db, { companyId: 2, scope: "balancete", period: "2026-07", findings: [{ code: "VARIACAO_ANOMALA", severity: "aviso", message: "a" }, { code: "SALDO_INVERTIDO", severity: "erro", message: "b" }], learningCodes: new Set(["VARIACAO_ANOMALA"]) });
    expect(r.learning).toBe(1);
    expect((db.prepare("SELECT learning FROM findings WHERE code = 'VARIACAO_ANOMALA'").get() as any).learning).toBe(1);
  });
});

describe("API: bloqueio da aprovacao, transicoes, motivos e parametros", () => {
  it("aprovar com alerta bloqueante exige justificacao; transicoes e permissoes por perfil", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null });
    const staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body;
    expect(staff.user.profile).toBe("toc");
    const S = (r: request.Test) => r.set("Authorization", `Bearer ${staff.token}`);
    const up = await S(request(app).post("/api/documents")).attach("file", fixture("factura-iva-errado.txt"), "err.txt").field("company_id", "1");
    expect(up.status).toBe(201);
    const blocking = blockingFindings(db, up.body.documentId);
    expect(blocking.length).toBeGreaterThan(0);
    const entry = db.prepare("SELECT id FROM entries WHERE document_id = ?").get(up.body.documentId) as any;
    const denied = await S(request(app).post("/api/entries/" + entry.id + "/decision")).send({ action: "aprovar" });
    expect(denied.status).toBe(409); expect(denied.body.blocking.length).toBe(blocking.length);
    const ok = await S(request(app).post("/api/entries/" + entry.id + "/decision")).send({ action: "aprovar", override_reason: "Confirmado com o fornecedor: IVA correcto na nota de crédito seguinte" });
    expect(ok.status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM findings WHERE document_id = ? AND status = 'aceite'").get(up.body.documentId) as any).n).toBe(blocking.length);
    expect(blockingFindings(db, up.body.documentId)).toEqual([]);

    const list = await S(request(app).get("/api/findings?status=aceite"));
    expect(list.body.findings.length).toBeGreaterThan(0); expect(list.body.severity_labels.erro).toBe("Bloqueante");
    const fid = list.body.findings[0].id;
    expect((await S(request(app).post("/api/findings/" + fid + "/transition")).send({ status: "reaberto" })).status).toBe(200);
    expect((await S(request(app).post("/api/findings/" + fid + "/transition")).send({ status: "falso_positivo" })).status).toBe(400);
    expect((await S(request(app).post("/api/findings/" + fid + "/transition")).send({ status: "falso_positivo", reason: "dados_extraidos_incorrectos" })).status).toBe(200);
    const compat = await S(request(app).post("/api/findings/" + fid + "/resolve")).send({ status: "resolvido" });
    expect(compat.status).toBe(404);

    const metrics = await S(request(app).get("/api/findings/metrics?company_id=1"));
    expect(metrics.body.totals.closed).toBeGreaterThan(0); expect(metrics.body.targets.precision).toBe(85);
    const reasons = await S(request(app).put("/api/findings/reasons")).send({ reasons: [{ code: "arredondamento_software", label: "Arredondamento", active: true }, { code: "novo_motivo", label: "Motivo da Lumarcont", active: true }] });
    expect(reasons.status).toBe(200); expect(reasons.body.reasons.some((r: any) => r.code === "novo_motivo")).toBe(true);
    const params = await S(request(app).get("/api/parameters"));
    expect(params.body.definitions.length).toBeGreaterThan(5);
    expect((await S(request(app).post("/api/parameters")).send({ key: "escala_impactos_minimos", value: 0.5, valid_from: "2026-10-01", note: "carteira de PME pequenas" })).status).toBe(201);
    // contabilista nao altera parametros nem motivos
    db.prepare("UPDATE users SET profile = 'contabilista' WHERE email = 'gabinete@demo.pt'").run();
    const cont = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    expect((await request(app).post("/api/parameters").set("Authorization", `Bearer ${cont}`).send({ key: "escala_impactos_minimos", value: 2, valid_from: "2026-11-01" })).status).toBe(403);
    expect((await request(app).put("/api/findings/reasons").set("Authorization", `Bearer ${cont}`).send({ reasons: [{ code: "x_y", label: "xyz", active: true }] })).status).toBe(403);
  });
});
