import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CommandAuthority } from '../src/bridge/authority';
import { SqliteStore } from '../src/bridge/sqlite-store';
import { displayDeliverySchema } from '../src/bridge/validation';
import { parseCommand, type CadDocument, type Vector3 } from '../src/shared/protocol';
import { emptyDocument } from '../src/cad/document';
import { replayPlan } from '../src/cad/replay';
import { createWorkbenchScene, disposeScene } from '../src/web/scene';
import { advanceOrbit, prepareOrbit, orbitLoop, showOutline } from '../src/web/presentation';
import { presentationFixture, ok, instance } from './fixtures/presentation';
import { expectedPlacement } from './fixtures/mount-placement';
const near = (a: number, b: number) => assert.ok(Math.abs(a-b) < 1e-5, `${a} != ${b}`);
const point = (a: number[], b: number[]) => a.forEach((n,i) => near(n,b[i]));

test('shaded hides ordinary edges while meshes, selection, ghosts and feedback stay available', () => {
  const evaluation = { visibleFeatureIds: ['body'], geometry: [], meshes: ['body','input'].map(featureId => ({ featureId, vertices: [0,0,0, 1,0,0, 0,1,0], normals: [0,0,1, 0,0,1, 0,0,1], triangles: [0,1,2], lines: [0,0,0,1,0,0] })) };
  const plain = createWorkbenchScene(evaluation, [], ['input'], undefined, false);
  assert.equal(plain.parts[0].outline.visible, false);
  assert.equal(plain.parts[0].mesh.visible, true);
  assert.equal(plain.parts[1].outline.visible, true);
  const selected = createWorkbenchScene(evaluation, ['body'], [], undefined, false);
  assert.equal(selected.parts[0].outline.visible, true);
  for (let i=0;i<5;i++) { const flags = [false,false,false,false,false]; flags[i]=true; assert.equal(showOutline(false, ...flags as [boolean,boolean,boolean,boolean,boolean]), true); }
  assert.equal(showOutline(false,false,false,false,false,false), false);
  disposeScene(plain.scene); disposeScene(selected.scene);
});

test('orbit is elapsed-time based and cleanup cancels its only frame', () => {
  const target = new THREE.Vector3(4,8,10);
  const pole = new THREE.OrthographicCamera(); pole.position.copy(target).add(new THREE.Vector3(0,0,40)); prepareOrbit(pole,target); near(pole.position.distanceTo(target),40); near(pole.position.z-target.z,40/Math.SQRT2); point(pole.up.toArray(),[0,0,1]);
  const cameras = [30,60,144].map(fps => { const camera = new THREE.OrthographicCamera(); camera.position.set(24,8,30); camera.zoom = 2; for(let i=0;i<fps*3;i++) advanceOrbit(camera,target,1/fps); near(camera.position.distanceTo(target),Math.sqrt(800)); near(camera.position.z,30); near(camera.zoom,2); return camera; });
  cameras.forEach(c => assert.ok(c.position.distanceTo(cameras[0].position)<1e-9));
  let callback: FrameRequestCallback = () => {}, canceled = 0, requests = 0, seconds = 0;
  const stop = orbitLoop(dt => { seconds += dt; }, fn => { callback=fn; return ++requests; }, n => { canceled=n; });
  callback(100); callback(600); near(seconds,0.5); stop(); assert.equal(canceled,3); callback(1000); near(seconds,0.5); assert.equal(requests,3);
});

