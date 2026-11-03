import {ConstructionFields,ShapingJSON} from './ShapingFields';
import {Select} from './Select';
import { bodySections, wingSections, wingProfile } from '../cad/modeling-presets';
import type { RuntimeClient } from '../cad/runtime';
import { InstanceSourceFields } from './InstanceSourceFields';
import { createContext, useContext, useId, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CadDocument, CurvePath, Feature, Frame, Profile, Parameter } from '../shared/protocol';
import { evaluateExpression, expressionNames, parameterValues, valueAt, withField } from '../cad/parameters';
import { changeFeatureParams } from './feature-draft';
import { Icon } from './icons';
import { fmt } from './modeling';

const SCRUB_HINT = 'Drag sideways to adjust · Shift fine · Alt coarse';
/**
 * Drag a field's label sideways to change its value, like a dial. A plain click still focuses the input.
 * Each change flows through the same draft, so the exact live preview follows the drag.
 */
function scrub(value: number, onChange: (v: number) => void, unit: string, min?: number, max?: number, integer = false) {
  return {
    title: SCRUB_HINT,
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || !Number.isFinite(value)) return;
      const element = event.currentTarget, pointer = event.pointerId, startX = event.clientX, start = value;
      const base = integer || unit === '°' ? 1 : unit === '×' ? 0.01 : 0.5;
      let moved = false;
      const move = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        if (!moved && Math.abs(dx) < 3) return;
        if (!moved) { moved = true; element.setPointerCapture?.(pointer); document.body.classList.add('scrubbing'); }
        const increment = integer ? (e.altKey ? 10 : 1) : e.shiftKey ? base / 10 : e.altKey ? base * 10 : base;
        let next = Number((start + Math.round(dx / 4) * increment).toFixed(4));
        if (min !== undefined) next = Math.max(min, next);
        if (max !== undefined) next = Math.min(max, next);
        onChange(next);
      };
      const end = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
        document.body.classList.remove('scrubbing');
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    },
  };
}

/** One numeric field: its resolved value, its optional parameter expression, and how to change both together. */
export interface Field { value: number; binding?: string; set: (value: number, expression?: string) => void }
export const plainField = (value: number, onChange: (v: number) => void): Field => ({ value, set: v => onChange(v) });

