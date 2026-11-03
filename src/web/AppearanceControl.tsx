import { useId } from 'react';
import { useAppearance, setAppearance } from './appearance';
import { Icon } from './icons';

const choices = [
  { mode: 'system', icon: 'monitor', label: 'System appearance' },
  { mode: 'light', icon: 'sun', label: 'Light appearance' },
  { mode: 'dark', icon: 'moon', label: 'Dark appearance' },
] as const;

export function AppearanceControl() {
  const { mode, thumbMode } = useAppearance();
  const name = useId();
  return <div className="appearance-control" role="radiogroup" aria-label="Appearance">
    <span className="appearance-thumb" aria-hidden="true" style={{ transform: `translateX(${choices.findIndex(choice => choice.mode === thumbMode) * 100}%)` }} />
    {choices.map(choice => <label key={choice.mode} className={`appearance-choice ${mode === choice.mode ? 'selected' : ''}`} title={choice.label}>
      <input className="sr-only" type="radio" name={name} aria-label={choice.label} checked={mode === choice.mode} onChange={event => setAppearance(choice.mode, event.currentTarget.parentElement ?? undefined)} />
      <Icon name={choice.icon} size={14} />
    </label>)}
  </div>;
}
