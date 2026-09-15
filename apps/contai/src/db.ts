import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { seedParameters } from "./domain/parameters.js";
import { seedFpReasons } from "./domain/exceptions.js";

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
  seedParameters(db);
  seedFpReasons(db);
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
  if (!docCols.some((c) => c.name === "onedrive_item_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN onedrive_item_id TEXT");
    db.exec("ALTER TABLE documents ADD COLUMN onedrive_url TEXT");
    db.exec("ALTER TABLE documents ADD COLUMN onedrive_path TEXT");
    db.exec("ALTER TABLE documents ADD COLUMN onedrive_synced_at TEXT");
    db.exec("ALTER TABLE documents ADD COLUMN onedrive_error TEXT");
    db.exec("ALTER TABLE documents ADD COLUMN onedrive_attempts INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS obligations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    source TEXT NOT NULL DEFAULT 'gestobrig',
    external_ref TEXT,
    code TEXT NOT NULL,
    label TEXT NOT NULL,
    period TEXT,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'por_cumprir' CHECK (status IN ('por_cumprir','cumprida','fora_prazo','justificada')),
    submitted_at TEXT,
    responsible TEXT,
    notes TEXT,
    proof_document_id INTEGER REFERENCES documents(id),
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_obligations_company_due ON obligations(company_id, due_date)");
  db.exec(`CREATE TABLE IF NOT EXISTS company_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    entity TEXT NOT NULL,
    label TEXT NOT NULL,
    url TEXT,
    username TEXT,
    password_enc TEXT,
    notes TEXT,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_credentials_company ON company_credentials(company_id)");
  // Centros de custo por empresa; fornecedores registados (marcas, site, centro de custo por omissao); descoberta por NIF em cache; dialogos de recepcao.
  db.exec(`CREATE TABLE IF NOT EXISTS cost_centers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (company_id, code)
  )`);
  const supplierCols = (db.prepare("PRAGMA table_info(supplier_profiles)").all() as any[]).map((c) => c.name);
  if (!supplierCols.includes("brand")) {
    db.exec("ALTER TABLE supplier_profiles ADD COLUMN brand TEXT");
    db.exec("ALTER TABLE supplier_profiles ADD COLUMN aliases_json TEXT");
    db.exec("ALTER TABLE supplier_profiles ADD COLUMN website TEXT");
    db.exec("ALTER TABLE supplier_profiles ADD COLUMN activity TEXT");
    db.exec("ALTER TABLE supplier_profiles ADD COLUMN registered_at TEXT");
    db.exec("ALTER TABLE supplier_profiles ADD COLUMN registered_by INTEGER");
    db.exec("ALTER TABLE supplier_profiles ADD COLUMN default_cost_center_id INTEGER");
    db.exec("ALTER TABLE supplier_profiles ADD COLUMN discovery_json TEXT");
  }
  const ccCols = (db.prepare("PRAGMA table_info(cost_centers)").all() as any[]).map((c) => c.name);
  if (!ccCols.includes("onedrive_path")) {
    db.exec("ALTER TABLE cost_centers ADD COLUMN onedrive_folder_id TEXT");
    db.exec("ALTER TABLE cost_centers ADD COLUMN onedrive_path TEXT");
    db.exec("ALTER TABLE cost_centers ADD COLUMN onedrive_url TEXT");
    db.exec("ALTER TABLE cost_centers ADD COLUMN onedrive_intake_id TEXT");
    db.exec("ALTER TABLE cost_centers ADD COLUMN onedrive_error TEXT");
    db.exec("ALTER TABLE cost_centers ADD COLUMN onedrive_attempts INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS onedrive_intake (
    item_id TEXT PRIMARY KEY,
    cost_center_id INTEGER NOT NULL REFERENCES cost_centers(id),
    document_id INTEGER REFERENCES documents(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processado','erro','ignorado')),
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS supplier_cost_centers (
    supplier_id INTEGER NOT NULL REFERENCES supplier_profiles(id) ON DELETE CASCADE,
    cost_center_id INTEGER NOT NULL REFERENCES cost_centers(id) ON DELETE CASCADE,
    PRIMARY KEY (supplier_id, cost_center_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS supplier_discoveries (
    nif TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    sources TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const docCols2 = (db.prepare("PRAGMA table_info(documents)").all() as any[]).map((c) => c.name);
  if (!docCols2.includes("cost_center_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN cost_center_id INTEGER REFERENCES cost_centers(id)");
    db.exec("ALTER TABLE documents ADD COLUMN client_doc_type TEXT");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS channel_dialogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    document_ids TEXT NOT NULL,
    step TEXT NOT NULL,
    detected_type TEXT,
    answers_json TEXT NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    UNIQUE (channel, sender)
  )`);
  // e-Fatura: documentos comunicados pelos fornecedores/clientes, conciliados com os recebidos.
  db.exec(`CREATE TABLE IF NOT EXISTS efatura_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    direction TEXT NOT NULL DEFAULT 'compra' CHECK (direction IN ('compra','venda')),
    source TEXT NOT NULL DEFAULT 'ficheiro',
    issuer_nif TEXT,
    issuer_name TEXT,
    acquirer_nif TEXT,
    doc_type TEXT,
    doc_number TEXT,
    doc_number_norm TEXT NOT NULL,
    atcud TEXT,
    doc_date TEXT,
    total REAL,
    vat REAL,
    base REAL,
    portal_status TEXT,
    sector TEXT,
    status TEXT NOT NULL DEFAULT 'em_falta' CHECK (status IN ('validado','em_falta','ignorado')),
    document_id INTEGER REFERENCES documents(id),
    match_confidence REAL,
    request_id INTEGER REFERENCES doc_requests(id),
    reconciled_at TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (company_id, issuer_nif, doc_number_norm)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_efatura_company_status ON efatura_documents(company_id, status, doc_date)");
  const reqCols = (db.prepare("PRAGMA table_info(doc_requests)").all() as any[]).map((c) => c.name);
  if (!reqCols.includes("efatura_id")) db.exec("ALTER TABLE doc_requests ADD COLUMN efatura_id INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS efatura_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    sent_by INTEGER,
    recipients TEXT NOT NULL,
    subject TEXT NOT NULL,
    validated_count INTEGER NOT NULL,
    missing_count INTEGER NOT NULL,
    mode TEXT NOT NULL,
    error TEXT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Ciclo de vida das excepções: estados, motivos fixos de falso positivo, excepções reutilizáveis, parâmetros versionados.
  db.exec(`CREATE TABLE IF NOT EXISTS fp_reasons (code TEXT PRIMARY KEY, label TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS finding_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER REFERENCES companies(id),
    code TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    justification TEXT NOT NULL,
    valid_until TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reuse_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS parameters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    note TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_parameters_key ON parameters(key, valid_from)");
  const findingCols = (db.prepare("PRAGMA table_info(findings)").all() as any[]).map((c) => c.name);
  if (!findingCols.includes("fingerprint")) {
    db.exec(`CREATE TABLE findings_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      scope TEXT NOT NULL CHECK (scope IN ('documento', 'balancete', 'conhecimento')),
      document_id INTEGER REFERENCES documents(id),
      period TEXT,
      code TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'aviso', 'erro')),
      message TEXT NOT NULL,
      detail_json TEXT,
      status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'em_analise', 'corrigido', 'falso_positivo', 'aceite', 'reaberto')),
      assigned_to INTEGER REFERENCES users(id),
      assigned_at TEXT,
      resolved_by INTEGER REFERENCES users(id),
      resolved_at TEXT,
      resolution_note TEXT,
      fp_reason TEXT,
      exception_id INTEGER,
      fingerprint TEXT,
      scope_key TEXT,
      learning INTEGER NOT NULL DEFAULT 0,
      reopened_count INTEGER NOT NULL DEFAULT 0,
      parameters_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    )`);
    db.exec(`INSERT INTO findings_v2 (id, company_id, scope, document_id, period, code, severity, message, detail_json, status, resolved_by, resolved_at, resolution_note, fp_reason, fingerprint, created_at)
             SELECT id, company_id, scope, document_id, period, code, severity, message, detail_json,
                    CASE status WHEN 'resolvido' THEN 'corrigido' WHEN 'ignorado' THEN 'falso_positivo' ELSE status END,
                    resolved_by, resolved_at, resolution_note, CASE status WHEN 'ignorado' THEN 'outro_motivo' ELSE NULL END,
                    company_id || '|' || scope || '|' || code || '|' || COALESCE(document_id, '') || '|' || COALESCE(period, '') || '|', created_at
             FROM findings`);
    db.exec("DROP TABLE findings");
    db.exec("ALTER TABLE findings_v2 RENAME TO findings");
    db.exec("CREATE INDEX IF NOT EXISTS idx_findings_company ON findings(company_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(fingerprint)");
  }
  // Perfis de acesso do gabinete (contabilista, coordenador, toc) e carteira de empresas por contabilista.
  const userCols = (db.prepare("PRAGMA table_info(users)").all() as any[]).map((c) => c.name);
  if (!userCols.includes("profile")) {
    db.exec("ALTER TABLE users ADD COLUMN profile TEXT");
    db.exec("UPDATE users SET profile = 'toc' WHERE role = 'staff' AND email != 'canais@contai.local'");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS company_assignments (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, company_id)
  )`);
  const ruleCols = (db.prepare("PRAGMA table_info(balance_rules)").all() as any[]).map((c) => c.name);
  if (!ruleCols.includes("method")) {
    db.exec("ALTER TABLE balance_rules ADD COLUMN method TEXT");
    db.exec("ALTER TABLE balance_rules ADD COLUMN min_impact REAL");
    db.exec("ALTER TABLE balance_rules ADD COLUMN cae_prefix TEXT");
    db.exec("ALTER TABLE balance_rules ADD COLUMN account TEXT");
    db.exec("ALTER TABLE balance_rules ADD COLUMN updated_by INTEGER");
    db.exec("ALTER TABLE balance_rules ADD COLUMN updated_at TEXT");
  }
  const repCols = (db.prepare("PRAGMA table_info(reports)").all() as any[]).map((c) => c.name);
  if (!repCols.includes("approved_at")) {
    db.exec("ALTER TABLE reports ADD COLUMN approved_by INTEGER");
    db.exec("ALTER TABLE reports ADD COLUMN approved_at TEXT");
    db.exec("ALTER TABLE reports ADD COLUMN sections_json TEXT");
    db.exec("ALTER TABLE reports ADD COLUMN recommendations_json TEXT");
    db.exec("ALTER TABLE reports ADD COLUMN sent_at TEXT");
  }
  const tbCols = (db.prepare("PRAGMA table_info(trial_balances)").all() as any[]).map((c) => c.name);
  if (!tbCols.includes("published_at")) {
    db.exec("ALTER TABLE trial_balances ADD COLUMN published_at TEXT");
    db.exec("ALTER TABLE trial_balances ADD COLUMN published_by INTEGER");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS legal_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('diario_republica','oficio_circulado','informacao_vinculativa','codigo','doutrina_interna','outro')),
    reference TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    url TEXT,
    published_at TEXT,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    affects TEXT,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','validado','rejeitado')),
    validated_by INTEGER,
    validated_at TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`);
  const compCols = (db.prepare("PRAGMA table_info(companies)").all() as any[]).map((c) => c.name);
  if (!compCols.includes("learning_until")) db.exec("ALTER TABLE companies ADD COLUMN learning_until TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_enc TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
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
