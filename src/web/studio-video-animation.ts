import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import type { StudioVideoAnimation } from '../shared/protocol';

export function constructionStep(animation: Extract<StudioVideoAnimation,{kind:'construction'}>, steps: number, progress: number) {
  const first=animation.fromStep??1,last=animation.toStep??steps;
  if(first>last||last>steps) throw new Error(`Construction range must be within 1–${steps}, in build order.`);
  return Math.min(last, first+Math.floor(THREE.MathUtils.clamp(progress,0,1)*(last-first+1)));
}

export function explosionAmount(animation: Extract<StudioVideoAnimation,{kind:'exploded'}>, progress: number) {
  const t=THREE.MathUtils.clamp(progress,0,1),p=animation.direction==='out_and_back'?1-Math.abs(2*t-1):animation.direction==='in'?1-t:t;
  return p*p*(3-2*p);
}

export function validateExplosion(animation: Extract<StudioVideoAnimation,{kind:'exploded'}>, evaluation: Evaluation) {
  const seen=new Set<string>();
  for(const offset of animation.offsets){
    if(seen.has(offset.featureId))throw new Error(`Exploded offset repeats ${offset.featureId}.`);
    seen.add(offset.featureId);
    if(!evaluation.meshes.some(m=>evaluation.visibleFeatureIds.includes(m.featureId)&&m.featureId===offset.featureId))
      throw new Error(`Exploded offset names a result that is not visible: ${offset.featureId}`);
  }
}

/** Model and ink move together in their millimetre parent group; floor, camera and exact geometry stay fixed. */
export function animateStudioModel(scene: THREE.Scene, animation: StudioVideoAnimation|undefined, progress: number) {
  scene.traverse(object=>{
    if(!object.userData.featureId)return;
    const base=object.userData.videoRestPosition??=(object.position.clone());
    object.position.copy(base);
    if(animation?.kind==='exploded'){
      const offset=animation.offsets.find(o=>o.featureId===object.userData.featureId);
      if(offset)object.position.addScaledVector(new THREE.Vector3(...offset.offsetMm),explosionAmount(animation,progress));
    }
    object.updateMatrix();
  });
  scene.updateMatrixWorld(true);
}
