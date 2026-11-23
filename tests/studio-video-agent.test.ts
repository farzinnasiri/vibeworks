import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as THREE from 'three';
import { commandSchemas, parseCommand, studioVideoRecipeSchema, studioVideoSequenceSchema, toolCatalog, videoOutputSize,
  type CadDocument, type FrozenGraph, type StudioVideoCamera, type StudioVideoView } from '../src/shared/protocol';
import type { Evaluation } from '../src/cad/types';
import { emptyDocument, validateDocument } from '../src/cad/document';
import { applyEdits } from '../src/cad/edits';
import { appearanceOnly } from '../src/cad/appearance';
import { resolveVideoRecipe, focalToFov } from '../src/web/studio-video-recipe';
import { blendPresentation, videoDuration, videoFrameAt, videoViewTime } from '../src/web/studio-video-camera';
import { StudioVideoJobs } from '../src/bridge/studio-video-jobs';
import { resultSchema } from '../src/bridge/validation';
import type { StudioVideoRunner } from '../src/bridge/studio-video-renderer';

// A long, low model: 400 x 100 x 60 mm, plus a small 'wing' at the rear.
function box(id: string, min: number[], max: number[]): Evaluation['meshes'][number] {
  const v: number[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) v.push(x, y, z);
  return { featureId: id, vertices: v, normals: v.map(() => 0), triangles: [0, 1, 2], lines: [] } as unknown as Evaluation['meshes'][number];
}
const parts = [box('body', [-200, -50, 0], [200, 50, 60]), box('wing', [170, -45, 60], [200, 45, 90])];
const bounds = new THREE.Box3(new THREE.Vector3(-200, -50, 0), new THREE.Vector3(200, 50, 90));
const ctx = (width = 1920, height = 1080) => ({ parts, bounds, width, height, presentation: { exposure: 1.1 } });
const dist = (c: StudioVideoCamera) => Math.hypot(...c.position.map((x, i) => x - c.target[i]));
const elevation = (c: StudioVideoCamera) => Math.asin((c.position[2] - c.target[2]) / dist(c)) * 180 / Math.PI;

test('render_video is a catalogued agent tool with one recipe for presets and keyframes', () => {
  assert.ok(toolCatalog().some(t => t.name === 'render_video' && /preset/.test(t.description)));
  const start = parseCommand({ type: 'render_video', params: { action: 'start', requestId: randomUUID(), documentId: randomUUID(),
    video: { preset: { name: 'crane', focus: { featureIds: ['wing'] } } }, output: { aspect: '9:16' } } });
  assert.equal(start.type, 'render_video');
  const recipe = studioVideoRecipeSchema.parse({ keyframes: [{ shot: { view: 'front' } }, { shot: { from: [1, -1, 0.3] }, seconds: 3 }] });
  assert.equal(recipe.keyframes![1].motion, 'orbit'); assert.equal(recipe.keyframes![0].hold, 0);
  assert.throws(() => studioVideoRecipeSchema.parse({ preset: { name: 'turntable' }, keyframes: recipe.keyframes }), /either preset or keyframes/);
  assert.throws(() => studioVideoRecipeSchema.parse({ keyframes: [{ shot: {}, camera: { position: [1, 0, 0], target: [0, 0, 0], fov: 30, focalLengthMm: 50 } }, { shot: {} }] }), /either shot or camera/);
  assert.throws(() => studioVideoRecipeSchema.parse({ keyframes: Array.from({ length: 4 }, () => ({ shot: {}, seconds: 10 })) }), /at most 20 seconds/);
  assert.deepEqual(videoOutputSize({ aspect: '16:9', resolution: '1080p' }), { width: 1920, height: 1080 });
  assert.deepEqual(videoOutputSize({ aspect: '9:16', resolution: '1080p' }), { width: 1080, height: 1920 });
  assert.deepEqual(videoOutputSize({ aspect: '4:5', resolution: '1080p' }), { width: 1080, height: 1350 });
  assert.deepEqual(videoOutputSize({ aspect: '1:1', resolution: '4k' }), { width: 2160, height: 2160 });
  assert.ok(commandSchemas.apply_edits.safeParse({ documentId: randomUUID(), expectedRevision: 0, edits: [{ op: 'set_video', video: { preset: { name: 'turntable' } } }] }).success);
});

