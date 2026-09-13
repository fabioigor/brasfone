/**
 * Extraction of structured data from document text (invoices, receipts,
 * bank statements). Heuristic engine used as the default provider; an AI
 * provider can replace it behind the same interface (see src/ai/provider.ts).
 */

export interface LineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
}

export interface ExtractedData {
  nifs: string[];
  items: LineItem[];
  issuerNif: string | null;
  docNumber: string | null;
  docDate: string | null; // YYYY-MM-DD
  totalAmount: number | null;
  vatAmount: number | null;
  vatRate: number | null; // 6 | 13 | 23
  netAmount: number | null;
  currency: string;
}

/** Validates a Portuguese NIF using the check digit algorithm. */
export function isValidNif(nif: string): boolean {
  if (!/^\d{9}$/.test(nif)) return false;
  const first = Number(nif[0]);
  if (![1, 2, 3, 5, 6, 7, 8, 9].includes(first)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(nif[i]) * (9 - i);
  const mod = sum % 11;
  const check = mod < 2 ? 0 : 11 - mod;
  return check === Number(nif[8]);
}

function parseAmount(raw: string): number | null {
  // Accepts "1.234,56", "1234.56", "1 234,56"
  let s = raw.replace(/\s/g, "").replace(/€/g, "");
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function normalizeDate(raw: string): string | null {
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const d = m[1]!.padStart(2, "0");
    const mo = m[2]!.padStart(2, "0");
    if (Number(mo) > 12 || Number(d) > 31) return null;
    return `${m[3]}-${mo}-${d}`;
  }
  return null;
}

const AMOUNT = String.raw`(\d{1,3}(?:[\s.]\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)`;

/**
 * Parses tabular line items such as
 *   "Farinha tipo 65 (saco 25kg)         10    18,50"
 * (description, quantity, unit price separated by 2+ spaces). Lines that
 * look like totals/headers are ignored.
 */
export function extractLineItems(text: string): LineItem[] {
  const items: LineItem[] = [];
  const skip = /^(descri|total|iva|incid|base|subtotal|qtd|quant|data|nif|factura|fatura|recibo|cliente)/i;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    // Two or more spaces separate columns in text exports; OCR output often
    // collapses them to one, so the tail "qty price" anchors the match.
    const m =
      line.match(/^(.+?\S)\s{2,}(\d+(?:[.,]\d+)?)\s+(\d{1,3}(?:[\s.]\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)\s*$/) ??
      line.match(/^([A-Za-zÀ-ÿ].+?\S)\s+(\d+(?:[.,]\d+)?)\s+(\d{1,3}(?:\.\d{3})*,\d{2}|\d+\.\d{2})\s*$/);
    if (!m) continue;
    const description = m[1]!.trim();
    if (skip.test(description) || description.length < 3) continue;
    const quantity = Number(m[2]!.replace(",", "."));
    const unitPrice = parseAmount(m[3]!);
    const lineTotal = unitPrice !== null && Number.isFinite(quantity) ? Math.round(quantity * unitPrice * 100) / 100 : null;
    items.push({ description, quantity: Number.isFinite(quantity) ? quantity : null, unitPrice, lineTotal });
  }
  return items;
}

export function extractFromText(text: string): ExtractedData {
  const nifs: string[] = [];
  for (const m of text.matchAll(/(?:NIF|NIPC|Contribuinte|Cliente)[:\s]*?(\d{9})/gi)) {
    if (isValidNif(m[1]!) && !nifs.includes(m[1]!)) nifs.push(m[1]!);
  }
  for (const m of text.matchAll(/\b(\d{9})\b/g)) {
    if (isValidNif(m[1]!) && !nifs.includes(m[1]!)) nifs.push(m[1]!);
  }

  // Issuer NIF: the first NIF that appears near the top of the document.
  const issuerNif = nifs.length > 0 ? nifs[0]! : null;

  let docNumber: string | null = null;
  const numMatch = text.match(
    /\b(?:FT|FR|FS|NC|ND|RC|RG)\s*[A-Z0-9]*\s*(?:n\.?º?\s*)?([A-Z0-9]+[\/\-]\d+)/i
  );
  if (numMatch) docNumber = numMatch[0].replace(/\s+/g, " ").trim();

  let docDate: string | null = null;
  const dateMatch = text.match(
    /(?:Data(?:\s+de\s+emiss[aã]o)?)[:\s]*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i
  );
  if (dateMatch) docDate = normalizeDate(dateMatch[1]!);
  if (!docDate) {
    const any = text.match(/\b(\d{4}-\d{2}-\d{2})\b/) ?? text.match(/\b(\d{2}[\/\-.]\d{2}[\/\-.]\d{4})\b/);
    if (any) docDate = normalizeDate(any[1]!);
  }

  let totalAmount: number | null = null;
  const totalMatch = text.match(new RegExp(String.raw`Total(?:\s+a\s+pagar)?[:\s]*` + AMOUNT, "i"));
  if (totalMatch) totalAmount = parseAmount(totalMatch[1]!);

  let vatAmount: number | null = null;
  const vatMatch = text.match(new RegExp(String.raw`(?:IVA|Imposto)[^\d%]*(?:\(?\s*(\d{1,2})\s*%\s*\)?)?[:\s]*` + AMOUNT, "i"));
  let vatRate: number | null = null;
  if (vatMatch) {
    vatAmount = parseAmount(vatMatch[2]!);
    if (vatMatch[1]) vatRate = Number(vatMatch[1]);
  }
  const rateMatch = text.match(/(\d{1,2})\s*%/);
  if (vatRate === null && rateMatch && [6, 13, 23].includes(Number(rateMatch[1]))) {
    vatRate = Number(rateMatch[1]);
  }

  let netAmount: number | null = null;
  const netMatch = text.match(
    new RegExp(String.raw`(?:Incid[eê]ncia|Base\s+tribut[aá]vel|Subtotal|Total\s+l[ií]quido)[:\s]*` + AMOUNT, "i")
  );
  if (netMatch) netAmount = parseAmount(netMatch[1]!);

  // Derive the missing member of net + vat = total when two are known.
  if (totalAmount !== null && vatAmount !== null && netAmount === null) {
    netAmount = Math.round((totalAmount - vatAmount) * 100) / 100;
  } else if (netAmount !== null && vatAmount !== null && totalAmount === null) {
    totalAmount = Math.round((netAmount + vatAmount) * 100) / 100;
  } else if (totalAmount !== null && netAmount !== null && vatAmount === null) {
    vatAmount = Math.round((totalAmount - netAmount) * 100) / 100;
  }

  // Infer the VAT rate from the amounts when not explicit.
  if (vatRate === null && netAmount !== null && vatAmount !== null && netAmount > 0) {
    const ratio = (vatAmount / netAmount) * 100;
    for (const r of [23, 13, 6]) {
      if (Math.abs(ratio - r) < 0.5) {
        vatRate = r;
        break;
      }
    }
  }

  return {
    nifs,
    items: extractLineItems(text),
    issuerNif,
    docNumber,
    docDate,
    totalAmount,
    vatAmount,
    vatRate,
    netAmount,
    currency: "EUR",
  };
}