test('Node product replay builds filtered, repeated, nested and mounted exact intermediate geometry without durable writes', { timeout: 60000 }, async t => {
  const store = new SqliteStore(':memory:');
  const authority = new CommandAuthority(store);
  t.after(async () => { await authority.close(); store.close(); });
  await authority.ready();
  const { part, sub, assembly } = await presentationFixture(authority);
  const before = await Promise.all([store.read(part.documentId),store.read(sub.documentId),store.read(assembly.documentId),store.operation({ action:'changes', after:0 })]);
  const base = await store.read(assembly.documentId);
  let key: string | undefined;
  const frame = async (step: number, override: object = {}) => {
    const outcome = await authority.execute(parseCommand({ type:'inspect_model', params: { documentId:assembly.documentId, replay:{ step, expectedRevision:assembly.revision, expectedStorageVersion:base!.version, ...(key?{key}:{}), ...override } } }));
    ok(outcome.result); displayDeliverySchema.parse(outcome); key = outcome.result.replay!.key; return outcome.evaluation!;
  };
  const first = await frame(1);
  assert.equal(first.replay!.steps.length,21);
  assert.deepEqual(first.visibleFeatureIds,['first']);
  near(first.geometry[0].volumeMm3,800); point(first.geometry[0].bounds.min,[0,0,0]);
  assert.ok(first.replay!.steps.every(s => s.path.every(p => p.featureId !== 'unrelated')));
  const cutter = await frame(2); near(cutter.geometry[0].volumeMm3,800+16*Math.PI); assert.equal(cutter.meshes.length,2);
  const cut = await frame(3); near(cut.geometry[0].volumeMm3,800-16*Math.PI); assert.equal(cut.meshes.length,1);
  const moved = await frame(4); point(moved.geometry[0].bounds.min,[3,0,0]); point(moved.geometry[0].bounds.max,[23,10,4]);
  const repeated = await frame(6); assert.deepEqual(repeated.visibleFeatureIds,['first','second']); near(repeated.geometry[1].volumeMm3,800); point(repeated.geometry[1].bounds.min,[30,0,0]);
  const nestedStep = first.replay!.steps.findIndex(s => s.path.map(p=>p.featureId).join('/')==='nested/inner/stock')+1;
  const nested = await frame(nestedStep); const n=nested.geometry.find(g=>g.featureId==='nested')!;
  near(n.volumeMm3,800); point(n.bounds.min,[10,10,10]); point(n.bounds.max,[30,20,14]);
  assert.equal(nested.meshes.find(m=>m.featureId==='nested')!.appearance!.color,'#426d97');
  assert.equal(nested.meshes.find(m=>m.featureId==='nested')!.appearance!.material,'aluminum');
  const mountedStep=first.replay!.steps.findIndex(s=>s.path.map(p=>p.featureId).join('/')==='mounted/stock')+1;
  const mounted = await frame(mountedStep); const m=mounted.geometry.find(g=>g.featureId==='mounted')!;
  const expected=expectedPlacement({name:'replay',source:{origin:[3,0,4],normal:[0,0,1],xDirection:[1,0,0]},target:{origin:[50,-20,8],normal:[0,0,1],xDirection:[0,1,0]},mode:'mate',twistDegrees:90,offset:[3,4,5]});
  point(m.bounds.min,expected.min);point(m.bounds.max,expected.max);near(m.volumeMm3,800);
  assert.equal(mounted.meshes.find(m=>m.featureId==='mounted')!.appearance!.color,'#c47b43');
  const last = await frame(21); const latest = await authority.execute(parseCommand({type:'inspect_model',params:{documentId:assembly.documentId}}));ok(latest.result);
  last.geometry.forEach(g=>{const current=latest.result.geometry!.find(c=>c.featureId===g.featureId)!;near(g.volumeMm3,current.volumeMm3);point(g.bounds.min,current.bounds.min);point(g.bounds.max,current.bounds.max);});
  const after = await Promise.all([store.read(part.documentId),store.read(sub.documentId),store.read(assembly.documentId),store.operation({action:'changes',after:0})]);
  assert.deepEqual(after,before);
  const changed=await authority.execute(parseCommand({type:'apply_edits',params:{documentId:part.documentId,expectedRevision:1,analyze:false,edits:[{op:'update',feature:{...part.features[0],params:{origin:[0,0,0],size:[22,10,4]}}}]}}));ok(changed.result);
  const stale=await authority.execute(parseCommand({type:'inspect_model',params:{documentId:assembly.documentId,replay:{step:2,expectedRevision:1,expectedStorageVersion:base!.version,key}}}));
  assert.equal(stale.result.error?.code,'REPLAY_STALE'); assert.equal(stale.result.replay,undefined);
  key=undefined;near((await frame(1)).geometry[0].volumeMm3,880);
  // A later missing mount does not block an independent early frame. The frame using it still fails.
  ok((await authority.execute(parseCommand({type:'apply_edits',params:{documentId:part.documentId,expectedRevision:2,analyze:false,edits:[{op:'update',feature:{...changed.result.document!.features[0],mounts:[]}}]}}))).result);
  const missing=await authority.execute(parseCommand({type:'inspect_model',params:{documentId:assembly.documentId,replay:{step:1,expectedRevision:1,expectedStorageVersion:base!.version}}}));
  ok(missing.result);
  const brokenFrame=await authority.execute(parseCommand({type:'inspect_model',params:{documentId:assembly.documentId,replay:{step:21,expectedRevision:1,expectedStorageVersion:base!.version}}}));
  assert.match(brokenFrame.result.error?.code ?? '', /^MOUNT_/);
  ok((await authority.execute(parseCommand({type:'document_action',params:{documentId:part.documentId,expectedRevision:3,action:'undo',analyze:false}}))).result);
  key=undefined;near((await frame(1)).geometry[0].volumeMm3,880);
});

