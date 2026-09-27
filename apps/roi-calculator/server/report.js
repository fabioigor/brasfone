'use strict';
/**
 * Renders the ROI report email and the Pipedrive note from the generic report payload
 * sent by either calculator page. The server never recomputes the models: the page sends
 * already formatted KPIs and rows, and this module only lays them out (and escapes them).
 * Text in European Portuguese (pre-AO).
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAVY = '#0A1628', LINE = '#dce3ef', MUTED = '#5a6a7e', GREEN = '#1a8a49', BLUE = '#1D3DF5';

/** Normalises and bounds the report payload so that a malformed request cannot blow up the email. */
function sanitizeReport(rep) {
  const r = rep && typeof rep === 'object' ? rep : {};
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const kpis = (Array.isArray(r.kpis) ? r.kpis : []).slice(0, 8).map((k) => ({
    label: str(k && k.label, 80), value: str(k && k.value, 40), note: str(k && k.note, 120),
  }));
  const sections = (Array.isArray(r.sections) ? r.sections : []).slice(0, 4).map((s) => ({
    title: str(s && s.title, 120),
    headers: (Array.isArray(s && s.headers) ? s.headers : ['Indicador', 'Hoje', 'Com Pipedrive + CAPI', 'Variação']).slice(0, 4).map((h) => str(h, 40)),
    rows: (Array.isArray(s && s.rows) ? s.rows : []).slice(0, 60).map((row) => (Array.isArray(row) ? row.slice(0, 4).map((c) => str(c, 120)) : [str(row, 120)])),
  }));
  return { title: str(r.title, 120), subtitle: str(r.subtitle, 300), kpis, sections, assumptions: str(r.assumptions, 1500) };
}

function kpiTiles(kpis) {
  if (!kpis.length) return '';
  const rows = [];
  for (let i = 0; i < kpis.length; i += 3) rows.push(kpis.slice(i, i + 3));
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:8px 8px;margin:0 -8px 10px">${rows.map((row) => `<tr>${row.map((k) => `
    <td valign="top" style="background:#e8ecf4;border-radius:8px;padding:14px;width:33%"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:${MUTED}">${esc(k.label)}</div><div style="font-size:24px;font-weight:700;color:${GREEN}">${esc(k.value)}</div>${k.note ? `<div style="font-size:12px;color:${MUTED}">${esc(k.note)}</div>` : ''}</td>`).join('')}</tr>`).join('')}</table>`;
}

function sectionTable(section) {
  const th = (t, align) => `<th align="${align}" style="padding:8px;border-bottom:2px solid ${LINE};color:${MUTED};font-weight:500">${esc(t)}</th>`;
  const h = section.headers;
  return `${section.title ? `<h3 style="margin:22px 0 8px;font-size:16px;color:${NAVY}">${esc(section.title)}</h3>` : ''}
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px">
    <tr>${th(h[0] || '', 'left')}${th(h[1] || '', 'right')}${th(h[2] || '', 'right')}${th(h[3] || '', 'right')}</tr>
    ${section.rows.map((row) => row.length === 1
      ? `<tr><td colspan="4" style="padding:14px 8px 6px;font-weight:700;color:${NAVY}">${esc(row[0])}</td></tr>`
      : `<tr><td style="padding:7px 8px;border-bottom:1px solid ${LINE};color:${MUTED}">${esc(row[0])}</td><td align="right" style="padding:7px 8px;border-bottom:1px solid ${LINE}">${esc(row[1])}</td><td align="right" style="padding:7px 8px;border-bottom:1px solid ${LINE};color:${GREEN};font-weight:700">${esc(row[2])}</td><td align="right" style="padding:7px 8px;border-bottom:1px solid ${LINE};color:${MUTED}">${esc(row[3] || '')}</td></tr>`
    ).join('')}
  </table>`;
}

function partnerPlanBlock(partnerPlanUrl) {
  return `<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${BLUE}">Plano de parceiros INUBIA</div>
    <h2 style="margin:8px 0 12px;font-size:20px;line-height:1.25">A agência apresenta, a INUBIA implementa, a comissão é vossa</h2>
    <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6;color:${NAVY}">
      <li><b>500 € de comissão de referral</b> por cada cliente apresentado pela agência que feche um projecto INUBIA acima de 5.000 €.</li>
      <li><b>Gestor de parceria dedicado</b>, apoio na proposta, demonstração conjunta ao cliente e acompanhamento do projecto.</li>
      <li><b>Implementação completa</b> de Pipedrive, Conversions API, automação e IA pela equipa INUBIA, com formação incluída. A agência mantém a relação com o cliente.</li>
      <li><b>Co-marketing</b>: casos de sucesso partilhados, webinars e presença conjunta em eventos.</li>
      <li><b>Metodologia INUBIA</b>: sprints Agile e milestones de pagamento claros (50% na adjudicação e kick-off, 40% na conclusão do desenvolvimento, 10% no go-live e hipercare).</li>
    </ul>
    ${partnerPlanUrl ? `<p style="margin:18px 0 0"><a href="${esc(partnerPlanUrl)}" style="display:inline-block;background:${BLUE};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">Ver o plano de parceiros completo</a></p>` : ''}`;
}

