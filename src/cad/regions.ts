import {cast,makeVertex,measureDistanceBetween} from 'replicad';
import {splineExtrema} from './crest-extrema';
import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import type { Appearance, DisplayMesh, PaintRegion, Vector3 } from '../shared/protocol';
import { indexedShapes } from './topology';
import { CadError } from './document';
import { resolveFaces } from './surface-reference';
const dot=(a:number[],b:number[])=>a.reduce((s,v,i)=>s+v*b[i],0);
const sub=(a:number[],b:number[])=>a.map((v,i)=>v-b[i]);
const unit=(v:number[])=>v.map(x=>x/Math.hypot(...v));
type UV=[number,number];
type Vertex={uv:UV;p:number[];n:number[]};

/** Bounded, numerical extrema of exact trimmed section curves. Every sampled local maximum is refined. */
export function sectionMaximum(oc:OpenCascadeInstance,face:TopoDS_Shape,axis:number[],station:number,extreme:number[],toleranceMm:number) {
 const owned:{delete():void}[]=[];const own=<T extends {delete():void}>(v:T)=>{owned.push(v);return v;};
 const candidates:{p:number[];value:number;endpoint?:boolean}[]=[],endpoints:{p:number[];rising:boolean}[]=[];
 try {
  const origin=axis.map(v=>v*station) as Vector3;
  const plane=own(new oc.gp_Pln(own(new oc.gp_Pnt(...origin)),own(new oc.gp_Dir(...axis as Vector3))));
  const section=own(new oc.BRepAlgoAPI_Section(face,plane,false));
  // Walking-line polylines can create artificial flat maxima. Ask OCCT for its
  // fitted intersection curve and p-curve, then check its support residual below.
  section.Approximation(true);section.ComputePCurveOn1(true);section.Build();
  const raw=own(section.Shape()),edges=indexedShapes(oc,raw,'EDGE');
  try { for(const edge of edges) {
   const typed=oc.TopoDS.Edge(edge),curve=new oc.BRepAdaptor_Curve(typed);typed.delete();
   try {
    const first=curve.FirstParameter(),last=curve.LastParameter();
    if(!Number.isFinite(first+last)||last<=first)continue;
    const value=(t:number)=>{const point=curve.Value(t);try{const p=[point.X(),point.Y(),point.Z()];return{p,value:dot(p,extreme),endpoint:Math.abs(t-first)<1e-12||Math.abs(t-last)<1e-12};}finally{point.delete();}};
    for(const [t,sign]of[[first,1],[last,-1]]){
      const d=curve.EvalD1(t);try{const tangent=[d.D1.X(),d.D1.Y(),d.D1.Z()];endpoints.push({p:[d.Point.X(),d.Point.Y(),d.Point.Z()],rising:sign*dot(tangent,extreme)>Math.hypot(...tangent)*1e-8});}finally{d.Point.delete();d.D1.delete();}
    }
    const extrema=splineExtrema(oc,curve,extreme);
    if(extrema){const parameters=[first,...extrema,last].sort((a,b)=>a-b).filter((v,i,a)=>!i||Math.abs(v-a[i-1])>1e-12),values=parameters.map(value);candidates.push(...values.filter((v,i)=>(!i||v.value>=values[i-1].value)&&(i===values.length-1||v.value>=values[i+1].value)));}
    else {
      // Conics have at most two isolated extrema per period. Other curve classes fail explicitly.
      const type=curve.GetType();
      if(!new Set<string>([oc.GeomAbs_CurveType.GeomAbs_Line,oc.GeomAbs_CurveType.GeomAbs_Circle,oc.GeomAbs_CurveType.GeomAbs_Ellipse,oc.GeomAbs_CurveType.GeomAbs_Parabola,oc.GeomAbs_CurveType.GeomAbs_Hyperbola]).has(type))throw new CadError('CREST_UNSUPPORTED','This exact section curve type has no bounded extrema solver.');
      const count=256,samples=Array.from({length:count+1},(_,i)=>value(first+(last-first)*i/count));
      candidates.push(samples[0],samples[count]);
      for(let i=1;i<count;i++)if(samples[i].value>=samples[i-1].value&&samples[i].value>=samples[i+1].value){
        let a=first+(last-first)*(i-1)/count,b=first+(last-first)*(i+1)/count;
        for(let j=0;j<32;j++){const l=a+(b-a)*0.38196601125,r=a+(b-a)*0.61803398875;if(value(l).value<value(r).value)a=l;else b=r;}
        candidates.push(value((a+b)/2));
      }
    }
   } finally {curve.delete();}
  }} finally{edges.forEach(e=>e.delete());}
  // A section can be split into several native edges. Their common endpoints are
  // not extrema when an incident edge continues uphill; do not report false crests.
  for(let i=candidates.length-1;i>=0;i--)if(candidates[i].endpoint&&endpoints.some(e=>e.rising&&Math.hypot(...sub(e.p,candidates[i].p))<=Math.max(1e-7,toleranceMm*1e-4)))candidates.splice(i,1);
  candidates.sort((a,b)=>b.value-a.value);
  if(!candidates.length)throw new CadError('CREST_NOT_FOUND','The section does not meet this support face.',{station});
  const best=candidates[0];
  if(candidates.some(c=>best.value-c.value<=toleranceMm&&Math.hypot(...sub(c.p,best.p))>4*toleranceMm))throw new CadError('CREST_AMBIGUOUS','Several section extrema lie within the dimensional crest tolerance.',{station,toleranceMm,candidates:candidates.slice(0,8)});
  const probe=makeVertex(best.p as Vector3),support=cast(face);try{const residual=measureDistanceBetween(probe,support);if(residual>toleranceMm)throw new CadError('CREST_UNRESOLVED','The numerical section maximum exceeds the support residual tolerance.',{station,residualMm:residual,toleranceMm});}finally{probe.delete();support.delete();}
  return best.p;
 } finally {owned.reverse().forEach(v=>v.delete());}
}
export function crestBoundary(oc:OpenCascadeInstance,face:TopoDS_Shape,c:Extract<PaintRegion['keep'][number],{crest:unknown}>['crest']) {
 const axis=unit(c.axis),extreme=unit(c.extreme),lateral=unit([axis[1]*extreme[2]-axis[2]*extreme[1],axis[2]*extreme[0]-axis[0]*extreme[2],axis[0]*extreme[1]-axis[1]*extreme[0]]);
 if(!lateral.every(Number.isFinite))throw new CadError('REGION_UNSUPPORTED','Crest axis and extreme must be independent.');
 const samples:{s:number;p:number[]}[]=[];
 const sample=(s:number)=>({s,p:sectionMaximum(oc,face,axis,s,extreme,c.toleranceMm/4)});
 for(let i=0;i<=32;i++)samples.push(sample(c.fromMm+(c.toMm-c.fromMm)*i/32));
 for(let i=0;i<samples.length-1;i++){
  const a=samples[i],b=samples[i+1],mid=sample((a.s+b.s)/2),pred=a.p.map((v,k)=>(v+b.p[k])/2);
  if(Math.hypot(...sub(mid.p,pred))>c.toleranceMm){if(samples.length>=400)throw new CadError('CREST_LIMIT','Crest chord tolerance could not be met within 400 stations.',{toleranceMm:c.toleranceMm});samples.splice(i+1,0,mid);i--;}
 }
 for(let i=1;i<samples.length;i++)if(Math.hypot(...sub(samples[i].p,samples[i-1].p))>4*(samples[i].s-samples[i-1].s))throw new CadError('CREST_DISCONTINUOUS','The numerical crest jumps between stations.',{station:samples[i].s});
 return {samples,side:(point:number[])=>{
  const s=dot(point,axis);
  const clamped=Math.max(c.fromMm,Math.min(c.toMm,s));
  let i=samples.findIndex(x=>x.s>=clamped);if(i<1)i=1;
  const a=samples[i-1],b=samples[i],t=(clamped-a.s)/(b.s-a.s),p=a.p.map((v,k)=>v+(b.p[k]-v)*t);
  return dot(sub(point,p),lateral)*(c.toward==='positive'?1:-1);
 }};
}
/** Triangular display approximation. UV crossing points are evaluated on exact support surfaces. */
export function regionMeshes(oc:OpenCascadeInstance,shape:TopoDS_Shape,mesh:DisplayMesh,regions:(PaintRegion&{from?:import('../shared/protocol').AppearanceOrigin;fieldOrigins?:Record<string,import('../shared/protocol').AppearanceOrigin>})[],faceLooks:Map<number,Appearance>,faceOrigins:Map<number,NonNullable<DisplayMesh['appearanceOrigins']>>=new Map(),meshToleranceMm=0.05):DisplayMesh[]{
 if(regions.length>32)throw new CadError('REGION_LIMIT','A result supports at most 32 expanded paint regions. Reduce the pattern or split the authored results.');
 const faces=indexedShapes(oc,shape,'FACE'),groups=new Map<string,DisplayMesh>(),areas=new Map<string,number>(),supportedAreas=new Set<string>();
 let nodeOffset=0,values=0,crossingResidualMm=0,crossingResidualUV=0;
 const graphicBounds=mesh.graphicBounds??{min:mesh.vertices.slice(0,3) as Vector3,max:mesh.vertices.slice(0,3) as Vector3};
 if(!mesh.graphicBounds)for(let i=3;i<mesh.vertices.length;i++){const axis=i%3;graphicBounds.min[axis]=Math.min(graphicBounds.min[axis],mesh.vertices[i]);graphicBounds.max[axis]=Math.max(graphicBounds.max[axis],mesh.vertices[i]);}
 const uvTests=new WeakSet<(v:Vertex)=>number>();
 const group=(appearance:Appearance|undefined,originKey:string)=>{const key=JSON.stringify([appearance,originKey]);let g=groups.get(key);if(!g){g={...mesh,graphicBounds,appearance,vertices:[],normals:[],triangles:[],faceRanges:[],lines:groups.size?[]:mesh.lines,edgeRanges:groups.size?[]:mesh.edgeRanges};groups.set(key,g);}return g;};
 const support=regions.map(r=>new Set(resolveFaces(mesh.topology!,r.target)));
 try { faces.forEach((raw,index)=>{
  const face=oc.TopoDS.Face(raw),location=new oc.TopLoc_Location(),tri=oc.BRep_Tool.Triangulation(face,location,0),surface=new oc.BRepAdaptor_Surface(face,true);
  try {
   const bounds=oc.BRepTools.UVBounds(face),rules=regions.flatMap((r,i)=>support[i].has(index)?[{r,tests:r.keep.flatMap(predicate=>{
     if('side'in predicate){const n=unit(predicate.side.plane.normal);return[(v:Vertex)=>dot(sub(v.p,predicate.side.plane.origin),n)];}
     if('crest'in predicate){const c=predicate.crest,axis=unit(c.axis),boundary=crestBoundary(oc,face,c);return[(v:Vertex)=>dot(v.p,axis)-c.fromMm,(v:Vertex)=>c.toMm-dot(v.p,axis),(v:Vertex)=>boundary.side(v.p)];}
     const {u,v}=predicate.iso;const tests:((p:Vertex)=>number)[]=[];
     if(u)tests.push(p=>(p.uv[0]-bounds.UMin)/(bounds.UMax-bounds.UMin)-u[0],p=>u[1]-(p.uv[0]-bounds.UMin)/(bounds.UMax-bounds.UMin));
     if(v)tests.push(p=>(p.uv[1]-bounds.VMin)/(bounds.VMax-bounds.VMin)-v[0],p=>v[1]-(p.uv[1]-bounds.VMin)/(bounds.VMax-bounds.VMin));
     tests.forEach(test=>uvTests.add(test));return tests;
   })}]:[]);
   const uvs:UV[]=[];for(let i=1;i<=tri.NbNodes();i++){const uv=tri.UVNode(i);uvs.push([uv.X(),uv.Y()]);uv.delete();}
   const vertex=(i:number):Vertex=>({uv:uvs[i-nodeOffset],p:mesh.vertices.slice(i*3,i*3+3),n:mesh.normals.slice(i*3,i*3+3)});
   const interpolate=(a:Vertex,b:Vertex,t:number):Vertex=>{const uv=a.uv.map((v,i)=>v+(b.uv[i]-v)*t) as UV,p=surface.Value(...uv);try{return{uv,p:[p.X(),p.Y(),p.Z()],n:unit(a.n.map((v,i)=>v+(b.n[i]-v)*t))};}finally{p.delete();}};
   const clip=(polygon:Vertex[],test:(v:Vertex)=>number,positive:boolean)=>{
    if(!positive&&polygon.every(v=>test(v)>=0))return [];
    const output:Vertex[]=[];
    for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length],av=test(a)*(positive?1:-1),bv=test(b)*(positive?1:-1);if(av>=0)output.push(a);if((av>=0)!==(bv>=0)){let lo=0,hi=1;for(let j=0;j<32;j++){const mid=(lo+hi)/2;if((test(interpolate(a,b,mid))>=0)===(test(a)>=0))lo=mid;else hi=mid;}const crossing=interpolate(a,b,(lo+hi)/2),residual=Math.abs(test(crossing));if(uvTests.has(test))crossingResidualUV=Math.max(crossingResidualUV,residual);else crossingResidualMm=Math.max(crossingResidualMm,residual);output.push(crossing);}}
    return output;
   };
   const emit=(polygon:Vertex[],look:Appearance|undefined,id?:string)=>{
    if(polygon.length<3)return;const g=group(look,JSON.stringify([id,faceOrigins.get(index)]));g.appearanceOrigins={...(faceOrigins.get(index)??mesh.appearanceOrigins),...(id?Object.fromEntries(Object.keys(regions.find(r=>r.id===id)!.look).map(k=>[k,regions.find(r=>r.id===id)!.fieldOrigins?.[k]??regions.find(r=>r.id===id)!.from??{documentId:mesh.source?.documentId??'',featureId:regions.find(r=>r.id===id)!.target.feature,layer:'region',styleId:id}])):{})};const start=g.triangles.length/3;
    for(let j=1;j<polygon.length-1;j++){
     const verts=[polygon[0],polygon[j],polygon[j+1]],a=sub(verts[1].p,verts[0].p),b=sub(verts[2].p,verts[0].p),area=Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])/2;
     if(area<1e-14)continue;if(id)areas.set(id,(areas.get(id)??0)+area);
     for(const v of verts){g.triangles.push(g.vertices.length/3);g.vertices.push(...v.p.map(Math.fround));g.normals.push(...v.n.map(Math.fround));values+=7;}
     if(values>2_000_000)throw new CadError('REGION_LIMIT','Region display exceeds two million added values.');
    }
    const count=g.triangles.length/3-start;if(count)g.faceRanges!.push(start,count,index,0);
   };
   for(let r=0;r<(mesh.faceRanges?.length??0);r+=4){if(mesh.faceRanges![r+2]!==index)continue;const start=mesh.faceRanges![r],count=mesh.faceRanges![r+1];
    for(let t=start;t<start+count;t++){
     let pieces:{polygon:Vertex[];look:Appearance|undefined;id?:string}[]=[{polygon:mesh.triangles.slice(t*3,t*3+3).map(vertex),look:faceLooks.get(index)??mesh.appearance}];
     for(const rule of rules){const next:typeof pieces=[];for(const piece of pieces){let inside=piece.polygon;for(const test of rule.tests){const outside=clip(inside,test,false);if(outside.length>=3)next.push({...piece,polygon:outside});inside=clip(inside,test,true);if(inside.length<3)break;}if(inside.length>=3){supportedAreas.add(rule.r.id);next.push({polygon:inside,look:{...piece.look,...rule.r.look},id:rule.r.id});}}pieces=next;}
     pieces.forEach(p=>emit(p.polygon,p.look,p.id));
    }
   }
   nodeOffset+=tri.NbNodes();
  } finally{tri.delete();surface.delete();location.delete();face.delete();}
 });
 for(const region of regions)if(!supportedAreas.has(region.id))throw new CadError('REGION_EMPTY',`Region '${region.id}' has no visible area on its support.`,{regionId:region.id});
 const output=[...groups.values()];if(output.length)output[0].regionReport={method:'exact-surface-UV predicates; triangular display boundary approximation',sectionBrackets:256,splineExtrema:'Bernstein derivative roots on trimmed knot spans',errors:{supportMeshToleranceMm:meshToleranceMm,crossingResidualMm,crossingResidualUV,boundary:'straight triangle chords; no exact CAD boundary or global error certification'},areas:regions.map(r=>({id:r.id,areaMm2:areas.get(r.id)??0,...(r.keep.some(p=>'crest'in p)?{crestChordToleranceMm:Math.max(...r.keep.flatMap(p=>'crest'in p?[p.crest.toleranceMm]:[]))}:{})}))};return output;
 } finally {faces.forEach(f=>f.delete());}
}
