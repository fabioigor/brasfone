'use strict';
/** Builds the HTML ROI report (email body) and the Pipedrive note. Text in European Portuguese (pre-AO). */

const eur = (v, d = 0) => new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: d, minimumFractionDigits: d }).format(Number(v) || 0);
const n = (v, d = 0) => new Intl.NumberFormat('pt-PT', { maximumFractionDigits: d, minimumFractionDigits: d }).format(Number(v) || 0);
const pct = (v, d = 0) => n((Number(v) || 0) * 100, d) + '%';
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function rows(inputs, r) {
  const i = inputs;
  const cpsDrop = r.cps > 0 ? 1 - r.newCps / r.cps : 0;
  return [
    ['Funil por cliente (mensal)'],
    ['Investimento Meta Ads', eur(i.adspend), eur(i.adspend)],
    ['Custo por lead', eur(i.cpl, 2), eur(r.newCpl, 2)],
    ['Leads', n(r.leads), n(r.newLeads)],
    ['Taxa lead para SQL', pct(i.sqlRate), pct(r.newSqlRate)],
    ['SQL', n(r.sqls, 1), n(r.newSqls, 1)],
    ['Custo por SQL', eur(r.cps), eur(r.newCps) + ' (menos ' + pct(cpsDrop) + ')'],
    ['Relação com o cliente'],
    ['Avença mensal', eur(i.fee), eur(r.newFee)],
    ['Retenção média', n(i.retention, 1) + ' meses', n(r.newRetention, 1) + ' meses'],
    ['LTV por cliente', eur(r.ltv), eur(r.newLtv)],
    ['LTV da carteira (' + n(i.clients) + ' clientes)', eur(r.portfolio), eur(r.newPortfolio)],
    ['Agência (primeiro ano)'],
    ['Receita anual em avenças', eur(r.annualRev), eur(r.newAnnualRev)],
    ['Comissões de referral', eur(0), eur(r.referral)],
    ['Investimento na integração', '', eur(r.investment)],
    ['Ganho líquido', '', eur(r.net) + ' (ROI ' + pct(r.roi) + ')'],
  ];
}

