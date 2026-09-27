'use strict';
/**
 * Partnership contract draft (minuta) generated from the partner sign-up data.
 * contractSections() gives the structured text (used by the PDF, the tests and the note);
 * buildContractPdf() renders it with pdfkit (A4, built-in Helvetica, WinAnsi covers PT/ES).
 * Text in European Portuguese (pre-AO). This is a draft for legal review, never a signed document.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { PROGRAM, summary, eur } = require('./partner-program');

const LOGO = path.join(__dirname, 'assets', 'inubia-logo.png');
const NAVY = '#0A1628', BLUE = '#1D3DF5', MUTED = '#5a6a7e', INK = '#0A1628';

const numberToWords = { 500: 'quinhentos', 5000: 'cinco mil' };
const words = (v) => numberToWords[v] || String(v);

function fmtDate(d) {
  return new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/** Normalised partner record (all strings, safe defaults). */
function normalizePartner(p) {
  const s = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
  return {
    type: s(p.type, 40) || 'Parceiro',
    company: s(p.company, 160),
    tradeName: s(p.tradeName, 160),
    nif: s(p.nif, 20),
    address: s(p.address, 200),
    postalCode: s(p.postalCode, 20),
    city: s(p.city, 80),
    country: s(p.country, 60) || 'Portugal',
    website: s(p.website, 120),
    repName: s(p.repName, 120),
    repRole: s(p.repRole, 80),
    email: s(p.email, 200),
    phone: s(p.phone, 40),
    iban: s(p.iban, 40).replace(/\s+/g, '').toUpperCase(),
    billingEmail: s(p.billingEmail, 200),
    date: p.date instanceof Date ? p.date : new Date(),
  };
}

