import type { ComponentReplay, ComponentReplayState } from './component-replay';
import { Icon } from './icons';

export function ComponentReplayControls({ controller, state, speed, onSpeed, onInteract, disabled }: {
  controller: ComponentReplay; state: ComponentReplayState; speed: number; onSpeed: () => void; onInteract: () => void; disabled: boolean;
}) {
  const { replay, loading, active, playing, error } = state;
  const current = replay?.steps[(replay?.step ?? 1) - 1];
  const path = current?.path.map(p => `${p.name} / ${p.label}`).join(' › ');
  const exit = () => { onInteract(); controller.exit(); };
  return <div className="component-replay">
    <div className="timeline" style={{ ['--at' as string]: replay && replay.steps.length > 1 ? (replay.step - 1) / (replay.steps.length - 1) : 0 }}>
      <button type="button" className="icon-button quiet" aria-label={playing ? 'Pause component replay' : error ? 'Retry component replay' : 'Play component build'} disabled={disabled} onClick={() => { onInteract(); controller.toggle(); }}>
        <Icon name={playing ? 'pause' : 'play'} size={15} />
      </button>
      <input type="range" min={1} max={replay?.steps.length ?? 1} value={replay?.step ?? 1} disabled={disabled || !replay}
        aria-label="Component build history" aria-valuetext={replay ? `Step ${replay.step} of ${replay.steps.length}: ${path}` : 'Start replay to load component steps'}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); exit(); } }}
        onChange={e => { onInteract(); controller.pause(); controller.seek(Number(e.target.value)); }} />
      <span className="timeline-count">{replay?.step ?? '–'}<small>/{replay?.steps.length ?? '–'}</small></span>
      <button type="button" className="speed-button" aria-label={`Replay speed ${speed}×`} onClick={onSpeed}>{speed}×</button>
      {active && <button type="button" className="icon-button quiet" aria-label="Back to latest" onClick={exit}><Icon name="latest" size={15} /></button>}
    </div>
    <p className="replay-path" title={path} role="status">{loading ? 'Loading build step…' : error ? 'Replay paused' : path ?? 'Play each component in assembly order'}</p>
    {error && <p className="field-error" role="alert">{error} Retry or return to latest.</p>}
    <p className="field-hint">Current construction · each instance builds in place</p>
  </div>;
}
