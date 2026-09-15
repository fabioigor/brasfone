/**
 * e-Fatura (Portal das Finanças) reconciliation.
 *
 * The AT has no public API for third parties to list the invoices communicated by suppliers, so
 * the source is the export the accountant downloads from e-Fatura ("Consultar faturas" > exportar,
 * CSV or Excel), in the acquirer's view (purchases) or the issuer's view (sales). `EFaturaSource`
 * is the contract a future connector must implement; `FileEFaturaSource` is the only one today.
 *
 * Reconciliation: each communicated document is matched to a document received in Cont.ai for the
 * same company (issuer NIF + document number, or issuer NIF + date + total). Matched = "validado";
 * unmatched = "em_falta" and a document request is created for the client automatically; documents
 * in Cont.ai that the supplier did not communicate are listed as "nao_comunicado". A button builds
 * and sends the client an email with the validated and missing lists (Microsoft Graph Mail.Send).
 */
import * as XLSX from "xlsx";
import { Db, audit } from "../db.js";

export type EFaturaStatus = "validado" | "em_falta" | "ignorado";

export interface EFaturaRow {
  issuerNif: string | null;
  issuerName: string | null;
  acquirerNif: string | null;
  docType: string | null;     // FT, FR, FS, NC, ND...
  docNumber: string | null;
  atcud: string | null;
  docDate: string | null;     // YYYY-MM-DD
  total: number | null;
  vat: number | null;
  base: number | null;
  portalStatus: string | null; // Registada, Pendente, Anulada...
  sector: string | null;
}

export interface EFaturaSource { name: string; fetch(): Promise<EFaturaRow[]> }

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

export function parseMoney(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  let s = String(v).replace(/[€\s]/g, "").replace(/EUR/i, "");
  if (!s) return null;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{1,2}$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(/[.,](?=\d{3}\b)/g, "");
  const n = Number(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function parseDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number") { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : null; }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
}

/** "501442600 - ELECTRO FORNECEDORA LDA" → nif + name. */
export function splitEntity(v: unknown): { nif: string | null; name: string | null } {
  const s = String(v ?? "").trim();
  if (!s) return { nif: null, name: null };
  const m = s.match(/(\d{9})/);
  const nif = m ? m[1]! : null;
  const name = s.replace(/\d{9}/, "").replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, "").trim() || null;
  return { nif, name: name && name !== nif ? name : null };
}

/** Normalised document number for matching: uppercase, no spaces, no leading zeros in the last numeric run. */
export function normDocNumber(v: string | null | undefined): string {
  if (!v) return "";
  return String(v).toUpperCase().replace(/\s+/g, "").replace(/(\D)0+(\d)/g, "$1$2").replace(/^0+(\d)/, "$1");
}

export function mapHeaders(headers: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => {
    const n = norm(String(h ?? ""));
    const set = (k: string) => { if (idx[k] === undefined) idx[k] = i; };
    if (/atcud/.test(n) && !/n[.º°o]?\s*(fatura|doc)/.test(n)) set("atcud");
    else if (/nif.*(adquirente|cliente)|adquirente/.test(n)) set("acquirer");
    else if (/nif.*emitente|emitente|fornecedor|comerciante|nif\b/.test(n)) set("issuer");
    else if (/nome|designacao|denominacao/.test(n)) set("issuerName");
    else if (/tipo/.test(n)) set("docType");
    else if (/n[.º°o]?\s*(da\s+)?(fatura|factura|doc)|numero|n\.?\s*documento/.test(n)) set("docNumber");
    else if (/data/.test(n)) set("date");
    else if (/base|tributavel|incidencia/.test(n)) set("base");
    else if (/\biva\b|imposto/.test(n)) set("vat");
    else if (/total|valor/.test(n)) set("total");
    else if (/situacao|estado|status/.test(n)) set("status");
    else if (/sec?tor|ac?tividade/.test(n)) set("sector");
  });
  return idx;
}

