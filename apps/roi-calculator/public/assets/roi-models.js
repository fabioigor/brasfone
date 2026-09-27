/**
 * ROI models shared by the calculator pages (browser) and the tests (Node).
 * Two independent models:
 *  - agency(): partner ROI for a marketing agency. Uses only agency-level data
 *    (portfolio, fee, retention) plus a purely illustrative "typical client" funnel.
 *  - company(): ROI for a company running its own Meta Ads, using its own funnel data.
 * All rates are fractions (0.2 = 20%). Money in euros.
 */
(function (root, factory) {
  const m = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  root.ROI_MODELS = m;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

  /** Client-level acquisition funnel, today vs. with Pipedrive + CAPI. */
  function funnel(c) {
    const spend = Math.max(0, c.adspend || 0);
    const cpl = Math.max(0.1, c.cpl || 0.1);
    const lost = clamp(c.lostRate || 0, 0, 0.95);
    const sqlRate = clamp(c.sqlRate, 0.01, 1);
    const closeRate = clamp(c.closeRate, 0.01, 1);
    const ticket = Math.max(0, c.ticket || 0);

    const leads = spend / cpl;
    const followed = leads * (1 - lost);
    const sqls = followed * sqlRate;
    const customers = sqls * closeRate;
    const sales = customers * ticket;
    const cps = sqls > 0 ? spend / sqls : 0;
    const cac = customers > 0 ? spend / customers : 0;

    const newCpl = cpl * (1 - clamp(c.cplRed || 0, 0, 0.9));
    const newLeads = spend / newCpl;
    const newLost = lost * (1 - clamp(c.recovery || 0, 0, 1));
    const newFollowed = newLeads * (1 - newLost);
    const newSqlRate = clamp(sqlRate * (1 + (c.sqlUp || 0)), 0.01, 0.95);
    const newCloseRate = clamp(closeRate * (1 + (c.closeUp || 0)), 0.01, 0.95);
    const newSqls = newFollowed * newSqlRate;
    const newCustomers = newSqls * newCloseRate;
    const newSales = newCustomers * ticket;
    const newCps = newSqls > 0 ? spend / newSqls : 0;
    const newCac = newCustomers > 0 ? spend / newCustomers : 0;

    return {
      spend, cpl, lost, sqlRate, closeRate, ticket,
      leads, followed, sqls, customers, sales, cps, cac,
      newCpl, newLeads, newLost, newFollowed, newSqlRate, newCloseRate, newSqls, newCustomers, newSales, newCps, newCac,
      recovered: newFollowed - newLeads * (1 - lost),
    };
  }

  /**
   * Agency partner model.
   * i: clients, fee, retention (months), adsShare, refShare, refClose, refFee, feeUp, retUp,
   *    hoursPerClient, hourCost, and c_* fields for the illustrative client funnel.
   */
  function agency(i) {
    const clients = Math.max(1, i.clients || 1);
    const fee = Math.max(0, i.fee || 0);
    const retention = Math.max(1, i.retention || 1);
    const eligible = clients * clamp(i.adsShare, 0, 1);
    const presented = eligible * clamp(i.refShare, 0, 1);
    const linked = presented * clamp(i.refClose, 0, 1);

    const newFee = fee * (1 + (i.feeUp || 0));
    const newRetention = retention * (1 + (i.retUp || 0));
    const ltv = fee * retention;
    const newLtv = newFee * newRetention;

    const feeGain = linked * (newFee - fee) * 12;
    const referral = linked * Math.max(0, i.refFee || 0);
    const gain = feeGain + referral;
    const ltvGain = (newLtv - ltv) * linked;
    const portfolioLtv = ltv * clients;
    const newPortfolioLtv = portfolioLtv + ltvGain;

    const hours = presented * Math.max(0, i.hoursPerClient || 0);
    const timeCost = hours * Math.max(0, i.hourCost || 0);
    const roi = timeCost > 0 ? (gain - timeCost) / timeCost : Infinity;
    const perHour = hours > 0 ? gain / hours : 0;

    const client = funnel({
      adspend: i.c_adspend, cpl: i.c_cpl, sqlRate: i.c_sqlRate, closeRate: i.c_closeRate, ticket: i.c_ticket,
      cplRed: i.cplRed, sqlUp: i.sqlUp, closeUp: i.closeUp, lostRate: 0, recovery: 0,
    });

    return {
      clients, eligible, presented, linked, fee, newFee, retention, newRetention, ltv, newLtv,
      feeGain, referral, gain, ltvGain, portfolioLtv, newPortfolioLtv, hours, timeCost, roi, perHour,
      extraMonths: newRetention - retention, client,
    };
  }

  /**
   * Company model (the company runs its own campaigns and sales).
   * i: adspend, cpl, lostRate, sqlRate, closeRate, ticket, users, margin,
   *    cplRed, recovery, sqlUp, closeUp, setup, licence, maintenance.
   */
  function company(i) {
    const f = funnel(i);
    const users = Math.max(1, i.users || 1);
    const margin = clamp(i.margin, 0.01, 1);
    const monthlyCost = users * Math.max(0, i.licence || 0) + Math.max(0, i.maintenance || 0);
    const investment = Math.max(0, i.setup || 0) + monthlyCost * 12;
    const salesGainMonthly = f.newSales - f.sales;
    const revenueGain = salesGainMonthly * 12;
    const marginGain = revenueGain * margin;
    const net = marginGain - investment;
    const roi = investment > 0 ? net / investment : Infinity;
    const payback = salesGainMonthly * margin > 0 ? investment / (salesGainMonthly * margin) : Infinity;
    const equivalentSpend = f.customers * f.newCac;
    const adsSaving = f.spend - equivalentSpend;
    return Object.assign({}, f, {
      users, margin, monthlyCost, investment, salesGainMonthly, revenueGain, marginGain, net, roi, payback, equivalentSpend, adsSaving,
    });
  }

  return { funnel, agency, company };
});
