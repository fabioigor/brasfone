/**
 * Document analysis orchestrator: one entry point that turns bytes into
 * text, extracted fields, classification and provenance, combining
 *   - OCR / text layer (src/ocr)
 *   - the AT QR code, when printed on the document (authoritative)
 *   - Claude structured extraction, when an API key is configured
 *   - the heuristic regex extractor (always)
 * and reconciling them (src/extraction/structured.ts).
 */
import { OcrEngine, OcrResult, isPdf, isImage, rasterizePdf } from "../ocr/engine.js";
import { AiProvider } from "../ai/provider.js";
import { Classification } from "../domain/classification.js";
import { ExtractedData } from "../domain/extraction.js";
import { decodeImage } from "./preprocess.js";
import { AtQrData, decodeAtQrFromRgba, atDocTypeToDocType } from "./atQr.js";
import { ClaudeStructuredExtractor, mergeSources, StructuredInvoice } from "./structured.js";
import { ratesOn, Territory } from "../knowledge/index.js";

export interface AnalysisDeps {
  ocr: OcrEngine;
  provider: AiProvider;
  structured?: ClaudeStructuredExtractor | null;
}

export interface DocumentAnalysis {
  text: string;
  ocr: OcrResult;
  qr: AtQrData | null;
  qrCount: number;
  structured: StructuredInvoice | null;
  extracted: ExtractedData;
  classification: Classification;
  divergences: string[];
}

/** Finds AT QR codes in an image or in the first pages of a PDF. */
export async function findAtQr(buffer: Buffer, mimeType: string, filename: string, maxPages = 3): Promise<AtQrData[]> {
  try {
    if (isPdf(mimeType, filename, buffer)) {
      const pages = await rasterizePdf(buffer, maxPages, 2.5);
      const all: AtQrData[] = [];
      for (const png of pages) {
        const r = await decodeImage(png);
        for (const q of await decodeAtQrFromRgba(r.data, r.width, r.height)) {
          if (!all.some((x) => x.raw === q.raw)) all.push(q);
        }
      }
      return all;
    }
    if (isImage(mimeType, filename)) {
      const r = await decodeImage(buffer);
      return decodeAtQrFromRgba(r.data, r.width, r.height);
    }
  } catch {
    // QR decoding is best effort; the other sources still apply.
  }
  return [];
}

export function buildStructuredExtractor(): ClaudeStructuredExtractor | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || process.env.CONTAI_DISABLE_AI_EXTRACTION === "1") return null;
  return new ClaudeStructuredExtractor(key);
}

export async function analyseDocument(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  companyNif: string,
  territory: Territory,
  deps: AnalysisDeps
): Promise<DocumentAnalysis> {
  const ocr = await deps.ocr.extract(buffer, mimeType, filename);
  const text = ocr.text;

  // Heuristic extraction + classification over the text (always).
  const base = await deps.provider.analyseDocument(text, filename, companyNif);

  const qrs = await findAtQr(buffer, mimeType, filename);
  const qr = qrs[0] ?? null;

  let structured: StructuredInvoice | null = null;
  if (deps.structured && (ocr.method !== "indisponivel" || isImage(mimeType, filename) || isPdf(mimeType, filename, buffer))) {
    const binary = isImage(mimeType, filename) || isPdf(mimeType, filename, buffer);
    structured = await deps.structured.extract({
      buffer: binary ? buffer : undefined,
      mimeType: binary ? mimeType : undefined,
      isPdf: binary ? isPdf(mimeType, filename, buffer) : undefined,
      text: text || undefined,
    });
  }

  const dateForRates = qr?.date ?? structured?.data ?? base.extracted.docDate ?? new Date().toISOString().slice(0, 10);
  const { data: extracted, divergences } = mergeSources({
    heuristic: base.extracted,
    qr,
    structured,
    territoryRates: ratesOn(territory, dateForRates),
  });

  // Classification: QR beats everything; the AI extractor beats the heuristic
  // when confident; otherwise the heuristic (or AI-refined) result stands.
  let classification: Classification = base.classification;
  if (qr) {
    classification = {
      docType: atDocTypeToDocType(qr.docType, qr.issuerNif === companyNif) as Classification["docType"],
      confidence: 0.99,
      source: "qr",
    };
  } else if (structured && structured.confianca >= 0.8 && structured.tipo_documento !== "outro") {
    const map: Record<string, Classification["docType"]> = {
      factura: extracted.issuerNif === companyNif ? "factura_venda" : "factura_compra",
      factura_recibo: extracted.issuerNif === companyNif ? "factura_venda" : "factura_compra",
      factura_simplificada: extracted.issuerNif === companyNif ? "factura_venda" : "factura_compra",
      nota_debito: extracted.issuerNif === companyNif ? "factura_venda" : "factura_compra",
      nota_credito: "nota_credito",
      recibo: "recibo",
      extracto_bancario: "extracto_bancario",
      guia_transporte: "guia_transporte",
      despesa: "despesa",
    };
    const mapped = map[structured.tipo_documento];
    if (mapped) classification = { docType: mapped, confidence: Math.max(base.classification.confidence, structured.confianca), source: "ia" };
  }

  return { text, ocr, qr, qrCount: qrs.length, structured, extracted, classification, divergences };
}
