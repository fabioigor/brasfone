/**
 * Exception lifecycle for findings (module A and B alerts). A finding is an exception with state,
 * never a static report:
 *   aberto → em_analise → corrigido | falso_positivo | aceite ;  reaberto when it recurs after a fix.
 * Closing as falso_positivo requires a reason from a short fixed list (the reason, not free text,
 * feeds threshold tuning); aceite records a reusable justification (an exception rule) that
 * auto-accepts identical future alerts. Reopened findings raise severity. Every transition is audited.
 */
import { Db, audit } from "../db.js";
import { Finding, Severity } from "./vatAudit.js";

export type FindingStatus = "aberto" | "em_analise" | "corrigido" | "falso_positivo" | "aceite" | "reaberto";
export const OPEN_STATUSES: FindingStatus[] = ["aberto", "em_analise", "reaberto"];
export const CLOSED_STATUSES: FindingStatus[] = ["corrigido", "falso_positivo", "aceite"];

export const SEVERITY_LABEL: Record<Severity, string> = { erro: "Bloqueante", aviso: "Alerta", info: "Informativo" };

/** Proposed closed list of false-positive reasons (INUBIA proposes 8; Lumarcont corrects in Configuração). */
export const DEFAULT_FP_REASONS: { code: string; label: string }[] = [
  { code: "arredondamento_software", label: "Arredondamento do software de facturação (por linha vs por documento)" },
  { code: "isencao_ou_regime_especial", label: "Operação isenta ou em regime especial não reconhecido pela regra" },
  { code: "espaco_fiscal", label: "Taxa de outro espaço fiscal (Açores, Madeira, estrangeiro)" },
  { code: "sazonalidade_prevista", label: "Variação sazonal ou pontual já prevista" },
  { code: "corrigido_noutro_periodo", label: "Situação já corrigida noutro período ou documento" },
  { code: "regra_mal_calibrada", label: "Limiar ou tolerância da regra mal calibrados" },
  { code: "dados_extraidos_incorrectos", label: "Dados extraídos incorrectamente (OCR/IA), documento correcto" },
  { code: "outro_motivo", label: "Outro motivo (descrever no contexto)" },
];

export function seedFpReasons(db: Db): void {
  const ins = db.prepare("INSERT OR IGNORE INTO fp_reasons (code, label, active, sort_order) VALUES (?, ?, 1, ?)");
  DEFAULT_FP_REASONS.forEach((r, i) => ins.run(r.code, r.label, i));
}

export function listFpReasons(db: Db, onlyActive = true): { code: string; label: string; active: boolean }[] {
  return (db.prepare(`SELECT code, label, active FROM fp_reasons ${onlyActive ? "WHERE active = 1" : ""} ORDER BY sort_order, code`).all() as any[]).map((r) => ({ code: r.code, label: r.label, active: r.active === 1 }));
}

const RAISE: Record<Severity, Severity> = { info: "aviso", aviso: "erro", erro: "erro" };

/** Stable identity of an alert across runs: company + scope + code + document or period + rule name. */
export function fingerprintOf(companyId: number, scope: string, code: string, documentId: number | null, period: string | null, detail?: Record<string, unknown>): string {
  const rule = detail && typeof detail.rule === "string" ? detail.rule : "";
  return [companyId, scope, code, documentId ?? "", period ?? "", rule].join("|");
}

/** Scope key used by exception rules: supplier NIF for documents, account/rule for balances. */
export function scopeKeyOf(scope: string, code: string, detail: Record<string, unknown> | undefined, counterpartyNif: string | null): string {
  if (scope === "documento") return counterpartyNif ? `nif:${counterpartyNif}` : `code:${code}`;
  const rule = detail && typeof detail.rule === "string" ? detail.rule : code;
  return `regra:${rule}`;
}

export interface PersistInput {
  companyId: number;
  scope: "documento" | "balancete" | "conhecimento";
  documentId?: number | null;
  period?: string | null;
  findings: Finding[];
  counterpartyNif?: string | null;
  /** Variation alerts during the client's learning period are recorded but flagged. */
  learningCodes?: Set<string>;
  parametersVersion?: string | null;
}

export interface PersistResult { created: number; reopened: number; autoAccepted: number; learning: number }

/**
 * Replaces the open findings of a document/period with the new run, applying:
 * reusable exceptions (auto-accept), reopen detection (recurrence after corrigido raises severity),
 * learning flag. Closed findings are never deleted.
 */
