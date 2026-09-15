import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import request from "supertest";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { articleKey, proposeFraming, queueFor, upsertArticlesFromDocument, listArticles, decideArticle, framingsFor, rebuildArticles } from "../src/domain/articles.js";
import { addParameterVersion } from "../src/domain/parameters.js";
import { auditDocument, buildAuditContext } from "../src/domain/vatAudit.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste";
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));
const doc = (items: any[], extra: Record<string, unknown> = {}) => ({ nifs: ["506284417", "501442600"], items, issuerNif: "501442600", docNumber: null, docDate: "2026-07-01", totalAmount: null, vatAmount: null, vatRate: null, netAmount: null, currency: "EUR", sources: [], ...extra } as any);

describe("A3: chave de artigo", () => {
  it("normaliza acentos, quantidades, unidades e referencias", () => {
    expect(articleKey("Farinha tipo 65 (saco 25kg)")).toBe("farinha tipo");
    expect(articleKey("FARINHA TIPO 65 saco 25 kg")).toBe(articleKey("farinha tipo 65 (saco 25kg)"));
    expect(articleKey("Manutenção forno industrial ref. AB-12")).toBe("manutencao forno industrial");
    expect(articleKey("Pão de centeio 500g x 10 un")).toBe("pao de centeio");
  });
});

describe("A3: proposta de enquadramento e filas", () => {
  it("regra conhecida com taxas observadas coerentes sobe o score; incoerentes descem e geram hipotese", () => {
    const coherent = proposeFraming("Farinha tipo 65", "continente", "2026-07-01", [6, 6, 6]);
    expect(coherent.band).toBe("reduzida"); expect(coherent.legalBasis).toMatch(/Lista I/); expect(coherent.score).toBeGreaterThanOrEqual(0.9);
    const divergent = proposeFraming("Farinha tipo 65", "continente", "2026-07-01", [23, 23, 23]);
    expect(divergent.band).toBe("reduzida"); expect(divergent.score).toBeLessThan(0.7);
    expect(divergent.hypotheses[0]!.band).toBe("normal");
    const plain = proposeFraming("Farinha tipo 65", "continente", "2026-07-01", []);
    expect(plain.score).toBe(0.75);
  });
  it("sem regra: so as taxas observadas com 3+ ocorrencias coerentes dao proposta; senao hipoteses", () => {
    const observed = proposeFraming("Widget XPTO", "continente", "2026-07-01", [23, 23, 23]);
    expect(observed.band).toBe("normal"); expect(observed.score).toBe(0.6); expect(observed.source).toBe("observado");
    const weak = proposeFraming("Widget XPTO", "continente", "2026-07-01", [23, 6]);
    expect(weak.score).toBe(0.4); expect(weak.hypotheses).toHaveLength(2);
    expect(proposeFraming("Widget XPTO", "continente", "2026-07-01", []).band).toBeNull();
  });
  it("as filas seguem os parametros versionados", () => {
    const db = openDb(":memory:");
    expect(queueFor(db, "proposto", 0.95, "2026-07-01")).toBe("aplicar");
    expect(queueFor(db, "proposto", 0.75, "2026-07-01")).toBe("validar");
    expect(queueFor(db, "proposto", 0.5, "2026-07-01")).toBe("hipoteses");
    expect(queueFor(db, "validado", 0.1, "2026-07-01")).toBe("validado");
    addParameterVersion(db, 1, "score_artigo_aplicar", 0.7, "2026-08-01", "piloto");
    expect(queueFor(db, "proposto", 0.75, "2026-07-31")).toBe("validar");
    expect(queueFor(db, "proposto", 0.75, "2026-08-01")).toBe("aplicar");
  });
});

