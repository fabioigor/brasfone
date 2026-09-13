/**
 * Banco de Portugal - BPstat public REST API (https://bpstat.bportugal.pt/data/docs).
 * Verified reachable from this environment (GET /data/v1/domains/ returns JSON).
 * Used to refresh sector benchmarks (Quadros do Setor / Central de Balancos)
 * instead of scraping the website.
 */
export interface BpstatDomain {
  id: number;
  label: string;
  short_label: string;
  num_series: number;
  obs_updated_at: string;
}

export interface BpstatSeriesPoint {
  date: string;
  value: number | null;
}

export class BpstatClient {
  constructor(private baseUrl = "https://bpstat.bportugal.pt/data/v1", private fetchImpl: typeof fetch = fetch) {}

  async listDomains(lang = "PT"): Promise<BpstatDomain[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/domains/?lang=${lang}`);
    if (!res.ok) throw new Error(`BPstat HTTP ${res.status}`);
    return (await res.json()) as BpstatDomain[];
  }

  /** Full-text search of series (e.g. "rendibilidade sector CAE 10"). */
  async searchSeries(query: string, lang = "PT", limit = 20): Promise<any[]> {
    const url = `${this.baseUrl}/series/?lang=${lang}&search=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`BPstat HTTP ${res.status}`);
    const body = (await res.json()) as any;
    return Array.isArray(body) ? body : body?.results ?? [];
  }

  /** Observations of one series by id. */
  async seriesObservations(seriesId: number | string, lang = "PT"): Promise<BpstatSeriesPoint[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/series/${seriesId}/observations/?lang=${lang}`);
    if (!res.ok) throw new Error(`BPstat HTTP ${res.status}`);
    const body = (await res.json()) as any;
    const obs = Array.isArray(body) ? body : body?.observations ?? [];
    return obs.map((o: any) => ({ date: String(o.date ?? o.period ?? ""), value: o.value === null || o.value === undefined ? null : Number(o.value) }));
  }
}
