import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import init from 'replicad-opencascadejs';
import {setOC} from 'replicad';
import {GeometryEngine} from '../src/cad/geometry';
import {emptyDocument,validateDocument} from '../src/cad/document';
const frame=(z:number)=>({origin:[0,0,z],normal:[0,0,1],xDirection:[1,0,0]});
export const canopy=()=>validateDocument({...emptyDocument(),features:[{id:'canopy',kind:'loft',params:{ruled:false,sections:[{profile:{type:'ellipse',radiusX:20,radiusY:12},frame:frame(0)},{profile:{type:'ellipse',radiusX:24,radiusY:15},frame:frame(20)},{profile:{type:'ellipse',radiusX:18,radiusY:10},frame:frame(40)}]},appearance:{material:'steel',color:'#345678'}}]});
async function kernel(){const oc=await init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});setOC(oc);return oc;}
test('native histories name curved loft, prism, sweep, revolve and nearby boolean and fillet outputs',async()=>{
 const engine=new GeometryEngine(await kernel());
 try{
  for(const feature of [canopy().features[0],{id:'prism',kind:'extrude',params:{profile:{type:'rectangle',width:20,height:30},plane:'XY',origin:[0,0,0],distance:10}},{id:'turned',kind:'revolve',params:{points:[[5,0],[10,0],[10,20],[5,20]],origin:[0,0,0],angleDegrees:360}},{id:'pipe',kind:'sweep',params:{profile:{type:'circle',radius:2},path:{points:[[0,0,0],[0,0,10],[5,0,20]]}}}]){
   const doc=validateDocument({...emptyDocument(),features:[feature]}),e=engine.evaluate(doc);
   assert.ok(e.meshes[0].topology!.faces.filter(f=>f.lineage.length).length>=Math.min(3,e.meshes[0].topology!.faces.length),`${feature.kind}: ${JSON.stringify(e.meshes[0].topology!.faces.map(f=>f.lineage))}`);
  }
  const box={id:'box',kind:'box',params:{origin:[0,0,0],size:[30,30,10]}};
  const cutter={id:'cut',kind:'box',params:{origin:[12,-1,-1],size:[6,32,12]}};
  const doc=validateDocument({...emptyDocument(),features:[box,cutter,{id:'split',kind:'subtract',params:{target:'box',tools:['cut']}}]});
  const faces=engine.evaluate(doc).meshes[0].topology!.faces;
  assert.ok(faces.filter(f=>f.lineage.includes('in0:+Z')).length===2,JSON.stringify(faces));
  const rounded=validateDocument({...emptyDocument(),features:[box,{id:'round',kind:'fillet',params:{target:'box',radius:1,edges:'all'}}]});
  assert.ok(engine.evaluate(rounded).meshes[0].topology!.faces.some(f=>f.lineage.some(n=>n.startsWith('blend('))));
 }finally{engine.dispose();}
});

