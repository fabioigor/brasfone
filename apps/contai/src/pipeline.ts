/**
 * Document processing pipeline:
 *   recebido -> classificado -> proposto (entry pending validation)
 * Text comes from the OCR cascade, fields from the reconciliation of the AT
 * QR code, the AI extractor and the heuristic extractor; the proposal uses
 * the supplier memory learned from previous approvals. The pipeline never
 * approves anything: every proposal waits for a human decision.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Db, audit } from "./db.js";
import { AiProvider } from "./ai/provider.js";
import { archivePath, DocType } from "./domain/classification.js";
import { proposeEntry } from "./domain/entries.js";
import { auditDocument, buildAuditContext, persistDocumentFindings, Finding } from "./domain/vatAudit.js";
import { OcrEngine, OcrResult } from "./ocr/engine.js";
import { analyseDocument, DocumentAnalysis } from "./extraction/analyse.js";
import { ClaudeStructuredExtractor } from "./extraction/structured.js";
import { counterpartyNif, getProfile, touchProfile } from "./domain/supplierMemory.js";

export interface IngestInput {
  companyId: number;
  uploaderId: number;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  channel?: "portal" | "email" | "whatsapp";
  requestId?: number | null;
}

export interface IngestOutcome {
  documentId: number;
  duplicate: boolean;
  docType: string;
  status: string;
  entryId: number | null;
  findings: { code: string; severity: string; message: string }[];
  ocr: { method: string; confidence: number; pages: number; warnings: string[] };
  sources: string[];
  qr: boolean;
}

export interface PipelineDeps {
  ocr: OcrEngine;
  structured?: ClaudeStructuredExtractor | null;
}

/** OCR confidence below this threshold asks the reviewer to double-check. */
export const OCR_LOW_CONFIDENCE = 0.85;

/** Findings derived from how the text was obtained (not from its content). */
export function ocrFindings(ocr: OcrResult, qrPresent = false): Finding[] {
  const out: Finding[] = [];
  // When the AT QR code supplied the fiscal values, a weak OCR reading of the
  // surrounding text is no longer a risk worth the reviewer's attention.
  if (qrPresent && ocr.method !== "indisponivel") return out;
  if (ocr.method === "indisponivel") {
    out.push({
      code: "TEXTO_NAO_EXTRAIDO",
      severity: "aviso",
      message:
        "Não foi possível extrair texto do documento; classificação baseada apenas no nome do ficheiro." +
        (ocr.warnings.length ? ` (${ocr.warnings.join("; ")})` : ""),
    });
  } else if ((ocr.method === "tesseract" || ocr.method === "claude_visao") && ocr.confidence < OCR_LOW_CONFIDENCE) {
    out.push({
      code: "OCR_CONFIANCA_BAIXA",
      severity: "aviso",
      message: `Texto obtido por OCR (${ocr.method}) com confiança ${Math.round(ocr.confidence * 100)}%; confirme valores e NIFs contra o original.`,
      detail: { method: ocr.method, confidence: ocr.confidence },
    });
  }
  return out;
}

interface CompanyRow {
  id: number;
  nif: string;
  name: string;
  territory: "continente" | "acores" | "madeira";
}

