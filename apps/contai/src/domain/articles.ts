/**
 * A3: article framing records ("fichas de enquadramento fiscal"). The engine classifies articles,
 * not lines: each article of each client gets a persistent record with the proposed VAT band,
 * legal basis (Lista I/II verba), confidence score and state. Once validated, every future line of
 * that article is checked against the record without any AI. Only new articles, changed
 * descriptions or articles affected by a legal change re-enter the classifier.
 *
 * Score bands come from versioned parameters: >= score_artigo_aplicar the framing is applied in the
 * audit (with a warning when it diverges from the invoice); between the two thresholds it waits in
 * the validation queue; below score_artigo_validar only hypotheses are shown.
 */
import { Db, audit } from "../db.js";
import { ExtractedData } from "./extraction.js";
import { categoriseItem, bandRate } from "./vatAudit.js";
import { Territory, VatBand, ratesOn } from "../knowledge/index.js";
import { numberAt } from "./parameters.js";

export type Band = VatBand | "isento";
export type ArticleStatus = "proposto" | "validado" | "rejeitado";
export type ArticleQueue = "aplicar" | "validar" | "hipoteses" | "validado" | "rejeitado";

export interface ArticleRecord {
  id: number; company_id: number; key: string; description: string; cae: string | null;
  proposed_band: Band | null; legal_basis: string | null; score: number; status: ArticleStatus; queue: ArticleQueue;
  validated_band: Band | null; validated_by: number | null; validated_at: string | null; effective_from: string | null;
  occurrences: number; last_seen: string | null; observed_rates: number[]; source: string; notes: string | null;
}

