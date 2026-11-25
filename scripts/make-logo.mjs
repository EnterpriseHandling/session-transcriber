// Draws Frances's "FR" monogram as plain shapes (no font needed to display it),
// then saves the app icon and the header mark. Run once after design changes:
//   node scripts/make-logo.mjs && node scripts/make-icons.mjs
import opentype from 'opentype.js';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const buf = readFileSync(root + 'node_modules/@fontsource/fraunces/files/fraunces-latin-500-normal.woff');
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const TEAL = '#1f4b55';
const CREAM = '#f6f3ec';
const SAGE = '#9cc2b6';

function monogram(size, cx, cy) {
  const f = font.charToGlyph('F');
  const r = font.charToGlyph('R');
  const scale = size / font.unitsPerEm;
  const gap = -0.02 * font.unitsPerEm;
  const width = (f.advanceWidth + gap + r.advanceWidth) * scale;
  const capHeight = (font.tables.os2.sCapHeight || 700) * scale;
  const x0 = cx - width / 2;
  const base = cy + capHeight / 2;
  const p1 = f.getPath(x0, base, size).toPathData(2);
  const p2 = r.getPath(x0 + (f.advanceWidth + gap) * scale, base, size).toPathData(2);
  return `${p1} ${p2}`;
}

// App icon: teal rounded square, thin sage ring, cream letters.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="${TEAL}"/>
<circle cx="256" cy="256" r="178" fill="none" stroke="${SAGE}" stroke-width="7" opacity="0.9"/>
<path d="${monogram(196, 256, 256)}" fill="${CREAM}"/>
</svg>
`;
writeFileSync(root + 'site/icon.svg', icon);

// Header mark: teal circle with ring, for use on light backgrounds.
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="FR">
<circle cx="60" cy="60" r="58" fill="${TEAL}"/>
<circle cx="60" cy="60" r="49" fill="none" stroke="${SAGE}" stroke-width="1.6"/>
<path d="${monogram(52, 60, 60)}" fill="${CREAM}"/>
</svg>
`;
writeFileSync(root + 'site/mark.svg', mark);
console.log('logo written');
