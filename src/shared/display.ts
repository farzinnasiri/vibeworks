import { topologyTableSchema, type DisplayMesh, type RuntimeDelivery } from './protocol';

/** Column-major rigid transforms, compatible with Three Matrix4. */
export const identityMatrix = () => [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export function multiplyMatrix(a: number[], b: number[]): number[] {
  return Array.from({length:16},(_,i)=>{const row=i%4,col=Math.floor(i/4);let n=0;for(let k=0;k<4;k++)n+=a[k*4+row]*b[col*4+k];return n;});
}
export function placementMatrix(p: {rotationAxis:number[];angleDegrees:number;origin:number[];translation:number[]}): number[] {
 const len=Math.hypot(...p.rotationAxis),[x,y,z]=p.rotationAxis.map(v=>v/len),a=p.angleDegrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a),t=1-c;
 const m=[t*x*x+c,t*x*y+s*z,t*x*z-s*y,0,t*x*y-s*z,t*y*y+c,t*y*z+s*x,0,t*x*z+s*y,t*y*z-s*x,t*z*z+c,0,0,0,0,1];
 for(let i=0;i<3;i++)m[12+i]=p.origin[i]+p.translation[i]-m[i]*p.origin[0]-m[4+i]*p.origin[1]-m[8+i]*p.origin[2];return m;
}
export function worldMesh(mesh: DisplayMesh): DisplayMesh {
 if(!mesh.transform)return mesh;
 const m=mesh.transform;
 const move=(a:number[],normal=false)=>a.map((_,i)=>{const j=i%3,k=i-j;return m[j]*a[k]+m[4+j]*a[k+1]+m[8+j]*a[k+2]+(normal?0:m[12+j]);});
 const {transform,...base}=mesh;
 return {...base,vertices:move(mesh.vertices),normals:move(mesh.normals,true),lines:move(mesh.lines)};
}
export function displayValueCount(meshes: DisplayMesh[]): number {
 const seen=new Set<number[]>();let total=0;
 for(const mesh of meshes)for(const a of [mesh.vertices,mesh.normals,mesh.triangles,mesh.lines,mesh.faceRanges??[],mesh.edgeRanges??[]])if(!seen.has(a)){seen.add(a);total+=a.length;}
 return total;
}
/**
 * Display arrays travel as base64 of little-endian Float32 (positions, normals, edges) and Uint32 (indices): about
 * 5.3 bytes per value instead of about 15 as JSON numbers. Display data only; exact geometry never leaves Node.
 */
export const ASSET_ENCODING = 'f32-u32-topology-base64-v2';
type Asset = Pick<DisplayMesh,'vertices'|'normals'|'triangles'|'lines'|'topology'|'faceRanges'|'edgeRanges'>;
const FIELDS = ['vertices','normals','triangles','lines'] as const;
const base64Length = (values: number) => 4 * Math.ceil(values * 4 / 3);
/** Upper bound of the packed display size, so the kernel can choose a quality without serializing it. */
export function displayBytes(values: number, placements: number): number {
 // Four arrays per asset round up separately; metadata covers id, appearance and transform.
 return base64Length(values) + placements * 600;
}
const NodeBuffer = (globalThis as { Buffer?: { from(data: ArrayBufferLike | string, offsetOrEncoding?: number | string, length?: number): Uint8Array & { toString(encoding: string): string } } }).Buffer;
function toBase64(bytes: Uint8Array): string {
 if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
 let binary = '';
 for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
 return btoa(binary);
}
function fromBase64(text: string): Uint8Array {
 if (NodeBuffer) return new Uint8Array(NodeBuffer.from(text, 'base64'));
 const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
 if (native) return native(text);
 const binary = atob(text), bytes = new Uint8Array(binary.length);
 for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
 return bytes;
}
export function encodeValues(values: number[], indices: boolean): string {
 const typed = indices ? Uint32Array.from(values) : Float32Array.from(values);
 return toBase64(new Uint8Array(typed.buffer));
}
/** Undefined when the text is not whole little-endian 4-byte values. */
export function decodeValues(text: unknown, indices: boolean): number[] | undefined {
 if (typeof text !== 'string' || text.length % 4 || /[^A-Za-z0-9+/=]/.test(text)) return undefined;
 const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
 if (text.indexOf('=') !== -1 && text.indexOf('=') < text.length - padding) return undefined;
 const bytes = fromBase64(text);
 if (bytes.byteLength !== text.length / 4 * 3 - padding || bytes.byteLength % 4) return undefined;
 const aligned = bytes.byteOffset % 4 ? bytes.slice() : bytes;
 const typed = indices ? new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4) : new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
 return Array.from(typed);
}
/** Each shared asset is sent once; workers and renderers keep shared array references. */
export function packDisplay(delivery: RuntimeDelivery): unknown {
 if(!delivery.evaluation)return delivery;
 const assets: Record<string, unknown>[]=[];
 const known=new Map<number[],Map<number[],number>>();
 const meshes=delivery.evaluation.meshes.map(({vertices,normals,triangles,lines,topology,faceRanges,edgeRanges,...metadata})=>{
  let variants=known.get(vertices);if(!variants)known.set(vertices,variants=new Map());
  let asset=variants.get(triangles);
  if(asset===undefined){
   asset=assets.length;variants.set(triangles,asset);
   const arrays={vertices,normals,triangles,lines};
   assets.push({...Object.fromEntries(FIELDS.map(field=>[field,encodeValues(arrays[field],field==='triangles')])),...(topology?{topology}:{}),...(faceRanges?{faceRanges:encodeValues(faceRanges,true)}:{}),...(edgeRanges?{edgeRanges:encodeValues(edgeRanges,true)}:{})});
  }
  return {...metadata,asset};
 });
 return {...delivery,evaluation:{...delivery.evaluation,meshes,assets,assetEncoding:ASSET_ENCODING}};
}
/** The inverse of packDisplay's asset encoding; undefined for any malformed asset. */
export function decodeAssets(assets: unknown): Asset[] | undefined {
 if (!Array.isArray(assets)) return undefined;
 const decoded: Asset[] = [];
 for (const asset of assets) {
  if (!asset || typeof asset !== 'object' || Object.keys(asset).some(k=>![...FIELDS,'topology','faceRanges','edgeRanges'].includes(k as never))) return undefined;
  const entry = {} as Asset;
  for (const field of FIELDS) {
   const values = decodeValues((asset as Record<string, unknown>)[field], field === 'triangles');
   if (!values) return undefined;
   entry[field] = values;
  }
  const metadata=asset as Record<string,unknown>;
  if(metadata.topology!==undefined){const parsed=topologyTableSchema.safeParse(metadata.topology);if(!parsed.success)return undefined;entry.topology=parsed.data;}
  for(const field of ['faceRanges','edgeRanges'] as const)if(metadata[field]!==undefined){const values=decodeValues(metadata[field],true);if(!values)return undefined;entry[field]=values;}
  decoded.push(entry);
 }
 return decoded;
}
