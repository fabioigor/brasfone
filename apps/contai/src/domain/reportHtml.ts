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

const LIGHT_COLOR: Record<string, string> = { verde: "#0F5A44", amarelo: "#B7791F", vermelho: "#B3261E", cinzento: "#8A8A86" };
const LIGHT_LABEL: Record<string, string> = { verde: "Bem", amarelo: "Atenção", vermelho: "Risco", cinzento: "Sem dados" };
const SEV_LABEL: Record<string, string> = { erro: "Bloqueante", aviso: "Alerta", info: "Informativo" };

export function renderReportHtml(d: ReportData): string {
  const f = d.financials;
  const p = d.previousFinancials;
  const has = (id: string) => !d.sections || d.sections.includes(id);
  const delta = (cur: number, prev: number | undefined) =>
    prev === undefined || prev === 0 ? null : `${cur - prev >= 0 ? "+" : ""}${(((cur - prev) / Math.abs(prev)) * 100).toFixed(1)}% vs ${d.previousPeriod}`;
  const totalCosts = d.costStructure.reduce((s, c) => s + c.value, 0);
  const pmr = f.vendas ? Math.round((f.clientes / f.vendas) * 365) : null;
  const pmp = f.cmvmc + f.fse ? Math.round((f.fornecedores / (f.cmvmc + f.fse)) * 365) : null;
  const fundoManeio = f.disponibilidades + f.clientes - f.fornecedores;

  const table = d.ratios
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td><td class="num">${esc(fmtRatio(r, r.company))}</td><td class="num">${esc(fmtRatio(r, r.sector))}</td><td>${esc(
          r.verdict === "melhor" ? "Acima do sector" : r.verdict === "pior" ? "Abaixo do sector" : r.verdict === "em_linha" ? "Em linha" : "Sem referência"
        )}</td></tr>`
    )
    .join("");
  const lights = (d.trafficLights ?? []).map((t) => `<div class="light"><span class="dot" style="background:${LIGHT_COLOR[t.light] ?? "#8A8A86"}" title="${esc(LIGHT_LABEL[t.light] ?? "")}"></span><div><div class="light-label">${esc(t.label)}</div><div class="light-value">${esc(t.value)}</div><div class="small muted">${esc(t.note)}</div></div></div>`).join("");
  const recs = (d.recommendations ?? []).map((r, i) => `<li><strong>${i + 1}. ${esc(r.title)}</strong><br>${esc(r.text)}<div class="small muted">Base: ${esc(r.basis)}</div></li>`).join("");
  const alerts = d.alerts;
  const alertsHtml = alerts ? `<p>${alerts.blocking + alerts.alerts + alerts.info === 0 ? "Não há alertas abertos na conferência deste período." : `Alertas abertos na conferência: <strong>${alerts.blocking}</strong> bloqueante(s), <strong>${alerts.alerts}</strong> alerta(s), ${alerts.info} informativo(s).`}</p>
${alerts.items.length ? `<ul class="small">${alerts.items.map((a) => `<li><span class="sev ${a.severity}">${esc(SEV_LABEL[a.severity] || a.severity)}</span> ${esc(a.message)}</li>`).join("")}</ul>` : ""}
${alerts.obligations.length ? `<h3>Obrigações seguintes</h3><table><thead><tr><th>Prazo</th><th>Obrigação</th></tr></thead><tbody>${alerts.obligations.map((o) => `<tr><td>${esc(o.dueDate.split("-").reverse().join("/"))}</td><td>${esc(o.label)}</td></tr>`).join("")}</tbody></table>` : `<p class="small muted">Sem obrigações declarativas carregadas para o período seguinte.</p>`}` : "";
  const model = d.sectorModel;
  const modelHtml = model ? `<h3>Indicadores do modelo "${esc(model.label)}"</h3><table><thead><tr><th>Indicador</th><th class="num">Valor</th><th>Nota</th></tr></thead><tbody>${model.indicators.map((i) => `<tr><td>${esc(i.label)}</td><td class="num">${esc(i.value)}</td><td class="small muted">${esc(i.note ?? "")}</td></tr>`).join("")}</tbody></table>` : "";

  return `<!doctype html>
<html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório financeiro ${esc(d.companyName)} ${esc(d.period)}</title>
<style>
:root{color-scheme:light;--bg:#F7F4EF;--paper:#fff;--ink:#1C1917;--ink2:#5c574f;--line:#e6dccf;--gold:#8F6D47;--gold2:#D4B58C;--co:#8F6D47;--se:#9aa5b1;--c1:#8F6D47;--c2:#D4B58C;--c3:#0F5A44;--c4:#B7791F;--good:#0F5A44;--bad:#B3261E}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1C1917;--paper:#27221e;--ink:#f5f1ea;--ink2:#c3bcb0;--line:#3a332c;--se:#7b8794}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#1C1917;--paper:#27221e;--ink:#f5f1ea;--ink2:#c3bcb0;--line:#3a332c;--se:#7b8794}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:24px 16px}
.wrap{max-width:860px;margin:0 auto}
.cover{background:var(--paper);border:1px solid var(--line);border-top:6px solid var(--gold);border-radius:14px;padding:28px 28px 22px;margin-bottom:22px}
.brand{font-family:Georgia,"Times New Roman",serif;color:var(--gold);font-size:14px;letter-spacing:.08em;text-transform:uppercase}
h1{font-family:Georgia,"Times New Roman",serif;font-size:30px;margin:6px 0 4px;font-weight:600}h2{font-size:18px;margin:30px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}h3{font-size:15px;margin:16px 0 6px}
.muted{color:var(--ink2)}.small{font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:18px 0}
.tile{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--paper)}
.tile-label{font-size:12px;color:var(--ink2)}.tile-value{font-size:24px;font-weight:700}.tile-delta{font-size:12px;color:var(--ink2)}
.lights{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin:12px 0}
.light{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--paper)}
.dot{width:18px;height:18px;border-radius:50%;flex:none;margin-top:3px;box-shadow:0 0 0 3px var(--bg)}
.light-label{font-size:12px;color:var(--ink2)}.light-value{font-size:20px;font-weight:700}
.chart{width:100%;height:auto;display:block;max-width:100%}
.lbl{font-size:12px;fill:var(--ink)}.val{font-size:11px;fill:var(--ink);font-weight:600}.val.muted{fill:var(--ink2);font-weight:400}
.bar.co,.seg.c1,.sw.co,.sw.c1{fill:var(--co);background:var(--co)}.bar.se,.seg.c2,.sw.se,.sw.c2{fill:var(--se);background:var(--se)}
.seg.c3,.sw.c3{fill:var(--c3);background:var(--c3)}.seg.c4,.sw.c4{fill:var(--c4);background:var(--c4)}
.verdict{font-size:11px;font-weight:700}.verdict.melhor{fill:var(--good)}.verdict.pior{fill:var(--bad)}.verdict.em_linha{fill:var(--ink2)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--ink2);margin:6px 0}.legend.col{flex-direction:column;gap:4px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;margin-right:4px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}th{font-size:12px;color:var(--ink2)}.num{text-align:right}
.tblwrap{overflow-x:auto}
.recs{padding-left:0;list-style:none}.recs li{border-left:4px solid var(--gold);padding:8px 12px;margin:8px 0;background:var(--paper);border-radius:0 10px 10px 0}
.sev{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;background:var(--line)}.sev.erro{background:#fbe9e7;color:#B3261E}.sev.aviso{background:#fdf3d7;color:#9a6700}
.foot{margin-top:28px;font-size:12px;color:var(--ink2);border-top:1px solid var(--line);padding-top:10px}
.lag{background:#fdf3d7;color:#7a5a12;border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}
@media print{body{background:#fff;padding:0}.cover,.tile,.light,.recs li{break-inside:avoid}}
</style></head><body><div class="wrap">
${has("capa") ? `<div class="cover"><div class="brand">Cont.ai by Lumarcont</div><h1>${esc(d.companyName)}</h1>
<div class="muted">Relatório financeiro · período ${esc(d.period)} · NIF ${esc(d.nif)}${d.sector ? ` · Sector de referência: ${esc(d.sector.label)}` : ""}${model ? ` · Modelo: ${esc(model.label)}` : ""}</div>
<p style="margin:14px 0 0">${esc(d.summary)}</p></div>` : ""}
${has("semaforo") && d.trafficLights ? `<h2>Saúde do negócio em seis indicadores</h2><div class="lights">${lights}</div>` : ""}
${has("memoria") ? `<h2>Memória descritiva</h2>${d.narrative.map((par) => `<p>${esc(par)}</p>`).join("\n")}` : ""}
${has("actividade") ? `<h2>Actividade: vendas, margem e resultado</h2><div class="tiles">
${kpiTile("Vendas e serviços", eur(f.vendas), delta(f.vendas, p?.vendas))}
${kpiTile("Margem bruta", eur(f.vendas - f.cmvmc), delta(f.vendas - f.cmvmc, p ? p.vendas - p.cmvmc : undefined))}
${kpiTile("EBITDA", eur(f.ebitda), delta(f.ebitda, p?.ebitda))}
${kpiTile("Resultado líquido", eur(f.resultadoLiquido), delta(f.resultadoLiquido, p?.resultadoLiquido))}
</div>` : ""}
${has("gastos") ? `<h2>Estrutura de gastos</h2>${costChart(d.costStructure, totalCosts)}` : ""}
${has("tesouraria") ? `<h2>Tesouraria e prazos médios</h2><div class="tiles">
${kpiTile("Disponibilidades", eur(f.disponibilidades), delta(f.disponibilidades, p?.disponibilidades))}
${kpiTile("Clientes por cobrar", eur(f.clientes), delta(f.clientes, p?.clientes))}
${kpiTile("Fornecedores por pagar", eur(f.fornecedores), delta(f.fornecedores, p?.fornecedores))}
${kpiTile("Fundo de maneio", eur(fundoManeio), null)}
${kpiTile("Prazo médio de recebimento", pmr === null ? "n.d." : `${pmr} dias`, null)}
${kpiTile("Prazo médio de pagamento", pmp === null ? "n.d." : `${pmp} dias`, null)}
</div>` : ""}
${has("sector") ? `<h2>Posição face ao sector</h2>${d.benchmark ? `<div class="lag">Referência sectorial: ${esc(d.benchmark.source)}, versão ${esc(d.benchmark.version)} (verificada em ${esc(d.benchmark.lastVerified)}). Os dados sectoriais têm um desfasamento de 12 a 24 meses face ao período da empresa.</div>` : ""}${ratiosChart(d.ratios)}
<div class="tblwrap"><table><thead><tr><th>Rácio</th><th class="num">Empresa</th><th class="num">Sector</th><th>Leitura</th></tr></thead><tbody>${table}</tbody></table></div>${modelHtml}` : ""}
${has("alertas") ? `<h2>Alertas fiscais e obrigações do período seguinte</h2>${alertsHtml}` : ""}
${has("recomendacoes") && d.recommendations ? `<h2>Três recomendações</h2><ol class="recs">${recs}</ol>` : ""}
${has("metodologia") ? `<h2>Anexo metodológico</h2><table class="small"><tbody>
<tr><td>Vendas e serviços</td><td>Saldo credor das contas 71 e 72 do balancete do período</td></tr>
<tr><td>Margem bruta</td><td>Vendas − custo das mercadorias (61)</td></tr>
<tr><td>EBITDA</td><td>Vendas − CMVMC (61) − FSE (62) − gastos com pessoal (63) − outros gastos operacionais</td></tr>
<tr><td>Margem EBITDA</td><td>EBITDA / vendas</td></tr>
<tr><td>Autonomia financeira</td><td>Capital próprio (classe 5) / activo</td></tr>
<tr><td>Liquidez geral</td><td>(Disponibilidades + clientes) / passivo</td></tr>
<tr><td>Prazo médio de recebimento</td><td>Clientes (21) / vendas × 365</td></tr>
<tr><td>Prazo médio de pagamento</td><td>Fornecedores (22) / (CMVMC + FSE) × 365</td></tr>
<tr><td>Fundo de maneio</td><td>Disponibilidades + clientes − fornecedores</td></tr>
<tr><td>Fontes</td><td>Balancete ${esc(d.period)}${d.previousPeriod ? ` e ${esc(d.previousPeriod)}` : ""} da empresa; ${d.benchmark ? esc(d.benchmark.source) : "sem referência sectorial"}; alertas da conferência Cont.ai; obrigações do GestObrig.</td></tr>
<tr><td>Data de referência</td><td>${esc(d.generatedAt.slice(0, 16).replace("T", " "))}${d.benchmark ? `; dados sectoriais versão ${esc(d.benchmark.version)}` : ""}</td></tr>
</tbody></table>` : ""}
<div class="foot">${d.benchmark ? `${esc(d.benchmark.disclaimer)}<br>` : ""}Todos os números provêm de campos calculados a partir do balancete; o texto explica, não calcula. Documento informativo; não substitui as demonstrações financeiras oficiais. Cont.ai by Lumarcont.</div>
</div></body></html>`;
}
