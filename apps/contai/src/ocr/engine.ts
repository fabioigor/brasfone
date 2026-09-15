/**
 * Text extraction from binary documents (PDF, images).
 *
 * Strategy, in order:
 *   1. PDF with a text layer  -> pdfjs text extraction (fast, exact).
 *   2. Scanned PDF / image    -> Claude vision (when ANTHROPIC_API_KEY is set)
 *                                otherwise local Tesseract (WASM, Portuguese).
 * The result is plain text laid out line by line so that the existing
 * extraction/classification/audit pipeline works unchanged on top of it.
 * Low OCR confidence is surfaced to the reviewer as a finding.
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { prepareForOcr } from "../extraction/preprocess.js";

export type OcrMethod = "texto" | "pdf_texto" | "claude_visao" | "tesseract" | "indisponivel";

export interface OcrResult {
  text: string;
  method: OcrMethod;
  /** 0..1; 1 for native text, OCR engines report their own confidence. */
  confidence: number;
  pages: number;
  warnings: string[];
}

export interface OcrEngine {
  extract(buffer: Buffer, mimeType: string, filename: string): Promise<OcrResult>;
}

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|csv))/;

export function isPdf(mimeType: string, filename: string, buffer?: Buffer): boolean {
  if (/pdf/i.test(mimeType) || /\.pdf$/i.test(filename)) return true;
  return !!buffer && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

export function isImage(mimeType: string, filename: string): boolean {
  return IMAGE_MIME.test(mimeType) || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(filename);
}

export function isText(mimeType: string, filename: string): boolean {
  return TEXT_MIME.test(mimeType) || /\.(txt|csv|xml|json)$/i.test(filename);
}

/** Native text layer of a PDF via pdfjs. Empty string when the PDF is a scan. */
export async function pdfTextLayer(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const doc = await task.promise;
  const numPages = doc.numPages;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group items into lines by their vertical position so the layout
    // (label   value) survives, which the regex extractors rely on.
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items as any[]) {
      if (typeof item.str !== "string") continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key)!.push({ x, s: item.str });
    }
    const ordered = [...rows.entries()].sort((a, b) => b[0] - a[0]);
    for (const [, items] of ordered) {
      items.sort((a, b) => a.x - b.x);
      let line = "";
      let lastX = -Infinity;
      for (const it of items) {
        if (line && it.x - lastX > 12) line += "   ";
        line += it.s;
        lastX = it.x + it.s.length * 5;
      }
      if (line.trim()) lines.push(line.trimEnd());
    }
    if (p < numPages) lines.push("");
  }
  await task.destroy();
  return { text: lines.join("\n"), pages: numPages };
}

/** Renders PDF pages to PNG buffers (for local OCR of scanned PDFs). */
export async function rasterizePdf(buffer: Buffer, maxPages = 5, scale = 2): Promise<Buffer[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const doc = await task.promise;
  const out: Buffer[] = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport, canvas: canvas as any } as any).promise;
    out.push(canvas.toBuffer("image/png"));
  }
  await task.destroy();
  return out;
}

const MIN_TEXT_CHARS = 40;
const hasUsefulText = (t: string) => t.replace(/\s+/g, "").length >= MIN_TEXT_CHARS && /[a-zA-Z]{3,}/.test(t);

/** Local OCR with tesseract.js (Portuguese + English). */
export class TesseractEngine {
  private worker: any = null;

  constructor(private langPath?: string) {}

  private async getWorker() {
    if (this.worker) return this.worker;
    const { createWorker } = await import("tesseract.js");
    const opts: any = { logger: () => {} };
    if (this.langPath) opts.langPath = this.langPath;
    // Language data is cached outside the source tree (gitignored).
    const cachePath = process.env.TESSERACT_CACHE_PATH || path.join("data", "tesseract");
    fs.mkdirSync(cachePath, { recursive: true });
    opts.cachePath = cachePath;
    this.worker = await createWorker(["por", "eng"], 1, opts);
    return this.worker;
  }

  async recognise(images: Buffer[]): Promise<{ text: string; confidence: number }> {
    const worker = await this.getWorker();
    const texts: string[] = [];
    let conf = 0;
    for (const raw of images) {
      // Grayscale + Otsu binarisation + upscale: cheap and it lifts confidence on phone photos.
      let img = raw;
      try {
        img = await prepareForOcr(raw);
      } catch {
        /* keep the original image */
      }
      const { data } = await worker.recognize(img);
      texts.push(data.text);
      conf += data.confidence;
    }
    return { text: texts.join("\n\n"), confidence: images.length ? conf / images.length / 100 : 0 };
  }

