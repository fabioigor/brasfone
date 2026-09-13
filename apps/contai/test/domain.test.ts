import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractFromText, isValidNif } from "../src/domain/extraction.js";
import { classifyDocument } from "../src/domain/classification.js";
import { proposeEntry, isBalanced } from "../src/domain/entries.js";
import { upcomingObligations } from "../src/domain/obligations.js";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");

const PADARIA_NIF = "506284417";

describe("NIF", () => {
  it("valida digito de controlo", () => {
    expect(isValidNif("501442600")).toBe(true);
    expect(isValidNif("506284417")).toBe(true);
    expect(isValidNif("506284415")).toBe(false);
    expect(isValidNif("123")).toBe(false);
    expect(isValidNif("000000000")).toBe(false);
  });
});

describe("extraccao", () => {
  it("extrai dados de factura de fornecedor", () => {
    const e = extractFromText(fixture("factura-fornecedor.txt"));
    expect(e.issuerNif).toBe("501442600");
    expect(e.nifs).toContain(PADARIA_NIF);
    expect(e.docDate).toBe("2026-07-15");
    expect(e.totalAmount).toBe(658.05);
    expect(e.vatAmount).toBe(123.05);
    expect(e.netAmount).toBe(535.0);
    expect(e.vatRate).toBe(23);
    expect(e.docNumber).toMatch(/FT/i);
  });

  it("extrai dados de factura de venda com IVA a 6%", () => {
    const e = extractFromText(fixture("factura-venda.txt"));
    expect(e.issuerNif).toBe(PADARIA_NIF);
    expect(e.docDate).toBe("2026-07-20");
    expect(e.totalAmount).toBe(381.6);
    expect(e.vatRate).toBe(6);
  });

  it("deriva o total quando falta (base + IVA)", () => {
    const e = extractFromText("Factura\nBase tributavel: 100,00\nIVA (23%): 23,00\n");
    expect(e.totalAmount).toBe(123.0);
  });
});

describe("classificacao", () => {
  it("factura emitida por terceiro e compra", () => {
    const text = fixture("factura-fornecedor.txt");
    const c = classifyDocument(text, "factura-fornecedor.txt", PADARIA_NIF, extractFromText(text));
    expect(c.docType).toBe("factura_compra");
    expect(c.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("factura emitida pela propria empresa e venda", () => {
    const text = fixture("factura-venda.txt");
    const c = classifyDocument(text, "factura-venda.txt", PADARIA_NIF, extractFromText(text));
    expect(c.docType).toBe("factura_venda");
  });

  it("recibo e classificado como recibo", () => {
    const text = fixture("recibo.txt");
    const c = classifyDocument(text, "recibo.txt", PADARIA_NIF, extractFromText(text));
    expect(c.docType).toBe("recibo");
  });

  it("texto irreconhecivel fica 'outro' com confianca baixa", () => {
    const c = classifyDocument("bom dia, tudo bem?", "nota.txt", PADARIA_NIF, extractFromText("bom dia"));
    expect(c.docType).toBe("outro");
    expect(c.confidence).toBeLessThan(0.5);
  });
});

describe("lancamentos", () => {
  it("compra gera lancamento balanceado com IVA dedutivel", () => {
    const text = fixture("factura-fornecedor.txt");
    const e = extractFromText(text);
    const p = proposeEntry("factura_compra", e, 0.9, "Electro Fornecedora")!;
    expect(p).not.toBeNull();
    expect(isBalanced(p.lines)).toBe(true);
    expect(p.lines.find((l) => l.account === "2432")?.debit).toBe(123.05);
    expect(p.lines.find((l) => l.account === "221")?.credit).toBe(658.05);
    expect(p.entryDate).toBe("2026-07-15");
  });

  it("venda gera lancamento balanceado com IVA liquidado", () => {
    const text = fixture("factura-venda.txt");
    const e = extractFromText(text);
    const p = proposeEntry("factura_venda", e, 0.9, "Restaurante O Forno")!;
    expect(isBalanced(p.lines)).toBe(true);
    expect(p.lines.find((l) => l.account === "211")?.debit).toBe(381.6);
    expect(p.lines.find((l) => l.account === "2433")?.credit).toBe(21.6);
  });

  it("documento sem total nao gera lancamento", () => {
    const e = extractFromText("Factura FT 1/1 sem valores");
    expect(proposeEntry("factura_compra", e, 0.9, "X")).toBeNull();
  });

  it("extracto bancario nao gera lancamento", () => {
    const e = extractFromText("Extracto bancario\nTotal: 100,00");
    expect(proposeEntry("extracto_bancario", e, 0.9, "Banco")).toBeNull();
  });

  it("falta de data reduz a confianca", () => {
    const e = extractFromText("Factura\nTotal: 123,00\nIVA: 23,00");
    const p = proposeEntry("factura_compra", e, 0.9, "X")!;
    expect(p.confidence).toBeLessThan(0.9);
  });
});

describe("calendario fiscal", () => {
  it("regime mensal inclui declaracao de IVA ao dia 20", () => {
    const obs = upcomingObligations("2026-09-01", "mensal", 30);
    expect(obs.some((o) => o.code === "IVA-DP" && o.dueDate === "2026-09-20")).toBe(true);
    expect(obs.some((o) => o.code === "DMR" && o.dueDate === "2026-09-10")).toBe(true);
  });

  it("regime trimestral so tem IVA nos meses certos", () => {
    const obs = upcomingObligations("2026-10-25", "trimestral", 40);
    expect(obs.some((o) => o.code === "IVA-DP" && o.dueDate === "2026-11-20")).toBe(true);
    const sept = upcomingObligations("2026-09-01", "trimestral", 25);
    expect(sept.some((o) => o.code === "IVA-DP")).toBe(false);
  });

  it("obrigacoes vem ordenadas por data", () => {
    const obs = upcomingObligations("2026-05-01", "mensal", 60);
    const dates = obs.map((o) => o.dueDate);
    expect([...dates].sort()).toEqual(dates);
    expect(obs.some((o) => o.code === "MOD22" && o.dueDate === "2026-05-31")).toBe(true);
  });
});
