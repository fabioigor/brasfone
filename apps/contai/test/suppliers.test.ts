import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { SupplierDiscovery, mergeCandidates, SupplierCandidate, DiscoveryAgent } from "../src/integrations/supplierDiscovery.js";
import { applyCostCenter, proposeEntry } from "../src/domain/entries.js";
import { exportApprovedEntries } from "../src/domain/exportPrimavera.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste";
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));
const cand = (name: string, kind: SupplierCandidate["kind"], probability: number, source: string): SupplierCandidate => ({ name, kind, probability, sources: [source], evidence: [], website: null, activity: null });

/** VIES fake: 509442013 has a name; 500000000 is unknown; anything else fails. */
const viesFetch: typeof fetch = async (input: any) => {
  const url = String(input);
  if (url.endsWith("/509442013")) return new Response(JSON.stringify({ isValid: true, userError: "VALID", name: "TECNONORTE UNIPESSOAL LDA", address: "RUA A 1\nPORTO", viesApproximate: { name: "---" } }), { status: 200 });
  if (url.endsWith("/500000001")) return new Response(JSON.stringify({ isValid: false, userError: "INVALID_INPUT", name: "---", address: "---" }), { status: 200 });
  if (url.endsWith("/123456789")) return new Response(JSON.stringify({ isValid: true, userError: "VALID", name: "---", address: "---" }), { status: 200 });
  return new Response("boom", { status: 500 });
};
const fakeAgent: DiscoveryAgent = {
  enabled: true,
  async discoverSupplier(nif) {
    if (nif !== "509442013") return { candidates: [], sources: [] };
    return { candidates: [cand("TecnoNorte", "marca", 0.9, "ia_web"), cand("Tecnonorte Unipessoal, Lda.", "denominacao", 0.85, "ia_web"), cand("NorteSoft", "marca", 0.35, "ia_web")], sources: ["https://exemplo.pt/nif"] };
  },
};

describe("descoberta de fornecedor por NIF", () => {
  it("funde candidatos de varias fontes e ordena por probabilidade", () => {
    const merged = mergeCandidates([[cand("TECNONORTE UNIPESSOAL LDA", "denominacao", 0.95, "vies")], [cand("TecnoNorte", "marca", 0.9, "ia_web"), cand("Tecnonorte Unipessoal, Lda.", "denominacao", 0.85, "ia_web")], [cand("TecnoNorte Lda", "nome_comercial", 0.6, "documento")]]);
    expect(merged.map((c) => c.name)).toEqual(["TECNONORTE UNIPESSOAL LDA"]);
    expect(merged[0]!.aliases).toEqual(["TecnoNorte", "Tecnonorte Unipessoal, Lda.", "TecnoNorte Lda"]);
    expect(merged[0]!.sources.sort()).toEqual(["documento", "ia_web", "vies"]);
    expect(merged[0]!.probability).toBeGreaterThan(0.95);
    expect(merged[0]!.probability).toBeLessThanOrEqual(0.99);
  });

  it("consulta VIES + IA + documento, guarda em cache e regista auditoria", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const d = new SupplierDiscovery(db, { fetchImpl: viesFetch, agent: fakeAgent });
    const r = await d.discover("509442013", { nameOnDocument: "TecnoNorte Lda" }, { userId: 1 });
    expect(r.validNif).toBe(true); expect(r.officialName).toBe("TECNONORTE UNIPESSOAL LDA"); expect(r.address).toContain("PORTO");
    expect(r.sources.sort()).toEqual(["documento", "ia_web", "nif", "vies"]);
    expect(r.candidates[0]!.name).toBe("TECNONORTE UNIPESSOAL LDA");
    expect(r.candidates.find((c) => c.name === "NorteSoft")!.probability).toBe(0.35);
    expect(r.fromCache).toBe(false);
    const again = await d.discover("509442013", {});
    expect(again.fromCache).toBe(true); expect(again.candidates.length).toBe(2);
    expect(again.candidates[0]!.aliases).toContain("TecnoNorte");
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supplier_discovery'").get() as any).n).toBe(1);
    const unknown = await d.discover("500000001", {});
    expect(unknown.validNif).toBe(false); expect(unknown.officialName).toBeNull(); expect(unknown.candidates).toEqual([]);
    expect(unknown.notes.join(" ")).toMatch(/dígito de controlo/);
    const silent = await d.discover("123456789", {});
    expect(silent.notes.join(" ")).toMatch(/não divulga o nome/);
    const down = await new SupplierDiscovery(db, { fetchImpl: viesFetch, agent: null }).discover("506284417", { nameOnDocument: "Padaria Central" });
    expect(down.notes.join(" ")).toMatch(/VIES respondeu HTTP 500/); expect(down.notes.join(" ")).toMatch(/Sem chave/);
    expect(down.candidates).toEqual([expect.objectContaining({ name: "Padaria Central", kind: "nome_comercial", probability: 0.6 })]);
    await expect(d.discover("12", {})).rejects.toThrow(/9 dígitos/);
  });
});

