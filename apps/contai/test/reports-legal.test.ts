import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import path from "node:path";
import request from "supertest";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { buildReportData, computeTrafficLights, computeRecommendations, computeSectorModel, sectorModelFor, REPORT_BLOCKS } from "../src/domain/financialReport.js";
import { renderReportHtml } from "../src/domain/reportHtml.js";
import { parseBalanceCsv, saveTrialBalance } from "../src/domain/trialBalance.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste";
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));

describe("Modulo C: dez blocos, semaforos, recomendacoes e modelos sectoriais", () => {
  it("monta os dados e o HTML com todos os blocos; a seleccao mantem os fixos", () => {
    const db = openDb(":memory:"); seedDemo(db);
    saveTrialBalance(db, { companyId: 1, period: "2026-06", source: "importado", lines: parseBalanceCsv(fixture("balancete-2026-06.csv").toString()) }, 1);
    saveTrialBalance(db, { companyId: 1, period: "2026-07", source: "importado", lines: parseBalanceCsv(fixture("balancete-2026-07.csv").toString()) }, 1);
    const d = buildReportData(db, 1, "2026-07");
    expect(d.trafficLights).toHaveLength(6); expect(d.trafficLights!.every((t) => ["verde", "amarelo", "vermelho", "cinzento"].includes(t.light))).toBe(true);
    expect(d.recommendations).toHaveLength(3); expect(d.recommendations!.every((r) => r.title && r.text && r.basis)).toBe(true);
    expect(d.sectorModel!.key).toBe("industria"); // CAE 10711 (padaria = divisão 10)
    expect(d.alerts).toMatchObject({ blocking: 0, alerts: 0 }); expect(d.benchmark!.version).toBeTruthy();
    expect(sectorModelFor("47110").key).toBe("comercio"); expect(sectorModelFor("56101").key).toBe("restauracao"); expect(sectorModelFor("86210").key).toBe("saude"); expect(sectorModelFor("99999").key).toBe("generico"); expect(sectorModelFor(null).key).toBe("generico");
    const html = renderReportHtml(d);
    for (const t of ["Saúde do negócio em seis indicadores", "Memória descritiva", "Tesouraria e prazos médios", "Posição face ao sector", "desfasamento de 12 a 24 meses", "Alertas fiscais e obrigações", "Três recomendações", "Anexo metodológico", "Cont.ai by Lumarcont"]) expect(html).toContain(t);
    d.sections = REPORT_BLOCKS.filter((b) => b.fixed).map((b) => b.id);
    const minimal = renderReportHtml(d);
    expect(minimal).not.toContain("Saúde do negócio em seis indicadores"); expect(minimal).not.toContain("Tesouraria e prazos médios");
    expect(minimal).toContain("Três recomendações"); expect(minimal).toContain("Anexo metodológico");
  });

  it("semaforos e recomendacoes sao deterministas e rastreaveis a indicadores", () => {
    const f = { vendas: 100000, cmvmc: 40000, fse: 20000, pessoal: 30000, outrosGastos: 5000, ebitda: 5000, resultadoLiquido: -2000, activo: 80000, capitalProprio: 8000, passivo: 72000, clientes: 40000, fornecedores: 10000, disponibilidades: 5000, financiamentos: 20000 };
    const p = { ...f, vendas: 120000, ebitda: 9000 };
    const lights = computeTrafficLights(f, p, []);
    expect(lights.find((l) => l.key === "vendas")!.light).toBe("vermelho");    // -16.7%
    expect(lights.find((l) => l.key === "resultado")!.light).toBe("vermelho");
    expect(lights.find((l) => l.key === "autonomia")!.light).toBe("cinzento"); // sem rácio calculado
    expect(lights.find((l) => l.key === "margem")!.value).toBe("5.0%");
    const recs = computeRecommendations(f, p, [{ key: "prazo_medio_recebimento", label: "PMR", unit: "dias", company: 146, sector: 30, verdict: "pior", higherIsBetter: false }], computeTrafficLights(f, p, [{ key: "prazo_medio_recebimento", label: "PMR", unit: "dias", company: 146, sector: 30, verdict: "pior", higherIsBetter: false }]));
    expect(recs).toHaveLength(3); expect(recs[0]!.title).toMatch(/prazo de recebimento/); expect(recs[0]!.basis).toBe("prazo médio de recebimento");
    const model = computeSectorModel("47110", f, 20000);
    expect(model.key).toBe("comercio"); expect(model.indicators.find((i) => i.label === "Margem bruta")!.value).toBe("60.0%"); expect(model.indicators.find((i) => i.label === "Rotação de inventário")!.value).toBe("2.0x");
    expect(computeSectorModel("69200", f, 0).indicators.some((i) => i.value === "n.d." && /colaboradores/.test(i.note || ""))).toBe(true);
  });
});

