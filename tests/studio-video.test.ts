import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioVideoEncodingSchema, studioVideoSequenceSchema, type StudioVideoView } from '../src/shared/protocol';
import { interpolateVideoCamera, turntableViews, videoDuration, videoFrameAt, videoPresetViews, videoViewTime, type VideoPreset } from '../src/web/studio-video-camera';
import { StudioVideoEncoder } from '../src/bridge/studio-video-encoder';

const camera = { position: [10, 0, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 35, focalLengthMm: 50 };
const view = (patch: Partial<StudioVideoView> = {}): StudioVideoView => ({ id: randomUUID(), name: 'View', camera, presentation: {}, motion: 'orbit', seconds: 2, hold: 0, ...patch });
const exec = promisify(execFile);

test('video presets start at the chosen camera and provide valid close-up, pull-back and orbit sequences', () => {
  for (const preset of ['turntable','half-orbit','push-pull','detail-reveal'] as VideoPreset[]) {
    const views = videoPresetViews(preset, camera, { exposure: 1.2 });
    studioVideoSequenceSchema.parse(views);
    assert.deepEqual(views[0].camera, camera);
    assert.ok(videoDuration(views) <= 20);
    assert.equal(videoViewTime(views,0),0);
    for (let i=1;i<views.length;i++) { const actual=videoFrameAt(views,videoViewTime(views,i)).camera; actual.position.forEach((value,axis)=>assert.ok(Math.abs(value-views[i].camera.position[axis])<1e-9)); }
    if (preset === 'push-pull' || preset === 'detail-reveal') {
      const distance = (v: StudioVideoView) => Math.hypot(...v.camera.position.map((x,i) => x-v.camera.target[i]));
      assert.ok(distance(views[1]) < distance(views[0]));
      assert.ok(distance(views.at(-1)!) > distance(views[0]));
    }
  }
});

test('cinematic orbits retain radius, take the short angular route and include the full turntable', () => {
  const opposite = { ...camera, position: [-10, 0, 5] as [number, number, number] };
  const middle = interpolateVideoCamera(camera, opposite, 0.5, 'orbit');
  assert.ok(Math.abs(Math.hypot(...middle.position) - Math.hypot(...camera.position)) < 1e-9);
  assert.ok(Math.abs(middle.position[1]) > 9.99, 'opposite views must go around the model');
  const at = (angle: number) => ({ ...camera, position: [Math.cos(angle) * 10, Math.sin(angle) * 10, 5] as [number, number, number] });
  assert.ok(interpolateVideoCamera(at(-0.1), at(0.1), 0.5, 'orbit').position[0] > 9.99);
  const views = turntableViews(camera, {});
  studioVideoSequenceSchema.parse(views); assert.equal(videoDuration(views), 8);
  assert.deepEqual(videoFrameAt(views, 0).camera, camera);
  for (let i = 1; i < 5; i++) {
    const actual = videoFrameAt(views, i * 2).camera;
    actual.position.forEach((v, n) => assert.ok(Math.abs(v - views[i].camera.position[n]) < 1e-8));
  }
  const before = videoFrameAt(views, 2 - 0.001).camera, after = videoFrameAt(views, 2 + 0.001).camera;
  assert.ok(Math.abs(before.position[0] - after.position[0]) > 0.001, 'intermediate views keep moving');
});

test('holds, cuts, arrival lighting and direct push movements use the same deterministic sequence clock', () => {
  const a = view({ hold: 1 }), b = view({ camera: { ...camera, position: [0, 10, 5] }, presentation: { exposure: 2 }, hold: 0.5 });
  const c = view({ camera: { ...camera, position: [-10, 0, 5] }, motion: 'cut', presentation: { exposure: 0.5 }, hold: 1 });
  const views = [a, b, c]; assert.equal(videoDuration(views), 4.5);
  assert.deepEqual(videoFrameAt(views, 0.9).camera, a.camera);
  assert.equal(videoFrameAt(views, 2).presentation.exposure, 1.5, 'the scene blends from the default exposure while travelling');
  assert.equal(videoFrameAt(views, 3).presentation.exposure, 2);
  assert.deepEqual(videoFrameAt(views, 3.5).camera, c.camera);
  assert.equal(videoFrameAt(views, 999).presentation.exposure, 0.5);
  assert.deepEqual(interpolateVideoCamera(camera, { ...camera, position: [5, 0, 2.5] }, 0.5, 'move').position, [7.5, 0, 3.75]);
  assert.throws(() => studioVideoSequenceSchema.parse([a, ...Array.from({ length: 11 }, () => view())]));
  assert.throws(() => studioVideoSequenceSchema.parse([a, a]));
  assert.throws(() => studioVideoSequenceSchema.parse([view()]));
  assert.throws(() => studioVideoEncodingSchema.parse({ id: randomUUID(), width: 1921, height: 1080, fps: 24, frames: 24 }));
  assert.throws(() => studioVideoEncodingSchema.parse({ id: randomUUID(), width: 1920, height: 1080, fps: 25, frames: 24 }));
});

test('real FFmpeg encodes ordered PNG frames as a complete 1080p H.264 MP4; cancellation releases its slot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibeworks-video-test-'));
  const encoder = new StudioVideoEncoder();
  try {
    const png = (await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
    const spec = { id: randomUUID(), width: 1920 as const, height: 1080 as const, fps: 24 as const, frames: 12 };
    await encoder.start(spec);
    await assert.rejects(encoder.start({ ...spec, id: randomUUID() }));
    await assert.rejects(encoder.frame(spec.id, 1, png));
    await assert.rejects(encoder.frame(spec.id, 0, Buffer.from('invalid')));
    await assert.rejects(encoder.finish(spec.id));
    for (let i = 0; i < 12; i++) assert.equal((await encoder.frame(spec.id, i, png)).frames, i + 1);
    const video = await encoder.finish(spec.id), path = join(directory, 'test.mp4');
    await writeFile(path, video);
    const info = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path])).stdout).streams[0];
    assert.equal(info.codec_name, 'h264'); assert.equal(info.width, 1920); assert.equal(info.height, 1080);
    assert.equal(info.r_frame_rate, '24/1'); assert.equal(Number(info.nb_frames), 12); assert.equal(Number(info.duration), 0.5);
    const next = { ...spec, id: randomUUID() }; await encoder.start(next); await encoder.cancel(next.id);
    await assert.rejects(encoder.frame(next.id, 0, png));
    await encoder.start({ ...spec, id: randomUUID() });
  } finally { await encoder.close(); await rm(directory, { recursive: true, force: true }); }
  const missing = new StudioVideoEncoder('/nonexistent/ffmpeg');
  try { await assert.rejects(missing.start({ id: randomUUID(), width: 1280, height: 720, fps: 24, frames: 12 }), /Install FFmpeg/); }
  finally { await missing.close(); }
});


test('encoder budget expiration remains a typed terminal error after its resources are released', async () => {
  const encoder = new StudioVideoEncoder('ffmpeg', 30), id = randomUUID();
  try {
    await encoder.start({id,width:1280,height:720,fps:24,frames:12});
    await new Promise(resolve=>setTimeout(resolve,100));
    await assert.rejects(encoder.finish(id),(error:any)=>error.code==='VIDEO_BUDGET_EXCEEDED');
    assert.equal(encoder.busy,false);
    await encoder.start({id:randomUUID(),width:1280,height:720,fps:24,frames:12});
  } finally { await encoder.close(); }
});
