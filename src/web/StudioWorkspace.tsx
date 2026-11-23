import {Select} from './Select';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RuntimeClient, RuntimeState } from '../cad/runtime';
import type { CadDocument, MaterialLook, Presentation, StudioVideoRecipe, ViewName, WorkspaceViewState } from '../shared/protocol';
import { FINISHES, materialById, NEUTRAL_COLOR, SURFACE_DETAILS } from '../shared/materials';
import {
  COAT_LABELS, DEFAULT_IMAGE_OUTPUT, DETAIL_LABELS, IMAGE_QUALITIES, IMAGE_SIZES, imagePixels, imageQuality,
  studioSettings, type ImageOutput,
} from '../shared/studio';
import { context } from '../cad/demo';
import { track } from './activity';
import { Icon, type IconName } from './icons';
import { detailKind } from './material-detail';
import { modelBounds } from './scene';
import { studioLensFov } from './studio-camera';
import { StudioViewport, type JobState, type PreviewState, type StudioView } from './StudioViewport';
import { addRender, downloadRender, downloadRenderSet, removeRender, useStudioRenders, useRenderHistoryError, useGalleryNotice, dismissGalleryNotice, type StudioRender } from './studio-renders';
import { readStudioNavigation, saveStudioNavigation, studioNavigationHelp, type StudioNavigation } from './studio-navigation';
import { StudioVideoPanel, type VideoProcess } from './StudioVideoPanel';
import { StudioProcess, type StudioProcessState } from './StudioProcess';
import type { ImageSetOptions } from './studio-image-output';
import { views as cameraViews, viewLabel } from './views';
import { StudioImageOptions, StudioImagePreview } from './StudioImageOptions';
import { Menu, MenuItem } from './Menu';
import { ViewOrientation } from './ViewOrientation';
import { Segmented, Slider } from './StudioControls';
import { BackdropPanel, LightPanel, LooksPanel } from './StudioScenePanels';
import { StudioGallery } from './StudioGallery';
import { readSceneDraft, readStudioPreferences, writeSceneDraft, writeStudioPreferences, type StudioPreferences } from './studio-looks';

const OUTPUT_KEY = 'vibeworks.studio.output';
function readOutput(): ImageOutput {
  try {
    const saved = JSON.parse(localStorage.getItem(OUTPUT_KEY) ?? 'null');
    if (saved && saved.size in IMAGE_SIZES && saved.quality in IMAGE_QUALITIES) return { size: saved.size, quality: saved.quality, denoise: saved.denoise !== false };
  } catch { /* fall back to defaults */ }
  return DEFAULT_IMAGE_OUTPUT;
}

type Panel = StudioPreferences['panel'];
const PANELS: { id: Panel; label: string; icon: IconName }[] = [
  { id: 'looks', label: 'Looks', icon: 'layers' }, { id: 'light', label: 'Light', icon: 'sun' }, { id: 'backdrop', label: 'Backdrop', icon: 'floor' },
  { id: 'materials', label: 'Materials', icon: 'material' }, { id: 'output', label: 'Output', icon: 'export' },
];
const PANEL_TITLES: Record<Panel, string> = { looks: 'Looks', light: 'Light', backdrop: 'Backdrop', materials: 'Materials', output: 'Output' };
const preparedPanel = (panel?: 'output' | 'scene' | 'materials'): Panel | undefined => panel === 'scene' ? 'light' : panel;
const formatTime = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; };
const finishName = (finish?: string) => finish ? finish[0].toUpperCase() + finish.slice(1) : 'Material default';

interface MaterialGroup { key: string; name: string; color: string; pieces: number; finishes: string[]; details: string[]; featureIds: string[]; partNames: string[] }
function materialGroups(meshes: RuntimeState['evaluation']['meshes'], visible: string[], document: CadDocument): MaterialGroup[] {
  const groups = new Map<string, MaterialGroup>();
  for (const mesh of meshes) {
    if (!visible.includes(mesh.featureId)) continue;
    const a = mesh.appearance, material = materialById(a?.material), key = material?.id ?? 'unassigned';
    let group = groups.get(key);
    if (!group) { group = { key, name: material?.name ?? 'No material', color: a?.color ?? material?.color ?? NEUTRAL_COLOR, pieces: 0, finishes: [], details: [], featureIds: [], partNames: [] }; groups.set(key, group); }
    group.pieces++;
    if (!group.featureIds.includes(mesh.featureId)) group.featureIds.push(mesh.featureId);
    const name = document.features.find(f => f.id === mesh.featureId)?.label ?? mesh.featureId;
    if (!group.partNames.includes(name)) group.partNames.push(name);
    const finish = finishName(a?.finish), detail = DETAIL_LABELS[detailKind(a)];
    if (!group.finishes.includes(finish)) group.finishes.push(finish);
    if (!group.details.includes(detail)) group.details.push(detail);
  }
  return [...groups.values()].sort((a, b) => b.pieces - a.pieces);
}

