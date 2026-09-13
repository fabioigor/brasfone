/**
 * Supplier/customer memory: learns from each human approval which SNC
 * account the accountant uses for a given counterparty (NIF) and reuses it
 * in the next proposal. This is the "the system learns from corrections"
 * capability: after the first invoice of a supplier is corrected once, the
 * following ones arrive pre-filled the same way.
 */
import { Db } from "../db.js";
import { EntryLine } from "./entries.js";
import { ExtractedData } from "./extraction.js";
import { DocType } from "./classification.js";

export interface SupplierProfile {
  nif: string;
  name: string | null;
  expenseAccount: string | null;
  revenueAccount: string | null;
  docCount: number;
}

export function counterpartyNif(extracted: ExtractedData, companyNif: string): string | null {
  return extracted.nifs.find((n) => n !== companyNif) ?? null;
}

export function getProfile(db: Db, companyId: number, nif: string | null): SupplierProfile | null {
  if (!nif) return null;
  const r = db.prepare("SELECT nif, name, expense_account, revenue_account, doc_count FROM supplier_profiles WHERE company_id = ? AND nif = ?").get(companyId, nif) as any;
  return r ? { nif: r.nif, name: r.name, expenseAccount: r.expense_account, revenueAccount: r.revenue_account, docCount: r.doc_count } : null;
}

/** Registers a sighting (name, count) without learning accounts. */
export function touchProfile(db: Db, companyId: number, nif: string | null, name: string | null | undefined): void {
  if (!nif) return;
  db.prepare(
    `INSERT INTO supplier_profiles (company_id, nif, name, doc_count, last_seen)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT (company_id, nif) DO UPDATE SET
       doc_count = doc_count + 1, last_seen = datetime('now'),
       name = COALESCE(excluded.name, supplier_profiles.name), updated_at = datetime('now')`
  ).run(companyId, nif, name ?? null);
}

/**
 * Learns the expense (class 3/6) or revenue (class 7) account from approved
 * lines. Called after a human approves an entry.
 */
export function learnFromApproval(db: Db, companyId: number, docType: DocType, extracted: ExtractedData, companyNif: string, lines: EntryLine[]): void {
  const nif = counterpartyNif(extracted, companyNif);
  if (!nif) return;
  let expense: string | null = null;
  let revenue: string | null = null;
  for (const l of lines) {
    if (l.debit > 0 && /^(3|6)/.test(l.account) && ["factura_compra", "despesa", "nota_credito"].includes(docType)) expense = l.account;
    if (l.credit > 0 && /^7/.test(l.account) && docType === "factura_venda") revenue = l.account;
  }
  if (!expense && !revenue) return;
  db.prepare(
    `INSERT INTO supplier_profiles (company_id, nif, name, expense_account, revenue_account, doc_count, last_seen)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT (company_id, nif) DO UPDATE SET
       expense_account = COALESCE(excluded.expense_account, supplier_profiles.expense_account),
       revenue_account = COALESCE(excluded.revenue_account, supplier_profiles.revenue_account),
       name = COALESCE(excluded.name, supplier_profiles.name),
       last_seen = datetime('now'), updated_at = datetime('now')`
  ).run(companyId, nif, extracted.issuerName ?? null, expense, revenue);
}
