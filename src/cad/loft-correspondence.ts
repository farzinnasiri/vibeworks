import { assembleWire, Edge, getOC, type Wire } from 'replicad';
import type { Feature, Vector3 } from '../shared/protocol';
import { CadError } from './document';
import { indexedShapes } from './topology';
type Section=Extract<Feature,{kind:'loft'}>['params']['sections'][number];
/** Splits use the original exact curve. Arclength inversion uses OCCT's exact-curve mass integrator. */
export function authoredWire(wire:Wire, section:Section){
 const oc=getOC(), raw=indexedShapes(oc,wire.wrapped,'EDGE'),edges=raw.map(r=>new Edge(oc.TopoDS.Edge(r)));raw.forEach(r=>r.delete());
 const pieces:Edge[]=[], names:string[]=[],positions:number[]=[],vertices:Vector3[]=[];
 const lengths=edges.map(e=>e.length),total=lengths.reduce((a,b)=>a+b,0);
 const ids=section.profile.type==='polygon'?section.profile.segmentIds:section.profile.type==='path'?section.profile.segments.map((s,i)=>s.id??String(i)):undefined;
 const seam=section.seam??0;
 const split=[...new Set([seam,...(section.splitAt??[])])].sort((a,b)=>a-b);
 let offset=0;
 try{
  for(const [i,edge] of edges.entries()){
   const start=offset/total,end=(offset+lengths[i])/total;
   const cuts=[start,...split.filter(t=>t>start+1e-9&&t<end-1e-9),end];
   const curve=oc.BRep_Tool.Curve(edge.wrapped);
   const reverse=edge.orientation==='backward';
   const parameter=(t:number)=>{
    if(t<=start+1e-12)return reverse?curve.Last:curve.First;
    if(t>=end-1e-12)return reverse?curve.First:curve.Last;
    const wanted=(t-start)*total;let lo=curve.First,hi=curve.Last;
    for(let k=0;k<40;k++){
     const mid=(lo+hi)/2,maker=new oc.BRepBuilderAPI_MakeEdge(curve.returnValue,reverse?mid:curve.First,reverse?curve.Last:mid),part=new Edge(maker.Edge());
     let length:number;try{length=part.length;}finally{part.delete();maker.delete();}
     if((length<wanted)!==reverse)lo=mid;else hi=mid;
    }return (lo+hi)/2;
   };
   try{for(let j=0;j<cuts.length-1;j++){
    const a=parameter(cuts[j]),b=parameter(cuts[j+1]),maker=new oc.BRepBuilderAPI_MakeEdge(curve.returnValue,Math.min(a,b),Math.max(a,b));
    try{const e=new Edge(maker.Edge());if(reverse)e.wrapped.Reverse();pieces.push(e);positions.push(cuts[j]);names.push(`${ids?.[i]??i}${cuts.length>2?`@${j}`:''}`);}finally{maker.delete();}
   }}finally{curve.returnValue.delete();}
   offset+=lengths[i];
  }
  let first=positions.findIndex(t=>Math.abs(t-seam)<1e-8);if(first<0)throw new CadError('LOFT_CORRESPONDENCE','Seam could not be located.');
  let ordered=pieces.map((_,i)=>(i+first)%pieces.length);
  if(section.reverse){ordered=ordered.reverse();for(const i of ordered)pieces[i].wrapped.Reverse();}
  const orderedNames=ordered.map(i=>names[i]);
  if(section.mapping&&(section.mapping.length!==ordered.length||section.mapping.some((n,i)=>n!==orderedNames[i])))throw new CadError('LOFT_CORRESPONDENCE','mapping must list each segment in its connected traversal order. Set seam/reverse to change traversal.',{available:orderedNames,requested:section.mapping});
  for(const i of ordered){const e=pieces[i],p=section.reverse?e.endPoint:e.startPoint;try{vertices.push(p.toTuple());}finally{p.delete();}}
  const outline:number[]=[];
  for(const i of ordered)for(let j=0;j<16;j++){const a=pieces[i].pointAt(j/16),b=pieces[i].pointAt((j+1)/16);try{outline.push(...a.toTuple(),...b.toTuple());}finally{a.delete();b.delete();}}
  return {outline,wire:assembleWire(ordered.map(i=>pieces[i])),names:orderedNames,positions:ordered.map(i=>positions[i]),vertices,perimeterMm:total,seam,reverse:section.reverse??false};
 }finally{pieces.forEach(e=>e.delete());edges.forEach(e=>e.delete());}
}
