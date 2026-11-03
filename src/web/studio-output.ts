import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import type { CadDocument, RenderedTile, Shot, StudioRenderJob } from '../shared/protocol';
import { imageQuality } from '../shared/studio';
import { buildStudioAssets, composeStudioScene, disposeStudioAssets, loadStudioLook, releaseStudioScene } from './studio-compose';
import { StudioRenderer, type RenderStatus } from './studio-render';
import { shotCamera } from './shots';

/** Match Studio's bounded silhouette sampling across the whole shot, rather than once per part. */
export function studioFramePoints(parts:Evaluation['meshes'],shot:Shot):number[]{
  const frame:number[]=[],point=new THREE.Vector3();
  const framedIds=shot.frame && 'featureIds' in shot.frame?shot.frame.featureIds:parts.map(p=>p.featureId);
  const framedParts=parts.filter(p=>framedIds.includes(p.featureId));
  const stride=Math.max(1,Math.ceil(framedParts.reduce((n,p)=>n+p.vertices.length,0)/180000))*3;
  if(shot.frame && 'min' in shot.frame){
    for(const x of [shot.frame.min[0],shot.frame.max[0]])for(const y of [shot.frame.min[1],shot.frame.max[1]])
      for(const z of [shot.frame.min[2],shot.frame.max[2]])frame.push(x,y,z);
  }else if(!(shot.frame && 'radiusMm' in shot.frame)){
    for(const data of framedParts){
      const matrix=data.transform?new THREE.Matrix4().fromArray(data.transform):undefined;
      for(let i=0;i<data.vertices.length;i+=stride){point.fromArray(data.vertices,i);if(matrix)point.applyMatrix4(matrix);frame.push(point.x,point.y,point.z);}
    }
  }
  return frame;
}

/** The managed final-image path shares Studio's scene, tracer, denoiser and quality budgets. */
export async function renderStudioOutput(evaluation: Evaluation, document: CadDocument, job: StudioRenderJob,
  progress: (status: RenderStatus) => void) {
  const hidden = new Set(job.shot.hide);
  const ids = evaluation.visibleFeatureIds.filter(id => !hidden.has(id));
  for (const id of [...hidden, ...('featureIds' in (job.shot.frame ?? {}) ? (job.shot.frame as {featureIds:string[]}).featureIds : [])])
    if (!evaluation.visibleFeatureIds.includes(id)) throw new Error(`Studio shot names a result that is not visible: ${id}`);
  if (!ids.length) throw new Error('Studio shot contains no visible results.');
  const shown = { ...evaluation, visibleFeatureIds: ids };
  const assets = await buildStudioAssets(shown);
  if (!assets) throw new Error('Studio assets could not be prepared.');
  const renderer = new StudioRenderer();
  try {
    const shot=job.shot,frame=studioFramePoints(assets.parts.map(p=>p.data),shot);
    const fitted = shotCamera(shot,0,frame,assets.bounds,job.width/job.height,job.height);
    const camera = fitted.camera;
    camera.position.sub(assets.center).divideScalar(assets.unit);
    camera.near /= assets.unit; camera.far /= assets.unit;
    if (camera instanceof THREE.OrthographicCamera) {
      camera.left /= assets.unit; camera.right /= assets.unit; camera.top /= assets.unit; camera.bottom /= assets.unit;
    }
    camera.lookAt(new THREE.Vector3(...fitted.tile.target).sub(assets.center).divideScalar(assets.unit));
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    const look = await loadStudioLook(job.presentation,assets.radius);
    const quality = imageQuality(job.output);
    const result = await renderer.render({key:job.jobId,scene:()=>composeStudioScene(assets,job.presentation,look,'trace'),
      release:releaseStudioScene,camera,width:job.width,height:job.height,samples:quality.samples,bounces:quality.bounces,
      denoise:job.output.denoise,exposure:job.presentation.exposure ?? 1},progress,new AbortController().signal);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary=''; for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return {base64:btoa(binary),width:job.width,height:job.height,camera:fitted.tile as RenderedTile,samples:result.samples,elapsedMs:result.elapsedMs};
  } finally { renderer.dispose(); disposeStudioAssets(assets); }
}
