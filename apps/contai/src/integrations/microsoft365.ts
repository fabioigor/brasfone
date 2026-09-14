/**
 * Microsoft 365 (Graph API) integration: OneDrive / SharePoint as the archive of scanned documents.
 *
 * Auth: application (client credentials) against Entra ID, scope https://graph.microsoft.com/.default,
 * with the application permission Files.ReadWrite.All granted by an administrator. Target drive:
 * a user's OneDrive (MS365_DRIVE_USER, e.g. documentos@lumarcont.pt) or a SharePoint site (MS365_SITE_ID).
 *
 * Layout in the drive: <root>/<Company (NIF)>/<YYYY>/<MM>/<Tipo>/<docId>-<original name>.
 * Uploads are idempotent (conflictBehavior=replace and the document id in the file name); the sync
 * worker retries failed documents up to MAX_ATTEMPTS and records the last error on the document row.
 */
import fs from "node:fs";
import path from "node:path";
import { Db, audit } from "../db.js";

export interface Microsoft365Config {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  driveUser?: string | null;
  siteId?: string | null;
  rootFolder?: string;
}

const DOC_TYPE_FOLDER: Record<string, string> = {
  factura_compra: "Facturas de compra", factura_venda: "Facturas de venda", nota_credito: "Notas de credito", recibo: "Recibos",
  extracto_bancario: "Extractos bancarios", despesa: "Despesas", guia_transporte: "Guias de transporte", outro: "Outros", por_classificar: "Por classificar",
};
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;   // Graph: simple PUT up to 4 MB
const CHUNK = 5 * 1024 * 1024;                 // upload session chunks (multiple of 320 KiB)
export const MAX_ATTEMPTS = 5;

/** Removes characters OneDrive rejects in names and trims length. */
export function safeName(s: string, max = 120): string {
  const cleaned = s.replace(/[\\/:*?"<>|#%]/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");
  return (cleaned || "sem nome").slice(0, max);
}

export function microsoft365ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Microsoft365Config | null {
  const tenantId = env.MS365_TENANT_ID?.trim(), clientId = env.MS365_CLIENT_ID?.trim(), clientSecret = env.MS365_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) return null;
  const driveUser = env.MS365_DRIVE_USER?.trim() || null, siteId = env.MS365_SITE_ID?.trim() || null;
  if (!driveUser && !siteId) return null;
  return { tenantId, clientId, clientSecret, driveUser, siteId, rootFolder: env.MS365_ROOT_FOLDER?.trim() || "Cont.ai" };
}

export class Microsoft365Error extends Error {
  constructor(message: string, public httpStatus?: number) { super(message); this.name = "Microsoft365Error"; }
}

export class Microsoft365Client {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private cfg: Microsoft365Config, private fetchImpl: typeof fetch = fetch) {}

  /** /users/{upn}/drive or /sites/{id}/drive */
  drivePath(): string {
    return this.cfg.siteId ? `/sites/${encodeURIComponent(this.cfg.siteId)}/drive` : `/users/${encodeURIComponent(this.cfg.driveUser!)}/drive`;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" });
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Microsoft365Error(`Autenticação Microsoft 365 falhou (HTTP ${res.status}): ${json.error_description || json.error || "sem detalhe"}`.slice(0, 300), res.status);
    this.token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000 };
    return this.token.value;
  }

  async graph(method: string, url: string, init: { body?: string | Buffer | Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const token = await this.accessToken();
    const full = url.startsWith("https://") ? url : `https://graph.microsoft.com/v1.0${url}`;
    return this.fetchImpl(full, { method, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) }, body: init.body as any });
  }

  /** Connection test: drive name, owner and quota. */
  async driveInfo(): Promise<{ name: string; owner: string; webUrl: string; usedGb: number; totalGb: number }> {
    const res = await this.graph("GET", `${this.drivePath()}?$select=id,name,webUrl,owner,quota`);
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Microsoft365Error(`Sem acesso à drive (HTTP ${res.status}): ${d?.error?.message || "sem detalhe"}`.slice(0, 300), res.status);
    const gb = (n: number) => Math.round((Number(n || 0) / 1024 ** 3) * 10) / 10;
    return { name: d.name || "OneDrive", owner: d.owner?.user?.displayName || d.owner?.user?.email || this.cfg.driveUser || this.cfg.siteId || "", webUrl: d.webUrl || "", usedGb: gb(d.quota?.used), totalGb: gb(d.quota?.total) };
  }

  /** Uploads bytes to <path> (folders created implicitly). Returns the drive item. */
  async upload(itemPath: string, data: Buffer, mimeType: string): Promise<{ id: string; webUrl: string; size: number }> {
    const encoded = itemPath.split("/").map(encodeURIComponent).join("/");
    if (data.length <= SIMPLE_UPLOAD_LIMIT) {
      const res = await this.graph("PUT", `${this.drivePath()}/root:/${encoded}:/content?@microsoft.graph.conflictBehavior=replace`, { body: data, headers: { "content-type": mimeType || "application/octet-stream" } });
      const item: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Microsoft365Error(`Upload rejeitado (HTTP ${res.status}): ${item?.error?.message || "sem detalhe"}`.slice(0, 300), res.status);
      return { id: item.id, webUrl: item.webUrl, size: item.size ?? data.length };
    }
    const sessionRes = await this.graph("POST", `${this.drivePath()}/root:/${encoded}:/createUploadSession`, {
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace", name: path.posix.basename(itemPath) } }), headers: { "content-type": "application/json" },
    });
    const session: any = await sessionRes.json().catch(() => ({}));
    if (!sessionRes.ok || !session.uploadUrl) throw new Microsoft365Error(`Sessão de upload recusada (HTTP ${sessionRes.status}): ${session?.error?.message || "sem detalhe"}`.slice(0, 300), sessionRes.status);
    let item: any = null;
    for (let start = 0; start < data.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, data.length);
      const res = await this.fetchImpl(session.uploadUrl, { method: "PUT", headers: { "content-length": String(end - start), "content-range": `bytes ${start}-${end - 1}/${data.length}` }, body: data.subarray(start, end) });
      if (!res.ok) throw new Microsoft365Error(`Falha a enviar o bloco ${start}-${end - 1} (HTTP ${res.status}).`, res.status);
      if (res.status === 200 || res.status === 201) item = await res.json().catch(() => null);
    }
    if (!item?.id) throw new Microsoft365Error("Sessão de upload terminou sem item.");
    return { id: item.id, webUrl: item.webUrl, size: item.size ?? data.length };
  }
}

