import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import init from 'replicad-opencascadejs';
import {setOC,makeCylinder,Face} from 'replicad';
import {indexedShapes} from '../src/cad/topology';
import {curvatureDifference} from '../src/cad/curvature';
import {GeometryEngine} from '../src/cad/geometry';
import {emptyDocument,validateDocument} from '../src/cad/document';
import type {Frame,Profile} from '../src/shared/protocol';
const oc=await init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});setOC(oc);
function evaluate(features:unknown[]){const engine=new GeometryEngine(oc);try{const result=engine.evaluate(validateDocument({...emptyDocument(),features}));return result;}finally{engine.dispose();}}
const frame=(z:number,angle=0):Frame=>({origin:[0,0,z],normal:[0,0,1],xDirection:[Math.cos(angle),Math.sin(angle),0]});
const rectangle:Profile={type:'rectangle',width:20,height:10};
test('curvature measurement matches analytic cylinders and a plane in inverse millimeters',()=>{
 const a=makeCylinder(10,20),b=makeCylinder(20,20),owned:Face[]=[];
 const face=(shape:typeof a,kind:string)=>{const raw=indexedShapes(oc,shape.wrapped,'FACE');try{for(const r of raw){const f=new Face(oc.TopoDS.Face(r));if(f.geomType===kind){owned.push(f);return f;}f.delete();}throw Error('Missing analytic face');}finally{raw.forEach(r=>r.delete());}};
 try{
  const first=face(a,'CYLINDRE'),second=face(b,'CYLINDRE'),plane=face(a,'PLANE');
  assert.ok(curvatureDifference(oc,first,first,[10,0,10])<1e-12);
  assert.ok(Math.abs(curvatureDifference(oc,first,second,[10,0,10])-0.05)<1e-10);
  assert.ok(Math.abs(curvatureDifference(oc,first,plane,[10,0,20])-0.1)<1e-10);
 }finally{owned.forEach(f=>f.delete());a.delete();b.delete();}
});
test('D1 eight authored loft configurations and atomic compatibility diagnostics',()=>{
 const cases=[
  [rectangle,rectangle,0,0,[]],
  [rectangle,rectangle,0.25,0.25,[]],
  [rectangle,rectangle,0,0,[0.1]],
  [{type:'circle',radius:10},{type:'circle',radius:8},0.15,0.25,[]],
  [{type:'ellipse',radiusX:10,radiusY:5},{type:'circle',radius:8},0,0,[]],
  [{type:'polygon',points:[[-10,-5],[10,-5],[10,5],[-10,5]],segmentIds:['a','b','c','d']},rectangle,0,0,[]],
  [rectangle,{type:'rectangle',width:12,height:7},0,0,[]],
  [{type:'circle',radius:10},{type:'ellipse',radiusX:7,radiusY:5},0,0,[0.25,0.5,0.75]],
 ] as const;
 for(const [i,c] of cases.entries()){
  const [a,b,seamA,seamB,splitAt]=c;
  const result=evaluate([{id:'loft',kind:'loft',params:{sections:[{profile:a,frame:frame(0),seam:seamA,splitAt},{profile:b,frame:frame(30,i===6?0.4:0),seam:seamB,splitAt}],ruled:false,correspondence:'authored'}}]);assert.ok(result.geometry[0].valid,`case ${i}`);
 }
 assert.throws(()=>evaluate([{id:'bad',kind:'loft',params:{sections:[{profile:rectangle,frame:frame(0)},{profile:{type:'circle',radius:5},frame:frame(20)}],ruled:false,correspondence:'authored'}}]),{code:'LOFT_CORRESPONDENCE'});
});
test('D4 six variable blends; explicit edge refs and unchanged legacy law',()=>{
 for(let i=0;i<6;i++){
  const base={id:'base',kind:'box',params:{origin:[0,0,0],size:[20+i,30,10]},appearance:{material:'steel',color:'#356abc'}};
  const e=evaluate([base]),edge=e.meshes[0].topology!.edges.find(e=>Math.abs(e.lengthMm-10)<1e-5)!;
  const result=evaluate([base,{id:'blend',kind:'fillet',params:{target:'base',radius:{stations:[[0,0.5+i/10],[0.4,1.1+i/10],[1,0.8+i/10]]},edges:{refs:[{feature:'base',name:edge.lineage[0],signature:{center:edge.center,lengthMm:edge.lengthMm}}]}}}]);
  assert.ok(result.geometry.at(-1)!.volumeMm3<e.geometry[0].volumeMm3);assert.equal(result.meshes[0].appearance?.color,'#356abc');
 }
});
test('D3 guided and multi-section exact sweeps',()=>{
 const profile={type:'circle',radius:1};
 const cases=[
  {profile,path:{points:[[0,0,0],[0,0,40]]},guide:{path:{points:[[8,0,0],[8,0,40]]},curvilinear:true,contact:'none'}},
  {profile,path:{points:[[0,0,0],[0,0,40]]},sections:[{at:0,profile},{at:1,profile:{type:'circle',radius:2}}]},
  {profile,path:{points:[[0,0,0],[5,0,20],[15,0,40]]},sections:[{at:0,profile:{type:'rectangle',width:2,height:1}},{at:1,profile:{type:'rectangle',width:3,height:1.5},rotationDegrees:20}]},
  {profile,path:{points:[[0,0,0],[5,0,20],[15,0,40]]},guide:{path:{points:[[0,8,0],[5,8,20],[15,8,40]]},curvilinear:true,contact:'none'}},
 ];
 for(const params of cases){const result=evaluate([{id:'sweep',kind:'sweep',params}]);assert.ok(result.geometry[0].valid);}
 assert.throws(()=>evaluate([{id:'conflict',kind:'sweep',params:{profile,path:{points:[[0,0,0],[0,0,40]]},guide:{path:{points:[[0,0,0],[0,0,40]]},curvilinear:true,contact:'none'}}}]),{code:'SWEEP_GUIDE_CONFLICT'});
});
test('D2 exact G0 sheet and cap replacement with no free edges',()=>{
 const base={id:'base',kind:'box',params:{origin:[0,0,0],size:[20,20,10]}};
 const original=evaluate([base]),table=original.meshes[0].topology!,faceIndex=table.faces.findIndex(f=>f.lineage.includes('+Z')),face=table.faces[faceIndex];
 const boundary=table.edges.filter(e=>e.faces.includes(faceIndex));
 // Order edges geometrically, preserving actual native directions where possible.
 const order=[boundary.find(e=>e.center[1]===0)!,boundary.find(e=>e.center[0]===20)!,boundary.find(e=>e.center[1]===20)!,boundary.find(e=>e.center[0]===0)!];
 const sheet={id:'cap',kind:'fill',params:{boundary:order.map(e=>({edge:{feature:'base',name:e.lineage[0],signature:{center:e.center,lengthMm:e.lengthMm}},continuity:'G0'})),tolerances:{g0Mm:0.01,g1Deg:0.5}}};
 const filled=evaluate([base,sheet]);assert.equal(filled.geometry.at(-1)!.resultKind,'sheet');assert.equal(filled.geometry.at(-1)!.solidCount,0);assert.equal(filled.geometry.at(-1)!.volumeMm3,0);
 const joined=evaluate([base,sheet,{id:'joined',kind:'join',params:{target:'base',replaceFaces:{feature:'base',select:{faces:['+Z'],fragments:'one'},signature:{surface:face.surface,areaMm2:face.areaMm2,normal:face.normal}},surfaces:['cap'],toleranceMm:0.001}}]);
 assert.ok(Math.abs(joined.geometry.at(-1)!.volumeMm3-4000)<1e-4);
 assert.ok(joined.meshes[0].topology!.faces.every(f=>f.lineage.length),'sewn target faces and the replacement sheet retain native identity');
});

