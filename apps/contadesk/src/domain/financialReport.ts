/**
 * Relatórios financeiros para clientes: KPIs, rácios, comparação com o
 * sector de actividade e memória descritiva. Deterministic by default; the
 * AI gateway may polish the narrative but never changes the numbers.
 */
import { Db } from "../db.js";
import { BalanceLine, computeFinancials, Financials, loadTrialBalance, previousPeriod } from "./trialBalance.js";
import { loadSectorBenchmarks, sectorForCae, SectorBenchmark } from "../knowledge/index.js";

export interface RatioComparison {
  key: string;
  label: string;
  unit: "%" | "x" | "dias";
  company: number | null;
  sector: number | null;
  /** 'melhor' when the company beats the sector in the ratio's favourable direction. */
  verdict: "melhor" | "pior" | "em_linha" | "sem_dados";
  higherIsBetter: boolean;
}

export interface ReportData {
  companyName: string;
  nif: string;
  cae: string | null;
  period: string;
  previousPeriod: string | null;
  template: string;
  sector: { key: string; label: string; source: string; disclaimer: string } | null;
  financials: Financials;
  previousFinancials: Financials | null;
  ratios: RatioComparison[];
  costStructure: { label: string; value: number }[];
  summary: string;
  narrative: string[];
  generatedAt: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number) => (den === 0 ? null : round1((num / den) * 100));

export function computeRatios(f: Financials, sector: SectorBenchmark | null): RatioComparison[] {
  const defs: { key: string; label: string; unit: "%" | "x" | "dias"; value: number | null; higherIsBetter: boolean }[] = [
    { key: "margem_ebitda", label: "Margem EBITDA", unit: "%", value: pct(f.ebitda, f.vendas), higherIsBetter: true },
    { key: "margem_liquida", label: "Margem líquida", unit: "%", value: pct(f.resultadoLiquido, f.vendas), higherIsBetter: true },
    { key: "autonomia_financeira", label: "Autonomia financeira", unit: "%", value: pct(f.capitalProprio, f.activo), higherIsBetter: true },
    { key: "liquidez_geral", label: "Liquidez geral", unit: "x", value: f.passivo === 0 ? null : round1((f.disponibilidades + f.clientes) / f.passivo * 10) / 10, higherIsBetter: true },
    { key: "peso_pessoal", label: "Gastos com pessoal / vendas", unit: "%", value: pct(f.pessoal, f.vendas), higherIsBetter: false },
    { key: "peso_fse", label: "FSE / vendas", unit: "%", value: pct(f.fse, f.vendas), higherIsBetter: false },
    { key: "peso_cmvmc", label: "CMVMC / vendas", unit: "%", value: pct(f.cmvmc, f.vendas), higherIsBetter: false },
    { key: "prazo_medio_recebimento", label: "Prazo médio de recebimento", unit: "dias", value: f.vendas === 0 ? null : Math.round((f.clientes / f.vendas) * 365), higherIsBetter: false },
  ];
  return defs.map((d) => {
    const s = sector?.ratios[d.key] ?? null;
    let verdict: RatioComparison["verdict"] = "sem_dados";
    if (d.value !== null && s !== null) {
      const tol = Math.abs(s) * 0.1;
      if (Math.abs(d.value - s) <= tol) verdict = "em_linha";
      else verdict = (d.value > s) === d.higherIsBetter ? "melhor" : "pior";
    }
    return { key: d.key, label: d.label, unit: d.unit, company: d.value, sector: s, verdict, higherIsBetter: d.higherIsBetter };
  });
}

const eur = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const fmtRatio = (r: RatioComparison, v: number | null) => (v === null ? "n.d." : r.unit === "x" ? `${v.toFixed(1)}x` : r.unit === "dias" ? `${v} dias` : `${v.toFixed(1)}%`);

