import {Select} from './Select';
import { useEffect, useRef, useState } from 'react';
import type { RuntimeClient } from '../cad/runtime';
import { MATERIALS, materialById, NEUTRAL_COLOR, type MaterialId } from '../shared/materials';
import type { Appearance } from '../shared/protocol';
import { Icon } from './icons';

const categories = ['Metal', 'Plastic', 'Elastomer', 'Composite', 'Other'] as const;
const sessionMaterials = new WeakMap<RuntimeClient, MaterialId | null>();
export const lastMaterial = (runtime: RuntimeClient): MaterialId | null => sessionMaterials.has(runtime) ? sessionMaterials.get(runtime)! : 'aluminum';
export function rememberMaterial(runtime: RuntimeClient, material?: MaterialId) {
  sessionMaterials.set(runtime, material ?? null);
}

/** Shared compact material/color controls for drafts and the committed appearance editor. */
export function AppearanceFields({ value, disabled, onChange, noneLabel = 'None (neutral)', debounceColor = false, mixed = [] }: {
  mixed?: (keyof Appearance)[];
  value: Appearance; disabled?: boolean; onChange: (appearance: Appearance) => void; noneLabel?: string; debounceColor?: boolean;
}) {
  const [color, setColor] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(timer.current); setColor(undefined);
    return () => clearTimeout(timer.current);
  }, [value.color, value.material]);
  const changeColor = (color: string) => {
    clearTimeout(timer.current);
    if (!debounceColor) { onChange({ ...value, color }); return; }
    setColor(color);
    timer.current = setTimeout(() => { setColor(undefined); onChange({ ...value, color }); }, 450);
  };
  const shown = color ?? value.color ?? materialById(value.material)?.color ?? NEUTRAL_COLOR;
  return <div className="appearance-fields">
    <label className="select-field"><span className="field-label">Material</span><span className="select-shell">
      <Select value={mixed.includes('material') ? 'mixed' : value.material ?? ''} disabled={disabled} onChange={e => onChange({ ...value, material: (e.target.value || undefined) as Appearance['material'] })}>
        {mixed.includes('material') && <option value="mixed" disabled>Mixed materials</option>}
        <option value="">{noneLabel}</option>
        {categories.map(category => <optgroup key={category} label={category}>{MATERIALS.filter(m => m.category === category).map(m => <option key={m.id} value={m.id}>{m.name} · {m.densityGcm3} g/cm³</option>)}</optgroup>)}
      </Select><Icon name="chevron" size={14} /></span></label>
    <label className="select-field"><span className="field-label">Color <span className="muted">optional</span></span>
      <span className="color-shell"><input type="color" value={shown} disabled={disabled} aria-label="Color" onChange={e => changeColor(e.target.value)} />
        <code>{mixed.includes('color') && !color ? 'Mixed colors' : shown}</code>{value.color && <button type="button" className="icon-button quiet" aria-label="Use the material's color" title="Use the material's color" disabled={disabled} onClick={() => { const { color: _color, ...rest } = value; onChange(rest); }}><Icon name="close" size={12} /></button>}
      </span>
    </label>
  </div>;
}