test('D2 measured supported G1 cap, G0 domed canopy and rejected conditions',()=>{
 const base={id:'base',kind:'cylinder',params:{origin:[0,0,0],radius:12,height:20}};
 const e=evaluate([base]),t=e.meshes[0].topology!,face=t.faces.find(f=>f.lineage.includes('top'))!,faceIndex=t.faces.indexOf(face),edge=t.edges.find(e=>e.faces.includes(faceIndex))!;
 const ref={feature:'base',select:{faces:['top'],fragments:'one'},signature:{surface:face.surface,areaMm2:face.areaMm2,normal:face.normal}};
 const constraint={edge:{feature:'base',name:edge.lineage[0],signature:{center:edge.center,lengthMm:edge.lengthMm}},continuity:'G1',support:ref};
 const g1=evaluate([base,{id:'cap',kind:'fill',params:{boundary:[constraint],tolerances:{g0Mm:0.01,g1Deg:0.5}}}]);assert.ok(g1.geometry.at(-1)!.diagnostics);
 const dome={id:'cap',kind:'fill',params:{boundary:[{...constraint,continuity:'G0',support:undefined}],points:[[0,0,23]],tolerances:{g0Mm:0.01,g1Deg:0.5}}};
 const shaped=evaluate([base,dome]);assert.ok(shaped.geometry.at(-1)!.bounds.max[2]>22.9);
 const joined=evaluate([base,dome,{id:'joined',kind:'join',params:{target:'base',replaceFaces:ref,surfaces:['cap'],toleranceMm:0.01}}]);assert.ok(joined.geometry.at(-1)!.volumeMm3>e.geometry[0].volumeMm3);
 const g2=evaluate([base,{id:'curvature_cap',kind:'fill',params:{boundary:[{...constraint,continuity:'G2'}],tolerances:{g0Mm:0.01,g1Deg:0.5,g2:0.01}}}]);
 const residuals=g2.geometry.at(-1)!.diagnostics!.residuals as {g2SampledPerMm:number;g1SampledDeg:number}[];
 assert.ok(residuals.every(r=>r.g2SampledPerMm<=0.01&&r.g1SampledDeg<=0.5));
 assert.throws(()=>evaluate([base,{id:'bad',kind:'fill',params:{boundary:[{...constraint,continuity:'G2'}],tolerances:{g0Mm:0.01,g1Deg:0.5}}}]),{code:'CONTINUITY_TOLERANCE'});
});
test('D2 four supported boundary/support configurations with measured continuity and honest rejection',()=>{
 const outcomes=[];
 for(const [i,profile] of [{type:'circle',radius:10},{type:'ellipse',radiusX:12,radiusY:8},{type:'rectangle',width:20,height:16},{type:'polygon',points:[[-10,-5],[6,-8],[12,4],[-5,9]]}].entries()){
  const base={id:'base',kind:'extrude',params:{profile,plane:'XY',origin:[0,0,0],distance:20}};
  const initial=evaluate([base]),t=initial.meshes[0].topology!,index=t.faces.findIndex(f=>f.lineage.includes('cap.end')),face=t.faces[index];let edges=t.edges.filter(e=>e.faces.includes(index));
  const ordered=edges.splice(0,1);let end=ordered[0].endpoints![1];while(edges.length){const idx=edges.findIndex(e=>e.endpoints!.some(p=>Math.hypot(...p.map((v,k)=>v-end[k]))<1e-6));assert.ok(idx>=0);const e=edges.splice(idx,1)[0];const same=Math.hypot(...e.endpoints![0].map((v,k)=>v-end[k]))<1e-6;end=e.endpoints![same?1:0];ordered.push(e);}
  const support={feature:'base',select:{faces:['cap.end'],fragments:'one'},signature:{surface:face.surface,areaMm2:face.areaMm2,normal:face.normal}};
  const cap={id:'cap',kind:'fill',params:{boundary:ordered.map(edge=>({edge:{feature:'base',name:edge.lineage[0],signature:{center:edge.center,lengthMm:edge.lengthMm}},continuity:'G1',support})),points:[[0,0,23]],tolerances:{g0Mm:0.01,g1Deg:0.5}}};
  try{const filled=evaluate([base,cap]);outcomes.push({case:i,status:'success',diagnostics:filled.geometry.at(-1)!.diagnostics});const joined=evaluate([base,cap,{id:'joined',kind:'join',params:{target:'base',replaceFaces:support,surfaces:['cap'],toleranceMm:0.01}}]);assert.ok(joined.geometry.at(-1)!.volumeMm3>initial.geometry[0].volumeMm3);}catch(error){assert.ok(['CONTINUITY_NOT_MET','JOIN_NOT_SOLID','JOIN_FREE_EDGES','FILL_INVALID_SHEET'].includes((error as any).code),String(error));outcomes.push({case:i,status:'measured rejection',code:(error as any).code,details:(error as any).details});}
 }
 assert.equal(outcomes.length,4);
 assert.ok(outcomes.filter(o=>o.status==='success').length>=3,JSON.stringify(outcomes.map(({case:i,status,code})=>({case:i,status,code}))));
});

