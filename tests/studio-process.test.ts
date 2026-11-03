import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('Studio shows compact transient progress without reserving or shifting the image area', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React,{useRef,useState,useEffect} from 'react';import{createRoot}from'react-dom/client';
    import{StudioProcess}from'./src/web/StudioProcess';
    function Harness(){const thumb=useRef(null),[state,setState]=useState({kind:'preview',phase:'preparing',title:'Preparing Studio',detail:'Loading model'});
      useEffect(()=>{window.setProcess=data=>setState({...data,cancel:data.phase==='idle'||data.phase==='error'?undefined:()=>window.cancels=(window.cancels??0)+1})},[]);
      return <div className="studio-workspace" style={{position:"relative",display:"block",height:600}}><div className="studio-picture" style={{height:600}}><StudioProcess state={state} thumbnail={thumb}/><div className="studio-viewport"/></div></div>}
    createRoot(document.getElementById('root')).render(<Harness/>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic' });
  const css = (await Promise.all(['styles.css','experience.css','studio-workspace.css'].map(name => readFile(new URL(`../src/web/${name}`,import.meta.url),'utf8')))).join('\n');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.route('http://process.test/**', route => route.fulfill({ contentType: 'text/html', body: `<style>${css}body{margin:0}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('http://process.test/'); await page.waitForFunction(() => (window as any).setProcess);
    await page.locator('.studio-workspace').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
    for (const width of [1100,390]) {
      await page.setViewportSize({width,height:800});
      const baseline = await page.locator('.studio-viewport').boundingBox();
      assert.ok(baseline);
      for (const state of [
        {kind:'image',phase:'compiling',title:'Compiling image shaders',detail:'1920 × 1080 · Draft'},
        {kind:'image',phase:'rendering',title:'Rendering image',detail:'12 / 24 samples',value:.5,elapsedMs:1000,etaMs:1000,thumbnail:true},
        {kind:'image',phase:'finishing',title:'Finishing image',detail:'Saving PNG'},
        {kind:'video',phase:'rendering',title:'Rendering video',detail:'Frame 25 / 240',value:.1,elapsedMs:2000,etaMs:18000},
        {kind:'video',phase:'encoding',title:'Encoding MP4',detail:'240 frames rendered'},
        {kind:'preview',phase:'idle',title:'Studio ready',detail:'Choose a view'},
      ]) {
        await page.evaluate(data => (window as any).setProcess(data),state);
        await page.getByRole('status').filter({hasText:state.title}).waitFor();
        assert.deepEqual(await page.locator('.studio-viewport').boundingBox(),baseline);
        assert.equal(await page.locator('.studio-process').count(),state.phase === 'idle' ? 0 : 1);
        assert.equal(await page.locator('.wave-field').count(),0);
        const meter = page.getByRole('progressbar');
        if (state.phase==='idle') assert.equal(await meter.count(),0);
        else {
          assert.equal(await meter.count(),1);
          const processBox = (await page.locator('.studio-process').boundingBox())!;
          assert.ok(processBox.width <= 400 && processBox.height < 130, 'Progress remains compact.');
          assert.ok(processBox.x >= 0 && processBox.x + processBox.width <= width, 'Progress stays inside the canvas.');
          assert.equal(await meter.getAttribute('aria-valuenow'),'value' in state ? String(state.value! * 100) : null);
        }
      }
    }
    await page.evaluate(() => (window as any).setProcess({kind:'video',phase:'rendering',title:'Rendering video',detail:'Frame 2 / 240',value:.01}));
    await page.getByRole('button',{name:'Cancel video'}).click();
    assert.equal(await page.evaluate(() => (window as any).cancels),1);
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.studio-process-scan').evaluate(el=>getComputedStyle(el).animationName),'none');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  } finally { await browser.close(); }
});