/** Normalised article key: no accents, no quantities/units/packaging/codes, collapsed spaces. */
export function articleKey(description: string): string {
  return description.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b\d+([.,]\d+)?\s*(kg|g|gr|l|ml|cl|un|uni|unid|unidades|cx|caixa|pack|emb|m|m2|m3|cm|mm|h|hrs|horas)\b/g, " ")
    .replace(/\b(ref|cod|art|sku)[.:]?\s*[a-z0-9-]+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\b\d+\b/g, " ")
    .replace(/\b(saco|sacos|caixa|caixas|embalagem|emb|garrafa|garrafas|lata|latas|pacote|pacotes|unidade|unidades|un|uni|unid|cx)\b/g, " ").replace(/\b[a-z]\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export interface Proposal { band: Band | null; legalBasis: string | null; score: number; source: string; hypotheses: { band: Band; legalBasis: string | null; why: string }[] }

/** Combines the keyword classifier with the rates observed on the client's invoices. */
export function proposeFraming(description: string, territory: Territory, date: string, observedRates: number[]): Proposal {
  const cat = categoriseItem(description);
  const rates = ratesOn(territory, date);
  const bandOf = (rate: number): Band | null => (rate === 0 ? "isento" : rate === rates.normal ? "normal" : rate === rates.intermedia ? "intermedia" : rate === rates.reduzida ? "reduzida" : null);
  const observedBands = observedRates.map(bandOf).filter((b): b is Band => b !== null);
  const counts = new Map<Band, number>(); for (const b of observedBands) counts.set(b, (counts.get(b) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const consistency = dominant ? dominant[1] / observedBands.length : 0;
  if (cat) {
    let score = 0.75;
    if (dominant && observedBands.length >= 2) score += dominant[0] === cat.band ? (consistency >= 0.9 ? 0.2 : 0.1) : -0.25;
    const hypotheses = dominant && dominant[0] !== cat.band ? [{ band: dominant[0], legalBasis: null, why: `facturado a esta taxa em ${dominant[1]} de ${observedBands.length} ocorrência(s)` }] : [];
    return { band: cat.band, legalBasis: cat.legal_basis, score: Math.max(0.1, Math.min(0.99, Math.round(score * 100) / 100)), source: "regras" + (observedBands.length ? "+observado" : ""), hypotheses };
  }
  if (dominant && observedBands.length >= 3 && consistency >= 0.9) {
    return { band: dominant[0], legalBasis: dominant[0] === "normal" ? "Taxa normal (artigo 18.º CIVA) por omissão" : null, score: 0.6, source: "observado", hypotheses: [] };
  }
  const hypotheses = [...counts.entries()].map(([b, n]) => ({ band: b, legalBasis: null, why: `facturado a esta taxa ${n} vez(es)` }));
  return { band: dominant ? dominant[0] : null, legalBasis: null, score: dominant ? 0.4 : 0.2, source: "observado", hypotheses };
}

export function queueFor(db: Db, status: ArticleStatus, score: number, date: string): ArticleQueue {
  if (status === "validado" || status === "rejeitado") return status;
  const apply = numberAt(db, "score_artigo_aplicar", date, 0.9).value;
  const validate = numberAt(db, "score_artigo_validar", date, 0.7).value;
  return score >= apply ? "aplicar" : score >= validate ? "validar" : "hipoteses";
}

/** Registers the articles of one document and refreshes their proposals (validated/rejected records keep their framing). */
export function upsertArticlesFromDocument(db: Db, companyId: number, x: ExtractedData, territory: Territory, date: string): number {
  if (!x.items?.length) return 0;
  const company = db.prepare("SELECT cae FROM companies WHERE id = ?").get(companyId) as any;
  let n = 0;
  const tx = db.transaction(() => {
    for (const item of x.items) {
      const desc = String(item.description ?? "").trim();
      const key = articleKey(desc);
      if (key.length < 3) continue;
      const rate = item.vatRate ?? x.vatRate ?? null;
      const cur = db.prepare("SELECT * FROM article_profiles WHERE company_id = ? AND key = ?").get(companyId, key) as any;
      const observed: number[] = cur ? JSON.parse(cur.observed_rates_json || "[]") : [];
      if (rate !== null && rate !== undefined) observed.push(rate);
      const trimmed = observed.slice(-24);
      if (cur && (cur.status === "validado" || cur.status === "rejeitado")) {
        db.prepare("UPDATE article_profiles SET occurrences = occurrences + 1, last_seen = ?, observed_rates_json = ? WHERE id = ?").run(date, JSON.stringify(trimmed), cur.id);
      } else {
        const p = proposeFraming(desc, territory, date, trimmed);
        if (cur) db.prepare("UPDATE article_profiles SET description = ?, proposed_band = ?, legal_basis = ?, score = ?, source = ?, hypotheses_json = ?, occurrences = occurrences + 1, last_seen = ?, observed_rates_json = ?, updated_at = datetime('now') WHERE id = ?")
          .run(desc.slice(0, 200), p.band, p.legalBasis, p.score, p.source, JSON.stringify(p.hypotheses), date, JSON.stringify(trimmed), cur.id);
        else db.prepare("INSERT INTO article_profiles (company_id, key, description, cae, proposed_band, legal_basis, score, status, source, hypotheses_json, occurrences, last_seen, observed_rates_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposto', ?, ?, 1, ?, ?)")
          .run(companyId, key, desc.slice(0, 200), company?.cae ?? null, p.band, p.legalBasis, p.score, p.source, JSON.stringify(p.hypotheses), date, JSON.stringify(trimmed));
      }
      n++;
    }
  });
  tx();
  return n;
}

/** Rebuilds the records of a company from every stored document (idempotent). */
export function rebuildArticles(db: Db, companyId: number): { documents: number; articles: number } {
  const company = db.prepare("SELECT territory FROM companies WHERE id = ?").get(companyId) as any;
  const docs = db.prepare("SELECT extracted_json, doc_date, created_at FROM documents WHERE company_id = ? AND extracted_json IS NOT NULL AND status != 'rejeitado' ORDER BY COALESCE(doc_date, created_at)").all(companyId) as any[];
  db.prepare("UPDATE article_profiles SET occurrences = 0, observed_rates_json = '[]' WHERE company_id = ?").run(companyId);
  let n = 0;
  for (const d of docs) { try { const x = JSON.parse(d.extracted_json) as ExtractedData; n += upsertArticlesFromDocument(db, companyId, x, company?.territory ?? "continente", x.docDate ?? String(d.created_at).slice(0, 10)); } catch { /* ignore */ } }
  db.prepare("DELETE FROM article_profiles WHERE company_id = ? AND occurrences = 0 AND status = 'proposto'").run(companyId);
  return { documents: docs.length, articles: n };
}

export function listArticles(db: Db, companyId: number, queue: string | null = null): { articles: ArticleRecord[]; summary: { total: number; validado: number; aplicar: number; validar: number; hipoteses: number; rejeitado: number; coverage: number | null } } {
  const rows = db.prepare("SELECT * FROM article_profiles WHERE company_id = ? ORDER BY CASE status WHEN 'proposto' THEN 0 WHEN 'validado' THEN 1 ELSE 2 END, score DESC, occurrences DESC").all(companyId) as any[];
  const today = new Date().toISOString().slice(0, 10);
  const all: ArticleRecord[] = rows.map((r) => ({ ...r, observed_rates: JSON.parse(r.observed_rates_json || "[]"), hypotheses: JSON.parse(r.hypotheses_json || "[]"), queue: queueFor(db, r.status, r.score, today), observed_rates_json: undefined, hypotheses_json: undefined }));
  const count = (q: ArticleQueue) => all.filter((a) => a.queue === q).length;
  const active = all.filter((a) => a.status !== "rejeitado").length;
  const summary = { total: all.length, validado: count("validado"), aplicar: count("aplicar"), validar: count("validar"), hipoteses: count("hipoteses"), rejeitado: count("rejeitado"), coverage: active ? Math.round((count("validado") / active) * 1000) / 10 : null };
  return { articles: queue ? all.filter((a) => a.queue === queue) : all, summary };
}

export function decideArticle(db: Db, id: number, userId: number, input: { status: "validado" | "rejeitado" | "proposto"; band?: Band | null; legalBasis?: string | null; notes?: string | null; effectiveFrom?: string | null }): any {
  const cur = db.prepare("SELECT * FROM article_profiles WHERE id = ?").get(id) as any;
  if (!cur) throw new Error("Ficha inexistente.");
  if (input.status === "validado" && !(input.band ?? cur.proposed_band)) throw new Error("Indique o enquadramento (taxa) a validar.");
  db.prepare("UPDATE article_profiles SET status = ?, validated_band = ?, legal_basis = COALESCE(?, legal_basis), validated_by = ?, validated_at = datetime('now'), effective_from = ?, notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?")
    .run(input.status, input.status === "validado" ? (input.band ?? cur.proposed_band) : null, input.legalBasis ?? null, userId, input.effectiveFrom ?? (input.status === "validado" ? new Date().toISOString().slice(0, 10) : null), input.notes ?? null, id);
  audit(db, userId, "article_" + input.status, "article_profile", id, JSON.stringify({ band: input.band ?? cur.proposed_band, previous: cur.status }));
  return db.prepare("SELECT * FROM article_profiles WHERE id = ?").get(id);
}

/** Framings the audit should use: validated records always; proposed ones only above the apply threshold. */
export function framingsFor(db: Db, companyId: number, date: string): Map<string, { band: Band; legalBasis: string | null; validated: boolean; score: number }> {
  const apply = numberAt(db, "score_artigo_aplicar", date, 0.9).value;
  const rows = db.prepare("SELECT key, status, proposed_band, validated_band, legal_basis, score FROM article_profiles WHERE company_id = ? AND status != 'rejeitado'").all(companyId) as any[];
  const out = new Map<string, { band: Band; legalBasis: string | null; validated: boolean; score: number }>();
  for (const r of rows) {
    if (r.status === "validado" && r.validated_band) out.set(r.key, { band: r.validated_band, legalBasis: r.legal_basis, validated: true, score: 1 });
    else if (r.status === "proposto" && r.proposed_band && r.score >= apply) out.set(r.key, { band: r.proposed_band, legalBasis: r.legal_basis, validated: false, score: r.score });
  }
  return out;
}

export function rateForBand(band: Band, territory: Territory, date: string): number {
  return band === "isento" ? 0 : bandRate(band, territory, date);
}
