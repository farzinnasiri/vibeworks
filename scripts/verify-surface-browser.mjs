import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const state=process.argv[2];if(!state?.includes('vibeworks-foundations-stack-'))throw Error('Pass an owned fixture stack directory.');
const marker=JSON.parse(await readFile(join(state,'foundations-stack.json'),'utf8'));if(marker.owner!=='vibeworks-foundations-2026-11-02')throw Error('Unowned fixture state.');
const fixture=JSON.parse(await readFile(new URL('../artifacts/foundations/surface-batch/commands.json',import.meta.url),'utf8'));
const out=new URL('../output/playwright/surface-batch/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
const errors=[],checks={},captures=[];page.on('pageerror',error=>errors.push(error.message));
const stateRead=()=>page.evaluate(()=>{const s=window.__cad.inspect();return{documentId:s.document.documentId,revision:s.document.revision,volume:s.evaluation.geometry[0]?.volumeMm3,mass:s.evaluation.geometry[0]?.massG,graphic:s.evaluation.meshes.find(m=>m.appearance?.graphics?.length)?.appearance.graphics[0].content.asset,regions:s.document.features[0]?.paintRegions,busy:s.busy,displayKey:s.evaluation.displayKey,storageVersion:s.storageVersion,meshInfo:s.evaluation.meshes.map(m=>({faceRanges:m.faceRanges?.length,topology:m.topology?.faces.length,source:m.source,occurrence:m.occurrencePath,triangles:m.triangles.length}))};});
const details=page.getByRole('region',{name:'Face details',exact:true});
const waitApply=()=>page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Apply region paint'&&!b.disabled));
const pickSide=async()=>{
 const row=page.locator('.model-tree-row[data-feature="outer"]').first();if(await row.isVisible())await row.click();
 const canvas=page.locator('canvas[aria-label^="Model viewport"]');await canvas.waitFor();const box=await canvas.boundingBox();
 for(const [x,y]of [[0.5,0.6],[0.5,0.5],[0.45,0.5],[0.55,0.6]]){
  await canvas.click({position:{x:box.width*x,y:box.height*y},modifiers:['Alt']});
  try{await details.waitFor({state:'visible',timeout:2000});break;}catch{}
 }
 await details.waitFor();const neighbour=details.getByRole('group',{name:'Neighbouring faces'}).getByRole('button',{name:'side.0',exact:true});if(await neighbour.isVisible())await neighbour.click();
 assert.ok((await details.innerText()).includes('BSPLINE_SURFACE'));
};
const regionTask=async()=>{await details.getByRole('button',{name:'Paint region',exact:true}).click();await page.getByRole('region',{name:'Paint region',exact:true}).waitFor();};
const chooseCrest=async()=>{await page.getByRole('combobox',{name:'Region boundary',exact:true}).click();await page.getByRole('option',{name:'Section crest',exact:true}).click();};
try{
 await page.goto(`http://127.0.0.1:${marker.webPort}`);await page.evaluate(()=>window.__cad.ready);
 if(await page.getByRole('button',{name:'Open project',exact:true}).isVisible()||await page.getByRole('heading',{name:'Projects',exact:true}).isVisible()){
  await page.getByRole('button',{name:new RegExp((fixture.projectName??'Surface batch fixture')+'.*documents')}).first().click();await page.getByRole('button',{name:'Open project',exact:true}).click();
 }
 await page.waitForFunction(id=>window.__cad.inspect().document.documentId===id&&window.__cad.inspect().evaluation.meshes.length>0,fixture.outerId);
 const returnView=page.getByRole('button',{name:'Return to personal view',exact:true});try{await returnView.waitFor({state:'visible',timeout:5000});}catch{}if(await returnView.isVisible()){await page.screenshot({path:new URL('prepared-highlight.png',out).pathname});await returnView.click();checks.preparedHighlightAndReturn=true;}
 await page.locator('.loading').waitFor({state:'hidden'});
 const before=await stateRead();assert.equal(before.revision,2);
 await pickSide();checks.facePickAndNestedPath=(await details.innerText()).includes('outer / inner / canopy');
 const neighbour=details.getByRole('group',{name:'Neighbouring faces'}).getByRole('button').first();await neighbour.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement?.textContent==='Face');checks.keyboardNeighbour=true;
 await details.getByRole('group',{name:'Neighbouring faces'}).getByRole('button',{name:'side.0',exact:true}).click();
 await regionTask();await chooseCrest();await page.getByRole('button',{name:'Preview region',exact:true}).click();await waitApply();assert.equal((await stateRead()).revision,2);assert.ok(await page.getByRole('region',{name:'Paint region',exact:true}).isVisible());checks.previewKeepsTask=true;
 await page.screenshot({path:new URL('crest-preview.png',out).pathname});
 await page.getByRole('button',{name:'Cancel region',exact:true}).click();assert.equal((await stateRead()).revision,2);checks.cancelPreservesRevision=true;
 await regionTask();await chooseCrest();await page.getByRole('button',{name:'Preview region',exact:true}).click();await waitApply();await page.getByRole('button',{name:'Apply region paint',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===3&&!window.__cad.inspect().busy);
 let after=await stateRead();assert.equal(after.volume,before.volume);assert.equal(after.mass,before.mass);assert.equal(after.graphic,before.graphic);assert.ok(after.regions.some(r=>r.id==='paint_region'));checks.applyPreservesMassGraphicSolid=true;
 await pickSide();await regionTask();await page.getByRole('button',{name:'paint_region',exact:true}).click();await page.getByRole('textbox',{name:'Region name',exact:true}).waitFor();await page.getByLabel('Region color',{exact:true}).fill('#17a5a2');await waitApply();await page.getByRole('button',{name:'Apply region paint',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===4&&!window.__cad.inspect().busy);
 assert.equal((await stateRead()).regions.find(r=>r.id==='paint_region').look.color,'#17a5a2');checks.recolourRegionOnly=true;
 await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===5&&!window.__cad.inspect().busy);assert.equal((await stateRead()).regions.find(r=>r.id==='paint_region').look.color,'#ee5500');
 await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===6&&!window.__cad.inspect().busy);assert.ok(!(await stateRead()).regions.some(r=>r.id==='paint_region'));
 await page.getByRole('button',{name:'Redo',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===7&&!window.__cad.inspect().busy);assert.ok((await stateRead()).regions.some(r=>r.id==='paint_region'));checks.undoRedo=true;
 await pickSide();await page.reload();await page.evaluate(()=>window.__cad.ready);await details.waitFor();assert.ok((await details.innerText()).includes('side.0'));after=await stateRead();assert.equal(after.revision,7);assert.equal(after.graphic,before.graphic);assert.equal(after.mass,before.mass);checks.reloadAndSemanticSelection=true;
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('vibeworks.surface-selection:'+window.__cad.inspect().document.documentId)));assert.equal(saved.faceIndex,undefined);assert.equal(saved.displayKey,undefined);assert.deepEqual(saved.select.faces,['side.0']);
 await regionTask();await page.getByRole('button',{name:'paint_region',exact:true}).click();
 for(const theme of['light','dark']){
  await page.evaluate(theme=>{localStorage.setItem('vibeworks.appearance',theme);window.dispatchEvent(new StorageEvent('storage',{key:'vibeworks.appearance',newValue:theme}));},theme);
  for(const width of[1440,1100,390]){
   await page.setViewportSize({width,height:1000});if(width===390){const toggle=page.getByRole('button',{name:'Details panel',exact:true});if(await toggle.isVisible()&&await toggle.getAttribute('aria-pressed')!=='true')await toggle.click();}
   await page.getByRole('region',{name:'Paint region',exact:true}).waitFor({state:'visible'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   const path=new URL(`region-${theme}-${width}.png`,out).pathname;await page.screenshot({path});captures.push({theme,width,path});
  }
 }
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Cancel region',exact:true}).click();await details.getByRole('button',{name:'Return to component',exact:true}).click();await page.getByRole('button',{name:'Edit source',exact:true}).waitFor();checks.returnToComponent=true;
 const revision=(await stateRead()).revision;await page.getByRole('button',{name:'View options',exact:true}).click();const match=page.getByRole('menuitemcheckbox',{name:/Match Studio looks/});await match.click();await page.keyboard.press('Escape');assert.equal((await stateRead()).revision,revision);checks.matchStudioDisplayOnly=true;
 assert.deepEqual(errors,[]);await writeFile(new URL('results.json',out),JSON.stringify({status:'passed',before,after:await stateRead(),checks,captures,pageErrors:errors,limits:'No live external-agent trial, STEP face-style readback or global topology/continuity claim.'},null,2)+'\n');console.log(JSON.stringify({status:'passed',out:out.pathname,checks,captures:captures.length}));
}catch(error){await page.screenshot({path:new URL('failure.png',out).pathname}).catch(()=>{});await writeFile(new URL('failure.txt',out),JSON.stringify({error:String(error),body:await page.locator('body').innerText(),state:await stateRead(),pageErrors:errors},null,2));throw error;}
finally{await browser.close();}
