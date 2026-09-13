/**
 * Multi-channel reception (email, WhatsApp). Both channels converge here:
 * a normalised InboundMessage with attachments is mapped to a company
 * through its registered contacts (sender address or phone) and every
 * supported attachment goes through the same ingestion pipeline as a
 * portal upload. Unknown senders are never auto-created as companies: the
 * message is kept for the accountant to map, and an alert is raised.
 */
import { Db, audit } from "../db.js";
import { AiProvider } from "../ai/provider.js";
import { ingestDocument, IngestOutcome } from "../pipeline.js";
import { OcrEngine } from "../ocr/engine.js";
import { ClaudeStructuredExtractor } from "../extraction/structured.js";

export type Channel = "email" | "whatsapp";

export interface InboundAttachment {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface InboundMessage {
  channel: Channel;
  externalId: string;
  sender: string; // email address or E.164 phone
  recipient?: string | null;
  subject?: string | null;
  body?: string | null;
  attachments: InboundAttachment[];
}

export interface InboundResult {
  inboundId: number;
  status: "processado" | "sem_empresa" | "sem_anexos" | "duplicado";
  companyId: number | null;
  outcomes: IngestOutcome[];
}

export interface InboundDeps {
  provider: AiProvider;
  ocr: OcrEngine;
  structured?: ClaudeStructuredExtractor | null;
  storageRoot: string;
  /** User id recorded as uploader for channel intakes (a service user). */
  systemUserId: number;
}

const SUPPORTED = /\.(pdf|png|jpe?g|webp|tiff?|txt|csv|xml)$/i;
const SUPPORTED_MIME = /^(application\/pdf|image\/(png|jpe?g|webp|tiff?)|text\/(plain|csv|xml)|application\/xml)/i;

export function normaliseEmail(a: string): string {
  const m = a.match(/<([^>]+)>/);
  return (m ? m[1]! : a).trim().toLowerCase();
}

/** E.164 without '+' (as Meta sends it), digits only. */
export function normalisePhone(p: string): string {
  return p.replace(/\D/g, "");
}

export function normaliseAddress(channel: Channel, address: string): string {
  return channel === "email" ? normaliseEmail(address) : normalisePhone(address);
}

export function companyForContact(db: Db, channel: Channel, address: string): number | null {
  const row = db
    .prepare("SELECT company_id FROM company_contacts WHERE channel = ? AND address = ?")
    .get(channel, normaliseAddress(channel, address)) as any;
  return row?.company_id ?? null;
}

/**
 * Optional address-based routing for email: docs+<companyId>@... or
 * <token>@... where the local part before '@' matches `empresa-<id>`.
 */
export function companyFromRecipient(db: Db, recipient: string | null | undefined): number | null {
  if (!recipient) return null;
  const local = normaliseEmail(recipient).split("@")[0] ?? "";
  const m = local.match(/(?:\+|^)(?:empresa[-_]?)?(\d{1,6})$/);
  if (!m) return null;
  const id = Number(m[1]);
  const row = db.prepare("SELECT id FROM companies WHERE id = ?").get(id);
  return row ? id : null;
}

export async function processInbound(db: Db, deps: InboundDeps, msg: InboundMessage): Promise<InboundResult> {
  const existing = db
    .prepare("SELECT id, company_id FROM inbound_messages WHERE channel = ? AND external_id = ?")
    .get(msg.channel, msg.externalId) as any;
  if (existing) return { inboundId: existing.id, status: "duplicado", companyId: existing.company_id, outcomes: [] };

  const sender = normaliseAddress(msg.channel, msg.sender);
  const companyId = companyForContact(db, msg.channel, sender) ?? (msg.channel === "email" ? companyFromRecipient(db, msg.recipient) : null);
  const usable = msg.attachments.filter((a) => SUPPORTED.test(a.filename) || SUPPORTED_MIME.test(a.mimeType));
  const excerpt = (msg.body ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;

  const insert = db.prepare(
    `INSERT INTO inbound_messages (channel, external_id, sender, recipient, subject, body_excerpt, company_id, status, attachments, document_ids, error_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  if (!companyId) {
    const r = insert.run(msg.channel, msg.externalId, sender, msg.recipient ?? null, msg.subject ?? null, excerpt, null, "sem_empresa", usable.length, null, null);
    const id = Number(r.lastInsertRowid);
    audit(db, null, "inbound_unknown", "inbound_message", id, `${msg.channel} ${sender}`);
    return { inboundId: id, status: "sem_empresa", companyId: null, outcomes: [] };
  }
  if (usable.length === 0) {
    const r = insert.run(msg.channel, msg.externalId, sender, msg.recipient ?? null, msg.subject ?? null, excerpt, companyId, "sem_anexos", 0, null, null);
    return { inboundId: Number(r.lastInsertRowid), status: "sem_anexos", companyId, outcomes: [] };
  }

  const outcomes: IngestOutcome[] = [];
  const errors: string[] = [];
  for (const att of usable) {
    try {
      outcomes.push(
        await ingestDocument(
          db, deps.provider, deps.storageRoot,
          { companyId, uploaderId: deps.systemUserId, originalName: att.filename, mimeType: att.mimeType, buffer: att.buffer, channel: msg.channel },
          deps.ocr, deps.structured
        )
      );
    } catch (e: any) {
      errors.push(`${att.filename}: ${e.message}`);
    }
  }
  const status = outcomes.length > 0 ? "processado" : "erro";
  const r = insert.run(
    msg.channel, msg.externalId, sender, msg.recipient ?? null, msg.subject ?? null, excerpt, companyId, status, usable.length,
    JSON.stringify(outcomes.map((o) => o.documentId)), errors.length ? errors.join("; ") : null
  );
  const id = Number(r.lastInsertRowid);
  audit(db, deps.systemUserId, "inbound", "inbound_message", id, `${msg.channel} ${sender}: ${outcomes.length} doc(s)`);
  return { inboundId: id, status: status === "erro" ? "sem_anexos" : "processado", companyId, outcomes };
}

/** Human-readable confirmation for the sender (used for WhatsApp replies). */
export function confirmationText(result: InboundResult): string {
  if (result.status === "sem_empresa") {
    return "Recebemos a sua mensagem, mas este contacto ainda não está associado a nenhuma empresa. O gabinete irá fazer a associação.";
  }
  if (result.status === "sem_anexos") return "Recebemos a sua mensagem, mas não encontrámos nenhum documento anexado (PDF ou imagem).";
  if (result.status === "duplicado") return "Esta mensagem já tinha sido recebida.";
  const parts = result.outcomes.map((o) => {
    const tipo = o.docType.replace(/_/g, " ");
    return o.duplicate ? `${tipo} (já existia)` : `${tipo}${o.findings.some((f) => f.severity === "erro") ? " (com alertas a rever)" : ""}`;
  });
  return `Documento(s) recebido(s) e classificado(s): ${parts.join("; ")}. Obrigado.`;
}
