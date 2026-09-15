/**
 * Access vault per client company: usernames and passwords for official portals (AT, Segurança Social
 * Directa, IAPMEI, fundos de compensação...). Passwords are AES-256-GCM encrypted with the same key
 * as the integration settings, only decrypted on an explicit "reveal" that is audited, and visible to
 * the firm and to the company's own client users. Quick-access buttons open the portal; the client
 * copies the credentials. No autologin is attempted: the official portals use CAPTCHA, 2FA and
 * Chave Móvel Digital, and automating them would breach their terms.
 */
import { Db, audit } from "../db.js";
import { encryptValue, decryptValue } from "../settings.js";

export interface EntityDef { code: string; label: string; url: string; hint?: string }

export const ENTITIES: EntityDef[] = [
  { code: "AT", label: "Portal das Finanças (AT)", url: "https://www.portaldasfinancas.gov.pt", hint: "Senha de acesso da empresa; procurações e declarações." },
  { code: "EFATURA", label: "e-Fatura", url: "https://faturas.portaldasfinancas.gov.pt", hint: "Mesma senha do Portal das Finanças." },
  { code: "SSD", label: "Segurança Social Directa", url: "https://app.seg-social.pt/sso/login", hint: "NISS da entidade empregadora e palavra-passe; aceitação de termos e consultas." },
  { code: "IAPMEI", label: "IAPMEI (Certificação PME)", url: "https://www.iapmei.pt", hint: "Renovação anual do certificado PME." },
  { code: "FCT", label: "Fundos de Compensação (FCT/FGCT)", url: "https://www.fundoscompensacao.pt", hint: "Entregas mensais e pedidos de reembolso." },
  { code: "ACT", label: "Autoridade para as Condições do Trabalho", url: "https://www.act.gov.pt", hint: "Comunicações obrigatórias." },
  { code: "BP", label: "Banco de Portugal (BPnet)", url: "https://www.bportugal.pt", hint: "Comunicações estatísticas e COL." },
  { code: "GESTOBRIG", label: "GestObrig", url: "https://www.gestobrig.com", hint: "Acesso do gabinete ou do cliente ao GestObrig." },
  { code: "OUTRO", label: "Outra entidade", url: "" },
];

export const ENTITY_BY_CODE = new Map(ENTITIES.map((e) => [e.code, e]));

export interface CredentialInput { entity: string; label?: string | null; url?: string | null; username?: string | null; password?: string | null; notes?: string | null }

export function listCredentials(db: Db, companyId: number) {
  const rows = db.prepare("SELECT id, company_id, entity, label, url, username, notes, updated_at, (password_enc IS NOT NULL) AS has_password FROM company_credentials WHERE company_id = ? ORDER BY entity, label").all(companyId) as any[];
  return rows.map((r) => ({ ...r, has_password: !!r.has_password }));
}

