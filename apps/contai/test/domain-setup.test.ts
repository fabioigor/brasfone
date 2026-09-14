import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import request from "supertest";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";
import { normaliseDomain, readDomain, writeDomain, domainStatus } from "../src/domainSetup.js";

describe("dominio e TLS em auto-servico", () => {
  it("normaliza e valida nomes de dominio", () => {
    expect(normaliseDomain(" https://App.Lumarcont.PT/ ")).toBe("app.lumarcont.pt");
    expect(normaliseDomain("")).toBeNull();
    expect(normaliseDomain("nao é dominio")).toBe("invalid");
    expect(normaliseDomain("localhost")).toBe("invalid");
  });

  it("guarda o dominio na pasta partilhada e reporta o estado", async () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "contai-cfg-")); const logs = fs.mkdtempSync(path.join(os.tmpdir(), "contai-logs-"));
    process.env.CONTAI_CONFIG_DIR = cfg; delete process.env.CONTAI_DOMAIN;
    expect(readDomain()).toBeNull();
    expect(writeDomain("app.exemplo.pt")).toBe(true);
    expect(readDomain()).toBe("app.exemplo.pt");
    fs.writeFileSync(path.join(logs, "server.json"), JSON.stringify({ publicIp: "203.0.113.10" }));
    fs.writeFileSync(path.join(logs, "domain.applied"), "\n");
    const fakeFetch: typeof fetch = async () => new Response("{}", { status: 200 });
    const st = await domainStatus(logs, fakeFetch);
    expect(st.domain).toBe("app.exemplo.pt");
    expect(st.serverIp).toBe("203.0.113.10");
    expect(st.applied).toBe(false);          // ainda nao aplicado pelo host
    expect(st.configurable).toBe(true);

    const db = openDb(":memory:"); seedDemo(db);
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null });
    const staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    const client = (await request(app).post("/api/auth/login").send({ email: "padaria@demo.pt", password: "cliente123" })).body.token;
    expect((await request(app).get("/api/domain").set("Authorization", `Bearer ${client}`)).status).toBe(403);
    expect((await request(app).put("/api/domain").set("Authorization", `Bearer ${staff}`).send({ domain: "http://x y" })).status).toBe(400);
    const ok = await request(app).put("/api/domain").set("Authorization", `Bearer ${staff}`).send({ domain: "Contai.Lumarcont.pt" });
    expect(ok.body.domain).toBe("contai.lumarcont.pt");
    expect(fs.readFileSync(path.join(cfg, "domain"), "utf8").trim()).toBe("contai.lumarcont.pt");
    await request(app).put("/api/domain").set("Authorization", `Bearer ${staff}`).send({ domain: "" });
    expect(fs.readFileSync(path.join(cfg, "domain"), "utf8")).toBe("");
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'domain_set'").get() as any).n).toBe(2);
    delete process.env.CONTAI_CONFIG_DIR;
    fs.rmSync(cfg, { recursive: true, force: true }); fs.rmSync(logs, { recursive: true, force: true });
  });

  it("testes de credenciais: validacao de entrada e WhatsApp com fetch injectado", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const fakeFetch: typeof fetch = async (input: any) => String(input).includes("/PHONE1?")
      ? new Response(JSON.stringify({ display_phone_number: "+351 21 000 0000", verified_name: "Lumarcont", quality_rating: "GREEN" }), { status: 200 })
      : new Response(JSON.stringify({ error: { message: "Invalid OAuth access token." } }), { status: 401 });
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null, whatsappFetch: fakeFetch });
    const staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    const A = (r: request.Test) => r.set("Authorization", `Bearer ${staff}`);
    delete process.env.ANTHROPIC_API_KEY;
    expect((await A(request(app).post("/api/settings/test/ia")).send({ values: {} })).status).toBe(400);
    expect((await A(request(app).post("/api/settings/test/email")).send({ values: { IMAP_HOST: "x" } })).status).toBe(400);
    const ok = await A(request(app).post("/api/settings/test/whatsapp")).send({ values: { WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "PHONE1" } });
    expect(ok.body.ok).toBe(true);
    expect(ok.body.detail).toContain("Lumarcont");
    expect(ok.body.detail).toContain("app secret");
    const bad = await A(request(app).post("/api/settings/test/whatsapp")).send({ values: { WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "OUTRO" } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.detail).toContain("401");
    expect((await A(request(app).post("/api/settings/test/nada")).send({})).status).toBe(404);
  });
});
