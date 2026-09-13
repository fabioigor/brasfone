/**
 * Conferência de lançamentos: checks each classified document against the
 * VAT knowledge base and the company's own history, producing findings for
 * the human reviewer. Conservative by design: a finding is an alert to look
 * at, never an automatic correction.
 */
import { Db } from "../db.js";
import { ExtractedData } from "./extraction.js";
import { DocType } from "./classification.js";
import { loadVatRules, ratesOn, Territory, VatBand, VatCategory } from "../knowledge/index.js";

export type Severity = "info" | "aviso" | "erro";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  detail?: Record<string, unknown>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Maps a line description to the VAT category whose keyword matches best. */
export function categoriseItem(description: string): VatCategory | null {
  const hay = norm(description);
  let best: { cat: VatCategory; len: number } | null = null;
  for (const cat of loadVatRules().categories) {
    for (const kw of cat.keywords) {
      if (hay.includes(norm(kw)) && (!best || kw.length > best.len)) best = { cat, len: kw.length };
    }
  }
  return best?.cat ?? null;
}

export function bandRate(band: VatBand, territory: Territory, date: string): number {
  return ratesOn(territory, date)[band];
}

export interface AuditContext {
  territory: Territory;
  companyNif: string;
  /** Effective VAT rate (%) observed on previous documents of the same counterparty. */
  counterpartyHistory?: number[];
  /** Existing (issuerNif, docNumber) pairs already archived for this company. */
  existingDocNumbers?: Set<string>;
  /** Existing ATCUD codes already archived for this company. */
  existingAtcuds?: Set<string>;
  /** Divergences between extraction sources (OCR vs IA vs QR). */
  divergences?: string[];
  /** Number of distinct AT QR codes found in the file (>1 = several invoices in one PDF). */
  qrCount?: number;
}

/**
 * Pure audit of one document. Returns an empty array for document types that
 * carry no VAT information (bank statements, transport guides, unknown).
 */