describe("A3: fichas persistentes e conferencia por ficha", () => {
  it("regista artigos a partir de documentos, acumula ocorrencias e a ficha validada manda na conferencia", () => {
    const db = openDb(":memory:"); seedDemo(db);
    const x1 = doc([{ description: "Farinha tipo 65 (saco 25kg)", quantity: 10, unitPrice: 18.5, lineTotal: 185, vatRate: 6 }, { description: "Widget XPTO", quantity: 1, unitPrice: 100, lineTotal: 100, vatRate: 23 }]);
    expect(upsertArticlesFromDocument(db, 1, x1, "continente", "2026-07-01")).toBe(2);
    upsertArticlesFromDocument(db, 1, doc([{ description: "FARINHA TIPO 65 saco 25 kg", quantity: 5, unitPrice: 18.5, lineTotal: 92.5, vatRate: 6 }]), "continente", "2026-07-05");
    const list = listArticles(db, 1);
    expect(list.summary.total).toBe(2);
    const farinha = list.articles.find((a) => a.key === "farinha tipo")!;
    expect(farinha.occurrences).toBe(2); expect(farinha.observed_rates).toEqual([6, 6]); expect(farinha.queue).toBe("aplicar");
    const widget = list.articles.find((a) => a.key === "widget xpto")!;
    expect(widget.queue).toBe("hipoteses"); expect(widget.proposed_band).toBe("normal");
    expect(list.summary.coverage).toBe(0);

    // Sem ficha validada, "Widget XPTO" nao tem regra: a conferencia fica em silencio sobre ele.
    const invoice = doc([{ description: "Widget XPTO", quantity: 1, unitPrice: 100, lineTotal: 100 }], { vatRate: 23, netAmount: 100, vatAmount: 23, totalAmount: 123 });
    const ctxBefore = { ...buildAuditContext(db, 1, invoice), articleFramings: framingsFor(db, 1, "2026-07-01"), articleKey };
    expect(auditDocument("factura_compra", invoice, ctxBefore).some((f) => f.code === "TAXA_DESADEQUADA")).toBe(false);

    // O coordenador valida a ficha como taxa reduzida: a mesma factura a 23% passa a gerar alerta com "ficha validada".
    expect(() => decideArticle(db, widget.id, 1, { status: "validado", band: null })).not.toThrow(); // usa a proposta (normal)
    decideArticle(db, widget.id, 1, { status: "validado", band: "reduzida", legalBasis: "verba 2.x Lista I (teste)" });
    const framings = framingsFor(db, 1, "2026-07-01");
    expect(framings.get("widget xpto")).toMatchObject({ band: "reduzida", validated: true });
    expect(framings.has("farinha tipo")).toBe(true); // proposta acima do limiar tambem se aplica
    const ctxAfter = { ...buildAuditContext(db, 1, invoice), articleFramings: framings, articleKey };
    const f = auditDocument("factura_compra", invoice, ctxAfter).find((x) => x.code === "TAXA_DESADEQUADA");
    expect(f).toBeDefined(); expect(f!.message).toMatch(/ficha validada/);
    expect(listArticles(db, 1).summary.coverage).toBe(50);

    // Fichas validadas nao sao reescritas por novos documentos; rejeitadas saem da conferencia.
    upsertArticlesFromDocument(db, 1, doc([{ description: "Widget XPTO", quantity: 1, unitPrice: 100, lineTotal: 100, vatRate: 23 }]), "continente", "2026-07-09");
    const w2 = listArticles(db, 1).articles.find((a) => a.key === "widget xpto")!;
    expect(w2.status).toBe("validado"); expect(w2.validated_band).toBe("reduzida"); expect(w2.occurrences).toBe(2);
    decideArticle(db, farinha.id, 1, { status: "rejeitado" });
    expect(framingsFor(db, 1, "2026-07-01").has("farinha tipo")).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'article_%'").get() as any).n).toBe(3);
    expect(() => decideArticle(db, 9999, 1, { status: "validado", band: "normal" })).toThrow(/inexistente/);
  });

  it("a reconstrucao e idempotente e limpa fichas sem ocorrencias", () => {
    const db = openDb(":memory:"); seedDemo(db);
    db.prepare("INSERT INTO documents (company_id, uploader_id, original_name, stored_path, mime_type, size_bytes, sha256, status, doc_type, extracted_json, doc_date) VALUES (1, 1, 'a.txt', 'a.txt', 'text/plain', 1, 'sha-a', 'classificado', 'factura_compra', ?, '2026-07-01')")
      .run(JSON.stringify(doc([{ description: "Farinha tipo 65", quantity: 1, unitPrice: 1, lineTotal: 1, vatRate: 6 }])));
    upsertArticlesFromDocument(db, 1, doc([{ description: "Artigo fantasma", quantity: 1, unitPrice: 1, lineTotal: 1, vatRate: 23 }]), "continente", "2026-07-01");
    const r1 = rebuildArticles(db, 1); const r2 = rebuildArticles(db, 1);
    expect(r1).toEqual(r2);
    const keys = listArticles(db, 1).articles.map((a) => a.key);
    expect(keys).toContain("farinha tipo"); expect(keys).not.toContain("artigo fantasma");
    expect(listArticles(db, 1).articles[0]!.occurrences).toBe(1);
  });
});