test('one smooth loft face supports bounded crest paint without changing exact mass or solid',async()=>{
 const engine=new GeometryEngine(await kernel()),doc=canopy();
 try {
  const before=engine.evaluate(doc),face=before.meshes[0].topology!.faces.find(f=>f.lineage.includes('side.0'))!;
  assert.ok(face);
  const target={feature:'canopy',select:{faces:['side.0'],fragments:'all'},signature:{surface:face.surface,areaMm2:face.areaMm2,shapeSamples:face.shapeSamples}};
  const painted=validateDocument({...doc,schemaVersion:2,features:[{...doc.features[0],paintRegions:[{id:'left',target,keep:[{crest:{axis:[0,0,1],fromMm:0,toMm:40,extreme:[0,1,0],toward:'positive',toleranceMm:0.05}}],look:{color:'#ee2200'}}]}]});
  const after=engine.evaluate(painted);
  assert.equal(after.geometry[0].volumeMm3,before.geometry[0].volumeMm3);assert.equal(after.geometry[0].massG,before.geometry[0].massG);
  assert.ok(after.meshes.some(m=>m.appearance?.color==='#ee2200'));assert.ok(after.meshes.some(m=>m.appearance?.color==='#345678'));
  const graphicBounds={min:[0,1,2].map(axis=>Math.min(...before.meshes[0].vertices.filter((_,i)=>i%3===axis))),max:[0,1,2].map(axis=>Math.max(...before.meshes[0].vertices.filter((_,i)=>i%3===axis)))};
  assert.ok(after.meshes.every(m=>JSON.stringify(m.graphicBounds)===JSON.stringify(graphicBounds)),'regions retain one source graphic frame');
  const {packDisplay}=await import('../src/shared/display'),{displayDeliverySchema}=await import('../src/bridge/validation');
  const decoded=displayDeliverySchema.parse(packDisplay({result:{operation:'inspect_model',status:'success',documentId:doc.documentId,revision:0,created:[],updated:[],warnings:[]},evaluation:after}));
  assert.ok(decoded.evaluation!.meshes.every(m=>JSON.stringify(m.graphicBounds)===JSON.stringify(graphicBounds)),'the Node-to-browser and prepared-cache wire preserves the shared frame');
  assert.ok(after.meshes.every(m=>m.faceRanges!.every((v,i)=>i%4!==2||v<before.meshes[0].topology!.faces.length)));
 }finally{engine.dispose();}
});

test('three fresh kernels retain curved lineage and reject a drastic unique-support reshape',async()=>{
 for(let worker=0;worker<3;worker++){
  const engine=new GeometryEngine(await kernel()),doc=canopy();
  try{
   const before=engine.evaluate(doc),face=before.meshes[0].topology!.faces.find(f=>f.lineage.includes('side.0'))!;
   const {resolveFaces}=await import('../src/cad/surface-reference');
   const target={feature:'canopy',select:{faces:['side.0'],fragments:'one' as const},signature:{surface:face.surface,areaMm2:face.areaMm2,shapeSamples:face.shapeSamples}};
   for(let i=0;i<20;i++){
    const next=structuredClone(doc);if(next.features[0].kind!=='loft')throw Error();const p=next.features[0].params.sections[1].profile;if(p.type!=='ellipse')throw Error();p.radiusX+=i*0.02;
    const table=engine.evaluate(next).meshes[0].topology!;assert.equal(resolveFaces(table,target).length,1);
   }
   const changed=structuredClone(doc);if(changed.features[0].kind!=='loft')throw Error();const p=changed.features[0].params.sections[1].profile;if(p.type!=='ellipse')throw Error();p.radiusX=40;p.radiusY=10;
   assert.throws(()=>resolveFaces(engine.evaluate(changed).meshes[0].topology!,target),{code:'REFERENCE_CHANGED'});
  }finally{engine.dispose();}
 }
});

test('Boolean split ambiguity and deleted-face repair require explicit candidate selection',async()=>{
 const engine=new GeometryEngine(await kernel());try{
 const {resolveFaces}=await import('../src/cad/surface-reference');
 const doc=validateDocument({...emptyDocument(),features:[{id:'base',kind:'box',params:{origin:[0,0,0],size:[30,30,10]}},{id:'tool',kind:'box',params:{origin:[12,-1,-1],size:[6,32,12]}},{id:'cut',kind:'subtract',params:{target:'base',tools:['tool']}}]});
 const table=engine.evaluate(doc).meshes[0].topology!,target={feature:'cut',select:{faces:['in0:+Z'],fragments:'one' as const}};
 assert.throws(()=>resolveFaces(table,target),(e:any)=>e.code==='REFERENCE_AMBIGUOUS'&&e.details.candidates.length===2);
 assert.equal(resolveFaces(table,{...target,select:{...target.select,fragments:'all'}}).length,2);
 assert.throws(()=>resolveFaces(table,{feature:'cut',select:{faces:['deleted_face'],fragments:'one'}}),(e:any)=>e.code==='REFERENCE_MISSING'&&e.details.candidates.length>0);
 const candidate=table.faces.find(f=>f.lineage.includes('in1:+X'))!;assert.ok(candidate);assert.equal(resolveFaces(table,{feature:'cut',select:{faces:candidate.lineage,fragments:'one'},signature:{surface:candidate.surface,areaMm2:candidate.areaMm2,normal:candidate.normal}}).length,1);
 }finally{engine.dispose();}
});

