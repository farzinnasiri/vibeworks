import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import { VIEW_DIRECTIONS, type Presentation, type ViewName as NamedView } from '../shared/protocol';
import { viewLabel } from './views';
import { imageQuality, type ImageOutput } from '../shared/studio';
import { buildStudioAssets, composeStudioScene, disposeStudioAssets, loadStudioLook, releaseStudioScene } from './studio-compose';
import type { StudioRenderer, RenderStatus } from './studio-render';
import { StudioVideoPreviewRenderer } from './studio-video-preview';
import { shotCamera } from './shots';
import type { StudioRender, StudioShot } from './studio-renders';

export interface ImageSetOptions { rendering: 'fast' | 'quality'; views?: NamedView[]; layout: 'separate' | 'sheet'; labels?: boolean }
export interface StudioImageTile { x: number; y: number; width: number; height: number; imageHeight: number; labelHeight: number }

/** Every row fills the sheet. Integer edges share boundaries, including odd output dimensions. */
export function studioImageLayout(count: number, width: number, height: number, labels = false): StudioImageTile[] {
  if (!Number.isInteger(count) || count < 1 || count > 16 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError('An image sheet needs one to sixteen views and positive integer dimensions.');
  const rows = Math.ceil(count / 3), base = Math.floor(count / rows), extra = count % rows;
  if (height < rows || width < base + (extra ? 1 : 0)) throw new RangeError('The image is too small for these views. Choose a larger output size.');
  const tiles: StudioImageTile[] = [];
  for (let row = 0; row < rows; row++) {
    const columns = base + (row < extra ? 1 : 0), y = Math.floor(row * height / rows), bottom = Math.floor((row + 1) * height / rows);
    const tileHeight = bottom - y, labelHeight = labels ? Math.min(32, Math.floor(tileHeight * .18)) : 0;
    for (let column = 0; column < columns; column++) {
      const x = Math.floor(column * width / columns), right = Math.floor((column + 1) * width / columns);
      tiles.push({ x, y, width: right - x, height: tileHeight, imageHeight: tileHeight - labelHeight, labelHeight });
    }
  }
  return tiles;
}
type CapturedImage = Omit<StudioRender, 'id' | 'url'>;
const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed.')), 'image/png'));
export async function imageThumbnail(blob: Blob) {
  const image = await createImageBitmap(blob), canvas = document.createElement('canvas');
  try { canvas.width = 128; canvas.height = Math.max(1, Math.round(128 * image.height / image.width)); canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height); return await toBlob(canvas); }
  finally { image.close(); canvas.width = canvas.height = 0; }
}

