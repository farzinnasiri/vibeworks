import {cast,Edge,assembleWire,makeFace,makeVertex,measureDistanceBetween,type Face,type Shape3D} from 'replicad';
import type {OpenCascadeInstance} from 'replicad-opencascadejs';
import type {Feature,Vector3} from '../shared/protocol';
import {authoredWire} from './loft-correspondence';
import {profileSketch,pathWire,splineWire} from './profiles';
import {indexedShapes} from './topology';
import {ShapeHistory} from './history';
import {CadError} from './document';

/** Native filling patches share exact authored section and rail boundaries, then sew into one solid. */
export function guidedLoft(oc:OpenCascadeInstance,feature:Extract<Feature,{kind:'loft'}>,history:ShapeHistory){
 const p=feature.params,tolerance=p.toleranceMm??0.005;
 if(p.correspondence!=='authored'||p.ruled||p.smoothing!==undefined||p.continuity!==undefined)throw new CadError('LOFT_GUIDE_SETTINGS','Guided lofts require authored correspondence and ruled:false. Smoothing/continuity controls apply to ordinary lofts; guide contact is independently checked.');
 const owned:{delete():void}[]=[],own=<T extends{delete():void}>(v:T):T=>{owned.push(v);return v;};
 let result:Shape3D|undefined;
 try{
  const sections=p.sections.map(s=>{const sketch=own(profileSketch(s.profile,s.frame)),report=authoredWire(sketch.wire,s);own(report.wire);return report;});
  const count=sections[0].names.length;
  if(count<2||count>32||sections.some(s=>s.names.length!==count))throw new CadError('LOFT_CORRESPONDENCE','Guided sections need 2–32 matching authored segments. Split round profiles explicitly; no polygon resampling is performed.',{sections:sections.map(s=>({names:s.names,positions:s.positions}))});
  const byVertex=new Map(p.guides!.map(g=>[g.vertex,g]));
  if(byVertex.size!==p.guides!.length||p.guides!.some(g=>!sections[0].names.includes(g.vertex)))throw new CadError('LOFT_GUIDE_VERTEX','Each guide must name a distinct start vertex of an authored first-section segment.',{vertices:sections[0].names});
  const rails=sections[0].names.map((name,index)=>{
   const guide=byVertex.get(name),points=sections.map(s=>s.vertices[index]);
   const wire=own(guide?('points'in guide.path?splineWire(guide.path.points):pathWire(guide.path,guide.path.frame)):splineWire(points));
   const edges=indexedShapes(oc,wire.wrapped,'EDGE').map(raw=>{try{return own(new Edge(oc.TopoDS.Edge(raw)));}finally{raw.delete();}});
   const rawVertices=indexedShapes(oc,wire.wrapped,'VERTEX');
   try{
    const endpoints=rawVertices.filter(vertex=>edges.reduce((n,edge)=>{const children=indexedShapes(oc,edge.wrapped,'VERTEX');try{return n+Number(children.some(v=>v.IsSame(vertex)));}finally{children.forEach(v=>v.delete());}},0)===1);
    const positions=endpoints.map(raw=>{const vertex=own(oc.TopoDS.Vertex(raw)),point=own(oc.BRep_Tool.Pnt(vertex));return[point.X(),point.Y(),point.Z()];});
    if(positions.length!==2||!points.filter((_,i)=>i===0||i===points.length-1).every(point=>positions.some(endpoint=>Math.hypot(...point.map((v,k)=>v-endpoint[k]))<=tolerance)))throw new CadError('LOFT_GUIDE_ENDPOINT','Guide endpoints must coincide with the corresponding first and last section vertices.',{vertex:name,expected:[points[0],points.at(-1)],endpoints:positions});
   }finally{rawVertices.forEach(v=>v.delete());}
   for(const [i,point]of points.entries()){
    const vertex=own(makeVertex(point));
    if(measureDistanceBetween(vertex,wire)>tolerance)throw new CadError('LOFT_GUIDE_MISSES_SECTION','A guide misses its corresponding authored section vertex.',{vertex:name,section:i,point});
    const frame=p.sections[i].frame,plane=own(new oc.gp_Pln(own(new oc.gp_Pnt(...frame.origin)),own(new oc.gp_Dir(...frame.normal)))),section=own(new oc.BRepAlgoAPI_Section(wire.wrapped,plane,true)),raw=own(section.Shape());
    const crossings=indexedShapes(oc,raw,'VERTEX'),overlap=indexedShapes(oc,raw,'EDGE');
    try{
     const unique:number[][]=[];
     for(const raw of crossings){const vertex=own(oc.TopoDS.Vertex(raw)),p=own(oc.BRep_Tool.Pnt(vertex)),point=[p.X(),p.Y(),p.Z()];if(!unique.some(q=>Math.hypot(...q.map((v,k)=>v-point[k]))<=1e-7))unique.push(point);}
     if(overlap.length||unique.length!==1)throw new CadError('LOFT_GUIDE_AMBIGUOUS','Each rail must cross each section plane exactly once.',{vertex:name,section:i,crossings:unique,overlappingEdges:overlap.length});
    }finally{crossings.forEach(v=>v.delete());overlap.forEach(e=>e.delete());}
   }
   return{wire,edges,name,authored:!!guide};
  });
  const sectionEdges=sections.map(report=>{
   const edges=indexedShapes(oc,report.wire.wrapped,'EDGE').map(raw=>{try{return own(new Edge(oc.TopoDS.Edge(raw)));}finally{raw.delete();}});
   return report.vertices.map((point,index)=>{
    const next=report.vertices[(index+1)%count],match=edges.find(edge=>{const a=edge.startPoint,b=edge.endPoint;try{const close=(p:number[],q:number[])=>Math.hypot(...p.map((v,k)=>v-q[k]))<=1e-6;return close(a.toTuple(),point)&&close(b.toTuple(),next)||close(b.toTuple(),point)&&close(a.toTuple(),next);}finally{a.delete();b.delete();}});
    if(!match)throw new CadError('LOFT_CORRESPONDENCE','An authored segment could not be matched to its exact native edge.');return match;
   });
  });
  const faces:Face[]=[],residuals:unknown[]=[];
  for(let side=0;side<count;side++){
   const pending=[sectionEdges[0][side],...rails[(side+1)%count].edges,sectionEdges.at(-1)![side],...rails[side].edges],boundaries:Edge[]=[];
   let end=sections[0].vertices[side];
   while(pending.length){
    const index=pending.findIndex(edge=>{const a=edge.startPoint,b=edge.endPoint;try{return[a.toTuple(),b.toTuple()].some(p=>Math.hypot(...p.map((v,k)=>v-end[k]))<=1e-6);}finally{a.delete();b.delete();}});
    if(index<0)throw new CadError('LOFT_GUIDE_FAILED','A guided patch boundary is not connected.',{side});
    const edge=pending.splice(index,1)[0],a=edge.startPoint,b=edge.endPoint;
    try{const forward=Math.hypot(...a.toTuple().map((v,k)=>v-end[k]))<=1e-6,raw=own(edge.wrapped.Oriented(forward?oc.TopAbs_Orientation.TopAbs_FORWARD:oc.TopAbs_Orientation.TopAbs_REVERSED));boundaries.push(own(new Edge(oc.TopoDS.Edge(raw))));end=forward?b.toTuple():a.toTuple();}finally{a.delete();b.delete();}
   }
   const origin=sections[0].vertices[side],u=sections[0].vertices[(side+1)%count].map((v,i)=>v-origin[i]),v=sections.at(-1)!.vertices[side].map((v,i)=>v-origin[i]);
   const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]] as Vector3;
   if(Math.hypot(...n)<1e-9)throw new CadError('LOFT_GUIDE_FRAME','A side has no independent section/span directions.',{side});
   const axes=own(new oc.gp_Ax3(own(new oc.gp_Pnt(...origin)),own(new oc.gp_Dir(...n)),own(new oc.gp_Dir(...u as Vector3)))),plane=own(new oc.gp_Pln(axes));
   const extent=Math.max(10,...sections.flatMap(s=>s.vertices.map(p=>Math.hypot(...p.map((v,k)=>v-origin[k])))))*2,seed=own(new oc.BRepBuilderAPI_MakeFace(plane,-extent,extent,-extent,extent)),seedFace=own(seed.Face());
   const middle=sectionEdges.slice(1,-1).map(edges=>edges[side]);
   // Profiles and rails were built independently. MakeWire joins coincident native
   // vertices before MakeFilling's topology-based boundary assembly sees the edges.
   const boundaryWire=own(assembleWire(boundaries));
   if(!oc.BRep_Tool.IsClosed(boundaryWire.wrapped))throw new CadError('LOFT_GUIDE_FAILED','The native patch boundary is not closed.',{side});
   const connected=indexedShapes(oc,boundaryWire.wrapped,'EDGE').map(raw=>{try{return own(new Edge(oc.TopoDS.Edge(raw)));}finally{raw.delete();}});
   let accepted:Face|undefined;const attempts:unknown[]=[];
   for(const fitTolerance of[tolerance/10,Math.min(1e-9,tolerance/100)]){
    const builder=own(new oc.BRepOffsetAPI_MakeFilling(3,24,3,false,1e-7,fitTolerance,0.001,0.1,p.maxDegree??8,32));builder.LoadInitSurface(seedFace);
    connected.forEach(edge=>builder.Add(edge.wrapped,oc.GeomAbs_Shape.GeomAbs_C0,true));middle.forEach(edge=>builder.Add(edge.wrapped,oc.GeomAbs_Shape.GeomAbs_C0,false));builder.Build();
    if(!builder.IsDone()){attempts.push({fitTolerance,done:false});continue;}
    const raw=own(builder.Shape()),face=own(cast(raw) as Face);
    const originalCheck=own(new oc.BRepCheck_Analyzer(face.wrapped,true,false,true));
    if(!originalCheck.IsValid()){
      const surface=own(oc.BRep_Tool.Surface(face.wrapped)),edges:Edge[]=[],rawEdges=indexedShapes(oc,face.wrapped,'EDGE');rawEdges.forEach(own);
      for(const raw of rawEdges){
        const source=own(oc.TopoDS.Edge(raw)),pc=own(new oc.BRepAdaptor_Curve2d(source,face.wrapped)),curve=own(pc.Curve()),maker=own(new oc.BRepBuilderAPI_MakeEdge(curve,surface,pc.FirstParameter(),pc.LastParameter())),edge=own(maker.Edge());
        if(!oc.BRepLib.BuildCurve3d(edge,1e-9,oc.GeomAbs_Shape.GeomAbs_C1,14,1000))throw new CadError('LOFT_GUIDE_FAILED','A guided patch boundary could not be rebuilt on its exact support.',{side});
        edge.Orientation(source.Orientation());edges.push(own(new Edge(oc.TopoDS.Edge(edge))));
      }
      const closed=own(assembleWire(edges)),maker=own(new oc.BRepBuilderAPI_MakeFace(surface,closed.wrapped,true));face.wrapped=maker.Face();
    }
    // Recompute p-curve tolerances, then reject if the native result exceeds the requested bound.
    oc.BRepLib.SameParameter(face.wrapped,Math.min(1e-7,tolerance/10),true);
    oc.BRepLib.UpdateEdgeTolerance(face.wrapped,tolerance/2,tolerance);
    oc.BRepLib.UpdateTolerances(face.wrapped,true);
    oc.BRepLib.UpdateInnerTolerances(face.wrapped);
    const maximumToleranceMm=Math.max(...(['EDGE','VERTEX','FACE'] as const).map(kind=>oc.BRep_Tool.MaxTolerance(face.wrapped,oc.TopAbs_ShapeEnum[`TopAbs_${kind}`])));
    const initialCheck=own(new oc.BRepCheck_Analyzer(face.wrapped,true,false,true));
    let repaired=false;
    if(!initialCheck.IsValid()){
      const count=(kind:'EDGE'|'WIRE')=>{const shapes=indexedShapes(oc,face.wrapped,kind);try{return shapes.length;}finally{shapes.forEach(s=>s.delete());}};
      const before=[count('EDGE'),count('WIRE')],fixer=own(new oc.ShapeFix_Face(face.wrapped));fixer.SetPrecision(tolerance/10);fixer.SetMinTolerance(1e-7);fixer.SetMaxTolerance(tolerance);repaired=fixer.Perform();
      face.wrapped=oc.TopoDS.Face(own(fixer.Face()));if(before[0]!==count('EDGE')||before[1]!==count('WIRE'))throw new CadError('LOFT_GUIDE_FAILED','Patch parameter repair changed boundary topology.',{side});
    }
    const check=own(new oc.BRepCheck_Analyzer(face.wrapped,true,false,true));let maximum=0;
    for(const edge of[...boundaries,...middle])for(let i=0;i<=16;i++){const point=edge.pointAt(i/16),vertex=makeVertex(point.toTuple());try{maximum=Math.max(maximum,measureDistanceBetween(vertex,face));}finally{vertex.delete();point.delete();}}
    const nativeEdges=indexedShapes(oc,face.wrapped,'EDGE'),surface=own(new oc.BRepAdaptor_Surface(face.wrapped,true));nativeEdges.forEach(own);
    const parameterResiduals=nativeEdges.map(raw=>{
      const edge=own(oc.TopoDS.Edge(raw)),curve=own(new oc.BRepAdaptor_Curve(edge)),pc=own(new oc.BRepAdaptor_Curve2d(edge,face.wrapped));let maximumMm=0;
      for(let i=0;i<=32;i++){const t=curve.FirstParameter()+(curve.LastParameter()-curve.FirstParameter())*i/32,a=curve.Value(t),uv=pc.Value(t),b=surface.Value(uv.X(),uv.Y());try{maximumMm=Math.max(maximumMm,a.Distance(b));}finally{a.delete();uv.delete();b.delete();}}
      return{maximumMm,toleranceMm:oc.BRep_Tool.Tolerance(edge),sameParameter:oc.BRep_Tool.SameParameter(edge),sameRange:oc.BRep_Tool.SameRange(edge),range:[curve.FirstParameter(),curve.LastParameter()],pcurveRange:[pc.FirstParameter(),pc.LastParameter()]};
    });
    const facts={side,fitTolerance,repaired,maximumToleranceMm,samplesPerEdge:17,sampledMaximumMm:maximum,builderMaximumMm:builder.G0Error(),valid:check.IsValid(),parameterResiduals};attempts.push(facts);
    if(check.IsValid()&&maximumToleranceMm<=tolerance&&Number.isFinite(maximum)&&maximum<=tolerance&&builder.G0Error()<=tolerance){accepted=face;residuals.push(facts);break;}
   }
   if(!accepted)throw new CadError('LOFT_GUIDE_FAILED','A guided patch failed exact validity or section/guide residual checks.',{side,attempts,toleranceMm:tolerance});
   history.set(accepted as unknown as Shape3D,[[`side.${sections[0].names[side]}`]]);faces.push(accepted);
  }
  for(const [index,name]of[[0,'cap.start'],[sections.length-1,'cap.end']] as const){const cap=own(makeFace(sections[index].wire));history.set(cap as unknown as Shape3D,[[name]]);faces.push(cap);}
  const sewingToleranceMm=tolerance/2;
  const sewing=own(new oc.BRepBuilderAPI_Sewing(sewingToleranceMm,true,true,true,false));sewing.SetMaxTolerance(sewingToleranceMm);sewing.SetSameParameterMode(true);faces.forEach(face=>sewing.Add(face.wrapped));sewing.Perform();
  if(sewing.NbFreeEdges()||sewing.NbMultipleEdges())throw new CadError('LOFT_GUIDE_FAILED','Guided patches did not form a closed manifold boundary.',{freeEdges:sewing.NbFreeEdges(),multipleEdges:sewing.NbMultipleEdges(),toleranceMm:tolerance});
  const sewed=own(sewing.SewedShape()),shells=indexedShapes(oc,sewed,'SHELL');shells.forEach(own);const maker=own(new oc.BRepBuilderAPI_MakeSolid());
  if(!shells.length)throw new CadError('LOFT_GUIDE_FAILED','Guided sewing produced no shell.');
  shells.forEach(shell=>maker.Add(own(oc.TopoDS.Shell(shell))));const solid=own(maker.Solid());if(!oc.BRepLib.OrientClosedSolid(solid))throw new CadError('LOFT_GUIDE_FAILED','The guided solid could not be oriented.');
  result=cast(solid).asShape3D();oc.BRepLib.SameParameter(result.wrapped,Math.min(1e-7,tolerance/10),true);oc.BRepLib.UpdateEdgeTolerance(result.wrapped,1e-7,tolerance);oc.BRepLib.UpdateTolerances(result.wrapped,true);oc.BRepLib.UpdateInnerTolerances(result.wrapped);
  const check=own(new oc.BRepCheck_Analyzer(result.wrapped,true,false,true));
  if(!check.IsValid()){
    const outputFaces=indexedShapes(oc,result.wrapped,'FACE');
    try{throw new CadError('LOFT_GUIDE_FAILED','The guided loft fails exact solid validation.',{faces:outputFaces.map((raw,i)=>({i,valid:check.IsValid(raw)}))});}finally{outputFaces.forEach(face=>face.delete());}
  }
  const maximumToleranceMm=Math.max(...(['EDGE','VERTEX','FACE'] as const).map(kind=>oc.BRep_Tool.MaxTolerance(result!.wrapped,oc.TopAbs_ShapeEnum[`TopAbs_${kind}`])));
  if(!Number.isFinite(maximumToleranceMm)||maximumToleranceMm>tolerance)throw new CadError('LOFT_GUIDE_FAILED','The sewn guided loft exceeds its requested native tolerance.',{maximumToleranceMm,toleranceMm:tolerance});
  const boundaryShells=indexedShapes(oc,result.wrapped,'SHELL').map(raw=>{try{return own(cast(raw));}finally{raw.delete();}});
  const finalResiduals=[...sectionEdges.flat(),...rails.flatMap(rail=>rail.edges)].map(edge=>{
    let maximumMm=0;for(let i=0;i<=32;i++){const point=edge.pointAt(i/32),vertex=makeVertex(point.toTuple());try{maximumMm=Math.max(maximumMm,Math.min(...boundaryShells.map(shell=>measureDistanceBetween(vertex,shell))));}finally{vertex.delete();point.delete();}}return maximumMm;
  });
  if(finalResiduals.some(mm=>!Number.isFinite(mm)||mm>tolerance))throw new CadError('LOFT_GUIDE_FAILED','The sewn solid missed an authored section or rail.',{finalResiduals,toleranceMm:tolerance});
  history.sewn(result,sewing,faces as unknown as Shape3D[]);
  const diagnostics={method:'OCCT filling patches with orthogonal plane initialization, sharing authored section and guide curves, then bounded sewing',toleranceMm:tolerance,maximumToleranceMm,finalBoundary:{samplesPerEdge:33,maximumMm:Math.max(...finalResiduals),measurement:'distance to exact final shells; sampled only'},seamContinuity:'G0; no boundary G1/G2 claim',residuals,guides:rails.map(r=>({vertex:r.name,authored:r.authored})),sections:sections.map(({wire,...report},i)=>({...report,section:i}))};
  const output={shape:result,diagnostics};result=undefined;return output;
 }finally{result?.delete();owned.reverse().forEach(v=>v.delete());}
}
