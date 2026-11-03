import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import init from 'replicad-opencascadejs';
import {setOC} from 'replicad';
import {GeometryEngine} from '../src/cad/geometry';
import {emptyDocument,validateDocument} from '../src/cad/document';
import {resolveFaces} from '../src/cad/surface-reference';
import type {Feature} from '../src/shared/protocol';

const box={id:'base',kind:'box',params:{origin:[0,0,0],size:[30,25,20]}};
const frame=(z:number)=>({origin:[0,0,z],normal:[0,0,1],xDirection:[1,0,0]});
const cases:unknown[][]=[
 [box],
 [{id:'base',kind:'cylinder',params:{origin:[0,0,0],radius:5,height:20}}],
 [{id:'base',kind:'rod',params:{from:[3,4,5],to:[12,-3,24],radius:2}}],
 [{id:'base',kind:'extrude',params:{profile:{type:'rectangle',width:20,height:16},plane:'XY',origin:[0,0,0],distance:20}}],
 [{id:'base',kind:'loft',params:{sections:[{profile:{type:'rectangle',width:20,height:16},frame:frame(0)},{profile:{type:'rectangle',width:12,height:8},frame:frame(20)}],ruled:false,correspondence:'authored'}}],
 [{id:'base',kind:'sweep',params:{profile:{type:'circle',radius:2},path:{points:[[0,0,0],[0,0,20]]}}}],
 [{id:'base',kind:'revolve',params:{points:[[4,0],[8,0],[8,10],[4,10]],origin:[0,0,0],angleDegrees:360}}],
 [box,{id:'finished',kind:'drill_holes',params:{target:'base',centers:[[10,10,0],[20,10,0]],diameter:3,axis:'Z'}}],
 [box,{id:'finished',kind:'fillet',params:{target:'base',radius:1,edges:'all'}}],
 [box,{id:'finished',kind:'chamfer',params:{target:'base',distance:1,edges:'all'}}],
 [box,{id:'finished',kind:'shell',params:{target:'base',thickness:1.5,removeFaces:[{point:[15,12.5,20],normal:[0,0,1],expectedCount:1,toleranceMm:0.001}]}}],
];

test('33 native models across three fresh kernels retain named faces and independently resolve captured references',async()=>{
 const expected:string[][]=[];
 for(let fresh=0;fresh<3;fresh++){
  const oc=await init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});setOC(oc);
  const engine=new GeometryEngine(oc);
  try{for(const [i,features]of cases.entries()){
   const doc=validateDocument({...emptyDocument(),features}),evaluation=engine.evaluate(doc),table=evaluation.meshes[0].topology!;
   assert.ok(evaluation.geometry.every(g=>g.valid));
   assert.ok(table.faces.every(face=>face.lineage.length>0),`${i}: ${JSON.stringify(table.faces.map(f=>f.lineage))}`);
   const names=table.faces.map(f=>[f.surface,...f.lineage].join('|')).sort();
   if(!fresh)expected[i]=names;else assert.deepEqual(names,expected[i],`model ${i} in fresh kernel ${fresh}`);
   for(const face of table.faces){
    const selected=resolveFaces(table,{feature:evaluation.visibleFeatureIds[0],select:{faces:face.lineage,fragments:'all'},signature:{surface:face.surface,areaMm2:table.faces.filter(f=>f.lineage.some(n=>face.lineage.includes(n))).reduce((sum,f)=>sum+f.areaMm2,0),normal:face.normal,shapeSamples:face.shapeSamples}});
    assert.ok(selected.includes(table.faces.indexOf(face)));
   }
  }}finally{engine.dispose();}
 }
});

test('drilled wall and endpoint-rod roles survive nearby dimension edits without anonymous face fallback',async()=>{
 const oc=await init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});setOC(oc);const engine=new GeometryEngine(oc);
 try{
  const doc=validateDocument({...emptyDocument(),features:cases[7]}),first=engine.evaluate(doc),wall=first.meshes[0].topology!.faces.find(f=>f.lineage.includes('hole.0.wall'))!;assert.ok(wall);
  const target={feature:'finished',select:{faces:['hole.0.wall'],fragments:'one' as const},signature:{surface:wall.surface,areaMm2:wall.areaMm2,shapeSamples:wall.shapeSamples}};
  for(let edit=1;edit<=20;edit++){
   const changed=structuredClone(doc),hole=changed.features[1] as Extract<Feature,{kind:'drill_holes'}>;hole.params.diameter+=edit*0.001;
   assert.equal(resolveFaces(engine.evaluate(changed).meshes[0].topology!,target).length,1);
  }
  const rod=engine.evaluate(validateDocument({...emptyDocument(),features:cases[2]})).meshes[0].topology!;
  assert.deepEqual(rod.faces.flatMap(f=>f.lineage).sort(),['end','side','start']);
 }finally{engine.dispose();}
});