export function auditDocument(docType: DocType, x: ExtractedData, ctx: AuditContext): Finding[] {
  const findings: Finding[] = [];
  if (!["factura_compra", "factura_venda", "nota_credito", "despesa", "recibo"].includes(docType)) return findings;

  const date = x.docDate ?? new Date().toISOString().slice(0, 10);
  const rates = ratesOn(ctx.territory, date);
  const validRates = [rates.normal, rates.intermedia, rates.reduzida, 0];

  // 1. Datas
  const today = new Date().toISOString().slice(0, 10);
  if (x.docDate && x.docDate > today) {
    findings.push({ code: "DATA_FUTURA", severity: "erro", message: `Data do documento (${x.docDate}) é posterior a hoje.` });
  }
  if (!x.docDate) {
    findings.push({ code: "DATA_EM_FALTA", severity: "aviso", message: "Não foi possível identificar a data do documento." });
  }

  // 2. Duplicado por ATCUD ou por número de documento do mesmo emissor
  if (x.atcud && ctx.existingAtcuds?.has(x.atcud)) {
    findings.push({
      code: "DUPLICADO",
      severity: "erro",
      message: `Já existe um documento com o ATCUD ${x.atcud} neste arquivo (detectado pelo QR code).`,
    });
  } else if (x.docNumber && x.issuerNif && ctx.existingDocNumbers?.has(`${x.issuerNif}|${x.docNumber.toUpperCase()}`)) {
    findings.push({
      code: "DUPLICADO",
      severity: "erro",
      message: `Já existe um documento ${x.docNumber} do emissor NIF ${x.issuerNif} neste arquivo.`,
    });
  }

  // 2b. Proveniência: QR anulado, várias facturas num ficheiro, fontes em desacordo
  if (x.docStatus === "A") {
    findings.push({ code: "DOCUMENTO_ANULADO", severity: "erro", message: "O QR code indica que o documento está anulado (estado A); não deve ser lançado." });
  }
  if ((ctx.qrCount ?? 0) > 1) {
    findings.push({
      code: "VARIOS_DOCUMENTOS_NO_FICHEIRO",
      severity: "aviso",
      message: `O ficheiro contém ${ctx.qrCount} QR codes distintos: parece agrupar vários documentos. Só o primeiro foi considerado; separe o ficheiro.`,
    });
  }
  for (const d of ctx.divergences ?? []) {
    findings.push({ code: "FONTES_DIVERGENTES", severity: "aviso", message: `As fontes de extracção discordam (${d}). Prevaleceu ${x.fieldSources?.["totalAmount"] ?? "a heurística"}; confirme no original.` });
  }

  if (docType === "recibo") return findings; // recibos não têm IVA próprio

  // 3. Coerência aritmética base + IVA = total
  if (x.netAmount !== null && x.vatAmount !== null && x.totalAmount !== null) {
    const diff = round2(x.netAmount + x.vatAmount - x.totalAmount);
    if (Math.abs(diff) > 0.02) {
      findings.push({
        code: "TOTAL_INCOERENTE",
        severity: "erro",
        message: `Base (${x.netAmount.toFixed(2)}) + IVA (${x.vatAmount.toFixed(2)}) não iguala o total (${x.totalAmount.toFixed(2)}); diferença ${diff.toFixed(2)} €.`,
        detail: { diff },
      });
    }
  }

  // 3b. Desagregação por taxa (QR / IA): cada taxa tem de bater com a sua base
  const breakdown = x.vatBreakdown ?? [];
  if (breakdown.length > 1 || (breakdown.length === 1 && x.vatRate === null)) {
    for (const b of breakdown) {
      if (b.rate > 0 && !validRates.includes(b.rate)) {
        findings.push({ code: "TAXA_INEXISTENTE", severity: "erro", message: `Taxa ${b.rate}% na desagregação não existe em ${ctx.territory} em ${date}.` });
        continue;
      }
      if (b.rate > 0 && b.base > 0) {
        const expected = round2((b.base * b.rate) / 100);
        if (Math.abs(expected - b.vat) > Math.max(0.02, b.base * 0.005)) {
          findings.push({
            code: "IVA_CALCULO",
            severity: "erro",
            message: `IVA à taxa ${b.rate}%: declarado ${b.vat.toFixed(2)} € sobre base ${b.base.toFixed(2)} € (esperado ${expected.toFixed(2)} €).`,
            detail: { rate: b.rate, expected, declared: b.vat },
          });
        }
      }
    }
    const sumBase = round2(breakdown.reduce((a, b) => a + b.base, 0));
    const sumVat = round2(breakdown.reduce((a, b) => a + b.vat, 0));
    if (x.totalAmount !== null && Math.abs(sumBase + sumVat - x.totalAmount) > 0.02) {
      findings.push({
        code: "QR_INCOERENTE",
        severity: "erro",
        message: `A desagregação (bases ${sumBase.toFixed(2)} + IVA ${sumVat.toFixed(2)}) não iguala o total ${x.totalAmount.toFixed(2)} €.`,
      });
    }
  }

  // 4. Taxa aplicada existe no território/data
  if (x.vatRate !== null && !validRates.includes(x.vatRate)) {
    findings.push({
      code: "TAXA_INEXISTENTE",
      severity: "erro",
      message: `Taxa de IVA ${x.vatRate}% não existe em ${ctx.territory} em ${date} (válidas: ${rates.normal}%, ${rates.intermedia}%, ${rates.reduzida}%).`,
    });
  }

  // 5. Valor do IVA vs taxa declarada
  if (x.vatRate !== null && x.netAmount !== null && x.vatAmount !== null && x.netAmount > 0) {
    const expected = round2((x.netAmount * x.vatRate) / 100);
    const tolerance = Math.max(0.02, x.netAmount * 0.005);
    if (Math.abs(expected - x.vatAmount) > tolerance) {
      findings.push({
        code: "IVA_CALCULO",
        severity: "erro",
        message: `IVA declarado ${x.vatAmount.toFixed(2)} € não corresponde a ${x.vatRate}% de ${x.netAmount.toFixed(2)} € (esperado ${expected.toFixed(2)} €).`,
        detail: { expected, declared: x.vatAmount },
      });
    }
  } else if (x.vatRate === null && x.netAmount && x.vatAmount) {
    findings.push({
      code: "TAXA_NAO_IDENTIFICADA",
      severity: "aviso",
      message: `IVA de ${x.vatAmount.toFixed(2)} € sobre ${x.netAmount.toFixed(2)} € (${round2((x.vatAmount / x.netAmount) * 100)}%) não corresponde a nenhuma taxa legal.`,
    });
  }

  // 6. Taxa aplicada vs natureza do produto/serviço (Listas I e II do CIVA)
  //    Com desagregação por taxa, o artigo é comparado com a sua própria taxa quando conhecida.
  if (x.vatRate === null && breakdown.length > 1 && x.items.length > 0) {
    const bad: string[] = [];
    for (const item of x.items) {
      const cat = categoriseItem(item.description);
      if (!cat || item.vatRate === null || item.vatRate === undefined) continue;
      const expected = bandRate(cat.band, ctx.territory, date);
      if (expected !== item.vatRate) bad.push(`"${item.description}" a ${item.vatRate}% (esperado ${expected}%, ${cat.legal_basis})`);
    }
    if (bad.length) {
      findings.push({ code: "TAXA_DESADEQUADA", severity: "aviso", message: `Artigos com taxa possivelmente desadequada: ${bad.join("; ")}.` });
    }
  }
  if (x.vatRate !== null && x.items.length > 0) {
    const mismatches: { item: string; category: string; expectedRate: number; legal: string }[] = [];
    const expectedRates = new Set<number>();
    for (const item of x.items) {
      const cat = categoriseItem(item.description);
      if (!cat) continue;
      const expected = bandRate(cat.band, ctx.territory, date);
      expectedRates.add(expected);
      if (expected !== x.vatRate) {
        mismatches.push({ item: item.description, category: cat.label, expectedRate: expected, legal: cat.legal_basis });
      }
    }
    if (mismatches.length > 0) {
      const mixed = expectedRates.size > 1;
      findings.push({
        code: mixed ? "TAXAS_MISTAS_POSSIVEIS" : "TAXA_DESADEQUADA",
        severity: "aviso",
        message: mixed
          ? `O documento aplica ${x.vatRate}% a tudo, mas contém artigos de taxas diferentes: ${mismatches.map((m) => `"${m.item}" → ${m.expectedRate}% (${m.legal})`).join("; ")}.`
          : `Taxa aplicada ${x.vatRate}% mas os artigos sugerem ${mismatches[0]!.expectedRate}%: ${mismatches.map((m) => `"${m.item}" (${m.category}, ${m.legal})`).join("; ")}.`,
        detail: { mismatches },
      });
    }
  }

  // 7. Aumento anómalo de imposto face ao histórico do mesmo fornecedor/cliente
  const hist = ctx.counterpartyHistory ?? [];
  const rules = loadVatRules();
  if (x.vatRate !== null && hist.length >= rules.anomaly.min_history_documents) {
    const avg = hist.reduce((s, r) => s + r, 0) / hist.length;
    if (x.vatRate - avg >= rules.anomaly.effective_rate_jump_points) {
      findings.push({
        code: "AUMENTO_IMPOSTO_ANOMALO",
        severity: "aviso",
        message: `Taxa efectiva de IVA subiu para ${x.vatRate}% quando o histórico deste terceiro era ${avg.toFixed(1)}% (${hist.length} documentos). Confirmar alteração legal ou erro do emissor.`,
        detail: { historicalAverage: round2(avg), sample: hist.length },
      });
    }
  }

  // 8. NIF do terceiro em falta
  const other = x.nifs.find((n) => n !== ctx.companyNif);
  if (!other) {
    findings.push({ code: "NIF_TERCEIRO_EM_FALTA", severity: "aviso", message: "Não foi identificado NIF válido do fornecedor/cliente." });
  }

  return findings;
}