test('plane and bounded UV regions follow rigid derived results and preserve graphic and density',async()=>{
 const engine=new GeometryEngine(await kernel());try{
 const doc=canopy(),base=engine.evaluate(doc),face=base.meshes[0].topology!.faces.find(f=>f.lineage.includes('side.0'))!;
 const source=doc.features[0];source.paintRegions=[{id:'stripe',target:{feature:'canopy',select:{faces:['side.0'],fragments:'all'},signature:{surface:face.surface,areaMm2:face.areaMm2,shapeSamples:face.shapeSamples}},keep:[{iso:{u:[0.1,0.25],v:[0.1,0.8]}}],look:{color:'#ff0000'}}];
 const painted=engine.evaluate(doc);assert.ok(painted.meshes[0].regionReport!.areas[0].areaMm2>0);
 for(const feature of [{id:'moved',kind:'transform',params:{target:'canopy',translation:[100,20,10],rotationAxis:[0,0,1],angleDegrees:30,origin:[0,0,0],scale:1,copy:false}},{id:'mirror',kind:'mirror',params:{target:'canopy',plane:'YZ',origin:[0,0,0],copy:false}},{id:'copies',kind:'pattern',params:{target:'canopy',layout:{type:'linear',direction:[1,0,0],spacing:60,count:3}}}]){
  const derived=validateDocument({...doc,features:[source,feature]}),e=engine.evaluate(derived);
  assert.ok(e.meshes.some(m=>m.appearance?.color==='#ff0000'));assert.ok(e.geometry.at(-1)!.massG!>0);
  if(feature.kind==='pattern')assert.equal(new Set(e.meshes[0].topology!.faces.map(f=>f.solidIndex)).size,3);
 }
 }finally{engine.dispose();}
});

test('multiple exact section extrema are rejected with a dimensional ambiguity error',async()=>{
 const oc=await kernel(),engine=new GeometryEngine(oc);try{
 const doc=validateDocument({...emptyDocument(),features:[{id:'body',kind:'cylinder',params:{origin:[0,0,0],radius:10,height:20}}]});const e=engine.evaluate(doc),table=e.meshes[0].topology!;
 const {indexedShapes}=await import('../src/cad/topology'),{sectionMaximum}=await import('../src/cad/regions');
 const faces=indexedShapes(oc,engine['shapes'].get('body')!.wrapped,'FACE');try{const face=faces[table.faces.findIndex(f=>f.lineage.includes('side'))];assert.throws(()=>sectionMaximum(oc,face,[1,0,0],0,[0,0,1],0.01),{code:'CREST_AMBIGUOUS'});}finally{faces.forEach(f=>f.delete());}
 }finally{engine.dispose();}
});

test('rational spline extrema isolate two peaks within one trimmed curve and are translation invariant',async()=>{
 const oc=await kernel(),{splineExtrema}=await import('../src/cad/crest-extrema');
 const rootsAt=(offset:number)=>{
  const points=new oc.NCollection_Array1_gp_Pnt(1,5);for(const [i,y]of [0,4,-2,4,0].entries()){const p=new oc.gp_Pnt(i*10,y+offset,0);points.SetValue(i+1,p);p.delete();}
  const curve=new oc.Geom_BezierCurve(points),builder=new oc.BRepBuilderAPI_MakeEdge(curve),edge=builder.Edge(),adaptor=new oc.BRepAdaptor_Curve(edge);
  try{const roots=splineExtrema(oc,adaptor,[0,1,0])!;assert.ok(roots.length>=3);const peaks=roots.filter(t=>{const a=curve.Value(t-1e-5),b=curve.Value(t),c=curve.Value(t+1e-5);try{return b.Y()>a.Y()&&b.Y()>c.Y();}finally{a.delete();b.delete();c.delete();}});assert.equal(peaks.length,2);return peaks;}
  finally{adaptor.delete();edge.delete();builder.delete();curve.delete();points.delete();}
 };
 const a=rootsAt(0),b=rootsAt(90000);a.forEach((t,i)=>assert.ok(Math.abs(t-b[i])<1e-7));
});

