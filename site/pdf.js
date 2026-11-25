// Builds the branded transcript PDF on this device. Nothing is uploaded: the PDF library
// and fonts are part of the app, and the finished file goes straight to the Downloads folder.

import { clock } from './transcript.js';

const A4 = [595.28, 841.89];
const MARGIN = 56;
const BOTTOM = 70;
const HEX = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const C = {
  teal: '#1f4b55', sage: '#9cc2b6', cream: '#f6f3ec', ink: '#1b2a2f', muted: '#5b6d72', line: '#dde6e3',
  // One soft colour per person: [bar and name, text]
  people: [['#1f4b55', '#1c3f47'], ['#7a5570', '#54394d'], ['#7d6a35', '#564a26']],
};

let libs = null;
async function load() {
  if (libs) return libs;
  // Both libraries are self-contained classic builds: they register themselves as
  // globalThis.PDFLib and globalThis.fontkit.
  const [, , regular, semibold, title, mark] = await Promise.all([
    import('./vendor/pdf-lib.min.js'),
    import('./vendor/fontkit.umd.min.js'),
    fetch('fonts/pdf/Inter-Regular.ttf').then((r) => r.arrayBuffer()),
    fetch('fonts/pdf/Inter-SemiBold.ttf').then((r) => r.arrayBuffer()),
    fetch('pdf-title.json').then((r) => r.json()), // the heading, pre-drawn as shapes
    fetch('mark.svg').then((r) => r.text()),
  ]);
  libs = { pdfLib: globalThis.PDFLib, fontkit: globalThis.fontkit, regular, semibold, title, monogram: (mark.match(/<path d="([^"]+)"/) || [])[1] || '' };
  return libs;
}

function wrap(text, font, size, width) {
  const lines = [];
  let line = '';
  const fits = (s) => font.widthOfTextAtSize(s, size) <= width;
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (!fits(word)) { // a single very long "word": break it
      let cut = word.length - 1;
      while (cut > 1 && !fits(word.slice(0, cut))) cut--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {{lines:{time:number,person:number,name:string,text:string}[], labelled:boolean, names:string[],
 *          showTimes:boolean, recording:string, footerName:string}} data
 * @returns {Promise<Uint8Array>}
 */
export async function makePdf(data) {
  const { pdfLib, fontkit, regular, semibold, title, monogram } = await load();
  const { PDFDocument, rgb } = pdfLib;
  const col = (hex) => rgb(...HEX(hex));

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // Whole fonts are embedded: the library's space-saving "subset" option drops letters with this font.
  const fReg = await doc.embedFont(regular);
  const fBold = await doc.embedFont(semibold);

  const footer = data.footerName ? `${clean(data.footerName)} – private and confidential` : 'Private and confidential';
  const made = new Date();
  doc.setTitle('Session transcript');
  doc.setSubject('Private and confidential');
  if (data.footerName) doc.setAuthor(clean(data.footerName));
  doc.setCreator('Session Transcriber');
  doc.setProducer('Session Transcriber');
  doc.setCreationDate(made);

  const width = A4[0] - 2 * MARGIN;
  let page = doc.addPage(A4);
  let y = A4[1] - MARGIN;
  const newPage = () => { page = doc.addPage(A4); y = A4[1] - MARGIN; };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };

  // ----- heading -----
  const R = 22;
  const cx = MARGIN + R;
  const cy = y - R;
  page.drawCircle({ x: cx, y: cy, size: R, color: col(C.teal) });
  page.drawCircle({ x: cx, y: cy, size: R * (49 / 58), borderColor: col(C.sage), borderWidth: 0.7 });
  if (monogram) page.drawSvgPath(monogram, { x: cx - R * (60 / 58), y: cy + R * (60 / 58), scale: R / 58, color: col(C.cream) });
  page.drawSvgPath(title.d, { x: MARGIN + 2 * R + 14 - title.left * 0.21, y: y - 20, scale: 0.21, color: col(C.teal) }); // 21 pt
  page.drawText('PRIVATE AND CONFIDENTIAL', { x: MARGIN + 2 * R + 14, y: y - 36, size: 7.5, font: fBold, color: col(C.muted), characterSpacing: 1.2 });
  y -= 2 * R + 16;

  const meta = [
    ['Recording', clean(data.recording) || 'Not stated'],
    ['Transcribed', made.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })],
  ];
  if (data.labelled) meta.push(['In the room', data.names.map(clean).join(', ')]);
  for (const [label, value] of meta) {
    page.drawText(label, { x: MARGIN, y, size: 8.5, font: fBold, color: col(C.muted) });
    const rows = wrap(value, fReg, 8.5, width - 70);
    rows.forEach((row, i) => page.drawText(row, { x: MARGIN + 70, y: y - i * 12, size: 8.5, font: fReg, color: col(C.ink) }));
    y -= 12 * rows.length + 1;
  }
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + width, y }, thickness: 0.8, color: col(C.sage) });
  y -= 22;

  // ----- transcript -----
  const SIZE = 10.5;
  const LEAD = 15.5;
  for (const line of data.lines) {
    const text = clean(line.text);
    if (!text) continue;
    if (data.labelled) {
      const [bar, ink] = C.people[line.person % C.people.length];
      const x = MARGIN + 12;
      const rows = wrap(text, fReg, SIZE, width - 12);
      need(14 + LEAD * Math.min(rows.length, 2));
      let top = y + 9;
      const drawBar = (from, to) => page.drawRectangle({ x: MARGIN, y: to, width: 2.2, height: from - to, color: col(bar) });
      const name = clean(line.name);
      page.drawText(name, { x, y, size: 9, font: fBold, color: col(bar) });
      if (data.showTimes) page.drawText(clock(line.time), { x: x + fBold.widthOfTextAtSize(name, 9) + 8, y, size: 8, font: fReg, color: col(C.muted) });
      y -= 14;
      for (const row of rows) {
        if (y < BOTTOM) { drawBar(top, y + LEAD - 4); newPage(); top = y + 9; }
        page.drawText(row, { x, y, size: SIZE, font: fReg, color: col(ink) });
        y -= LEAD;
      }
      drawBar(top, y + LEAD - 4);
      y -= 7;
    } else {
      const indent = data.showTimes ? 42 : 0;
      const rows = wrap(text, fReg, SIZE, width - indent);
      need(LEAD);
      if (data.showTimes) page.drawText(clock(line.time), { x: MARGIN, y: y + 0.8, size: 8, font: fReg, color: col(C.muted) });
      for (const row of rows) {
        if (y < BOTTOM) newPage();
        page.drawText(row, { x: MARGIN + indent, y, size: SIZE, font: fReg, color: col(C.ink) });
        y -= LEAD;
      }
      y -= 4;
    }
  }

  need(34);
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + width, y }, thickness: 0.5, color: col(C.line) });
  y -= 14;
  const note = 'Transcribed by machine on the device holding the recording; nothing was uploaded. Checked and corrected by hand where needed.';
  wrap(note, fReg, 8, width).forEach((row, i) => page.drawText(row, { x: MARGIN, y: y - i * 11, size: 8, font: fReg, color: col(C.muted) }));

  // ----- footer on every page -----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: 46 }, end: { x: MARGIN + width, y: 46 }, thickness: 0.5, color: col(C.line) });
    p.drawText(footer, { x: MARGIN, y: 32, size: 8, font: fBold, color: col(C.teal) });
    const count = `Page ${i + 1} of ${pages.length}`;
    p.drawText(count, { x: MARGIN + width - fReg.widthOfTextAtSize(count, 8), y: 32, size: 8, font: fReg, color: col(C.muted) });
  });

  return doc.save();
}