function looksLikeText(b: Buffer): boolean {
  const head = b.subarray(0, Math.min(512, b.length));
  if (head[0] === 0x50 && head[1] === 0x4b) return false;
  for (const c of head) if (c === 0) return false;
  return true;
}

export function parseEFaturaExport(buffer: Buffer, filename = ""): { rows: EFaturaRow[]; headers: string[]; mapping: Record<string, number> } {
  const isCsv = /\.csv$|\.txt$/i.test(filename) || (!/\.xlsx?$/i.test(filename) && looksLikeText(buffer));
  let table: unknown[][];
  if (isCsv) {
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    const first = text.split("\n")[0] || ""; const sep = first.split(";").length >= first.split(",").length ? ";" : (first.split("\t").length > first.split(",").length ? "\t" : ",");
    const wb = XLSX.read(text, { type: "string", FS: sep, raw: true });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: true, defval: "" }) as unknown[][];
  } else {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: true, defval: "" }) as unknown[][];
  }
  const hi = table.findIndex((r) => r.filter((c) => String(c ?? "").trim()).length >= 3 && r.some((c) => /emitente|fatura|factura|nif|atcud|total/i.test(String(c))));
  if (hi < 0) return { rows: [], headers: [], mapping: {} };
  const headers = table[hi]!.map((c) => String(c ?? ""));
  const mapping = mapHeaders(headers);
  if (mapping.issuer === undefined && mapping.docNumber === undefined) return { rows: [], headers, mapping };
  const rows: EFaturaRow[] = [];
  for (const r of table.slice(hi + 1)) {
    const cell = (k: string): unknown => (mapping[k] === undefined ? "" : r[mapping[k]!]);
    const issuer = splitEntity(cell("issuer"));
    const acquirer = splitEntity(cell("acquirer"));
    const numberRaw = String(cell("docNumber") ?? "").trim();
    if (!numberRaw && !issuer.nif) continue;
    // e-Fatura sometimes puts "FT A/1 / ATCUD ABC-1" in one cell.
    let docNumber = numberRaw; let atcud = String(cell("atcud") ?? "").trim() || null;
    const both = numberRaw.match(/^(.*?)\s*[\/|]\s*([A-Z0-9]{6,}-\d+)$/i);
    if (both && !atcud) { docNumber = both[1]!.trim(); atcud = both[2]!; }
    const total = parseMoney(cell("total")); const vat = parseMoney(cell("vat")); const base = parseMoney(cell("base"));
    rows.push({
      issuerNif: issuer.nif, issuerName: issuer.name || (String(cell("issuerName") ?? "").trim() || null), acquirerNif: acquirer.nif,
      docType: String(cell("docType") ?? "").trim() || null, docNumber: docNumber || null, atcud,
      docDate: parseDate(cell("date")), total: total ?? (base != null && vat != null ? Math.round((base + vat) * 100) / 100 : null), vat, base,
      portalStatus: String(cell("status") ?? "").trim() || null, sector: String(cell("sector") ?? "").trim() || null,
    });
  }
  return { rows, headers, mapping };
}

export class FileEFaturaSource implements EFaturaSource {
  name = "efatura-ficheiro";
  constructor(private buffer: Buffer, private filename: string) {}
  async fetch(): Promise<EFaturaRow[]> { return parseEFaturaExport(this.buffer, this.filename).rows; }
}

export interface ImportReport { imported: number; updated: number; skipped: number; total: number }

