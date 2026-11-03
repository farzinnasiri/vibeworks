import type { Feature, PaintRegion, Vector3 } from '../shared/protocol';
import {identityMatrix,multiplyMatrix,placementMatrix} from '../shared/display';
type Style=NonNullable<Feature['surfaceStyles']>[number];
function copies(feature:Feature):{prefix:string;m:number[];scale:number}[]{
 if(feature.kind==='pattern'){
  const l=feature.params.layout;
  return Array.from({length:l.count},(_,i)=>({prefix:`copy${i}:`,scale:1,m:l.type==='linear'?placementMatrix({translation:l.direction.map(v=>v/Math.hypot(...l.direction)*l.spacing*i),angleDegrees:0,origin:[0,0,0],rotationAxis:[0,0,1]}):placementMatrix({translation:[0,0,0],angleDegrees:i*(l.angleDegrees>=360?360/l.count:l.angleDegrees/(l.count-1)),origin:l.origin,rotationAxis:l.axis})}));
 }
 if(feature.kind==='transform'){
  const p=feature.params,s=p.scale,m=identityMatrix();m[0]=m[5]=m[10]=s;for(let i=0;i<3;i++)m[12+i]=p.origin[i]*(1-s);
  return[{prefix:'',scale:s,m:multiplyMatrix(placementMatrix(p),m)}];
 }
 if(feature.kind==='mirror'){
  const m=identityMatrix(),i=feature.params.plane==='XY'?2:feature.params.plane==='XZ'?1:0;m[i*5]=-1;m[12+i]=2*feature.params.origin[i];return[{prefix:'',scale:1,m}];
 }
 return[{prefix:'',scale:1,m:identityMatrix()}];
}
function mapped(feature:Feature,slot:number,target:Style['target'],copy:ReturnType<typeof copies>[number]){
 const {m,scale}=copy;
 const point=(p:number[],direction=false)=>p.map((_,i)=>(m[i]*p[0]+m[4+i]*p[1]+m[8+i]*p[2])/(direction?scale:1)+(direction?0:m[12+i])) as Vector3;
 const signature=target.signature?{...target.signature,areaMm2:target.signature.areaMm2*scale*scale,...(target.signature.shapeSamples?{shapeSamples:target.signature.shapeSamples.map(p=>point(p))}:{}),...(target.signature.normal?{normal:point(target.signature.normal,true)}:{})}:undefined;
 return{point,target:{...target,feature:feature.id,path:[],signature,select:'faces'in target.select?{...target.select,faces:target.select.faces.map(n=>`${copy.prefix}in${slot}:${n}`)}:target.select}};
}
export function inheritStyles(feature:Feature,slot:number,styles:Style[]):Style[]{return copies(feature).flatMap(copy=>styles.map(style=>({...style,target:mapped(feature,slot,style.target,copy).target})));}
export function inheritRegions(feature:Feature,slot:number,regions:PaintRegion[]):PaintRegion[]{
 return copies(feature).flatMap((copy,i)=>regions.map(region=>{
  const {target,point}=mapped(feature,slot,region.target,copy);
  return{...region,id:`in${slot}_${i}_${region.id}`,target,keep:region.keep.map(predicate=>{
   if('side'in predicate)return{side:{plane:{origin:point(predicate.side.plane.origin),normal:point(predicate.side.plane.normal,true)}}};
   if('iso'in predicate)return predicate;
   const c=predicate.crest,axis=point(c.axis,true),length=Math.hypot(...axis),unit=axis.map(v=>v/length),origin=point([0,0,0]),shift=origin.reduce((s,v,j)=>s+v*unit[j],0);
   return{crest:{...c,toward:feature.kind==='mirror'?(c.toward==='positive'?'negative':'positive'):c.toward,axis,extreme:point(c.extreme,true),fromMm:c.fromMm*copy.scale+shift,toMm:c.toMm*copy.scale+shift,toleranceMm:c.toleranceMm*copy.scale}};
  })};
 }));
}
