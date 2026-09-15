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

export type Light = "verde" | "amarelo" | "vermelho" | "cinzento";
export interface TrafficLight { key: string; label: string; value: string; light: Light; note: string }
export interface Recommendation { title: string; text: string; basis: string }
export interface SectorModel { key: string; label: string; indicators: { label: string; value: string; note: string | null }[] }
export interface ReportAlerts { blocking: number; alerts: number; info: number; items: { code: string; severity: string; message: string }[]; obligations: { code: string; label: string; dueDate: string }[] }

/** The ten blocks of the common structure; 1, 3, 8, 9 and 10 are always present. */
export const REPORT_BLOCKS: { id: string; label: string; fixed: boolean }[] = [
  { id: "capa", label: "Capa", fixed: true },
  { id: "semaforo", label: "Semáforo de saúde (6 indicadores)", fixed: false },
  { id: "memoria", label: "Memória descritiva", fixed: true },
  { id: "actividade", label: "Actividade: vendas, margem e resultado", fixed: false },
  { id: "gastos", label: "Estrutura de gastos", fixed: false },
  { id: "tesouraria", label: "Tesouraria e prazos médios", fixed: false },
  { id: "sector", label: "Posição face ao sector", fixed: false },
  { id: "alertas", label: "Alertas fiscais e obrigações do período seguinte", fixed: true },
  { id: "recomendacoes", label: "Três recomendações", fixed: true },
  { id: "metodologia", label: "Anexo metodológico", fixed: true },
];

/** Six sector models from the specification, by CAE division ranges. */
export const SECTOR_MODELS: { key: string; label: string; divisions: [number, number][] }[] = [
  { key: "comercio", label: "Comércio e retalho", divisions: [[45, 47]] },
  { key: "servicos", label: "Serviços profissionais", divisions: [[69, 74]] },
  { key: "industria", label: "Indústria e produção", divisions: [[10, 33]] },
  { key: "construcao", label: "Construção e imobiliário", divisions: [[41, 43], [68, 68]] },
  { key: "restauracao", label: "Restauração e hotelaria", divisions: [[55, 56]] },
  { key: "saude", label: "Saúde e clínicas", divisions: [[86, 87]] },
];

