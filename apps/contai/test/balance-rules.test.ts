import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import request from "supertest";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { evaluateRules, resolveRules, ruleLevel, subaccountMismatches, listRules, seedDefaultRules, checkBalance, BalanceRule, DEFAULT_RULES } from "../src/domain/balanceRules.js";
import { parseBalanceCsv, saveTrialBalance, BalanceLine } from "../src/domain/trialBalance.js";
import { addParameterVersion } from "../src/domain/parameters.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste";
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const line = (account: string, balance: number): BalanceLine => ({ account, description: account, debit: balance > 0 ? balance : 0, credit: balance < 0 ? -balance : 0, balance });
const rule = (r: Partial<BalanceRule>): BalanceRule => ({ id: 1, companyId: null, name: "r", type: "variacao", method: "mediana_12m", accountPrefixes: ["62"], param: null, threshold: 30, minImpact: 500, severity: "aviso", enabled: true, ...r });
/** Balanced synthetic month: sales (credit) and FSE/personnel/clients (debit). */
const month = (fse: number, vendas: number, pessoal = 3000, clientes = 6000) => [line("62", fse), line("63", pessoal), line("211", clientes), line("71", -vendas), line("12", vendas - fse - pessoal - clientes)];
const history = (n: number, fse = 1000, vendas = 10000) => Array.from({ length: n }, (_, i) => ({ period: `2025-${String(12 - i).padStart(2, "0")}`, lines: month(fse, vendas) }));

