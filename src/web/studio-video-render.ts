import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import type { StudioVideoView, StudioVideoAnimation } from '../shared/protocol';
import { buildStudioAssets, composeStudioScene, disposeStudioAssets, loadStudioLook, releaseStudioScene } from './studio-compose';
import { videoDuration, videoFrameAt } from './studio-video-camera';
import { StudioVideoPreviewRenderer } from './studio-video-preview';
import { animateStudioModel, constructionStep, validateExplosion } from './studio-video-animation';

export interface VideoProgress {
  phase: 'preparing' | 'rendering' | 'encoding'; frames: number; total: number;
  samples: number; target: number; elapsedMs: number; etaMs?: number;
}
export interface VideoFrameOptions { width: number; height: number; fps: number;
  depthOfField?:{fStop:number};
  animation?:StudioVideoAnimation; construction?:{steps:number;frame:(step:number)=>Promise<Evaluation>} }
/**
 * The one frame loop for Studio video: deterministic timestamps that include both endpoints, Studio's scene and
 * renderers, and holds that reuse a finished frame. onFrame receives each PNG, or null when it repeats the last one.
 */
export async function renderVideoFrames(evaluation: Evaluation, views: StudioVideoView[], options: VideoFrameOptions,
  onFrame: (index: number, png: Blob | null) => Promise<void>, report: (completed: number) => void, signal: AbortSignal) {
  const frames = Math.ceil(videoDuration(views) * options.fps);
  const check = () => signal.throwIfAborted();
  let assets: Awaited<ReturnType<typeof buildStudioAssets>>;
  let preview: StudioVideoPreviewRenderer | undefined;
  let retired: typeof assets;
  try {
    if(options.animation?.kind==='exploded')validateExplosion(options.animation,evaluation);
    if(options.animation?.kind==='construction'&&!options.construction)throw new Error('Construction requires exact frames from the captured Node worker.');
    assets = await buildStudioAssets(evaluation, () => !signal.aborted); check();
    if (!assets) throw new Error('Could not prepare the captured model.');
    preview = new StudioVideoPreviewRenderer();
    const camera = new THREE.PerspectiveCamera(35, options.width / options.height, Math.max(assets.radius / assets.unit * 0.001, 1e-5), assets.radius / assets.unit * 500);
    camera.up.set(0, 0, 1);
    const referenceBounds=assets.bounds.clone();
    let lastStep=0;
    let sceneKey = '', look: Awaited<ReturnType<typeof loadStudioLook>> | undefined, previousFrameKey = '';
    for (let i = 0; i < frames; i++) {
      check();
      const frame = videoFrameAt(views, i / (frames - 1) * videoDuration(views));
      const progress=i/(frames-1);
      if(options.animation?.kind==='construction'){
        const step=constructionStep(options.animation,options.construction!.steps,progress);
        if(step!==lastStep){
          const evaluation=await options.construction!.frame(step);check();
          const next=await buildStudioAssets(evaluation,()=>!signal.aborted,referenceBounds);check();
          if(!next)throw new Error('Construction frame could not be prepared.');
          retired=assets;assets=next;lastStep=step;
        }
      }
      const nextKey = JSON.stringify([frame.presentation,lastStep]);
      if (nextKey !== sceneKey || !look) { look = await loadStudioLook(frame.presentation, assets.radius); sceneKey = nextKey; check(); }
      camera.position.fromArray(frame.camera.position).sub(assets.center).divideScalar(assets.unit);
      camera.fov = frame.camera.fov;
      camera.lookAt(new THREE.Vector3(...frame.camera.target).sub(assets.center).divideScalar(assets.unit));
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      const owned = assets, ownedLook = look;
      // Holds have identical captured cameras and scenes. Reuse one finished frame, including its exact samples.
      const frameKey = JSON.stringify([frame.camera, frame.presentation,lastStep,options.animation?.kind==='exploded'?progress:0]);
      if (previousFrameKey === frameKey) { await onFrame(i, null); report(i + 1); continue; }
      const blob = await preview.render({ key: sceneKey,
        scene: () => composeStudioScene(owned, frame.presentation, ownedLook, 'preview'), release: releaseStudioScene,
        camera, width: options.width, height: options.height, presentation: frame.presentation,
        update:scene=>animateStudioModel(scene,options.animation,progress),
        ...(options.depthOfField?{depthOfField:{fStop:options.depthOfField.fStop,focalLengthMm:frame.camera.focalLengthMm,unitMm:assets.unit,
          focusDistance:new THREE.Vector3(...frame.camera.position).distanceTo(new THREE.Vector3(...frame.camera.target))/assets.unit}}:{}) }, signal);
      check();
      if(retired){disposeStudioAssets(retired);retired=undefined;}
      await onFrame(i, blob);
      previousFrameKey = frameKey;
      report(i + 1);
    }
    return { frames };
  } finally {
    preview?.dispose(); if (assets) disposeStudioAssets(assets); if(retired)disposeStudioAssets(retired);
  }
}