/** Upserts communicated documents for a company. Direction: sale when the company is the issuer, purchase otherwise. */
export function importEFatura(db: Db, companyId: number, rows: EFaturaRow[], userId: number | null, source = "ficheiro"): ImportReport {
  const company = db.prepare("SELECT nif FROM companies WHERE id = ?").get(companyId) as any;
  if (!company) throw new Error("Empresa inexistente");
  const find = db.prepare("SELECT id FROM efatura_documents WHERE company_id = ? AND COALESCE(issuer_nif,'') = ? AND doc_number_norm = ?");
  const ins = db.prepare(`INSERT INTO efatura_documents (company_id, direction, source, issuer_nif, issuer_name, acquirer_nif, doc_type, doc_number, doc_number_norm, atcud, doc_date, total, vat, base, portal_status, sector, status, imported_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'em_falta', datetime('now'))`);
  const upd = db.prepare(`UPDATE efatura_documents SET issuer_name = COALESCE(?, issuer_name), doc_type = COALESCE(?, doc_type), atcud = COALESCE(?, atcud), doc_date = COALESCE(?, doc_date), total = COALESCE(?, total), vat = COALESCE(?, vat), base = COALESCE(?, base), portal_status = COALESCE(?, portal_status), sector = COALESCE(?, sector), imported_at = datetime('now') WHERE id = ?`);
  const report: ImportReport = { imported: 0, updated: 0, skipped: 0, total: rows.length };
  const tx = db.transaction(() => {
    for (const r of rows) {
      const numberNorm = normDocNumber(r.docNumber);
      if (!numberNorm && !r.atcud) { report.skipped++; continue; }
      const direction = r.issuerNif && r.issuerNif === company.nif ? "venda" : "compra";
      const key = numberNorm || `ATCUD:${r.atcud}`;
      const existing = find.get(companyId, r.issuerNif ?? "", key) as any;
      if (existing) { upd.run(r.issuerName, r.docType, r.atcud, r.docDate, r.total, r.vat, r.base, r.portalStatus, r.sector, existing.id); report.updated++; }
      else { ins.run(companyId, direction, source, r.issuerNif, r.issuerName, r.acquirerNif, r.docType, r.docNumber, key, r.atcud, r.docDate, r.total, r.vat, r.base, r.portalStatus, r.sector); report.imported++; }
    }
  });
  tx();
  audit(db, userId, "efatura_import", "efatura", null, JSON.stringify({ companyId, source, ...report }));
  return report;
}

interface DocCandidate { id: number; nif: string | null; number: string; date: string | null; total: number | null; atcud: string | null; docType: string; status: string }

function companyDocuments(db: Db, companyId: number, companyNif: string): DocCandidate[] {
  const rows = db.prepare("SELECT id, doc_type, status, extracted_json FROM documents WHERE company_id = ? AND status != 'rejeitado'").all(companyId) as any[];
  const out: DocCandidate[] = [];
  for (const d of rows) {
    let x: any = null; try { x = JSON.parse(d.extracted_json || "null"); } catch { /* ignore */ }
    if (!x) continue;
    const nif = x.issuerNif && x.issuerNif !== companyNif ? x.issuerNif : ((x.nifs || []).find((n: string) => n !== companyNif) ?? null);
    out.push({ id: d.id, nif, number: normDocNumber(x.docNumber), date: x.docDate ?? null, total: x.totalAmount ?? null, atcud: x.atcud ?? null, docType: d.doc_type, status: d.status });
  }
  return out;
}

export interface ReconcileReport { validated: number; missing: number; requestsCreated: number; requestsFulfilled: number; notCommunicated: number }

/**
 * Matches communicated documents to received ones; creates one document request per missing
 * document (idempotent) and fulfils it when the document later arrives.
 */
