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
import { ingestDocument, reprocessDocument } from "./pipeline.js";
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
}: ServerOptions): express.Express {
  const app = express();
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
      .prepare("SELECT id, email, name, password_hash, role, company_id FROM users WHERE email = ?")
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
    const outcome = await ingestDocument(db, provider, storageRoot, {
      companyId,
      uploaderId: req.user!.id,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype || "application/octet-stream",
      buffer: req.file.buffer,
      channel: "portal",
      requestId,
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
    return res.json({
      entries: rows.map((r) => {
        let sources: string[] = [];
        let extracted: any = null;
        try { extracted = JSON.parse(r.extracted_json || "null"); sources = extracted?.sources || []; } catch { /* ignore */ }
        return { ...r, lines: JSON.parse(r.lines_json), lines_json: undefined, extracted_json: undefined, sources, extracted };
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
        })
      )
      .optional(),
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    description: z.string().optional(),
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

    // Aprovar, com edicao opcional das linhas.
    let lines: EntryLine[] = JSON.parse(entry.lines_json);
    if (body.data.lines) {
      lines = body.data.lines;
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
      "SELECT r.*, c.name AS company_name FROM doc_requests r JOIN companies c ON c.id = r.company_id WHERE 1=1";
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
    let sql = `SELECT f.*, c.name AS company_name, d.original_name
      FROM findings f JOIN companies c ON c.id = f.company_id LEFT JOIN documents d ON d.id = f.document_id WHERE f.status = ?`;
    const params: any[] = [status];
    if (companyId !== null) { sql += " AND f.company_id = ?"; params.push(companyId); }
    if (scope) { sql += " AND f.scope = ?"; params.push(scope); }
    // Clientes só vêem alertas que lhes dizem respeito (documentos), nunca os de balancete.
    if (req.user!.role === "client") sql += " AND f.scope = 'documento' AND f.severity != 'info'";
    sql += " ORDER BY CASE f.severity WHEN 'erro' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END, f.created_at DESC LIMIT 300";
    return res.json({ findings: db.prepare(sql).all(...params) });
  });

  app.post("/api/findings/:id/resolve", auth, requireStaff, (req, res) => {
    const body = z.object({ status: z.enum(["resolvido", "ignorado"]), note: z.string().optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos." });
    const r = db
      .prepare("UPDATE findings SET status = ?, resolved_by = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ? AND status = 'aberto'")
      .run(body.data.status, req.user!.id, body.data.note ?? null, Number(req.params.id));
    if (r.changes === 0) return res.status(404).json({ error: "Alerta inexistente ou já fechado." });
    audit(db, req.user!.id, "resolve_finding", "finding", Number(req.params.id), body.data.status);
    return res.json({ status: body.data.status });
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
        const inbound = await toInboundMessage(m, waClient);
        const result = await processInbound(db, inboundDeps(), inbound);
        if (whatsapp.reply && result.status !== "duplicado") await waClient.sendText(m.from, confirmationText(result));
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
    return res.json({ configured: true, ...onedrive.counts(), root: process.env.MS365_ROOT_FOLDER || "Cont.ai", target: process.env.MS365_SITE_ID ? "SharePoint " + process.env.MS365_SITE_ID : "OneDrive de " + (process.env.MS365_DRIVE_USER || "") });
  });
  app.post("/api/onedrive/sync", auth, requireStaff, async (req, res) => {
    if (!onedrive) return res.status(409).json({ error: "Microsoft 365 não configurado (Integrações > Microsoft 365)." });
    if (req.body?.retry_failed) onedrive.retryFailed();
    const outcomes = await onedrive.syncPending(50, req.user!.id);
    return res.json({ outcomes, ...onedrive.counts() });
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

    return res.json({
      documents: docCounts,
      entries: entryCounts,
      pendingRequests: pendingRequests?.n ?? 0,
      openFindings,
      knowledge,
      obligations,
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
