import express, { Request, Response } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Db, audit } from "./db.js";
import { listSettings, saveSettings } from "./settings.js";
import { domainStatus, normaliseDomain, writeDomain, configDirPending } from "./domainSetup.js";
import Anthropic from "@anthropic-ai/sdk";
import { Microsoft365Client, OneDriveSync } from "./integrations/microsoft365.js";
import { GraphMailPoller } from "./channels/graphMail.js";

/** Version from package.json, exposed in /health to confirm which build is running after an update. */
const APP_VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const p of [path.join(here, "..", "package.json"), path.join(process.cwd(), "package.json")]) {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")).version ?? "0.0.0";
    }
  } catch { /* sem package.json: versao desconhecida */ }
  return "0.0.0";
})();
import {
  authenticate,
  requireStaff,
  issueToken,
  verifyPassword,
  hashPassword,
  scopedCompanyId,
  issuePreviewToken,
  verifyPreviewToken,
} from "./auth.js";
import { AiProvider } from "./ai/provider.js";
import { ingestDocument, reprocessDocument, applyIntakeAnswers } from "./pipeline.js";
import { SupplierDiscovery } from "./integrations/supplierDiscovery.js";
import { parseEFaturaExport, importEFatura, reconcileEFatura, efaturaSummary, notCommunicated, buildNotification } from "./integrations/efatura.js";
import { Microsoft365Files } from "./integrations/microsoft365.js";
import { IntakeDialog, DOC_TYPE_OPTIONS } from "./channels/dialog.js";
import { getProfile, isKnownSupplier, counterpartyNif } from "./domain/supplierMemory.js";
import { applyCostCenter } from "./domain/entries.js";
import { transitionFinding, findingMetrics, listFpReasons, blockingFindings, SEVERITY_LABEL } from "./domain/exceptions.js";
import { listParameters, addParameterVersion, PARAMETER_DEFS } from "./domain/parameters.js";
import { DocType } from "./domain/classification.js";
import { OcrEngine, DocumentOcr } from "./ocr/engine.js";
import { ClaudeStructuredExtractor } from "./extraction/structured.js";
import { buildStructuredExtractor } from "./extraction/analyse.js";
import { learnFromApproval } from "./domain/supplierMemory.js";
import { processInbound, confirmationText, InboundDeps, normaliseAddress } from "./channels/inbound.js";
import { parseInboundEmailJson, parseRawEmail } from "./channels/email.js";
import {
  WhatsAppConfig, WhatsAppClient, whatsappConfigFromEnv, verifyMetaSignature, parseWhatsAppPayload, toInboundMessage,
} from "./channels/whatsapp.js";
import { exportApprovedEntries } from "./domain/exportPrimavera.js";
import { upcomingObligations } from "./domain/obligations.js";
import { parseGestObrigExport, importObligations, obligationsSummary, parseAccessExport } from "./integrations/gestobrig.js";
import { ENTITIES, listCredentials, saveCredential, revealCredential, deleteCredential, importCredentials } from "./domain/credentials.js";
import { EntryLine, isBalanced } from "./domain/entries.js";
import { CentralGestClient, dispatchApprovedEntries, CentralGestError } from "./integrations/centralgest.js";
import { auditStoredDocument } from "./domain/vatAudit.js";
import {
  parseBalanceCsv,
  deriveBalanceFromEntries,
  saveTrialBalance,
  loadTrialBalance,
  previousPeriod,
  computeFinancials,
} from "./domain/trialBalance.js";
import { listRules, evaluateRules, persistBalanceFindings } from "./domain/balanceRules.js";
import { buildReportData } from "./domain/financialReport.js";
import { renderReportHtml } from "./domain/reportHtml.js";
import { knowledgeStatus, loadVatRules, loadSectorBenchmarks } from "./knowledge/index.js";
import { AgentGateway } from "./ai/agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  db: Db;
  provider: AiProvider;
  storageRoot: string;
  centralgest?: CentralGestClient | null;
  agents?: AgentGateway;
  ocr?: OcrEngine;
  structured?: ClaudeStructuredExtractor | null;
  /** Shared secret for POST /api/inbound/email (header x-contai-secret). */
  inboundEmailSecret?: string | null;
  whatsapp?: WhatsAppConfig | null;
  /** Injected for tests (media download / replies). */
  whatsappFetch?: typeof fetch;
  /** Demo accounts are seeded: the login page may show their credentials. */
  demo?: boolean;
  /** Called after integration settings are saved; production restarts the process so every component reloads. */
  onSettingsSaved?: (() => void) | null;
  /** OneDrive archive worker (null when Microsoft 365 is not configured). */
  onedrive?: OneDriveSync | null;
  /** Supplier discovery by NIF (VIES + AI web search); built from `agents` and `whatsappFetch` when omitted. */
  discovery?: SupplierDiscovery | null;
  /** Reception dialog (WhatsApp questions); built when the WhatsApp config has `ask`. */
  dialog?: IntakeDialog | null;
  /** Outbound email (Microsoft Graph Mail.Send); defaults to the OneDrive client's files helper when present. */
  mailer?: Pick<Microsoft365Files, "sendMail"> | null;
  /** Mailbox that sends notifications (default MS365_MAIL_USER, then MS365_DRIVE_USER). */
  mailFrom?: string | null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

