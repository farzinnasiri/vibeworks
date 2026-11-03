import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { OrthographicCamera } from 'three';
declare global { interface Window { __navigationControls: OrbitControls & { object: OrthographicCamera }; fit: () => void; setNavigationTool: (tool: 'select' | 'pan' | 'orbit' | 'zoom') => void; selectionClicks: number } }
const root = fileURLToPath(new URL('../', import.meta.url));

test('the actual workbench pans after pinch, orbits with Shift, and recovers with Fit', { timeout: 30000 }, async () => {
const source = `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import {Viewport} from './src/web/Viewport';
function Harness(){const [fitKey,setFit]=useState(0);const [navigationTool,setNavigationTool]=useState('select');window.fit=()=>setFit(x=>x+1);window.setNavigationTool=setNavigationTool;window.selectionClicks??=0;return <Viewport evaluation={{geometry:[],meshes:[],visibleFeatureIds:[],warnings:[]}} selected={[]} ghosts={[]} view="isometric" fitKey={fitKey} documentId="test" revision={1} snap={false} navigation="trackpad" navigationTool={navigationTool} name={id=>id} onSelect={()=>window.selectionClicks++} onTransform={async()=>{}}/>};createRoot(document.getElementById('root')).render(<Harness/>);`;
const bundle = await build({stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',plugins:[{name:'observe-controls',setup(b){b.onLoad({filter:/\/OrbitControls\.js$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('super( object, domElement );','super( object, domElement ); globalThis.__navigationControls = this;'),loader:'js'}));}}]});
const browser=await chromium.launch({headless:true,args:process.platform === 'darwin' ? ['--use-angle=metal'] : []});
try {
const page=await browser.newPage({viewport:{width:1200,height:800}});page.on('pageerror',e=>console.error(e.message));
await page.route('http://vibeworks.test/**',route=>route.fulfill({contentType:'text/html',body:`<style>html,body,#root{margin:0;width:100%;height:100%}.viewport{position:absolute;inset:0}.viewport>canvas{display:block;width:100%;height:100%}.axis-triad,.dimension-callouts{display:none}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`}));
await page.goto('http://vibeworks.test/');await page.waitForFunction(()=>window.__navigationControls?.object.projectionMatrix.elements.every(Number.isFinite));
const state=()=>page.evaluate(()=>({target:window.__navigationControls.target.toArray(),position:window.__navigationControls.object.position.toArray(),zoom:window.__navigationControls.object.zoom}));
await page.locator('canvas').evaluate(c=>c.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-75,clientX:780,clientY:300,bubbles:true,cancelable:true})));
const before=await state();
await page.locator('canvas').evaluate(c=>c.dispatchEvent(new WheelEvent('wheel',{deltaX:90,deltaY:40,clientX:780,clientY:300,bubbles:true,cancelable:true})));
const after=await state();
assert.ok(Math.hypot(...after.target.map((v,i)=>v-before.target[i]))>0.01,'Two-finger scroll after pinch must pan the orbit target');
assert.ok(Math.abs(after.zoom-before.zoom)<1e-8,'Two-finger scroll must not keep zooming');
await page.locator('canvas').evaluate(c=>c.dispatchEvent(new WheelEvent('wheel',{shiftKey:true,deltaX:60,deltaY:20,clientX:780,clientY:300,bubbles:true,cancelable:true})));
const orbit=await state();assert.ok(Math.hypot(...orbit.position.map((v,i)=>v-after.position[i]))>0.01,'Shift-scroll must orbit after panning');
await page.evaluate(()=>window.fit());await page.waitForTimeout(100);const fit=await state();assert.ok(Math.abs(fit.zoom-1)<1e-8,'Fit must recover zoom');
const drag=async()=>{await page.mouse.move(650,400);await page.mouse.down();await page.mouse.move(750,450,{steps:5});await page.mouse.up();};
for(const mode of ['pan','orbit','zoom'] as const){
  await page.evaluate(mode=>window.setNavigationTool(mode),mode);
  await page.waitForFunction(mode=>window.__navigationControls.mouseButtons.LEFT===({pan:2,orbit:0,zoom:1})[mode],mode);
  const start=await state();await drag();const end=await state();
  if(mode==='pan') {assert.notDeepEqual(end.target,start.target,'Pan must move the camera target');assert.equal(end.zoom,start.zoom);}
  if(mode==='orbit') {assert.notDeepEqual(end.position,start.position,'Orbit must rotate the camera');assert.ok(Math.hypot(...end.target.map((v,i)=>v-start.target[i]))<1e-8,'Orbit must retain its target');}
  if(mode==='zoom') {assert.notEqual(end.zoom,start.zoom,'Zoom must change camera magnification');}
  await page.locator('canvas').click({position:{x:600,y:400}});
  assert.equal(await page.evaluate(()=>window.selectionClicks),0,'Navigation must preserve selection even on a click');
}
await page.evaluate(()=>window.setNavigationTool('select'));
await page.waitForFunction(()=>window.__navigationControls.mouseButtons.LEFT===0);
await page.locator('canvas').click({position:{x:600,y:400}});
assert.equal(await page.evaluate(()=>window.selectionClicks),1,'Select must restore picking');
}finally{await browser.close();}

});
