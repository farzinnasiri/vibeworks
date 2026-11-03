import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { chromium } from 'playwright';

const directory = new URL('../public/brand/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('FONT-LICENSE.txt', directory), await readFile(new URL('../src/cad/fonts/IBMPlexSans-OFL.txt', import.meta.url)));
// One geometry source for every export. Two chamfered beams form the product's initial.
const left = 'M8 14 20 7 32 28 44 7 56 14 32 56Z';
const right = 'M32 28 44 7 56 14 32 56Z';
const font = opentype.parse((await readFile(new URL('../src/cad/fonts/IBMPlexSans-Bold.ttf', import.meta.url))).buffer);
const lettering = font.getPath('Vibeworks', 76, 47, 43).toPathData(3);
const width = Math.ceil(76 + font.getAdvanceWidth('Vibeworks', 43) + 8);
const palettes = { light: ['#17191b', '#f0561d'], dark: ['#ecefeb', '#ff8751'], mono: ['#17191b', '#17191b'] };
const svg = (ink, orange, lockup = false, adaptive = false) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lockup ? width : 64} 64" fill="none"><title>Vibeworks</title>${adaptive ? '<style>@media(prefers-color-scheme:dark){.ink{fill:#ecefeb}.accent{fill:#ff8751}}</style>' : ''}<path class="ink" fill="${ink}" d="${left}"/><path class="accent" fill="${orange}" d="${right}"/>${lockup ? `<path fill="${ink}" d="${lettering}"/>` : ''}</svg>`;
const exports = [];
for (const [variant, [ink, orange]] of Object.entries(palettes)) {
  const suffix = variant === 'light' ? '' : `-${variant}`;
  for (const lockup of [false, true]) {
    const name = `vibeworks-${lockup ? 'logo' : 'mark'}${suffix}.svg`, content = svg(ink, orange, lockup);
    await writeFile(new URL(name, directory), content + '\n');
    exports.push({ name, content, lockup, variant });
  }
}
await writeFile(new URL('favicon.svg', directory), svg(...palettes.light, false, true) + '\n');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const item of exports) {
    const sizes = item.lockup ? [320, 640, 1280] : item.variant === 'light' ? [16, 32, 48, 64, 128, 256, 512, 1024] : [64, 256, 512];
    for (const size of sizes) {
      const height = item.lockup ? Math.round(size * 64 / width) : size;
      await page.setViewportSize({ width: size, height });
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>${item.content}`);
      await page.screenshot({ path: fileURLToPath(new URL(item.name.replace('.svg', `-${size}.png`), directory)), omitBackground: true });
    }
  }
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:#ecebe5}svg{display:block;width:144px;height:144px;padding:18px}</style>${svg(...palettes.light)}`);
  await page.screenshot({ path: fileURLToPath(new URL('apple-touch-icon.png', directory)) });
} finally { await browser.close(); }
await writeFile(new URL('README.md', directory), `# Vibeworks identity

The mark is two chamfered beams forming a V. Ink and signal orange match the Bench interface.
All files derive from the same geometry in scripts/generate-brand.mjs. Run node scripts/generate-brand.mjs to regenerate.

- vibeworks-mark.svg is the standalone transparent mark, with dark and mono variants.
- vibeworks-logo.svg is the horizontal lockup, with dark and mono variants. Its lettering is outlined IBM Plex Sans Bold, using the existing bundled SIL OFL font.
- Mark PNGs are supplied at 16, 32, 48, 64, 128, 256, 512 and 1024 px. Dark/mono PNGs are 64, 256 and 512 px.
- Lockup PNGs are 320, 640 and 1280 px wide, with transparent backgrounds in every variant.
- favicon.svg follows the browser's appearance. apple-touch-icon.png has an opaque paper background.

Keep the proportions and clear space in the SVG viewBox. Use the dark variant on graphite surfaces.
Font license: FONT-LICENSE.txt. The source font stays in src/cad/fonts/ in the repository.
`);
console.log('Generated canonical SVG marks/lockups, PNG size families, favicon and touch icon.');
