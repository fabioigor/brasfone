const PDFDocument = require('pdfkit'); const QRCode = require('qrcode'); const fs = require('fs');
const URL = process.argv[2] || 'https://inubia-roi-capi.vercel.app/qr/';
const mm = (v) => v * 72 / 25.4;
const NAVY = '#0A1628', BLUE = '#1D3DF5', GREEN = '#22A657', INK = '#F5F6FA', MUTED = '#B8C4DA', LIGHT = '#F5F6FA', DARK = '#0A1628';
const path = require('path'); const LOGO_WHITE = path.join(__dirname, '..', 'server', 'assets', 'inubia-logo-white.png'); const OUT = path.join(__dirname, 'autocolantes'); process.chdir(__dirname);
const qr = QRCode.create(URL, { errorCorrectionLevel: 'M' });
const N = qr.modules.size, bits = qr.modules.data;

function drawQR(doc, x, y, size, fg, bg) {
  const cell = size / N;
  doc.save().rect(x, y, size, size).fill(bg);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (bits[r * N + c]) doc.rect(x + c * cell, y + r * cell, cell + 0.15, cell + 0.15).fill(fg);
  doc.restore();
}

/** One 60x60 mm sticker drawn at (ox, oy) with `bleed` mm around it. variant: 'dark' | 'light' */
function sticker(doc, ox, oy, variant, bleed) {
  const S = mm(60), B = mm(bleed);
  const dark = variant === 'dark';
  doc.save();
  doc.roundedRect(ox - B, oy - B, S + 2 * B, S + 2 * B, bleed ? 0 : mm(3)).fill(dark ? NAVY : '#FFFFFF');
  // logo: white logo, on a navy chip in the light variant
  const lw = mm(22), lh = lw * 151 / 720;
  if (!dark) doc.roundedRect(ox + mm(3), oy + mm(3), lw + mm(3), lh + mm(2.4), mm(1.5)).fill(NAVY);
  doc.image(LOGO_WHITE, ox + mm(4.5), oy + mm(4.2), { width: lw });
  doc.font('Helvetica-Bold').fontSize(5.2).fillColor(dark ? GREEN : BLUE)
    .text('SOCIAL MEDIA\nHACKATHON', ox + mm(33), oy + mm(4.2), { width: mm(23), align: 'right', lineGap: 0.4 });
  // headline
  doc.font('Helvetica-Bold').fontSize(8.6).fillColor(dark ? INK : DARK)
    .text('Quantos clientes perde entre o anúncio e o fecho?', ox + mm(4), oy + mm(11.2), { width: mm(52), lineGap: 0.4 });
  // QR: 29 mm of modules inside a 33 mm white panel (quiet zone 2 mm)
  const panel = mm(33), qs = mm(29), px = ox + (S - panel) / 2, py = oy + mm(19.2);
  if (dark) doc.roundedRect(px, py, panel, panel, mm(1.5)).fill('#FFFFFF');
  drawQR(doc, px + (panel - qs) / 2, py + (panel - qs) / 2, qs, DARK, '#FFFFFF');
  // footer
  doc.font('Helvetica-Bold').fontSize(6.4).fillColor(GREEN)
    .text('Aponte a câmara: 60 segundos e vê o seu ROI', ox + mm(3), oy + mm(53.2), { width: mm(54), align: 'center' });
  doc.font('Helvetica').fontSize(4.6).fillColor(dark ? MUTED : '#5a6a7e')
    .text('INUBIA · Grupo Brasfone · Pipedrive + Meta CAPI', ox + mm(3), oy + mm(56.4), { width: mm(54), align: 'center' });
  doc.restore();
}

function cropMarks(doc, x, y, w, h) {
  const L = mm(3), G = mm(1.5);
  doc.save().lineWidth(0.25).strokeColor('#000');
  for (const [cx, cy, dx, dy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]) {
    doc.moveTo(cx + dx * G, cy).lineTo(cx + dx * (G + L), cy).stroke();
    doc.moveTo(cx, cy + dy * G).lineTo(cx, cy + dy * (G + L)).stroke();
  }
  doc.restore();
}

// 1. Single stickers with 3 mm bleed (66x66 mm pages), one per variant
for (const variant of ['dark', 'light']) {
  const doc = new PDFDocument({ size: [mm(66), mm(66)], margin: 0, info: { Title: `Autocolante QR 60x60 mm (${variant})`, Author: 'INUBIA · Grupo Brasfone' } });
  doc.pipe(fs.createWriteStream(`autocolantes/autocolante-qr-60x60-${variant}.pdf`));
  sticker(doc, mm(3), mm(3), variant, 3);
  cropMarks(doc, mm(3), mm(3), mm(60), mm(60));
  doc.end();
}
// 2. A4 sheet: 3 x 4 = 12 stickers with crop marks, alternating rows dark/light, plus an all-dark sheet
for (const [name, pick] of [['folha-a4-12-mista', (r) => (r % 2 ? 'light' : 'dark')], ['folha-a4-12-dark', () => 'dark'], ['folha-a4-12-light', () => 'light']]) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Folha A4 de autocolantes QR 60x60 mm (${name})`, Author: 'INUBIA · Grupo Brasfone' } });
  doc.pipe(fs.createWriteStream(`autocolantes/${name}.pdf`));
  const cols = 3, rows = 4, S = mm(60), gap = mm(6);
  const x0 = (mm(210) - (cols * S + (cols - 1) * gap)) / 2, y0 = (mm(297) - (rows * S + (rows - 1) * gap)) / 2;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c * (S + gap), y = y0 + r * (S + gap);
    sticker(doc, x, y, pick(r), 0);
    cropMarks(doc, x, y, S, S);
  }
  doc.font('Helvetica').fontSize(7).fillColor('#666').text(`Autocolantes 60 x 60 mm · corte pelas marcas · QR: ${URL}`, mm(10), mm(292), { width: mm(190), align: 'center' });
  doc.end();
}
// 3. QR only, as PNG and SVG, for the designer
QRCode.toFile('autocolantes/qr-inubia-roi.png', URL, { errorCorrectionLevel: 'M', width: 1200, margin: 4, color: { dark: '#0A1628', light: '#FFFFFF' } });
QRCode.toFile('autocolantes/qr-inubia-roi.svg', URL, { errorCorrectionLevel: 'M', margin: 4, color: { dark: '#0A1628', light: '#FFFFFF' } });
console.log('modules', N, 'url', URL);
