/**
 * CentralGest Cloud integration.
 *
 * The CentralGest API is not publicly documented (access is granted through
 * their "Pedido de Adesao a API"); this client implements the assumed
 * contract described in docs/centralgest-api.md. When the official
 * documentation arrives, only this file and the mock need adjusting.
 *
 * Dispatching is idempotent at two layers: the local `dispatches` table
 * (entry_id unique per channel) and the `idExterno` sent to CentralGest,
 * whose 409 response is treated as "already posted".
 */
import { Db, audit } from "../db.js";
import { EntryLine } from "../domain/entries.js";

export interface CentralGestConfig {
  baseUrl: string;
  apiKey: string;
}

export interface CentralGestDocumentInput {
  companyCode: string;
  externalId: string;
  journal: string;
  docDate: string;
  description: string;
  lines: { conta: string; descricao: string; debito: number; credito: number }[];
}

export interface CentralGestDocumentResult {
  status: "lancado" | "ja_existia";
  remoteId: string | null;
  remoteNumber: string | null;
}

export class CentralGestError extends Error {
  constructor(
    message: string,
    public httpStatus?: number
  ) {
    super(message);
    this.name = "CentralGestError";
  }
}

export class CentralGestClient {
  private token: string | null = null;

  constructor(private config: CentralGestConfig) {}

  static fromEnv(): CentralGestClient | null {
    const baseUrl = process.env.CENTRALGEST_BASE_URL;
    const apiKey = process.env.CENTRALGEST_API_KEY;
    if (!baseUrl || !apiKey) return null;
    return new CentralGestClient({ baseUrl: baseUrl.replace(/\/$/, ""), apiKey });
  }

  private async authenticate(): Promise<void> {
    const res = await fetch(`${this.config.baseUrl}/api/v1/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: this.config.apiKey }),
    });
    if (!res.ok) {
      throw new CentralGestError(`Autenticacao CentralGest falhou (HTTP ${res.status}).`, res.status);
    }
    const body = (await res.json()) as any;
    if (!body?.token) throw new CentralGestError("Resposta de autenticacao sem token.");
    this.token = body.token;
  }

  private async request(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
    if (!this.token) await this.authenticate();
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.request(method, path, body, false);
    }
    return res;
  }

  /** Connection test: lists the companies the credentials can reach. */
  async listCompanies(): Promise<{ codigo: string; nome: string }[]> {
    const res = await this.request("GET", "/api/v1/empresas");
    if (!res.ok) throw new CentralGestError(`Falha ao listar empresas (HTTP ${res.status}).`, res.status);
    const body = (await res.json()) as any;
    return Array.isArray(body?.empresas) ? body.empresas : [];
  }

  async createAccountingDocument(input: CentralGestDocumentInput): Promise<CentralGestDocumentResult> {
    const res = await this.request(
      "POST",
      `/api/v1/empresas/${encodeURIComponent(input.companyCode)}/contabilidade/documentos`,
      {
        idExterno: input.externalId,
        diario: input.journal,
        dataDocumento: input.docDate,
        descricao: input.description,
        linhas: input.lines,
      }
    );
    if (res.status === 409) {
      // idExterno duplicado: ja foi lancado numa tentativa anterior.
      const body = (await res.json().catch(() => ({}))) as any;
      return { status: "ja_existia", remoteId: body?.id ?? null, remoteNumber: body?.numero ?? null };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new CentralGestError(
        `CentralGest rejeitou o documento (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        res.status
      );
    }
    const body = (await res.json()) as any;
    return { status: "lancado", remoteId: body?.id ?? null, remoteNumber: body?.numero ?? null };
  }
}

export interface DispatchOutcome {
  entryId: number;
  status: "lancado" | "ja_existia" | "ja_despachado" | "erro";
  remoteNumber?: string | null;
  error?: string;
}

export const externalIdFor = (entryId: number) => `contadesk-entry-${entryId}`;