test('expanded replay metadata rejects repeated-source blowup at 2000 steps', () => {
  const part: CadDocument={...emptyDocument(),features:Array.from({length:250},(_,i)=>({id:'b'+i,kind:'box',params:{origin:[i,0,0],size:[1,1,1]}}))};
  const root: CadDocument={...emptyDocument(),kind:'assembly',features:Array.from({length:9},(_,i)=>instance('i'+i,part.documentId))};
  assert.throws(()=>replayPlan(root,[part]),(e:any)=>e.code==='REPLAY_LIMIT');
  assert.throws(()=>parseCommand({type:'inspect_model',params:{documentId:root.documentId,replay:{step:2001,expectedRevision:0,expectedStorageVersion:1}}}));
  assert.throws(()=>parseCommand({type:'inspect_model',params:{featureId:'b1',replay:{step:1,expectedRevision:0,expectedStorageVersion:1}}}));
});

test('filtered copied result hides its retained source at completion and root derived placement remains exact', {timeout:60000}, async t=>{
  const store=new SqliteStore(':memory:');const authority=new CommandAuthority(store,{workers:1});t.after(async()=>{await authority.close();store.close();});await authority.ready();
  const {part,assembly,run}=await presentationFixture(authority);
  await run({type:'apply_edits',params:{documentId:part.documentId,expectedRevision:1,analyze:false,edits:[{op:'add',feature:{id:'copy',kind:'transform',params:{target:'finished',translation:[0,20,0],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,scale:1,copy:true}}}]}});
  const doc=(await run({type:'apply_edits',params:{documentId:assembly.documentId,expectedRevision:1,analyze:false,edits:[{op:'add',feature:instance('copied',part.documentId,[0,0,0],'copy')},{op:'add',feature:{id:'root_move',kind:'transform',params:{target:'copied',translation:[0,0,50],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,scale:1,copy:false}}}]}})).document!;
  const record=(await store.read(doc.documentId))!;
  const get=async(step:number)=>{const out=await authority.execute(parseCommand({type:'inspect_model',params:{documentId:doc.documentId,replay:{step,expectedRevision:doc.revision,expectedStorageVersion:record.version}}}));ok(out.result);return out.evaluation!;};
  const plan=(await get(1)).replay!.steps;
  const copyStep=plan.findIndex(s=>s.path.map(p=>p.featureId).join('/')==='copied/copy')+1;
  const copied=await get(copyStep);const info=copied.geometry.find(g=>g.featureId==='copied')!;
  near(info.volumeMm3,800-16*Math.PI);point(info.bounds.min,[3,20,0]);assert.equal(copied.meshes.filter(m=>m.featureId==='copied').length,1);
  const final=await get(plan.length);point(final.geometry.find(g=>g.featureId==='root_move')!.bounds.min,[3,20,50]);assert.ok(!final.visibleFeatureIds.includes('copied'));
});

test('replay postchecks reject source/root races and a terminated projection worker retries without changing durable state', {timeout:60000}, async t=>{
  const store=new SqliteStore(':memory:');const authority=new CommandAuthority(store,{workers:1});t.after(async()=>{await authority.close();store.close();});await authority.ready();
  const {part,assembly}=await presentationFixture(authority);
  const slot=(authority as unknown as {slots:{worker:import('../src/cad/node-worker').NodeGeometryWorker}[]}).slots[0];
  const original=slot.worker.evaluate.bind(slot.worker);
  const replay=()=>authority.execute(parseCommand({type:'inspect_model',params:{documentId:assembly.documentId,replay:{step:1,expectedRevision:1,expectedStorageVersion:2}}}));
  for(const id of [part.documentId,assembly.documentId]) {
    let injected=false;
    const mock=t.mock.method(slot.worker,'evaluate',async(...args:Parameters<typeof original>)=>{
      const result=await original(...args);
      if(args[4]&&!injected){injected=true;const record=(await store.read(id))!;await store.put({...record.document,name:record.document.name+' renamed'},record.version,record.history);}
      return result;
    });
    const outcome=await replay();assert.equal(outcome.result.error?.code,'STORAGE_CONFLICT');assert.equal(outcome.result.replay,undefined);mock.mock.restore();
  }
  const root=(await store.read(assembly.documentId))!;
  const command=parseCommand({type:'inspect_model',params:{documentId:assembly.documentId,replay:{step:1,expectedRevision:1,expectedStorageVersion:root.version}}});
  // Warm the session before injecting an actual 1 ms worker deadline into the projection only.
  ok((await authority.execute(parseCommand({type:'inspect_model',params:{documentId:assembly.documentId}}))).result);
  const before=await Promise.all([store.read(assembly.documentId),store.read(part.documentId),store.operation({action:'changes',after:0})]);
  const mock=t.mock.method(slot.worker,'evaluate',(...args:Parameters<typeof original>)=>{if(args[4]){slot.worker.stop();args[1]=1;}return original(...args);});
  const failure=await authority.execute(command);assert.equal(failure.result.error?.code,'WORKER_TIMEOUT');assert.equal(failure.result.replay,undefined);mock.mock.restore();
  const retry=await authority.execute(command);ok(retry.result);near(retry.evaluation!.geometry[0].volumeMm3,800);
  assert.deepEqual(await Promise.all([store.read(assembly.documentId),store.read(part.documentId),store.operation({action:'changes',after:0})]),before);
});

