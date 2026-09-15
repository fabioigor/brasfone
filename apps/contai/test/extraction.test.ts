import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseAtQr, atQrConsistency, atDocTypeToDocType } from "../src/extraction/atQr.js";
import { findAtQr, analyseDocument } from "../src/extraction/analyse.js";
import { mergeSources } from "../src/extraction/structured.js";
import { extractFromText } from "../src/domain/extraction.js";
import { proposeEntry, isBalanced } from "../src/domain/entries.js";
import { auditDocument } from "../src/domain/vatAudit.js";
import { DocumentOcr } from "../src/ocr/engine.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { learnFromApproval, getProfile, touchProfile } from "../src/domain/supplierMemory.js";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));
const payload = fs.readFileSync(path.join(__dirname, "..", "fixtures", "factura-qr.payload.txt"), "utf8").trim();
const PADARIA = "506284417";
const rates = { normal: 23, intermedia: 13, reduzida: 6 };

describe("QR code da AT", () => {
  it("parse do payload oficial", () => {
    const q = parseAtQr(payload)!;
    expect(q).not.toBeNull();
    expect(q.issuerNif).toBe("501442600");
    expect(q.acquirerNif).toBe(PADARIA);
    expect(q.docType).toBe("FT");
    expect(q.date).toBe("2026-07-15");
    expect(q.docNumber).toBe("FT A/2026-0147");
    expect(q.atcud).toBe("AAJFJ5F7-147");
    expect(q.reducedBase).toBe(185);
    expect(q.reducedVat).toBe(11.1);
    expect(q.normalBase).toBe(350);
    expect(q.normalVat).toBe(80.5);
    expect(q.total).toBe(626.6);
    expect(atQrConsistency(q).ok).toBe(true);
  });

  it("rejeita texto que nao e um QR da AT e detecta incoerencias", () => {
    expect(parseAtQr("https://exemplo.pt")).toBeNull();
    const bad = parseAtQr(payload.replace("O:626.60", "O:700.00"))!;
    expect(atQrConsistency(bad).ok).toBe(false);
  });

  it("consumidor final nao tem NIF de adquirente", () => {
    const q = parseAtQr(payload.replace("B:506284417", "B:999999990"))!;
    expect(q.acquirerNif).toBeNull();
  });

  it("mapeia tipos de documento", () => {
    expect(atDocTypeToDocType("FT", false)).toBe("factura_compra");
    expect(atDocTypeToDocType("FT", true)).toBe("factura_venda");
    expect(atDocTypeToDocType("NC", false)).toBe("nota_credito");
    expect(atDocTypeToDocType("RC", false)).toBe("recibo");
  });

  it("le o QR impresso numa imagem e num PDF", async () => {
    const png = await findAtQr(fixture("factura-qr.png"), "image/png", "factura-qr.png");
    expect(png).toHaveLength(1);
    expect(png[0]!.atcud).toBe("AAJFJ5F7-147");
    const pdf = await findAtQr(fixture("factura-qr.pdf"), "application/pdf", "factura-qr.pdf");
    expect(pdf).toHaveLength(1);
    expect(pdf[0]!.total).toBe(626.6);
  }, 60_000);
});

describe("fusao de fontes", () => {
  it("o QR prevalece sobre o texto e regista a proveniencia", () => {
    const heuristic = extractFromText(fixture("factura-fornecedor.txt").toString());
    const { data, divergences } = mergeSources({ heuristic, qr: parseAtQr(payload), territoryRates: rates });
    expect(data.sources).toContain("qr");
    expect(data.totalAmount).toBe(626.6);
    expect(data.fieldSources!["totalAmount"]).toBe("qr");
    expect(data.vatBreakdown).toEqual([
      { rate: 6, base: 185, vat: 11.1 },
      { rate: 23, base: 350, vat: 80.5 },
    ]);
    expect(data.vatRate).toBeNull();
    expect(data.atcud).toBe("AAJFJ5F7-147");
    // o texto dizia 658,05: divergencia assinalada
    expect(divergences.some((d) => d.includes("658.05") && d.includes("626.60"))).toBe(true);
  });

  it("a extraccao estruturada da IA completa o texto sem inventar", () => {
    const heuristic = extractFromText("Factura FT 9/1\nTotal: 100,00");
    const { data } = mergeSources({
      heuristic,
      structured: {
        tipo_documento: "factura", emitente: { nome: "Fornecedor X", nif: "501442600" }, adquirente: { nome: null, nif: PADARIA },
        numero: "FT 9/1", data: "2026-08-01", atcud: null, moeda: "EUR",
        linhas: [{ descricao: "Servico", quantidade: 1, preco_unitario: 81.3, total_linha: 81.3, taxa_iva: 23 }],
        iva: [{ taxa: 23, base: 81.3, valor: 18.7 }], base_total: 81.3, iva_total: 18.7, total: 100, meio_pagamento: null, confianca: 0.9,
      },
      territoryRates: rates,
    });
    expect(data.sources).toContain("ia");
    expect(data.issuerNif).toBe("501442600");
    expect(data.issuerName).toBe("Fornecedor X");
    expect(data.docDate).toBe("2026-08-01");
    expect(data.vatRate).toBe(23);
    expect(data.items[0]!.vatRate).toBe(23);
  });
});

