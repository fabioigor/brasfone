/**
 * Structured invoice extraction with Claude (official SDK) and the
 * reconciliation of the three sources available for a document:
 *   1. AT QR code (machine-issued, exact)        -> authoritative
 *   2. Claude structured extraction (vision/text) -> strong, validated by zod
 *   3. Heuristic regex extraction over OCR text  -> always available
 * The merge keeps a per-field provenance so the reviewer sees where each
 * value came from, and disagreements become findings instead of silent picks.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ExtractedData, isValidNif, VatLine, LineItem } from "../domain/extraction.js";
import { AtQrData } from "./atQr.js";

export const StructuredInvoiceSchema = z.object({
  tipo_documento: z.enum(["factura", "factura_recibo", "factura_simplificada", "nota_credito", "nota_debito", "recibo", "extracto_bancario", "guia_transporte", "despesa", "outro"]),
  emitente: z.object({ nome: z.string().nullable(), nif: z.string().nullable() }),
  adquirente: z.object({ nome: z.string().nullable(), nif: z.string().nullable() }),
  numero: z.string().nullable(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  atcud: z.string().nullable(),
  moeda: z.string().default("EUR"),
  linhas: z.array(z.object({
    descricao: z.string(),
    quantidade: z.number().nullable(),
    preco_unitario: z.number().nullable(),
    total_linha: z.number().nullable(),
    taxa_iva: z.number().nullable(),
  })).default([]),
  iva: z.array(z.object({ taxa: z.number(), base: z.number(), valor: z.number() })).default([]),
  base_total: z.number().nullable(),
  iva_total: z.number().nullable(),
  total: z.number().nullable(),
  meio_pagamento: z.string().nullable(),
  confianca: z.number().min(0).max(1),
});
export type StructuredInvoice = z.infer<typeof StructuredInvoiceSchema>;

const SYSTEM =
  "Extrais dados de documentos contabilísticos portugueses (facturas, facturas-recibo, notas de crédito, recibos, talões). " +
  "Responde APENAS com JSON válido com este formato exacto: " +
  JSON.stringify({
    tipo_documento: "factura|factura_recibo|factura_simplificada|nota_credito|nota_debito|recibo|extracto_bancario|guia_transporte|despesa|outro",
    emitente: { nome: "string|null", nif: "9 dígitos|null" },
    adquirente: { nome: "string|null", nif: "9 dígitos|null" },
    numero: "string|null", data: "YYYY-MM-DD|null", atcud: "string|null", moeda: "EUR",
    linhas: [{ descricao: "string", quantidade: 0, preco_unitario: 0, total_linha: 0, taxa_iva: 23 }],
    iva: [{ taxa: 23, base: 0, valor: 0 }], base_total: 0, iva_total: 0, total: 0, meio_pagamento: "string|null", confianca: 0.9,
  }) +
  ". Regras: valores em número com ponto decimal; nunca inventes valores que não estejam no documento (usa null); " +
  "o emitente é quem emite a factura, o adquirente é o cliente; 'iva' tem uma entrada por taxa presente; " +
  "'confianca' é a tua confiança global de 0 a 1 (baixa se o documento estiver ilegível ou cortado).";

export class ClaudeStructuredExtractor {
  private client: Anthropic;
  constructor(apiKey: string, private model = process.env.CONTAI_OCR_MODEL || "claude-opus-5") {
    this.client = new Anthropic({ apiKey });
  }

  /** Accepts the document bytes (image/PDF) and/or its text. Returns null on failure. */
  async extract(input: { buffer?: Buffer; mimeType?: string; isPdf?: boolean; text?: string }): Promise<StructuredInvoice | null> {
    const content: any[] = [];
    if (input.buffer && input.mimeType) {
      const source = { type: "base64", media_type: input.isPdf ? "application/pdf" : input.mimeType, data: input.buffer.toString("base64") };
      content.push(input.isPdf ? { type: "document", source } : { type: "image", source });
    }
    if (input.text) content.push({ type: "text", text: `Texto já extraído (pode conter erros de OCR):\n${input.text.slice(0, 6000)}` });
    content.push({ type: "text", text: "Extrai os dados deste documento." });
    const ask = async (previous?: string, correction?: string) => {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 3000,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages:
          previous && correction
            ? [{ role: "user", content }, { role: "assistant", content: previous }, { role: "user", content: correction }]
            : [{ role: "user", content }],
      } as any);
      if ((res as any).stop_reason === "refusal") return null;
      const text = (res as any).content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end < 0) return null;
      return text.slice(start, end + 1);
    };
    try {
      let raw = await ask();
      if (!raw) return null;
      let parsed = StructuredInvoiceSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        // One correction round with the validation errors, then give up.
        raw = await ask(raw, `O JSON anterior falhou a validação: ${JSON.stringify(parsed.error.issues.slice(0, 5))}. Devolve o JSON corrigido completo.`);
        if (!raw) return null;
        parsed = StructuredInvoiceSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface MergeInput {
  heuristic: ExtractedData;
  qr?: AtQrData | null;
  structured?: StructuredInvoice | null;
  territoryRates: { normal: number; intermedia: number; reduzida: number };
}

/**
 * Reconciles the sources into one ExtractedData with provenance and a list
 * of divergences (each becomes a finding downstream).
 */
export function mergeSources(input: MergeInput): { data: ExtractedData; divergences: string[] } {
  const { heuristic: h, qr, structured: s, territoryRates: r } = input;
  const out: ExtractedData = { ...h, sources: [...(h.sources ?? ["heuristica"])], fieldSources: { ...(h.fieldSources ?? {}) } };
  const divergences: string[] = [];
  const set = <K extends keyof ExtractedData>(key: K, value: ExtractedData[K], source: string) => {
    (out as any)[key] = value;
    out.fieldSources![key as string] = source;
  };

  if (s) {
    out.sources.push("ia");
    const nifOk = (n: string | null) => (n && isValidNif(n) ? n : null);
    const issuer = nifOk(s.emitente.nif);
    const acquirer = nifOk(s.adquirente.nif);
    if (issuer) set("issuerNif", issuer, "ia");
    const nifs = [issuer, acquirer].filter((x): x is string => !!x);
    if (nifs.length) set("nifs", Array.from(new Set([...nifs, ...h.nifs])), "ia");
    if (s.numero) set("docNumber", s.numero, "ia");
    if (s.data) set("docDate", s.data, "ia");
    if (s.total !== null) set("totalAmount", round2(s.total), "ia");
    if (s.iva_total !== null) set("vatAmount", round2(s.iva_total), "ia");
    if (s.base_total !== null) set("netAmount", round2(s.base_total), "ia");
    if (s.iva.length) {
      set("vatBreakdown", s.iva.map((v) => ({ rate: v.taxa, base: round2(v.base), vat: round2(v.valor) })), "ia");
      if (s.iva.length === 1) set("vatRate", s.iva[0]!.taxa, "ia");
    }
    if (s.linhas.length) {
      const items: LineItem[] = s.linhas.map((l) => ({ description: l.descricao, quantity: l.quantidade, unitPrice: l.preco_unitario, lineTotal: l.total_linha, vatRate: l.taxa_iva }));
      set("items", items, "ia");
    }
    if (s.atcud) set("atcud", s.atcud, "ia");
    if (s.emitente.nome) set("issuerName", s.emitente.nome, "ia");
    out.aiConfidence = s.confianca;
    if (h.totalAmount !== null && s.total !== null && Math.abs(h.totalAmount - s.total) > 0.02) {
      divergences.push(`Total: OCR ${h.totalAmount.toFixed(2)} vs IA ${s.total.toFixed(2)}`);
    }
  }

  if (qr) {
    out.sources.push("qr");
    set("issuerNif", qr.issuerNif, "qr");
    const nifs = [qr.issuerNif, qr.acquirerNif].filter((x): x is string => !!x);
    set("nifs", Array.from(new Set([...nifs, ...out.nifs])), "qr");
    set("docNumber", qr.docNumber, "qr");
    set("docDate", qr.date, "qr");
    set("atcud", qr.atcud || null, "qr");
    set("atDocType", qr.docType, "qr");
    set("docStatus", qr.status, "qr");
    const breakdown: VatLine[] = [];
    if (qr.reducedBase || qr.reducedVat) breakdown.push({ rate: r.reduzida, base: qr.reducedBase, vat: qr.reducedVat });
    if (qr.intermediateBase || qr.intermediateVat) breakdown.push({ rate: r.intermedia, base: qr.intermediateBase, vat: qr.intermediateVat });
    if (qr.normalBase || qr.normalVat) breakdown.push({ rate: r.normal, base: qr.normalBase, vat: qr.normalVat });
    if (qr.exemptBase) breakdown.push({ rate: 0, base: qr.exemptBase, vat: 0 });
    const prevTotal = out.totalAmount;
    const prevVat = out.vatAmount;
    set("vatBreakdown", breakdown, "qr");
    set("netAmount", round2(breakdown.reduce((a, b) => a + b.base, 0)), "qr");
    set("vatAmount", round2(qr.reducedVat + qr.intermediateVat + qr.normalVat), "qr");
    set("totalAmount", qr.total, "qr");
    const rated = breakdown.filter((b) => b.rate > 0);
    set("vatRate", rated.length === 1 ? rated[0]!.rate : null, "qr");
    if (prevTotal !== null && Math.abs(prevTotal - qr.total) > 0.02) {
      divergences.push(`Total: ${out.fieldSources!["totalAmount"] === "qr" && s ? "IA" : "OCR"} ${prevTotal.toFixed(2)} vs QR ${qr.total.toFixed(2)}`);
    }
    if (prevVat !== null && Math.abs(prevVat - out.vatAmount!) > 0.02) {
      divergences.push(`IVA: texto ${prevVat.toFixed(2)} vs QR ${out.vatAmount!.toFixed(2)}`);
    }
  }
  return { data: out, divergences };
}
