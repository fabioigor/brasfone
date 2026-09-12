/**
 * AI agents gateway (official Anthropic SDK). All model calls of the
 * "agentes" features live here: narrative polishing for client reports and
 * second-opinion review of VAT findings. The numbers and findings are
 * produced deterministically; the model only explains, never decides.
 * Without ANTHROPIC_API_KEY every method returns null and callers keep the
 * deterministic output.
 */
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CONTADESK_AGENT_MODEL || "claude-opus-5";

const SYSTEM_REPORT =
  "És um contabilista certificado português a escrever para o gerente de uma PME. " +
  "Recebes uma memória descritiva gerada a partir de números já validados. Reescreve-a em português europeu (pré-Acordo Ortográfico: 'actividade', 'objectivo'), " +
  "clara e profissional, em 3 a 5 parágrafos curtos. Nunca alteres, arredondes ou inventes números, percentagens ou factos; usa exactamente os valores fornecidos. " +
  "Não uses travessões. Devolve apenas o texto.";

const SYSTEM_VAT =
  "És um revisor fiscal português especialista em IVA (CIVA, Listas I e II). Recebes um alerta gerado por regras e o extracto do documento. " +
  "Responde APENAS com JSON {\"concorda\": true|false, \"justificacao\": \"frase curta em português europeu\", \"confianca\": 0..1}. " +
  "Se a lei em vigor depender de detalhes que não constam do documento, diz que não é possível concluir (concorda=false, confianca baixa).";

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
