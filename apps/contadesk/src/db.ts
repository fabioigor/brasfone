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
  return db;
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
