/**
 * Padrões de conferência de balancetes. Each rule is data (stored per firm or
 * per company) so the accountant can tune thresholds in the configuration
 * area without code changes. The engine compares the current balancete with
 * the previous period and emits findings.
 */
import { Db } from "../db.js";
import { BalanceLine, sumPrefix, computeFinancials } from "./trialBalance.js";
import { Finding } from "./vatAudit.js";
import { persistFindings } from "./exceptions.js";
import { numberAt } from "./parameters.js";

export type RuleType = "saldo_sinal" | "variacao_percentual" | "variacao_absoluta" | "saldo_maximo" | "saldo_minimo" | "racio" | "variacao";
/** Reference methods for variation rules (B2). */
export type RuleMethod = "mes_anterior" | "mediana_12m" | "homologa" | "pct_vendas" | "pct_pessoal" | "valor_fixo" | "dias_recebimento" | "dias_pagamento";
export const RULE_METHODS: RuleMethod[] = ["mes_anterior", "mediana_12m", "homologa", "pct_vendas", "pct_pessoal", "valor_fixo", "dias_recebimento", "dias_pagamento"];

export interface BalanceRule {
  id?: number;
  companyId: number | null; // null = regra global ou sectorial
  /** Sector rule: applies to companies whose CAE starts with this prefix (companyId null). */
  caePrefix?: string | null;
  /** Account-level rule: applies to one exact account of one company (most specific level). */
  account?: string | null;
  name: string;
  type: RuleType;
  accountPrefixes: string[];
  /** saldo_sinal: 'devedor' | 'credor'; racio: prefixes of the denominator; valor_fixo: expected value. */
  param: string | null;
  /** Relative deviation: % (or p.p. for pct_* methods, days for dias_* methods). */
  threshold: number | null;
  /** Minimum absolute impact in euros (dual condition). */
  minImpact?: number | null;
  method?: RuleMethod | null;
  severity: "info" | "aviso" | "erro";
  enabled: boolean;
}

/** Hierarchy level, most specific first: conta > cliente > sector > global. */
export function ruleLevel(r: BalanceRule): 0 | 1 | 2 | 3 {
  if (r.companyId && r.account) return 0;
  if (r.companyId) return 1;
  if (r.caePrefix) return 2;
  return 3;
}

/**
 * Default patterns from the specification (starting point; impacts rescaled with the parameter
 * escala_impactos_minimos once Lumarcont indicates the median revenue of the portfolio).
 */
export const DEFAULT_RULES: Omit<BalanceRule, "id" | "companyId">[] = [
  { name: "Caixa e bancos não podem ficar credores", type: "saldo_sinal", accountPrefixes: ["11", "12"], param: "devedor", threshold: null, severity: "erro", enabled: true },
  { name: "Fornecedores devem ficar credores", type: "saldo_sinal", accountPrefixes: ["221"], param: "credor", threshold: null, severity: "aviso", enabled: true },
  { name: "Clientes devem ficar devedores", type: "saldo_sinal", accountPrefixes: ["211"], param: "devedor", threshold: null, severity: "aviso", enabled: true },
  { name: "IVA dedutível deve ficar devedor", type: "saldo_sinal", accountPrefixes: ["2432"], param: "devedor", threshold: null, severity: "aviso", enabled: true },
  { name: "IVA liquidado deve ficar credor", type: "saldo_sinal", accountPrefixes: ["2433"], param: "credor", threshold: null, severity: "aviso", enabled: true },
  { name: "61 Custo das mercadorias fora do padrão (% das vendas)", type: "variacao", method: "pct_vendas", accountPrefixes: ["61"], param: null, threshold: 5, minImpact: 1000, severity: "aviso", enabled: true },
  { name: "62 Fornecimentos e serviços fora do padrão", type: "variacao", method: "mediana_12m", accountPrefixes: ["62"], param: null, threshold: 30, minImpact: 500, severity: "aviso", enabled: true },
  { name: "63 Gastos com pessoal fora do padrão", type: "variacao", method: "mediana_12m", accountPrefixes: ["63"], param: null, threshold: 10, minImpact: 1000, severity: "aviso", enabled: true },
  { name: "64 Depreciações fora do padrão", type: "variacao", method: "mediana_12m", accountPrefixes: ["64"], param: null, threshold: 2, minImpact: 250, severity: "aviso", enabled: true },
  { name: "68 Outros gastos fora do padrão", type: "variacao", method: "mediana_12m", accountPrefixes: ["68"], param: null, threshold: 40, minImpact: 500, severity: "info", enabled: true },
  { name: "71 Vendas fora do padrão (homóloga)", type: "variacao", method: "homologa", accountPrefixes: ["71"], param: null, threshold: 25, minImpact: 2500, severity: "aviso", enabled: true },
  { name: "72 Prestações de serviços fora do padrão (homóloga)", type: "variacao", method: "homologa", accountPrefixes: ["72"], param: null, threshold: 25, minImpact: 2500, severity: "aviso", enabled: true },
  { name: "21 Clientes: dias de recebimento", type: "variacao", method: "dias_recebimento", accountPrefixes: ["21"], param: null, threshold: 15, minImpact: 5000, severity: "aviso", enabled: true },
  { name: "22 Fornecedores: dias de pagamento", type: "variacao", method: "dias_pagamento", accountPrefixes: ["22"], param: null, threshold: 15, minImpact: 5000, severity: "aviso", enabled: true },
  { name: "IVA liquidado fora de 4% a 25% das vendas", type: "racio", accountPrefixes: ["2433"], param: "71,72", threshold: 25, severity: "aviso", enabled: true },
];

