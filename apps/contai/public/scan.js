/* Cont.ai - digitalizacao no telemovel: melhoria de imagem no browser e escrita de PDF sem dependencias.
   Exposto em window.ContaiScan (browser) ou globalThis.ContaiScan (testes em Node). */
(function (root) {
  "use strict";

  /** Estatisticas de luminancia para esticar o contraste (percentis 1 e 99). */
  function levels(data) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) hist[(data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0]++;
    const total = data.length / 4; let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
    return { lo, hi: Math.max(hi, lo + 1) };
  }

  /** Limiar de Otsu sobre a luminancia (para preto e branco). */
  function otsu(data) {
    const hist = new Uint32Array(256); let n = 0;
    for (let i = 0; i < data.length; i += 4) { hist[(data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0]++; n++; }
    let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v]; if (!wB) continue; const wF = n - wB; if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = v; }
    }
    return thr;
  }

  /**
   * Aplica o modo de melhoria a um ImageData: "cor" (so contraste), "cinza" (cinzentos + contraste),
   * "pb" (preto e branco por Otsu). Devolve o mesmo objecto, alterado.
   */
  function enhance(imageData, mode) {
    const d = imageData.data;
    if (mode === "pb") {
      const t = otsu(d);
      for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; const v = y > t ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
      return imageData;
    }
    const { lo, hi } = levels(d); const k = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      if (mode === "cinza") {
        const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; const v = Math.max(0, Math.min(255, (y - lo) * k));
        d[i] = d[i + 1] = d[i + 2] = v;
      } else {
        d[i] = Math.max(0, Math.min(255, (d[i] - lo) * k)); d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] - lo) * k)); d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] - lo) * k));
      }
    }
    return imageData;
  }

  /**
   * Escreve um PDF com uma pagina A4 (retrato ou paisagem conforme a imagem) por JPEG, imagem ajustada com margens.
   * pages: [{ bytes: Uint8Array (JPEG), width, height }]. Devolve Uint8Array.
   */
  function jpegsToPdf(pages, meta) {
    const enc = new TextEncoder();
    const parts = []; const offsets = []; let length = 0;
    const push = (s) => { const b = typeof s === "string" ? enc.encode(s) : s; parts.push(b); length += b.length; };
    const obj = (id, body) => { offsets[id] = length; push(`${id} 0 obj\n`); push(body); push("\nendobj\n"); };
    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    const n = pages.length; const kids = [];
    // 1 catalog, 2 pages, 3 info; depois por pagina: page, image, content
    const firstPage = 4;
    for (let i = 0; i < n; i++) kids.push(`${firstPage + i * 3} 0 R`);
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`);
    const esc = (s) => String(s || "").replace(/[()\\]/g, "\\$&");
    obj(3, `<< /Producer (Cont.ai by Lumarcont) /Title (${esc(meta && meta.title)}) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z) >>`);
    for (let i = 0; i < n; i++) {
      const p = pages[i]; const pid = firstPage + i * 3, iid = pid + 1, cid = pid + 2;
      const landscape = p.width > p.height; const W = landscape ? 841.89 : 595.28, H = landscape ? 595.28 : 841.89, m = 18;
      const scale = Math.min((W - 2 * m) / p.width, (H - 2 * m) / p.height);
      const w = p.width * scale, h = p.height * scale, x = (W - w) / 2, y = (H - h) / 2;
      const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;
      obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
      offsets[iid] = length;
      push(`${iid} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
      push(p.bytes); push("\nendstream\nendobj\n");
      obj(cid, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }
    const xref = length; const count = firstPage + n * 3;
    push(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id++) push(String(offsets[id]).padStart(10, "0") + " 00000 n \n");
    push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length); let o = 0;
    for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }

  /** Limite do lado maior das fotografias enviadas (bom para OCR, leve para a rede). */
  const MAX_SIDE = 2200;

  /**
   * Browser: prepara uma pagina a partir de um Blob de imagem: redimensiona, roda (graus) e melhora.
   * Devolve { bytes, width, height, dataUrl } com JPEG de qualidade 0.86.
   */
  async function preparePage(blob, opts) {
    const mode = (opts && opts.mode) || "cor", rotation = ((opts && opts.rotation) || 0) % 360;
    const bmp = await createImageBitmap(blob);
    let sw = bmp.width, sh = bmp.height; const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    sw = Math.round(sw * k); sh = Math.round(sh * k);
    const rot = rotation === 90 || rotation === 270;
    const c = document.createElement("canvas"); c.width = rot ? sh : sw; c.height = rot ? sw : sh;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate((rotation * Math.PI) / 180); ctx.drawImage(bmp, -sw / 2, -sh / 2, sw, sh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (mode !== "original") ctx.putImageData(enhance(ctx.getImageData(0, 0, c.width, c.height), mode), 0, 0);
    bmp.close && bmp.close();
    const out = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.86));
    return { bytes: new Uint8Array(await out.arrayBuffer()), width: c.width, height: c.height, blob: out };
  }

  root.ContaiScan = { enhance, jpegsToPdf, preparePage, levels, otsu, MAX_SIDE };
})(typeof window !== "undefined" ? window : globalThis);
