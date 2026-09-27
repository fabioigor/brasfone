'use strict';
const assert = require('node:assert/strict');
const models = require('../public/assets/roi-models');
const { buildReportHtml, buildNoteHtml, sanitizeReport } = require('./report');

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

// ---------- Agency model (defaults of public/agencias/index.html) ----------
const ag = models.agency({
  clients: 12, fee: 1500, retention: 9, adsShare: 0.8,
  refShare: 0.5, refClose: 0.6, refFee: 500, retUp: 0.5, feeUp: 0.15, hoursPerClient: 3, hourCost: 45,
  c_adspend: 2000, c_cpl: 25, c_sqlRate: 0.2, c_closeRate: 0.25, c_ticket: 2500, cplRed: 0.25, sqlUp: 0.3, closeUp: 0.1,
});
near(ag.eligible, 9.6);
near(ag.presented, 4.8);
near(ag.linked, 2.88);
near(ag.referral, 1440);           // 2,88 × 500 €
near(ag.feeGain, 2.88 * 225 * 12); // avença +15% nos clientes ligados
near(ag.gain, ag.feeGain + ag.referral);
assert.equal(ag.ltv, 13500);
near(ag.newLtv, 23287.5);
near(ag.extraMonths, 4.5);
near(ag.hours, 14.4);
near(ag.timeCost, 648);
assert.ok(ag.roi > 1 && ag.perHour > 100, 'agency partnership pays for the time invested');
// Illustrative client funnel does not depend on agency data.
near(ag.client.leads, 80);
near(ag.client.newLeads, 106.67);
near(ag.client.cps, 125);
near(ag.client.customers, 4);

// Agency ROI must not change when the client-type benchmarks change.
const ag2 = models.agency({ clients: 12, fee: 1500, retention: 9, adsShare: 0.8, refShare: 0.5, refClose: 0.6, refFee: 500, retUp: 0.5, feeUp: 0.15, hoursPerClient: 3, hourCost: 45,
  c_adspend: 9000, c_cpl: 60, c_sqlRate: 0.05, c_closeRate: 0.1, c_ticket: 100, cplRed: 0.25, sqlUp: 0.3, closeUp: 0.1 });
assert.equal(ag2.gain, ag.gain);
assert.equal(ag2.ltvGain, ag.ltvGain);

// ---------- Company model (defaults of public/empresas/index.html) ----------
const co = models.company({
  adspend: 3000, cpl: 25, lostRate: 0.2, sqlRate: 0.2, closeRate: 0.25, ticket: 2500, users: 3, sellerCost: 2000, margin: 0.4,
  cplRed: 0.25, recovery: 0.5, sqlUp: 0.3, closeUp: 0.1, setup: 5000, licence: 708,
});
near(co.leads, 120);
near(co.followed, 96);
near(co.sqls, 19.2);
near(co.customers, 4.8);
near(co.sales, 12000);
near(co.cac, 625);
near(co.newLeads, 160);
near(co.newLost, 0.1);
near(co.newFollowed, 144);
near(co.newSqls, 37.44);
near(co.newCustomers, 10.296);
near(co.recovered, 16);
near(co.teamCostMonthly, 6000);
near(co.teamCostAnnual, 72000);
near(co.licenceAnnual, 2124);           // 3 × 708 €
near(co.investment, 7124);              // licenças + implementação média
near(co.recurringAnnual, 2124);
near(co.toolShare, 7124 / 72000, 0.0001);
near(co.fullCac, 9000 / 4.8);           // (ads + equipa) por cliente
near(co.newFullCac, 9000 / 10.296);
near(co.marginPerCustomer, 1000);
near(co.breakEvenCustomers, 7.124);     // clientes adicionais por ano para pagar o investimento
near(co.marginGain, (co.newSales - co.sales) * 12 * 0.4);
assert.ok(co.roi > 1 && Number.isFinite(co.payback) && co.payback < 12, 'company scenario pays back within the year');
assert.ok(co.adsSaving > 0 && co.equivalentSpend < co.spend, 'same customers with less ad spend');

// Guard rails: rates are capped and zero inputs do not produce NaN or Infinity in the funnel.
const edge = models.company({ adspend: 0, cpl: 0, lostRate: 2, sqlRate: 5, closeRate: 5, ticket: 0, users: 0, sellerCost: 0, margin: 0, cplRed: 3, recovery: 3, sqlUp: 100, closeUp: 100, setup: 0, licence: 0 });
assert.ok(edge.newSqlRate <= 0.95 && edge.newCloseRate <= 0.95 && edge.newLost <= 0.95);
['leads', 'sqls', 'customers', 'sales', 'cps', 'cac', 'newCps', 'newCac', 'fullCac', 'newFullCac', 'teamCostAnnual', 'investment'].forEach((k) => assert.ok(Number.isFinite(edge[k]), k + ' is finite'));

// ---------- Report rendering ----------
const report = {
  title: 'Relatório de ROI da parceria INUBIA', subtitle: 'Sub',
  kpis: [{ label: 'Receita adicional anual', value: '9.216 €', note: '2,9 clientes ligados' }, { label: 'X', value: '1' }],
  sections: [{ title: 'Agência', headers: ['Indicador', 'Hoje', 'Com a parceria', 'Detalhe'], rows: [['Carteira'], ['Clientes activos', '', '12', ''], ['LTV', '13 500 €', '23 288 €', '+9 788 €']] }],
  assumptions: 'Pressupostos <script>alert(1)</script>',
};
const html = buildReportHtml({ kind: 'agency', name: 'Agência <Teste>', contact: 'Ana Silva', report, partnerPlanUrl: 'https://inubia.pt/parceiros' });
assert.ok(html.includes('Agência &lt;Teste&gt;'), 'name is escaped');
assert.ok(html.includes('&lt;script&gt;'), 'assumptions are escaped');
assert.ok(html.includes('Olá Ana'), 'greets by first name');
assert.ok(html.includes('Plano de parceiros INUBIA'));
assert.ok(html.includes('500 € de comissão de referral'));
assert.ok(html.includes('maior Pipedrive Platinum Partner'));
assert.ok(html.includes('inubia.pt/parceiros'));

const html2 = buildReportHtml({ kind: 'company', name: 'Empresa Teste', contact: 'Rui Pires', report: { title: 'Relatório de ROI Pipedrive + Meta CAPI', kpis: [], sections: [], assumptions: '' } });
assert.ok(html2.includes('Próximos passos com a INUBIA'));
assert.ok(!html2.includes('Plano de parceiros'), 'companies do not get the partner plan');

const note = buildNoteHtml({ kind: 'company', name: 'Empresa Teste', contact: 'Rui Pires', phone: '+351910000000', email: 'rui@exemplo.pt', report, source: 'Social Media Hackathon 2026' });
assert.ok(note.includes('Social Media Hackathon 2026') && note.includes('Empresa (Pipedrive + CAPI)'));

// Oversized or malformed payloads are bounded.
const big = sanitizeReport({ kpis: new Array(50).fill({ label: 'x'.repeat(500), value: 1 }), sections: new Array(20).fill({ rows: new Array(500).fill(['a', 'b', 'c', 'd', 'e']) }), title: 'y'.repeat(1000) });
assert.equal(big.kpis.length, 8);
assert.equal(big.kpis[0].label.length, 80);
assert.equal(big.sections.length, 4);
assert.equal(big.sections[0].rows.length, 60);
assert.equal(big.sections[0].rows[0].length, 4);
assert.equal(big.title.length, 120);
assert.deepEqual(sanitizeReport(null).kpis, []);

console.log('report.test.js: ok');
