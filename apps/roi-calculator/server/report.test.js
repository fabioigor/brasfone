'use strict';
const assert = require('node:assert/strict');
const { buildReportHtml, buildNoteHtml } = require('./report');

// Same model as public/index.html compute(), used here to keep the report in sync with the page.
function compute(i) {
  const leads = i.adspend / i.cpl, sqls = leads * i.sqlRate, cps = i.adspend / sqls;
  const newCpl = i.cpl * (1 - i.cplRed), newLeads = i.adspend / newCpl;
  const newSqlRate = Math.min(0.95, i.sqlRate * (1 + i.sqlUp)), newSqls = newLeads * newSqlRate, newCps = i.adspend / newSqls;
  const customers = sqls * i.closeRate, newCloseRate = Math.min(0.95, i.closeRate * (1 + i.closeUp)), newCustomers = newSqls * newCloseRate;
  const cac = i.adspend / customers, newCac = i.adspend / newCustomers, sales = customers * i.ticket, newSales = newCustomers * i.ticket;
  const referred = i.clients * i.refShare, refClosed = referred * i.refClose;
  const newFee = i.fee * (1 + i.feeUp), newRetention = i.retention * (1 + i.retUp);
  const ltv = i.fee * i.retention, newLtv = newFee * newRetention;
  const annualRev = i.fee * 12 * i.clients, newAnnualRev = newFee * 12 * i.clients;
  const referral = refClosed * i.refFee;
  const gain = newAnnualRev - annualRev + referral, investment = i.setup + i.monthly * 12 * i.clients;
  const net = gain - investment, roi = net / investment, payback = investment / (gain / 12);
  return { leads, sqls, cps, newCpl, newLeads, newSqlRate, newSqls, newCps, customers, newCloseRate, newCustomers, cac, newCac, sales, newSales, referred, refClosed, newFee, newRetention, ltv, newLtv, annualRev, newAnnualRev, referral, gain, investment, net, roi, payback, portfolio: ltv * i.clients, newPortfolio: newLtv * i.clients };
}

const inputs = { fee: 1500, clients: 12, retention: 9, adspend: 3000, cpl: 25, sqlRate: 0.2, cplRed: 0.25, sqlUp: 0.3, retUp: 0.5, feeUp: 0.15, setup: 2400, monthly: 99, closeRate: 0.25, ticket: 2500, closeUp: 0.1, refShare: 0.5, refClose: 0.6, refFee: 500 };
const r = compute(inputs);

// Reference values for the default scenario.
assert.equal(Math.round(r.leads), 120);
assert.equal(Math.round(r.newLeads), 160);
assert.equal(Math.round(r.cps), 125);
assert.equal(Math.round(r.newCps * 100) / 100, 72.12);
assert.equal(r.ltv, 13500);
assert.equal(Math.round(r.newLtv * 100) / 100, 23287.5);
assert.equal(Math.round(r.referral), 1800); // 12 × 50% × 60% × 500 €
assert.equal(r.customers, 6);
assert.equal(Math.round(r.cac), 500);
assert.equal(r.sales, 15000);
assert.equal(r.investment, 2400 + 99 * 12 * 12);
assert.ok(r.roi > 1, 'default scenario should show positive ROI');

const html = buildReportHtml({ agency: 'Agência <Teste>', contact: 'Ana Silva', inputs, results: r, partnerPlanUrl: 'https://inubia.pt/parceiros' });
assert.ok(html.includes('Agência &lt;Teste&gt;'), 'agency name is escaped');
assert.ok(html.includes('Olá Ana'), 'greets by first name');
assert.ok(html.includes('Plano de parceiros INUBIA'));
assert.ok(/500.€ de comissão de referral/.test(html));
assert.ok(html.includes('maior Pipedrive Platinum Partner'));

const note = buildNoteHtml({ agency: 'Agência Teste', contact: 'Ana Silva', phone: '+351910000000', email: 'ana@exemplo.pt', inputs, results: r, source: 'Social Media Hackathon 2026' });
assert.ok(note.includes('Social Media Hackathon 2026'));
assert.ok(note.includes('Referral estimado/ano'));

console.log('report.test.js: ok');
