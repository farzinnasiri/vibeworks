import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import init from 'replicad-opencascadejs';
import { setOC, importSTEP, type Shape3D } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument, validateDocument } from '../src/cad/document';
import type { CadDocument, PaintRegion } from '../src/shared/protocol';
import {indexedShapes} from '../src/cad/topology';

const oc=await init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});setOC(oc);
const reader=await createRequire(import.meta.url)('occt-import-js')();
const red=(color:number[]|null)=>!!color&&color[0]===1&&color[1]===0&&color[2]===0;
const adaptiveVolume=(shape:Shape3D)=>{const props=new oc.GProp_GProps();try{const error=oc.BRepGProp.VolumePropertiesGK(shape.wrapped,props,1e-12,true,true,false,false,false);assert.ok(Number.isFinite(error)&&error>=0);return props.Mass();}finally{props.delete();}};
test('STEP retains plane-side, UV and combined exact region colours without changing solid volume',async()=>{
 for(const [i,keep]of [
   [{side:{plane:{origin:[10,0,0],normal:[1,0,0]}}}],
   [{iso:{u:[0.25,0.75],v:[0.25,0.75]}}],
   [{side:{plane:{origin:[5,0,0],normal:[1,0,0]}}},{side:{plane:{origin:[15,0,0],normal:[-1,0,0]}}}],
 ].entries()){
  const engine=new GeometryEngine(oc);
  try{
   const doc=validateDocument({...emptyDocument(),features:[{id:'body',kind:'box',params:{origin:[0,0,0],size:[20,30,10]},appearance:{color:'#0000ff'},paintRegions:[{id:'stripe',target:{feature:'body',select:{faces:['+Z'],fragments:'all'},signature:{surface:'PLANE',areaMm2:600,normal:[0,0,1]}},keep:keep as PaintRegion['keep'],look:{color:'#ff0000'}}]}]});
   const before=engine.evaluate(doc),stl=await engine.export('stl',['body'],doc),step=await engine.export('step',['body'],doc);
   assert.equal(step.warnings,undefined,`case ${i}`);
   const read=reader.ReadStepFile(new Uint8Array(step.bytes),{linearUnit:'millimeter'});assert.equal(read.success,true);assert.equal(read.meshes.length,1);
   assert.ok(read.meshes[0].brep_faces.some((face:any)=>red(face.color)),`case ${i}: missing region colour`);
   const imported=await importSTEP(new Blob([step.bytes]));
   try{const info=engine.measure('roundtrip',imported.asShape3D());assert.equal(info.valid,true);assert.equal(info.solidCount,1);assert.ok(Math.abs(info.volumeMm3-before.geometry[0].volumeMm3)<1e-7);assert.ok(info.faceCount!>6);}finally{imported.delete();}
   assert.deepEqual((await engine.export('stl',['body'],doc)).bytes,stl.bytes,'STEP splitting must not mutate committed/native cached geometry');
  }finally{engine.dispose();}
 }
});

