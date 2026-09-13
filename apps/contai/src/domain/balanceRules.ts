/**
 * Padrões de conferência de balancetes. Each rule is data (stored per firm or
 * per company) so the accountant can tune thresholds in the configuration
 * area without code changes. The engine compares the current balancete with
 * the previous period and emits findings.
 */
import { Db } from "../db.js";
import { BalanceLine, sumPrefix, computeFinancials } from "./trialBalance.js";
import { Finding } from "./vatAudit.js";

export type RuleType = "saldo_sinal" | "variacao_percentual" | "variacao_absoluta" | "saldo_maximo" | "saldo_minimo" | "racio";

export interface BalanceRule {
  id?: number;
  companyId: number | null; // null = regra global do gabinete
  name: string;
  type: RuleType;
  accountPrefixes: string[];
  /** saldo_sinal: 'devedor' | 'credor'; racio: prefixes of the denominator. */
  param: string | null;
  threshold: number | null;
  severity: "info" | "aviso" | "erro";
  enabled: boolean;
}

export const DEFAULT_RULES: Omit<BalanceRule, "id" | "companyId">[] = [
  { name: "Caixa e bancos não podem ficar credores", type: "saldo_sinal", accountPrefixes: ["11", "12"], param: "devedor", threshold: null, severity: "erro", enabled: true },
  { name: "Fornecedores devem ficar credores", type: "saldo_sinal", accountPrefixes: ["221"], param: "credor", threshold: null, severity: "aviso", enabled: true },
  { name: "Clientes devem ficar devedores", type: "saldo_sinal", accountPrefixes: ["211"], param: "devedor", threshold: null, severity: "aviso", enabled: true },
  { name: "IVA dedutível deve ficar devedor", type: "saldo_sinal", accountPrefixes: ["2432"], param: "devedor", threshold: null, severity: "aviso", enabled: true },
  { name: "IVA liquidado deve ficar credor", type: "saldo_sinal", accountPrefixes: ["2433"], param: "credor", threshold: null, severity: "aviso", enabled: true },
  { name: "FSE variam mais de 30% face ao período anterior", type: "variacao_percentual", accountPrefixes: ["62"], param: null, threshold: 30, severity: "aviso", enabled: true },
  { name: "Gastos com pessoal variam mais de 25%", type: "variacao_percentual", accountPrefixes: ["63"], param: null, threshold: 25, severity: "aviso", enabled: true },
  { name: "Vendas e serviços variam mais de 40%", type: "variacao_percentual", accountPrefixes: ["71", "72"], param: null, threshold: 40, severity: "aviso", enabled: true },
  { name: "IVA liquidado fora de 4% a 25% das vendas", type: "racio", accountPrefixes: ["2433"], param: "71,72", threshold: 25, severity: "aviso", enabled: true },
  { name: "Saldo de clientes acima de 60% das vendas do período", type: "racio", accountPrefixes: ["211"], param: "71,72", threshold: 60, severity: "info", enabled: true },
];

export function seedDefaultRules(db: Db): void {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM balance_rules WHERE company_id IS NULL").get() as any).n;
  if (n > 0) return;
  const ins = db.prepare(
    "INSERT INTO balance_rules (company_id, name, type, account_prefixes, param, threshold, severity, enabled) VALUES (NULL, ?, ?, ?, ?, ?, ?, 1)"
  );
  for (const r of DEFAULT_RULES) ins.run(r.name, r.type, r.accountPrefixes.join(","), r.param, r.threshold, r.severity);
}

export function listRules(db: Db, companyId: number | null): BalanceRule[] {
  const rows = db
    .prepare("SELECT * FROM balance_rules WHERE company_id IS NULL OR company_id = ? ORDER BY company_id IS NOT NULL, id")
    .all(companyId) as any[];
  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    type: r.type,
    accountPrefixes: String(r.account_prefixes).split(",").map((s: string) => s.trim()).filter(Boolean),
    param: r.param,
    threshold: r.threshold,
    severity: r.severity,
    enabled: r.enabled === 1,
  }));
}

const pct = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? 0 : Infinity) : ((cur - prev) / Math.abs(prev)) * 100);
const fmt = (n: number) => n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

export function evaluateRules(rules: BalanceRule[], current: BalanceLine[], previous: BalanceLine[] | null): Finding[] {
  const out: Finding[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const cur = sumPrefix(current, rule.accountPrefixes);
    const prefixes = rule.accountPrefixes.join(", ");
    switch (rule.type) {
      case "saldo_sinal": {
        if (rule.param === "devedor" && cur < -0.005) {
          out.push({ code: "SALDO_INVERTIDO", severity: rule.severity, message: `${rule.name}: contas ${prefixes} apresentam saldo credor de ${fmt(-cur)}.`, detail: { rule: rule.name, balance: cur } });
        } else if (rule.param === "credor" && cur > 0.005) {
          out.push({ code: "SALDO_INVERTIDO", severity: rule.severity, message: `${rule.name}: contas ${prefixes} apresentam saldo devedor de ${fmt(cur)}.`, detail: { rule: rule.name, balance: cur } });
        }
        break;
      }
      case "variacao_percentual": {
        if (!previous || rule.threshold === null) break;
        const prev = sumPrefix(previous, rule.accountPrefixes);
        const p = pct(Math.abs(cur), Math.abs(prev));
        if (Math.abs(prev) > 0 && Math.abs(p) > rule.threshold) {
          out.push({ code: "VARIACAO_ANOMALA", severity: rule.severity, message: `${rule.name}: ${prefixes} passou de ${fmt(Math.abs(prev))} para ${fmt(Math.abs(cur))} (${p > 0 ? "+" : ""}${p.toFixed(1)}%).`, detail: { rule: rule.name, previous: prev, current: cur, pct: p } });
        }
        break;
      }
      case "variacao_absoluta": {
        if (!previous || rule.threshold === null) break;
        const prev = sumPrefix(previous, rule.accountPrefixes);
        const d = Math.abs(cur) - Math.abs(prev);
        if (Math.abs(d) > rule.threshold) {
          out.push({ code: "VARIACAO_ANOMALA", severity: rule.severity, message: `${rule.name}: variação de ${fmt(d)} em ${prefixes}.`, detail: { rule: rule.name, previous: prev, current: cur } });
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

  // Sanity check universal: balancete deve estar equilibrado.
  const totalD = current.reduce((s, l) => s + l.debit, 0);
  const totalC = current.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalD - totalC) > 0.05) {
    out.unshift({ code: "BALANCETE_DESEQUILIBRADO", severity: "erro", message: `Total de débitos (${fmt(totalD)}) difere do total de créditos (${fmt(totalC)}).`, detail: { totalD, totalC } });
  }

  const fin = computeFinancials(current);
  if (fin.vendas > 0 && fin.ebitda < 0) {
    out.push({ code: "EBITDA_NEGATIVO", severity: "aviso", message: `EBITDA negativo (${fmt(fin.ebitda)}) com vendas de ${fmt(fin.vendas)}.`, detail: { ebitda: fin.ebitda } });
  }
  return out;
}

export function persistBalanceFindings(db: Db, companyId: number, period: string, findings: Finding[]): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM findings WHERE company_id = ? AND scope = 'balancete' AND period = ? AND status = 'aberto'").run(companyId, period);
    const ins = db.prepare(
      "INSERT INTO findings (company_id, scope, period, code, severity, message, detail_json) VALUES (?, 'balancete', ?, ?, ?, ?, ?)"
    );
    for (const f of findings) ins.run(companyId, period, f.code, f.severity, f.message, f.detail ? JSON.stringify(f.detail) : null);
  });
  tx();
}
