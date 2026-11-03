import {Select} from './Select';
import { useState } from 'react';
import type { Bounds, SurfaceGraphic } from '../shared/protocol';
import { surfaceGraphicSchema } from '../shared/protocol';
import { NumberField, plainField } from './FeatureFields';

const faces = { Top: [[0,0,1],[1,0,0],[0.5,0.5,1]], Front: [[0,-1,0],[1,0,0],[0.5,0,0.5]], Right: [[1,0,0],[0,1,0],[1,0.5,0.5]], Back: [[0,1,0],[-1,0,0],[0.5,1,0.5]], Left: [[-1,0,0],[0,-1,0],[0,0.5,0.5]], Bottom: [[0,0,-1],[1,0,0],[0.5,0.5,0]] } as const;
export function SurfaceGraphicsFields({ value = [], bounds, disabled, onChange }: { value?: SurfaceGraphic[]; bounds?: Bounds; disabled: boolean; onChange: (graphics: SurfaceGraphic[]) => Promise<boolean> }) {
  const [draft, setDraft] = useState<SurfaceGraphic>();
  const [error, setError] = useState('');
  const start = () => {
    let n = 1; while (value.some(graphic => graphic.id === `graphic_${n}`)) n++;
    setDraft({ id: `graphic_${n}`, anchor: [0.5,0.5,1], normal:[0,0,1], xDirection:[1,0,0],
      width: Math.max(1, (bounds?.size[0] ?? 100) * 0.6), height: Math.max(1, (bounds?.size[1] ?? 50) * 0.4),
      depth: Math.max(1, (bounds?.size[2] ?? 10) * 0.25), rotation:0, maxAngle:75,
      content: { type:'text', text:'VIBEWORKS', font:'sans', weight:'bold', spacing:0, align:'center', color:'#ffffff' } });
    setError('');
  };
  const change = (patch: Partial<SurfaceGraphic>) => setDraft(draft ? { ...draft, ...patch } : undefined);
  return <details className="method"><summary>Printed text and graphics · {value.length}</summary>
    <p className="field-hint">Printed on this result. No added mass. Tight corners distort projection; use a smaller graphic or change its direction and depth.</p>
    <fieldset disabled={disabled} className="presentation-fields">
      {value.map(graphic => <div className="button-row" key={graphic.id}><button className="link-button" type="button" onClick={() => { setDraft(structuredClone(graphic)); setError(''); }}>{graphic.id}</button><button className="link-button" type="button" onClick={() => onChange(value.filter(g => g.id !== graphic.id))}>Remove</button></div>)}
      {!draft && <button className="ghost-button" type="button" disabled={value.length >= 8} onClick={start}>Add printed graphic</button>}
      {draft && <>
        <label className="select-field"><span className="field-label">Project from</span><span className="select-shell"><Select aria-label="Project graphic from" value={Object.entries(faces).find(([, f]) => JSON.stringify(f[0]) === JSON.stringify(draft.normal) && JSON.stringify(f[1]) === JSON.stringify(draft.xDirection))?.[0] ?? ''} onChange={event => { const [normal,xDirection,anchor] = faces[event.target.value as keyof typeof faces]; change({ normal:[...normal], xDirection:[...xDirection], anchor:[...anchor] }); }}><option value="" disabled>Custom direction</option>{Object.keys(faces).map(face => <option key={face}>{face}</option>)}</Select></span></label>
        {(['width','height','depth','rotation','maxAngle'] as const).map(key => <NumberField key={key} label={{width:'Graphic width',height:'Graphic height',depth:'Projection depth',rotation:'Graphic rotation',maxAngle:'Maximum surface angle'}[key]} unit={key === 'rotation' || key === 'maxAngle' ? '°' : 'mm'} field={plainField(draft[key], number => change({ [key]:number }))} />)}
        {draft.anchor.map((a,i) => <NumberField key={i} label={`Anchor ${'XYZ'[i]}`} min={0} max={100} unit="%" field={plainField(a*100, number => change({ anchor:draft.anchor.map((v,j) => i===j ? number/100 : v) as SurfaceGraphic['anchor'] }))} />)}
        {(['normal', 'xDirection'] as const).map(key => <details key={key}><summary>{key === 'normal' ? 'Projection normal' : 'Text baseline direction'}</summary>{draft[key].map((v,i) => <NumberField key={i} label={`${key} ${'XYZ'[i]}`} unit="" field={plainField(v, number => change({ [key]:draft[key].map((v,j) => i===j ? number : v) }))} />)}</details>)}
        {draft.content.type === 'text' && <>
          <label className="select-field"><span className="field-label">Printed text</span><input aria-label="Printed text" className="text-input" maxLength={80} value={draft.content.text} onChange={event => { if(draft.content.type==='text') change({content:{...draft.content,text:event.target.value}}); }} /></label>
          {(['font','weight','align'] as const).map(key => <label key={key} className="select-field"><span className="field-label">{key}</span><span className="select-shell"><Select aria-label={`Text ${key}`} value={draft.content.type === 'text' ? draft.content[key] : ''} onChange={event => { if(draft.content.type==='text') change({content:{...draft.content,[key]:event.target.value}}); }}>{({font:['sans','serif','mono'],weight:['regular','bold'],align:['left','center','right']}[key]).map(option => <option key={option}>{option}</option>)}</Select></span></label>)}
          <NumberField label="Letter spacing" unit="em" min={-0.05} max={0.5} field={plainField(draft.content.spacing, spacing => { if(draft.content.type==='text') change({content:{...draft.content,spacing}}); })} />
          <label className="select-field"><span className="field-label">Ink</span><input type="color" aria-label="Ink color" value={draft.content.color} onChange={event => { if(draft.content.type==='text') change({content:{...draft.content,color:event.target.value}}); }} /></label>
        </>}
        <label className="select-field"><span className="field-label">PNG or static SVG · up to 48 KB, 2048 px</span><input aria-label="Graphic image" type="file" accept="image/png,image/svg+xml" onChange={async event => {
          const file = event.target.files?.[0]; if(!file)return;
          if(file.size>48000){setError('Use an image smaller than 48 KB.');return;}
          if(!['image/png','image/svg+xml'].includes(file.type)){setError('Choose a PNG or SVG.');return;}
          const dataUrl = await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);});
          change({content:{type:'image',dataUrl}});setError('');
        }} /></label>
        {draft.content.type === 'image' && <img className="graphic-preview" src={'dataUrl'in draft.content?draft.content.dataUrl:''} alt="Graphic to apply" />}
        <div className="button-row"><button className="primary-button" type="button" onClick={async () => {
          const checked = surfaceGraphicSchema.safeParse(draft);
          if (!checked.success) { setError(checked.error.issues[0]?.message ?? 'Check graphic settings.'); return; }
          try {
            if (await onChange([...value.filter(g=>g.id!==draft.id),checked.data])) { setDraft(undefined); setError(''); }
          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        }}>Apply graphic</button><button className="link-button" type="button" onClick={()=>setDraft(undefined)}>Cancel</button></div>
      </>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </details>;
}