/** Parameters that expressions in these fields may reference, and the id of their suggestion list. */
const ParameterScope = createContext<{ parameters: Parameter[]; listId?: string }>({ parameters: [] });
function ParameterProvider({ parameters = [], children }: { parameters?: Parameter[]; children: React.ReactNode }) {
  const listId = useId();
  return <ParameterScope.Provider value={{ parameters, listId: parameters.length ? listId : undefined }}>
    {parameters.length > 0 && <datalist id={listId}>{parameters.map(p => <option key={p.name} value={p.name}>{fmt(p.value)}</option>)}</datalist>}
    {children}
  </ParameterScope.Provider>;
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
/**
 * Accepts a number, arithmetic (2*15+3) or an expression over parameters (thickness + 2).
 * Arithmetic without names stores its value; an expression with names binds the field to it.
 */
function ExprInput({ field, label, className = '' }: { field: Field; label: string; className?: string }) {
  const { parameters, listId } = useContext(ParameterScope);
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const shown = field.binding ?? (Number.isFinite(field.value) ? String(Number(field.value.toFixed(6))) : '');
  const update = (raw: string) => {
    setText(raw);
    const input = raw.trim();
    if (!input) { setProblem('Enter a number'); field.set(Number.NaN); return; }
    if (NUMBER.test(input)) { setProblem(''); field.set(Number(input)); return; }
    try {
      const value = evaluateExpression(input, parameterValues(parameters));
      setProblem('');
      field.set(value, expressionNames(input).length ? input : undefined);
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
  };
  const step = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || field.binding || !Number.isFinite(field.value)) return;
    event.preventDefault();
    const amount = (event.shiftKey ? 10 : event.altKey ? 0.1 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
    const next = Number((field.value + amount).toFixed(6));
    setText(String(next)); setProblem(''); field.set(next);
  };
  const bound = !!field.binding && text === null;
  return <input type="text" inputMode={parameters.length ? 'text' : 'decimal'} list={listId} spellCheck={false} autoComplete="off" aria-label={label}
    className={`${className} ${bound ? 'bound' : ''}`} value={text ?? shown} aria-invalid={!!problem || !shown}
    title={problem || (field.binding ? `${field.binding} = ${fmt(field.value, 4)}` : parameters.length ? 'Type a number, arithmetic, or a parameter name' : undefined)}
    onFocus={() => setText(shown)} onBlur={() => { setText(null); setProblem(''); }} onChange={event => update(event.target.value)} onKeyDown={step} />;
}

export function NumberField({ label, field, min, max, unit = 'mm', hideLabel = false, className = '', integer = false }: { label: string; field: Field; min?: number; max?: number; unit?: string; hideLabel?: boolean; className?: string; integer?: boolean }) {
  const labelProps = hideLabel || field.binding ? {} : scrub(field.value, v => field.set(v), unit, min, max, integer);
  return <label className={`number-field ${className}`}>
    <span className={hideLabel ? 'sr-only' : `field-label ${field.binding ? 'bound' : 'scrub'}`} {...labelProps}>{label}{field.binding && <Icon name="link" size={12} />}</span>
    <span className={`input-shell ${field.binding ? 'bound' : ''}`}><ExprInput field={field} label={label} />{(unit || field.binding) && <span className="unit">{field.binding ? `${fmt(field.value, 3)} ${unit}` : unit}</span>}</span>
  </label>;
}
export function VectorField({ label, field, unit = 'mm' }: { label: string; field: (axis: number) => Field; unit?: string }) {
  return <fieldset className="vector-field"><legend className="field-label">{label}{unit && <small>{unit}</small>}</legend><div className="xyz">{['X', 'Y', 'Z'].map((axis, i) => {
    const f = field(i);
    return <label key={axis} className={`axis-input axis-${axis.toLowerCase()} ${f.binding ? 'bound' : ''}`}>
      <span aria-hidden="true" className={f.binding ? '' : 'scrub'} {...(f.binding ? { title: `Bound to ${f.binding}` } : scrub(f.value, v => f.set(v), unit))}>{axis}</span>
      <ExprInput field={f} label={`${label} ${axis}`} />
    </label>;
  })}</div></fieldset>;
}
export function Segmented<T extends string>({ label, value, options, onChange, labels, disabled }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Partial<Record<T, string>>; disabled?: boolean }) {
  const name = useId();
  return <fieldset disabled={disabled} className="segmented-field"><legend className="field-label">{label}</legend><div className="segmented">{options.map(option => <label key={option} className={value === option ? 'checked' : ''}>
    <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
    <span>{labels?.[option] ?? option}</span>
  </label>)}</div></fieldset>;
}
function PointsField({ label, value, onChange, field, radial = false }: { label: string; value: [number, number][]; onChange: (v: [number, number][]) => void; field: (point: number, axis: number) => Field; radial?: boolean }) {
  return <fieldset className="points-field"><legend className="field-label">{label}<small>mm</small></legend>
    <p className="field-hint">{radial ? 'Radius from the axis, then height. The last point closes back to the first.' : 'Local plane coordinates U, V. The last point closes back to the first.'}</p>
    <div className="point-head" aria-hidden="true"><span>#</span><span>{radial ? 'Radius' : 'U'}</span><span>{radial ? 'Height' : 'V'}</span><span /></div>
    {value.map((_, i) => <div className="point-row" key={i}>
      <span className="point-index" aria-hidden="true">{i + 1}</span>
      <NumberField label={`${radial ? 'Radius' : 'U'} ${i + 1}`} hideLabel unit="" min={radial ? 0 : undefined} field={field(i, 0)} />
      <NumberField label={`${radial ? 'Height' : 'V'} ${i + 1}`} hideLabel unit="" field={field(i, 1)} />
      <button type="button" className="icon-button quiet" aria-label={`Remove point ${i + 1}`} title={`Remove point ${i + 1}`} disabled={value.length <= 3} onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
    </div>)}
    <button type="button" className="ghost-button" disabled={value.length >= 64} onClick={() => onChange([...value, [value.at(-1)![0] + 5, value.at(-1)![1]]])}><Icon name="plus" size={14} />Add point</button>
  </fieldset>;
}
function ObjectChoice({ label, value, options, onChange, optional }: { label: string; value: string | undefined; options: Feature[]; onChange: (id: string) => void; optional?: string }) {
  return <label className="select-field"><span className="field-label">{label}</span><span className="select-shell"><Select required={!optional} value={value ?? ''} onChange={e => onChange(e.target.value)}><option value="" disabled={!optional}>{optional ?? 'Choose an object'}</option>{options.map(v => <option key={v.id} value={v.id}>{v.label || v.id}</option>)}</Select><Icon name="chevron" size={14} /></span></label>;
}