describe("centros de custo nas linhas e na exportacao", () => {
  it("aplica o centro as contas de gasto/rendimento e exporta a coluna", () => {
    const lines = applyCostCenter([{ account: "62", description: "FSE", debit: 100, credit: 0 }, { account: "2432", description: "IVA", debit: 23, credit: 0 }, { account: "221", description: "Forn", debit: 0, credit: 123 }], "LOJA");
    expect(lines.map((l) => l.costCenter)).toEqual(["LOJA", null, null]);
    const p = proposeEntry("factura_compra", { nifs: ["509442013"], items: [], issuerNif: "509442013", docNumber: "FT 1", docDate: "2026-09-01", totalAmount: 123, vatAmount: 23, vatRate: 23, netAmount: 100, currency: "EUR", sources: ["heuristica"] }, 0.8, "X", { costCenter: "PROJ" })!;
    expect(p.lines[0]!.costCenter).toBe("PROJ"); expect(p.lines[2]!.costCenter).toBeNull();
    const db = openDb(":memory:"); seedDemo(db);
    const docId = Number(db.prepare("INSERT INTO documents (company_id, uploader_id, original_name, stored_path, mime_type, size_bytes, sha256) VALUES (1, 1, 'a.pdf', 'a', 'application/pdf', 1, 'h1')").run().lastInsertRowid);
    db.prepare("INSERT INTO entries (document_id, company_id, entry_date, journal, description, lines_json, confidence, status) VALUES (?, 1, '2026-09-01', 'Compras', 'x', ?, 0.9, 'aprovado')").run(docId, JSON.stringify(lines));
    const out = exportApprovedEntries(db, 1, 1);
    expect(out.csv.split("\n")[0]).toBe("Diario;Data;Documento;Conta;Descricao;Debito;Credito;CentroCusto");
    expect(out.csv).toContain(";62;FSE;100,00;0,00;LOJA");
    expect(out.csv).toContain(";221;Forn;0,00;123,00;\n");
  });
});

