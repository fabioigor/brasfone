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

export interface DriveChild { id: string; name: string; size: number; isFolder: boolean; mimeType: string | null; webUrl: string | null; modified: string | null }

/** Folder and mail helpers (same client credentials). */
export class Microsoft365Files {
  constructor(private client: Microsoft365Client) {}

  private enc(p: string): string { return p.split("/").filter(Boolean).map(encodeURIComponent).join("/"); }

  /** Gets a drive item by path; null when it does not exist. */
  async itemByPath(itemPath: string): Promise<{ id: string; webUrl: string; isFolder: boolean } | null> {
    const res = await this.client.graph("GET", `${this.client.drivePath()}/root:/${this.enc(itemPath)}?$select=id,webUrl,folder`);
    if (res.status === 404) return null;
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Microsoft365Error(`Sem acesso ao item ${itemPath} (HTTP ${res.status}): ${j?.error?.message || "sem detalhe"}`.slice(0, 300), res.status);
    return { id: j.id, webUrl: j.webUrl, isFolder: !!j.folder };
  }

  /** Creates the folder chain if needed and returns the last folder. */
  async ensureFolder(folderPath: string): Promise<{ id: string; webUrl: string }> {
    const parts = folderPath.split("/").filter(Boolean);
    let existing = await this.itemByPath(parts.join("/"));
    if (existing) return { id: existing.id, webUrl: existing.webUrl };
    // find the deepest existing prefix, then create the rest
    let depth = parts.length - 1;
    while (depth > 0 && !(existing = await this.itemByPath(parts.slice(0, depth).join("/")))) depth--;
    let parentUrl = depth > 0 ? `${this.client.drivePath()}/root:/${this.enc(parts.slice(0, depth).join("/"))}:/children` : `${this.client.drivePath()}/root/children`;
    let last: any = existing;
    for (let i = depth; i < parts.length; i++) {
      const res = await this.client.graph("POST", parentUrl, { body: JSON.stringify({ name: parts[i], folder: {}, "@microsoft.graph.conflictBehavior": "fail" }), headers: { "content-type": "application/json" } });
      let j: any = await res.json().catch(() => ({}));
      if (res.status === 409) { const again = await this.itemByPath(parts.slice(0, i + 1).join("/")); if (!again) throw new Microsoft365Error(`Pasta ${parts[i]} em conflito.`, 409); j = again; }
      else if (!res.ok) throw new Microsoft365Error(`Não foi possível criar a pasta ${parts[i]} (HTTP ${res.status}): ${j?.error?.message || "sem detalhe"}`.slice(0, 300), res.status);
      last = j; parentUrl = `${this.client.drivePath()}/items/${encodeURIComponent(j.id)}/children`;
    }
    return { id: last.id, webUrl: last.webUrl };
  }

  async children(folderPath: string, top = 50): Promise<DriveChild[]> {
    const res = await this.client.graph("GET", `${this.client.drivePath()}/root:/${this.enc(folderPath)}:/children?$select=id,name,size,file,folder,webUrl,lastModifiedDateTime&$top=${top}`);
    if (res.status === 404) return [];
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Microsoft365Error(`Não foi possível listar ${folderPath} (HTTP ${res.status}): ${j?.error?.message || "sem detalhe"}`.slice(0, 300), res.status);
    return (j.value ?? []).map((c: any) => ({ id: c.id, name: c.name, size: c.size ?? 0, isFolder: !!c.folder, mimeType: c.file?.mimeType ?? null, webUrl: c.webUrl ?? null, modified: c.lastModifiedDateTime ?? null }));
  }

  async download(itemId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const res = await this.client.graph("GET", `${this.client.drivePath()}/items/${encodeURIComponent(itemId)}/content`);
    if (!res.ok) throw new Microsoft365Error(`Download falhou (HTTP ${res.status}).`, res.status);
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type") || "application/octet-stream" };
  }

  async deleteItem(itemId: string): Promise<void> {
    const res = await this.client.graph("DELETE", `${this.client.drivePath()}/items/${encodeURIComponent(itemId)}`);
    if (!res.ok && res.status !== 404) throw new Microsoft365Error(`Não foi possível apagar o item (HTTP ${res.status}).`, res.status);
  }

