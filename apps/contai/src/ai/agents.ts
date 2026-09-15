/**
 * AI agents gateway (official Anthropic SDK). All model calls of the
 * "agentes" features live here: narrative polishing for client reports and
 * second-opinion review of VAT findings. The numbers and findings are
 * produced deterministically; the model only explains, never decides.
 * Without ANTHROPIC_API_KEY every method returns null and callers keep the
 * deterministic output.
 */
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CONTAI_AGENT_MODEL || "claude-opus-5";

const SYSTEM_REPORT =
  "És um contabilista certificado português a escrever para o gerente de uma PME. " +
  "Recebes uma memória descritiva gerada a partir de números já validados. Reescreve-a em português europeu (pré-Acordo Ortográfico: 'actividade', 'objectivo'), " +
  "clara e profissional, em 3 a 5 parágrafos curtos. Nunca alteres, arredondes ou inventes números, percentagens ou factos; usa exactamente os valores fornecidos. " +
  "Não uses travessões. Devolve apenas o texto.";

const SYSTEM_VAT =
  "És um revisor fiscal português especialista em IVA (CIVA, Listas I e II). Recebes um alerta gerado por regras e o extracto do documento. " +
  "Responde APENAS com JSON {\"concorda\": true|false, \"justificacao\": \"frase curta em português europeu\", \"confianca\": 0..1}. " +
  "Se a lei em vigor depender de detalhes que não constam do documento, diz que não é possível concluir (concorda=false, confianca baixa).";

const SYSTEM_SUPPLIER =
  "És um assistente de um gabinete de contabilidade português. Recebes um NIF (número de identificação fiscal / NIPC) de uma empresa portuguesa e, opcionalmente, o nome impresso num documento. " +
  "Usa a pesquisa web para identificar a denominação social e TODAS as marcas ou nomes comerciais associados a esse NIF (lojas, insígnias, sites, nomes de fantasia). " +
  "Pesquisa pelo NIF entre aspas, por 'NIF <número>', 'NIPC <número>' e pelos sites de informação empresarial (racius.com, einforma.pt, nif.pt, portugalio.com, publicacoes.mj.pt). " +
  "Responde APENAS com JSON válido, sem texto à volta, no formato " +
  "{\"candidatos\":[{\"nome\":\"string\",\"tipo\":\"denominacao|marca|nome_comercial\",\"probabilidade\":0.0,\"website\":\"string|null\",\"actividade\":\"string|null\",\"fontes\":[\"url\"]}],\"morada\":\"string|null\"}. " +
  "A probabilidade é a tua confiança de que o nome pertence a esse NIF (0 a 1). Inclui candidatos com probabilidade baixa quando a associação é incerta, em vez de os omitir. Nunca inventes nomes sem os teres visto numa página; se não encontrares nada, devolve candidatos vazios.";

export class AgentGateway {
  private client: Anthropic | null;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  private async complete(system: string, user: string, maxTokens: number): Promise<string | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as any);
      if ((res as any).stop_reason === "refusal") return null;
      const text = (res as any).content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      return text || null;
    } catch {
      // AI failure never breaks the feature: the deterministic text stands.
      return null;
    }
  }

  /** Polishes the deterministic narrative. Returns null when disabled or on failure. */
  async polishNarrative(paragraphs: string[]): Promise<string[] | null> {
    const text = await this.complete(SYSTEM_REPORT, paragraphs.join("\n\n"), 2000);
    if (!text) return null;
    return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }

  /**
   * Web search for the brands behind a NIF (server-side web_search tool). Returns candidates with
   * probabilities and the pages visited; null when disabled or on failure. Never decides anything.
   */
  async discoverSupplier(nif: string, hints: { nameOnDocument?: string | null; companyName?: string | null; officialName?: string | null }): Promise<{ candidates: { name: string; kind: "denominacao" | "marca" | "nome_comercial"; probability: number; sources: string[]; evidence: { title: string; url: string }[]; website: string | null; activity: string | null }[]; sources: string[] } | null> {
    if (!this.client) return null;
    const user = [
      `NIF: ${nif}`,
      hints.officialName ? `Denominação social segundo o VIES: ${hints.officialName}` : "Denominação social desconhecida.",
      hints.nameOnDocument ? `Nome impresso no documento: ${hints.nameOnDocument}` : null,
      hints.companyName ? `Cliente do gabinete que recebeu o documento: ${hints.companyName}` : null,
      "Identifica a denominação e as marcas/nomes comerciais associados a este NIF.",
    ].filter(Boolean).join("\n");
    try {
      const res: any = await this.client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: [{ type: "text", text: SYSTEM_SUPPLIER, cache_control: { type: "ephemeral" } }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6, user_location: { type: "approximate", country: "PT", timezone: "Europe/Lisbon" } } as any],
        messages: [{ role: "user", content: user }],
      } as any);
      if (res.stop_reason === "refusal") return null;
      const visited: { title: string; url: string }[] = [];
      for (const b of res.content ?? []) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.type === "web_search_result" && r.url) visited.push({ title: r.title || r.url, url: r.url });
      }
      const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      const start = text.indexOf("{"); const end = text.lastIndexOf("}");
      if (start < 0 || end < 0) return { candidates: [], sources: visited.map((v) => v.url) };
      const parsed = JSON.parse(text.slice(start, end + 1));
      const kinds = new Set(["denominacao", "marca", "nome_comercial"]);
      const candidates = (Array.isArray(parsed.candidatos) ? parsed.candidatos : [])
        .filter((c: any) => c && typeof c.nome === "string" && c.nome.trim().length >= 2)
        .map((c: any) => {
          const urls: string[] = Array.isArray(c.fontes) ? c.fontes.filter((u: any) => typeof u === "string" && /^https?:\/\//.test(u)) : [];
          const evidence = urls.map((u) => visited.find((v) => v.url === u) ?? { title: u.replace(/^https?:\/\//, "").split("/")[0]!, url: u });
          return {
            name: String(c.nome).trim().slice(0, 160),
            kind: (kinds.has(c.tipo) ? c.tipo : "marca") as "denominacao" | "marca" | "nome_comercial",
            probability: Math.max(0, Math.min(0.99, Number(c.probabilidade) || 0.3)),
            sources: ["ia_web"],
            evidence,
            website: typeof c.website === "string" && /^https?:\/\//.test(c.website) ? c.website : null,
            activity: typeof c.actividade === "string" && c.actividade.trim() ? c.actividade.trim().slice(0, 160) : null,
          };
        });
      return { candidates, sources: visited.map((v) => v.url) };
    } catch {
      return null;
    }
  }

  /** Second opinion on a VAT finding. */
  async reviewVatFinding(finding: { code: string; message: string }, documentExcerpt: string): Promise<{ concorda: boolean; justificacao: string; confianca: number } | null> {
    const text = await this.complete(
      SYSTEM_VAT,
      `Alerta ${finding.code}: ${finding.message}\n\nDocumento:\n${documentExcerpt.slice(0, 3000)}`,
      400
    );
    if (!text) return null;
    try {
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      if (typeof parsed.concorda === "boolean" && typeof parsed.justificacao === "string") {
        return { concorda: parsed.concorda, justificacao: parsed.justificacao, confianca: Number(parsed.confianca) || 0 };
      }
    } catch {
      /* JSON inválido: ignorar */
    }
    return null;
  }
}