describe("B2: metodos de referencia e dupla condicao", () => {
  it("mediana movel de 12 meses: dispara so com desvio e impacto; precisa de 3 meses", () => {
    const r = [rule({})];
    expect(evaluateRules(r, month(2000, 10000), null, { history: history(2), period: "2026-01" }).some((f) => f.code === "VARIACAO_ANOMALA")).toBe(false);
    const hit = evaluateRules(r, month(2000, 10000), null, { history: history(6), period: "2026-01" }).find((f) => f.code === "VARIACAO_ANOMALA")!;
    expect(hit).toBeDefined(); expect(hit.detail).toMatchObject({ method: "mediana_12m", reference: 1000, impact: 1000 });
    expect(hit.message).toMatch(/\+100\.0% face a mediana de 6 meses/);
    // +100% mas só 80 €: silêncio
    expect(evaluateRules([rule({ accountPrefixes: ["68"] })], [...month(1000, 10000), line("68", 160)], null, { history: history(6).map((h) => ({ ...h, lines: [...h.lines, line("68", 80)] })), period: "2026-01" }).some((f) => f.code === "VARIACAO_ANOMALA")).toBe(false);
    // +12% mas 40 000 €: alerta (limiar 10%, impacto 1 000)
    const big = history(6, 300000, 900000);
    expect(evaluateRules([rule({ threshold: 10, minImpact: 1000 })], month(340000, 900000), null, { history: big, period: "2026-01" }).some((f) => f.code === "VARIACAO_ANOMALA")).toBe(true);
    // escala dos impactos minimos
    expect(evaluateRules(r, month(1600, 10000), null, { history: history(6), period: "2026-01", impactScale: 2 }).some((f) => f.code === "VARIACAO_ANOMALA")).toBe(false);
  });

  it("homologa, percentagem das vendas e dias de recebimento", () => {
    const hist = [...history(3), { period: "2025-01", lines: month(1000, 10000) }];
    const hom = evaluateRules([rule({ method: "homologa", accountPrefixes: ["71"], threshold: 25, minImpact: 2500 })], month(1000, 14000), null, { history: hist, period: "2026-01" }).find((f) => f.code === "VARIACAO_ANOMALA")!;
    expect(hom.message).toMatch(/homólogo 2025-01/); expect(hom.detail!.impact).toBe(4000);
    expect(evaluateRules([rule({ method: "homologa", accountPrefixes: ["71"], threshold: 25, minImpact: 2500 })], month(1000, 14000), null, { history: history(3), period: "2026-01" }).length).toBe(0);
    // % das vendas: FSE passa de 10% para 20% das vendas (+10 p.p., impacto 1 000) com limiar 5 p.p.
    const pv = evaluateRules([rule({ method: "pct_vendas", threshold: 5, minImpact: 500 })], month(2000, 10000), null, { history: history(4), period: "2026-01" }).find((f) => f.code === "VARIACAO_ANOMALA")!;
    expect(pv.message).toMatch(/\+10\.0 p\.p\. face a % das vendas/);
    // dias de recebimento: clientes duplicam com vendas iguais -> +219 dias
    const dr = evaluateRules([rule({ method: "dias_recebimento", accountPrefixes: ["21"], threshold: 15, minImpact: 5000 })], month(1000, 10000, 3000, 12000), month(1000, 10000, 3000, 6000), { period: "2026-01" }).find((f) => f.code === "VARIACAO_ANOMALA")!;
    expect(dr.message).toMatch(/dias face a prazo médio de recebimento/); expect(dr.detail!.impact).toBe(6000);
  });

  it("hierarquia: conta > cliente > sector > global; sectorial so se o CAE bater", () => {
    const g = rule({ id: 1, name: "global", threshold: 30 });
    const s = rule({ id: 2, name: "sector", caePrefix: "10", threshold: 20 });
    const c = rule({ id: 3, name: "cliente", companyId: 1, threshold: 10 });
    const a = rule({ id: 4, name: "conta", companyId: 1, account: "6221", threshold: 5 });
    expect([g, s, c, a].map(ruleLevel)).toEqual([3, 2, 1, 0]);
    const resolved = resolveRules([g, s, c, a]);
    expect(resolved.map((r) => r.name).sort()).toEqual(["cliente", "conta"]); // conta tem familia propria (account); entre g/s/c ganha cliente
    const db = openDb(":memory:"); seedDemo(db);
    db.prepare("INSERT INTO balance_rules (company_id, cae_prefix, name, type, account_prefixes, threshold, min_impact, method, severity, enabled) VALUES (NULL, '10', 'sector padaria', 'variacao', '62', 20, 500, 'mediana_12m', 'aviso', 1)").run();
    db.prepare("INSERT INTO balance_rules (company_id, cae_prefix, name, type, account_prefixes, threshold, min_impact, method, severity, enabled) VALUES (NULL, '62', 'sector informatica', 'variacao', '62', 50, 500, 'mediana_12m', 'aviso', 1)").run();
    expect(listRules(db, 1).map((r) => r.name)).toContain("sector padaria");   // CAE 10711
    expect(listRules(db, 1).map((r) => r.name)).not.toContain("sector informatica");
    expect(listRules(db, 2).map((r) => r.name)).toContain("sector informatica"); // CAE 62020
  });

  it("B1.03 soma das subcontas e B1.01 com tolerancia versionada; regras antigas so por percentagem removidas", () => {
    const ok = [line("62", 300), line("621", 100), line("622", 200), line("6221", 150), line("6222", 50), line("12", -300)];
    expect(subaccountMismatches(ok)).toEqual([]);
    const bad = [line("62", 300), line("621", 100), line("622", 150), line("12", -300)];
    const m = subaccountMismatches(bad);
    expect(m).toHaveLength(1); expect(m[0]!.code).toBe("SUBCONTAS_INCOERENTES"); expect(m[0]!.detail).toMatchObject({ account: "62", parent: 300, sum: 250 });
    const db = openDb(":memory:");
    db.prepare("INSERT INTO balance_rules (company_id, name, type, account_prefixes, threshold, severity, enabled) VALUES (NULL, 'FSE variam mais de 30% face ao período anterior', 'variacao_percentual', '62', 30, 'aviso', 1)").run();
    seedDefaultRules(db);
    const names = (db.prepare("SELECT name FROM balance_rules").all() as any[]).map((r) => r.name);
    expect(names).not.toContain("FSE variam mais de 30% face ao período anterior");
    expect(names).toContain("62 Fornecimentos e serviços fora do padrão");
    expect(DEFAULT_RULES.filter((r) => r.type === "variacao").every((r) => (r.minImpact ?? 0) > 0)).toBe(true);
    const unbalanced = evaluateRules([], [line("62", 100.02), line("12", -100)], null, { balanceTolerance: 0.01 });
    expect(unbalanced[0]!.code).toBe("BALANCETE_DESEQUILIBRADO");
    expect(evaluateRules([], [line("62", 100.02), line("12", -100)], null, { balanceTolerance: 0.05 }).length).toBe(0);
  });

  it("checkBalance usa o historico guardado, a escala dos impactos e a tolerancia por data", () => {
    const db = openDb(":memory:"); seedDemo(db);
    for (let i = 1; i <= 6; i++) saveTrialBalance(db, { companyId: 1, period: `2026-0${i}`, source: "importado", lines: month(1000, 10000) }, 1);
    saveTrialBalance(db, { companyId: 1, period: "2026-07", source: "importado", lines: month(2000, 10000) }, 1);
    const r1 = checkBalance(db, 1, "2026-07", month(2000, 10000));
    expect(r1.previousPeriod).toBe("2026-06");
    expect(r1.findings.some((f) => f.code === "VARIACAO_ANOMALA" && /62 Fornecimentos/.test(f.message))).toBe(true);
    addParameterVersion(db, 1, "escala_impactos_minimos", 5, "2026-07-01", "carteira grande");
    expect(checkBalance(db, 1, "2026-07", month(2000, 10000)).findings.some((f) => /62 Fornecimentos/.test(f.message))).toBe(false); // impacto 1000 < 500x5
    expect(checkBalance(db, 1, "2026-06", month(2000, 10000)).findings.some((f) => /62 Fornecimentos/.test(f.message))).toBe(true);  // antes da eficacia
  });
});

