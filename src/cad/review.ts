import type { Evaluation } from './types';
import type { Vector3,ReviewEvidence,Shot } from '../shared/protocol';
import { CadError } from './document';

/** Numeric evidence always comes from exact Node results, never image/display bounds. */
export function reviewTotals(evaluation:Evaluation,featureId?:string):ReviewEvidence['totals']{
  const ids=featureId?[featureId]:evaluation.visibleFeatureIds;
  const geometry=evaluation.geometry.filter(g=>ids.includes(g.featureId));
  if(!geometry.length)throw new CadError('EMPTY_MODEL','No exact result is available for this review.');
  const min=[0,1,2].map(i=>Math.min(...geometry.map(g=>g.bounds.min[i]))) as Vector3;
  const max=[0,1,2].map(i=>Math.max(...geometry.map(g=>g.bounds.max[i]))) as Vector3;
  return {min,max,size:max.map((n,i)=>n-min[i]) as Vector3,
    sumVisibleVolumesMm3:geometry.reduce((n,g)=>n+g.volumeMm3,0),solids:geometry.reduce((n,g)=>n+g.solidCount,0),valid:geometry.every(g=>g.valid)};
}

/** Lock the same box for comparison, while preserving explicitly authored detail frames. */
export function comparisonShots(shots:Shot[],before:ReviewEvidence['totals'],after:ReviewEvidence['totals'],evaluations:Evaluation[]):Shot[]{
  const min=before.min.map((n,i)=>Math.min(n,after.min[i])) as Vector3;
  const max=before.max.map((n,i)=>Math.max(n,after.max[i])) as Vector3;
  return shots.map(shot=>{
    if(shot.frame&&'featureIds'in shot.frame){
      const ids=shot.frame.featureIds;
      const geometry=evaluations.flatMap(evaluation=>{
        const found=evaluation.geometry.filter(g=>ids.includes(g.featureId));
        if(ids.some(id=>!found.some(g=>g.featureId===id)))throw new CadError('FEATURE_NOT_FOUND','A framed result is missing from one comparison revision. Use a fixed box or compare whole documents.');
        return found;
      });
      return {...shot,frame:{min:[0,1,2].map(i=>Math.min(...geometry.map(g=>g.bounds.min[i]))) as Vector3,
        max:[0,1,2].map(i=>Math.max(...geometry.map(g=>g.bounds.max[i]))) as Vector3}};
    }
    return {...shot,frame:shot.frame??{min,max}};
  });
}
