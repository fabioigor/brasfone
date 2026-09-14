/**
 * Email intake through Microsoft Graph (Microsoft 365 authentication): reads unread messages with
 * attachments from a mailbox of the tenant using the same application registration as the OneDrive
 * archive (application permission Mail.ReadWrite, ideally limited to that mailbox with an
 * Application Access Policy). No mailbox password is stored; IMAP stays as a fallback for other providers.
 */
import { Db } from "../db.js";
import { Microsoft365Client } from "../integrations/microsoft365.js";
import { InboundDeps, InboundMessage, InboundResult, processInbound } from "./inbound.js";

export interface GraphMailConfig {
  mailbox: string;          // UPN of the mailbox, e.g. documentos@lumarcont.pt
  folder: string;           // well-known name or display name; default "inbox"
  intervalMs: number;
  markRead: boolean;
}

export function graphMailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GraphMailConfig | null {
  const mailbox = env.MS365_MAIL_USER?.trim();
  if (!mailbox) return null;
  return { mailbox, folder: env.MS365_MAIL_FOLDER?.trim() || "inbox", intervalMs: Number(env.MS365_MAIL_POLL_SECONDS || 120) * 1000, markRead: env.MS365_MAIL_MARK_READ !== "0" };
}

export class GraphMailPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private db: Db, private deps: InboundDeps, private client: Microsoft365Client, private cfg: GraphMailConfig, private log: (m: string) => void = console.log) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.cfg.intervalMs);
    this.timer.unref?.();
    setTimeout(() => void this.pollOnce(), 2000).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private base(): string { return `/users/${encodeURIComponent(this.cfg.mailbox)}/mailFolders/${encodeURIComponent(this.cfg.folder)}`; }

  /** Connection test: folder counters. */
  async folderInfo(): Promise<{ displayName: string; total: number; unread: number }> {
    const res = await this.client.graph("GET", `${this.base()}?$select=displayName,totalItemCount,unreadItemCount`);
    const f: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Sem acesso à caixa ${this.cfg.mailbox} (HTTP ${res.status}): ${f?.error?.message || "sem detalhe"}`.slice(0, 300));
    return { displayName: f.displayName || this.cfg.folder, total: f.totalItemCount ?? 0, unread: f.unreadItemCount ?? 0 };
  }

  async pollOnce(): Promise<InboundResult[]> {
    if (this.running) return [];
    this.running = true;
    const results: InboundResult[] = [];
    try {
      const list = await this.client.graph("GET", `${this.base()}/messages?$filter=isRead eq false and hasAttachments eq true&$select=id,subject,from,toRecipients,internetMessageId,bodyPreview&$top=20&$orderby=receivedDateTime asc`);
      const body: any = await list.json().catch(() => ({}));
      if (!list.ok) throw new Error(`Graph mail HTTP ${list.status}: ${body?.error?.message || "sem detalhe"}`);
      for (const m of body.value || []) {
        const att = await this.client.graph("GET", `/users/${encodeURIComponent(this.cfg.mailbox)}/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline,@odata.type,contentBytes`);
        const attBody: any = await att.json().catch(() => ({}));
        const attachments = ((attBody.value || []) as any[])
          .filter((a) => a["@odata.type"] === "#microsoft.graph.fileAttachment" && a.contentBytes && !a.isInline)
          .map((a) => ({ filename: a.name || "anexo", mimeType: a.contentType || "application/octet-stream", buffer: Buffer.from(a.contentBytes, "base64") }));
        const msg: InboundMessage = {
          channel: "email",
          externalId: m.internetMessageId || `graph:${m.id}`,
          sender: String(m.from?.emailAddress?.address || "").toLowerCase(),
          recipient: m.toRecipients?.[0]?.emailAddress?.address || this.cfg.mailbox,
          subject: m.subject || null,
          body: m.bodyPreview || null,
          attachments,
        };
        const r = await processInbound(this.db, this.deps, msg);
        results.push(r);
        if (this.cfg.markRead) {
          await this.client.graph("PATCH", `/users/${encodeURIComponent(this.cfg.mailbox)}/messages/${encodeURIComponent(m.id)}`, { body: JSON.stringify({ isRead: true, categories: ["Cont.ai"] }), headers: { "content-type": "application/json" } });
        }
        this.log(`[email 365] ${msg.sender}: ${r.status} (${r.outcomes.length} doc)`);
      }
    } catch (e: any) {
      this.log(`[email 365] erro: ${e.message}`);
    } finally {
      this.running = false;
    }
    return results;
  }
}
