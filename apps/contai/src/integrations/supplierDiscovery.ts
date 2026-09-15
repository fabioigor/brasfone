/**
 * Supplier discovery by NIF: when a document arrives from a counterparty the firm has not
 * registered, the accountant can ask "who is this NIF?". The answer is assembled from several
 * sources, each contributing candidates with a probability:
 *  1. NIF checksum (local, deterministic).
 *  2. VIES (European Commission VAT information exchange, public REST API): official name and
 *     address for Portuguese VAT numbers. High probability, "denominação" kind.
 *  3. AI web search (Anthropic web_search tool through the ai-gateway): brands and trade names
 *     found on the web for that NIF, each with its own probability and evidence URLs.
 *  4. The name printed on the document itself (medium probability).
 * The AI never writes anything: it only returns candidates; a human chooses one and the
 * supplier is created by deterministic code. Results are cached per NIF for 30 days.
 */
import { Db, audit } from "../db.js";
import { isValidNif } from "../domain/extraction.js";

export type CandidateKind = "denominacao" | "marca" | "nome_comercial";

export interface SupplierCandidate {
  name: string;
  kind: CandidateKind;
  probability: number;
  sources: string[];
  evidence: { title: string; url: string }[];
  website: string | null;
  activity: string | null;
  /** Other spellings merged into this candidate (e.g. the brand form of a denomination). */
  aliases?: string[];
}

export interface DiscoveryResult {
  nif: string;
  validNif: boolean;
  officialName: string | null;
  address: string | null;
  candidates: SupplierCandidate[];
  sources: string[];
  notes: string[];
  searchedAt: string;
  fromCache: boolean;
}

export interface DiscoveryHints {
  nameOnDocument?: string | null;
  companyName?: string | null;
}

/** Contract implemented by the ai-gateway (AgentGateway.discoverSupplier). */
export interface DiscoveryAgent {
  enabled: boolean;
  discoverSupplier(nif: string, hints: DiscoveryHints & { officialName?: string | null }): Promise<{ candidates: SupplierCandidate[]; sources: string[] } | null>;
}

export interface DiscoveryOptions {
  fetchImpl?: typeof fetch;
  agent?: DiscoveryAgent | null;
  cacheDays?: number;
  viesUrl?: string;
}

/** Normalised key for merging: no accents/punctuation, and the legal-form suffix (Lda, SA, Unipessoal...) removed. */
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
  .replace(/(\s+(sociedade\s+)?(unipessoal|limitada|lda|ltda|sa|s a|crl|e i r l|eireli|ag|gmbh|bv|plc|inc|ltd|sl|srl))+$/g, "").trim();

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Merges candidates from several sources: same normalised name → one candidate, boosted when sources agree. */
export function mergeCandidates(lists: SupplierCandidate[][]): SupplierCandidate[] {
  const byKey = new Map<string, SupplierCandidate>();
  for (const list of lists) {
    for (const c of list) {
      const key = norm(c.name);
      if (!key) continue;
      const cur = byKey.get(key);
      if (!cur) { byKey.set(key, { ...c, probability: Math.min(0.99, Math.max(0, c.probability)), sources: [...new Set(c.sources)], evidence: [...c.evidence], aliases: [...(c.aliases ?? [])] }); continue; }
      const spellings = new Set([cur.name, ...(cur.aliases ?? [])]);
      if (!spellings.has(c.name)) cur.aliases = [...(cur.aliases ?? []), c.name];
      for (const a of c.aliases ?? []) if (!spellings.has(a) && !(cur.aliases ?? []).includes(a)) cur.aliases!.push(a);
      const newSources = c.sources.filter((s) => !cur.sources.includes(s));
      cur.sources.push(...newSources);
      cur.evidence.push(...c.evidence.filter((e) => !cur.evidence.some((x) => x.url === e.url)));
      if (c.probability > cur.probability) { cur.aliases = (cur.aliases ?? []).filter((a) => a !== c.name).concat(cur.name === c.name ? [] : [cur.name]); cur.name = c.name; cur.kind = c.kind; }
      cur.probability = Math.min(0.99, Math.max(cur.probability, c.probability) + (newSources.length ? 0.08 : 0));
      if (cur.kind !== "denominacao" && c.kind === "denominacao") cur.kind = "denominacao";
      cur.website = cur.website || c.website; cur.activity = cur.activity || c.activity;
    }
  }
  return [...byKey.values()].map((c) => ({ ...c, probability: round2(c.probability) })).sort((a, b) => b.probability - a.probability || a.name.localeCompare(b.name)).slice(0, 12);
}

export class SupplierDiscovery {
  private fetchImpl: typeof fetch;
  private agent: DiscoveryAgent | null;
  private cacheDays: number;
  private viesUrl: string;

  constructor(private db: Db, opts: DiscoveryOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.agent = opts.agent ?? null;
    this.cacheDays = opts.cacheDays ?? 30;
    this.viesUrl = opts.viesUrl ?? "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/PT/vat/";
  }

