import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const state=process.argv[2],marker=JSON.parse(await readFile(join(state,'foundations-stack.json'),'utf8'));assert.equal(marker.owner,'vibeworks-foundations-2026-11-02');
const fixture=JSON.parse(await readFile(new URL('../artifacts/foundations/d/commands.json',import.meta.url),'utf8')),out=new URL('../output/playwright/foundations-d/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=metal']}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
const errors=[],checks=[],captures=[];page.on('pageerror',e=>errors.push(e.message));
const read=()=>page.evaluate(()=>({document:window.__cad.inspect().document,busy:window.__cad.inspect().busy}));
const open=async(d,feature)=>{
 await page.getByRole('button',{name:'View options',exact:true}).waitFor();
 const modelToggle=page.getByRole('button',{name:'Model panel',exact:true});if(await modelToggle.isVisible()&&await modelToggle.getAttribute('aria-pressed')!=='true')await modelToggle.click();
 const root=page.locator(`.model-document-row[data-row="document:${d.documentId}"]`);await root.click();
 await page.waitForFunction(id=>window.__cad.inspect().document.documentId===id&&!window.__cad.inspect().busy&&JSON.parse(sessionStorage.getItem('vibeworks.view.documentNavigation')??'{}').activeId===id,d.documentId);
 const name=await page.evaluate(()=>window.__cad.inspect().document.name),expand=page.getByRole('button',{name:`Expand document ${name}`,exact:true});if(await expand.isVisible())await expand.click();
 const row=page.locator(`.model-tree-row[data-owner="${d.documentId}"][data-feature="${feature}"]`).first();await row.click();
 const toggle=page.getByRole('button',{name:'Details panel',exact:true});if(await toggle.isVisible()&&await toggle.getAttribute('aria-pressed')!=='true')await toggle.click();
 await page.getByText('Shape',{exact:true}).first().click();
};
const fillSeams=async()=>{const second=page.getByRole('textbox',{name:'Section 2 seam',exact:true});if(!await second.isVisible())await page.locator('summary').filter({hasText:/^Section 2/}).click();await page.getByRole('textbox',{name:'Section 1 seam',exact:true}).fill('0.05');await second.fill('0.05');await second.press('Tab');};
const ready=()=>page.locator('.preview-readout.ready .preview-tag').waitFor();
try{
 await page.goto(`http://127.0.0.1:${marker.webPort}`);await page.evaluate(()=>window.__cad.ready);
 const prepared=page.getByRole('button',{name:'Return to personal view',exact:true});try{await prepared.waitFor({state:'visible',timeout:5000});await prepared.click();}catch{}
 await page.evaluate(async id=>{await window.__cad.execute({type:'documents',params:{action:'open',documentId:id}});},fixture.documents[0].documentId);
 const loft=fixture.documents.find(d=>d.kinds.includes('loft'));
 await open(loft,'loft');

 for(const theme of ['light','dark'])for(const width of [1440,1100,390]){
  await page.setViewportSize({width,height:1000});await page.evaluate(theme=>{localStorage.setItem('vibeworks.appearance',theme);window.dispatchEvent(new StorageEvent('storage',{key:'vibeworks.appearance',newValue:theme}));},theme);
  if(width===390&&await page.getByRole('button',{name:'Details panel',exact:true}).getAttribute('aria-pressed')!=='true')await page.getByRole('button',{name:'Details panel',exact:true}).click();
  const before=await read(),seam=page.getByRole('textbox',{name:'Section 1 seam',exact:true});await fillSeams();await ready();assert.equal((await read()).document.revision,before.document.revision);
  await page.getByRole('button',{name:'Discard',exact:true}).focus();await page.keyboard.press('Enter');assert.equal((await read()).document.revision,before.document.revision);checks.push({theme,width,previewAndKeyboardCancel:true});
  await fillSeams();await ready();const file=new URL(`loft-preview-${theme}-${width}.png`,out).pathname;await page.screenshot({path:file});captures.push(file);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('button',{name:/^Apply/}).click();await page.waitForFunction(revision=>window.__cad.inspect().document.revision===revision+1&&!window.__cad.inspect().busy,before.document.revision);checks.at(-1).apply=true;
  await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(revision=>window.__cad.inspect().document.revision===revision+2&&!window.__cad.inspect().busy,before.document.revision);checks.at(-1).undo=true;
 }
 await page.setViewportSize({width:1440,height:1000});
 const blend=fixture.documents.find(d=>d.kinds.includes('fillet'));await open(blend,'blend');const stations=page.getByRole('textbox',{name:'Radius stations [length fraction, mm]',exact:true});await stations.fill('[[0,0.6],[0.4,1.2],[1,0.9]]');await stations.press('Tab');await ready();await page.screenshot({path:new URL('variable-blend-preview.png',out).pathname});await page.getByRole('button',{name:'Discard',exact:true}).click();checks.push({variableBlendPreviewCancel:true});
 const sweep=fixture.documents.find(d=>d.kinds.includes('sweep')&&d.features[0].params.sections);await open(sweep,'sweep');await page.getByText('Guide and section locations',{exact:true}).click();const sweepField=page.getByRole('textbox',{name:'Sweep parameters',exact:true});const changed=structuredClone(sweep.features[0].params);changed.sections.at(-1).profile.radius+=0.1;await sweepField.fill(JSON.stringify(changed));await sweepField.press('Tab');await ready();await page.getByRole('button',{name:'Discard',exact:true}).click();checks.push({multiSectionSweepPreviewCancel:true});
 const construction=fixture.documents.find(d=>d.kinds.includes('fill')&&!d.kinds.includes('join'));await open(construction,'cap');await page.getByRole('button',{name:'Inspect source faces',exact:true}).click();await page.getByRole('button',{name:'Use boundary of +Z',exact:true}).click();await ready();await page.screenshot({path:new URL('construction-sheet-preview.png',out).pathname});await page.getByRole('button',{name:'Discard',exact:true}).click();await page.getByText('Measurements',{exact:true}).click();await page.getByText('Construction sheet · not a physical solid',{exact:true}).waitFor();checks.push({constructionFaceSelectionPreviewAndSheetLabel:true});
 const joined=fixture.documents.findLast(d=>d.kinds.includes('join'));await open(joined,'joined');await page.getByRole('button',{name:'Inspect source faces',exact:true}).click();await page.getByRole('button',{name:'Replace cap.end',exact:true}).click();await ready();await page.getByRole('button',{name:'Discard',exact:true}).click();checks.push({joinCapturedFaceSelectionPreviewCancel:true});
 const tasks=[
  {name:'blend',document:blend,feature:'blend',mutate:async()=>{const input=page.getByRole('textbox',{name:'Radius stations [length fraction, mm]',exact:true});await input.fill('[[0,0.6],[0.4,1.2],[1,0.9]]');await input.press('Tab');}},
  {name:'sweep',document:sweep,feature:'sweep',mutate:async()=>{const summary=page.getByText('Guide and section locations',{exact:true});if(await summary.locator('..').getAttribute('open')===null)await summary.click();const input=page.getByRole('textbox',{name:'Sweep parameters',exact:true});await input.fill(JSON.stringify(changed));await input.press('Tab');}},
  {name:'sheet',document:construction,feature:'cap',mutate:async()=>{await page.getByRole('button',{name:'Inspect source faces',exact:true}).click();await page.getByRole('button',{name:'Use boundary of +Z',exact:true}).click();}},
  {name:'join',document:joined,feature:'joined',mutate:async()=>{await page.getByRole('button',{name:'Inspect source faces',exact:true}).click();await page.getByRole('button',{name:'Replace cap.end',exact:true}).click();}}
 ];
 for(const theme of ['light','dark'])for(const width of [1440,1100,390])for(const task of tasks){
  await page.setViewportSize({width,height:1000});await page.evaluate(theme=>{localStorage.setItem('vibeworks.appearance',theme);window.dispatchEvent(new StorageEvent('storage',{key:'vibeworks.appearance',newValue:theme}));},theme);await open(task.document,task.feature);
  const before=await read();await task.mutate();await ready();await page.getByRole('button',{name:'Discard',exact:true}).focus();await page.keyboard.press('Enter');assert.equal((await read()).document.revision,before.document.revision);
  await task.mutate();await ready();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const path=new URL(`${task.name}-${theme}-${width}.png`,out).pathname;await page.screenshot({path});captures.push(path);
  await page.getByRole('button',{name:/^Apply/}).click();await page.waitForFunction(r=>window.__cad.inspect().document.revision===r+1&&!window.__cad.inspect().busy,before.document.revision);
  await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(r=>window.__cad.inspect().document.revision===r+2&&!window.__cad.inspect().busy,before.document.revision);
  checks.push({task:task.name,theme,width,keyboardCancel:true,preview:true,apply:true,undo:true,overflow:false});
 }
 await page.setViewportSize({width:1440,height:1000});
 const returnRevision=(await read()).document.revision;await page.getByRole('button',{name:'Back to previous document',exact:true}).click();await page.waitForFunction(id=>window.__cad.inspect().document.documentId!==id&&!window.__cad.inspect().busy,joined.documentId);await page.getByRole('button',{name:'Forward to next document',exact:true}).click();await page.waitForFunction(id=>window.__cad.inspect().document.documentId===id&&!window.__cad.inspect().busy,joined.documentId);assert.equal((await read()).document.revision,returnRevision);checks.push({backAndForwardReturn:true});
 await page.reload();await page.evaluate(()=>window.__cad.ready);await page.getByRole('button',{name:'View options',exact:true}).waitFor();assert.equal((await read()).document.documentId,joined.documentId);checks.push({reloadHistory:true});
 assert.deepEqual(errors,[]);await writeFile(new URL('results.json',out),JSON.stringify({status:'passed',checks,captures,pageErrors:errors},null,2));console.log(JSON.stringify({status:'passed',checks:checks.length,captures:captures.length,out:out.pathname}));
}catch(error){await page.screenshot({path:new URL('failure.png',out).pathname}).catch(()=>{});await writeFile(new URL('failure.json',out),JSON.stringify({error:String(error),body:await page.locator('body').innerText(),state:await read(),pageErrors:errors},null,2));throw error;}finally{await browser.close();}
