import { useEffect, useId, useRef, useState } from 'react';
import type { Presentation } from '../shared/protocol';
import { STUDIO_FLOOR_IDS } from '../shared/materials';
import { floorPatternSize, studioSettings } from '../shared/studio';
import { BackgroundChoices, EnvironmentChoices, FloorChoices } from './StudioChoices';
import { Color, Group, LightDial, Segmented, Slider } from './StudioControls';
import { Icon } from './icons';
import { applyLook, BUILT_IN_LOOKS, deleteLook, MAX_SAVED_LOOKS, saveLook, sameScene, useSavedLooks, type StudioLook } from './studio-looks';
import type { StudioView } from './StudioViewport';

type Change = (patch: Partial<Presentation>) => void;
type Settings = ReturnType<typeof studioSettings>;

/** Thumbnails show this model from the current camera. They are made once per visit to the panel. */
function useLookThumbnails(looks: StudioLook[], settings: Presentation, api: React.RefObject<StudioView | null>, ready: boolean, identity: string) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = looks.map(look => look.id).join(',');
  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController(), made: string[] = [];
    void (async () => {
      for (const look of looks) {
        if (abort.signal.aborted || !api.current) return;
        try {
          const blob = await api.current.thumbnail(applyLook(settings, look), 264, 168, abort.signal);
          const url = URL.createObjectURL(blob); made.push(url);
          setUrls(current => ({ ...current, [look.id]: url }));
        } catch { if (abort.signal.aborted) return; }
      }
    })();
    return () => { abort.abort(); made.forEach(url => URL.revokeObjectURL(url)); setUrls({}); };
    // Settings are read when the panel opens; material changes do not regenerate every look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, identity]);
  return urls;
}

function LookCard({ look, chosen, url, onApply, onDelete }: { look: StudioLook; chosen: boolean; url?: string; onApply: () => void; onDelete?: () => void }) {
  return <li className={`studio-look ${chosen ? 'chosen' : ''}`}>
    <button type="button" aria-pressed={chosen} onClick={onApply}>
      <span className="studio-look-image">{url ? <img src={url} alt="" /> : <span className="studio-look-pending" aria-hidden="true" />}</span>
      <span className="studio-look-name"><strong>{look.name}</strong>{look.caption && <small>{look.caption}</small>}</span>
      {chosen && <Icon name="check" size={13} />}
    </button>
    {onDelete && <button type="button" className="icon-button quiet studio-look-delete" aria-label={`Delete look ${look.name}`} title="Delete look" onClick={onDelete}><Icon name="delete" size={14} /></button>}
  </li>;
}

/** Complete scenes in one click: lighting, surroundings, floor and background. Materials stay. */
export function LooksPanel({ settings, onApply, api, ready, identity, disabled }: { settings: Presentation; onApply: (scene: Presentation) => void; api: React.RefObject<StudioView | null>; ready: boolean; identity: string; disabled: boolean }) {
  const saved = useSavedLooks(), [naming, setNaming] = useState(false), [name, setName] = useState(''), input = useRef<HTMLInputElement>(null), nameId = useId();
  const all = [...BUILT_IN_LOOKS, ...saved];
  const urls = useLookThumbnails(all, settings, api, ready, identity);
  const current = all.find(look => sameScene(settings, look.scene));
  useEffect(() => { if (naming) input.current?.focus(); }, [naming]);
  const submit = (event: React.FormEvent) => { event.preventDefault(); saveLook(name, settings); setName(''); setNaming(false); };
  return <fieldset className="studio-panel-body" disabled={disabled}>
    <Group title="Starting looks" hint="One click sets lights, floor and background." info="A look replaces the lights, surroundings, floor and background. Your material choices are kept.">
      <ul className="studio-looks">{BUILT_IN_LOOKS.map(look => <LookCard key={look.id} look={look} chosen={current?.id === look.id} url={urls[look.id]} onApply={() => onApply(applyLook(settings, look))} />)}</ul>
    </Group>
    <Group title="Your looks" hint={saved.length ? 'Saved in this browser, for any model.' : 'Save this scene to reuse it on any model.'}>
      {saved.length > 0 && <ul className="studio-looks">{saved.map(look => <LookCard key={look.id} look={look} chosen={current?.id === look.id} url={urls[look.id]} onApply={() => onApply(applyLook(settings, look))} onDelete={() => deleteLook(look.id)} />)}</ul>}
      {naming ? <form className="studio-look-form" onSubmit={submit}>
        <label htmlFor={nameId} className="sr-only">Look name</label>
        <input id={nameId} ref={input} value={name} maxLength={60} placeholder="Look name" onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setNaming(false); } }} />
        <button type="submit" className="ghost-button small">Save</button>
        <button type="button" className="link-button" onClick={() => setNaming(false)}>Cancel</button>
      </form> : <button type="button" className="ghost-button studio-look-save" disabled={!!current || saved.length >= MAX_SAVED_LOOKS} onClick={() => setNaming(true)}>
        <Icon name="plus" size={14} />{current ? 'This look is already saved' : saved.length >= MAX_SAVED_LOOKS ? `Up to ${MAX_SAVED_LOOKS} looks` : 'Save current look'}
      </button>}
    </Group>
  </fieldset>;
}