export function reconcileEFatura(db: Db, companyId: number, userId: number | null, opts: { requestDueDays?: number; createRequests?: boolean } = {}): ReconcileReport {
  const company = db.prepare("SELECT id, nif FROM companies WHERE id = ?").get(companyId) as any;
  if (!company) throw new Error("Empresa inexistente");
  const docs = companyDocuments(db, companyId, company.nif);
  const rows = db.prepare("SELECT * FROM efatura_documents WHERE company_id = ? AND status != 'ignorado'").all(companyId) as any[];
  const report: ReconcileReport = { validated: 0, missing: 0, requestsCreated: 0, requestsFulfilled: 0, notCommunicated: 0 };
  const dueDays = opts.requestDueDays ?? 7;
  const createRequests = opts.createRequests !== false;
  const requester = userId ?? ((db.prepare("SELECT id FROM users WHERE role = 'staff' ORDER BY id LIMIT 1").get() as any)?.id ?? 1);
  const matched = new Set<number>();
  const tx = db.transaction(() => {
    for (const r of rows) {
      const sameNif = docs.filter((d) => (r.direction === "venda" ? true : d.nif === r.issuer_nif));
      let hit = sameNif.find((d) => r.atcud && d.atcud && d.atcud === r.atcud) ?? null; let confidence = hit ? 1 : 0;
      if (!hit && r.doc_number_norm && !r.doc_number_norm.startsWith("ATCUD:")) { hit = sameNif.find((d) => d.number && d.number === r.doc_number_norm) ?? null; confidence = hit ? 1 : 0; }
      if (!hit && r.doc_date && r.total != null) { hit = sameNif.find((d) => d.date === r.doc_date && d.total != null && Math.abs(d.total - r.total) <= 0.05) ?? null; confidence = hit ? 0.9 : 0; }
      if (hit) {
        matched.add(hit.id);
        db.prepare("UPDATE efatura_documents SET status = 'validado', document_id = ?, match_confidence = ?, reconciled_at = datetime('now') WHERE id = ?").run(hit.id, confidence, r.id);
        report.validated++;
        if (r.request_id) {
          const done = db.prepare("UPDATE doc_requests SET status = 'cumprido', fulfilled_document_id = ? WHERE id = ? AND status = 'pendente'").run(hit.id, r.request_id);
          if (done.changes) { report.requestsFulfilled++; audit(db, userId, "fulfil", "doc_request", r.request_id, `documento ${hit.id} (e-Fatura)`); }
        }
      } else {
        db.prepare("UPDATE efatura_documents SET status = 'em_falta', document_id = NULL, match_confidence = NULL, reconciled_at = datetime('now') WHERE id = ?").run(r.id);
        report.missing++;
        if (createRequests && r.direction === "compra") {
          const pending = r.request_id ? (db.prepare("SELECT id, status FROM doc_requests WHERE id = ?").get(r.request_id) as any) : null;
          if (!pending || pending.status === "cancelado") {
            const due = new Date(Date.now() + dueDays * 86400_000).toISOString().slice(0, 10);
            const title = `Factura ${r.doc_number || r.atcud || ""} de ${r.issuer_name || "NIF " + (r.issuer_nif || "?")}`.trim();
            const details = `Comunicada ao e-Fatura${r.doc_date ? " em " + r.doc_date : ""}${r.total != null ? ", total " + r.total.toFixed(2) + " EUR" : ""}. Envie o documento para ficar validado.`;
            const req = db.prepare("INSERT INTO doc_requests (company_id, created_by, title, details, due_date, efatura_id) VALUES (?, ?, ?, ?, ?, ?)").run(companyId, requester, title, details, due, r.id);
            db.prepare("UPDATE efatura_documents SET request_id = ? WHERE id = ?").run(Number(req.lastInsertRowid), r.id);
            audit(db, userId, "create", "doc_request", Number(req.lastInsertRowid), `e-Fatura ${r.doc_number || r.atcud}`);
            report.requestsCreated++;
          }
        }
      }
    }
  });
  tx();
  // Purchases received in Cont.ai whose supplier did not communicate them (within the periods covered by the import).
  report.notCommunicated = notCommunicated(db, companyId, docs).length;
  audit(db, userId, "efatura_reconcile", "efatura", null, JSON.stringify({ companyId, ...report }));
  return report;
}