export function sectorModelFor(cae: string | null | undefined): { key: string; label: string } {
  const div = Number(String(cae ?? "").replace(/\D/g, "").slice(0, 2));
  for (const m of SECTOR_MODELS) if (m.divisions.some(([a, b]) => div >= a && div <= b)) return { key: m.key, label: m.label };
  return { key: "generico", label: "Modelo genérico" };
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
  trafficLights?: TrafficLight[];
  recommendations?: Recommendation[];
  sectorModel?: SectorModel;
  alerts?: ReportAlerts;
  sections?: string[];
  inventory?: number;
  benchmark?: { version: string; lastVerified: string; source: string; disclaimer: string } | null;
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

const pctStr = (n: number | null) => (n === null ? "n.d." : `${n.toFixed(1)}%`);

/** Block 2: six traffic lights. Thresholds are business-sense defaults; sector verdicts refine them. */
export function computeTrafficLights(f: Financials, p: Financials | null, ratios: RatioComparison[]): TrafficLight[] {
  const r = (k: string) => ratios.find((x) => x.key === k);
  const bySector = (k: string, fallback: Light): Light => { const v = r(k)?.verdict; return v === "melhor" ? "verde" : v === "pior" ? "vermelho" : v === "em_linha" ? "amarelo" : fallback; };
  const vVendas = p && p.vendas ? ((f.vendas - p.vendas) / Math.abs(p.vendas)) * 100 : null;
  const margem = f.vendas ? (f.ebitda / f.vendas) * 100 : null;
  const af = r("autonomia_financeira")?.company ?? null;
  const liq = r("liquidez_geral")?.company ?? null;
  const pmr = r("prazo_medio_recebimento")?.company ?? null;
  return [
    { key: "vendas", label: "Evolução das vendas", value: vVendas === null ? "sem período anterior" : `${vVendas > 0 ? "+" : ""}${vVendas.toFixed(1)}%`, light: vVendas === null ? "cinzento" : vVendas >= 0 ? "verde" : vVendas > -10 ? "amarelo" : "vermelho", note: "Face ao período anterior." },
    { key: "margem", label: "Margem EBITDA", value: pctStr(margem), light: margem === null ? "cinzento" : r("margem_ebitda")?.sector != null ? bySector("margem_ebitda", "amarelo") : margem >= 10 ? "verde" : margem >= 0 ? "amarelo" : "vermelho", note: "O que sobra das vendas depois dos gastos operacionais." },
    { key: "resultado", label: "Resultado líquido", value: eur(f.resultadoLiquido), light: f.resultadoLiquido > 0 ? "verde" : f.resultadoLiquido === 0 ? "amarelo" : "vermelho", note: "Lucro ou prejuízo do período." },
    { key: "autonomia", label: "Autonomia financeira", value: pctStr(af), light: af === null ? "cinzento" : af >= 35 ? "verde" : af >= 20 ? "amarelo" : "vermelho", note: "Parte do activo financiada por capitais próprios." },
    { key: "liquidez", label: "Liquidez", value: liq === null ? "n.d." : `${liq.toFixed(1)}x`, light: liq === null ? "cinzento" : liq >= 1.2 ? "verde" : liq >= 1 ? "amarelo" : "vermelho", note: "Capacidade de pagar as dívidas de curto prazo." },
    { key: "recebimentos", label: "Prazo médio de recebimento", value: pmr === null ? "n.d." : `${pmr} dias`, light: pmr === null ? "cinzento" : r("prazo_medio_recebimento")?.sector != null ? bySector("prazo_medio_recebimento", "amarelo") : pmr <= 45 ? "verde" : pmr <= 90 ? "amarelo" : "vermelho", note: "Dias que os clientes demoram a pagar." },
  ];
}

/** Block 9: three concrete recommendations in business language, each traceable to an indicator. Editable by the accountant. */
export function computeRecommendations(f: Financials, p: Financials | null, ratios: RatioComparison[], lights: TrafficLight[]): Recommendation[] {
  const out: Recommendation[] = [];
  const r = (k: string) => ratios.find((x) => x.key === k);
  const light = (k: string) => lights.find((l) => l.key === k)!;
  if (light("recebimentos").light === "vermelho") out.push({ title: "Encurtar o prazo de recebimento", text: `Os clientes demoram em média ${light("recebimentos").value} a pagar. Reveja as condições de pagamento dos maiores clientes e automatize lembretes na semana anterior ao vencimento.`, basis: "prazo médio de recebimento" });
  const pp = r("peso_pessoal"); if (pp?.verdict === "pior" && pp.company !== null) out.push({ title: "Rever a produtividade da equipa", text: `Os gastos com pessoal pesam ${pctStr(pp.company)} das vendas, acima do sector (${pctStr(pp.sector)}). Analise horas extra, escalas e se há tarefas que podem ser automatizadas.`, basis: "gastos com pessoal / vendas" });
  const fse = r("peso_fse"); if (fse?.verdict === "pior" && fse.company !== null) out.push({ title: "Renegociar fornecimentos e serviços", text: `Os fornecimentos e serviços externos representam ${pctStr(fse.company)} das vendas, acima da referência (${pctStr(fse.sector)}). Compare as três maiores rubricas com propostas alternativas.`, basis: "FSE / vendas" });
  const cm = r("peso_cmvmc"); if (cm?.verdict === "pior" && cm.company !== null) out.push({ title: "Melhorar a margem sobre as mercadorias", text: `O custo das mercadorias absorve ${pctStr(cm.company)} das vendas face a ${pctStr(cm.sector)} no sector. Reveja preços de venda, condições de compra e quebras.`, basis: "CMVMC / vendas" });
  if (light("autonomia").light === "vermelho") out.push({ title: "Reforçar os capitais próprios", text: `A autonomia financeira é de ${light("autonomia").value}. Considere reter resultados, converter suprimentos em capital ou reduzir dívida de curto prazo.`, basis: "autonomia financeira" });
  if (light("liquidez").light !== "verde" && light("liquidez").light !== "cinzento") out.push({ title: "Proteger a tesouraria", text: `A liquidez de ${light("liquidez").value} deixa pouca folga para pagar compromissos de curto prazo. Prepare uma previsão de tesouraria a 13 semanas.`, basis: "liquidez geral" });
  if (light("vendas").light === "vermelho") out.push({ title: "Recuperar o volume de vendas", text: `As vendas caíram ${light("vendas").value} face ao período anterior. Identifique os clientes e produtos com maior queda e defina um plano comercial para o trimestre.`, basis: "evolução das vendas" });
  if (p && f.ebitda > 0 && p.ebitda > 0 && f.ebitda > p.ebitda) out.push({ title: "Consolidar o crescimento do EBITDA", text: `O EBITDA subiu de ${eur(p.ebitda)} para ${eur(f.ebitda)}. Mantenha a disciplina de custos e considere investir parte da margem em capacidade ou digitalização.`, basis: "EBITDA" });
  out.push({ title: "Enviar os documentos ao longo do mês", text: "Documentos entregues à medida que chegam permitem conferência contínua e um fecho mais rápido, com menos correcções no fim do período.", basis: "processo" });
  out.push({ title: "Acompanhar o painel mensalmente", text: "Reveja os seis semáforos todos os meses com o gabinete; a tendência importa mais do que o valor isolado.", basis: "processo" });
  return out.slice(0, 3);
}

/** Block 7 variant: indicators of the sector model, computed where the balance allows; otherwise marked as requiring extra data. */
export function computeSectorModel(cae: string | null | undefined, f: Financials, inventory: number): SectorModel {
  const m = sectorModelFor(cae);
  const nd = (label: string, why: string) => ({ label, value: "n.d.", note: why });
  const pc = (num: number, den: number) => (den ? `${((num / den) * 100).toFixed(1)}%` : "n.d.");
  const margemBruta = { label: "Margem bruta", value: pc(f.vendas - f.cmvmc, f.vendas), note: null as string | null };
  const pesoPessoal = { label: "Peso do pessoal nas vendas", value: pc(f.pessoal, f.vendas), note: null as string | null };
  const pmr = { label: "Prazo médio de recebimento", value: f.vendas ? `${Math.round((f.clientes / f.vendas) * 365)} dias` : "n.d.", note: null as string | null };
  switch (m.key) {
    case "comercio": return { ...m, indicators: [margemBruta, { label: "Rotação de inventário", value: inventory > 0 ? `${(f.cmvmc / inventory).toFixed(1)}x` : "n.d.", note: inventory > 0 ? null : "requer saldo de inventários (classe 3) no balancete" }, nd("Vendas por m²", "requer área de venda (dado adicional)"), nd("Ruptura de stock", "requer dados do sistema de gestão de stocks")] };
    case "servicos": return { ...m, indicators: [nd("Receita por colaborador", "requer número de colaboradores (módulo de salários)"), nd("Taxa de utilização", "requer registo de horas"), pesoPessoal, nd("Concentração de clientes", "requer vendas por cliente (SAF-T de facturação)")] };
    case "industria": return { ...m, indicators: [{ label: "Peso das matérias", value: pc(f.cmvmc, f.vendas), note: null }, { label: "Custo de transformação (FSE + pessoal / vendas)", value: pc(f.fse + f.pessoal, f.vendas), note: null }, nd("Energia por unidade", "requer consumos e unidades produzidas"), nd("Produtividade", "requer unidades produzidas e horas")] };
    case "construcao": return { ...m, indicators: [nd("Margem por obra", "requer centros de custo por obra (activos na app)"), { label: "Obra em curso (inventários)", value: inventory > 0 ? eur(inventory) : "n.d.", note: inventory > 0 ? null : "requer classe 3 no balancete" }, pmr, nd("Garantias retidas", "requer contas de retenções de garantia")] };
    case "restauracao": return { ...m, indicators: [{ label: "Custo de mercadoria sobre vendas", value: pc(f.cmvmc, f.vendas), note: null }, pesoPessoal, nd("Ticket médio", "requer número de refeições (SAF-T de facturação)"), nd("Sazonalidade", "requer 12 meses de balancetes")] };
    case "saude": return { ...m, indicators: [nd("Receita por profissional", "requer número de profissionais"), { label: "Peso dos consumíveis", value: pc(f.cmvmc, f.vendas), note: null }, nd("Mix convenções vs privados", "requer vendas por tipo de cliente"), nd("Ocupação", "requer agenda clínica")] };
    default: return { ...m, indicators: [margemBruta, pesoPessoal, pmr, { label: "FSE nas vendas", value: pc(f.fse, f.vendas), note: null }] };
  }
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
  const inventory = Math.abs(tb.lines.filter((l) => /^3/.test(l.account) && l.account.length <= 2).reduce((s, l) => s + l.balance, 0)) || Math.abs(tb.lines.filter((l) => /^3/.test(l.account)).reduce((s, l) => s + l.balance, 0));
  const trafficLights = computeTrafficLights(financials, previousFinancials, ratios);
  const recommendations = computeRecommendations(financials, previousFinancials, ratios, trafficLights);
  const sectorModel = computeSectorModel(company.cae, financials, inventory);
  // Block 8: open alerts of the company and obligations of the next 60 days (modules A and B feed the report).
  const open = db.prepare("SELECT code, severity, message FROM findings WHERE company_id = ? AND status IN ('aberto','em_analise','reaberto') AND learning = 0 ORDER BY CASE severity WHEN 'erro' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END LIMIT 12").all(companyId) as any[];
  const counts = db.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE company_id = ? AND status IN ('aberto','em_analise','reaberto') AND learning = 0 GROUP BY severity").all(companyId) as any[];
  const n = (sev: string) => counts.find((c) => c.severity === sev)?.n ?? 0;
  const from = period.length === 7 ? `${period}-28` : `${period}-12-31`;
  const obligationsRows = db.prepare("SELECT code, label, due_date FROM obligations WHERE company_id = ? AND status = 'por_cumprir' AND due_date >= ? ORDER BY due_date LIMIT 8").all(companyId, from) as any[];
  const alerts: ReportAlerts = { blocking: n("erro"), alerts: n("aviso"), info: n("info"), items: open, obligations: obligationsRows.map((o) => ({ code: o.code, label: o.label, dueDate: o.due_date })) };
  return { ...base, summary, narrative, generatedAt: new Date().toISOString(), trafficLights, recommendations, sectorModel, alerts, inventory, sections: REPORT_BLOCKS.map((b) => b.id), benchmark: { version: bench.version, lastVerified: bench.last_verified, source: bench.source, disclaimer: bench.disclaimer } };
}
