import { createRoot } from 'react-dom/client';
import { RemoteRuntime } from './remote-runtime';
import { Workspace } from './Workspace';
import type { CadResult } from '../shared/protocol';
import './styles.css';
import './experience.css';
import './studio-workspace.css';
import './workspace-redesign.css';
import './appearance';
import { Tooltips } from './Tooltips';

const runtime = new RemoteRuntime();
// A bounded diagnostic interface for reproducible browser integration. It accepts only the
// shared command schema; there is no source evaluation or geometry bypass.
declare global {
  interface Window {
    __cad: { execute: (command: unknown) => Promise<CadResult>; inspect: () => ReturnType<RemoteRuntime['getSnapshot']>; select: (ids: string[]) => Promise<void>; ready: Promise<void> };
  }
}
const ready = runtime.initialize();
// Poll durable sequence numbers; the model is read only when one moved. Timers never execute a geometry mutation.
setInterval(() => { void runtime.refreshStorage(); void runtime.refreshWorkspaceView(); }, 1500);
window.addEventListener('focus', () => { void runtime.refreshStorage(); });
window.__cad = { execute: command => runtime.execute(command), inspect: () => structuredClone(runtime.getSnapshot()), select: ids => runtime.select(ids), ready };
createRoot(document.getElementById('root')!).render(<><Workspace runtime={runtime} /><Tooltips /></>);