const OLD_PERCENT_ONLY = ["FSE variam mais de 30% face ao período anterior", "Gastos com pessoal variam mais de 25%", "Vendas e serviços variam mais de 40%", "Saldo de clientes acima de 60% das vendas do período"];

export function seedDefaultRules(db: Db): void {
  // Remove the first-generation percentage-only rules (they violate the dual condition) and add missing defaults by name.
  db.prepare(`DELETE FROM balance_rules WHERE company_id IS NULL AND name IN (${OLD_PERCENT_ONLY.map(() => "?").join(",")})`).run(...OLD_PERCENT_ONLY);
  const ins = db.prepare(
    "INSERT INTO balance_rules (company_id, name, type, account_prefixes, param, threshold, severity, enabled, method, min_impact) VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
  );
  for (const r of DEFAULT_RULES) {
    if (db.prepare("SELECT 1 FROM balance_rules WHERE company_id IS NULL AND cae_prefix IS NULL AND name = ?").get(r.name)) continue;
    ins.run(r.name, r.type, r.accountPrefixes.join(","), r.param, r.threshold, r.severity, r.method ?? null, r.minImpact ?? null);
  }
}

function mapRow(r: any): BalanceRule {
  return {
    id: r.id, companyId: r.company_id, caePrefix: r.cae_prefix ?? null, account: r.account ?? null, name: r.name, type: r.type,
    accountPrefixes: String(r.account_prefixes).split(",").map((s: string) => s.trim()).filter(Boolean),
    param: r.param, threshold: r.threshold, minImpact: r.min_impact ?? null, method: r.method ?? null, severity: r.severity, enabled: r.enabled === 1,
  };
}

/** All rules that apply to a company (global + its sector + its own), before hierarchy resolution. */
export function listRules(db: Db, companyId: number | null): BalanceRule[] {
  const cae = companyId ? String((db.prepare("SELECT cae FROM companies WHERE id = ?").get(companyId) as any)?.cae ?? "").replace(/\D/g, "") : "";
  const rows = db.prepare("SELECT * FROM balance_rules WHERE company_id IS NULL OR company_id = ? ORDER BY company_id IS NOT NULL, id").all(companyId) as any[];
  return rows.map(mapRow).filter((r) => !r.caePrefix || (cae && cae.startsWith(String(r.caePrefix).replace(/\D/g, ""))));
}

/** Hierarchy resolution: for the same family (type + accounts), the most specific level wins (conta > cliente > sector > global). */
export function resolveRules(rules: BalanceRule[]): BalanceRule[] {
  const best = new Map<string, BalanceRule>();
  for (const r of rules) {
    const key = `${r.type}|${r.account ?? r.accountPrefixes.join(",")}`;
    const cur = best.get(key);
    if (!cur || ruleLevel(r) < ruleLevel(cur)) best.set(key, r);
  }
  return [...best.values()];
}

const pct = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? 0 : Infinity) : ((cur - prev) / Math.abs(prev)) * 100);
const fmt = (n: number) => n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; };

