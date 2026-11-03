/** Isolated UI acceptance. Real React components and CSS, fixture activity only; no CAD service or user data. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const out=resolve('output/playwright/agent-review-ui');
await mkdir(out,{recursive:true});
const source=`
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AgentsTab,AgentDetail} from './src/web/Agents';
import {AgentMark} from './src/web/AgentMark';
import {FloatingPanel} from './src/web/FloatingPanel';
import {Tooltips} from './src/web/Tooltips';
import './src/web/styles.css';
import './src/web/experience.css';
import './src/web/workspace-redesign.css';
const stamp=new Date().toISOString();
const project={projectId:'fixture',name:'VWR 12 | Racing'};
const docs=[{documentId:'main',projectId:'fixture',name:'VWR 12 | Flowline',kind:'assembly'}, {documentId:'source',projectId:'fixture',name:'VWR 12 | Continuous chassis and bodywork',kind:'part'}];
const make=(id,name,connected=true)=>({identity:{agentId:id,name,kind:'agent',createdAt:stamp},connected,running:0,queued:0,activeWork:[],session:{agentId:id,sessionId:'session-'+id,client:'codex',model:'Test fixture',startedAt:stamp,lastSeenAt:stamp,workState:connected?'working':'completed',phase:'integrating',task:'Coordinate the chassis and bodywork. This is a fixture report.',focus:{projectId:'fixture',documentId:'source',featureIds:['body']}}});
const initial=[make('agent-bright-owl-67','bright_owl'),make('agent-quiet-falcon-68','quiet_falcon'),make('earlier-01','mellow_heron',false)];
const commit={operationId:'commit-1',agentId:initial[0].identity.agentId,sequence:1,commitSequence:1,toVersion:1,featureIds:['body'],status:'success',operation:'apply_edits',documentId:'source',revision:67,startedAt:stamp,completedAt:stamp,intent:{purpose:'Apply reviewed livery and the canonical logo to the completed body.'}};
const runtime={execute:async()=>({status:'success',operations:[commit],participants:initial,sessions:initial.map(p=>p.session)})};
function Fixture(){
 const [people,setPeople]=useState(initial),[selected,setSelected]=useState(initial[0].identity.agentId),[follow,setFollow]=useState(),[sides,setSides]=useState([]),[view,setView]=useState('main');
 const [long,setLong]=useState(false),[left,setLeft]=useState('expanded'),[right,setRight]=useState('expanded');
 const p=people.find(p=>p.identity.agentId===selected);
 const work={participants:people,operations:[commit],sessions:people.map(p=>p.session)};
 const viewing={...docs.find(d=>d.documentId===view),features:view==='main'?[{id:'placement',kind:'instance',params:{document:'source'}}]:[{id:'body',kind:'box',params:{size:[1,1,1]}}]};
 const start=(id,mode='follow')=>{setFollow({id,mode,paused:mode==='show'});setView('source');};
 window.fixture={update:()=>{setLong(true);setPeople(ps=>ps.map(p=>({...p,identity:{...p.identity,name:p.identity.name+'_with_a_very_long_unbroken_name'},session:{...p.session,task:'A long and changing report. '.repeat(80),phase:'An extremely long status update '.repeat(10),focus:{...p.session.focus,featureIds:['a_very_long_unbroken_feature_id_'.repeat(20)]}},lastAction:{...commit,status:'error',toVersion:undefined,error:{code:'FIXTURE',message:'A long failure message '.repeat(50)}}})));},disconnect:()=>setPeople(ps=>ps.map(p=>({...p,connected:false,session:{...p.session,endedAt:stamp}})))};
 const toggleSide=id=>setSides(ids=>ids.includes(id)?ids.filter(v=>v!==id):[...ids,id]);
 return <><div className="fixture-label">Isolated agent UI fixture, no CAD model or service</div><main className="fixture-workspace">
 <FloatingPanel side="left" label="Model" heading="Project" mode={left} restoreMode="expanded" onMode={setLeft}>
 <div className="panel-scroll"><AgentsTab runtime={runtime} changes={{work,loadEarlier:async()=>{}}} work={work} documents={long?docs.map(d=>({...d,name:d.name+' extra details '.repeat(20)})):docs} projects={[project]} projectId="fixture" connection={{phase:'connected'}} doc={viewing} selected={selected} onSelect={setSelected} following={follow?.id} followPaused={!!follow?.paused} sideViews={sides} canAddSide={sides.length<3} onToggleFollow={p=>follow?.id===p.identity.agentId?setFollow({...follow,paused:!follow.paused}):start(p.identity.agentId)} onToggleSide={toggleSide} onView={async()=>{}} loadEarlier={async()=>{}} cancelKey={0} reconnect={()=>{}} /></div>
 </FloatingPanel>
 <div className="fixture-marks" aria-label="Generated identity examples">{Array.from({length:12},(_,i)=><AgentMark key={i} id={'agent-example-'+i} size={36} />)}</div>
 <FloatingPanel side="right" label="Details" mode={right} restoreMode="expanded" onMode={setRight}>
 <div className="panel-scroll">{p&&<AgentDetail key={p.identity.agentId} participant={p} participants={people} projects={[project]} projectId="fixture" documents={long?docs.map(d=>({...d,name:d.name+' extra details '.repeat(20)})):docs} viewing={viewing} commits={[commit]} operations={[commit]} follow={follow?.id===p.identity.agentId?follow:undefined} sideView={sides.includes(p.identity.agentId)} canAddSide={sides.length<3} onShowWork={()=>start(p.identity.agentId,'show')} onFollow={()=>start(p.identity.agentId)} onPauseFollow={()=>setFollow({...follow,paused:true})} onResumeFollow={()=>setFollow({...follow,mode:'follow',paused:false})} onReturn={()=>{setFollow(undefined);setView('main');}} onToggleSide={()=>toggleSide(p.identity.agentId)} onHighlight={()=>window.highlighted=true} onReviewChange={()=>window.reviewed=true} onClose={()=>setSelected(undefined)} />}</div>
 </FloatingPanel></main><Tooltips /></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const bundled=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'agent-review-fixture.tsx',loader:'tsx'},bundle:true,write:false,outdir:'fixture',format:'esm',platform:'browser',jsx:'automatic',logLevel:'silent'});
const files=new Map(bundled.outputFiles.map(f=>['/'+f.path.split('/').pop(),f.contents]));
const html=`<!doctype html><html data-theme="light"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/stdin.css"><style>html,body,#root{height:100%;overflow:hidden}.fixture-label{height:48px;padding:12px 16px;font-size:12px;color:var(--ink-3)}.fixture-workspace{position:relative;height:calc(100% - 48px);background:var(--paper)}.fixture-workspace>.floating-panel{top:12px;bottom:12px;height:calc(100% - 24px)}.fixture-marks{position:absolute;left:calc(50% - 145px);top:30%;width:290px;display:flex;flex-wrap:wrap;gap:12px}@media(max-width:860px){.fixture-workspace>.left-panel{left:12px;right:12px;bottom:12px;top:auto;height:calc(100% - 24px);width:calc(100% - 24px)}.fixture-workspace>.right-panel{display:none}.fixture-workspace.show-details>.left-panel{display:none}.fixture-workspace.show-details>.right-panel{display:flex;left:12px;right:12px;bottom:12px;top:auto;height:calc(100% - 24px);width:calc(100% - 24px)}} </style><div id="root"></div><script type="module" src="/stdin.js"></script></html>`;
const server=createServer((req,res)=>{const data=files.get(req.url);res.setHeader('Content-Type',req.url?.endsWith('.css')?'text/css':data?'text/javascript':'text/html');res.end(data??html);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
const results={};const errors=[];
try{
const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.message);});page.setDefaultTimeout(8000);
await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.agent-detail-top').waitFor();
const detail=page.locator('.agent-detail');
const main=detail.getByRole('button',{name:'Follow in main view',exact:true});
const top=await main.boundingBox();assert.ok(top.y<300);
const progress=await detail.locator('.agent-progress').boundingBox();
await page.screenshot({path:resolve(out,'light-default.png')});
const contactIsGreen=()=>page.locator('.agent-connection-trigger').evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--ok)';document.body.append(probe);const same=getComputedStyle(el).color===getComputedStyle(probe).color;probe.remove();return same;});assert.equal(await contactIsGreen(),true);
await detail.getByRole('button',{name:/Connected. Session and connection details/}).click();
await page.getByRole('dialog',{name:'Session and connection'}).waitFor();assert.equal(await page.locator('.agent-connection-trigger').getAttribute('aria-expanded'),'true');
await page.keyboard.press('Escape');assert.equal(await page.locator('.agent-connection-trigger').evaluate(el=>el===document.activeElement),true);
await main.click();await detail.getByRole('button',{name:'Pause following',exact:true}).click();await detail.getByRole('button',{name:'Resume following',exact:true}).click();await detail.getByRole('button',{name:'Return to my view',exact:true}).click();
await detail.getByRole('button',{name:'Open side view',exact:true}).click();await detail.getByRole('button',{name:'Close side view',exact:true}).click();
await page.getByRole('button',{name:'Follow in main view for Quiet Falcon',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Pause following for Quiet Falcon',exact:true}).getAttribute('aria-pressed'),'true');
await page.getByRole('button',{name:'Open side view for Quiet Falcon',exact:true}).click();await page.getByRole('button',{name:'Close side view for Quiet Falcon',exact:true}).click();
// Shortcuts are sibling controls, so they never toggle the selected agent accidentally.
assert.equal(await detail.locator('h2').innerText(),'Bright Owl');
const selection=await page.locator('.team-member.selected').evaluate(el=>({shadow:getComputedStyle(el).boxShadow,border:getComputedStyle(el).borderLeftWidth}));assert.equal(selection.shadow,'none');assert.equal(selection.border,'1px');
await page.locator('.team-earlier>summary').click();assert.equal(await page.locator('.team-earlier').getAttribute('open'),'');await page.locator('.team-earlier>summary').click();
await page.getByRole('button',{name:'Activity log',exact:true}).click();await page.getByRole('heading',{name:'Activity log',exact:true}).waitFor();await page.getByRole('button',{name:'Team',exact:true}).click();
await page.getByRole('button',{name:'Sessions',exact:true}).click();await page.getByRole('region',{name:'Project sessions'}).waitFor();await page.getByRole('button',{name:'Team',exact:true}).click();
await page.keyboard.press('Tab');await page.getByRole('button',{name:'Open side view for Bright Owl',exact:true}).focus();await page.getByRole('tooltip').waitFor();assert.match(await page.getByRole('tooltip').innerText(),/Open beside my view/);
results.actions={followPauseResumeReturn:true,sideViewOpenClose:true,sidebarShortcuts:true,connectionEscapeRestoresFocus:true,recordsNavigation:true,earlierDisclosure:true,keyboardTooltip:true,noSelectionStripe:true};
// Default report updates must not move the top controls or the recorded-progress section.
await page.evaluate(()=>window.fixture.update());
const updated=await detail.getByRole('button',{name:'Follow in main view',exact:true}).boundingBox();assert.ok(Math.abs(top.y-updated.y)<1);
assert.match(await detail.locator('.agent-commit>small').innerText(),/r67/);
const changedProgress=await detail.locator('.agent-progress').boundingBox();assert.ok(Math.abs(progress.y-changedProgress.y)<1,JSON.stringify({progress,changedProgress}));
results.stability={longNamesReportsAndFailure:true,controlsDelta:updated.y-top.y,progressDelta:changedProgress.y-progress.y};
for(const theme of ['light','dark'])for(const width of [1440,1100,390]){
 await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 await page.evaluate(()=>document.querySelector('.fixture-workspace').classList.remove('show-details'));
 await page.screenshot({path:resolve(out,theme+'-'+width+'-team.png')});
 if(width===390)await page.evaluate(()=>document.querySelector('.fixture-workspace').classList.add('show-details'));
 await page.screenshot({path:resolve(out,theme+'-'+width+'-details.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const contrasts=await page.evaluate(()=>{
  const context=document.createElement('canvas').getContext('2d');context.canvas.width=1;context.canvas.height=1;
  const rgb=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3);};
  const lum=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const bg=lum(rgb(getComputedStyle(document.querySelector('.agent-detail-top')).backgroundColor));
  const ratio=el=>{const fg=lum(rgb(getComputedStyle(el).color));return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);};
  return {text:[...document.querySelectorAll('.agent-detail h2,.agent-detail .section-title,.agent-progress-facts dt,.agent-connection-trigger')].map(ratio),marks:[...document.querySelectorAll('.fixture-marks .agent-mark')].map(ratio)};
 });
 assert.ok(contrasts.text.every(n=>n>=4.5),JSON.stringify(contrasts));assert.ok(contrasts.marks.every(n=>n>=3),JSON.stringify(contrasts));
 const bounds=await detail.getByRole('button',{name:'Follow in main view',exact:true}).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
 if(width===390){const buttons=await page.locator('.agent-view-buttons>button,.team-row-actions>button,.agent-disclosure>summary,.agent-connection-trigger').evaluateAll(els=>els.filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect().height));assert.ok(buttons.every(h=>h>=44));}
}
await page.setViewportSize({width:1440,height:760});
await detail.locator('.agent-reported>summary').click();await detail.locator('.agent-reported').evaluate(el=>el.scrollIntoView({block:'start'}));
const pinned=await detail.getByRole('button',{name:'Follow in main view',exact:true}).boundingBox();assert.ok(pinned.y>0&&pinned.y<300);
await page.screenshot({path:resolve(out,'dark-pinned-controls.png')});
await page.evaluate(()=>window.fixture.disconnect());
await detail.getByRole('button',{name:/Session ended. Session and connection details/}).click();await page.getByRole('dialog',{name:'Session and connection'}).waitFor();
assert.equal(await detail.getByRole('button',{name:'Follow in main view',exact:true}).isDisabled(),true);
assert.equal(await contactIsGreen(),false);
await page.screenshot({path:resolve(out,'disconnected-session.png')});
results.layouts={themes:['light','dark'],widths:[1440,1100,390],touchTargets:true,stickyControls:true,disconnectedState:true,textAndAvatarContrast:true};
assert.deepEqual(errors,[]);results.pageErrors=errors;
await writeFile(resolve(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}catch(error){const page=browser.contexts()[0]?.pages()[0];if(page){await page.screenshot({path:resolve(out,'failure.png')});await writeFile(resolve(out,'failure.txt'),await page.locator('body').innerText());}throw error;}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
