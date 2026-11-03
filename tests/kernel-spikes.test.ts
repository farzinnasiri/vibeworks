import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import init from 'replicad-opencascadejs';
import { setOC, makeBox, makeCircle, makeLine, assembleWire, cast, measureVolume, measureDistanceBetween, makeVertex, type Shape3D } from 'replicad';
import { indexedShapes, topologyMesh } from '../src/cad/topology';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument, validateDocument } from '../src/cad/document';
import { profileSketch, pathWire } from '../src/cad/profiles';

const records:Record<string,unknown>={};
const kernel=init({wasmBinary:await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});
async function probe(id:string,run:(oc:Awaited<typeof kernel>)=>unknown|Promise<unknown>){
  const oc=await kernel;setOC(oc);const started=performance.now();
  try{records[id]={status:'measured subset',result:await run(oc),durationMs:performance.now()-started};}
  catch(error){let message=error instanceof Error?error.message:String(error);try{if(error instanceof WebAssembly.Exception)message=oc.getExceptionMessage(error).join(': ');}catch{}records[id]={status:'probe failed',error:message,durationMs:performance.now()-started};}
}
function valid(oc:Awaited<typeof kernel>,shape:Shape3D){const a=new oc.BRepCheck_Analyzer(shape.wrapped,true,false,true);try{return a.IsValid();}finally{a.delete();}}

