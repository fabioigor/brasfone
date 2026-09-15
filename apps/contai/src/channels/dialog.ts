/**
 * Reception dialog: after a client sends documents by WhatsApp, the app asks the right questions
 * to register them well (document type, then cost centre) and applies the answers to the
 * documents just received. Plain numbered questions, so no Meta message templates are needed;
 * answers can be the number, "ok" (keep what was detected) or a keyword.
 * One dialog per sender; a new document replaces it; it expires after 24 hours.
 * The client's answers never bypass the accountant: they only improve the proposal that the
 * firm still validates.
 */
import { Db, audit } from "../db.js";
import { DocType } from "../domain/classification.js";
import { applyIntakeAnswers } from "../pipeline.js";
import { counterpartyNif } from "../domain/supplierMemory.js";

export const DOC_TYPE_OPTIONS: { key: DocType; label: string; keywords: RegExp }[] = [
  { key: "factura_compra", label: "Factura de compra (de um fornecedor)", keywords: /compra|fornecedor|fatura|factura/ },
  { key: "despesa", label: "Despesa ou talão (sem factura completa)", keywords: /despesa|tal[aã]o|ticket|recibo verde|combust/ },
  { key: "factura_venda", label: "Factura de venda (emitida pela sua empresa)", keywords: /venda|cliente/ },
  { key: "nota_credito", label: "Nota de crédito", keywords: /cr[eé]dito|nc\b/ },
  { key: "recibo", label: "Recibo", keywords: /recibo|pagamento/ },
  { key: "extracto_bancario", label: "Extracto bancário", keywords: /extra[ct]o|banc/ },
  { key: "outro", label: "Outro documento", keywords: /outro/ },
];

export const DOC_TYPE_SHORT: Record<string, string> = {
  factura_compra: "Factura de compra", despesa: "Despesa", factura_venda: "Factura de venda", nota_credito: "Nota de crédito",
  recibo: "Recibo", extracto_bancario: "Extracto bancário", guia_transporte: "Guia de transporte", outro: "Outro", por_classificar: "Por classificar",
};

export interface DialogStart {
  channel: string;
  sender: string;
  companyId: number;
  documentIds: number[];
  detectedType: DocType | string | null;
}

export interface DialogAnswer { handled: boolean; reply: string | null; finished: boolean }

interface DialogRow { id: number; channel: string; sender: string; company_id: number; document_ids: string; step: string; detected_type: string | null; answers_json: string; attempts: number; expires_at: string }

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const KEEP = /^(ok|sim|s|certo|correcto|correto|confirmo|mant[eé]m|manter|isso|exacto|exato|yes|👍)$/;

export class IntakeDialog {
  constructor(private db: Db, private opts: { ttlHours?: number; maxAttempts?: number } = {}) {}

  costCenters(companyId: number): { id: number; code: string; name: string }[] {
    return this.db.prepare("SELECT id, code, name FROM cost_centers WHERE company_id = ? AND active = 1 ORDER BY code").all(companyId) as any[];
  }

  active(channel: string, sender: string): DialogRow | null {
    const row = this.db.prepare("SELECT * FROM channel_dialogs WHERE channel = ? AND sender = ? AND step != 'concluido' AND expires_at > datetime('now')").get(channel, sender) as DialogRow | undefined;
    return row ?? null;
  }

  /** Opens (or replaces) the dialog and returns the first question, or null when there is nothing to ask. */
  start(input: DialogStart): string | null {
    if (!input.documentIds.length) return null;
    const ccs = this.costCenters(input.companyId);
    const ttl = this.opts.ttlHours ?? 24;
    this.db.prepare(
      `INSERT INTO channel_dialogs (channel, sender, company_id, document_ids, step, detected_type, answers_json, attempts, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, 'tipo', ?, '{}', 0, datetime('now'), datetime('now'), datetime('now', ?))
       ON CONFLICT(channel, sender) DO UPDATE SET company_id = excluded.company_id, document_ids = excluded.document_ids, step = 'tipo', detected_type = excluded.detected_type,
         answers_json = '{}', attempts = 0, created_at = datetime('now'), updated_at = datetime('now'), expires_at = excluded.expires_at`
    ).run(input.channel, input.sender, input.companyId, JSON.stringify(input.documentIds), input.detectedType ?? null, `+${ttl} hours`);
    audit(this.db, null, "dialog_start", "channel_dialog", null, JSON.stringify({ channel: input.channel, documents: input.documentIds.length, costCenters: ccs.length }));
    return this.typeQuestion(input.documentIds.length, input.detectedType ?? null);
  }

