import * as THREE from 'three';
import { worldMesh } from '../shared/display';
import type { Shot } from '../shared/protocol';
import type { Evaluation } from '../cad/types';
import { CadError } from '../cad/document';

/** Resolve a view against real Node display meshes, including instance placements. */
export function shotFrame(evaluation:Evaluation,shot:Shot) {
  const available=evaluation.visibleFeatureIds;
  const named=[...(shot.hide??[]),...(shot.ghost??[]),...(shot.frame&&'featureIds'in shot.frame?shot.frame.featureIds:[])];
  if(named.some(id=>!available.includes(id)))throw new CadError('INVALID_SHOT','A framed, hidden or ghosted result is not present in this view.');
  const ids=available.filter(id=>!shot.hide?.includes(id));
  const solid=ids.filter(id=>!shot.ghost?.includes(id));
  if(!solid.length)throw new CadError('EMPTY_SHOT','The view has no visible solid to frame.');
  const bounds=new THREE.Box3(),points=new Map<string,number[]>();
  const meshes=evaluation.meshes.filter(m=>ids.includes(m.featureId));
  const stride=Math.max(1,Math.ceil(meshes.reduce((n,m)=>n+m.vertices.length,0)/3/60_000))*3;
  const point=new THREE.Vector3();
  for(const mesh of meshes){
    const values=worldMesh(mesh).vertices,frame=points.get(mesh.featureId)??[];
    for(let i=0;i+2<values.length;i+=stride){point.set(values[i],values[i+1],values[i+2]);bounds.expandByPoint(point);frame.push(point.x,point.y,point.z);}
    points.set(mesh.featureId,frame);
  }
  let frame:number[];
  if(shot.frame&&'min'in shot.frame){
    const box=shot.frame;
    if(!bounds.intersectsBox(new THREE.Box3(new THREE.Vector3(...box.min),new THREE.Vector3(...box.max))))throw new CadError('EMPTY_SHOT','The frame misses the shown geometry.');
    frame=[0,1].flatMap(x=>[0,1].flatMap(y=>[0,1].flatMap(z=>[x?box.max[0]:box.min[0],y?box.max[1]:box.min[1],z?box.max[2]:box.min[2]])));
  }else if(shot.frame&&'radiusMm'in shot.frame){
    if(!bounds.intersectsSphere(new THREE.Sphere(new THREE.Vector3(...shot.frame.center),shot.frame.radiusMm)))throw new CadError('EMPTY_SHOT','The detail frame misses the shown geometry.');
    frame=[];
  }
  else frame=(shot.frame&&'featureIds'in shot.frame?shot.frame.featureIds:solid).filter(id=>solid.includes(id)).flatMap(id=>points.get(id)??[]);
  if(!frame.length&&!(shot.frame&&'radiusMm'in shot.frame))throw new CadError('EMPTY_SHOT','The chosen frame has no solid geometry.');
  return {bounds,frame,evaluation:{...evaluation,visibleFeatureIds:ids,meshes}};
}