describe("API: centros de custo, fornecedores, recepcao com tipo e centro", () => {
  let db: Db; let app: ReturnType<typeof createServer>; let staff: string; let client: string; let tmp: string;
  beforeAll(async () => {
    db = openDb(":memory:"); seedDemo(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contai-sup-"));
    app = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmp, structured: null, discovery: new SupplierDiscovery(db, { fetchImpl: viesFetch, agent: fakeAgent }) });
    staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    client = (await request(app).post("/api/auth/login").send({ email: "padaria@demo.pt", password: "cliente123" })).body.token;
  });
  const S = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);
  const C = (r: request.Test) => r.set("Authorization", `Bearer ${client}`);

  it("gere centros de custo por empresa; o cliente le os da sua empresa", async () => {
    const list = await C(request(app).get("/api/companies/1/cost-centers"));
    expect(list.status).toBe(200); expect(list.body.cost_centers.map((c: any) => c.code)).toEqual(["ADMIN", "FABRICO", "LOJA"]); expect(list.body.doc_types.length).toBe(7);
    expect((await C(request(app).get("/api/companies/2/cost-centers"))).status).toBe(403);
    expect((await C(request(app).post("/api/companies/1/cost-centers").send({ code: "X", name: "x" }))).status).toBe(403);
    const created = await S(request(app).post("/api/companies/1/cost-centers").send({ code: "obras", name: "Obras" }));
    expect(created.status).toBe(201); expect(created.body.cost_center.code).toBe("OBRAS");
    expect((await S(request(app).post("/api/companies/1/cost-centers").send({ code: "OBRAS", name: "dup" }))).status).toBe(409);
    expect((await S(request(app).post("/api/companies/1/cost-centers").send({ code: "com espaço", name: "x" }))).status).toBe(400);
    const ren = await S(request(app).patch("/api/cost-centers/" + created.body.cost_center.id).send({ name: "Obras e reparações", active: false }));
    expect(ren.body.cost_center.name).toBe("Obras e reparações"); expect(ren.body.cost_center.active).toBe(0);
    expect((await C(request(app).get("/api/companies/1/cost-centers"))).body.cost_centers.length).toBe(3);
    const del = await S(request(app).delete("/api/cost-centers/" + created.body.cost_center.id));
    expect(del.body.deactivated).toBe(false);
  });

  it("carregar com tipo e centro de custo: o documento e o lancamento herdam-nos", async () => {
    const loja = (db.prepare("SELECT id FROM cost_centers WHERE company_id = 1 AND code = 'LOJA'").get() as any).id;
    const bad = await C(request(app).post("/api/documents").attach("file", fixture("factura-fornecedor.txt"), "f1.txt").field("cost_center_id", "999"));
    expect(bad.status).toBe(400);
    const up = await C(request(app).post("/api/documents").attach("file", fixture("factura-fornecedor.txt"), "f1.txt").field("cost_center_id", String(loja)).field("doc_type", "despesa"));
    expect(up.status).toBe(201); expect(up.body.docType).toBe("despesa");
    const doc = db.prepare("SELECT doc_type, client_doc_type, cost_center_id, classification_source FROM documents WHERE id = ?").get(up.body.documentId) as any;
    expect(doc).toMatchObject({ doc_type: "despesa", client_doc_type: "despesa", cost_center_id: loja, classification_source: "cliente" });
    const entry = db.prepare("SELECT lines_json FROM entries WHERE document_id = ?").get(up.body.documentId) as any;
    const lines = JSON.parse(entry.lines_json);
    expect(lines.find((l: any) => /^6/.test(l.account)).costCenter).toBe("LOJA");
    expect(lines.find((l: any) => /^221/.test(l.account)).costCenter).toBeNull();

    const entries = await S(request(app).get("/api/entries?status=pendente"));
    const e = entries.body.entries.find((x: any) => x.document_id === up.body.documentId);
    expect(e.cost_centers.length).toBe(3); expect(e.document_cost_center_id).toBe(loja); expect(e.client_doc_type).toBe("despesa");
    expect(e.supplier).toMatchObject({ known: false, registered: false });
    expect(e.supplier.nif).toMatch(/^\d{9}$/);
  });

  it("o gabinete corrige tipo e centro depois da recepcao e re-propoe", async () => {
    const docId = (db.prepare("SELECT id FROM documents WHERE client_doc_type = 'despesa' ORDER BY id DESC").get() as any).id;
    const admin = (db.prepare("SELECT id FROM cost_centers WHERE company_id = 1 AND code = 'ADMIN'").get() as any).id;
    const r = await S(request(app).post("/api/documents/" + docId + "/intake").send({ doc_type: "factura_compra", cost_center_id: admin }));
    expect(r.status).toBe(200); expect(r.body.docType).toBe("factura_compra"); expect(r.body.costCenter).toBe("ADMIN");
    const lines = JSON.parse((db.prepare("SELECT lines_json FROM entries WHERE document_id = ? AND status = 'pendente'").get(docId) as any).lines_json);
    expect(lines.find((l: any) => /^6/.test(l.account)).costCenter).toBe("ADMIN");
    expect((db.prepare("SELECT COUNT(*) AS n FROM entries WHERE document_id = ?").get(docId) as any).n).toBe(1);
    expect((await S(request(app).post("/api/documents/" + docId + "/intake").send({ cost_center_id: 999 }))).status).toBe(400);
    expect((await C(request(app).post("/api/documents/" + docId + "/intake").send({ doc_type: "recibo" }))).status).toBe(403);
  });

  it("aprovar com centro de custo por linha valida o codigo", async () => {
    const e = (db.prepare("SELECT id, lines_json FROM entries WHERE status = 'pendente' ORDER BY id DESC").get() as any);
    const lines = JSON.parse(e.lines_json).map((l: any) => ({ account: l.account, description: l.description, debit: l.debit, credit: l.credit, cost_center: /^6/.test(l.account) ? "FABRICO" : null }));
    expect((await S(request(app).post("/api/entries/" + e.id + "/decision").send({ action: "aprovar", lines: lines.map((l: any) => ({ ...l, cost_center: l.cost_center ? "NAOEXISTE" : null })) }))).status).toBe(400);
    const ok = await S(request(app).post("/api/entries/" + e.id + "/decision").send({ action: "aprovar", lines }));
    expect(ok.status).toBe(200);
    const saved = JSON.parse((db.prepare("SELECT lines_json FROM entries WHERE id = ?").get(e.id) as any).lines_json);
    expect(saved.find((l: any) => /^6/.test(l.account)).costCenter).toBe("FABRICO");
  });

  it("pesquisa o NIF, cria o fornecedor com marca e centros de custo e aplica aos pendentes", async () => {
    // Documento da TecnoNorte (NIF 509442013) recebido pela Padaria: fornecedor novo.
    const txt = fixture("factura-fornecedor.txt").toString("utf8").replace(/\b\d{9}\b/g, (m) => (m === "506284417" ? m : "509442013"));
    const up = await S(request(app).post("/api/documents").attach("file", Buffer.from(txt + "\nNIF 509442013\n"), "tecnonorte.txt").field("company_id", "1"));
    expect(up.status).toBe(201);
    const entries = await S(request(app).get("/api/entries?status=pendente"));
    const e = entries.body.entries.find((x: any) => x.document_id === up.body.documentId);
    expect(e.supplier.nif).toBe("509442013"); expect(e.supplier.known).toBe(false);

    expect((await C(request(app).post("/api/suppliers/discover").send({ nif: "509442013" }))).status).toBe(403);
    const disc = await S(request(app).post("/api/suppliers/discover").send({ nif: "509442013", company_id: 1, document_id: up.body.documentId }));
    expect(disc.status).toBe(200); expect(disc.body.officialName).toBe("TECNONORTE UNIPESSOAL LDA");
    expect(disc.body.candidates.map((c: any) => c.name)).toContain("NorteSoft");
    expect(disc.body.candidates.every((c: any) => typeof c.probability === "number")).toBe(true);

    const unknown = await S(request(app).get("/api/suppliers?company_id=1&status=desconhecidos"));
    expect(unknown.body.suppliers.some((s: any) => s.nif === "509442013" && s.pending_entries === 1)).toBe(true);

    const loja = (db.prepare("SELECT id FROM cost_centers WHERE company_id = 1 AND code = 'LOJA'").get() as any).id;
    const fab = (db.prepare("SELECT id FROM cost_centers WHERE company_id = 1 AND code = 'FABRICO'").get() as any).id;
    const created = await S(request(app).post("/api/companies/1/suppliers").send({
      nif: "509442013", name: "TECNONORTE UNIPESSOAL LDA", brand: "TecnoNorte", aliases: ["NorteSoft"], website: "https://tecnonorte.example", activity: "Consultoria informática",
      expense_account: "6221", cost_center_ids: [loja, fab], default_cost_center_id: fab, candidate: { name: "TecnoNorte", kind: "marca", probability: 0.9, sources: ["ia_web"] },
    }));
    expect(created.status).toBe(201);
    expect(created.body.supplier).toMatchObject({ nif: "509442013", brand: "TecnoNorte", known: true, aliases: ["NorteSoft"], default_cost_center_id: fab });
    expect(created.body.supplier.cost_centers.map((c: any) => c.code).sort()).toEqual(["FABRICO", "LOJA"]);
    expect(created.body.applied_to_pending).toBe(1);
    const lines = JSON.parse((db.prepare("SELECT lines_json FROM entries WHERE document_id = ?").get(up.body.documentId) as any).lines_json);
    const gasto = lines.find((l: any) => l.debit > 0 && /^(3|6)/.test(l.account));
    expect(gasto.account).toBe("6221"); expect(gasto.costCenter).toBe("FABRICO");

    const after = await S(request(app).get("/api/entries?status=pendente"));
    const e2 = after.body.entries.find((x: any) => x.document_id === up.body.documentId);
    expect(e2.supplier).toMatchObject({ known: true, registered: true, brand: "TecnoNorte", default_cost_center_id: fab });

    expect((await S(request(app).post("/api/companies/1/suppliers").send({ nif: "509442013", name: "X", cost_center_ids: [999] }))).status).toBe(400);
    expect((await S(request(app).post("/api/companies/1/suppliers").send({ nif: "12", name: "X" }))).status).toBe(400);
    expect((await C(request(app).post("/api/companies/1/suppliers").send({ nif: "509442013", name: "X" }))).status).toBe(403);

    const patched = await S(request(app).patch("/api/suppliers/" + created.body.supplier.id).send({ brand: "TecnoNorte Soluções", cost_center_ids: [loja], default_cost_center_id: loja }));
    expect(patched.body.supplier.brand).toBe("TecnoNorte Soluções"); expect(patched.body.supplier.cost_centers.map((c: any) => c.code)).toEqual(["LOJA"]);
    const audit = db.prepare("SELECT action FROM audit_log WHERE action IN ('supplier_register','supplier_update','supplier_discovery')").all() as any[];
    expect(audit.map((a) => a.action).sort()).toEqual(["supplier_discovery", "supplier_register", "supplier_update"]);

    // Novo documento do fornecedor registado herda o centro habitual sem o cliente escolher.
    const up2 = await S(request(app).post("/api/documents").attach("file", Buffer.from(txt.replace(/FT\s*\S+/, "FT 2026/999") + "\nNIF 509442013\nNumero: FT 2026/999\n"), "tecnonorte-2.txt").field("company_id", "1"));
    expect(up2.status).toBe(201);
    const l2 = JSON.parse((db.prepare("SELECT lines_json FROM entries WHERE document_id = ?").get(up2.body.documentId) as any).lines_json);
    expect(l2.find((l: any) => l.debit > 0 && /^(3|6)/.test(l.account)).costCenter).toBe("LOJA");
  });
});
