'use strict';
/**
 * Canonical conditions of the INUBIA partner (referral) programme, version 2026-09.
 * Used by the contract draft, the welcome email, the Pipedrive note and the tests.
 * Legal identification of the INUBIA entity comes from the environment so that the
 * repository never carries it; placeholders make it obvious when it is missing.
 */
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;

const PROGRAM = {
  version: '2026-09',
  name: 'Programa de Parceiros INUBIA',
  fee: 500,                 // € + IVA por referência fechada
  minDeal: 5000,            // € + IVA, valor mínimo de adjudicação
  contactHours: 24,         // horas úteis para o primeiro contacto
  recommendedReferrals: 3,
  validationDays: 5,        // dias úteis para confirmar a validade de uma referência
  closingWindowMonths: 12,  // prazo para a referência fechar depois do registo
  quarantineMonths: 6,      // meses sem negociação activa/cliente para a referência ser válida
  termMonths: 12,
  noticeDays: 30,
  postTerminationMonths: 6, // comissões ainda devidas depois da cessação
  confidentialityYears: 2,
  company: {
    brand: 'INUBIA',
    group: 'Grupo Brasfone',
    legalName: env('PARTNER_COMPANY_LEGAL', '[Denominação social da INUBIA]'),
    nif: env('PARTNER_COMPANY_NIF', '[NIF]'),
    address: env('PARTNER_COMPANY_ADDRESS', '[Sede], Faro'),
    email: env('PARTNER_EMAIL', 'parcerias@inubia.pt'),
    website: 'inubia.pt',
    jurisdiction: env('PARTNER_JURISDICTION', 'Faro'),
    offices: 'Faro, Vila do Conde e Barcelona',
    positioning: 'maior Pipedrive Platinum Partner de Portugal e Espanha',
  },
};

/** 5000 -> "5.000 €" (pt-PT Intl leaves four-digit numbers ungrouped, which reads badly in a contract). */
const eur = (v) => `${Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;

/** Short bullet summary shown on the form page, in the email and in the annex of the contract. */
function summary(p = PROGRAM) {
  return [
    `Comissão de ${eur(p.fee)} + IVA por cada referência fechada.`,
    `Referência fechada: a empresa apresentada adjudica à INUBIA um projecto (implementação, integração, serviços e subscrições contratadas através da INUBIA) de valor igual ou superior a ${eur(p.minDeal)} + IVA, no prazo de ${p.closingWindowMonths} meses após o registo.`,
    `A INUBIA contacta a referência no máximo em ${p.contactHours} horas úteis e confirma a sua validade em ${p.validationDays} dias úteis.`,
    `Recomendamos pelo menos ${p.recommendedReferrals} referências; não há máximo.`,
    'Pagamento no final do mês correspondente à adjudicação, contra factura do parceiro com o IBAN indicado na adesão.',
    'A INUBIA reserva-se o direito de não apresentar proposta quando entender que não pode ajudar a referência.',
    `Vigência de ${p.termMonths} meses, renovável, sem exclusividade; denúncia com ${p.noticeDays} dias de aviso.`,
  ];
}

module.exports = { PROGRAM, summary, eur };
