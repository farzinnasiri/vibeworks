import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the loading wave keeps a bounded composited surface without per-frame SVG repainting', { timeout: 15000 }, async () => {
  const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {LoadingField} from './src/web/LoadingField';createRoot(document.getElementById('root')).render(<LoadingField label="Preparing model"/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic' });
  const css = (await Promise.all(['styles.css', 'experience.css'].map(path => readFile(new URL(`../src/web/${path}`, import.meta.url), 'utf8')))).join('\n');
  const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    await page.route('http://wave.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/brand/')) { await route.fulfill({ contentType: 'image/svg+xml', body: await readFile(new URL(`../public${path}`, import.meta.url), 'utf8') }); return; }
      await route.fulfill({ contentType: 'text/html', body: `<style>${css}\nhtml,body,#root{margin:0;width:100%;height:100%}#root{position:relative}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>` });
    });
    await page.goto('http://wave.test/'); await page.locator('.wave-field').waitFor();
    const entrance = await page.locator('.loading-field').evaluate(element => ({
      carrier: getComputedStyle(element.querySelector('.wave-field')!).animationName,
      delays: ['.loading-brand','.loading-label','.progress-meter'].map(selector=>getComputedStyle(element.querySelector(selector)!).animationDelay),
    }));
    assert.match(entrance.carrier,/wave-arrive/);
    assert.deepEqual(entrance.delays,['0.04s','0.08s','0.16s']);
    await page.waitForTimeout(350);
    const cdp = await page.context().newCDPSession(page), events: { name: string; dur?: number }[] = [];
    let layers: { drawsContent: boolean; width: number; height: number }[] = [];
    cdp.on('LayerTree.layerTreeDidChange', event => { layers = event.layers ?? []; });
    await cdp.send('LayerTree.enable');
    await page.screenshot();
    await page.waitForTimeout(100);
    const surfaces = layers.filter(layer => layer.drawsContent && layer.width && layer.height);
    const pixels = surfaces.reduce((n, layer) => n + layer.width * layer.height, 0);
    assert.ok(surfaces.length > 0, 'The browser must report its composited surfaces.');
    assert.ok(pixels <= 1440 * 900 * 6, `The wave allocates ${surfaces.length} composited surfaces covering ${(pixels / (1440 * 900)).toFixed(1)} viewports. At Retina density these independent line textures compete with the CAD renderer.`);
    cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value.map(event => ({ name: event.name }))));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
    const frames: string[] = [];
    for (let i = 0; i < 3; i++) { await page.waitForTimeout(180); frames.push((await cdp.send('Page.captureScreenshot', { format: 'png' })).data); }
    const complete = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve()));
    await cdp.send('Tracing.end'); await complete;
    const paints = events.filter(event => event.name === 'Paint');
    assert.equal(new Set(frames).size, 3, 'The wave must actually keep moving during the repaint check.');
    assert.ok(paints.length <= 2, `The idle wave repainted ${paints.length} times during three frames, so main-thread work can stall and shimmer its lines.`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('.wave-field')!.getAnimations({ subtree: true }).length === 0);
    assert.equal(await page.locator('.wave-field').evaluate(element => getComputedStyle(element).animationName), 'none');
  } finally { await browser.close(); }
});
