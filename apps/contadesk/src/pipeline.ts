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
import { auditDocument, buildAuditContext, persistDocumentFindings } from "./domain/vatAudit.js";

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
}

const TEXT_MIME = /^(text\/|application\/(json|xml|csv))/;

function extractText(buffer: Buffer, mimeType: string, originalName: string): string {
  if (TEXT_MIME.test(mimeType) || /\.(txt|csv|xml|json)$/i.test(originalName)) {
    return buffer.toString("utf8");
  }
  // Binary formats (PDF/images) are not parsed in v1: classification falls
  // back to the filename and the reviewer fills in the details.
  return "";
}

export async function ingestDocument(
  db: Db,
  provider: AiProvider,
  storageRoot: string,
  input: IngestInput
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
    };
  }

  const company = db.prepare("SELECT id, nif, name FROM companies WHERE id = ?").get(input.companyId) as any;
  if (!company) throw new Error("Empresa inexistente");

  const text = extractText(input.buffer, input.mimeType, input.originalName);
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
          extracted_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'classificado')`
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
      JSON.stringify(extracted)
    );
  const documentId = Number(result.lastInsertRowid);
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
  const findings = auditDocument(classification.docType, extracted, auditCtx);
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
  };
}
