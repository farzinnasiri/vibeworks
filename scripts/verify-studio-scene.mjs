import { startBridge } from '../src/bridge/server.ts';
import { SqliteStore } from '../src/bridge/sqlite-store.ts';
import { emptyDocument } from '../src/cad/document.ts';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// node --import tsx scripts/verify-studio-scene.mjs
// Studio looks, light map, backdrop, materials, gallery and return visits on isolated services.
// The user's workspace database and personal gallery are never opened.
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'vibeworks-studio-scene-'));
const out = join(root, 'output/playwright/studio-scene');
await mkdir(out, { recursive: true });
const WEB = 45203, BRIDGE = 44358;
process.env.VIBEWORKS_WEB_PORT = String(WEB);
process.env.VIBEWORKS_BRIDGE_PORT = String(BRIDGE);
const store = new SqliteStore(join(dir, 'workspace.db'));
await store.put({ ...emptyDocument(), name: 'Bench grinder housing with a deliberately long model name for wrapping checks', features: [
  { id: 'base', kind: 'box', label: 'Cast base', params: { origin: [-60, -35, 0], size: [120, 70, 14] }, appearance: { material: 'cast_iron' } },
  { id: 'housing', kind: 'box', label: 'Motor housing', params: { origin: [-40, -25, 14], size: [80, 50, 40] }, appearance: { material: 'aluminum', color: '#b45e3c', finish: 'satin' } },
  { id: 'dial', kind: 'cylinder', label: 'Speed dial', params: { origin: [12, 0, 54], radius: 14, height: 10 }, appearance: { material: 'steel', color: '#262b30', finish: 'mirror' } },
  { id: 'foot', kind: 'cylinder', label: 'Rubber foot', params: { origin: [-50, -25, -6], radius: 6, height: 6 }, appearance: { material: 'rubber' } },
] }, null);
store.close();
let bridge, server, browser;
const errors = [], checks = [];
let passed = false;
try {
  bridge = await startBridge({ port: BRIDGE, databasePath: join(dir, 'workspace.db'), connectionFile: join(dir, 'connection.json'), webOrigins: [`http://127.0.0.1:${WEB}`] });
  await bridge.ready();
  server = await createServer({ root, configFile: join(root, 'vite.config.ts') });
  await server.listen();
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, colorScheme: 'light' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const settings = () => page.getByRole('complementary', { name: 'Studio scene settings' });
  const tab = name => settings().getByRole('navigation', { name: 'Studio settings' }).getByRole('button', { name, exact: true });
  const documentId = () => page.evaluate(() => window.__cad.inspect().document.documentId);
  const stored = async key => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), key);
  const noOverflow = async label => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: page overflow`);
    assert.equal(await page.evaluate(() => { const s = document.querySelector('.studio-settings-scroll'); return !!s && s.scrollWidth > s.clientWidth + 1; }), false, `${label}: panel overflow`);
  };
  const shot = async name => page.screenshot({ path: join(out, `${name}.png`) });
  const enter = async () => {
    await page.waitForFunction(() => window.__cad?.inspect().evaluation.meshes.length > 0);
    await page.getByRole('button', { name: 'Enter Studio', exact: true }).click();
    await page.getByRole('button', { name: 'Render image', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.studio-process'));
  };
  const exit = async () => { await page.getByRole('button', { name: 'Exit Studio', exact: true }).click(); await page.locator('.studio-workspace').waitFor({ state: 'detached' }); };

  await page.goto(`http://127.0.0.1:${WEB}`);
  await page.evaluate(() => window.__cad.ready);
  await page.locator('.picker-project').first().click();
  await page.locator('.picker-document').first().click();
  await enter();
  const id = await documentId();

  // One header row: camera tools live beside the modes; no second toolbar.
  assert.equal(await page.locator('.studio-camera-bar').count(), 0);
  const toolbar = page.getByRole('toolbar', { name: 'Studio camera' });
  assert.ok((await toolbar.boundingBox()).y < 100, 'camera tools sit in the Studio header');
  await page.getByRole('button', { name: 'Camera direction', exact: true }).click();
  await page.locator('#menu-studio-views').waitFor();
  await shot('00-view-menu');
  await page.getByRole('menuitem', { name: 'Front', exact: true }).click();
  await page.getByRole('button', { name: 'Lens', exact: true }).click();
  await page.getByRole('menuitem', { name: /^85 mm/ }).click();
  assert.equal(await page.getByRole('button', { name: 'Lens', exact: true }).innerText(), '85 mm');
  await page.getByRole('button', { name: 'Lens', exact: true }).click();
  await page.getByRole('menuitem', { name: /^50 mm/ }).click();
  await page.getByRole('button', { name: 'Fit Studio model', exact: true }).click();
  checks.push('camera tools in the single Studio header: view menu, lens, fit');

  // Looks: real thumbnails of this model, one click applies a whole scene, materials stay.
  assert.equal(await tab('Looks').getAttribute('aria-pressed'), 'true', 'Looks is the first panel.');
  await page.waitForFunction(() => document.querySelectorAll('.studio-look-image img').length >= 6, null, { timeout: 60_000 });
  await noOverflow('looks'); await shot('01-looks');
  await settings().getByRole('button', { name: /Dark product/ }).click();
  await page.waitForFunction(id => JSON.parse(localStorage.getItem('vibeworks.studio.draft.' + id) ?? '{}').environmentPreset === 'dark_studio', id);
  assert.equal(await settings().getByRole('button', { name: /Dark product/ }).getAttribute('aria-pressed'), 'true');
  checks.push('looks render model thumbnails and apply a complete scene');
  await page.waitForTimeout(400); await shot('02-dark-look');

  // Saved looks are personal and reusable.
  await settings().getByRole('button', { name: 'This look is already saved' }).waitFor();
  await settings().getByRole('button', { name: /Studio gray/ }).click();
  await tab('Light').click();
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('1.6');
  await tab('Looks').click();
  await settings().getByRole('button', { name: 'Save current look' }).click();
  await settings().getByRole('textbox', { name: 'Look name' }).fill('Bright gray');
  await settings().getByRole('button', { name: 'Save', exact: true }).click();
  await settings().getByRole('button', { name: /^Bright gray/ }).waitFor();
  assert.equal(await settings().getByRole('button', { name: /^Bright gray/ }).getAttribute('aria-pressed'), 'true');
  assert.equal((await stored('vibeworks.studio.looks')).length, 1);
  checks.push('save current look and see it selected');

  // Quick output: rendering and size from any panel; everything else one click away.
  const quick = settings().getByRole('group', { name: 'Quick output' });
  await quick.getByRole('radio', { name: 'High quality', exact: true }).click();
  assert.equal(await quick.getByRole('radio', { name: 'High quality', exact: true }).getAttribute('aria-checked'), 'true');
  await quick.getByRole('combobox', { name: 'Image size', exact: true }).click();
  await page.getByRole('option', { name: 'Square', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('vibeworks.studio.output') ?? '{}').size === 'square');
  await page.waitForTimeout(300); await shot('01b-quick-output');
  await quick.getByRole('button', { name: 'All output settings', exact: true }).click();
  assert.equal(await tab('Output').getAttribute('aria-pressed'), 'true');
  assert.equal(await settings().getByRole('group', { name: 'Quick output' }).count(), 0, 'no duplicate controls on Output');
  assert.equal(await settings().getByRole('radio', { name: 'High quality', exact: true }).isChecked(), true);
  await settings().getByRole('radio', { name: 'Fast', exact: true }).check();
  await settings().getByRole('radio', { name: 'HD 16:9', exact: true }).click();
  await tab('Looks').click();
  assert.equal(await quick.getByRole('radio', { name: 'Fast', exact: true }).getAttribute('aria-checked'), 'true');
  checks.push('quick output toggles rendering and size; settings icon opens Output');

  // Light: the map moves the key light relative to the camera; explanations are visible.
  await tab('Light').click();
  const dial = settings().getByRole('slider', { name: 'Key light position' });
  const before = (await stored('vibeworks.studio.draft.' + id)).lightRotation ?? -35;
  const box = await dial.boundingBox();
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.5); await page.mouse.down(); await page.mouse.up();
  await page.waitForFunction(([id, before]) => (JSON.parse(localStorage.getItem('vibeworks.studio.draft.' + id) ?? '{}').lightRotation ?? -35) !== before, [id, before]);
  assert.match(await dial.getAttribute('aria-valuetext'), /from (the left|the front|back left)/);
  await dial.focus(); await page.keyboard.press('ArrowUp');
  assert.ok(await settings().getByText('Lifts the shadow side.').isVisible(), 'short hint stays visible');
  await settings().getByRole('button', { name: 'About Key light' }).hover();
  await page.locator('#workspace-tooltip').getByText(/bottom edge is where you look from/).waitFor();
  await shot('03a-light-info');
  await noOverflow('light'); await shot('03-light');
  checks.push('light map drag and keyboard set key light direction and height');

  // Backdrop: seamless is the default; an incompatible background explains itself.
  await tab('Backdrop').click();
  assert.equal(await settings().getByRole('radio', { name: 'Seamless', exact: true }).isChecked(), true);
  const setCard = await settings().locator('.studio-set-choices label').first().boundingBox();
  assert.ok(setCard.height < 64, `set choices stay one compact row each: ${JSON.stringify(setCard)}`);
  await settings().locator('.studio-set-choices').screenshot({ path: join(out, '04a-backdrop-set.png') });
  await settings().getByRole('radio', { name: 'Surroundings background', exact: true }).check();
  await settings().getByText('The seamless wall hides this.').waitFor();
  await settings().getByRole('button', { name: 'Use an open floor' }).click();
  assert.equal(await settings().getByRole('radio', { name: 'Open floor', exact: true }).isChecked(), true);
  await page.waitForTimeout(400); await noOverflow('backdrop'); await shot('04-backdrop-environment');
  checks.push('seamless default and background/backdrop conflict guidance');

  // Camera stays above a floor.
  const canvas = page.locator('.studio-viewport canvas').first(), cbox = await canvas.boundingBox();
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2); await page.mouse.down();
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + 10, { steps: 12 }); await page.mouse.up();
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2); await page.mouse.down();
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + 10, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(600);
  const camera = await stored('vibeworks.studio.camera.' + id);
  assert.ok(camera && camera.position[2] >= -6 + 0.01, `camera stays above the floor: ${JSON.stringify(camera?.position)}`);
  await shot('05-low-orbit');
  checks.push('orbit cannot pass below the floor');

  // Materials: opening flashes the parts, then the edited look is visible without the highlight.
  await tab('Materials').click();
  await settings().locator('.studio-material-row').filter({ hasText: 'Steel' }).click();
  assert.equal(await page.locator('.studio-viewport').getAttribute('data-highlighted-features'), 'dial');
  await page.mouse.move(cbox.x + 20, cbox.y + 20);
  await page.waitForFunction(() => !document.querySelector('.studio-viewport')?.getAttribute('data-highlighted-features'), null, { timeout: 3000 });
  await settings().getByRole('radio', { name: 'Gloss', exact: true }).click();
  assert.equal(await page.locator('.studio-viewport').getAttribute('data-highlighted-features'), null, 'no highlight while editing a finish');
  await noOverflow('materials'); await shot('06-materials');
  checks.push('material highlight is transient and does not hide the edited finish');

  // Leaving Studio keeps the unsaved scene, the panel and the camera.
  const draftBefore = await stored('vibeworks.studio.draft.' + id), cameraBefore = await stored('vibeworks.studio.camera.' + id);
  await exit(); await enter();
  assert.equal(await tab('Materials').getAttribute('aria-pressed'), 'true', 'panel remembered');
  assert.deepEqual(await stored('vibeworks.studio.draft.' + id), draftBefore, 'draft restored');
  await settings().getByText('Unsaved scene from your last visit').waitFor();
  await page.waitForTimeout(600);
  const cameraAfter = await stored('vibeworks.studio.camera.' + id);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(cameraAfter.position[i] - cameraBefore.position[i]) < 1e-3, 'camera restored');
  checks.push('exit and return keep draft scene, panel and camera');

  // Save to model, then Revert has nothing to discard.
  await settings().getByRole('button', { name: 'Save to model', exact: true }).click();
  await settings().getByText('Same as the scene saved with the model').waitFor();
  assert.equal(await stored('vibeworks.studio.draft.' + id), null);
  assert.equal((await page.evaluate(() => window.__cad.inspect().document.presentation)).backdrop, 'plane');
  checks.push('save writes the scene into the model and clears the browser draft');

  // Gallery: renders are listed with storage, can be selected and deleted.
  await tab('Looks').click();
  await settings().getByRole('button', { name: /Clean white/ }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Render image', exact: true }).click();
    await page.waitForFunction(n => document.querySelectorAll('.studio-renders li').length === n, i + 1, { timeout: 120_000 });
    const result = page.getByRole('region', { name: 'Finished image' });
    await result.waitFor();
    if (i === 0) {
      await page.waitForTimeout(500); await shot('07-rendered');
      await page.locator('.studio-image-lock').click({ position: { x: 40, y: 40 } });
      await page.locator('.studio-result-bar.nudged').waitFor();
      await page.keyboard.press('Escape');
      await result.waitFor({ state: 'hidden' });
    } else await result.getByRole('button', { name: 'Back to preview', exact: true }).click();
  }
  checks.push('finished image shows a clear result bar; touching the image nudges it; Escape returns to preview');
  await page.getByRole('button', { name: /^Gallery/ }).click();
  const gallery = page.getByRole('dialog', { name: 'Gallery' });
  await gallery.getByRole('meter', { name: 'Gallery space used' }).waitFor();
  assert.match(await gallery.locator('.studio-gallery-usage').innerText(), /2 images/);
  assert.match(await gallery.locator('.studio-gallery-usage').innerText(), /not in the model/);
  await shot('08-gallery');
  await gallery.getByRole('checkbox').first().check();
  page.once('dialog', dialog => dialog.accept());
  await gallery.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.studio-gallery-grid li').length === 1);
  await gallery.getByRole('button', { name: 'All models', exact: true }).click();
  assert.equal(await gallery.locator('.studio-gallery-grid li').count(), 1);
  await page.keyboard.press('Escape'); await gallery.waitFor({ state: 'hidden' });
  checks.push('gallery shows usage, selects and deletes images');

  // Dark appearance and a narrow phone sheet.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await tab('Light').click(); await page.waitForTimeout(300); await shot('09-light-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click().catch(() => {});
  const toggle = page.locator('.studio-workspace-header .studio-settings-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.waitForTimeout(400); await noOverflow('phone light'); await shot('10-phone-light');
  await tab('Looks').click(); await page.waitForTimeout(300); await noOverflow('phone looks'); await shot('11-phone-looks');
  const quickBox = await settings().getByRole('group', { name: 'Quick output' }).boundingBox();
  assert.ok(quickBox && quickBox.width <= 390 && quickBox.height < 60, `quick output fits one row on a phone: ${JSON.stringify(quickBox)}`);
  checks.push('dark appearance and 390 px sheet without overflow');

  assert.deepEqual(errors.filter(e => !/favicon/.test(e)), [], 'no browser errors');
  passed = true;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'results.json'), JSON.stringify({ passed, checks, errors }, null, 2));
  await browser?.close(); await server?.close(); await bridge?.close?.();
  await rm(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ passed, checks, errors }, null, 2));
}
