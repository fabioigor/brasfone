/**
 * Self-contained HTML rendering of a client financial report: KPI tiles,
 * company-vs-sector grouped bars, cost structure and narrative. Inline SVG
 * only (no external libraries) so the report can be stored, e-mailed or
 * opened offline. Colours follow a validated categorical palette (company =
 * blue, sector = orange) with direct labels so identity is never colour-alone.
 */
import { ReportData, RatioComparison } from "./financialReport.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const eur = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const fmtRatio = (r: RatioComparison, v: number | null) => (v === null ? "n.d." : r.unit === "x" ? `${v.toFixed(1)}x` : r.unit === "dias" ? `${v} d` : `${v.toFixed(1)}%`);

function kpiTile(label: string, value: string, delta: string | null): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${
    delta ? `<div class="tile-delta">${esc(delta)}</div>` : ""
  }</div>`;
}

/** Grouped horizontal bars: company vs sector per ratio, one row per ratio. */
function ratiosChart(ratios: RatioComparison[]): string {
  const rows = ratios.filter((r) => r.company !== null);
  if (rows.length === 0) return `<p class="muted">Sem rácios calculáveis.</p>`;
  const rowH = 46;
  const labelW = 210;
  const width = 720;
  const barMax = width - labelW - 170;
  const height = rows.length * rowH + 30;
  const maxVal = Math.max(...rows.flatMap((r) => [Math.abs(r.company ?? 0), Math.abs(r.sector ?? 0)]), 1);
  const scale = (v: number) => Math.max(2, (Math.abs(v) / maxVal) * barMax);
  let svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Rácios da empresa comparados com o sector">`;
  rows.forEach((r, i) => {
    const y = i * rowH + 8;
    const c = r.company ?? 0;
    const s = r.sector;
    svg += `<text x="0" y="${y + 20}" class="lbl">${esc(r.label)}</text>`;
    svg += `<rect class="bar co" x="${labelW}" y="${y + 4}" width="${scale(c)}" height="12" rx="4"><title>${esc(r.label)} (empresa): ${fmtRatio(r, c)}</title></rect>`;
    svg += `<text x="${labelW + scale(c) + 6}" y="${y + 14}" class="val">${esc(fmtRatio(r, c))}</text>`;
    if (s !== null) {
      svg += `<rect class="bar se" x="${labelW}" y="${y + 20}" width="${scale(s)}" height="12" rx="4"><title>${esc(r.label)} (sector): ${fmtRatio(r, s)}</title></rect>`;
      svg += `<text x="${labelW + scale(s) + 6}" y="${y + 30}" class="val muted">${esc(fmtRatio(r, s))}</text>`;
    }
    const badge = r.verdict === "melhor" ? "▲ acima" : r.verdict === "pior" ? "▼ abaixo" : r.verdict === "em_linha" ? "● em linha" : "";
    if (badge) svg += `<text x="${width - 2}" y="${y + 20}" text-anchor="end" class="verdict ${r.verdict}">${badge}</text>`;
  });
  svg += `</svg>`;
  return `<div class="legend"><span><i class="sw co"></i> Empresa</span><span><i class="sw se"></i> Sector de referência</span></div>${svg}`;
}

/** Horizontal stacked bar: part-to-whole of the cost structure. */
function costChart(parts: { label: string; value: number }[], total: number): string {
  const items = parts.filter((p) => p.value > 0);
  if (items.length === 0 || total <= 0) return `<p class="muted">Sem gastos registados.</p>`;
  const width = 720;
  const classes = ["c1", "c2", "c3", "c4"];
  let x = 0;
  let svg = `<svg class="chart" viewBox="0 0 ${width} 40" role="img" aria-label="Estrutura de gastos">`;
  items.forEach((p, i) => {
    const w = Math.max(0, (p.value / total) * width - 2);
    svg += `<rect class="seg ${classes[i % 4]}" x="${x}" y="8" width="${w}" height="20" rx="3"><title>${esc(p.label)}: ${eur(p.value)} (${((p.value / total) * 100).toFixed(1)}%)</title></rect>`;
    x += w + 2;
  });
  svg += `</svg>`;
  const legend = items
    .map((p, i) => `<span><i class="sw ${classes[i % 4]}"></i> ${esc(p.label)} · ${eur(p.value)} (${((p.value / total) * 100).toFixed(1)}%)</span>`)
    .join("");
  return svg + `<div class="legend col">${legend}</div>`;
}

