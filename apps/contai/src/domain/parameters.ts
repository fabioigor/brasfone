/**
 * Versioned parameters: no legal value or threshold lives in code. Each parameter has a validity
 * window (valid_from / valid_to) and every check records the version it used, so reprocessing an
 * old period gives the same result. Values are JSON (numbers, strings, objects).
 */
import { Db, audit } from "../db.js";

export interface ParameterDef { key: string; label: string; unit: string; description: string; defaultValue: unknown }

/** Defaults seeded on first run (valid from 2020-01-01). Change values by inserting new versions, never by editing code. */
export const PARAMETER_DEFS: ParameterDef[] = [
  { key: "tolerancia_iva_linha_eur", label: "Tolerância do IVA por linha", unit: "€", description: "A1.01: IVA da linha = base × taxa, com arredondamento por linha ou por documento.", defaultValue: 0.01 },
  { key: "tolerancia_total_documento_eur", label: "Tolerância do total do documento", unit: "€", description: "A1.02/A1.03: soma das linhas e base + IVA − retenções face ao total.", defaultValue: 0.01 },
  { key: "tolerancia_balancete_eur", label: "Tolerância do equilíbrio do balancete", unit: "€", description: "B1.01: total de débitos face ao total de créditos.", defaultValue: 0.01 },
  { key: "duplicado_valor_eur", label: "Tolerância de valor na detecção de duplicados", unit: "€", description: "A1.08: mesmo NIF, número e valor.", defaultValue: 0.01 },
  { key: "score_artigo_aplicar", label: "Score mínimo para aplicar a ficha de artigo", unit: "0-1", description: "A3: acima deste score o enquadramento é aplicado na conferência (com aviso se divergir).", defaultValue: 0.9 },
  { key: "score_artigo_validar", label: "Score mínimo para fila de validação", unit: "0-1", description: "A3: entre este score e o de aplicação a ficha vai à fila de validação; abaixo só apresenta hipóteses.", defaultValue: 0.7 },
  { key: "periodo_aprendizagem_meses", label: "Período de aprendizagem por cliente novo", unit: "meses", description: "B2: alertas de variação marcados como em aprendizagem, fora da checklist de fecho.", defaultValue: 6 },
  { key: "escala_impactos_minimos", label: "Escala dos impactos mínimos em euros", unit: "×", description: "B2: multiplica os impactos mínimos dos padrões; recalcular a partir da facturação mediana da carteira.", defaultValue: 1 },
  { key: "variacao_taxa_efectiva_pp", label: "Desvio da taxa média efectiva de IVA", unit: "p.p.", description: "A4.01: desvio face à mediana de 12 meses.", defaultValue: 2 },
  { key: "divergencia_dp_eur", label: "Divergência IVA apurado vs declarado", unit: "€", description: "A4.06 / B3.01.", defaultValue: 50 },
];

export function seedParameters(db: Db): void {
  const ins = db.prepare("INSERT OR IGNORE INTO parameters (key, value_json, valid_from, valid_to, note, created_by) VALUES (?, ?, '2020-01-01', NULL, 'valor inicial da especificação', NULL)");
  for (const p of PARAMETER_DEFS) {
    const exists = db.prepare("SELECT 1 FROM parameters WHERE key = ? LIMIT 1").get(p.key);
    if (!exists) ins.run(p.key, JSON.stringify(p.defaultValue));
  }
}

export interface ParameterVersion { id: number; key: string; value: unknown; validFrom: string; validTo: string | null; note: string | null }

/** Value of a parameter on a given date (the document's or period's date). */
export function parameterAt(db: Db, key: string, date: string): ParameterVersion | null {
  const r = db.prepare("SELECT * FROM parameters WHERE key = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?) ORDER BY valid_from DESC LIMIT 1").get(key, date, date) as any;
  if (!r) return null;
  return { id: r.id, key: r.key, value: JSON.parse(r.value_json), validFrom: r.valid_from, validTo: r.valid_to, note: r.note };
}

export function numberAt(db: Db, key: string, date: string, fallback: number): { value: number; versionId: number | null } {
  const p = parameterAt(db, key, date);
  const v = p ? Number(p.value) : NaN;
  return { value: isFinite(v) ? v : fallback, versionId: p?.id ?? null };
}

export function listParameters(db: Db, key?: string): ParameterVersion[] {
  const rows = (key ? db.prepare("SELECT * FROM parameters WHERE key = ? ORDER BY valid_from DESC").all(key) : db.prepare("SELECT * FROM parameters ORDER BY key, valid_from DESC").all()) as any[];
  return rows.map((r) => ({ id: r.id, key: r.key, value: JSON.parse(r.value_json), validFrom: r.valid_from, validTo: r.valid_to, note: r.note }));
}

/** Adds a new version: the previous open version is closed the day before. Never edits history. */
export function addParameterVersion(db: Db, userId: number, key: string, value: unknown, validFrom: string, note: string | null): ParameterVersion {
  if (!PARAMETER_DEFS.some((d) => d.key === key)) throw new Error("Parâmetro desconhecido.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) throw new Error("Data de eficácia inválida.");
  const tx = db.transaction(() => {
    const prev = db.prepare("SELECT id, value_json, valid_from FROM parameters WHERE key = ? AND (valid_to IS NULL OR valid_to >= ?) ORDER BY valid_from DESC LIMIT 1").get(key, validFrom) as any;
    if (prev && prev.valid_from >= validFrom) throw new Error(`Já existe uma versão com eficácia a partir de ${prev.valid_from}; use uma data posterior.`);
    const dayBefore = new Date(new Date(validFrom + "T00:00:00Z").getTime() - 86400_000).toISOString().slice(0, 10);
    if (prev) db.prepare("UPDATE parameters SET valid_to = ? WHERE id = ?").run(dayBefore, prev.id);
    const r = db.prepare("INSERT INTO parameters (key, value_json, valid_from, valid_to, note, created_by) VALUES (?, ?, ?, NULL, ?, ?)").run(key, JSON.stringify(value), validFrom, note, userId);
    audit(db, userId, "parameter_version", "parameter", Number(r.lastInsertRowid), JSON.stringify({ key, value, validFrom, previous: prev ? JSON.parse(prev.value_json) : null }));
    return Number(r.lastInsertRowid);
  });
  const id = tx();
  return listParameters(db, key).find((p) => p.id === id)!;
}
