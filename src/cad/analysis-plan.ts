import { ENGINE_VERSION, type AnalysisLeaf, type CheckTarget } from '../shared/protocol';
import { identityMatrix, multiplyMatrix } from '../shared/display';
import type { Fingerprint } from './result-cache';
export const ANALYSIS_ALGORITHM = 'leaf-exact-v2';
export interface DurablePair { key:string; value:{gap:number;common?:{overlap:number}} }
export type AnalysisEvent = {type:'pair';key:string;a:string;b:string} | {type:'fact';fact:DurablePair} | {type:'failure';key:string;a:string;b:string;error:string} | {type:'leaves';leaves:AnalysisLeaf[]};
export interface AnalysisControl { facts?:DurablePair[]; excluded?:string[]; pairLimit?:number; retryKey?:string; retryPair?:{a:string;b:string} }
export function fullDescriptor(f:Fingerprint):unknown {const nodes:unknown[]=[];const seen=new Map<Fingerprint,number>();const visit=(node:Fingerprint):number=>{const found=seen.get(node);if(found!==undefined)return found;const inputs=node.inputs.map(visit),index=nodes.length;nodes.push([node.descriptor,inputs]);seen.set(node,index);return index;};return {root:visit(f),nodes};}
function inverseRigid(m:number[]):number[]{const n=identityMatrix();for(let i=0;i<3;i++)for(let j=0;j<3;j++)n[i+j*4]=m[j+i*4];for(let i=0;i<3;i++)n[12+i]=-(n[i]*m[12]+n[4+i]*m[13]+n[8+i]*m[14]);return n;}
/** Both operand orders are canonicalized with their own relative frame. Scale and reflection are baked into the local construction. */
export function pairDescriptor(a:{descriptor:string;matrix:number[]},b:{descriptor:string;matrix:number[]}):string {
 const order=(x:typeof a,y:typeof a)=>JSON.stringify([ANALYSIS_ALGORITHM,ENGINE_VERSION,x.descriptor,y.descriptor,multiplyMatrix(inverseRigid(x.matrix),y.matrix).map(v=>Object.is(v,-0)?0:v)]);
 const ab=order(a,b),ba=order(b,a);return ab<ba?ab:ba;
}
export function matchesLeaf(leaf:AnalysisLeaf,target:CheckTarget):boolean {const t=typeof target==='string'?{feature:target}:target;return leaf.feature===t.feature&&(!t.path||t.path.every((id,i)=>leaf.path[i]===id))&&(t.solidIndex===undefined||t.solidIndex===leaf.solidIndex);}
export function boundsGap(a:AnalysisLeaf['bounds'],b:AnalysisLeaf['bounds']):number {return Math.hypot(...[0,1,2].map(i=>Math.max(0,a.min[i]-b.max[i],b.min[i]-a.max[i])));}
