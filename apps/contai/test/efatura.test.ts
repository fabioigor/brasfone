import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import request from "supertest";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { parseEFaturaExport, parseMoney, splitEntity, normDocNumber, importEFatura, reconcileEFatura, efaturaSummary, buildNotification } from "../src/integrations/efatura.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste";
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));

describe("e-Fatura: leitura da exportacao", () => {
  it("le valores, datas, emitentes e numeros", () => {
    expect(parseMoney("658,05 €")).toBe(658.05); expect(parseMoney("1.234,56")).toBe(1234.56); expect(parseMoney("1,234.56")).toBe(1234.56); expect(parseMoney(12)).toBe(12); expect(parseMoney("")).toBeNull();
    expect(splitEntity("501442600 - ELECTRO FORNECEDORA LDA")).toEqual({ nif: "501442600", name: "ELECTRO FORNECEDORA LDA" });
    expect(splitEntity("509442013")).toEqual({ nif: "509442013", name: null });
    expect(normDocNumber("FT A/2026-0147")).toBe("FTA/2026-147"); expect(normDocNumber("ft a/2026-147")).toBe("FTA/2026-147"); expect(normDocNumber(null)).toBe("");
    const { rows, mapping } = parseEFaturaExport(fixture("efatura-compras.csv"), "efatura-compras.csv");
    expect(rows).toHaveLength(3);
    expect(mapping).toMatchObject({ issuer: 1, docType: 2, docNumber: 3, date: 4, total: 5, vat: 6, base: 7, status: 8 });
    expect(rows[0]).toMatchObject({ issuerNif: "501442600", issuerName: "ELECTRO FORNECEDORA LDA", docType: "Fatura", docNumber: "FT A/2026-0147", docDate: "2026-07-15", total: 658.05, vat: 123.05, base: 535, portalStatus: "Registada" });
    expect(rows[2]!.docType).toBe("Fatura-Recibo");
  });
});