test('all 19 feature kinds and 30 canonical results have complete face/edge/solid display mapping in three fresh Node workers',async()=>{
 const base={id:'base',kind:'box',params:{origin:[0,0,0],size:[20,20,10]}},tool={id:'tool',kind:'cylinder',params:{origin:[10,10,-1],radius:3,height:12}};
 const simple=[base,tool,{id:'rod',kind:'rod',params:{from:[0,0,0],to:[10,10,20],radius:2}},{id:'prism',kind:'extrude',params:{origin:[0,0,0],plane:'XY',distance:12,profile:{type:'ellipse',radiusX:20,radiusY:10}}},canopy().features[0],{id:'pipe',kind:'sweep',params:{profile:{type:'circle',radius:2},path:{points:[[0,0,0],[0,0,10],[5,0,20]]}}},{id:'turned',kind:'revolve',params:{points:[[5,0],[10,0],[10,20],[5,20]],origin:[0,0,0],angleDegrees:270}},{id:'label',kind:'text',params:{text:'CAD',plane:'XY',origin:[0,0,0],size:5,depth:1}}];
 const derived=[...['union','subtract','intersect'].map(kind=>({id:kind,kind,params:{target:'base',tools:['tool']}})),{id:'rounded',kind:'fillet',params:{target:'base',radius:1,edges:'vertical'}},{id:'beveled',kind:'chamfer',params:{target:'base',distance:1,edges:'vertical'}},{id:'moved',kind:'transform',params:{target:'base',translation:[10,5,2],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:20,scale:1,copy:false}},{id:'mirrored',kind:'mirror',params:{target:'base',plane:'YZ',origin:[0,0,0],copy:false}},{id:'copies',kind:'pattern',params:{target:'base',layout:{type:'linear',direction:[1,0,0],spacing:30,count:3}}},{id:'holes',kind:'drill_holes',params:{target:'base',centers:[[5,5,0]],diameter:2,axis:'Z'}},{id:'hollow',kind:'shell',params:{target:'base',thickness:1,removeFaces:[{point:[10,10,10],normal:[0,0,1],toleranceMm:0.001,expectedCount:1}]}}];
 const source=validateDocument({...emptyDocument(),features:[base,tool]});
 const placement={translation:[5,6,7],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:25};
 const inner=validateDocument({...emptyDocument(),features:[{id:'inner',kind:'instance',params:{...placement,document:source.documentId}}]});
 const models=[...simple.map(f=>validateDocument({...emptyDocument(),features:[f]})),...derived.map(f=>validateDocument({...emptyDocument(),features:[base,...(['union','subtract','intersect'].includes(f.kind)?[tool]:[]),f]})),validateDocument({...emptyDocument(),features:[{id:'outer',kind:'instance',params:{...placement,document:inner.documentId}}]}),...Array.from({length:11},(_,i)=>validateDocument({...emptyDocument(),features:[{...base,params:{origin:[i*3,0,0],size:[20+i/10,20,10]}},{id:'cut',kind:'drill_holes',params:{target:'base',centers:[[i*3+5,5,0]],diameter:2+i/20,axis:'Z'}}]}))];
 assert.equal(models.length,30);
 const {NodeGeometryWorker}=await import('../src/cad/node-worker');const threadIds=new Set<number>();
 for(let worker=0;worker<3;worker++){
  const engine=new NodeGeometryWorker();
  try{for(const document of models){const e=await engine.evaluate(document,55000,undefined,[source,inner]);assert.ok(e.meshes.length);for(const mesh of e.meshes){assert.equal(mesh.faceRanges!.filter((_,i)=>i%4===1).reduce((a,b)=>a+b,0),mesh.triangles.length/3,document.features.at(-1)!.kind);assert.equal(mesh.edgeRanges!.filter((_,i)=>i%3===1).reduce((a,b)=>a+b,0),mesh.lines.length/6);assert.ok(mesh.topology!.faces.every(f=>f.solidIndex!==undefined));}}for(const execution of engine.diagnostics.executions)threadIds.add(execution.threadId);}finally{await engine.close();}
 }
 assert.equal(threadIds.size,3);

});

