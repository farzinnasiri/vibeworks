import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('appearance is one native three-way toggle with System default, saved manual choice and keyboard/touch support', { timeout: 15000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {AppearanceControl} from './src/web/AppearanceControl';createRoot(document.getElementById('root')).render(<header className="topbar"><AppearanceControl/></header>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' });
  const css = (await Promise.all(['styles.css', 'experience.css'].map(path => readFile(new URL(`../src/web/${path}`, import.meta.url), 'utf8')))).join('\n');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 200 }, colorScheme: 'light', reducedMotion: 'no-preference' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://appearance.test/**', route => route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('http://appearance.test/');
    const group = page.getByRole('radiogroup', { name: 'Appearance', exact: true });
    const system = group.getByRole('radio', { name: 'System appearance', exact: true });
    const light = group.getByRole('radio', { name: 'Light appearance', exact: true });
    const dark = group.getByRole('radio', { name: 'Dark appearance', exact: true });
    const theme = () => page.locator('html').getAttribute('data-theme');
    assert.equal(await group.getByRole('radio').count(), 3);
    assert.ok(await system.isChecked()); assert.equal(await theme(), 'light');
    await page.emulateMedia({ colorScheme: 'dark' }); assert.ok(await system.isChecked());
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await group.getByTitle('Light appearance', { exact: true }).click();
    await page.waitForFunction(() => document.documentElement.getAnimations({ subtree: true }).some(animation =>
      animation.effect instanceof KeyframeEffect && animation.effect.pseudoElement === '::view-transition-new(root)'));
    const slide = await page.evaluate(() => {
      const pseudo = '::view-transition-group(appearance-thumb)';
      const animation = document.documentElement.getAnimations({ subtree: true }).find(animation =>
        animation.effect instanceof KeyframeEffect && animation.effect.pseudoElement === pseudo);
      if (!animation) return undefined;
      const effect = animation.effect as KeyframeEffect;
      animation.pause(); animation.currentTime = 100;
      const position = new DOMMatrix(getComputedStyle(document.documentElement, pseudo).transform).m41;
      const endpoints = effect.getKeyframes().map(frame => new DOMMatrix(String(frame.transform)).m41);
      animation.play();
      return { duration: effect.getTiming().duration, position, endpoints };
    });
    assert.ok(slide, 'The thumb needs a visible moving layer above the page snapshot.');
    assert.equal(slide.duration, 200);
    assert.ok(slide.position > Math.min(...slide.endpoints) && slide.position < Math.max(...slide.endpoints),
      'The visible thumb must pass between the old and new choices during the reveal.');
    const reveal = await page.evaluate(() => {
      const animation = document.documentElement.getAnimations({ subtree: true }).find(animation =>
        animation.effect instanceof KeyframeEffect && animation.effect.pseudoElement === '::view-transition-new(root)')!;
      const effect = animation.effect as KeyframeEffect;
      animation.pause(); animation.currentTime = 140;
      const clip = getComputedStyle(document.documentElement, '::view-transition-new(root)').clipPath;
      animation.play();
      return { duration: effect.getTiming().duration, frames: effect.getKeyframes().map(frame => frame.clipPath), clip };
    });
    assert.equal(reveal.duration, 420);
    assert.match(String(reveal.frames[0]), /^circle\(0px at /);
    assert.notEqual(reveal.clip, reveal.frames[0], 'The reveal must advance between its endpoints.');
    assert.notEqual(reveal.clip, reveal.frames[1]);
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme-transition'));
    await page.reload(); assert.ok(await light.isChecked()); assert.equal(await theme(), 'light');
    await page.emulateMedia({ colorScheme: 'light' }); await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await theme(), 'light', 'Manual Light must ignore system changes.');
    await group.getByTitle('Dark appearance', { exact: true }).click();
    await page.reload(); assert.ok(await dark.isChecked()); assert.equal(await theme(), 'dark');
    await group.getByTitle('System appearance', { exact: true }).click();
    await page.reload(); assert.ok(await system.isChecked());
    await system.focus(); await page.keyboard.press('ArrowRight'); assert.ok(await light.isChecked());
    await page.keyboard.press('ArrowRight'); assert.ok(await dark.isChecked());
    await page.setViewportSize({ width: 390, height: 200 });
    for (const label of await group.locator('label').all()) {
      const box = await label.boundingBox(); assert.ok(box && box.width >= 44 && box.height >= 44);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await group.locator('.appearance-thumb').evaluate(element => getComputedStyle(element).transitionProperty), 'none');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme-transition'));
    await light.evaluate(input => (input as HTMLInputElement).click());
    await page.waitForFunction(() => document.documentElement.getAnimations({ subtree: true }).some(animation =>
      animation.effect instanceof KeyframeEffect && animation.effect.pseudoElement === '::view-transition-new(root)'));
    const fade = await page.evaluate(() => {
      const effect = document.documentElement.getAnimations({ subtree: true }).find(animation =>
        animation.effect instanceof KeyframeEffect && animation.effect.pseudoElement === '::view-transition-new(root)')!.effect as KeyframeEffect;
      return { duration: effect.getTiming().duration, frames: effect.getKeyframes().map(frame => ({ opacity: frame.opacity, clipPath: frame.clipPath })) };
    });
    assert.equal(fade.duration, 120);
    assert.deepEqual(fade.frames, [{ opacity: '0', clipPath: undefined }, { opacity: '1', clipPath: undefined }]);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement, '::view-transition-group(appearance-thumb)').animationName), 'none');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme-transition'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      for (const name of ['Dark appearance', 'Light appearance', 'Dark appearance']) {
        document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!.click();
      }
    });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme-transition'));
    assert.equal(await theme(), 'dark'); assert.ok(await dark.isChecked());
    assert.equal(await page.evaluate(() => localStorage.getItem('vibeworks.appearance')), 'dark');
    await page.evaluate(() => Object.defineProperty(document, 'startViewTransition', { value: undefined, configurable: true }));
    await light.evaluate(input => (input as HTMLInputElement).click());
    assert.equal(await theme(), 'light'); assert.ok(await light.isChecked());
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
