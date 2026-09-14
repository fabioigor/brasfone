import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { IntakeDialog, DOC_TYPE_OPTIONS } from "../src/channels/dialog.js";
import { parseWhatsAppPayload } from "../src/channels/whatsapp.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste";
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));
const WA = { verifyToken: "v", appSecret: "app-secret", accessToken: "token", phoneNumberId: "PHONE123", reply: true, ask: true };
const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", WA.appSecret).update(body).digest("hex");

describe("dialogo de recepcao: interpretacao das respostas", () => {
  const db = openDb(":memory:"); seedDemo(db);
  const dlg = new IntakeDialog(db);
  it("percebe numeros, palavras-chave e 'ok'", () => {
    expect(dlg.parseType("1", null)).toBe("factura_compra");
    expect(dlg.parseType("2.", null)).toBe("despesa");
    expect(dlg.parseType("nota de crédito", null)).toBe("nota_credito");
    expect(dlg.parseType("é uma factura de venda", null)).toBe("factura_venda");
    expect(dlg.parseType("ok", "recibo")).toBe("recibo");
    expect(dlg.parseType("ok", null)).toBeUndefined();
    expect(dlg.parseType("99", null)).toBeUndefined();
    expect(dlg.parseType("olá", null)).toBeUndefined();
    const ccs = dlg.costCenters(1);
    expect(ccs.map((c) => c.code)).toEqual(["ADMIN", "FABRICO", "LOJA"]);
    expect(dlg.parseCostCenter("3", ccs, null)).toBe(ccs[2]!.id);
    expect(dlg.parseCostCenter("0", ccs, null)).toBeNull();
    expect(dlg.parseCostCenter("loja", ccs, null)).toBe(ccs[2]!.id);
    expect(dlg.parseCostCenter("administração", ccs, null)).toBe(ccs[0]!.id);
    expect(dlg.parseCostCenter("nenhum", ccs, null)).toBeNull();
    expect(dlg.parseCostCenter("ok", ccs, ccs[1]!.id)).toBe(ccs[1]!.id);
    expect(dlg.parseCostCenter("7", ccs, null)).toBeUndefined();
  });
  it("le respostas interactivas e botoes da Meta como texto", () => {
    const msgs = parseWhatsAppPayload({ entry: [{ changes: [{ value: { messages: [
      { id: "w1", from: "351911111111", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "2", title: "Despesa" } } },
      { id: "w2", from: "351911111111", type: "button", button: { text: "Sim" } },
    ] } }] }] });
    expect(msgs.map((m) => m.text)).toEqual(["Despesa", "Sim"]);
  });
});

