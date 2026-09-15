/**
 * Email reception, two mechanisms that feed the same inbound pipeline:
 *   1. Inbound webhook (POST /api/inbound/email, shared secret): JSON with
 *      from/to/subject/text and attachments (base64) as produced by
 *      SendGrid Inbound Parse, Mailgun Routes, Postmark or a small relay.
 *      Raw MIME (.eml) is also accepted and parsed with mailparser.
 *   2. IMAP poller (imapflow): reads UNSEEN messages from a mailbox on a
 *      schedule, processes them and marks them seen.
 * Routing: sender address registered as a company contact, or the alias
 * empresa-<id>@... / docs+<id>@... in the recipient.
 */
import { simpleParser } from "mailparser";
import { z } from "zod";
import { Db } from "../db.js";
import { InboundDeps, InboundMessage, InboundResult, processInbound } from "./inbound.js";

export const InboundEmailJsonSchema = z.object({
  message_id: z.string().min(1).optional(),
  from: z.string().min(3),
  to: z.string().optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  attachments: z
    .array(z.object({ filename: z.string().min(1), content_type: z.string().default("application/octet-stream"), content_base64: z.string().min(1) }))
    .default([]),
});

export function parseInboundEmailJson(body: unknown): InboundMessage {
  const p = InboundEmailJsonSchema.parse(body);
  return {
    channel: "email",
    externalId: p.message_id ?? `${p.from}|${p.subject ?? ""}|${Date.now()}`,
    sender: p.from,
    recipient: p.to ?? null,
    subject: p.subject ?? null,
    body: p.text ?? null,
    attachments: p.attachments.map((a) => ({ filename: a.filename, mimeType: a.content_type, buffer: Buffer.from(a.content_base64, "base64") })),
  };
}

/** Parses a raw RFC 822 message (.eml) into an InboundMessage. */
export async function parseRawEmail(raw: Buffer | string): Promise<InboundMessage> {
  const mail = await simpleParser(raw);
  const from = mail.from?.value?.[0]?.address ?? mail.from?.text ?? "desconhecido@invalido";
  const toField: any = mail.to;
  const to = Array.isArray(toField) ? toField[0]?.text : toField?.text;
  return {
    channel: "email",
    externalId: mail.messageId ?? `${from}|${mail.subject ?? ""}|${mail.date?.toISOString() ?? Date.now()}`,
    sender: from,
    recipient: to ?? null,
    subject: mail.subject ?? null,
    body: mail.text ?? null,
    attachments: (mail.attachments ?? []).map((a) => ({
      filename: a.filename || `anexo-${a.checksum || Date.now()}`,
      mimeType: a.contentType || "application/octet-stream",
      buffer: a.content,
    })),
  };
}

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  intervalMs: number;
}

export function imapConfigFromEnv(): ImapConfig | null {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;
  if (!host || !user || !password) return null;
  return {
    host,
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE !== "0",
    user,
    password,
    mailbox: process.env.IMAP_MAILBOX || "INBOX",
    intervalMs: Number(process.env.IMAP_POLL_SECONDS || 120) * 1000,
  };
}

/**
 * Polls an IMAP mailbox for unseen messages. Each message is processed once
 * (dedupe by Message-ID in inbound_messages) and flagged \Seen afterwards.
 */
export class EmailPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private db: Db, private deps: InboundDeps, private cfg: ImapConfig, private log: (m: string) => void = console.log) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.cfg.intervalMs);
    void this.pollOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<InboundResult[]> {
    if (this.running) return [];
    this.running = true;
    const results: InboundResult[] = [];
    try {
      const { ImapFlow } = await import("imapflow");
      const client = new ImapFlow({
        host: this.cfg.host, port: this.cfg.port, secure: this.cfg.secure,
        auth: { user: this.cfg.user, pass: this.cfg.password }, logger: false,
      });
      await client.connect();
      const lock = await client.getMailboxLock(this.cfg.mailbox);
      try {
        for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
          if (!msg.source) continue;
          const inbound = await parseRawEmail(msg.source);
          const r = await processInbound(this.db, this.deps, inbound);
          results.push(r);
          await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true });
          this.log(`[email] ${inbound.sender}: ${r.status} (${r.outcomes.length} doc)`);
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (e: any) {
      this.log(`[email] erro no poller IMAP: ${e.message}`);
    } finally {
      this.running = false;
    }
    return results;
  }
}
