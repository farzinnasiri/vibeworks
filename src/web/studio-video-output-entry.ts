// Loaded only by the bridge's managed video renderer. No runtime, storage or OCCT imports.
import { decodeAssets } from '../shared/display';
import { studioVideoSequenceSchema, type Presentation, type StudioVideoRecipe } from '../shared/protocol';
import type { Evaluation } from '../cad/types';
import { videoDuration } from './studio-video-camera';
import { recipeContext, resolveVideoRecipe, videoCropWarnings } from './studio-video-recipe';
import { renderVideoFrames } from './studio-video-render';

interface Payload { evaluation: any; recipe: StudioVideoRecipe; presentation: Presentation; constructionSteps?: number; job: { width: number; height: number; fps: 24 | 30 | 60; depthOfField?:{fStop:number} } }
const base64 = (bytes: ArrayBuffer) => {
  let binary = '';
  const data = new Uint8Array(bytes);
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
};
const host = globalThis as any;

/** Resolve the recipe for this output, tell the bridge the plan, then hand over each finished frame in order. */
host.__studioVideo = async (payload: Payload) => {
  const decode = (packed:any):Evaluation => {
    const { assets, assetEncoding: _, ...rest } = packed, decoded = decodeAssets(assets);
    if (!decoded) throw new Error('Studio display capture could not be decoded.');
    return { ...rest, meshes: rest.meshes.map(({ asset, ...metadata }: any) => ({ ...decoded[asset], ...metadata })) };
  };
  const evaluation = decode(payload.evaluation);
  const { width, height, fps } = payload.job;
  const context = recipeContext(evaluation, width, height, payload.presentation);
  const views = studioVideoSequenceSchema.parse(resolveVideoRecipe(payload.recipe, context));
  const seconds = videoDuration(views), frames = Math.ceil(seconds * fps);
  await host.__videoPlan(JSON.stringify({ frames, seconds,
    warnings: videoCropWarnings(views, context),
    keyframes: views.map(({ name, camera, seconds, hold, motion, easing, focus }) => ({ name, camera, seconds, hold, motion, ...(easing ? { easing } : {}), ...(focus ? { focus } : {}) })) }));
  await renderVideoFrames(evaluation, views, { width, height, fps, animation: payload.recipe.animation,depthOfField:payload.job.depthOfField,
    ...(payload.constructionSteps ? { construction: { steps: payload.constructionSteps, frame: async(step:number)=>decode(JSON.parse(await host.__videoConstruction(step))) } } : {}) },
    async (index, png) => { await host.__videoFrame(index, png ? base64(await png.arrayBuffer()) : null); },
    completed => { host.__studioVideoProgress = { frames: completed, total: frames }; }, new AbortController().signal);
  return { frames, seconds };
};