describe("lancamento com IVA multi-taxa", () => {
  it("uma linha de IVA por taxa e conta aprendida", () => {
    const heuristic = extractFromText(fixture("factura-fornecedor.txt").toString());
    const { data } = mergeSources({ heuristic, qr: parseAtQr(payload), territoryRates: rates });
    const p = proposeEntry("factura_compra", data, 0.9, "Electro Fornecedora", { preferredExpenseAccount: "6221" })!;
    expect(isBalanced(p.lines)).toBe(true);
    const vat = p.lines.filter((l) => l.account === "2432");
    expect(vat).toHaveLength(2);
    expect(vat.map((l) => l.debit).sort()).toEqual([11.1, 80.5]);
    expect(p.lines[0]!.account).toBe("6221");
    expect(p.lines.find((l) => l.account === "221")!.credit).toBe(626.6);
    expect(p.confidence).toBeGreaterThanOrEqual(0.95);
  });
});

describe("conferencia com QR", () => {
  const ctx = { territory: "continente" as const, companyNif: PADARIA };

  it("desagregacao coerente nao gera erros; anulado e duplicado por ATCUD sao erros", () => {
    const heuristic = extractFromText(fixture("factura-fornecedor.txt").toString());
    const { data, divergences } = mergeSources({ heuristic, qr: parseAtQr(payload), territoryRates: rates });
    const f = auditDocument("factura_compra", data, { ...ctx, divergences });
    expect(f.filter((a) => a.severity === "erro")).toEqual([]);
    expect(f.some((a) => a.code === "FONTES_DIVERGENTES")).toBe(true);

    const cancelled = mergeSources({ heuristic, qr: parseAtQr(payload.replace("E:N", "E:A")), territoryRates: rates }).data;
    expect(auditDocument("factura_compra", cancelled, ctx).some((a) => a.code === "DOCUMENTO_ANULADO")).toBe(true);

    const dup = auditDocument("factura_compra", data, { ...ctx, existingAtcuds: new Set(["AAJFJ5F7-147"]) });
    expect(dup.some((a) => a.code === "DUPLICADO" && a.message.includes("ATCUD"))).toBe(true);
  });

  it("IVA errado numa das taxas e detectado", () => {
    const heuristic = extractFromText("Factura\nTotal: 626,60");
    const { data } = mergeSources({ heuristic, qr: parseAtQr(payload.replace("I8:80.50", "I8:70.50").replace("N:91.60", "N:81.60").replace("O:626.60", "O:616.60")), territoryRates: rates });
    const f = auditDocument("factura_compra", data, ctx);
    const calc = f.find((a) => a.code === "IVA_CALCULO");
    expect(calc).toBeDefined();
    expect(calc!.message).toContain("23%");
  });

  it("varios QR num ficheiro e assinalado", () => {
    const heuristic = extractFromText("Factura\nTotal: 10,00");
    const f = auditDocument("factura_compra", heuristic, { ...ctx, qrCount: 3 });
    expect(f.some((a) => a.code === "VARIOS_DOCUMENTOS_NO_FICHEIRO")).toBe(true);
  });
});

describe("analise completa de um documento com QR (sem IA)", () => {
  it("classifica pelo QR, extrai por taxa e ignora o OCR nos valores", async () => {
    const a = await analyseDocument(fixture("factura-qr.png"), "image/png", "factura-qr.png", PADARIA, "continente", {
      ocr: new DocumentOcr({}),
      provider: new HeuristicProvider(),
      structured: null,
    });
    expect(a.qr).not.toBeNull();
    expect(a.classification.source).toBe("qr");
    expect(a.classification.docType).toBe("factura_compra");
    expect(a.extracted.totalAmount).toBe(626.6);
    expect(a.extracted.vatBreakdown).toHaveLength(2);
    expect(a.ocr.method).toBe("tesseract");
  }, 120_000);
});

describe("memoria de fornecedores", () => {
  it("aprende a conta de gasto na aprovacao e reutiliza-a", () => {
    const db = openDb(":memory:");
    seedDemo(db);
    const x = extractFromText(fixture("factura-fornecedor.txt").toString());
    expect(getProfile(db, 1, "501442600")).toBeNull();
    touchProfile(db, 1, "501442600", "Electro Fornecedora");
    learnFromApproval(db, 1, "factura_compra", x, PADARIA, [
      { account: "6226", description: "Manutencao", debit: 535, credit: 0 },
      { account: "2432", description: "IVA", debit: 123.05, credit: 0 },
      { account: "221", description: "Fornecedor", debit: 0, credit: 658.05 },
    ]);
    const p = getProfile(db, 1, "501442600")!;
    expect(p.expenseAccount).toBe("6226");
    expect(p.name).toBe("Electro Fornecedora");
    const proposal = proposeEntry("factura_compra", x, 0.9, "Electro", { preferredExpenseAccount: p.expenseAccount })!;
    expect(proposal.lines[0]!.account).toBe("6226");
  });
});