test('K1 actual Boolean history methods and native indexed-map constructor',async()=>probe('K1',oc=>{
 const a=makeBox([0,0,0],[20,20,10]),b=makeBox([5,5,5],[25,25,15]);const builder=new oc.BRepAlgoAPI_Fuse(a.wrapped,b.wrapped);
 const faces=indexedShapes(oc,a.wrapped,'FACE');
 try{const history=faces.map(f=>{const m=builder.Modified(f);try{return{deleted:builder.IsDeleted(f),modifiedEmpty:m.IsEmpty()};}finally{m.delete();}});
 let indexedMap:string;try{const map=new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher();map.delete();indexedMap='callable';}catch(error){indexedMap=String(error);}
 return {history,indexedMap,acceptance:'30 models, complete naming and three fresh workers remain required'};
 }finally{faces.forEach(f=>f.delete());builder.delete();a.delete();b.delete();}
}));
test('K2 per-face triangulation has complete triangle coverage without face hashes',async()=>probe('K2',oc=>{
 const engine=new GeometryEngine(oc);try{const doc=validateDocument({...emptyDocument(),features:[{id:'box',kind:'box',params:{origin:[0,0,0],size:[20,30,10]}}]});const collisionBox=makeBox([0,0,0],[20,30,10]);const collisionFaces=indexedShapes(oc,collisionBox.wrapped,'FACE',()=>1);assert.equal(collisionFaces.length,6);collisionFaces.forEach(f=>f.delete());collisionBox.delete();const mesh=engine.evaluate(doc).meshes[0];assert.equal(mesh.topology!.faces.length,6);assert.equal(mesh.faceRanges!.filter((_,i)=>i%4===1).reduce((a,b)=>a+b,0),12);return{faces:6,triangles:12,edges:mesh.topology!.edges.length};}finally{engine.dispose();}
}));
test('K3 physical splitter with a closed circle wire on a plane',async()=>probe('K3',oc=>{
 const box=makeBox([0,0,0],[20,20,10]),circle=makeCircle(3,[10,10,10],[0,0,1]),wire=assembleWire([circle]);const splitter=new oc.BRepAlgoAPI_Splitter();
 try{const args=splitter.Arguments(),tools=splitter.Tools();try{args.Append(box.wrapped);tools.Append(wire.wrapped);splitter.SetArguments(args);splitter.SetTools(tools);splitter.Build();const raw=splitter.Shape(),shape=cast(raw).asShape3D();try{return{valid:valid(oc,shape),volumeBefore:measureVolume(box),volumeAfter:measureVolume(shape),faces:indexedShapes(oc,shape.wrapped,'FACE').map(f=>{f.delete();return 1;}).length};}finally{shape.delete();}}finally{args.delete();tools.delete();}}
 finally{splitter.delete();wire.delete();circle.delete();box.delete();}
}));
test('K4 authored rectangular loft compatibility and Wires history',async()=>probe('K4',oc=>{
 const builder=new oc.BRepOffsetAPI_ThruSections(true,false,1e-6);const a=profileSketch({type:'rectangle',width:20,height:10},{origin:[0,0,0],normal:[0,0,1],xDirection:[1,0,0]}),b=profileSketch({type:'rectangle',width:16,height:8},{origin:[0,0,20],normal:[0,0,1],xDirection:[1,0,0]});
 try{builder.CheckCompatibility(false);builder.SetSmoothing(true);builder.SetContinuity(oc.GeomAbs_Shape.GeomAbs_C2);builder.SetMaxDegree(8);builder.AddWire(a.wire.wrapped);builder.AddWire(b.wire.wrapped);builder.Build();assert.ok(builder.IsDone());const shape=cast(builder.Shape()).asShape3D(),wires=builder.Wires();try{return{valid:valid(oc,shape),volume:measureVolume(shape),wireHistoryCallable:!wires.IsEmpty(),acceptance:'one aligned case; seam/split and eight-case acceptance unverified'};}finally{shape.delete();wires.delete();}}
 finally{builder.delete();a.delete();b.delete();}
}));
test('K5 planar filling with independent boundary distance samples',async()=>probe('K5',oc=>{
 const edges=[makeLine([0,0,0],[20,0,0]),makeLine([20,0,0],[20,20,0]),makeLine([20,20,0],[0,20,0]),makeLine([0,20,0],[0,0,0])];const b=new oc.BRepOffsetAPI_MakeFilling();
 try{for(const e of edges)b.Add(e.wrapped,oc.GeomAbs_Shape.GeomAbs_C0,true);b.Build();assert.ok(b.IsDone());const shape=cast(b.Shape());try{let max=0;for(const e of edges)for(let i=0;i<=10;i++){const p=e.pointAt(i/10),v=makeVertex(p.toTuple());try{max=Math.max(max,measureDistanceBetween(v,shape));}finally{v.delete();p.delete();}}return{g0ReportedMm:b.G0Error(),g1Reported:b.G1Error(),boundarySamples:44,maxBoundaryGapMm:max,acceptance:'G1/G2 and sewing into solid unverified'};}finally{shape.delete();}}
 finally{b.delete();edges.forEach(e=>e.delete());}
}));
test('K6 auxiliary-spine guided sweep on straight rails',async()=>probe('K6',oc=>{
 const frame={origin:[0,0,0] as [number,number,number],normal:[0,1,0] as [number,number,number],xDirection:[1,0,0] as [number,number,number]};
 const path=pathWire({start:[0,0],segments:[{type:'line',to:[0,20]}]},frame),guide=pathWire({start:[5,0],segments:[{type:'line',to:[5,20]}]},frame),profile=profileSketch({type:'circle',radius:2},{origin:[0,0,0],normal:[0,0,-1],xDirection:[1,0,0]});const b=new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
 try{b.SetMode(guide.wrapped,true,oc.BRepFill_TypeOfContact.BRepFill_NoContact);b.Add(profile.wire.wrapped,false,true);b.Build();assert.ok(b.IsDone());assert.ok(b.MakeSolid());const shape=cast(b.Shape()).asShape3D();try{return{valid:valid(oc,shape),errorOnSurface:b.ErrorOnSurface(),volume:measureVolume(shape),acceptance:'one rail case; multi-section and four-case acceptance unverified'};}finally{shape.delete();}}
 finally{b.delete();path.delete();guide.delete();profile.delete();}
}));
test('K7 XCAF face-color prerequisite is callable',async()=>probe('K7',oc=>{
 // No face-colour readback claim follows from constructing the exporter.
 const document=new oc.TDocStd_Document(new oc.TCollection_ExtendedString('BinXCAF'));try{const tool=oc.XCAFDoc_DocumentTool.ColorTool(document.Main());tool.delete();return{colorToolCallable:true,acceptance:'face assignments and independent STEP readback required'};}finally{document.delete();}
}));
test('K8 shared style-group GPU geometry prerequisite',async()=>probe('K8',async oc=>{
 const THREE=await import('three');const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0,1,1,0],3));geometry.setIndex([0,1,2,1,3,2]);geometry.addGroup(0,3,0);geometry.addGroup(3,3,1);const mesh=new THREE.Mesh(geometry,[new THREE.MeshPhysicalMaterial({color:'red'}),new THREE.MeshPhysicalMaterial({color:'blue'})]);try{assert.equal(mesh.geometry.groups.length,2);return{groups:2,acceptance:'GLB readback and actual path tracing required'};}finally{geometry.dispose();mesh.material.forEach(m=>m.dispose());}
}));
test('K9 variable radius native array and fillet builder',async()=>probe('K9',oc=>{
 const shape=makeBox([0,0,0],[20,20,20]),edges=indexedShapes(oc,shape.wrapped,'EDGE'),array=new oc.NCollection_Array1_gp_Pnt2d(1,3),b=new oc.BRepFilletAPI_MakeFillet(shape.wrapped);const edge=oc.TopoDS.Edge(edges[0]);
 try{for(let i=0;i<3;i++){const p=new oc.gp_Pnt2d(i/2,1+i/2);array.SetValue(i+1,p);p.delete();}b.Add(array,edge);b.Build();assert.ok(b.IsDone());const result=cast(b.Shape()).asShape3D();try{return{valid:valid(oc,result),volume:measureVolume(result),acceptance:'one case; six-case acceptance unverified'};}finally{result.delete();}}
 finally{edge.delete();b.delete();array.delete();edges.forEach(e=>e.delete());shape.delete();}
}));
test('K10 500 repeated solids are enumerable without collapsing locations',async()=>probe('K10',oc=>{
 const builder=new oc.TopoDS_Builder(),raw=new oc.TopoDS_Compound(),source=makeBox([0,0,0],[1,1,1]);builder.MakeCompound(raw);const started=performance.now();
 try{for(let i=0;i<500;i++){const s=source.clone().translate([i*3,0,0]);builder.Add(raw,s.wrapped);s.delete();}const solids=indexedShapes(oc,raw,'SOLID');try{assert.equal(solids.length,500);return{leafBodies:solids.length,enumerationAndBuildMs:performance.now()-started,acceptance:'broad phase and durable fact restart reuse unverified'};}finally{solids.forEach(s=>s.delete());}}
 finally{raw.delete();builder.delete();source.delete();}
}));
test('record reproducible kernel outcomes separately from acceptance',async()=>{
 await mkdir('artifacts/foundations',{recursive:true});await writeFile('artifacts/foundations/kernel-spikes.json',JSON.stringify({at:new Date().toISOString(),kernel:'replicad-opencascadejs 1.1.0',records},null,2)+'\n');
 assert.equal(Object.keys(records).length,10);
});
