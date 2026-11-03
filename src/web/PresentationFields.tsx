import {Select} from './Select';
import { useState } from 'react';
import type { CadDocument, Presentation } from '../shared/protocol';
import type { RuntimeClient } from '../cad/runtime';
import { context } from '../cad/demo';
import { NumberField, plainField } from './FeatureFields';
import { track } from './activity';
import { studioSettings } from '../shared/studio';

export function PresentationFields({ document, runtime, disabled }: { document: CadDocument; runtime: RuntimeClient; disabled: boolean }) {
  const [draft, setDraft] = useState<Presentation>();
  const [base, setBase] = useState<CadDocument>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const settings = draft ?? document.presentation ?? {};
  const resolved = studioSettings(settings);
  const change = (patch: Partial<Presentation>) => { setBase(base ?? document); setDraft({ ...settings, ...patch }); };
  const save = async (value: Presentation | null) => {
    setSaving(true); setError('');
    try {
      const result = await track('apply_edits', () => runtime.execute({ type: 'apply_edits', params: { ...context(base ?? document), edits: [{ op: 'set_presentation', presentation: value }] } }));
      if (result.status === 'error') setError(result.error!.message);
      else { setDraft(undefined); setBase(undefined); }
    } finally { setSaving(false); }
  };
  return <details className="method"><summary>Presentation</summary>
    <p className="field-hint">Saved lighting for Studio view and material renders. Camera views remain personal.</p>
    <fieldset disabled={disabled || saving} className="presentation-fields">
      <label className="select-field"><span className="field-label">Lighting</span><span className="select-shell"><Select aria-label="Lighting" value={settings.preset ?? 'studio'} onChange={event => change({ preset: event.target.value as Presentation['preset'], environment: undefined, keyIntensity: undefined })}>
        <option value="studio">Studio</option><option value="soft">Soft</option><option value="dramatic">Dramatic</option>
      </Select></span></label>
      <NumberField label="Exposure" unit="×" min={0.25} max={3} field={plainField(settings.exposure ?? 1, exposure => change({ exposure }))} />
      <NumberField label="Reflections" unit="×" min={0} max={3} field={plainField(resolved.environment, environment => change({ environment }))} />
      <NumberField label="Key light" unit="×" min={0} max={8} field={plainField(settings.keyIntensity ?? (settings.preset === 'soft' ? 1.2 : settings.preset === 'dramatic' ? 3.5 : 2.2), keyIntensity => change({ keyIntensity }))} />
      <NumberField label="Light direction" unit="°" min={-180} max={180} field={plainField(settings.lightRotation ?? 0, lightRotation => change({ lightRotation }))} />
      <label className="select-field"><span className="field-label">Backdrop</span><input aria-label="Backdrop" type="color" value={settings.background ?? '#eef1f2'} onChange={event => change({ background: event.target.value })} /></label>
      <label><input type="checkbox" checked={settings.shadows !== false} onChange={event => change({ shadows: event.target.checked })} /> Cast shadows</label>
      <div className="button-row"><button type="button" className="primary-button" disabled={!draft} onClick={() => void save(settings)}>{saving ? 'Saving…' : 'Save presentation'}</button>
        <button type="button" className="link-button" onClick={() => void save(null)}>Reset</button></div>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </details>;
}