  async moveItem(itemId: string, parentFolderId: string, newName?: string): Promise<void> {
    const res = await this.client.graph("PATCH", `${this.client.drivePath()}/items/${encodeURIComponent(itemId)}`, { body: JSON.stringify({ parentReference: { id: parentFolderId }, ...(newName ? { name: newName } : {}), "@microsoft.graph.conflictBehavior": "rename" }), headers: { "content-type": "application/json" } });
    if (!res.ok) throw new Microsoft365Error(`Não foi possível mover o item (HTTP ${res.status}).`, res.status);
  }

  /** Sends an email from a mailbox with application permission Mail.Send. */
  async sendMail(from: string, msg: { to: string[]; cc?: string[]; subject: string; html: string; text?: string; attachments?: { name: string; contentType: string; bytes: Buffer }[] }): Promise<void> {
    const rcpt = (a: string) => ({ emailAddress: { address: a } });
    const attachments = (msg.attachments ?? []).map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.name, contentType: a.contentType, contentBytes: a.bytes.toString("base64") }));
    const res = await this.client.graph("POST", `/users/${encodeURIComponent(from)}/sendMail`, {
      body: JSON.stringify({ message: { subject: msg.subject, body: { contentType: "HTML", content: msg.html }, toRecipients: msg.to.map(rcpt), ccRecipients: (msg.cc ?? []).map(rcpt), ...(attachments.length ? { attachments } : {}) }, saveToSentItems: true }),
      headers: { "content-type": "application/json" },
    });
    if (!res.ok && res.status !== 202) { const j: any = await res.json().catch(() => ({})); throw new Microsoft365Error(`Envio de email recusado (HTTP ${res.status}): ${j?.error?.message || "sem detalhe"}`.slice(0, 300), res.status); }
  }
}

interface DocRow { id: number; company_id: number; original_name: string; stored_path: string; mime_type: string; doc_type: string; doc_date: string | null; created_at: string; company_name: string; nif: string; onedrive_attempts: number; cost_center_code?: string | null; cost_center_name?: string | null }

export const COST_CENTERS_FOLDER = "Centros de custo";
export const INTAKE_FOLDER = "A receber";

/** Folder of a cost centre: <root>/<Company (NIF)>/Centros de custo/<CODE - Name>. Files dropped in its "A receber" subfolder are ingested with that cost centre. */
export function costCenterFolderFor(root: string, companyName: string, nif: string, cc: { code: string; name: string }): string {
  return [safeName(root || "Cont.ai"), safeName(`${companyName} (${nif})`, 100), COST_CENTERS_FOLDER, safeName(`${cc.code} - ${cc.name}`, 80)].join("/");
}

/** Path in the drive for a document: <root>/<Company (NIF)>/<YYYY>/<MM>/<Tipo>/<id>-<name>. */
export function drivePathFor(root: string, d: Pick<DocRow, "id" | "original_name" | "doc_type" | "doc_date" | "created_at" | "company_name" | "nif"> & { cost_center_code?: string | null; cost_center_name?: string | null }): string {
  const when = /^\d{4}-\d{2}/.test(d.doc_date || "") ? d.doc_date! : d.created_at;
  const yyyy = when.slice(0, 4), mm = when.slice(5, 7);
  const company = safeName(`${d.company_name} (${d.nif})`, 100);
  const type = DOC_TYPE_FOLDER[d.doc_type] || safeName(d.doc_type);
  const base = d.cost_center_code ? [safeName(root || "Cont.ai"), company, COST_CENTERS_FOLDER, safeName(`${d.cost_center_code} - ${d.cost_center_name || d.cost_center_code}`, 80)] : [safeName(root || "Cont.ai"), company];
  return [...base, yyyy, mm, type, `${d.id}-${safeName(d.original_name)}`].join("/");
}

export interface SyncOutcome { documentId: number; status: "sincronizado" | "erro" | "ficheiro_em_falta"; webUrl?: string; error?: string }

/** Copies stored documents to the drive, idempotently, recording the result on the document row. */
/** What the intake poller needs to ingest a file found in a cost centre folder (set by the app at startup). */
export interface IntakeIngestor {
  ingest(input: { companyId: number; uploaderId: number; originalName: string; mimeType: string; buffer: Buffer; costCenterId: number }): Promise<{ documentId: number; duplicate: boolean; docType: string }>;
  systemUserId: number;
}

const INTAKE_SUPPORTED = /\.(pdf|png|jpe?g|webp|tiff?|txt|csv|xml)$/i;

