/**
 * INE - Instituto Nacional de Estatistica JSON indicator API
 * (https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=<codigo>&lang=PT).
 * Public and documented by INE; from this sandbox the host timed out, so the
 * client is exercised only with an injected fetch in tests until it can be
 * verified against the live service.
 */
export interface IneIndicatorValue {
  dimension: Record<string, string>;
  period: string;
  value: number | null;
}

export class IneClient {
  constructor(private baseUrl = "https://www.ine.pt/ine/json_indicador/pindica.jsp", private fetchImpl: typeof fetch = fetch) {}

  /** Fetches an indicator (varcd) and flattens its values. */
  async indicator(varcd: string, lang = "PT"): Promise<{ title: string; values: IneIndicatorValue[] }> {
    const res = await this.fetchImpl(`${this.baseUrl}?op=2&varcd=${encodeURIComponent(varcd)}&lang=${lang}`);
    if (!res.ok) throw new Error(`INE HTTP ${res.status}`);
    const body = (await res.json()) as any;
    const root = Array.isArray(body) ? body[0] : body;
    const title = root?.IndicadorDsg ?? root?.IndicadorNome ?? varcd;
    const values: IneIndicatorValue[] = [];
    const dados = root?.Dados ?? {};
    for (const [period, rows] of Object.entries(dados)) {
      for (const r of rows as any[]) {
        const dimension: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) if (/^dim_\d+_t$/.test(k)) dimension[k] = String(v);
        const raw = r.valor ?? r.value;
        values.push({ dimension, period, value: raw === undefined || raw === null || raw === "" ? null : Number(String(raw).replace(",", ".")) });
      }
    }
    return { title, values };
  }
}