test('cold early replay and display do not evaluate failing future geometry or final analysis', {timeout:60000}, async t => {
  const store = new SqliteStore(':memory:');
  const authority = new CommandAuthority(store, {workers:1});
  t.after(async()=>{await authority.close();store.close();}); await authority.ready();
  const document: CadDocument = {...emptyDocument(), features:[
    {id:'stock',kind:'box',params:{origin:[0,0,0],size:[10,10,10]}},
    {id:'tool',kind:'box',params:{origin:[0,0,0],size:[10,10,10]}},
    {id:'empty',kind:'subtract',params:{target:'stock',tools:['tool']}},
  ]};
  await store.put(document,null);
  for (const projection of [{replay:{step:1,expectedRevision:0,expectedStorageVersion:1}},
    {display:{step:1,expectedRevision:0,expectedStorageVersion:1}}]) {
    const out = await authority.execute(parseCommand({type:'inspect_model',params:{documentId:document.documentId,...projection}}));
    ok(out.result); near(out.evaluation!.geometry[0].volumeMm3,1000);
    assert.deepEqual(out.evaluation!.visibleFeatureIds,['stock']); assert.equal(out.result.analysis,undefined);
    assert.equal(out.result.health?.analysis,'unchecked');
  }
  assert.equal((await store.read(document.documentId))!.version,1);
});

test('nested construction evaluates only the active exact prefix and retains repeated finished placements', {timeout:60000}, async t=>{
 const store=new SqliteStore(':memory:'),authority=new CommandAuthority(store);t.after(async()=>{await authority.close();store.close();});await authority.ready();
 const source:CadDocument={...emptyDocument(),name:'Progressive source',features:[
  {id:'stock',kind:'box',params:{origin:[0,0,0],size:[10,10,10]}},
  {id:'tool',kind:'box',params:{origin:[0,0,0],size:[10,10,10]}},
  {id:'empty',kind:'subtract',params:{target:'stock',tools:['tool']}}
 ]};
 const root:CadDocument={...emptyDocument(),kind:'assembly',features:[instance('component',source.documentId,[20,0,0])]};
 await store.put(source,null);await store.put(root,null);
 const early=await authority.execute(parseCommand({type:'inspect_model',params:{documentId:root.documentId,snapshot:{},replay:{step:1,expectedRevision:0,expectedStorageVersion:1}}}));
 ok(early.result);near(early.evaluation!.geometry[0].volumeMm3,1000);near(early.evaluation!.geometry[0].bounds.min[0],20);assert.equal(early.evaluation!.stats!.cache.misses,2,'only the first source feature and its placement are built');
 const valid:CadDocument={...emptyDocument(),features:[{id:'one',kind:'box',params:{origin:[0,0,0],size:[10,10,10]}},{id:'two',kind:'box',params:{origin:[20,0,0],size:[5,5,5]}}]};
 const copies:CadDocument={...emptyDocument(),kind:'assembly',features:[instance('first',valid.documentId,[0,0,0]),instance('second',valid.documentId,[50,0,0])]};await store.put(valid,null);await store.put(copies,null);
 const plan=replayPlan(copies,[valid]),secondStart=plan.findIndex(e=>e.step.path.length===2&&e.step.rootStep===2)+1;
 const repeated=await authority.execute(parseCommand({type:'inspect_model',params:{documentId:copies.documentId,snapshot:{},replay:{step:secondStart,expectedRevision:0,expectedStorageVersion:1}}}));ok(repeated.result);
 near(repeated.evaluation!.geometry.find(g=>g.featureId==='first')!.volumeMm3,1125);near(repeated.evaluation!.geometry.find(g=>g.featureId==='second')!.volumeMm3,1000);
});