test('presets resolve to valid sequences framed for the output, with focus, direction, crane and seconds', () => {
  for (const name of ['turntable', 'half_orbit', 'push_pull', 'detail_reveal', 'crane'] as const) {
    const views = studioVideoSequenceSchema.parse(resolveVideoRecipe({ preset: { name } }, ctx()));
    assert.ok(videoDuration(views) >= 6 && videoDuration(views) <= 20, name);
    assert.ok(views.every(v => v.presentation.exposure === 1.1), 'scene comes from the context');
  }
  const turntable = resolveVideoRecipe({ preset: { name: 'turntable' } }, ctx());
  assert.ok(Math.abs(dist(turntable[0].camera) - dist(turntable[2].camera)) < 1e-6, 'turntable keeps its distance');
  const cw = resolveVideoRecipe({ preset: { name: 'turntable', direction: 'clockwise' } }, ctx());
  assert.ok(Math.abs(cw[1].camera.position[0] - turntable[3].camera.position[0]) < 1e-6, 'clockwise mirrors the orbit');
  // A focus close-up looks at the focus, much closer than the start.
  const push = resolveVideoRecipe({ preset: { name: 'push_pull', focus: { featureIds: ['wing'] } } }, ctx());
  assert.ok(push[1].camera.target[0] > 150, 'close-up targets the wing');
  assert.ok(dist(push[1].camera) < dist(push[0].camera) * 0.6);
  // Crane: starts low on the far side, rises, settles on the focus.
  const crane = resolveVideoRecipe({ preset: { name: 'crane', focus: { center: [185, 0, 75], radiusMm: 30 } } }, ctx());
  assert.ok(elevation(crane[0].camera) < 8 && elevation(crane[1].camera) > 30);
  // Every preset view is fitted from its own direction: in a tall frame, the side-on views of this long model sit farther away.
  const tallCrane = resolveVideoRecipe({ preset: { name: 'crane' } }, ctx(1080, 1920));
  assert.ok(dist(tallCrane[0].camera) > dist(crane[0].camera));
  assert.ok(Math.abs(crane[2].camera.target[0] - 185) < 1);
  // A tall output frames the long model from farther away than a wide one.
  const wide = resolveVideoRecipe({ preset: { name: 'turntable' } }, ctx()), tall = resolveVideoRecipe({ preset: { name: 'turntable' } }, ctx(1080, 1920));
  assert.ok(dist(tall[0].camera) > dist(wide[0].camera) * 1.2);
  assert.ok(Math.abs(focalToFov(50, 16 / 9) - 22.27) < 0.05, 'Studio 35 mm gate');
  const timed = resolveVideoRecipe({ preset: { name: 'detail_reveal', seconds: 6 } }, ctx());
  assert.ok(Math.abs(videoDuration(timed) - 6) < 0.05);
  // Keyframes: shots are framed, cameras are exact, per-keyframe scene overrides apply.
  const exact = { position: [500, -500, 300] as [number, number, number], target: [0, 0, 30] as [number, number, number], fov: 30, focalLengthMm: 60 };
  const keyed = resolveVideoRecipe({ keyframes: [{ shot: { from: [1, -1, 0.3], frame: { featureIds: ['wing'] } }, motion: 'orbit', seconds: 2.5, hold: 0 },
    { camera: exact, motion: 'move', seconds: 3, hold: 1, presentation: { exposure: 2 } }] }, ctx());
  assert.ok(keyed[0].camera.target[0] > 150); assert.deepEqual(keyed[1].camera, exact);
  assert.equal(keyed[1].presentation.exposure, 2); assert.equal(keyed[0].presentation.exposure, 1.1);
});

