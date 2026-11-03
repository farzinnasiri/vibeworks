import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {SqliteStore} from '../src/bridge/sqlite-store.ts';
import {startBridge} from '../src/bridge/server.ts';
import {emptyDocument} from '../src/cad/document.ts';
import {LEGACY_PROJECT_ID} from '../src/shared/protocol.ts';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'inspector-appearance-'));
const out=join(root,'output/playwright/inspector-appearance');await mkdir(out,{recursive:true});
process.env.VIBEWORKS_WEB_PORT='45216';process.env.VIBEWORKS_BRIDGE_PORT='44371';
const part={...emptyDocument(),name:'Frame source with a long descriptive title',analysis:{auto:false},features:[{id:'frame',label:'Frame body',kind:'box',params:{origin:[0,0,0],size:[40,30,5]},appearance:{material:'steel',color:'#30353b'}}]};
const machine={...emptyDocument(),name:'Machine assembly',kind:'assembly',analysis:{auto:false},features:[{id:'frame_component',label:'Frame component',kind:'instance',params:{document:part.documentId,translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}]};
const store=new SqliteStore(join(dir,'workspace.db'));await store.put(part);await store.put(machine);await store.operation({action:'project',project:{projectId:LEGACY_PROJECT_ID,name:'Inspector acceptance',mainAssemblyId:machine.documentId,version:1},expectedVersion:1});store.close();
let bridge,server,browser;const errors=[],results={};
try{
 bridge=await startBridge({port:44371,databasePath:join(dir,'workspace.db'),connectionFile:join(dir,'connection.json'),workers:1,webOrigins:['http://127.0.0.1:45216']});await bridge.ready();
 server=await createServer({root,configFile:join(root,'vite.config.ts')});await server.listen();browser=await chromium.launch({headless:true,args:['--use-angle=metal']});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce',colorScheme:'dark'});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:45216');await page.evaluate(()=>window.__cad.ready);await page.getByRole('button',{name:/Inspector acceptance.*documents/}).click();await page.getByRole('button',{name:'Open project',exact:true}).click();await page.locator('.loading').waitFor({state:'hidden'});
 const waitDoc=async id=>{await page.waitForFunction(id=>window.__cad.inspect().document.documentId===id&&!window.__cad.inspect().busy,id);await page.locator('.loading').waitFor({state:'hidden'});};
 const inspector=page.getByRole('region',{name:'Inspector',exact:true});
 await page.locator('.model-tree-row[data-feature="frame_component"]').click();
 const card=page.locator('.inspector-card[aria-label="Inspector"]');await card.getByRole('tab',{name:'Appearance',exact:true}).waitFor();
 assert.equal(await card.getByRole('combobox').count(),2);assert.equal(await card.getByText('Appearance override',{exact:true}).count(),0);
 const undoX=(await page.getByRole('button',{name:'Undo',exact:true}).boundingBox()).x;
 await page.getByRole('button',{name:'Expand Frame component',exact:true}).click();await page.locator(`.model-tree-row[data-owner="${part.documentId}"]`).waitFor();
 const occurrence=page.locator(`.model-tree-row[data-owner="${part.documentId}"]`).first();const before=await occurrence.boundingBox();const rowsBefore=await page.locator('.model-tree-row').count();
 await occurrence.click();await waitDoc(part.documentId);const after=await page.locator(`.model-tree-row[data-owner="${part.documentId}"]`).first().boundingBox();
 assert.ok(Math.abs(after.y-before.y)<2,JSON.stringify({before,after}));assert.equal(await page.locator('.model-tree-row').count(),rowsBefore);
 results.tree={stableExpandedOccurrence:true};
 const original=await page.evaluate(async id=>window.__cad.execute({type:'inspect_model',params:{documentId:id,snapshot:{}}}),part.documentId);assert.equal(original.status,'success');
 const color=card.getByLabel('Color',{exact:true});await color.fill('#143052');
 await card.getByRole('button',{name:'Apply appearance',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__cad.inspect().document.features.find(f=>f.id==='frame').appearance.color),'#30353b');
 await page.screenshot({path:join(out,'color-preview-selected.png')});
 await card.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await color.inputValue(),'#30353b');
 await color.fill('#143052');await card.getByRole('button',{name:'Apply appearance',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===1&&!window.__cad.inspect().busy);
 const selectedImage=await page.screenshot({path:join(out,'selected-material.png')});await page.evaluate(()=>window.__cad.select([]));const unselectedImage=await page.screenshot({path:join(out,'unselected-material.png')});
 const pixel=buffer=>page.evaluate(async source=>{const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(600,500,1,1).data];},'data:image/png;base64,'+buffer.toString('base64'));
 assert.deepEqual(await pixel(selectedImage),await pixel(unselectedImage));
 await page.evaluate(()=>window.__cad.select(['frame']));
 await page.getByRole('button',{name:'Back to Machine assembly',exact:true}).click();await waitDoc(machine.documentId);
 assert.ok(Math.abs((await page.getByRole('button',{name:'Undo',exact:true}).boundingBox()).x-undoX)<2);
 await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(()=>!window.__cad.inspect().busy);await page.waitForFunction(()=>window.__cad.inspect().evaluation.meshes.some(m=>m.appearance?.color==='#30353b'));
 assert.equal(await page.evaluate(()=>window.__cad.inspect().document.documentId),machine.documentId);assert.equal(await page.evaluate(()=>window.__cad.inspect().document.features.length),1);
 await page.getByRole('button',{name:'Redo',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().evaluation.meshes.some(m=>m.appearance?.color==='#143052'));
 results.appearance={draftDoesNotWrite:true,cancelRestores:true,applyCommits:true,undoSourceFromAssembly:true,redoSourceFromAssembly:true,componentPreserved:true,toolbarAnchored:true};
 // Historical snapshots must keep the original color, not the latest appearance override.
 const receipt=await page.evaluate(async ({id,snapshot})=>window.__cad.execute({type:'inspect_model',params:{documentId:id,snapshot:{id:snapshot}}}),{id:part.documentId,snapshot:original.snapshot.snapshotId});assert.equal(receipt.status,'success');assert.equal(receipt.document.features[0].appearance.color,'#30353b');results.history={frozenOriginalAppearance:true};
 // An occurrence override changes the parent, while the reusable source keeps its own color.
 await card.getByLabel('Color',{exact:true}).fill('#cc6633');await card.getByRole('button',{name:'Apply appearance',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===1&&!window.__cad.inspect().busy);
 const source=await page.evaluate(async id=>window.__cad.execute({type:'inspect_model',params:{documentId:id,definitionsOnly:true}}),part.documentId);assert.equal(source.document.features[0].appearance.color,'#143052');
 await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===2&&!window.__cad.inspect().busy);assert.equal(await page.evaluate(()=>window.__cad.inspect().document.features[0].appearance),undefined);results.appearance.componentOverrideKeepsSource=true;
 for(const width of[1440,1100,390]){await page.setViewportSize({width,height:1000});if(width===390)await page.getByRole('button',{name:'Details panel',exact:true}).click();await page.screenshot({path:join(out,`inspector-${width}.png`)});const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(el).position!=='absolute').slice(0,12).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right}))}));assert.ok(overflow.scroll<=width,JSON.stringify(overflow));}
 const headers={Authorization:'Bearer '+bridge.connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':bridge.connection.fingerprint};
 const call=async command=>(await(await fetch(bridge.connection.httpUrl+'/command',{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),command,...(globalThis.sessionId?{sessionId:globalThis.sessionId}:{})})})).json());
 globalThis.sessionId=(await call({type:'agent_session',params:{action:'join',client:'external-appearance-test'}})).session.sessionId;
 assert.equal((await call({type:'apply_edits',params:{documentId:part.documentId,expectedRevision:3,analyze:false,edits:[{op:'patch',id:'frame',params:{size:[50,30,5]}}]}})).status,'success');
 await page.getByRole('button',{name:'Undo',exact:true}).click();await page.getByText(/changed since your edit/).waitFor();results.history.externalEditBlocksUndo=true;
 assert.deepEqual(errors,[]);results.pageErrors=errors;await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));console.log(results);
}catch(error){const page=browser?.contexts()[0]?.pages()[0];if(page){await page.screenshot({path:join(out,'failure.png')});await writeFile(join(out,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{await browser?.close();await server?.close();await bridge?.close();await rm(dir,{recursive:true,force:true});}