test('coplanar Boolean merge keeps both origins; an actually deleted cap never redirects to the new cap',async()=>{
 const engine=new GeometryEngine(await kernel()),{resolveFaces}=await import('../src/cad/surface-reference');
 try{
  const base={id:'base',kind:'box',params:{origin:[0,0,0],size:[20,20,10]}};
  const union=validateDocument({...emptyDocument(),features:[base,{id:'boss',kind:'box',params:{origin:[10,0,0],size:[20,20,10]}},{id:'joined',kind:'union',params:{target:'base',tools:['boss']}}]});
  const table=engine.evaluate(union).meshes[0].topology!,merged=table.faces.find(f=>f.lineage.includes('in0:+Z')&&f.lineage.includes('in1:+Z'));assert.ok(merged,JSON.stringify(table.faces.map(f=>f.lineage)));
  const trimmed=validateDocument({...emptyDocument(),features:[base,{id:'tool',kind:'box',params:{origin:[-1,-1,8],size:[22,22,4]}},{id:'trimmed',kind:'subtract',params:{target:'base',tools:['tool']}}]});
  const out=engine.evaluate(trimmed).meshes[0].topology!;
  assert.throws(()=>resolveFaces(out,{feature:'trimmed',select:{faces:['in0:+Z'],fragments:'one'},signature:{surface:'PLANE',areaMm2:400,normal:[0,0,1]}}),{code:'REFERENCE_MISSING'});
  assert.ok(out.faces.some(f=>f.lineage.includes('in1:-Z')));
 }finally{engine.dispose();}
});

test('a mirrored crest region follows the authored side through the reflected frame',async()=>{
 const engine=new GeometryEngine(await kernel());try{
 const doc=canopy(),face=engine.evaluate(doc).meshes[0].topology!.faces.find(f=>f.lineage.includes('side.0'))!;
 doc.features[0].paintRegions=[{id:'crest',target:{feature:'canopy',select:{faces:['side.0'],fragments:'all'},signature:{surface:face.surface,areaMm2:face.areaMm2,shapeSamples:face.shapeSamples}},keep:[{crest:{axis:[0,0,1],fromMm:0,toMm:40,extreme:[0,1,0],toward:'positive',toleranceMm:0.05}}],look:{color:'#ff0000'}}];
 const before=engine.evaluate(doc),mirror=validateDocument({...doc,features:[...doc.features,{id:'mirror',kind:'mirror',params:{target:'canopy',plane:'YZ',origin:[0,0,0],copy:false}}]});
 const center=(meshes:typeof before.meshes)=>{const red=meshes.find(m=>m.appearance?.color==='#ff0000')!;return red.vertices.filter((_,i)=>i%3===0).reduce((a,b)=>a+b,0)/(red.vertices.length/3);};
 assert.ok(center(before.meshes)<-1);assert.ok(center(engine.evaluate(mirror).meshes)>1);
 }finally{engine.dispose();}
});

