import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { pdfTextLayer, DocumentOcr, isPdf, isImage } from "../src/ocr/engine.js";
import { extractFromText } from "../src/domain/extraction.js";
import { classifyDocument } from "../src/domain/classification.js";
import { ocrFindings } from "../src/pipeline.js";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));
const PADARIA = "506284417";

describe("deteccao de formato", () => {
  it("reconhece PDF por mime, extensao e assinatura", () => {
    expect(isPdf("application/pdf", "x.bin")).toBe(true);
    expect(isPdf("application/octet-stream", "factura.PDF")).toBe(true);
    expect(isPdf("application/octet-stream", "x.bin", Buffer.from("%PDF-1.4"))).toBe(true);
    expect(isPdf("image/png", "x.png", Buffer.from("PNG"))).toBe(false);
    expect(isImage("image/jpeg", "a")).toBe(true);
    expect(isImage("application/pdf", "a.pdf")).toBe(false);
  });
});

describe("PDF com camada de texto", () => {
  it("extrai o texto com o layout preservado e alimenta a extraccao", async () => {
    const { text, pages } = await pdfTextLayer(fixture("factura-texto.pdf"));
    expect(pages).toBe(1);
    expect(text).toContain("Total a pagar: 658,05");
    const x = extractFromText(text);
    expect(x.totalAmount).toBe(658.05);
    expect(x.vatAmount).toBe(123.05);
    expect(x.issuerNif).toBe("501442600");
    expect(x.items.map((i) => i.description)).toContain("Farinha tipo 65 (saco 25kg)");
    const c = classifyDocument(text, "factura-texto.pdf", PADARIA, x);
    expect(c.docType).toBe("factura_compra");
  });

  it("DocumentOcr usa a camada de texto sem OCR", async () => {
    const ocr = new DocumentOcr({ disableTesseract: true });
    const r = await ocr.extract(fixture("factura-texto.pdf"), "application/pdf", "factura-texto.pdf");
    expect(r.method).toBe("pdf_texto");
    expect(r.confidence).toBe(1);
  });

  it("sem motor de OCR, uma digitalizacao fica 'indisponivel' com aviso", async () => {
    const ocr = new DocumentOcr({ disableTesseract: true });
    const r = await ocr.extract(fixture("factura-scan.pdf"), "application/pdf", "factura-scan.pdf");
    expect(r.method).toBe("indisponivel");
    const f = ocrFindings(r);
    expect(f[0]!.code).toBe("TEXTO_NAO_EXTRAIDO");
  });

  it("formato nao suportado e sinalizado", async () => {
    const ocr = new DocumentOcr({ disableTesseract: true });
    const r = await ocr.extract(Buffer.from("PKzip"), "application/zip", "coisa.zip");
    expect(r.method).toBe("indisponivel");
  });
});

describe("OCR local (tesseract.js)", () => {
  const ocr = new DocumentOcr({});

  it("le uma imagem digitalizada e os valores batem certo", async () => {
    const r = await ocr.extract(fixture("factura-scan.png"), "image/png", "factura-scan.png");
    expect(r.method).toBe("tesseract");
    expect(r.confidence).toBeGreaterThan(0.7);
    const x = extractFromText(r.text);
    expect(x.totalAmount).toBe(658.05);
    expect(x.vatAmount).toBe(123.05);
    expect(x.nifs).toContain(PADARIA);
    expect(x.items.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("rasteriza e le um PDF digitalizado (sem camada de texto)", async () => {
    const r = await ocr.extract(fixture("factura-scan.pdf"), "application/pdf", "factura-scan.pdf");
    expect(r.method).toBe("tesseract");
    expect(extractFromText(r.text).totalAmount).toBe(658.05);
  }, 120_000);

  it("confianca baixa gera alerta para o revisor", () => {
    const f = ocrFindings({ text: "x", method: "tesseract", confidence: 0.6, pages: 1, warnings: [] });
    expect(f[0]!.code).toBe("OCR_CONFIANCA_BAIXA");
    expect(ocrFindings({ text: "x", method: "tesseract", confidence: 0.95, pages: 1, warnings: [] })).toEqual([]);
  });
});

describe("OCR via API", () => {
  let db: Db;
  let app: ReturnType<typeof createServer>;
  let tmpDir: string;
  let staff: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contai-ocr-"));
    db = openDb(":memory:");
    seedDemo(db);
    app = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmpDir, ocr: new DocumentOcr({}) });
    staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const S = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);

  it("upload de PDF com texto classifica e propoe lancamento", async () => {
    const res = await S(
      request(app)
        .post("/api/documents")
        .field("company_id", "1")
        .attach("file", fixture("factura-texto.pdf"), { filename: "factura-texto.pdf", contentType: "application/pdf" })
    );
    expect(res.status).toBe(201);
    expect(res.body.ocr.method).toBe("pdf_texto");
    expect(res.body.docType).toBe("factura_compra");
    expect(res.body.entryId).toBeGreaterThan(0);
    const text = await S(request(app).get(`/api/documents/${res.body.documentId}/text`));
    expect(text.body.method).toBe("pdf_texto");
    expect(text.body.extracted.totalAmount).toBe(658.05);
  });

  it("upload de imagem digitalizada passa por OCR e e conferido", async () => {
    const res = await S(
      request(app)
        .post("/api/documents")
        .field("company_id", "1")
        .attach("file", fixture("factura-scan.png"), { filename: "factura-scan.png", contentType: "image/png" })
    );
    expect(res.status).toBe(201);
    expect(res.body.ocr.method).toBe("tesseract");
    expect(res.body.docType).toBe("factura_compra");
    // Mesmo documento que o PDF (mesmo numero e emissor): a conferencia detecta o duplicado.
    expect(res.body.findings.some((f: any) => f.code === "DUPLICADO")).toBe(true);
    const text = await S(request(app).get(`/api/documents/${res.body.documentId}/text`));
    expect(text.body.text).toContain("658,05");
  }, 120_000);

  it("reprocessar documento volta a extrair e mantem o estado coerente", async () => {
    const doc = db.prepare("SELECT id FROM documents WHERE ocr_method = 'pdf_texto' LIMIT 1").get() as any;
    const res = await S(request(app).post(`/api/documents/${doc.id}/reprocess`));
    expect(res.status).toBe(200);
    expect(res.body.ocr.method).toBe("pdf_texto");
    expect(res.body.entryId).toBeGreaterThan(0);
    const pend = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE document_id = ? AND status = 'pendente'").get(doc.id) as any;
    expect(pend.n).toBe(1);
  });
});
