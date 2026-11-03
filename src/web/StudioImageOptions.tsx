import { useEffect, useId, useState } from 'react';
import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import { VIEW_DIRECTIONS, type Presentation, type ViewName } from '../shared/protocol';
import { Icon, type IconName } from './icons';
import { buildStudioAssets, composeStudioScene, disposeStudioAssets, loadStudioLook, releaseStudioScene, type StudioAssets } from './studio-compose';
import { StudioVideoPreviewRenderer } from './studio-video-preview';
import { studioImageLayout } from './studio-image-output';
import { shotCamera } from './shots';
import './studio-image-options.css';
import { ViewOrientation } from './ViewOrientation';
import { useModelThumbnails } from './model-thumbnails';

import { views as namedViews, viewLabel } from './views';
export const STUDIO_PRODUCT_VIEWS = namedViews.map(v => ({ id: v.view, label: viewLabel(v.view), icon: v.icon }));

export interface StudioImageOptionsProps {
  scope: 'current' | 'views'; onScope: (scope: 'current' | 'views') => void;
  views: ViewName[]; onViews: (views: ViewName[]) => void;
  layout: 'sheet' | 'separate'; onLayout: (layout: 'sheet' | 'separate') => void;
  labels: boolean; onLabels: (labels: boolean) => void;
  rendering: 'fast' | 'quality'; onRendering: (rendering: 'fast' | 'quality') => void;
  disabled?: boolean;
  evaluation?:Evaluation;
}

function Choices<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { id: T; label: string; icon?: IconName }[]; onChange: (value: T) => void;
}) {
  const name = useId();
  return <fieldset className="studio-output-choice-group"><legend>{label}</legend><div className="studio-output-choices">
    {options.map(option => <label key={option.id} className={value === option.id ? 'is-selected' : ''}>
      <input type="radio" name={name} checked={value === option.id} onChange={() => onChange(option.id)} />
      {option.icon && <Icon name={option.icon} size={17} />}<span>{option.label}</span>
    </label>)}
  </div></fieldset>;
}

/** Output decisions stay visible beside the picture, rather than covering it. */
export function StudioImageOptions(props: StudioImageOptionsProps) {
  const { scope, views, layout, labels, rendering, disabled } = props;
  const thumbnails=useModelThumbnails(scope==='views'?props.evaluation:undefined,STUDIO_PRODUCT_VIEWS.map(v=>v.id));
  return <fieldset className="studio-output-options" disabled={disabled}>
    <legend className="sr-only">Image output</legend>
    <Choices label="Views" value={scope} onChange={props.onScope} options={[
      { id: 'current', label: 'Current camera', icon: 'camera' }, { id: 'views', label: 'Product views', icon: 'orthographic' },
    ]} />
    {scope === 'views' && <>
      <fieldset className="studio-product-view-picker"><legend>Choose views <span>{views.length} selected</span></legend><div>
        {STUDIO_PRODUCT_VIEWS.map(view => <label key={view.id} className={views.includes(view.id) ? 'is-selected' : ''}>
          <input type="checkbox" aria-label={view.label} checked={views.includes(view.id)} onChange={event => {
            const selected = new Set(views);
            if (event.target.checked) selected.add(view.id); else selected.delete(view.id);
            props.onViews(STUDIO_PRODUCT_VIEWS.filter(view => selected.has(view.id)).map(view => view.id));
          }} />
          <span className="product-view-image">{thumbnails[view.id]?<img src={thumbnails[view.id]} alt=""/>:<ViewOrientation view={view.id} size={36}/>}</span><span>{view.id==='isometric'?'Isometric':view.label}</span><span className="studio-product-view-check" aria-hidden="true"><Icon name="check" size={11} /></span>
        </label>)}
      </div></fieldset>
      {!views.length && <p className="studio-output-help" role="status">Choose at least one view to render.</p>}
      <Choices label="Save as" value={layout} onChange={props.onLayout} options={[
        { id: 'sheet', label: 'One image', icon: 'orthographic' }, { id: 'separate', label: 'Separate PNGs', icon: 'layers' },
      ]} />
      {layout === 'sheet' ? <label className="studio-output-labels"><input type="checkbox" checked={labels} onChange={event => props.onLabels(event.target.checked)} />Show view labels</label>
        : <p className="studio-output-help">Full-size images, downloadable together as a ZIP.</p>}
    </>}
    <Choices label="Rendering" value={rendering} onChange={props.onRendering} options={[
      { id: 'fast', label: 'Fast', icon: 'camera' }, { id: 'quality', label: 'High quality', icon: 'material' },
    ]} />
  </fieldset>;
}

