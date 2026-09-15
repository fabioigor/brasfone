import { Db, openDb } from "./db.js";
import { hashPassword } from "./auth.js";
import { seedDefaultRules } from "./domain/balanceRules.js";

/**
 * Seeds a demo firm with one staff user and two client companies.
 * Passwords here are demo-only; real deployments must change them.
 */
export function seedDemo(db: Db): void {
  seedDefaultRules(db);
  const hasUsers = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n > 0;
  if (hasUsers) return;

  const insertCompany = db.prepare(
    "INSERT INTO companies (name, nif, vat_regime, activity, cae) VALUES (?, ?, ?, ?, ?)"
  );
  const c1 = Number(insertCompany.run("Padaria Central Lda", "506284417", "trimestral", "Padaria e pastelaria", "10711").lastInsertRowid);
  const c2 = Number(insertCompany.run("TecnoNorte Unipessoal Lda", "509442013", "mensal", "Consultoria informatica", "62020").lastInsertRowid);

  const insertCc = db.prepare("INSERT INTO cost_centers (company_id, code, name) VALUES (?, ?, ?)");
  for (const [code, name] of [["LOJA", "Loja"], ["FABRICO", "Fabrico"], ["ADMIN", "Administracao"]]) insertCc.run(c1, code, name);
  for (const [code, name] of [["PROJ", "Projectos"], ["ADMIN", "Administracao"]]) insertCc.run(c2, code, name);

  const insertUser = db.prepare(
    "INSERT INTO users (email, name, password_hash, role, company_id) VALUES (?, ?, ?, ?, ?)"
  );
  insertUser.run("gabinete@demo.pt", "Maria Contabilista", hashPassword("gabinete123"), "staff", null);
  insertUser.run("padaria@demo.pt", "Joao Padeiro", hashPassword("cliente123"), "client", c1);
  db.prepare("UPDATE users SET profile = 'toc' WHERE role = 'staff' AND profile IS NULL").run();
  insertUser.run("tecnonorte@demo.pt", "Ana Silva", hashPassword("cliente123"), "client", c2);
}

/**
 * Creates (once) the first staff account of a real deployment from the environment.
 * Idempotent: an existing account with the same email is never touched, so the
 * variables can stay in .env without resetting the password on every restart.
 */
export function bootstrapAdmin(db: Db, email: string, password: string): "created" | "exists" {
  const normalised = email.trim().toLowerCase();
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(normalised);
  if (exists) return "exists";
  db.prepare("INSERT INTO users (email, name, password_hash, role, company_id, profile) VALUES (?, ?, ?, 'staff', NULL, 'toc')")
    .run(normalised, "Administração", hashPassword(password));
  return "created";
}

/** Demo data is seeded outside production, or when explicitly requested (CONTAI_SEED_DEMO=1). */
export function demoModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CONTAI_SEED_DEMO === "1") return true;
  if (env.CONTAI_SEED_DEMO === "0") return false;
  return env.NODE_ENV !== "production";
}

// Executable directly: npm run seed
if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const db = openDb(process.env.DB_PATH || "data/contai.db");
  seedDemo(db);
  console.log("Base de dados semeada: gabinete@demo.pt / gabinete123");
}
