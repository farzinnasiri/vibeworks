import { useSyncExternalStore } from 'react';
import type { RuntimeState } from '../cad/runtime';
import { activity, operationLabels } from './activity';

/** Current work and retained failures share one keyboard-accessible disclosure. */
export function TaskStatus({ state }: { state: RuntimeState }) {
  const entries = useSyncExternalStore(activity.subscribe, activity.entries);
  const running = entries.find(entry => entry.status === 'running');
  const waiting = state.busy || state.displayStatus === 'loading' || state.phase === 'initializing' || !!running;
  const failed = state.phase === 'error' || state.displayStatus === 'failed';
  const label = state.phase === 'error' ? 'Connection unavailable' : state.phase !== 'ready' ? 'Connecting' :
    state.displayStatus === 'loading' ? 'Loading model' : state.busy ? state.activity.replaceAll('_', ' ') :
    running ? `${running.actor === 'agent' ? 'Agent · ' : ''}${operationLabels[running.operation] ?? running.operation.replaceAll('_', ' ')}` :
    state.displayStatus === 'failed' ? 'Display unavailable' : 'Ready';
  return <details className="task-status">
    <summary aria-label="Task status and activity"><span className={`readiness-light ${failed ? 'error' : waiting ? 'busy' : ''}`} aria-hidden="true" />{label}{entries.some(entry => entry.status === 'error') ? ' · !' : ''}</summary>
    <div className="task-inbox">
      <div className="inbox-heading"><strong>Workspace activity</strong><span>r{state.document.revision}</span></div>
      {state.error && <p role="alert">{state.error}</p>}
      <ol>{entries.slice(0, 20).map(entry => <li key={entry.key}>
        <strong>{operationLabels[entry.operation] ?? entry.operation.replaceAll('_', ' ')}</strong> · {entry.status}
        {entry.documentId && <small>{entry.documentId} {entry.revision === undefined ? '' : `· r${entry.revision}`}</small>}
        {entry.message && <p>{entry.message}</p>}
      </li>)}</ol>
      {!entries.length && <div className="inbox-empty"><strong>All caught up</strong><span>Operations and errors appear here.</span></div>}
      <details><summary>Connection details</summary><p>{state.persistence}</p></details>
    </div>
  </details>;
}
