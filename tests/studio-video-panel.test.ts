import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('video camera selection restores its camera and scene on ready, removal, undo and remount without overriding manual navigation', { timeout: 30_000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';
    import{StudioVideoPanel}from'./src/web/StudioVideoPanel';
    const views=Array.from({length:3},(_,i)=>({id:'00000000-0000-4000-8000-00000000000'+(i+1),name:'Camera '+(i+1),
      camera:{position:[[100,100,70],[100,-100,70],[-100,-100,70]][i],target:[0,0,0],fov:35,focalLengthMm:50},
      presentation:{environmentPreset:'dark_studio',floor:'none',background:['#aa3333','#33aa33','#3333aa'][i]},motion:'move',seconds:1,hold:.5}));
    localStorage.setItem('vibeworks.studio.video.selection-fixture',JSON.stringify(views));window.originalViews=views;
    const evaluation={meshes:[],geometry:[],visibleFeatureIds:[]},settings={background:'#888888'};
    function Harness(){const[ready,setReady]=useState(false),[key,setKey]=useState(0),[interaction,setInteraction]=useState(0);
      const api=useRef({captureVideo:()=>window.camera,previewVideo:camera=>{window.camera=structuredClone(camera);window.cameraCalls=(window.cameraCalls??0)+1}});
      useEffect(()=>{window.readyVideo=()=>setReady(true);window.manualCamera=camera=>{window.camera=camera;setInteraction(n=>n+1)};window.remountVideo=()=>setKey(n=>n+1)},[]);
      return <StudioVideoPanel key={key} documentId="selection-fixture" revision={0} name="Fixture" evaluation={evaluation} settings={settings} api={api} ready={ready} perspective interaction={interaction}
        execute={async command=>command.params.action==='cancel'?{status:'success',videoJob:{state:'cancelled'}}:{status:'error',error:{code:'RENDER_TIMEOUT',message:'Video exceeded its render budget.'}}}
        onScene={scene=>window.scene=scene} onBusy={()=>{}} onProcess={()=>{}} onSave={async()=>undefined} onFrame={()=>{}}/>;
    }createRoot(document.getElementById('root')).render(<Harness/>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: 'fixture.js', loader: { '.css': 'empty', '.tza': 'dataurl' }, define: { __VIBEWORKS_FINGERPRINT__: '"selection-fixture"' } });
  const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:49998/**', route => route.fulfill({ contentType: 'text/html', body: `<div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('http://127.0.0.1:49998/');
    await page.waitForFunction(() => typeof (window as any).readyVideo === 'function');
    assert.equal(await page.evaluate(() => (window as any).cameraCalls ?? 0), 0);
    await page.evaluate(() => (window as any).readyVideo());
    const assertSelected = async (index: number) => {
      await page.waitForFunction(index => JSON.stringify((window as any).camera) === JSON.stringify((window as any).originalViews[index].camera), index);
      const result = await page.evaluate(index => ({ camera: (window as any).camera, scene: (window as any).scene, expected: (window as any).originalViews[index] }), index);
      assert.deepEqual(result.camera, result.expected.camera);
      assert.deepEqual(result.scene, result.expected.presentation);
      assert.equal(await page.locator('.studio-video-shots button.active').getAttribute('aria-label'), `View ${index + 1}: Camera ${index + 1}`);
    };
    await assertSelected(0);
    await page.getByRole('button', { name: 'View 3: Camera 3', exact: true }).click();
    await assertSelected(2);
    await page.getByRole('button', { name: 'Edit view', exact: true }).click();
    await page.getByRole('button', { name: 'Remove view', exact: true }).click();
    await assertSelected(1);
    await page.getByRole('button', { name: 'Undo sequence change', exact: true }).click();
    await assertSelected(0);
    const manual = { position: [220, 70, 35], target: [1, 2, 3], fov: 45, focalLengthMm: 35 };
    const calls = await page.evaluate(() => (window as any).cameraCalls);
    await page.evaluate(camera => (window as any).manualCamera(camera), manual);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await page.evaluate(() => (window as any).camera), manual);
    assert.equal(await page.evaluate(() => (window as any).cameraCalls), calls);
    await page.getByRole('button', { name: 'View 2: Camera 2', exact: true }).click();
    await assertSelected(1);
    await page.evaluate(() => (window as any).remountVideo());
    await assertSelected(0);
    await page.locator('.studio-video-export-summary').click();
    assert.equal(await page.getByRole('button',{name:'Realistic',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Fast',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByText('Realistic video is unavailable until renders can resume after interruption.',{exact:false}).waitFor();
    await page.locator('.studio-video-export-summary').click();
    await page.getByRole('button',{name:'Render video',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.studio-video-panel')?.getAttribute('data-video-state')==='error');
    assert.equal(await page.locator('.studio-video-panel').getAttribute('data-error-code'),'RENDER_TIMEOUT');
    assert.equal(await page.getByRole('button',{name:'Render video',exact:true}).isEnabled(),true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
