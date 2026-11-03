import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const state=process.argv[2];if(!state?.includes('vibeworks-foundations-stack-'))throw Error('Pass owned fixture state.');
const marker=JSON.parse(await readFile(join(state,'foundations-stack.json'),'utf8'));assert.equal(marker.owner,'vibeworks-foundations-2026-11-02');
const fixture=JSON.parse(await readFile(new URL('../artifacts/foundations/e2-e/commands.json',import.meta.url),'utf8'));
const out=new URL('../output/playwright/e2-e/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=metal']}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(20000);
const errors=[],checks={},captures=[];page.on('pageerror',e=>errors.push(e.message));
const inspect=()=>page.evaluate(()=>{const s=window.__cad.inspect();return {id:s.document.documentId,revision:s.document.revision,version:s.storageVersion,features:s.document.features.map(f=>({id:f.id,kind:f.kind})),geometry:s.evaluation.geometry.filter(g=>s.evaluation.visibleFeatureIds.includes(g.featureId)).map(g=>({volume:g.volumeMm3,mass:g.massG})),busy:s.busy};});
const dialog=page.getByRole('dialog',{name:'Extract to part',exact:true});
const openExtract=async()=>{await page.locator('.model-tree-row[data-feature="stock"]').first().click({button:'right'});await page.getByRole('menuitem',{name:'Extract to part…',exact:true}).click();await dialog.waitFor();};
try{
 await page.goto(`http://127.0.0.1:${marker.webPort}`);await page.evaluate(()=>window.__cad.ready);
 if(await page.getByRole('heading',{name:'Projects',exact:true}).isVisible()){await page.getByRole('button',{name:/E2 and extraction isolated review.*documents/}).click();await page.getByRole('button',{name:'Open project',exact:true}).click();}
 await page.waitForFunction(id=>window.__cad.inspect().document.documentId===id&&window.__cad.inspect().evaluation.meshes.length>0,fixture.source);
 await page.getByRole('button',{name:'Open design checks',exact:true}).click();await page.getByRole('progressbar',{name:'Leaf pair progress'}).waitFor();checks.checksScopeAndCounts=(await page.getByRole('region',{name:'Model health'}).innerText()).includes('2 leaf solids');assert.ok(checks.checksScopeAndCounts);
 await openExtract();assert.equal(await page.getByRole('textbox',{name:'Part name',exact:true}).evaluate(el=>el===document.activeElement),true);checks.initialFocus=true;
 const before=await inspect();await page.getByRole('textbox',{name:'Part name',exact:true}).fill('An extracted stock component with a deliberately long name for mobile review');
 await page.getByRole('button',{name:'Preview extraction',exact:true}).click();await page.getByRole('heading',{name:'Exact preview passed',exact:true}).waitFor();assert.equal((await inspect()).revision,before.revision);checks.previewPreservesRevision=true;
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>{localStorage.setItem('vibeworks.appearance',theme);window.dispatchEvent(new StorageEvent('storage',{key:'vibeworks.appearance',newValue:theme}));},theme);
  for(const width of [1440,1100,390]){await page.setViewportSize({width,height:1000});await dialog.waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const apply=page.getByRole('button',{name:'Apply extraction',exact:true});await apply.scrollIntoViewIfNeeded();assert.ok(await apply.isVisible());const path=new URL(`extract-${theme}-${width}.png`,out).pathname;await page.screenshot({path});captures.push({theme,width,path});}
 }
 await page.keyboard.press('Tab');assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);checks.focusTrap=true;
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal((await inspect()).revision,before.revision);checks.escapeCancel=true;
 await page.setViewportSize({width:1440,height:1000});await openExtract();await page.getByRole('textbox',{name:'Part name',exact:true}).fill('Browser extracted long named stock component');await page.getByRole('button',{name:'Preview extraction',exact:true}).click();await page.getByRole('button',{name:'Apply extraction',exact:true}).waitFor();await page.getByRole('button',{name:'Apply extraction',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.waitForFunction(rev=>window.__cad.inspect().document.revision===rev+1&&!window.__cad.inspect().busy,before.revision);
 const applied=await inspect();assert.equal(applied.id,before.id);assert.equal(applied.features.find(f=>f.id==='stock').kind,'instance');assert.deepEqual(applied.geometry,before.geometry);checks.applyKeepsViewGeometryAndMass=true;
 const crossView=process.env.VIBEWORKS_VERIFY_CROSS_VIEW==='1';let viewedSource;if(crossView){await page.getByRole('button',{name:'Edit source',exact:true}).click();await page.waitForFunction(id=>window.__cad.inspect().document.documentId!==id,before.id);viewedSource=(await inspect()).id;}
 await page.getByRole('button',{name:'Undo',exact:true}).click();if(crossView){await page.waitForFunction(()=>!window.__cad.inspect().busy);assert.equal((await inspect()).id,viewedSource);checks.undoRetainsCurrentSourceView=true;await page.getByRole('button',{name:'Back to previous document',exact:true}).click();}await page.waitForFunction(rev=>window.__cad.inspect().document.revision===rev+2&&!window.__cad.inspect().busy,before.revision);assert.equal((await inspect()).features.find(f=>f.id==='stock').kind,before.features.find(f=>f.id==='stock').kind);checks.atomicToolbarUndo=true;
 await page.getByRole('button',{name:'Redo',exact:true}).click();await page.waitForFunction(rev=>window.__cad.inspect().document.revision===rev+3&&!window.__cad.inspect().busy,before.revision);assert.equal((await inspect()).features.find(f=>f.id==='stock').kind,'instance');checks.atomicToolbarRedo=true;
 await page.reload();await page.evaluate(()=>window.__cad.ready);await page.waitForFunction(id=>window.__cad.inspect().document.documentId===id&&window.__cad.inspect().evaluation.meshes.length>0,fixture.source);assert.equal((await inspect()).features.find(f=>f.id==='stock').kind,'instance');checks.reloadPersists=true;
 assert.deepEqual(errors,[]);await writeFile(new URL('results.json',out),JSON.stringify({status:'passed',state,before,after:await inspect(),checks,captures,pageErrors:errors},null,2));console.log(JSON.stringify({status:'passed',checks,captures:captures.length}));
}catch(error){await page.screenshot({path:new URL('failure.png',out).pathname}).catch(()=>{});await writeFile(new URL('failure.json',out),JSON.stringify({error:String(error),body:await page.locator('body').innerText(),state:await inspect(),errors},null,2));throw error;}finally{await browser.close();}