function contractSections(partnerInput, program = PROGRAM) {
  const p = normalizePartner(partnerInput);
  const c = program.company;
  const partnerAddress = [p.address, [p.postalCode, p.city].filter(Boolean).join(' '), p.country].filter(Boolean).join(', ');
  const partnerLabel = p.tradeName && p.tradeName !== p.company ? `${p.company} (${p.tradeName})` : p.company;
  return {
    partner: p,
    title: 'Contrato de Parceria de Referenciação',
    subtitle: `${program.name} · versão ${program.version} · minuta`,
    parties: [
      `Primeira Outorgante: ${c.legalName}, pessoa colectiva n.º ${c.nif}, com sede em ${c.address}, adiante designada por "INUBIA".`,
      `Segunda Outorgante: ${partnerLabel}, pessoa colectiva n.º ${p.nif}, com sede em ${partnerAddress}, neste acto representada por ${p.repName}${p.repRole ? ', na qualidade de ' + p.repRole : ''}, adiante designada por "Parceiro".`,
    ],
    recitals: [
      `A INUBIA, parte do ${c.group}, é o ${c.positioning} e presta serviços de implementação, integração e automação de CRM, incluindo a integração do Pipedrive com a Meta Conversions API.`,
      'O Parceiro mantém relações comerciais com empresas que podem beneficiar dessas soluções e pretende apresentá-las à INUBIA.',
      'É celebrado o presente contrato, que se rege pelas cláusulas seguintes e, no que nelas for omisso, pelas condições do Programa de Parceiros INUBIA em anexo.',
    ],
    clauses: [
      { title: 'Cláusula 1.ª · Objecto', items: [
        'O Parceiro compromete-se a apresentar à INUBIA empresas potencialmente interessadas nas soluções Pipedrive CRM e serviços associados (adiante "Referências"), e a INUBIA compromete-se a remunerar o Parceiro por cada Referência Fechada, nos termos da Cláusula 4.ª.',
      ] },
      { title: 'Cláusula 2.ª · Registo e validação das Referências', items: [
        `Uma Referência considera-se registada quando o Parceiro a comunica à INUBIA por escrito, através do formulário de parceiros ou do email ${c.email}, indicando o nome da empresa, o contacto do decisor e o contexto da apresentação.`,
        `A Referência é válida se, à data do registo, a empresa apresentada não estiver em negociação activa com a INUBIA ou com outra empresa do ${c.group}, nem tiver sido sua cliente nos ${program.quarantineMonths} meses anteriores, e se o contacto tiver consentido em ser contactado pela INUBIA.`,
        `A INUBIA confirma ao Parceiro a validade da Referência no prazo de ${program.validationDays} dias úteis após o registo.`,
        'Quando a mesma empresa for registada por mais do que um parceiro, a Referência é atribuída ao primeiro registo válido.',
      ] },
      { title: 'Cláusula 3.ª · Obrigações da INUBIA', items: [
        `Contactar a Referência no prazo máximo de ${program.contactHours} horas úteis após o registo.`,
        'Realizar o diagnóstico e, quando entender que pode ajudar a Referência, apresentar proposta. A INUBIA reserva-se o direito de não apresentar proposta.',
        'Informar o Parceiro do estado de cada Referência: contactada, em proposta, fechada ou sem seguimento.',
      ] },
      { title: 'Cláusula 4.ª · Comissão', items: [
        `Por cada Referência Fechada, a INUBIA paga ao Parceiro a comissão de ${eur(program.fee)} (${words(program.fee)} euros), acrescida de IVA à taxa legal em vigor.`,
        `Considera-se Referência Fechada aquela em que a empresa apresentada adjudica à INUBIA um projecto (implementação, integração, serviços e subscrições contratadas através da INUBIA) de valor igual ou superior a ${eur(program.minDeal)} (${words(program.minDeal)} euros), acrescido de IVA, no prazo de ${program.closingWindowMonths} meses após o registo da Referência.`,
        'A comissão é devida uma única vez por Referência, independentemente do número de projectos posteriores com a mesma empresa, salvo acordo escrito em contrário.',
        'A INUBIA poderá, por sua iniciativa, superar os parâmetros aqui definidos, sem qualquer encargo adicional para o Parceiro. Parâmetros diferentes dos descritos poderão ser acordados por escrito entre as partes.',
      ] },
      { title: 'Cláusula 5.ª · Facturação e pagamento', items: [
        'A comissão vence no final do mês correspondente ao mês de adjudicação do projecto pela Referência.',
        `O Parceiro emite factura à INUBIA pelo valor apurado, identificando a Referência a que respeita e o IBAN ${p.iban || '[IBAN]'}.`,
        'A INUBIA paga a comissão por transferência bancária contra a factura do Parceiro, para o IBAN indicado pelo Parceiro na adesão ou posteriormente comunicado por escrito.',
      ] },
      { title: 'Cláusula 6.ª · Obrigações do Parceiro', items: [
        'Apresentar as Referências de forma transparente, informando o contacto de que os seus dados serão partilhados com a INUBIA para efeitos de contacto comercial.',
        'Não assumir compromissos, preços, prazos ou condições em nome da INUBIA.',
        `Não utilizar marcas, logótipos ou materiais da INUBIA, do ${c.group} ou do Pipedrive sem autorização escrita, salvo os materiais fornecidos pela INUBIA para o programa.`,
      ] },
      { title: 'Cláusula 7.ª · Independência e não exclusividade', items: [
        'O presente contrato não constitui relação laboral, de agência, mandato, sociedade ou representação. O Parceiro não representa a INUBIA perante terceiros.',
        'Nenhuma das partes fica sujeita a exclusividade.',
      ] },
      { title: 'Cláusula 8.ª · Confidencialidade', items: [
        `As partes mantêm confidencial a informação comercial e técnica a que tenham acesso por força deste contrato, durante a sua vigência e nos ${program.confidentialityYears} anos seguintes à sua cessação.`,
      ] },
      { title: 'Cláusula 9.ª · Protecção de dados', items: [
        'As partes cumprem o Regulamento Geral sobre a Protecção de Dados. O Parceiro garante que dispõe de base legal para transmitir à INUBIA os dados de contacto das Referências.',
        'A INUBIA trata os dados das Referências exclusivamente para contacto comercial e diagnóstico, cessando o tratamento a pedido do titular.',
      ] },
      { title: 'Cláusula 10.ª · Vigência e cessação', items: [
        `O contrato vigora por ${program.termMonths} meses a contar da assinatura, renovando-se automaticamente por iguais períodos, salvo denúncia por qualquer das partes com ${program.noticeDays} dias de antecedência, por escrito.`,
        `A cessação não prejudica o pagamento das comissões relativas a Referências registadas antes da cessação e fechadas nos ${program.postTerminationMonths} meses seguintes.`,
      ] },
      { title: 'Cláusula 11.ª · Alterações ao programa', items: [
        `A INUBIA pode actualizar as condições do ${program.name}, comunicando-as por escrito ao Parceiro com ${program.noticeDays} dias de antecedência. As Referências já registadas mantêm as condições em vigor à data do registo.`,
      ] },
      { title: 'Cláusula 12.ª · Lei aplicável e foro', items: [
        `O presente contrato rege-se pela lei portuguesa. Para qualquer litígio é competente o foro da comarca de ${c.jurisdiction}, com expressa renúncia a qualquer outro.`,
      ] },
    ],
    signatures: [
      { party: 'Pela INUBIA', name: c.legalName, role: '' },
      { party: 'Pelo Parceiro', name: p.repName || p.company, role: [p.repRole, p.company].filter(Boolean).join(', ') },
    ],
    annex: { title: `Anexo I · Resumo do ${program.name} (versão ${program.version})`, items: summary(program) },
    footer: `Minuta gerada automaticamente em ${fmtDate(p.date)} para ${p.company} (adesão ao ${program.name}). Documento para revisão; só produz efeitos após assinatura de ambas as partes.`,
  };
}

