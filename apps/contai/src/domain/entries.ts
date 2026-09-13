/**
 * Generation of accounting entry proposals (SNC chart of accounts).
 * Proposals are ALWAYS subject to human validation before export; the
 * engine never writes to the accounting system directly.
 */
import { DocType } from "./classification.js";
import { ExtractedData } from "./extraction.js";

export interface EntryLine {
  account: string;
  description: string;
  debit: number;
  credit: number;
}

export interface EntryProposal {
  journal: string;
  entryDate: string;
  description: string;
  lines: EntryLine[];
  confidence: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** SNC accounts used by the proposal engine (configurable per firm later). */
export const SNC = {
  clientes: "211",
  fornecedores: "221",
  bancos: "12",
  ivaDedutivel: "2432",
  ivaLiquidado: "2433",
  compras: "312",
  fse: "62",
  vendas: "711",
  servicos: "721",
} as const;

export function isBalanced(lines: EntryLine[]): boolean {
  const d = round2(lines.reduce((s, l) => s + l.debit, 0));
  const c = round2(lines.reduce((s, l) => s + l.credit, 0));
  return Math.abs(d - c) < 0.005;
}

/**
 * Builds an entry proposal from a classified document. Returns null when
 * the document type does not originate entries (bank statements, transport
 * guides, unknown) or when the required amounts are missing.
 */
export function proposeEntry(
  docType: DocType,
  extracted: ExtractedData,
  classificationConfidence: number,
  counterpartyLabel: string
): EntryProposal | null {
  const total = extracted.totalAmount;
  if (total === null || total <= 0) return null;

  const entryDate = extracted.docDate ?? new Date().toISOString().slice(0, 10);
  const vat = extracted.vatAmount ?? 0;
  const net = extracted.netAmount ?? round2(total - vat);
  const ref = extracted.docNumber ? ` ${extracted.docNumber}` : "";
  let lines: EntryLine[] = [];
  let journal = "";
  let description = "";
  let confidence = classificationConfidence;

  switch (docType) {
    case "factura_compra":
    case "despesa": {
      journal = "Compras";
      description = `${docType === "despesa" ? "Despesa" : "Factura de compra"}${ref} - ${counterpartyLabel}`;
      lines = [
        { account: SNC.fse, description: "Fornecimentos e servicos externos", debit: net, credit: 0 },
      ];
      if (vat > 0) {
        lines.push({ account: SNC.ivaDedutivel, description: "IVA dedutivel", debit: vat, credit: 0 });
      }
      lines.push({ account: SNC.fornecedores, description: counterpartyLabel, debit: 0, credit: total });
      break;
    }
    case "factura_venda": {
      journal = "Vendas";
      description = `Factura de venda${ref} - ${counterpartyLabel}`;
      lines = [{ account: SNC.clientes, description: counterpartyLabel, debit: total, credit: 0 }];
      lines.push({ account: SNC.servicos, description: "Prestacao de servicos", debit: 0, credit: net });
      if (vat > 0) {
        lines.push({ account: SNC.ivaLiquidado, description: "IVA liquidado", debit: 0, credit: vat });
      }
      break;
    }
    case "nota_credito": {
      journal = "Compras";
      description = `Nota de credito${ref} - ${counterpartyLabel}`;
      lines = [
        { account: SNC.fornecedores, description: counterpartyLabel, debit: total, credit: 0 },
        { account: SNC.fse, description: "Regularizacao FSE", debit: 0, credit: net },
      ];
      if (vat > 0) {
        lines.push({ account: SNC.ivaDedutivel, description: "Regularizacao IVA", debit: 0, credit: vat });
      }
      break;
    }
    case "recibo": {
      journal = "Caixa/Bancos";
      description = `Recibo${ref} - ${counterpartyLabel}`;
      lines = [
        { account: SNC.bancos, description: "Deposito bancario", debit: total, credit: 0 },
        { account: SNC.clientes, description: counterpartyLabel, debit: 0, credit: total },
      ];
      break;
    }
    default:
      return null;
  }

  // Rounding guard: absorb cent differences into the counterparty line.
  const dSum = round2(lines.reduce((s, l) => s + l.debit, 0));
  const cSum = round2(lines.reduce((s, l) => s + l.credit, 0));
  const diff = round2(dSum - cSum);
  if (diff !== 0 && Math.abs(diff) <= 0.05) {
    const last = lines[lines.length - 1]!;
    if (last.credit > 0) last.credit = round2(last.credit + diff);
    else last.debit = round2(last.debit - diff);
  }

  if (!isBalanced(lines)) return null;

  // Missing pieces reduce confidence: the reviewer must look harder.
  if (extracted.docDate === null) confidence -= 0.15;
  if (extracted.vatAmount === null && docType !== "recibo") confidence -= 0.1;
  if (extracted.docNumber === null) confidence -= 0.05;
  confidence = round2(Math.max(0.1, Math.min(confidence, 0.98)));

  return { journal, entryDate, description, lines, confidence };
}
