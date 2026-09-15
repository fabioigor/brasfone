import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import request from "supertest";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { ingestDocument } from "../src/pipeline.js";
import { DocumentOcr } from "../src/ocr/engine.js";
import { Microsoft365Client, OneDriveSync, drivePathFor, costCenterFolderFor, Microsoft365Files } from "../src/integrations/microsoft365.js";

/** Fake Graph with a tiny in-memory drive: folders by path, files by id, uploads, downloads, deletes, sendMail. */
function fakeDrive() {
  const folders = new Map<string, { id: string }>();      // path -> folder
  const items = new Map<string, { name: string; parent: string; bytes: Buffer; mime: string }>(); // id -> file
  const uploads: string[] = []; const deleted: string[] = []; const mails: any[] = [];
  let seq = 0; const nid = (p: string) => `${p}-${++seq}`;
  const dec = (s: string) => s.split("/").map(decodeURIComponent).join("/");
  const fetchImpl: typeof fetch = async (input: any, init: any = {}) => {
    const url = String(input); const method = init.method || "GET";
    if (url.includes("/oauth2/v2.0/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    let m: RegExpMatchArray | null;
    if ((m = url.match(/\/sendMail$/)) && method === "POST") { mails.push(JSON.parse(init.body)); return new Response(null, { status: 202 }); }
    if ((m = url.match(/\/drive\/root:\/(.+?):\/children\?/)) && method === "GET") {
      const p = dec(m[1]!); if (!folders.has(p)) return new Response("{}", { status: 404 });
      const value = [...items.entries()].filter(([, f]) => f.parent === p).map(([id, f]) => ({ id, name: f.name, size: f.bytes.length, file: { mimeType: f.mime }, webUrl: "https://od.example/" + id }));
      for (const [fp, f] of folders) if (fp.startsWith(p + "/") && !fp.slice(p.length + 1).includes("/")) value.push({ id: f.id, name: fp.slice(p.length + 1), size: 0, folder: { childCount: 0 }, webUrl: "https://od.example/" + f.id } as any);
      return new Response(JSON.stringify({ value }), { status: 200 });
    }
    if ((m = url.match(/\/drive\/root:\/(.+?):\/content\?/)) && method === "PUT") { const p = dec(m[1]!); uploads.push(p); return new Response(JSON.stringify({ id: nid("up"), webUrl: "https://od.example/" + p, size: init.body.length }), { status: 201 }); }
    if ((m = url.match(/\/drive\/root:\/(.+?):\/children$/)) && method === "POST") {
      const parent = dec(m[1]!); if (!folders.has(parent)) return new Response(JSON.stringify({ error: { message: "parent missing" } }), { status: 404 });
      const name = JSON.parse(init.body).name; const p = parent + "/" + name; if (folders.has(p)) return new Response(JSON.stringify({ error: { message: "exists" } }), { status: 409 });
      const f = { id: nid("f") }; folders.set(p, f); return new Response(JSON.stringify({ id: f.id, webUrl: "https://od.example/" + f.id, folder: {} }), { status: 201 });
    }
    if (url.match(/\/drive\/root\/children$/) && method === "POST") { const name = JSON.parse(init.body).name; if (folders.has(name)) return new Response("{}", { status: 409 }); const f = { id: nid("f") }; folders.set(name, f); return new Response(JSON.stringify({ id: f.id, webUrl: "https://od.example/" + f.id, folder: {} }), { status: 201 }); }
    if ((m = url.match(/\/drive\/items\/(.+?)\/children$/)) && method === "POST") {
      const parentPath = [...folders.entries()].find(([, f]) => f.id === decodeURIComponent(m![1]!))?.[0]; if (!parentPath) return new Response("{}", { status: 404 });
      const name = JSON.parse(init.body).name; const p = parentPath + "/" + name; if (folders.has(p)) return new Response("{}", { status: 409 });
      const f = { id: nid("f") }; folders.set(p, f); return new Response(JSON.stringify({ id: f.id, webUrl: "https://od.example/" + f.id, folder: {} }), { status: 201 });
    }
    if ((m = url.match(/\/drive\/root:\/(.+?)\?\$select=id,webUrl,folder$/)) && method === "GET") {
      const p = dec(m[1]!); const f = folders.get(p); if (!f) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ id: f.id, webUrl: "https://od.example/" + f.id, folder: {} }), { status: 200 });
    }
    if ((m = url.match(/\/drive\/items\/(.+?)\/content$/)) && method === "GET") { const f = items.get(decodeURIComponent(m[1]!)); if (!f) return new Response("{}", { status: 404 }); return new Response(f.bytes, { status: 200, headers: { "content-type": f.mime } }); }
    if ((m = url.match(/\/drive\/items\/(.+?)$/)) && method === "DELETE") { const id = decodeURIComponent(m[1]!); deleted.push(id); items.delete(id); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ error: { message: "nf " + method + " " + url } }), { status: 404 });
  };
  const drop = (folder: string, name: string, bytes: Buffer, mime = "text/plain") => { const id = nid("file"); items.set(id, { name, parent: folder, bytes, mime }); return id; };
  return { fetchImpl, folders, items, uploads, deleted, mails, drop };
}
const cfg = { tenantId: "t", clientId: "c", clientSecret: "s", driveUser: "documentos@lumarcont.pt" };

