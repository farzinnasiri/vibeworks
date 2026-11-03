import type { OpenCascadeInstance, BRepAdaptor_Curve, Geom_BSplineCurve, Geom_BezierCurve } from 'replicad-opencascadejs';
import {CadError} from './document';
const choose=(n:number,k:number)=>{let v=1;for(let i=1;i<=k;i++)v=v*(n-i+1)/i;return v;};
function product(a:number[],b:number[]){const n=a.length-1,m=b.length-1;return Array.from({length:n+m+1},(_,k)=>{let s=0;for(let i=Math.max(0,k-m);i<=Math.min(n,k);i++)s+=a[i]*b[k-i]*choose(n,i)*choose(m,k-i)/choose(n+m,k);return s;});}
function halves(values:number[]){const left=[values[0]],right=[values.at(-1)!];let row=values;while(row.length>1){row=row.slice(1).map((v,i)=>(v+row[i])/2);left.push(row[0]);right.push(row.at(-1)!);}return[left,right.reverse()];}
/** Bernstein sign variation bounds all real derivative roots on each rational Bezier span. */
function roots(curve:Geom_BSplineCurve|Geom_BezierCurve,extreme:number[]){
 const degree=curve.Degree();if(degree>16||curve.NbPoles()!==degree+1)throw new CadError('CREST_UNSUPPORTED','Crest supports rational section spans of degree at most 16.');
 const weights=Array.from({length:degree+1},(_,i)=>curve.Weight(i+1)),max=Math.max(...weights),w=weights.map(x=>x/max),p0=curve.Pole(1),origin=[p0.X(),p0.Y(),p0.Z()];p0.delete();
 const q=w.map((weight,i)=>{const p=curve.Pole(i+1);try{return weight*([p.X(),p.Y(),p.Z()].reduce((s,v,k)=>s+(v-origin[k])*extreme[k],0));}finally{p.delete();}});
 const derivative=(v:number[])=>v.slice(1).map((x,i)=>degree*(x-v[i]));
 const a=product(derivative(q),w),b=product(q,derivative(w)),coefficients=a.map((v,i)=>v-b[i]),scale=Math.max(...coefficients.map(Math.abs)),epsilon=Math.max(1,scale)*1e-13;
 if(scale<=epsilon)return[]; // Endpoints below detect a flat, spatially extended maximum as ambiguous.
 const found:number[]=[],stack=[{c:coefficients,a:0,b:1,depth:0}];let visited=0;
 while(stack.length){if(++visited>8192)throw new CadError('CREST_UNRESOLVED','Section extrema exceed the bounded root-isolation budget.');const node=stack.pop()!,signs=node.c.filter(v=>Math.abs(v)>epsilon).map(v=>Math.sign(v)),changes=signs.slice(1).filter((v,i)=>v!==signs[i]).length;
  if(Math.abs(node.c[0])<=epsilon)found.push(node.a);if(Math.abs(node.c.at(-1)!)<=epsilon)found.push(node.b);
  if(!changes)continue;
  if(node.depth>=40){if(changes>1)throw new CadError('CREST_UNRESOLVED','Several section extrema cannot be isolated at numerical precision.');found.push((node.a+node.b)/2);continue;}
  const [left,right]=halves(node.c),mid=(node.a+node.b)/2;stack.push({c:right,a:mid,b:node.b,depth:node.depth+1},{c:left,a:node.a,b:mid,depth:node.depth+1});
 }
 return found.filter((v,i)=>found.findIndex(x=>Math.abs(x-v)<1e-9)===i);
}
export function splineExtrema(oc:OpenCascadeInstance,curve:BRepAdaptor_Curve,extreme:number[]):number[]|undefined{
 const type=curve.GetType();
 if(type===oc.GeomAbs_CurveType.GeomAbs_BezierCurve){const original=curve.Bezier(),copy=new oc.Geom_BezierCurve(original);original.delete();try{const a=curve.FirstParameter(),b=curve.LastParameter();copy.Segment(a,b);return roots(copy,extreme).map(t=>a+(b-a)*t);}finally{copy.delete();}}
 if(type!==oc.GeomAbs_CurveType.GeomAbs_BSplineCurve)return undefined;
 const spline=curve.BSpline();try{
  if(spline.NbKnots()>2048)throw new CadError('CREST_UNSUPPORTED','Crest supports at most 2048 section knots.');
  const first=curve.FirstParameter(),last=curve.LastParameter(),bounds=[first,...Array.from({length:spline.NbKnots()},(_,i)=>spline.Knot(i+1)).filter(k=>k>first+1e-12&&k<last-1e-12),last];
  if(spline.Degree()===1)return bounds;
  return bounds.slice(1).flatMap((b,i)=>{const a=bounds[i],copy=new oc.Geom_BSplineCurve(spline);try{copy.Segment(a,b,1e-12);return[a,b,...roots(copy,extreme).map(t=>a+(b-a)*t)];}finally{copy.delete();}});
 }finally{spline.delete();}
}
