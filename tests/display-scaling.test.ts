import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import {setOC} from 'replicad';
import {GeometryEngine} from '../src/cad/geometry';
import {emptyDocument,validateDocument} from '../src/cad/document';
import {displayValueCount,packDisplay,worldMesh} from '../src/shared/display';
import {createWorkbenchScene,disposeScene} from '../src/web/scene';
import {displayDeliverySchema} from '../src/bridge/validation';

test('lazy display meshes only requested root results, shares repeated assets/GPU buffers and preserves exact coarse/fine geometry',async()=>{
 const wasmBinary=await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url));
 const oc=await initOpenCascade({wasmBinary,print:()=>{},printErr:()=>{}});setOC(oc);
 const engine=new GeometryEngine(oc);
 const part=validateDocument({...emptyDocument(),features:[
  {id:'stock',kind:'box',params:{origin:[0,0,0],size:[20,10,4]}},
  {id:'cutter',kind:'cylinder',params:{origin:[10,5,-1],radius:2,height:6}},
  {id:'cut',kind:'subtract',params:{target:'stock',tools:['cutter']}},
 ]});
 const instance=(id:string,x:number)=>({id,kind:'instance',params:{document:part.documentId,translation:[x,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}});
 const root=validateDocument({...emptyDocument(),features:[instance('first',0),instance('second',30)]});
 try{
  const e=engine.evaluate(root,[part]);
  assert.deepEqual(e.meshes.map(m=>m.featureId),['first','second']);
  assert.equal(e.meshes[0].vertices,e.meshes[1].vertices,'instances share local asset arrays');
  assert.ok(displayValueCount(e.meshes)<e.meshes.reduce((n,m)=>n+m.vertices.length+m.normals.length+m.triangles.length+m.lines.length,0));
  const placed=worldMesh(e.meshes[1]);assert.equal(Math.min(...placed.vertices.filter((_,i)=>i%3===0)),30);
  const built=createWorkbenchScene(e,[],[]);assert.equal(built.parts[0].mesh.geometry,built.parts[1].mesh.geometry);built.scene.updateMatrixWorld(true);
  assert.equal(built.parts[1].mesh.position.x,30);disposeScene(built.scene);
  const result={operation:'inspect_model' as const,status:'success' as const,documentId:root.documentId,revision:0,created:[],updated:[],warnings:[]};
  const packed=JSON.parse(JSON.stringify(packDisplay({result,evaluation:e})));
  assert.equal(packed.evaluation.assets.length,1);
  const decoded=displayDeliverySchema.parse(packed).evaluation!;
  assert.equal(decoded.meshes[0].vertices,decoded.meshes[1].vertices);
  assert.deepEqual(worldMesh(decoded.meshes[1]),placed);
  assert.equal(displayDeliverySchema.safeParse({...packed,evaluation:{...packed.evaluation,meshes:[{...packed.evaluation.meshes[0],asset:999}]}}).success,false);
  assert.equal(displayDeliverySchema.safeParse({...packed,evaluation:{...packed.evaluation,meshes:[{...packed.evaluation.meshes[0],transform:[1,2]}]}}).success,false);
  assert.equal(displayDeliverySchema.safeParse({...packed,evaluation:1}).success,false);
  const rotated=validateDocument({...root,features:[{...instance('rotated',30),params:{...instance('rotated',30).params,origin:[1,2,0],angleDegrees:90}}]});
  const nested=validateDocument({...emptyDocument(),features:[{...instance('nested',-15),params:{...instance('nested',-15).params,document:rotated.documentId,rotationAxis:[1,0,0],angleDegrees:35}}]});
  const composed=engine.evaluate(nested,[rotated,part]),world=worldMesh(composed.meshes[0]);
  for(let axis=0;axis<3;axis++){
   const coordinates=world.vertices.filter((_,i)=>i%3===axis);
   assert.ok(Math.abs(Math.min(...coordinates)-composed.geometry[0].bounds.min[axis])<0.05);
   assert.ok(Math.abs(Math.max(...coordinates)-composed.geometry[0].bounds.max[axis])<0.05);
  }
  const history=engine.evaluate(part,[],undefined,{step:1});
  assert.deepEqual(history.visibleFeatureIds,['stock']);assert.deepEqual(history.meshes.map(m=>m.featureId),['stock']);
  const hidden=engine.evaluate(part,[],undefined,{featureIds:['cutter']});
  assert.deepEqual(hidden.visibleFeatureIds,['cut']);assert.deepEqual(hidden.meshes.map(m=>m.featureId),['cut','cutter']);
  const coarse=engine.evaluate(root,[part],undefined,{detail:'coarse'});
  const fine=engine.evaluate(root,[part],undefined,{detail:'fine'});
  assert.deepEqual(coarse.geometry,fine.geometry,'display quality must never change exact metrics');
  assert.ok(coarse.meshes[0].triangles.length<fine.meshes[0].triangles.length);
  assert.equal(coarse.stats!.display!.reduced,true);
  const adaptive=new GeometryEngine(oc,undefined,Math.floor((coarse.stats!.display!.values+fine.stats!.display!.values)/2));
  try{const reduced=adaptive.evaluate(root,[part]);assert.equal(reduced.stats!.display!.reduced,true);assert.deepEqual(reduced.geometry,fine.geometry);}finally{adaptive.dispose();}
  // A consumer cannot mutate the native cache's display asset.
  fine.meshes[0].vertices[0]=999;
  assert.notEqual(engine.evaluate(root,[part]).meshes[0].vertices[0],999);
 }finally{engine.dispose();}
});