/** Purchase documents in Cont.ai without a communicated counterpart, limited to the months covered by imported rows. */
export function notCommunicated(db: Db, companyId: number, docs?: DocCandidate[]): { document_id: number; nif: string | null; number: string; date: string | null; total: number | null }[] {
  const company = db.prepare("SELECT nif FROM companies WHERE id = ?").get(companyId) as any;
  if (!company) return [];
  const list = docs ?? companyDocuments(db, companyId, company.nif);
  const months = new Set((db.prepare("SELECT DISTINCT substr(doc_date, 1, 7) AS m FROM efatura_documents WHERE company_id = ? AND doc_date IS NOT NULL").all(companyId) as any[]).map((r) => r.m));
  if (!months.size) return [];
  const matchedIds = new Set((db.prepare("SELECT document_id FROM efatura_documents WHERE company_id = ? AND document_id IS NOT NULL").all(companyId) as any[]).map((r) => r.document_id));
  return list
    .filter((d) => ["factura_compra", "despesa", "nota_credito"].includes(d.docType) && d.nif && d.date && months.has(d.date.slice(0, 7)) && !matchedIds.has(d.id))
    .map((d) => ({ document_id: d.id, nif: d.nif, number: d.number, date: d.date, total: d.total }));
}

export interface EFaturaSummary { communicated: number; validated: number; missing: number; missingTotal: number; notCommunicated: number; periods: string[]; lastImport: string | null }

