'use strict';
/** Welcome email sent to a new partner with the contract draft attached. European Portuguese (pre-AO). */
const { PROGRAM, summary, eur } = require('./partner-program');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAVY = '#0A1628', MUTED = '#5a6a7e', BLUE = '#1D3DF5', LINE = '#dce3ef';

function buildPartnerEmailHtml({ partner, programUrl, program = PROGRAM }) {
  const first = esc(String(partner.repName || '').trim().split(' ')[0]);
  const c = program.company;
  return `<!doctype html><html lang="pt-PT"><body style="margin:0;background:#F5F6FA;font-family:Ubuntu,Arial,sans-serif;color:${NAVY}">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">
    <div style="background:${NAVY};color:#fff;border-radius:10px 10px 0 0;padding:28px 28px 22px">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#B8C4DA">${esc(c.brand)} · ${esc(c.group)} · ${esc(program.name)}</div>
      <h1 style="margin:10px 0 6px;font-size:24px;line-height:1.2">Bem-vindos ao ${esc(program.name)}, ${esc(partner.company)}</h1>
      <p style="margin:0;color:#B8C4DA;font-size:15px">A minuta do contrato de parceria segue em anexo, já preenchida com os dados da adesão.</p>
    </div>
    <div style="background:#fff;padding:28px;border:1px solid #e0e6ef;border-top:0">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.55">Olá ${first}, obrigado pela adesão. Registámos a ${esc(partner.company)} como parceiro ${esc(partner.type).toLowerCase()} da INUBIA. Em anexo encontra a minuta do contrato de parceria de referenciação, com todos os termos e condições do programa.</p>
      <h2 style="margin:0 0 10px;font-size:17px">Condições do programa</h2>
      <ul style="margin:0 0 18px;padding-left:20px;font-size:14px;line-height:1.6">${summary(program).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <h2 style="margin:0 0 10px;font-size:17px">Próximos passos</h2>
      <ol style="margin:0 0 18px;padding-left:20px;font-size:14px;line-height:1.6">
        <li>Rever a minuta em anexo. Qualquer ajuste é combinado com a equipa de parcerias.</li>
        <li>Devolver o contrato assinado para <a href="mailto:${esc(c.email)}" style="color:${BLUE}">${esc(c.email)}</a>, ou assinar digitalmente no link que enviamos a seguir.</li>
        <li>Registar a primeira referência: nome da empresa, decisor e contexto. A INUBIA contacta em ${program.contactHours} horas úteis.</li>
      </ol>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">
        <tr><td style="padding:8px;border-bottom:1px solid ${LINE};color:${MUTED};width:40%">Comissão por referência fechada</td><td style="padding:8px;border-bottom:1px solid ${LINE};font-weight:700">${esc(eur(program.fee))} + IVA</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid ${LINE};color:${MUTED}">Valor mínimo do projecto</td><td style="padding:8px;border-bottom:1px solid ${LINE};font-weight:700">${esc(eur(program.minDeal))} + IVA</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid ${LINE};color:${MUTED}">IBAN para pagamento das comissões</td><td style="padding:8px;border-bottom:1px solid ${LINE};font-family:monospace">${esc(partner.iban)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid ${LINE};color:${MUTED}">Representante</td><td style="padding:8px;border-bottom:1px solid ${LINE}">${esc(partner.repName)}${partner.repRole ? ', ' + esc(partner.repRole) : ''}</td></tr>
      </table>
      ${programUrl ? `<p style="margin:0 0 18px"><a href="${esc(programUrl)}" style="display:inline-block;background:${BLUE};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">Ver o programa de parceiros completo</a></p>` : ''}
      <p style="margin:0;font-size:14px;line-height:1.55">A INUBIA faz parte do ${esc(c.group)} e é o ${esc(c.positioning)}, com equipas em ${esc(c.offices)}. Respondemos a este email para qualquer dúvida.</p>
      <p style="margin:16px 0 0;font-size:13px;color:${MUTED}">${esc(c.brand)} · ${esc(c.group)} · <a href="https://${esc(c.website)}" style="color:${BLUE}">${esc(c.website)}</a></p>
    </div>
  </div></body></html>`;
}

function buildPartnerNoteHtml({ partner, source, program = PROGRAM }) {
  const row = (k, v) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v || '—')}</td></tr>`;
  return `<p><b>Adesão ao ${esc(program.name)}</b> (versão ${esc(program.version)}) · Origem: ${esc(source || 'Formulário de parceiros')}</p>
  <table>${row('Tipo de parceiro', partner.type)}${row('Denominação social', partner.company)}${row('Nome comercial', partner.tradeName)}${row('NIF', partner.nif)}${row('Morada', [partner.address, partner.postalCode, partner.city, partner.country].filter(Boolean).join(', '))}${row('Website', partner.website)}${row('Representante', [partner.repName, partner.repRole].filter(Boolean).join(', '))}${row('Email', partner.email)}${row('Telefone', partner.phone)}${row('IBAN', partner.iban)}${row('Email de facturação', partner.billingEmail)}</table>
  <p>Minuta de contrato enviada por email com as condições: ${esc(eur(program.fee))} + IVA por referência fechada (projecto igual ou superior a ${esc(eur(program.minDeal))} + IVA). Próximo passo: validar a adesão e recolher o contrato assinado.</p>`;
}

module.exports = { buildPartnerEmailHtml, buildPartnerNoteHtml };
