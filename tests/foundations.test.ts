import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument, validateDocument } from '../src/cad/document';
import { applyEdits } from '../src/cad/edits';
import { displayDeliverySchema } from '../src/bridge/validation';
import { packDisplay } from '../src/shared/display';
import { resolveLook } from '../src/shared/appearance-resolver';
import { commandSchemas } from '../src/shared/protocol';

const feature = { id:'block', kind:'box' as const, params:{origin:[0,0,0],size:[20,30,10]}, appearance:{material:'steel',color:'#123456',graphics:[]} };
const fixture = () => validateDocument({...emptyDocument(),features:[feature]});
test('appearance patches preserve unspecified fields; reset inherits; keyed operations validate modes', () => {
  const source = fixture();
  const patch = commandSchemas.apply_edits.parse({ documentId:source.documentId, expectedRevision:0, edits:[{op:'patch',id:'block',appearance:{color:'#abcdef'}}] });
  const next = applyEdits(source,patch.edits).document;
  assert.deepEqual(next.features[0].appearance,{material:'steel',color:'#abcdef',graphics:[]});
  const cleared = applyEdits(next,[{op:'appearance',target:{feature:'block',select:{all:true}},unset:['color']}]).document;
  assert.deepEqual(cleared.features[0].appearance,{material:'steel',graphics:[]});
  assert.throws(()=>applyEdits(source,[{op:'appearance',target:{feature:'block',select:{all:true}},replace:null,set:{color:'#ffffff'}}]),{code:'APPEARANCE_MODE_CONFLICT'});
  assert.throws(()=>applyEdits(source,[{op:'appearance',target:{feature:'block',select:{all:true}},graphics:{remove:['absent']}}]),{code:'GRAPHIC_NOT_FOUND'});
  assert.deepEqual(source,fixtureWithId(source.documentId));
});
function fixtureWithId(id:string){return {...fixture(),documentId:id};}
test('visual material changes look without changing physical material; authored roughness and coat win',()=>{
  const look=resolveLook({material:'steel',visualMaterial:'rubber',roughness:0.17,coat:'clear'});
  assert.equal(look.roughness,0.17);assert.equal(look.clearcoat,1);assert.equal(look.metalness,0);
});
test('face and edge ranges survive packing, identify nested source, reject corrupt indices; 20 nearby box edits',async()=>{
  const oc=await init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});setOC(oc);
  const engine=new GeometryEngine(oc),doc=fixture();
  try{
    let names:string[]|undefined;
    for(let n=0;n<20;n++){
      const changed=validateDocument({...doc,features:[{...feature,params:{...feature.params,size:[20+n/10,30+n/20,10+n/30]}}]});
      const e=engine.evaluate(changed),mesh=e.meshes[0];
      const current=mesh.topology!.faces.flatMap(f=>f.lineage).sort();
      if(names)assert.deepEqual(current,names);else names=current;
      assert.equal(current.length,6);
      assert.equal(mesh.faceRanges!.filter((_,i)=>i%4===1).reduce((a,b)=>a+b,0),mesh.triangles.length/3);
      const result={operation:'inspect_model' as const,status:'success' as const,documentId:doc.documentId,revision:0,created:[],updated:[],warnings:[]};
      const delivery=displayDeliverySchema.parse(JSON.parse(JSON.stringify(packDisplay({result,evaluation:e}))));
      assert.deepEqual(delivery.evaluation!.meshes[0].topology,mesh.topology);
      const bad=structuredClone(e);bad.meshes[0].faceRanges![2]=999;
      assert.equal(displayDeliverySchema.safeParse({result,evaluation:bad}).success,false);
    }
    const placement={translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]};
    const mid=validateDocument({...emptyDocument(),features:[{id:'inner',kind:'instance',params:{...placement,document:doc.documentId}}]});
    const outer=validateDocument({...emptyDocument(),features:[{id:'outer',kind:'instance',params:{...placement,document:mid.documentId}}]});
    const mesh=engine.evaluate(outer,[mid,doc]).meshes[0];
    assert.deepEqual(mesh.occurrencePath,['outer','inner','block']);assert.deepEqual(mesh.source,{documentId:doc.documentId,revision:0,featureId:'block'});
  }finally{engine.dispose();}
});

test('face paint preserves physical mass, creates distinct packed styles, survives nearby edits and fails changed signatures with candidates',async()=>{
 const oc=await init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});setOC(oc);
 const engine=new GeometryEngine(oc),source=fixture();
 try{
  const before=engine.evaluate(source),face=before.meshes[0].topology!.faces.find(f=>f.lineage.includes('+Z'))!;
  const edit={op:'appearance' as const,target:{feature:'block',select:{faces:['+Z'],fragments:'all' as const},signature:{surface:face.surface,areaMm2:face.areaMm2,normal:face.normal}},set:{color:'#ee2200',visualMaterial:'rubber' as const}};
  const painted=applyEdits(source,[edit]).document,after=engine.evaluate(painted);
  assert.equal(painted.schemaVersion,2);assert.equal(after.geometry[0].volumeMm3,before.geometry[0].volumeMm3);assert.equal(after.geometry[0].massG,before.geometry[0].massG);assert.equal(after.meshes.length,2);assert.ok(after.meshes.some(m=>m.appearance?.color==='#ee2200'));assert.ok(after.meshes.some(m=>m.appearance?.color==='#123456'));
  const result={operation:'inspect_model' as const,status:'success' as const,documentId:source.documentId,revision:0,created:[],updated:[],warnings:[]};const packed=packDisplay({result,evaluation:after});const decoded=displayDeliverySchema.parse(packed).evaluation!;assert.equal(decoded.meshes.length,2);assert.notDeepEqual(decoded.meshes[0].triangles,decoded.meshes[1].triangles);
  const nearby=applyEdits(painted,[{op:'patch',id:'block',params:{size:[21,30,10]}}]).document;assert.ok(engine.evaluate(nearby).meshes.some(m=>m.appearance?.color==='#ee2200'));
  const drastic=applyEdits(painted,[{op:'patch',id:'block',params:{size:[200,30,10]}}]).document;
  assert.throws(()=>engine.evaluate(drastic),(error:any)=>error.code==='REFERENCE_CHANGED'&&error.details.candidates.length>0);
  assert.throws(()=>applyEdits(source,[{...edit,set:{material:'steel'}}]),{code:'APPEARANCE_FIELD_NOT_ALLOWED'});
 }finally{engine.dispose();}
});

test('topology output coordinates admit origin plus dimensions beyond input-coordinate bounds',async()=>{
 const oc=await init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});setOC(oc);
 const engine=new GeometryEngine(oc),document=validateDocument({...emptyDocument(),features:[{id:'far',kind:'box',params:{origin:[100000,100000,100000],size:[10000,10000,10000]}}]});
 try{const evaluation=engine.evaluate(document),result={operation:'inspect_model' as const,status:'success' as const,documentId:document.documentId,revision:0,created:[],updated:[],warnings:[]};assert.ok(evaluation.meshes[0].topology!.faces.some(f=>f.center[0]>100000));assert.ok(displayDeliverySchema.safeParse(packDisplay({result,evaluation})).success);}finally{engine.dispose();}
});