export function efaturaSummary(db: Db, companyId: number): EFaturaSummary {
  const r = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'validado' THEN 1 ELSE 0 END) AS v, SUM(CASE WHEN status = 'em_falta' THEN 1 ELSE 0 END) AS m,
                        SUM(CASE WHEN status = 'em_falta' THEN COALESCE(total, 0) ELSE 0 END) AS mt, MAX(imported_at) AS li FROM efatura_documents WHERE company_id = ? AND status != 'ignorado'`).get(companyId) as any;
  const periods = (db.prepare("SELECT DISTINCT substr(doc_date, 1, 7) AS m FROM efatura_documents WHERE company_id = ? AND doc_date IS NOT NULL ORDER BY m").all(companyId) as any[]).map((x) => x.m);
  return { communicated: r?.n || 0, validated: r?.v || 0, missing: r?.m || 0, missingTotal: Math.round((r?.mt || 0) * 100) / 100, notCommunicated: notCommunicated(db, companyId).length, periods, lastImport: r?.li || null };
}

export interface NotificationDraft { to: string[]; subject: string; html: string; text: string; validated: any[]; missing: any[] }

const eur = (n: number | null) => (n == null ? "" : n.toFixed(2).replace(".", ",") + " €");
const dmy = (d: string | null) => (d ? d.split("-").reverse().join("/") : "");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Email to the client: what is validated and what is still missing (purchases only). */
export function buildNotification(db: Db, companyId: number, opts: { period?: string | null; firmName?: string; appUrl?: string | null; message?: string | null; includeValidated?: boolean } = {}): NotificationDraft {
  const company = db.prepare("SELECT name, nif FROM companies WHERE id = ?").get(companyId) as any;
  if (!company) throw new Error("Empresa inexistente");
  const where = opts.period ? " AND substr(doc_date, 1, 7) = ?" : ""; const params: any[] = opts.period ? [companyId, opts.period] : [companyId];
  const rows = db.prepare(`SELECT * FROM efatura_documents WHERE company_id = ? AND direction = 'compra' AND status != 'ignorado'${where} ORDER BY doc_date, issuer_name`).all(...params) as any[];
  const validated = rows.filter((r) => r.status === "validado"); const missing = rows.filter((r) => r.status === "em_falta");
  const to = [
    ...(db.prepare("SELECT email FROM users WHERE role = 'client' AND company_id = ?").all(companyId) as any[]).map((u) => u.email),
    ...(db.prepare("SELECT address FROM company_contacts WHERE channel = 'email' AND company_id = ?").all(companyId) as any[]).map((c) => c.address),
  ].filter((e, i, a) => e && a.indexOf(e) === i);
  const firm = opts.firmName || "Lumarcont";
  const periodLabel = opts.period ? ` de ${opts.period.split("-").reverse().join("/")}` : "";
  const withValidated = opts.includeValidated === true;
  const subject = withValidated ? `${firm}: documentos${periodLabel} validados e em falta (${missing.length} em falta)` : `${firm}: documentos${periodLabel} em falta (${missing.length})`;
  const rowHtml = (r: any) => `<tr><td>${esc(dmy(r.doc_date))}</td><td>${esc(r.issuer_name || "")}<br><small>NIF ${esc(r.issuer_nif || "")}</small></td><td>${esc(r.doc_type || "")} ${esc(r.doc_number || r.atcud || "")}</td><td style="text-align:right">${esc(eur(r.total))}</td></tr>`;
  const table = (list: any[]) => `<table cellpadding="6" style="border-collapse:collapse;font-size:14px"><tr style="background:#F7F4EF"><th align="left">Data</th><th align="left">Emitente</th><th align="left">Documento</th><th align="right">Total</th></tr>${list.map(rowHtml).join("")}</table>`;
  const missingTotal = missing.reduce((s, r) => s + (r.total || 0), 0);
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1C1917;max-width:720px">
<p>Bom dia,</p>
<p>Cruzámos os documentos comunicados ao e-Fatura pelos seus fornecedores${periodLabel} com os documentos que nos enviou (${esc(company.name)}, NIF ${esc(company.nif)}).</p>
${opts.message ? `<p>${esc(opts.message)}</p>` : ""}
${withValidated ? `<h3 style="color:#0F5A44">Validados (${validated.length})</h3>${validated.length ? table(validated) : "<p>Ainda sem documentos validados neste período.</p>"}` : `<p>Já recebemos e validámos ${validated.length} documento(s)${periodLabel}.</p>`}
<h3 style="color:#b3261e">Em falta (${missing.length}${missing.length ? ", " + eur(missingTotal) : ""})</h3>
${missing.length ? table(missing) + `<p>Pedimos que nos envie estes documentos${opts.appUrl ? ` pela app Cont.ai (<a href="${esc(opts.appUrl)}">${esc(opts.appUrl)}</a>), pelo WhatsApp ou por email` : " pela app Cont.ai, pelo WhatsApp ou por email"}. Cada um já consta em "Pedidos" na sua área.</p>` : "<p>Não há documentos em falta. Obrigado.</p>"}
<p>Com os melhores cumprimentos,<br>${esc(firm)}</p>
</div>`;
  const line = (r: any) => `- ${dmy(r.doc_date)} · ${r.issuer_name || "NIF " + (r.issuer_nif || "")} · ${r.doc_type || ""} ${r.doc_number || r.atcud || ""} · ${eur(r.total)}`;
  const text = `Bom dia,\n\nCruzámos os documentos comunicados ao e-Fatura${periodLabel} com os documentos que nos enviou (${company.name}, NIF ${company.nif}).\n${opts.message ? "\n" + opts.message + "\n" : ""}\n${withValidated ? `VALIDADOS (${validated.length})\n${validated.map(line).join("\n") || "(nenhum)"}` : `Já recebemos e validámos ${validated.length} documento(s).`}\n\nEM FALTA (${missing.length}${missing.length ? ", " + eur(missingTotal) : ""})\n${missing.map(line).join("\n") || "(nenhum)"}\n\n${missing.length ? "Pedimos que nos envie estes documentos pela app Cont.ai, pelo WhatsApp ou por email. Cada um já consta em Pedidos na sua área.\n\n" : ""}Com os melhores cumprimentos,\n${firm}\n`;
  return { to, subject, html, text, validated, missing };
}