export interface HistoryBalance { period: string; lines: BalanceLine[] }

export interface EvaluateOptions {
  /** Previous balances, most recent first (up to 12), for median and homologous references. */
  history?: HistoryBalance[];
  /** Current period (YYYY-MM) to find the homologous month. */
  period?: string;
  /** Multiplier of the minimum impacts (parameter escala_impactos_minimos). */
  impactScale?: number;
  /** Tolerance for structural checks (parameter tolerancia_balancete_eur). */
  balanceTolerance?: number;
}

function reference(rule: BalanceRule, cur: number, current: BalanceLine[], previous: BalanceLine[] | null, opts: EvaluateOptions): { ref: number | null; deviation: number | null; impact: number | null; unit: string; label: string } | null {
  const method: RuleMethod = rule.method ?? "mes_anterior";
  const hist = opts.history ?? [];
  const value = (lines: BalanceLine[]) => Math.abs(sumPrefix(lines, rule.account ? [rule.account] : rule.accountPrefixes));
  const c = Math.abs(cur);
  switch (method) {
    case "mes_anterior": { if (!previous) return null; const ref = value(previous); return { ref, deviation: pct(c, ref), impact: Math.abs(c - ref), unit: "%", label: "mês anterior" }; }
    case "mediana_12m": { const vals = hist.slice(0, 12).map((h) => value(h.lines)); if (vals.length < 3) return null; const ref = median(vals); return { ref, deviation: pct(c, ref), impact: Math.abs(c - ref), unit: "%", label: `mediana de ${vals.length} meses` }; }
    case "homologa": {
      if (!opts.period || opts.period.length !== 7) return null;
      const y = Number(opts.period.slice(0, 4)) - 1; const target = `${y}-${opts.period.slice(5, 7)}`;
      const h = hist.find((x) => x.period === target); if (!h) return null; const ref = value(h.lines);
      return { ref, deviation: pct(c, ref), impact: Math.abs(c - ref), unit: "%", label: `homólogo ${target}` };
    }
    case "pct_vendas": case "pct_pessoal": {
      const denomPrefixes = method === "pct_vendas" ? ["71", "72"] : ["63"];
      const denom = Math.abs(sumPrefix(current, denomPrefixes)); if (denom === 0) return null;
      const ratios = hist.slice(0, 12).map((h) => { const d = Math.abs(sumPrefix(h.lines, denomPrefixes)); return d === 0 ? null : (value(h.lines) / d) * 100; }).filter((v): v is number => v !== null);
      if (ratios.length < 3) return null;
      const refRatio = median(ratios); const ratio = (c / denom) * 100;
      return { ref: refRatio, deviation: ratio - refRatio, impact: Math.abs(c - (refRatio / 100) * denom), unit: "p.p.", label: method === "pct_vendas" ? "% das vendas" : "% dos gastos com pessoal" };
    }
    case "valor_fixo": { const ref = Number(rule.param); if (!isFinite(ref) || ref === 0) return null; return { ref, deviation: pct(c, ref), impact: Math.abs(c - ref), unit: "%", label: "valor esperado" }; }
    case "dias_recebimento": case "dias_pagamento": {
      const base = method === "dias_recebimento" ? Math.abs(sumPrefix(current, ["71", "72"])) : Math.abs(sumPrefix(current, ["31", "61", "62"]));
      if (base === 0 || !previous) return null;
      const prevBase = method === "dias_recebimento" ? Math.abs(sumPrefix(previous, ["71", "72"])) : Math.abs(sumPrefix(previous, ["31", "61", "62"]));
      if (prevBase === 0) return null;
      const days = (c / base) * 365; const prevDays = (value(previous) / prevBase) * 365;
      return { ref: prevDays, deviation: days - prevDays, impact: Math.abs(c - value(previous)), unit: "dias", label: method === "dias_recebimento" ? "prazo médio de recebimento" : "prazo médio de pagamento" };
    }
  }
}