function nextStepsBlock() {
  return `<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${BLUE}">Próximos passos com a INUBIA</div>
    <h2 style="margin:8px 0 12px;font-size:20px;line-height:1.25">Do diagnóstico ao go-live em sprints</h2>
    <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6;color:${NAVY}">
      <li><b>Diagnóstico de 30 minutos</b>: revemos o vosso funil real, as fontes de leads e o que a Meta consegue ver hoje.</li>
      <li><b>Proposta INUBIA</b>: Pipedrive, integração com a Conversions API, automação do seguimento e formação da equipa comercial.</li>
      <li><b>Implementação Agile</b> em sprints curtos, com 50% na adjudicação e kick-off, 40% na conclusão do desenvolvimento e 10% no go-live e hipercare.</li>
      <li><b>Acompanhamento mensal</b> de CPL, custo por SQL e CAC com a vossa equipa.</li>
    </ul>`;
}

function buildReportHtml({ kind, name, contact, report, partnerPlanUrl }) {
  const rep = sanitizeReport(report);
  const first = esc(String(contact || '').trim().split(' ')[0]);
  const isAgency = kind === 'agency';
  const intro = isAgency
    ? `Olá ${first}, obrigado pela visita. Abaixo fica o impacto estimado da parceria INUBIA na ${esc(name)}: clientes retidos mais tempo, avença justificada por resultados no CRM e comissão por cada cliente apresentado. O cliente tipo é ilustrativo e serve para mostrar o argumento aos vossos clientes.`
    : `Olá ${first}, obrigado pela visita. Abaixo fica o impacto estimado de integrar o Pipedrive com a Meta Conversions API na ${esc(name)}: leads com seguimento garantido, custo por SQL e CAC mais baixos e mais clientes ao mesmo investimento em Meta Ads.`;
  return `<!doctype html><html lang="pt-PT"><body style="margin:0;background:#F5F6FA;font-family:Ubuntu,Arial,sans-serif;color:${NAVY}">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">
    <div style="background:${NAVY};color:#fff;border-radius:10px 10px 0 0;padding:28px 28px 22px">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#B8C4DA">INUBIA · Grupo Brasfone · Social Media Hackathon</div>
      <h1 style="margin:10px 0 6px;font-size:24px;line-height:1.2">${esc(rep.title || 'Relatório de ROI')} para ${esc(name)}</h1>
      <p style="margin:0;color:#B8C4DA;font-size:15px">${esc(rep.subtitle)}</p>
    </div>
    <div style="background:#fff;padding:28px;border:1px solid #e0e6ef;border-top:0">
      <p style="margin:0 0 18px;font-size:15px;line-height:1.55">${intro}</p>
      ${kpiTiles(rep.kpis)}
      ${rep.sections.map(sectionTable).join('')}
      ${rep.assumptions ? `<p style="margin:18px 0 0;font-size:12px;color:${MUTED};line-height:1.5">${esc(rep.assumptions)} Modelo indicativo para conversa comercial; os ganhos reais dependem do volume de conversões enviadas e da disciplina de actualização do CRM.</p>` : ''}
    </div>
    <div style="background:#fff;padding:28px;border:1px solid #e0e6ef;border-top:0;border-radius:0 0 10px 10px">
      ${isAgency ? partnerPlanBlock(partnerPlanUrl) : nextStepsBlock()}
      <p style="margin:20px 0 0;font-size:14px;line-height:1.55">A INUBIA faz parte do Grupo Brasfone e é o maior Pipedrive Platinum Partner de Portugal e Espanha, com equipas em Faro, Vila do Conde e Barcelona. Respondemos a este email para marcar uma conversa de 30 minutos.</p>
      <p style="margin:16px 0 0;font-size:13px;color:${MUTED}">INUBIA · Grupo Brasfone · <a href="https://inubia.pt" style="color:${BLUE}">inubia.pt</a></p>
    </div>
  </div></body></html>`;
}

function buildNoteHtml({ kind, name, contact, phone, email, report, source }) {
  const rep = sanitizeReport(report);
  const kpis = rep.kpis.map((k) => `<b>${esc(k.label)}:</b> ${esc(k.value)}`).join(' · ');
  return `<p><b>Origem:</b> ${esc(source || 'Calculadora ROI')} · <b>Perfil:</b> ${kind === 'agency' ? 'Agência de marketing (parceria)' : 'Empresa (Pipedrive + CAPI)'}</p>
  <p><b>${kind === 'agency' ? 'Agência' : 'Empresa'}:</b> ${esc(name)} · <b>Contacto:</b> ${esc(contact)} · ${esc(phone)} · ${esc(email)}</p>
  <p>${kpis}</p>
  ${rep.sections.map(sectionTable).join('')}
  ${rep.assumptions ? `<p><i>${esc(rep.assumptions)}</i></p>` : ''}`;
}

module.exports = { buildReportHtml, buildNoteHtml, sanitizeReport };