describe("e-Fatura: conciliacao, pedidos automaticos e email", () => {
  let db: Db; let app: ReturnType<typeof createServer>; let staff: string; let client: string; let tmp: string;
  const mails: any[] = [];
  beforeAll(async () => {
    db = openDb(":memory:"); seedDemo(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contai-efatura-"));
    app = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmp, structured: null, mailer: { async sendMail(from, msg) { mails.push({ from, ...msg }); } }, mailFrom: "documentos@lumarcont.pt" });
    staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    client = (await request(app).post("/api/auth/login").send({ email: "padaria@demo.pt", password: "cliente123" })).body.token;
    // a Padaria ja enviou a factura da Electro Fornecedora
    await request(app).post("/api/documents").set("Authorization", `Bearer ${client}`).attach("file", fixture("factura-fornecedor.txt"), "electro.txt");
  });
  const S = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);
  const C = (r: request.Test) => r.set("Authorization", `Bearer ${client}`);

  it("importa, concilia e cria pedidos para os documentos em falta (idempotente)", async () => {
    expect((await C(request(app).post("/api/companies/1/efatura/import")).attach("file", fixture("efatura-compras.csv"), "e.csv")).status).toBe(403);
    const dry = await S(request(app).post("/api/companies/1/efatura/import?dry_run=1")).attach("file", fixture("efatura-compras.csv"), "e.csv");
    expect(dry.body.dryRun).toBe(true); expect(dry.body.total).toBe(3);
    const imp = await S(request(app).post("/api/companies/1/efatura/import")).attach("file", fixture("efatura-compras.csv"), "e.csv");
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ imported: 3, updated: 0 });
    expect(imp.body.reconcile).toMatchObject({ validated: 1, missing: 2, requestsCreated: 2, requestsFulfilled: 0 });
    expect(imp.body.summary).toMatchObject({ communicated: 3, validated: 1, missing: 2, missingTotal: 168.1, periods: ["2026-07"] });
    const again = await S(request(app).post("/api/companies/1/efatura/import")).attach("file", fixture("efatura-compras.csv"), "e.csv");
    expect(again.body).toMatchObject({ imported: 0, updated: 3 }); expect(again.body.reconcile.requestsCreated).toBe(0);
    const reqs = await C(request(app).get("/api/requests"));
    const fromEf = reqs.body.requests.filter((r: any) => r.from_efatura);
    expect(fromEf).toHaveLength(2); expect(fromEf[0].title).toMatch(/^Factura (FT 2026\/77 de TECNONORTE|FR 2026\/15 de RESTAURANTE)/);
    expect(fromEf.every((r: any) => r.status === "pendente")).toBe(true);
    const mine = await C(request(app).get("/api/companies/1/efatura?status=em_falta"));
    expect(mine.status).toBe(200); expect(mine.body.documents).toHaveLength(2); expect(mine.body.documents.every((d: any) => d.request_status === "pendente")).toBe(true);
    expect((await C(request(app).get("/api/companies/2/efatura"))).status).toBe(403);
    const dash = await C(request(app).get("/api/dashboard"));
    expect(dash.body.efatura).toMatchObject({ missing: 2, validated: 1 });
  });

  it("um documento que chega valida o comunicado em falta e cumpre o pedido", async () => {
    const txt = "TECNONORTE UNIPESSOAL LDA\nNIF: 509442013\n\nFACTURA FT 2026/77\nData: 20/07/2026\n\nCliente: Padaria Central Lda\nNIF: 506284417\n\nIncidencia: 100,00\nIVA (23%): 23,00\nTotal: 123,00 EUR\n";
    const up = await C(request(app).post("/api/documents")).attach("file", Buffer.from(txt), "tecnonorte-77.txt");
    expect(up.status).toBe(201);
    const row = db.prepare("SELECT status, document_id, match_confidence, request_id FROM efatura_documents WHERE doc_number = 'FT 2026/77'").get() as any;
    expect(row.status).toBe("validado"); expect(row.document_id).toBe(up.body.documentId); expect(row.match_confidence).toBe(1);
    const req = db.prepare("SELECT status, fulfilled_document_id FROM doc_requests WHERE id = ?").get(row.request_id) as any;
    expect(req).toEqual({ status: "cumprido", fulfilled_document_id: up.body.documentId });
    expect(efaturaSummary(db, 1)).toMatchObject({ validated: 2, missing: 1 });
    // correspondencia aproximada (numero diferente, mesma data e total)
    const txt2 = "RESTAURANTE O FORNO LDA\nNIF: 504426290\nFATURA-RECIBO FR 15\nData: 22/07/2026\nTotal: 45,10 EUR\n";
    await C(request(app).post("/api/documents")).attach("file", Buffer.from(txt2), "forno.txt");
    const fr = db.prepare("SELECT status, match_confidence FROM efatura_documents WHERE doc_number = 'FR 2026/15'").get() as any;
    expect(fr.status).toBe("validado"); expect(fr.match_confidence).toBe(0.9);
    expect(efaturaSummary(db, 1).missing).toBe(0);
  });

  it("ignorar cancela o pedido; voltar a pedir reabre na conciliacao", async () => {
    importEFatura(db, 1, [{ issuerNif: "500000000", issuerName: "OUTRA LDA", acquirerNif: null, docType: "Fatura", docNumber: "FT 9/1", atcud: null, docDate: "2026-07-30", total: 10, vat: 1.87, base: 8.13, portalStatus: "Registada", sector: null }], 1);
    const rec = reconcileEFatura(db, 1, 1);
    expect(rec.requestsCreated).toBe(1);
    const row = db.prepare("SELECT id, request_id FROM efatura_documents WHERE doc_number = 'FT 9/1'").get() as any;
    expect((await C(request(app).patch("/api/efatura/" + row.id)).send({ status: "ignorado" })).status).toBe(403);
    expect((await S(request(app).patch("/api/efatura/" + row.id)).send({ status: "ignorado" })).status).toBe(200);
    expect((db.prepare("SELECT status FROM doc_requests WHERE id = ?").get(row.request_id) as any).status).toBe("cancelado");
    expect(efaturaSummary(db, 1).communicated).toBe(3);
    await S(request(app).patch("/api/efatura/" + row.id)).send({ status: "em_falta" });
    const rec2 = reconcileEFatura(db, 1, 1);
    expect(rec2.requestsCreated).toBe(1); // novo pedido porque o anterior foi cancelado
    await S(request(app).patch("/api/efatura/" + row.id)).send({ status: "ignorado" });
  });

  it("prepara e envia o email com validados e em falta pela Graph", async () => {
    importEFatura(db, 1, [{ issuerNif: "509442013", issuerName: "TECNONORTE UNIPESSOAL LDA", acquirerNif: null, docType: "Fatura", docNumber: "FT 2026/78", atcud: null, docDate: "2026-07-28", total: 61.5, vat: 11.5, base: 50, portalStatus: "Registada", sector: null }], 1);
    reconcileEFatura(db, 1, 1);
    const onlyMissing = buildNotification(db, 1, { period: "2026-07" });
    expect(onlyMissing.subject).toMatch(/documentos de 07\/2026 em falta \(1\)/);
    expect(onlyMissing.html).not.toContain("<h3 style=\"color:#0F5A44\">Validados"); expect(onlyMissing.html).toContain("validámos 3 documento(s)");
    const draft = buildNotification(db, 1, { period: "2026-07", includeValidated: true });
    expect(draft.to).toEqual(["padaria@demo.pt"]);
    expect(draft.subject).toMatch(/documentos de 07\/2026 validados e em falta \(1 em falta\)/);
    expect(draft.validated).toHaveLength(3); expect(draft.missing).toHaveLength(1);
    expect(draft.html).toContain("FT 2026/78"); expect(draft.html).toContain("61,50 €"); expect(draft.text).toContain("EM FALTA (1, 61,50 €)");

    const preview = await S(request(app).get("/api/companies/1/efatura/notify?period=2026-07"));
    expect(preview.body.mail).toEqual({ configured: true, from: "documentos@lumarcont.pt" });
    expect((await C(request(app).get("/api/companies/1/efatura/notify"))).status).toBe(403);
    expect((await S(request(app).post("/api/companies/1/efatura/notify")).send({ to: ["nao-e-email"] })).status).toBe(400);
    const sent = await S(request(app).post("/api/companies/1/efatura/notify")).send({ period: "2026-07", message: "Obrigado pela atenção." });
    expect(sent.status).toBe(200); expect(sent.body.sent).toBe(true); expect(sent.body.to).toEqual(["padaria@demo.pt"]);
    expect(mails).toHaveLength(1); expect(mails[0].from).toBe("documentos@lumarcont.pt"); expect(mails[0].html).toContain("Obrigado pela atenção.");
    const hist = db.prepare("SELECT mode, validated_count, missing_count, recipients FROM efatura_notifications").all() as any[];
    expect(hist).toEqual([{ mode: "graph", validated_count: 3, missing_count: 1, recipients: "padaria@demo.pt" }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'efatura_notify'").get() as any).n).toBe(1);

    // sem Microsoft 365: devolve o texto para copiar
    const plain = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmp, structured: null });
    const s2 = (await request(plain).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    delete process.env.MS365_MAIL_USER; delete process.env.MS365_DRIVE_USER;
    const manual = await request(plain).post("/api/companies/1/efatura/notify").set("Authorization", `Bearer ${s2}`).send({});
    expect(manual.status).toBe(200); expect(manual.body.sent).toBe(false); expect(manual.body.text).toContain("EM FALTA");
  });
});