  async terminate(): Promise<void> {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}

/** Claude vision OCR through the official SDK (PDF documents and images natively). */
export class ClaudeVisionEngine {
  private client: Anthropic;
  constructor(apiKey: string, private model = process.env.CONTAI_OCR_MODEL || "claude-opus-5") {
    this.client = new Anthropic({ apiKey });
  }

  async transcribe(buffer: Buffer, mimeType: string, pdf: boolean): Promise<{ text: string; confidence: number }> {
    const source = { type: "base64" as const, media_type: (pdf ? "application/pdf" : mimeType) as any, data: buffer.toString("base64") };
    const block: any = pdf ? { type: "document", source } : { type: "image", source };
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system:
        "Transcreves documentos contabilísticos portugueses (facturas, recibos, extractos). Devolve APENAS o texto do documento, linha a linha, " +
        "preservando rótulos e valores na mesma linha (ex.: 'IVA (23%): 123,05'), sem comentários, sem traduzir, sem corrigir valores. " +
        "Se uma parte for ilegível escreve [ilegível]. No fim escreve uma linha 'CONFIANCA: 0.xx' com a tua confiança na transcrição.",
      messages: [{ role: "user", content: [block, { type: "text", text: "Transcreve este documento." }] }],
    });
    if ((res as any).stop_reason === "refusal") return { text: "", confidence: 0 };
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("\n");
    const m = text.match(/CONFIANCA:\s*([01](?:[.,]\d+)?)/i);
    const confidence = m ? Math.max(0, Math.min(1, Number(m[1]!.replace(",", ".")))) : 0.8;
    return { text: text.replace(/CONFIANCA:.*$/im, "").trim(), confidence };
  }
}

export interface DocumentOcrOptions {
  anthropicApiKey?: string;
  tesseractLangPath?: string;
  /** Disable local OCR entirely (e.g. constrained servers). */
  disableTesseract?: boolean;
}

export class DocumentOcr implements OcrEngine {
  private tesseract: TesseractEngine | null;
  private claude: ClaudeVisionEngine | null;

  constructor(opts: DocumentOcrOptions = {}) {
    this.claude = opts.anthropicApiKey ? new ClaudeVisionEngine(opts.anthropicApiKey) : null;
    this.tesseract = opts.disableTesseract ? null : new TesseractEngine(opts.tesseractLangPath);
  }

  static fromEnv(): DocumentOcr {
    return new DocumentOcr({
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      tesseractLangPath: process.env.TESSERACT_LANG_PATH,
      disableTesseract: process.env.CONTAI_DISABLE_TESSERACT === "1",
    });
  }

  get engines(): string[] {
    const e = ["pdf_texto"];
    if (this.claude) e.push("claude_visao");
    if (this.tesseract) e.push("tesseract");
    return e;
  }

  async extract(buffer: Buffer, mimeType: string, filename: string): Promise<OcrResult> {
    const warnings: string[] = [];
    if (isText(mimeType, filename)) {
      return { text: buffer.toString("utf8"), method: "texto", confidence: 1, pages: 1, warnings };
    }
    const pdf = isPdf(mimeType, filename, buffer);
    const image = isImage(mimeType, filename);
    if (!pdf && !image) {
      return { text: "", method: "indisponivel", confidence: 0, pages: 0, warnings: ["Formato não suportado para extracção de texto."] };
    }

    let pages = 1;
    if (pdf) {
      try {
        const layer = await pdfTextLayer(buffer);
        pages = layer.pages;
        if (hasUsefulText(layer.text)) {
          return { text: layer.text, method: "pdf_texto", confidence: 1, pages, warnings };
        }
      } catch (e: any) {
        warnings.push(`Falha a ler o PDF: ${e.message}`);
      }
    }

    // Scanned PDF or image: OCR.
    if (this.claude) {
      try {
        const r = await this.claude.transcribe(buffer, mimeType || "image/png", pdf);
        if (hasUsefulText(r.text)) return { text: r.text, method: "claude_visao", confidence: r.confidence, pages, warnings };
        warnings.push("Claude não devolveu texto útil; a tentar OCR local.");
      } catch (e: any) {
        warnings.push(`Claude visão indisponível: ${e.message}`);
      }
    }
    if (this.tesseract) {
      try {
        const images = pdf ? await rasterizePdf(buffer) : [buffer];
        const r = await this.tesseract.recognise(images);
        if (hasUsefulText(r.text)) return { text: r.text, method: "tesseract", confidence: r.confidence, pages, warnings };
        warnings.push("OCR local não reconheceu texto suficiente.");
      } catch (e: any) {
        warnings.push(`OCR local falhou: ${e.message}`);
      }
    }
    return { text: "", method: "indisponivel", confidence: 0, pages, warnings };
  }
}
