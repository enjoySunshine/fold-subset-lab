import fs from 'node:fs';
import { register } from 'node:module';

register(new URL('./resolver.mjs', import.meta.url));

const fontkit = await import('../src/node.js');

const ttf = fontkit.openSync(
  new URL('../test/data/OpenSans/OpenSans-Regular.ttf', import.meta.url),
);
const woff2 = fontkit.openSync(
  new URL('../test/data/OpenSans/OpenSans-Regular.woff2', import.meta.url),
);

// Subset each target glyph out of the WOFF2 font on its own.
function subsetGlyph(font, text) {
  const original = font.glyphsForString(text)[0];
  const subset = font.createSubset();
  subset.includeGlyph(original);
  const subFont = fontkit.create(subset.encode());
  const subGid = subset.mapping[original.id];
  return { original, glyph: subFont.getGlyph(subGid), subFont, subGid };
}

const targets = ['A', 'B', 'e', 'é'];
let overlays = '';
let report = [];

for (const text of targets) {
  const ttfGlyph = ttf.glyphsForString(text)[0];
  const { glyph: subGlyph } = subsetGlyph(woff2, text);

  const ttfPath = ttfGlyph.path.toSVG();
  const subPath = subGlyph.path.toSVG();
  const match = ttfPath === subPath;
  report.push({ text, match });

  const box = ttfGlyph.cbox;
  const w = Math.max(1, Math.ceil(box.maxX - box.minX));
  const h = Math.max(1, Math.ceil(box.maxY - box.minY));
  const x = box.minX;
  const y = -box.maxY;

  // Draw the TTF original in blue, then the WOFF2 subset outline in red on
  // top. Where they coincide the strokes merge into purple.
  overlays += `
  <svg viewBox="${x} ${y} ${w} ${h}" width="220" height="220">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#111"/>
    <path d="${ttfPath}" transform="scale(1,-1)" fill="none" stroke="#4d8dff" stroke-width="14"/>
    <path d="${subPath}" transform="scale(1,-1)" fill="none" stroke="#ff5d5d" stroke-width="6"/>
  </svg>`;
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${targets.length * 240}" height="260" viewBox="0 0 ${targets.length * 240} 260">
  <rect width="100%" height="100%" fill="#0c0c0c"/>
  <g transform="translate(10,20)">${overlays}
  </g>
</svg>
`;

fs.writeFileSync(new URL('./overlay.svg', import.meta.url), svg);
console.log('wrote preview/overlay.svg');
for (const { text, match } of report) {
  console.log(
    `  '${text}': WOFF2 subset outline ${match ? 'overlaps' : 'DOES NOT MATCH'} the TTF original`,
  );
}
process.exit(report.every((r) => r.match) ? 0 : 1);
