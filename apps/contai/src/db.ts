import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('staff', 'client')),
  company_id INTEGER REFERENCES companies(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  nif TEXT NOT NULL UNIQUE,
  vat_regime TEXT NOT NULL DEFAULT 'trimestral' CHECK (vat_regime IN ('mensal', 'trimestral')),
  activity TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'portal' CHECK (channel IN ('portal', 'email', 'whatsapp')),
  doc_type TEXT NOT NULL DEFAULT 'por_classificar',
  doc_date TEXT,
  period TEXT,
  classification_confidence REAL,
  classification_source TEXT,
  extracted_json TEXT,
  status TEXT NOT NULL DEFAULT 'recebido'
    CHECK (status IN ('recebido', 'classificado', 'proposto', 'validado', 'exportado', 'rejeitado')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, sha256)
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  entry_date TEXT NOT NULL,
  journal TEXT NOT NULL,
  description TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'aprovado', 'rejeitado', 'exportado')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS doc_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  details TEXT,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'cumprido', 'cancelado')),
  fulfilled_document_id INTEGER REFERENCES documents(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS export_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  format TEXT NOT NULL DEFAULT 'primavera_csv',
  entry_count INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS export_batch_entries (
  batch_id INTEGER NOT NULL REFERENCES export_batches(id),
  entry_id INTEGER NOT NULL UNIQUE REFERENCES entries(id),
  PRIMARY KEY (batch_id, entry_id)
);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES entries(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  channel TEXT NOT NULL DEFAULT 'centralgest',
  external_id TEXT NOT NULL,
  remote_id TEXT,
  remote_number TEXT,
  status TEXT NOT NULL CHECK (status IN ('lancado', 'ja_existia', 'erro')),
  error_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entry_id, channel)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  scope TEXT NOT NULL CHECK (scope IN ('documento', 'balancete', 'conhecimento')),
  document_id INTEGER REFERENCES documents(id),
  period TEXT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'aviso', 'erro')),
  message TEXT NOT NULL,
  detail_json TEXT,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'resolvido', 'ignorado')),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trial_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  period TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('importado', 'derivado')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, period)
);

CREATE TABLE IF NOT EXISTS trial_balance_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_balance_id INTEGER NOT NULL REFERENCES trial_balances(id),
  account TEXT NOT NULL,
  description TEXT,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS balance_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  account_prefixes TEXT NOT NULL,
  param TEXT,
  threshold REAL,
  severity TEXT NOT NULL DEFAULT 'aviso',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  period TEXT NOT NULL,
  template TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  data_json TEXT NOT NULL,
  html TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_findings_company ON findings(company_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_company ON reports(company_id, created_at);

CREATE TABLE IF NOT EXISTS supplier_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  nif TEXT NOT NULL,
  name TEXT,
  expense_account TEXT,
  revenue_account TEXT,
  doc_count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, nif)
);

CREATE TABLE IF NOT EXISTS company_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  address TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, address)
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  external_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  body_excerpt TEXT,
  company_id INTEGER REFERENCES companies(id),
  status TEXT NOT NULL CHECK (status IN ('processado', 'sem_empresa', 'sem_anexos', 'erro')),
  attachments INTEGER NOT NULL DEFAULT 0,
  document_ids TEXT,
  error_detail TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_status ON inbound_messages(status, received_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_company ON documents(company_id, status);
CREATE INDEX IF NOT EXISTS idx_entries_company ON entries(company_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_company ON doc_requests(company_id, status);
`;

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db: Db): void {
  const companyCols = db.prepare("PRAGMA table_info(companies)").all() as any[];
  if (!companyCols.some((c) => c.name === "centralgest_code")) {
    db.exec("ALTER TABLE companies ADD COLUMN centralgest_code TEXT");
  }
  if (!companyCols.some((c) => c.name === "cae")) {
    db.exec("ALTER TABLE companies ADD COLUMN cae TEXT");
  }
  if (!companyCols.some((c) => c.name === "territory")) {
    db.exec("ALTER TABLE companies ADD COLUMN territory TEXT NOT NULL DEFAULT 'continente'");
  }
  const docCols = db.prepare("PRAGMA table_info(documents)").all() as any[];
  if (!docCols.some((c) => c.name === "ocr_text")) {
    db.exec("ALTER TABLE documents ADD COLUMN ocr_text TEXT");
    db.exec("ALTER TABLE documents ADD COLUMN ocr_method TEXT");
    db.exec("ALTER TABLE documents ADD COLUMN ocr_confidence REAL");
  }
}

export function audit(
  db: Db,
  userId: number | null,
  action: string,
  entity: string,
  entityId: number | null,
  detail?: string
): void {
  db.prepare(
    "INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, action, entity, entityId, detail ?? null);
}