  private typeQuestion(count: number, detected: string | null, prefix = ""): string {
    const head = count === 1 ? "Recebemos o seu documento." : `Recebemos ${count} documentos (as respostas aplicam-se a todos; se forem de tipos diferentes, envie-os em mensagens separadas).`;
    const lines = DOC_TYPE_OPTIONS.map((o, i) => `${i + 1}. ${o.label}${detected === o.key ? " (detectado)" : ""}`);
    return `${prefix}${head} Que tipo de documento é?\n${lines.join("\n")}\nResponda com o número${detected ? ", ou \"ok\" para manter o detectado" : ""}.`;
  }

  private costCenterQuestion(ccs: { id: number; code: string; name: string }[], suggestedId: number | null, prefix = ""): string {
    const lines = ccs.map((c, i) => `${i + 1}. ${c.name}${c.id === suggestedId ? " (habitual deste fornecedor)" : ""}`);
    return `${prefix}A que centro de custo pertence?\n${lines.join("\n")}\n0. Sem centro de custo\nResponda com o número${suggestedId ? ", ou \"ok\" para o habitual" : ""}.`;
  }

  /** Handles a text message from a sender with an open dialog. Returns handled=false when there is no dialog. */
  answer(channel: string, sender: string, textRaw: string): DialogAnswer {
    const row = this.active(channel, sender);
    if (!row) return { handled: false, reply: null, finished: false };
    const text = norm(textRaw || "");
    const docIds: number[] = JSON.parse(row.document_ids);
    const answers = JSON.parse(row.answers_json || "{}");
    const ccs = this.costCenters(row.company_id);
    const maxAttempts = this.opts.maxAttempts ?? 2;

    if (row.step === "tipo") {
      const choice = this.parseType(text, row.detected_type);
      if (choice === undefined) return this.retry(row, docIds.length, ccs, maxAttempts);
      if (choice && choice !== row.detected_type) { for (const id of docIds) this.safeApply(id, { docType: choice }); answers.docType = choice; }
      else answers.docType = row.detected_type;
      const suggested = this.suggestedCostCenter(row.company_id, docIds);
      if (!ccs.length) return this.finish(row, answers, null);
      this.db.prepare("UPDATE channel_dialogs SET step = 'centro', answers_json = ?, attempts = 0, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify({ ...answers, suggestedCostCenterId: suggested }), row.id);
      return { handled: true, reply: this.costCenterQuestion(ccs, suggested, `Registado como ${DOC_TYPE_SHORT[answers.docType] || answers.docType}. `), finished: false };
    }

    if (row.step === "centro") {
      const suggested = answers.suggestedCostCenterId ?? null;
      const choice = this.parseCostCenter(text, ccs, suggested);
      if (choice === undefined) return this.retry(row, docIds.length, ccs, maxAttempts);
      for (const id of docIds) this.safeApply(id, { costCenterId: choice });
      const cc = choice ? ccs.find((c) => c.id === choice) ?? null : null;
      return this.finish(row, { ...answers, costCenterId: choice }, cc);
    }
    return { handled: false, reply: null, finished: false };
  }

  private retry(row: DialogRow, count: number, ccs: { id: number; code: string; name: string }[], maxAttempts: number): DialogAnswer {
    const answers = JSON.parse(row.answers_json || "{}");
    if (row.attempts + 1 > maxAttempts) {
      this.db.prepare("UPDATE channel_dialogs SET step = 'concluido', updated_at = datetime('now') WHERE id = ?").run(row.id);
      const kept = DOC_TYPE_SHORT[answers.docType || row.detected_type || ""] || "classificação automática";
      return { handled: true, reply: `Não conseguimos interpretar a resposta. Mantemos ${kept} e o gabinete ajusta o que for preciso na validação. Obrigado.`, finished: true };
    }
    this.db.prepare("UPDATE channel_dialogs SET attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").run(row.id);
    const q = row.step === "tipo" ? this.typeQuestion(count, row.detected_type, "Não percebi. ") : this.costCenterQuestion(ccs, answers.suggestedCostCenterId ?? null, "Não percebi. ");
    return { handled: true, reply: q, finished: false };
  }

  private finish(row: DialogRow, answers: any, cc: { name: string } | null): DialogAnswer {
    this.db.prepare("UPDATE channel_dialogs SET step = 'concluido', answers_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(answers), row.id);
    audit(this.db, null, "dialog_finish", "channel_dialog", row.id, JSON.stringify(answers));
    const tipo = DOC_TYPE_SHORT[answers.docType || ""] || "documento";
    return { handled: true, reply: `Obrigado. Registado como ${tipo}${cc ? `, centro de custo ${cc.name}` : ""}. O gabinete valida o lançamento e avisa se faltar algo.`, finished: true };
  }

  private safeApply(documentId: number, a: { docType?: DocType; costCenterId?: number | null }): void {
    try { applyIntakeAnswers(this.db, documentId, a); } catch (e: any) { audit(this.db, null, "dialog_apply_error", "document", documentId, String(e?.message || e).slice(0, 200)); }
  }

  /** undefined = not understood; null = keep detected (only when there is one); DocType = chosen. */
  parseType(text: string, detected: string | null): DocType | null | undefined {
    if (!text) return undefined;
    if (KEEP.test(text)) return detected ? (detected as DocType) : undefined;
    const n = Number(text.replace(/[^\d]/g, ""));
    if (/^\d+$/.test(text.replace(/[.)\s]/g, "")) && n >= 1 && n <= DOC_TYPE_OPTIONS.length) return DOC_TYPE_OPTIONS[n - 1]!.key;
    // Specific keywords first (venda, crédito, extracto...), the generic "factura/compra" last.
    const order: DocType[] = ["factura_venda", "nota_credito", "extracto_bancario", "despesa", "recibo", "outro", "factura_compra"];
    for (const key of order) { const o = DOC_TYPE_OPTIONS.find((x) => x.key === key)!; if (o.keywords.test(text)) return o.key; }
    return undefined;
  }

  /** undefined = not understood; null = no cost centre; number = cost centre id. */
  parseCostCenter(text: string, ccs: { id: number; code: string; name: string }[], suggested: number | null): number | null | undefined {
    if (!text) return undefined;
    if (KEEP.test(text)) return suggested ?? undefined;
    const digits = text.replace(/[.)\s]/g, "");
    if (/^\d+$/.test(digits)) { const n = Number(digits); if (n === 0) return null; if (n >= 1 && n <= ccs.length) return ccs[n - 1]!.id; return undefined; }
    if (/^(nenhum|sem|nao|não|n)\b/.test(text)) return null;
    for (const c of ccs) if (text.includes(norm(c.code)) || text.includes(norm(c.name)) || norm(c.name).includes(text)) return c.id;
    return undefined;
  }

  private suggestedCostCenter(companyId: number, docIds: number[]): number | null {
    const company = this.db.prepare("SELECT nif FROM companies WHERE id = ?").get(companyId) as any;
    for (const id of docIds) {
      const d = this.db.prepare("SELECT extracted_json FROM documents WHERE id = ?").get(id) as any;
      if (!d?.extracted_json) continue;
      try {
        const nif = counterpartyNif(JSON.parse(d.extracted_json), company?.nif ?? "");
        if (!nif) continue;
        const p = this.db.prepare("SELECT default_cost_center_id FROM supplier_profiles WHERE company_id = ? AND nif = ?").get(companyId, nif) as any;
        if (p?.default_cost_center_id) return p.default_cost_center_id;
      } catch { /* ignore */ }
    }
    return null;
  }
}
