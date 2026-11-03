import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import { studioVideoSequenceSchema, studioVideoViewSchema, type Presentation, type StudioVideoView } from '../shared/protocol';
import type { ImageOutput } from '../shared/studio';
import type { StudioView } from './StudioViewport';
import { Icon } from './icons';
import { renderStudioVideo, VIDEO_TIME_BUDGET_MS, type VideoProgress } from './studio-video-render';
import { videoPresetViews, type VideoPreset, videoDuration, videoFrameAt, videoViewTime } from './studio-video-camera';
import { buildStudioAssets, composeStudioScene, disposeStudioAssets, loadStudioLook, releaseStudioScene } from './studio-compose';
import { StudioVideoPreviewRenderer } from './studio-video-preview';
import './studio-video.css';

export interface VideoProcess { progress?: VideoProgress; error?: string; cancel?: () => void }

function readViews(documentId: string): StudioVideoView[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`vibeworks.studio.video.${documentId}`) ?? '[]');
    if (Array.isArray(saved) && saved.length <= 12 && saved.every(v => studioVideoViewSchema.safeParse(v).success)) return saved as StudioVideoView[];
  } catch { /* A missing or obsolete personal sequence starts empty. */ }
  return [];
}
const time = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round(ms / 1000) % 60} s`;
interface FinishedVideo { url: string; revision: number; frames: number; elapsedMs: number; width: number; height: number; mode: 'studio' | 'path-traced' }

export function StudioVideoPanel({ documentId, revision, name, evaluation, settings, output, api, ready, perspective, interaction, onScene, onBusy, onProcess }: {
  documentId: string; revision: number; name: string; evaluation: Evaluation; settings: Presentation; output: ImageOutput;
  api: React.RefObject<StudioView | null>; ready: boolean; perspective: boolean; interaction: number;
  onScene: (scene: Presentation | undefined) => void; onBusy: (busy: boolean) => void;
  onProcess: (state: VideoProcess | undefined) => void;
}) {
  const [views, setViews] = useState(() => readViews(documentId));
  const [selected, setSelected] = useState<string | undefined>(() => views[0]?.id);
  const [previous, setPrevious] = useState<StudioVideoView[]>();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [height, setHeight] = useState<720 | 1080>(1080);
  const [mode, setMode] = useState<'studio' | 'path-traced'>('studio');
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [editingView, setEditingView] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, { key: string; url: string }>>({});
  const [thumbnailError, setThumbnailError] = useState(false);
  const [progress, setProgress] = useState<VideoProgress>();
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [finished, setFinished] = useState<FinishedVideo>();
  const [viewing, setViewing] = useState(false);
  const abort = useRef<AbortController | null>(null), resultUrl = useRef<string | undefined>(undefined);
  const panel = useRef<HTMLElement | null>(null);
  const viewer = useRef<HTMLDialogElement | null>(null);
  const sceneKey = useRef(''), playhead = useRef(0), restored = useRef(false);
  const live = useRef({ views, onScene, onBusy, onProcess }); live.current = { views, onScene, onBusy, onProcess };
  const duration = videoDuration(views), valid = studioVideoSequenceSchema.safeParse(views);
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
          const camera = new THREE.PerspectiveCamera(35, 16 / 9, Math.max(assets.radius / assets.unit * .001, 1e-5), assets.radius / assets.unit * 500);
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
            const blob = await renderer.render({ key: JSON.stringify(view.presentation), camera, width: 240, height: 135,
              scene: () => composeStudioScene(owned, view.presentation, look, 'preview'), release: releaseStudioScene, presentation: view.presentation }, controller.signal);
            const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
            controller.signal.throwIfAborted();
            setThumbnails(all => ({ ...all, [view.id]: { key: JSON.stringify([thumbnailEpoch, view.camera, view.presentation]), url } }));
          }
        } catch {
          if (!controller.signal.aborted) setThumbnailError(true);
        } finally { renderer?.dispose(); if (assets) disposeStudioAssets(assets); }
      })();
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [thumbnailViews, thumbnailEpoch, evaluation, ready, busy]);
  useEffect(() => {
    const ids = new Set(views.map(view => view.id));
    setThumbnails(all => Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
  }, [thumbnailViews]);
  useEffect(() => {
    live.current.onProcess(progress || error ? { progress, error, ...(progress ? { cancel: () => { abort.current?.abort(); setError('Video cancelled.'); } } : {}) } : undefined);
  }, [progress, error]);

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
    if (views.length) selectView(views, 0);
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
  function capture() {
    const camera = api.current?.captureVideo();
    if (!camera) { setError('Choose Perspective and wait for the model preview before saving a view.'); return; }
    if (views.length >= 12) { setError('A sequence can have up to twelve views.'); return; }
    const view: StudioVideoView = { id: crypto.randomUUID(), name: `View ${views.length + 1}`, camera, presentation: structuredClone(settings), motion: 'orbit', seconds: 2, hold: views.length ? 0 : 1 };
    const next = [...views, view]; update(next); selectView(next, next.length - 1);
  }
  function preset(presetName: VideoPreset) {
    const camera = api.current?.captureVideo(); if (!camera) return;
    setPrevious(views); const next = videoPresetViews(presetName, camera, settings); update(next); selectView(next, 0); setPresetsOpen(false); setEditingView(false);
  }
  function push(factor: number) {
    if (!active || views.length >= 12) return;
    const camera = { ...active.camera, position: active.camera.position.map((v, i) => active.camera.target[i] + (v - active.camera.target[i]) * factor) as [number, number, number] };
    const index = views.indexOf(active), view: StudioVideoView = { ...active, id: crypto.randomUUID(), name: factor < 1 ? 'Push in' : 'Pull back', camera, motion: 'move', seconds: 2, hold: 1 };
    const next = [...views.slice(0, index + 1), view, ...views.slice(index + 1)]; update(next); selectView(next, index + 1);
  }
  async function render() {
    if (!valid.success || abort.current) return;
    setPlaying(false); setError(''); setViewing(false);
    const controller = new AbortController(); abort.current = controller; onBusy(true);
    const timer = window.setTimeout(() => controller.abort(new Error('Video exceeded its 30-minute render budget. Choose Studio rendering, 720p or a shorter sequence.')), VIDEO_TIME_BUDGET_MS);
    const capturedRevision = revision;
    // Runtime updates replace the live evaluation. Own a deep capture for the entire sequence.
    try {
      const captured = structuredClone(evaluation), recipe = structuredClone(valid.data);
      setProgress({ phase: 'preparing', frames: 0, total: Math.ceil(duration * 24), samples: 0, target: 0, elapsedMs: 0 });
      const result = await renderStudioVideo(captured, recipe, { height, quality: output.quality, denoise: output.denoise, mode }, setProgress, controller.signal);
      if (controller.signal.aborted) return;
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
      const url = URL.createObjectURL(result.blob); resultUrl.current = url;
      setFinished({ ...result, url, revision: capturedRevision, mode }); setViewing(true);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      else if (controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError') setError(controller.signal.reason.message);
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
  const presets: { id: VideoPreset; label: string; detail: string }[] = [
    { id: 'turntable', label: 'Turntable', detail: '360° orbit · 8 s' },
    { id: 'half-orbit', label: 'Half orbit', detail: '180° orbit · 6.5 s' },
    { id: 'push-pull', label: 'Close-up', detail: 'Push in and reveal · 6.5 s' },
    { id: 'detail-reveal', label: 'Detail reveal', detail: 'Close-up and orbit · 9.5 s' },
  ];
  return <>
    {viewing && finished && <dialog ref={viewer} className="studio-viewer studio-video-viewer" aria-label="Finished video" onClose={() => setViewing(false)}>
      <header><span>{finished.width} × {finished.height} · 24 fps · {finished.mode === 'studio' ? 'Fast' : 'Realistic'} · r{finished.revision}{revision !== finished.revision ? `, now r${revision}` : ''} · {time(finished.elapsedMs)}</span>
        <div className="studio-viewer-actions"><button className="ghost-button" type="button" onClick={download}><Icon name="export" size={16} />Save MP4</button><button className="icon-button" type="button" autoFocus aria-label="Close video" onClick={() => setViewing(false)}><Icon name="close" /></button></div></header>
      <video src={finished.url} controls playsInline aria-label="Rendered video" />
    </dialog>}
    <section className="studio-video-panel studio-video-editor" aria-label="Video sequence" ref={panel}>
      <div className="studio-video-toolbar">
        <div className="studio-video-heading"><strong>Camera sequence</strong><span>{views.length ? `${views.length} view${views.length === 1 ? '' : 's'} · ${duration.toFixed(1)} s` : 'Start with a camera move'}</span></div>
        <div className="studio-video-toolbar-actions">
          {previous && <button type="button" className="icon-button" disabled={busy} aria-label="Undo sequence change" onClick={undoSequence}><Icon name="undo" size={16} /></button>}
          <button type="button" className="ghost-button small" disabled={busy} aria-expanded={presetsOpen} aria-controls="studio-video-presets" onClick={() => { setPresetsOpen(!presetsOpen); setOutputOpen(false); setEditingView(false); }}><Icon name="rotate" size={15} />Presets</button>
          <button type="button" className="ghost-button small" disabled={busy || !ready || !perspective || views.length >= 12} onClick={capture}><Icon name="plus" size={15} />Add view</button>
        </div>
      </div>
      {(presetsOpen || !views.length) && <div className="studio-video-presets" id="studio-video-presets" role="group" aria-label="Video presets">
        {presets.map(presetOption => <button type="button" key={presetOption.id} disabled={busy || !ready || !perspective} onClick={() => preset(presetOption.id)}>
          <Icon name={presetOption.id === 'push-pull' ? 'target' : 'rotate'} size={20} /><span><strong>{presetOption.label}</strong><small>{presetOption.detail}</small></span>
        </button>)}
        {!!views.length && <p>Replaces the sequence. Undo is available.</p>}
      </div>}
      {views.length > 0 && <ol className="studio-video-shots" aria-label="Saved camera views">{views.map((view, i) => {
        const thumbnail = thumbnails[view.id], image = thumbnail?.key === JSON.stringify([thumbnailEpoch, view.camera, view.presentation]) ? thumbnail.url : undefined;
        return <li key={view.id}><button type="button" className={selected === view.id ? 'active' : ''} aria-label={`View ${i + 1}: ${view.name}`} aria-pressed={selected === view.id} disabled={busy} onClick={() => selectView(views, i)}>
          <span className="studio-video-shot-picture">{image ? <img src={image} alt="" /> : <span className="studio-video-shot-loading">{thumbnailError ? 'Preview unavailable' : 'Preparing preview…'}</span>}<span className="studio-video-shot-index">{String(i + 1).padStart(2, '0')}</span></span>
          <span className="studio-video-shot-caption"><strong>{view.name}</strong><small>{i === 0 ? 'Start' : view.motion === 'cut' ? 'Cut' : `${view.seconds} s ${view.motion === 'orbit' ? 'orbit' : 'move'}`}{view.hold ? ` · hold ${view.hold} s` : ''}</small></span>
        </button></li>;
      })}</ol>}
      {views.length > 0 && <div className="studio-video-transport">
        <button type="button" className="icon-button" aria-label={playing ? 'Pause video preview' : 'Play video preview'} aria-pressed={playing} disabled={busy || !ready || !valid.success} onClick={() => { if (position >= duration) seek(0); setPlaying(!playing); }}><Icon name={playing ? 'pause' : 'play'} size={18} /></button>
        <input type="range" aria-label="Video playhead" aria-valuetext={`${position.toFixed(1)} of ${duration.toFixed(1)} seconds`} min={0} max={Math.max(duration, 0.5)} step={1 / 24} value={Math.min(position, duration)} disabled={busy || !ready} onChange={e => { setPlaying(false); seek(Number(e.target.value)); }} /><output>{position.toFixed(1)} / {duration.toFixed(1)} s</output>
        {active && <button type="button" className="ghost-button small" disabled={busy} aria-expanded={editingView} aria-controls="studio-video-view-editor" onClick={() => { setEditingView(!editingView); setPresetsOpen(false); setOutputOpen(false); }}><Icon name="sliders" size={15} />Edit view</button>}
      </div>}
      {active && editingView && <div className="studio-video-details" id="studio-video-view-editor"><fieldset disabled={busy}>
        <div className="studio-video-edit-fields"><label>View name<input aria-label="View name" maxLength={40} value={active.name} onChange={e => patch({ name: e.target.value })} /></label>
          {views.indexOf(active) > 0 && <div className="studio-video-motion"><span>Movement</span><div role="group" aria-label="Camera movement">{(['orbit', 'move', 'cut'] as const).map(motion => <button className="ghost-button small" key={motion} type="button" aria-pressed={active.motion === motion} onClick={() => patch({ motion })}>{motion === 'orbit' ? 'Orbit' : motion === 'move' ? 'Direct' : 'Cut'}</button>)}</div></div>}
          {views.indexOf(active) > 0 && active.motion !== 'cut' && <label>Move, s<input aria-label="Move seconds" type="number" min={0.5} max={10} step={0.5} value={active.seconds} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value) && value >= .5 && value <= 10) patch({ seconds: value }); }} /></label>}
          <label>Hold, s<input aria-label="Hold seconds" type="number" min={0} max={5} step={0.5} value={active.hold} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value) && value >= 0 && value <= 5) patch({ hold: value }); }} /></label>
        </div>
        <div className="studio-video-edit-actions">
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
        <div><span>Resolution</span><div role="group" aria-label="Video size">{([720, 1080] as const).map(value => <button type="button" className="ghost-button small" key={value} aria-pressed={height === value} onClick={() => setHeight(value)}>{value}p</button>)}</div></div>
        <div><span>Quality</span><div role="group" aria-label="Video rendering"><button type="button" className="ghost-button small" aria-pressed={mode === 'studio'} onClick={() => setMode('studio')}>Fast</button><button type="button" className="ghost-button small" aria-pressed={mode === 'path-traced'} onClick={() => setMode('path-traced')}>Realistic</button></div></div>
        <p>{mode === 'studio' ? 'Matches the live preview.' : `${output.quality[0].toUpperCase() + output.quality.slice(1)} path tracing. Export takes longer; the live preview stays fast.`}</p>
      </fieldset>}
      <div className="studio-video-output">
        <button type="button" className="studio-video-export-summary" disabled={busy} aria-expanded={outputOpen} aria-controls="studio-video-export-settings" onClick={() => { setOutputOpen(!outputOpen); setEditingView(false); setPresetsOpen(false); }}><Icon name="sliders" size={15} /><span>MP4 · {height}p · 24 fps · {mode === 'studio' ? 'Fast' : 'Realistic'}</span></button>
        {finished && !busy && <button type="button" className="ghost-button small" onClick={() => setViewing(true)}>Last video</button>}
        {busy ? <button type="button" className="primary-button" disabled>Rendering video…</button>
          : <button type="button" className="primary-button" disabled={!ready || !valid.success} onClick={() => void render()}><Icon name="camera" size={16} />Render video</button>}
      </div>
      {!perspective && <p className="studio-video-note">Choose Perspective to save camera views.</p>}
      {views.length > 0 && !valid.success && <p className="studio-video-error" role="alert">{valid.error.issues[0].message}</p>}
      {storageError && <p className="studio-video-error" role="alert">Browser storage is unavailable. Keep Studio open to retain this sequence.</p>}
    </section>
  </>;
}
