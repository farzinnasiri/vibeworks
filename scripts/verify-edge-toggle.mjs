/** Actual viewport regression with exact Node geometry in a disposable workspace. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {SqliteStore} from '../src/bridge/sqlite-store.ts';
import {startBridge} from '../src/bridge/server.ts';
import {emptyDocument} from '../src/cad/document.ts';
import {LEGACY_PROJECT_ID} from '../src/shared/protocol.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(join(tmpdir(),'edge-toggle-'));
const out=join(root,'output/playwright/edge-toggle');await mkdir(out,{recursive:true});
process.env.VIBEWORKS_WEB_PORT='45218';process.env.VIBEWORKS_BRIDGE_PORT='44373';
const doc={...emptyDocument(),name:'Dark authored body',kind:'assembly',analysis:{auto:false},features:[{id:'body',kind:'box',params:{origin:[0,0,0],size:[40,30,15]},appearance:{material:'steel',color:'#101820'}}]};
const store=new SqliteStore(join(dir,'workspace.db'));await store.put(doc);await store.operation({action:'project',project:{projectId:LEGACY_PROJECT_ID,name:'Edge toggle acceptance',mainAssemblyId:doc.documentId,version:1},expectedVersion:1});store.close();
let bridge,server,browser;const errors=[],results={};
try{
 bridge=await startBridge({port:44373,databasePath:join(dir,'workspace.db'),connectionFile:join(dir,'connection.json'),workers:1,webOrigins:['http://127.0.0.1:45218']});await bridge.ready();
 server=await createServer({root,configFile:join(root,'vite.config.ts')});await server.listen();
 browser=await chromium.launch({headless:true,args:['--use-angle=metal']});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce',colorScheme:'dark'});
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 // Count the line segments actually submitted by the last WebGL frame, rather than testing a helper
 // that a later styling branch could override again. Grid/axes provide a stable baseline.
 await page.addInitScript(()=>{
  window.__edgeSegments=0;
  for(const proto of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype]){
   const clear=proto.clear;proto.clear=function(mask){if(mask&this.COLOR_BUFFER_BIT)window.__edgeSegments=0;return clear.call(this,mask);};
   for(const key of ['drawArrays','drawElements']){const draw=proto[key];proto[key]=function(...args){if(args[0]===this.LINES)window.__edgeSegments+=(key==='drawArrays'?args[2]:args[1])/2;return draw.apply(this,args);};}
  }
 });
 await page.goto('http://127.0.0.1:45218');await page.evaluate(()=>window.__cad.ready);
 await page.getByRole('button',{name:/Edge toggle acceptance.*document/}).click();await page.getByRole('button',{name:'Open project',exact:true}).click();
 await page.locator('.loading').waitFor({state:'hidden'});
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.getByRole('button',{name:'View options',exact:true}).click();
 const toggle=page.getByRole('menuitemcheckbox',{name:/Show edges/});
 if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click();
 await settle();const on=await page.evaluate(()=>window.__edgeSegments);
 await page.screenshot({path:join(out,'dark-edges-on.png')});
 await toggle.click();await settle();const off=await page.evaluate(()=>window.__edgeSegments);
 await page.screenshot({path:join(out,'dark-edges-off.png')});
 assert.ok(on>off,JSON.stringify({on,off}));
 await page.keyboard.press('Escape');await page.evaluate(()=>window.__cad.select(['body']));await settle();
 const selected=await page.evaluate(()=>window.__edgeSegments);assert.ok(selected>off,JSON.stringify({selected,off}));
 await page.screenshot({path:join(out,'dark-selected-edges-off.png')});
 await page.evaluate(()=>window.__cad.select([]));await settle();assert.equal(await page.evaluate(()=>window.__edgeSegments),off);
 // Switch System appearance to light through the OS preference, without touching saved geometry.
 await page.emulateMedia({colorScheme:'light'});await settle();
 await page.getByRole('button',{name:'View options',exact:true}).click();await toggle.click();await settle();const lightOn=await page.evaluate(()=>window.__edgeSegments);
 await toggle.click();await settle();const lightOff=await page.evaluate(()=>window.__edgeSegments);assert.ok(lightOn>lightOff,JSON.stringify({lightOn,lightOff}));
 const saved=await page.evaluate(()=>window.__cad.inspect().document);assert.equal(saved.revision,doc.revision);assert.equal(saved.features[0].appearance.color,'#101820');
 assert.deepEqual(errors,[]);Object.assign(results,{dark:{on,off,selected},light:{on:lightOn,off:lightOff},savedAppearanceAndRevisionUnchanged:true,pageErrors:errors});
 await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));console.log(results);
}catch(error){const page=browser?.contexts()[0]?.pages()[0];if(page){await page.screenshot({path:join(out,'failure.png')});await writeFile(join(out,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{await browser?.close();await server?.close();await bridge?.close();await rm(dir,{recursive:true,force:true});}
