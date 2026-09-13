import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import {
  CentralGestClient,
  dispatchApprovedEntries,
  externalIdFor,
} from "../src/integrations/centralgest.js";
import { startCentralGestMock, MockState } from "../src/integrations/centralgest-mock.js";

let db: Db;
let client: CentralGestClient;
let server: http.Server;
let state: MockState;

function insertApprovedEntry(companyId: number, description: string): number {
  const doc = db
    .prepare(
      `INSERT INTO documents (company_id, uploader_id, original_name, stored_path, mime_type, size_bytes, sha256, doc_type, status)
       VALUES (?, 1, 'f.txt', 'x/f.txt', 'text/plain', 10, ?, 'factura_compra', 'validado')`
    )
    .run(companyId, "sha-" + Math.random());
  const lines = [
    { account: "62", description: "FSE", debit: 100, credit: 0 },
    { account: "2432", description: "IVA", debit: 23, credit: 0 },
    { account: "221", description: "Fornecedor", debit: 0, credit: 123 },
  ];
  const e = db
    .prepare(
      `INSERT INTO entries (document_id, company_id, entry_date, journal, description, lines_json, confidence, status)
       VALUES (?, ?, '2026-08-01', 'Compras', ?, ?, 0.9, 'aprovado')`
    )
    .run(Number(doc.lastInsertRowid), companyId, description, JSON.stringify(lines));
  return Number(e.lastInsertRowid);
}

beforeAll(async () => {
  db = openDb(":memory:");
  seedDemo(db);
  const mock = await startCentralGestMock("chave-teste");
  server = mock.server;
  state = mock.state;
  client = new CentralGestClient({ baseUrl: mock.baseUrl, apiKey: "chave-teste" });
});

afterAll(() => {
  server.close();
});

describe("cliente CentralGest", () => {
  it("autentica e lista empresas", async () => {
    const companies = await client.listCompanies();
    expect(companies.map((c) => c.codigo)).toContain("PADARIA");
  });

  it("apiKey errada falha autenticacao", async () => {
    const bad = new CentralGestClient({ baseUrl: (server.address() as any) && `http://localhost:${(server.address() as any).port}`, apiKey: "errada" });
    await expect(bad.listCompanies()).rejects.toThrow(/Autenticacao/);
  });
});

describe("despacho para CentralGest", () => {
  it("exige codigo CentralGest configurado na empresa", async () => {
    insertApprovedEntry(1, "Sem codigo");
    await expect(dispatchApprovedEntries(db, client, 1, null)).rejects.toThrow(/codigo CentralGest/);
  });

  it("lanca lancamentos aprovados e regista despacho", async () => {
    db.prepare("UPDATE companies SET centralgest_code = 'PADARIA' WHERE id = 1").run();
    const outcomes = await dispatchApprovedEntries(db, client, 1, null);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((o) => o.status === "lancado")).toBe(true);
    const entry = db.prepare("SELECT status FROM entries WHERE id = ?").get(outcomes[0]!.entryId) as any;
    expect(entry.status).toBe("exportado");
    const doc = state.documents.get(externalIdFor(outcomes[0]!.entryId));
    expect(doc).toBeDefined();
    expect(doc!.payload.linhas).toHaveLength(3);
  });

  it("re-despacho nao envia nada (idempotencia local)", async () => {
    const outcomes = await dispatchApprovedEntries(db, client, 1, null);
    expect(outcomes).toHaveLength(0);
  });

  it("409 do CentralGest e tratado como ja_existia (idempotencia remota)", async () => {
    const entryId = insertApprovedEntry(1, "Duplicado remoto");
    // Simula um envio anterior que ficou registado no CentralGest mas nao localmente.
    state.documents.set(externalIdFor(entryId), { id: "CG-X", numero: "COM/99", payload: {} });
    const outcomes = await dispatchApprovedEntries(db, client, 1, null, entryId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("ja_existia");
  });

  it("erro remoto fica registado e permite reenvio posterior", async () => {
    const entryId = insertApprovedEntry(1, "Vai falhar");
    state.failNext = true;
    const first = await dispatchApprovedEntries(db, client, 1, null, entryId);
    expect(first[0]!.status).toBe("erro");
    const entry = db.prepare("SELECT status FROM entries WHERE id = ?").get(entryId) as any;
    expect(entry.status).toBe("aprovado");

    const second = await dispatchApprovedEntries(db, client, 1, null, entryId);
    expect(second[0]!.status).toBe("lancado");
  });

  it("lancamento exportado por CSV nao vai para o CentralGest", async () => {
    const entryId = insertApprovedEntry(1, "Ja saiu em CSV");
    const batch = db
      .prepare("INSERT INTO export_batches (company_id, created_by, entry_count, content) VALUES (1, 1, 1, 'x')")
      .run();
    db.prepare("INSERT INTO export_batch_entries (batch_id, entry_id) VALUES (?, ?)").run(Number(batch.lastInsertRowid), entryId);
    const outcomes = await dispatchApprovedEntries(db, client, 1, null, entryId);
    expect(outcomes).toHaveLength(0);
  });
});
