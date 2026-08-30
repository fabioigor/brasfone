import express, { Request, Response } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Db, audit } from "./db.js";
import {
  authenticate,
  requireStaff,
  issueToken,
  verifyPassword,
  hashPassword,
  scopedCompanyId,
} from "./auth.js";
import { AiProvider } from "./ai/provider.js";
import { ingestDocument } from "./pipeline.js";
import { exportApprovedEntries } from "./domain/exportPrimavera.js";
import { upcomingObligations } from "./domain/obligations.js";
import { EntryLine, isBalanced } from "./domain/entries.js";
import { CentralGestClient, dispatchApprovedEntries, CentralGestError } from "./integrations/centralgest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  db: Db;
  provider: AiProvider;
  storageRoot: string;
  centralgest?: CentralGestClient | null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

export function createServer({ db, provider, storageRoot, centralgest = null }: ServerOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const auth = authenticate(db);

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

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
    });
    return res.status(outcome.duplicate ? 200 : 201).json(outcome);
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
        `SELECT e.*, d.original_name, d.doc_type, c.name AS company_name
         FROM entries e
         JOIN documents d ON d.id = e.document_id
         JOIN companies c ON c.id = e.company_id
         WHERE e.status = ? ORDER BY e.created_at LIMIT 200`
      )
      .all(status) as any[];
    return res.json({
      entries: rows.map((r) => ({ ...r, lines: JSON.parse(r.lines_json), lines_json: undefined })),
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
      .object({ centralgest_code: z.string().trim().min(1).nullable() })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Dados inválidos.", details: body.error.issues });
    const r = db
      .prepare("UPDATE companies SET centralgest_code = ? WHERE id = ?")
      .run(body.data.centralgest_code, Number(req.params.id));
    if (r.changes === 0) return res.status(404).json({ error: "Empresa inexistente." });
    audit(db, req.user!.id, "update", "company", Number(req.params.id), `centralgest_code=${body.data.centralgest_code}`);
    return res.json({ centralgest_code: body.data.centralgest_code });
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
