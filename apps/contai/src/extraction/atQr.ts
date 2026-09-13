/**
 * Portuguese AT invoice QR code (Despacho n.º 412/2020-XXII, mandatory on
 * fiscally relevant documents since 2022). The payload is a list of
 * key:value pairs separated by '*'. Reading it gives exact, machine-issued
 * values for issuer/acquirer NIF, document type, date, number, ATCUD and
 * the VAT breakdown per rate: the most reliable extraction path available,
 * so it takes precedence over OCR when present.
 */

export interface AtQrData {
  issuerNif: string;          // A
  acquirerNif: string | null; // B ("999999990" = consumidor final)
  acquirerCountry: string;    // C
  docType: string;            // D (FT, FR, FS, NC, ND, RC, RG, GT...)
  status: string;             // E (N normal, A anulado, ...)
  date: string;               // F -> YYYY-MM-DD
  docNumber: string;          // G
  atcud: string;              // H
  taxSpace: string;           // I1 (PT, PT-AC, PT-MA, 0 = sem IVA)
  exemptBase: number;         // I2
  reducedBase: number;        // I3
  reducedVat: number;         // I4
  intermediateBase: number;   // I5
  intermediateVat: number;    // I6
  normalBase: number;         // I7
  normalVat: number;          // I8
  nonSubject: number;         // L
  stampDuty: number;          // M
  totalTaxes: number;         // N
  total: number;              // O
  withholding: number;        // P
  hash: string;               // Q
  certificate: string;        // R
  other: string | null;       // S
  raw: string;
}

const num = (v: string | undefined): number => {
  if (!v) return 0;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** Returns null when the text is not an AT QR payload. */
export function parseAtQr(payload: string): AtQrData | null {
  const text = payload.trim();
  if (!/^A:\d{9}\*B:/.test(text)) return null;
  const fields: Record<string, string> = {};
  for (const part of text.split("*")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    fields[part.slice(0, idx)] = part.slice(idx + 1);
  }
  const f = fields["F"] ?? "";
  const date = /^\d{8}$/.test(f) ? `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}` : "";
  if (!fields["A"] || !fields["D"] || !date || !fields["G"]) return null;
  const acquirer = fields["B"] && fields["B"] !== "999999990" ? fields["B"] : null;
  return {
    issuerNif: fields["A"]!,
    acquirerNif: acquirer,
    acquirerCountry: fields["C"] ?? "PT",
    docType: fields["D"]!,
    status: fields["E"] ?? "N",
    date,
    docNumber: fields["G"]!,
    atcud: fields["H"] ?? "",
    taxSpace: fields["I1"] ?? "PT",
    exemptBase: num(fields["I2"]),
    reducedBase: num(fields["I3"]),
    reducedVat: num(fields["I4"]),
    intermediateBase: num(fields["I5"]),
    intermediateVat: num(fields["I6"]),
    normalBase: num(fields["I7"]),
    normalVat: num(fields["I8"]),
    nonSubject: num(fields["L"]),
    stampDuty: num(fields["M"]),
    totalTaxes: num(fields["N"]),
    total: num(fields["O"]),
    withholding: num(fields["P"]),
    hash: fields["Q"] ?? "",
    certificate: fields["R"] ?? "",
    other: fields["S"] ?? null,
    raw: text,
  };
}

/** Consistency of the QR itself: bases + taxes must equal the total. */
export function atQrConsistency(q: AtQrData): { ok: boolean; expectedTotal: number; diff: number } {
  const bases = q.exemptBase + q.reducedBase + q.intermediateBase + q.normalBase + q.nonSubject;
  const taxes = q.reducedVat + q.intermediateVat + q.normalVat + q.stampDuty;
  const expectedTotal = Math.round((bases + taxes) * 100) / 100;
  const diff = Math.round((q.total - expectedTotal) * 100) / 100;
  return { ok: Math.abs(diff) <= 0.02, expectedTotal, diff };
}

/** Maps the AT document type code to the archive document type. */
export function atDocTypeToDocType(code: string, issuedByCompany: boolean): string {
  switch (code) {
    case "NC":
      return "nota_credito";
    case "RC":
    case "RG":
      return "recibo";
    case "GT":
    case "GR":
    case "GA":
      return "guia_transporte";
    case "FT":
    case "FR":
    case "FS":
    case "ND":
    default:
      return issuedByCompany ? "factura_venda" : "factura_compra";
  }
}

/**
 * Decodes QR codes found in an image (RGBA pixels). Returns AT payloads
 * only. Scans the full image and, for robustness on dense invoices, four
 * quadrants at higher effective resolution.
 */
export async function decodeAtQrFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Promise<AtQrData[]> {
  const mod: any = await import("jsqr");
  const jsQR: (d: Uint8ClampedArray, w: number, h: number, o?: any) => { data: string } | null =
    mod.default?.default ?? mod.default ?? mod;
  const found = new Map<string, AtQrData>();
  const tryDecode = (px: Uint8ClampedArray, w: number, h: number) => {
    const r = jsQR(px, w, h, { inversionAttempts: "dontInvert" });
    if (r?.data) {
      const parsed = parseAtQr(r.data);
      if (parsed) found.set(parsed.raw, parsed);
    }
  };
  tryDecode(data, width, height);
  if (found.size === 0 && width > 600 && height > 600) {
    const halfW = Math.floor(width / 2);
    const halfH = Math.floor(height / 2);
    for (const [ox, oy] of [[0, 0], [halfW, 0], [0, halfH], [halfW, halfH]] as const) {
      const w = Math.min(halfW + 100, width - ox);
      const h = Math.min(halfH + 100, height - oy);
      const crop = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const src = ((oy + y) * width + ox) * 4;
        crop.set(data.subarray(src, src + w * 4), y * w * 4);
      }
      tryDecode(crop, w, h);
      if (found.size) break;
    }
  }
  return [...found.values()];
}