function MaterialRow({ group, look, open, onToggle, onChange, onPoint }: { group: MaterialGroup; look: MaterialLook | undefined; open: boolean; onToggle: () => void; onChange: (look: MaterialLook | undefined) => void; onPoint: (pointing: boolean) => void }) {
  const set = (patch: Partial<MaterialLook>) => {
    const next = { ...look, ...patch };
    for (const key of Object.keys(next) as (keyof MaterialLook)[]) if (next[key] === undefined) delete next[key];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const custom = !!look && Object.keys(look).length > 0;
  const authored = `${group.finishes.join(', ')} · ${group.details.join(', ')}`;
  const effectiveDetail = look?.detail ?? (group.details.length === 1 ? SURFACE_DETAILS.find(d => DETAIL_LABELS[d] === group.details[0]) : undefined);
  const parts: string[] = [];
  if (look?.finish) parts.push(finishName(look.finish));
  if (look?.coat) parts.push(COAT_LABELS[look.coat]);
  if (look?.detail) parts.push(DETAIL_LABELS[look.detail]);
  if (look?.detailScale) parts.push(`${look.detailScale}× pattern`);
  return <li className={`studio-material ${open ? 'open' : ''}`}>
    <button type="button" className="studio-material-row" aria-expanded={open} onClick={onToggle} onPointerEnter={() => onPoint(true)} onPointerLeave={() => onPoint(false)} onFocus={() => onPoint(true)} onBlur={() => onPoint(false)}>
      <span className="studio-swatch" style={{ background: group.color }} aria-hidden="true" />
      <span className="studio-material-name"><strong>{group.name}</strong><small>{custom ? parts.join(' · ') : authored}</small></span>
      <span className={`studio-badge ${custom ? 'custom' : ''}`}>{custom ? 'Studio' : 'Model'}</span>
      <span className="studio-material-count">{group.pieces} {group.pieces === 1 ? 'part' : 'parts'}</span>
    </button>
    {open && <div className="studio-material-editor">
      <p className="studio-material-applies">Applies to all {group.pieces} {group.pieces === 1 ? 'part' : 'parts'}. Point at the name to see them.</p><details className="studio-affected"><summary>Show {group.partNames.length} {group.partNames.length === 1 ? 'component' : 'components'}</summary><ul className="studio-material-parts">{group.partNames.map(name => <li key={name}>{name}</li>)}</ul></details>
      <div className="finish-choices"><Segmented label="Finish" value={look?.finish ?? 'model'} onChange={finish => set({ finish: finish === 'model' ? undefined : finish })}
        options={[{ id: 'model', label: 'Model', title: `As modeled: ${group.finishes.join(', ')}` }, ...FINISHES.map(f => ({ id: f, label: finishName(f) }))]} /></div>
      <Segmented label="Coating" value={look?.coat ?? 'model'} onChange={coat => set({ coat: coat === 'model' ? undefined : coat })}
        options={[{ id: 'model', label: 'Model' }, { id: 'none', label: 'None' }, { id: 'clear', label: 'Clear coat' }]} />
      <label className="studio-select"><span>Surface detail</span>
        <Select aria-label={`${group.name} surface detail`} value={look?.detail ?? 'model'} onChange={e => set({ detail: e.target.value === 'model' ? undefined : e.target.value as MaterialLook['detail'] })}>
          <option value="model">Model ({group.details.join(', ')})</option>
          {SURFACE_DETAILS.map(d => <option key={d} value={d}>{DETAIL_LABELS[d]}</option>)}
        </Select>
      </label>
      {effectiveDetail !== 'plain' && <Slider label="Pattern size" min={0.25} max={4} step={0.25} unit="×" value={look?.detailScale ?? 1} onChange={detailScale => set({ detailScale: detailScale === 1 ? undefined : detailScale })} />}
      {custom && <button type="button" className="link-button" onClick={() => onChange(undefined)}>Use the model's look</button>}
    </div>}
  </li>;
}


function ImageViewer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; const previous = globalThis.document.activeElement as HTMLElement | null; dialog.showModal(); return () => { dialog.close(); previous?.focus(); }; }, []);
  return <dialog ref={ref} className="studio-viewer" aria-label="Finished image" onCancel={event => { event.preventDefault(); onClose(); }}>{children}</dialog>;
}

