// One-off/rerunnable script that rasterizes the branding SVGs into the
// PNG sizes needed for PWA installability (Android app-drawer install).
// Run with: node scripts/generate-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const brandingDir = path.join(root, 'src', 'branding');
const outDir = path.join(root, 'public', 'icons');

mkdirSync(outDir, { recursive: true });

const targets = [
  { svg: 'icon.svg', file: 'icon-192.png', size: 192 },
  { svg: 'icon.svg', file: 'icon-512.png', size: 512 },
  { svg: 'icon-maskable.svg', file: 'icon-512-maskable.png', size: 512 },
];

for (const { svg, file, size } of targets) {
  const svgContent = readFileSync(path.join(brandingDir, svg), 'utf-8');
  const resvg = new Resvg(svgContent, {
    fitTo: { mode: 'width', value: size },
  });
  const png = resvg.render().asPng();
  writeFileSync(path.join(outDir, file), png);
  console.log(`Wrote public/icons/${file} (${size}x${size})`);
}
