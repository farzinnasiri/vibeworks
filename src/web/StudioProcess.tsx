import type { RefObject } from 'react';
import { ProgressMeter } from './ProgressMeter';

export interface StudioProcessState {
  kind: 'image' | 'video' | 'preview';
  phase: 'idle' | 'preparing' | 'compiling' | 'rendering' | 'finishing' | 'encoding' | 'error';
  title: string;
  detail: string;
  value?: number;
  elapsedMs?: number;
  etaMs?: number;
  thumbnail?: boolean;
  cancel?: () => void;
}

/** Transient job feedback leaves the camera and output layout untouched. */
export function StudioProcess({ state, thumbnail }: { state: StudioProcessState; thumbnail: RefObject<HTMLCanvasElement | null> }) {
  const busy = state.phase !== 'idle' && state.phase !== 'error';
  if (!busy && state.phase !== 'error') return <span className="sr-only" role="status">{state.title}</span>;
  return <section className={`studio-process ${busy ? 'working' : ''} ${state.phase === 'error' ? 'failed' : ''}`} aria-label="Studio process" aria-busy={busy}>
    <div className="studio-process-head">
      <div className="studio-process-frame" aria-hidden="true">
        <canvas ref={thumbnail} width={96} height={60} hidden={!busy || !state.thumbnail} />
        <span className="studio-process-scan" />
      </div>
      <div className="studio-process-copy"><strong role="status" aria-live="polite">{state.title}</strong>
        <span title={state.detail} role={state.phase === 'error' ? 'alert' : undefined}>{state.detail}</span></div>
      {state.cancel && <button type="button" className="ghost-button small" aria-label={state.kind === 'video' ? 'Cancel video' : 'Cancel image'} onClick={state.cancel}>Cancel</button>}
    </div>
    {busy ? <ProgressMeter key={state.kind} compact label={state.kind === 'video' ? 'Video rendering' : state.kind === 'image' ? 'Image rendering' : 'Preparing Studio'}
      value={state.value} elapsedMs={state.elapsedMs} etaMs={state.etaMs} /> : <div className="studio-process-rest" aria-hidden="true"><span /></div>}
  </section>;
}
