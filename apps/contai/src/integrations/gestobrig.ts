/**
 * GestObrig (gestobrig.com) integration: fiscal obligations managed by the firm.
 *
 * GestObrig has no public API (confirmed on 2026-09-14: website, pricing and support pages only;
 * technical contact gestobrigweb@gmail.com). The integration therefore works in layers:
 *  1. File mode (available now): import the obligation lists exported from GestObrig (CSV or Excel)
 *     into the `obligations` table, matched to Cont.ai companies by NIF. Idempotent by
 *     (company, code, period, source).
 *  2. Links (available now): GESTOBRIG_URL opens the firm's GestObrig from Cont.ai.
 *  3. API mode (future): `ObligationsSource` is the contract an API or RPA connector must implement;
 *     `FileObligationsSource` is the only implementation today.
 */
import * as XLSX from "xlsx";
import { Db, audit } from "../db.js";

export type ObligationStatus = "por_cumprir" | "cumprida" | "fora_prazo" | "justificada";

export interface ObligationRow {
  nif: string | null;
  companyName: string | null;
  code: string;
  label: string;
  period: string | null;   // 2026-07, 2026-T2, 2025
  dueDate: string | null;  // YYYY-MM-DD
  status: ObligationStatus;
  submittedAt: string | null;
  responsible: string | null;
  notes: string | null;
  externalRef: string | null;
}

export interface ObligationsSource {
  name: string;
  fetch(): Promise<ObligationRow[]>;
}

/** Known obligation codes with the keywords GestObrig (and accountants) use for them. */
const CODES: [string, RegExp][] = [
  ["IVA-DP", /iva.*(peri[oó]dica|declara|dp\b)|declara[cç][aã]o peri[oó]dica/i],
  ["IVA-REC", /recapitulativa/i],
  ["IVA-PAG", /pagamento.*iva|iva.*pagamento/i],
  ["DMR", /\bdmr\b(?!.*seg)|declara[cç][aã]o mensal de remunera/i],
  ["DMR-SS", /dmr.*(ss|seg|social)|seguran[cç]a social/i],
  ["SAFT", /saf-?t|e-?fa[ct]tura/i],
  ["DRI", /\bdri\b|retenc/i],
  ["MOD22", /modelo ?22|\bm22\b|irc/i],
  ["IES", /\bies\b/i],
  ["MOD10", /modelo ?10/i],
  ["MOD30", /modelo ?30/i],
  ["MOD3", /modelo ?3\b|irs/i],
  ["PEC", /pagamento (especial )?por conta|\bpec\b|\bppc\b/i],
  ["IUC", /\biuc\b/i],
  ["IMI", /\bimi\b/i],
  ["RCBE", /rcbe|benefici[aá]rio efe[ct]tivo/i],
  ["INV", /invent[aá]rio/i],
];