/**
 * Dispatches approved entries of a company to CentralGest. Skips entries
 * already dispatched (any channel outcome except 'erro') and entries already
 * delivered via CSV export: one delivery route per entry. Errors are recorded
 * per entry and never abort the batch.
 */
export async function dispatchApprovedEntries(
  db: Db,
  client: CentralGestClient,
  companyId: number,
  userId: number | null,
  onlyEntryId?: number
): Promise<DispatchOutcome[]> {
  const company = db
    .prepare("SELECT id, name, centralgest_code FROM companies WHERE id = ?")
    .get(companyId) as any;
  if (!company) throw new CentralGestError("Empresa inexistente.");
  if (!company.centralgest_code) {
    throw new CentralGestError(
      `A empresa "${company.name}" nao tem codigo CentralGest configurado. Defina-o na vista Empresas antes de lancar.`
    );
  }

  let sql = `SELECT e.* FROM entries e
     WHERE e.company_id = ? AND e.status = 'aprovado'
       AND e.id NOT IN (SELECT entry_id FROM export_batch_entries)
       AND e.id NOT IN (SELECT entry_id FROM dispatches WHERE status != 'erro')`;
  const params: any[] = [companyId];
  if (onlyEntryId) {
    sql += " AND e.id = ?";
    params.push(onlyEntryId);
  }
  sql += " ORDER BY e.entry_date, e.id";
  const rows = db.prepare(sql).all(...params) as any[];

  if (onlyEntryId && rows.length === 0) {
    const existing = db
      .prepare("SELECT status FROM dispatches WHERE entry_id = ? AND status != 'erro'")
      .get(onlyEntryId) as any;
    if (existing) return [{ entryId: onlyEntryId, status: "ja_despachado" }];
  }

  const outcomes: DispatchOutcome[] = [];
  const upsertDispatch = db.prepare(
    `INSERT INTO dispatches (entry_id, company_id, channel, external_id, remote_id, remote_number, status, error_detail)
     VALUES (?, ?, 'centralgest', ?, ?, ?, ?, ?)
     ON CONFLICT (entry_id, channel) DO UPDATE SET
       remote_id = excluded.remote_id, remote_number = excluded.remote_number,
       status = excluded.status, error_detail = excluded.error_detail, created_at = datetime('now')`
  );

  for (const row of rows) {
    const lines = (JSON.parse(row.lines_json) as EntryLine[]).map((l) => ({
      conta: l.account,
      descricao: l.description || row.description,
      debito: l.debit,
      credito: l.credit,
    }));
    try {
      const result = await client.createAccountingDocument({
        companyCode: company.centralgest_code,
        externalId: externalIdFor(row.id),
        journal: row.journal,
        docDate: row.entry_date,
        description: row.description,
        lines,
      });
      const apply = db.transaction(() => {
        upsertDispatch.run(row.id, companyId, externalIdFor(row.id), result.remoteId, result.remoteNumber, result.status, null);
        db.prepare("UPDATE entries SET status = 'exportado' WHERE id = ?").run(row.id);
        db.prepare("UPDATE documents SET status = 'exportado' WHERE id = ? AND status = 'validado'").run(row.document_id);
        audit(db, userId, "dispatch", "entry", row.id, `centralgest ${result.status} ${result.remoteNumber ?? ""}`.trim());
      });
      apply();
      outcomes.push({ entryId: row.id, status: result.status, remoteNumber: result.remoteNumber });
    } catch (e: any) {
      const message = e instanceof CentralGestError ? e.message : `Erro de rede: ${e.message}`;
      upsertDispatch.run(row.id, companyId, externalIdFor(row.id), null, null, "erro", message);
      audit(db, userId, "dispatch_error", "entry", row.id, message);
      outcomes.push({ entryId: row.id, status: "erro", error: message });
    }
  }
  return outcomes;
}
