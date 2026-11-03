import {VIEW_DIRECTIONS,type ViewName} from '../shared/protocol';
/** A world-axis cube projected from the actual named direction, rather than a reused generic icon. */
export function ViewOrientation({view,size=28}:{view:ViewName;size?:number}){
 const normalize=(a:number[])=>{const n=Math.hypot(...a);return a.map(v=>v/n);};
 const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const dot=(a:number[],b:number[])=>a.reduce((n,v,i)=>n+v*b[i],0);
 const direction=normalize(VIEW_DIRECTIONS[view]),right=normalize(cross(Math.abs(direction[2])>.99?[0,1,0]:[0,0,1],direction)),up=cross(direction,right);
 const point=(p:number[])=>[18+dot(p,right)*11,18-dot(p,up)*11];
 const faces=[{axis:0,name:'X',corners:[[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]]},{axis:1,name:'Y',corners:[[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]]},{axis:2,name:'Z',corners:[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]}];
 return <svg width={size} height={size} viewBox="0 0 36 36" className="view-orientation" aria-hidden="true">{faces.map(f=>{
  if(Math.abs(direction[f.axis])<.0001)return null;const sign=Math.sign(direction[f.axis]);
  const corners=f.corners.map(p=>{const q=p.map(v=>v*.65);q[f.axis]*=sign;return point(q);});const center=[0,0,0];center[f.axis]=.66*sign;const label=point(center);
  return <g key={f.name}><polygon points={corners.map(p=>p.join(',')).join(' ')} fill={`var(--${f.name.toLowerCase()})`} fillOpacity={sign>0?.3:.12} stroke="currentColor" strokeWidth="1"/><text x={label[0]} y={label[1]+2} fill="currentColor" fontSize="6" textAnchor="middle">{sign<0?'−':''}{f.name}</text></g>;
 })}</svg>;
}
