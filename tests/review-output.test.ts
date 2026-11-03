import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startBridge } from '../src/bridge/server';
import { PROJECT_ROOT } from '../src/bridge/connection';
import { toMcpResult } from '../src/bridge/mcp';

test('one MCP review returns individual views, exact sections, profile images and an immutable matched baseline',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cad-review-')),file=join(dir,'connection.json');
  const bridge=await startBridge({port:0,connectionFile:file,workers:1});await bridge.ready();
  const client=new Client({name:'review-sdk',version:'1'});const paths:string[]=[];
  t.after(async()=>{await client.close();await bridge.close();await Promise.all(paths.map(path=>rm(path,{force:true})));await rm(dir,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx',join(PROJECT_ROOT,'src/bridge/mcp.ts')],cwd:PROJECT_ROOT,env:{...process.env,VIBEWORKS_CONNECTION_FILE:file} as Record<string,string>}));
  const call=async(name:string,args:Record<string,unknown>)=>{
    const reply=await client.callTool({name,arguments:args});const value=reply.structuredContent as any;
    assert.equal(reply.isError,undefined,JSON.stringify(value));
    if(value.image){paths.push(value.image.path);for(const p of value.image.panels??[])paths.push(p.path);}
    return {value,reply};
  };
  await call('agent_session',{action:'join',client:'review-test'});
  const {value:initial}=await call('inspect_model',{});const documentId=initial.documentId;
  const body=(width:number)=>({id:'body',kind:'extrude',params:{profile:{type:'rectangle',width,height:10},plane:'XY',origin:[0,0,0],distance:5},appearance:{material:'aluminum'}});
  await call('apply_edits',{documentId,expectedRevision:0,edits:[{op:'add',feature:body(20)}]});
  const {value:first,reply}=await call('render_views',{documentId,tileSize:192,views:['front','right','top'],outputs:'both',review:{sections:[{axis:'Z',offset:2.5}],profiles:[{featureId:'body'}]}});
  assert.deepEqual(first.review.totals.size,[20,10,5]);assert.ok(Math.abs(first.review.totals.sumVisibleVolumesMm3-1000)<1e-6);
  assert.equal(first.sections[0].widthMm,20);assert.equal(first.sections[0].heightMm,10);
  assert.equal(first.image.panels.filter((p:any)=>p.kind==='view').length,3);
  assert.equal(first.image.panels.filter((p:any)=>p.kind==='profile').length,1);
  assert.equal(reply.content.filter(c=>c.type==='image').length,2);
  for(const p of first.image.panels)assert.equal((await readFile(p.path)).toString('ascii',12,16),'IHDR');
  const baseline=first.review.snapshot.snapshotId;
  const {value:edited,reply:editedReply}=await call('apply_edits',{documentId,expectedRevision:1,edits:[{op:'update',feature:body(30)}],
    review:{tileSize:192,shots:[{view:'front'},{from:[1,-1,1],projection:'perspective',frame:{featureIds:['body']}}],compareTo:baseline,profiles:[{featureId:'body'}]}});
  assert.equal(edited.revision,2);assert.deepEqual(edited.review.comparison.sizeDeltaMm,[10,0,0]);
  assert.ok(Math.abs(edited.review.comparison.visibleVolumeDeltaMm3-500)<1e-6);assert.equal(editedReply.content.filter(c=>c.type==='image').length,3);
  assert.equal(edited.image.panels.filter((p:any)=>p.kind==='baseline').length,1);
  assert.deepEqual(edited.image.panels.find((p:any)=>p.kind==='baseline').tiles,edited.image.tiles,'before/after cameras and scales must match');
  const {value:old}=await call('inspect_model',{detail:'full',documentId,snapshot:{id:baseline}});
  assert.equal(old.revision,1);assert.ok(Math.abs(old.geometry[0].volumeMm3-1000)<1e-6);
  const {value:failedReview}=await call('apply_edits',{documentId,expectedRevision:2,edits:[{op:'update',feature:body(40)}],
    review:{tileSize:128,profiles:[{featureId:'missing'}]}});
  assert.equal(failedReview.status,'success');assert.equal(failedReview.revision,3);
  assert.equal(failedReview.reviewFailure.committed,true);assert.equal(failedReview.reviewFailure.code,'PROFILE_UNAVAILABLE');
  const {value:latest}=await call('inspect_model',{detail:'full',documentId});assert.equal(latest.revision,3);assert.ok(Math.abs(latest.geometry[0].volumeMm3-2000)<1e-6);
});

test('image delivery failure after an edit keeps the successful commit receipt explicit',async()=>{
  const documentId=crypto.randomUUID();
  const reply=await toMcpResult({type:'apply_edits',params:{documentId,expectedRevision:0,edits:[],review:{}}},
    {operation:'apply_edits',status:'success',documentId,revision:1,created:['body'],updated:[],warnings:[],
      image:{mimeType:'image/png',base64:'broken',width:1,height:1,tiles:[]}});
  const result=reply.structuredContent as any;
  assert.equal(reply.isError,undefined);assert.equal(result.status,'success');assert.equal(result.revision,1);
  assert.equal(result.reviewFailure.committed,true);assert.equal(result.reviewFailure.code,'IMAGE_DELIVERY_FAILED');
});