describe("A3: API e permissoes", () => {
  it("processar um documento cria fichas; contabilista le mas nao decide; coordenador valida; cliente nao acede", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: fs.mkdtempSync(path.join(require("node:os").tmpdir(), "contai-art-")) });
    const login = async (email: string, password: string) => (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;
    const toc = await login("gabinete@demo.pt", "gabinete123");
    const client = await login("padaria@demo.pt", "cliente123");
    expect((await request(app).post("/api/users").set("Authorization", `Bearer ${toc}`).send({ name: "Contabilista Teste", email: "conta@demo.pt", password: "segredo123", profile: "contabilista", company_ids: [1] })).status).toBe(201);
    const conta = await login("conta@demo.pt", "segredo123");

    const up = await request(app).post("/api/documents").set("Authorization", `Bearer ${client}`).attach("file", fixture("factura-fornecedor.txt"), "factura-fornecedor.txt");
    expect(up.status).toBe(201);
    const list = await request(app).get("/api/companies/1/articles").set("Authorization", `Bearer ${conta}`);
    expect(list.status).toBe(200);
    expect(list.body.articles.map((a: any) => a.key)).toEqual(expect.arrayContaining(["farinha tipo", "manutencao forno industrial"]));
    const farinha = list.body.articles.find((a: any) => a.key === "farinha tipo");
    expect(farinha.proposed_band).toBe("reduzida");
    expect((await request(app).get("/api/companies/1/articles?queue=validado").set("Authorization", `Bearer ${conta}`)).body.articles).toHaveLength(0);
    expect((await request(app).get("/api/companies/2/articles").set("Authorization", `Bearer ${conta}`)).status).toBe(403); // fora da carteira
    expect((await request(app).get("/api/companies/1/articles").set("Authorization", `Bearer ${client}`)).status).toBe(403);
    expect((await request(app).patch(`/api/articles/${farinha.id}`).set("Authorization", `Bearer ${conta}`).send({ status: "validado", band: "reduzida" })).status).toBe(403);
    const ok = await request(app).patch(`/api/articles/${farinha.id}`).set("Authorization", `Bearer ${toc}`).send({ status: "validado", band: "reduzida", legal_basis: "Lista I, verba 1.1", effective_from: "2026-07-01" });
    expect(ok.status).toBe(200); expect(ok.body.article.status).toBe("validado");
    expect((await request(app).patch(`/api/articles/${farinha.id}`).set("Authorization", `Bearer ${toc}`).send({ status: "validado", band: "iva" })).status).toBe(400);
    expect((await request(app).patch(`/api/articles/99999`).set("Authorization", `Bearer ${toc}`).send({ status: "rejeitado" })).status).toBe(404);
    const rebuilt = await request(app).post("/api/companies/1/articles/rebuild").set("Authorization", `Bearer ${toc}`);
    expect(rebuilt.status).toBe(200); expect(rebuilt.body.validado).toBe(1); expect(rebuilt.body.documents).toBeGreaterThan(0);
    const after = await request(app).get("/api/companies/1/articles?queue=validado").set("Authorization", `Bearer ${toc}`);
    expect(after.body.articles).toHaveLength(1); expect(after.body.summary.coverage).toBe(50);
    // A conferencia da empresa usa a ficha validada sem erro.
    expect((await request(app).post("/api/audit/companies/1").set("Authorization", `Bearer ${toc}`)).status).toBe(200);
  });
});