function buildContractPdf(partnerInput, program = PROGRAM) {
  const s = contractSections(partnerInput, program);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ bufferPages: true, size: 'A4', margins: { top: 56, bottom: 64, left: 56, right: 56 }, info: { Title: s.title, Author: `${program.company.brand} · ${program.company.group}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width, L = doc.page.margins.left, R = W - doc.page.margins.right, CW = R - L;

    // Header band on the first page (navy with the white logo).
    doc.rect(0, 0, W, 92).fill(NAVY);
    if (fs.existsSync(LOGO)) doc.image(LOGO, L, 30, { height: 26 });
    doc.fillColor('#B8C4DA').font('Helvetica').fontSize(9).text(`${program.company.group} · ${program.company.positioning}`, L, 64, { width: CW });
    doc.fillColor(INK);
    doc.y = 118;

    doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY).text(s.title, { width: CW });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(s.subtitle, { width: CW });
    doc.moveDown(1);

    const para = (t, opts = {}) => { doc.font('Helvetica').fontSize(10).fillColor(INK).text(t, { width: CW, align: 'justify', lineGap: 2, ...opts }); doc.moveDown(0.5); };
    const heading = (t) => { if (doc.y > doc.page.height - 140) doc.addPage(); doc.moveDown(0.3); doc.font('Helvetica-Bold').fontSize(11).fillColor(BLUE).text(t, { width: CW }); doc.moveDown(0.3); };

    heading('Entre');
    s.parties.forEach((t) => para(t));
    heading('Considerando que');
    s.recitals.forEach((t, i) => para(`${String.fromCharCode(97 + i)}) ${t}`));
    s.clauses.forEach((cl) => {
      heading(cl.title);
      cl.items.forEach((t, i) => para(cl.items.length > 1 ? `${i + 1}. ${t}` : t));
    });

    // Signatures
    if (doc.y > doc.page.height - 200) doc.addPage();
    doc.moveDown(1);
    heading(`Feito em duplicado, em ${program.company.jurisdiction}, a ${fmtDate(s.partner.date)}`);
    const colW = (CW - 24) / 2;
    const y0 = doc.y + 40;
    s.signatures.forEach((sig, i) => {
      const x = L + i * (colW + 24);
      doc.moveTo(x, y0).lineTo(x + colW, y0).strokeColor('#9aa5b5').lineWidth(0.8).stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(sig.party, x, y0 + 6, { width: colW });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text([sig.name, sig.role].filter(Boolean).join(' · '), x, y0 + 20, { width: colW });
    });
    doc.y = y0 + 60;

    // Annex
    doc.addPage();
    heading(s.annex.title);
    s.annex.items.forEach((t) => para(`• ${t}`, { indent: 0 }));
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(s.footer, { width: CW, align: 'left' });

    // Page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // writing inside the bottom margin must not open a new page
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`${program.company.brand} · ${program.name} · ${i + 1}/${range.count}`, L, doc.page.height - 40, { width: CW, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { contractSections, buildContractPdf, normalizePartner };
