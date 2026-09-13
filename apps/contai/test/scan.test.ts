import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import request from "supertest";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { createServer } from "../src/server.js";
import { HeuristicProvider } from "../src/ai/provider.js";

async function loadScan(): Promise<any> {
  // @ts-expect-error script de browser sem declaracoes de tipos
  await import("../public/scan.js");
  return (globalThis as any).ContaiScan;
}
function jpeg(w: number, h: number, color: string) {
  const c = createCanvas(w, h); const ctx = c.getContext("2d");
  ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); ctx.fillStyle = "#000"; ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
  return { bytes: new Uint8Array(c.toBuffer("image/jpeg", 85)), width: w, height: h, canvas: c };
}

describe("digitalizacao: PDF escrito no browser", () => {
  it("gera um PDF valido com uma pagina A4 por fotografia, retrato e paisagem", async () => {
    const scan = await loadScan();
    const a = jpeg(600, 800, "#fff"), b = jpeg(800, 600, "#eee");
    const pdf: Uint8Array = scan.jpegsToPdf([a, b], { title: "Teste (1)" });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: pdf, isEvalSupported: false } as any).promise;
    expect(doc.numPages).toBe(2);
    const p1 = await doc.getPage(1), p2 = await doc.getPage(2);
    expect(Math.round(p1.getViewport({ scale: 1 }).width)).toBe(595);
    expect(Math.round(p2.getViewport({ scale: 1 }).width)).toBe(842);
    const ops = await p1.getOperatorList();
    expect(ops.fnArray.length).toBeGreaterThan(0);
    const meta = await doc.getMetadata();
    expect((meta.info as any).Producer).toContain("Lumarcont");
  });

  it("melhora o contraste e binariza por Otsu", async () => {
    const scan = await loadScan();
    const c = createCanvas(40, 40); const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 40, 0); g.addColorStop(0, "#333"); g.addColorStop(1, "#ccc");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 40, 40);
    const img = ctx.getImageData(0, 0, 40, 40);
    const before = new Set(Array.from(img.data).filter((_, i) => i % 4 === 0));
    scan.enhance(img, "pb");
    const after = new Set(Array.from(img.data).filter((_, i) => i % 4 === 0));
    expect(after.size).toBeLessThanOrEqual(2);
    expect(before.size).toBeGreaterThan(after.size);
    const img2 = ctx.getImageData(0, 0, 40, 40);
    scan.enhance(img2, "cinza");
    expect(img2.data[0]).toBe(img2.data[1]); // cinzento
    const lv = scan.levels(ctx.getImageData(0, 0, 40, 40).data);
    expect(lv.hi).toBeGreaterThan(lv.lo);
  });
});

describe("app Android: asset links e partilha", () => {
  it("assetlinks so existe com impressoes configuradas; /share-target sem SW abre a digitalizacao", async () => {
    const db = openDb(":memory:"); seedDemo(db);
    const app = createServer({ db, provider: new HeuristicProvider(), storageRoot: "/tmp", structured: null });
    delete process.env.ANDROID_SHA256_FINGERPRINTS;
    expect((await request(app).get("/.well-known/assetlinks.json")).status).toBe(404);
    process.env.ANDROID_SHA256_FINGERPRINTS = "aa:bb, cc:dd";
    process.env.ANDROID_PACKAGE = "pt.lumarcont.contai";
    const r = await request(app).get("/.well-known/assetlinks.json");
    expect(r.status).toBe(200);
    expect(r.body[0].target.package_name).toBe("pt.lumarcont.contai");
    expect(r.body[0].target.sha256_cert_fingerprints).toEqual(["AA:BB", "CC:DD"]);
    delete process.env.ANDROID_SHA256_FINGERPRINTS;
    const s = await request(app).post("/share-target");
    expect(s.status).toBe(303);
    expect(s.headers.location).toBe("/#digitalizar");
  });
});
