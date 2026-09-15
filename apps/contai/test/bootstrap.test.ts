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

describe("equipa do gabinete", () => {
  it("cria, lista e apaga contas staff; o cliente nao pode; nunca fica sem gabinete", async () => {
    const { openDb } = await import("../src/db.js"); const { seedDemo } = await import("../src/seed.js");
    const { createServer } = await import("../src/server.js"); const { HeuristicProvider } = await import("../src/ai/provider.js");
    const request = (await import("supertest")).default;
    const db = openDb(":memory:"); seedDemo(db);
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null });
    const staff = (await request(app).post("/api/auth/login").send({ email: "gabinete@demo.pt", password: "gabinete123" })).body.token;
    const client = (await request(app).post("/api/auth/login").send({ email: "padaria@demo.pt", password: "cliente123" })).body.token;
    expect((await request(app).post("/api/users").set("Authorization", `Bearer ${client}`).send({ name: "X Y", email: "x@y.pt", password: "12345678" })).status).toBe(403);
    expect((await request(app).post("/api/users").set("Authorization", `Bearer ${staff}`).send({ name: "X Y", email: "x@y.pt", password: "curta" })).status).toBe(400);
    const c = await request(app).post("/api/users").set("Authorization", `Bearer ${staff}`).send({ name: "Diogo Teste", email: "Diogo@Exemplo.pt", password: "Senha-Forte-123", profile: "coordenador" });
    expect(c.status).toBe(201); expect(c.body.email).toBe("diogo@exemplo.pt");
    expect((await request(app).post("/api/users").set("Authorization", `Bearer ${staff}`).send({ name: "Diogo Teste", email: "diogo@exemplo.pt", password: "Senha-Forte-123" })).status).toBe(409);
    const login = await request(app).post("/api/auth/login").send({ email: "diogo@exemplo.pt", password: "Senha-Forte-123" });
    expect(login.status).toBe(200); expect(login.body.user.role).toBe("staff");
    const list = await request(app).get("/api/users").set("Authorization", `Bearer ${staff}`);
    expect(list.body.users.some((u: any) => u.email === "diogo@exemplo.pt" && u.role === "staff")).toBe(true);
    expect(list.body.users.some((u: any) => u.email === "canais@contai.local")).toBe(false);
    const me = login.body.user.id;
    expect((await request(app).delete("/api/users/" + me).set("Authorization", `Bearer ${login.body.token}`)).status).toBe(400);
    expect((await request(app).delete("/api/users/" + c.body.id).set("Authorization", `Bearer ${staff}`)).status).toBe(200);
    const only = (db.prepare("SELECT id FROM users WHERE email = 'gabinete@demo.pt'").get() as any).id;
    const other = (await request(app).post("/api/users").set("Authorization", `Bearer ${staff}`).send({ name: "Outro Staff", email: "o@s.pt", password: "12345678", profile: "coordenador" })).body;
    const otherToken = (await request(app).post("/api/auth/login").send({ email: "o@s.pt", password: "12345678" })).body.token;
    expect((await request(app).delete("/api/users/" + only).set("Authorization", `Bearer ${otherToken}`)).status).toBe(200);
    expect((await request(app).delete("/api/users/" + other.id).set("Authorization", `Bearer ${otherToken}`)).status).toBe(400);
  });
});