export function createServer({
  db, provider, storageRoot, centralgest = null, agents = new AgentGateway(), ocr = DocumentOcr.fromEnv(),
  structured = buildStructuredExtractor(),
  inboundEmailSecret = process.env.INBOUND_EMAIL_SECRET ?? null,
  whatsapp = whatsappConfigFromEnv(),
  whatsappFetch = fetch,
  demo = false,
  onSettingsSaved = null,
  onedrive = null,
  discovery = null,
  dialog = null,
  mailer = null,
  mailFrom = null,
}: ServerOptions): express.Express {
  const app = express();
  const mailSender = mailer ?? (onedrive ? onedrive.files : null);
  const mailSenderFrom = (): string | null => mailFrom || process.env.MS365_MAIL_USER || process.env.MS365_DRIVE_USER || null;
  const discoveryService = discovery ?? new SupplierDiscovery(db, { fetchImpl: whatsappFetch, agent: agents });
  const intake = dialog ?? (whatsapp?.ask ? new IntakeDialog(db) : null);
  const DOC_TYPES = new Set<string>(DOC_TYPE_OPTIONS.map((o) => o.key).concat(["guia_transporte"]));
  // Raw body is needed to validate the Meta signature; keep it for webhooks only.
  app.use(express.json({ limit: "25mb", verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

  // Service user that owns channel intakes (created lazily).
  const systemUserId = (): number => {
    const row = db.prepare("SELECT id FROM users WHERE email = 'canais@contai.local'").get() as any;
    if (row) return row.id;
    const r = db
      .prepare("INSERT INTO users (email, name, password_hash, role, company_id) VALUES ('canais@contai.local', 'Recepção automática', 'x', 'staff', NULL)")
      .run();
    return Number(r.lastInsertRowid);
  };
  const inboundDeps = (): InboundDeps => ({ provider, ocr, structured, storageRoot, systemUserId: systemUserId() });

  const auth = authenticate(db);

  app.get("/health", (_req, res) => res.json({ status: "ok", version: APP_VERSION }));

  // Estado do sistema (versao, ultimo deploy, registo da actualizacao automatica) para o gabinete.
  const startedAt = new Date().toISOString();
  app.get("/api/system", auth, requireStaff, (_req, res) => {
    const dir = process.env.CONTAI_SYSTEM_LOG_DIR || "";
    const read = (name: string): string | null => { try { return dir ? fs.readFileSync(path.join(dir, name), "utf8") : null; } catch { return null; } };
    let deploy: any = null; try { deploy = JSON.parse(read("deploy.json") || "null"); } catch { deploy = null; }
    const log = (read("autoupdate.log") || "").trim().split("\n").filter(Boolean).slice(-40);
    const lastCheck = (read("last-check") || "").trim() || null;
    return res.json({ version: APP_VERSION, startedAt, node: process.version, deploy, lastCheck, autoupdateLog: log, autoupdate: !!dir });
  });

  // Digital Asset Links: liga a app Android (Trusted Web Activity) a este dominio.
  app.get("/.well-known/assetlinks.json", (_req, res) => {
    const pkg = (process.env.ANDROID_PACKAGE || "pt.lumarcont.contai").trim();
    const fps = (process.env.ANDROID_SHA256_FINGERPRINTS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!fps.length) return res.status(404).json({ error: "Sem impressões SHA-256 configuradas (Configuração > Integrações > Aplicação Android)." });
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fps } }]);
  });
  // Sem service worker activo, a partilha do Android cai aqui: abre a digitalizacao.
  app.all("/share-target", (_req, res) => res.redirect(303, "/#digitalizar"));
  // Public, non-sensitive settings needed before login.
  app.get("/api/public-config", (_req, res) => res.json({ demo, brand: "Cont.ai by Lumarcont" }));

  // ---------- Autenticacao ----------
  app.post("/api/auth/login", (req: Request, res: Response) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Credenciais em falta." });
    const row = db
      .prepare("SELECT id, email, name, password_hash, role, company_id, profile FROM users WHERE email = ?")
      .get(body.data.email.toLowerCase()) as any;
    if (!row || !verifyPassword(body.data.password, row.password_hash)) {
      return res.status(401).json({ error: "Email ou palavra-passe incorrectos." });
    }
    const user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      companyId: row.company_id,
      profile: row.profile ?? (row.role === "staff" ? "toc" : null),
    };
    audit(db, row.id, "login", "user", row.id);
    return res.json({ token: issueToken(user), user });
  });

  app.get("/api/me", auth, (req, res) => res.json({ user: req.user }));

  app.post("/api/auth/password", auth, (req, res) => {
    const body = z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "A nova palavra-passe tem de ter pelo menos 10 caracteres." });
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user!.id) as any;
    if (!row || !verifyPassword(body.data.current, row.password_hash)) {
      return res.status(401).json({ error: "A palavra-passe actual não está correcta." });
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(body.data.next), req.user!.id);
    audit(db, req.user!.id, "password_change", "user", req.user!.id);
    return res.json({ ok: true });
  });

  // ---------- Empresas (clientes do gabinete) ----------
  app.get("/api/companies", auth, (req, res) => {
    if (req.user!.role === "client") {
      const rows = db.prepare("SELECT * FROM companies WHERE id = ?").all(req.user!.companyId);
      return res.json({ companies: rows });
    }
    const rows = db.prepare("SELECT * FROM companies ORDER BY name").all();
    return res.json({ companies: rows });
  });

  app.post("/api/companies", auth, requireStaff, (req, res) => {
    const body = z
      .object({
        name: z.string().min(2),
        nif: z.string().regex(/^\d{9}$/),
        vat_regime: z.enum(["mensal", "trimestral"]).default("trimestral"),
        activity: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos.", details: body.error.issues });
    try {
      const r = db
        .prepare("INSERT INTO companies (name, nif, vat_regime, activity) VALUES (?, ?, ?, ?)")
        .run(body.data.name, body.data.nif, body.data.vat_regime, body.data.activity ?? null);
      audit(db, req.user!.id, "create", "company", Number(r.lastInsertRowid));
      return res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "Já existe uma empresa com esse NIF." });
      }
      throw e;
    }
  });

  app.post("/api/companies/:id/users", auth, requireStaff, (req, res) => {
    const companyId = Number(req.params.id);
    const body = z
      .object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8) })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos.", details: body.error.issues });
    const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId);
    if (!company) return res.status(404).json({ error: "Empresa inexistente." });
    try {
      const r = db
        .prepare("INSERT INTO users (email, name, password_hash, role, company_id) VALUES (?, ?, ?, 'client', ?)")
        .run(body.data.email.toLowerCase(), body.data.name, hashPassword(body.data.password), companyId);
      audit(db, req.user!.id, "create", "user", Number(r.lastInsertRowid));
      return res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "Já existe um utilizador com esse email." });
      }
      throw e;
    }
  });

  // ---------- Equipa do gabinete (contas staff) ----------
  app.get("/api/users", auth, requireStaff, (_req, res) => {
    const rows = db.prepare("SELECT id, email, name, role, company_id, profile, created_at FROM users WHERE email NOT IN ('canais@contai.local', 'mcp@contai.local') ORDER BY role, name").all();
    return res.json({ users: rows });
  });

  app.post("/api/users", auth, requireStaff, (req, res) => {
    const body = z.object({ name: z.string().trim().min(2), email: z.string().email(), password: z.string().min(8), profile: z.enum(["contabilista", "coordenador", "toc"]).default("contabilista"), company_ids: z.array(z.number().int()).optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos (nome, email e palavra-passe com 8 ou mais caracteres)." });
    if ((req.user!.profile ?? "toc") === "contabilista") return res.status(403).json({ error: "Só o coordenador ou o TOC responsável criam contas do gabinete." });
    try {
      const r = db.prepare("INSERT INTO users (email, name, password_hash, role, company_id, profile) VALUES (?, ?, ?, 'staff', NULL, ?)").run(body.data.email.toLowerCase(), body.data.name, hashPassword(body.data.password), body.data.profile);
      for (const cid of body.data.company_ids ?? []) db.prepare("INSERT OR IGNORE INTO company_assignments (user_id, company_id) VALUES (?, ?)").run(Number(r.lastInsertRowid), cid);
      audit(db, req.user!.id, "create_staff", "user", Number(r.lastInsertRowid), body.data.email.toLowerCase());
      return res.status(201).json({ id: Number(r.lastInsertRowid), email: body.data.email.toLowerCase(), role: "staff" });
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Já existe um utilizador com esse email." });
      throw e;
    }
  });

  app.delete("/api/users/:id", auth, requireStaff, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user!.id) return res.status(400).json({ error: "Não pode apagar a sua própria conta." });
    const u = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as any;
    if (!u) return res.status(404).json({ error: "Utilizador inexistente." });
    if (u.role === "staff" && (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'staff' AND email != 'canais@contai.local'").get() as any).n <= 1) return res.status(400).json({ error: "Tem de ficar pelo menos uma conta de gabinete." });
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    audit(db, req.user!.id, "delete", "user", id);
    return res.json({ ok: true });
  });

  // ---------- Documentos ----------
  app.post("/api/documents", auth, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Ficheiro em falta (campo 'file')." });
    const requestedCompany = req.body.company_id ? Number(req.body.company_id) : null;
    const companyId = scopedCompanyId(req, requestedCompany);
    if (!companyId || companyId < 1) {
      return res.status(400).json({ error: "Empresa em falta." });
    }
    if (req.user!.role === "client" && companyId !== req.user!.companyId) {
      return res.status(403).json({ error: "Sem acesso a essa empresa." });
    }
    const requestId = req.body.request_id ? Number(req.body.request_id) : null;
    const costCenterId = req.body.cost_center_id ? Number(req.body.cost_center_id) : null;
    if (costCenterId && !db.prepare("SELECT id FROM cost_centers WHERE id = ? AND company_id = ? AND active = 1").get(costCenterId, companyId)) {
      return res.status(400).json({ error: "Centro de custo inexistente nesta empresa." });
    }
    const declaredType = typeof req.body.doc_type === "string" && req.body.doc_type ? req.body.doc_type : null;
    if (declaredType && !DOC_TYPES.has(declaredType)) return res.status(400).json({ error: "Tipo de documento desconhecido." });
    const outcome = await ingestDocument(db, provider, storageRoot, {
      companyId,
      uploaderId: req.user!.id,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype || "application/octet-stream",
      buffer: req.file.buffer,
      channel: "portal",
      requestId,
      costCenterId,
      clientDocType: declaredType as DocType | null,
    }, ocr, structured);
    if (onedrive && !outcome.duplicate) setTimeout(() => { onedrive.syncPending().catch(() => {}); }, 500);
    return res.status(outcome.duplicate ? 200 : 201).json(outcome);
  });

  /** Returns an inline preview URL valid for 20 minutes (for iframe/img). */
  app.get("/api/documents/:id/preview-url", auth, (req, res) => {
    const doc = db.prepare("SELECT id, company_id, mime_type, original_name FROM documents WHERE id = ?").get(Number(req.params.id)) as any;
    if (!doc) return res.status(404).json({ error: "Documento inexistente." });
    if (req.user!.role === "client" && doc.company_id !== req.user!.companyId) return res.status(403).json({ error: "Sem acesso." });
    const token = issuePreviewToken(doc.id, req.user!.id);
    const kind = /pdf/i.test(doc.mime_type) || /\.pdf$/i.test(doc.original_name) ? "pdf" : /^image\//i.test(doc.mime_type) || /\.(png|jpe?g|webp|gif)$/i.test(doc.original_name) ? "image" : "text";
    return res.json({ url: `/api/documents/${doc.id}/preview?t=${encodeURIComponent(token)}`, kind, name: doc.original_name });
  });

  app.get("/api/documents/:id/preview", (req, res) => {
    const id = Number(req.params.id);
    const token = typeof req.query.t === "string" ? req.query.t : "";
    if (!verifyPreviewToken(token, id)) return res.status(401).json({ error: "Pré-visualização expirada. Recarregue a página." });
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as any;
    if (!doc) return res.status(404).json({ error: "Documento inexistente." });
    const abs = path.join(storageRoot, doc.stored_path);
    if (!fs.existsSync(abs)) return res.status(410).json({ error: "Ficheiro já não existe." });
    const isText = /^text\//i.test(doc.mime_type) || /\.(txt|csv|xml|json)$/i.test(doc.original_name);
    res.setHeader("Content-Type", isText ? "text/plain; charset=utf-8" : doc.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${doc.original_name.replace(/"/g, "")}"`);
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.send(fs.readFileSync(abs));
  });

  app.post("/api/documents/:id/reprocess", auth, requireStaff, async (req, res) => {
    const doc = db.prepare("SELECT id FROM documents WHERE id = ?").get(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: "Documento inexistente." });
    const outcome = await reprocessDocument(db, provider, storageRoot, Number(req.params.id), ocr, structured);
    return res.json(outcome);
  });

  app.get("/api/documents/:id/text", auth, (req, res) => {
    const doc = db.prepare("SELECT company_id, ocr_text, ocr_method, ocr_confidence, extracted_json FROM documents WHERE id = ?").get(Number(req.params.id)) as any;
    if (!doc) return res.status(404).json({ error: "Documento inexistente." });
    if (req.user!.role === "client" && doc.company_id !== req.user!.companyId) return res.status(403).json({ error: "Sem acesso." });
    return res.json({ text: doc.ocr_text, method: doc.ocr_method, confidence: doc.ocr_confidence, extracted: doc.extracted_json ? JSON.parse(doc.extracted_json) : null });
  });

  app.get("/api/documents", auth, (req, res) => {
    const requested = req.query.company_id ? Number(req.query.company_id) : null;
    const companyId = scopedCompanyId(req, requested);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    let sql =
      "SELECT d.*, c.name AS company_name FROM documents d JOIN companies c ON c.id = d.company_id WHERE 1=1";
    const params: any[] = [];
    if (companyId !== null) {
      sql += " AND d.company_id = ?";
      params.push(companyId);
    }
    if (status) {
      sql += " AND d.status = ?";
      params.push(status);
    }
    sql += " ORDER BY d.created_at DESC LIMIT 200";
    return res.json({ documents: db.prepare(sql).all(...params) });
  });

  app.get("/api/documents/:id/file", auth, (req, res) => {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(Number(req.params.id)) as any;
    if (!doc) return res.status(404).json({ error: "Documento inexistente." });
    if (req.user!.role === "client" && doc.company_id !== req.user!.companyId) {
      return res.status(403).json({ error: "Sem acesso." });
    }
    const abs = path.join(storageRoot, doc.stored_path);
    if (!fs.existsSync(abs)) return res.status(410).json({ error: "Ficheiro já não existe." });
    audit(db, req.user!.id, "download", "document", doc.id);
    res.setHeader("Content-Type", doc.mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.original_name.replace(/"/g, "")}"`);
    return res.send(fs.readFileSync(abs));
  });

  // ---------- Fila de validação (lancamentos) ----------
  app.get("/api/entries", auth, requireStaff, (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pendente";
    const rows = db
      .prepare(
        `SELECT e.*, d.original_name, d.doc_type, d.extracted_json, d.ocr_method, d.ocr_confidence, c.name AS company_name
         FROM entries e
         JOIN documents d ON d.id = e.document_id
         JOIN companies c ON c.id = e.company_id
         WHERE e.status = ? ORDER BY e.created_at LIMIT 200`
      )
      .all(status) as any[];
    const companyNif = new Map<number, string>(); const ccByCompany = new Map<number, any[]>();
    const supplierInfo = (companyId: number, extracted: any) => {
      if (!companyNif.has(companyId)) companyNif.set(companyId, ((db.prepare("SELECT nif FROM companies WHERE id = ?").get(companyId) as any)?.nif) ?? "");
      const nif = extracted ? counterpartyNif(extracted, companyNif.get(companyId)!) : null;
      if (!nif) return null;
      const p = getProfile(db, companyId, nif);
      const ccs = p ? (db.prepare("SELECT c.id, c.code, c.name FROM supplier_cost_centers s JOIN cost_centers c ON c.id = s.cost_center_id WHERE s.supplier_id = ? ORDER BY c.code").all(p.id) as any[]) : [];
      return { nif, known: isKnownSupplier(p), registered: !!p?.registeredAt, name: p?.name ?? extracted?.issuerName ?? null, brand: p?.brand ?? null, expense_account: p?.expenseAccount ?? null, doc_count: p?.docCount ?? 0, default_cost_center_id: p?.defaultCostCenterId ?? null, cost_centers: ccs };
    };
    const costCenters = (companyId: number) => {
      if (!ccByCompany.has(companyId)) ccByCompany.set(companyId, db.prepare("SELECT id, code, name FROM cost_centers WHERE company_id = ? AND active = 1 ORDER BY code").all(companyId) as any[]);
      return ccByCompany.get(companyId)!;
    };
    return res.json({
      entries: rows.map((r) => {
        let sources: string[] = [];
        let extracted: any = null;
        try { extracted = JSON.parse(r.extracted_json || "null"); sources = extracted?.sources || []; } catch { /* ignore */ }
        const docMeta = db.prepare("SELECT cost_center_id, client_doc_type FROM documents WHERE id = ?").get(r.document_id) as any;
        return { ...r, lines: JSON.parse(r.lines_json), lines_json: undefined, extracted_json: undefined, sources, extracted, supplier: supplierInfo(r.company_id, extracted), cost_centers: costCenters(r.company_id), document_cost_center_id: docMeta?.cost_center_id ?? null, client_doc_type: docMeta?.client_doc_type ?? null };
      }),
    });
  });

  const decisionSchema = z.object({
    action: z.enum(["aprovar", "rejeitar"]),
    reason: z.string().optional(),
    lines: z
      .array(
        z.object({
          account: z.string().min(1),
          description: z.string(),
          debit: z.number().min(0),
          credit: z.number().min(0),
          cost_center: z.string().max(40).nullable().optional(),
        })
      )
      .optional(),
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    description: z.string().optional(),
    override_reason: z.string().max(500).optional(),
  });

  app.post("/api/entries/:id/decision", auth, requireStaff, (req, res) => {
    const body = decisionSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Pedido inválido.", details: body.error.issues });
    const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(Number(req.params.id)) as any;
    if (!entry) return res.status(404).json({ error: "Lançamento inexistente." });
    if (entry.status !== "pendente") {
      return res.status(409).json({ error: `Lançamento já decidido (${entry.status}).` });
    }

    if (body.data.action === "rejeitar") {
      if (!body.data.reason?.trim()) {
        return res.status(400).json({ error: "A rejeição exige um motivo." });
      }
      db.prepare(
        "UPDATE entries SET status = 'rejeitado', reviewed_by = ?, reviewed_at = datetime('now'), rejection_reason = ? WHERE id = ?"
      ).run(req.user!.id, body.data.reason.trim(), entry.id);
      db.prepare("UPDATE documents SET status = 'rejeitado' WHERE id = ?").run(entry.document_id);
      audit(db, req.user!.id, "reject", "entry", entry.id, body.data.reason.trim());
      return res.json({ status: "rejeitado" });
    }

    // Aprovar: alertas bloqueantes abertos exigem justificação (ficam 'aceite' com a nota do revisor).
    const blocking = blockingFindings(db, entry.document_id);
    if (blocking.length) {
      const justification = (body.data.override_reason ?? "").trim();
      if (!justification) return res.status(409).json({ error: "O documento tem alertas bloqueantes abertos. Corrija-os na Conferência ou indique uma justificação para aprovar mesmo assim.", blocking });
      for (const b of blocking) transitionFinding(db, b.id, { id: req.user!.id, profile: req.user!.profile ?? null }, { status: "aceite", note: `Aprovação com justificação: ${justification}` });
    }
    // Aprovar, com edicao opcional das linhas.
    let lines: EntryLine[] = JSON.parse(entry.lines_json);
    if (body.data.lines) {
      const validCodes = new Set((db.prepare("SELECT code FROM cost_centers WHERE company_id = ?").all(entry.company_id) as any[]).map((c) => c.code));
      lines = body.data.lines.map((l) => ({ account: l.account, description: l.description, debit: l.debit, credit: l.credit, costCenter: l.cost_center && validCodes.has(l.cost_center) ? l.cost_center : null }));
      if (body.data.lines.some((l) => l.cost_center && !validCodes.has(l.cost_center))) return res.status(400).json({ error: "Centro de custo desconhecido nesta empresa." });
      if (!isBalanced(lines)) {
        return res.status(400).json({ error: "As linhas editadas não estão balanceadas (débito != crédito)." });
      }
    }
    db.prepare(
      `UPDATE entries SET status = 'aprovado', reviewed_by = ?, reviewed_at = datetime('now'),
        lines_json = ?, entry_date = COALESCE(?, entry_date), description = COALESCE(?, description)
       WHERE id = ?`
    ).run(
      req.user!.id,
      JSON.stringify(lines),
      body.data.entry_date ?? null,
      body.data.description ?? null,
      entry.id
    );
    db.prepare("UPDATE documents SET status = 'validado' WHERE id = ?").run(entry.document_id);
    audit(db, req.user!.id, "approve", "entry", entry.id, body.data.lines ? "editado" : "sem alteracoes");
    // Memoria de fornecedor: aprende a conta usada para este terceiro.
    const doc = db.prepare("SELECT d.doc_type, d.extracted_json, c.nif FROM documents d JOIN companies c ON c.id = d.company_id WHERE d.id = ?").get(entry.document_id) as any;
    if (doc?.extracted_json) learnFromApproval(db, entry.company_id, doc.doc_type, JSON.parse(doc.extracted_json), doc.nif, lines);
    return res.json({ status: "aprovado" });
  });

  // ---------- Pedidos de documentos ----------
  app.post("/api/requests", auth, requireStaff, (req, res) => {
    const body = z
      .object({
        company_id: z.number().int().positive(),
        title: z.string().min(3),
        details: z.string().optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos.", details: body.error.issues });
    const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(body.data.company_id);
    if (!company) return res.status(404).json({ error: "Empresa inexistente." });
    const r = db
      .prepare("INSERT INTO doc_requests (company_id, created_by, title, details, due_date) VALUES (?, ?, ?, ?, ?)")
      .run(body.data.company_id, req.user!.id, body.data.title, body.data.details ?? null, body.data.due_date);
    audit(db, req.user!.id, "create", "doc_request", Number(r.lastInsertRowid));
    return res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  app.get("/api/requests", auth, (req, res) => {
    const requested = req.query.company_id ? Number(req.query.company_id) : null;
    const companyId = scopedCompanyId(req, requested);
    let sql =
      "SELECT r.*, c.name AS company_name, (r.efatura_id IS NOT NULL) AS from_efatura FROM doc_requests r JOIN companies c ON c.id = r.company_id WHERE 1=1";
    const params: any[] = [];
    if (companyId !== null) {
      sql += " AND r.company_id = ?";
      params.push(companyId);
    }
    sql += " ORDER BY CASE r.status WHEN 'pendente' THEN 0 ELSE 1 END, r.due_date LIMIT 200";
    return res.json({ requests: db.prepare(sql).all(...params) });
  });

  app.post("/api/requests/:id/cancel", auth, requireStaff, (req, res) => {
    const r = db
      .prepare("UPDATE doc_requests SET status = 'cancelado' WHERE id = ? AND status = 'pendente'")
      .run(Number(req.params.id));
    if (r.changes === 0) return res.status(404).json({ error: "Pedido inexistente ou já fechado." });
    audit(db, req.user!.id, "cancel", "doc_request", Number(req.params.id));
    return res.json({ status: "cancelado" });
  });

  // ---------- Exportacao Primavera ----------
  app.post("/api/export/:companyId", auth, requireStaff, (req, res) => {
    const companyId = Number(req.params.companyId);
    const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId);
    if (!company) return res.status(404).json({ error: "Empresa inexistente." });
    const result = exportApprovedEntries(db, companyId, req.user!.id);
    return res.json(result);
  });

  app.get("/api/export/batches", auth, requireStaff, (req, res) => {
    const rows = db
      .prepare(
        `SELECT b.id, b.company_id, c.name AS company_name, b.format, b.entry_count, b.created_at
         FROM export_batches b JOIN companies c ON c.id = b.company_id
         ORDER BY b.created_at DESC LIMIT 100`
      )
      .all();
    return res.json({ batches: rows });
  });

  app.get("/api/export/batches/:id/download", auth, requireStaff, (req, res) => {
    const b = db.prepare("SELECT * FROM export_batches WHERE id = ?").get(Number(req.params.id)) as any;
    if (!b) return res.status(404).json({ error: "Lote inexistente." });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="primavera-lote-${b.id}.csv"`);
    return res.send(b.content);
  });

  // ---------- CentralGest ----------
  app.patch("/api/companies/:id", auth, requireStaff, (req, res) => {
    const body = z
      .object({
        centralgest_code: z.string().trim().min(1).nullable().optional(),
        cae: z.string().trim().regex(/^\d{3,5}$/).nullable().optional(),
        territory: z.enum(["continente", "acores", "madeira"]).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos.", details: body.error.issues });
    const sets: string[] = [];
    const params: any[] = [];
    if (body.data.centralgest_code !== undefined) { sets.push("centralgest_code = ?"); params.push(body.data.centralgest_code); }
    if (body.data.cae !== undefined) { sets.push("cae = ?"); params.push(body.data.cae); }
    if (body.data.territory !== undefined) { sets.push("territory = ?"); params.push(body.data.territory); }
    if (sets.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
    params.push(Number(req.params.id));
    const r = db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (r.changes === 0) return res.status(404).json({ error: "Empresa inexistente." });
    audit(db, req.user!.id, "update", "company", Number(req.params.id), JSON.stringify(body.data));
    return res.json(body.data);
  });

  app.get("/api/centralgest/status", auth, requireStaff, async (_req, res) => {
    if (!centralgest) {
      return res.json({ configured: false });
    }
    try {
      const companies = await centralgest.listCompanies();
      return res.json({ configured: true, connection: "ok", remoteCompanies: companies });
    } catch (e: any) {
      return res.json({ configured: true, connection: "erro", detail: e.message });
    }
  });

  /** Tests CentralGest credentials (given in the body, or the active ones) without saving anything. */
  app.post("/api/centralgest/test", auth, requireStaff, async (req, res) => {
    const body = z.object({ baseUrl: z.string().url().optional(), apiKey: z.string().min(1).optional() }).safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: "URL inválido ou chave em falta." });
    let client: CentralGestClient | null = centralgest;
    let where = "definições activas";
    if (body.data.baseUrl || body.data.apiKey) {
      const baseUrl = (body.data.baseUrl ?? process.env.CENTRALGEST_BASE_URL ?? "").replace(/\/$/, "");
      const apiKey = body.data.apiKey ?? process.env.CENTRALGEST_API_KEY ?? "";
      if (!baseUrl || !apiKey) return res.status(400).json({ error: "Indique o URL base e a chave da API." });
      client = new CentralGestClient({ baseUrl, apiKey });
      where = baseUrl;
    }
    if (!client) return res.json({ ok: false, detail: "CentralGest não configurado.", where });
    const started = Date.now();
    try {
      const companies = await client.listCompanies();
      audit(db, req.user!.id, "centralgest_test", "settings", null, JSON.stringify({ ok: true, where, companies: companies.length }));
      return res.json({ ok: true, where, ms: Date.now() - started, remoteCompanies: companies });
    } catch (e: any) {
      audit(db, req.user!.id, "centralgest_test", "settings", null, JSON.stringify({ ok: false, where }));
      return res.json({ ok: false, where, ms: Date.now() - started, detail: e.message });
    }
  });

  app.post("/api/centralgest/dispatch/:companyId", auth, requireStaff, async (req, res) => {
    if (!centralgest) {
      return res.status(409).json({
        error: "CentralGest não configurado. Defina CENTRALGEST_BASE_URL e CENTRALGEST_API_KEY (ou CENTRALGEST_MOCK=1).",
      });
    }
    const entryId = req.body?.entry_id ? Number(req.body.entry_id) : undefined;
    try {
      const outcomes = await dispatchApprovedEntries(db, centralgest, Number(req.params.companyId), req.user!.id, entryId);
      return res.json({ outcomes });
    } catch (e: any) {
      if (e instanceof CentralGestError) return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  app.get("/api/centralgest/dispatches", auth, requireStaff, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT dp.id, dp.entry_id, dp.company_id, c.name AS company_name, dp.external_id,
           dp.remote_number, dp.status, dp.error_detail, dp.created_at,
           e.description AS entry_description
         FROM dispatches dp
         JOIN companies c ON c.id = dp.company_id
         JOIN entries e ON e.id = dp.entry_id
         ORDER BY dp.created_at DESC LIMIT 100`
      )
      .all();
    return res.json({ dispatches: rows });
  });

  // ---------- Conferência (alertas) ----------
  app.get("/api/findings", auth, (req, res) => {
    const companyId = scopedCompanyId(req, req.query.company_id ? Number(req.query.company_id) : null);
    const status = typeof req.query.status === "string" ? req.query.status : "aberto";
    const scope = typeof req.query.scope === "string" ? req.query.scope : null;
    // "aberto" lists every open state (aberto, em_analise, reaberto); "fechado" every closed one.
    const statusSet = status === "aberto" ? ["aberto", "em_analise", "reaberto"] : status === "fechado" ? ["corrigido", "falso_positivo", "aceite"] : status === "resolvido" ? ["corrigido"] : status === "ignorado" ? ["falso_positivo"] : [status];
    let sql = `SELECT f.*, c.name AS company_name, d.original_name, u.name AS assigned_name
      FROM findings f JOIN companies c ON c.id = f.company_id LEFT JOIN documents d ON d.id = f.document_id LEFT JOIN users u ON u.id = f.assigned_to WHERE f.status IN (${statusSet.map(() => "?").join(",")})`;
    const params: any[] = [...statusSet];
    if (companyId !== null) { sql += " AND f.company_id = ?"; params.push(companyId); }
    if (scope) { sql += " AND f.scope = ?"; params.push(scope); }
    // Clientes só vêem alertas que lhes dizem respeito (documentos), nunca os de balancete.
    if (req.user!.role === "client") sql += " AND f.scope = 'documento' AND f.severity != 'info'";
    if (String(req.query.learning ?? "") === "0") sql += " AND f.learning = 0";
    sql += " ORDER BY CASE f.status WHEN 'reaberto' THEN 0 ELSE 1 END, CASE f.severity WHEN 'erro' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END, f.created_at DESC LIMIT 300";
    return res.json({ findings: db.prepare(sql).all(...params), severity_labels: SEVERITY_LABEL });
  });

  // Compatibilidade: resolvido → corrigido, ignorado → falso positivo (motivo 'outro_motivo').
  app.post("/api/findings/:id/resolve", auth, requireStaff, (req, res) => {
    const body = z.object({ status: z.enum(["resolvido", "ignorado", "corrigido", "falso_positivo", "aceite"]), note: z.string().optional(), reason: z.string().optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos." });
    const map: Record<string, string> = { resolvido: "corrigido", ignorado: "falso_positivo" };
    const status = (map[body.data.status] ?? body.data.status) as any;
    try {
      const f = transitionFinding(db, Number(req.params.id), { id: req.user!.id, profile: req.user!.profile ?? null }, { status, note: body.data.note ?? (status === "aceite" ? "Aceite pelo gabinete" : null), reason: body.data.reason ?? (status === "falso_positivo" ? "outro_motivo" : null) });
      return res.json({ status: f.status });
    } catch (e: any) { return res.status(/inexistente|já fechado/.test(e.message) ? 404 : 409).json({ error: e.message }); }
  });

  // Ciclo de vida completo: em_analise (atribuir), corrigido, falso_positivo (motivo), aceite (justificação, excepção reutilizável), reaberto.
  app.post("/api/findings/:id/transition", auth, requireStaff, (req, res) => {
    const body = z.object({
      status: z.enum(["em_analise", "corrigido", "falso_positivo", "aceite", "reaberto"]),
      note: z.string().max(2000).nullable().optional(), reason: z.string().max(60).nullable().optional(),
      assignee_id: z.number().int().nullable().optional(), create_exception: z.boolean().optional(), exception_valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos." });
    try {
      const f = transitionFinding(db, Number(req.params.id), { id: req.user!.id, profile: req.user!.profile ?? null }, { status: body.data.status, note: body.data.note ?? null, reason: body.data.reason ?? null, assigneeId: body.data.assignee_id ?? null, createException: body.data.create_exception, exceptionValidUntil: body.data.exception_valid_until ?? null });
      return res.json({ finding: f });
    } catch (e: any) { return res.status(/inexistente/.test(e.message) ? 404 : 400).json({ error: e.message }); }
  });

  app.get("/api/findings/metrics", auth, requireStaff, (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const from = typeof req.query.from === "string" && req.query.from ? req.query.from : null;
    return res.json({ ...findingMetrics(db, companyId, from), targets: { precision: 85, fpRate: 10, avgDays: 3 } });
  });

  app.get("/api/findings/reasons", auth, requireStaff, (_req, res) => res.json({ reasons: listFpReasons(db, false) }));
  app.put("/api/findings/reasons", auth, requireStaff, (req, res) => {
    if (!["toc", "coordenador"].includes(req.user!.profile ?? "toc")) return res.status(403).json({ error: "Só o coordenador ou o TOC responsável alteram a lista de motivos." });
    const body = z.object({ reasons: z.array(z.object({ code: z.string().regex(/^[a-z0-9_]{3,40}$/), label: z.string().min(3).max(160), active: z.boolean() })).min(1).max(20) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos (código em minúsculas com sublinhados, rótulo, activo)." });
    const tx = db.transaction(() => {
      body.data.reasons.forEach((r, i) => db.prepare("INSERT INTO fp_reasons (code, label, active, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET label = excluded.label, active = excluded.active, sort_order = excluded.sort_order").run(r.code, r.label, r.active ? 1 : 0, i));
    });
    tx();
    audit(db, req.user!.id, "fp_reasons_update", "fp_reasons", null, JSON.stringify(body.data.reasons.map((r) => r.code)));
    return res.json({ reasons: listFpReasons(db, false) });
  });

  app.get("/api/exceptions", auth, requireStaff, (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const rows = db.prepare(`SELECT e.*, c.name AS company_name, u.name AS created_name FROM finding_exceptions e LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN users u ON u.id = e.created_by ${companyId ? "WHERE e.company_id = ? OR e.company_id IS NULL" : ""} ORDER BY e.created_at DESC LIMIT 300`).all(...(companyId ? [companyId] : []));
    return res.json({ exceptions: rows });
  });
  app.delete("/api/exceptions/:id", auth, requireStaff, (req, res) => {
    const r = db.prepare("DELETE FROM finding_exceptions WHERE id = ?").run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: "Excepção inexistente." });
    audit(db, req.user!.id, "exception_delete", "finding_exception", Number(req.params.id));
    return res.json({ ok: true });
  });

  // Parâmetros versionados (tolerâncias, limiares): só o TOC responsável cria versões novas.
  app.get("/api/parameters", auth, requireStaff, (_req, res) => res.json({ definitions: PARAMETER_DEFS, versions: listParameters(db) }));
  app.post("/api/parameters", auth, requireStaff, (req, res) => {
    if ((req.user!.profile ?? "toc") !== "toc") return res.status(403).json({ error: "Só o TOC responsável altera parâmetros." });
    const body = z.object({ key: z.string(), value: z.union([z.number(), z.string(), z.boolean()]), valid_from: z.string(), note: z.string().max(300).nullable().optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos." });
    try { return res.status(201).json({ version: addParameterVersion(db, req.user!.id, body.data.key, body.data.value, body.data.valid_from, body.data.note ?? null) }); }
    catch (e: any) { return res.status(400).json({ error: e.message }); }
  });

  app.post("/api/audit/documents/:id", auth, requireStaff, (req, res) => {
    const findings = auditStoredDocument(db, Number(req.params.id));
    return res.json({ findings });
  });

  app.post("/api/audit/companies/:companyId", auth, requireStaff, (req, res) => {
    const docs = db.prepare("SELECT id FROM documents WHERE company_id = ? AND extracted_json IS NOT NULL").all(Number(req.params.companyId)) as any[];
    let total = 0;
    for (const d of docs) total += auditStoredDocument(db, d.id).length;
    return res.json({ documents: docs.length, findings: total });
  });

  app.post("/api/findings/:id/second-opinion", auth, requireStaff, async (req, res) => {
    const f = db.prepare("SELECT f.*, d.stored_path FROM findings f LEFT JOIN documents d ON d.id = f.document_id WHERE f.id = ?").get(Number(req.params.id)) as any;
    if (!f) return res.status(404).json({ error: "Alerta inexistente." });
    if (!agents.enabled) return res.status(409).json({ error: "Agente de IA não configurado (ANTHROPIC_API_KEY em falta)." });
    let excerpt = "";
    if (f.stored_path) {
      const abs = path.join(storageRoot, f.stored_path);
      if (fs.existsSync(abs)) excerpt = fs.readFileSync(abs, "utf8");
    }
    const opinion = await agents.reviewVatFinding({ code: f.code, message: f.message }, excerpt);
    return res.json({ opinion });
  });

  // ---------- Balancetes e padrões ----------
  app.post("/api/balances/:companyId/import", auth, requireStaff, upload.single("file"), (req, res) => {
    const companyId = Number(req.params.companyId);
    const period = String(req.body?.period ?? "");
    if (!/^\d{4}(-\d{2})?$/.test(period)) return res.status(400).json({ error: "Período inválido (use AAAA ou AAAA-MM)." });
    if (!req.file) return res.status(400).json({ error: "Ficheiro CSV em falta (campo 'file')." });
    try {
      const lines = parseBalanceCsv(req.file.buffer.toString("utf8"));
      if (lines.length === 0) return res.status(400).json({ error: "CSV sem linhas de contas." });
      const id = saveTrialBalance(db, { companyId, period, source: "importado", lines }, req.user!.id);
      audit(db, req.user!.id, "import_balance", "trial_balance", id, period);
      return res.status(201).json({ id, lines: lines.length });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/balances/:companyId/derive", auth, requireStaff, (req, res) => {
    const companyId = Number(req.params.companyId);
    const period = String(req.body?.period ?? "");
    if (!/^\d{4}(-\d{2})?$/.test(period)) return res.status(400).json({ error: "Período inválido (use AAAA ou AAAA-MM)." });
    const lines = deriveBalanceFromEntries(db, companyId, period);
    if (lines.length === 0) return res.status(404).json({ error: "Sem lançamentos aprovados nesse período." });
    const id = saveTrialBalance(db, { companyId, period, source: "derivado", lines }, req.user!.id);
    return res.status(201).json({ id, lines: lines.length });
  });

  app.get("/api/balances/:companyId", auth, (req, res) => {
    const companyId = Number(req.params.companyId);
    if (req.user!.role === "client" && companyId !== req.user!.companyId) return res.status(403).json({ error: "Sem acesso." });
    const rows = db.prepare("SELECT id, period, source, created_at FROM trial_balances WHERE company_id = ? ORDER BY period DESC").all(companyId);
    return res.json({ balances: rows });
  });

  app.get("/api/balances/:companyId/:period", auth, (req, res) => {
    const companyId = Number(req.params.companyId);
    if (req.user!.role === "client" && companyId !== req.user!.companyId) return res.status(403).json({ error: "Sem acesso." });
    const tb = loadTrialBalance(db, companyId, String(req.params.period));
    if (!tb) return res.status(404).json({ error: "Balancete inexistente." });
    return res.json({ ...tb, financials: computeFinancials(tb.lines) });
  });

  app.post("/api/balances/:companyId/:period/check", auth, requireStaff, (req, res) => {
    const companyId = Number(req.params.companyId);
    const period = String(req.params.period);
    const tb = loadTrialBalance(db, companyId, period);
    if (!tb) return res.status(404).json({ error: "Balancete inexistente. Importe-o primeiro." });
    const prev = loadTrialBalance(db, companyId, previousPeriod(period));
    const findings = evaluateRules(listRules(db, companyId), tb.lines, prev?.lines ?? null);
    persistBalanceFindings(db, companyId, period, findings);
    audit(db, req.user!.id, "check_balance", "trial_balance", null, `${companyId}/${period}: ${findings.length} alertas`);
    return res.json({ period, previousPeriod: prev ? previousPeriod(period) : null, findings });
  });

  app.get("/api/rules", auth, requireStaff, (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    return res.json({ rules: listRules(db, companyId) });
  });

  const ruleSchema = z.object({
    company_id: z.number().int().positive().nullable().optional(),
    name: z.string().min(3),
    type: z.enum(["saldo_sinal", "variacao_percentual", "variacao_absoluta", "saldo_maximo", "saldo_minimo", "racio"]),
    account_prefixes: z.array(z.string().min(1)).min(1),
    param: z.string().nullable().optional(),
    threshold: z.number().nullable().optional(),
    severity: z.enum(["info", "aviso", "erro"]).default("aviso"),
    enabled: z.boolean().default(true),
  });

  app.post("/api/rules", auth, requireStaff, (req, res) => {
    const body = ruleSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos.", details: body.error.issues });
    const d = body.data;
    const r = db
      .prepare("INSERT INTO balance_rules (company_id, name, type, account_prefixes, param, threshold, severity, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.company_id ?? null, d.name, d.type, d.account_prefixes.join(","), d.param ?? null, d.threshold ?? null, d.severity, d.enabled ? 1 : 0);
    audit(db, req.user!.id, "create", "balance_rule", Number(r.lastInsertRowid));
    return res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  app.patch("/api/rules/:id", auth, requireStaff, (req, res) => {
    const body = z.object({ enabled: z.boolean().optional(), threshold: z.number().nullable().optional(), severity: z.enum(["info", "aviso", "erro"]).optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos." });
    const sets: string[] = []; const params: any[] = [];
    if (body.data.enabled !== undefined) { sets.push("enabled = ?"); params.push(body.data.enabled ? 1 : 0); }
    if (body.data.threshold !== undefined) { sets.push("threshold = ?"); params.push(body.data.threshold); }
    if (body.data.severity !== undefined) { sets.push("severity = ?"); params.push(body.data.severity); }
    if (!sets.length) return res.status(400).json({ error: "Nada para actualizar." });
    params.push(Number(req.params.id));
    const r = db.prepare(`UPDATE balance_rules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (r.changes === 0) return res.status(404).json({ error: "Padrão inexistente." });
    return res.json({ ok: true });
  });

  app.delete("/api/rules/:id", auth, requireStaff, (req, res) => {
    const r = db.prepare("DELETE FROM balance_rules WHERE id = ?").run(Number(req.params.id));
    if (r.changes === 0) return res.status(404).json({ error: "Padrão inexistente." });
    return res.json({ ok: true });
  });

  // ---------- Relatórios financeiros ----------
  app.post("/api/reports/:companyId", auth, requireStaff, async (req, res) => {
    const companyId = Number(req.params.companyId);
    const period = String(req.body?.period ?? "");
    if (!/^\d{4}(-\d{2})?$/.test(period)) return res.status(400).json({ error: "Período inválido (use AAAA ou AAAA-MM)." });
    try {
      const data = buildReportData(db, companyId, period);
      if (req.body?.polish && agents.enabled) {
        const polished = await agents.polishNarrative(data.narrative);
        if (polished) data.narrative = polished;
      }
      const html = renderReportHtml(data);
      const title = `Relatório financeiro ${data.companyName} · ${period}`;
      const r = db
        .prepare("INSERT INTO reports (company_id, period, template, title, summary, data_json, html, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(companyId, period, data.template, title, data.summary, JSON.stringify(data), html, req.user!.id);
      audit(db, req.user!.id, "create", "report", Number(r.lastInsertRowid), period);
      return res.status(201).json({ id: Number(r.lastInsertRowid), title, summary: data.summary, template: data.template });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/reports", auth, (req, res) => {
    const companyId = scopedCompanyId(req, req.query.company_id ? Number(req.query.company_id) : null);
    let sql = "SELECT r.id, r.company_id, c.name AS company_name, r.period, r.template, r.title, r.summary, r.created_at FROM reports r JOIN companies c ON c.id = r.company_id WHERE 1=1";
    const params: any[] = [];
    if (companyId !== null) { sql += " AND r.company_id = ?"; params.push(companyId); }
    sql += " ORDER BY r.created_at DESC LIMIT 100";
    return res.json({ reports: db.prepare(sql).all(...params) });
  });

  app.get("/api/reports/:id/html", auth, (req, res) => {
    const r = db.prepare("SELECT company_id, html FROM reports WHERE id = ?").get(Number(req.params.id)) as any;
    if (!r) return res.status(404).json({ error: "Relatório inexistente." });
    if (req.user!.role === "client" && r.company_id !== req.user!.companyId) return res.status(403).json({ error: "Sem acesso." });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(r.html);
  });

  app.get("/api/reports/:id", auth, (req, res) => {
    const r = db.prepare("SELECT * FROM reports WHERE id = ?").get(Number(req.params.id)) as any;
    if (!r) return res.status(404).json({ error: "Relatório inexistente." });
    if (req.user!.role === "client" && r.company_id !== req.user!.companyId) return res.status(403).json({ error: "Sem acesso." });
    return res.json({ ...r, data: JSON.parse(r.data_json), data_json: undefined, html: undefined });
  });

  // ---------- Conhecimento (lei do IVA, benchmarks) ----------
  app.get("/api/knowledge", auth, requireStaff, (_req, res) => {
    const vat = loadVatRules();
    const sectors = loadSectorBenchmarks();
    return res.json({
      status: knowledgeStatus(),
      vat: { version: vat.version, last_verified: vat.last_verified, sources: vat.sources, territories: vat.territories, categories: vat.categories },
      sectors: { version: sectors.version, source: sectors.source, disclaimer: sectors.disclaimer, sectors: sectors.sectors.map((s) => ({ key: s.key, label: s.label, cae_prefixes: s.cae_prefixes })) },
      agents: { enabled: agents.enabled },
    });
  });

  // ---------- Recepção multi-canal ----------
  const waClient = whatsapp ? new WhatsAppClient(whatsapp, whatsappFetch) : null;

  app.get("/webhooks/whatsapp", (req, res) => {
    if (!whatsapp) return res.status(404).send("WhatsApp não configurado");
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === whatsapp.verifyToken) {
      return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
    }
    return res.status(403).send("token inválido");
  });

  app.post("/webhooks/whatsapp", async (req: any, res) => {
    if (!whatsapp || !waClient) return res.status(404).json({ error: "WhatsApp não configurado." });
    if (!verifyMetaSignature(req.rawBody ?? Buffer.alloc(0), req.headers["x-hub-signature-256"] as string | undefined, whatsapp.appSecret)) {
      return res.status(401).json({ error: "Assinatura inválida." });
    }
    // Responder já; a Meta reenvia se não receber 200 rapidamente.
    res.status(200).json({ received: true });
    const incoming = parseWhatsAppPayload(req.body);
    for (const m of incoming) {
      try {
        const sender = normaliseAddress("whatsapp", m.from);
        // Resposta às perguntas de recepção (tipo de documento, centro de custo): sem anexos e com diálogo aberto.
        if (intake && whatsapp.reply && !m.media.length && m.text) {
          const a = intake.answer("whatsapp", sender, m.text);
          if (a.handled) {
            db.prepare("INSERT OR IGNORE INTO inbound_messages (channel, external_id, sender, recipient, subject, body_excerpt, company_id, status, attachments) VALUES ('whatsapp', ?, ?, ?, 'resposta às perguntas de recepção', ?, (SELECT company_id FROM channel_dialogs WHERE channel = 'whatsapp' AND sender = ?), 'processado', 0)")
              .run(m.messageId, sender, m.phoneNumberId, m.text.slice(0, 300), sender);
            if (a.reply) await waClient.sendText(m.from, a.reply);
            continue;
          }
        }
        const inbound = await toInboundMessage(m, waClient);
        const result = await processInbound(db, inboundDeps(), inbound);
        if (whatsapp.reply && result.status !== "duplicado") {
          let text = confirmationText(result);
          const fresh = result.outcomes.filter((o) => !o.duplicate);
          if (intake && result.status === "processado" && result.companyId && fresh.length) {
            const q = intake.start({ channel: "whatsapp", sender, companyId: result.companyId, documentIds: fresh.map((o) => o.documentId), detectedType: fresh[0]!.docType });
            if (q) text = q;
          }
          await waClient.sendText(m.from, text);
        }
      } catch (e: any) {
        console.error("[whatsapp] falha a processar", m.messageId, e.message);
        db.prepare(
          "INSERT OR IGNORE INTO inbound_messages (channel, external_id, sender, status, attachments, error_detail) VALUES ('whatsapp', ?, ?, 'erro', ?, ?)"
        ).run(m.messageId, normaliseAddress("whatsapp", m.from), m.media.length, e.message);
      }
    }
  });

  app.post("/api/inbound/email", express.text({ type: ["message/rfc822", "text/plain"], limit: "25mb" }), async (req: any, res) => {
    if (!inboundEmailSecret) return res.status(404).json({ error: "Recepção por email não configurada (INBOUND_EMAIL_SECRET)." });
    if (req.headers["x-contai-secret"] !== inboundEmailSecret) return res.status(401).json({ error: "Segredo inválido." });
    try {
      const inbound = typeof req.body === "string" ? await parseRawEmail(req.body) : parseInboundEmailJson(req.body);
      const result = await processInbound(db, inboundDeps(), inbound);
      return res.status(result.status === "duplicado" ? 200 : 201).json({
        inboundId: result.inboundId, status: result.status, companyId: result.companyId,
        documents: result.outcomes.map((o) => ({ id: o.documentId, docType: o.docType, duplicate: o.duplicate, findings: o.findings.length })),
      });
    } catch (e: any) {
      return res.status(400).json({ error: `Email inválido: ${e.message}` });
    }
  });

  app.get("/api/inbound", auth, requireStaff, (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    let sql = "SELECT m.*, c.name AS company_name FROM inbound_messages m LEFT JOIN companies c ON c.id = m.company_id WHERE 1=1";
    const params: any[] = [];
    if (status) { sql += " AND m.status = ?"; params.push(status); }
    sql += " ORDER BY m.received_at DESC LIMIT 200";
    return res.json({ messages: db.prepare(sql).all(...params) });
  });

  /** Associates an unknown sender to a company and reprocesses its pending messages' attachments cannot be recovered; only future ones route. */
  app.post("/api/inbound/:id/assign", auth, requireStaff, (req, res) => {
    const body = z.object({ company_id: z.number().int().positive() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos." });
    const m = db.prepare("SELECT * FROM inbound_messages WHERE id = ?").get(Number(req.params.id)) as any;
    if (!m) return res.status(404).json({ error: "Recepção inexistente." });
    db.prepare("INSERT OR IGNORE INTO company_contacts (company_id, channel, address, label) VALUES (?, ?, ?, 'associado a partir de recepção')")
      .run(body.data.company_id, m.channel, m.sender);
    db.prepare("UPDATE inbound_messages SET company_id = ? WHERE id = ? AND status = 'sem_empresa'").run(body.data.company_id, m.id);
    audit(db, req.user!.id, "assign_contact", "company_contact", body.data.company_id, `${m.channel} ${m.sender}`);
    return res.json({ ok: true, note: "Contacto associado. As próximas mensagens deste remetente entram automaticamente; reenvie os documentos desta mensagem." });
  });

  app.get("/api/companies/:id/contacts", auth, requireStaff, (req, res) => {
    const rows = db.prepare("SELECT id, channel, address, label, created_at FROM company_contacts WHERE company_id = ? ORDER BY channel, address").all(Number(req.params.id));
    return res.json({ contacts: rows });
  });

  app.post("/api/companies/:id/contacts", auth, requireStaff, (req, res) => {
    const body = z.object({ channel: z.enum(["email", "whatsapp"]), address: z.string().min(5), label: z.string().optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos." });
    const companyId = Number(req.params.id);
    if (!db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId)) return res.status(404).json({ error: "Empresa inexistente." });
    const address = normaliseAddress(body.data.channel, body.data.address);
    if (body.data.channel === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return res.status(400).json({ error: "Email inválido." });
    if (body.data.channel === "whatsapp" && !/^\d{9,15}$/.test(address)) return res.status(400).json({ error: "Número inválido (use formato internacional, ex.: 351912345678)." });
    try {
      const r = db.prepare("INSERT INTO company_contacts (company_id, channel, address, label) VALUES (?, ?, ?, ?)").run(companyId, body.data.channel, address, body.data.label ?? null);
      audit(db, req.user!.id, "create", "company_contact", Number(r.lastInsertRowid), `${body.data.channel} ${address}`);
      return res.status(201).json({ id: Number(r.lastInsertRowid), address });
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Este contacto já está associado a uma empresa." });
      throw e;
    }
  });

  app.delete("/api/contacts/:id", auth, requireStaff, (req, res) => {
    const r = db.prepare("DELETE FROM company_contacts WHERE id = ?").run(Number(req.params.id));
    if (r.changes === 0) return res.status(404).json({ error: "Contacto inexistente." });
    return res.json({ ok: true });
  });

  // ---------- Dominio e TLS (auto-servico) ----------
  app.get("/api/domain", auth, requireStaff, async (_req, res) => {
    return res.json(await domainStatus(process.env.CONTAI_SYSTEM_LOG_DIR || null));
  });
  app.put("/api/domain", auth, requireStaff, async (req, res) => {
    const body = z.object({ domain: z.string().max(253) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Pedido inválido." });
    const d = normaliseDomain(body.data.domain);
    if (d === "invalid") return res.status(400).json({ error: "Domínio inválido. Exemplo: app.lumarcont.pt (sem https:// nem barras)." });
    if (!writeDomain(d ?? "")) return res.status(409).json({ error: configDirPending() ? "A pasta de configuração ainda não está pronta; fica disponível na próxima actualização automática do servidor (até 5 minutos). Tente de novo daqui a pouco." : "Este servidor não tem a pasta de configuração partilhada (CONTAI_CONFIG_DIR). Defina o domínio com contai-update." });
    audit(db, req.user!.id, "domain_set", "settings", null, d ?? "");
    return res.json({ domain: d, applyWithinMinutes: 5 });
  });

  // ---------- Testes de credenciais (sem guardar) ----------
  app.post("/api/settings/test/:group", auth, requireStaff, async (req, res) => {
    const v = (k: string): string => String((req.body?.values ?? {})[k] ?? process.env[k] ?? "").trim();
    const started = Date.now();
    const done = (ok: boolean, detail: string, extra: Record<string, unknown> = {}) => {
      audit(db, req.user!.id, "settings_test", "settings", null, JSON.stringify({ group: req.params.group, ok }));
      return res.json({ ok, detail, ms: Date.now() - started, ...extra });
    };
    try {
      if (req.params.group === "ia") {
        const key = v("ANTHROPIC_API_KEY"); if (!key) return res.status(400).json({ error: "Indique a chave da API Anthropic." });
        const client = new Anthropic({ apiKey: key });
        const models = await client.models.list({ limit: 20 });
        const ids = models.data.map((m) => m.id);
        const wanted = [v("CONTAI_OCR_MODEL") || "claude-opus-5", v("CONTAI_AGENT_MODEL") || "claude-opus-5"].filter((x, i, a) => a.indexOf(x) === i);
        const missing = wanted.filter((m) => !ids.some((id) => id === m || id.startsWith(m)));
        return done(true, `Chave válida. ${ids.length} modelo(s) disponíveis${missing.length ? `; atenção: ${missing.join(", ")} não consta da lista` : ""}.`, { models: ids });
      }
      if (req.params.group === "email") {
        const mailbox = v("MS365_MAIL_USER");
        if (mailbox) {
          const tenantId = v("MS365_TENANT_ID"), clientId = v("MS365_CLIENT_ID"), clientSecret = v("MS365_CLIENT_SECRET");
          if (!tenantId || !clientId || !clientSecret) return res.status(400).json({ error: "A caixa Microsoft 365 usa a aplicação configurada no grupo Microsoft 365: preencha tenant, client ID e client secret (podem já estar guardados)." });
          const client = new Microsoft365Client({ tenantId, clientId, clientSecret, driveUser: mailbox }, whatsappFetch);
          const poller = new GraphMailPoller(db, { provider, ocr, structured, storageRoot, systemUserId: systemUserId() }, client, { mailbox, folder: v("MS365_MAIL_FOLDER") || "inbox", intervalMs: 0, markRead: false }, () => {});
          const info = await poller.folderInfo();
          return done(true, `Caixa ${mailbox} acessível pela Graph API: pasta ${info.displayName} com ${info.total} mensagem(ns), ${info.unread} por ler.`);
        }
        const host = v("IMAP_HOST"), user = v("IMAP_USER"), pass = v("IMAP_PASSWORD");
        if (!host || !user || !pass) return res.status(400).json({ error: "Indique a caixa Microsoft 365, ou servidor, utilizador e palavra-passe IMAP (o webhook não precisa de teste)." });
        const { ImapFlow } = await import("imapflow");
        const client = new ImapFlow({ host, port: Number(v("IMAP_PORT") || 993), secure: v("IMAP_SECURE") !== "0", auth: { user, pass }, logger: false, connectionTimeout: 8000 } as any);
        await client.connect();
        try {
          const box = await client.mailboxOpen(v("IMAP_MAILBOX") || "INBOX", { readOnly: true });
          return done(true, `Ligação IMAP OK a ${host}: pasta ${box.path} com ${box.exists} mensagem(ns).`);
        } finally { await client.logout().catch(() => {}); }
      }
      if (req.params.group === "microsoft365") {
        const tenantId = v("MS365_TENANT_ID"), clientId = v("MS365_CLIENT_ID"), clientSecret = v("MS365_CLIENT_SECRET"), driveUser = v("MS365_DRIVE_USER"), siteId = v("MS365_SITE_ID");
        if (!tenantId || !clientId || !clientSecret || (!driveUser && !siteId)) return res.status(400).json({ error: "Indique tenant, client ID, client secret e o OneDrive (email) ou o site SharePoint." });
        const client = new Microsoft365Client({ tenantId, clientId, clientSecret, driveUser: driveUser || null, siteId: siteId || null }, whatsappFetch);
        const info = await client.driveInfo();
        return done(true, `Ligação OK: ${info.name} de ${info.owner}${info.totalGb ? ` (${info.usedGb} de ${info.totalGb} GB usados)` : ""}. Os documentos vão para a pasta "${v("MS365_ROOT_FOLDER") || "Cont.ai"}".`, { webUrl: info.webUrl });
      }
      if (req.params.group === "whatsapp") {
        const token = v("WHATSAPP_ACCESS_TOKEN"), phone = v("WHATSAPP_PHONE_NUMBER_ID");
        if (!token || !phone) return res.status(400).json({ error: "Indique o access token e o phone number ID." });
        const r = await whatsappFetch(`https://graph.facebook.com/${v("WHATSAPP_GRAPH_VERSION") || "v21.0"}/${encodeURIComponent(phone)}?fields=display_phone_number,verified_name,quality_rating`, { headers: { authorization: `Bearer ${token}` } });
        const body: any = await r.json().catch(() => ({}));
        if (!r.ok) return done(false, `Meta respondeu HTTP ${r.status}: ${body?.error?.message || "sem detalhe"}.`);
        return done(true, `Número ${body.display_phone_number || phone} (${body.verified_name || "sem nome verificado"}), qualidade ${body.quality_rating || "n/d"}.${v("WHATSAPP_APP_SECRET") ? "" : " Falta o app secret para validar as assinaturas dos eventos."}`);
      }
      return res.status(404).json({ error: "Grupo sem teste." });
    } catch (e: any) {
      return done(false, String(e?.message || e).slice(0, 300));
    }
  });

  // ---------- Integracoes (definicoes cifradas na BD) ----------
  app.get("/api/settings", auth, requireStaff, (_req, res) => {
    return res.json({ settings: listSettings(db), restart: !!onSettingsSaved });
  });

  app.put("/api/settings", auth, requireStaff, (req, res) => {
    const body = z.object({ values: z.record(z.string(), z.string().max(4000).nullable()) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Pedido inválido." });
    try {
      const out = saveSettings(db, req.user!.id, body.data.values);
      if (onSettingsSaved && (out.saved.length || out.cleared.length)) setTimeout(onSettingsSaved, 400);
      return res.json({ ...out, restart: !!onSettingsSaved });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/onedrive/status", auth, requireStaff, (_req, res) => {
    if (!onedrive) return res.json({ configured: false });
    return res.json({ configured: true, ...onedrive.counts(), intakeEnabled: onedrive.intakeEnabled, root: process.env.MS365_ROOT_FOLDER || "Cont.ai", target: process.env.MS365_SITE_ID ? "SharePoint " + process.env.MS365_SITE_ID : "OneDrive de " + (process.env.MS365_DRIVE_USER || "") });
  });
  app.post("/api/onedrive/sync", auth, requireStaff, async (req, res) => {
    if (!onedrive) return res.status(409).json({ error: "Microsoft 365 não configurado (Integrações > Microsoft 365)." });
    if (req.body?.retry_failed) onedrive.retryFailed();
    const folders = await onedrive.ensureAllCostCenterFolders().catch(() => 0);
    const intake = await onedrive.pollIntake().catch(() => ({ processed: 0, errors: 0, skipped: 0 }));
    const outcomes = await onedrive.syncPending(50, req.user!.id);
    return res.json({ outcomes, folders, intake, ...onedrive.counts() });
  });

  app.get("/api/channels/status", auth, requireStaff, (_req, res) => {
    return res.json({
      onedrive: !!onedrive,
      email_webhook: !!inboundEmailSecret,
      graph_mail: !!(process.env.MS365_MAIL_USER && process.env.MS365_TENANT_ID),
      imap: !!process.env.IMAP_HOST && !process.env.MS365_MAIL_USER,
      whatsapp: !!whatsapp,
      whatsapp_reply: !!whatsapp?.reply,
      ai_extraction: !!structured,
      ocr: ocr instanceof DocumentOcr ? ocr.engines : ["personalizado"],
    });
  });

  // ---------- Centros de custo ----------
  const companyScoped = (req: Request, res: Response): number | null => {
    const requested = Number(req.params.id);
    const companyId = scopedCompanyId(req, requested);
    if (companyId !== requested) { res.status(403).json({ error: "Sem acesso a esta empresa." }); return null; }
    if (!db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId)) { res.status(404).json({ error: "Empresa inexistente." }); return null; }
    return companyId;
  };

  app.get("/api/companies/:id/cost-centers", auth, (req, res) => {
    const companyId = companyScoped(req, res); if (companyId === null) return;
    const all = String(req.query.all ?? "") === "1" && req.user!.role === "staff";
    const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM documents d WHERE d.cost_center_id = c.id) AS documents FROM cost_centers c WHERE c.company_id = ? ${all ? "" : "AND c.active = 1"} ORDER BY c.code`).all(companyId);
    return res.json({ cost_centers: rows, doc_types: DOC_TYPE_OPTIONS.map((o) => ({ key: o.key, label: o.label })) });
  });

  app.post("/api/companies/:id/cost-centers", auth, requireStaff, async (req, res) => {
    const companyId = companyScoped(req, res); if (companyId === null) return;
    const parsed = z.object({ code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_.-]+$/, "Código só com letras, números, ponto, hífen ou sublinhado."), name: z.string().trim().min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Dados inválidos." });
    const code = parsed.data.code.toUpperCase();
    if (db.prepare("SELECT id FROM cost_centers WHERE company_id = ? AND code = ?").get(companyId, code)) return res.status(409).json({ error: "Já existe um centro de custo com esse código." });
    const r = db.prepare("INSERT INTO cost_centers (company_id, code, name) VALUES (?, ?, ?)").run(companyId, code, parsed.data.name);
    const id = Number(r.lastInsertRowid);
    audit(db, req.user!.id, "cost_center_create", "cost_center", id, `${code} ${parsed.data.name}`);
    let onedriveNote: string | null = null;
    if (onedrive) {
      try { const f = await onedrive.ensureCostCenterFolder(id, req.user!.id); onedriveNote = `Pasta criada no OneDrive: ${f.path}`; }
      catch (e: any) { onedriveNote = `Pasta no OneDrive por criar (${String(e?.message || e).slice(0, 120)}); a app volta a tentar.`; db.prepare("UPDATE cost_centers SET onedrive_error = ?, onedrive_attempts = 1 WHERE id = ?").run(String(e?.message || e).slice(0, 300), id); }
    }
    return res.status(201).json({ cost_center: db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(id), onedrive: onedriveNote });
  });

  app.patch("/api/cost-centers/:id", auth, requireStaff, (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos." });
    const cur = db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(Number(req.params.id)) as any;
    if (!cur) return res.status(404).json({ error: "Centro de custo inexistente." });
    db.prepare("UPDATE cost_centers SET name = ?, active = ? WHERE id = ?").run(parsed.data.name ?? cur.name, parsed.data.active === undefined ? cur.active : (parsed.data.active ? 1 : 0), cur.id);
    audit(db, req.user!.id, "cost_center_update", "cost_center", cur.id, JSON.stringify(parsed.data));
    return res.json({ cost_center: db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(cur.id) });
  });

  app.delete("/api/cost-centers/:id", auth, requireStaff, (req, res) => {
    const cur = db.prepare("SELECT * FROM cost_centers WHERE id = ?").get(Number(req.params.id)) as any;
    if (!cur) return res.status(404).json({ error: "Centro de custo inexistente." });
    const used = (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE cost_center_id = ?").get(cur.id) as any).n + (db.prepare("SELECT COUNT(*) AS n FROM supplier_profiles WHERE default_cost_center_id = ?").get(cur.id) as any).n;
    if (used > 0) {
      db.prepare("UPDATE cost_centers SET active = 0 WHERE id = ?").run(cur.id);
      audit(db, req.user!.id, "cost_center_deactivate", "cost_center", cur.id);
      return res.json({ ok: true, deactivated: true, note: "Centro de custo em uso: ficou inactivo em vez de apagado." });
    }
    db.prepare("DELETE FROM supplier_cost_centers WHERE cost_center_id = ?").run(cur.id);
    db.prepare("DELETE FROM cost_centers WHERE id = ?").run(cur.id);
    audit(db, req.user!.id, "cost_center_delete", "cost_center", cur.id);
    return res.json({ ok: true, deactivated: false });
  });

  // Tipo e centro de custo indicados depois da recepção (gabinete); re-propõe o lançamento pendente.
  app.post("/api/documents/:id/intake", auth, requireStaff, (req, res) => {
    const parsed = z.object({ doc_type: z.string().optional(), cost_center_id: z.number().int().nullable().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos." });
    if (parsed.data.doc_type && !DOC_TYPES.has(parsed.data.doc_type)) return res.status(400).json({ error: "Tipo de documento desconhecido." });
    try {
      const out = applyIntakeAnswers(db, Number(req.params.id), { docType: (parsed.data.doc_type as DocType | undefined) ?? undefined, costCenterId: parsed.data.cost_center_id }, req.user!.id);
      return res.json(out);
    } catch (e: any) { return res.status(/^Documento inexistente/.test(e.message || "") ? 404 : 400).json({ error: e.message }); }
  });

  // ---------- Fornecedores: registo, descoberta por NIF ----------
  const supplierRow = (id: number) => {
    const p = db.prepare("SELECT p.*, c.name AS company_name FROM supplier_profiles p JOIN companies c ON c.id = p.company_id WHERE p.id = ?").get(id) as any;
    if (!p) return null;
    const ccs = db.prepare("SELECT c.id, c.code, c.name FROM supplier_cost_centers s JOIN cost_centers c ON c.id = s.cost_center_id WHERE s.supplier_id = ? ORDER BY c.code").all(id);
    let aliases: string[] = []; try { aliases = JSON.parse(p.aliases_json || "[]"); } catch { /* ignore */ }
    return { ...p, aliases, aliases_json: undefined, discovery_json: undefined, known: !!(p.registered_at || p.expense_account || p.revenue_account), cost_centers: ccs };
  };

  app.get("/api/suppliers", auth, requireStaff, (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const status = typeof req.query.status === "string" ? req.query.status : "todos";
    const rows = db.prepare(`SELECT p.id FROM supplier_profiles p ${companyId ? "WHERE p.company_id = ?" : ""} ORDER BY p.last_seen DESC, p.id DESC LIMIT 500`).all(...(companyId ? [companyId] : [])) as any[];
    let list = rows.map((r) => supplierRow(r.id)!);
    // Pending entries per (company, nif) so the accountant sees which unknown suppliers block validation.
    const pending = new Map<string, number>();
    const pend = db.prepare(`SELECT e.company_id, d.extracted_json, c.nif AS company_nif FROM entries e JOIN documents d ON d.id = e.document_id JOIN companies c ON c.id = e.company_id WHERE e.status = 'pendente' ${companyId ? "AND e.company_id = ?" : ""}`).all(...(companyId ? [companyId] : [])) as any[];
    for (const p of pend) { try { const nif = counterpartyNif(JSON.parse(p.extracted_json || "null") ?? { nifs: [] }, p.company_nif); if (nif) pending.set(`${p.company_id}:${nif}`, (pending.get(`${p.company_id}:${nif}`) ?? 0) + 1); } catch { /* ignore */ } }
    list = list.map((s) => ({ ...s, pending_entries: pending.get(`${s.company_id}:${s.nif}`) ?? 0 }));
    if (status === "desconhecidos") list = list.filter((s) => !s.known);
    else if (status === "registados") list = list.filter((s) => !!s.registered_at);
    return res.json({ suppliers: list, discovery_sources: discoveryService.sourcesAvailable });
  });

  app.post("/api/suppliers/discover", auth, requireStaff, async (req, res) => {
    const parsed = z.object({ nif: z.string().min(9).max(12), company_id: z.number().int().optional(), document_id: z.number().int().optional(), refresh: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Indique o NIF a pesquisar." });
    let nameOnDocument: string | null = null; let companyName: string | null = null;
    if (parsed.data.document_id) {
      const d = db.prepare("SELECT extracted_json FROM documents WHERE id = ?").get(parsed.data.document_id) as any;
      try { const x = JSON.parse(d?.extracted_json || "null"); if (x && x.issuerNif === parsed.data.nif.replace(/\D/g, "")) nameOnDocument = x.issuerName ?? null; } catch { /* ignore */ }
    }
    if (parsed.data.company_id) companyName = (db.prepare("SELECT name FROM companies WHERE id = ?").get(parsed.data.company_id) as any)?.name ?? null;
    try {
      const result = await discoveryService.discover(parsed.data.nif, { nameOnDocument, companyName }, { refresh: parsed.data.refresh, userId: req.user!.id });
      return res.json(result);
    } catch (e: any) { return res.status(400).json({ error: e.message }); }
  });

  app.post("/api/companies/:id/suppliers", auth, requireStaff, (req, res) => {
    const companyId = companyScoped(req, res); if (companyId === null) return;
    const schema = z.object({
      nif: z.string().regex(/^\d{9}$/, "NIF com 9 dígitos."),
      name: z.string().trim().min(2).max(160),
      brand: z.string().trim().max(120).nullable().optional(),
      aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
      website: z.string().trim().max(300).nullable().optional(),
      activity: z.string().trim().max(160).nullable().optional(),
      expense_account: z.string().trim().regex(/^\d{2,12}$/).nullable().optional(),
      cost_center_ids: z.array(z.number().int()).max(50).optional(),
      default_cost_center_id: z.number().int().nullable().optional(),
      candidate: z.object({ name: z.string(), kind: z.string(), probability: z.number(), sources: z.array(z.string()).optional() }).nullable().optional(),
      apply_to_pending: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Dados inválidos." });
    const d = parsed.data;
    if (d.website && !/^https?:\/\//i.test(d.website)) return res.status(400).json({ error: "O site tem de começar por http:// ou https://." });
    const ccIds = [...new Set([...(d.cost_center_ids ?? []), ...(d.default_cost_center_id ? [d.default_cost_center_id] : [])])];
    for (const id of ccIds) if (!db.prepare("SELECT id FROM cost_centers WHERE id = ? AND company_id = ?").get(id, companyId)) return res.status(400).json({ error: "Centro de custo inexistente nesta empresa." });
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO supplier_profiles (company_id, nif, name, brand, aliases_json, website, activity, expense_account, registered_at, registered_by, default_cost_center_id, discovery_json, doc_count, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, 0, NULL)
         ON CONFLICT (company_id, nif) DO UPDATE SET name = excluded.name, brand = excluded.brand, aliases_json = excluded.aliases_json, website = excluded.website, activity = excluded.activity,
           expense_account = COALESCE(excluded.expense_account, supplier_profiles.expense_account), registered_at = datetime('now'), registered_by = excluded.registered_by,
           default_cost_center_id = excluded.default_cost_center_id, discovery_json = COALESCE(excluded.discovery_json, supplier_profiles.discovery_json), updated_at = datetime('now')`
      ).run(companyId, d.nif, d.name, d.brand ?? null, JSON.stringify(d.aliases ?? []), d.website ?? null, d.activity ?? null, d.expense_account ?? null, req.user!.id, d.default_cost_center_id ?? null, d.candidate ? JSON.stringify(d.candidate) : null);
      const sid = (db.prepare("SELECT id FROM supplier_profiles WHERE company_id = ? AND nif = ?").get(companyId, d.nif) as any).id as number;
      db.prepare("DELETE FROM supplier_cost_centers WHERE supplier_id = ?").run(sid);
      for (const id of ccIds) db.prepare("INSERT OR IGNORE INTO supplier_cost_centers (supplier_id, cost_center_id) VALUES (?, ?)").run(sid, id);
      let applied = 0;
      if (d.apply_to_pending !== false) {
        const code = d.default_cost_center_id ? (db.prepare("SELECT code FROM cost_centers WHERE id = ?").get(d.default_cost_center_id) as any)?.code ?? null : null;
        const companyNif = (db.prepare("SELECT nif FROM companies WHERE id = ?").get(companyId) as any).nif as string;
        const pend = db.prepare("SELECT e.id, e.lines_json, e.document_id, d.extracted_json, d.doc_type, d.cost_center_id FROM entries e JOIN documents d ON d.id = e.document_id WHERE e.company_id = ? AND e.status = 'pendente'").all(companyId) as any[];
        for (const p of pend) {
          let nif: string | null = null; try { nif = counterpartyNif(JSON.parse(p.extracted_json || "null") ?? { nifs: [] }, companyNif); } catch { /* ignore */ }
          if (nif !== d.nif) continue;
          let lines: EntryLine[] = JSON.parse(p.lines_json);
          const docCode = p.cost_center_id ? (db.prepare("SELECT code FROM cost_centers WHERE id = ?").get(p.cost_center_id) as any)?.code ?? null : null;
          if (docCode || code) lines = applyCostCenter(lines, docCode || code);
          if (d.expense_account && ["factura_compra", "despesa", "nota_credito"].includes(p.doc_type)) lines = lines.map((l) => (/^(3|6)/.test(l.account) ? { ...l, account: d.expense_account! } : l));
          db.prepare("UPDATE entries SET lines_json = ? WHERE id = ?").run(JSON.stringify(lines), p.id);
          applied++;
        }
      }
      audit(db, req.user!.id, "supplier_register", "supplier", sid, JSON.stringify({ nif: d.nif, name: d.name, brand: d.brand ?? null, probability: d.candidate?.probability ?? null, costCenters: ccIds.length, applied }));
      return { sid, applied };
    });
    const out = tx();
    return res.status(201).json({ supplier: supplierRow(out.sid), applied_to_pending: out.applied });
  });

  app.patch("/api/suppliers/:id", auth, requireStaff, (req, res) => {
    const cur = db.prepare("SELECT * FROM supplier_profiles WHERE id = ?").get(Number(req.params.id)) as any;
    if (!cur) return res.status(404).json({ error: "Fornecedor inexistente." });
    const parsed = z.object({
      name: z.string().trim().min(2).max(160).optional(), brand: z.string().trim().max(120).nullable().optional(), website: z.string().trim().max(300).nullable().optional(),
      activity: z.string().trim().max(160).nullable().optional(), expense_account: z.string().trim().regex(/^\d{2,12}$/).nullable().optional(),
      cost_center_ids: z.array(z.number().int()).max(50).optional(), default_cost_center_id: z.number().int().nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos." });
    const d = parsed.data;
    const ccIds = d.cost_center_ids !== undefined || d.default_cost_center_id !== undefined ? [...new Set([...(d.cost_center_ids ?? []), ...(d.default_cost_center_id ? [d.default_cost_center_id] : [])])] : null;
    if (ccIds) for (const id of ccIds) if (!db.prepare("SELECT id FROM cost_centers WHERE id = ? AND company_id = ?").get(id, cur.company_id)) return res.status(400).json({ error: "Centro de custo inexistente nesta empresa." });
    db.prepare("UPDATE supplier_profiles SET name = ?, brand = ?, website = ?, activity = ?, expense_account = ?, default_cost_center_id = ?, registered_at = COALESCE(registered_at, datetime('now')), registered_by = COALESCE(registered_by, ?), updated_at = datetime('now') WHERE id = ?")
      .run(d.name ?? cur.name, d.brand === undefined ? cur.brand : d.brand, d.website === undefined ? cur.website : d.website, d.activity === undefined ? cur.activity : d.activity, d.expense_account === undefined ? cur.expense_account : d.expense_account, d.default_cost_center_id === undefined ? cur.default_cost_center_id : d.default_cost_center_id, req.user!.id, cur.id);
    if (ccIds) { db.prepare("DELETE FROM supplier_cost_centers WHERE supplier_id = ?").run(cur.id); for (const id of ccIds) db.prepare("INSERT OR IGNORE INTO supplier_cost_centers (supplier_id, cost_center_id) VALUES (?, ?)").run(cur.id, id); }
    audit(db, req.user!.id, "supplier_update", "supplier", cur.id, JSON.stringify(d));
    return res.json({ supplier: supplierRow(cur.id) });
  });

  // ---------- e-Fatura: importação, conciliação, pedidos automáticos e email ao cliente ----------
  app.get("/api/companies/:id/efatura", auth, (req, res) => {
    const companyId = companyScoped(req, res); if (companyId === null) return;
    const conds = ["e.company_id = ?"]; const params: any[] = [companyId];
    const status = typeof req.query.status === "string" ? req.query.status : "";
    if (status && status !== "todos") { conds.push("e.status = ?"); params.push(status); }
    if (typeof req.query.period === "string" && req.query.period) { conds.push("substr(e.doc_date,1,7) = ?"); params.push(req.query.period); }
    const rows = db.prepare(`SELECT e.*, d.original_name AS document_name, r.status AS request_status FROM efatura_documents e LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN doc_requests r ON r.id = e.request_id WHERE ${conds.join(" AND ")} ORDER BY CASE e.status WHEN 'em_falta' THEN 0 ELSE 1 END, e.doc_date DESC, e.id DESC LIMIT 1000`).all(...params);
    const missingDocs = notCommunicated(db, companyId).map((m) => ({ ...m, original_name: (db.prepare("SELECT original_name FROM documents WHERE id = ?").get(m.document_id) as any)?.original_name ?? null }));
    return res.json({ documents: rows, summary: efaturaSummary(db, companyId), not_communicated: missingDocs, mail: { configured: !!(mailSender && mailSenderFrom()), from: mailSenderFrom() } });
  });

  app.post("/api/companies/:id/efatura/import", auth, requireStaff, upload.single("file"), (req, res) => {
    const companyId = companyScoped(req, res); if (companyId === null) return;
    if (!req.file) return res.status(400).json({ error: "Envie o ficheiro exportado do e-Fatura (CSV ou Excel)." });
    const parsed = parseEFaturaExport(req.file.buffer, req.file.originalname);
    if (!parsed.rows.length) return res.status(400).json({ error: "Não foi possível reconhecer documentos no ficheiro. Exporte a lista em e-Fatura > Consultar faturas (colunas emitente, tipo, número, data, total).", headers: parsed.headers });
    if (String(req.query.dry_run ?? req.body?.dry_run ?? "") === "1") return res.json({ dryRun: true, total: parsed.rows.length, headers: parsed.headers, mapping: parsed.mapping, rows: parsed.rows.slice(0, 200) });
    const report = importEFatura(db, companyId, parsed.rows, req.user!.id, "ficheiro");
    const rec = reconcileEFatura(db, companyId, req.user!.id);
    return res.json({ dryRun: false, ...report, reconcile: rec, summary: efaturaSummary(db, companyId) });
  });

  app.post("/api/companies/:id/efatura/reconcile", auth, requireStaff, (req, res) => {
    const companyId = companyScoped(req, res); if (companyId === null) return;
    const rec = reconcileEFatura(db, companyId, req.user!.id);
    return res.json({ reconcile: rec, summary: efaturaSummary(db, companyId) });
  });

  app.patch("/api/efatura/:id", auth, requireStaff, (req, res) => {
    const parsed = z.object({ status: z.enum(["em_falta", "ignorado"]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Estado inválido (em_falta ou ignorado)." });
    const cur = db.prepare("SELECT * FROM efatura_documents WHERE id = ?").get(Number(req.params.id)) as any;
    if (!cur) return res.status(404).json({ error: "Documento e-Fatura inexistente." });
    db.prepare("UPDATE efatura_documents SET status = ? WHERE id = ?").run(parsed.data.status, cur.id);
    if (parsed.data.status === "ignorado" && cur.request_id) db.prepare("UPDATE doc_requests SET status = 'cancelado' WHERE id = ? AND status = 'pendente'").run(cur.request_id);
    audit(db, req.user!.id, "efatura_update", "efatura", cur.id, parsed.data.status);
    return res.json({ ok: true });
  });

  app.get("/api/companies/:id/efatura/notify", auth, requireStaff, (req, res) => {
    const companyId = companyScoped(req, res); if (companyId === null) return;
    const draft = buildNotification(db, companyId, { period: typeof req.query.period === "string" && req.query.period ? req.query.period : null, appUrl: process.env.CONTAI_PUBLIC_URL || null, includeValidated: String(req.query.include_validated ?? "") === "1" });
    const history = db.prepare("SELECT * FROM efatura_notifications WHERE company_id = ? ORDER BY id DESC LIMIT 10").all(companyId);
    return res.json({ ...draft, mail: { configured: !!(mailSender && mailSenderFrom()), from: mailSenderFrom() }, history });
  });

  app.post("/api/companies/:id/efatura/notify", auth, requireStaff, async (req, res) => {
    const companyId = companyScoped(req, res); if (companyId === null) return;
    const parsed = z.object({ to: z.array(z.string().email()).max(20).optional(), cc: z.array(z.string().email()).max(10).optional(), period: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(), message: z.string().max(2000).nullable().optional(), include_validated: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos (destinatários têm de ser emails)." });
    const draft = buildNotification(db, companyId, { period: parsed.data.period ?? null, message: parsed.data.message ?? null, appUrl: process.env.CONTAI_PUBLIC_URL || null, includeValidated: parsed.data.include_validated === true });
    const to = parsed.data.to && parsed.data.to.length ? parsed.data.to : draft.to;
    if (!to.length) return res.status(400).json({ error: "A empresa não tem emails de cliente nem remetentes de email registados. Indique os destinatários." });
    const from = mailSenderFrom();
    if (!mailSender || !from) {
      db.prepare("INSERT INTO efatura_notifications (company_id, sent_by, recipients, subject, validated_count, missing_count, mode, error) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'Microsoft 365 sem caixa de envio configurada')").run(companyId, req.user!.id, to.join(", "), draft.subject, draft.validated.length, draft.missing.length);
      return res.status(200).json({ sent: false, reason: "Microsoft 365 não configurado para enviar email (Integrações > Microsoft 365 e caixa de correio). Copie o texto abaixo.", to, subject: draft.subject, text: draft.text });
    }
    try {
      await mailSender.sendMail(from, { to, cc: parsed.data.cc, subject: draft.subject, html: draft.html, text: draft.text });
      db.prepare("INSERT INTO efatura_notifications (company_id, sent_by, recipients, subject, validated_count, missing_count, mode) VALUES (?, ?, ?, ?, ?, ?, 'graph')").run(companyId, req.user!.id, to.join(", "), draft.subject, draft.validated.length, draft.missing.length);
      audit(db, req.user!.id, "efatura_notify", "company", companyId, JSON.stringify({ to, validated: draft.validated.length, missing: draft.missing.length }));
      return res.json({ sent: true, to, subject: draft.subject, from });
    } catch (e: any) {
      db.prepare("INSERT INTO efatura_notifications (company_id, sent_by, recipients, subject, validated_count, missing_count, mode, error) VALUES (?, ?, ?, ?, ?, ?, 'graph', ?)").run(companyId, req.user!.id, to.join(", "), draft.subject, draft.validated.length, draft.missing.length, String(e?.message || e).slice(0, 300));
      return res.status(502).json({ error: `Envio falhou: ${String(e?.message || e).slice(0, 200)}`, text: draft.text });
    }
  });

  // ---------- Obrigações declarativas (GestObrig) ----------
  const soonDays = (): number => Math.max(1, Number(process.env.GESTOBRIG_SOON_DAYS || 7) || 7);
  const obligationSelect = `SELECT o.*, c.name AS company_name, c.nif AS company_nif FROM obligations o JOIN companies c ON c.id = o.company_id`;

  app.get("/api/obligations", auth, (req, res) => {
    const companyId = scopedCompanyId(req, req.query.company_id ? Number(req.query.company_id) : null);
    const conds: string[] = []; const params: unknown[] = [];
    if (companyId !== null) { conds.push("o.company_id = ?"); params.push(companyId); }
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : "abertas";
    if (status === "abertas") conds.push("o.status = 'por_cumprir'");
    else if (status && status !== "todas") { conds.push("o.status = ?"); params.push(status); }
    if (typeof req.query.from === "string" && req.query.from) { conds.push("o.due_date >= ?"); params.push(req.query.from); }
    if (typeof req.query.to === "string" && req.query.to) { conds.push("o.due_date <= ?"); params.push(req.query.to); }
    const where = conds.length ? " WHERE " + conds.join(" AND ") : "";
    const rows = db.prepare(`${obligationSelect}${where} ORDER BY CASE WHEN o.status = 'por_cumprir' THEN 0 ELSE 1 END, o.due_date IS NULL, o.due_date, c.name LIMIT 500`).all(...params);
    const today = new Date().toISOString().slice(0, 10);
    return res.json({ obligations: rows, summary: obligationsSummary(db, companyId, today, soonDays()), today, soonDays: soonDays(), gestobrigUrl: process.env.GESTOBRIG_URL || "https://www.gestobrig.com" });
  });

  // Importa a exportação de obrigações do GestObrig (CSV ou Excel). ?dry_run=1 só mostra o que seria importado.
  app.post("/api/obligations/import", auth, requireStaff, upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Envie o ficheiro exportado do GestObrig (CSV ou Excel)." });
    const parsed = parseGestObrigExport(req.file.buffer, req.file.originalname);
    if (!parsed.rows.length) return res.status(400).json({ error: "Não foi possível reconhecer obrigações no ficheiro. Verifique se a primeira linha tem os cabeçalhos (empresa/NIF, obrigação, prazo, estado).", headers: parsed.headers });
    const onlyCompanyId = req.body?.company_id ? Number(req.body.company_id) : null;
    if (onlyCompanyId && !db.prepare("SELECT id FROM companies WHERE id = ?").get(onlyCompanyId)) return res.status(404).json({ error: "Empresa inexistente." });
    const dryRun = String(req.query.dry_run ?? req.body?.dry_run ?? "") === "1";
    if (dryRun) {
      const nifs = new Set((db.prepare("SELECT nif FROM companies").all() as any[]).map((c) => c.nif));
      const rows = parsed.rows.map((r) => ({ ...r, matched: !!onlyCompanyId || (r.nif ? nifs.has(r.nif) : false) }));
      return res.json({ dryRun: true, total: rows.length, matched: rows.filter((r) => r.matched).length, headers: parsed.headers, mapping: parsed.mapping, rows: rows.slice(0, 200) });
    }
    const report = importObligations(db, parsed.rows, req.user!.id, "gestobrig", onlyCompanyId);
    return res.json({ dryRun: false, ...report, skipped: report.skipped.slice(0, 50).map((s) => ({ reason: s.reason, label: s.row.label, nif: s.row.nif, company: s.row.companyName })), skippedTotal: report.skipped.length, headers: parsed.headers, mapping: parsed.mapping });
  });

  // Actualização manual (cumprida / justificada / reaberta) pelo gabinete.
  app.patch("/api/obligations/:id", auth, requireStaff, (req, res) => {
    const schema = z.object({
      status: z.enum(["por_cumprir", "cumprida", "fora_prazo", "justificada"]).optional(),
      submitted_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos." });
    const id = Number(req.params.id);
    const cur = db.prepare("SELECT * FROM obligations WHERE id = ?").get(id) as any;
    if (!cur) return res.status(404).json({ error: "Obrigação inexistente." });
    const d = parsed.data;
    let status = d.status ?? cur.status;
    let submitted = d.submitted_at === undefined ? cur.submitted_at : d.submitted_at;
    if (d.status === "cumprida" && !submitted) submitted = new Date().toISOString().slice(0, 10);
    if (d.status === "cumprida" && cur.due_date && submitted && submitted > cur.due_date) status = "fora_prazo";
    if (d.status === "por_cumprir") submitted = null;
    db.prepare("UPDATE obligations SET status = ?, submitted_at = ?, notes = ? WHERE id = ?").run(status, submitted, d.notes === undefined ? cur.notes : d.notes, id);
    audit(db, req.user!.id, "obligation_update", "obligations", id, JSON.stringify({ status }));
    return res.json({ obligation: db.prepare(`${obligationSelect} WHERE o.id = ?`).get(id) });
  });

  app.delete("/api/obligations/:id", auth, requireStaff, (req, res) => {
    const r = db.prepare("DELETE FROM obligations WHERE id = ?").run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: "Obrigação inexistente." });
    audit(db, req.user!.id, "obligation_delete", "obligations", Number(req.params.id));
    return res.json({ ok: true });
  });

  // ---------- Cofre de acessos às entidades (AT, Segurança Social, IAPMEI...) ----------
  const companyForCredentials = (req: Request, res: Response): number | null => {
    const requested = Number(req.params.id);
    const companyId = scopedCompanyId(req, requested);
    if (companyId !== requested) { res.status(403).json({ error: "Sem acesso a esta empresa." }); return null; }
    if (!db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId)) { res.status(404).json({ error: "Empresa inexistente." }); return null; }
    return companyId;
  };

  app.get("/api/credentials/entities", auth, (_req, res) => res.json({ entities: ENTITIES }));

  app.get("/api/companies/:id/credentials", auth, (req, res) => {
    const companyId = companyForCredentials(req, res); if (companyId === null) return;
    return res.json({ credentials: listCredentials(db, companyId), entities: ENTITIES });
  });

  // Cliente e gabinete podem criar/actualizar acessos da empresa; só o gabinete apaga.
  app.post("/api/companies/:id/credentials", auth, (req, res) => {
    const companyId = companyForCredentials(req, res); if (companyId === null) return;
    const schema = z.object({
      id: z.number().int().positive().optional(),
      entity: z.string().min(1).max(20),
      label: z.string().max(120).nullable().optional(),
      url: z.string().max(500).nullable().optional(),
      username: z.string().max(200).nullable().optional(),
      password: z.string().max(500).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos." });
    if (parsed.data.url && !/^https?:\/\//i.test(parsed.data.url)) return res.status(400).json({ error: "O endereço tem de começar por http:// ou https://." });
    try {
      const id = saveCredential(db, companyId, req.user!.id, parsed.data, parsed.data.id ?? null);
      return res.json({ credential: listCredentials(db, companyId).find((c) => c.id === id) });
    } catch (e: any) { return res.status(404).json({ error: e.message }); }
  });

  app.post("/api/companies/:id/credentials/:credId/reveal", auth, (req, res) => {
    const companyId = companyForCredentials(req, res); if (companyId === null) return;
    try { return res.json(revealCredential(db, Number(req.params.credId), companyId, req.user!.id)); }
    catch (e: any) { return res.status(404).json({ error: e.message }); }
  });

  app.delete("/api/companies/:id/credentials/:credId", auth, requireStaff, (req, res) => {
    const companyId = companyForCredentials(req, res); if (companyId === null) return;
    if (!deleteCredential(db, Number(req.params.credId), companyId, req.user!.id)) return res.status(404).json({ error: "Acesso inexistente." });
    return res.json({ ok: true });
  });

  // Importa a lista de acessos exportada do GestObrig (CSV/Excel com empresa ou NIF, entidade, utilizador, palavra-passe).
  app.post("/api/credentials/import", auth, requireStaff, upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Envie o ficheiro de acessos (CSV ou Excel)." });
    const rows = parseAccessExport(req.file.buffer, req.file.originalname);
    if (!rows.length) return res.status(400).json({ error: "Não foi possível reconhecer acessos no ficheiro (colunas esperadas: NIF ou empresa, entidade, utilizador, palavra-passe)." });
    const r = importCredentials(db, rows, req.user!.id);
    return res.json({ imported: r.imported, updated: r.updated, skippedTotal: r.skipped.length, skipped: r.skipped.slice(0, 50).map((s) => ({ reason: s.reason, entity: s.row.entity, nif: s.row.nif, company: s.row.companyName })) });
  });

  // ---------- Dashboard e calendario fiscal ----------
  app.get("/api/dashboard", auth, (req, res) => {
    const companyId = scopedCompanyId(req, req.query.company_id ? Number(req.query.company_id) : null);
    const where = companyId !== null ? "WHERE company_id = ?" : "";
    const params = companyId !== null ? [companyId] : [];

    const docCounts = db
      .prepare(`SELECT status, COUNT(*) AS n FROM documents ${where} GROUP BY status`)
      .all(...params);
    const entryCounts = db
      .prepare(`SELECT status, COUNT(*) AS n FROM entries ${where} GROUP BY status`)
      .all(...params);
    const pendingRequests = db
      .prepare(`SELECT COUNT(*) AS n FROM doc_requests ${where ? where + " AND" : "WHERE"} status = 'pendente'`)
      .get(...params) as any;
    const openFindings = db
      .prepare(`SELECT severity, COUNT(*) AS n FROM findings ${where ? where + " AND" : "WHERE"} status = 'aberto' GROUP BY severity`)
      .all(...params);
    const knowledge = req.user!.role === "staff" ? knowledgeStatus() : [];

    const today = new Date().toISOString().slice(0, 10);
    let obligations: any[] = [];
    if (companyId !== null) {
      const company = db.prepare("SELECT vat_regime FROM companies WHERE id = ?").get(companyId) as any;
      if (company) obligations = upcomingObligations(today, company.vat_regime, 60);
    } else {
      obligations = upcomingObligations(today, "mensal", 45);
    }

    const horizon = new Date(new Date(today + "T00:00:00Z").getTime() + 60 * 86400_000).toISOString().slice(0, 10);
    const managed = db.prepare(`${obligationSelect} WHERE ${companyId !== null ? "o.company_id = ? AND" : ""} o.status = 'por_cumprir' AND (o.due_date IS NULL OR o.due_date <= ?) ORDER BY o.due_date IS NULL, o.due_date, c.name LIMIT 100`).all(...params, horizon);
    const gestobrig = {
      summary: obligationsSummary(db, companyId, today, soonDays()),
      open: managed,
      total: (db.prepare(`SELECT COUNT(*) AS n FROM obligations ${where}`).get(...params) as any).n as number,
      soonDays: soonDays(),
      url: process.env.GESTOBRIG_URL || "https://www.gestobrig.com",
    };

    const efatura = companyId !== null ? efaturaSummary(db, companyId) : null;

    return res.json({
      documents: docCounts,
      entries: entryCounts,
      pendingRequests: pendingRequests?.n ?? 0,
      openFindings,
      knowledge,
      obligations,
      gestobrig,
      efatura,
    });
  });

  // ---------- Frontend estatico ----------
  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

  // Handler de erros: nunca expor detalhes internos.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Erro interno. Tente novamente." });
  });

  return app;
}
