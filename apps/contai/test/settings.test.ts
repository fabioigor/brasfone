import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { openDb, Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { encryptValue, decryptValue, applyStoredSettings, listSettings, saveSettings } from "../src/settings.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste-para-cifrar-definicoes";

describe("definicoes cifradas", () => {
  it("cifra e decifra com AES-256-GCM e rejeita adulteracao", () => {
    const enc = encryptValue("sk-ant-teste-1234");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("sk-ant");
    expect(decryptValue(enc)).toBe("sk-ant-teste-1234");
    const parts = enc.split(":"); parts[3] = Buffer.from("xx" + Buffer.from(parts[3]!, "base64").toString("binary").slice(2), "binary").toString("base64");
    expect(() => decryptValue(parts.join(":"))).toThrow();
  });

  it("guarda, mascara segredos, aplica ao ambiente e remove", () => {
    const db = openDb(":memory:");
    seedDemo(db);
    delete process.env.ANTHROPIC_API_KEY;
    const r = saveSettings(db, 1, { ANTHROPIC_API_KEY: "sk-ant-abcdef-9876", IMAP_HOST: "imap.exemplo.pt", IMAP_PORT: " " });
    expect(r.saved.sort()).toEqual(["ANTHROPIC_API_KEY", "IMAP_HOST"]);
    expect(r.cleared).toEqual(["IMAP_PORT"]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-abcdef-9876");
    const raw = db.prepare("SELECT value_enc FROM settings WHERE key = 'ANTHROPIC_API_KEY'").get() as any;
    expect(raw.value_enc).not.toContain("abcdef");

    const list = listSettings(db);
    const key = list.find((s) => s.key === "ANTHROPIC_API_KEY")!;
    expect(key.value).toBeNull();
    expect(key.masked).toBe("••••9876");
    expect(key.source).toBe("definicoes");
    expect(list.find((s) => s.key === "IMAP_HOST")!.value).toBe("imap.exemplo.pt");
    expect(list.find((s) => s.key === "IMAP_USER")!.source).toBe("nenhum");
    expect(() => saveSettings(db, 1, { INVENTADA: "x" })).toThrow(/desconhecida/);

    delete process.env.ANTHROPIC_API_KEY;
    expect(applyStoredSettings(db).sort()).toEqual(["ANTHROPIC_API_KEY", "IMAP_HOST"]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-abcdef-9876");
    saveSettings(db, 1, { ANTHROPIC_API_KEY: null });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'settings_update'").all() as any[];
    expect(audit.length).toBe(2);
    expect(audit.map((a) => a.detail).join("")).not.toContain("abcdef");
  });
});

describe("API de integracoes", () => {
  let db: Db; let app: ReturnType<typeof createServer>; let staff: string; let client: string;
  let restarted = 0;
  beforeAll(async () => {
    db = openDb(":memory:"); seedDemo(db);
    app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null, onSettingsSaved: () => { restarted++; } });
    staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    client = (await request(app).post("/api/auth/login").send({ email: "padaria@demo.pt", password: "cliente123" })).body.token;
  });

  it("so o gabinete acede; segredos nunca saem em claro; guardar pede reinicio", async () => {
    expect((await request(app).get("/api/settings").set("Authorization", `Bearer ${client}`)).status).toBe(403);
    const before = await request(app).get("/api/settings").set("Authorization", `Bearer ${staff}`);
    expect(before.status).toBe(200);
    expect(before.body.restart).toBe(true);
    const put = await request(app).put("/api/settings").set("Authorization", `Bearer ${staff}`).send({ values: { WHATSAPP_ACCESS_TOKEN: "EAAB-token-secreto-0001", WHATSAPP_PHONE_NUMBER_ID: "123456" } });
    expect(put.status).toBe(200);
    expect(put.body.saved).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 600));
    expect(restarted).toBe(1);
    const after = await request(app).get("/api/settings").set("Authorization", `Bearer ${staff}`);
    expect(JSON.stringify(after.body)).not.toContain("token-secreto");
    expect(after.body.settings.find((s: any) => s.key === "WHATSAPP_ACCESS_TOKEN").masked).toBe("••••0001");
    expect(after.body.settings.find((s: any) => s.key === "WHATSAPP_PHONE_NUMBER_ID").value).toBe("123456");
    expect((await request(app).put("/api/settings").set("Authorization", `Bearer ${staff}`).send({ values: { OUTRA: "x" } })).status).toBe(400);
  });
});

describe("teste de ligacao CentralGest", () => {
  it("testa credenciais sem as guardar e reporta erro em URL inacessivel", async () => {
    const { startCentralGestMock } = await import("../src/integrations/centralgest-mock.js");
    const mock = await startCentralGestMock("chave-teste");
    const db = openDb(":memory:"); seedDemo(db);
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null });
    const staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);

    const none = await auth(request(app).post("/api/centralgest/test")).send({});
    expect(none.body.ok).toBe(false);
    const ok = await auth(request(app).post("/api/centralgest/test")).send({ baseUrl: mock.baseUrl, apiKey: "chave-teste" });
    expect(ok.body.ok).toBe(true);
    expect(ok.body.remoteCompanies.length).toBeGreaterThan(0);
    const bad = await auth(request(app).post("/api/centralgest/test")).send({ baseUrl: mock.baseUrl, apiKey: "errada" });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.detail).toMatch(/Autenticacao/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM settings").get() as any).n).toBe(0);
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'centralgest_test'").all() as any[];
    expect(audit.length).toBe(2); // o caso "nao configurado" nao contacta ninguem
    expect(audit.map((a) => a.detail).join("")).not.toContain("chave-teste");
    mock.server.close();
  });
});