const LIGHT_STYLES = [{ id: 'studio', label: 'Balanced' }, { id: 'soft', label: 'Soft' }, { id: 'dramatic', label: 'Dramatic' }] as const;
/** Lights in the order they matter: overall exposure, the key light, then the surroundings. */
export function LightPanel({ s, change, camera, disabled }: { s: Settings; change: Change; camera: number; disabled: boolean }) {
  return <fieldset className="studio-panel-body" disabled={disabled}>
    <Group title="Overall">
      <Segmented label="Lighting style" info="A starting arrangement of lights. Choosing one resets the key light and surroundings strengths." value={s.preset} onChange={preset => change({ preset, environment: undefined, keyIntensity: undefined })} options={LIGHT_STYLES} />
      <Slider label="Exposure" hint="Brightness of the whole picture." min={0.25} max={3} step={0.05} value={s.exposure} onChange={exposure => change({ exposure })} />
    </Group>
    <Group title="Key light" hint="Top view. Drag the light around the model." info="The map turns with your camera: the bottom edge is where you look from, so left on the map is left in the picture. Nearer the center is higher. Lights stay fixed to the model while you orbit.">
      <LightDial rotation={s.lightRotation} elevation={s.lightElevation} camera={camera} fill={s.preset !== 'dramatic'} color={s.lightColor} onChange={change} />
      <Slider label="Strength" ariaLabel="Key light" min={0} max={8} step={0.1} value={s.keyIntensity} onChange={keyIntensity => change({ keyIntensity })} />
      <Slider label="Softness" hint="Softer shadows, broader highlights." min={0.25} max={3} step={0.05} unit="×" value={s.keySize} onChange={keySize => change({ keySize })} />
      <Slider label="Fill light" hint="Lifts the shadow side." min={0} max={3} step={0.05} unit="×" value={s.fillIntensity} onChange={fillIntensity => change({ fillIntensity })} />
      <div className="studio-inline-row">
        <Color label="Key color" value={s.lightColor} onChange={lightColor => change({ lightColor })} />
        <label className="studio-check"><input type="checkbox" checked={s.shadows} onChange={e => change({ shadows: e.target.checked })} />Shadows in preview</label>
      </div>
    </Group>
    <Group title="Surroundings" hint="The photo that shiny parts reflect." info="A photo all around the model. It adds soft light and appears in reflections. It is visible behind the model only with an Environment background.">
      <EnvironmentChoices compact legend="Photo" value={s.environmentPreset} onChange={environmentPreset => change({ environmentPreset })} />
      <Slider label="Strength" ariaLabel="Surroundings strength" min={0} max={3} step={0.05} value={s.environment} onChange={environment => change({ environment })} />
      <Slider label="Turn" ariaLabel="Turn surroundings" hint="Moves the reflections." min={-180} max={180} value={s.environmentRotation} unit="°" onChange={environmentRotation => change({ environmentRotation })} />
    </Group>
  </fieldset>;
}