describe("API: relatorios aprovados, balancetes publicados e base legal", () => {
  let db: Db; let app: ReturnType<typeof createServer>; let staff: string; let client: string;
  const mails: any[] = [];
  beforeAll(async () => {
    db = openDb(":memory:"); seedDemo(db);
    app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null, mailer: { async sendMail(from, msg) { mails.push({ from, ...msg }); } }, mailFrom: "documentos@lumarcont.pt" });
    staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    client = (await request(app).post("/api/auth/login").send({ email: "padaria@demo.pt", password: "cliente123" })).body.token;
    for (const per of ["2026-06", "2026-07"]) await request(app).post("/api/balances/1/import").set("Authorization", `Bearer ${staff}`).field("period", per).attach("file", fixture(`balancete-${per}.csv`), "b.csv");
  });
  const S = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);
  const C = (r: request.Test) => r.set("Authorization", `Bearer ${client}`);

  it("o cliente so ve relatorios aprovados; recomendacoes editaveis ate a aprovacao; blocos escolhidos", async () => {
    const created = await S(request(app).post("/api/reports/1")).send({ period: "2026-07", sections: ["semaforo", "actividade"] });
    expect(created.status).toBe(201); expect(created.body.approved).toBe(false); expect(created.body.template).toBe("industria");
    const id = created.body.id;
    expect((await C(request(app).get("/api/reports"))).body.reports).toHaveLength(0);
    expect((await C(request(app).get("/api/reports/" + id + "/html"))).status).toBe(403);
    const detail = await S(request(app).get("/api/reports/" + id));
    expect(detail.body.data.sections.sort()).toEqual(["actividade", "alertas", "capa", "memoria", "metodologia", "recomendacoes", "semaforo"].sort());
    const html1 = (await S(request(app).get("/api/reports/" + id + "/html"))).text;
    expect(html1).toContain("Saúde do negócio"); expect(html1).not.toContain("Tesouraria e prazos médios");
    const edited = await S(request(app).patch("/api/reports/" + id)).send({ recommendations: [{ title: "Rever preços de venda", text: "Actualize a tabela de preços antes do Natal." }] });
    expect(edited.status).toBe(200); expect(edited.body.recommendations[0].basis).toBe("contabilista");
    expect((await S(request(app).get("/api/reports/" + id + "/html"))).text).toContain("Rever preços de venda");
    expect((await S(request(app).post("/api/reports/" + id + "/approve")).send({})).body.approved).toBe(true);
    expect((await S(request(app).patch("/api/reports/" + id)).send({ recommendations: [{ title: "x y", text: "z z" }] })).status).toBe(409);
    const mine = await C(request(app).get("/api/reports"));
    expect(mine.body.reports).toHaveLength(1); expect(mine.body.reports[0].approved_name).toBe("Maria Contabilista");
    expect((await C(request(app).get("/api/reports/" + id + "/html"))).status).toBe(200);
    expect((await S(request(app).post("/api/reports/" + id + "/approve")).send({ approved: false })).body.approved).toBe(false);
    expect((await C(request(app).get("/api/reports"))).body.reports).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'report' AND action IN ('approve','unapprove')").get() as any).n).toBe(2);
  });

  it("balancetes: o cliente so ve os disponibilizados, descarrega CSV e envia por email com anexo", async () => {
    expect((await C(request(app).get("/api/balances/1"))).body.balances).toHaveLength(0);
    expect((await C(request(app).get("/api/balances/1/2026-07"))).status).toBe(403);
    expect((await C(request(app).get("/api/balances/1/2026-07/csv"))).status).toBe(403);
    expect((await C(request(app).post("/api/balances/1/2026-07/publish")).send({})).status).toBe(403);
    expect((await S(request(app).post("/api/balances/1/2026-07/publish")).send({})).body.published).toBe(true);
    const list = await C(request(app).get("/api/balances/1"));
    expect(list.body.balances.map((b: any) => b.period)).toEqual(["2026-07"]); expect(list.body.balances[0].published_name).toBe("Maria Contabilista");
    expect((await S(request(app).get("/api/balances/1"))).body.balances).toHaveLength(2);
    const csv = await C(request(app).get("/api/balances/1/2026-07/csv"));
    expect(csv.status).toBe(200); expect(csv.headers["content-type"]).toContain("text/csv"); expect(csv.headers["content-disposition"]).toContain("balancete-Padaria_Central_Lda-2026-07.csv");
    expect(csv.text).toContain("Conta;Descricao;Debito;Credito;Saldo"); expect(csv.text.split("\n").length).toBeGreaterThan(10);
    const sent = await C(request(app).post("/api/balances/1/2026-07/send")).send({});
    expect(sent.status).toBe(200); expect(sent.body.to).toEqual(["padaria@demo.pt"]);
    expect(mails).toHaveLength(1); expect(mails[0].attachments[0].name).toBe("balancete-2026-07.csv"); expect(mails[0].html).toContain("Padaria Central Lda"); expect(mails[0].subject).toBe("Balancete Padaria Central Lda · 2026-07");
    expect((await C(request(app).post("/api/balances/1/2026-06/send")).send({})).status).toBe(403);
    expect((await S(request(app).post("/api/balances/1/2026-07/publish")).send({ published: false })).body.published).toBe(false);
    expect((await C(request(app).get("/api/balances/1"))).body.balances).toHaveLength(0);
    expect((await C(request(app).get("/api/balances/2"))).status).toBe(403);
  });

  it("base legal: coordenador regista, so o TOC valida; datas de publicacao e eficacia separadas", async () => {
    const created = await S(request(app).post("/api/legal")).send({ type: "oficio_circulado", reference: "Ofício-Circulado 25117/2026", title: "Verba 2.42 da Lista I: construção para habitação", summary: "Articulação com autoliquidação", published_at: "2026-06-15", effective_from: "2026-07-01", affects: "verba 2.42; regra A2.04" });
    expect(created.status).toBe(201); expect(created.body.source.status).toBe("pendente");
    const id = created.body.source.id;
    expect((await S(request(app).post("/api/legal")).send({ type: "outro", reference: "x", title: "t", effective_from: "2026-01-01" })).status).toBe(400);
    expect((await C(request(app).get("/api/legal"))).status).toBe(403);
    db.prepare("UPDATE users SET profile = 'coordenador' WHERE email = 'gabinete@demo.pt'").run();
    const coord = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    expect((await request(app).patch("/api/legal/" + id).set("Authorization", `Bearer ${coord}`).send({ status: "validado" })).status).toBe(403);
    expect((await request(app).patch("/api/legal/" + id).set("Authorization", `Bearer ${coord}`).send({ summary: "Resumo revisto" })).status).toBe(200);
    db.prepare("UPDATE users SET profile = 'toc' WHERE email = 'gabinete@demo.pt'").run();
    const validated = await S(request(app).patch("/api/legal/" + id)).send({ status: "validado" });
    expect(validated.body.source.status).toBe("validado"); expect(validated.body.source.validated_by).toBeTruthy();
    const list = await S(request(app).get("/api/legal?status=validado"));
    expect(list.body.sources).toHaveLength(1); expect(list.body.sources[0].validated_name).toBe("Maria Contabilista"); expect(list.body.cadence.diario_republica).toBe("diária"); expect(list.body.knowledge.length).toBeGreaterThan(0);
    expect((await S(request(app).delete("/api/legal/" + id))).status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'legal_source'").get() as any).n).toBe(4);
  });
});
