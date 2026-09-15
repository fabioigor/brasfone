/**
 * Balancetes: import (CSV exported from the accounting system) or derive from
 * approved entries, then aggregate into the financial figures used by the
 * pattern checks and the client reports.
 */
import { Db } from "../db.js";
import { EntryLine } from "./entries.js";

export interface BalanceLine {
  account: string;
  description: string;
  debit: number;
  credit: number;
  balance: number; // debit - credit (positive = devedor)
}

export interface TrialBalance {
  companyId: number;
  period: string; // YYYY-MM or YYYY
  source: "importado" | "derivado";
  lines: BalanceLine[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function num(raw: string | undefined): number {
  if (!raw) return 0;
  let s = raw.trim().replace(/€/g, "").replace(/\s/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? round2(n) : 0;
}

/**
 * Parses a balancete CSV. Accepted headers (case-insensitive, ; or , separated):
 * conta;descricao;debito;credito[;saldo]. When saldo is missing it is derived.
 */
export function parseBalanceCsv(text: string): BalanceLine[] {
  const rows = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rows.length === 0) return [];
  const sep = rows[0]!.includes(";") ? ";" : ",";
  const header = rows[0]!.split(sep).map((h) => h.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iAcc = idx(["conta", "account", "codigo"]);
  const iDesc = idx(["descricao", "designacao", "description", "nome"]);
  const iDeb = idx(["debito", "debit", "debitos"]);
  const iCred = idx(["credito", "credit", "creditos"]);
  const iBal = idx(["saldo", "balance"]);
  if (iAcc < 0) throw new Error("CSV sem coluna 'conta'.");
  const lines: BalanceLine[] = [];
  for (const row of rows.slice(1)) {
    const cols = row.split(sep);
    const account = (cols[iAcc] ?? "").trim();
    if (!account) continue;
    const debit = iDeb >= 0 ? num(cols[iDeb]) : 0;
    const credit = iCred >= 0 ? num(cols[iCred]) : 0;
    const balance = iBal >= 0 && cols[iBal]?.trim() ? num(cols[iBal]) : round2(debit - credit);
    lines.push({ account, description: iDesc >= 0 ? (cols[iDesc] ?? "").trim() : "", debit, credit, balance });
  }
  return lines;
}

/** Derives a balancete for a period from approved/exported entries. */
export function deriveBalanceFromEntries(db: Db, companyId: number, period: string): BalanceLine[] {
  const rows = db
    .prepare(
      `SELECT lines_json FROM entries WHERE company_id = ? AND status IN ('aprovado','exportado') AND substr(entry_date, 1, ?) = ?`
    )
    .all(companyId, period.length, period) as any[];
  const acc = new Map<string, BalanceLine>();
  for (const r of rows) {
    for (const l of JSON.parse(r.lines_json) as EntryLine[]) {
      const cur = acc.get(l.account) ?? { account: l.account, description: l.description, debit: 0, credit: 0, balance: 0 };
      cur.debit = round2(cur.debit + l.debit);
      cur.credit = round2(cur.credit + l.credit);
      cur.balance = round2(cur.debit - cur.credit);
      acc.set(l.account, cur);
    }
  }
  return [...acc.values()].sort((a, b) => a.account.localeCompare(b.account));
}

export function saveTrialBalance(db: Db, tb: TrialBalance, userId: number | null): number {
  const tx = db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM trial_balances WHERE company_id = ? AND period = ?")
      .get(tb.companyId, tb.period) as any;
    if (existing) {
      db.prepare("DELETE FROM trial_balance_lines WHERE trial_balance_id = ?").run(existing.id);
      db.prepare("DELETE FROM trial_balances WHERE id = ?").run(existing.id);
    }
    const r = db
      .prepare("INSERT INTO trial_balances (company_id, period, source, created_by) VALUES (?, ?, ?, ?)")
      .run(tb.companyId, tb.period, tb.source, userId);
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare(
      "INSERT INTO trial_balance_lines (trial_balance_id, account, description, debit, credit, balance) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const l of tb.lines) ins.run(id, l.account, l.description, l.debit, l.credit, l.balance);
    return id;
  });
  return tx();
}

export function loadTrialBalance(db: Db, companyId: number, period: string): TrialBalance | null {
  const tb = db.prepare("SELECT * FROM trial_balances WHERE company_id = ? AND period = ?").get(companyId, period) as any;
  if (!tb) return null;
  const lines = db
    .prepare("SELECT account, description, debit, credit, balance FROM trial_balance_lines WHERE trial_balance_id = ? ORDER BY account")
    .all(tb.id) as BalanceLine[];
  return { companyId, period, source: tb.source, lines };
}

/** The period immediately before (YYYY-MM -> previous month; YYYY -> previous year). */
export function previousPeriod(period: string): string {
  if (/^\d{4}$/.test(period)) return String(Number(period) - 1);
  const [y, m] = period.split("-").map(Number);
  const idx = y! * 12 + (m! - 1) - 1;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Sum of balances (signed) for accounts starting with any of the prefixes. */
export function sumPrefix(lines: BalanceLine[], prefixes: string[], mode: "balance" | "debit" | "credit" = "balance"): number {
  return round2(
    lines
      .filter((l) => prefixes.some((p) => l.account.startsWith(p)))
      .reduce((s, l) => s + l[mode], 0)
  );
}

/** SNC-based aggregates used by rules and reports (amounts positive). */
export interface Financials {
  vendas: number;          // 71 + 72 (credit balance)
  cmvmc: number;           // 61
  fse: number;             // 62
  pessoal: number;         // 63
  outrosGastos: number;    // 64-69 excl. 68 (juros) simplification
  ebitda: number;
  resultadoLiquido: number; // 81 or derived
  activo: number;          // classes 1-4 debit side (simplified)
  capitalProprio: number;  // 5
  passivo: number;         // 22, 23, 24 credit side, 25 financiamentos
  clientes: number;        // 21
  fornecedores: number;    // 22
  disponibilidades: number; // 11 + 12
  financiamentos: number;  // 25
}

export function computeFinancials(lines: BalanceLine[]): Financials {
  const vendas = round2(-sumPrefix(lines, ["71", "72"]));
  const cmvmc = sumPrefix(lines, ["61"]);
  const fse = sumPrefix(lines, ["62"]);
  const pessoal = sumPrefix(lines, ["63"]);
  const outrosGastos = round2(sumPrefix(lines, ["64", "65", "66", "67", "68", "69"]));
  const outrosRendimentos = round2(-sumPrefix(lines, ["73", "74", "75", "76", "78", "79"]));
  const ebitda = round2(vendas + outrosRendimentos - cmvmc - fse - pessoal - sumPrefix(lines, ["65", "66", "67"]));
  const depreciacoes = sumPrefix(lines, ["64"]);
  const juros = sumPrefix(lines, ["69"]);
  const irc = sumPrefix(lines, ["81"]);
  const resultadoLiquido = round2(ebitda - depreciacoes - juros - irc + sumPrefix(lines, ["68"]) * 0);
  const clientes = sumPrefix(lines, ["21"]);
  const fornecedores = round2(-sumPrefix(lines, ["22"]));
  const disponibilidades = sumPrefix(lines, ["11", "12", "13"]);
  const financiamentos = round2(-sumPrefix(lines, ["25"]));
  const activo = round2(
    disponibilidades + clientes + sumPrefix(lines, ["3", "41", "42", "43", "44", "45", "46"]) + Math.max(0, sumPrefix(lines, ["24"]))
  );
  const capitalProprio = round2(-sumPrefix(lines, ["5"]) + resultadoLiquido);
  const passivo = round2(fornecedores + financiamentos + Math.max(0, -sumPrefix(lines, ["23", "24", "26", "27", "28"])));
  return {
    vendas, cmvmc, fse, pessoal, outrosGastos, ebitda, resultadoLiquido, activo, capitalProprio, passivo,
    clientes, fornecedores, disponibilidades, financiamentos,
  };
}
