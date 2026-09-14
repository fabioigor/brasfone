import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import request from "supertest";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { ingestDocument } from "../src/pipeline.js";
import { DocumentOcr } from "../src/ocr/engine.js";
import { Microsoft365Client, OneDriveSync, drivePathFor, safeName, microsoft365ConfigFromEnv, MAX_ATTEMPTS } from "../src/integrations/microsoft365.js";

/** Fake Graph: token endpoint, drive info, simple upload, upload session with chunks; records calls. */
function fakeGraph(opts: { failUploads?: boolean } = {}) {
  const calls: { method: string; url: string; size?: number; headers?: any }[] = [];
  const files: Record<string, number> = {};
  const fetchImpl: typeof fetch = async (input: any, init: any = {}) => {
    const url = String(input); const method = init.method || "GET";
    const body = init.body; const size = body ? (typeof body === "string" ? Buffer.byteLength(body) : body.length ?? body.byteLength) : undefined;
    calls.push({ method, url, size, headers: init.headers });
    if (url.includes("/oauth2/v2.0/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    if (!String(init.headers?.authorization || "").includes("tok") && !url.includes("upload-session")) return new Response(JSON.stringify({ error: { message: "no token" } }), { status: 401 });
    if (url.endsWith("/drive?$select=id,name,webUrl,owner,quota")) return new Response(JSON.stringify({ name: "OneDrive", webUrl: "https://lumarcont-my.sharepoint.com/x", owner: { user: { displayName: "Documentos Lumarcont" } }, quota: { used: 5 * 1024 ** 3, total: 1024 ** 4 } }), { status: 200 });
    if (opts.failUploads && url.includes(":/content")) return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 507 });
    const m = url.match(/\/root:\/(.+?):\/(content|createUploadSession)/);
    if (m && m[2] === "content") { const p = decodeURIComponent(m[1]!); files[p] = size!; return new Response(JSON.stringify({ id: "item-" + Object.keys(files).length, webUrl: "https://onedrive.example/" + p, size }), { status: 201 }); }
    if (m && m[2] === "createUploadSession") return new Response(JSON.stringify({ uploadUrl: "https://upload.example/upload-session/" + encodeURIComponent(decodeURIComponent(m[1]!)) }), { status: 200 });
    if (url.includes("upload-session")) {
      const range = String(init.headers["content-range"]); const [, , end, total] = range.match(/bytes (\d+)-(\d+)\/(\d+)/)!.map(Number) as any;
      const p = decodeURIComponent(url.split("upload-session/")[1]!); files[p] = (files[p] || 0) + size!;
      return end + 1 === total ? new Response(JSON.stringify({ id: "big-item", webUrl: "https://onedrive.example/" + p, size: total }), { status: 201 }) : new Response(JSON.stringify({ nextExpectedRanges: [`${end + 1}-`] }), { status: 202 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, files };
}
const cfg = { tenantId: "tenant", clientId: "client", clientSecret: "secret", driveUser: "documentos@lumarcont.pt" };

describe("Microsoft 365 / OneDrive", () => {
  it("le a configuracao do ambiente e monta caminhos seguros por empresa, ano, mes e tipo", () => {
    expect(microsoft365ConfigFromEnv({})).toBeNull();
    expect(microsoft365ConfigFromEnv({ MS365_TENANT_ID: "t", MS365_CLIENT_ID: "c", MS365_CLIENT_SECRET: "s" })).toBeNull();
    const c = microsoft365ConfigFromEnv({ MS365_TENANT_ID: "t", MS365_CLIENT_ID: "c", MS365_CLIENT_SECRET: "s", MS365_DRIVE_USER: "d@x.pt" })!;
    expect(c.rootFolder).toBe("Cont.ai");
    expect(safeName('Fact: "A/B" <2026>?')).toBe("Fact- -A-B- -2026--");
    const p = drivePathFor("Cont.ai", { id: 42, original_name: "factura FT/2026.pdf", doc_type: "factura_compra", doc_date: "2026-07-15", created_at: "2026-09-01 10:00:00", company_name: "Padaria Central Lda", nif: "506284417" });
    expect(p).toBe("Cont.ai/Padaria Central Lda (506284417)/2026/07/Facturas de compra/42-factura FT-2026.pdf");
    const q = drivePathFor("Arquivo", { id: 7, original_name: "x.png", doc_type: "por_classificar", doc_date: null, created_at: "2026-09-14 08:00:00", company_name: "Tecno", nif: "509442013" });
    expect(q).toBe("Arquivo/Tecno (509442013)/2026/09/Por classificar/7-x.png");
  });

  it("autentica uma vez, testa a drive e envia ficheiros pequenos e grandes", async () => {
    const g = fakeGraph();
    const client = new Microsoft365Client(cfg, g.fetchImpl);
    const info = await client.driveInfo();
    expect(info.owner).toBe("Documentos Lumarcont"); expect(info.totalGb).toBe(1024);
    const small = await client.upload("Cont.ai/A/2026/09/Recibos/1-r.txt", Buffer.from("ola"), "text/plain");
    expect(small.webUrl).toContain("1-r.txt");
    const big = await client.upload("Cont.ai/A/2026/09/Recibos/2-grande.pdf", Buffer.alloc(9 * 1024 * 1024, 1), "application/pdf");
    expect(big.id).toBe("big-item");
    expect(g.files["Cont.ai/A/2026/09/Recibos/2-grande.pdf"]).toBe(9 * 1024 * 1024);
    expect(g.calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length).toBe(1);
    expect(g.calls.filter((c) => c.url.includes("upload-session")).length).toBe(2); // 5 MiB + 4 MiB
  });

  it("sincroniza documentos recebidos, e idempotente e regista erros com tentativas limitadas", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contai-od-"));
    const ocr = new DocumentOcr({});
    const ingest = (name: string, text: string) => ingestDocument(db, new HeuristicProvider(), tmp, { companyId: 1, uploaderId: 1, originalName: name, mimeType: "text/plain", buffer: Buffer.from(text) } as any, ocr, null);
    await ingest("factura-a.txt", fs.readFileSync("fixtures/factura-fornecedor.txt", "utf8"));
    await ingest("recibo-b.txt", fs.readFileSync("fixtures/recibo.txt", "utf8"));

    const g = fakeGraph();
    const sync = new OneDriveSync(db, tmp, new Microsoft365Client(cfg, g.fetchImpl), "Cont.ai", () => {});
    expect(sync.counts()).toEqual({ synced: 0, pending: 2, failed: 0 });
    const out = await sync.syncPending();
    expect(out.map((o) => o.status)).toEqual(["sincronizado", "sincronizado"]);
    expect(sync.counts()).toEqual({ synced: 2, pending: 0, failed: 0 });
    const rows = db.prepare("SELECT onedrive_path, onedrive_url FROM documents ORDER BY id").all() as any[];
    expect(rows[0].onedrive_path).toMatch(/^Cont\.ai\/Padaria Central Lda \(506284417\)\/\d{4}\/\d{2}\/Facturas de compra\/1-factura-a\.txt$/);
    expect(rows[1].onedrive_path).toContain("/Recibos/2-recibo-b.txt");
    expect((await sync.syncPending()).length).toBe(0); // nada por enviar
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'onedrive_upload'").get() as any).n).toBe(2);

    // erros: tentativas limitadas e repetir
    await ingest("terceiro.txt", "Factura FT 1/1\nTotal: 10,00");
    const bad = new OneDriveSync(db, tmp, new Microsoft365Client(cfg, fakeGraph({ failUploads: true }).fetchImpl), "Cont.ai", () => {});
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await bad.syncPending();
    expect(bad.counts()).toEqual({ synced: 2, pending: 0, failed: 1 });
    expect((db.prepare("SELECT onedrive_error, onedrive_attempts FROM documents WHERE id = 3").get() as any)).toMatchObject({ onedrive_attempts: MAX_ATTEMPTS });
    expect(bad.retryFailed()).toBe(1);
    expect((await sync.syncPending()).map((o) => o.status)).toEqual(["sincronizado"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("API: estado, sincronizacao manual, teste de credenciais e ligacao no documento", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contai-od-api-"));
    const g = fakeGraph();
    const sync = new OneDriveSync(db, tmp, new Microsoft365Client(cfg, g.fetchImpl), "Cont.ai", () => {});
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmp, structured: null, onedrive: sync, whatsappFetch: g.fetchImpl });
    const staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    const A = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);
    const up = await A(request(app).post("/api/documents")).attach("file", "fixtures/factura-venda.txt").field("company_id", "1");
    expect(up.status).toBe(201);
    await new Promise((r) => setTimeout(r, 900)); // sincronizacao em segundo plano apos o upload
    const st = await A(request(app).get("/api/onedrive/status"));
    expect(st.body.configured).toBe(true); expect(st.body.synced).toBe(1);
    const docs = await A(request(app).get("/api/documents"));
    expect(docs.body.documents[0].onedrive_url).toContain("onedrive.example");
    const manual = await A(request(app).post("/api/onedrive/sync")).send({});
    expect(manual.body.outcomes).toEqual([]);
    const test = await A(request(app).post("/api/settings/test/microsoft365")).send({ values: { MS365_TENANT_ID: "t", MS365_CLIENT_ID: "c", MS365_CLIENT_SECRET: "s", MS365_DRIVE_USER: "documentos@lumarcont.pt" } });
    expect(test.body.ok).toBe(true); expect(test.body.detail).toContain("Documentos Lumarcont");
    expect((await A(request(app).post("/api/settings/test/microsoft365")).send({ values: { MS365_TENANT_ID: "t" } })).status).toBe(400);
    const none = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmp, structured: null });
    const staff2 = (await request(none).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    expect((await request(none).get("/api/onedrive/status").set("Authorization", `Bearer ${staff2}`)).body.configured).toBe(false);
    expect((await request(none).post("/api/onedrive/sync").set("Authorization", `Bearer ${staff2}`).send({})).status).toBe(409);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("email com autenticacao Microsoft 365 (Graph)", () => {
  it("le mensagens por ler com anexos, processa-as e marca-as como lidas", async () => {
    const { graphMailConfigFromEnv, GraphMailPoller } = await import("../src/channels/graphMail.js");
    expect(graphMailConfigFromEnv({})).toBeNull();
    const c = graphMailConfigFromEnv({ MS365_MAIL_USER: "documentos@lumarcont.pt" })!;
    expect(c.folder).toBe("inbox"); expect(c.intervalMs).toBe(120000);

    const db = openDb(":memory:"); seedDemo(db);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contai-gm-"));
    const patched: string[] = [];
    const fetchImpl: typeof fetch = async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes("/oauth2/v2.0/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      if (url.includes("/mailFolders/inbox?")) return new Response(JSON.stringify({ displayName: "Inbox", totalItemCount: 12, unreadItemCount: 1 }), { status: 200 });
      if (url.includes("/mailFolders/inbox/messages?")) return new Response(JSON.stringify({ value: [{ id: "M1", subject: "Factura", internetMessageId: "<m1@padaria.pt>", from: { emailAddress: { address: "Padaria@Demo.PT" } }, toRecipients: [{ emailAddress: { address: "documentos@lumarcont.pt" } }], bodyPreview: "segue" }] }), { status: 200 });
      if (url.includes("/messages/M1/attachments")) return new Response(JSON.stringify({ value: [
        { "@odata.type": "#microsoft.graph.fileAttachment", name: "factura.txt", contentType: "text/plain", isInline: false, contentBytes: fs.readFileSync("fixtures/factura-fornecedor.txt").toString("base64") },
        { "@odata.type": "#microsoft.graph.fileAttachment", name: "logo.png", contentType: "image/png", isInline: true, contentBytes: "AA==" },
      ] }), { status: 200 });
      if (url.endsWith("/messages/M1") && init.method === "PATCH") { patched.push(init.body); return new Response("{}", { status: 200 }); }
      return new Response(JSON.stringify({ error: { message: "nao esperado " + url } }), { status: 404 });
    };
    const client = new Microsoft365Client(cfg, fetchImpl);
    const poller = new GraphMailPoller(db, { provider: new HeuristicProvider(), ocr: new DocumentOcr({}), structured: null, storageRoot: tmp, systemUserId: 1 }, client, c, () => {});
    expect(await poller.folderInfo()).toEqual({ displayName: "Inbox", total: 12, unread: 1 });
    // remetente registado na empresa 1
    db.prepare("INSERT INTO company_contacts (company_id, channel, address, label) VALUES (1, 'email', 'padaria@demo.pt', 'Padaria')").run();
    const out = await poller.pollOnce();
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("processado"); expect(out[0]!.companyId).toBe(1);
    expect(out[0]!.outcomes).toHaveLength(1); // o anexo inline foi ignorado
    expect(patched).toHaveLength(1); expect(JSON.parse(patched[0]!).isRead).toBe(true);
    const doc = db.prepare("SELECT channel, doc_type FROM documents").get() as any;
    expect(doc.channel).toBe("email"); expect(doc.doc_type).toBe("factura_compra");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