export function evaluateRules(rulesIn: BalanceRule[], current: BalanceLine[], previous: BalanceLine[] | null, opts: EvaluateOptions = {}): Finding[] {
  const out: Finding[] = [];
  const rules = resolveRules(rulesIn.filter((r) => r.enabled));
  const scale = opts.impactScale ?? 1;
  for (const rule of rules) {
    const cur = sumPrefix(current, rule.account ? [rule.account] : rule.accountPrefixes);
    const prefixes = rule.account ?? rule.accountPrefixes.join(", ");
    switch (rule.type) {
      case "saldo_sinal": {
        if (rule.param === "devedor" && cur < -0.005) {
          out.push({ code: "SALDO_INVERTIDO", severity: rule.severity, message: `${rule.name}: contas ${prefixes} apresentam saldo credor de ${fmt(-cur)}.`, detail: { rule: rule.name, balance: cur } });
        } else if (rule.param === "credor" && cur > 0.005) {
          out.push({ code: "SALDO_INVERTIDO", severity: rule.severity, message: `${rule.name}: contas ${prefixes} apresentam saldo devedor de ${fmt(cur)}.`, detail: { rule: rule.name, balance: cur } });
        }
        break;
      }
      case "variacao": case "variacao_percentual": case "variacao_absoluta": {
        if (rule.threshold === null) break;
        const r = reference(rule, cur, current, previous, opts);
        if (!r || r.deviation === null || r.impact === null) break;
        // Dual condition: relative deviation AND absolute impact must both exceed their thresholds.
        const minImpact = (rule.minImpact ?? (rule.type === "variacao_absoluta" ? rule.threshold : 0)) * scale;
        const relOk = rule.type === "variacao_absoluta" ? true : Math.abs(r.deviation) > rule.threshold;
        if (relOk && r.impact >= minImpact && r.impact > 0) {
          const dev = r.unit === "%" ? `${r.deviation > 0 ? "+" : ""}${r.deviation.toFixed(1)}%` : r.unit === "p.p." ? `${r.deviation > 0 ? "+" : ""}${r.deviation.toFixed(1)} p.p.` : `${r.deviation > 0 ? "+" : ""}${r.deviation.toFixed(0)} dias`;
          out.push({ code: "VARIACAO_ANOMALA", severity: rule.severity, message: `${rule.name}: ${prefixes} em ${fmt(Math.abs(cur))}, ${dev} face a ${r.label} (impacto ${fmt(r.impact)}).`, detail: { rule: rule.name, method: rule.method ?? "mes_anterior", reference: r.ref, current: cur, deviation: r.deviation, impact: r.impact, threshold: rule.threshold, minImpact } });
        }
        break;
      }
      case "saldo_maximo": {
        if (rule.threshold !== null && Math.abs(cur) > rule.threshold) {
          out.push({ code: "SALDO_FORA_DO_PADRAO", severity: rule.severity, message: `${rule.name}: saldo ${fmt(Math.abs(cur))} acima do máximo ${fmt(rule.threshold)}.`, detail: { rule: rule.name, current: cur } });
        }
        break;
      }
      case "saldo_minimo": {
        if (rule.threshold !== null && Math.abs(cur) < rule.threshold) {
          out.push({ code: "SALDO_FORA_DO_PADRAO", severity: rule.severity, message: `${rule.name}: saldo ${fmt(Math.abs(cur))} abaixo do mínimo ${fmt(rule.threshold)}.`, detail: { rule: rule.name, current: cur } });
        }
        break;
      }
      case "racio": {
        if (rule.threshold === null || !rule.param) break;
        const denom = Math.abs(sumPrefix(current, rule.param.split(",").map((s) => s.trim())));
        if (denom === 0) break;
        const ratio = (Math.abs(cur) / denom) * 100;
        const lowBand = rule.accountPrefixes.includes("2433") ? 4 : null;
        if (ratio > rule.threshold || (lowBand !== null && ratio < lowBand)) {
          out.push({ code: "RACIO_FORA_DO_PADRAO", severity: rule.severity, message: `${rule.name}: rácio actual ${ratio.toFixed(1)}%.`, detail: { rule: rule.name, ratio } });
        }
        break;
      }
    }
  }

  // B1.01 estrutural: balancete equilibrado (tolerância versionada).
  const tol = opts.balanceTolerance ?? 0.01;
  const totalD = current.reduce((s, l) => s + l.debit, 0);
  const totalC = current.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalD - totalC) > tol + 0.0001) {
    out.unshift({ code: "BALANCETE_DESEQUILIBRADO", severity: "erro", message: `Total de débitos (${fmt(totalD)}) difere do total de créditos (${fmt(totalC)}).`, detail: { rule: "B1.01", totalD, totalC } });
  }
  // B1.03 estrutural: soma das subcontas igual ao saldo da agregadora (quando o balancete traz ambas).
  for (const f of subaccountMismatches(current, tol)) out.push(f);

  const fin = computeFinancials(current);
  if (fin.vendas > 0 && fin.ebitda < 0) {
    out.push({ code: "EBITDA_NEGATIVO", severity: "aviso", message: `EBITDA negativo (${fmt(fin.ebitda)}) com vendas de ${fmt(fin.vendas)}.`, detail: { rule: "EBITDA", ebitda: fin.ebitda } });
  }
  return out;
}