describe("WhatsApp: perguntas de tipo e centro de custo apos receber um documento", () => {
  let db: Db; let app: ReturnType<typeof createServer>; let staff: string;
  const sent: { to: string; text: string }[] = [];
  const fakeFetch: typeof fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/MEDIA-IMG-1")) return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/media/1", mime_type: "image/png" }), { status: 200 });
    if (url.includes("lookaside")) return new Response(fixture("factura-scan.png"), { status: 200, headers: { "content-type": "image/png" } });
    if (url.endsWith("/PHONE123/messages")) { const b = JSON.parse(init.body); sent.push({ to: b.to, text: b.text.body }); return new Response("{}", { status: 200 }); }
    return new Response("nf", { status: 404 });
  };
  const post = (body: any) => request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", sign(JSON.stringify(body))).send(JSON.stringify(body));
  const textMsg = (id: string, text: string) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PHONE123" }, messages: [{ from: "351912345678", id, timestamp: "1", type: "text", text: { body: text } }] } }] }] });
  const wait = async (n: number) => { for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 100)); };

  beforeAll(async () => {
    db = openDb(":memory:"); seedDemo(db);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contai-dialog-"));
    app = createServer({ db, provider: new HeuristicProvider(), storageRoot: tmp, structured: null, whatsapp: WA, whatsappFetch: fakeFetch });
    staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    await request(app).post("/api/companies/1/contacts").set("Authorization", `Bearer ${staff}`).send({ channel: "whatsapp", address: "+351 912 345 678", label: "Joao" });
  });

  it("documento recebido -> pergunta o tipo; resposta -> pergunta o centro; resposta -> confirma e aplica", async () => {
    const res = await post(JSON.parse(fixture("whatsapp-webhook.json").toString()));
    expect(res.status).toBe(200);
    await wait(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/Recebemos o seu documento\. Que tipo de documento é\?/);
    expect(sent[0]!.text).toMatch(/1\. Factura de compra/);
    expect(sent[0]!.text).toMatch(/\(detectado\)/);
    expect(sent[0]!.text.split("\n").length).toBeGreaterThanOrEqual(DOC_TYPE_OPTIONS.length + 1);
    const dialog = db.prepare("SELECT * FROM channel_dialogs WHERE sender = '351912345678'").get() as any;
    expect(dialog.step).toBe("tipo"); expect(dialog.company_id).toBe(1);
    const docId = JSON.parse(dialog.document_ids)[0];

    // resposta nao percebida -> repete a pergunta uma vez
    await post(textMsg("wamid.R0", "???")); await wait(2);
    expect(sent[1]!.text).toMatch(/^Não percebi\./);

    await post(textMsg("wamid.R1", "2")); await wait(3);
    expect(sent[2]!.text).toMatch(/^Registado como Despesa\. A que centro de custo pertence\?/);
    expect(sent[2]!.text).toMatch(/1\. Administracao/); expect(sent[2]!.text).toMatch(/0\. Sem centro de custo/);
    const doc = db.prepare("SELECT doc_type, client_doc_type, classification_source FROM documents WHERE id = ?").get(docId) as any;
    expect(doc).toMatchObject({ doc_type: "despesa", client_doc_type: "despesa", classification_source: "cliente" });

    await post(textMsg("wamid.R2", "Loja")); await wait(4);
    expect(sent[3]!.text).toMatch(/Obrigado\. Registado como Despesa, centro de custo Loja\./);
    const loja = (db.prepare("SELECT id FROM cost_centers WHERE company_id = 1 AND code = 'LOJA'").get() as any).id;
    expect((db.prepare("SELECT cost_center_id FROM documents WHERE id = ?").get(docId) as any).cost_center_id).toBe(loja);
    const entry = db.prepare("SELECT lines_json, status FROM entries WHERE document_id = ?").get(docId) as any;
    if (entry) expect(JSON.parse(entry.lines_json).find((l: any) => /^(3|6)/.test(l.account))?.costCenter).toBe("LOJA");
    expect((db.prepare("SELECT step FROM channel_dialogs WHERE sender = '351912345678'").get() as any).step).toBe("concluido");
    // as respostas ficam registadas como mensagens recebidas, sem passar por 'sem_anexos'
    const inbound = db.prepare("SELECT status, subject FROM inbound_messages WHERE external_id IN ('wamid.R1','wamid.R2')").all() as any[];
    expect(inbound.map((i) => i.status)).toEqual(["processado", "processado"]);
    expect(inbound[0]!.subject).toMatch(/resposta/);

    // sem dialogo aberto, um texto solto volta a ter a resposta habitual
    await post(textMsg("wamid.R3", "obrigado")); await wait(5);
    expect(sent[4]!.text).toMatch(/não encontrámos nenhum documento/);
  });

  it("desiste apos duas respostas nao percebidas e mantem a classificacao automatica", () => {
    const dlg = new IntakeDialog(db, { maxAttempts: 2 });
    const docId = Number(db.prepare("INSERT INTO documents (company_id, uploader_id, original_name, stored_path, mime_type, size_bytes, sha256, doc_type) VALUES (1, 1, 'x.pdf', 'x', 'application/pdf', 1, 'hx', 'factura_compra')").run().lastInsertRowid);
    expect(dlg.start({ channel: "whatsapp", sender: "351900000000", companyId: 1, documentIds: [docId], detectedType: "factura_compra" })).toMatch(/Que tipo/);
    expect(dlg.answer("whatsapp", "351900000000", "hmm").reply).toMatch(/Não percebi/);
    expect(dlg.answer("whatsapp", "351900000000", "hmm").reply).toMatch(/Não percebi/);
    const last = dlg.answer("whatsapp", "351900000000", "hmm");
    expect(last.finished).toBe(true); expect(last.reply).toMatch(/Mantemos Factura de compra/);
    expect(dlg.answer("whatsapp", "351900000000", "1").handled).toBe(false);
    // sem centros de custo, o dialogo termina logo apos o tipo
    const doc2 = Number(db.prepare("INSERT INTO documents (company_id, uploader_id, original_name, stored_path, mime_type, size_bytes, sha256, doc_type) VALUES (2, 1, 'y.pdf', 'y', 'application/pdf', 1, 'hy', 'recibo')").run().lastInsertRowid);
    db.prepare("UPDATE cost_centers SET active = 0 WHERE company_id = 2").run();
    dlg.start({ channel: "whatsapp", sender: "351900000001", companyId: 2, documentIds: [doc2], detectedType: "recibo" });
    const done = dlg.answer("whatsapp", "351900000001", "ok");
    expect(done.finished).toBe(true); expect(done.reply).toMatch(/Registado como Recibo\./);
  });
});