test('curved crest paint survives nearby Boolean and fillet edits with exact geometry parity',async()=>{
 const engine=new GeometryEngine(await kernel());try{
 const doc=canopy(),face=engine.evaluate(doc).meshes[0].topology!.faces.find(f=>f.lineage.includes('side.0'))!;
 doc.features[0].paintRegions=[{id:'crest',target:{feature:'canopy',select:{faces:['side.0'],fragments:'one'},signature:{surface:face.surface,areaMm2:face.areaMm2,shapeSamples:face.shapeSamples}},keep:[{crest:{axis:[0,0,1],fromMm:0,toMm:40,extreme:[0,1,0],toward:'positive',toleranceMm:0.05}}],look:{color:'#ff0000'}}];
 for(const delta of[0,0.1]){
  const derived=validateDocument({...doc,features:[...doc.features,{id:'boss',kind:'cylinder',params:{origin:[0,0,-5],radius:6+delta,height:6}},{id:'joined',kind:'union',params:{target:'canopy',tools:['boss']}},{id:'rounded',kind:'fillet',params:{target:'joined',radius:0.4+delta,edges:{on:{axis:'Z',value:-5},toleranceMm:0.001}}}]});
  const painted=engine.evaluate(derived),bare=structuredClone(derived);delete bare.features[0].paintRegions;const unpainted=engine.evaluate(bare);
  assert.ok(painted.meshes.some(m=>m.appearance?.color==='#ff0000'));assert.ok(painted.meshes.some(m=>m.topology!.faces.some(f=>f.lineage.includes('in0:in0:side.0'))));
  assert.equal(painted.geometry.at(-1)!.volumeMm3,unpainted.geometry.at(-1)!.volumeMm3);assert.equal(painted.geometry.at(-1)!.massG,unpainted.geometry.at(-1)!.massG);
 }
 }finally{engine.dispose();}
});

test('keyed occurrence graphics retain each source piece and resolve per-field occurrence provenance',async()=>{
 const engine=new GeometryEngine(await kernel());try{
 const mark=(id:string)=>({id,anchor:[0.5,0.5,1],normal:[0,0,1],xDirection:[1,0,0],width:5,height:3,depth:1,rotation:0,maxAngle:60,content:{type:'text',text:id,font:'sans',weight:'regular',spacing:0,align:'center',color:'#ffffff'}});
 const source=validateDocument({...emptyDocument(),features:[{id:'one',kind:'box',params:{origin:[0,0,0],size:[10,10,5]},appearance:{material:'steel',graphics:[mark('alpha')]}},{id:'two',kind:'box',params:{origin:[20,0,0],size:[10,10,5]},appearance:{material:'steel',graphics:[mark('beta')]}}]});
 const placement={translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]};
 const assembly=validateDocument({...emptyDocument(),features:[{id:'placed',kind:'instance',params:{...placement,document:source.documentId},appearance:{color:'#112233'},graphicEdits:{upsert:[mark('added')],remove:['alpha']}}]});
 const evaluated=engine.evaluate(assembly,[source]);
 assert.deepEqual(evaluated.meshes.find(m=>m.source?.featureId==='one')!.appearance!.graphics!.map(g=>g.id),['added']);
 assert.deepEqual(evaluated.meshes.find(m=>m.source?.featureId==='two')!.appearance!.graphics!.map(g=>g.id),['beta','added']);
 assert.equal(evaluated.meshes[0].appearanceOrigins!.color.documentId,assembly.documentId);assert.equal(evaluated.meshes[0].appearanceOrigins!.color.layer,'occurrence');
 const first=engine.evaluate(source).meshes[0].topology!.faces.find(f=>f.lineage.includes('+Z'))!;
 source.features[0].surfaceStyles=[{target:{feature:'one',select:{faces:['+Z'],fragments:'all'},signature:{surface:first.surface,areaMm2:first.areaMm2,normal:first.normal}},look:{color:'#ff0000'}}];
 const painted=engine.evaluate(assembly,[source]);assert.ok(painted.meshes.every(m=>m.appearance!.color==='#112233'));assert.ok(painted.meshes.every(m=>m.appearanceOrigins!.color.layer==='occurrence'));
 }finally{engine.dispose();}
});