const SETS = [
  { id: 'sweep', label: 'Seamless', caption: 'No horizon line', path: 'M6 30 H34 Q50 30 50 14 V4' },
  { id: 'plane', label: 'Open floor', caption: 'Runs to the horizon', path: 'M4 30 H52 M4 20 H52' },
  { id: 'none', label: 'No floor', caption: 'Model only', path: '' },
] as const;
function SetChoices({ value, onChange }: { value: 'sweep' | 'plane' | 'none'; onChange: (value: 'sweep' | 'plane' | 'none') => void }) {
  const name = useId();
  return <fieldset className="visual-choice-field studio-set-choices"><legend>Set</legend><div>
    {SETS.map(set => <label key={set.id} className={value === set.id ? 'chosen' : ''}>
      <input type="radio" name={name} aria-label={set.label} checked={value === set.id} onChange={() => onChange(set.id)} />
      <svg viewBox="0 0 56 36" aria-hidden="true"><path className="set-ground" d={set.path} /><rect className="set-model" x={18} y={set.id === 'none' ? 14 : 18} width={12} height={12} rx={2} />{set.id === 'none' && <path className="set-none" d="M10 30 H46" />}</svg>
      <span><strong>{set.label}</strong><small>{set.caption}</small></span>
    </label>)}
  </div></fieldset>;
}

const FLOORS = STUDIO_FLOOR_IDS.filter(floor => floor !== 'none');
/** What the model stands on and what is behind it. */
export function BackdropPanel({ s, settings, radius, change, disabled }: { s: Settings; settings: Presentation; radius: number; change: Change; disabled: boolean }) {
  const set = s.floor === 'none' ? 'none' : s.backdrop, patternSize = floorPatternSize(settings, radius);
  const hidden = set === 'sweep' && (s.backgroundMode === 'environment' || s.backgroundMode === 'transparent');
  return <fieldset className="studio-panel-body" disabled={disabled}>
    <Group title="Floor">
      <SetChoices value={set} onChange={value => change(value === 'none' ? { floor: 'none' } : { backdrop: value, floor: s.floor === 'none' ? 'matte' : s.floor })} />
      {s.floor !== 'none' && <>
        <FloorChoices compact choices={FLOORS} value={s.floor} onChange={floor => change({ floor, floorColor: undefined, floorRoughness: undefined, floorScale: undefined })} />
        <Color label="Floor color" value={s.floorColor} onChange={floorColor => change({ floorColor })} />
        <Slider label="Roughness" ariaLabel="Floor roughness" hint="Lower is shinier." min={0.05} max={1} step={0.01} value={s.floorRoughness} onChange={floorRoughness => change({ floorRoughness })} />
        {patternSize !== undefined && <div className="studio-field"><span>Pattern size</span>
          <span className="studio-pattern-size">
            <input aria-label="Floor pattern size in millimetres" type="number" min={10} max={10000} value={patternSize} onChange={e => { if (e.target.value && Number.isFinite(e.target.valueAsNumber)) change({ floorScale: Math.max(10, Math.min(10000, e.target.valueAsNumber)) }); }} />
            <span>mm</span>
            <button type="button" className="ghost-button small" aria-pressed={s.floorScale === undefined} title="Follow the model's size" onClick={() => change({ floorScale: undefined })}>Auto</button>
          </span>
        </div>}
        <label className="studio-select"><span>Floor height, mm</span><input aria-label="Floor height" type="number" min={-10000} max={10000} value={s.floorHeight} onChange={e => { if (e.target.value && Number.isFinite(e.target.valueAsNumber)) change({ floorHeight: Math.max(-10000, Math.min(10000, e.target.valueAsNumber)) }); }} /></label>
        {set === 'plane' && <p className="studio-hint">Edge-on in orthographic side views.</p>}
      </>}
    </Group>
    <Group title="Background" hint={set === 'sweep' ? 'The seamless wall blends into this color.' : undefined}>
      <div className="studio-quiet-legend"><BackgroundChoices value={s.backgroundMode} color={s.background} top={s.backgroundTop} environment={s.environmentPreset} onChange={backgroundMode => change({ backgroundMode })} /></div>
      {hidden && <p className="studio-hint studio-hint-action">The seamless wall hides this. <button type="button" className="link-button" onClick={() => change({ backdrop: 'plane' })}>Use an open floor</button></p>}
      {s.backgroundMode === 'gradient' && <Color label="Top" value={s.backgroundTop} onChange={backgroundTop => change({ backgroundTop })} />}
      {s.backgroundMode !== 'environment' && s.backgroundMode !== 'transparent' && <Color label={s.backgroundMode === 'gradient' ? 'Horizon' : 'Color'} value={s.background} onChange={background => change({ background })} />}
      {s.backgroundMode === 'environment' && <p className="studio-hint">Choose the photo in Light.</p>}
    </Group>
  </fieldset>;
}