export function renderReportHtml(d: ReportData): string {
  const f = d.financials;
  const p = d.previousFinancials;
  const delta = (cur: number, prev: number | undefined) =>
    prev === undefined || prev === 0 ? null : `${cur - prev >= 0 ? "+" : ""}${(((cur - prev) / Math.abs(prev)) * 100).toFixed(1)}% vs ${d.previousPeriod}`;
  const totalCosts = d.costStructure.reduce((s, c) => s + c.value, 0);

  const table = d.ratios
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td><td class="num">${esc(fmtRatio(r, r.company))}</td><td class="num">${esc(fmtRatio(r, r.sector))}</td><td>${esc(
          r.verdict === "melhor" ? "Acima do sector" : r.verdict === "pior" ? "Abaixo do sector" : r.verdict === "em_linha" ? "Em linha" : "Sem referência"
        )}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório financeiro ${esc(d.companyName)} ${esc(d.period)}</title>
<style>
:root{color-scheme:light;--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3df;--co:#2a78d6;--se:#eb6834;--c1:#2a78d6;--c2:#eb6834;--c3:#1baf7a;--c4:#eda100;--good:#0ca30c;--bad:#d03b3b}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--line:#33332f;--co:#3987e5;--se:#d95926;--c1:#3987e5;--c2:#d95926;--c3:#199e70;--c4:#c98500}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--line:#33332f;--co:#3987e5;--se:#d95926;--c1:#3987e5;--c2:#d95926;--c3:#199e70;--c4:#c98500}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:24px 16px}
.wrap{max-width:820px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px}
.muted{color:var(--ink2)}.small{font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:18px 0}
.tile{border:1px solid var(--line);border-radius:10px;padding:12px}
.tile-label{font-size:12px;color:var(--ink2)}.tile-value{font-size:24px;font-weight:700}.tile-delta{font-size:12px;color:var(--ink2)}
.chart{width:100%;height:auto;display:block;max-width:100%}
.lbl{font-size:12px;fill:var(--ink)}.val{font-size:11px;fill:var(--ink);font-weight:600}.val.muted{fill:var(--ink2);font-weight:400}
.bar.co,.seg.c1,.sw.co,.sw.c1{fill:var(--co);background:var(--co)}.bar.se,.seg.c2,.sw.se,.sw.c2{fill:var(--se);background:var(--se)}
.seg.c3,.sw.c3{fill:var(--c3);background:var(--c3)}.seg.c4,.sw.c4{fill:var(--c4);background:var(--c4)}
.verdict{font-size:11px;font-weight:700}.verdict.melhor{fill:var(--good)}.verdict.pior{fill:var(--bad)}.verdict.em_linha{fill:var(--ink2)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--ink2);margin:6px 0}.legend.col{flex-direction:column;gap:4px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;margin-right:4px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}th{font-size:12px;color:var(--ink2)}.num{text-align:right}
.tblwrap{overflow-x:auto}
.foot{margin-top:28px;font-size:12px;color:var(--ink2);border-top:1px solid var(--line);padding-top:10px}
</style></head><body><div class="wrap">
<h1>${esc(d.companyName)}</h1>
<div class="muted">Relatório financeiro · período ${esc(d.period)} · NIF ${esc(d.nif)}${d.sector ? ` · Sector: ${esc(d.sector.label)}` : ""}</div>
<h2>Resumo</h2><p>${esc(d.summary)}</p>
<div class="tiles">
${kpiTile("Vendas e serviços", eur(f.vendas), delta(f.vendas, p?.vendas))}
${kpiTile("EBITDA", eur(f.ebitda), delta(f.ebitda, p?.ebitda))}
${kpiTile("Resultado líquido", eur(f.resultadoLiquido), delta(f.resultadoLiquido, p?.resultadoLiquido))}
${kpiTile("Disponibilidades", eur(f.disponibilidades), delta(f.disponibilidades, p?.disponibilidades))}
</div>
<h2>Empresa vs sector de actividade</h2>
${ratiosChart(d.ratios)}
<h2>Estrutura de gastos</h2>
${costChart(d.costStructure, totalCosts)}
<h2>Memória descritiva</h2>
${d.narrative.map((par) => `<p>${esc(par)}</p>`).join("\n")}
<h2>Tabela de rácios</h2>
<div class="tblwrap"><table><thead><tr><th>Rácio</th><th class="num">Empresa</th><th class="num">Sector</th><th>Leitura</th></tr></thead><tbody>${table}</tbody></table></div>
<div class="foot">${d.sector ? `Referências sectoriais: ${esc(d.sector.source)}. ${esc(d.sector.disclaimer)}<br>` : ""}Gerado por ContaDesk em ${esc(d.generatedAt.slice(0, 16).replace("T", " "))}. Documento informativo; não substitui as demonstrações financeiras oficiais.</div>
</div></body></html>`;
}
