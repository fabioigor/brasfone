import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import * as XLSX from "xlsx";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { parseGestObrigExport, importObligations, obligationsSummary, obligationCode, parsePeriod, parseDate, parseAccessExport } from "../src/integrations/gestobrig.js";
import { saveCredential, revealCredential, listCredentials, entityCodeFor } from "../src/domain/credentials.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste-para-cifrar-definicoes";
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));

describe("GestObrig: leitura das exportacoes", () => {
  it("reconhece codigos, periodos e datas em portugues", () => {
    expect(obligationCode("Declaração Periódica de IVA")).toBe("IVA-DP");
    expect(obligationCode("DMR - Declaração Mensal de Remunerações")).toBe("DMR");
    expect(obligationCode("Modelo 22 - IRC")).toBe("MOD22");
    expect(obligationCode("IES - Informação Empresarial Simplificada")).toBe("IES");
    expect(obligationCode("Renovação do certificado PME")).toBe("OUTRA");
    expect(parsePeriod("2º Trimestre 2026", null)).toBe("2026-T2");
    expect(parsePeriod("2026-08", null)).toBe("2026-08");
    expect(parsePeriod("Julho 2026", null)).toBe("2026-07");
    expect(parsePeriod("", "2026-09-10")).toBe("2026-09");
    expect(parseDate("20/08/2026")).toBe("2026-08-20");
    expect(parseDate("2026-08-20")).toBe("2026-08-20");
    expect(parseDate(46000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("le o CSV exportado (separador ;) e deriva estados", () => {
    const { rows, mapping } = parseGestObrigExport(fixture("gestobrig-obrigacoes.csv"), "gestobrig-obrigacoes.csv");
    expect(rows).toHaveLength(10);
    expect(mapping.nif).toBe(1); expect(mapping.due).toBe(4);
    const late = rows.find((r) => r.label.startsWith("DMR"))!;
    expect(late.status).toBe("fora_prazo"); expect(late.submittedAt).toBe("2026-09-12"); expect(late.period).toBe("2026-08");
    const iva = rows.find((r) => r.period === "2026-T2")!;
    expect(iva.status).toBe("cumprida"); expect(iva.nif).toBe("506284417");
    expect(rows.find((r) => r.label.startsWith("Modelo 22"))!.status).toBe("justificada");
    expect(rows.find((r) => r.label.startsWith("Pagamento por conta"))!.status).toBe("por_cumprir");
  });

  it("le o mesmo conteudo em Excel", () => {
    const csv = fixture("gestobrig-obrigacoes.csv").toString("utf8");
    const aoa = csv.trim().split("\n").map((l) => l.split(";"));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Obrigações");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const { rows } = parseGestObrigExport(buf, "export.xlsx");
    expect(rows).toHaveLength(10);
    expect(rows[0]!.dueDate).toBe("2026-08-20");
  });

  it("importa por NIF de forma idempotente e resume prazos", () => {
    const db = openDb(":memory:"); seedDemo(db);
    const { rows } = parseGestObrigExport(fixture("gestobrig-obrigacoes.csv"), "x.csv");
    const r1 = importObligations(db, rows, 1);
    expect(r1.imported).toBe(9); expect(r1.updated).toBe(0); expect(r1.skipped).toHaveLength(1);
    expect(r1.skipped[0]!.reason).toContain("500000000");
    const r2 = importObligations(db, rows, 1);
    expect(r2.imported).toBe(0); expect(r2.updated).toBe(9);
    expect((db.prepare("SELECT COUNT(*) AS n FROM obligations").get() as any).n).toBe(9);

    const s = obligationsSummary(db, 1, "2026-09-14", 7);
    expect(s.overdue).toBe(1);      // IES 2026-07-15
    expect(s.dueSoon).toBe(0);      // certificado PME 30/09 esta a 16 dias
    expect(s.open).toBe(3);
    expect(s.doneThisMonth).toBe(2); // DMR 12/09 (fora de prazo) + SAF-T 04/09
    const all = obligationsSummary(db, null, "2026-09-14", 7);
    expect(all.dueSoon).toBe(1);    // pagamento por conta 15/09 da TecnoNorte
    expect(all.lateThisYear).toBe(2); // DMR fora de prazo + Modelo 22 justificada
    const audit = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'obligations_import'").get() as any;
    expect(audit.n).toBe(2);
  });

  it("le a lista de acessos e classifica entidades", () => {
    const rows = parseAccessExport(fixture("gestobrig-acessos.csv"), "acessos.csv");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ nif: "506284417", username: "506284417", password: "Senha-AT-Ficticia-1" });
    expect(entityCodeFor(rows[1]!.entity)).toBe("SSD");
    expect(entityCodeFor(rows[2]!.entity)).toBe("IAPMEI");
  });
});

describe("cofre de acessos", () => {
  it("cifra a palavra-passe, revela com auditoria e nunca a lista em claro", () => {
    const db = openDb(":memory:"); seedDemo(db);
    const id = saveCredential(db, 1, 1, { entity: "SSD", username: "20012345678", password: "Segredo-SS-1" });
    const raw = db.prepare("SELECT password_enc FROM company_credentials WHERE id = ?").get(id) as any;
    expect(raw.password_enc).not.toContain("Segredo");
    const listed = listCredentials(db, 1);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("Segredo");
    expect(listed[0]).toMatchObject({ entity: "SSD", label: "Segurança Social Directa", has_password: true, url: "https://app.seg-social.pt/sso/login" });
    expect(revealCredential(db, id, 1, 2).password).toBe("Segredo-SS-1");
    expect(() => revealCredential(db, id, 2, 1)).toThrow(/inexistente/);
    const audit = db.prepare("SELECT user_id FROM audit_log WHERE action = 'credential_reveal'").all() as any[];
    expect(audit.map((a) => a.user_id)).toEqual([2]);
    saveCredential(db, 1, 1, { entity: "SSD", username: "20012345678", password: "" }, id);
    expect(revealCredential(db, id, 1, 1).password).toBe("Segredo-SS-1"); // vazio mantem a anterior
  });
});

describe("API de obrigacoes e acessos", () => {
  let db: Db; let app: ReturnType<typeof createServer>; let staff: string; let client: string;
  beforeAll(async () => {
    db = openDb(":memory:"); seedDemo(db);
    app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null });
    staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    client = (await request(app).post("/api/auth/login").send({ email: "padaria@demo.pt", password: "cliente123" })).body.token;
  });

  it("pre-visualiza e importa a exportacao; o cliente ve so a sua empresa", async () => {
    expect((await request(app).post("/api/obligations/import").set("Authorization", `Bearer ${client}`).attach("file", fixture("gestobrig-obrigacoes.csv"), "o.csv")).status).toBe(403);
    const dry = await request(app).post("/api/obligations/import?dry_run=1").set("Authorization", `Bearer ${staff}`).attach("file", fixture("gestobrig-obrigacoes.csv"), "o.csv");
    expect(dry.status).toBe(200); expect(dry.body.dryRun).toBe(true); expect(dry.body.total).toBe(10); expect(dry.body.matched).toBe(9);
    expect((db.prepare("SELECT COUNT(*) AS n FROM obligations").get() as any).n).toBe(0);
    const imp = await request(app).post("/api/obligations/import").set("Authorization", `Bearer ${staff}`).attach("file", fixture("gestobrig-obrigacoes.csv"), "o.csv");
    expect(imp.status).toBe(200); expect(imp.body.imported).toBe(9); expect(imp.body.skippedTotal).toBe(1);

    const mine = await request(app).get("/api/obligations?status=todas").set("Authorization", `Bearer ${client}`);
    expect(mine.status).toBe(200);
    expect(mine.body.obligations).toHaveLength(6);
    expect(mine.body.obligations.every((o: any) => o.company_id === 1)).toBe(true);
    const other = await request(app).get("/api/obligations?status=todas&company_id=2").set("Authorization", `Bearer ${client}`);
    expect(other.body.obligations.every((o: any) => o.company_id === 1)).toBe(true);
    const all = await request(app).get("/api/obligations?status=todas").set("Authorization", `Bearer ${staff}`);
    expect(all.body.obligations).toHaveLength(9);
    const open = await request(app).get("/api/obligations").set("Authorization", `Bearer ${staff}`);
    expect(open.body.obligations.every((o: any) => o.status === "por_cumprir")).toBe(true);
    expect(open.body.summary.open).toBe(4);

    const dash = await request(app).get("/api/dashboard").set("Authorization", `Bearer ${client}`);
    expect(dash.body.gestobrig.total).toBe(6);
    expect(dash.body.gestobrig.summary.open).toBe(3);
    expect(dash.body.gestobrig.open.every((o: any) => o.company_id === 1)).toBe(true);
  });

  it("o gabinete marca cumprida (fora de prazo se depois do limite) e reabre", async () => {
    const pme = db.prepare("SELECT id FROM obligations WHERE label LIKE 'Renova%'").get() as any;
    expect((await request(app).patch("/api/obligations/" + pme.id).set("Authorization", `Bearer ${client}`).send({ status: "cumprida" })).status).toBe(403);
    const ok = await request(app).patch("/api/obligations/" + pme.id).set("Authorization", `Bearer ${staff}`).send({ status: "cumprida", submitted_at: "2026-09-20" });
    expect(ok.status).toBe(200); expect(ok.body.obligation.status).toBe("cumprida");
    const late = await request(app).patch("/api/obligations/" + pme.id).set("Authorization", `Bearer ${staff}`).send({ status: "cumprida", submitted_at: "2026-10-02" });
    expect(late.body.obligation.status).toBe("fora_prazo");
    const re = await request(app).patch("/api/obligations/" + pme.id).set("Authorization", `Bearer ${staff}`).send({ status: "por_cumprir" });
    expect(re.body.obligation.status).toBe("por_cumprir"); expect(re.body.obligation.submitted_at).toBeNull();
    expect((await request(app).patch("/api/obligations/" + pme.id).set("Authorization", `Bearer ${staff}`).send({ status: "invalido" })).status).toBe(400);
  });

  it("acessos: cliente gere os da sua empresa, nunca os de outra; revelar fica auditado", async () => {
    const create = await request(app).post("/api/companies/1/credentials").set("Authorization", `Bearer ${staff}`).send({ entity: "AT", username: "506284417", password: "Senha-AT-Teste" });
    expect(create.status).toBe(200); expect(create.body.credential.has_password).toBe(true);
    expect(JSON.stringify(create.body)).not.toContain("Senha-AT");
    const id = create.body.credential.id;

    const list = await request(app).get("/api/companies/1/credentials").set("Authorization", `Bearer ${client}`);
    expect(list.status).toBe(200); expect(list.body.credentials).toHaveLength(1); expect(list.body.entities.length).toBeGreaterThan(5);
    expect((await request(app).get("/api/companies/2/credentials").set("Authorization", `Bearer ${client}`)).status).toBe(403);
    expect((await request(app).post("/api/companies/2/credentials").set("Authorization", `Bearer ${client}`).send({ entity: "AT", username: "x" })).status).toBe(403);
    expect((await request(app).post("/api/companies/2/credentials/" + id + "/reveal").set("Authorization", `Bearer ${client}`)).status).toBe(403);

    const reveal = await request(app).post("/api/companies/1/credentials/" + id + "/reveal").set("Authorization", `Bearer ${client}`);
    expect(reveal.status).toBe(200); expect(reveal.body.password).toBe("Senha-AT-Teste"); expect(reveal.body.url).toContain("portaldasfinancas");
    const audit = db.prepare("SELECT user_id FROM audit_log WHERE action = 'credential_reveal' AND entity_id = ?").all(id) as any[];
    expect(audit).toHaveLength(1); expect(audit[0].user_id).toBe(2);

    // o cliente pode actualizar a palavra-passe da sua empresa (mudou-a no portal)
    const upd = await request(app).post("/api/companies/1/credentials").set("Authorization", `Bearer ${client}`).send({ id, entity: "AT", username: "506284417", password: "Nova-Senha-AT", notes: "Alterada em Setembro" });
    expect(upd.status).toBe(200);
    expect((await request(app).post("/api/companies/1/credentials/" + id + "/reveal").set("Authorization", `Bearer ${staff}`)).body.password).toBe("Nova-Senha-AT");
    expect((await request(app).post("/api/companies/1/credentials").set("Authorization", `Bearer ${staff}`).send({ entity: "OUTRO", url: "ftp://x" })).status).toBe(400);

    expect((await request(app).delete("/api/companies/1/credentials/" + id).set("Authorization", `Bearer ${client}`)).status).toBe(403);
    expect((await request(app).delete("/api/companies/1/credentials/" + id).set("Authorization", `Bearer ${staff}`)).status).toBe(200);
    expect((await request(app).get("/api/companies/1/credentials").set("Authorization", `Bearer ${staff}`)).body.credentials).toHaveLength(0);
  });

  it("importa a lista de acessos do GestObrig por NIF", async () => {
    const r = await request(app).post("/api/credentials/import").set("Authorization", `Bearer ${staff}`).attach("file", fixture("gestobrig-acessos.csv"), "acessos.csv");
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(4); expect(r.body.skippedTotal).toBe(1);
    const padaria = (await request(app).get("/api/companies/1/credentials").set("Authorization", `Bearer ${client}`)).body.credentials;
    expect(padaria.map((c: any) => c.entity).sort()).toEqual(["AT", "IAPMEI", "SSD"]);
    expect(padaria.find((c: any) => c.entity === "IAPMEI").url).toBe("https://www.iapmei.pt");
    const again = await request(app).post("/api/credentials/import").set("Authorization", `Bearer ${staff}`).attach("file", fixture("gestobrig-acessos.csv"), "acessos.csv");
    expect(again.body.imported).toBe(0); expect(again.body.updated).toBe(4);
    expect((await request(app).post("/api/credentials/import").set("Authorization", `Bearer ${staff}`).attach("file", Buffer.from("a;b\n1;2\n"), "vazio.csv")).status).toBe(400);
  });
});
