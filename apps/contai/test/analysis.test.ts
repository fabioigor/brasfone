import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractFromText } from "../src/domain/extraction.js";
import { auditDocument, categoriseItem } from "../src/domain/vatAudit.js";
import { parseBalanceCsv, computeFinancials, previousPeriod } from "../src/domain/trialBalance.js";
import { evaluateRules, DEFAULT_RULES } from "../src/domain/balanceRules.js";
import { computeRatios, buildNarrative } from "../src/domain/financialReport.js";
import { renderReportHtml } from "../src/domain/reportHtml.js";
import { knowledgeStatus, ratesOn, sectorForCae } from "../src/knowledge/index.js";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const PADARIA = "506284417";
const ctx = { territory: "continente" as const, companyNif: PADARIA };

describe("conhecimento fiscal", () => {
  it("taxas por territorio", () => {
    expect(ratesOn("continente", "2026-07-01")).toEqual({ normal: 23, intermedia: 13, reduzida: 6 });
    expect(ratesOn("acores", "2026-07-01").normal).toBe(16);
    expect(ratesOn("madeira", "2026-07-01").normal).toBe(22);
  });
  it("categoriza produtos pelas Listas do CIVA", () => {
    expect(categoriseItem("Farinha tipo 65 (saco 25kg)")?.band).toBe("reduzida");
    expect(categoriseItem("Manutencao forno industrial")?.band).toBe("normal");
    expect(categoriseItem("Vinho tinto regional")?.band).toBe("intermedia");
    expect(categoriseItem("Artigo desconhecido xpto")).toBeNull();
  });
  it("sinaliza conhecimento desactualizado", () => {
    const fresh = knowledgeStatus(new Date("2026-09-12T00:00:00Z"));
    expect(fresh.find((k) => k.name === "regras_iva")!.stale).toBe(false);
    const old = knowledgeStatus(new Date("2027-06-01T00:00:00Z"));
    expect(old.find((k) => k.name === "regras_iva")!.stale).toBe(true);
  });
  it("mapeia CAE para sector", () => {
    expect(sectorForCae("10711")?.key).toBe("restauracao_alimentar");
    expect(sectorForCae("62020")?.key).toBe("servicos_ti");
    expect(sectorForCae("99999")).toBeNull();
  });
});

describe("conferencia de lancamentos (IVA)", () => {
  it("extrai linhas de artigos", () => {
    const x = extractFromText(fixture("factura-fornecedor.txt"));
    expect(x.items.map((i) => i.description)).toEqual(["Farinha tipo 65 (saco 25kg)", "Manutencao forno industrial"]);
    expect(x.items[0]!.quantity).toBe(10);
    expect(x.items[0]!.unitPrice).toBe(18.5);
  });

  it("factura com taxa unica sobre artigos de taxas mistas gera aviso", () => {
    const x = extractFromText(fixture("factura-fornecedor.txt"));
    const f = auditDocument("factura_compra", x, ctx);
    const mixed = f.find((a) => a.code === "TAXAS_MISTAS_POSSIVEIS");
    expect(mixed).toBeDefined();
    expect(mixed!.message).toContain("Farinha");
    expect(f.some((a) => a.code === "IVA_CALCULO")).toBe(false);
  });

  it("detecta IVA mal calculado e taxa desadequada ao produto", () => {
    const x = extractFromText(fixture("factura-iva-errado.txt"));
    const f = auditDocument("factura_compra", x, ctx);
    const calc = f.find((a) => a.code === "IVA_CALCULO");
    expect(calc).toBeDefined();
    expect(calc!.severity).toBe("erro");
    expect(calc!.detail?.expected).toBe(53.13);
    const rate = f.find((a) => a.code === "TAXA_DESADEQUADA");
    expect(rate).toBeDefined();
    expect(rate!.message).toContain("6%");
  });

  it("factura de venda correcta a 6% nao gera erros", () => {
    const x = extractFromText(fixture("factura-venda.txt"));
    const f = auditDocument("factura_venda", x, ctx).filter((a) => a.severity === "erro");
    expect(f).toEqual([]);
  });

  it("taxa inexistente e total incoerente", () => {
    const x = extractFromText("Factura FT 1/1\nData: 2026-05-05\nNIF: 501442600\nBase tributavel: 100,00\nIVA (21%): 21,00\nTotal: 130,00");
    const codes = auditDocument("factura_compra", x, ctx).map((a) => a.code);
    expect(codes).toContain("TAXA_INEXISTENTE");
    expect(codes).toContain("TOTAL_INCOERENTE");
  });

  it("duplicado por numero de documento do mesmo emissor", () => {
    const x = extractFromText(fixture("factura-fornecedor.txt"));
    const existing = new Set([`${x.issuerNif}|${x.docNumber!.toUpperCase()}`]);
    const f = auditDocument("factura_compra", x, { ...ctx, existingDocNumbers: existing });
    expect(f.some((a) => a.code === "DUPLICADO")).toBe(true);
  });

  it("aumento anomalo de imposto face ao historico do fornecedor", () => {
    const x = extractFromText(fixture("factura-fornecedor.txt"));
    const f = auditDocument("factura_compra", x, { ...ctx, counterpartyHistory: [6, 6, 6, 6] });
    expect(f.some((a) => a.code === "AUMENTO_IMPOSTO_ANOMALO")).toBe(true);
    const g = auditDocument("factura_compra", x, { ...ctx, counterpartyHistory: [23, 23, 23] });
    expect(g.some((a) => a.code === "AUMENTO_IMPOSTO_ANOMALO")).toBe(false);
  });

  it("extracto bancario nao e auditado", () => {
    expect(auditDocument("extracto_bancario", extractFromText("Extracto"), ctx)).toEqual([]);
  });
});

