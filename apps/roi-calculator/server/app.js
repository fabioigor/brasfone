'use strict';
/**
 * ROI calculators backend (agencies + companies).
 * Serves the static pages and exposes POST /api/roi-leads, which:
 *   1. creates/updates Organization + Person + Deal + Note in Pipedrive (API token),
 *   2. emails the ROI report (plus partner plan or next steps) to the contact.
 * Set DRY_RUN=1, or leave the credentials empty, to log instead of calling Pipedrive/SMTP.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');
const { buildReportHtml, buildNoteHtml } = require('./report');

const DRY_RUN = process.env.DRY_RUN === '1';
const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PD_DOMAIN = process.env.PIPEDRIVE_COMPANY_DOMAIN; // e.g. "inubia" -> https://inubia.pipedrive.com
const PD_BASE = `https://${PD_DOMAIN || 'api'}.pipedrive.com/api/v1`;
const PD_PIPELINE_ID = process.env.PIPEDRIVE_PIPELINE_ID ? Number(process.env.PIPEDRIVE_PIPELINE_ID) : undefined;
const PD_STAGE_ID = process.env.PIPEDRIVE_STAGE_ID ? Number(process.env.PIPEDRIVE_STAGE_ID) : undefined;
const PD_OWNER_ID = process.env.PIPEDRIVE_OWNER_ID ? Number(process.env.PIPEDRIVE_OWNER_ID) : undefined;
const PD_LABEL_ORG = process.env.PIPEDRIVE_ORG_LABEL_ID ? Number(process.env.PIPEDRIVE_ORG_LABEL_ID) : undefined;
const MAIL_FROM = process.env.MAIL_FROM || 'INUBIA <parcerias@inubia.pt>';
const MAIL_CC = process.env.MAIL_CC || '';
const PARTNER_PLAN_URL = process.env.PARTNER_PLAN_URL || '';

const KINDS = {
  agency: { dealTitle: (name) => `Parceria INUBIA · ${name}`, subject: (name) => `Relatório de ROI da parceria INUBIA para ${name} e plano de parceiros` },
  company: { dealTitle: (name) => `Pipedrive + CAPI · ${name}`, subject: (name) => `Relatório de ROI Pipedrive + Meta CAPI para ${name}` },
};

const app = express();
app.use(express.json({ limit: '300kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => res.json({ ok: true, dryRun: DRY_RUN, pipedrive: !DRY_RUN && !!PD_TOKEN, email: !DRY_RUN && !!process.env.SMTP_HOST }));

// ---------- Pipedrive ----------
async function pd(method, endpoint, body) {
  const url = `${PD_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(PD_TOKEN)}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`Pipedrive ${method} ${endpoint}: ${res.status} ${json.error || ''} ${json.error_info || ''}`.trim());
  }
  return json.data;
}

async function findOrCreateOrganization(name) {
  const found = await pd('GET', `/organizations/search?term=${encodeURIComponent(name)}&fields=name&exact_match=true&limit=1`);
  const hit = found && found.items && found.items[0] && found.items[0].item;
  if (hit) return hit.id;
  const body = { name };
  if (PD_OWNER_ID) body.owner_id = PD_OWNER_ID;
  if (PD_LABEL_ORG) body.label = PD_LABEL_ORG;
  const org = await pd('POST', '/organizations', body);
  return org.id;
}

async function findOrCreatePerson({ name, email, phone, orgId }) {
  const found = await pd('GET', `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true&limit=1`);
  const hit = found && found.items && found.items[0] && found.items[0].item;
  if (hit) {
    // Keep the person linked to the organisation and make sure the phone is stored.
    await pd('PUT', `/persons/${hit.id}`, { org_id: orgId, phone: [{ value: phone, primary: true, label: 'work' }] });
    return hit.id;
  }
  const body = {
    name, org_id: orgId,
    email: [{ value: email, primary: true, label: 'work' }],
    phone: [{ value: phone, primary: true, label: 'work' }],
  };
  if (PD_OWNER_ID) body.owner_id = PD_OWNER_ID;
  const person = await pd('POST', '/persons', body);
  return person.id;
}

async function createDeal({ title, orgId, personId, value }) {
  const body = { title, org_id: orgId, person_id: personId, value: Math.round(value), currency: 'EUR' };
  if (PD_PIPELINE_ID) body.pipeline_id = PD_PIPELINE_ID;
  if (PD_STAGE_ID) body.stage_id = PD_STAGE_ID;
  if (PD_OWNER_ID) body.user_id = PD_OWNER_ID;
  return pd('POST', '/deals', body);
}

// ---------- Email ----------
function mailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

// ---------- Validation ----------
function validate(body) {
  const errors = [];
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const kind = KINDS[body.kind] ? body.kind : null;
  const name = s(body.name), contact = s(body.contact), phone = s(body.phone), email = s(body.email);
  if (!kind) errors.push('kind');
  if (name.length < 2 || name.length > 120) errors.push('name');
  if (contact.length < 2 || contact.length > 120) errors.push('contact');
  if (!/^[+\d][\d\s().-]{6,}$/.test(phone) || phone.length > 30) errors.push('phone');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) errors.push('email');
  if (!body.report || typeof body.report !== 'object') errors.push('report');
  const dealValue = Number(body.dealValue);
  return { errors, kind, name, contact, phone, email, dealValue: Number.isFinite(dealValue) && dealValue >= 0 ? dealValue : 0 };
}

// ---------- Endpoint ----------
app.post('/api/roi-leads', async (req, res) => {
  const v = validate(req.body || {});
  if (v.errors.length) return res.status(400).json({ ok: false, error: `Campos inválidos: ${v.errors.join(', ')}` });
  const { kind, name, contact, phone, email, dealValue } = v;
  const { report, source } = req.body;
  const reportHtml = buildReportHtml({ kind, name, contact, report, partnerPlanUrl: PARTNER_PLAN_URL });
  const noteHtml = buildNoteHtml({ kind, name, contact, phone, email, report, source });

  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const dryRun = DRY_RUN || !PD_TOKEN;
  let dealUrl = null;

  try {
    if (dryRun) {
      log('[DRY_RUN] Pipedrive:', kind, 'org/person/deal/note for', name, contact, email, phone, 'value', dealValue);
    } else {
      const orgId = await findOrCreateOrganization(name);
      const personId = await findOrCreatePerson({ name: contact, email, phone, orgId });
      const deal = await createDeal({ title: KINDS[kind].dealTitle(name), orgId, personId, value: dealValue });
      await pd('POST', '/notes', { content: noteHtml, deal_id: deal.id, person_id: personId, org_id: orgId, pinned_to_deal_flag: 1 });
      dealUrl = PD_DOMAIN ? `https://${PD_DOMAIN}.pipedrive.com/deal/${deal.id}` : null;
      log('Pipedrive deal created', deal.id, 'for', name);
    }
  } catch (err) {
    log('Pipedrive error', err.message);
    return res.status(502).json({ ok: false, error: 'Falha ao criar o contacto no Pipedrive' });
  }

  let emailSent = false;
  try {
    const transport = DRY_RUN ? null : mailer();
    if (!transport) {
      log('[DRY_RUN] Email to', email, 'subject:', KINDS[kind].subject(name), '| html bytes', reportHtml.length);
    } else {
      await transport.sendMail({
        from: MAIL_FROM, to: `${contact} <${email}>`, cc: MAIL_CC || undefined,
        subject: KINDS[kind].subject(name),
        html: reportHtml,
      });
      emailSent = true;
      log('Email sent to', email);
    }
  } catch (err) {
    log('Email error', err.message);
    return res.status(502).json({ ok: false, error: 'Contacto criado no Pipedrive, mas o email não foi enviado' });
  }

  res.json({ ok: true, dealUrl, dryRun, emailSent });
});

module.exports = app;