export class OneDriveSync {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  readonly files: Microsoft365Files;
  private ingestor: IntakeIngestor | null = null;
  constructor(private db: Db, private storageRoot: string, private client: Microsoft365Client, private rootFolder = "Cont.ai", private log: (m: string) => void = (m) => console.log(m)) {
    this.files = new Microsoft365Files(client);
  }

  /** Enables reading the "A receber" folders of the cost centres. */
  setIntake(ingestor: IntakeIngestor | null): void { this.ingestor = ingestor; }
  get intakeEnabled(): boolean { return this.ingestor !== null; }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    const tick = () => { this.tickAll().catch((e) => this.log(`[onedrive] ${e.message}`)); };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    setTimeout(tick, 3000).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One cycle: folders for new cost centres, files dropped in "A receber", then the archive queue. */
  async tickAll(): Promise<void> {
    await this.ensureAllCostCenterFolders().catch((e) => this.log(`[onedrive] pastas: ${e.message}`));
    await this.pollIntake().catch((e) => this.log(`[onedrive] recepção: ${e.message}`));
    await this.syncPending();
  }

  pending(limit = 20): DocRow[] {
    return this.db.prepare(
      `SELECT d.*, c.name AS company_name, c.nif, cc.code AS cost_center_code, cc.name AS cost_center_name
       FROM documents d JOIN companies c ON c.id = d.company_id LEFT JOIN cost_centers cc ON cc.id = d.cost_center_id
       WHERE d.onedrive_synced_at IS NULL AND COALESCE(d.onedrive_attempts, 0) < ? ORDER BY d.id LIMIT ?`
    ).all(MAX_ATTEMPTS, limit) as DocRow[];
  }

  counts(): { synced: number; pending: number; failed: number; costCenterFolders: number; costCentersWithoutFolder: number; intakeProcessed: number; intakeErrors: number } {
    const r = this.db.prepare(
      `SELECT SUM(CASE WHEN onedrive_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS synced,
              SUM(CASE WHEN onedrive_synced_at IS NULL AND COALESCE(onedrive_attempts,0) < ? THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN onedrive_synced_at IS NULL AND COALESCE(onedrive_attempts,0) >= ? THEN 1 ELSE 0 END) AS failed FROM documents`
    ).get(MAX_ATTEMPTS, MAX_ATTEMPTS) as any;
    const cc = this.db.prepare("SELECT SUM(CASE WHEN onedrive_path IS NOT NULL THEN 1 ELSE 0 END) AS with_folder, SUM(CASE WHEN onedrive_path IS NULL THEN 1 ELSE 0 END) AS without_folder FROM cost_centers WHERE active = 1").get() as any;
    const it = this.db.prepare("SELECT SUM(CASE WHEN status = 'processado' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status = 'erro' THEN 1 ELSE 0 END) AS err FROM onedrive_intake").get() as any;
    return { synced: r.synced || 0, pending: r.pending || 0, failed: r.failed || 0, costCenterFolders: cc?.with_folder || 0, costCentersWithoutFolder: cc?.without_folder || 0, intakeProcessed: it?.ok || 0, intakeErrors: it?.err || 0 };
  }

  /** Creates (idempotently) the OneDrive folder of a cost centre and its "A receber" subfolder, recording ids on the row. */
  async ensureCostCenterFolder(costCenterId: number, actorId: number | null = null): Promise<{ path: string; webUrl: string }> {
    const cc = this.db.prepare("SELECT cc.*, c.name AS company_name, c.nif FROM cost_centers cc JOIN companies c ON c.id = cc.company_id WHERE cc.id = ?").get(costCenterId) as any;
    if (!cc) throw new Error("Centro de custo inexistente");
    const folder = costCenterFolderFor(this.rootFolder, cc.company_name, cc.nif, cc);
    const main = await this.files.ensureFolder(folder);
    const intake = await this.files.ensureFolder(`${folder}/${INTAKE_FOLDER}`);
    this.db.prepare("UPDATE cost_centers SET onedrive_folder_id = ?, onedrive_path = ?, onedrive_url = ?, onedrive_intake_id = ?, onedrive_error = NULL WHERE id = ?").run(main.id, folder, main.webUrl, intake.id, costCenterId);
    audit(this.db, actorId, "onedrive_folder", "cost_center", costCenterId, folder);
    return { path: folder, webUrl: main.webUrl };
  }

