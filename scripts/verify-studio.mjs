import { startBridge } from '../src/bridge/server.ts';
import { SqliteStore } from '../src/bridge/sqlite-store.ts';
import { emptyDocument } from '../src/cad/document.ts';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import assert from 'node:assert/strict';

// node --import tsx scripts/verify-studio.mjs
// All modeling and encoding use isolated services and an exact Node-produced test model.
// The user's workspace database and personal render history are never opened.
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'vibeworks-studio-'));
const out = join(root, 'output/playwright/studio-redesign');
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
const capturesOnly = process.argv.includes('--captures-only');
const errors = [], timings = {}, checks = [], downloads = {};
let passed = false;
const pngSize = bytes => { assert.equal(Buffer.from(bytes).subarray(1, 4).toString(), 'PNG'); return { width: Buffer.from(bytes).readUInt32BE(16), height: Buffer.from(bytes).readUInt32BE(20) }; };
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
  const studio = () => page.locator('.studio-workspace');
  const mode = name => studio().locator('.studio-workspace-header').getByRole('button', { name, exact: true });
  const settings = () => page.getByRole('complementary', { name: 'Studio scene settings' });
  const nav = name => settings().getByRole('navigation', { name: 'Studio settings' }).getByRole('button', { name, exact: true });
  const countImages = async count => page.waitForFunction(count => document.querySelectorAll('.studio-renders li').length === count, count, { timeout: 180_000 });
  const recipe = () => page.evaluate(() => JSON.parse(localStorage.getItem('vibeworks.studio.video.' + window.__cad.inspect().document.documentId)));
  const noOverflow = async label => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
  const enter = async () => {
    await page.waitForFunction(() => window.__cad?.inspect().evaluation.meshes.length > 0);
    await page.getByRole('button', { name: 'Enter Studio', exact: true }).click();
    // Output choices are remembered between visits, so the action may name product views.
    await page.getByRole('button', { name: /^Render (image|\d+ views?)$/ }).waitFor({ state: 'visible' });
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
    const bytes = await readFile(join(out, filename)); downloads[filename] = { ...pngSize(bytes), bytes: bytes.length };
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
  await enter();
  if (!capturesOnly) {
  assert.equal(await mode('Images').getAttribute('aria-pressed'), 'true');
  assert.equal(await nav('Looks').getAttribute('aria-pressed'), 'true', 'Looks open first in a fresh browser.');
  await nav('Output').click();
  assert.equal(await page.getByRole('radio', { name: 'Product views', exact: true }).isVisible(), true, 'Product views are one tab away.');
  assert.equal(await page.locator('.studio-image-options').count(), 0, 'Output is no longer hidden over the camera.');
  const viewportBefore = await page.locator('.studio-viewport').boundingBox();
  assert.ok(viewportBefore.height > 600, JSON.stringify(viewportBefore));
  checks.push('direct mode and output discovery; no idle process reservation');
  let started = Date.now();
  await page.getByRole('button', { name: 'Render image', exact: true }).click();
  await countImages(1); timings.fastImageMs = Date.now() - started;
  await page.locator('.studio-image-lock').waitFor();
  const single = await saveImage('single.png');
  assert.deepEqual(pngSize(single), { width: 1920, height: 1080 });
  await preview();
  await page.reload(); await enter(); await countImages(1);
  checks.push('completed real fast image; native viewer Escape; persisted history');

  await page.getByRole('radio', { name: 'Product views', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Right', exact: true }).uncheck();
  assert.equal(await page.getByRole('checkbox', { name: 'Show view labels', exact: true }).isChecked(), false);
  const productPreview = page.getByRole('region', { name: 'Product view preview', exact: true });
  await productPreview.getByText('Live preview', { exact: true }).waitFor();
  assert.equal(await productPreview.locator('img').count(), 1);
  assert.ok((await productPreview.locator('img').getAttribute('alt')).includes('without labels'));
  await page.screenshot({ path: join(out, 'images-desktop.png') });
  started = Date.now(); await page.getByRole('button', { name: 'Render 3 views', exact: true }).click();
  await countImages(2); timings.cleanSheetMs = Date.now() - started;
  const clean = await saveImage('product-sheet-clean.png');
  assert.deepEqual(pngSize(clean), { width: 1920, height: 1080 });
  const cleanMetrics = await imageMetrics(clean);
  assert.ok(cleanMetrics.thirds.every(colors => colors > 20), JSON.stringify(cleanMetrics));
  assert.notDeepEqual(cleanMetrics.corner, [245, 244, 240, 255], 'Clean output contains no forced label stripe.');
  await preview();
  await page.getByRole('checkbox', { name: 'Show view labels', exact: true }).check();
  await productPreview.getByText('Live preview', { exact: true }).waitFor();
  assert.ok((await productPreview.locator('img').getAttribute('alt')).includes('with view labels'));
  await page.getByRole('button', { name: 'Render 3 views', exact: true }).click(); await countImages(3);
  const labelled = await saveImage('product-sheet-labelled.png');
  assert.deepEqual(pngSize(labelled), pngSize(clean));
  const labelMetrics = await imageMetrics(labelled);
  assert.deepEqual(labelMetrics.corner, [245, 244, 240, 255]);
  assert.notDeepEqual(labelled, clean);
  checks.push('live layout preview; clean and labelled full-size sheets; three filled tiles without empty quadrant');
  await preview();
  await page.getByRole('radio', { name: 'Separate PNGs', exact: true }).check();
  await productPreview.getByText('Live preview', { exact: true }).waitFor();
  assert.equal(await productPreview.locator('img').count(), 3);
  await page.getByRole('button', { name: 'Render 3 views', exact: true }).click(); await countImages(6);
  let downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Save view ZIP', exact: true }).click();
  await (await downloading).saveAs(join(out, 'product-views.zip'));
  const zipped = unzipSync(await readFile(join(out, 'product-views.zip')));
  assert.equal(Object.keys(zipped).length, 3);
  Object.values(zipped).forEach(bytes => assert.deepEqual(pngSize(bytes), { width: 1920, height: 1080 }));
  downloads['product-views.zip'] = { entries: Object.keys(zipped) };
  checks.push('three separate full-size PNGs and real ZIP download');
  await preview();

  await page.getByRole('radio', { name: 'Current camera', exact: true }).check();
  await nav('Materials').click();
  const canvasBefore = await page.locator('.studio-viewport canvas').first().screenshot();
  await page.locator('.studio-material-row').filter({ hasText: 'Aluminium' }).click();
  assert.ok((await page.locator('.studio-material-parts').textContent()).toLowerCase().includes('housing'));
  assert.equal(await page.locator('.studio-viewport').getAttribute('data-highlighted-features'), 'housing');
  const canvasAfter = await page.locator('.studio-viewport canvas').first().screenshot();
  assert.notDeepEqual(canvasBefore, canvasAfter, 'Choosing a material changes its part highlight in the actual preview.');
  await page.screenshot({ path: join(out, 'materials-desktop.png') });
  await nav('Light').click();
  assert.equal(await page.getByRole('slider', { name: 'Exposure', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('slider', { name: 'Key light position', exact: true }).isVisible(), true, 'The key light map is visible with its controls.');
  checks.push('material-to-part names and visible highlight; light panel with key light map');
  await nav('Output').click();
  await page.getByRole('radio', { name: 'High quality', exact: true }).check();
  await page.getByRole('radio', { name: 'Draft', exact: true }).check();
  started = Date.now(); await page.getByRole('button', { name: 'Render image', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel image', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Studio process' }).isVisible(), true);
  const processBox = await page.getByRole('region', { name: 'Studio process' }).boundingBox();
  assert.ok(processBox.height < 120, JSON.stringify(processBox));
  assert.deepEqual(await page.locator('.studio-viewport').boundingBox(), viewportBefore, 'Rendering feedback does not reserve a new camera row.');
  await countImages(7); timings.qualityImageMs = Date.now() - started;
  const quality = await saveImage('quality.png'); assert.deepEqual(pngSize(quality), { width: 1920, height: 1080 });
  await preview();
  await page.getByRole('button', { name: 'Render image', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel image', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.studio-process'));
  assert.equal(await page.locator('.studio-renders li').count(), 7);
  checks.push('completed path-traced image; compact non-shifting process; image cancellation');

  await mode('Video').focus(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: /Turntable/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.studio-video-shots img').length === 5);
  assert.equal(await page.locator('.studio-video-panel select').count(), 0);
  const dock = await page.locator('.studio-video-panel').boundingBox();
  assert.ok(dock.height < 300, JSON.stringify(dock));
  await page.getByRole('button', { name: 'Presets', exact: true }).click();
  await page.getByRole('button', { name: /Close-up.*Push in/ }).click();
  let views = await recipe(); assert.equal(views.length, 3);
  const distance = view => Math.hypot(...view.camera.position.map((value, index) => value - view.camera.target[index]));
  assert.ok(distance(views[1]) < distance(views[0]) && distance(views[2]) > distance(views[0]));
  await page.locator('.studio-video-shots li').nth(1).getByRole('button').click();
  await page.getByRole('button', { name: 'Edit view', exact: true }).click();
  await page.getByRole('textbox', { name: 'View name', exact: true }).fill('Macro detail');
  await page.getByRole('button', { name: 'Update from preview', exact: true }).click();
  await page.getByRole('button', { name: 'Push in', exact: true }).click();
  assert.equal(await page.locator('.studio-video-shots li').count(), 4);
  await page.getByRole('button', { name: 'Move view later', exact: true }).click();
  await page.getByRole('button', { name: 'Move view earlier', exact: true }).click();
  await page.getByRole('button', { name: 'Remove view', exact: true }).click();
  assert.equal(await page.locator('.studio-video-shots li').count(), 3);
  await page.getByRole('button', { name: 'Edit view', exact: true }).click();
  await page.getByRole('button', { name: 'Play video preview', exact: true }).click();
  await page.getByRole('button', { name: 'Pause video preview', exact: true }).click();
  await page.getByRole('slider', { name: 'Video playhead', exact: true }).fill('2');
  await page.waitForFunction(() => document.querySelectorAll('.studio-video-shots img').length === 3);
  await page.screenshot({ path: join(out, 'video-desktop.png') });
  checks.push('keyboard mode change; actual camera thumbnails; presets, edit, reorder, remove, playback and scrub');

  // A single held camera is a valid half-second, twelve-frame sequence. Preserve the same camera and scene.
  const shortViews = [(await recipe())[0]]; shortViews[0] = { ...shortViews[0], hold: .5, seconds: .5 };
  await mode('Images').click();
  await page.evaluate(views => localStorage.setItem('vibeworks.studio.video.' + window.__cad.inspect().document.documentId, JSON.stringify(views)), shortViews);
  await mode('Video').click();
  await page.getByRole('button', { name: /MP4 · 1080p/ }).click();
  await page.getByRole('button', { name: '720p', exact: true }).click();
  await page.getByRole('button', { name: /MP4 · 720p/ }).click();
  started = Date.now(); await page.getByRole('button', { name: 'Render video', exact: true }).click();
  await page.getByRole('dialog', { name: 'Finished video', exact: true }).waitFor({ timeout: 180_000 });
  timings.shortVideoMs = Date.now() - started;
  const videoDialog = page.getByRole('dialog', { name: 'Finished video', exact: true });
  downloading = page.waitForEvent('download'); await videoDialog.getByRole('button', { name: 'Save MP4', exact: true }).click();
  await (await downloading).saveAs(join(out, 'short-video.mp4'));
  const videoBytes = await readFile(join(out, 'short-video.mp4'));
  assert.ok(videoBytes.length > 100 && videoBytes.subarray(4, 8).toString() === 'ftyp');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', join(out, 'short-video.mp4')], { encoding: 'utf8' });
  if (probe.status === 0) { const stream = JSON.parse(probe.stdout).streams[0]; assert.equal(stream.width, 1280); assert.equal(stream.height, 720); assert.equal(Number(stream.nb_frames), 12); downloads['short-video.mp4'] = stream; }
  else downloads['short-video.mp4'] = { bytes: videoBytes.length, container: 'MP4', ffprobe: 'unavailable' };
  await page.keyboard.press('Escape'); await videoDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Render video', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel video', exact: true }).click();
  await page.getByRole('button', { name: 'Render video', exact: true }).waitFor();
  checks.push('completed actual twelve-frame 720p MP4; native modal Escape; video cancellation');

  } else {
    await page.getByRole('button', { name: 'Render image', exact: true }).click(); await countImages(1); await preview();
    await page.getByRole('radio', { name: 'Product views', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Right', exact: true }).uncheck();
    await page.getByRole('region', { name: 'Product view preview', exact: true }).getByText('Live preview', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Fit Studio model', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save preview as PNG', exact: true }).count(), 0);
    await page.screenshot({ path: join(out, 'images-desktop.png') });
    await nav('Materials').click();
    await page.locator('.studio-material-row').filter({ hasText: 'Aluminium' }).click();
    await page.screenshot({ path: join(out, 'materials-desktop.png') });
    await nav('Light').click();
    const environments = page.getByRole('radiogroup', { name: 'Environment', exact: true }).getByRole('radio');
    assert.deepEqual(await environments.allTextContents(), ['Photo studio', 'Dark studio', 'Warehouse', 'Outdoor']);
    assert.equal(await environments.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true);
    await mode('Video').click();
    await page.getByRole('button', { name: /Turntable/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.studio-video-shots img').length === 5);
    await page.screenshot({ path: join(out, 'video-desktop.png') });
  }
  const productPreview = page.getByRole('region', { name: 'Product view preview', exact: true });
  // One batched responsive capture pass after all workflows are exercised.
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow('Mobile video');
  await page.screenshot({ path: join(out, 'video-mobile.png') });
  const smallButtons = await page.locator('.studio-video-panel button:visible').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height < 44).map(node => node.getAttribute('aria-label') || node.textContent));
  assert.deepEqual(smallButtons, []);
  await mode('Images').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await studio().isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).evaluate(element => document.activeElement === element), true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await nav('Output').click();
  await page.getByRole('radio', { name: 'Fast', exact: true }).check();
  await page.getByRole('radio', { name: 'Product views', exact: true }).check();
  await page.getByRole('radio', { name: 'One image', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Show view labels', exact: true }).uncheck();
  await page.locator('.studio-settings-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(out, 'output-mobile.png') }); await noOverflow('Mobile output settings');
  await page.getByRole('button', { name: 'Close scene settings', exact: true }).click();
  await productPreview.getByText('Live preview', { exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'images-mobile.png') }); await noOverflow('Mobile image preview');
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  // System appearance follows the emulated scheme; the explicit choice lives in the top-bar Settings popover.
  const darkChoice = page.getByRole('radio', { name: 'Dark appearance', exact: true });
  if (await darkChoice.isVisible()) await darkChoice.locator('..').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.studio-picture').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await productPreview.getByText('Live preview', { exact: true }).waitFor();
  await productPreview.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.screenshot({ path: join(out, 'images-dark.png') }); await noOverflow('Dark desktop');
  assert.equal(await page.locator('.studio-workspace').evaluate(element => getComputedStyle(element).animationName), 'none');
  if (!capturesOnly) {
  await page.locator('.studio-renders li').first().getByRole('button').click();
  const imageDialog = page.getByRole('dialog', { name: 'Finished image', exact: true });
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    const focus = await imageDialog.evaluate(element => ({ modal: element.matches(':modal'), inside: element.contains(document.activeElement), body: document.activeElement === document.body, active: document.activeElement?.outerHTML.slice(0, 300) }));
    assert.equal(focus.modal, true);
    assert.ok(focus.inside || focus.body, JSON.stringify(focus));
  }
  await imageDialog.getByRole('button', { name: 'Remove image', exact: true }).click();
  await imageDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.studio-renders li').count(), 6);
  await page.reload(); await enter(); await countImages(6);
  }
  checks.push(capturesOnly ? 'desktop and 390px captures; 44px video targets; loaded dark preview; reduced motion' : '390px layouts; 44px video targets; dark theme and reduced motion; viewer focus containment; durable image removal');
  assert.deepEqual(errors, []);
  passed = true;
  console.log(capturesOnly ? 'STUDIO_CAPTURES' : 'STUDIO_ACCEPTANCE', JSON.stringify({ passed, timings, checks, downloads, errors, artifacts: out }));
} catch (error) {
  console.error(error);
  if (page) { console.log((await page.locator('body').innerText()).slice(-5000)); await page.screenshot({ path: join(out, 'failure.png') }); }
  process.exitCode = 1;
} finally {
  await writeFile(join(out, capturesOnly ? 'capture-acceptance.json' : 'acceptance.json'), JSON.stringify({ passed, timings, checks, downloads, errors }, null, 2));
  await browser?.close(); await server?.close(); await bridge?.close(); await rm(dir, { recursive: true, force: true });
}