interface DocRow { id: number; company_id: number; original_name: string; stored_path: string; mime_type: string; doc_type: string; doc_date: string | null; created_at: string; company_name: string; nif: string; onedrive_attempts: number }

/** Path in the drive for a document: <root>/<Company (NIF)>/<YYYY>/<MM>/<Tipo>/<id>-<name>. */
export function drivePathFor(root: string, d: Pick<DocRow, "id" | "original_name" | "doc_type" | "doc_date" | "created_at" | "company_name" | "nif">): string {
  const when = /^\d{4}-\d{2}/.test(d.doc_date || "") ? d.doc_date! : d.created_at;
  const yyyy = when.slice(0, 4), mm = when.slice(5, 7);
  const company = safeName(`${d.company_name} (${d.nif})`, 100);
  const type = DOC_TYPE_FOLDER[d.doc_type] || safeName(d.doc_type);
  return [safeName(root || "Cont.ai"), company, yyyy, mm, type, `${d.id}-${safeName(d.original_name)}`].join("/");
}

export interface SyncOutcome { documentId: number; status: "sincronizado" | "erro" | "ficheiro_em_falta"; webUrl?: string; error?: string }

/** Copies stored documents to the drive, idempotently, recording the result on the document row. */
export class OneDriveSync {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private db: Db, private storageRoot: string, private client: Microsoft365Client, private rootFolder = "Cont.ai", private log: (m: string) => void = (m) => console.log(m)) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.syncPending().catch((e) => this.log(`[onedrive] ${e.message}`)); }, intervalMs);
    this.timer.unref?.();
    setTimeout(() => { this.syncPending().catch((e) => this.log(`[onedrive] ${e.message}`)); }, 3000).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  pending(limit = 20): DocRow[] {
    return this.db.prepare(
      `SELECT d.*, c.name AS company_name, c.nif FROM documents d JOIN companies c ON c.id = d.company_id
       WHERE d.onedrive_synced_at IS NULL AND COALESCE(d.onedrive_attempts, 0) < ? ORDER BY d.id LIMIT ?`
    ).all(MAX_ATTEMPTS, limit) as DocRow[];
  }

  counts(): { synced: number; pending: number; failed: number } {
    const r = this.db.prepare(
      `SELECT SUM(CASE WHEN onedrive_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS synced,
              SUM(CASE WHEN onedrive_synced_at IS NULL AND COALESCE(onedrive_attempts,0) < ? THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN onedrive_synced_at IS NULL AND COALESCE(onedrive_attempts,0) >= ? THEN 1 ELSE 0 END) AS failed FROM documents`
    ).get(MAX_ATTEMPTS, MAX_ATTEMPTS) as any;
    return { synced: r.synced || 0, pending: r.pending || 0, failed: r.failed || 0 };
  }

  async syncDocument(d: DocRow, actorId: number | null = null): Promise<SyncOutcome> {
    const abs = path.join(this.storageRoot, d.stored_path);
    if (!fs.existsSync(abs)) {
      this.db.prepare("UPDATE documents SET onedrive_error = ?, onedrive_attempts = ? WHERE id = ?").run("Ficheiro local já não existe.", MAX_ATTEMPTS, d.id);
      return { documentId: d.id, status: "ficheiro_em_falta" };
    }
    const target = drivePathFor(this.rootFolder, d);
    try {
      const item = await this.client.upload(target, fs.readFileSync(abs), d.mime_type);
      this.db.prepare("UPDATE documents SET onedrive_item_id = ?, onedrive_url = ?, onedrive_path = ?, onedrive_synced_at = datetime('now'), onedrive_error = NULL WHERE id = ?").run(item.id, item.webUrl, target, d.id);
      audit(this.db, actorId, "onedrive_upload", "document", d.id, target);
      return { documentId: d.id, status: "sincronizado", webUrl: item.webUrl };
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 300);
      this.db.prepare("UPDATE documents SET onedrive_error = ?, onedrive_attempts = COALESCE(onedrive_attempts, 0) + 1 WHERE id = ?").run(msg, d.id);
      return { documentId: d.id, status: "erro", error: msg };
    }
  }

  async syncPending(limit = 20, actorId: number | null = null): Promise<SyncOutcome[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const out: SyncOutcome[] = [];
      for (const d of this.pending(limit)) out.push(await this.syncDocument(d, actorId));
      if (out.length) this.log(`[onedrive] ${out.filter((o) => o.status === "sincronizado").length}/${out.length} documento(s) sincronizados`);
      return out;
    } finally { this.running = false; }
  }

  /** Reset failed documents so the worker tries again. */
  retryFailed(): number {
    return this.db.prepare("UPDATE documents SET onedrive_attempts = 0 WHERE onedrive_synced_at IS NULL AND COALESCE(onedrive_attempts,0) >= ?").run(MAX_ATTEMPTS).changes;
  }
}