async function analyse(
  db: Db,
  provider: AiProvider,
  deps: PipelineDeps,
  company: CompanyRow,
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<DocumentAnalysis> {
  return analyseDocument(buffer, mimeType, filename, company.nif, company.territory ?? "continente", {
    ocr: deps.ocr,
    provider,
    structured: deps.structured ?? null,
  });
}

/** Writes the proposal (if any) and the findings for an analysed document. */
function proposeAndAudit(
  db: Db,
  company: CompanyRow,
  documentId: number,
  a: DocumentAnalysis,
  opts: { replacePending: boolean }
): { entryId: number | null; status: string; findings: Finding[] } {
  const otherNif = counterpartyNif(a.extracted, company.nif);
  const counterparty = a.extracted.issuerName && otherNif && a.extracted.issuerNif === otherNif
    ? `${a.extracted.issuerName} (NIF ${otherNif})`
    : otherNif ? `NIF ${otherNif}` : "Terceiro por identificar";
  const profile = getProfile(db, company.id, otherNif);
  touchProfile(db, company.id, otherNif, a.extracted.issuerNif === otherNif ? a.extracted.issuerName : null);

  let entryId: number | null = null;
  let status = "classificado";
  const decided = db.prepare("SELECT id FROM entries WHERE document_id = ? AND status != 'pendente'").get(documentId) as any;
  if (!decided) {
    const pending = db.prepare("SELECT id FROM entries WHERE document_id = ? AND status = 'pendente'").get(documentId) as any;
    if (pending && opts.replacePending) db.prepare("DELETE FROM entries WHERE id = ?").run(pending.id);
    const proposal = a.extracted.docStatus === "A"
      ? null
      : proposeEntry(a.classification.docType, a.extracted, a.classification.confidence, counterparty, {
          preferredExpenseAccount: profile?.expenseAccount ?? null,
          preferredRevenueAccount: profile?.revenueAccount ?? null,
        });
    if (proposal) {
      const e = db
        .prepare(
          `INSERT INTO entries (document_id, company_id, entry_date, journal, description, lines_json, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(documentId, company.id, proposal.entryDate, proposal.journal, proposal.description, JSON.stringify(proposal.lines), proposal.confidence);
      entryId = Number(e.lastInsertRowid);
      status = "proposto";
      audit(db, null, "propose", "entry", entryId, `confianca ${proposal.confidence}${profile?.expenseAccount ? " conta aprendida " + profile.expenseAccount : ""}`);
    }
    db.prepare("UPDATE documents SET status = ? WHERE id = ?").run(status, documentId);
  } else {
    status = (db.prepare("SELECT status FROM documents WHERE id = ?").get(documentId) as any).status;
  }

  const auditCtx = buildAuditContext(db, company.id, a.extracted, documentId);
  auditCtx.divergences = a.divergences;
  auditCtx.qrCount = a.qrCount;
  const findings = [...ocrFindings(a.ocr, a.qr !== null), ...auditDocument(a.classification.docType as DocType, a.extracted, auditCtx)];
  persistDocumentFindings(db, company.id, documentId, findings);
  return { entryId, status, findings };
}

const outcomeOf = (documentId: number, a: DocumentAnalysis, r: { entryId: number | null; status: string; findings: Finding[] }): IngestOutcome => ({
  documentId,
  duplicate: false,
  docType: a.classification.docType,
  status: r.status,
  entryId: r.entryId,
  findings: r.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
  ocr: { method: a.ocr.method, confidence: a.ocr.confidence, pages: a.ocr.pages, warnings: a.ocr.warnings },
  sources: a.extracted.sources,
  qr: a.qr !== null,
});

export async function ingestDocument(
  db: Db,
  provider: AiProvider,
  storageRoot: string,
  input: IngestInput,
  ocr: OcrEngine,
  structured?: ClaudeStructuredExtractor | null
): Promise<IngestOutcome> {
  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");

  const existing = db
    .prepare("SELECT id, doc_type, status FROM documents WHERE company_id = ? AND sha256 = ?")
    .get(input.companyId, sha256) as any;
  if (existing) {
    return {
      documentId: existing.id,
      duplicate: true,
      docType: existing.doc_type,
      status: existing.status,
      entryId: null,
      findings: [],
      ocr: { method: "duplicado", confidence: 1, pages: 0, warnings: [] },
      sources: [],
      qr: false,
    };
  }

  const company = db.prepare("SELECT id, nif, name, territory FROM companies WHERE id = ?").get(input.companyId) as CompanyRow | undefined;
  if (!company) throw new Error("Empresa inexistente");

  const a = await analyse(db, provider, { ocr, structured }, company, input.buffer, input.mimeType, input.originalName);

  // Archive per DL 28/2019: empresa / ano / mes / tipo.
  const relDir = archivePath(input.companyId, a.extracted.docDate, a.classification.docType);
  fs.mkdirSync(path.join(storageRoot, relDir), { recursive: true });
  const safeName = `${sha256.slice(0, 12)}-${input.originalName.replace(/[^\w.\-]+/g, "_")}`;
  const relPath = path.join(relDir, safeName);
  fs.writeFileSync(path.join(storageRoot, relPath), input.buffer);

  const result = db
    .prepare(
      `INSERT INTO documents
         (company_id, uploader_id, original_name, stored_path, mime_type, size_bytes, sha256,
          channel, doc_type, doc_date, period, classification_confidence, classification_source,
          extracted_json, ocr_text, ocr_method, ocr_confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'classificado')`
    )
    .run(
      input.companyId, input.uploaderId, input.originalName, relPath, input.mimeType, input.buffer.length, sha256,
      input.channel ?? "portal", a.classification.docType, a.extracted.docDate,
      a.extracted.docDate ? a.extracted.docDate.slice(0, 7) : null,
      a.classification.confidence, a.classification.source, JSON.stringify(a.extracted),
      a.ocr.method === "texto" ? null : a.text || null, a.ocr.method, a.ocr.confidence
    );
  const documentId = Number(result.lastInsertRowid);
  audit(db, input.uploaderId, "upload", "document", documentId, `${input.originalName} via ${input.channel ?? "portal"}`);
  if (a.ocr.method !== "texto") {
    audit(db, null, "ocr", "document", documentId, `${a.ocr.method} conf=${a.ocr.confidence.toFixed(2)} pags=${a.ocr.pages}`);
  }
  if (a.qr) audit(db, null, "qr", "document", documentId, `ATCUD ${a.qr.atcud || "-"} ${a.qr.docType} ${a.qr.docNumber}`);

  const r = proposeAndAudit(db, company, documentId, a, { replacePending: false });

  // Fulfil a document request only when the upload targets it explicitly.
  if (input.requestId) {
    const updated = db
      .prepare("UPDATE doc_requests SET status = 'cumprido', fulfilled_document_id = ? WHERE id = ? AND company_id = ? AND status = 'pendente'")
      .run(documentId, input.requestId, input.companyId);
    if (updated.changes > 0) audit(db, input.uploaderId, "fulfil", "doc_request", input.requestId, `documento ${documentId}`);
  }

  return outcomeOf(documentId, a, r);
}

/**
 * Re-runs the full analysis on an already stored document (e.g. after
 * enabling a better OCR engine). Entries already decided are left
 * untouched; a pending proposal is replaced.
 */
export async function reprocessDocument(
  db: Db,
  provider: AiProvider,
  storageRoot: string,
  documentId: number,
  ocr: OcrEngine,
  structured?: ClaudeStructuredExtractor | null
): Promise<IngestOutcome> {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as any;
  if (!doc) throw new Error("Documento inexistente");
  const company = db.prepare("SELECT id, nif, name, territory FROM companies WHERE id = ?").get(doc.company_id) as CompanyRow;
  const buffer = fs.readFileSync(path.join(storageRoot, doc.stored_path));
  const a = await analyse(db, provider, { ocr, structured }, company, buffer, doc.mime_type, doc.original_name);
  db.prepare(
    `UPDATE documents SET doc_type = ?, doc_date = ?, period = ?, classification_confidence = ?, classification_source = ?,
       extracted_json = ?, ocr_text = ?, ocr_method = ?, ocr_confidence = ? WHERE id = ?`
  ).run(
    a.classification.docType, a.extracted.docDate, a.extracted.docDate ? a.extracted.docDate.slice(0, 7) : null,
    a.classification.confidence, a.classification.source, JSON.stringify(a.extracted),
    a.ocr.method === "texto" ? null : a.text || null, a.ocr.method, a.ocr.confidence, documentId
  );
  const r = proposeAndAudit(db, company, documentId, a, { replacePending: true });
  audit(db, null, "reprocess", "document", documentId, `${a.ocr.method} conf=${a.ocr.confidence.toFixed(2)} fontes=${a.extracted.sources.join("+")}`);
  return outcomeOf(documentId, a, r);
}
