import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('gallery survives reload, merges completed images across tabs, and keeps deletions and reports its bound', { timeout: 20000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {addRender,removeRender,useStudioRenders,loadRenderHistory,GALLERY_LIMITS,useGalleryNotice} from './src/web/studio-renders';
    GALLERY_LIMITS.images=8;
    function History(){const rows=useStudioRenders('model'),notice=useGalleryNotice();return <><div id="history">{rows.map(r=><span key={r.id}>{r.id}</span>)}</div><p id="notice">{notice}</p></>}
    createRoot(document.getElementById('root')).render(<History/>);
    window.remove=removeRender;
    window.make=async id=>{await loadRenderHistory();const canvas=document.createElement('canvas');canvas.width=canvas.height=4;
      const blob=await new Promise(done=>canvas.toBlob(done));addRender({id,documentId:'model',revision:1,createdAt:Date.now(),
        blob,url:URL.createObjectURL(blob),width:4,height:4,samples:0,quality:'Fast',elapsedMs:10,hiddenMs:0,
        shot:{projection:'perspective',position:[1,1,1],target:[0,0,0],up:[0,0,1],fov:35,zoom:1},settings:{},renderer:'test'});};
    window.stored=()=>new Promise(resolve=>{const r=indexedDB.open('vibeworks.studio.history',1);r.onsuccess=()=>{
      const db=r.result,q=db.transaction('images').objectStore('images').getAll();q.onsuccess=()=>{db.close();resolve(q.result.map(x=>x.id).sort())}}});
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('http://history.test/**', route => route.fulfill({ contentType: 'text/html', body: `<div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    const a = await context.newPage(), b = await context.newPage();
    await a.goto('http://history.test/'); await b.goto('http://history.test/');
    await a.evaluate(() => (window as any).make('A'));
    await a.waitForFunction(async () => (await (window as any).stored()).join() === 'A');
    await b.evaluate(() => (window as any).make('B'));
    await b.waitForFunction(async () => (await (window as any).stored()).join() === 'A,B');
    await a.reload(); await a.locator('#history span').nth(1).waitFor();
    assert.deepEqual((await a.locator('#history span').allTextContents()).sort(), ['A','B']);
    await b.reload(); await b.locator('#history span').nth(1).waitFor();
    await a.evaluate(() => (window as any).remove('A'));
    await a.waitForFunction(async () => (await (window as any).stored()).join() === 'B');
    await b.evaluate(() => (window as any).make('C'));
    await b.waitForFunction(async () => (await (window as any).stored()).join() === 'B,C');
    await a.reload(); await a.locator('#history span').nth(1).waitFor();
    assert.deepEqual((await a.locator('#history span').allTextContents()).sort(), ['B','C']);
    for (let i=0;i<10;i++) await a.evaluate(id => (window as any).make(id), `render${i}`);
    await a.waitForFunction(async () => { const ids=await (window as any).stored();return ids.length===8&&ids.includes('render9'); });
    await a.reload(); await a.locator('#history span').nth(7).waitFor();
    assert.equal(await a.locator('#history span').count(),8);
    assert.equal(await a.locator('#history').innerText().then(text=>text.includes('render0')),false);
    // Reaching the bound is reported, never silent.
    await a.evaluate(id => (window as any).make(id), 'render10');
    await a.waitForFunction(() => document.getElementById('notice')!.textContent!.includes('oldest image was removed'));
  } finally { await browser.close(); }
});