describe("OneDrive: pastas por centro de custo e recepcao pela pasta 'A receber'", () => {
  it("monta o caminho do arquivo dentro da pasta do centro de custo", () => {
    expect(costCenterFolderFor("Cont.ai", "Padaria Central Lda", "506284417", { code: "LOJA", name: "Loja" })).toBe("Cont.ai/Padaria Central Lda (506284417)/Centros de custo/LOJA - Loja");
    const p = drivePathFor("Cont.ai", { id: 9, original_name: "f.pdf", doc_type: "factura_compra", doc_date: "2026-08-02", created_at: "2026-09-01", company_name: "Padaria Central Lda", nif: "506284417", cost_center_code: "LOJA", cost_center_name: "Loja" });
    expect(p).toBe("Cont.ai/Padaria Central Lda (506284417)/Centros de custo/LOJA - Loja/2026/08/Facturas de compra/9-f.pdf");
  });

  it("ensureFolder cria a cadeia de pastas uma so vez", async () => {
    const g = fakeDrive(); const files = new Microsoft365Files(new Microsoft365Client(cfg, g.fetchImpl));
    const a = await files.ensureFolder("Cont.ai/Empresa (1)/Centros de custo/X - Xis");
    expect(g.folders.size).toBe(4); expect(a.id).toBe(g.folders.get("Cont.ai/Empresa (1)/Centros de custo/X - Xis")!.id);
    const b = await files.ensureFolder("Cont.ai/Empresa (1)/Centros de custo/X - Xis/A receber");
    expect(g.folders.size).toBe(5); expect(b.id).not.toBe(a.id);
    expect((await files.ensureFolder("Cont.ai/Empresa (1)/Centros de custo/X - Xis")).id).toBe(a.id);
    expect(await files.children("Cont.ai/nao-existe")).toEqual([]);
    await files.sendMail("documentos@lumarcont.pt", { to: ["a@b.pt"], subject: "Olá", html: "<p>x</p>" });
    expect(g.mails[0].message.toRecipients[0].emailAddress.address).toBe("a@b.pt");
  });

  it("criar um centro de custo cria a pasta; ficheiros em 'A receber' entram com o centro e vao para o arquivo", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contai-odcc-"));
    const g = fakeDrive();
    const sync = new OneDriveSync(db, tmp, new Microsoft365Client(cfg, g.fetchImpl), "Cont.ai", () => {});
    const ocr = new DocumentOcr({});
    sync.setIntake({ systemUserId: 1, ingest: (i) => ingestDocument(db, new HeuristicProvider(), tmp, { ...i, channel: "portal" }, ocr, null) });
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmp, structured: null, onedrive: sync, whatsappFetch: g.fetchImpl });
    const staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    const A = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);

    const created = await A(request(app).post("/api/companies/1/cost-centers")).send({ code: "OBRAS", name: "Obras" });
    expect(created.status).toBe(201);
    expect(created.body.onedrive).toMatch(/Pasta criada no OneDrive: Cont\.ai\/Padaria Central Lda \(506284417\)\/Centros de custo\/OBRAS - Obras/);
    expect(created.body.cost_center.onedrive_path).toBe("Cont.ai/Padaria Central Lda (506284417)/Centros de custo/OBRAS - Obras");
    expect(g.folders.has("Cont.ai/Padaria Central Lda (506284417)/Centros de custo/OBRAS - Obras/A receber")).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'onedrive_folder'").get() as any).n).toBe(1);

    // centros semeados sem pasta: o ciclo cria-as todas
    expect(await sync.ensureAllCostCenterFolders()).toBe(5);
    expect(sync.counts().costCentersWithoutFolder).toBe(0);

    // ficheiro colocado em "A receber" do centro OBRAS
    const intake = "Cont.ai/Padaria Central Lda (506284417)/Centros de custo/OBRAS - Obras/A receber";
    const fileId = g.drop(intake, "factura-obras.txt", fs.readFileSync("fixtures/factura-fornecedor.txt"));
    g.drop(intake, "notas.docx", Buffer.from("x"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const r = await sync.pollIntake();
    expect(r).toEqual({ processed: 1, errors: 0, skipped: 1 });
    const doc = db.prepare("SELECT d.id, d.cost_center_id, d.onedrive_path, d.original_name, cc.code FROM documents d JOIN cost_centers cc ON cc.id = d.cost_center_id ORDER BY d.id DESC").get() as any;
    expect(doc.code).toBe("OBRAS"); expect(doc.original_name).toBe("factura-obras.txt");
    expect(doc.onedrive_path).toMatch(/^Cont\.ai\/Padaria Central Lda \(506284417\)\/Centros de custo\/OBRAS - Obras\/\d{4}\/\d{2}\/Facturas de compra\/\d+-factura-obras\.txt$/);
    expect(g.deleted).toEqual([fileId]);
    const lines = JSON.parse((db.prepare("SELECT lines_json FROM entries WHERE document_id = ?").get(doc.id) as any).lines_json);
    expect(lines.find((l: any) => /^6/.test(l.account)).costCenter).toBe("OBRAS");
    // segundo ciclo: nada de novo; o .docx fica ignorado
    expect(await sync.pollIntake()).toEqual({ processed: 0, errors: 0, skipped: 1 });
    const st = await A(request(app).get("/api/onedrive/status"));
    expect(st.body).toMatchObject({ configured: true, intakeEnabled: true, intakeProcessed: 1, costCenterFolders: 6 });
    const manual = await A(request(app).post("/api/onedrive/sync")).send({});
    expect(manual.body.intake).toEqual({ processed: 0, errors: 0, skipped: 1 });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
