import test from 'node:test';
import assert from 'node:assert/strict';
import {NodeGeometryWorker} from '../src/cad/node-worker';
import {emptyDocument,validateDocument} from '../src/cad/document';
import {MemoryStore} from '../src/cad/store';
import {CommandAuthority} from '../src/bridge/authority';
import type {Feature} from '../src/shared/protocol';

const profile=(x:number,y:number)=>({type:'polygon',points:[[-x/2,-y/2],[x/2,-y/2],[x/2,y/2],[-x/2,y/2]],segmentIds:['bottom','right','top','left']});
const frame=(z:number,angle=0)=>({origin:[0,0,z],normal:[0,0,1],xDirection:[Math.cos(angle),Math.sin(angle),0]});
const feature=(middle=-14)=>({id:'body',kind:'loft',params:{correspondence:'authored',ruled:false,toleranceMm:0.005,sections:[{profile:profile(20,10),frame:frame(0)},{profile:profile(16,8),frame:frame(20)}],guides:[{vertex:'bottom',path:{points:[[-10,-5,0],[middle,-6,10],[-8,-4,20]]}}]}});

test('native guided lofts follow two and three authored sections and curved rails with named surfaces',async t=>{
 const worker=new NodeGeometryWorker({timeoutMs:15000});t.after(()=>worker.close());
 const two=feature(),three=feature();three.params.sections.splice(1,0,{profile:profile(28,12),frame:frame(10)});
 for(const f of[two,three]){
  const doc=validateDocument({...emptyDocument(),features:[f]}),e=await worker.evaluate(doc);
  assert.equal(e.geometry[0].valid,true);assert.equal(e.geometry[0].solidCount,1);
  assert.equal(e.meshes[0].topology!.faces.length,6);assert.ok(e.meshes[0].topology!.faces.every(face=>face.lineage.length));
  const residuals=e.geometry[0].diagnostics!.residuals as {sampledMaximumMm:number;builderMaximumMm:number}[];
  assert.equal(residuals.length,4);assert.ok(residuals.every(r=>r.sampledMaximumMm<=0.005&&r.builderMaximumMm<=0.005));
  assert.ok((e.geometry[0].diagnostics!.maximumToleranceMm as number)<=0.005);
 }
 const a=await worker.evaluate(validateDocument({...emptyDocument(),features:[feature(-12)]})),b=await worker.evaluate(validateDocument({...emptyDocument(),features:[feature(-16)]}));
 assert.ok(Math.abs(a.geometry[0].volumeMm3-b.geometry[0].volumeMm3)>1,'guide shape must affect exact volume');
});

test('failed guided loft edits preserve saved definitions and history through the command authority',async t=>{
 const store=new MemoryStore(),doc=validateDocument({...emptyDocument(),features:[feature()]});await store.put(doc,null);
 const authority=new CommandAuthority(store,{workers:1});t.after(()=>authority.close());await authority.ready();
 const before=await authority.execute({type:'inspect_model',params:{documentId:doc.documentId}});assert.equal(before.result.status,'success',JSON.stringify(before.result.error));
 const history=await store.operation({action:'history',documentId:doc.documentId}),bad=structuredClone(doc.features[0]) as Extract<Feature,{kind:'loft'}>;
 const stored=await store.read(doc.documentId);
 if(!bad.params.guides||!('points'in bad.params.guides[0].path))throw Error();bad.params.guides[0].path.points[0][0]-=3;
 const result=await authority.execute({type:'apply_edits',params:{documentId:doc.documentId,expectedRevision:0,analyze:false,edits:[{op:'update',feature:bad}]}});
 assert.equal(result.result.status,'error');assert.equal(result.result.error!.code,'LOFT_GUIDE_ENDPOINT');
 assert.deepEqual(await store.read(doc.documentId),stored);assert.deepEqual(await store.operation({action:'history',documentId:doc.documentId}),history);
});
