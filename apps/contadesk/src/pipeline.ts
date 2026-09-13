/**
 * Document processing pipeline:
 *   recebido -> classificado -> proposto (entry pending validation)
 * The pipeline never approves anything: every proposal waits for a human
 * decision in the validation queue.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Db, audit } from "./db.js";
import { AiProvider } from "./ai/provider.js";
import { archivePath } from "./domain/classification.js";
import { proposeEntry } from "./domain/entries.js";
import { auditDocument, buildAuditContext, persistDocumentFindings, Finding } from "./domain/vatAudit.js";
import { OcrEngine, OcrResult } from "./ocr/engine.js";

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
}

/** OCR confidence below this threshold asks the reviewer to double-check. */
export const OCR_LOW_CONFIDENCE = 0.85;

/** Findings derived from how the text was obtained (not from its content). */
export function ocrFindings(ocr: OcrResult): Finding[] {
  const out: Finding[] = [];
  if (ocr.method === "indisponivel") {
    out.push({
      code: "TEXTO_NAO_EXTRAIDO",
      severity: "aviso",
      message: "Não foi possível extrair texto do documento; classificação baseada apenas no nome do ficheiro." + (ocr.warnings.length ? ` (${ocr.warnings.join("; ")})` : ""),
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

export async function ingestDocument(
  db: Db,
  provider: AiProvider,
  storageRoot: string,
  input: IngestInput,
  ocr: OcrEngine
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
    };
  }

  const company = db.prepare("SELECT id, nif, name FROM companies WHERE id = ?").get(input.companyId) as any;
  if (!company) throw new Error("Empresa inexistente");

  const ocrResult = await ocr.extract(input.buffer, input.mimeType, input.originalName);
  const text = ocrResult.text;
  const { extracted, classification } = await provider.analyseDocument(
    text,
    input.originalName,
    company.nif
  );

  // Archive per DL 28/2019: empresa / ano / mes / tipo.
  const relDir = archivePath(input.companyId, extracted.docDate, classification.docType);
  const absDir = path.join(storageRoot, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  const safeName = `${sha256.slice(0, 12)}-${input.originalName.replace(/[^\w.\-]+/g, "_")}`;
  const relPath = path.join(relDir, safeName);
  fs.writeFileSync(path.join(storageRoot, relPath), input.buffer);

  const period = extracted.docDate ? extracted.docDate.slice(0, 7) : null;

  const result = db
    .prepare(
      `INSERT INTO documents
         (company_id, uploader_id, original_name, stored_path, mime_type, size_bytes, sha256,
          channel, doc_type, doc_date, period, classification_confidence, classification_source,
          extracted_json, ocr_text, ocr_method, ocr_confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'classificado')`
    )
    .run(
      input.companyId,
      input.uploaderId,
      input.originalName,
      relPath,
      input.mimeType,
      input.buffer.length,
      sha256,
      input.channel ?? "portal",
      classification.docType,
      extracted.docDate,
      period,
      classification.confidence,
      classification.source,
      JSON.stringify(extracted),
      ocrResult.method === "texto" ? null : text || null,
      ocrResult.method,
      ocrResult.confidence
    );
  const documentId = Number(result.lastInsertRowid);
  if (ocrResult.method !== "texto") {
    audit(db, null, "ocr", "document", documentId, `${ocrResult.method} conf=${ocrResult.confidence.toFixed(2)} pags=${ocrResult.pages}`);
  }
  audit(db, input.uploaderId, "upload", "document", documentId, input.originalName);

  // Counterparty label: another NIF on the document that is not the company's.
  const otherNif = extracted.nifs.find((n) => n !== company.nif);
  const counterparty = otherNif ? `NIF ${otherNif}` : "Terceiro por identificar";

  let entryId: number | null = null;
  let status = "classificado";
  const proposal = proposeEntry(
    classification.docType,
    extracted,
    classification.confidence,
    counterparty
  );
  if (proposal) {
    const e = db
      .prepare(
        `INSERT INTO entries (document_id, company_id, entry_date, journal, description, lines_json, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        documentId,
        input.companyId,
        proposal.entryDate,
        proposal.journal,
        proposal.description,
        JSON.stringify(proposal.lines),
        proposal.confidence
      );
    entryId = Number(e.lastInsertRowid);
    status = "proposto";
    db.prepare("UPDATE documents SET status = 'proposto' WHERE id = ?").run(documentId);
    audit(db, null, "propose", "entry", entryId, `confianca ${proposal.confidence}`);
  }

  // Conferencia automatica do documento (IVA, coerencia, duplicados).
  const auditCtx = buildAuditContext(db, input.companyId, extracted, documentId);
  const findings = [...ocrFindings(ocrResult), ...auditDocument(classification.docType, extracted, auditCtx)];
  persistDocumentFindings(db, input.companyId, documentId, findings);

  // Fulfil a document request only when the upload targets it explicitly.
  if (input.requestId) {
    const updated = db
      .prepare(
        "UPDATE doc_requests SET status = 'cumprido', fulfilled_document_id = ? WHERE id = ? AND company_id = ? AND status = 'pendente'"
      )
      .run(documentId, input.requestId, input.companyId);
    if (updated.changes > 0) {
      audit(db, input.uploaderId, "fulfil", "doc_request", input.requestId, `documento ${documentId}`);
    }
  }

  return {
    documentId,
    duplicate: false,
    docType: classification.docType,
    status,
    entryId,
    findings: findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
    ocr: { method: ocrResult.method, confidence: ocrResult.confidence, pages: ocrResult.pages, warnings: ocrResult.warnings },
  };
}

/**
 * Re-runs OCR + classification + audit on an already stored document
 * (e.g. after enabling a better OCR engine). Entries already decided are
 * left untouched; a pending proposal is replaced.
 */
export async function reprocessDocument(db: Db, provider: AiProvider, storageRoot: string, documentId: number, ocr: OcrEngine): Promise<IngestOutcome> {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as any;
  if (!doc) throw new Error("Documento inexistente");
  const company = db.prepare("SELECT nif FROM companies WHERE id = ?").get(doc.company_id) as any;
  const buffer = fs.readFileSync(path.join(storageRoot, doc.stored_path));
  const ocrResult = await ocr.extract(buffer, doc.mime_type, doc.original_name);
  const { extracted, classification } = await provider.analyseDocument(ocrResult.text, doc.original_name, company.nif);
  db.prepare(
    `UPDATE documents SET doc_type = ?, doc_date = ?, period = ?, classification_confidence = ?, classification_source = ?,
       extracted_json = ?, ocr_text = ?, ocr_method = ?, ocr_confidence = ? WHERE id = ?`
  ).run(
    classification.docType, extracted.docDate, extracted.docDate ? extracted.docDate.slice(0, 7) : null,
    classification.confidence, classification.source, JSON.stringify(extracted),
    ocrResult.method === "texto" ? null : ocrResult.text || null, ocrResult.method, ocrResult.confidence, documentId
  );
  let entryId: number | null = null;
  const pending = db.prepare("SELECT id FROM entries WHERE document_id = ? AND status = 'pendente'").get(documentId) as any;
  const decided = db.prepare("SELECT id FROM entries WHERE document_id = ? AND status != 'pendente'").get(documentId) as any;
  if (!decided) {
    const otherNif = extracted.nifs.find((n) => n !== company.nif);
    const proposal = proposeEntry(classification.docType, extracted, classification.confidence, otherNif ? `NIF ${otherNif}` : "Terceiro por identificar");
    if (pending) db.prepare("DELETE FROM entries WHERE id = ?").run(pending.id);
    if (proposal) {
      const e = db
        .prepare("INSERT INTO entries (document_id, company_id, entry_date, journal, description, lines_json, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(documentId, doc.company_id, proposal.entryDate, proposal.journal, proposal.description, JSON.stringify(proposal.lines), proposal.confidence);
      entryId = Number(e.lastInsertRowid);
      db.prepare("UPDATE documents SET status = 'proposto' WHERE id = ?").run(documentId);
    } else {
      db.prepare("UPDATE documents SET status = 'classificado' WHERE id = ?").run(documentId);
    }
  }
  const auditCtx = buildAuditContext(db, doc.company_id, extracted, documentId);
  const findings = [...ocrFindings(ocrResult), ...auditDocument(classification.docType, extracted, auditCtx)];
  persistDocumentFindings(db, doc.company_id, documentId, findings);
  audit(db, null, "reprocess", "document", documentId, `${ocrResult.method} conf=${ocrResult.confidence.toFixed(2)}`);
  return {
    documentId, duplicate: false, docType: classification.docType,
    status: (db.prepare("SELECT status FROM documents WHERE id = ?").get(documentId) as any).status,
    entryId,
    findings: findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
    ocr: { method: ocrResult.method, confidence: ocrResult.confidence, pages: ocrResult.pages, warnings: ocrResult.warnings },
  };
}