/** Bounded exact curve data, edited with ordinary numeric fields and the same live preview. */
function PointField({ label, field, path }: { label: string; field: (path: string) => Field; path: string }) {
  return <div className="field-pair">{['U', 'V'].map((axis, i) => <NumberField key={axis} label={`${label} ${axis}`} field={field(`${path}.${i}`)} />)}</div>;
}
function CurveFields({ path, prefix, field, onChange }: { path: CurvePath; prefix: string; field: (path: string) => Field; onChange: (path: CurvePath) => void }) {
  const endpoint = path.segments.at(-1)?.to ?? path.start;
  const segment = (type: 'line' | 'arc' | 'bezier', from: [number, number]) => type === 'line'
    ? { type, to: [from[0] + 20, from[1]] as [number, number] }
    : type === 'arc' ? { type, via: [from[0] + 10, from[1] + 10] as [number, number], to: [from[0] + 20, from[1]] as [number, number] }
    : { type, controls: [[from[0] + 5, from[1] + 10], [from[0] + 15, from[1] + 10]] as [number, number][], to: [from[0] + 20, from[1]] as [number, number] };
  return <>
    <PointField label="Start" path={`${prefix}.start`} field={field} />
    {path.segments.map((s, i) => <details key={i} open className="method">
      <summary>Segment {i + 1} · {s.type === 'bezier' ? 'Bezier spline' : s.type}</summary>
      <label className="select-field"><span className="field-label">Segment {i + 1} type</span><Select value={s.type} onChange={e => onChange({ ...path, segments: path.segments.map((old, j) => j === i ? segment(e.target.value as typeof s.type, i ? path.segments[i - 1].to : path.start) : old) })}>
        <option value="line">Line</option><option value="arc">Circular arc through a point</option><option value="bezier">Bezier spline</option>
      </Select></label>
      {s.type === 'arc' && <PointField label={`Arc ${i + 1} through`} path={`${prefix}.segments.${i}.via`} field={field} />}
      {s.type === 'bezier' && <>
        {s.controls.map((_, j) => <PointField key={j} label={`Segment ${i + 1} control ${j + 1}`} path={`${prefix}.segments.${i}.controls.${j}`} field={field} />)}
        <button className="link-button" type="button" onClick={() => onChange({ ...path, segments: path.segments.map((old, j) => j === i ? { ...s, controls: s.controls.length === 2 ? [s.controls[0]] : [s.controls[0], [s.to[0] - 5, s.to[1] + 5]] } : old) })}>{s.controls.length === 2 ? 'Use quadratic' : 'Use cubic'}</button>
      </>}
      <PointField label={`Segment ${i + 1} end`} path={`${prefix}.segments.${i}.to`} field={field} />
      <button className="link-button" type="button" disabled={path.segments.length <= 1} onClick={() => onChange({ ...path, segments: path.segments.filter((_, j) => j !== i) })}>Remove segment {i + 1}</button>
    </details>)}
    <button className="ghost-button" type="button" disabled={path.segments.length >= 32} onClick={() => onChange({ ...path, segments: [...path.segments, segment('line', endpoint)] })}>Add segment</button>
  </>;
}
function ProfileFields({ profile, prefix, field, onChange }: { profile: Profile; prefix: string; field: (path: string) => Field; onChange: (profile: Profile) => void }) {
  return <>
    <label className="select-field"><span className="field-label">Profile</span><Select aria-label={`${prefix} type`} value={profile.type} onChange={e => {
      const type = e.target.value as Profile['type'];
      onChange(type === 'circle' ? { type, radius: 5 } : type === 'rectangle' ? { type, width: 40, height: 20 } : type === 'ellipse' ? { type, radiusX: 20, radiusY: 10 } : type === 'polygon' ? { type, points: [[-20,-10],[20,-10],[20,10],[-20,10]] } : wingProfile());
    }}><option value="rectangle">Rectangle</option><option value="circle">Circle</option><option value="ellipse">Ellipse</option><option value="polygon">Polygon</option><option value="path">Curved path / spline</option></Select></label>
    {profile.type === 'rectangle' && <div className="field-pair"><NumberField label="Width" field={field(`${prefix}.width`)} /><NumberField label="Length" field={field(`${prefix}.height`)} /></div>}
    {profile.type === 'circle' && <NumberField label="Radius" field={field(`${prefix}.radius`)} />}
    {profile.type === 'ellipse' && <div className="field-pair"><NumberField label="U radius" field={field(`${prefix}.radiusX`)} /><NumberField label="V radius" field={field(`${prefix}.radiusY`)} /></div>}
    {profile.type === 'polygon' && <PointsField label="Profile points" value={profile.points} field={(i,a)=>field(`${prefix}.points.${i}.${a}`)} onChange={points=>onChange({type:'polygon',points})} />}
    {profile.type === 'path' && <><p className="field-hint">Exact circular arcs and quadratic/cubic Bezier splines. A final straight edge closes the profile when needed. Keep the boundary simple.</p><CurveFields path={profile} prefix={prefix} field={field} onChange={path=>onChange({type:'path',...path})} /></>}
  </>;
}
function FrameFields({ prefix, field }: { prefix: string; field: (path: string) => Field }) {
  return <><VectorField label="Frame origin" field={i=>field(`${prefix}.origin.${i}`)} /><VectorField label="Frame normal" unit="" field={i=>field(`${prefix}.normal.${i}`)} /><VectorField label="Local U direction" unit="" field={i=>field(`${prefix}.xDirection.${i}`)} /><p className="field-hint">U and normal must be perpendicular. V = normal cross U. Directions are normalized.</p></>;
}
function MountFields({ feature, onChange }: { feature: Feature; onChange: (feature: Feature) => void }) {
  const mounts = feature.mounts ?? [];
  return <details className="method"><summary>Mount points · {mounts.length} authored</summary>
    <p className="field-hint">Named static frames in this result's document coordinates. Derived results inherit them. Explicit names override inherited mounts. These frames do not track faces.</p>
    {mounts.map((mount,i)=><fieldset className="vector-field" key={i}><legend>Mount {i+1}</legend>
      <label className="select-field"><span className="field-label">Mount name</span><input className="text-input" aria-label={`Mount ${i+1} name`} value={mount.name} onChange={e=>onChange({...feature,mounts:mounts.map((m,j)=>j===i?{...m,name:e.target.value}:m)})} /></label>
      <FrameFields prefix="frame" field={path=>({value:valueAt(mount,path)??NaN,set:value=>{
        const frame=structuredClone(mount.frame); const [,key,axis]=path.split('.'); frame[key as keyof Frame][Number(axis)]=value;
        onChange({...feature,mounts:mounts.map((m,j)=>j===i?{...m,frame}:m)});
      }})} />
      <button className="link-button" type="button" onClick={()=>onChange({...feature,mounts:mounts.filter((_,j)=>j!==i)})}>Remove mount {i+1}</button>
    </fieldset>)}
    <button className="ghost-button" type="button" disabled={mounts.length>=32} onClick={()=>{
      let n=1;while(mounts.some(m=>m.name===`mount_${n}`))n++;
      onChange({...feature,mounts:[...mounts,{name:`mount_${n}`,frame:{origin:[0,0,0],normal:[0,0,1],xDirection:[1,0,0]}}]});
    }}>Add mount</button>
  </details>;
}

