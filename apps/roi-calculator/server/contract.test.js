'use strict';
const assert = require('node:assert/strict');
const { contractSections, buildContractPdf, normalizePartner } = require('./contract');
const { PROGRAM, summary } = require('./partner-program');
const { buildPartnerEmailHtml, buildPartnerNoteHtml } = require('./partner-email');

const partner = {
  type: 'Agência de marketing', company: 'Exemplo Marketing, Lda.', tradeName: 'Exemplo', nif: '500000000',
  address: 'Rua das Flores 10', postalCode: '8000-000', city: 'Faro', country: 'Portugal', website: 'www.exemplo.pt',
  repName: 'Ana Silva', repRole: 'Sócia-gerente', email: 'ana@exemplo.pt', phone: '+351 910 000 000',
  iban: 'pt50 0000 0000 0000 0000 0000 0', billingEmail: 'faturas@exemplo.pt', date: new Date('2026-09-27T10:00:00Z'),
};

(async () => {
  const n = normalizePartner(partner);
  assert.equal(n.iban, ('PT50' + '0'.repeat(21)), 'IBAN is normalised');

  const s = contractSections(partner);
  assert.equal(s.clauses.length, 12);
  const all = JSON.stringify(s);
  assert.ok(all.includes('500 €') || all.includes('500 €'), 'fee present');
  assert.ok(all.includes('5000') || all.includes('5 000') || all.includes('5 000'), 'minimum deal present');
  assert.ok(all.includes('quinhentos euros') && all.includes('cinco mil euros'), 'amounts in words');
  assert.ok(all.includes('24 horas úteis'), 'contact SLA present');
  assert.ok(all.includes('Exemplo Marketing, Lda. (Exemplo)') && all.includes('Ana Silva'), 'partner data present');
  assert.ok(all.includes(('PT50' + '0'.repeat(21))), 'IBAN in payment clause');
  assert.ok(all.includes(PROGRAM.company.jurisdiction), 'jurisdiction present');
  assert.ok(s.footer.includes('27 de setembro de 2026') || s.footer.includes('27 de Setembro de 2026'), 'date present');
  assert.equal(s.annex.items.length, summary().length);

  const pdf = await buildContractPdf(partner);
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 8000, 'pdf generated');
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-', 'pdf header');

  const html = buildPartnerEmailHtml({ partner: n, programUrl: 'https://example.org/programa.pdf' });
  assert.ok(html.includes('Olá Ana') && html.includes('Exemplo Marketing, Lda.') && html.includes('example.org/programa.pdf'));
  assert.ok(html.includes(('PT50' + '0'.repeat(21))));

  const note = buildPartnerNoteHtml({ partner: n, source: 'Social Media Hackathon 2026' });
  assert.ok(note.includes('Social Media Hackathon 2026') && note.includes('500000000') && note.includes('Sócia-gerente'));

  // Escaping in the email
  const hostile = buildPartnerEmailHtml({ partner: normalizePartner({ ...partner, company: 'X <script>' }), programUrl: '' });
  assert.ok(hostile.includes('&lt;script&gt;') && !hostile.includes('<script>'));

  console.log('contract.test.js: ok');
})().catch((e) => { console.error(e); process.exit(1); });
