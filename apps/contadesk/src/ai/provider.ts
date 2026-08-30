/**
 * AI gateway. All classification/extraction intelligence goes through this
 * interface; no other module may call an AI API directly. The default
 * provider is the deterministic heuristic engine, which keeps the app fully
 * functional offline. When ANTHROPIC_API_KEY is set, the Anthropic provider
 * refines low-confidence classifications with claude-haiku-4-5.
 */
import { classifyDocument, Classification } from "../domain/classification.js";
import { extractFromText, ExtractedData } from "../domain/extraction.js";

export interface AnalysisResult {
  extracted: ExtractedData;
  classification: Classification;
}

export interface AiProvider {
  analyseDocument(text: string, filename: string, companyNif: string): Promise<AnalysisResult>;
}

export class HeuristicProvider implements AiProvider {
  async analyseDocument(text: string, filename: string, companyNif: string): Promise<AnalysisResult> {
    const extracted = extractFromText(text);
    const classification = classifyDocument(text, filename, companyNif, extracted);
    return { extracted, classification };
  }
}

const DOC_TYPES = [
  "factura_compra",
  "factura_venda",
  "nota_credito",
  "recibo",
  "extracto_bancario",
  "despesa",
  "guia_transporte",
  "outro",
] as const;

export class AnthropicProvider implements AiProvider {
  private heuristic = new HeuristicProvider();

  constructor(
    private apiKey: string,
    private model = "claude-haiku-4-5"
  ) {}

  async analyseDocument(text: string, filename: string, companyNif: string): Promise<AnalysisResult> {
    const base = await this.heuristic.analyseDocument(text, filename, companyNif);
    if (base.classification.confidence >= 0.8) return base;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 200,
          system:
            "Classificas documentos contabilisticos portugueses. Responde APENAS com JSON " +
            `{"tipo": um de ${JSON.stringify(DOC_TYPES)}, "confianca": 0..1}. ` +
            "Se tiveres duvidas usa 'outro' com confianca baixa. Nunca inventes dados.",
          messages: [
            {
              role: "user",
              content: `NIF da empresa: ${companyNif}\nFicheiro: ${filename}\nTexto (truncado):\n${text.slice(0, 4000)}`,
            },
          ],
        }),
      });
      if (!res.ok) return base;
      const body = (await res.json()) as any;
      const raw = body?.content?.[0]?.text ?? "";
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (DOC_TYPES.includes(parsed.tipo) && typeof parsed.confianca === "number") {
        return {
          extracted: base.extracted,
          classification: {
            docType: parsed.tipo,
            confidence: Math.max(0, Math.min(1, parsed.confianca)),
            source: "ia",
          },
        };
      }
      return base;
    } catch {
      // AI failure never breaks the pipeline; the heuristic result stands.
      return base;
    }
  }
}

export function buildProvider(): AiProvider {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return new AnthropicProvider(key);
  return new HeuristicProvider();
}
