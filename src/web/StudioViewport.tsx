import { normalToSurface } from './normal-view';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Evaluation } from '../cad/types';
import { VIEW_DIRECTIONS, type ViewName, type Presentation, type StudioVideoCamera } from '../shared/protocol';
import { imageQuality, imageFrame, imagePixels, type ImageOutput } from '../shared/studio';
import { configureStudioRenderer } from './scene';
import { changeStudioLens, fitStudioCamera, matchStudioProjection, resizeStudioCamera, studioLensFov } from './studio-camera';
import { configureStudioNavigation, studioNavigationHelp, studioWheelIntent, type StudioNavigation } from './studio-navigation';
import { buildStudioAssets, composeStudioScene, disposeStudioAssets, loadStudioLook, releaseStudioScene, type StudioAssets } from './studio-compose';
import { renderStudioImages, type ImageSetOptions } from './studio-image-output';
import { shotFrame } from './shot-frame';
import { shotCamera } from './shots';
import { StudioRenderer, type RenderStatus } from './studio-render';
import type { StudioRender, StudioShot } from './studio-renders';
import { readStudioCamera, writeStudioCamera } from './studio-looks';
import { StudioVideoPreviewRenderer } from './studio-video-preview';
import { studioSettings } from '../shared/studio';

export interface StudioView {
  present: (shot:import('../shared/protocol').Shot,evaluation:Evaluation)=>void;
  view: (view: ViewName) => void;
  normalTo: () => void;
  fit: () => void;
  render: (options?: ImageSetOptions) => void;
  resumePreview: () => void;
  cancel: () => void;
  /** Return the preview camera to a finished image's view. */
  show: (render: StudioRender) => void;
  savePreview: () => void;
  captureVideo: () => StudioVideoCamera | undefined;
  previewVideo: (shot: StudioVideoCamera) => void;
  /** A small raster picture of the current camera with other scene settings, for choosing a look. */
  thumbnail: (settings: Presentation, width: number, height: number, signal: AbortSignal) => Promise<Blob>;
}
export type PreviewState = { phase: 'loading' | 'ready' | 'error'; message?: string };
export type JobState = { phase: 'idle' } | { phase: 'running'; status: RenderStatus; quality: string; width: number; height: number; index?: number; total?: number; label?: string } | { phase: 'error'; message: string };