test('D4 distinct curved and multiple-edge variable-law models; painted nearby blend references',()=>{
 const profiles=[
  [{id:'base',kind:'cylinder',params:{origin:[0,0,0],radius:15,height:20}}],
  [{id:'base',kind:'extrude',params:{profile:{type:'ellipse',radiusX:18,radiusY:12},plane:'XY',origin:[0,0,0],distance:20}}],
  [{id:'base',kind:'box',params:{origin:[0,0,0],size:[30,25,15]}}],
 ];
 for(const [i,features] of profiles.entries()){
  const base=evaluate(features),edges=i===2?'vertical':{on:{axis:'Z',value:20}};
  const output=evaluate([...features,{id:'blend',kind:'fillet',params:{target:'base',radius:{stations:[[0,1],[0.5,1.5],[1,1]]},edges}}]);assert.ok(output.geometry.at(-1)!.valid);assert.ok(output.geometry.at(-1)!.volumeMm3<base.geometry[0].volumeMm3);
 }
 const base={id:'base',kind:'box',params:{origin:[0,0,0],size:[30,25,15]},appearance:{material:'steel',color:'#204060'}};
 const original=evaluate([base]),top=original.meshes[0].topology!.faces.find(f=>f.lineage.includes('+Z'))!;
 const target={feature:'base',select:{faces:['+Z'],fragments:'one'},signature:{surface:top.surface,areaMm2:top.areaMm2,normal:top.normal}};
 const painted={...base,surfaceStyles:[{target,look:{color:'#db3300'}}],paintRegions:[{id:'stripe',target,keep:[{side:{plane:{origin:[15,0,0],normal:[1,0,0]}}}],look:{color:'#00aa77'}}]};
 for(const r of [1,1.05]){const output=evaluate([painted,{id:'blend',kind:'fillet',params:{target:'base',radius:{stations:[[0,r],[0.5,r+0.5],[1,r]]},edges:'vertical'}}]);assert.ok(output.meshes.some(m=>m.appearance?.color==='#00aa77'));assert.ok(output.meshes.some(m=>m.topology?.faces.some(f=>f.lineage.includes('in0:+Z'))));}
});
test('D1 explicit mapping/reversal, three-section sweep stations and join continuity gates',()=>{
 const profile={type:'polygon',points:[[-10,-5],[10,-5],[10,5],[-10,5]],segmentIds:['a','b','c','d']};
 const result=evaluate([{id:'mapped',kind:'loft',params:{sections:[{profile,frame:frame(0),reverse:true,mapping:['d','c','b','a']},{profile,frame:frame(25),reverse:true,mapping:['d','c','b','a']}],ruled:false,correspondence:'authored',smoothing:true,continuity:'C2',maxDegree:8}}]);assert.ok(result.geometry[0].valid);
 const circle={type:'circle',radius:1};const swept=evaluate([{id:'steam',kind:'sweep',params:{profile:circle,path:{points:[[0,0,0],[5,0,20],[15,0,40]]},sections:[{at:0,profile:circle},{at:0.5,profile:{type:'circle',radius:1.5}},{at:1,profile:{type:'circle',radius:2}}]}}]);assert.ok(swept.geometry[0].valid);
 const base={id:'base',kind:'cylinder',params:{origin:[0,0,0],radius:12,height:20}},initial=evaluate([base]),t=initial.meshes[0].topology!,index=t.faces.findIndex(f=>f.lineage.includes('top')),f=t.faces[index],edge=t.edges.find(e=>e.faces.includes(index))!;
 const support={feature:'base',select:{faces:['top'],fragments:'one'},signature:{surface:f.surface,areaMm2:f.areaMm2,normal:f.normal}};
 const sheet={id:'cap',kind:'fill',params:{boundary:[{edge:{feature:'base',name:edge.lineage[0],signature:{center:edge.center,lengthMm:edge.lengthMm}},continuity:'G0'}],tolerances:{g0Mm:0.01,g1Deg:0.5}}};
 assert.throws(()=>evaluate([base,sheet,{id:'joined',kind:'join',params:{target:'base',replaceFaces:support,surfaces:['cap'],toleranceMm:0.001,continuity:{maxAngleDeg:0.5}}}]),{code:'CONTINUITY_NOT_MET'});
});
test('D2 filling cannot close a through-hole by loose sewing',()=>{
 const features=[{id:'outer',kind:'cylinder',params:{origin:[0,0,0],radius:15,height:20}},{id:'bore',kind:'cylinder',params:{origin:[0,0,-1],radius:4,height:22}},{id:'base',kind:'subtract',params:{target:'outer',tools:['bore']}}];
 const initial=evaluate(features),t=initial.meshes[0].topology!,index=t.faces.findIndex(f=>f.normal?.[2]===1),f=t.faces[index],edge=t.edges.filter(e=>e.faces.includes(index)).sort((a,b)=>b.lengthMm-a.lengthMm)[0];
 const support={feature:'base',select:{faces:[f.lineage[0]],fragments:'one'},signature:{surface:f.surface,areaMm2:f.areaMm2,normal:f.normal}};
 const sheet={id:'cap',kind:'fill',params:{boundary:[{edge:{feature:'base',name:edge.lineage[0],signature:{center:edge.center,lengthMm:edge.lengthMm}},continuity:'G0'}],tolerances:{g0Mm:0.01,g1Deg:0.5}}};
 assert.throws(()=>evaluate([...features,sheet,{id:'joined',kind:'join',params:{target:'base',replaceFaces:support,surfaces:['cap'],toleranceMm:0.01}}]),{code:'JOIN_FREE_EDGES'});
});
test('D cache isolates mutable diagnostics and operation settings; native law has independently observable effect',()=>{
 const engine=new GeometryEngine(oc);
 try{
  const loft=validateDocument({...emptyDocument(),features:[{id:'loft',kind:'loft',params:{sections:[{profile:rectangle,frame:frame(0)},{profile:rectangle,frame:frame(30)}],ruled:false,correspondence:'authored'}}]});
  const first=engine.evaluate(loft);(first.geometry[0].diagnostics!.sections as any[])[0].seam=0.75;const second=engine.evaluate(loft);assert.equal((second.geometry[0].diagnostics!.sections as any[])[0].seam,0);assert.equal(second.stats!.cache.misses,0);
  const changed=validateDocument({...loft,features:[{...loft.features[0],params:{...loft.features[0].params,continuity:'C2',maxDegree:9}}]});assert.equal(engine.evaluate(changed).stats!.cache.misses,1);
  const base={id:'base',kind:'box',params:{origin:[0,0,0],size:[30,25,15]}};
  const run=(radius:unknown)=>engine.evaluate(validateDocument({...emptyDocument(),features:[base,{id:'blend',kind:'fillet',params:{target:'base',radius,edges:{near:[[0,0,7.5]],toleranceMm:0.001}}}]})).geometry.at(-1)!.volumeMm3;
  const constant=run(1),constantLaw=run({stations:[[0,1],[0.5,1],[1,1]]});assert.ok(Math.abs(constant-constantLaw)<1e-8);assert.ok(Math.abs(constant-(30*25-(1-Math.PI/4))*15)<1e-7);
  const a=run({stations:[[0,1],[0.5,1.5],[1,1]]}),b=run({stations:[[0,1],[0.5,2.5],[1,1]]});assert.ok(Math.abs(a-b)>0.1);assert.ok(a<constant&&b<a);
 }finally{engine.dispose();}
});
