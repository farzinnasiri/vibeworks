import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {startBridge} from '../src/bridge/server.ts';
import {SqliteStore} from '../src/bridge/sqlite-store.ts';
import {emptyDocument} from '../src/cad/document.ts';
import {LEGACY_PROJECT_ID} from '../src/shared/protocol.ts';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'vibeworks-workspace-redesign-'));
const out=join(root,'output/playwright/workspace-redesign');await mkdir(out,{recursive:true});
process.env.VIBEWORKS_WEB_PORT='45213';process.env.VIBEWORKS_BRIDGE_PORT='44368';
const part={...emptyDocument(),name:'Sculpted halo source — long component name for layout verification',features:[{id:'halo_body',label:'Halo body',kind:'extrude',params:{profile:{type:'rectangle',width:60,height:30},plane:'XY',origin:[0,0,0],distance:5},appearance:{material:'carbon_fiber'}}]};
// Use the material IDs from the shared catalog; this fixture's blue color also makes selection easy to inspect.
part.features[0].appearance={color:'#376a8b'};
const wheel={...emptyDocument(),name:'Wheel source',features:[{id:'wheel',kind:'cylinder',params:{origin:[0,0,0],radius:12,height:12},appearance:{material:'steel'}}]};
const instance=(id,label,source,translation)=>({id,label,kind:'instance',params:{document:source,translation,rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}});
const subsystem={...emptyDocument(),name:'Cockpit subsystem',kind:'assembly',features:[instance('halo','Halo',part.documentId,[0,0,20])]};
const main={...emptyDocument(),name:'Main assembly',kind:'assembly',features:[instance('details','Details',subsystem.documentId,[0,0,0]),instance('wheel_left','Left wheel',wheel.documentId,[-45,30,0]),instance('wheel_right','Right wheel',wheel.documentId,[45,30,0])]};
const dense={...emptyDocument(),name:'Dense fixture — 120 features',features:Array.from({length:120},(_,i)=>({id:`block_${i}`,label:`Fixture block ${i+1} — long feature label`,kind:'box',params:{origin:[i%12*12,Math.floor(i/12)*12,0],size:[8,8,5]},appearance:{color:'#376a8b'}}))};
const seed=new SqliteStore(join(dir,'workspace.db'));for(const doc of[part,wheel,subsystem,main,dense])await seed.put(doc);
await seed.operation({action:'project',project:{projectId:LEGACY_PROJECT_ID,name:'Workspace acceptance',mainAssemblyId:main.documentId,version:2},expectedVersion:1});seed.close();
let bridge,server,browser;const errors=[],results={};
try{
 bridge=await startBridge({port:44368,databasePath:join(dir,'workspace.db'),connectionFile:join(dir,'connection.json'),webOrigins:['http://127.0.0.1:45213']});await bridge.ready();
 const headers={Authorization:'Bearer '+bridge.connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':bridge.connection.fingerprint};let sessionId;
 const call=async(type,params)=>{const response=await fetch(bridge.connection.httpUrl+'/command',{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),command:{type,params},...(sessionId?{sessionId}:{})})});const value=await response.json();assert.equal(value.status,'success',JSON.stringify(value));return value;};
 sessionId=(await call('agent_session',{action:'join',client:'workspace-redesign-acceptance'})).session.sessionId;
 for(const[revision,width]of[[0,70],[1,80]])await call('apply_edits',{documentId:part.documentId,expectedRevision:revision,analyze:false,edits:[{op:'patch',id:'halo_body',params:{profile:{type:'rectangle',width,height:30}}}]});
 server=await createServer({root,configFile:join(root,'vite.config.ts')});await server.listen();browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-angle=metal']:[]});
 const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light',reducedMotion:'reduce'});page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('http://127.0.0.1:45213');await page.evaluate(()=>window.__cad.ready);
 await page.getByRole('button',{name:/Workspace acceptance.*documents/}).click();await page.getByRole('button',{name:'Open project',exact:true}).click();
 const waitDoc=async(id)=>{await page.waitForFunction(id=>window.__cad.inspect().document.documentId===id&&window.__cad.inspect().phase==='ready'&&!window.__cad.inspect().busy,id);await page.locator('.loading').waitFor({state:'hidden'});};
 await waitDoc(main.documentId);await page.getByRole('tree',{name:'Model',exact:true}).waitFor();
 assert.equal(await page.getByRole('tablist',{name:'Workspace panel'}).getByRole('tab').count(),4);assert.equal(await page.locator('.model-library').count(),0);assert.equal(await page.locator('.left-panel [aria-label^="Project:"]').count(),0);assert.equal(await page.locator('.topbar [aria-label^="Project:"]').count(),1);
 const browseProjects=async()=>{await page.getByRole('button',{name:'All projects',exact:true}).click();await page.getByRole('dialog',{name:'Browse all projects?',exact:true}).getByRole('button',{name:'All projects',exact:true}).click();await page.getByRole('dialog',{name:'Browse projects',exact:true}).waitFor();};
 const leftPanel=page.locator('.floating-panel.left-panel'),rightPanel=page.locator('.floating-panel.right-panel');
 // All overlay kinds share one bounded, anchored surface.
 await page.getByRole('button',{name:'Project: Workspace acceptance',exact:true}).click();
 const projectPop=page.getByRole('menu',{name:'Project: Workspace acceptance',exact:true});
 const placement=await projectPop.evaluate(el=>{const box=el.getBoundingClientRect(),anchor=document.querySelector('[aria-label="Project: Workspace acceptance"]').getBoundingClientRect();return{gap:box.top-anchor.bottom,left:box.left,right:box.right,bottom:box.bottom};});
 assert.ok(placement.gap>=7&&placement.left>=8&&placement.right<=1440-8&&placement.bottom<=1000-8,JSON.stringify(placement));
 await projectPop.evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:join(out,'shared-project-menu.png')});await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Workspace settings',exact:true}).click();
 const navigation=page.getByRole('combobox',{name:'Navigation device',exact:true});await navigation.click();
 await page.getByRole('option',{name:'Mouse',exact:true}).click();assert.equal(await page.locator('select[aria-label="Navigation device"]').inputValue(),'mouse');
 await navigation.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');await page.keyboard.press('Enter');
 assert.equal(await page.locator('select[aria-label="Navigation device"]').inputValue(),'trackpad');
 await navigation.click();await page.keyboard.press('Escape');assert.equal(await navigation.evaluate(el=>el===document.activeElement),true);
 await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
 const pathSpacing=await page.locator('.crumb-sep').evaluate(el=>{const sep=el.getBoundingClientRect(),path=el.nextElementSibling.getBoundingClientRect();return path.left-sep.right;});assert.ok(pathSpacing>=10);
 results.overlays={sharedMenuAndSelect:true,anchoredGap:placement.gap,viewportBounded:true,keyboardSelection:true,escapeRestoresFocus:true,pathSpacing};
 const panelVersion=(await call('inspect_model',{documentId:main.documentId})).storageVersion;
 const fullWidth=(await leftPanel.boundingBox()).width;
 assert.ok(await leftPanel.evaluate(el=>{const panel=el.getBoundingClientRect(),stage=el.closest('.stage').getBoundingClientRect();return panel.left>stage.left&&panel.top>stage.top&&getComputedStyle(el).borderRadius==='12px';}));
 const triadClear=await leftPanel.evaluate(el=>{const panel=el.getBoundingClientRect(),triad=document.querySelector('.axis-triad').getBoundingClientRect();return panel.bottom<=triad.top;});assert.ok(triadClear);
 const mirrored=await rightPanel.evaluate(el=>el.querySelector('.panel-identity').getBoundingClientRect().left>el.querySelector('.panel-size-toggle').getBoundingClientRect().right);assert.ok(mirrored);
 await page.screenshot({path:join(out,'panels-expanded.png')});
 await page.getByRole('button',{name:'Compact Model panel',exact:true}).click();await page.getByRole('button',{name:'Compact Details panel',exact:true}).click();
 assert.ok((await leftPanel.boundingBox()).width<fullWidth);assert.ok(await page.getByRole('tree',{name:'Model',exact:true}).isVisible());assert.ok(await rightPanel.locator('.compact-inspector').isVisible());
 await page.screenshot({path:join(out,'panels-compact.png')});
 await page.getByRole('button',{name:'Hide Model panel',exact:true}).click();await page.getByRole('button',{name:'Hide Details panel',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.app').dataset.leftPanel==='collapsed'&&document.querySelector('.app').dataset.rightPanel==='collapsed');
 assert.equal((await leftPanel.boundingBox()).width,44);assert.equal((await rightPanel.boundingBox()).width,44,JSON.stringify(await rightPanel.evaluate(el=>({mode:el.dataset.panelState,app:el.closest('.app').dataset.rightPanel,width:getComputedStyle(el).width,min:getComputedStyle(el).minWidth,variable:getComputedStyle(el).getPropertyValue('--right-w'),count:document.querySelectorAll('.right-panel').length}))));
 await page.screenshot({path:join(out,'panels-collapsed.png')});await page.reload();await page.evaluate(()=>window.__cad.ready);await waitDoc(main.documentId);
 assert.equal(await leftPanel.getAttribute('data-panel-state'),'collapsed');assert.equal(await rightPanel.getAttribute('data-panel-state'),'collapsed');
 await page.getByRole('button',{name:'Show Model panel',exact:true}).click();assert.equal(await leftPanel.getAttribute('data-panel-state'),'compact');await page.getByRole('button',{name:'Expand Model panel',exact:true}).click();
 await page.getByRole('button',{name:'Show Details panel',exact:true}).click();await page.getByRole('button',{name:'Expand Details panel',exact:true}).click();
 const visiblePanel=(el)=>{const surface=el.querySelector('.panel-surface'),box=surface.getBoundingClientRect(),clip=getComputedStyle(surface).clipPath;const parts=clip.match(/inset\(([^)]*?)(?: round ([^)]*))?\)/);const v=parts?.[1].trim().split(/\s+/).map(parseFloat)??[0];const top=v[0],right=v[1]??top,bottom=v[2]??top,left=v[3]??right;return{width:box.width-left-right,height:box.height-top-bottom,right:box.right-right,radius:parseFloat(parts?.[2]??getComputedStyle(surface).borderRadius)};};
 // The shadow must follow the visible frame, including intermediate shrink/expand frames.
 const shadowFrames=async panel=>panel.evaluate(el=>{
  const surface=el.querySelector('.panel-surface'),shadow=surface.closest('.panel-shadow')??surface;
  const shape=surface.getAnimations().find(a=>a.effect.getTiming().duration===300);if(!shape)throw Error('Missing frame motion');shape.pause();
  return[0,30,150,299].map(time=>{
   shape.currentTime=time;
   const box=surface.getBoundingClientRect(),cast=shadow.getBoundingClientRect(),clip=getComputedStyle(surface).clipPath;
   const parts=clip.match(/inset\(([^)]*?)(?: round ([^)]*))?\)/),v=parts?.[1].trim().split(/\s+/).map(parseFloat)??[0];
   const top=v[0],right=v[1]??top,bottom=v[2]??top,left=v[3]??right;
   return{time,width:box.width-left-right,height:box.height-top-bottom,shadowWidth:cast.width,shadowHeight:cast.height};
  });
 });
 // A layout changes only while its single live body is transparent; its header never fades.
 const fadeThrough=async(panel,target)=>panel.evaluate(async(el,target)=>{
  const body=el.querySelector('.floating-panel-content'),before=el.dataset.panelState;
  el.querySelector('.panel-size-toggle').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
  const exit=body.getAnimations().find(a=>a.effect.getTiming().duration===80&&a.effect.getKeyframes().at(-1).opacity==='0');
  if(!exit)throw Error('Missing outgoing body fade');exit.pause();
  const outgoing=[0,20,40,79].map(time=>{exit.currentTime=time;return{opacity:Number(getComputedStyle(body).opacity),mode:el.dataset.panelState};});
  exit.finish();for(let frame=0;frame<20&&el.dataset.panelState!==target;frame++)await new Promise(requestAnimationFrame);
  if(el.dataset.panelState!==target)throw Error('Layout request did not settle');
  const incoming=body.getAnimations().find(a=>a.effect.getTiming().duration===140);if(!incoming)throw Error('Missing incoming body fade');incoming.pause();
  const entering=[0,40,80,140,179].map(time=>{incoming.currentTime=time;return Number(getComputedStyle(body).opacity);});
  const result={before,target,outgoing,entering,liveInteriors:el.querySelectorAll('.panel-interior').length,ghosts:el.querySelectorAll('.panel-transition-ghost').length,headerOpacity:Number(getComputedStyle(el.querySelector('.floating-panel-head')).opacity)};
  return result;
 },target);
 // Deterministically inspect intermediate presentation sizes and reverse mid-transition.
 await page.emulateMedia({reducedMotion:'no-preference'});
 const contentPhases=[],shadowContinuity=[];for(const panel of[leftPanel,rightPanel])for(const target of['compact','expanded']){
  const trace=await fadeThrough(panel,target);contentPhases.push(trace);assert.equal(trace.liveInteriors,1);assert.equal(trace.ghosts,0);assert.equal(trace.headerOpacity,1);
  assert.ok(trace.outgoing.every(sample=>sample.mode===trace.before));assert.ok(trace.outgoing.every((sample,i)=>i===0||sample.opacity<=trace.outgoing[i-1].opacity));
  assert.equal(trace.entering[0],0);assert.ok(trace.entering.every((opacity,i)=>i===0||opacity>=trace.entering[i-1]));
  const frames=await shadowFrames(panel);shadowContinuity.push({side:await panel.getAttribute('data-inset'),target,frames});
  assert.ok(frames.every(frame=>Math.abs(frame.width-frame.shadowWidth)<1&&Math.abs(frame.height-frame.shadowHeight)<1),'Shadow bounds jumped away from the visible panel: '+JSON.stringify(frames));
  await panel.evaluate(el=>el.getAnimations({subtree:true}).forEach(a=>a.finish()));
 }
 for(const panel of[leftPanel,rightPanel]){
  await panel.locator('.panel-identity').click();await page.waitForFunction(el=>el.dataset.panelState==='collapsed',await panel.elementHandle());
  const closing=await shadowFrames(panel);assert.ok(closing.every(frame=>Math.abs(frame.width-frame.shadowWidth)<1&&Math.abs(frame.height-frame.shadowHeight)<1),JSON.stringify(closing));
  await panel.evaluate(el=>el.getAnimations({subtree:true}).forEach(a=>a.finish()));
  await panel.locator('.panel-reopen').click();
  const opening=await shadowFrames(panel);assert.ok(opening.every(frame=>Math.abs(frame.width-frame.shadowWidth)<1&&Math.abs(frame.height-frame.shadowHeight)<1),JSON.stringify(opening));
  shadowContinuity.push({side:await panel.getAttribute('data-inset'),closing,opening});
  await panel.evaluate(el=>el.getAnimations({subtree:true}).forEach(a=>a.finish()));
 }
 const cancelledExit=await leftPanel.evaluate(el=>{
  const body=el.querySelector('.floating-panel-content'),button=el.querySelector('.panel-size-toggle');button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
  const fade=body.getAnimations().find(a=>a.effect.getTiming().duration===80);fade.pause();fade.currentTime=40;const before=Number(getComputedStyle(body).opacity);
  button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));const restore=body.getAnimations().filter(a=>a.playState==='running').at(-1);restore.pause();restore.currentTime=0;
  const after=Number(getComputedStyle(body).opacity);restore.finish();return{before,after,mode:el.dataset.panelState};
 });assert.equal(cancelledExit.mode,'expanded');assert.ok(Math.abs(cancelledExit.before-cancelledExit.after)<.01);
 await page.getByRole('button',{name:'Compact Model panel',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.left-panel').dataset.panelState==='compact');
 const motion=await leftPanel.evaluate((el,read)=>{
  const visible=eval(`(${read})`),surface=el.querySelector('.panel-surface'),content=el.querySelector('.panel-interior');
  const shape=surface.getAnimations().find(a=>a.effect.getTiming().duration===300);if(!shape)throw Error('Missing panel frame motion');
  shape.pause();shape.currentTime=0;const start=visible(el);shape.currentTime=150;const middle=visible(el);shape.currentTime=300;const end=visible(el);shape.currentTime=70;shape.play();
  return{start:start.width,middle:middle.width,end:end.width,radii:[start.radius,middle.radius,end.radius],ghost:!!el.querySelector('.panel-transition-ghost'),textTransform:getComputedStyle(content).transform,frameTransform:getComputedStyle(el).transform};
 },visiblePanel.toString());
 assert.ok(motion.start>motion.middle&&motion.middle>motion.end,JSON.stringify(motion));assert.equal(motion.textTransform,'none');assert.equal(motion.frameTransform,'none');assert.equal(motion.ghost,false);assert.ok(motion.radii.every(r=>r>=10&&r<=12));
 // A second pointer action retargets the current visible frame, rather than jumping to its old endpoint.
 const reversal=await leftPanel.evaluate(async(el,read)=>{
  const visible=eval(`(${read})`);
  const surface=el.querySelector('.panel-surface'),shape=surface.getAnimations()[0];shape.pause();shape.currentTime=90;
  const before=visible(el).width;
  el.querySelector('.panel-size-toggle').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
  for(let frame=0;frame<30&&el.dataset.panelState!=='expanded';frame++)await new Promise(requestAnimationFrame);
  const next=surface.getAnimations()[0];next.pause();next.currentTime=0;return{before,after:visible(el).width};
 },visiblePanel.toString());
 assert.ok(Math.abs(reversal.before-reversal.after)<8,JSON.stringify(reversal));
 await leftPanel.evaluate(el=>el.querySelectorAll('*').forEach(node=>node.getAnimations().forEach(a=>a.finish())));
 await page.getByRole('button',{name:'Hide Model panel',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.left-panel').dataset.panelState==='collapsed');
 const corners=await leftPanel.evaluate((el,read)=>{const visible=eval(`(${read})`),shape=el.querySelector('.panel-surface').getAnimations()[0];shape.pause();return[0,100,200,300].map(time=>{shape.currentTime=time;return visible(el).radius;});},visiblePanel.toString());assert.ok(corners.every(r=>r>=10&&r<=12),JSON.stringify(corners));
 await leftPanel.evaluate(el=>el.querySelectorAll('*').forEach(node=>node.getAnimations().forEach(a=>a.finish())));
 await page.getByRole('button',{name:'Show Model panel',exact:true}).focus();await page.keyboard.press('Enter');
 await page.getByRole('button',{name:'Hide Model panel',exact:true}).focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Show Model panel');
 assert.equal(await leftPanel.evaluate(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running')),false);
 await page.keyboard.press('Enter');await page.getByRole('button',{name:'Hide Model panel',exact:true}).waitFor();
 await page.getByRole('button',{name:'Compact Model panel',exact:true}).focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Expand Model panel');await page.keyboard.press('Enter');
 await page.getByRole('button',{name:'Compact Details panel',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.right-panel').dataset.panelState==='compact');
 const rightMotion=await rightPanel.evaluate((el,read)=>{const visible=eval(`(${read})`),surface=el.querySelector('.panel-surface'),shape=surface.getAnimations()[0];shape.pause();shape.currentTime=0;const start=visible(el);shape.currentTime=150;const mid=visible(el);return{start:start.width,middle:mid.width,rightEdgeDelta:Math.abs(start.right-mid.right)};},visiblePanel.toString());
 assert.ok(rightMotion.start>rightMotion.middle&&rightMotion.rightEdgeDelta<1,JSON.stringify(rightMotion));
 await rightPanel.evaluate(el=>el.querySelectorAll('*').forEach(node=>node.getAnimations().forEach(a=>{a.pause();a.currentTime=100;})));await page.screenshot({path:join(out,'panels-motion-midpoint.png')});
 await rightPanel.evaluate(el=>el.querySelectorAll('*').forEach(node=>node.getAnimations().forEach(a=>a.finish())));
 await page.getByRole('button',{name:'Expand Details panel',exact:true}).click();
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.getByRole('button',{name:'Compact Details panel',exact:true}).click();
 assert.equal(await rightPanel.locator('.panel-surface').evaluate(el=>el.getAnimations().length),0);
 await page.getByRole('button',{name:'Expand Details panel',exact:true}).click();
 results.panelMotion={...motion,contentPhases,shadowContinuity,cancelledExit,reversal,rightMotion,collapseCornerRadii:corners,keyboardInstant:true,keyboardToggleFocus:true,reducedMotionSkipsResize:true};
 await page.getByRole('button',{name:'Replay construction',exact:true}).click();await page.getByRole('slider',{name:'Replay position',exact:true}).waitFor();await page.getByRole('button',{name:'Close replay',exact:true}).click();results.hierarchy={peerModes:4,oneProjectSelector:true,oneDocumentTree:true,contextualReplay:true,animatedPanels:true};
 // One player stays open across detail modes; only the viewport frame and status advance.
 await page.getByRole('button',{name:'Replay construction',exact:true}).click();
 const player=page.getByRole('region',{name:'Replay',exact:true});await player.waitFor();assert.equal(await page.getByRole('slider',{name:'Replay position',exact:true}).count(),1);
 await page.getByRole('button',{name:'Inside components',exact:true}).click();await player.getByRole('button',{name:'Play replay',exact:true}).click();await player.getByRole('status').filter({hasText:/Showing|Playing/}).waitFor();
 assert.equal(await player.count(),1);assert.equal(await page.getByRole('slider',{name:'Construction step',exact:true}).count(),0);
 await page.getByRole('button',{name:'Assembly steps',exact:true}).click();if(await player.getByRole('button',{name:'Play replay',exact:true}).count())await player.getByRole('button',{name:'Play replay',exact:true}).click();await player.getByRole('status').filter({hasText:/Showing|Playing/}).waitFor();
 const wasPlaying=await player.getByRole('button',{name:'Pause replay',exact:true}).count();if(wasPlaying)await player.getByRole('button',{name:'Pause replay',exact:true}).click();
 await page.getByRole('slider',{name:'Replay position',exact:true}).fill('3');await player.getByRole('status').filter({hasText:'Showing 3 of 3'}).waitFor();
 await page.getByRole('button',{name:'Target replay speed 1×',exact:true}).click();await page.getByRole('button',{name:'Target replay speed 2×',exact:true}).click();await page.getByRole('button',{name:'Target replay speed 4×',exact:true}).click();await page.getByRole('button',{name:'Target replay speed 8×',exact:true}).click();await page.getByRole('button',{name:'Target replay speed 16×',exact:true}).waitFor();
 await player.screenshot({path:join(out,'unified-replay.png')});await page.getByRole('button',{name:'Close replay',exact:true}).click();assert.equal(await player.count(),0);
 await page.getByRole('tab',{name:'History',exact:true}).click();await page.getByRole('button',{name:'Replay recorded changes',exact:true}).click();await player.getByRole('status').filter({hasText:/Showing|Playback paused/}).waitFor();
 assert.match(await player.locator('.replay-scope').innerText(),/^Main assembly · r\d+$/);assert.equal(await page.getByRole('slider',{name:'Replay position',exact:true}).count(),1);
 await page.getByRole('button',{name:'Close replay',exact:true}).click();await page.getByRole('tab',{name:'Model',exact:true}).click();
 results.replay={onePlayer:true,modeSwitchStable:true,closeAlwaysAvailable:true,assemblyFinalFrame:true,requestedSpeed:true,changesScopeStable:true};
 // Exercise real UI recovery from a failed frame and closing an in-flight frame.
 const failFrame=async route=>{const payload=route.request().postDataJSON();if(payload.command?.type==='inspect_model'&&payload.command.params.snapshot&&payload.command.params.display?.step===2){await route.fulfill({status:200,headers:{'content-type':'application/json','x-vibeworks-fingerprint':bridge.connection.fingerprint},json:{result:{operation:'inspect_model',requestId:payload.requestId,documentId:main.documentId,status:'error',created:[],updated:[],warnings:[],error:{code:'WORKER_TIMEOUT',message:'Injected replay frame failure'}}}});}else await route.continue();};
 await page.route('**/api/view-command',failFrame);await page.getByRole('button',{name:'Replay construction',exact:true}).click();await player.getByRole('slider',{name:'Replay position',exact:true}).fill('2');await player.getByRole('alert').filter({hasText:'Injected replay frame failure'}).waitFor();
 assert.ok(await page.getByRole('button',{name:'Close replay',exact:true}).isEnabled());await page.unroute('**/api/view-command',failFrame);await player.getByRole('button',{name:'Retry frame',exact:true}).click();await player.getByRole('status').filter({hasText:'Showing 2 of 3'}).waitFor();await page.getByRole('button',{name:'Close replay',exact:true}).click();
 let releaseHeld,startedHeld;const gate=new Promise(resolve=>releaseHeld=resolve),heldStarted=new Promise(resolve=>startedHeld=resolve);
 const holdFrame=async route=>{const payload=route.request().postDataJSON();if(payload.command?.type==='inspect_model'&&payload.command.params.snapshot&&payload.command.params.display?.step===1){startedHeld();await gate;}await route.continue();};
 await page.route('**/api/view-command',holdFrame);try{await page.getByRole('button',{name:'Replay construction',exact:true}).click();await player.getByRole('button',{name:'Play replay',exact:true}).click();await heldStarted;await player.getByRole('status').filter({hasText:'Preparing 1'}).waitFor();await page.getByRole('button',{name:'Close replay',exact:true}).click();assert.equal(await player.count(),0);const delivered=page.waitForResponse(response=>response.url().endsWith('/api/view-command')&&response.request().postDataJSON()?.command?.params?.display?.step===1);releaseHeld();await delivered;assert.equal(await player.count(),0);}finally{releaseHeld();await page.unroute('**/api/view-command',holdFrame);}
 results.replay.failedFrameRetry=true;results.replay.closeWhileLoading=true;
 const actors=(await call('activity',{projectId:LEGACY_PROJECT_ID,changesOnly:true,limit:100})).participants;const recordedAgent=actors.find(p=>p.identity.kind==='agent');assert.ok(recordedAgent);
 await page.getByRole('tab',{name:'History',exact:true}).click();await page.getByRole('combobox',{name:'History author',exact:true}).click();await page.getByRole('listbox',{name:'History author',exact:true}).locator(`[role=option][data-value="${recordedAgent.identity.agentId}"]`).click();await page.getByRole('button',{name:'Replay recorded changes',exact:true}).click();await player.getByRole('status').filter({hasText:/Showing/}).waitFor();assert.ok(await player.locator('.replay-scope').innerText().then(text=>text.includes('Main assembly')&&!text.includes('Selected agent')));await page.getByRole('button',{name:'Close replay',exact:true}).click();await page.getByRole('tab',{name:'Model',exact:true}).click();results.replay.agentFilter=true;



 assert.equal((await call('inspect_model',{documentId:main.documentId})).storageVersion,panelVersion);results.panels={floating:true,threeStates:true,independent:true,persistAfterReload:true,storageUnchanged:true};
 await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('menuitem',{name:'Open JSON…',exact:true}).waitFor();assert.equal(await page.getByRole('menuitem',{name:'All projects',exact:true}).count(),0);await page.keyboard.press('Escape');await page.getByRole('button',{name:'Export',exact:true}).click();await page.getByRole('menuitem',{name:'STEP',exact:true}).waitFor();await page.getByRole('menuitem',{name:'STL',exact:true}).waitFor();await page.keyboard.press('Escape');
 const details=page.locator('.model-tree-row[data-feature="details"]');await details.focus();await page.keyboard.press('ArrowRight');
 await page.locator('.model-tree-row').filter({hasText:/^Halo/}).waitFor();await page.keyboard.press('ArrowDown');
 assert.ok(await page.evaluate(()=>document.activeElement?.getAttribute('data-row')?.endsWith('/details/halo')));
 await page.keyboard.press('ArrowLeft');assert.equal(await details.evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('ArrowLeft');assert.equal(await page.getByRole('button',{name:'Expand Details',exact:true}).count(),1);
 await page.getByRole('button',{name:'Expand Left wheel',exact:true}).click();await page.getByRole('button',{name:'Expand Right wheel',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-row]')].filter(el=>el.getAttribute('data-row').endsWith('/wheel')).length===2);
 const paths=await page.locator('[data-row]').evaluateAll(els=>els.map(el=>el.getAttribute('data-row')));assert.equal(new Set(paths).size,paths.length);results.keyboard={arrows:true,distinctOccurrencePaths:true};
 await page.getByRole('button',{name:'Expand Details',exact:true}).click();
 await page.locator('.model-tree-row').filter({hasText:/^Halo/}).click();await waitDoc(subsystem.documentId);
 assert.deepEqual(await page.evaluate(()=>window.__cad.inspect().document.selectedFeatureIds),['halo']);
 await page.getByRole('button',{name:'Edit source',exact:true}).click();await waitDoc(part.documentId);
 await page.reload();await page.evaluate(()=>window.__cad.ready);await waitDoc(part.documentId);await page.getByRole('button',{name:'Back to Cockpit subsystem',exact:true}).waitFor();
 await page.locator('.model-tree-row[data-feature="halo_body"]').click();await page.getByRole('textbox',{name:'Width',exact:true}).fill('90');
 await page.locator('.preview-readout.ready').waitFor();await page.evaluate(()=>window.__warmCanvas=document.querySelector('.viewport canvas'));
 await browseProjects();const projectBrowser=page.getByRole('dialog',{name:'Browse projects',exact:true});await projectBrowser.getByRole('button',{name:/Workspace acceptance.*documents/}).click();await projectBrowser.locator('.picker-document').filter({hasText:'Dense fixture'}).click();await page.getByRole('dialog',{name:'Leave this design?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__cad.inspect().document.documentId),part.documentId);await projectBrowser.getByRole('button',{name:'Return to workspace',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Width',exact:true}).inputValue(),'90');assert.equal(await page.evaluate(()=>window.__warmCanvas===document.querySelector('.viewport canvas')&&window.__warmCanvas.isConnected),true);results.projectBrowser={viewportPreserved:true,draftPreserved:true,cancelNavigation:true};
 await page.locator('.preview-readout.ready').waitFor();await page.getByRole('button',{name:'Compact Details panel',exact:true}).click();await page.getByRole('button',{name:'Hide Details panel',exact:true}).click();
 assert.ok(await rightPanel.locator('.panel-task-dot').isVisible());await page.getByRole('button',{name:'Show Details panel',exact:true}).click();await page.getByRole('button',{name:'Continue editing',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Width',exact:true}).inputValue(),'90');results.panels.draftPreserved=true;
 await page.getByRole('form',{name:'Parameters',exact:true}).getByRole('button',{name:/^Apply/}).click();
 await page.waitForFunction(()=>window.__cad.inspect().document.revision===3);
 await page.getByRole('button',{name:'Back to Cockpit subsystem',exact:true}).click();await waitDoc(subsystem.documentId);assert.deepEqual(await page.evaluate(()=>window.__cad.inspect().document.selectedFeatureIds),['halo']);
 await page.getByRole('button',{name:'Back to Main assembly',exact:true}).click();await waitDoc(main.documentId);assert.deepEqual(await page.evaluate(()=>window.__cad.inspect().document.selectedFeatureIds),['details']);
 await page.screenshot({path:join(out,'model-desktop.png')});results.navigation={nestedSource:true,sourceEdited:true,returnSelection:true,reloadTrail:true};
 // Insertion starts unselected, cancel preserves storage, and applying inserts just the chosen source.
 await page.getByRole('button',{name:'Clear selection',exact:true}).first().click();await page.getByRole('button',{name:'Insert part',exact:true}).click();
 const sourceSelect=page.getByRole('combobox',{name:'Source part or assembly',exact:true});assert.equal(await page.locator('select[aria-label="Source part or assembly"]').inputValue(),'');
 assert.ok(await page.locator('.tool-card button[type=submit]').isDisabled());const before=(await call('inspect_model',{documentId:main.documentId})).storageVersion;
 await page.screenshot({path:join(out,'insert-source.png')});await page.locator('.tool-card').getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await call('inspect_model',{documentId:main.documentId})).storageVersion,before);
 await page.getByRole('button',{name:'Insert part',exact:true}).click();await sourceSelect.click();await page.getByRole('option',{name:`${part.name} · part`,exact:true}).click();await page.locator('.chosen-source img').waitFor();await page.locator('.tool-card .preview-readout.ready').waitFor();
 await page.getByText('Appearance override',{exact:true}).click();const material=page.getByRole('combobox',{name:'Material',exact:true});await material.click();
 const materialPop=page.getByRole('listbox',{name:'Material',exact:true});await materialPop.waitFor();await materialPop.locator('[role=option]').first().waitFor();assert.equal(await materialPop.getByRole('option').count(),await page.locator('.appearance-fields select option').count());await materialPop.locator('.menu-label').filter({hasText:'Composite'}).waitFor();
 await page.keyboard.press('End');const edgeBounds=await materialPop.boundingBox();assert.ok(edgeBounds.x>=8&&edgeBounds.y>=8&&edgeBounds.x+edgeBounds.width<=1432&&edgeBounds.y+edgeBounds.height<=992);
 await materialPop.evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:join(out,'shared-material-menu.png')});
 await page.keyboard.press('Escape');assert.equal(await material.evaluate(el=>el===document.activeElement),true);results.overlays.groupedOptionsAndScroll=true;

 await page.locator('.tool-card button[type=submit]').click();await page.waitForFunction(()=>window.__cad.inspect().document.revision===1);
 const inserted=await call('inspect_model',{documentId:main.documentId});assert.equal(inserted.document.features.length,4);assert.equal(inserted.document.features.at(-1).params.document,part.documentId);
 results.insertion={startsUnselected:true,cancelUnchanged:true,chosenSourceOnly:true};
 const placedId=inserted.document.features.at(-1).id;await page.locator(`.model-tree-row[data-feature="${placedId}"]`).click({button:'right'});await page.getByRole('menuitem',{name:'Placement history',exact:true}).click();await player.getByRole('status').filter({hasText:'Showing 1 of 1'}).waitFor();assert.equal(await page.evaluate(()=>window.__cad.inspect().document.documentId),main.documentId);await page.getByRole('button',{name:'Close replay',exact:true}).click();await page.getByRole('tab',{name:'Model',exact:true}).click();
 await page.locator(`.model-tree-row[data-feature="${placedId}"]`).click({button:'right'});await page.getByRole('menuitem',{name:'Source history',exact:true}).click();await player.getByRole('status').filter({hasText:/Showing/}).waitFor();assert.equal(await page.evaluate(()=>window.__cad.inspect().document.documentId),main.documentId);assert.ok((await player.locator('.replay-scope').innerText()).includes('Sculpted halo source'));await page.getByRole('button',{name:'Close replay',exact:true}).click();results.replay.sourceAndPlacementScopes=true;

 // Historical restore targets one document, remains a new revision, and leaves the old immutable graph intact.
 await page.getByRole('tab',{name:'History',exact:true}).click();
 await page.locator('.revision-row').filter({hasText:'Updated design'}).filter({hasText:'Sculpted halo source'}).filter({hasText:'r1'}).first().click();await page.getByRole('button',{name:'Restore as new revision',exact:true}).waitFor();
 await page.getByRole('button',{name:'Compare before / after',exact:true}).first().click();await page.getByRole('slider',{name:'Before and after split'}).waitFor();
 await page.screenshot({path:join(out,'history-comparison.png')});await page.getByRole('button',{name:'Restore as new revision',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Restore as new revision',exact:true}).click();
 await waitDoc(part.documentId);await page.waitForFunction(()=>window.__cad.inspect().document.revision===4);const restored=await call('inspect_model',{documentId:part.documentId});assert.equal(restored.document.features[0].params.profile.width,70);assert.equal(restored.revision,4);
 await call('document_action',{documentId:part.documentId,expectedRevision:4,action:'undo'});const undone=await call('inspect_model',{documentId:part.documentId});assert.equal(undone.document.features[0].params.profile.width,90);results.history={compared:true,restoreNewRevision:4,restoreUndo:true};
 await page.getByRole('tab',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Main assembly',exact:true}).click();await waitDoc(main.documentId);
 await page.getByRole('button',{name:'Workspace settings',exact:true}).click();await page.getByTitle('Dark appearance',{exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 const contrast=async(selector)=>page.locator(selector).first().evaluate(el=>{
  const luminance=value=>{const rgb=value.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const style=getComputedStyle(el),a=luminance(style.color),b=luminance(style.backgroundColor);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 });
 await page.getByRole('button',{name:'Insert part',exact:true}).click();await sourceSelect.click();await page.getByRole('option',{name:`${part.name} · part`,exact:true}).click();await page.locator('.tool-card .preview-readout.ready').waitFor();
 const previewContrast=await contrast('.preview-readout.ready');assert.ok(previewContrast>=4.5,`Dark preview contrast ${previewContrast}`);
 await page.locator('.preview-readout.ready').scrollIntoViewIfNeeded();await page.screenshot({path:join(out,'insert-dark-preview.png')});await page.locator('.tool-card').getByRole('button',{name:'Cancel',exact:true}).click();
 await details.click();await page.locator('.callout').first().waitFor();const calloutContrast=await contrast('.callout');assert.ok(calloutContrast>=4.5,`Dark dimensions contrast ${calloutContrast}`);
 await page.getByRole('button',{name:'Clear selection',exact:true}).first().click();results.contrast={darkPreview:previewContrast,darkDimension:calloutContrast};
 await page.screenshot({path:join(out,'model-dark.png')});const sceneVersion=(await call('inspect_model',{documentId:main.documentId})).storageVersion;await page.getByRole('button',{name:'Enter Studio',exact:true}).click();await page.getByRole('button',{name:'Scene',exact:true}).click();
 await page.getByRole('radio',{name:'Warehouse',exact:true}).check();assert.ok(await page.getByRole('radio',{name:'Warehouse',exact:true}).isChecked());
 await page.waitForFunction(()=>[...document.querySelectorAll('.environment-sample')].length===4&&[...document.querySelectorAll('.environment-sample')].every(c=>c.getContext('2d').getImageData(0,0,1,1).data[3]===255));
 assert.equal(await page.locator('.studio-process.working').count(),0);await page.screenshot({path:join(out,'studio-environments.png')});
 await page.getByRole('button',{name:/^Floor/}).click();await page.getByRole('radio',{name:'Wood planks',exact:true}).check();assert.ok(await page.getByRole('radio',{name:'Wood planks',exact:true}).isChecked());
 await page.screenshot({path:join(out,'studio-scene.png')});await page.getByRole('button',{name:'Output',exact:true}).click();await page.locator('.studio-output-choices label').filter({hasText:'Product views'}).click();await page.locator('.product-view-image img').first().waitFor();
 assert.equal(await page.locator('.studio-product-view-picker .product-view-image img').count(),16);
 assert.equal(await page.locator('.studio-product-view-picker>div').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2);
 await page.screenshot({path:join(out,'studio-product-views.png')});results.studio={visualFloor:true,environmentPreviews:4,actualViewThumbnails:16,readableTwoColumnViews:true};
 await page.getByRole('radio',{name:'Current camera',exact:true}).check();await page.getByRole('radio',{name:'High quality',exact:true}).check();await page.getByRole('button',{name:'Render image',exact:true}).click();await page.getByRole('button',{name:'Cancel image',exact:true}).waitFor();
 await browseProjects();const renderBrowser=page.getByRole('dialog',{name:'Browse projects',exact:true});await renderBrowser.getByRole('button',{name:/Workspace acceptance.*documents/}).click();await renderBrowser.locator('.picker-document').filter({hasText:'Dense fixture'}).click();const leaveRender=page.getByRole('dialog',{name:'Leave this design?',exact:true});await leaveRender.getByText('The active render will be stopped.',{exact:true}).waitFor();await leaveRender.getByRole('button',{name:'Cancel',exact:true}).click();await renderBrowser.getByRole('button',{name:'Return to workspace',exact:true}).click();await page.getByRole('button',{name:'Cancel image',exact:true}).click();await page.locator('.studio-process.working').waitFor({state:'hidden'});results.projectBrowser.activeRenderProtected=true;
 await page.getByRole('radio',{name:'Product views',exact:true}).check();
 await page.setViewportSize({width:1100,height:800});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('.studio-product-preview [role=status]').filter({hasText:'Live preview'}).waitFor();await page.screenshot({path:join(out,'studio-mobile.png')});
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('.studio-product-view-picker').waitFor({state:'visible'});
 await page.getByRole('checkbox',{name:'Top',exact:true}).uncheck();assert.equal(await page.getByRole('checkbox',{name:'Top',exact:true}).isChecked(),false);await page.getByRole('checkbox',{name:'Top',exact:true}).check();await page.screenshot({path:join(out,'studio-mobile-settings.png')});
 await page.getByRole('button',{name:'Exit Studio',exact:true}).click();await page.getByRole('button',{name:'Workspace settings',exact:true}).click();
 await page.getByRole('combobox',{name:'Display detail',exact:true}).click();const mobilePop=page.getByRole('listbox',{name:'Display detail',exact:true});await mobilePop.getByRole('option',{name:'Fine',exact:true}).waitFor();
 const mb=await mobilePop.boundingBox();assert.ok(mb.x>=8&&mb.x+mb.width<=382&&mb.y>=8&&mb.y+mb.height<=836);await mobilePop.evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:join(out,'shared-mobile-select.png')});await page.keyboard.press('Escape');await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();results.overlays.mobileBounds=true;
 await page.getByRole('button',{name:'Model panel',exact:true}).click();await page.getByRole('button',{name:'Replay construction',exact:true}).click();await page.getByRole('region',{name:'Replay',exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.getByRole('button',{name:'Close replay',exact:true}).click();results.replay.mobileClose=true;await details.click();assert.deepEqual(await page.evaluate(()=>window.__cad.inspect().document.selectedFeatureIds),['details']);
 results.contrast.mobilePanelButton=await contrast('.sheet-toggles [aria-pressed=true]');assert.ok(results.contrast.mobilePanelButton>=4.5);
 results.mobileIconStyle=await page.getByRole('button',{name:'Model panel',exact:true}).evaluate(el=>({button:getComputedStyle(el).color,icon:getComputedStyle(el.querySelector('svg')).color,background:getComputedStyle(el).backgroundColor}));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(out,'model-mobile.png')});results.responsive={widths:[1440,1100,390],noHorizontalOverflow:true,mobileSheetsUsable:true};
 await page.getByRole('button',{name:'Compact Model panel',exact:true}).click();assert.equal(await leftPanel.getAttribute('data-panel-state'),'compact');await page.screenshot({path:join(out,'panels-mobile-compact.png')});await page.getByRole('button',{name:'Hide Model panel',exact:true}).click();assert.ok(await leftPanel.isHidden());await page.getByRole('button',{name:'Model panel',exact:true}).click();assert.equal(await leftPanel.getAttribute('data-panel-state'),'expanded');results.panels.mobileCompactAndRestore=true;
 assert.equal((await call('inspect_model',{documentId:main.documentId})).storageVersion,sceneVersion);results.studio.draftLeavesSavedModelUnchanged=true;
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('textbox',{name:'Find in model',exact:true}).fill('Dense fixture');await page.getByRole('button',{name:'Dense fixture — 120 features',exact:true}).click();await waitDoc(dense.documentId);
 assert.equal(await page.locator('.model-tree-row').count(),120);await page.getByRole('textbox',{name:'Find in model',exact:true}).fill('Fixture block');await page.locator('.model-tree-row').first().focus();await page.keyboard.press('End');await page.keyboard.press('Enter');
 assert.deepEqual(await page.evaluate(()=>window.__cad.inspect().document.selectedFeatureIds),['block_119']);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(out,'model-dense.png')});results.denseModel={features:120,keyboardLastFeature:true};
 assert.equal(await page.locator('.workspace-path').count(),0);assert.equal(await page.locator('.topbar button[aria-label^="Document:"]').count(),0);
 const documentsBefore=(await call('documents',{action:'list'})).documents.length;
 await page.getByRole('button',{name:'New document',exact:true}).click();await page.getByRole('menuitem',{name:'New part',exact:true}).click();await page.waitForFunction(id=>window.__cad.inspect().document.documentId!==id&&window.__cad.inspect().phase==='ready',dense.documentId);
 const newPart=await page.evaluate(()=>window.__cad.inspect().document);assert.equal(newPart.kind,'part');assert.equal(newPart.projectId,LEGACY_PROJECT_ID);assert.equal(newPart.features.length,0);
 await page.getByRole('button',{name:`Actions for ${newPart.name}`,exact:true}).click();await page.getByRole('menuitem',{name:'Rename…',exact:true}).click();await page.getByRole('textbox',{name:'Document name',exact:true}).fill('Part created from sidebar');await page.getByRole('dialog').getByRole('button',{name:'Rename',exact:true}).click();await page.waitForFunction(()=>window.__cad.inspect().document.name==='Part created from sidebar');
 await page.getByRole('button',{name:'New document',exact:true}).click();await page.getByRole('menuitem',{name:'New assembly',exact:true}).click();await page.waitForFunction(id=>window.__cad.inspect().document.documentId!==id&&window.__cad.inspect().phase==='ready',newPart.documentId);
 const newAssembly=await page.evaluate(()=>window.__cad.inspect().document);assert.equal(newAssembly.kind,'assembly');assert.equal(newAssembly.projectId,LEGACY_PROJECT_ID);assert.equal(newAssembly.features.length,0);assert.equal((await call('documents',{action:'list'})).documents.length,documentsBefore+2);
 await page.screenshot({path:join(out,'sidebar-create.png')});results.sidebar={singleDocumentBrowser:true,partCreated:true,assemblyCreated:true,rename:true};
 assert.deepEqual(errors,[]);results.browserErrors=errors;await writeFile(join(out,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}catch(error){const failed=browser?.contexts()[0]?.pages()[0];if(failed){await failed.screenshot({path:join(out,'failure.png')}).catch(()=>{});await writeFile(join(out,'failure.html'),await failed.content()).catch(()=>{});}console.error(error);throw error;}finally{await browser?.close();await server?.close();await bridge?.close();await rm(dir,{recursive:true,force:true});}
