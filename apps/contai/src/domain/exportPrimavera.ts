/**
 * Export of approved entries as a Cegid Primavera-compatible movements CSV.
 * Idempotent: every exported entry is registered in export_batch_entries
 * (entry_id UNIQUE), so re-running an export never duplicates movements.
 */
import { Db, audit } from "../db.js";
import { EntryLine } from "./entries.js";

export interface ExportResult {
  batchId: number | null;
  entryCount: number;
  csv: string;
}

const HEADER = "Diario;Data;Documento;Conta;Descricao;Debito;Credito;CentroCusto";

const money = (n: number) => n.toFixed(2).replace(".", ",");

function csvField(s: string): string {
  const clean = s.replace(/[\r\n;]+/g, " ").trim();
  return clean;
}

export function exportApprovedEntries(db: Db, companyId: number, userId: number): ExportResult {
  const rows = db
    .prepare(
      `SELECT e.* FROM entries e
       WHERE e.company_id = ? AND e.status = 'aprovado'
         AND e.id NOT IN (SELECT entry_id FROM export_batch_entries)
         AND e.id NOT IN (SELECT entry_id FROM dispatches WHERE status != 'erro')
       ORDER BY e.entry_date, e.id`
    )
    .all(companyId) as any[];

  if (rows.length === 0) {
    return { batchId: null, entryCount: 0, csv: HEADER + "\n" };
  }

  const lines: string[] = [HEADER];
  for (const row of rows) {
    const entryLines = JSON.parse(row.lines_json) as EntryLine[];
    for (const l of entryLines) {
      lines.push(
        [
          csvField(row.journal),
          row.entry_date,
          `CD-${row.id}`,
          l.account,
          csvField(l.description || row.description),
          money(l.debit),
          money(l.credit),
          csvField(l.costCenter || ""),
        ].join(";")
      );
    }
  }
  const csv = lines.join("\n") + "\n";

  const tx = db.transaction(() => {
    const batch = db
      .prepare(
        "INSERT INTO export_batches (company_id, created_by, format, entry_count, content) VALUES (?, ?, 'primavera_csv', ?, ?)"
      )
      .run(companyId, userId, rows.length, csv);
    const batchId = Number(batch.lastInsertRowid);
    const link = db.prepare("INSERT INTO export_batch_entries (batch_id, entry_id) VALUES (?, ?)");
    const markEntry = db.prepare("UPDATE entries SET status = 'exportado' WHERE id = ?");
    const markDoc = db.prepare(
      "UPDATE documents SET status = 'exportado' WHERE id = ? AND status = 'validado'"
    );
    for (const row of rows) {
      link.run(batchId, row.id);
      markEntry.run(row.id);
      markDoc.run(row.document_id);
    }
    audit(db, userId, "export", "export_batch", batchId, `${rows.length} lancamentos`);
    return batchId;
  });

  const batchId = tx();
  return { batchId, entryCount: rows.length, csv };
}
