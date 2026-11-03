import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {SqliteStore} from '../src/bridge/sqlite-store.ts';
import {startBridge} from '../src/bridge/server.ts';
import {emptyDocument} from '../src/cad/document.ts';
import {LEGACY_PROJECT_ID} from '../src/shared/protocol.ts';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'vibeworks-foundations-'));
const out=join(root,'output/playwright/foundations');await mkdir(out,{recursive:true});
const webPort=Number(process.env.FOUNDATIONS_WEB_PORT??45283);
const part={...emptyDocument(),name:'Canopy source with a deliberately long name for checking source identity and return navigation',analysis:{auto:false},features:[{id:'canopy',kind:'box',params:{origin:[0,0,0],size:[40,30,12]},appearance:{material:'steel',color:'#39526b'}}]};
const placement={translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]};
const inner={...emptyDocument(),kind:'assembly',name:'Nested canopy assembly',analysis:{auto:false},features:[{id:'canopy_inner',kind:'instance',params:{...placement,document:part.documentId}}]};
const assembly={...emptyDocument(),kind:'assembly',name:'Occurrence face acceptance',analysis:{auto:false},features:[{id:'canopy_outer',label:'Canopy occurrence with a deliberately long component label',kind:'instance',params:{...placement,document:inner.documentId}}]};
const store=new SqliteStore(join(dir,'workspace.db'));for(const doc of[part,inner,assembly])await store.put(doc);await store.operation({action:'project',project:{projectId:LEGACY_PROJECT_ID,name:'Foundations isolated acceptance',version:1,mainAssemblyId:assembly.documentId},expectedVersion:1});store.close();
let bridge,server,browser;const errors=[],evidence=[];
try{
 bridge=await startBridge({port:0,databasePath:join(dir,'workspace.db'),connectionFile:join(dir,'connection.json'),workers:1,webOrigins:[`http://127.0.0.1:${webPort}`]});await bridge.ready();
 process.env.VIBEWORKS_BRIDGE_PORT=String(new URL(bridge.connection.httpUrl).port);process.env.VIBEWORKS_WEB_PORT=String(webPort);
 server=await createServer({root,configFile:join(root,'vite.config.ts')});await server.listen();
 browser=await chromium.launch({headless:true,args:['--use-angle=metal']});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${webPort}`);await page.evaluate(()=>window.__cad.ready);
 await page.getByRole('button',{name:/Foundations isolated acceptance.*documents/}).click();await page.getByRole('button',{name:'Open project',exact:true}).click();await page.locator('.loading').waitFor({state:'hidden'});
 await page.waitForFunction(()=>window.__cad.inspect().evaluation.meshes.length>0);
 const projection=await page.evaluate(async id=>window.__cad.execute({type:'inspect_model',params:{documentId:id,select:{topology:{target:{feature:'canopy_outer'}}}}}),assembly.documentId);
 assert.equal(projection.status,'success',JSON.stringify(projection.error));const m=projection.inspection.topology[0];assert.deepEqual(m.path,['canopy_outer','canopy_inner','canopy']);assert.equal(m.source.documentId,part.documentId);assert.equal(m.faces.length,6);
 const pick={documentId:assembly.documentId,revision:projection.revision,storageVersion:projection.storageVersion,displayKey:m.displayKey,feature:'canopy_outer',path:m.path.slice(1),faceIndex:m.faces[0].index,point:m.faces[0].center,normal:m.faces[0].normal};
 const fromPick=await page.evaluate(async ({id,pick})=>window.__cad.execute({type:'inspect_model',params:{documentId:id,select:{topology:{target:{feature:'canopy_outer'},faces:{pick}}}}}),{id:assembly.documentId,pick});assert.equal(fromPick.status,'success',JSON.stringify(fromPick.error));assert.equal(fromPick.inspection.topology[0].faces.length,1);
 await page.getByRole('button',{name:'View options',exact:true}).click();const match=page.getByRole('menuitemcheckbox',{name:/Match Studio looks/});await match.click();assert.equal(await match.getAttribute('aria-checked'),'true');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.__cad.inspect().document.revision),0);
 await page.locator('.model-tree-row[data-feature="canopy_outer"]').click();
 const canvas=page.locator('canvas[aria-label^="Model viewport"]');await canvas.waitFor();const box=await canvas.boundingBox();
 await canvas.click({position:{x:box.width/2,y:box.height/2},modifiers:['Alt']});
 const details=page.getByRole('region',{name:'Face details',exact:true});await details.waitFor();
 assert.ok(await details.getByRole('button',{name:'Return to component'}).isVisible());
 const neighbour=details.getByRole('group',{name:'Neighbouring faces'}).getByRole('button').first();await neighbour.focus();await page.keyboard.press('Enter');assert.equal(await page.locator(':focus').count(),1);
 // Exercise the actual face paint dry run, commit, return and undo through the browser.
 const volume=await page.evaluate(()=>window.__cad.inspect().evaluation.geometry[0].volumeMm3);
 await details.getByLabel('Face color',{exact:true}).fill('#ee2200');
 await details.getByRole('button',{name:'Apply face paint',exact:true}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Apply face paint'&&!b.disabled));
 assert.equal(await page.evaluate(()=>window.__cad.inspect().document.revision),0);
 await details.getByRole('button',{name:'Cancel paint',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__cad.inspect().document.revision),0);
 await details.getByLabel('Face color',{exact:true}).fill('#ee2200');
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Apply face paint'&&!b.disabled));
 await details.getByRole('button',{name:'Apply face paint',exact:true}).click();
 await page.waitForFunction(()=>window.__cad.inspect().document.revision===1&&!window.__cad.inspect().busy);
 assert.equal(await page.evaluate(()=>window.__cad.inspect().evaluation.geometry[0].volumeMm3),volume);
 assert.ok(await page.evaluate(()=>window.__cad.inspect().document.features[0].surfaceStyles.length===1));
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await page.waitForFunction(()=>window.__cad.inspect().document.revision===2&&!window.__cad.inspect().busy);
 assert.equal(await page.evaluate(()=>window.__cad.inspect().document.features[0].surfaceStyles),undefined);
 await canvas.click({position:{x:box.width/2,y:box.height/2},modifiers:['Alt']});await details.waitFor();
 for(const theme of['light','dark']){
  await page.evaluate(theme=>{localStorage.setItem('vibeworks.appearance',theme);window.dispatchEvent(new StorageEvent('storage',{key:'vibeworks.appearance',newValue:theme}));},theme);
  for(const width of[1440,1100,390]){
   await page.setViewportSize({width,height:1000});if(width===390){const toggle=page.getByRole('button',{name:'Details panel',exact:true});if(await toggle.isVisible()&&await toggle.getAttribute('aria-pressed')!=='true')await toggle.click();}
   await details.waitFor({state:'visible'});
   await page.screenshot({path:join(out,`face-${theme}-${width}.png`)});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false,`${theme}/${width}`);evidence.push({theme,width,overflow});
  }
 }
 await page.setViewportSize({width:1440,height:1000});
 await details.getByRole('button',{name:'Return to component'}).click();await page.getByRole('region',{name:'Inspector',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 await writeFile(join(out,'results.json'),JSON.stringify({facePick:true,nestedSource:true,keyboardNeighbours:true,matchingPickInspection:true,matchStudioToggleDoesNotWrite:true,facePaintPreview:true,cancelPreservesRevision:true,applyPreservesVolume:true,undoPaint:true,returnToComponent:true,evidence,pageErrors:errors,limits:'Regions, extraction and analysis jobs are not verified by this script.'},null,2)+'\n');
 console.log(JSON.stringify({status:'passed',out,captures:evidence.length}));
}catch(error){const page=browser?.contexts()[0]?.pages()[0];if(page){await page.screenshot({path:join(out,'failure.png')});await writeFile(join(out,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{await browser?.close();await server?.close();await bridge?.close();await rm(dir,{recursive:true,force:true});}