/** Each image set owns frozen model data, scene assets and cameras. Live edits never replace its inputs. */
export async function renderStudioImages(capture: { evaluation: Evaluation; documentId: string; revision: number; settings: Presentation;
  output: ImageOutput; width: number; height: number; camera: THREE.PerspectiveCamera | THREE.OrthographicCamera; shot: StudioShot },
  options: ImageSetOptions, tracer: StudioRenderer | undefined, onStatus: (status: RenderStatus, index: number, total: number, label: string) => void,
  onImage: (image: CapturedImage) => void | Promise<void>, signal: AbortSignal) {
  const started = performance.now(), check = () => signal.throwIfAborted();
  const labels = options.views?.length ? options.views : ['Current view'];
  const sheet = options.layout === 'sheet' && !!options.views?.length;
  const tiles = sheet ? studioImageLayout(labels.length, capture.width, capture.height, options.labels)
    : labels.map(() => ({ x: 0, y: 0, width: capture.width, height: capture.height, imageHeight: capture.height, labelHeight: 0 }));
  const assets = await buildStudioAssets(capture.evaluation, () => !signal.aborted); check();
  if (!assets) throw new Error('The captured model is unavailable.');
  let preview: StudioVideoPreviewRenderer | undefined;
  const canvas = sheet ? document.createElement('canvas') : undefined;
  if (canvas) { canvas.width = capture.width; canvas.height = capture.height; const ctx = canvas.getContext('2d')!;  }
  const quality = imageQuality(capture.output), key = crypto.randomUUID();
  let firstShot = capture.shot;
  let imageSetBytes = 0;
  try {
    if (options.rendering === 'fast') preview = new StudioVideoPreviewRenderer();
    const look = await loadStudioLook(capture.settings, assets.radius); check();
    const bounds = new THREE.Box3(assets.bounds.min.clone().sub(assets.center).divideScalar(assets.unit), assets.bounds.max.clone().sub(assets.center).divideScalar(assets.unit));
    for (let i = 0; i < labels.length; i++) {
      check(); const label = labels[i];
      const tile = tiles[i], width = tile.width, height = tile.imageHeight;
      const named = options.views?.[i];
      const settings = named && VIEW_DIRECTIONS[named][2] < 0 ? { ...capture.settings, floor: 'none' as const, backdrop: 'plane' as const } : capture.settings;
      const sceneKey = key + JSON.stringify(settings);
      const fit = named ? shotCamera({ view: named, projection: capture.shot.projection, fovDegrees: capture.shot.fov }, i, assets.points, bounds, width / height, height) : undefined;
      const camera = fit?.camera ?? capture.camera;
      const shot: StudioShot = fit ? { projection: fit.tile.projection, position: camera.position.clone().multiplyScalar(assets.unit).add(assets.center).toArray(),
        target: new THREE.Vector3(...fit.tile.target).multiplyScalar(assets.unit).add(assets.center).toArray(), up: camera.up.toArray(), fov: camera instanceof THREE.PerspectiveCamera ? camera.fov : capture.shot.fov, zoom: camera.zoom } : capture.shot;
      if (!i) firstShot = shot;
      const report = (status: RenderStatus) => onStatus({ ...status, elapsedMs: performance.now() - started }, i + 1, labels.length, label);
      report({ phase: 'preparing', samples: 0, target: preview ? 0 : quality.samples, elapsedMs: 0 });
      let blob: Blob, hiddenMs = 0, samples = 0;
      if (preview) {
        report({ phase: 'rendering', samples: 0, target: 0, elapsedMs: 0 });
        // Supersample fast images where the fixed eight-million-pixel drawing budget permits it.
        const scale = Math.min(1.5, Math.sqrt(8_294_400 / (width * height)));
        const large = await preview.render({ key: sceneKey, scene: () => composeStudioScene(assets, settings, look, 'preview'), release: releaseStudioScene,
          camera, width: Math.round(width * scale), height: Math.round(height * scale), presentation: settings }, signal);
        const bitmap = await createImageBitmap(large), resized = document.createElement('canvas');
        try { resized.width = width; resized.height = height; const ctx = resized.getContext('2d')!; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bitmap, 0, 0, width, height); blob = await toBlob(resized); }
        finally { bitmap.close(); resized.width = resized.height = 0; }
      } else {
        if (!tracer) throw new Error('High quality images need an image renderer.');
        const result = await tracer.render({ key: sceneKey, scene: () => composeStudioScene(assets, settings, look, 'trace'), release: releaseStudioScene,
          camera, width, height, samples: quality.samples, bounces: quality.bounces, denoise: capture.output.denoise, exposure: settings.exposure ?? 1 }, report, signal);
        blob = result.blob; samples = result.samples; hiddenMs = result.hiddenMs;
      }
      check();
      imageSetBytes += blob.size;
      if (!canvas && imageSetBytes > 64 * 1024 * 1024) throw new Error('This image set exceeds 64 MB. Completed images remain in history. Choose fewer views or a smaller image size.');
      const metadata = { documentId: capture.documentId, revision: capture.revision, setId: key, createdAt: Date.now(), quality: preview ? 'Fast' : quality.label,
        samples, elapsedMs: performance.now() - started, hiddenMs, settings, renderer: preview ? 'Studio WebGL, supersampled' : 'three-gpu-pathtracer 0.0.27 WebGPU' };
      if (canvas) {
        const bitmap = await createImageBitmap(blob);
        try { const { x, y } = tile, ctx = canvas.getContext('2d')!;
          ctx.drawImage(bitmap, x, y, width, height);
          if (tile.labelHeight) {
            ctx.fillStyle = '#f5f4f0'; ctx.fillRect(x, y + height, width, tile.labelHeight);
            ctx.save(); ctx.beginPath(); ctx.rect(x, y + height, width, tile.labelHeight); ctx.clip();
            ctx.fillStyle = '#252728'; ctx.font = `${Math.max(1, Math.min(16, tile.labelHeight * .5))}px sans-serif`; ctx.textBaseline = 'middle';
            ctx.fillText(named ? viewLabel(named) : label, x + Math.min(12, width * .05), y + height + tile.labelHeight / 2); ctx.restore();
          }
        } finally { bitmap.close(); }
        if (i === labels.length - 1) { blob = await toBlob(canvas); check(); await onImage({ ...metadata, settings: capture.settings, blob, thumbnail: await imageThumbnail(blob), width: capture.width, height: capture.height, shot: firstShot, label: 'View sheet', views: [...labels] }); }
      } else await onImage({ ...metadata, blob, thumbnail: await imageThumbnail(blob), width, height, shot, label });
    }
  } finally { preview?.dispose(); disposeStudioAssets(assets); if (canvas) canvas.width = canvas.height = 0; }
}
