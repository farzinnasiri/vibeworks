import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { startBridge } from '../src/bridge/server.ts';
import { SqliteStore } from '../src/bridge/sqlite-store.ts';
import { emptyDocument } from '../src/cad/document.ts';

// Isolated authority/browser acceptance. No live workspace, global configuration or agent runtime.
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(join(tmpdir(),'vibeworks-agent-interaction-'));
const out=join(root,'output/playwright/agent-interaction');await mkdir(out,{recursive:true});
process.env.VIBEWORKS_WEB_PORT='45203';process.env.VIBEWORKS_BRIDGE_PORT='44358';
const doc={...emptyDocument(),name:'Presentation acceptance',features:[
  {id:'stock',kind:'extrude',params:{profile:{type:'rectangle',width:60,height:40},plane:'XY',origin:[0,0,0],distance:10},appearance:{material:'aluminum',color:'#985c37'}},
  {id:'boss',kind:'cylinder',params:{origin:[0,0,8],radius:10,height:15},appearance:{material:'steel'}},
  {id:'body',kind:'union',params:{target:'stock',tools:['boss']}},
]};
const seed=new SqliteStore(join(dir,'workspace.db'));await seed.put(doc);seed.close();
let bridge,server,browser;
const errors=[];const results={};
try{
  bridge=await startBridge({port:44358,databasePath:join(dir,'workspace.db'),connectionFile:join(dir,'connection.json'),webOrigins:['http://127.0.0.1:45203']});
  await bridge.ready();
  const headers={Authorization:'Bearer '+bridge.connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':bridge.connection.fingerprint};
  let sessionId;
  const call=async(type,params)=>{
    const creation=type==='workspace_view'&&params.action==='present';
    const response=await fetch(bridge.connection.httpUrl+'/command',{method:'POST',headers,
      body:JSON.stringify({requestId:creation?(params.requestId??randomUUID()):randomUUID(),command:{type,params},...(sessionId?{sessionId}:{})})});
    const value=await response.json();assert.equal(value.status,'success',JSON.stringify(value));return value;
  };
  sessionId=(await call('agent_session',{action:'join',client:'interaction-acceptance'})).session.sessionId;
  const requestId=randomUUID();
  const saved=await call('workspace_view',{action:'present',requestId,documentId:doc.documentId,expectedRevision:0,
    state:{panes:[{view:'top'},{from:[1,-1,1],projection:'perspective'}],isolate:['stock'],selection:['stock'],layout:'columns'}});
  assert.equal(saved.workspaceView.request.status,'saved');
  server=await createServer({root,configFile:join(root,'vite.config.ts')});await server.listen();
  browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-angle=metal']:[]});
  const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light'});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto('http://127.0.0.1:45203');await page.evaluate(()=>window.__cad.ready);
  await page.getByRole('region',{name:'Prepared workspace view'}).waitFor({state:'visible',timeout:30000}).catch(async()=>{
    await page.locator('[aria-label="Prepared workspace view"]').waitFor({state:'visible',timeout:30000});
  });
  await page.waitForFunction(()=>document.querySelectorAll('.prepared-pane canvas').length===2);
  const waitApplied=async(id)=>{
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      const result=await call('workspace_view',{action:'status',requestId:id});
      if(result.workspaceView.request.status==='applied')return result.workspaceView.request;
      if(result.workspaceView.request.status==='error')throw new Error(result.workspaceView.request.error);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Viewer did not acknowledge its prepared view.');
  };
  await waitApplied(requestId);
  assert.deepEqual(await page.locator('.prepared-pane').evaluateAll(panes=>panes.map(p=>p.dataset.resultIds)),['stock','stock']);
  assert.ok(await page.locator('.prepared-pane canvas').first().evaluate(canvas=>canvas.clientHeight)>600,'prepared panes should fill the workspace');
  assert.equal(await page.evaluate(()=>window.__cad.inspect().document.documentId),doc.documentId);
  assert.deepEqual(await page.evaluate(()=>window.__cad.inspect().document.selectedFeatureIds),['stock']);
  await page.screenshot({path:join(out,'prepared-modeling.png')});
  results.modeling={requestId,status:'applied',panes:2,isolatedHiddenInput:'stock'};
  await page.getByRole('button',{name:'Return to personal view'}).click();
  assert.equal(await page.locator('.workspace-presentation').count(),0);
  const studioId=randomUUID();
  await call('workspace_view',{action:'present',requestId:studioId,documentId:doc.documentId,
    state:{mode:'studio',panes:[{view:'top',projection:'orthographic'}],isolate:['body'],
      presentation:{floor:'none',backgroundMode:'transparent'},studio:{panel:'scene',output:{size:'hd',quality:'draft',denoise:false}}}});
  await waitApplied(studioId);
  await page.locator('.workspace-presentation .studio-workspace').waitFor({state:'visible'});
  await page.getByRole('button',{name:'Return to personal view'}).waitFor({state:'visible'});
  assert.equal(await page.getByRole('button',{name:'Scene',exact:true}).getAttribute('aria-pressed'),'true');
  await page.screenshot({path:join(out,'prepared-studio.png')});
  results.studio={requestId:studioId,status:'applied',projection:'orthographic',scene:'transparent/no floor'};
  const inspected=await call('inspect_model',{documentId:doc.documentId});assert.equal(inspected.revision,0);assert.equal(inspected.storageVersion,1);
  results.modelUnchanged=true;
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.screenshot({path:join(out,'prepared-mobile.png')});
  // Same authoritative command path, with bundle files retained for visual inspection.
  const saveImages=async(value,prefix)=>{
    await writeFile(join(out,prefix+'-sheet.png'),Buffer.from(value.image.base64,'base64'));
    for(const [index,panel]of(value.image.panels??[]).entries())
      await writeFile(join(out,`${prefix}-${panel.kind}-${index}.png`),Buffer.from(panel.base64,'base64'));
  };
  await page.getByRole('button',{name:'Return to personal view'}).click();
  const shots=[{view:'top'},{from:[1,-1,1],fovDegrees:35}];
  const first=await call('render_views',{documentId:doc.documentId,tileSize:384,appearance:'materials',shots,outputs:'both',
    review:{sections:[{axis:'Z',offset:5}],profiles:[{featureId:'stock'}]}});
  await saveImages(first,'inspection-before');
  assert.equal(first.image.panels.filter(p=>p.kind==='view').length,2);
  assert.equal(first.image.panels.find(p=>p.kind==='profile').featureId,'stock');
  assert.equal(first.sections[0].widthMm,60);
  const after=await call('apply_edits',{documentId:doc.documentId,expectedRevision:0,
    edits:[{op:'patch',id:'stock',params:{profile:{type:'rectangle',width:70,height:40}}}],
    review:{tileSize:384,appearance:'materials',shots,compareTo:first.review.snapshot.snapshotId,profiles:[{featureId:'stock'}]}});
  assert.equal(after.revision,1);assert.equal(after.reviewFailure,undefined);
  assert.deepEqual(after.review.comparison.sizeDeltaMm,[10,0,0]);
  assert.deepEqual(after.image.panels.find(p=>p.kind==='baseline').tiles,after.image.tiles);
  await saveImages(after,'inspection-after');
  results.inspection={snapshot:first.review.snapshot.snapshotId,exactSectionWidthMm:60,
    sizeDeltaMm:after.review.comparison.sizeDeltaMm,matchedCameras:true,authoredProfile:true};
  assert.deepEqual(errors,[]);results.browserErrors=errors;
  await writeFile(join(out,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{
  await browser?.close();await server?.close();await bridge?.close();await rm(dir,{recursive:true,force:true});
}
