import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as THREE from 'three';
import { studioVideoRecipeSchema, studioVideoSequenceSchema, type StudioVideoView } from '../src/shared/protocol';
import { resolveVideoRecipe, videoCropWarnings, viewsToRecipe, focalToFov, type RecipeContext } from '../src/web/studio-video-recipe';
import { videoFrameAt } from '../src/web/studio-video-camera';

const bounds = new THREE.Box3(new THREE.Vector3(-10,-10,-10), new THREE.Vector3(10,10,10));
const vertices: number[] = []; for (const x of [-10,10]) for (const y of [-10,10]) for (const z of [-10,10]) vertices.push(x,y,z);
const context: RecipeContext = { width: 1280, height: 720, presentation: {}, bounds,
  parts: [{ featureId: 'spindle_body', occurrencePath: ['spindle'], vertices, normals: [], triangles: [], lines: [],
    transform: new THREE.Matrix4().makeTranslation(30,0,0).toArray() }] };
const camera = { position: [100,-100,60] as [number,number,number], target: [0,0,0] as [number,number,number], fov: 40, focalLengthMm: 50 };
const view = (x: number, seconds: number): StudioVideoView => ({ id: randomUUID(), name: 'View', camera: { ...camera, position: [x,-100,60] },
  presentation: {}, motion: 'smooth', seconds, hold: 0 });

test('smooth paths pass through keyframes with continuous velocity across unequal travel times', () => {
  const views = [view(0,1), view(10,1), view(40,3), view(30,2)];
  studioVideoSequenceSchema.parse(views);
  const h = 0.0001, at = (t: number) => videoFrameAt(views,t).camera.position;
  assert.deepEqual(at(1), views[1].camera.position);
  for (const time of [1,4]) {
    const a = at(time-h), b = at(time), c = at(time+h);
    for (let n=0;n<3;n++) assert.ok(Math.abs((b[n]-a[n])/h-(c[n]-b[n])/h)<.02, 'the camera must not kink at a through-view');
  }
  assert.ok(Math.abs(at(.0001)[0]-at(0)[0])<1e-5, 'automatic easing starts at rest');
  const linear = views.map(v=>({...v,easing:'linear' as const}));
  assert.ok(videoFrameAt(linear,.001).camera.position[0]>.005, 'explicit constant pace overrides start easing');
  const held = [{...views[0],hold:1},...views.slice(1)];
  assert.deepEqual(videoFrameAt(held,.5).camera,views[0].camera);
});

test('semantic focus includes components, lenses resolve for the output, and saved recipes preserve path settings', () => {
  const recipe = studioVideoRecipeSchema.parse({ keyframes: [
    { shot: { from: [1,-1,1] }, focus: {featureIds:['spindle']}, focalLengthMm:35, easing:'linear' },
    { camera, focalLengthMm:85, focus:{featureIds:['spindle_body']}, easing:'ease_out' },
  ] });
  const views = resolveVideoRecipe(recipe, context);
  assert.deepEqual(views[0].camera.target,[30,0,0]);
  assert.deepEqual(views[1].camera.target,[30,0,0]);
  assert.equal(views[0].camera.fov,focalToFov(35,16/9));
  assert.equal(views[1].camera.focalLengthMm,85);
  const mid = videoFrameAt(views,1.25).camera;
  assert.ok(mid.focalLengthMm>35&&mid.focalLengthMm<85);
  const roundtrip = resolveVideoRecipe(studioVideoRecipeSchema.parse(viewsToRecipe(views,undefined)),context);
  assert.deepEqual(roundtrip.map(({id:_,...v})=>v),views.map(({id:_,...v})=>v));
  assert.throws(()=>resolveVideoRecipe(studioVideoRecipeSchema.parse({keyframes:[{shot:{},focus:{featureIds:['missing']}},{shot:{}}]}),context),/not visible: missing/);
});

test('bounds crop warnings sample the travel as well as its endpoints and do not move the camera', () => {
  // Explicit cameras can crop; a close-up is an advisory, not an automatic correction.
  const close = [view(0,1),view(0,1)].map(v=>({...v,camera:{...camera,position:[0,-12,0] as [number,number,number]}}));
  const before = JSON.stringify(close);
  assert.match(videoCropWarnings(close,context)[0],/VIDEO_CROP.*sampled views/);
  assert.equal(JSON.stringify(close),before);
  const wide = close.map(v=>({...v,camera:{...v.camera,position:[0,-200,0] as [number,number,number]}}));
  assert.deepEqual(videoCropWarnings(wide,context),[]);
});
