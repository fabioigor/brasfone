/**
 * Knowledge base loader. Rules live in versioned JSON files so that legal
 * updates (VAT rates, lists, sector benchmarks) are data changes reviewed in
 * git, not code changes. Each file carries `last_verified`; when it grows
 * older than `review_after_days` the engines emit a staleness alert so the
 * agent's knowledge is never silently outdated.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export type VatBand = "normal" | "intermedia" | "reduzida";
export type Territory = "continente" | "acores" | "madeira";

export interface VatCategory {
  key: string;
  label: string;
  band: VatBand;
  legal_basis: string;
  keywords: string[];
}

export interface VatRules {
  version: string;
  last_verified: string;
  review_after_days: number;
  sources: string[];
  territories: Record<Territory, { label: string; normal: number; intermedia: number; reduzida: number }>;
  history: { territory: Territory; effective_from: string; normal: number; intermedia: number; reduzida: number }[];
  categories: VatCategory[];
  anomaly: { effective_rate_jump_points: number; min_history_documents: number };
}

export interface SectorBenchmark {
  key: string;
  label: string;
  cae_prefixes: string[];
  ratios: Record<string, number>;
  narrative: string;
}

export interface SectorBenchmarks {
  version: string;
  last_verified: string;
  disclaimer: string;
  source: string;
  sectors: SectorBenchmark[];
}

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(here, name), "utf8")) as T;
}

let vatCache: VatRules | null = null;
let sectorCache: SectorBenchmarks | null = null;

export function loadVatRules(force = false): VatRules {
  if (!vatCache || force) vatCache = readJson<VatRules>("vat-rules.json");
  return vatCache;
}

export function loadSectorBenchmarks(force = false): SectorBenchmarks {
  if (!sectorCache || force) sectorCache = readJson<SectorBenchmarks>("sector-benchmarks.json");
  return sectorCache;
}

export interface KnowledgeStatus {
  name: string;
  version: string;
  lastVerified: string;
  ageDays: number;
  stale: boolean;
  reviewAfterDays: number;
}

export function knowledgeStatus(today = new Date()): KnowledgeStatus[] {
  const vat = loadVatRules();
  const sectors = loadSectorBenchmarks();
  const age = (d: string) => Math.floor((today.getTime() - new Date(d + "T00:00:00Z").getTime()) / 86400_000);
  return [
    {
      name: "regras_iva",
      version: vat.version,
      lastVerified: vat.last_verified,
      ageDays: age(vat.last_verified),
      stale: age(vat.last_verified) > vat.review_after_days,
      reviewAfterDays: vat.review_after_days,
    },
    {
      name: "benchmarks_sector",
      version: sectors.version,
      lastVerified: sectors.last_verified,
      ageDays: age(sectors.last_verified),
      stale: age(sectors.last_verified) > 180,
      reviewAfterDays: 180,
    },
  ];
}

/** Rates in force for a territory on a date (history-aware). */
export function ratesOn(territory: Territory, date: string): { normal: number; intermedia: number; reduzida: number } {
  const rules = loadVatRules();
  const hist = rules.history
    .filter((h) => h.territory === territory && h.effective_from <= date)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  const h = hist[0];
  if (h) return { normal: h.normal, intermedia: h.intermedia, reduzida: h.reduzida };
  const t = rules.territories[territory];
  return { normal: t.normal, intermedia: t.intermedia, reduzida: t.reduzida };
}

export function sectorForCae(cae: string | null | undefined): SectorBenchmark | null {
  if (!cae) return null;
  const digits = cae.replace(/\D/g, "");
  const sectors = loadSectorBenchmarks().sectors;
  let best: SectorBenchmark | null = null;
  let bestLen = 0;
  for (const s of sectors) {
    for (const p of s.cae_prefixes) {
      if (digits.startsWith(p) && p.length > bestLen) {
        best = s;
        bestLen = p.length;
      }
    }
  }
  return best;
}