test('scene settings blend while the camera travels; equal scenes stay the same object', () => {
  const a = { exposure: 1, lightRotation: 170, background: '#000000', floor: 'matte' as const };
  const b = { exposure: 2, lightRotation: -170, background: '#ffffff', floor: 'none' as const };
  const mid = blendPresentation(a, b, 0.5);
  assert.equal(mid.exposure, 1.5); assert.equal(Math.abs(mid.lightRotation!), 180, 'angles take the short way');
  assert.equal(mid.background, '#808080'); assert.equal(mid.floor, 'none');
  assert.equal(blendPresentation(a, structuredClone(a), 0.3), a);
  const camera = { position: [10, 0, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 35, focalLengthMm: 50 };
  const views: StudioVideoView[] = [{ id: randomUUID(), name: 'A', camera, presentation: a, motion: 'orbit', seconds: 2, hold: 0 },
    { id: randomUUID(), name: 'B', camera: { ...camera, position: [0, 10, 5] }, presentation: b, motion: 'orbit', seconds: 2, hold: 0 }];
  assert.equal(videoFrameAt(views, videoViewTime(views, 1) / 2).presentation.exposure, 1.5);
});

test('set_video saves a display-only camera move: no geometry change, clear with null', () => {
  const doc = validateDocument({ ...emptyDocument(), features: [{ id: 'body', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] } }] } as unknown as CadDocument);
  const saved = applyEdits(doc, [{ op: 'set_video', video: { preset: { name: 'crane' }, output: { aspect: '1:1', resolution: '1080p', fps: 30, quality: 'standard' } } }]).document;
  assert.equal(saved.video?.preset?.name, 'crane');
  assert.ok(appearanceOnly(doc, saved), 'a camera move never rebuilds or reanalyses geometry');
  validateDocument(saved);
  assert.equal(applyEdits(saved, [{ op: 'set_video', video: null }]).document.video, undefined);
});

const doc = validateDocument({ ...emptyDocument(), presentation: { exposure: 1.4 }, video: { preset: { name: 'push_pull' }, output: { aspect: '9:16', resolution: '720p', fps: 24, quality: 'standard' } } } as unknown as CadDocument);
const graph = { document: doc, documents: [], snapshot: { snapshotId: randomUUID(), documentId: doc.documentId, storageVersion: 3, revision: 0, sources: [], engineVersion: 'test', cursor: 0, createdAt: new Date().toISOString() } } as unknown as FrozenGraph;
const start = (patch = {}) => ({ action: 'start' as const, requestId: randomUUID(), documentId: doc.documentId, ...patch });
const turn = () => new Promise<void>(r => setImmediate(r));
const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const fakePng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 2, 208, 0, 0, 5, 0]), Buffer.alloc(16)]);

