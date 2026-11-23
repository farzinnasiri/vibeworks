import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import { studioVideoOutputSchema, studioVideoSequenceSchema, studioVideoViewSchema, videoOutputSize, type Presentation, type StudioVideoOutput, type StudioVideoRecipe, type StudioVideoView, type CadCommand, type CadResult } from '../shared/protocol';
import type { Outcome } from '../cad/runtime';
import type { StudioView } from './StudioViewport';
import { Icon } from './icons';
import type { VideoProgress } from './studio-video-render';
import { videoDuration, videoFrameAt, videoViewTime } from './studio-video-camera';
import { recipeContext, resolveVideoRecipe, viewsToRecipe, videoCropWarnings, focalToFov } from './studio-video-recipe';
import { buildStudioAssets, composeStudioScene, disposeStudioAssets, loadStudioLook, releaseStudioScene } from './studio-compose';
import { StudioVideoPreviewRenderer } from './studio-video-preview';
import { renderSharedStudioVideo } from './studio-video-client';
import { useStudioVideoAnimation } from './use-studio-video-animation';
import './studio-video.css';

export interface VideoProcess { progress?: VideoProgress; error?: string; errorCode?:string; cancel?: () => void }

function readViews(documentId: string): StudioVideoView[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`vibeworks.studio.video.${documentId}`) ?? '[]');
    if (Array.isArray(saved) && saved.length <= 12 && saved.every(v => studioVideoViewSchema.safeParse(v).success)) return saved as StudioVideoView[];
  } catch { /* A missing or obsolete personal sequence starts empty. */ }
  return [];
}
const FORMAT_KEY = 'vibeworks.studio.video-format';
function readFormat(saved?: StudioVideoRecipe): StudioVideoOutput {
  if (saved?.output) return studioVideoOutputSchema.parse(saved.output);
  try { const parsed = studioVideoOutputSchema.safeParse(JSON.parse(localStorage.getItem(FORMAT_KEY) ?? '{}')); if (parsed.success) return parsed.data; } catch { /* preference only */ }
  return studioVideoOutputSchema.parse({});
}
type Preset = NonNullable<StudioVideoRecipe['preset']>['name'];
/** A tiny drawing of each camera move: the model as a box, the camera path as a line with its end marked. */
function PresetGlyph({ name }: { name: Preset }) {
  const path = { turntable: 'M6 16a10 5 0 1 0 20 0a10 5 0 1 0 -20 0', half_orbit: 'M6 16a10 5 0 0 0 20 0', push_pull: 'M3 22L11 17M11 17L4 24',
    detail_reveal: 'M4 23L12 18Q20 12 27 18', crane: 'M5 25Q8 8 26 9' }[name];
  return <svg className="studio-video-glyph" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
    <rect x="12" y="12" width="8" height="8" rx="1.5" /><path d={path} /><circle cx={name === 'turntable' ? 6 : name === 'half_orbit' ? 26 : name === 'push_pull' ? 4 : name === 'crane' ? 26 : 27} cy={name === 'turntable' ? 16 : name === 'half_orbit' ? 16 : name === 'push_pull' ? 24 : name === 'crane' ? 9 : 18} r="2" />
  </svg>;
}
const time = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round(ms / 1000) % 60} s`;
interface FinishedVideo { url: string; revision: number; frames: number; elapsedMs: number; width: number; height: number; fps: number }

export function StudioVideoPanel({ documentId, revision, name, evaluation, settings, api, ready, perspective, interaction, onScene, onBusy, onProcess, saved, onSave, onFrame, selection = [], execute, inspectDisplay }: {
  documentId: string; revision: number; name: string; evaluation: Evaluation; settings: Presentation;
  api: React.RefObject<StudioView | null>; ready: boolean; perspective: boolean; interaction: number;
  onScene: (scene: Presentation | undefined) => void; onBusy: (busy: boolean) => void;
  onProcess: (state: VideoProcess | undefined) => void;
  /** The camera move saved with the model, if any. */
  saved?: StudioVideoRecipe;
  /** Save a recipe with the model; resolves to an error message, or undefined on success. */
  onSave: (recipe: StudioVideoRecipe) => Promise<string | undefined>;
  /** The output frame size, so the preview shows the exact crop. */
  onFrame: (size: { width: number; height: number } | undefined) => void;
  selection?: string[];
  execute: (command: CadCommand) => Promise<CadResult>;
  inspectDisplay?:(params:Extract<CadCommand,{type:'inspect_model'}>['params'])=>Promise<Outcome>;
}) {
  const [views, setViews] = useState(() => readViews(documentId));
  const [selected, setSelected] = useState<string | undefined>(() => views[0]?.id);
  const [previous, setPrevious] = useState<StudioVideoView[]>();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [format, setFormatState] = useState<StudioVideoOutput>(() => readFormat(saved));
  const [saving, setSaving] = useState(false);
  const [animation,setAnimation]=useState<StudioVideoRecipe['animation']>(saved?.animation);
  const [savedViews, setSavedViews] = useState<string>();
  const frame = videoOutputSize(format);
  // The recipe the current views came from, so an untouched move can be reframed when the aspect changes.
  const resolved = useRef<{ recipe: StudioVideoRecipe; from?: StudioVideoView['camera']; key: string }>(undefined);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [editingView, setEditingView] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, { key: string; url: string }>>({});
  const [thumbnailError, setThumbnailError] = useState(false);
  const [progress, setProgress] = useState<VideoProgress>();
  const [error, setError] = useState('');
  const [errorCode,setErrorCode]=useState<string>();
  const [renderState,setRenderState]=useState<'idle'|'running'|'complete'|'cancelled'|'error'>('idle');
  const [storageError, setStorageError] = useState(false);
  const [finished, setFinished] = useState<FinishedVideo>();
  const [viewing, setViewing] = useState(false);
  const abort = useRef<AbortController | null>(null), resultUrl = useRef<string | undefined>(undefined);
  const panel = useRef<HTMLElement | null>(null);
  const viewer = useRef<HTMLDialogElement | null>(null);
  const sceneKey = useRef(''), playhead = useRef(0), restored = useRef(false);
  const live = useRef({ views, onScene, onBusy, onProcess, onFrame }); live.current = { views, onScene, onBusy, onProcess, onFrame };
  const duration = videoDuration(views), valid = studioVideoSequenceSchema.safeParse(views);
  const animationValid=animation?.kind!=='exploded'||animation.offsets.length>0;
  const animationPreview=useStudioVideoAnimation(animation,position,duration,evaluation,documentId,api,inspectDisplay);
  const cropWarnings = useMemo(() => {
    try { return videoCropWarnings(views, recipeContext(evaluation, frame.width, frame.height, settings)); }
    catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  }, [views, evaluation, frame.width, frame.height]);
  const active = views.find(v => v.id === selected);
  const busy = !!progress;
  // Timing and names do not invalidate a photographic camera thumbnail.
  const thumbnailEpoch = useMemo(() => crypto.randomUUID(), [evaluation]);
  const thumbnailKey = JSON.stringify(views.map(({ id, camera, presentation }) => ({ id, camera, presentation })));
  const thumbnailViews = useMemo(() => views.map(({ id, camera, presentation }) => ({ id, camera, presentation })), [thumbnailKey]);
  useEffect(() => {
    if (!ready || busy || !thumbnailViews.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        let assets: Awaited<ReturnType<typeof buildStudioAssets>>;
        let renderer: StudioVideoPreviewRenderer | undefined;
        setThumbnailError(false);
        try {
          assets = await buildStudioAssets(evaluation, () => !controller.signal.aborted);
          if (!assets || controller.signal.aborted) return;
          renderer = new StudioVideoPreviewRenderer();
          const camera = new THREE.PerspectiveCamera(35, frame.width / frame.height, Math.max(assets.radius / assets.unit * .001, 1e-5), assets.radius / assets.unit * 500);
          camera.up.set(0, 0, 1);
          for (const view of thumbnailViews) {
            controller.signal.throwIfAborted();
            const look = await loadStudioLook(view.presentation, assets.radius);
            controller.signal.throwIfAborted();
            camera.position.fromArray(view.camera.position).sub(assets.center).divideScalar(assets.unit);
            camera.fov = view.camera.fov;
            camera.lookAt(new THREE.Vector3(...view.camera.target).sub(assets.center).divideScalar(assets.unit));
            camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
            const owned = assets;
            const thumb = frame.width >= frame.height ? { width: 240, height: Math.round(240 * frame.height / frame.width) } : { width: Math.round(135 * frame.width / frame.height), height: 135 };
            const blob = await renderer.render({ key: JSON.stringify(view.presentation), camera, ...thumb,
              scene: () => composeStudioScene(owned, view.presentation, look, 'preview'), release: releaseStudioScene, presentation: view.presentation }, controller.signal);
            const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
            controller.signal.throwIfAborted();
            setThumbnails(all => ({ ...all, [view.id]: { key: JSON.stringify([thumbnailEpoch, frame.width, frame.height, view.camera, view.presentation]), url } }));
          }
        } catch {
          if (!controller.signal.aborted) setThumbnailError(true);
        } finally { renderer?.dispose(); if (assets) disposeStudioAssets(assets); }
      })();
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [thumbnailViews, thumbnailEpoch, evaluation, ready, busy, frame.width, frame.height]);
  useEffect(() => {
    const ids = new Set(views.map(view => view.id));
    setThumbnails(all => Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
  }, [thumbnailViews]);
  useEffect(() => {
    live.current.onProcess(progress || error ? { progress, error, errorCode, ...(progress ? { cancel: () => { abort.current?.abort(); setError('Video cancelled.');setErrorCode('VIDEO_CANCELLED');setRenderState('cancelled'); } } : {}) } : undefined);
  }, [progress, error,errorCode]);

  useEffect(() => {
    const element = panel.current; if (!element) return;
    const parent = element.parentElement!;
    let handle = 0;
    const observer = new ResizeObserver(() => {
      const height = `${Math.ceil(element.getBoundingClientRect().height)}px`;
      cancelAnimationFrame(handle);
      handle = requestAnimationFrame(() => {
        if (parent.style.getPropertyValue('--studio-video-height') !== height) parent.style.setProperty('--studio-video-height', height);
      });
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(handle); parent.style.removeProperty('--studio-video-height'); };
  }, []);
  useEffect(() => { sceneKey.current = JSON.stringify(settings); }, [settings]);
  useEffect(() => { live.current.onFrame(frame); }, [frame.width, frame.height]);
  useEffect(() => () => live.current.onFrame(undefined), []);
  function setFormat(patch: Partial<StudioVideoOutput>) {
    const next = { ...format, ...patch }; setFormatState(next);
    const source = resolved.current;
    if (next.aspect !== format.aspect && source && source.key === viewsKey) {
      const size = videoOutputSize(next);
      try { const views = resolveVideoRecipe(source.recipe, recipeContext(evaluation, size.width, size.height, settings), source.from); remember(source.recipe, views, source.from); update(views); selectView(views, 0); }
      catch { /* keep the current cameras */ }
    }
    try { localStorage.setItem(FORMAT_KEY, JSON.stringify(next)); } catch { /* preference only */ }
  }

  useEffect(() => {
    try { localStorage.setItem(`vibeworks.studio.video.${documentId}`, JSON.stringify(views)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [documentId, views]);
  useEffect(() => () => {
    abort.current?.abort(); live.current.onBusy(false); live.current.onScene(undefined);
    live.current.onProcess(undefined);
    if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
  }, []);
  useEffect(() => { setPlaying(false); }, [interaction]);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    if (views.length) { selectView(views, 0); return; }
    if (saved) loadSaved();
  }, [ready]);
  useEffect(() => {
    if (!viewing || !viewer.current) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    viewer.current.showModal();
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation(); event.preventDefault(); setViewing(false);
    };
    window.addEventListener('keydown', close, true);
    return () => { window.removeEventListener('keydown', close, true); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [viewing]);
  useEffect(() => {
    if (!playing) return;
    let handle = 0, last = performance.now();
    const frame = (now: number) => {
      const dt = document.hidden ? 0 : Math.min(100, now - last) / 1000; last = now;
      const next = Math.min(videoDuration(live.current.views), playhead.current + dt);
      seek(next);
      if (next < videoDuration(live.current.views)) handle = requestAnimationFrame(frame); else setPlaying(false);
    };
    handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
  }, [playing]);

  function showScene(presentation: Presentation) {
    const key = JSON.stringify(presentation);
    if (sceneKey.current !== key) { sceneKey.current = key; live.current.onScene(presentation); }
  }
  function seek(seconds: number) {
    if (!live.current.views.length) return;
    playhead.current = seconds; setPosition(seconds);
    const frame = videoFrameAt(live.current.views, seconds);
    api.current?.previewVideo(frame.camera); showScene(frame.presentation);
    setSelected(live.current.views[frame.index].id);
  }
  function update(next: StudioVideoView[]) {
    setPlaying(false); setViews(next); setError('');
    const index = next.findIndex(view => view.id === selected), at = index >= 0 ? videoViewTime(next, index) : 0;
    playhead.current = at; setPosition(at);
  }
  function patch(patch: Partial<StudioVideoView>) {
    if (active) update(views.map(v => v.id === active.id ? { ...v, ...patch } : v));
  }
  function capture(frameSelected = false) {
    let camera = api.current?.captureVideo();
    if (!camera) { setError('Choose Perspective and wait for the model preview before saving a view.'); return; }
    if (views.length >= 12) { setError('A sequence can have up to twelve views.'); return; }
    const focus = frameSelected ? { featureIds: selection } : undefined;
    if (focus) {
      try {
        const direction = camera.position.map((x, i) => x - camera!.target[i]) as [number,number,number];
        camera = resolveVideoRecipe({ keyframes: [{ shot: { from: direction, frame: focus }, focalLengthMm: camera.focalLengthMm, focus, motion: 'smooth', seconds: 2, hold: 0 }] }, context())[0].camera;
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); return; }
    }
    const view: StudioVideoView = { id: crypto.randomUUID(), name: `${focus ? 'Selection' : 'View'} ${views.length + 1}`, camera,
      presentation: structuredClone(settings), motion: 'smooth', seconds: 2, hold: views.length ? 0 : 1, ...(focus ? { focus } : {}) };
    const next = [...views, view]; update(next); selectView(next, next.length - 1);
  }
  const context = () => recipeContext(evaluation, frame.width, frame.height, settings);
  function preset(presetName: Preset) {
    const camera = api.current?.captureVideo(); if (!camera) return;
    try {
      // The same resolver agents use: every view is framed for this output, starting from the current camera.
      const recipe = { preset: { name: presetName } };
      const next = resolveVideoRecipe(recipe, context(), camera);
      remember(recipe, next, camera); setPrevious(views); update(next); selectView(next, 0); setPresetsOpen(false); setEditingView(false);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  function loadSaved() {
    if (!saved) return;
    try {
      const next = resolveVideoRecipe(saved, context());
      setAnimation(saved.animation);
      remember(saved, next);
      if (views.length) setPrevious(views);
      update(next); selectView(next, 0); setSavedViews(keyOf(next,saved.animation));
      if (saved.output) setFormatState(studioVideoOutputSchema.parse(saved.output));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  async function saveToModel() {
    if (!valid.success||!animationValid) return;
    setSaving(true); setError('');
    const failure = await onSave(viewsToRecipe(views, format, animation));
    setSaving(false);
    if (failure) setError(failure); else setSavedViews(keyOf(views));
  }
  const keyOf = (list: StudioVideoView[], move=animation) => JSON.stringify([list.map(({ id: _, ...v }) => v),move]);
  const viewsKey = keyOf(views);
  function remember(recipe: StudioVideoRecipe, list: StudioVideoView[], from?: StudioVideoView['camera']) { resolved.current = { recipe, from, key: keyOf(list) }; }
  const savedState = !views.length ? undefined : savedViews === viewsKey && JSON.stringify(saved?.output) === JSON.stringify(format) ? 'saved' : saved ? 'changed' : 'unsaved';
  function push(factor: number) {
    if (!active || views.length >= 12) return;
    const camera = { ...active.camera, position: active.camera.position.map((v, i) => active.camera.target[i] + (v - active.camera.target[i]) * factor) as [number, number, number] };
    const index = views.indexOf(active), view: StudioVideoView = { ...active, id: crypto.randomUUID(), name: factor < 1 ? 'Push in' : 'Pull back', camera, motion: 'move', seconds: 2, hold: 1 };
    const next = [...views.slice(0, index + 1), view, ...views.slice(index + 1)]; update(next); selectView(next, index + 1);
  }
  async function render() {
    if (!valid.success || !animationValid || abort.current) return;
    setPlaying(false); setError('');setErrorCode(undefined);setRenderState('running'); setViewing(false);
    const controller = new AbortController(); abort.current = controller; onBusy(true);
    const timer = window.setTimeout(() => controller.abort(Object.assign(new Error('Video exceeded its 30-minute render budget. Use a lower resolution or a shorter sequence.'),{code:'VIDEO_BUDGET_EXCEEDED'})), 30 * 60_000);
    const capturedRevision = revision;
    try {
      const recipe = viewsToRecipe(valid.data, format, animation);
      setProgress({ phase: 'preparing', frames: 0, total: Math.ceil(duration * format.fps), samples: 0, target: 0, elapsedMs: 0 });
      const result = await renderSharedStudioVideo(execute, documentId, capturedRevision, recipe, settings, setProgress, controller.signal);
      controller.signal.throwIfAborted();
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
      const url = URL.createObjectURL(result.blob); resultUrl.current = url;
      setFinished({ ...result, url, fps: format.fps, revision: capturedRevision });setRenderState('complete'); setViewing(true);
    } catch (error) {
      const failure=controller.signal.aborted?controller.signal.reason:error;
      const cancelled=failure instanceof Error&&failure.name==='AbortError';
      const code=cancelled?'VIDEO_CANCELLED':(failure as {code?:string})?.code??'STUDIO_RENDER_FAILED';
      setError(failure instanceof Error?failure.message:String(failure));setErrorCode(code);setRenderState(cancelled?'cancelled':'error');
    } finally {
      clearTimeout(timer);
      if (abort.current === controller) { abort.current = null; setProgress(undefined); onBusy(false); }
    }
  }

  const download = () => {
    if (!finished) return;
    const a = document.createElement('a'); a.href = finished.url;
    a.download = `${name.replace(/[^\w.-]+/g, '-') || 'vibeworks'}-r${finished.revision}.mp4`; a.click();
  };
  function selectView(sequence: StudioVideoView[], index: number) {
    const view = sequence[index];
    setPlaying(false); setSelected(view?.id);
    const at = view ? videoViewTime(sequence, index) : 0;
    playhead.current = at; setPosition(at);
    if (view) {
      api.current?.previewVideo(view.camera);
      // Explicit selection restores both snapshot halves even when the scene values happen to match.
      sceneKey.current = JSON.stringify(view.presentation); live.current.onScene(view.presentation);
    } else live.current.onScene(undefined);
  }
  const undoSequence = () => {
    if (!previous) return;
    const next = previous; update(next); setPrevious(undefined); selectView(next, 0);
  };
  const replaceCamera = () => {
    const camera = api.current?.captureVideo(); if (camera) patch({ camera, presentation: structuredClone(settings) });
  };
  const reorder = (offset: number) => {
    if (!active) return;
    const next = [...views], i = next.indexOf(active), to = i + offset;
    if (to < 0 || to >= next.length) return;
    [next[to], next[i]] = [next[i], next[to]]; update(next);
  };
  const removeView = () => {
    if (!active) return;
    setPrevious(views); const next = views.filter(v => v.id !== active.id); update(next); selectView(next, Math.max(0, views.indexOf(active) - 1));
  };
  const presets: { id: Preset; label: string; detail: string }[] = [
    { id: 'turntable', label: 'Turntable', detail: '360° orbit · 8 s' },
    { id: 'half_orbit', label: 'Half orbit', detail: '180° orbit · 6 s' },
    { id: 'push_pull', label: 'Close-up', detail: 'Push in, pull back · 8.9 s' },
    { id: 'detail_reveal', label: 'Detail reveal', detail: 'Close-up, orbit, reveal · 10.6 s' },
    { id: 'crane', label: 'Crane', detail: 'Low pass, rise, settle · 9.5 s' },
  ];
  return <>
    {viewing && finished && <dialog ref={viewer} className="studio-viewer studio-video-viewer" aria-label="Finished video" onClose={() => setViewing(false)}>
      <header><span>{finished.width} × {finished.height} · {finished.fps} fps · Fast · r{finished.revision}{revision !== finished.revision ? `, now r${revision}` : ''} · {time(finished.elapsedMs)}</span>
        <div className="studio-viewer-actions"><button className="ghost-button" type="button" onClick={download}><Icon name="export" size={16} />Save MP4</button><button className="icon-button" type="button" autoFocus aria-label="Close video" onClick={() => setViewing(false)}><Icon name="close" /></button></div></header>
      <video src={finished.url} controls playsInline aria-label="Rendered video" />
    </dialog>}
    <section className="studio-video-panel studio-video-editor" aria-label="Video sequence" data-video-state={renderState} data-error-code={errorCode} ref={panel}>
      <div className="studio-video-toolbar">
        <div className="studio-video-heading"><strong>Camera sequence</strong><span>{views.length ? `${views.length} view${views.length === 1 ? '' : 's'} · ${duration.toFixed(1)} s` : saved ? 'A camera move is saved with the model' : 'Start with a camera move'}</span>
          {savedState && <span className={`studio-video-saved ${savedState}`} role="status">{savedState === 'saved' ? 'Saved with the model' : savedState === 'changed' ? 'Differs from the saved move' : 'Only in this browser'}</span>}</div>
        <div className="studio-video-toolbar-actions">
          {saved && savedState === 'changed' && <button type="button" className="link-button" disabled={busy} onClick={loadSaved}>Use saved move</button>}
          {views.length > 0 && savedState !== 'saved' && <button type="button" className="ghost-button small" disabled={busy || saving || !valid.success || !animationValid} onClick={() => void saveToModel()}>{saving ? 'Saving…' : 'Save move to model'}</button>}
          {previous && <button type="button" className="icon-button" disabled={busy} aria-label="Undo sequence change" onClick={undoSequence}><Icon name="undo" size={16} /></button>}
          <button type="button" className="ghost-button small" disabled={busy} aria-expanded={presetsOpen} aria-controls="studio-video-presets" onClick={() => { setPresetsOpen(!presetsOpen); setOutputOpen(false); setEditingView(false); }}><Icon name="rotate" size={15} />Presets</button>
          <button type="button" className="ghost-button small" disabled={busy || !ready || !perspective || views.length >= 12} onClick={() => capture()}><Icon name="plus" size={15} />Add view</button>
          <button type="button" className="ghost-button small" disabled={busy || !ready || !perspective || !selection.length || views.length >= 12} onClick={() => capture(true)}>Frame selected</button>
        </div>
      </div>
      {(presetsOpen || !views.length) && <div className="studio-video-presets" id="studio-video-presets" role="group" aria-label="Video presets">
        {presets.map(presetOption => <button type="button" key={presetOption.id} disabled={busy || !ready || !perspective} onClick={() => preset(presetOption.id)}>
          <PresetGlyph name={presetOption.id} /><span><strong>{presetOption.label}</strong><small>{presetOption.detail}</small></span>
        </button>)}
        {!!views.length && <p>Replaces the sequence. Undo is available.</p>}
      </div>}
      {views.length > 0 && <ol className="studio-video-shots" aria-label="Saved camera views">{views.map((view, i) => {
        const thumbnail = thumbnails[view.id], image = thumbnail?.key === JSON.stringify([thumbnailEpoch, frame.width, frame.height, view.camera, view.presentation]) ? thumbnail.url : undefined;
        return <li key={view.id}><button type="button" className={selected === view.id ? 'active' : ''} aria-label={`View ${i + 1}: ${view.name}`} aria-pressed={selected === view.id} disabled={busy} onClick={() => selectView(views, i)}>
          <span className="studio-video-shot-picture">{image ? <img src={image} alt="" /> : <span className="studio-video-shot-loading">{thumbnailError ? 'Preview unavailable' : 'Preparing preview…'}</span>}<span className="studio-video-shot-index">{String(i + 1).padStart(2, '0')}</span></span>
          <span className="studio-video-shot-caption"><strong>{view.name}</strong><small>{i === 0 ? 'Start' : view.motion === 'cut' ? 'Cut' : `${view.seconds} s ${view.motion === 'smooth' ? 'path' : view.motion === 'orbit' ? 'orbit' : 'move'}`}{view.hold ? ` · hold ${view.hold} s` : ''}</small></span>
        </button></li>;
      })}</ol>}
      {views.length > 0 && <div className="studio-video-transport">
        <button type="button" className="icon-button" aria-label={playing ? 'Pause video preview' : 'Play video preview'} aria-pressed={playing} disabled={busy || !ready || !valid.success} onClick={() => { if (position >= duration) seek(0); setPlaying(!playing); }}><Icon name={playing ? 'pause' : 'play'} size={18} /></button>
        <span className="studio-video-scrubber">
          <input type="range" aria-label="Video playhead" aria-valuetext={`${position.toFixed(1)} of ${duration.toFixed(1)} seconds`} min={0} max={Math.max(duration, 0.5)} step={1 / format.fps} value={Math.min(position, duration)} disabled={busy || !ready} onChange={e => { setPlaying(false); seek(Number(e.target.value)); }} />
          <span className="studio-video-ticks" aria-hidden="true">{views.map((view, i) => <i key={view.id} className={view.id === selected ? 'active' : ''} style={{ left: `${duration ? videoViewTime(views, i) / duration * 100 : 0}%` }} />)}</span>
        </span><output>{position.toFixed(1)} / {duration.toFixed(1)} s</output>
        {active && <button type="button" className="ghost-button small" disabled={busy} aria-expanded={editingView} aria-controls="studio-video-view-editor" onClick={() => { setEditingView(!editingView); setPresetsOpen(false); setOutputOpen(false); }}><Icon name="sliders" size={15} />Edit view</button>}
      </div>}
      {!!views.length && <fieldset className="studio-video-model-animation" disabled={busy}>
        <label>Model animation<select aria-label="Model animation" value={animation?.kind??'none'} onChange={e=>{
          setAnimation(e.target.value==='construction'?{kind:'construction'}:e.target.value==='exploded'?{kind:'exploded',offsets:[],direction:'out_and_back'}:undefined);
        }}><option value="none">Static model</option><option value="construction" disabled={!inspectDisplay}>Construction</option><option value="exploded">Exploded view</option></select></label>
        {animation?.kind==='construction'&&<p>{animationPreview.note||'Exact build steps from a frozen model. Preview may wait for geometry.'}</p>}
        {animation?.kind==='exploded'&&<>
          <button type="button" className="ghost-button small" disabled={!selection.length||animation.offsets.length>=64} onClick={()=>setAnimation({...animation,offsets:[...animation.offsets,...selection.filter(id=>!animation.offsets.some(o=>o.featureId===id)).map(featureId=>({featureId,offsetMm:[0,0,30] as [number,number,number]}))]})}>Add selected offset</button>
          <label>Direction<select aria-label="Explosion direction" value={animation.direction} onChange={e=>setAnimation({...animation,direction:e.target.value as typeof animation.direction})}><option value="out_and_back">Out and back</option><option value="out">Explode</option><option value="in">Assemble</option></select></label>
          {animation.offsets.map((offset,index)=><div className="studio-video-offset" key={offset.featureId}><span>{offset.featureId}</span>{(['X','Y','Z'] as const).map((axis,n)=><label key={axis}>{axis}, mm<input type="number" aria-label={`${offset.featureId} ${axis} offset`} value={offset.offsetMm[n]} onChange={e=>{
            const value=e.target.valueAsNumber;if(!Number.isFinite(value)||Math.abs(value)>100000)return;
            setAnimation({...animation,offsets:animation.offsets.map((o,i)=>i!==index?o:{...o,offsetMm:o.offsetMm.map((v,j)=>j===n?value:v) as [number,number,number]})});
          }}/></label>)}<button type="button" className="icon-button" aria-label={`Remove offset ${offset.featureId}`} onClick={()=>setAnimation({...animation,offsets:animation.offsets.filter((_,i)=>i!==index)})}><Icon name="close"/></button></div>)}
          {!animation.offsets.length&&<p>Click a part, then add its display offset. The saved assembly stays assembled.</p>}
        </>}
      </fieldset>}
      {active && editingView && <div className="studio-video-details" id="studio-video-view-editor"><fieldset disabled={busy}>
        <div className="studio-video-edit-fields"><label>View name<input aria-label="View name" maxLength={40} value={active.name} onChange={e => patch({ name: e.target.value })} /></label>
          {views.indexOf(active) > 0 && <div className="studio-video-motion"><span>Movement</span><div role="group" aria-label="Camera movement">{(['smooth', 'orbit', 'move', 'cut'] as const).map(motion => <button className="ghost-button small" key={motion} type="button" aria-pressed={active.motion === motion} onClick={() => patch({ motion })}>{motion === 'smooth' ? 'Smooth path' : motion === 'orbit' ? 'Orbit' : motion === 'move' ? 'Direct' : 'Cut'}</button>)}</div></div>}
          <label>Lens, mm<input aria-label="Lens millimetres" type="number" min={10} max={300} step={1} value={active.camera.focalLengthMm} onChange={e => {
            const focalLengthMm = e.target.valueAsNumber;
            if (!Number.isFinite(focalLengthMm) || focalLengthMm < 10 || focalLengthMm > 300) return;
            const camera = { ...active.camera, focalLengthMm, fov: focalToFov(focalLengthMm, frame.width / frame.height) };
            patch({ camera }); api.current?.previewVideo(camera);
          }} /></label>
          <label>Easing<select aria-label="Segment easing" value={active.easing ?? 'auto'} onChange={e => patch({ easing: e.target.value as StudioVideoView['easing'] })}>
            <option value="auto">Automatic</option><option value="linear">Constant pace</option><option value="ease_in">Ease in</option><option value="ease_out">Ease out</option><option value="ease_in_out">Ease in and out</option>
          </select></label>
          {views.indexOf(active) > 0 && active.motion !== 'cut' && <label>Move, s<input aria-label="Move seconds" type="number" min={0.5} max={10} step={0.5} value={active.seconds} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value) && value >= .5 && value <= 10) patch({ seconds: value }); }} /></label>}
          <label>Hold, s<input aria-label="Hold seconds" type="number" min={0} max={5} step={0.5} value={active.hold} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value) && value >= 0 && value <= 5) patch({ hold: value }); }} /></label>
        </div>
        <div className="studio-video-edit-actions">
          <button type="button" className="ghost-button small" disabled={!selection.length} onClick={() => {
            try { const focus = { featureIds: selection }, camera = { ...active.camera, target: resolveVideoRecipe({ keyframes: [{ shot: { frame: focus }, motion: 'smooth', seconds: 2, hold: 0 }] }, context())[0].camera.target };
              patch({ focus, camera }); api.current?.previewVideo(camera); }
            catch (error) { setError(error instanceof Error ? error.message : String(error)); }
          }}>Aim at selected</button>
          {active.focus && <button type="button" className="link-button" onClick={() => patch({ focus: undefined })}>Use fixed target</button>}
          <button type="button" className="ghost-button small" disabled={!ready || !perspective} onClick={replaceCamera}><Icon name="camera" size={15} />Update from preview</button>
          <button type="button" className="ghost-button small" disabled={views.length >= 12} onClick={() => push(.75)}>Push in</button><button type="button" className="ghost-button small" disabled={views.length >= 12} onClick={() => push(1.3)}>Pull back</button>
          <span className="studio-video-edit-divider" />
          <button type="button" className="icon-button" aria-label="Move view earlier" disabled={views.indexOf(active) === 0} onClick={() => reorder(-1)}><Icon name="chevron-left" size={16} /></button>
          <button type="button" className="icon-button" aria-label="Move view later" disabled={views.indexOf(active) === views.length - 1} onClick={() => reorder(1)}><Icon name="arrow-right" size={16} /></button>
          <button type="button" className="icon-button" aria-label="Remove view" onClick={removeView}><Icon name="delete" size={16} /></button>
        </div>
        <details className="studio-video-advanced"><summary>Camera distance</summary><label>Distance, mm<input aria-label="Camera distance" type="number" min={.01} step={1} value={Number(Math.hypot(...active.camera.position.map((v,i) => v-active.camera.target[i])).toFixed(2))} onChange={e => {
          const distance = e.target.valueAsNumber, current = Math.hypot(...active.camera.position.map((v,i) => v-active.camera.target[i]));
          if (!Number.isFinite(distance) || distance <= 0 || !current) return;
          const camera = { ...active.camera, position: active.camera.position.map((v,i) => active.camera.target[i]+(v-active.camera.target[i])*distance/current) as [number,number,number] };
          patch({ camera }); api.current?.previewVideo(camera);
        }} /></label></details>
      </fieldset></div>}
      {outputOpen && <fieldset className="studio-video-export-settings" disabled={busy} id="studio-video-export-settings">
        <div><span>Frame</span><div role="group" aria-label="Video aspect">{(['16:9', '9:16', '1:1', '4:5'] as const).map(aspect => {
          const [w, h] = aspect.split(':').map(Number), k = 14 / Math.max(w, h);
          return <button type="button" className="ghost-button small studio-video-aspect" key={aspect} aria-pressed={format.aspect === aspect} onClick={() => setFormat({ aspect })}>
            <i aria-hidden="true" style={{ width: Math.round(w * k), height: Math.round(h * k) }} />{aspect}</button>;
        })}</div></div>
        <div><span>Size</span><div role="group" aria-label="Video size">{(['720p', '1080p', '4k'] as const).map(value => <button type="button" className="ghost-button small" key={value} aria-pressed={format.resolution === value} onClick={() => setFormat({ resolution: value })}>{value === '4k' ? '4K' : value}</button>)}</div></div>
        <div><span>Frame rate</span><div role="group" aria-label="Frame rate">{([24, 30, 60] as const).map(fps => <button type="button" className="ghost-button small" key={fps} aria-pressed={format.fps === fps} onClick={() => setFormat({ fps })}>{fps}</button>)}</div></div>
        <div><span>Encoding</span><div role="group" aria-label="Encoding quality">{(['standard', 'high'] as const).map(quality => <button type="button" className="ghost-button small" key={quality} aria-pressed={format.quality === quality} onClick={() => setFormat({ quality })}>{quality === 'standard' ? 'Standard' : 'High'}</button>)}</div></div>
        <div><span>Surface detail</span><div role="group" aria-label="Final surface detail">{(['standard','fine'] as const).map(meshDetail=><button type="button" className="ghost-button small" key={meshDetail} aria-pressed={(format.meshDetail??'fine')===meshDetail} onClick={()=>setFormat({meshDetail})}>{meshDetail==='fine'?'Fine':'Standard'}</button>)}</div></div>
        <label><input type="checkbox" aria-label="Depth of field" checked={!!format.depthOfField} onChange={e=>setFormat({depthOfField:e.target.checked?{fStop:4}:undefined})}/>Depth of field</label>
        {format.depthOfField&&<label>Aperture, f/<input type="number" aria-label="Aperture f-stop" min={1} max={32} step={.2} value={format.depthOfField.fStop} onChange={e=>{const fStop=e.target.valueAsNumber;if(Number.isFinite(fStop)&&fStop>=1&&fStop<=32)setFormat({depthOfField:{fStop}});}}/></label>}
        <p>Fine re-tessellates the exact model for smooth reflections. Depth of field focuses on the camera target in final Fast frames; smaller f-stops soften more of the background.</p>
        <div><span>Rendering</span><div role="group" aria-label="Video rendering"><button type="button" className="ghost-button small" aria-pressed="true">Fast</button><button type="button" className="ghost-button small" aria-pressed="false" disabled aria-describedby="video-realistic-limit">Realistic</button></div></div>
        <p>{frame.width} × {frame.height} · {Math.ceil(duration * format.fps)} frames. Fast uses Studio lighting and materials.</p><p id="video-realistic-limit">Realistic video is unavailable until renders can resume after interruption. Use High quality in Image for path-traced stills.</p>
      </fieldset>}
      <div className="studio-video-output">
        <button type="button" className="studio-video-export-summary" disabled={busy} aria-expanded={outputOpen} aria-controls="studio-video-export-settings" onClick={() => { setOutputOpen(!outputOpen); setEditingView(false); setPresetsOpen(false); }}><Icon name="sliders" size={15} /><span>MP4 · {format.aspect} · {format.resolution === '4k' ? '4K' : format.resolution} · {format.fps} fps · Fast</span></button>
        {finished && !busy && <button type="button" className="ghost-button small" onClick={() => setViewing(true)}>Last video</button>}
        {busy ? <button type="button" className="primary-button" disabled>Rendering video…</button>
          : <button type="button" className="primary-button" disabled={!ready || !valid.success || !animationValid} onClick={() => void render()}><Icon name="camera" size={16} />Render video</button>}
      </div>
      {!perspective && <p className="studio-video-note">Choose Perspective to save camera views.</p>}
      {cropWarnings.map(warning => <p className="studio-video-note" role="status" key={warning}>{warning}</p>)}
      {views.length > 0 && !valid.success && <p className="studio-video-error" role="alert">{valid.error.issues[0].message}</p>}
      {storageError && <p className="studio-video-error" role="alert">Browser storage is unavailable. Keep Studio open to retain this sequence.</p>}
      {animationPreview.error&&<p className="studio-video-error" role="alert">{animationPreview.error}</p>}
    </section>
  </>;
}
