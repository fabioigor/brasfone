import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "..", "fixtures", name));

let db: Db;
let app: ReturnType<typeof createServer>;
let tmpDir: string;
let staffToken: string;
let clientToken: string;
let otherClientToken: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contadesk-test-"));
  db = openDb(":memory:");
  seedDemo(db);
  app = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmpDir });

  const login = async (email: string, password: string) => {
    const res = await request(app).post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    return res.body.token as string;
  };
  staffToken = await login("gabinete@demo.pt", "gabinete123");
  clientToken = await login("padaria@demo.pt", "cliente123");
  otherClientToken = await login("tecnonorte@demo.pt", "cliente123");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const asStaff = (r: request.Test) => r.set("Authorization", `Bearer ${staffToken}`);
const asClient = (r: request.Test) => r.set("Authorization", `Bearer ${clientToken}`);

describe("autenticacao e acesso", () => {
  it("rejeita credenciais erradas", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "errada" });
    expect(res.status).toBe(401);
  });

  it("rejeita pedidos sem sessao", async () => {
    const res = await request(app).get("/api/documents");
    expect(res.status).toBe(401);
  });

  it("cliente nao acede a fila de validacao", async () => {
    const res = await asClient(request(app).get("/api/entries"));
    expect(res.status).toBe(403);
  });
});

describe("fluxo documento -> lancamento -> validacao -> exportacao", () => {
  let entryId: number;
  let documentId: number;

  it("cliente carrega factura de fornecedor e nasce proposta", async () => {
    const res = await asClient(
      request(app)
        .post("/api/documents")
        .attach("file", fixture("factura-fornecedor.txt"), "factura-fornecedor.txt")
    );
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.docType).toBe("factura_compra");
    expect(res.body.status).toBe("proposto");
    expect(res.body.entryId).toBeGreaterThan(0);
    entryId = res.body.entryId;
    documentId = res.body.documentId;
  });

  it("re-upload do mesmo ficheiro nao duplica (dedupe por sha256)", async () => {
    const res = await asClient(
      request(app)
        .post("/api/documents")
        .attach("file", fixture("factura-fornecedor.txt"), "outra-copia.txt")
    );
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.documentId).toBe(documentId);
  });

  it("gabinete ve o lancamento pendente com linhas balanceadas", async () => {
    const res = await asStaff(request(app).get("/api/entries?status=pendente"));
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry).toBeDefined();
    const debit = entry.lines.reduce((s: number, l: any) => s + l.debit, 0);
    const credit = entry.lines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
  });

  it("rejeicao sem motivo e recusada", async () => {
    const res = await asStaff(
      request(app).post(`/api/entries/${entryId}/decision`).send({ action: "rejeitar" })
    );
    expect(res.status).toBe(400);
  });

  it("edicao desbalanceada e recusada", async () => {
    const res = await asStaff(
      request(app)
        .post(`/api/entries/${entryId}/decision`)
        .send({
          action: "aprovar",
          lines: [
            { account: "62", description: "FSE", debit: 100, credit: 0 },
            { account: "221", description: "Fornecedor", debit: 0, credit: 90 },
          ],
        })
    );
    expect(res.status).toBe(400);
  });

  it("aprovacao valida o documento", async () => {
    const res = await asStaff(
      request(app).post(`/api/entries/${entryId}/decision`).send({ action: "aprovar" })
    );
    expect(res.status).toBe(200);
    const doc = db.prepare("SELECT status FROM documents WHERE id = ?").get(documentId) as any;
    expect(doc.status).toBe("validado");
  });

  it("segunda decisao sobre o mesmo lancamento e recusada", async () => {
    const res = await asStaff(
      request(app).post(`/api/entries/${entryId}/decision`).send({ action: "aprovar" })
    );
    expect(res.status).toBe(409);
  });

  it("exportacao gera CSV Primavera e e idempotente", async () => {
    const first = await asStaff(request(app).post("/api/export/1"));
    expect(first.status).toBe(200);
    expect(first.body.entryCount).toBe(1);
    expect(first.body.csv).toContain("Diario;Data;Documento;Conta");
    expect(first.body.csv).toContain("2432");
    expect(first.body.csv).toContain("123,05");

    const second = await asStaff(request(app).post("/api/export/1"));
    expect(second.status).toBe(200);
    expect(second.body.entryCount).toBe(0);
    expect(second.body.batchId).toBeNull();
  });
});

describe("isolamento entre empresas", () => {
  it("cliente so ve documentos da sua empresa", async () => {
    const res = await request(app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${otherClientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(0);
  });

  it("cliente nao descarrega ficheiro de outra empresa", async () => {
    const doc = db.prepare("SELECT id FROM documents WHERE company_id = 1 LIMIT 1").get() as any;
    const res = await request(app)
      .get(`/api/documents/${doc.id}/file`)
      .set("Authorization", `Bearer ${otherClientToken}`);
    expect(res.status).toBe(403);
  });

  it("cliente nao carrega documentos para outra empresa", async () => {
    const res = await asClient(
      request(app)
        .post("/api/documents")
        .field("company_id", "2")
        .attach("file", Buffer.from("Factura Total: 10,00"), "doc.txt")
    );
    // company_id do corpo e ignorado para clientes: fica sempre na sua empresa
    expect(res.status).toBe(201);
    const doc = db.prepare("SELECT company_id FROM documents WHERE id = ?").get(res.body.documentId) as any;
    expect(doc.company_id).toBe(1);
  });
});

describe("pedidos de documentos", () => {
  let requestId: number;

  it("gabinete cria pedido com prazo", async () => {
    const res = await asStaff(
      request(app).post("/api/requests").send({
        company_id: 1,
        title: "Extracto bancario de Julho",
        due_date: "2026-09-10",
      })
    );
    expect(res.status).toBe(201);
    requestId = res.body.id;
  });

  it("cliente ve o pedido pendente", async () => {
    const res = await asClient(request(app).get("/api/requests"));
    expect(res.status).toBe(200);
    expect(res.body.requests.some((r: any) => r.id === requestId && r.status === "pendente")).toBe(true);
  });

  it("upload dirigido ao pedido marca-o como cumprido", async () => {
    const res = await asClient(
      request(app)
        .post("/api/documents")
        .field("request_id", String(requestId))
        .attach("file", fixture("recibo.txt"), "recibo.txt")
    );
    expect(res.status).toBe(201);
    const r = db.prepare("SELECT status, fulfilled_document_id FROM doc_requests WHERE id = ?").get(requestId) as any;
    expect(r.status).toBe("cumprido");
    expect(r.fulfilled_document_id).toBe(res.body.documentId);
  });
});

describe("dashboard", () => {
  it("devolve contagens e obrigacoes fiscais", async () => {
    const res = await asStaff(request(app).get("/api/dashboard?company_id=1"));
    expect(res.status).toBe(200);
    expect(res.body.obligations.length).toBeGreaterThan(0);
    expect(res.body.documents.length).toBeGreaterThan(0);
  });
});
