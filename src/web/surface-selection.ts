import { useSyncExternalStore } from 'react';
import type { DisplayEvaluation, SurfacePick, Feature } from '../shared/protocol';
import {resolveFaces} from '../cad/surface-reference';
let pick: SurfacePick | undefined;
const listeners = new Set<()=>void>();
type Target=NonNullable<Feature['surfaceStyles']>[number]['target'];
const key=(documentId:string)=>`vibeworks.surface-selection:${documentId}`;
export function selectSurface(value?:SurfacePick,target?:Target){
 try {if(value&&target)localStorage.setItem(key(value.documentId),JSON.stringify(target));else if(!value&&pick)localStorage.removeItem(key(pick.documentId));}catch{}
 pick=value;listeners.forEach(f=>f());
}
export function restoreSurface(documentId:string,evaluation:DisplayEvaluation,revision:number,storageVersion?:number){
 if(pick?.documentId===documentId&&pick.displayKey===evaluation.displayKey||!evaluation.displayKey||!storageVersion)return;
 let target:Target;try{const saved=localStorage.getItem(key(documentId));if(!saved)return;target=JSON.parse(saved);}catch{return;}
 const mesh=evaluation.meshes.find(m=>m.featureId===target.feature&&JSON.stringify(m.occurrencePath?.slice(1)??[])===JSON.stringify(target.path??[]));
 if(!mesh?.topology)return;
 try{const faces=resolveFaces(mesh.topology,target);if(faces.length!==1)return;const face=mesh.topology.faces[faces[0]];selectSurface({documentId,revision,storageVersion,displayKey:evaluation.displayKey,feature:target.feature,path:target.path??[],faceIndex:faces[0],point:face.center,normal:face.normal??[0,0,1]});}catch{/* A stale semantic selection remains unresolved until the user chooses again. */}
}
export function useSurfaceSelection(){return useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>pick);}