/** Deterministic memória descritiva in European Portuguese. */
export function buildNarrative(d: Omit<ReportData, "summary" | "narrative" | "generatedAt">): { summary: string; narrative: string[] } {
  const f = d.financials;
  const p = d.previousFinancials;
  const parts: string[] = [];

  const var_ = (cur: number, prev: number | undefined) =>
    prev === undefined || prev === 0 ? null : round1(((cur - prev) / Math.abs(prev)) * 100);

  const vVendas = p ? var_(f.vendas, p.vendas) : null;
  parts.push(
    `No período ${d.period}, a ${d.companyName} registou vendas e prestações de serviços de ${eur(f.vendas)}` +
      (vVendas !== null ? `, o que representa uma variação de ${vVendas > 0 ? "+" : ""}${vVendas}% face a ${d.previousPeriod}.` : ".") +
      ` O EBITDA situou-se em ${eur(f.ebitda)} e o resultado líquido em ${eur(f.resultadoLiquido)}.`
  );

  const costs = d.costStructure.filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
  if (costs.length > 0 && f.vendas > 0) {
    const top = costs[0]!;
    const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
    parts.push(
      `A estrutura de gastos é dominada por ${lc(top.label)} (${eur(top.value)}, ${round1((top.value / f.vendas) * 100)}% das vendas)` +
        (costs[1] ? `, seguida de ${lc(costs[1].label)} (${round1((costs[1].value / f.vendas) * 100)}%).` : ".")
    );
  }

  if (d.sector) {
    const melhor = d.ratios.filter((r) => r.verdict === "melhor");
    const pior = d.ratios.filter((r) => r.verdict === "pior");
    let s = `Comparando com o sector "${d.sector.label}", a empresa `;
    const lcr = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
    if (melhor.length > 0) s += `supera a referência sectorial em ${melhor.map((r) => `${lcr(r.label)} (${fmtRatio(r, r.company)} vs ${fmtRatio(r, r.sector)})`).join(", ")}`;
    if (melhor.length > 0 && pior.length > 0) s += " e ";
    if (pior.length > 0) s += `fica abaixo em ${pior.map((r) => `${lcr(r.label)} (${fmtRatio(r, r.company)} vs ${fmtRatio(r, r.sector)})`).join(", ")}`;
    if (melhor.length === 0 && pior.length === 0) s += "está globalmente em linha com as referências sectoriais";
    parts.push(s + ".");
    const bench = loadSectorBenchmarks().sectors.find((x) => x.key === d.sector!.key);
    if (bench) parts.push(bench.narrative);
  } else {
    parts.push("Não foi possível associar a empresa a um sector de referência (CAE em falta); a comparação sectorial não foi efectuada.");
  }

  const af = d.ratios.find((r) => r.key === "autonomia_financeira");
  if (af?.company !== null && af?.company !== undefined) {
    parts.push(
      af.company < 20
        ? `A autonomia financeira de ${af.company}% é baixa e recomenda-se atenção à estrutura de capitais.`
        : af.company > 50
          ? `A autonomia financeira de ${af.company}% traduz uma estrutura de capitais sólida.`
          : `A autonomia financeira de ${af.company}% encontra-se num intervalo prudente.`
    );
  }

  const summary =
    `Vendas ${eur(f.vendas)}` +
    (vVendas !== null ? ` (${vVendas > 0 ? "+" : ""}${vVendas}%)` : "") +
    `, EBITDA ${eur(f.ebitda)}, resultado líquido ${eur(f.resultadoLiquido)}` +
    (d.sector ? `; ${d.ratios.filter((r) => r.verdict === "melhor").length} rácios acima e ${d.ratios.filter((r) => r.verdict === "pior").length} abaixo do sector.` : ".");
  return { summary, narrative: parts };
}

export function buildReportData(db: Db, companyId: number, period: string, lines?: BalanceLine[]): ReportData {
  const company = db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId) as any;
  if (!company) throw new Error("Empresa inexistente.");
  const tb = lines ? { lines } : loadTrialBalance(db, companyId, period);
  if (!tb) throw new Error(`Não existe balancete para ${period}. Importe ou derive o balancete primeiro.`);
  const prevPeriod = previousPeriod(period);
  const prev = loadTrialBalance(db, companyId, prevPeriod);

  const financials = computeFinancials(tb.lines);
  const previousFinancials = prev ? computeFinancials(prev.lines) : null;
  const sector = sectorForCae(company.cae);
  const bench = loadSectorBenchmarks();
  const ratios = computeRatios(financials, sector);
  const costStructure = [
    { label: "Custo das mercadorias (CMVMC)", value: financials.cmvmc },
    { label: "Fornecimentos e serviços externos", value: financials.fse },
    { label: "Gastos com pessoal", value: financials.pessoal },
    { label: "Outros gastos", value: Math.max(0, financials.outrosGastos) },
  ];
  const base = {
    companyName: company.name,
    nif: company.nif,
    cae: company.cae ?? null,
    period,
    previousPeriod: prev ? prevPeriod : null,
    template: sector?.key ?? "generico",
    sector: sector ? { key: sector.key, label: sector.label, source: bench.source, disclaimer: bench.disclaimer } : null,
    financials,
    previousFinancials,
    ratios,
    costStructure,
  };
  const { summary, narrative } = buildNarrative(base);
  return { ...base, summary, narrative, generatedAt: new Date().toISOString() };
}