export function StudioWorkspace({ runtime, state, disabled, prepared, onPrepared,onNavigationRisk }: { runtime: RuntimeClient; state: RuntimeState; disabled: boolean; prepared?:WorkspaceViewState; onPrepared?:(error?:string)=>void;onNavigationRisk?:(risk:{draft:boolean;rendering:boolean})=>void }) {
  const document = state.document;
  const [videoSelection, setVideoSelection] = useState<string[]>(document.selectedFeatureIds);
  const remembered = useMemo(() => prepared ? {} : readStudioPreferences(), [prepared]);
  // Unsaved scene edits stay in this browser between visits; agent-prepared scenes never read or write them.
  const [draft, setDraft] = useState<Presentation|undefined>(() => prepared?.presentation ?? readSceneDraft(document.documentId));
  const [base, setBase] = useState<CadDocument|undefined>(() => draft ? document : undefined);
  const restoredDraft = useRef(!prepared && !!draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [projection, setProjection] = useState<'perspective' | 'orthographic'>(prepared?(prepared.panes[0].projection??'orthographic'):'perspective');
  const [focalLengthMm, setFocalLengthMm] = useState(remembered.focalLengthMm ?? 50);
  const [navigation, setNavigation] = useState<StudioNavigation>(readStudioNavigation);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(preparedPanel(prepared?.studio?.panel) ?? remembered.panel ?? 'looks');
  const [materialOpen, setMaterialOpen] = useState<string>();
  const [pointed, setPointed] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [output, setOutputState] = useState<ImageOutput>(()=>prepared?.studio?.output??readOutput());
  const [preview, setPreview] = useState<PreviewState>({ phase: 'loading' });
  const [job, setJob] = useState<JobState>({ phase: 'idle' });
  const [jobSettings, setJobSettings] = useState('');
  const [viewing, setViewing] = useState<string>();
  const [gallery, setGallery] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);
  const [showingImage, setShowingImage] = useState(false);
  const [displayedId, setDisplayedId] = useState<string>();
  const [cameraAzimuth, setCameraAzimuth] = useState(-127);
  const [imageRendering, setImageRendering] = useState<'fast' | 'quality'>(remembered.rendering ?? 'fast');
  const [imageScope, setImageScope] = useState<'current' | 'views'>(remembered.scope ?? 'current');
  const [imageViews, setImageViews] = useState<ViewName[]>(prepared?.studio?.views??(remembered.views?.filter(view => cameraViews.some(v => v.view === view)) as ViewName[] | undefined)??['isometric', 'front', 'right', 'top']);
  const [imageLabels, setImageLabels] = useState(prepared?.studio?.labels??remembered.labels??false);
  const [imageLayout, setImageLayout] = useState<ImageSetOptions['layout']>(prepared?.studio?.layout??remembered.layout??'sheet');
  const historyError = useRenderHistoryError();
  const galleryNotice = useGalleryNotice();
  const [mode, setMode] = useState<'image' | 'video'>('image');
  const [videoScene, setVideoScene] = useState<Presentation>();
  const [videoFrame, setVideoFrame] = useState<{ width: number; height: number }>();
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoProcess, setVideoProcess] = useState<VideoProcess>();
  const [videoInteraction, setVideoInteraction] = useState(0);
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const api = useRef<StudioView | null>(null);
  const preparedApplied=useRef(false);
  const thumb = useRef<HTMLCanvasElement>(null);
  const picture = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const renders = useStudioRenders(document.documentId);
  const settings = useMemo(() => videoScene ?? draft ?? document.presentation ?? {}, [videoScene, draft, document.presentation]);
  const s = studioSettings(settings);
  // A restored draft starts from the current model, so saving replaces its scene at the current revision.
  const stale = !!base && base.revision !== document.revision && !restoredDraft.current;
  const visible = state.evaluation.visibleFeatureIds;
  const groups = useMemo(() => materialGroups(state.evaluation.meshes, visible, document), [state.evaluation.meshes, visible, document]);
  const radius = useMemo(() => { const b = modelBounds(state.evaluation); return Math.hypot(...b.size) / 2; }, [state.evaluation]);
  const identity = JSON.stringify([document.documentId, document.features, state.evaluation.meshes.length, state.evaluation.references?.map(r => [r.documentId, r.revision])]);
  const running = job.phase === 'running';
  useEffect(()=>{onNavigationRisk?.({draft:false,rendering:running||videoBusy});},[onNavigationRisk,running,videoBusy]);
  useEffect(()=>()=>onNavigationRisk?.({draft:false,rendering:false}),[onNavigationRisk]);
  useEffect(() => { if (!prepared) writeSceneDraft(document.documentId, draft); }, [prepared, document.documentId, draft]);
  useEffect(() => { if (!prepared) writeStudioPreferences({ panel, rendering: imageRendering, scope: imageScope, views: imageViews, layout: imageLayout, labels: imageLabels, focalLengthMm }); },
    [prepared, panel, imageRendering, imageScope, imageViews, imageLayout, imageLabels, focalLengthMm]);
  // Opening a material briefly marks its parts, then gets out of the way so finish changes stay visible.
  useEffect(() => { if (!flash) return; const timer = setTimeout(() => setFlash(undefined), 1100); return () => clearTimeout(timer); }, [flash]);
  const displayed = renders.find(r => r.id === displayedId) ?? renders[0];
  const viewed = renders.find(r => r.id === viewing);

  useEffect(() => {
    const element = picture.current?.querySelector<HTMLElement>('.studio-viewport'); if (!element) return;
    const observer = new ResizeObserver(() => setViewport({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!viewed && !gallery) return;
    // The viewer and gallery own Escape; the workspace must not also act on it.
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); if (viewed) setViewing(undefined); else setGallery(false); } };
    window.addEventListener('keydown', close, true); return () => window.removeEventListener('keydown', close, true);
  }, [viewed, gallery]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (viewed || gallery || event.defaultPrevented || event.key.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault(); api.current?.fit();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [viewed, gallery]);
  useEffect(() => {
    if (!showingImage) return;
    const back = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || viewed || gallery || menu || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); api.current?.resumePreview();
    };
    window.addEventListener('keydown', back, true); return () => window.removeEventListener('keydown', back, true);
  }, [showingImage, viewed, gallery, menu]);
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setSettingsOpen(false); settingsButton.current?.focus();
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [settingsOpen]);

  const change = (patch: Partial<Presentation>) => {
    setVideoScene(undefined);
    setBase(base ?? document);
    const next: Presentation = { ...settings, ...patch };
    for (const key of Object.keys(next) as (keyof Presentation)[]) if (next[key] === undefined) delete next[key];
    setDraft(next); setError('');
  };
  const replaceScene = (next: Presentation) => { setVideoScene(undefined); setBase(base ?? document); setDraft(next); setError(''); };
  const setLook = (key: string, look: MaterialLook | undefined) => {
    const materials = { ...s.materials };
    if (look) materials[key] = look; else delete materials[key];
    // Material looks replace the legacy carbon-only option.
    change({ materials: Object.keys(materials).length ? materials : undefined, carbonFinish: undefined });
  };
  const setOutput = (patch: Partial<ImageOutput>) => {
    const next = { ...output, ...patch };
    setOutputState(next);
    try { localStorage.setItem(OUTPUT_KEY, JSON.stringify(next)); } catch { /* preference only */ }
  };
  const revert = () => { setVideoScene(undefined); setDraft(undefined); setBase(undefined); setError(''); restoredDraft.current = false; };
  const save = async () => {
    if (!draft || !base) return;
    setSaving(true); setError('');
    try {
      const target = restoredDraft.current ? document : base;
      const result = await track('apply_edits', () => runtime.execute({ type: 'apply_edits', params: { ...context(target), edits: [{ op: 'set_presentation', presentation: draft }] } }));
      if (result.status === 'error') setError(result.error!.message);
      else { setDraft(undefined); setBase(undefined); restoredDraft.current = false; }
    } catch (error) { setError(String(error)); } finally { setSaving(false); }
  };
  const saveVideo = async (video: StudioVideoRecipe) => {
    try {
      const result = await track('apply_edits', () => runtime.execute({ type: 'apply_edits', params: { ...context(document), edits: [{ op: 'set_video', video }] } }));
      return result.status === 'error' ? result.error!.message : undefined;
    } catch (error) { return String(error); }
  };
  const startRender = () => { setJobSettings(JSON.stringify(settings)); setViewing(undefined); api.current?.render({ rendering: imageRendering, layout: imageLayout, labels: imageLabels, ...(imageScope === 'views' ? { views: imageViews } : {}) }); };
  const openPanel = (next: Panel) => { setPanel(next); if (next !== 'materials') setPointed(undefined); };
  const pointMaterial = useCallback((key: string, pointing: boolean) => setPointed(current => pointing ? key : current === key ? undefined : current), []);
  const pixels = imagePixels(output, viewport, window.devicePixelRatio);
  const quality = imageQuality(output);
  const customLooks = Object.keys(s.materials).length;
  const editing = disabled || saving;
  const composingViews = mode === 'image' && imageScope === 'views' && panel === 'output' && !showingImage;
  const highlighted = panel === 'materials' && !running && !showingImage ? pointed ?? flash : undefined;
  const panels = mode === 'image' ? PANELS : PANELS.filter(tab => tab.id !== 'output');
  const sceneStatus = videoScene ? 'Scene from the selected camera view' : draft ? (restoredDraft.current ? 'Unsaved scene from your last visit' : 'Unsaved changes · kept in this browser') : 'Same as the scene saved with the model';

  const process: StudioProcessState = (() => {
    if (job.phase === 'running') {
      const st = job.status, index = job.index ?? 1, total = job.total ?? 1;
      const title = st.phase === 'preparing' ? 'Preparing image' : st.phase === 'compiling' ? 'Compiling image shaders' : st.phase === 'finishing' ? 'Finishing image' : 'Rendering image';
      const detail = `${total > 1 ? `${job.label} · view ${index} / ${total} · ` : ''}${st.target ? `${st.samples} / ${st.target} samples · ` : ''}${job.width} × ${job.height} · ${job.quality}${jobSettings !== JSON.stringify(settings) ? ' · captured scene' : ''}`;
      const value = st.phase === 'rendering' ? st.target ? (index - 1 + st.samples / st.target) / total : total > 1 ? (index - 1) / total : undefined : undefined;
      return { kind: 'image', phase: st.phase, title, detail, value, elapsedMs: st.elapsedMs,
        etaMs: total === index && st.phase === 'rendering' ? st.etaMs : undefined, thumbnail: st.target > 0, cancel: () => api.current?.cancel() };
    }
    const video = videoProcess?.progress;
    if (video) return { kind: 'video', phase: video.phase,
      title: video.phase === 'preparing' ? 'Preparing video' : video.phase === 'encoding' ? 'Encoding MP4' : 'Rendering video',
      detail: video.phase === 'encoding' ? `${video.total} frames rendered · finishing MP4` : `Frame ${Math.min(video.frames + 1, video.total)} / ${video.total}${video.target ? ` · ${video.samples} / ${video.target} samples` : ''}`,
      value: video.phase === 'rendering' ? video.frames / video.total : undefined, elapsedMs: video.elapsedMs,
      etaMs: video.phase === 'rendering' ? video.etaMs : undefined, cancel: videoProcess?.cancel };
    if (mode === 'video' && videoProcess?.error) return { kind: 'video', phase: videoProcess.errorCode === 'VIDEO_CANCELLED' ? 'idle' : 'error', title: videoProcess.errorCode === 'VIDEO_CANCELLED' ? 'Video cancelled' : 'Video stopped', detail: videoProcess.error,errorCode:videoProcess.errorCode };
    if (mode === 'image' && job.phase === 'error') return { kind: 'image', phase: 'error', title: 'Image stopped', detail: job.message };
    if (preview.phase === 'loading') return { kind: 'preview', phase: 'preparing', title: 'Preparing Studio', detail: `Loading model, graphics and lighting · ${document.name ?? 'Model'}` };
    if (preview.phase === 'error') return { kind: 'preview', phase: 'error', title: 'Preview unavailable', detail: preview.message ?? 'Exit Studio and reopen it to retry.' };
    if (showingImage && renders[0]) return { kind: 'image', phase: 'idle', title: 'Finished image', detail: `${renders[0].width} × ${renders[0].height} · ${formatTime(renders[0].elapsedMs)} · camera locked · kept in the gallery` };
    return { kind: mode === 'video' ? 'video' : 'image', phase: 'idle', title: mode === 'video' ? 'Video ready' : 'Studio ready',
      detail: mode === 'video' ? 'Choose your camera views, then render the sequence.' : `${pixels.width} × ${pixels.height} · ${imageRendering === 'fast' ? 'Fast Studio render' : `${quality.label}, ${quality.samples} samples`}` };
  })();

  return <section className={`studio-workspace ${settingsOpen ? 'studio-settings-open' : ''} ${mode === 'video' ? 'studio-video-mode' : ''}`} aria-label="Studio">
    <header className="studio-workspace-header">
      <strong>Studio</strong>
      <div className="studio-mode-switch" role="group" aria-label="Studio mode">
        <button type="button" aria-pressed={mode === 'image'} disabled={videoBusy} onClick={() => { setMode('image'); setVideoScene(undefined); }}><Icon name="camera" size={18} />Images</button>
        <button type="button" aria-pressed={mode === 'video'} disabled={running} onClick={() => { api.current?.resumePreview(); setMode('video'); setProjection('perspective'); setViewing(undefined); if (panel === 'output') setPanel('looks'); }}><Icon name="video" size={18} />Video</button>
      </div>
      <span className="studio-bar-divider studio-header-divider" />
      <div className="studio-camera-tools" role="toolbar" aria-label="Studio camera">
        <button type="button" className="icon-button" disabled={showingImage || running} aria-label="Perspective camera" title="Perspective" aria-pressed={projection === 'perspective'} onClick={() => setProjection('perspective')}><Icon name="perspective" /></button>
        <button type="button" className="icon-button" disabled={showingImage || running || mode === 'video'} aria-label="Orthographic camera" title="Orthographic" aria-pressed={projection === 'orthographic'} onClick={() => setProjection('orthographic')}><Icon name="orthographic" /></button>
        {!composingViews && <Menu id="studio-views" open={menu === 'studio-views'} onToggle={setMenu} label="View" icon="target" ariaLabel="Camera direction" title="Camera direction" className="studio-header-menu">
          <MenuItem label="Normal To surface…" icon="orthographic" disabled={showingImage} onClick={() => { setMenu(null); api.current?.normalTo(); }} />
          <div className="orientation-picker studio-view-picker">{cameraViews.map(v => <button key={v.view} type="button" role="menuitem" disabled={showingImage} onClick={() => { api.current?.view(v.view); setMenu(null); }}><ViewOrientation view={v.view} size={36} /><span>{v.view === 'isometric' ? 'Isometric' : viewLabel(v.view)}</span></button>)}</div>
        </Menu>}
        <Menu id="studio-lens" open={menu === 'studio-lens'} onToggle={setMenu} label={`${focalLengthMm} mm`} ariaLabel="Lens" title="Lens: wider shows more, longer flattens perspective" className="studio-header-menu">
          {[35, 50, 85, 135].map(mm => <MenuItem key={mm} label={`${mm} mm`} hint={{ 35: 'Wide', 50: 'Natural', 85: 'Portrait', 135: 'Flat' }[mm]} icon={focalLengthMm === mm ? 'check' : undefined} onClick={() => { setFocalLengthMm(mm); setMenu(null); }} />)}
        </Menu>
        {!composingViews && <><button type="button" className="icon-button" disabled={showingImage} aria-label="Fit Studio model" title="Fit model · F" onClick={() => api.current?.fit()}><Icon name="fit" /></button>
        <button type="button" className="icon-button" aria-label="Save preview as PNG" title="Save this preview as PNG" disabled={preview.phase !== 'ready' || showingImage} onClick={() => api.current?.savePreview()}><Icon name="export" /></button></>}
      </div>
      <Menu id="studio-help" open={menu === 'studio-help'} onToggle={setMenu} label={<span className="sr-only">Camera controls</span>} icon="help" ariaLabel="Camera controls" title="Camera controls" className="studio-header-menu studio-help-menu">
        <div className="studio-help-body">
          <Segmented label="Navigation" value={navigation} options={[{id:'trackpad',label:'Trackpad'},{id:'mouse',label:'Mouse'}]} onChange={next => { setNavigation(next); saveStudioNavigation(next); }} />
          <p>{studioNavigationHelp(navigation)}</p>
          {s.floor !== 'none' && <p>With a floor, the camera stays above it.</p>}
        </div>
      </Menu>
      <button ref={settingsButton} type="button" className="bar-button studio-settings-toggle" aria-expanded={settingsOpen} aria-controls="studio-settings" onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="sliders" size={16} />Settings</button>
      {mode === 'image' && !settingsOpen && <button type="button" className="primary-button studio-mobile-render" disabled={running || disabled || preview.phase !== 'ready' || (imageScope === 'views' && !imageViews.length)} onClick={startRender}>Render</button>}
    </header>
    <div className={`studio-picture ${mode === 'image' ? 'studio-image-mode' : ''} ${composingViews ? 'studio-has-product-preview' : ''}`} ref={picture}
      onPointerDownCapture={event => { if (event.target instanceof Element && event.target.closest('.studio-image-lock')) setNudge(n => n + 1); }}>
      <StudioProcess state={process} thumbnail={thumb} />
      <StudioViewport identity={identity}
        evaluation={state.evaluation} documentId={document.documentId} revision={document.revision} settings={settings} output={output} frameSize={mode === 'video' ? videoFrame : undefined} projection={projection} focalLengthMm={focalLengthMm} navigation={navigation} api={api}
        rememberCamera={!prepared} onCameraAzimuth={setCameraAzimuth}
        onPreview={next=>{setPreview(next);if(prepared&&!preparedApplied.current){
          if(next.phase==='error'){preparedApplied.current=true;onPrepared?.(next.message??'Studio preview failed.');}
          else if(next.phase==='ready'&&api.current){preparedApplied.current=true;try{api.current.present(prepared.panes[0],state.evaluation);onPrepared?.();}catch(e){onPrepared?.(e instanceof Error?e.message:String(e));}}
        }}} onJob={setJob} onRendered={async render => { const saved: StudioRender = { ...render, documentName: document.name ?? undefined, id: crypto.randomUUID(), url: URL.createObjectURL(render.blob), ...(render.thumbnail ? { thumbnailUrl: URL.createObjectURL(render.thumbnail) } : {}) }; await addRender(saved); setDisplayedId(saved.id); return saved; }}
        onInteraction={() => { setViewing(undefined); setVideoInteraction(n => n + 1); }} onProjection={setProjection} onLens={setFocalLengthMm} onShowingImage={setShowingImage} progressThumb={thumb}
        highlightFeatures={mode === 'video' ? videoSelection : highlighted ? groups.find(g => g.key === highlighted)?.featureIds : undefined}
        onPickFeature={featureId => { if (mode === 'video') { setVideoSelection([featureId]); return; } const group = groups.find(g => g.featureIds.includes(featureId)); if (group) { setPanel('materials'); setMaterialOpen(group.key); setFlash(group.key); setSettingsOpen(true); } }} />
      {composingViews && !running && <StudioImagePreview evaluation={state.evaluation} settings={settings} views={imageViews} layout={imageLayout} labels={imageLabels} aspect={pixels.width / pixels.height} width={pixels.width} height={pixels.height} projection={projection} fov={studioLensFov(focalLengthMm, viewport, pixels)} />}
      {showingImage && displayed && <div key={nudge} className={`studio-result-bar ${nudge ? 'nudged' : ''}`} role="region" aria-label="Finished image">
        <span><strong>Finished image</strong> · {displayed.width} × {displayed.height} · {displayed.quality} · in your gallery</span>
        <button type="button" className="ghost-button" onClick={() => downloadRender(displayed, document.name ?? 'product')}><Icon name="export" size={16} />Save PNG</button>
        <button type="button" className="primary-button" onClick={() => api.current?.resumePreview()}><Icon name="camera" size={16} />Back to preview</button>
      </div>}
      {mode === 'video' && <StudioVideoPanel key={document.documentId} documentId={document.documentId} revision={document.revision} name={document.name ?? 'vibeworks'}
        evaluation={state.evaluation} settings={settings} api={api} ready={preview.phase === 'ready' && !disabled} perspective={projection === 'perspective'} interaction={videoInteraction}
        onScene={setVideoScene} onBusy={setVideoBusy} onProcess={setVideoProcess} saved={document.video} onSave={saveVideo} onFrame={setVideoFrame} selection={videoSelection}
        execute={command=>runtime.execute(command)} inspectDisplay={runtime.inspectDisplay?.bind(runtime)} />}
      {mode === 'image' && <div className="studio-render-bar" role="region" aria-label="Rendered images">
        {renders.length > 0 && <ol className="studio-renders" aria-label="Finished images">
          {renders.slice(0, 12).map((render, i) => <li key={render.id}><button type="button" className={viewing === render.id ? 'active' : ''} title={render.label} aria-label={`Open image ${renders.length - i}: ${render.width} × ${render.height}, ${render.quality}`} onClick={() => setViewing(render.id)}>
            <img src={render.thumbnailUrl ?? render.url} alt="" />
          </button></li>)}
        </ol>}
        {renders[0]?.setId && renders.filter(r => r.setId === renders[0].setId).length > 1 && <button className="ghost-button small" type="button" onClick={() => void downloadRenderSet(renders.filter(r => r.setId === renders[0].setId), document.name ?? 'product').catch(e => setError(String(e)))}>Save view ZIP</button>}
        {!renders.length && <span className="studio-history-label">Your rendered images will appear here</span>}
        <button type="button" className="ghost-button studio-gallery-button" onClick={() => setGallery(true)}><Icon name="layers" size={16} />Gallery{renders.length ? <span className="studio-gallery-count">{renders.length}</span> : null}</button>
      </div>}
      {(historyError || galleryNotice) && <p className="studio-history-error" role="alert">{historyError || galleryNotice}{!historyError && <button type="button" className="icon-button quiet" aria-label="Dismiss" onClick={dismissGalleryNotice}><Icon name="close" size={14} /></button>}</p>}
      {gallery && <StudioGallery documentId={document.documentId} documentName={document.name ?? 'Model'} revision={document.revision} onClose={() => setGallery(false)} onOpen={render => { setGallery(false); if (render.documentId === document.documentId) setViewing(render.id); else downloadRender(render, render.documentName ?? 'vibeworks'); }} />}
      {viewed && <ImageViewer onClose={() => setViewing(undefined)}>
        <header>
          <span><strong>{viewed.width} × {viewed.height}</strong> · {viewed.quality}{viewed.samples > 0 && `, ${viewed.samples} samples`} · {formatTime(viewed.elapsedMs)}
            {viewed.hiddenMs > 1000 && <> · {formatTime(viewed.hiddenMs)} in a background tab</>}
            {viewed.revision !== document.revision && <em> · model r{viewed.revision}, now r{document.revision}</em>}
            {JSON.stringify(viewed.settings) !== JSON.stringify(settings) && <em> · scene changed since</em>}
          </span>
          <span className="studio-viewer-actions">
            <button type="button" className="ghost-button small" onClick={() => downloadRender(viewed, document.name ?? document.documentId)}><Icon name="export" size={14} />Save PNG</button>
            <button disabled={!!viewed.views?.length} type="button" className="ghost-button small" onClick={() => { api.current?.show(viewed); setDisplayedId(viewed.id); setViewing(undefined); }}><Icon name="target" size={14} />Use this view</button>
            <button disabled={JSON.stringify(viewed.settings) === JSON.stringify(settings)} type="button" className="ghost-button small" title="Load the lights, backdrop and materials used for this image" onClick={() => { replaceScene(viewed.settings); setViewing(undefined); }}><Icon name="sun" size={14} />Use this scene</button>
            <button type="button" className="icon-button quiet" aria-label="Remove image" title="Delete from the gallery" onClick={async () => { api.current?.resumePreview(); await removeRender(viewed.id); setViewing(undefined); }}><Icon name="delete" size={16} /></button>
            <button type="button" className="icon-button quiet" aria-label="Close image" autoFocus onClick={() => setViewing(undefined)}><Icon name="close" size={16} /></button>
          </span>
        </header>
        <img src={viewed.url} alt={`Rendered image, ${viewed.width} by ${viewed.height} pixels`} />
      </ImageViewer>}
    </div>
    <aside id="studio-settings" className="studio-settings" aria-label="Studio scene settings">
      <header><div><h1>{PANEL_TITLES[panel]}</h1>{videoScene && <span className="studio-note">Scene from selected video view</span>}</div><button className="icon-button studio-settings-toggle" type="button" aria-label="Close scene settings" onClick={() => { setSettingsOpen(false); settingsButton.current?.focus(); }}><Icon name="close" /></button></header>
      <nav className="studio-panel-tabs" aria-label="Studio settings">
        {panels.map(tab => <button type="button" key={tab.id} aria-pressed={panel === tab.id} onClick={() => openPanel(tab.id)}><Icon name={tab.icon} size={17} /><span>{tab.label}</span></button>)}
      </nav>
      <div className="studio-settings-scroll">
        {panel === 'looks' && <LooksPanel settings={settings} onApply={replaceScene} api={api} ready={preview.phase === 'ready'} identity={identity} disabled={editing} />}
        {panel === 'light' && <LightPanel s={s} change={change} camera={cameraAzimuth} disabled={editing} />}
        {panel === 'backdrop' && <BackdropPanel s={s} settings={settings} radius={radius} change={change} disabled={editing} />}
        {panel === 'materials' && <fieldset className="studio-panel-body" disabled={editing}>
          <p className="studio-hint">Studio looks only; the model is unchanged.</p>
          <ul className="studio-materials">
            {groups.map(group => <MaterialRow key={group.key} group={group} look={s.materials[group.key]} open={materialOpen === group.key}
              onToggle={() => { const next = materialOpen === group.key ? undefined : group.key; setMaterialOpen(next); setFlash(next); }} onChange={look => setLook(group.key, look)} onPoint={pointing => pointMaterial(group.key, pointing)} />)}
          </ul>
          {customLooks > 0 && <button type="button" className="link-button" onClick={() => change({ materials: undefined, carbonFinish: undefined })}>Use model looks for all materials</button>}
        </fieldset>}
        {panel === 'output' && <div className="studio-panel-body">
          {mode === 'image' && <StudioImageOptions evaluation={state.evaluation} scope={imageScope} onScope={scope => { api.current?.resumePreview(); setImageScope(scope); }} views={imageViews} onViews={views => { api.current?.resumePreview(); setImageViews(views); }} layout={imageLayout} onLayout={layout => { api.current?.resumePreview(); setImageLayout(layout); }} labels={imageLabels} onLabels={labels => { api.current?.resumePreview(); setImageLabels(labels); }} rendering={imageRendering} onRendering={setImageRendering} disabled={running} />}
          {mode === 'image' && <><Segmented label="Size" value={output.size} onChange={size => { api.current?.resumePreview(); setOutput({size}); }} options={Object.entries(IMAGE_SIZES).map(([id,size]) => ({id:id as ImageOutput['size'],label:size.label}))} />
            <p className="studio-note">{pixels.width} × {pixels.height} px. The frame on the preview shows the crop.</p></>}
          {mode === 'image' && imageRendering === 'quality' && <><Segmented label="Quality" value={output.quality} onChange={q => setOutput({ quality: q })}
            options={Object.entries(IMAGE_QUALITIES).map(([id, q]) => ({ id: id as ImageOutput['quality'], label: q.label, title: `${output.denoise ? q.samples : q.rawSamples} samples` }))} />
            <label className="studio-check"><input type="checkbox" checked={output.denoise} onChange={e => setOutput({ denoise: e.target.checked })} /> Reduce noise when finished</label>
            <p className="studio-note">{quality.samples} samples, path traced with WebGPU.</p></>}
        </div>}
        {stale && <p className="notice error" role="alert">The model changed while you adjusted this scene. Revert to the saved scene before saving again.</p>}
        {error && <p className="notice error" role="alert">{error}</p>}
      </div>
      <footer>
        {mode === 'image' && <>
          {panel !== 'output' && <div className="studio-quick-output" role="group" aria-label="Quick output">
            <div className="studio-quick-rendering" role="radiogroup" aria-label="Rendering">
              {([['fast', 'Fast', 'Studio preview quality, in seconds'], ['quality', 'High quality', `Path traced, ${quality.label}, ${quality.samples} samples`]] as const).map(([id, label, title]) =>
                <button key={id} type="button" role="radio" aria-checked={imageRendering === id} title={title} disabled={running} onClick={() => setImageRendering(id)}>{label}</button>)}
            </div>
            <Select aria-label="Image size" title={`${pixels.width} × ${pixels.height} px`} className="studio-quick-size" value={output.size} disabled={running}
              onChange={event => { api.current?.resumePreview(); setOutput({ size: event.target.value as ImageOutput['size'] }); }}>
              {Object.entries(IMAGE_SIZES).map(([id, size]) => <option key={id} value={id}>{size.label}</option>)}
            </Select>
            {imageScope === 'views' && <button type="button" className="studio-quick-views" title="Choose product views in Output" onClick={() => setPanel('output')}>{imageViews.length} {imageViews.length === 1 ? 'view' : 'views'}</button>}
            <button type="button" className="icon-button quiet studio-quick-more" aria-label="All output settings" title="All output settings" onClick={() => setPanel('output')}><Icon name="sliders" size={16} /></button>
          </div>}
          <button type="button" className="primary-button studio-render-action" disabled={running || disabled || preview.phase !== 'ready' || (imageScope === 'views' && !imageViews.length)} onClick={startRender}><Icon name="camera" size={18} />{running ? 'Rendering…' : imageScope === 'views' ? `Render ${imageViews.length} ${imageViews.length === 1 ? 'view' : 'views'}` : 'Render image'}</button>
        </>}
        <div><button className="ghost-button" type="button" title="Save these lights, backdrop and materials into the model so other people and agents render with them" disabled={!!videoScene || !draft || editing || stale} onClick={() => void save()}>{saving ? 'Saving…' : 'Save to model'}</button>
          <button className="link-button" type="button" disabled={(!draft && !videoScene) || saving} onClick={revert}>Revert</button></div>
        <span>{sceneStatus}</span>
      </footer>
    </aside>
  </section>;
}
