import { renderStudioOutput } from './studio-output';
import { decodeAssets } from '../shared/display';
import type { Evaluation } from '../cad/types';

(globalThis as any).__studioOutput = (payload: any) => {
  const {assets,assetEncoding:_,...evaluation}=payload.evaluation;
  const decoded=decodeAssets(assets);
  if(!decoded)throw new Error('Studio display capture could not be decoded.');
  evaluation.meshes=evaluation.meshes.map(({asset,...metadata}:any)=>({...decoded[asset],...metadata}));
  return renderStudioOutput(evaluation as Evaluation,payload.document,payload.job,
    status=>{(globalThis as any).__studioProgress=status;});
};
