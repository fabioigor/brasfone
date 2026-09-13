import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb } from "../src/db.js";
import { bootstrapAdmin, demoModeFromEnv, seedDemo } from "../src/seed.js";
import { seedDefaultRules } from "../src/domain/balanceRules.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";

describe("arranque em producao", () => {
  it("modo de demonstracao depende do ambiente", () => {
    expect(demoModeFromEnv({ NODE_ENV: "production" })).toBe(false);
    expect(demoModeFromEnv({ NODE_ENV: "development" })).toBe(true);
    expect(demoModeFromEnv({})).toBe(true);
    expect(demoModeFromEnv({ NODE_ENV: "production", CONTAI_SEED_DEMO: "1" })).toBe(true);
    expect(demoModeFromEnv({ NODE_ENV: "development", CONTAI_SEED_DEMO: "0" })).toBe(false);
  });

  it("cria a conta de administracao uma so vez e sem dados de demonstracao", async () => {
    const db = openDb(":memory:");
    seedDefaultRules(db);
    expect(bootstrapAdmin(db, "Admin@Gabinete.PT", "palavra-passe-forte-1")).toBe("created");
    expect(bootstrapAdmin(db, "admin@gabinete.pt", "outra-palavra-passe-2")).toBe("exists");
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companies").get() as any).n).toBe(0);

    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", ocr: undefined, structured: null, demo: false });
    const cfg = await request(app).get("/api/public-config");
    expect(cfg.body.demo).toBe(false);
    const demoLogin = await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" });
    expect(demoLogin.status).toBe(401);
    const login = await request(app).post("/api/auth/login").send({ email: "admin@gabinete.pt", password: "palavra-passe-forte-1" });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("staff");
  });

  it("o utilizador altera a propria palavra-passe", async () => {
    const db = openDb(":memory:");
    seedDemo(db);
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null, demo: true });
    expect((await request(app).get("/api/public-config")).body.demo).toBe(true);
    const token = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

    expect((await auth(request(app).post("/api/auth/password")).send({ current: "errada", next: "nova-palavra-passe" })).status).toBe(401);
    expect((await auth(request(app).post("/api/auth/password")).send({ current: "gabinete123", next: "curta" })).status).toBe(400);
    expect((await auth(request(app).post("/api/auth/password")).send({ current: "gabinete123", next: "nova-palavra-passe" })).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "nova-palavra-passe" })).status).toBe(200);
    const audit = db.prepare("SELECT action FROM audit_log WHERE action = 'password_change'").all();
    expect(audit.length).toBe(1);
  });
});