/** Persists findings for a document, replacing previous open ones of the same run. */
export function persistDocumentFindings(db: Db, companyId: number, documentId: number, findings: Finding[]): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM findings WHERE document_id = ? AND status = 'aberto'").run(documentId);
    const ins = db.prepare(
      "INSERT INTO findings (company_id, scope, document_id, code, severity, message, detail_json) VALUES (?, 'documento', ?, ?, ?, ?, ?)"
    );
    for (const f of findings) ins.run(companyId, documentId, f.code, f.severity, f.message, f.detail ? JSON.stringify(f.detail) : null);
  });
  tx();
}

/** Builds the audit context from what the company already has archived. */
export function buildAuditContext(db: Db, companyId: number, x: ExtractedData, excludeDocumentId?: number): AuditContext {
  const company = db.prepare("SELECT nif, territory FROM companies WHERE id = ?").get(companyId) as any;
  const territory: Territory = company?.territory ?? "continente";
  const rows = db
    .prepare("SELECT id, extracted_json FROM documents WHERE company_id = ? AND extracted_json IS NOT NULL")
    .all(companyId) as any[];
  const existing = new Set<string>();
  const atcuds = new Set<string>();
  const history: number[] = [];
  const other = x.nifs.find((n) => n !== company?.nif) ?? null;
  for (const r of rows) {
    if (r.id === excludeDocumentId) continue;
    const e = JSON.parse(r.extracted_json) as ExtractedData;
    if (e.issuerNif && e.docNumber) existing.add(`${e.issuerNif}|${e.docNumber.toUpperCase()}`);
    if (e.atcud) atcuds.add(e.atcud);
    if (other && e.nifs?.includes(other) && e.vatRate !== null && e.vatRate !== undefined) history.push(e.vatRate);
  }
  return { territory, companyNif: company?.nif ?? "", counterpartyHistory: history, existingDocNumbers: existing, existingAtcuds: atcuds };
}

/** Runs the audit on one stored document and persists the findings. */
export function auditStoredDocument(db: Db, documentId: number): Finding[] {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as any;
  if (!doc || !doc.extracted_json) return [];
  const x = JSON.parse(doc.extracted_json) as ExtractedData;
  if (!x.items) x.items = [];
  const ctx = buildAuditContext(db, doc.company_id, x, documentId);
  const findings = auditDocument(doc.doc_type, x, ctx);
  persistDocumentFindings(db, doc.company_id, documentId, findings);
  return findings;
}
