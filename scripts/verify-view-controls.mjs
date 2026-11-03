import { startBridge } from '../src/bridge/server.ts';
import { SqliteStore } from '../src/bridge/sqlite-store.ts';
import { emptyDocument } from '../src/cad/document.ts';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// node --import tsx scripts/verify-view-controls.mjs [--quality]
// All modeling and encoding use isolated services and an exact Node-produced test model.
// The user's workspace database and personal render history are never opened.
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'vibeworks-studio-'));
const out = join(root, 'output/playwright/view-controls');
await mkdir(out, { recursive: true });
process.env.VIBEWORKS_WEB_PORT = '45193';
process.env.VIBEWORKS_BRIDGE_PORT = '44348';
const store = new SqliteStore(join(dir, 'workspace.db'));
await store.put({ ...emptyDocument(), name: 'Studio acceptance', features: [
  { id: 'housing', kind: 'box', params: { origin: [-40, -25, 0], size: [80, 50, 24] }, appearance: { material: 'aluminum', color: '#b45e3c', finish: 'satin' } },
  { id: 'dial', kind: 'cylinder', params: { origin: [12, 0, 24], radius: 14, height: 10 }, appearance: { material: 'steel', color: '#262b30', finish: 'mirror' } },
] }, null);
store.close();
let bridge, server, browser, page;
const errors = [];

try {
  bridge = await startBridge({ port: 44348, databasePath: join(dir, 'workspace.db'), connectionFile: join(dir, 'connection.json'), webOrigins: ['http://127.0.0.1:45193'] });
  await bridge.ready();
  server = await createServer({ root, configFile: join(root, 'vite.config.ts') });
  await server.listen();
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const settings = () => page.getByRole('complementary', { name: 'Studio scene settings' });
  const nav = name => settings().getByRole('navigation', { name: 'Studio settings' }).getByRole('button', { name, exact: true });
  const countImages = async count => page.waitForFunction(count => document.querySelectorAll('.studio-renders li').length === count, count, { timeout: 180_000 });
  const noOverflow = async label => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
  const enter = async () => {
    await page.waitForFunction(() => window.__cad?.inspect().evaluation.meshes.length > 0);
    await page.getByRole('button', { name: 'Enter Studio', exact: true }).click();
    await page.getByRole('button', { name: 'Render image', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.studio-process'));
  };
  const preview = async () => {
    const button = page.getByRole('button', { name: 'Back to preview', exact: true });
    if (await button.count()) await button.click();
    await page.locator('.studio-image-lock').waitFor({ state: 'hidden' });
  };
  const saveImage = async filename => {
    await page.locator('.studio-renders li').first().getByRole('button').click();
    const dialog = page.getByRole('dialog', { name: 'Finished image', exact: true });
    await dialog.waitFor();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save PNG', exact: true }).click();
    await (await download).saveAs(join(out, filename));
    const bytes = await readFile(join(out, filename));
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    return bytes;
  };
  const imageMetrics = bytes => page.evaluate(async base64 => {
    const blob = await (await fetch('data:image/png;base64,' + base64)).blob(), bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const corner = Array.from(ctx.getImageData(10, canvas.height - 10, 1, 1).data);
    const thirds = [0, 1, 2].map(index => {
      const data = ctx.getImageData(Math.floor(index * canvas.width / 3), 0, Math.floor(canvas.width / 3), canvas.height).data;
      const colors = new Set(); for (let i = 0; i < data.length; i += 4 * 97) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      return colors.size;
    });
    return { corner, thirds };
  }, bytes.toString('base64'));
  await page.goto('http://127.0.0.1:45193');
  await page.evaluate(() => window.__cad.ready);
  await page.locator('.picker-project').first().click();
  await page.locator('.picker-document').first().click();
  await page.waitForFunction(() => window.__cad?.inspect().evaluation.meshes.length > 0);
  await page.getByRole('button', {name:'More views',exact:true}).click();
  await page.getByRole('menuitem', {name:'Dimetric',exact:true}).click();
  await page.getByRole('button', {name:'More views',exact:true}).click();
  await page.getByRole('menuitem', {name:'Normal To surface…',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Normal To: click a surface'}).waitFor();
  await page.keyboard.press('Escape');
  await enter();
  await page.getByRole('button',{name:'Camera direction',exact:true}).click();
  assert.equal(await page.locator('#menu-studio-views .orientation-picker [role=menuitem]').count(),16);
  await page.getByRole('menuitem',{name:'Trimetric',exact:true}).click();
  await page.getByRole('button',{name:'Camera direction',exact:true}).click();
  await page.getByRole('menuitem',{name:'Normal To surface…',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Normal To: click a surface'}).waitFor();
  await page.keyboard.press('Escape');
  await nav('Backdrop').click();
  await page.getByRole('radio',{name:'No floor',exact:true}).click();
  await page.getByRole('radio',{name:'Transparent background',exact:true}).click();
  if (process.argv.includes('--quality')) {
    await nav('Output').click();
    await page.getByRole('radio',{name:'High quality',exact:true}).check();
    await page.getByRole('radio',{name:'Draft',exact:true}).check();
    await page.getByRole('button',{name:'Render image',exact:true}).click();
    await countImages(1);
    const bytes = await saveImage('transparent-quality.png');
    const metrics = await imageMetrics(bytes);
    assert.equal(metrics.corner[3],0,'High quality PNG background is transparent.');
    await preview();
    console.log('TRANSPARENT_QUALITY_PNG passed');
  }
  await page.waitForTimeout(300);
  await page.setViewportSize({width:390,height:844});
  await noOverflow('Mobile scene');
  assert.deepEqual(errors, []); console.log('VIEW_CONTROLS_ACCEPTANCE passed');
} finally {
  await browser?.close(); await server?.close(); await bridge?.close(); await rm(dir,{recursive:true,force:true});
}
