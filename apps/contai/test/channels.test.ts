import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { DocumentOcr } from "../src/ocr/engine.js";
import { parseRawEmail, parseInboundEmailJson } from "../src/channels/email.js";
import { parseWhatsAppPayload, verifyMetaSignature } from "../src/channels/whatsapp.js";
import { confirmationText, normaliseAddress } from "../src/channels/inbound.js";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name));
const SECRET = "segredo-email";
const WA = { verifyToken: "verifica-me", appSecret: "app-secret", accessToken: "token", phoneNumberId: "PHONE123", reply: true };

let db: Db;
let app: ReturnType<typeof createServer>;
let tmpDir: string;
let staff: string;
const sent: any[] = [];

/** Fake Graph API: media metadata, media bytes (the scanned PNG) and outbound messages. */
const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (url.endsWith("/MEDIA-IMG-1")) return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/media/1", mime_type: "image/png" }), { status: 200 });
  if (url.includes("lookaside")) return new Response(fixture("factura-scan.png"), { status: 200, headers: { "content-type": "image/png" } });
  if (url.endsWith("/PHONE123/messages")) { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
  return new Response("not found", { status: 404 });
};

const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", WA.appSecret).update(body).digest("hex");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contai-channels-"));
  db = openDb(":memory:");
  seedDemo(db);
  app = createServer({
    db, provider: new HeuristicProvider(), storageRoot: tmpDir, ocr: new DocumentOcr({}), structured: null,
    inboundEmailSecret: SECRET, whatsapp: WA, whatsappFetch: fakeFetch,
  });
  staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
const S = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);

describe("parsing", () => {
  it("normaliza enderecos", () => {
    expect(normaliseAddress("email", "Joao <Padaria@Demo.PT>")).toBe("padaria@demo.pt");
    expect(normaliseAddress("whatsapp", "+351 912 345 678")).toBe("351912345678");
  });

  it("le um .eml com anexo", async () => {
    const m = await parseRawEmail(fixture("email-factura.eml"));
    expect(m.sender).toBe("padaria@demo.pt");
    expect(m.externalId).toBe("<fixture-eml-001@demo.pt>");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.filename).toBe("factura-fornecedor.txt");
    expect(m.attachments[0]!.buffer.toString()).toContain("658,05");
  });

  it("valida JSON de webhook de email", () => {
    expect(() => parseInboundEmailJson({ from: "x" })).toThrow();
    const m = parseInboundEmailJson({ from: "a@b.pt", attachments: [{ filename: "f.txt", content_base64: Buffer.from("ola").toString("base64") }] });
    expect(m.attachments[0]!.buffer.toString()).toBe("ola");
  });

  it("le o payload do WhatsApp e valida assinaturas", () => {
    const msgs = parseWhatsAppPayload(JSON.parse(fixture("whatsapp-webhook.json").toString()));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.from).toBe("351912345678");
    expect(msgs[0]!.media[0]!.id).toBe("MEDIA-IMG-1");
    const body = "{}";
    expect(verifyMetaSignature(Buffer.from(body), sign(body), WA.appSecret)).toBe(true);
    expect(verifyMetaSignature(Buffer.from(body), "sha256=" + "0".repeat(64), WA.appSecret)).toBe(false);
    expect(verifyMetaSignature(Buffer.from(body), undefined, WA.appSecret)).toBe(false);
  });
});