/** B1.03: for each account that has direct children in the balance, their balances must add up to the parent's. */
export function subaccountMismatches(lines: BalanceLine[], tol = 0.01): Finding[] {
  const out: Finding[] = [];
  const byAcc = new Map(lines.map((l) => [l.account, l]));
  const accounts = [...byAcc.keys()].sort();
  for (const acc of accounts) {
    const children = accounts.filter((a) => a !== acc && a.startsWith(acc) && !accounts.some((m) => m !== acc && m !== a && a.startsWith(m) && m.startsWith(acc)));
    if (!children.length) continue;
    const sum = children.reduce((s, a) => s + byAcc.get(a)!.balance, 0);
    const parent = byAcc.get(acc)!.balance;
    if (Math.abs(sum - parent) > tol + 0.0001) {
      out.push({ code: "SUBCONTAS_INCOERENTES", severity: "erro", message: `Conta ${acc}: soma das subcontas (${fmt(sum)}) difere do saldo da agregadora (${fmt(parent)}).`, detail: { rule: "B1.03", account: acc, parent, sum } });
    }
  }
  return out;
}

/** Loads up to `months` previous monthly balances of a company, most recent first. */
export function loadHistory(db: Db, companyId: number, period: string, months = 13): HistoryBalance[] {
  const rows = db.prepare("SELECT id, period FROM trial_balances WHERE company_id = ? AND period < ? AND length(period) = length(?) ORDER BY period DESC LIMIT ?").all(companyId, period, period, months) as any[];
  return rows.map((r) => ({ period: r.period, lines: db.prepare("SELECT account, description, debit, credit, balance FROM trial_balance_lines WHERE trial_balance_id = ? ORDER BY account").all(r.id) as BalanceLine[] }));
}

/** Convenience: evaluate a stored balance with history, versioned tolerances and impact scale. */
export function checkBalance(db: Db, companyId: number, period: string, current: BalanceLine[]): { findings: Finding[]; previousPeriod: string | null } {
  const history = loadHistory(db, companyId, period);
  const previous = history[0] ?? null;
  const date = period.length === 7 ? period + "-28" : period + "-12-31";
  const findings = evaluateRules(listRules(db, companyId), current, previous?.lines ?? null, {
    history, period, impactScale: numberAt(db, "escala_impactos_minimos", date, 1).value, balanceTolerance: numberAt(db, "tolerancia_balancete_eur", date, 0.01).value,
  });
  return { findings, previousPeriod: previous?.period ?? null };
}

const VARIATION_CODES = new Set(["VARIACAO_ANOMALA", "RACIO_FORA_DO_PADRAO", "SALDO_FORA_DO_PADRAO", "EBITDA_NEGATIVO"]);

/** True while the company is in its learning period (default 6 months after creation; overridable per company). */
export function inLearningPeriod(db: Db, companyId: number, period: string): boolean {
  const c = db.prepare("SELECT created_at, learning_until FROM companies WHERE id = ?").get(companyId) as any;
  if (!c) return false;
  const date = period.length === 7 ? period + "-28" : period + "-12-31";
  if (c.learning_until) return date <= c.learning_until;
  const months = numberAt(db, "periodo_aprendizagem_meses", date, 6).value;
  const start = new Date(String(c.created_at).replace(" ", "T") + "Z");
  const until = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate())).toISOString().slice(0, 10);
  return date <= until;
}

export function persistBalanceFindings(db: Db, companyId: number, period: string, findings: Finding[]): void {
  const learning = inLearningPeriod(db, companyId, period);
  persistFindings(db, { companyId, scope: "balancete", period, findings, learningCodes: learning ? VARIATION_CODES : undefined });
}