  async ensureAllCostCenterFolders(): Promise<number> {
    const rows = this.db.prepare("SELECT id FROM cost_centers WHERE active = 1 AND onedrive_path IS NULL AND COALESCE(onedrive_attempts, 0) < ?").all(MAX_ATTEMPTS) as any[];
    let n = 0;
    for (const r of rows) {
      try { await this.ensureCostCenterFolder(r.id); n++; }
      catch (e: any) { this.db.prepare("UPDATE cost_centers SET onedrive_error = ?, onedrive_attempts = COALESCE(onedrive_attempts, 0) + 1 WHERE id = ?").run(String(e?.message || e).slice(0, 300), r.id); }
    }
    return n;
  }

  /** Reads the "A receber" folder of every cost centre: each supported file is ingested with that cost centre, archived and removed from the folder. */
  async pollIntake(limitPerFolder = 10): Promise<{ processed: number; errors: number; skipped: number }> {
    const out = { processed: 0, errors: 0, skipped: 0 };
    if (!this.ingestor) return out;
    const ccs = this.db.prepare("SELECT cc.*, c.name AS company_name, c.nif FROM cost_centers cc JOIN companies c ON c.id = cc.company_id WHERE cc.active = 1 AND cc.onedrive_path IS NOT NULL").all() as any[];
    for (const cc of ccs) {
      let children: DriveChild[] = [];
      try { children = await this.files.children(`${cc.onedrive_path}/${INTAKE_FOLDER}`, limitPerFolder); } catch (e: any) { this.log(`[onedrive] ${cc.code}: ${e.message}`); continue; }
      for (const ch of children) {
        if (ch.isFolder) continue;
        const seen = this.db.prepare("SELECT status, attempts FROM onedrive_intake WHERE item_id = ?").get(ch.id) as any;
        if (seen && (seen.status === "processado" || seen.attempts >= 3)) { out.skipped++; continue; }
        if (!INTAKE_SUPPORTED.test(ch.name)) {
          this.db.prepare("INSERT OR REPLACE INTO onedrive_intake (item_id, cost_center_id, name, status, error, attempts, processed_at) VALUES (?, ?, ?, 'ignorado', 'tipo de ficheiro não suportado', 3, datetime('now'))").run(ch.id, cc.id, ch.name);
          out.skipped++; continue;
        }
        try {
          const { buffer, mimeType } = await this.files.download(ch.id);
          const r = await this.ingestor.ingest({ companyId: cc.company_id, uploaderId: this.ingestor.systemUserId, originalName: ch.name, mimeType: ch.mimeType || mimeType, buffer, costCenterId: cc.id });
          this.db.prepare("INSERT OR REPLACE INTO onedrive_intake (item_id, cost_center_id, document_id, name, status, error, attempts, processed_at) VALUES (?, ?, ?, ?, 'processado', NULL, COALESCE(?, 0) + 1, datetime('now'))").run(ch.id, cc.id, r.documentId, ch.name, seen?.attempts ?? 0);
          audit(this.db, this.ingestor.systemUserId, "onedrive_intake", "document", r.documentId, `${cc.onedrive_path}/${INTAKE_FOLDER}/${ch.name}${r.duplicate ? " (duplicado)" : ""}`);
          // Archive copy first, then remove the dropped file so the folder only holds what is still to process.
          const doc = this.db.prepare(`SELECT d.*, c.name AS company_name, c.nif, cc2.code AS cost_center_code, cc2.name AS cost_center_name FROM documents d JOIN companies c ON c.id = d.company_id LEFT JOIN cost_centers cc2 ON cc2.id = d.cost_center_id WHERE d.id = ?`).get(r.documentId) as DocRow | undefined;
          if (doc && !doc.onedrive_attempts) await this.syncDocument(doc, this.ingestor.systemUserId);
          await this.files.deleteItem(ch.id);
          out.processed++;
        } catch (e: any) {
          this.db.prepare("INSERT OR REPLACE INTO onedrive_intake (item_id, cost_center_id, name, status, error, attempts, processed_at) VALUES (?, ?, ?, 'erro', ?, COALESCE(?, 0) + 1, datetime('now'))").run(ch.id, cc.id, ch.name, String(e?.message || e).slice(0, 300), seen?.attempts ?? 0);
          out.errors++;
        }
      }
    }
    if (out.processed || out.errors) this.log(`[onedrive] recepção: ${out.processed} ficheiro(s) processado(s), ${out.errors} erro(s)`);
    return out;
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
