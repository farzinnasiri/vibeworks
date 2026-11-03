import type { RuntimeState } from '../cad/runtime';
import type { ConnectionState } from './bridge';
import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { toolSpec, type Tool } from './modeling';
import { LoadingField } from './LoadingField';
import { usePreparationTime } from './preparation-time';

interface WorkspaceStatusProps {
  state: RuntimeState;
  tool: Tool | null;
  disabled: boolean;
  chooseTool: (tool: Tool | null) => void;
  demo: () => Promise<void>;
  openFile: () => void;
  connection: ConnectionState;
  projectName?: string;
}

export function WorkspaceStatus({
  state,
  tool,
  disabled,
  chooseTool,
  demo,
  openFile,
  connection,
  projectName,
}: WorkspaceStatusProps) {
  const [copied, setCopied] = useState(false);
  const doc = state.document;
  const loading = state.phase === 'initializing' || state.displayStatus === 'loading';
  const [retainedLoading, setRetainedLoading] = useState(loading);
  useEffect(() => {
    if (loading) { setRetainedLoading(true); return; }
    const timer = window.setTimeout(() => setRetainedLoading(false), 160);
    return () => clearTimeout(timer);
  }, [loading]);
  const preparation = usePreparationTime(doc.documentId, state.displayStatus === 'loading', state.phase === 'ready' && !state.displayStatus && !state.error);
  const empty = !doc.features.length;
  const assembly = doc.kind === 'assembly' || doc.features.some((f) => f.kind === 'instance');
  const prompt = `Use the Vibeworks CAD MCP tools. Build ${assembly ? 'this assembly' : 'this part'} in document ${doc.documentId} (expectedRevision ${doc.revision}): <describe it>. Inspect before editing and report validity.`;
  return (
    <>
      {state.evaluation.referenceError && (
        <div className="assembly-warning notice error" role="alert">
          <Icon name="warning" size={16} />
          <span>
            Assembly needs repair. {state.evaluation.referenceError} Geometry is from its last successful
            evaluation. Select the instance in Build to repair it.
          </span>
        </div>
      )}
      {empty && state.phase === 'ready' && !state.displayStatus && !tool && (
        <div className="empty">
          <p className="field-hint">{projectName ? `${projectName} · ` : ''}{assembly ? 'Assembly' : 'Part'} · millimeters · Z up</p>
          <h1>{doc.name && !/^Untitled/.test(doc.name) ? doc.name : assembly ? 'An empty assembly' : 'An empty part'}</h1>
          <p className="empty-lede">{assembly ? 'Insert parts from this project, then place them with mounts or Move.' : 'Ask your agent to build it, or start from a shape.'}</p>
          <div className="empty-agent-card">
            <div className="empty-agent-head">
              <span className={`link-dot ${connection.phase === 'connected' ? 'ok' : 'off'}`} />
              <b>{connection.phase === 'connected' ? 'Your agent can work here now' : 'Agent link offline'}</b>
            </div>
            <code className="empty-prompt">{prompt}</code>
            <button type="button" className="ghost-button small" onClick={() => { void navigator.clipboard?.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
              <Icon name="copy" size={13} />{copied ? 'Copied' : 'Copy prompt'}
            </button>
          </div>
          {assembly ? <button type="button" className="primary-button" disabled={disabled} onClick={() => chooseTool('instance')}><Icon name="layers" size={16} />Insert part</button>
            : <div className="starts">
              {(
                [
                  ['extrude', 'Plate', '80 × 50 × 5 extrusion'],
                  ['box', 'Block', 'Sized by corner'],
                  ['revolve', 'Shaft', 'Turned profile'],
                  ['cylinder', 'Round bar', 'Ø10 × 20'],
                ] as const
              ).map(([t, label, hint]) => (
                <button key={t} type="button" className="start" disabled={disabled} onClick={() => chooseTool(t)}>
                  <Icon name={toolSpec(t).icon} size={26} />
                  <b>{label}</b>
                  <small>{hint}</small>
                </button>
              ))}
            </div>}
          <div className="empty-links">
            {!assembly && <button type="button" className="link-button" disabled={disabled} onClick={() => void demo()}>Build the demo plate</button>}
            <button type="button" className="link-button" disabled={disabled} onClick={openFile}>Open a JSON document</button>
          </div>
        </div>
      )}
      {(loading || retainedLoading) && (
        <div className={`loading ${loading ? '' : 'is-leaving'}`} role="status" aria-hidden={!loading}>
          <LoadingField label={connection.phase === 'offline' ? 'Reconnecting' : 'Preparing model'} name={doc.name} startedAt={preparation?.startedAt} expectedMs={preparation?.expectedMs} />
        </div>
      )}
    </>
  );
}

