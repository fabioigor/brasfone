import { Db, openDb } from "./db.js";
import { hashPassword } from "./auth.js";

/**
 * Seeds a demo firm with one staff user and two client companies.
 * Passwords here are demo-only; real deployments must change them.
 */
export function seedDemo(db: Db): void {
  const hasUsers = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n > 0;
  if (hasUsers) return;

  const insertCompany = db.prepare(
    "INSERT INTO companies (name, nif, vat_regime, activity) VALUES (?, ?, ?, ?)"
  );
  const c1 = Number(insertCompany.run("Padaria Central Lda", "506284417", "trimestral", "Padaria e pastelaria").lastInsertRowid);
  const c2 = Number(insertCompany.run("TecnoNorte Unipessoal Lda", "509442013", "mensal", "Consultoria informatica").lastInsertRowid);

  const insertUser = db.prepare(
    "INSERT INTO users (email, name, password_hash, role, company_id) VALUES (?, ?, ?, ?, ?)"
  );
  insertUser.run("gabinete@demo.pt", "Maria Contabilista", hashPassword("gabinete123"), "staff", null);
  insertUser.run("padaria@demo.pt", "Joao Padeiro", hashPassword("cliente123"), "client", c1);
  insertUser.run("tecnonorte@demo.pt", "Ana Silva", hashPassword("cliente123"), "client", c2);
}

// Executable directly: npm run seed
if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const db = openDb(process.env.DB_PATH || "data/contadesk.db");
  seedDemo(db);
  console.log("Base de dados semeada: gabinete@demo.pt / gabinete123");
}