describe("balancetes e padroes", () => {
  const jun = parseBalanceCsv(fixture("balancete-2026-06.csv"));
  const jul = parseBalanceCsv(fixture("balancete-2026-07.csv"));
  const rules = DEFAULT_RULES.map((r, i) => ({ ...r, id: i + 1, companyId: null }));

  it("parse CSV e periodo anterior", () => {
    expect(jun.length).toBe(18);
    expect(jun.find((l) => l.account === "12")!.balance).toBe(7300);
    expect(previousPeriod("2026-07")).toBe("2026-06");
    expect(previousPeriod("2026-01")).toBe("2025-12");
    expect(previousPeriod("2026")).toBe("2025");
  });

  it("indicadores financeiros", () => {
    const f = computeFinancials(jul);
    expect(f.vendas).toBe(42040);
    expect(f.fse).toBe(11800);
    expect(f.ebitda).toBeGreaterThan(0);
  });

  it("balancete equilibrado e sem saldos invertidos nao gera erros", () => {
    const f = evaluateRules(rules, jul, jun);
    expect(f.some((a) => a.code === "BALANCETE_DESEQUILIBRADO")).toBe(false);
    expect(f.some((a) => a.code === "SALDO_INVERTIDO")).toBe(false);
  });

  it("variacao de FSE so dispara com desvio relativo E impacto absoluto (dupla condicao)", () => {
    const fse = (r: Partial<typeof rules[0]>) => [{ id: 99, companyId: null, name: "62 FSE", type: "variacao" as const, method: "mes_anterior" as const, accountPrefixes: ["62"], param: null, threshold: 30, minImpact: 500, severity: "aviso" as const, enabled: true, ...r }];
    const hit = evaluateRules(fse({}), jul, jun).find((a) => a.code === "VARIACAO_ANOMALA");
    expect(hit).toBeDefined();
    expect(Math.abs(hit!.detail!.deviation as number)).toBeGreaterThan(30);
    expect(hit!.detail!.impact as number).toBeGreaterThanOrEqual(500);
    // mesmo desvio relativo, impacto minimo muito alto: nao interessa a ninguem
    expect(evaluateRules(fse({ minImpact: 100000 }), jul, jun).some((a) => a.code === "VARIACAO_ANOMALA")).toBe(false);
    // as regras por defeito de mediana precisam de historico (>= 3 meses); sem ele nao ha falso positivo
    expect(evaluateRules(rules, jul, jun).some((a) => a.code === "VARIACAO_ANOMALA")).toBe(false);
  });

  it("saldo invertido em bancos gera erro", () => {
    const bad = jul.map((l) => (l.account === "12" ? { ...l, debit: 100, credit: 5000, balance: -4900 } : l));
    const f = evaluateRules(rules, bad, null);
    const inv = f.find((a) => a.code === "SALDO_INVERTIDO");
    expect(inv).toBeDefined();
    expect(inv!.severity).toBe("erro");
  });

  it("balancete desequilibrado e sinalizado", () => {
    const bad = [...jul, { account: "99", description: "x", debit: 500, credit: 0, balance: 500 }];
    expect(evaluateRules(rules, bad, null)[0]!.code).toBe("BALANCETE_DESEQUILIBRADO");
  });
});

describe("relatorio financeiro", () => {
  const jul = parseBalanceCsv(fixture("balancete-2026-07.csv"));
  const jun = parseBalanceCsv(fixture("balancete-2026-06.csv"));
  const fin = computeFinancials(jul);
  const sector = sectorForCae("10711")!;

  it("compara racios com o sector", () => {
    const r = computeRatios(fin, sector);
    const ebitda = r.find((x) => x.key === "margem_ebitda")!;
    expect(ebitda.company).not.toBeNull();
    expect(ebitda.sector).toBe(9.5);
    expect(["melhor", "pior", "em_linha"]).toContain(ebitda.verdict);
  });

  it("memoria descritiva usa os numeros e o sector", () => {
    const ratios = computeRatios(fin, sector);
    const { summary, narrative } = buildNarrative({
      companyName: "Padaria Central Lda", nif: "506284417", cae: "10711", period: "2026-07", previousPeriod: "2026-06",
      template: sector.key, sector: { key: sector.key, label: sector.label, source: "BdP", disclaimer: "" },
      financials: fin, previousFinancials: computeFinancials(jun), ratios,
      costStructure: [{ label: "CMVMC", value: fin.cmvmc }, { label: "FSE", value: fin.fse }, { label: "Pessoal", value: fin.pessoal }, { label: "Outros", value: 0 }],
    });
    expect(summary).toContain("42");
    expect(narrative.join(" ")).toContain("Restauração");
    expect(narrative.join(" ")).not.toMatch(/—/);
  });

  it("HTML e auto-contido com graficos SVG e legenda", () => {
    const ratios = computeRatios(fin, sector);
    const html = renderReportHtml({
      companyName: "Padaria Central Lda", nif: "506284417", cae: "10711", period: "2026-07", previousPeriod: null,
      template: sector.key, sector: { key: sector.key, label: sector.label, source: "BdP", disclaimer: "d" },
      financials: fin, previousFinancials: null, ratios,
      costStructure: [{ label: "CMVMC", value: fin.cmvmc }, { label: "FSE", value: fin.fse }],
      summary: "s", narrative: ["p1"], generatedAt: "2026-09-12T10:00:00.000Z",
    });
    expect(html).toContain("<svg");
    expect(html).toContain("Sector de referência");
    expect(html).not.toContain("<script src=");
    expect(html).toContain("Referências sectoriais");
  });
});