export function saveCredential(db: Db, companyId: number, userId: number, input: CredentialInput, id: number | null = null): number {
  const def = ENTITY_BY_CODE.get(input.entity) ?? ENTITY_BY_CODE.get("OUTRO")!;
  const label = (input.label ?? "").trim() || def.label;
  const url = (input.url ?? "").trim() || def.url || null;
  const username = (input.username ?? "").trim() || null;
  const notes = (input.notes ?? "").trim() || null;
  if (id) {
    const cur = db.prepare("SELECT id FROM company_credentials WHERE id = ? AND company_id = ?").get(id, companyId);
    if (!cur) throw new Error("Acesso inexistente.");
    if (input.password != null && input.password !== "") {
      db.prepare("UPDATE company_credentials SET entity = ?, label = ?, url = ?, username = ?, password_enc = ?, notes = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
        .run(def.code, label, url, username, encryptValue(input.password), notes, userId, id);
    } else {
      db.prepare("UPDATE company_credentials SET entity = ?, label = ?, url = ?, username = ?, notes = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
        .run(def.code, label, url, username, notes, userId, id);
    }
    audit(db, userId, "credential_update", "company_credentials", id);
    return id;
  }
  const r = db.prepare("INSERT INTO company_credentials (company_id, entity, label, url, username, password_enc, notes, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(companyId, def.code, label, url, username, input.password ? encryptValue(input.password) : null, notes, userId);
  const newId = Number(r.lastInsertRowid);
  audit(db, userId, "credential_create", "company_credentials", newId);
  return newId;
}

/** Decrypts one password; every call is audited with the user who looked. */
export function revealCredential(db: Db, id: number, companyId: number, userId: number): { username: string | null; password: string | null; url: string | null } {
  const row = db.prepare("SELECT username, password_enc, url FROM company_credentials WHERE id = ? AND company_id = ?").get(id, companyId) as any;
  if (!row) throw new Error("Acesso inexistente.");
  audit(db, userId, "credential_reveal", "company_credentials", id);
  return { username: row.username, password: row.password_enc ? decryptValue(row.password_enc) : null, url: row.url };
}

export function deleteCredential(db: Db, id: number, companyId: number, userId: number): boolean {
  const r = db.prepare("DELETE FROM company_credentials WHERE id = ? AND company_id = ?").run(id, companyId);
  if (r.changes) audit(db, userId, "credential_delete", "company_credentials", id);
  return r.changes > 0;
}

/** Bulk import (e.g. exported from GestObrig "acessos rápidos"): rows with nif/company, entity, username, password, url. */
export interface CredentialImportRow { nif: string | null; companyName: string | null; entity: string; label: string | null; url: string | null; username: string | null; password: string | null; notes: string | null }

export function entityCodeFor(label: string): string {
  const s = label.toLowerCase();
  if (/finan|\bat\b|portal das/.test(s)) return "AT";
  if (/e-?fa[ct]ura/.test(s)) return "EFATURA";
  if (/seg.*social|\bssd\b|niss/.test(s)) return "SSD";
  if (/iapmei|pme/.test(s)) return "IAPMEI";
  if (/fundo|fct|fgct|compensa/.test(s)) return "FCT";
  if (/\bact\b|condi[cç][oõ]es do trabalho/.test(s)) return "ACT";
  if (/banco de portugal|bpnet|\bbp\b/.test(s)) return "BP";
  if (/gestobrig/.test(s)) return "GESTOBRIG";
  return "OUTRO";
}

export function importCredentials(db: Db, rows: CredentialImportRow[], userId: number): { imported: number; updated: number; skipped: { reason: string; row: CredentialImportRow }[] } {
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const byNif = new Map<string, number>(); const byName = new Map<string, number>();
  for (const c of db.prepare("SELECT id, nif, name FROM companies").all() as any[]) { byNif.set(c.nif, c.id); byName.set(norm(c.name), c.id); }
  const out = { imported: 0, updated: 0, skipped: [] as { reason: string; row: CredentialImportRow }[] };
  const tx = db.transaction(() => {
    for (const r of rows) {
      const companyId = (r.nif ? byNif.get(r.nif) : undefined) ?? (r.companyName ? byName.get(norm(r.companyName)) : undefined);
      if (!companyId) { out.skipped.push({ reason: r.nif ? `NIF ${r.nif} não existe nas empresas` : "empresa não reconhecida", row: r }); continue; }
      const entity = ENTITY_BY_CODE.has(r.entity) ? r.entity : entityCodeFor(r.label || r.entity || "");
      const label = r.label || ENTITY_BY_CODE.get(entity)!.label;
      const existing = db.prepare("SELECT id FROM company_credentials WHERE company_id = ? AND entity = ? AND label = ?").get(companyId, entity, label) as any;
      saveCredential(db, companyId, userId, { entity, label, url: r.url, username: r.username, password: r.password, notes: r.notes }, existing?.id ?? null);
      if (existing) out.updated++; else out.imported++;
    }
  });
  tx();
  audit(db, userId, "credentials_import", "company_credentials", null, JSON.stringify({ imported: out.imported, updated: out.updated, skipped: out.skipped.length }));
  return out;
}
