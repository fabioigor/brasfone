/**
 * WhatsApp Business (Meta Cloud API) reception.
 *   GET  /webhooks/whatsapp  -> subscription verification (hub.challenge)
 *   POST /webhooks/whatsapp  -> messages; signature X-Hub-Signature-256
 *                               (HMAC SHA-256 of the raw body with the app secret)
 * Media (documents, images) is downloaded through the Graph API and fed to
 * the inbound pipeline. Text-only messages are recorded as 'sem_anexos'.
 * Env: WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_ACCESS_TOKEN,
 *      WHATSAPP_PHONE_NUMBER_ID (for replies), WHATSAPP_REPLY=1 to confirm.
 */
import crypto from "node:crypto";
import { InboundMessage, InboundAttachment } from "./inbound.js";

export interface WhatsAppConfig {
  verifyToken: string;
  appSecret: string;
  accessToken: string;
  phoneNumberId?: string;
  graphVersion?: string;
  reply?: boolean;
}

export function whatsappConfigFromEnv(): WhatsAppConfig | null {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!verifyToken || !appSecret || !accessToken) return null;
  return {
    verifyToken,
    appSecret,
    accessToken,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || "v21.0",
    reply: process.env.WHATSAPP_REPLY === "1",
  };
}

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export interface WaMediaRef {
  id: string;
  mimeType: string;
  filename: string;
  caption: string | null;
}

export interface WaIncoming {
  messageId: string;
  from: string; // digits (E.164 without '+')
  timestamp: string;
  text: string | null;
  media: WaMediaRef[];
  phoneNumberId: string | null;
}

/** Flattens a Cloud API webhook payload into incoming messages (ignores statuses). */
export function parseWhatsAppPayload(payload: any): WaIncoming[] {
  const out: WaIncoming[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id ?? null;
      for (const m of value.messages ?? []) {
        const media: WaMediaRef[] = [];
        if (m.type === "document" && m.document?.id) {
          media.push({ id: m.document.id, mimeType: m.document.mime_type || "application/octet-stream", filename: m.document.filename || `documento-${m.document.id}`, caption: m.document.caption ?? null });
        } else if (m.type === "image" && m.image?.id) {
          const ext = (m.image.mime_type || "image/jpeg").split("/")[1] || "jpg";
          media.push({ id: m.image.id, mimeType: m.image.mime_type || "image/jpeg", filename: `imagem-${m.image.id}.${ext}`, caption: m.image.caption ?? null });
        }
        out.push({
          messageId: m.id,
          from: String(m.from ?? "").replace(/\D/g, ""),
          timestamp: m.timestamp ?? "",
          text: m.type === "text" ? m.text?.body ?? null : media[0]?.caption ?? null,
          media,
          phoneNumberId,
        });
      }
    }
  }
  return out;
}

export class WhatsAppClient {
  constructor(private cfg: WhatsAppConfig, private fetchImpl: typeof fetch = fetch) {}

  private get base() {
    return `https://graph.facebook.com/${this.cfg.graphVersion || "v21.0"}`;
  }

  /** Two-step media download: metadata (url) then the bytes, both with the bearer token. */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const meta = await this.fetchImpl(`${this.base}/${mediaId}`, { headers: { authorization: `Bearer ${this.cfg.accessToken}` } });
    if (!meta.ok) throw new Error(`Meta media metadata HTTP ${meta.status}`);
    const info = (await meta.json()) as any;
    const res = await this.fetchImpl(info.url, { headers: { authorization: `Bearer ${this.cfg.accessToken}` } });
    if (!res.ok) throw new Error(`Meta media download HTTP ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: info.mime_type || res.headers.get("content-type") || "application/octet-stream" };
  }

  async sendText(to: string, text: string): Promise<void> {
    if (!this.cfg.phoneNumberId) return;
    await this.fetchImpl(`${this.base}/${this.cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    });
  }
}

/** Turns an incoming WhatsApp message into the channel-neutral InboundMessage. */
export async function toInboundMessage(msg: WaIncoming, client: WhatsAppClient): Promise<InboundMessage> {
  const attachments: InboundAttachment[] = [];
  for (const m of msg.media) {
    const { buffer, mimeType } = await client.downloadMedia(m.id);
    attachments.push({ filename: m.filename, mimeType: mimeType || m.mimeType, buffer });
  }
  return {
    channel: "whatsapp",
    externalId: msg.messageId,
    sender: msg.from,
    recipient: msg.phoneNumberId,
    subject: null,
    body: msg.text,
    attachments,
  };
}
