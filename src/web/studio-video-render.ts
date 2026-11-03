import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import { studioVideoAckSchema, studioVideoEncodingSchema, studioVideoSequenceSchema, type StudioVideoView } from '../shared/protocol';
import { imageQuality, type ImageQuality } from '../shared/studio';
import { buildStudioAssets, composeStudioScene, disposeStudioAssets, loadStudioLook, releaseStudioScene } from './studio-compose';
import { StudioRenderer } from './studio-render';
import { videoDuration, videoFrameAt } from './studio-video-camera';
import { StudioVideoPreviewRenderer } from './studio-video-preview';

declare const __VIBEWORKS_FINGERPRINT__: string;
export const VIDEO_TIME_BUDGET_MS = 30 * 60_000;
export function videoRemainingMs(frameTimes: number[], remaining: number): number | undefined {
  return frameTimes.length >= 2 ? frameTimes.reduce((sum, ms) => sum + ms, 0) / frameTimes.length * remaining : undefined;
}

export interface VideoProgress {
  phase: 'preparing' | 'rendering' | 'encoding'; frames: number; total: number;
  samples: number; target: number; elapsedMs: number; etaMs?: number;
}
/** Freeze the caller's evaluation and recipe before entering this function. Upload and encode one frame at a time. */
export async function renderStudioVideo(evaluation: Evaluation, views: StudioVideoView[], options: { height: 720 | 1080; quality: ImageQuality; denoise: boolean; mode: 'studio' | 'path-traced' },
  progress: (status: VideoProgress) => void, signal: AbortSignal) {
  views = studioVideoSequenceSchema.parse(views);
  const frames = Math.ceil(videoDuration(views) * 24), width = options.height === 1080 ? 1920 : 1280;
  const id = crypto.randomUUID(), spec = studioVideoEncodingSchema.parse({ id, width, height: options.height, fps: 24, frames });
  const started = performance.now(), quality = imageQuality(options), tracing = options.mode === 'path-traced';
  const frameTimes: number[] = [];
  const check = () => signal.throwIfAborted();
  const report = (phase: VideoProgress['phase'], completed: number, samples = 0) => {
    const elapsedMs = performance.now() - started;
    progress({ phase, frames: completed, total: frames, samples, target: tracing ? quality.samples : 0, elapsedMs,
      ...(frameTimes.length >= 2 ? { etaMs: videoRemainingMs(frameTimes, frames - completed) } : {}) });
  };
  report('preparing', 0);
  const connection = await fetch('/api/connection', { cache: 'no-store', signal });
  if (!connection.ok) throw new Error('The local bridge is unavailable. Reconnect before rendering video.');
  const { token } = await connection.json();
  const headers = { Authorization: `Bearer ${token}`, 'X-Vibeworks-Fingerprint': __VIBEWORKS_FINGERPRINT__ };
  const request = async (path: string, body: BodyInit, type: string, abortSignal: AbortSignal = signal) => {
    const response = await fetch('/api/studio-video' + path, { method: 'POST', headers: { ...headers, 'Content-Type': type }, body, signal: abortSignal });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error?.message ?? `Video encoding returned HTTP ${response.status}.`);
    }
    return response;
  };
  const cancel = () => request('', JSON.stringify({ action: 'cancel', id }), 'application/json', AbortSignal.timeout(5000)).catch(() => {});
  // The identity is known before start, so even a lost acknowledgement can be cancelled honestly.
  const abort = () => { void cancel(); };
  signal.addEventListener('abort', abort, { once: true });
  let assets: Awaited<ReturnType<typeof buildStudioAssets>>;
  let renderer: StudioRenderer | undefined, preview: StudioVideoPreviewRenderer | undefined;
  try {
    const accepted = studioVideoAckSchema.parse(await (await request('', JSON.stringify({ action: 'start', encoding: spec }), 'application/json')).json());
    if (accepted.id !== id || accepted.frames !== 0) throw new Error('Video encoder returned a different job.');
    check();
    assets = await buildStudioAssets(evaluation, () => !signal.aborted); check();
    if (!assets) throw new Error('Could not prepare the captured model.');
    if (tracing) renderer = new StudioRenderer(); else preview = new StudioVideoPreviewRenderer();
    const camera = new THREE.PerspectiveCamera(35, 16 / 9, Math.max(assets.radius / assets.unit * 0.001, 1e-5), assets.radius / assets.unit * 500);
    camera.up.set(0, 0, 1);
    let sceneKey = '', look: Awaited<ReturnType<typeof loadStudioLook>> | undefined;
    let previousFrameKey = '', previousBlob: Blob | undefined, completedAt = 0;
    for (let i = 0; i < frames; i++) {
      check();
      // Include both endpoints, with deterministic 24 fps timestamps in the encoded output.
      const frame = videoFrameAt(views, i / (frames - 1) * videoDuration(views));
      const nextKey = JSON.stringify(frame.presentation);
      if (nextKey !== sceneKey || !look) { look = await loadStudioLook(frame.presentation, assets.radius); sceneKey = nextKey; check(); }
      camera.position.fromArray(frame.camera.position).sub(assets.center).divideScalar(assets.unit);
      camera.fov = frame.camera.fov;
      camera.lookAt(new THREE.Vector3(...frame.camera.target).sub(assets.center).divideScalar(assets.unit));
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      const owned = assets, ownedLook = look;
      // Holds have identical captured cameras and scenes. Reuse one finished frame, including its exact samples.
      const frameKey = JSON.stringify([frame.camera, frame.presentation]);
      let blob: Blob;
      if (previousBlob && previousFrameKey === frameKey) blob = previousBlob;
      else if (preview) blob = await preview.render({ key: sceneKey,
        scene: () => composeStudioScene(owned, frame.presentation, ownedLook, 'preview'), release: releaseStudioScene,
        camera, width, height: options.height, presentation: frame.presentation }, signal);
      else blob = (await renderer!.render({ key: sceneKey,
        scene: () => composeStudioScene(owned, frame.presentation, ownedLook, 'trace'), release: releaseStudioScene,
        camera, width, height: options.height, samples: quality.samples, bounces: quality.bounces,
        denoise: options.denoise, exposure: frame.presentation.exposure ?? 1 }, status => report('rendering', i, status.samples), signal)).blob;
      check();
      const ack = studioVideoAckSchema.parse(await (await request(`/frame?id=${id}&index=${i}`, blob, 'image/png')).json());
      if (ack.id !== id || ack.frames !== i + 1) throw new Error('Video encoder acknowledged a different frame.');
      previousFrameKey = frameKey; previousBlob = blob;
      const now = performance.now();
      // Initial scene/shader setup is a one-time cost, not the steady per-frame rate.
      if (completedAt) { frameTimes.push(now - completedAt); if (frameTimes.length > 8) frameTimes.shift(); }
      completedAt = now;
      report('rendering', i + 1);
      if (frameTimes.length >= 8 && now - started + (videoRemainingMs(frameTimes, frames - i - 1) ?? 0) > VIDEO_TIME_BUDGET_MS) {
        throw new Error(`At this speed, this export would exceed 30 minutes. ${tracing ? 'Choose Studio rendering, 720p or a shorter sequence.' : 'Choose 720p or a shorter sequence.'}`);
      }
    }
    report('encoding', frames);
    const response = await request('', JSON.stringify({ action: 'finish', id }), 'application/json');
    const blob = await response.blob(); check();
    if (blob.type !== 'video/mp4' || blob.size < 32 || blob.size > 64 * 1024 * 1024) throw new Error('Video output did not pass validation.');
    return { blob, frames, width, height: options.height, elapsedMs: performance.now() - started };
  } finally {
    signal.removeEventListener('abort', abort);
    renderer?.dispose(); preview?.dispose(); if (assets) disposeStudioAssets(assets);
    await cancel();
  }
}