/** A display-only photographic camera over the same Node-produced meshes as the workbench. */
export function StudioViewport({ evaluation, identity, documentId, revision, settings, output, projection, focalLengthMm, navigation, api, onPreview, onJob, onRendered, onInteraction, onProjection, onLens, onShowingImage, progressThumb, highlightFeatures, onPickFeature, onCameraAzimuth, rememberCamera = true }: {
  evaluation: Evaluation; identity: string; documentId: string; revision: number; settings: Presentation; output: ImageOutput;
  projection: 'perspective' | 'orthographic'; focalLengthMm: number; navigation: StudioNavigation; api: React.RefObject<StudioView | null>;
  onPreview: (state: PreviewState) => void; onJob: (state: JobState) => void;
  onRendered: (render: Omit<StudioRender, 'id' | 'url'>) => StudioRender | Promise<StudioRender>; onInteraction: () => void;
  onProjection: (projection: 'perspective' | 'orthographic') => void;
  onLens: (focalLengthMm: number) => void;
  /** Whether a finished image currently covers the matching preview. */
  onShowingImage: (showing: boolean) => void;
  progressThumb: React.RefObject<HTMLCanvasElement | null>;
  highlightFeatures?: string[];
  onPickFeature?: (featureId: string) => void;
  /** Camera direction around the model, degrees in the same frame as the key light direction. */
  onCameraAzimuth?: (degrees: number) => void;
  /** Restore this browser's last Studio camera for the model and keep it across model updates. */
  rememberCamera?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ settings, output, projection, focalLengthMm, navigation, revision, documentId, onPreview, onJob, onRendered, onInteraction, onProjection, onLens, onShowingImage, highlightFeatures, onPickFeature, onCameraAzimuth, rememberCamera });
  live.current = { settings, output, projection, focalLengthMm, navigation, revision, documentId, onPreview, onJob, onRendered, onInteraction, onProjection, onLens, onShowingImage, highlightFeatures, onPickFeature, onCameraAzimuth, rememberCamera };
  const engine = useRef<{ restage: () => void; projection: () => void; lens: () => void; frame: () => void; highlight: () => void; floor: () => void } | null>(null);
  const tracer = useRef<StudioRenderer | null>(null);
  const job = useRef<{ abort: AbortController; view: number } | null>(null);
  const progress = useRef<HTMLCanvasElement>(null);
  /** Bumped by every camera or framing change, across model updates. */
  const viewVersion = useRef(0);
  /** A scene change waiting for its debounced restage. A render applies it first so it cannot hide the result. */
  const pendingRestage = useRef<number | undefined>(undefined);
  const [frame, setFrame] = useState<{ x: number; y: number; width: number; height: number; guide: boolean }>();
  /** The finished image or live progress shown over the preview while the camera has not moved. */
  const [overlay, setOverlay] = useState<{ kind: 'progress' } | { kind: 'image'; url: string; frame: { x: number; y: number; width: number; height: number } }>();
  const [error, setError] = useState('');
  const [normalPicking, setNormalPicking] = useState(false);
  const normalMode = useRef(false);
  
  const imageLocked = useRef(false); imageLocked.current = overlay?.kind === 'image';

  // The render context outlives model updates: an agent edit does not cancel a running image.
  useEffect(() => {
    const renderer = new StudioRenderer(); tracer.current = renderer;
    renderer.onDisplay = () => {
      for (const target of [progress.current, progressThumb.current]) {
        const ctx = target?.getContext('2d'); if (!target || !ctx) continue;
        ctx.drawImage(renderer.canvas, 0, 0, target.width, target.height);
      }
    };
    return () => { job.current?.abort.abort(); job.current = null; renderer.dispose(); tracer.current = null; };
  }, [progressThumb]);

  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true }); }
    catch { setError('Studio needs WebGL. Enable graphics acceleration and reload.'); live.current.onPreview({ phase: 'error', message: 'WebGL unavailable' }); return; }
    renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label', 'Studio model. ' + studioNavigationHelp(live.current.navigation));
    renderer.domElement.setAttribute('role', 'img'); renderer.domElement.tabIndex = 0; element.prepend(renderer.domElement);
    const perspective = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspective;
    camera.position.set(-1.4, -1.8, 0.95);
    camera.up.set(0, 0, 1); orthographic.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    configureStudioNavigation(controls, 1);
    let assets: StudioAssets | undefined, scene: THREE.Scene | undefined, thumbnails: StudioVideoPreviewRenderer | undefined;
    let stop = false, staging = 0, idle = 0;
    const draw = () => { if (scene && !stop) renderer.render(scene, camera); };
    /**
     * With a floor, the camera stays above it: below, the one-sided floor vanishes and the model floats.
     * The bound follows zoom and target height. No floor allows every direction.
     */
    const keepAboveFloor = () => {
      if (!assets) return false;
      const s = studioSettings(live.current.settings);
      if (s.floor === 'none') { controls.maxPolarAngle = Math.PI; return false; }
      const floorZ = (assets.bounds.min.z + s.floorHeight - assets.center.z) / assets.unit, margin = assets.radius / assets.unit * 0.01;
      const distance = camera.position.distanceTo(controls.target);
      const limit = Math.acos(Math.max(-1, Math.min(1, (floorZ + margin - controls.target.z) / Math.max(distance, 1e-9))));
      controls.maxPolarAngle = Math.max(0.05, limit);
      const polar = Math.acos(Math.max(-1, Math.min(1, (camera.position.z - controls.target.z) / Math.max(distance, 1e-9))));
      return polar > controls.maxPolarAngle + 1e-4;
    };
    let azimuth = NaN;
    /** Any camera or frame change: the preview is current again and overlays no longer match it. */
    const moved = () => {
      if (keepAboveFloor()) { controls.update(); return; }
      viewVersion.current++; if (!imageLocked.current) setOverlay(undefined); draw();
      const offset = camera.position.clone().sub(controls.target);
      if (Math.hypot(offset.x, offset.y) > 1e-9) {
        const next = Math.round(THREE.MathUtils.radToDeg(Math.atan2(offset.y, offset.x)));
        if (next !== azimuth) { azimuth = next; live.current.onCameraAzimuth?.(next); }
      }
      if (assets && live.current.rememberCamera) { clearTimeout(rememberTimer); rememberTimer = window.setTimeout(remember, 400); }
    };
    let rememberTimer = 0;
    const remember = () => { clearTimeout(rememberTimer); if (assets && live.current.rememberCamera) writeStudioCamera(live.current.documentId, shotOf()); };
    const size = () => ({ width: Math.max(element.clientWidth, 1), height: Math.max(element.clientHeight, 1) });
    const updateFrame = () => {
      const viewport = size(), pixels = imagePixels(live.current.output, viewport, window.devicePixelRatio);
      const rect = imageFrame(viewport, pixels);
      setFrame({ ...rect, guide: Math.abs(rect.width - viewport.width) > 1 || Math.abs(rect.height - viewport.height) > 1 });
    };
    const fit = () => {
      if (!assets || assets.points.length < 3) return;
      const { width, height } = size(), bounds = new THREE.Box3(assets.bounds.min.clone().sub(assets.center).divideScalar(assets.unit), assets.bounds.max.clone().sub(assets.center).divideScalar(assets.unit));
      const direction = camera.position.clone().sub(controls.target).normalize();
      const viewport = { width, height }, image = imagePixels(live.current.output, viewport, window.devicePixelRatio);
      const shot = fitStudioCamera(live.current.projection, direction.toArray(), assets.points, bounds, viewport, image, live.current.focalLengthMm);
      if (shot.camera instanceof THREE.PerspectiveCamera) perspective.copy(shot.camera); else orthographic.copy(shot.camera);
      camera = live.current.projection === 'perspective' ? perspective : orthographic; controls.object = camera;
      controls.target.fromArray(shot.tile.target);
      const radius = assets.radius / assets.unit;
      camera.near = Math.max(radius * 0.001, 0.00001); camera.far = radius * 500; camera.updateProjectionMatrix();
      controls.update(); moved();
    };
    const highlight = () => {
      const ids = new Set(live.current.highlightFeatures ?? []);
      scene?.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !object.userData.featureId || object.userData.graphicId) return;
        const material = object.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          object.userData.studioEmissive ??= { color: material.emissive.clone(), intensity: material.emissiveIntensity };
          const original = object.userData.studioEmissive;
          material.emissive.copy(ids.has(object.userData.featureId) ? new THREE.Color('#e8743f') : original.color);
          material.emissiveIntensity = ids.has(object.userData.featureId) ? .45 : original.intensity;
        }
      });
      draw();
    };
    const restage = () => {
      // A scene edit invalidates the image overlay, while its captured render keeps running.
      viewVersion.current++; if (!imageLocked.current) setOverlay(undefined);
      const ticket = ++staging, settings = live.current.settings;
      if (!assets) return;
      void loadStudioLook(settings, assets.radius).then(look => {
        if (stop || ticket !== staging || !assets) return;
        const next = composeStudioScene(assets, settings, look, 'preview');
        configureStudioRenderer(renderer, settings);
        const old = scene; scene = next; highlight(); draw();
        if (old) releaseStudioScene(old);
        live.current.onPreview({ phase: 'ready' });
      }).catch(error => { if (!stop && ticket === staging) { setError(String(error)); live.current.onPreview({ phase: 'error', message: String(error) }); } });
    };
    live.current.onPreview({ phase: 'loading' });
    void buildStudioAssets(evaluation, () => !stop).then(built => {
      if (!built || stop) { if (built) disposeStudioAssets(built); return; }
      assets = built; configureStudioNavigation(controls, assets.radius / assets.unit);
      const savedShot = live.current.rememberCamera ? readStudioCamera(live.current.documentId) : undefined;
      if (savedShot) restoreShot(savedShot); else fit();
      restage();
    }).catch(error => { if (!stop) { const message = 'Studio could not prepare this model. ' + String(error); setError(message); live.current.onPreview({ phase: 'error', message }); } });

    const changeProjection = () => {
      const next = live.current.projection === 'perspective' ? perspective : orthographic;
      if (next === camera) return;
      const viewport = size();
      matchStudioProjection(camera, next, controls.target, viewport.width / viewport.height);
      camera = next; controls.object = next; controls.update(); moved();
    };
    const changeLens = () => {
      const viewport = size(), image = imagePixels(live.current.output, viewport, window.devicePixelRatio);
      changeStudioLens(perspective, controls.target, studioLensFov(live.current.focalLengthMm, viewport, image));
      controls.update(); moved();
    };
    let previousSize = size();
    const resize = new ResizeObserver(() => {
      const { width, height } = size(), scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4.2e6 / (width * height)));
      renderer.setSize(Math.round(width * scale), Math.round(height * scale), false);
      const nextSize = { width, height };
      const image = live.current.output.size === 'viewport' ? undefined : imagePixels(live.current.output, nextSize, window.devicePixelRatio);
      resizeStudioCamera(perspective, previousSize, nextSize, image);
      resizeStudioCamera(orthographic, previousSize, nextSize, image);
      previousSize = nextSize;
      updateFrame(); moved();
    }); resize.observe(element);
    const begin = () => { live.current.onInteraction(); if (tracer.current) tracer.current.interacting = true; clearTimeout(idle); };
    const end = () => { idle = window.setTimeout(() => { if (tracer.current) tracer.current.interacting = false; }, 400); };
    controls.addEventListener('start', begin); controls.addEventListener('end', end); controls.addEventListener('change', moved);
    const wheel = (event: WheelEvent) => {
      const intent = studioWheelIntent(live.current.navigation, event, element.clientHeight);
      if (intent.kind === 'native') return;
      event.preventDefault(); event.stopImmediatePropagation(); begin();
      if (intent.kind === 'pan') controls.pan(intent.x, intent.y);
      else {
        const angle = 2 * Math.PI / Math.max(element.clientHeight, 1);
        controls.rotateLeft(intent.x * angle); controls.rotateUp(intent.y * angle);
      }
      end();
    };
    const focus = (event: MouseEvent) => {
      if (!scene) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
      const parts: THREE.Mesh[] = [];
      scene.traverse(object => { if (object instanceof THREE.Mesh && object.userData.featureId && !object.userData.graphicId) parts.push(object); });
      const hit = ray.intersectObjects(parts, false)[0]; if (!hit) return;
      live.current.onPickFeature?.(hit.object.userData.featureId);
      begin(); camera.position.add(hit.point.clone().sub(controls.target)); controls.target.copy(hit.point); controls.update(); end();
    };
    const cancelNormal = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !normalMode.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); normalMode.current = false; setNormalPicking(false);
    };
    window.addEventListener('keydown', cancelNormal, true);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { normalMode.current = false; setNormalPicking(false); }
      if (event.key.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); if (!imageLocked.current) fit();
    };
    let pointerStart = { x: 0, y: 0 };
    const startPick = (event: PointerEvent) => { pointerStart = { x: event.clientX, y: event.clientY }; };
    const pick = (event: MouseEvent) => {
      if (!scene || imageLocked.current || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
      const hit = ray.intersectObjects(scene.children, true).find(hit => hit.object.userData.featureId && !hit.object.userData.graphicId);
      if (normalMode.current) {
        if (hit && normalToSurface(camera, controls.target, hit)) { normalMode.current = false; setNormalPicking(false); controls.update(); end(); }
        return;
      }
      if (hit) live.current.onPickFeature?.(hit.object.userData.featureId);
    };
    renderer.domElement.addEventListener('pointerdown', startPick);
    renderer.domElement.addEventListener('click', pick);
    renderer.domElement.addEventListener('wheel', wheel, { capture: true, passive: false });
    renderer.domElement.addEventListener('dblclick', focus);
    renderer.domElement.addEventListener('keydown', keydown);

    const shotOf = (): StudioShot => {
      const toModel = (v: THREE.Vector3) => v.clone().multiplyScalar(assets!.unit).add(assets!.center).toArray() as [number, number, number];
      return {
        projection: camera instanceof THREE.PerspectiveCamera ? 'perspective' : 'orthographic', focalLengthMm: live.current.focalLengthMm,
        position: toModel(camera.position), target: toModel(controls.target), up: camera.up.toArray() as [number, number, number],
        fov: perspective.fov, zoom: camera.zoom,
      };
    };
    const render = (options: ImageSetOptions = { rendering: 'fast', layout: 'separate' }) => {
      const studio = tracer.current;
      if (!assets || !studio || studio.busy || job.current) return;
      if (pendingRestage.current !== undefined) { clearTimeout(pendingRestage.current); pendingRestage.current = undefined; restage(); if (keepAboveFloor()) controls.update(); }
      const settings = structuredClone(live.current.settings), output = { ...live.current.output }, quality = imageQuality(output);
      const viewport = size(), pixels = imagePixels(output, viewport, window.devicePixelRatio), rect = imageFrame(viewport, pixels);
      const shotCam = camera.clone(); shotCam.setViewOffset(viewport.width, viewport.height, rect.x, rect.y, rect.width, rect.height);
      shotCam.updateProjectionMatrix(); shotCam.updateMatrixWorld(true);
      const shot = shotOf(), abort = new AbortController(), startedView = viewVersion.current;
      job.current = { abort, view: startedView }; imageLocked.current = false;
      if (progress.current) { progress.current.width = Math.round(rect.width); progress.current.height = Math.round(rect.height); progress.current.getContext('2d')?.clearRect(0, 0, progress.current.width, progress.current.height); }
      setOverlay({ kind: 'progress' }); setError(''); 
      const report = (status: RenderStatus, index = 1, total = 1, label = 'Current view') => live.current.onJob({ phase: 'running', status,
        quality: options.rendering === 'fast' ? 'Fast' : quality.label, width: pixels.width, height: pixels.height, index, total, label });
      report({ phase: 'preparing', samples: 0, target: options.rendering === 'fast' ? 0 : quality.samples, elapsedMs: 0 });
      let last: StudioRender | undefined;
      const capture = { evaluation: structuredClone(evaluation), documentId: live.current.documentId, revision: live.current.revision,
        settings, output, width: pixels.width, height: pixels.height, camera: shotCam, shot };
      void renderStudioImages(capture, options, studio, report, async image => { last = await live.current.onRendered(image); }, abort.signal).then(() => {
        if (job.current?.abort !== abort) return;
        job.current = null; live.current.onJob({ phase: 'idle' });
        if (!abort.signal.aborted && last && viewVersion.current === startedView) { imageLocked.current = true; setOverlay({ kind: 'image', url: last.url, frame: rect }); }
        else setOverlay(undefined);
      }).catch(error => {
        if (job.current?.abort === abort) job.current = null;
        setOverlay(current => current?.kind === 'progress' ? undefined : current);
        if (abort.signal.aborted) { live.current.onJob({ phase: 'idle' }); return; }
        live.current.onJob({ phase: 'error', message: String(error instanceof Error ? error.message : error) });
      });
    };
    const show = (finished: Pick<StudioRender, 'shot'>) => restoreShot(finished.shot);
    function restoreShot(s: StudioShot) {
      if (!assets) return;
      const toScene = (v: [number, number, number]) => new THREE.Vector3(...v).sub(assets!.center).divideScalar(assets!.unit);
      const next = s.projection === 'perspective' ? perspective : orthographic;
      if (s.projection !== live.current.projection) live.current.onProjection(s.projection);
      if (s.focalLengthMm) live.current.onLens(s.focalLengthMm);
      camera = next; controls.object = next;
      if (next === perspective) { perspective.fov = s.fov; }
      next.position.copy(toScene(s.position)); next.up.fromArray(s.up); next.zoom = s.zoom;
      const radius = assets.radius / assets.unit;
      next.near = Math.max(radius * 0.001, 0.00001); next.far = radius * 500;
      controls.target.copy(toScene(s.target)); next.lookAt(controls.target); next.updateProjectionMatrix(); controls.update();
      moved();
    }
    api.current = {
      present: (shot,evaluation) => {
        if(!assets)throw new Error('Studio geometry is not ready.');
        const framed=shotFrame(evaluation,shot),viewport=size();
        const pixels=imagePixels(live.current.output,viewport,window.devicePixelRatio),rect=imageFrame(viewport,pixels);
        const fitted=shotCamera(shot,0,framed.frame,framed.bounds,rect.width/rect.height,rect.height);
        const desired=fitted.camera;
        camera=desired instanceof THREE.PerspectiveCamera?perspective:orthographic;
        camera.position.copy(desired.position).sub(assets.center).divideScalar(assets.unit);
        camera.up.copy(desired.up);controls.target.fromArray(fitted.tile.target).sub(assets.center).divideScalar(assets.unit);
        camera.near=desired.near/assets.unit;camera.far=desired.far/assets.unit;camera.zoom=1;
        if(desired instanceof THREE.PerspectiveCamera){
          perspective.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(desired.fov)/2)*viewport.height/rect.height));
        }else{
          const ortho=desired as THREE.OrthographicCamera;
          orthographic.left=ortho.left/assets.unit*viewport.width/rect.width;orthographic.right=ortho.right/assets.unit*viewport.width/rect.width;
          orthographic.top=ortho.top/assets.unit*viewport.height/rect.height;orthographic.bottom=ortho.bottom/assets.unit*viewport.height/rect.height;
        }
        camera.updateProjectionMatrix();controls.object=camera;controls.update();moved();
      },
      view: view => {
        if (imageLocked.current) return;
        const distance = camera.position.distanceTo(controls.target);
        camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(...VIEW_DIRECTIONS[view]).normalize(), distance);
        camera.up.set(0, 0, 1); camera.lookAt(controls.target); controls.update(); fit();
      },
      normalTo: () => { normalMode.current = !normalMode.current; setNormalPicking(normalMode.current); },
      fit: () => { if (!imageLocked.current) fit(); }, render, show,
      resumePreview: () => { imageLocked.current = false; setOverlay(undefined);  },
      captureVideo: () => {
        if (!assets || camera !== perspective) return undefined;
        const viewport = size(), rect = imageFrame(viewport, { width: 1920, height: 1080 });
        const shot = shotOf();
        return { position: shot.position, target: shot.target, focalLengthMm: live.current.focalLengthMm,
          fov: THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) * rect.height / viewport.height / perspective.zoom)) };
      },
      previewVideo: shot => {
        if (!assets) return;
        const viewport = size(), rect = imageFrame(viewport, { width: 1920, height: 1080 });
        camera = perspective; controls.object = camera;
        perspective.position.fromArray(shot.position).sub(assets.center).divideScalar(assets.unit);
        controls.target.fromArray(shot.target).sub(assets.center).divideScalar(assets.unit);
        perspective.zoom = 1;
        perspective.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(shot.fov) / 2) * viewport.height / rect.height));
        perspective.up.set(0, 0, 1); perspective.lookAt(controls.target); perspective.updateProjectionMatrix();
        live.current.onProjection('perspective');
        live.current.onLens(shot.focalLengthMm);
        controls.update(); moved();
      },
      cancel: () => job.current?.abort.abort(),
      thumbnail: async (settings, width, height, signal) => {
        if (!assets) throw new Error('Studio geometry is not ready.');
        const owned = assets, look = await loadStudioLook(settings, owned.radius); signal.throwIfAborted();
        if (stop || assets !== owned) throw new DOMException('Studio changed.', 'AbortError');
        const shot = camera.clone(), aspect = width / height;
        if (shot instanceof THREE.PerspectiveCamera) shot.aspect = aspect;
        else { const half = (shot.top - shot.bottom) / 2; shot.left = -half * aspect; shot.right = half * aspect; }
        shot.clearViewOffset(); shot.updateProjectionMatrix();
        thumbnails ??= new StudioVideoPreviewRenderer();
        return thumbnails.render({ key: JSON.stringify(settings) + identity, scene: () => composeStudioScene(owned, settings, look, 'preview'), release: releaseStudioScene,
          camera: shot, width, height, presentation: settings }, signal);
      },
      savePreview: () => { draw(); const link = document.createElement('a'); link.download = 'vibeworks-studio-preview.png'; link.href = renderer.domElement.toDataURL('image/png'); link.click(); },
    };
    engine.current = { restage, highlight, projection: changeProjection, lens: changeLens, frame: () => { updateFrame(); moved(); }, floor: () => { if (keepAboveFloor()) controls.update(); } };
    const lost = (event: Event) => { event.preventDefault(); setError('Graphics memory was lost. Exit Studio and reopen it to restore the preview.'); live.current.onPreview({ phase: 'error', message: 'Graphics context lost' }); };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    updateFrame();
    return () => {
      window.removeEventListener('keydown', cancelNormal, true);
      if (assets && live.current.rememberCamera) remember();
      stop = true; clearTimeout(idle); clearTimeout(rememberTimer); resize.disconnect(); thumbnails?.dispose();
      renderer.domElement.removeEventListener('wheel', wheel, true);
      renderer.domElement.removeEventListener('dblclick', focus);
      renderer.domElement.removeEventListener('pointerdown', startPick); renderer.domElement.removeEventListener('click', pick);
      renderer.domElement.removeEventListener('keydown', keydown);
      controls.removeEventListener('start', begin); controls.removeEventListener('end', end); controls.removeEventListener('change', moved); controls.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', lost); api.current = null; engine.current = null;
      if (scene) releaseStudioScene(scene);
      if (assets) disposeStudioAssets(assets);
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  // A new evaluation always arrives with a new identity.
  }, [identity, api]);
  // Scene adjustments restage the preview only. They never start or change a render.
  const previousSettings = useRef(settings);
  useEffect(() => {
    if (previousSettings.current === settings) return; previousSettings.current = settings;
    const timer = window.setTimeout(() => { pendingRestage.current = undefined; engine.current?.restage(); engine.current?.floor(); }, 90);
    pendingRestage.current = timer; return () => { clearTimeout(timer); if (pendingRestage.current === timer) pendingRestage.current = undefined; };
  }, [settings]);
  useEffect(() => { engine.current?.highlight(); }, [highlightFeatures]);
  useEffect(() => { engine.current?.projection(); }, [projection]);
  useEffect(() => { engine.current?.lens(); }, [focalLengthMm]);
  useEffect(() => { engine.current?.frame(); }, [output.size]);
  useEffect(() => { host.current?.querySelector('canvas[role="img"]')?.setAttribute('aria-label', 'Studio model. ' + studioNavigationHelp(navigation)); }, [navigation]);
  useEffect(() => { live.current.onShowingImage(overlay?.kind === 'image'); }, [overlay]);
  return <div className="studio-viewport" data-highlighted-features={highlightFeatures?.join(',')} ref={host}>
    {normalPicking && <button type="button" className="normal-view-prompt" onClick={() => { normalMode.current = false; setNormalPicking(false); }} role="status">Normal To: click a surface · Esc to cancel</button>}
    {frame?.guide && <div className="studio-frame-guide" aria-hidden="true" style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} />}
    <canvas ref={progress} className="studio-render-overlay" aria-hidden="true" hidden={overlay?.kind !== 'progress'} style={frame ? { left: frame.x, top: frame.y, width: frame.width, height: frame.height } : undefined} />
    {overlay?.kind === 'image' && <img className="studio-render-overlay" src={overlay.url} alt="Rendered image of this view" style={{ inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />}
    {overlay?.kind === 'image' && <div className="studio-image-lock" aria-label="Finished image. Use Back to preview to edit the scene." onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} />}
    {error && <p className="studio-render-error" role="alert">{error}</p>}
  </div>;
}
