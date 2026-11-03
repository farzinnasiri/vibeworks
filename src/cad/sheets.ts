import {cast,Edge,Face,makeVertex,measureDistanceBetween,type Shape3D} from 'replicad';
import type {OpenCascadeInstance} from 'replicad-opencascadejs';
import type {EdgeRef,Feature,SurfaceTarget,Vector3} from '../shared/protocol';
import {CadError} from './document';
import {curvatureDifference} from './curvature';
import {indexedShapes,topologyTable} from './topology';
import {resolveFaces} from './surface-reference';
import type {ShapeHistory} from './history';
function table(oc:OpenCascadeInstance,shape:Shape3D,history:ShapeHistory){return topologyTable(oc,shape,{id:'support',kind:'fill'} as Feature,history.get(shape)?.map(names=>names.map(n=>n.replace(/^in[0-9]+:/,''))));}
export function resolveEdge(oc:OpenCascadeInstance,shape:Shape3D,ref:EdgeRef,history:ShapeHistory):Edge{
 const t=table(oc,shape,history),candidates=t.edges.flatMap((e,index)=>e.lineage.includes(ref.name)?[{...e,index}]:[]);
 const details={reference:ref,candidates:candidates.length?candidates:t.edges};
 if(candidates.length!==1)throw new CadError(candidates.length?'REFERENCE_AMBIGUOUS':'REFERENCE_MISSING','Inspect topology and explicitly choose an edge candidate.',details);
 const candidate=candidates[0];
 if(Math.hypot(...candidate.center.map((v,i)=>v-ref.signature.center[i]))>Math.max(0.01,ref.signature.lengthMm*0.05)||Math.abs(candidate.lengthMm-ref.signature.lengthMm)>Math.max(0.01,ref.signature.lengthMm*0.05))throw new CadError('REFERENCE_CHANGED','The captured edge position or length changed. Inspect and repair explicitly.',details);
 const raw=indexedShapes(oc,shape.wrapped,'EDGE');try{return new Edge(oc.TopoDS.Edge(raw[candidate.index]));}finally{raw.forEach(r=>r.delete());}
}
function faces(oc:OpenCascadeInstance,shape:Shape3D,target:SurfaceTarget,history:ShapeHistory){
 if(target.path?.length)throw new CadError('REFERENCE_SCOPE','Open the source document to use construction references. Placed occurrence references are not accepted here.');
 if(!target.signature||!('faces'in target.select))throw new CadError('REFERENCE_SIGNATURE_REQUIRED','Construction face references require named faces and a captured signature.');
 const selected=resolveFaces(table(oc,shape,history),target),raw=indexedShapes(oc,shape.wrapped,'FACE');
 try{return selected.map(i=>new Face(oc.TopoDS.Face(raw[i])));}finally{raw.forEach(r=>r.delete());}
}
/** Every reported residual is a bounded sample of exact curves/surfaces, never a global certificate. */
export function fillSheet(oc:OpenCascadeInstance,p:Extract<Feature,{kind:'fill'}>['params'],shapes:Map<string,Shape3D>,history:ShapeHistory){
 try{return fillAttempt(oc,p,shapes,history,false);}
 catch(error){
  if(!(error instanceof CadError)||!['FILL_INVALID_SHEET','CONTINUITY_NOT_MET'].includes(error.code))throw error;
  // A tighter native fit can repair approximation defects. Both attempts must pass the
  // same requested residuals and exact validity checks; never relax the requested tolerances.
  try{return fillAttempt(oc,p,shapes,history,true);}
  catch(second){if(second instanceof CadError)throw new CadError(second.code,second.message,{...second.details as object,previousAttempt:{code:error.code,details:{...error.details as object,candidate:undefined}}});throw second;}
 }
}
function fillAttempt(oc:OpenCascadeInstance,p:Extract<Feature,{kind:'fill'}>['params'],shapes:Map<string,Shape3D>,history:ShapeHistory,tight:boolean){
 const owned:{delete():void}[]=[],own=<T extends{delete():void}>(v:T):T=>{owned.push(v);return v;};
 let result:Shape3D|undefined;
 try{
  const constraints=p.boundary.map(c=>{
   const source=shapes.get(c.edge.feature);if(!source)throw new CadError('REFERENCE_MISSING','Boundary source is missing.');
   const edge=own(resolveEdge(oc,source,c.edge,history));
   const support=c.support?faces(oc,shapes.get(c.support.feature)!,c.support,history).map(own):[];
   if(support.length>1||c.continuity!=='G0'&&!support.length)throw new CadError('CONTINUITY_UNSUPPORTED','G1/G2 constraints require one supporting face per edge.');
   if(support[0]&&measureDistanceBetween(edge,support[0])>p.tolerances.g0Mm)throw new CadError('REFERENCE_CHANGED','Boundary edge is not on its supporting face.');
   return {edge,support:support[0],continuity:c.continuity};
  });
  // Require one connected closed boundary. MakeFilling otherwise synthesizes unannounced gap edges.
  const ends=constraints.map(c=>{const a=own(c.edge.startPoint),b=own(c.edge.endPoint);return [a.toTuple(),b.toTuple()];});
  const distance=(a:Vector3,b:Vector3)=>Math.hypot(...a.map((v,k)=>v-b[k]));
  let orientations:boolean[]|undefined;
  for(const firstReverse of [false,true]){
   const trial=[firstReverse];let end=ends[0][firstReverse?0:1];
   for(let i=1;i<ends.length;i++){if(distance(end,ends[i][0])<=p.tolerances.g0Mm){trial.push(false);end=ends[i][1];}else if(distance(end,ends[i][1])<=p.tolerances.g0Mm){trial.push(true);end=ends[i][0];}else break;}
   if(trial.length===ends.length&&distance(end,ends[0][firstReverse?1:0])<=p.tolerances.g0Mm){orientations=trial;break;}
  }
  if(!orientations)throw new CadError('FILL_BOUNDARY','Boundary edges must form one ordered closed loop.',{endpoints:ends});
  constraints.forEach((c,i)=>{const backward=c.edge.orientation==='backward';if(backward!==orientations![i])c.edge.wrapped.Reverse();});
  if(constraints.some(c=>c.continuity==='G2')&&p.tolerances.g2===undefined)throw new CadError('CONTINUITY_TOLERANCE','G2 filling requires tolerances.g2 in inverse millimeters.');
  const fitToleranceMm=tight?Math.min(1e-7,p.tolerances.g0Mm/10):p.tolerances.g0Mm/10;
  const builder=own(new oc.BRepOffsetAPI_MakeFilling(constraints.some(c=>c.continuity==='G2')?4:3,24,3,false,1e-7,fitToleranceMm,p.tolerances.g1Deg*Math.PI/180,p.tolerances.g2??0.1,p.degree??8,p.maxSegments??16));
  const initial=constraints[0].support;
  // A shared plane has orthogonal parameters and is a valid initial plate. This avoids
  // the automatic plate's tilted parameter frame on circular/elliptical boundaries.
  if(initial?.geomType==='PLANE'&&constraints.every(c=>c.support?.wrapped.IsSame(initial.wrapped)))builder.LoadInitSurface(initial.wrapped);
  // MakeFilling forwards enum ordinals to plate orders 0/1/2; GeomAbs_G2 is ordinal 3 and fails.
  constraints.forEach(c=>{const order=c.continuity==='G0'?oc.GeomAbs_Shape.GeomAbs_C0:c.continuity==='G1'?oc.GeomAbs_Shape.GeomAbs_G1:oc.GeomAbs_Shape.GeomAbs_C1;if(c.support)builder.Add(c.edge.wrapped,c.support.wrapped,order,true);else builder.Add(c.edge.wrapped,order,true);});
  for(const point of p.points??[])builder.Add(own(new oc.gp_Pnt(...point)));
  builder.Build();if(!builder.IsDone())throw new CadError('FILL_FAILED','OCCT MakeFilling did not produce a sheet.');
  const raw=own(builder.Shape()),face=cast(raw) as Face;
  result=face as unknown as Shape3D;
  const residuals=constraints.map((c,index)=>{
   let gap=0,angle:number|undefined,curvature:number|undefined,failingPoint:Vector3=[0,0,0];
   for(let i=0;i<=32;i++){
    const point=c.edge.pointAt(i/32),vertex=makeVertex(point.toTuple());
    try{const distance=measureDistanceBetween(vertex,face);if(distance>=gap){gap=distance;failingPoint=point.toTuple();}
     if(c.support){const a=face.normalAt(point),b=c.support.normalAt(point);try{const cosine=Math.abs(a.toTuple().reduce((n,v,k)=>n+v*b.toTuple()[k],0));const degrees=Math.acos(Math.min(1,cosine))*180/Math.PI;if(angle===undefined||degrees>angle){angle=degrees;if(c.continuity!=='G0')failingPoint=point.toTuple();}}finally{a.delete();b.delete();}
      if(c.continuity==='G2'){const difference=curvatureDifference(oc,face,c.support,point.toTuple());if(curvature===undefined||difference>curvature){curvature=difference;failingPoint=point.toTuple();}}
     }
    }finally{vertex.delete();point.delete();}
   }
   return {constraint:index,samples:33,g0BuilderMaximumMm:builder.G0Error(),g1ReportedRad:c.continuity!=='G0'?builder.G1Error():undefined,g2Reported:c.continuity==='G2'?builder.G2Error():undefined,g2SampledPerMm:curvature,g0SampledMm:gap,g1SampledDeg:angle,failingPoint,requested:c.continuity};
  });
  const pointResiduals=(p.points??[]).map(point=>{const vertex=makeVertex(point);try{return {point,distanceMm:measureDistanceBetween(vertex,face)};}finally{vertex.delete();}});
  const diagnostics={pointResiduals,fitToleranceMm,attempt:tight?2:1,method:'OCCT MakeFilling; 33 uniform edge-parameter samples per constraint, exact trimmed-face distance, support normals and second fundamental forms; sampled only',residuals,tolerances:p.tolerances,curvature:'inverse mm; Frobenius difference in a common orthonormal tangent frame; sampled, not a global certificate'};
  if(pointResiduals.some(r=>!Number.isFinite(r.distanceMm)||r.distanceMm>p.tolerances.g0Mm)||residuals.some(r=>!Number.isFinite(r.g0SampledMm)||!Number.isFinite(r.g0BuilderMaximumMm)||r.g0SampledMm>p.tolerances.g0Mm||r.g0BuilderMaximumMm>p.tolerances.g0Mm||r.requested!=='G0'&&(r.g1SampledDeg===undefined||!Number.isFinite(r.g1SampledDeg)||r.g1SampledDeg>p.tolerances.g1Deg||(r.g1ReportedRad??Infinity)>p.tolerances.g1Deg*Math.PI/180)||r.requested==='G2'&&(r.g2SampledPerMm===undefined||r.g2SampledPerMm>p.tolerances.g2!)))throw new CadError('CONTINUITY_NOT_MET','Candidate sheet does not meet the requested measured continuity. Model and history remain unchanged.',{...diagnostics,candidate:face.mesh()});
  const analyzer=own(new oc.BRepCheck_Analyzer(face.wrapped,true,false,true));
  if(!analyzer.IsValid()){
    const topological=own(new oc.BRepCheck_Analyzer(face.wrapped,false,false,true)),invalidEdges:number[]=[];
    const edges=indexedShapes(oc,face.wrapped,'EDGE');try{edges.forEach((edge,index)=>{if(!analyzer.IsValid(edge))invalidEdges.push(index);});}finally{edges.forEach(edge=>edge.delete());}
    throw new CadError('FILL_INVALID_SHEET','Candidate passes sampled residual checks but fails OCCT face validity.',{...diagnostics,nativeValidity:{topology:topological.IsValid(),invalidEdges},candidate:face.mesh()});
  }
  return {shape:result,diagnostics};
 }catch(error){result?.delete();throw error;}finally{for(const v of owned.reverse())v.delete();}
}
export function joinSheets(oc:OpenCascadeInstance,p:Extract<Feature,{kind:'join'}>['params'],shapes:Map<string,Shape3D>,history:ShapeHistory){
 const owned:{delete():void}[]=[],own=<T extends{delete():void}>(v:T):T=>{owned.push(v);return v;};
 try{
  if(p.replaceFaces.feature!==p.target)throw new CadError('REFERENCE_SCOPE','replaceFaces must belong to target.');
  const target=shapes.get(p.target)!,remove=faces(oc,target,p.replaceFaces,history);remove.forEach(own);
  const sewing=own(new oc.BRepBuilderAPI_Sewing(p.toleranceMm,true,true,true,false));
  sewing.SetMaxTolerance(p.toleranceMm);
  const raw=indexedShapes(oc,target.wrapped,'FACE');raw.forEach(own);
  for(const f of raw)if(!remove.some(r=>r.wrapped.IsSame(f)))sewing.Add(f);
  for(const id of p.surfaces){const shape=shapes.get(id)!;const solids=indexedShapes(oc,shape.wrapped,'SOLID');try{if(solids.length)throw new CadError('JOIN_REQUIRES_SHEET','Join surfaces must be construction sheets.');}finally{solids.forEach(s=>s.delete());}sewing.Add(shape.wrapped);}
  sewing.Perform();const freeEdges=sewing.NbFreeEdges(),multipleEdges=sewing.NbMultipleEdges(),midpoints:Vector3[]=[];
  for(let i=1;i<=Math.min(freeEdges,32);i++){const edge=own(new Edge(sewing.FreeEdge(i))),point=own(edge.pointAt(0.5));midpoints.push(point.toTuple());}
  const diagnostics={freeEdges,multipleEdges,freeEdgeMidpoints:midpoints,sewingToleranceMm:p.toleranceMm,removedFaces:remove.length,healing:'none; all shells retained'};
  if(freeEdges||multipleEdges)throw new CadError(freeEdges?'JOIN_FREE_EDGES':'JOIN_NON_MANIFOLD','Sewing did not produce a closed manifold boundary.',diagnostics);
  const sewed=own(sewing.SewedShape()),shells=indexedShapes(oc,sewed,'SHELL');shells.forEach(own);
  if(!shells.length)throw new CadError('JOIN_NOT_SOLID','Sewing produced no shell.',diagnostics);
  const maker=own(new oc.BRepBuilderAPI_MakeSolid());for(const shell of shells){const typed=own(oc.TopoDS.Shell(shell));maker.Add(typed);}
  const solid=own(maker.Solid());
  // Orient shells without a topology-changing heal. Retain cavities; validity and exact volume checked by caller.
  if(!oc.BRepLib.OrientClosedSolid(solid))throw new CadError('JOIN_NOT_SOLID','Closed shells could not be oriented.',diagnostics);
  const check=own(new oc.BRepCheck_Analyzer(solid,true,false,true));if(!check.IsValid())throw new CadError('JOIN_NOT_SOLID','Sewn result fails exact solid validation.',diagnostics);
  const shape=cast(solid).asShape3D();
  try{
   const resultFaces=indexedShapes(oc,shape.wrapped,'FACE').map(r=>{try{return own(new Face(oc.TopoDS.Face(r)));}finally{r.delete();}}),resultEdges=indexedShapes(oc,shape.wrapped,'EDGE').map(r=>{try{return own(new Edge(oc.TopoDS.Edge(r)));}finally{r.delete();}});
   const sheetEdges=p.surfaces.flatMap(id=>indexedShapes(oc,shapes.get(id)!.wrapped,'EDGE').map(r=>{try{return own(new Edge(oc.TopoDS.Edge(r)));}finally{r.delete();}}));
   const seams=[];
   for(const edge of resultEdges){
    const probes=[0.25,0.5,0.75].map(t=>own(makeVertex(own(edge.pointAt(t)).toTuple())));
    if(!probes.every(v=>sheetEdges.some(e=>measureDistanceBetween(v,e)<=p.toleranceMm)))continue;
    const adjacent=resultFaces.filter(f=>{const es=indexedShapes(oc,f.wrapped,'EDGE');try{return es.some(e=>e.IsSame(edge.wrapped));}finally{es.forEach(e=>e.delete());}});
    if(adjacent.length!==2)throw new CadError('JOIN_NON_MANIFOLD','A sheet seam does not have exactly two incident faces.',diagnostics);
    let maxAngleDeg=0,maxGapMm=0,maxCurvaturePerMm:number|undefined,failingPoint:Vector3=[0,0,0];
    for(let i=1;i<16;i++){const point=own(edge.pointAt(i/16)),vertex=own(makeVertex(point.toTuple())),a=own(adjacent[0].normalAt(point)),b=own(adjacent[1].normalAt(point));
      const angle=Math.acos(Math.min(1,Math.abs(a.toTuple().reduce((n,v,k)=>n+v*b.toTuple()[k],0))))*180/Math.PI;
      if(angle>=maxAngleDeg){maxAngleDeg=angle;failingPoint=point.toTuple();}maxGapMm=Math.max(maxGapMm,...adjacent.map(f=>measureDistanceBetween(vertex,f)));
      if(p.continuity?.maxCurvaturePerMm!==undefined){const curvature=curvatureDifference(oc,adjacent[0],adjacent[1],point.toTuple());if(maxCurvaturePerMm===undefined||curvature>maxCurvaturePerMm){maxCurvaturePerMm=curvature;failingPoint=point.toTuple();}}
    }
    seams.push({samples:15,maxGapMm,maxAngleDeg,...(maxCurvaturePerMm===undefined?{}:{maxCurvaturePerMm}),failingPoint});
   }
   const measured={...diagnostics,seams,measurement:'15 interior edge-parameter samples on sheet seams; exact face distances, normals and optional second fundamental forms in inverse mm; sampled, not a global certificate'};
   if(seams.some(s=>!Number.isFinite(s.maxGapMm)||s.maxGapMm>p.toleranceMm||!Number.isFinite(s.maxAngleDeg)||p.continuity&&s.maxAngleDeg>p.continuity.maxAngleDeg||p.continuity?.maxCurvaturePerMm!==undefined&&(s.maxCurvaturePerMm===undefined||!Number.isFinite(s.maxCurvaturePerMm)||s.maxCurvaturePerMm>p.continuity.maxCurvaturePerMm)))throw new CadError('CONTINUITY_NOT_MET','Joined sheet seam misses the requested sampled continuity.',{...measured,candidate:shape.mesh()});
   history.sewn(shape,sewing,[target,...p.surfaces.map(id=>shapes.get(id)!)]);return {shape,diagnostics:measured};}catch(error){shape.delete();throw error;}
 }finally{for(const value of owned.reverse())value.delete();}
}
