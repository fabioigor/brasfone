/**
 * Image preparation for OCR and QR decoding with @napi-rs/canvas:
 * decode to RGBA pixels, upscale small photos, convert to grayscale and
 * binarise with Otsu's threshold. Photos taken with a phone gain several
 * points of Tesseract confidence with this alone.
 */

export interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export async function decodeImage(buffer: Buffer): Promise<Raster> {
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  return { data: id.data as unknown as Uint8ClampedArray, width: img.width, height: img.height };
}

function otsuThreshold(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const g of gray) hist[g]!++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/**
 * Produces a cleaned PNG for Tesseract: upscaled to at least `minWidth`,
 * grayscale, Otsu-binarised. Returns the original when it is already large
 * and high-contrast, to avoid degrading good scans.
 */
export async function prepareForOcr(buffer: Buffer, minWidth = 1600): Promise<Buffer> {
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const img = await loadImage(buffer);
  const scale = img.width < minWidth ? Math.min(3, minWidth / img.width) : 1;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const px = id.data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000;
  }
  // Skip binarisation for images that are already clean black-on-white.
  let dark = 0, light = 0;
  for (const g of gray) { if (g < 60) dark++; else if (g > 200) light++; }
  const clean = (dark + light) / gray.length > 0.97;
  if (!clean) {
    const t = otsuThreshold(gray);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = gray[j]! > t ? 255 : 0;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }
  return canvas.toBuffer("image/png");
}