  get sourcesAvailable(): string[] {
    return ["nif", "vies", ...(this.agent?.enabled ? ["ia_web"] : []), "documento"];
  }

  /** VIES lookup; never throws (network problems become a note). */
  async vies(nif: string): Promise<{ valid: boolean; name: string | null; address: string | null; error: string | null }> {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await this.fetchImpl(this.viesUrl + encodeURIComponent(nif), { headers: { accept: "application/json" }, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return { valid: false, name: null, address: null, error: `VIES respondeu HTTP ${r.status}` };
      const j: any = await r.json();
      const clean = (v: unknown) => { const s = String(v ?? "").trim(); return !s || s === "---" ? null : s.replace(/\s+/g, " "); };
      return { valid: j.isValid === true, name: clean(j.name), address: clean(j.address), error: j.userError && j.userError !== "VALID" ? String(j.userError) : null };
    } catch (e: any) {
      return { valid: false, name: null, address: null, error: `VIES indisponível: ${String(e?.message || e).slice(0, 80)}` };
    }
  }

  async discover(nifRaw: string, hints: DiscoveryHints = {}, opts: { refresh?: boolean; userId?: number | null } = {}): Promise<DiscoveryResult> {
    const nif = String(nifRaw).replace(/\D/g, "");
    if (!/^\d{9}$/.test(nif)) throw new Error("NIF inválido: são precisos 9 dígitos.");
    if (!opts.refresh) {
      const cached = this.db.prepare("SELECT result_json, created_at FROM supplier_discoveries WHERE nif = ? AND created_at > datetime('now', ?)").get(nif, `-${this.cacheDays} days`) as any;
      if (cached) {
        const r = JSON.parse(cached.result_json) as DiscoveryResult;
        return { ...r, candidates: mergeCandidates([r.candidates, this.documentCandidates(hints)]), fromCache: true };
      }
    }
    const notes: string[] = []; const sources: string[] = ["nif"];
    const validNif = isValidNif(nif);
    if (!validNif) notes.push("O dígito de controlo do NIF não confere: confirme o número no documento.");

    const lists: SupplierCandidate[][] = [];
    const v = await this.vies(nif);
    let officialName: string | null = null; let address: string | null = null;
    if (v.error && !v.name) notes.push(v.error);
    if (v.name) {
      officialName = v.name; address = v.address; sources.push("vies");
      lists.push([{ name: v.name, kind: "denominacao", probability: 0.95, sources: ["vies"], evidence: [{ title: "VIES (Comissão Europeia)", url: "https://ec.europa.eu/taxation_customs/vies/" }], website: null, activity: null }]);
    } else if (!v.error) {
      sources.push("vies");
      notes.push(v.valid ? "O VIES confirma o NIF mas não divulga o nome." : "O VIES não reconhece este NIF como sujeito passivo de IVA activo.");
    }

    if (this.agent?.enabled) {
      try {
        const ai = await this.agent.discoverSupplier(nif, { ...hints, officialName });
        if (ai && ai.candidates.length) { lists.push(ai.candidates.map((c) => ({ ...c, sources: c.sources.length ? c.sources : ["ia_web"] }))); sources.push("ia_web"); }
        else if (ai) notes.push("A pesquisa web não encontrou marcas associadas a este NIF.");
        else notes.push("A pesquisa web por IA não devolveu resultados utilizáveis.");
      } catch (e: any) { notes.push(`Pesquisa web por IA falhou: ${String(e?.message || e).slice(0, 100)}`); }
    } else {
      notes.push("Sem chave da API Anthropic: a pesquisa de marcas na web está desactivada (Integrações > Inteligência artificial).");
    }
    lists.push(this.documentCandidates(hints));
    if (hints.nameOnDocument) sources.push("documento");

    const result: DiscoveryResult = { nif, validNif, officialName, address, candidates: mergeCandidates(lists), sources: [...new Set(sources)], notes, searchedAt: new Date().toISOString(), fromCache: false };
    this.db.prepare("INSERT INTO supplier_discoveries (nif, result_json, sources, created_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(nif) DO UPDATE SET result_json = excluded.result_json, sources = excluded.sources, created_at = datetime('now')")
      .run(nif, JSON.stringify({ ...result, candidates: result.candidates.filter((c) => !c.sources.every((s) => s === "documento")) }), result.sources.join(","));
    audit(this.db, opts.userId ?? null, "supplier_discovery", "supplier", null, JSON.stringify({ nif, sources: result.sources, candidates: result.candidates.length }));
    return result;
  }

  private documentCandidates(hints: DiscoveryHints): SupplierCandidate[] {
    const name = (hints.nameOnDocument ?? "").trim();
    if (name.length < 3) return [];
    return [{ name, kind: "nome_comercial", probability: 0.6, sources: ["documento"], evidence: [], website: null, activity: null }];
  }
}