export function persistFindings(db: Db, input: PersistInput): PersistResult {
  const res: PersistResult = { created: 0, reopened: 0, autoAccepted: 0, learning: 0 };
  const tx = db.transaction(() => {
    if (input.scope === "documento") db.prepare("DELETE FROM findings WHERE document_id = ? AND status IN ('aberto','em_analise','reaberto')").run(input.documentId ?? -1);
    else db.prepare("DELETE FROM findings WHERE company_id = ? AND scope = ? AND period = ? AND status IN ('aberto','em_analise','reaberto')").run(input.companyId, input.scope, input.period ?? "");
    const ins = db.prepare(`INSERT INTO findings (company_id, scope, document_id, period, code, severity, message, detail_json, status, fingerprint, scope_key, learning, reopened_count, exception_id, resolved_by, resolved_at, resolution_note, parameters_version)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`);
    const findException = db.prepare("SELECT id, justification FROM finding_exceptions WHERE code = ? AND scope_key = ? AND (company_id IS NULL OR company_id = ?) AND (valid_until IS NULL OR valid_until >= date('now')) ORDER BY company_id IS NULL LIMIT 1");
    const lastClosed = db.prepare("SELECT status, reopened_count FROM findings WHERE fingerprint = ? AND status IN ('corrigido','falso_positivo','aceite') ORDER BY id DESC LIMIT 1");
    for (const f of input.findings) {
      const fp = fingerprintOf(input.companyId, input.scope, f.code, input.documentId ?? null, input.period ?? null, f.detail);
      const scopeKey = scopeKeyOf(input.scope, f.code, f.detail, input.counterpartyNif ?? null);
      const learning = input.learningCodes?.has(f.code) ? 1 : 0;
      const exc = findException.get(f.code, scopeKey, input.companyId) as any;
      if (exc) {
        ins.run(input.companyId, input.scope, input.documentId ?? null, input.period ?? null, f.code, f.severity, f.message, f.detail ? JSON.stringify(f.detail) : null, "aceite", fp, scopeKey, learning, 0, exc.id, new Date().toISOString(), `Excepção reutilizada: ${exc.justification}`, input.parametersVersion ?? null);
        db.prepare("UPDATE finding_exceptions SET reuse_count = reuse_count + 1, last_used_at = datetime('now') WHERE id = ?").run(exc.id);
        res.autoAccepted++; continue;
      }
      const prev = lastClosed.get(fp) as any;
      let status: FindingStatus = "aberto"; let severity = f.severity; let reopened = 0;
      if (prev && prev.status === "corrigido") { status = "reaberto"; severity = RAISE[f.severity]; reopened = (prev.reopened_count ?? 0) + 1; res.reopened++; }
      ins.run(input.companyId, input.scope, input.documentId ?? null, input.period ?? null, f.code, severity, f.message, f.detail ? JSON.stringify(f.detail) : null, status, fp, scopeKey, learning, reopened, null, null, null, input.parametersVersion ?? null);
      res.created++; if (learning) res.learning++;
    }
  });
  tx();
  return res;
}

export interface TransitionInput { status: FindingStatus; note?: string | null; reason?: string | null; assigneeId?: number | null; createException?: boolean; exceptionValidUntil?: string | null }

export interface UserLike { id: number; profile?: string | null }

