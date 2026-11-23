// Isolated live Studio/MCP proof. Run: node --import tsx scripts/verify-studio-video-plan.mjs 3
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startBridge } from '../src/bridge/server.ts';
import { SqliteStore } from '../src/bridge/sqlite-store.ts';
import { emptyDocument } from '../src/cad/document.ts';

const step = Number(process.argv[2] ?? 3), root = fileURLToPath(new URL('../',import.meta.url));
const state = await mkdtemp(join(tmpdir(),`vibeworks-video-step${step}-`));
const out = join(root,'output/playwright/video-plan',`step${step}`); await mkdir(out,{recursive:true});
const WEB=48173, BRIDGE=48318;
process.env.VIBEWORKS_WEB_PORT=String(WEB); process.env.VIBEWORKS_BRIDGE_PORT=String(BRIDGE);
process.env.VIBEWORKS_DB_PATH=join(state,'workspace.db'); process.env.VIBEWORKS_CONNECTION_FILE=join(state,'connection.json');
const store = new SqliteStore(process.env.VIBEWORKS_DB_PATH);
const document={...emptyDocument(),name:'Studio video verification',features:[
  {id:'base',kind:'box',label:'Base',params:{origin:[-45,-30,0],size:[90,60,12]},appearance:{material:'aluminum',color:'#d27c45',finish:'satin'}},
  {id:'spindle',kind:'cylinder',label:'Spindle',params:{origin:[0,0,12],radius:18,height:45},appearance:{material:'steel',finish:'mirror'}},
]};
if(step>=4)document.features.push(
  {id:'bore_tool',kind:'cylinder',params:{origin:[0,0,11],radius:5,height:48}},
  {id:'hollow_spindle',kind:'subtract',params:{target:'spindle',tools:['bore_tool']}},
);
const focusId=step>=4?'hollow_spindle':'spindle';
await store.put(document,null);store.close();
let bridge,web,browser,client;
const report={step,state,checks:[],videos:[],errors:[]};
const exec=promisify(execFile);
try {
  bridge=await startBridge({port:BRIDGE,workers:1,databasePath:process.env.VIBEWORKS_DB_PATH,connectionFile:process.env.VIBEWORKS_CONNECTION_FILE,webOrigins:[`http://127.0.0.1:${WEB}`]}); await bridge.ready();
  web=await createServer({root,configFile:join(root,'vite.config.ts')});await web.listen();
  client=new Client({name:'studio-video-plan-proof',version:'1.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx',join(root,'src/bridge/mcp.ts')],cwd:root,
    env:{...process.env,VIBEWORKS_CONNECTION_FILE:process.env.VIBEWORKS_CONNECTION_FILE}}));
  async function call(name,args){const result=await client.callTool({name,arguments:args}); const receipt=result.structuredContent;
    assert.ok(!result.isError,JSON.stringify(receipt));assert.equal(receipt.status,'success',JSON.stringify(receipt));return receipt;}
  await call('agent_session',{action:'join',client:'studio-video-plan-proof'});
  const before=await call('inspect_model',{documentId:document.documentId,definitionsOnly:true});
  const recipe={keyframes:[
    {shot:{from:[1,-1,.6]},motion:'smooth',seconds:.75,hold:.1,focalLengthMm:35},
    {shot:{from:[1,1,.7]},focus:{featureIds:[focusId]},motion:'smooth',seconds:.75,hold:0,focalLengthMm:70,easing:'linear'},
    {shot:{from:[-1,1,.4]},motion:'smooth',seconds:.75,hold:0,focalLengthMm:50},
  ]};
  const started=await call('render_video',{action:'start',documentId:document.documentId,requestId:randomUUID(),video:recipe,
    output:{aspect:'16:9',resolution:'720p',fps:24,quality:'high',...(step>=5?{depthOfField:{fStop:4}}:{})},skipAnalysis:true});
  let done=started;
  const deadline=Date.now()+120000;
  while(!['complete','error','cancelled'].includes(done.videoJob.state)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));done=await call('render_video',{action:'status',jobId:started.videoJob.jobId});}
  assert.equal(done.videoJob.state,'complete',JSON.stringify(done));
  done=await call('render_video',{action:'result',jobId:started.videoJob.jobId});
  assert.equal(done.videoJob.keyframes[1].camera.focalLengthMm,70);
  if(step>=5){assert.equal(done.evaluationStats.display.toleranceMm,.005);assert.equal(done.videoJob.output.depthOfField.fStop,4);report.checks.push('final fine B-rep tessellation and optional focus/lens depth of field reached MCP output');}
  assert.ok(done.warnings.some(w=>w.includes('VIDEO_CROP')),'agent receives crop warnings');
  await writeFile(join(out,'poster.png'),await readFile(done.video.poster.path));
  const metadata=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-of','json',done.video.path])).stdout).streams[0];
  assert.equal(metadata.width,1280); assert.equal(metadata.height,720);assert.equal(metadata.codec_name,'h264');
  assert.equal(Number(metadata.nb_frames),done.video.frames);
  report.videos.push({path:done.video.path,frames:done.video.frames,width:metadata.width,height:metadata.height,warnings:done.warnings});
  report.checks.push('MCP smooth/lens/focus recipe rendered a complete H.264 video with crop warnings');
  if(step>=4){
    const camera=structuredClone(done.videoJob.keyframes[0].camera);
    camera.position=camera.position.map((v,i)=>camera.target[i]+(v-camera.target[i])*1.6);
    for(const animation of [{kind:'construction'},{kind:'exploded',direction:'out',offsets:[{featureId:focusId,offsetMm:[0,0,40]}]}]){
      const video={keyframes:[{camera,motion:'move',seconds:.8,hold:.2},{camera,motion:'move',seconds:.8,hold:0}],animation};
      let result=await call('render_video',{action:'start',documentId:document.documentId,requestId:randomUUID(),video,output:{resolution:'720p',fps:24},skipAnalysis:true});
      const id=result.videoJob.jobId,deadline=Date.now()+120000;
      while(!['complete','error','cancelled'].includes(result.videoJob.state)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));result=await call('render_video',{action:'status',jobId:id});}
      assert.equal(result.videoJob.state,'complete',JSON.stringify(result));result=await call('render_video',{action:'result',jobId:id});
      await writeFile(join(out,animation.kind+'-poster.png'),await readFile(result.video.poster.path));
      await exec('ffmpeg',['-y','-v','error','-i',result.video.path,'-vf',`select='eq(n,0)+eq(n,${result.video.frames-1})'`,'-vsync','0',join(out,animation.kind+'-%02d.png')]);
      report.videos.push({animation:animation.kind,path:result.video.path,frames:result.video.frames});
    }
    report.checks.push('MCP construction and exploded recipes rendered complete videos from a static camera');
  }
  browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-angle=metal']:[]});
  const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light'});page.setDefaultTimeout(20000);
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${WEB}`);await page.evaluate(()=>window.__cad.ready);
  await page.locator('.picker-project').first().click();await page.locator('.picker-document').first().click();
  await page.getByRole('button',{name:'Enter Studio',exact:true}).click();
  await page.getByRole('button',{name:'Video',exact:true}).click();
  await page.getByRole('button',{name:'Add view',exact:true}).waitFor({state:'visible'});
  const viewport=page.getByRole('img',{name:/^Studio model\./});const box=await viewport.boundingBox();
  for(const f of [.5,.45,.55]){if(await page.getByRole('button',{name:'Frame selected',exact:true}).isEnabled())break;
    await page.mouse.click(box.x+box.width*f,box.y+box.height*.5);}
  assert.ok(await page.getByRole('button',{name:'Frame selected',exact:true}).isEnabled(),'click selects a real model part');
  await page.getByRole('button',{name:'Frame selected',exact:true}).click();
  await page.getByRole('button',{name:'Add view',exact:true}).click();
  await page.getByRole('button',{name:'Edit view',exact:true}).click();
  await page.getByRole('button',{name:'Smooth path',exact:true}).click();
  await page.getByRole('textbox',{name:'View name',exact:true}).fill('Camera detail');
  await page.getByRole('spinbutton',{name:'Lens millimetres',exact:true}).fill('65');
  await page.getByRole('combobox',{name:'Segment easing',exact:true}).selectOption('ease_in_out');
  await page.locator('.studio-video-shots img').first().waitFor();
  await page.screenshot({path:join(out,'path-editor.png')});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.studio-video-shots img').first().waitFor();
  await page.screenshot({path:join(out,'path-editor-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile has no page overflow');
  const stored=await page.evaluate(id=>JSON.parse(localStorage.getItem(`vibeworks.studio.video.${id}`)),document.documentId);
  assert.ok(stored[0].focus.featureIds.length);assert.equal(stored[1].camera.focalLengthMm,65);assert.equal(stored[1].easing,'ease_in_out');
  if(step>=4){
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('combobox',{name:'Model animation',exact:true}).selectOption('construction');
    await page.getByText(/Construction step 4 \/ 4 · exact preview/).waitFor();
    await page.getByRole('slider',{name:'Video playhead',exact:true}).press('Home');
    await page.getByText(/Construction step 1 \/ 4 · exact preview/).waitFor();
    await page.screenshot({path:join(out,'construction-preview.png')});
    if(step>=5){await page.locator('.studio-video-export-summary').click();if(step>=6){assert.equal(await page.getByRole('button',{name:'Realistic',exact:true}).isDisabled(),true);report.checks.push('Realistic video visibly restricted with resumability explanation');}
      await page.getByRole('checkbox',{name:'Depth of field',exact:true}).check();await page.getByRole('spinbutton',{name:'Aperture f-stop',exact:true}).fill('5.6');await page.locator('.studio-video-export-summary').click();}
    await page.getByRole('button',{name:'Render video',exact:true}).click();
    await Promise.race([page.getByRole('dialog',{name:'Finished video',exact:true}).waitFor({timeout:120000}),
      page.locator('.studio-process.failed').waitFor({timeout:120000}).then(async()=>{throw new Error(await page.locator('.studio-process.failed').innerText());})]);
    if(step>=6){assert.equal(await page.locator('.studio-video-panel').getAttribute('data-video-state'),'complete');report.checks.push('panel exposes script-readable complete terminal state');}
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Save MP4',exact:true}).click();
    await(await download).saveAs(join(out,'panel-construction.mp4'));
    await page.getByRole('button',{name:'Close video',exact:true}).click();
    await page.getByRole('combobox',{name:'Model animation',exact:true}).selectOption('exploded');
    await page.getByRole('button',{name:'Add selected offset',exact:true}).click();
    await page.getByRole('combobox',{name:'Explosion direction',exact:true}).selectOption('out');
    await page.getByRole('slider',{name:'Video playhead',exact:true}).press('End');
    await page.screenshot({path:join(out,'exploded-preview.png')});
    await page.getByRole('combobox',{name:'Model animation',exact:true}).selectOption('none');
    report.checks.push('panel exact construction preview, shared-job construction MP4, exploded offsets and restoration');
  }
  const after=await call('inspect_model',{documentId:document.documentId,definitionsOnly:true});
  assert.equal(before.revision,after.revision);assert.deepEqual(before.document,after.document);
  assert.deepEqual(report.errors,[]);report.checks.push('panel part selection, framing, lens/easing editing, narrow layout, saved model unchanged');
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  if(browser){const page=browser.contexts()[0]?.pages()[0];if(page){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});console.error((await page.locator('body').ariaSnapshot()).slice(-2500));}}
  throw error;
} finally {
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();await client?.close();await web?.close();await bridge?.close();
}