test('STEP retains crest paint on symmetric and drifting twisted lofts with checked exact volume',async()=>{
 for(const twisted of[false,true]){
  const engine=new GeometryEngine(oc);
  try{
   const doc=validateDocument({...emptyDocument(),features:[{id:'canopy',kind:'loft',params:{ruled:false,sections:[0,20,40].map((z,i)=>({profile:{type:'ellipse',radiusX:[20,24,18][i],radiusY:[12,15,10][i]},frame:{origin:[twisted?[0,4,-3][i]:0,0,z],normal:[0,0,1],xDirection:[Math.cos(twisted?i*0.2:0),Math.sin(twisted?i*0.2:0),0]}}))},appearance:{material:'steel',color:'#0000ff'}}]});
   const initial=engine.evaluate(doc),face=initial.meshes[0].topology!.faces.find(f=>f.lineage.includes('side.0'))!;
   const exactVolume=adaptiveVolume(engine['shapes'].get('canopy')!);
   const plain=await engine.export('step',['canopy'],doc),plainImport=await importSTEP(new Blob([plain.bytes]));
   try{assert.equal(engine.measure('unpainted roundtrip',plainImport.asShape3D()).valid,true);}finally{plainImport.delete();}
   doc.features[0].paintRegions=[{id:'crest_side',target:{feature:'canopy',select:{faces:['side.0'],fragments:'all'},signature:{surface:face.surface,areaMm2:face.areaMm2,shapeSamples:face.shapeSamples}},keep:[{crest:{axis:[0,0,1],fromMm:0,toMm:40,extreme:[0,1,0],toward:'positive',toleranceMm:0.05}}],look:{color:'#ff0000'}}];
   engine.evaluate(doc);const step=await engine.export('step',['canopy'],doc);
   const read=reader.ReadStepFile(new Uint8Array(step.bytes),{linearUnit:'millimeter'});assert.equal(read.success,true);assert.equal(read.meshes.length,1);assert.ok(read.meshes[0].brep_faces.some((face:any)=>red(face.color)));
   assert.ok(!step.warnings?.some(w=>w.startsWith('REGION_NOT_IN_STEP')));
   if(twisted)assert.ok(step.warnings?.some(w=>w.startsWith('STEP_CREST_BOUNDARY')),'numerical crest boundary carries measured tolerance evidence');
   const imported=await importSTEP(new Blob([step.bytes]));try{
    const check=new oc.BRepCheck_Analyzer(imported.wrapped,true,false,true),topo=new oc.BRepCheck_Analyzer(imported.wrapped,false,false,true),faces=indexedShapes(oc,imported.wrapped,'FACE');
    try{assert.equal(check.IsValid(),true,JSON.stringify({twisted,topologyValid:topo.IsValid(),faces:faces.map((face,i)=>({i,valid:check.IsValid(face)}))}));}finally{check.delete();topo.delete();faces.forEach(f=>f.delete());}
    const info=engine.measure('roundtrip',imported.asShape3D());assert.equal(info.valid,true);assert.equal(info.solidCount,1);assert.ok(Math.abs(adaptiveVolume(imported.asShape3D())-exactVolume)<Math.abs(exactVolume)*1e-9,'adaptive exact-surface integration must agree across face reparameterization');
   }finally{imported.delete();}
  }catch(error){if(error instanceof Error)error.message=`${twisted?'drifting':'symmetric'} crest: ${error.message} ${JSON.stringify((error as {details?:unknown}).details)}`;throw error;}finally{engine.dispose();}
 }
});

test('STEP UV bands on a curved face retain source coordinates through a rotated nested occurrence',async()=>{
 const engine=new GeometryEngine(oc);
 try{
  const source=validateDocument({...emptyDocument(),features:[{id:'barrel',kind:'cylinder',params:{origin:[0,0,0],radius:5,height:20},appearance:{color:'#0000ff'}}]});
  const support=engine.evaluate(source).meshes[0].topology!.faces.find(f=>f.lineage.includes('side'))!;
  source.features[0].paintRegions=[{id:'band',target:{feature:'barrel',select:{faces:['side'],fragments:'all'},signature:{surface:support.surface,areaMm2:support.areaMm2,shapeSamples:support.shapeSamples}},keep:[{iso:{v:[0.25,0.75]}}],look:{color:'#ff0000'}}];
  const placed=(id:string,documentId:string):CadDocument=>validateDocument({...emptyDocument(),kind:'assembly',features:[{id,kind:'instance',params:{document:documentId,translation:[30,10,20],rotationAxis:[0,1,0],origin:[0,0,0],angleDegrees:90}}]});
  const mid=placed('inner',source.documentId),root=placed('outer',mid.documentId);
  const before=engine.evaluate(root,[source,mid]),step=await engine.export('step',['outer'],root);
  const read=reader.ReadStepFile(new Uint8Array(step.bytes),{linearUnit:'millimeter'});assert.equal(read.success,true);assert.equal(read.meshes.length,1);assert.equal(read.meshes[0].brep_faces.filter((face:any)=>red(face.color)).length,1);
  const imported=await importSTEP(new Blob([step.bytes]));try{const info=engine.measure('roundtrip',imported.asShape3D());assert.ok(Math.abs(info.volumeMm3-before.geometry[0].volumeMm3)<1e-7);assert.equal(info.solidCount,1);}finally{imported.delete();}
 }finally{engine.dispose();}
});