test('display-capacity rejection reports measured limits and leaves previous exact shapes exportable',async()=>{
 const wasmBinary=await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url));
 const oc=await initOpenCascade({wasmBinary,print:()=>{},printErr:()=>{}});setOC(oc);
 const engine=new GeometryEngine(oc,undefined,400);
 const doc=validateDocument({...emptyDocument(),features:[{id:'body',kind:'box',params:{origin:[0,0,0],size:[10,10,10]}}]});
 try{
  engine.evaluate(doc);
  const complex=validateDocument({...doc,features:[{id:'curved',kind:'cylinder',params:{origin:[0,0,0],radius:100,height:100}}]});
  assert.throws(()=>engine.evaluate(complex,[],undefined,{detail:'auto'}),error=>error instanceof Error && 'code' in error && error.code==='MODEL_TOO_COMPLEX' && 'details' in error && !!error.details);
  const step=await engine.export('step',['body']);assert.ok(step.bytes.byteLength>1000);
  // An implicit display (a commit) keeps the exact result and reports why it has no meshes.
  const committed=engine.evaluate(complex);
  assert.deepEqual(committed.meshes,[]);assert.match(committed.displayError??'',/display exceeds/);
  assert.equal(committed.geometry[0].featureId,'curved');
  assert.ok((await engine.export('step',['curved'])).bytes.byteLength>1000);
 }finally{engine.dispose();}
});


test('automatic display scales tessellation to model size while explicit fine preserves exact metrics', async () => {
 const wasmBinary=await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url));
 const oc=await initOpenCascade({wasmBinary,print:()=>{},printErr:()=>{}});setOC(oc);
 const engine=new GeometryEngine(oc);
 const doc=validateDocument({...emptyDocument(),features:[{id:'large',kind:'cylinder',params:{origin:[0,0,0],radius:1000,height:4000}}]});
 try {
  const auto=engine.evaluate(doc);
  const fine=engine.evaluate(doc,[],undefined,{detail:'fine'});
  assert.ok(auto.stats!.display!.toleranceMm>fine.stats!.display!.toleranceMm);
  assert.equal(fine.stats!.display!.toleranceMm,0.05);
  assert.ok(auto.meshes[0].triangles.length<fine.meshes[0].triangles.length);
  assert.deepEqual(auto.geometry,fine.geometry);
 } finally {engine.dispose();}
});