type AssetLease = { assets: StudioAssets; evaluation: Evaluation; users: number; retired: boolean };
function releaseAssets(lease: AssetLease) { if (lease.retired && lease.users === 0) disposeStudioAssets(lease.assets); }
interface PreviewImage { view: ViewName | 'sheet'; url: string }
export interface StudioImagePreviewProps {
  evaluation: Evaluation; settings: Presentation; views: ViewName[]; layout: 'sheet' | 'separate'; labels: boolean;
  aspect: number; projection: 'perspective' | 'orthographic'; fov: number; width?: number; height?: number;
}

/** Low-resolution, raster previews share exact display assets and final-image camera/layout rules. */
export function StudioImagePreview({ evaluation, settings, views, layout, labels, aspect, projection, fov, width: outputWidth, height: outputHeight }: StudioImagePreviewProps) {
  const [lease, setLease] = useState<AssetLease>();
  const [images, setImages] = useState<PreviewImage[]>([]);
  const [phase, setPhase] = useState<'preparing' | 'ready' | 'error'>('preparing');
  const [error, setError] = useState('');
  const key = views.join(',');
  const outputAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  useEffect(() => {
    let active = true, owned: AssetLease | undefined;
    setLease(undefined); setPhase('preparing');
    void buildStudioAssets(evaluation, () => active).then(assets => {
      if (!assets) return;
      owned = { assets, evaluation, users: 0, retired: !active };
      if (active) setLease(owned); else releaseAssets(owned);
    }).catch(error => { if (active) { setError(String(error)); setPhase('error'); } });
    return () => { active = false; if (owned) { owned.retired = true; releaseAssets(owned); } };
  }, [evaluation]);
  useEffect(() => {
    if (!lease || lease.evaluation !== evaluation) return;
    const abort = new AbortController(), urls: string[] = [];
    let published = false;
    setPhase('preparing'); setError('');
    const timer = setTimeout(() => {
      if (!views.length) { setImages([]); setPhase('ready'); return; }
      lease.users++;
      const run = async () => {
        let renderer: StudioVideoPreviewRenderer | undefined;
        const output: PreviewImage[] = [];
        try {
          const { assets } = lease;
          const look = await loadStudioLook(settings, assets.radius); abort.signal.throwIfAborted();
          renderer = new StudioVideoPreviewRenderer();
          const bounds = new THREE.Box3(assets.bounds.min.clone().sub(assets.center).divideScalar(assets.unit), assets.bounds.max.clone().sub(assets.center).divideScalar(assets.unit));
          // Bound both axes; portrait outputs must not allocate an enormous preview canvas.
          const sourceWidth = Math.max(3, Math.round(outputWidth ?? 1920)), sourceHeight = Math.max(3, Math.round(outputHeight ?? sourceWidth / outputAspect));
          const scale = Math.min(1, 1200 / sourceWidth, 800 / sourceHeight);
          const width = Math.round(sourceWidth * scale), height = Math.round(sourceHeight * scale);
          const sheet = layout === 'sheet';
          const sourceTiles = sheet ? studioImageLayout(views.length, sourceWidth, sourceHeight, labels)
            : views.map(() => ({ x: 0, y: 0, width: sourceWidth, height: sourceHeight, imageHeight: sourceHeight, labelHeight: 0 }));
          const tiles = sourceTiles.map(tile => {
            const x = Math.round(tile.x * scale), y = Math.round(tile.y * scale), bottom = Math.round((tile.y + tile.height) * scale);
            const imageBottom = Math.round((tile.y + tile.imageHeight) * scale);
            return { x, y, width: Math.round((tile.x + tile.width) * scale) - x, height: bottom - y, imageHeight: imageBottom - y, labelHeight: bottom - imageBottom };
          });
          const canvas = sheet ? document.createElement('canvas') : undefined;
          if (canvas) { canvas.width = width; canvas.height = height; }
          try {
            for (let i = 0; i < views.length; i++) {
              abort.signal.throwIfAborted(); const view = views[i], tile = tiles[i];
              const sceneSettings = VIEW_DIRECTIONS[view][2] < 0 ? { ...settings, floor: 'none' as const, backdrop: 'plane' as const } : settings;
              const camera = shotCamera({ view, projection: projection, fovDegrees: fov }, i, assets.points, bounds, sourceTiles[i].width / sourceTiles[i].imageHeight, sourceTiles[i].imageHeight).camera;
              const blob = await renderer.render({ key: JSON.stringify(sceneSettings), scene: () => composeStudioScene(assets, sceneSettings, look, 'preview'), release: releaseStudioScene,
                camera, width: tile.width, height: tile.imageHeight, presentation: sceneSettings }, abort.signal);
              if (canvas) {
                const bitmap = await createImageBitmap(blob);
                try {
                  abort.signal.throwIfAborted(); const ctx = canvas.getContext('2d')!;
                  ctx.drawImage(bitmap, tile.x, tile.y, tile.width, tile.imageHeight);
                  if (tile.labelHeight) {
                    ctx.fillStyle = '#f5f4f0'; ctx.fillRect(tile.x, tile.y + tile.imageHeight, tile.width, tile.labelHeight);
                    ctx.save(); ctx.beginPath(); ctx.rect(tile.x, tile.y + tile.imageHeight, tile.width, tile.labelHeight); ctx.clip();
                    ctx.fillStyle = '#252728'; ctx.textBaseline = 'middle'; ctx.font = `${Math.max(1, Math.min(16 * scale, tile.labelHeight * .5))}px sans-serif`;
                    ctx.fillText(viewLabel(view), tile.x + Math.min(12 * scale, tile.width * .05), tile.y + tile.imageHeight + tile.labelHeight / 2); ctx.restore();
                  }
                } finally { bitmap.close(); }
              } else { const url = URL.createObjectURL(blob); urls.push(url); output.push({ view, url }); }
            }
            if (canvas) {
              const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png')); abort.signal.throwIfAborted();
              if (!blob) throw new Error('The image layout preview could not be prepared.');
              const url = URL.createObjectURL(blob); urls.push(url); output.push({ view: 'sheet', url });
            }
            abort.signal.throwIfAborted(); setImages(output); setPhase('ready'); published = true;
          } finally { if (canvas) canvas.width = canvas.height = 0; }
        } catch (error) { if (!abort.signal.aborted) { setError(error instanceof Error ? error.message : String(error)); setPhase('error'); } }
        finally { renderer?.dispose(); lease.users--; releaseAssets(lease); if (!published) urls.forEach(url => URL.revokeObjectURL(url)); }
      };
      void run();
    }, 180);
    return () => { clearTimeout(timer); abort.abort(); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [lease, evaluation, settings, key, layout, labels, outputAspect, projection, fov, outputWidth, outputHeight]);
  return <section className={`studio-product-preview ${layout === 'separate' ? 'separate' : 'sheet'}`} aria-label="Product view preview" aria-busy={phase === 'preparing'}>
    <header><span>{layout === 'sheet' ? 'Image layout' : 'Separate images'}</span><small role="status">{!views.length ? 'No views selected' : phase === 'preparing' ? 'Updating preview…' : phase === 'ready' ? 'Live preview' : 'Preview unavailable'}</small></header>
    {error ? <p className="studio-product-preview-message" role="alert">{error}</p>
      : !views.length ? <p className="studio-product-preview-message">Choose views in Output to compose your image.</p>
      : <div className="studio-product-preview-images" style={layout === 'sheet' ? { aspectRatio: outputAspect } : undefined}>
        {phase === 'preparing' && <p className="studio-product-preview-message" role="status">Preparing product views…</p>}
        {phase === 'ready' && images.map(image => <figure key={image.view} style={layout === 'separate' ? { aspectRatio: outputAspect } : undefined}>
          <img src={image.url} alt={image.view === 'sheet' ? `Output layout with ${views.map(viewLabel).join(', ')}${labels ? ', with view labels' : ', without labels'}` : `${viewLabel(image.view)} image preview`} />
          {layout === 'separate' && image.view !== 'sheet' && <figcaption>{viewLabel(image.view)}</figcaption>}
        </figure>)}
      </div>}
  </section>;
}
