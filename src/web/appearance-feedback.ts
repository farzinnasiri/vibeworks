import {useSyncExternalStore} from 'react';
import type {Appearance} from '../shared/protocol';
import type {Evaluation} from '../cad/types';
type Feedback={documentId:string;featureId:string;appearance?:Appearance};
let feedback:Feedback|undefined;const listeners=new Set<()=>void>();
export const getAppearanceFeedback=()=>feedback;
export function setAppearanceFeedback(value:Feedback|undefined){feedback=value;listeners.forEach(listener=>listener());}
export function useAppearanceFeedback(){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>feedback);}
/** Display-only appearance preview. B-rep geometry and committed definitions stay untouched. */
export function appearanceEvaluation(evaluation:Evaluation,value:Feedback|undefined,documentId:string):Evaluation{
 if(!value||value.documentId!==documentId||!value.appearance)return evaluation;
 return {...evaluation,meshes:evaluation.meshes.map(mesh=>mesh.featureId===value.featureId?{...mesh,appearance:{...mesh.appearance,...value.appearance}}:mesh)};
}