describe("API: padroes com hierarquia e perfis; carteira do contabilista", () => {
  it("regras de variacao exigem impacto minimo; globais so pelo TOC; contabilista ve so a sua carteira", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null });
    const toc = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    const T = (r: request.Test) => r.set("Authorization", `Bearer ${toc}`);
    expect((await T(request(app).post("/api/rules")).send({ name: "62 só por %", type: "variacao", method: "mediana_12m", account_prefixes: ["62"], threshold: 30 })).status).toBe(400);
    const created = await T(request(app).post("/api/rules")).send({ name: "Sector 10: FSE", type: "variacao", method: "mediana_12m", account_prefixes: ["62"], threshold: 20, min_impact: 400, cae_prefix: "10" });
    expect(created.status).toBe(201);
    const rules = await T(request(app).get("/api/rules?company_id=1"));
    expect(rules.body.methods).toContain("homologa"); expect(rules.body.rules.some((r: any) => r.name === "Sector 10: FSE" && r.caePrefix === "10")).toBe(true);
    // contas de gabinete com perfil e carteira
    const created2 = await T(request(app).post("/api/users")).send({ name: "Ana Contabilista", email: "ana@lumarcont.pt", password: "Senha-Ana-123", profile: "contabilista", company_ids: [1] });
    expect(created2.status).toBe(201);
    const users = await T(request(app).get("/api/users"));
    expect(users.body.users.find((u: any) => u.email === "ana@lumarcont.pt")).toMatchObject({ profile: "contabilista", company_ids: [1] });
    const ana = (await request(app).post("/api/auth/login").send({ email: "ana@lumarcont.pt", password: "Senha-Ana-123" })).body;
    expect(ana.user.profile).toBe("contabilista");
    const A = (r: request.Test) => r.set("Authorization", `Bearer ${ana.token}`);
    expect((await A(request(app).get("/api/companies"))).body.companies.map((c: any) => c.id)).toEqual([1]);
    expect((await A(request(app).post("/api/rules")).send({ name: "x", type: "saldo_sinal", account_prefixes: ["11"], param: "devedor" })).status).toBe(403);
    expect((await A(request(app).post("/api/rules")).send({ company_id: 1, name: "cliente 1", type: "saldo_sinal", account_prefixes: ["11"], param: "devedor" })).status).toBe(403); // contabilista nao configura
    expect((await A(request(app).get("/api/settings"))).status).toBe(403);
    expect((await A(request(app).post("/api/users")).send({ name: "X Y", email: "x@y.pt", password: "12345678" })).status).toBe(403);
    // documentos e alertas fora da carteira nao aparecem
    await T(request(app).post("/api/documents")).attach("file", Buffer.from(fixture("factura-fornecedor.txt")), "f.txt").field("company_id", "2");
    expect((await T(request(app).get("/api/documents"))).body.documents.length).toBe(1);
    expect((await A(request(app).get("/api/documents"))).body.documents.length).toBe(0);
    const entry = db.prepare("SELECT id FROM entries WHERE company_id = 2").get() as any;
    expect((await A(request(app).post("/api/entries/" + entry.id + "/decision")).send({ action: "aprovar" })).status).toBe(403);
    // coordenador altera perfil e carteira; nao pode promover a toc
    const coordId = (await T(request(app).post("/api/users")).send({ name: "Rui Coordenador", email: "rui@lumarcont.pt", password: "Senha-Rui-123", profile: "coordenador" })).body.id;
    const rui = (await request(app).post("/api/auth/login").send({ email: "rui@lumarcont.pt", password: "Senha-Rui-123" })).body.token;
    const anaId = users.body.users.find((u: any) => u.email === "ana@lumarcont.pt").id;
    expect((await request(app).patch("/api/users/" + anaId).set("Authorization", `Bearer ${rui}`).send({ company_ids: [1, 2] })).body.company_ids).toEqual([1, 2]);
    expect((await request(app).patch("/api/users/" + anaId).set("Authorization", `Bearer ${rui}`).send({ profile: "toc" })).status).toBe(403);
    expect((await request(app).post("/api/rules").set("Authorization", `Bearer ${rui}`).send({ company_id: 1, name: "cliente 1", type: "saldo_sinal", account_prefixes: ["11"], param: "devedor" })).status).toBe(201);
    expect((await request(app).post("/api/rules").set("Authorization", `Bearer ${rui}`).send({ name: "global", type: "saldo_sinal", account_prefixes: ["11"], param: "devedor" })).status).toBe(403);
    expect(coordId).toBeGreaterThan(0);
  });
});
