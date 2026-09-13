/**
 * Document classification for the digital archive (Decreto-Lei 28/2019).
 * A document is classified by type from its text content and filename;
 * direction (purchase vs. sale) is decided by comparing the issuer NIF
 * with the company's own NIF.
 */
import { ExtractedData } from "./extraction.js";

export type DocType =
  | "factura_compra"
  | "factura_venda"
  | "nota_credito"
  | "recibo"
  | "extracto_bancario"
  | "despesa"
  | "guia_transporte"
  | "outro";

export interface Classification {
  docType: DocType;
  confidence: number;
  source: "heuristica" | "ia" | "qr";
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

interface Rule {
  type: DocType;
  keywords: string[];
  weight: number;
}

const RULES: Rule[] = [
  { type: "nota_credito", keywords: ["nota de credito", "nc "], weight: 0.9 },
  { type: "extracto_bancario", keywords: ["extracto bancario", "extrato bancario", "extracto de conta", "saldo inicial", "saldo final"], weight: 0.9 },
  { type: "recibo", keywords: ["recibo", "recebemos de", "valor recebido"], weight: 0.85 },
  { type: "guia_transporte", keywords: ["guia de transporte", "guia de remessa"], weight: 0.9 },
  { type: "despesa", keywords: ["despesa", "portagem", "combustivel", "estacionamento", "refeicao", "talao"], weight: 0.7 },
  { type: "factura_compra", keywords: ["factura", "fatura", "factura-recibo", "fatura-recibo", "invoice"], weight: 0.6 },
];

export function classifyDocument(
  text: string,
  filename: string,
  companyNif: string,
  extracted: ExtractedData
): Classification {
  const haystack = norm(text) + " " + norm(filename);

  let best: { type: DocType; score: number } = { type: "outro", score: 0 };
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw)) {
        if (rule.weight > best.score) best = { type: rule.type, score: rule.weight };
        break;
      }
    }
  }

  if (best.score === 0) {
    return { docType: "outro", confidence: 0.3, source: "heuristica" };
  }

  let docType = best.type;
  let confidence = best.score;

  // An invoice issued by the company itself is a sale; issued by a third
  // party it is a purchase. Without a recognisable issuer NIF we keep the
  // purchase default with lower confidence.
  if (docType === "factura_compra") {
    if (extracted.issuerNif === companyNif) {
      docType = "factura_venda";
      confidence = Math.min(confidence + 0.3, 0.95);
    } else if (extracted.issuerNif !== null && extracted.nifs.includes(companyNif)) {
      confidence = Math.min(confidence + 0.3, 0.95);
    } else {
      confidence = Math.max(confidence - 0.15, 0.4);
    }
  }

  if (extracted.totalAmount !== null && extracted.docDate !== null) {
    confidence = Math.min(confidence + 0.05, 0.98);
  }

  return { docType, confidence: Math.round(confidence * 100) / 100, source: "heuristica" };
}

/** Archive folder per DL 28/2019: company / year / month / type. */
export function archivePath(companyId: number, docDate: string | null, docType: DocType): string {
  const d = docDate ? new Date(docDate + "T00:00:00Z") : new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `empresa-${companyId}/${year}/${month}/${docType}`;
}
