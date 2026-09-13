// Gera os icones PNG da web app a partir do mesmo desenho do icon.svg (sem depender de fontes do sistema).
import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs";
function draw(size, maskable) {
  const c = createCanvas(size, size), ctx = c.getContext("2d");
  const pad = maskable ? size * 0.1 : 0, s = size - pad * 2, r = maskable ? 0 : s * 0.22;
  const g = ctx.createLinearGradient(0, 0, size, size); g.addColorStop(0, "#d4b58c"); g.addColorStop(1, "#8f6d47");
  ctx.fillStyle = g;
  if (maskable) ctx.fillRect(0, 0, size, size); else { ctx.beginPath(); ctx.roundRect(pad, pad, s, s, r); ctx.fill(); }
  const k = s / 128;
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 12 * k; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(pad + 64 * k, pad + 64 * k, 26 * k, 0.72, Math.PI * 2 - 0.72); ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(pad + 92 * k, pad + 86 * k, 6 * k, 0, Math.PI * 2); ctx.fill();
  return c.toBuffer("image/png");
}
fs.writeFileSync("public/icon-192.png", draw(192, false));
fs.writeFileSync("public/icon-512.png", draw(512, false));
fs.writeFileSync("public/icon-maskable-512.png", draw(512, true));
console.log("icones gerados");