test('video jobs freeze saved defaults, report progress, save the MP4 and stay bounded', async () => {
  const payloads: any[] = [], saves: any[] = [];
  let finish!: () => void;
  const run: StudioVideoRunner = (payload, progress, signal) => new Promise((resolve, reject) => {
    payloads.push(JSON.parse(payload));
    progress({ phase: 'rendering', completedFrames: 6, frames: 24, seconds: 1, keyframes: [] });
    signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
    finish = () => resolve({ mp4: fakeMp4, poster: fakePng, frames: 24, seconds: 1, keyframes: [] });
  });
  const save = async (bytes: Buffer, filename: string, mimeType: string) => { saves.push({ bytes, filename, mimeType });
    return { filename, path: '/tmp/' + filename, uri: 'file:///tmp/' + filename, mimeType, byteLength: bytes.length, sha256: 'a'.repeat(64) }; };
  const jobs = new StudioVideoJobs(run, 60_000, save as never);
  try {
    const first = start({ output: { fps: 60 } });
    const accepted = jobs.startGraph(first, graph); resultSchema.parse(accepted);
    assert.match(accepted.warnings[0], /saved with the model/);
    assert.deepEqual(accepted.videoJob!.output, { aspect: '9:16', resolution: '720p', fps: 60, quality: 'standard' }, 'request output overrides the saved output field by field');
    assert.equal(accepted.videoJob!.width, 720); assert.equal(accepted.videoJob!.height, 1280);
    await turn();
    assert.equal(payloads[0].recipe.preset.name, 'push_pull'); assert.equal(payloads[0].presentation.exposure, 1.4);
    assert.equal(jobs.control({ action: 'status', jobId: first.requestId }).videoJob!.completedFrames, 6);
    assert.equal(jobs.existing({ ...first })!.videoJob!.jobId, first.requestId);
    assert.throws(() => jobs.existing({ ...first, output: { fps: 30 } }), (e: any) => e.code === 'REQUEST_ID_CONFLICT');
    jobs.startGraph(start(), graph);
    assert.throws(() => jobs.startGraph(start(), graph), (e: any) => e.code === 'RENDERER_BUSY');
    assert.match(jobs.control({ action: 'result', jobId: first.requestId }).warnings.at(-1)!, /poll status/);
    finish(); await turn(); await turn();
    const done = jobs.control({ action: 'result', jobId: first.requestId }); resultSchema.parse(done);
    assert.equal(done.videoJob!.state, 'complete'); assert.equal(done.video!.path, '/tmp/studio-video-r0.mp4');
    assert.equal(done.video!.fps, 60); assert.equal(saves[0].mimeType, 'video/mp4');
    const explicit = jobs.startGraph(start({ video: { preset: { name: 'turntable' } } }), graph);
    assert.match(explicit.warnings[0], /recipe in this request/);
  } finally { await jobs.close(); }
  const broken = new StudioVideoJobs(async () => ({ mp4: Buffer.from('not a video'), poster: fakePng, frames: 24, seconds: 1, keyframes: [] }), 60_000, save as never);
  try { const p = start(); broken.startGraph(p, graph); await turn(); await turn();
    const r = broken.control({ action: 'result', jobId: p.requestId }); resultSchema.parse(r);
    assert.equal(r.error?.code, 'INVALID_RESPONSE'); assert.equal(r.video, undefined);
  } finally { await broken.close(); }
  const none = validateDocument({ ...emptyDocument() } as CadDocument);
  const plain = new StudioVideoJobs(() => new Promise(() => {}), 60_000, save as never);
  try { const r = plain.startGraph({ ...start(), documentId: none.documentId }, { ...graph, document: none, snapshot: { ...graph.snapshot, documentId: none.documentId } } as FrozenGraph);
    assert.match(r.warnings[0], /turntable/); assert.deepEqual(r.videoJob!.output, { aspect: '16:9', resolution: '1080p', fps: 30, quality: 'standard' });
  } finally { await plain.close(); }
});

test('a stalled setup expires as a terminal job error, cancels its runner and releases capacity',async()=>{
  let cancelled=false;
  const jobs=new StudioVideoJobs((_payload,_report,signal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true});
  }),30);
  try {
    const input=start();jobs.startGraph(input,graph);
    await new Promise(resolve=>setTimeout(resolve,80));
    const result=jobs.control({action:'status',jobId:input.requestId});resultSchema.parse(result);
    assert.equal(result.status,'error');assert.equal(result.videoJob!.state,'error');
    assert.equal(result.videoJob!.phase,'error');assert.equal(result.videoJob!.error!.code,'RENDER_TIMEOUT');
    assert.equal(result.error!.code,'RENDER_TIMEOUT');assert.equal(cancelled,true);assert.equal(jobs.busy,false);
    jobs.startGraph(start(),graph);
  }finally{await jobs.close();}
});