describe("email", () => {
  it("segredo errado e recusado", async () => {
    const res = await request(app).post("/api/inbound/email").set("x-contai-secret", "errado").send({ from: "a@b.pt" });
    expect(res.status).toBe(401);
  });

  it("remetente desconhecido fica em 'sem_empresa' sem criar nada", async () => {
    const res = await request(app).post("/api/inbound/email").set("x-contai-secret", SECRET).send({
      message_id: "<desconhecido-1>", from: "alguem@outra.pt", subject: "doc",
      attachments: [{ filename: "f.txt", content_type: "text/plain", content_base64: fixture("factura-venda.txt").toString("base64") }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("sem_empresa");
    expect((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as any).n).toBe(0);
  });

  it("alias docs+<id>@ encaminha para a empresa; .eml cru tambem e aceite", async () => {
    const res = await request(app).post("/api/inbound/email").set("x-contai-secret", SECRET).set("content-type", "message/rfc822").send(fixture("email-factura.eml").toString());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("processado");
    expect(res.body.companyId).toBe(1);
    expect(res.body.documents[0].docType).toBe("factura_compra");
    const doc = db.prepare("SELECT channel FROM documents WHERE id = ?").get(res.body.documents[0].id) as any;
    expect(doc.channel).toBe("email");
  });

  it("o mesmo Message-ID nao e processado duas vezes", async () => {
    const res = await request(app).post("/api/inbound/email").set("x-contai-secret", SECRET).set("content-type", "message/rfc822").send(fixture("email-factura.eml").toString());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("duplicado");
  });

  it("contacto registado encaminha pelo remetente", async () => {
    const add = await S(request(app).post("/api/companies/2/contacts").send({ channel: "email", address: "Ana <TECNO@demo.pt>" }));
    expect(add.status).toBe(201);
    expect(add.body.address).toBe("tecno@demo.pt");
    const res = await request(app).post("/api/inbound/email").set("x-contai-secret", SECRET).send({
      message_id: "<tecno-1>", from: "tecno@demo.pt",
      attachments: [{ filename: "factura-venda.txt", content_type: "text/plain", content_base64: fixture("factura-venda.txt").toString("base64") }],
    });
    expect(res.body.companyId).toBe(2);
    const dupContact = await S(request(app).post("/api/companies/1/contacts").send({ channel: "email", address: "tecno@demo.pt" }));
    expect(dupContact.status).toBe(409);
  });

  it("associar um remetente desconhecido cria o contacto", async () => {
    const m = db.prepare("SELECT id FROM inbound_messages WHERE status = 'sem_empresa' LIMIT 1").get() as any;
    const res = await S(request(app).post(`/api/inbound/${m.id}/assign`).send({ company_id: 2 }));
    expect(res.status).toBe(200);
    const c = db.prepare("SELECT company_id FROM company_contacts WHERE address = 'alguem@outra.pt'").get() as any;
    expect(c.company_id).toBe(2);
  });
});

describe("whatsapp", () => {
  it("verificacao da subscricao", async () => {
    const ok = await request(app).get("/webhooks/whatsapp").query({ "hub.mode": "subscribe", "hub.verify_token": WA.verifyToken, "hub.challenge": "12345" });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("12345");
    const bad = await request(app).get("/webhooks/whatsapp").query({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "1" });
    expect(bad.status).toBe(403);
  });

  it("assinatura invalida e rejeitada", async () => {
    const body = fixture("whatsapp-webhook.json").toString();
    const res = await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", "sha256=" + "0".repeat(64)).send(body);
    expect(res.status).toBe(401);
  });

  it("imagem enviada por numero associado e descarregada, lida por OCR e confirmada", async () => {
    await S(request(app).post("/api/companies/1/contacts").send({ channel: "whatsapp", address: "+351 912 345 678", label: "Joao" }));
    const body = fixture("whatsapp-webhook.json").toString();
    const res = await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", sign(body)).send(body);
    expect(res.status).toBe(200);
    // processamento assincrono apos o 200
    for (let i = 0; i < 100; i++) {
      const m = db.prepare("SELECT * FROM inbound_messages WHERE external_id = 'wamid.FIXTURE001'").get() as any;
      if (m) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const m = db.prepare("SELECT * FROM inbound_messages WHERE external_id = 'wamid.FIXTURE001'").get() as any;
    expect(m).toBeDefined();
    expect(m.status).toBe("processado");
    expect(m.company_id).toBe(1);
    const docId = JSON.parse(m.document_ids)[0];
    const doc = db.prepare("SELECT channel, doc_type, ocr_method FROM documents WHERE id = ?").get(docId) as any;
    expect(doc.channel).toBe("whatsapp");
    expect(doc.doc_type).toBe("factura_compra");
    expect(doc.ocr_method).toBe("tesseract");
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("351912345678");
    expect(sent[0].text.body).toContain("factura compra");
  }, 120_000);

  it("texto de confirmacao", () => {
    expect(confirmationText({ inboundId: 1, status: "sem_empresa", companyId: null, outcomes: [] })).toMatch(/não está associado/);
    expect(confirmationText({ inboundId: 1, status: "sem_anexos", companyId: 1, outcomes: [] })).toMatch(/nenhum documento/);
  });

  it("estado dos canais e recepcoes listadas", async () => {
    const st = await S(request(app).get("/api/channels/status"));
    expect(st.body.whatsapp).toBe(true);
    expect(st.body.email_webhook).toBe(true);
    const list = await S(request(app).get("/api/inbound"));
    expect(list.body.messages.length).toBeGreaterThanOrEqual(3);
  });
});