/** Applies a state transition with the lifecycle's rules. Throws with a user-facing message when invalid. */
export function transitionFinding(db: Db, id: number, user: UserLike, input: TransitionInput): any {
  const f = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as any;
  if (!f) throw new Error("Alerta inexistente.");
  const isOpen = OPEN_STATUSES.includes(f.status);
  const target = input.status;
  if (target === "aberto") throw new Error("Um alerta não volta a 'aberto' manualmente; use reabrir a partir de um fechado.");
  if (target === "reaberto") {
    if (isOpen) throw new Error("O alerta ainda está aberto.");
    db.prepare("UPDATE findings SET status = 'reaberto', reopened_count = reopened_count + 1, severity = ?, resolved_by = NULL, resolved_at = NULL, updated_at = datetime('now') WHERE id = ?").run(RAISE[f.severity as Severity], id);
    audit(db, user.id, "finding_reopen", "finding", id, input.note ?? undefined);
    return db.prepare("SELECT * FROM findings WHERE id = ?").get(id);
  }
  if (!isOpen) throw new Error(`Alerta já fechado (${f.status}).`);
  if (f.status === "reaberto" && user.profile && user.profile !== "toc") throw new Error("Um alerta reaberto só pode ser fechado pelo TOC responsável.");
  if (target === "em_analise") {
    const assignee = input.assigneeId ?? user.id;
    db.prepare("UPDATE findings SET status = 'em_analise', assigned_to = ?, assigned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(assignee, id);
    audit(db, user.id, "finding_assign", "finding", id, String(assignee));
    return db.prepare("SELECT * FROM findings WHERE id = ?").get(id);
  }
  let exceptionId: number | null = null;
  if (target === "falso_positivo") {
    const reason = (input.reason ?? "").trim();
    const valid = db.prepare("SELECT 1 FROM fp_reasons WHERE code = ? AND active = 1").get(reason);
    if (!valid) throw new Error("Falso positivo exige um motivo da lista.");
  }
  if (target === "aceite") {
    if (!(input.note ?? "").trim()) throw new Error("Aceitar um desvio exige justificação.");
    if (input.createException) {
      const r = db.prepare("INSERT INTO finding_exceptions (company_id, code, scope_key, justification, valid_until, created_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run(f.company_id, f.code, f.scope_key, input.note!.trim(), input.exceptionValidUntil ?? null, user.id);
      exceptionId = Number(r.lastInsertRowid);
      audit(db, user.id, "exception_create", "finding_exception", exceptionId, JSON.stringify({ code: f.code, scopeKey: f.scope_key }));
    }
  }
  db.prepare("UPDATE findings SET status = ?, resolved_by = ?, resolved_at = datetime('now'), resolution_note = ?, fp_reason = ?, exception_id = COALESCE(?, exception_id), updated_at = datetime('now') WHERE id = ?")
    .run(target, user.id, input.note?.trim() || null, target === "falso_positivo" ? input.reason : null, exceptionId, id);
  audit(db, user.id, "finding_close", "finding", id, JSON.stringify({ status: target, reason: input.reason ?? null, previous: f.status }));
  return db.prepare("SELECT * FROM findings WHERE id = ?").get(id);
}

export interface RuleMetrics { code: string; open: number; closed: number; corrigido: number; falso_positivo: number; aceite: number; precision: number | null; fpRate: number | null; avgDays: number | null; reopened: number }

/** Engine indicators: precision per rule, false-positive rate, average closure time, reopenings. */
export function findingMetrics(db: Db, companyId: number | null, from: string | null): { rules: RuleMetrics[]; totals: RuleMetrics & { learning: number } } {
  const conds: string[] = []; const params: any[] = [];
  if (companyId !== null) { conds.push("company_id = ?"); params.push(companyId); }
  if (from) { conds.push("created_at >= ?"); params.push(from); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = db.prepare(`SELECT code,
      SUM(CASE WHEN status IN ('aberto','em_analise','reaberto') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'corrigido' THEN 1 ELSE 0 END) AS corrigido,
      SUM(CASE WHEN status = 'falso_positivo' THEN 1 ELSE 0 END) AS falso_positivo,
      SUM(CASE WHEN status = 'aceite' THEN 1 ELSE 0 END) AS aceite,
      SUM(reopened_count) AS reopened,
      SUM(learning) AS learning,
      AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at) - julianday(created_at)) END) AS avg_days
    FROM findings ${where} GROUP BY code ORDER BY code`).all(...params) as any[];
  const mk = (r: any): RuleMetrics => {
    const closed = (r.corrigido || 0) + (r.falso_positivo || 0) + (r.aceite || 0);
    return { code: r.code, open: r.open || 0, closed, corrigido: r.corrigido || 0, falso_positivo: r.falso_positivo || 0, aceite: r.aceite || 0,
      precision: closed ? Math.round(((r.corrigido || 0) / closed) * 1000) / 10 : null, fpRate: closed ? Math.round(((r.falso_positivo || 0) / closed) * 1000) / 10 : null,
      avgDays: r.avg_days != null ? Math.round(r.avg_days * 10) / 10 : null, reopened: r.reopened || 0 };
  };
  const rules = rows.map(mk);
  const t = rules.reduce((a, r) => ({ open: a.open + r.open, corrigido: a.corrigido + r.corrigido, falso_positivo: a.falso_positivo + r.falso_positivo, aceite: a.aceite + r.aceite, reopened: a.reopened + r.reopened }), { open: 0, corrigido: 0, falso_positivo: 0, aceite: 0, reopened: 0 });
  const closed = t.corrigido + t.falso_positivo + t.aceite;
  const avgAll = db.prepare(`SELECT AVG(julianday(resolved_at) - julianday(created_at)) AS d, SUM(learning) AS l FROM findings ${where ? where + " AND" : "WHERE"} resolved_at IS NOT NULL`).get(...params) as any;
  const learning = (db.prepare(`SELECT SUM(learning) AS l FROM findings ${where}`).get(...params) as any)?.l || 0;
  return { rules, totals: { code: "*", ...t, closed, precision: closed ? Math.round((t.corrigido / closed) * 1000) / 10 : null, fpRate: closed ? Math.round((t.falso_positivo / closed) * 1000) / 10 : null, avgDays: avgAll?.d != null ? Math.round(avgAll.d * 10) / 10 : null, learning } };
}

/** Open blocking findings of a document (used to require a justification before approval). */
export function blockingFindings(db: Db, documentId: number): any[] {
  return db.prepare("SELECT id, code, message FROM findings WHERE document_id = ? AND severity = 'erro' AND status IN ('aberto','em_analise','reaberto') AND learning = 0").all(documentId) as any[];
}