/** Typed fields for every feature kind. `mode` narrows transform fields to the active verb. */
/** How a fillet or chamfer edge selection presents in the form. */
const edgeMode = (edges: Extract<Feature, { kind: 'fillet' }>['params']['edges']) =>
  typeof edges === 'string' ? edges : edges.near && Object.keys(edges).every(key => key === 'near' || key === 'toleranceMm') ? 'picked' as const : 'query' as const;

export function FeatureFields({ feature: f, document, onChange, mode = 'edit', showName = true, extra, runtime }: { runtime?: RuntimeClient; feature: Feature; document: CadDocument; onChange: (v: Feature) => void; mode?: string; showName?: boolean; extra?: (change: (params: Record<string, unknown>) => void) => React.ReactNode }) {
  const change = (params: Record<string, unknown>, reset?: string[]) => onChange(changeFeatureParams(f, params, reset));
  const field = (path: string): Field => ({ value: valueAt(f.params, path) ?? Number.NaN, binding: f.bindings?.[path], set: (value, expression) => onChange(withField(f, path, value, expression)) });
  const vector = (path: string) => (axis: number) => field(`${path}.${axis}`);
  const index = document.features.findIndex(feature => feature.id === f.id);
  const earlier = index < 0 ? document.features : document.features.slice(0, index);
  const target = 'target' in f.params && f.kind !== 'text' && <ObjectChoice label={f.kind === 'subtract' || f.kind === 'union' || f.kind === 'intersect' ? 'Target (kept)' : 'Target'} value={f.params.target} options={earlier} onChange={id => change({ target: id, ...('tools' in f.params ? { tools: f.params.tools.filter(tool => tool !== id) } : {}) })} />;
  return <ParameterProvider parameters={document.parameters}>
    {showName && <label className="select-field"><span className="field-label">Name</span><input className="text-input" value={f.label ?? ''} maxLength={120} placeholder={f.id} onChange={e => onChange({ ...f, label: e.target.value || undefined })} /></label>}
    {target}
    {f.kind === 'instance' && <>
      {runtime && <InstanceSourceFields runtime={runtime} document={document} feature={f} onChange={onChange} />}
      {f.params.attachment ? <>
        {'frame' in f.params.attachment.target && <FrameFields prefix="attachment.target.frame" field={field} />}
        <VectorField label="Target-local offset" field={vector('attachment.offset')} />
        <NumberField label="Mount twist" unit="°" field={field('attachment.twistDegrees')} />
      </> : <><VectorField label="Translation" field={vector('translation')} />
        <details className="placement-advanced"><summary>Rotation and pivot</summary><NumberField label="Angle" unit="°" field={field('angleDegrees')} />
        <VectorField label="Rotation axis" unit="" field={vector('rotationAxis')} />
        <VectorField label="Pivot" field={vector('origin')} />
        <p className="field-hint">Rotate about the pivot, then translate in world coordinates.</p></details></>}

    </>}
    {f.kind === 'box' && <><VectorField label="Size" field={vector('size')} /><VectorField label="Minimum corner" field={vector('origin')} /></>}
    {f.kind === 'rod' && <><VectorField label="From center" field={vector('from')} /><VectorField label="To center" field={vector('to')} /><NumberField label="Radius" min={0.01} field={field('radius')} /><p className="field-hint">Flat ends, perpendicular to the line between the centers.</p></>}
    {f.kind === 'cylinder' && <><div className="field-pair"><NumberField label="Radius" min={0.01} field={field('radius')} /><NumberField label="Height" min={0.01} field={field('height')} /></div><VectorField label="Bottom center" field={vector('origin')} /></>}
    {f.kind === 'extrude' && <>
      <ProfileFields profile={f.params.profile} prefix="profile" field={field} onChange={profile=>change({profile})} />
      <NumberField label="Depth" min={0.01} field={field('distance')} />
      <Segmented label="Sketch plane" value={typeof f.params.plane === 'string' ? f.params.plane : 'custom'} options={['XY','XZ','YZ','custom'] as const} labels={{custom:'Local'}} onChange={plane=>change({plane:plane==='custom'?{normal:[0,0,1],xDirection:[1,0,0]}:plane})} />
      <VectorField label="Profile origin" field={vector('origin')} />
      {typeof f.params.plane !== 'string' && <><VectorField label="Plane normal" unit="" field={vector('plane.normal')} /><VectorField label="Local U direction" unit="" field={vector('plane.xDirection')} /></>}
      <p className="field-hint">Depth follows the plane normal. Presets: XY +Z, XZ -Y, YZ +X. Local V = normal cross U.</p>
    </>}
    {(f.kind==='fill'||f.kind==='join')&&<ConstructionFields feature={f} document={document} runtime={runtime} change={change}/>}
    {f.kind === 'loft' && <>
      <Segmented label="Correspondence" value={f.params.correspondence??'automatic'} options={['automatic','authored'] as const} onChange={correspondence=>change({correspondence})}/>
      {f.params.correspondence==='authored'&&<p className="field-hint">Exact seam and split positions use normalized perimeter length. Edge counts must match. Preview shows seams and correspondence.</p>}
      <Segmented label="Surface" value={f.params.ruled?'ruled':'smooth'} options={['smooth','ruled'] as const} onChange={v=>change({ruled:v==='ruled'})} />
      <div className="field-pair"><button type="button" className="ghost-button" onClick={()=>change({sections:bodySections(),ruled:false},['sections'])}>Smooth body</button><button type="button" className="ghost-button" onClick={()=>change({sections:wingSections(),ruled:false},['sections'])}>Twisted wing</button></div>
      {f.params.sections.map((section,i)=><details className="method" key={i} open={i===0}>
        <summary>Section {i+1} · {section.profile.type} · {section.frame.origin.map(v=>fmt(v,1)).join(', ')}</summary>
        <ProfileFields profile={section.profile} prefix={`sections.${i}.profile`} field={field} onChange={profile=>change({sections:f.params.sections.map((s,j)=>j===i?{...s,profile}:s)})} />
        <FrameFields prefix={`sections.${i}.frame`} field={field} />
        {f.params.correspondence==='authored'&&<><NumberField label={`Section ${i+1} seam`} unit="" min={0} max={0.999999} field={{...field(`sections.${i}.seam`),value:section.seam??0}}/><label><input type="checkbox" checked={section.reverse??false} onChange={e=>change({sections:f.params.sections.map((s,j)=>j===i?{...s,reverse:e.target.checked}:s)})}/>Reverse traversal</label><ShapingJSON label={`Section ${i+1} exact splits`} value={section.splitAt??[]} onChange={splitAt=>change({sections:f.params.sections.map((s,j)=>j===i?{...s,splitAt}:s)})}/></>}

        <button className="link-button" type="button" disabled={f.params.sections.length<=2} onClick={()=>change({sections:f.params.sections.filter((_,j)=>j!==i)})}>Remove section {i+1}</button>
      </details>)}
      <button className="ghost-button" type="button" disabled={f.params.sections.length>=12} onClick={()=>{
        const last=structuredClone(f.params.sections.at(-1)!); const length=Math.hypot(...last.frame.normal);
        last.frame.origin=last.frame.origin.map((v,i)=>v+last.frame.normal[i]/length*20) as Frame['origin'];change({sections:[...f.params.sections,last]});
      }}>Add section</button>
      <details className="method"><summary>Guides, smoothness and explicit mapping</summary><ShapingJSON label="Loft parameters" value={f.params} onChange={change}/><p>Guides follow named section vertices with authored correspondence. Guided patch seams are G0; ordinary loft C1/C2 controls describe internal smoothness.</p></details>
      <p className="field-hint">Sections are ordered. Smooth uses one kernel loft across them; ruled joins consecutive sections. Profiles must stay simple and compatible.</p>
    </>}
    {f.kind === 'sweep' && <>
      <details className="method"><summary>Guide and section locations</summary><ShapingJSON label="Sweep parameters" value={f.params} onChange={change}/><p>Advanced paths support one exact edge. Locations use native path parameter. Guide contact mode: none, curvilinear: true.</p></details>
      <ProfileFields profile={f.params.profile} prefix="profile" field={field} onChange={profile=>change({profile})} />
      {'points' in f.params.path ? <>
        <h3 className="section-title">3D path</h3>
        <p className="field-hint">A smooth spline through {f.params.path.points.length} points{f.params.endScale !== undefined ? `, scaling the profile to ${f.params.endScale}× at the end` : ''}. Edit its points through apply_edits.</p>
      </> : (() => { const planar = f.params.path; return <>
        <h3 className="section-title">Open curved path</h3>
        <CurveFields path={planar} prefix="path" field={field} onChange={path=>change({path:{...path,frame:planar.frame}})} />
        <FrameFields prefix="path.frame" field={field} />
      </>; })()}
      <p className="field-hint">The profile starts perpendicular to the path tangent. Profile U follows {f.params.profileX ? 'profileX' : 'points' in f.params.path ? 'world Z' : 'the path-plane normal'}. Corrected Frenet transport follows the exact path. Keep the profile smaller than the bend radius.</p>
    </>}
    {f.kind === 'shell' && <>
      <NumberField label="Inward thickness" field={field('thickness')} min={0.01} />
      {f.params.removeFaces.map((_,i)=><details className="method" key={i} open>
        <summary>Planar opening {i+1}</summary>
        <VectorField label="Point on opening plane" field={vector(`removeFaces.${i}.point`)} /><VectorField label="Opening normal" unit="" field={vector(`removeFaces.${i}.normal`)} />
        <NumberField label="Expected faces" unit="" min={1} max={16} integer field={field(`removeFaces.${i}.expectedCount`)} /><NumberField label="Plane tolerance" field={field(`removeFaces.${i}.toleranceMm`)} />
        <button className="link-button" type="button" disabled={f.params.removeFaces.length<=1} onClick={()=>change({removeFaces:f.params.removeFaces.filter((_,j)=>j!==i)})}>Remove opening {i+1}</button>
      </details>)}
      <button className="ghost-button" type="button" disabled={f.params.removeFaces.length>=8} onClick={()=>change({removeFaces:[...f.params.removeFaces,{point:[0,0,0],normal:[0,0,1],toleranceMm:0.001,expectedCount:1}]})}>Add opening plane</button>
      <p className="field-hint">Every planar face on a query plane is removed, regardless of normal sign. The exact match count is required. Ambiguous or overlapping queries fail without changing the part.</p>
    </>}
    {f.kind === 'revolve' && <><PointsField label="Turned profile" radial value={f.params.points} onChange={points => change({ points })} field={(i, a) => field(`points.${i}.${a}`)} /><NumberField label="Angle" unit="°" min={0.1} max={360} field={field('angleDegrees')} /><VectorField label="Axis origin" field={vector('origin')} /><p className="field-hint">Revolves about world Z through the axis origin.</p></>}
    {(f.kind === 'subtract' || f.kind === 'union' || f.kind === 'intersect') && <fieldset className="check-list"><legend className="field-label">{f.kind === 'subtract' ? 'Cut away' : f.kind === 'union' ? 'Fuse with' : 'Intersect with'}</legend>
      {earlier.filter(v => v.id !== f.params.target).map(v => <label key={v.id} className="check-row"><input type="checkbox" checked={f.params.tools.includes(v.id)} onChange={e => change({ tools: e.target.checked ? [...f.params.tools, v.id] : f.params.tools.filter(id => id !== v.id) })} /><span>{v.label || v.id}</span></label>)}
      {!f.params.tools.length && <p className="field-hint warn-text">Choose at least one object.</p>}
    </fieldset>}
    {(f.kind === 'fillet' || f.kind === 'chamfer') && <>
      {f.kind==='fillet'&&<><label><input type="checkbox" checked={typeof f.params.radius!=='number'} onChange={e=>change({radius:e.target.checked?{stations:[[0,1],[1,2]]}:1})}/>Variable radius</label>{typeof f.params.radius!=='number'&&<ShapingJSON label="Radius stations [length fraction, mm]" value={f.params.radius.stations} onChange={stations=>change({radius:{stations}})}/>}</>}
      {(f.kind!=='fillet'||typeof f.params.radius==='number')&&<NumberField label={f.kind === 'fillet' ? 'Radius' : 'Distance'} min={0.01} field={field(f.kind === 'fillet' ? 'radius' : 'distance')} />}
      <Segmented label="Edges" value={edgeMode(f.params.edges)} options={edgeMode(f.params.edges) === 'query' ? ['vertical', 'all', 'picked', 'query'] as const : ['vertical', 'all', 'picked'] as const} labels={{ vertical: 'Vertical (∥ Z)', all: 'All', picked: 'Picked', query: 'Query' }}
        onChange={mode => { if (mode === 'vertical' || mode === 'all') change({ edges: mode }); else if (mode === 'picked' && edgeMode(f.params.edges) !== 'picked') change({ edges: { near: [] } }); }} />
      {typeof f.params.edges === 'object' && edgeMode(f.params.edges) === 'query' && <p className="field-hint">Selected by the query <code>{JSON.stringify(f.params.edges)}</code>, re-resolved on every rebuild.</p>}
      {extra?.(change)}
      <p className="field-hint">{edgeMode(f.params.edges) === 'picked' ? 'Picked edges are those passing near the clicked points, found again on every rebuild.' : 'Vertical picks straight edges parallel to world Z, such as plate corners.'} Oversized values are rejected and the model is left unchanged.</p>
    </>}
    {f.kind === 'transform' && <>
      {['move', 'duplicate', 'edit'].includes(mode) && <VectorField label={mode === 'duplicate' ? 'Copy offset' : 'Translation'} field={vector('translation')} />}
      {['rotate', 'edit'].includes(mode) && <><NumberField label="Angle" unit="°" field={field('angleDegrees')} /><VectorField label="Rotation axis" unit="" field={vector('rotationAxis')} /></>}
      {['scale', 'edit'].includes(mode) && <NumberField label="Uniform scale" unit="×" min={0.001} max={1000} field={field('scale')} />}
      {['rotate', 'scale', 'edit'].includes(mode) && <VectorField label="Pivot" field={vector('origin')} />}
      <label className="check-row"><input type="checkbox" checked={f.params.copy} onChange={e => change({ copy: e.target.checked })} /><span>Keep the source (linked copy)</span></label>
      <p className="field-hint">Order: scale and rotate about the pivot, then translate in world coordinates.</p>
    </>}
    {f.kind === 'pattern' && <>
      <Segmented label="Layout" value={f.params.layout.type} options={['linear', 'circular'] as const} labels={{ linear: 'Linear', circular: 'Circular' }}
        onChange={type => { if (f.kind === 'pattern') change({ layout: type === 'linear' ? { type, direction: [1, 0, 0], spacing: 20, count: f.params.layout.count } : { type, axis: [0, 0, 1], origin: [0, 0, 0], count: Math.max(f.params.layout.count, 6), angleDegrees: 360 } }); }} />
      {f.params.layout.type === 'linear' ? <>
        <div className="field-pair"><NumberField label="Spacing" min={0.01} field={field('layout.spacing')} /><NumberField label="Copies" unit="" integer min={2} max={64} field={field('layout.count')} /></div>
        <VectorField label="Direction" unit="" field={vector('layout.direction')} />
        <p className="field-hint">The first copy is the original; each next one moves Spacing further along Direction.</p>
      </> : <>
        <div className="field-pair"><NumberField label="Copies" unit="" integer min={2} max={360} field={field('layout.count')} /><NumberField label="Over" unit="°" min={0.1} max={360} field={field('layout.angleDegrees')} /></div>
        <VectorField label="Axis" unit="" field={vector('layout.axis')} />
        <VectorField label="Axis through" field={vector('layout.origin')} />
        <p className="field-hint">360° spaces copies evenly around a full circle. Subtract the pattern from a body to cut every copy at once.</p>
      </>}
    </>}
    {f.kind === 'text' && <>
      <label className="select-field"><span className="field-label">Text</span><input className="text-input" value={f.params.text} maxLength={80} onChange={e => change({ text: e.target.value })} /></label>
      <ObjectChoice label="Into part" value={f.params.target} options={earlier} optional="None: raised letters" onChange={id => change(id ? { target: id, mode: f.kind === 'text' ? f.params.mode ?? 'engrave' : 'engrave' } : { target: undefined, mode: undefined })} />
      {f.params.target && <Segmented label="Mode" value={f.params.mode ?? 'engrave'} options={['engrave', 'emboss'] as const} labels={{ engrave: 'Engrave (cut in)', emboss: 'Emboss (raise)' }} onChange={mode => change({ mode })} />}
      <div className="field-pair"><NumberField label="Size" min={0.01} field={field('size')} /><NumberField label="Depth" min={0.01} field={field('depth')} /></div>
      <Segmented label="Face" value={f.params.plane} options={['XY', 'XZ', 'YZ'] as const} labels={{ XY: 'Top +Z', XZ: 'Front −Y', YZ: 'Right +X' }} onChange={plane => change({ plane })} />
      <VectorField label="Center on the face" field={vector('origin')} />
      <p className="field-hint">Size is the font size; capitals are about 0.7 of it. The center must lie on the chosen face of the part.</p>
    </>}
    {f.kind === 'mirror' && <><Segmented label="Mirror plane" value={f.params.plane} options={['YZ', 'XZ', 'XY'] as const} onChange={plane => change({ plane })} /><VectorField label="Plane origin" field={vector('origin')} /><label className="check-row"><input type="checkbox" checked={f.params.copy} onChange={e => change({ copy: e.target.checked })} /><span>Keep the source (linked copy)</span></label></>}
    {f.kind === 'drill_holes' && <>
      <div className="field-pair"><NumberField label="Diameter" min={0.01} field={field('diameter')} /><Segmented label="Axis" value={f.params.axis} options={['X', 'Y', 'Z'] as const} onChange={axis => change({ axis })} /></div>
      {extra?.(change)}
      <fieldset className="hole-list"><legend className="field-label">Centers<small>{f.params.centers.length} / 32</small></legend>
        {f.params.centers.map((_, i) => <div className="hole-row" key={i}>
          <span className="point-index" aria-hidden="true">{i + 1}</span>
          <div className="xyz">{['X', 'Y', 'Z'].map((axis, a) => {
            const along = f.kind === 'drill_holes' && axis === f.params.axis;
            const c = field(`centers.${i}.${a}`);
            return <label key={axis} className={`axis-input axis-${axis.toLowerCase()}${along ? ' along' : ''} ${c.binding ? 'bound' : ''}`} title={along ? 'Ignored: holes go through along this axis' : undefined}>
              <span aria-hidden="true">{axis}</span>
              <ExprInput field={c} label={`Hole ${i + 1} ${axis}`} />
            </label>;
          })}</div>
          <button type="button" className="icon-button quiet" aria-label={`Remove hole ${i + 1}`} title={`Remove hole ${i + 1}`} disabled={f.params.centers.length <= 1} onClick={() => { if (f.kind === 'drill_holes') change({ centers: f.params.centers.filter((_, j) => j !== i) }); }}><Icon name="close" size={14} /></button>
        </div>)}
        <button type="button" className="ghost-button" disabled={f.params.centers.length >= 32} onClick={() => { if (f.kind === 'drill_holes') change({ centers: [...f.params.centers, [...f.params.centers.at(-1)!]] }); }}><Icon name="plus" size={14} />Add center</button>
      </fieldset>
      <p className="field-hint">Holes go through all material. The coordinate along the drilling axis is ignored.</p>
    </>}
    <MountFields feature={f} onChange={onChange} />
    {document.parameters?.length ? <p className="field-hint">Typing a number replaces the binding. Type a parameter name or expression such as <code>{document.parameters[0].name} + 2</code> to bind.</p> : null}
  </ParameterProvider>;
}