function tableHtml(inputs, r, { navy = '#0A1628', line = '#dce3ef' } = {}) {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><th align="left" style="padding:8px;border-bottom:2px solid ${line};color:#5a6a7e;font-weight:500">Indicador</th><th align="right" style="padding:8px;border-bottom:2px solid ${line};color:#5a6a7e;font-weight:500">Hoje</th><th align="right" style="padding:8px;border-bottom:2px solid ${line};color:#5a6a7e;font-weight:500">Com Pipedrive + CAPI</th></tr>
    ${rows(inputs, r).map((row) => row.length === 1
      ? `<tr><td colspan="3" style="padding:16px 8px 6px;font-weight:700;color:${navy}">${esc(row[0])}</td></tr>`
      : `<tr><td style="padding:8px;border-bottom:1px solid ${line};color:#5a6a7e">${esc(row[0])}</td><td align="right" style="padding:8px;border-bottom:1px solid ${line}">${esc(row[1])}</td><td align="right" style="padding:8px;border-bottom:1px solid ${line};color:#1a8a49;font-weight:700">${esc(row[2])}</td></tr>`
    ).join('')}
  </table>`;
}

function buildReportHtml({ agency, contact, inputs, results: r, partnerPlanUrl }) {
  const first = esc(String(contact).split(' ')[0]);
  const refPct = n((inputs.refPct || 0) * 100);
  return `<!doctype html><html lang="pt-PT"><body style="margin:0;background:#F5F6FA;font-family:Ubuntu,Arial,sans-serif;color:#0A1628">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">
    <div style="background:#0A1628;color:#fff;border-radius:10px 10px 0 0;padding:28px 28px 22px">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#B8C4DA">INUBIA · Grupo Brasfone · Social Media Hackathon</div>
      <h1 style="margin:10px 0 6px;font-size:24px;line-height:1.2">Relatório de ROI para ${esc(agency)}</h1>
      <p style="margin:0;color:#B8C4DA;font-size:15px">Integração Pipedrive + Meta Conversions API. Valores calculados com os dados que nos indicou no stand.</p>
    </div>
    <div style="background:#fff;padding:28px;border:1px solid #e0e6ef;border-top:0">
      <p style="margin:0 0 18px;font-size:15px;line-height:1.55">Olá ${first}, obrigado pela visita. Abaixo fica o resumo do impacto que a integração do Pipedrive com a Conversions API teria na ${esc(agency)}: a Meta passa a optimizar para SQL e vendas registadas no CRM, o custo por oportunidade desce, os clientes ficam mais tempo e a avença justifica-se com resultados.</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 -8px 18px">
        <tr>
          <td style="background:#e8ecf4;border-radius:8px;padding:14px;width:33%"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5a6a7e">ROI 1.º ano</div><div style="font-size:26px;font-weight:700;color:#1a8a49">${pct(r.roi)}</div></td>
          <td style="background:#e8ecf4;border-radius:8px;padding:14px;width:33%"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5a6a7e">Payback</div><div style="font-size:26px;font-weight:700">${Number.isFinite(r.payback) ? n(r.payback, 1) + ' meses' : '—'}</div></td>
          <td style="background:#e8ecf4;border-radius:8px;padding:14px;width:33%"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5a6a7e">Custo por SQL</div><div style="font-size:26px;font-weight:700;color:#1a8a49">${eur(r.newCps)}</div><div style="font-size:12px;color:#5a6a7e">antes ${eur(r.cps)}</div></td>
        </tr>
      </table>
      ${tableHtml(inputs, r)}
      <p style="margin:18px 0 0;font-size:12px;color:#5a6a7e;line-height:1.5">Pressupostos: CPL menos ${pct(inputs.cplRed)}, taxa de SQL mais ${pct(inputs.sqlUp)} (relativo), retenção mais ${pct(inputs.retUp)}, avença mais ${pct(inputs.feeUp)}, implementação ${eur(inputs.setup)}, manutenção ${eur(inputs.monthly)} por cliente e mês, ${n(inputs.refs)} clientes apresentados por ano com projecto médio de ${eur(inputs.proj)}. Modelo indicativo para conversa comercial; os ganhos reais dependem do volume de conversões enviadas e da disciplina de actualização do CRM.</p>
    </div>

    <div style="background:#fff;padding:28px;border:1px solid #e0e6ef;border-top:0;border-radius:0 0 10px 10px">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#1D3DF5">Plano de parceiros INUBIA</div>
      <h2 style="margin:8px 0 12px;font-size:20px;line-height:1.25">A agência apresenta, a INUBIA implementa, a comissão é vossa</h2>
      <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6;color:#0A1628">
        <li><b>${refPct}% de comissão de referral</b> sobre os serviços INUBIA contratados por cada cliente que a agência apresentar, durante o primeiro ano de contrato.</li>
        <li><b>Gestor de parceria dedicado</b>, apoio na proposta, demonstração conjunta ao cliente e acompanhamento do projecto.</li>
        <li><b>Implementação completa</b> de Pipedrive, Conversions API, automação e IA pela equipa INUBIA, com formação incluída. A agência mantém a relação com o cliente.</li>
        <li><b>Co-marketing</b>: casos de sucesso partilhados, webinars e presença conjunta em eventos.</li>
        <li><b>Metodologia INUBIA</b>: sprints Agile, milestones de pagamento claros (50% na adjudicação e kick-off, 40% na conclusão do desenvolvimento, 10% no go-live e hipercare).</li>
      </ul>
      ${partnerPlanUrl ? `<p style="margin:18px 0 0"><a href="${esc(partnerPlanUrl)}" style="display:inline-block;background:#1D3DF5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">Ver o plano de parceiros completo</a></p>` : ''}
      <p style="margin:20px 0 0;font-size:14px;line-height:1.55">A INUBIA faz parte do Grupo Brasfone e é o maior Pipedrive Platinum Partner de Portugal e Espanha, com equipas em Faro, Vila do Conde e Barcelona. Respondemos a este email para marcar uma conversa de 30 minutos sobre a parceria.</p>
      <p style="margin:16px 0 0;font-size:13px;color:#5a6a7e">INUBIA · Grupo Brasfone · <a href="https://inubia.pt" style="color:#1D3DF5">inubia.pt</a></p>
    </div>
  </div></body></html>`;
}

function buildNoteHtml({ agency, contact, phone, email, inputs, results: r, source }) {
  return `<p><b>Origem:</b> ${esc(source || 'Calculadora ROI')} · <b>Contacto:</b> ${esc(contact)} · ${esc(phone)} · ${esc(email)}</p>
  <p><b>ROI 1.º ano:</b> ${pct(r.roi)} · <b>Payback:</b> ${Number.isFinite(r.payback) ? n(r.payback, 1) + ' meses' : '—'} · <b>Ganho líquido:</b> ${eur(r.net)} · <b>Referral estimado/ano:</b> ${eur(r.referral)}</p>
  <p><b>Agência:</b> ${esc(agency)} · ${n(inputs.clients)} clientes · avença ${eur(inputs.fee)} · retenção ${n(inputs.retention, 1)} meses · ads ${eur(inputs.adspend)}/mês · CPL ${eur(inputs.cpl, 2)} · SQL ${pct(inputs.sqlRate)}</p>
  ${tableHtml(inputs, r)}`;
}

module.exports = { buildReportHtml, buildNoteHtml };