export function obligationCode(label: string): string {
  for (const [code, re] of CODES) if (re.test(label)) return code;
  return "OUTRA";
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Maps a header row to canonical fields by keyword. */
export function mapHeaders(headers: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => {
    const n = norm(String(h ?? ""));
    const set = (k: string) => { if (idx[k] === undefined) idx[k] = i; };
    if (/\bnif\b|contribuinte|nipc/.test(n)) set("nif");
    else if (/entidade|empresa|cliente|nome/.test(n)) set("company");
    else if (/obriga|declara|tipo|descri/.test(n)) set("label");
    else if (/periodo|ano|mes|trimestre|exercicio/.test(n)) set("period");
    else if (/prazo|limite|vencimento|data ?fim|termo/.test(n)) set("due");
    else if (/estado|situacao|status/.test(n)) set("status");
    else if (/entreg|submiss|submet|envio|enviad|cumprid/.test(n)) set("submitted");
    else if (/respons|utilizador|tecnico|contabilista/.test(n)) set("responsible");
    else if (/observ|nota|justif|coment/.test(n)) set("notes");
    else if (/\bid\b|ref|n\.?o|numero/.test(n)) set("ref");
  });
  return idx;
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

export function parsePeriod(v: unknown, due: string | null): string | null {
  if (v == null || v === "") return due ? due.slice(0, 7) : null;
  const s = norm(String(v));
  let m = s.match(/(\d{4})[-\/](\d{1,2})$/); if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}`;
  m = s.match(/(\d{1,2})[-\/](\d{4})/); if (m) return `${m[2]}-${m[1]!.padStart(2, "0")}`;
  m = s.match(/([1-4])\s*[ºo.]?\s*t(?:rim)?\w*\s*(?:de\s*)?(\d{4})/); if (m) return `${m[2]}-T${m[1]}`;
  m = s.match(/(\d{4})\s*[-\/ ]\s*t([1-4])/); if (m) return `${m[1]}-T${m[2]}`;
  m = s.match(/^(\d{4})$/); if (m) return m[1]!;
  const months = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  m = s.match(/([a-z]{3})\w*\s*[\/ -]?\s*(\d{4})/); if (m && months.indexOf(m[1]!) >= 0) return `${m[2]}-${String(months.indexOf(m[1]!) + 1).padStart(2, "0")}`;
  return String(v).trim().slice(0, 20);
}

export function parseStatus(v: unknown, due: string | null, submitted: string | null, today = new Date().toISOString().slice(0, 10)): ObligationStatus {
  const s = norm(String(v ?? ""));
  if (/justif/.test(s)) return "justificada";
  if (/fora|atras|tardi/.test(s)) return "fora_prazo";
  if (/cumprid|entreg|submet|envia|conclu|ok\b|sim\b/.test(s) || submitted) {
    return due && submitted && submitted > due ? "fora_prazo" : "cumprida";
  }
  if (/pendente|por |nao|em curso|aberto|falta/.test(s) || !s) return "por_cumprir";
  return "por_cumprir";
}

/** Parses a GestObrig export (CSV with ; or , or Excel first sheet) into obligation rows. */
export function parseGestObrigExport(buffer: Buffer, filename = ""): { rows: ObligationRow[]; headers: string[]; mapping: Record<string, number> } {
  const isCsv = /\.csv$|\.txt$/i.test(filename) || (!/\.xlsx?$/i.test(filename) && looksLikeText(buffer));
  let table: unknown[][];
  if (isCsv) {
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    const sep = (text.split("\n")[0] || "").split(";").length >= (text.split("\n")[0] || "").split(",").length ? ";" : ",";
    const wb = XLSX.read(text, { type: "string", FS: sep, raw: true });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: true, defval: "" }) as unknown[][];
  } else {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: true, defval: "" }) as unknown[][];
  }
  // header = first row with at least 3 non-empty cells
  const hi = table.findIndex((r) => r.filter((c) => String(c ?? "").trim()).length >= 3);
  if (hi < 0) return { rows: [], headers: [], mapping: {} };
  const headers = table[hi]!.map((c) => String(c ?? ""));
  const mapping = mapHeaders(headers);
  if (mapping.label === undefined && mapping.company === undefined) return { rows: [], headers, mapping };
  const rows: ObligationRow[] = [];
  for (const r of table.slice(hi + 1)) {
    const cell = (k: string): unknown => (mapping[k] === undefined ? "" : r[mapping[k]!]);
    const label = String(cell("label") ?? "").trim();
    if (!label && !String(cell("company") ?? "").trim()) continue;
    const due = parseDate(cell("due")); const submitted = parseDate(cell("submitted"));
    const nifRaw = String(cell("nif") ?? "").replace(/\D/g, "");
    rows.push({
      nif: /^\d{9}$/.test(nifRaw) ? nifRaw : null,
      companyName: String(cell("company") ?? "").trim() || null,
      code: obligationCode(label), label: label || "Obrigação",
      period: parsePeriod(cell("period"), due), dueDate: due,
      status: parseStatus(cell("status"), due, submitted), submittedAt: submitted,
      responsible: String(cell("responsible") ?? "").trim() || null,
      notes: String(cell("notes") ?? "").trim() || null,
      externalRef: String(cell("ref") ?? "").trim() || null,
    });
  }
  return { rows, headers, mapping };
}

function looksLikeText(b: Buffer): boolean {
  const head = b.subarray(0, Math.min(512, b.length));
  if (head[0] === 0x50 && head[1] === 0x4b) return false; // zip = xlsx
  let bin = 0; for (const c of head) if (c === 0 || (c < 9)) bin++;
  return bin === 0;
}

export class FileObligationsSource implements ObligationsSource {
  name = "gestobrig-ficheiro";
  constructor(private buffer: Buffer, private filename: string) {}
  async fetch(): Promise<ObligationRow[]> { return parseGestObrigExport(this.buffer, this.filename).rows; }
}

export interface ImportReport { imported: number; updated: number; skipped: { row: ObligationRow; reason: string }[]; total: number }

/** Upserts rows into `obligations`, matching companies by NIF (or exact name as fallback). */
export function importObligations(db: Db, rows: ObligationRow[], userId: number | null, source = "gestobrig", onlyCompanyId: number | null = null): ImportReport {
  const byNif = new Map<string, number>(); const byName = new Map<string, number>();
  for (const c of db.prepare("SELECT id, nif, name FROM companies").all() as any[]) { byNif.set(c.nif, c.id); byName.set(norm(c.name), c.id); }
  const find = db.prepare("SELECT id FROM obligations WHERE company_id = ? AND code = ? AND COALESCE(period,'') = ? AND source = ? AND COALESCE(external_ref,'') = ?");
  const ins = db.prepare(`INSERT INTO obligations (company_id, source, external_ref, code, label, period, due_date, status, submitted_at, responsible, notes, imported_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
  const upd = db.prepare(`UPDATE obligations SET label = ?, due_date = ?, status = ?, submitted_at = ?, responsible = ?, notes = ?, imported_at = datetime('now') WHERE id = ?`);
  const report: ImportReport = { imported: 0, updated: 0, skipped: [], total: rows.length };
  const tx = db.transaction(() => {
    for (const r of rows) {
      let companyId = onlyCompanyId ?? (r.nif ? byNif.get(r.nif) : undefined) ?? (r.companyName ? byName.get(norm(r.companyName)) : undefined);
      if (!companyId) { report.skipped.push({ row: r, reason: r.nif ? `NIF ${r.nif} não existe nas empresas` : "sem NIF nem empresa reconhecida" }); continue; }
      const existing = find.get(companyId, r.code, r.period ?? "", source, r.externalRef ?? "") as any;
      if (existing) { upd.run(r.label, r.dueDate, r.status, r.submittedAt, r.responsible, r.notes, existing.id); report.updated++; }
      else { ins.run(companyId, source, r.externalRef, r.code, r.label, r.period, r.dueDate, r.status, r.submittedAt, r.responsible, r.notes); report.imported++; }
    }
  });
  tx();
  audit(db, userId, "obligations_import", "obligations", null, JSON.stringify({ source, imported: report.imported, updated: report.updated, skipped: report.skipped.length }));
  return report;
}

export interface ObligationsSummary { overdue: number; dueSoon: number; open: number; doneThisMonth: number; lateThisYear: number }

export function obligationsSummary(db: Db, companyId: number | null, today = new Date().toISOString().slice(0, 10), soonDays = 7): ObligationsSummary {
  const where = companyId !== null ? "AND company_id = ?" : ""; const p = companyId !== null ? [companyId] : [];
  const soon = new Date(new Date(today + "T00:00:00Z").getTime() + soonDays * 86400_000).toISOString().slice(0, 10);
  const q = (sql: string, ...extra: any[]) => (db.prepare(`SELECT COUNT(*) AS n FROM obligations WHERE 1=1 ${where} ${sql}`).get(...p, ...extra) as any).n as number;
  return {
    overdue: q("AND status = 'por_cumprir' AND due_date IS NOT NULL AND due_date < ?", today),
    dueSoon: q("AND status = 'por_cumprir' AND due_date >= ? AND due_date <= ?", today, soon),
    open: q("AND status = 'por_cumprir'"),
    doneThisMonth: q("AND status IN ('cumprida','fora_prazo','justificada') AND substr(COALESCE(submitted_at, due_date, ''),1,7) = ?", today.slice(0, 7)),
    lateThisYear: q("AND status IN ('fora_prazo','justificada') AND substr(COALESCE(due_date,''),1,4) = ?", today.slice(0, 4)),
  };
}

/** Parses an access list (CSV/Excel) with columns like NIF/Empresa, Entidade, Utilizador, Palavra-passe, URL, Notas. */
export function parseAccessExport(buffer: Buffer, filename = ""): { nif: string | null; companyName: string | null; entity: string; label: string | null; url: string | null; username: string | null; password: string | null; notes: string | null }[] {
  const isCsv = /\.csv$|\.txt$/i.test(filename) || (!/\.xlsx?$/i.test(filename) && looksLikeText(buffer));
  let table: unknown[][];
  if (isCsv) {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const first = text.split("\n")[0] || ""; const sep = first.split(";").length >= first.split(",").length ? ";" : ",";
    const wb = XLSX.read(text, { type: "string", FS: sep, raw: true });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: true, defval: "" }) as unknown[][];
  } else {
    const wb = XLSX.read(buffer, { type: "buffer" });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: true, defval: "" }) as unknown[][];
  }
  const hi = table.findIndex((r) => r.filter((c) => String(c ?? "").trim()).length >= 3);
  if (hi < 0) return [];
  const headers = table[hi]!.map((c) => norm(String(c ?? "")));
  const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
  const iNif = col(/\bnif\b|nipc|contribuinte/), iComp = col(/empresa|entidade empregadora|cliente|nome/), iEnt = col(/^entidade$|portal|servico|site|plataforma/), iUser = col(/utilizador|user|login|niss|acesso/), iPass = col(/senha|palavra|password|pass\b/), iUrl = col(/url|endereco|link/), iNotes = col(/nota|observ/);
  const out = [];
  for (const r of table.slice(hi + 1)) {
    const g = (i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
    const entityLabel = g(iEnt); const nifRaw = g(iNif).replace(/\D/g, "");
    if (!entityLabel && !g(iUser)) continue;
    out.push({ nif: /^\d{9}$/.test(nifRaw) ? nifRaw : null, companyName: g(iComp) || null, entity: entityLabel, label: entityLabel || null, url: g(iUrl) || null, username: g(iUser) || null, password: g(iPass) || null, notes: g(iNotes) || null });
  }
  return out;
}
