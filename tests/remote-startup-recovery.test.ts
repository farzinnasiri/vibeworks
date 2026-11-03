import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { emptyDocument } from '../src/cad/document';
import { modelHealth } from '../src/cad/health';
import { ENGINE_VERSION, LEGACY_PROJECT_ID, type CadCommand, type CadDocument } from '../src/shared/protocol';

async function fixture(t: TestContext, options: { timeout?: boolean; offline?: boolean; stale?: boolean; remembered?: boolean; deferred?: boolean; largeAssembly?: boolean; prepared?: boolean; changedPreparation?: boolean } = {}) {
  (globalThis as any).__VIBEWORKS_FINGERPRINT__ = 'startup-test';
  const { RemoteRuntime } = await import('../src/web/remote-runtime');
  const saved: CadDocument = { ...emptyDocument(), kind: 'assembly', projectId: LEGACY_PROJECT_ID, name: 'Saved car', features: [{ id: 'body', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] }, appearance: { material: 'aluminum' } }] };
  const healthy: CadDocument = { ...emptyDocument(), kind: 'part', projectId: LEGACY_PROJECT_ID, name: 'Small part' };
  const other: CadDocument = { ...emptyDocument(), kind: 'part', projectId: LEGACY_PROJECT_ID, name: 'Other source' };
  if (options.largeAssembly) {
    for (const source of [healthy, other]) source.features = Array.from({ length: 126 }, (_, i) => ({ id: `body_${i}`, kind: 'box', params: { origin: [i * 2, 0, 0], size: [1, 1, 1] } }));
    saved.features = [healthy, healthy, other].map((source, i) => ({ id: `component_${i}`, kind: 'instance', params: { document: source.documentId, translation: [0, i * 5, 0], origin: [0, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 0 } }));
  }
  const evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
  const projects = [{ projectId: saved.projectId!, name: 'Saved project', version: 1 }];
  const documents = [saved, healthy, ...(options.largeAssembly ? [other] : [])].map(d => ({ documentId: d.documentId, name: d.name!, kind: d.kind!, projectId: d.projectId!, revision: d.revision, storageVersion: 1, features: d.features.length, updatedAt: new Date(0).toISOString(), active: false }));
  const snapshotId = crypto.randomUUID();
  const preferences = new Map<string, string>();
  if (options.remembered) preferences.set('vibeworks.view.activeDocumentId', saved.documentId);
  if (options.stale) preferences.set('vibeworks.view.activeDocumentId', crypto.randomUUID());
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (previousStorage) Object.defineProperty(globalThis, 'sessionStorage', previousStorage); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => { preferences.set(key, value); } } });
  let offline = options.offline ?? false;
  let token = 'unit-only';
  let bridgeId = '00000000-0000-4000-8000-000000000001';
  let data = 1;
  let started!: () => void, release!: () => void;
  const displayStarted = new Promise<void>(resolve => { started = resolve; });
  const displayGate = new Promise<void>(resolve => { release = resolve; });
  const commands: CadCommand[] = [];
  const unknownReads: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new Error('Controlled initial disconnection');
    if (url === '/api/connection') return Response.json({ token, fingerprint: 'startup-test', bridgeId, wsUrl: 'ws://127.0.0.1' });
    if (url === '/api/probe') return Response.json({ changes: data, work: 0 });
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer ' + token)
      return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Bridge restarted.' } }, { status: 401 });
    const { requestId, command, passive } = JSON.parse(init!.body as string) as { requestId: string; command: CadCommand; passive?: boolean };
    commands.push(command);
    const headers = { 'x-vibeworks-fingerprint': 'startup-test' };
    const error = (code: string, message: string) => Response.json({ result: { operation: command.type, requestId, status: 'error', created: [], updated: [], warnings: [], error: { code, message } } }, { headers });
    if (passive && !['inspect_model', 'select_features', 'agent_session', 'activity', 'describe'].includes(command.type))
      return error('INVALID_PASSIVE_READ', 'Only personal browser observation may omit an activity record.');
    const id = 'documentId' in command.params ? command.params.documentId : undefined;
    const document = id === healthy.documentId ? healthy : saved;
    if (command.type === 'inspect_model' && id && !documents.some(d => d.documentId === id)) {
      unknownReads.push(id);
      return error('DOCUMENT_NOT_FOUND', `Document '${id}' is not in this workspace. Call documents with action list.`);
    }
    if (command.type === 'inspect_model' && !command.params.definitionsOnly && document === saved) {
      started();
      if (options.deferred) await displayGate;
      if (options.timeout) return error('WORKER_TIMEOUT', 'Geometry exceeded 55000 ms. Its worker was terminated. Committed data is preserved.');
    }
    const definitionsOnly = command.type === 'inspect_model' && command.params.definitionsOnly;
    const frozen = options.largeAssembly && command.type === 'inspect_model' && command.params.snapshot ? {
      snapshot: { snapshotId, documentId: saved.documentId, storageVersion: 1, revision: saved.revision, sources: [healthy, other].map(source => ({ documentId: source.documentId, storageVersion: 1, revision: source.revision })), engineVersion: ENGINE_VERSION, cursor: 1, createdAt: new Date(0).toISOString() },
      inspection: { current: !(options.changedPreparation && command.params.display), ...(options.prepared ? { displayCache: 'prepared' } : {}) },
    } : {};
    return Response.json({ result: { operation: command.type, requestId, status: 'success', documentId: document.documentId, revision: document.revision, storageVersion: 1, document, documents, projects, geometry: [], visibleFeatureIds: [], created: [], updated: [], warnings: [], health: modelHealth(document, evaluation, null), ...frozen }, ...(!definitionsOnly ? { evaluation } : {}) }, { headers });
  });
  return { runtime: new RemoteRuntime(), reload: () => new RemoteRuntime(), preferences, saved, healthy, projects, commands, unknownReads, displayStarted, releaseDisplay: release, changeData: () => { data++; }, setOnline: () => { offline = false; }, setOffline: () => { offline = true; }, restartBridge: () => { token = 'unit-restarted'; bridgeId = crypto.randomUUID(); } };
}

test('large assembly loading prepares unique source prefixes in one frozen graph before adopting the complete display', async t => {
  const f = await fixture(t, { largeAssembly: true });
  await f.runtime.initialize();
  const result = await f.runtime.openDocument(f.saved.documentId);
  assert.equal(result.status, 'success');
  const prepared = f.commands.filter(command => command.type === 'inspect_model' && command.params.display);
  assert.deepEqual(prepared.map(command => command.type === 'inspect_model' ? command.params.display?.step : undefined), [1, 3]);
  assert.equal(new Set(prepared.map(command => command.type === 'inspect_model' ? command.params.snapshot?.id : undefined)).size, 1);
  assert.equal(f.runtime.getSnapshot().displayStatus, undefined);
  assert.equal(f.runtime.getSnapshot().document.documentId, f.saved.documentId);
  assert.ok(!f.commands.some(command => command.type === 'apply_edits' || command.type === 'document_action'));
});

test('large assembly loading skips source preparation when the complete current display is already cached', async t => {
  const f = await fixture(t, { largeAssembly: true, prepared: true });
  await f.runtime.initialize();
  assert.equal((await f.runtime.openDocument(f.saved.documentId)).status, 'success');
  assert.ok(!f.commands.some(command => command.type === 'inspect_model' && command.params.display));
});

test('a graph changed during source preparation cannot become a successfully loaded display', async t => {
  const f = await fixture(t, { largeAssembly: true, changedPreparation: true });
  await f.runtime.initialize();
  const result = await f.runtime.openDocument(f.saved.documentId);
  assert.equal(result.error?.code, 'PREPARATION_CHANGED');
  assert.equal(f.runtime.getSnapshot().displayStatus, 'failed');
  assert.equal(f.runtime.getSnapshot().health.ok, false);
  assert.ok(!f.commands.some(command => command.type === 'inspect_model' && command.params.documentId === f.saved.documentId && !command.params.definitionsOnly && !command.params.display));
});

test('new navigation abandons a pending preparation without requesting further source prefixes', async t => {
  const f = await fixture(t, { largeAssembly: true, deferred: true });
  await f.runtime.initialize();
  const loading = f.runtime.openDocument(f.saved.documentId);
  await f.displayStarted;
  await f.runtime.openDocument(f.healthy.documentId);
  f.releaseDisplay();
  await loading;
  assert.equal(f.runtime.getSnapshot().document.documentId, f.healthy.documentId);
  assert.equal(f.commands.filter(command => command.type === 'inspect_model' && command.params.display).length, 1);
});

test('a failed source preparation returns its failure once and leaves saved navigation usable', async t => {
  const f = await fixture(t, { largeAssembly: true, timeout: true });
  await f.runtime.initialize();
  const result = await f.runtime.openDocument(f.saved.documentId);
  assert.equal(result.error?.code, 'WORKER_TIMEOUT');
  assert.equal(f.runtime.getSnapshot().lastResult?.error?.code, 'WORKER_TIMEOUT');
  assert.equal(f.runtime.getSnapshot().phase, 'ready');
  assert.equal(f.runtime.getSnapshot().displayStatus, 'failed');
  assert.equal(f.commands.filter(command => command.type === 'inspect_model' && command.params.display).length, 1);
});

test('a chosen model timeout keeps projects navigable and polling never requests the placeholder document', async t => {
  const f = await fixture(t, { timeout: true });
  const placeholder = f.runtime.getSnapshot().document.documentId;
  await f.runtime.initialize();
  await f.runtime.openDocument(f.saved.documentId);
  const modelLoads = () => f.commands.filter(c => c.type === 'inspect_model' && !c.params.definitionsOnly && c.params.documentId === f.saved.documentId).length;
  assert.equal(modelLoads(), 1);
  for (let i = 0; i < 3; i++) await f.runtime.refreshStorage(true);
  assert.equal(modelLoads(), 1, 'Polling and window focus must not repeatedly rebuild an unchanged model that timed out');
  const state = f.runtime.getSnapshot();
  assert.equal(state.document.documentId, f.saved.documentId, `Must retain the authoritative saved document instead of placeholder ${placeholder}; error: ${state.error}`);
  assert.deepEqual(state.projects, f.projects);
  assert.equal(state.documents.length, 2);
  assert.equal(state.phase, 'ready', 'A model failure must not disable project navigation');
  assert.equal(state.displayStatus, 'failed');
  assert.match(state.error ?? '', /Geometry exceeded/);
  assert.equal(state.health.ok, false);
  assert.deepEqual(f.unknownReads, [], 'Background polling must never send the browser placeholder ID');
  f.changeData();
  await f.runtime.refreshStorage(true);
  assert.equal(modelLoads(), 2, 'A saved data change permits one fresh model attempt');
  await f.runtime.refreshStorage(true);
  assert.equal(modelLoads(), 2, 'A repeated failure pauses geometry reads again');
  await f.runtime.openDocument(f.saved.documentId);
  assert.equal(modelLoads(), 3, 'Explicit retry must still attempt the model');
  assert.equal((await f.runtime.openDocument(f.healthy.documentId)).status, 'success');
  assert.equal(f.runtime.getSnapshot().document.documentId, f.healthy.documentId);
});

test('startup lists projects without preparing even a remembered model or loading geometry during polling', async t => {
  const f = await fixture(t, { deferred: true, remembered: true });
  const initialization = f.runtime.initialize();
  try {
    await Promise.race([initialization, f.displayStarted]);
    assert.equal(f.commands.some(c => c.type === 'inspect_model' && !c.params.definitionsOnly), false,
      'Startup must wait for the user to choose a project before requesting geometry');
    assert.deepEqual(f.runtime.getSnapshot().projects, f.projects);
    assert.equal(f.runtime.getSnapshot().workspaceHome, true);
    for (let i = 0; i < 3; i++) await f.runtime.refreshStorage(true);
    assert.equal(f.commands.some(c => c.type === 'inspect_model' && !c.params.definitionsOnly), false);
    assert.equal(f.runtime.getSnapshot().documents.some(d => d.active), false);
  } finally {
    f.releaseDisplay();
    await initialization;
  }
});

test('saved project navigation is ready during the first display request and a late failure cannot replace a newly opened document', async t => {
  const f = await fixture(t, { timeout: true, deferred: true });
  await f.runtime.initialize();
  const initialization = f.runtime.openDocument(f.saved.documentId);
  await f.displayStarted;
  try {
    assert.equal(f.runtime.getSnapshot().phase, 'ready', 'Workspace discovery must unlock navigation before geometry completes');
    assert.equal(f.runtime.getSnapshot().displayStatus, 'loading');
    await f.runtime.refreshStorage(true);
    assert.equal(f.commands.filter(c => c.type === 'inspect_model' && !c.params.definitionsOnly).length, 1, 'Polling must not queue another load while the first is pending');
    assert.equal((await f.runtime.openDocument(f.healthy.documentId)).status, 'success');
    assert.equal(f.runtime.getSnapshot().document.documentId, f.healthy.documentId);
  } finally {
    f.releaseDisplay();
    await initialization;
  }
  assert.equal(f.runtime.getSnapshot().document.documentId, f.healthy.documentId);
  assert.equal(f.runtime.getSnapshot().displayStatus, undefined);
  assert.equal(f.runtime.getSnapshot().error, undefined, 'The previous model failure must not overwrite the new view');
});

test('a missing remembered document does not prevent project discovery or create a replacement', async t => {
  const f = await fixture(t, { stale: true });
  await f.runtime.initialize();
  assert.equal(f.runtime.getSnapshot().workspaceHome, true);
  assert.deepEqual(f.runtime.getSnapshot().projects, f.projects);
  assert.equal(f.unknownReads.length, 0, 'Startup must not try the stale remembered ID');
  assert.equal(f.commands.some(c => c.type === 'documents' && ['create', 'duplicate'].includes(c.params.action)), false);
});

test('reconnection before any document loaded repeats discovery instead of reading a placeholder ID', async t => {
  const f = await fixture(t, { offline: true });
  await f.runtime.initialize();
  assert.equal(f.runtime.getSnapshot().phase, 'error');
  f.setOnline();
  await f.runtime.refreshStorage();
  assert.equal(f.runtime.getSnapshot().phase, 'ready');
  assert.equal(f.runtime.getSnapshot().workspaceHome, true);
  assert.deepEqual(f.unknownReads, []);
});

test('navigation returns target display failure instead of a successful definitions receipt', async t => {
  const f = await fixture(t, { timeout: true });
  await f.runtime.initialize();
  await f.runtime.openDocument(f.healthy.documentId);
  const result = await f.runtime.openDocument(f.saved.documentId);
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'WORKER_TIMEOUT');
  assert.equal(f.runtime.getSnapshot().document.documentId, f.saved.documentId);
  assert.equal(f.runtime.getSnapshot().displayStatus, 'failed');
});

test('selection is local and a newer navigation supersedes a pending display', async t => {
  const f = await fixture(t, { deferred: true, timeout: true });
  await f.runtime.initialize();
  const init = f.runtime.openDocument(f.saved.documentId);
  await f.displayStarted;
  const count = f.commands.length;
  await f.runtime.select(['body']);
  assert.deepEqual(f.runtime.getSnapshot().document.selectedFeatureIds, ['body']);
  assert.equal(f.commands.length, count, 'Selection must not submit a geometry command');
  const obsolete = f.runtime.openDocument(f.saved.documentId);
  await new Promise(resolve => setTimeout(resolve, 10));
  await f.runtime.openDocument(f.healthy.documentId);
  f.releaseDisplay();
  await Promise.all([init, obsolete]);
  assert.equal(f.runtime.getSnapshot().document.documentId, f.healthy.documentId);
  assert.equal(f.runtime.getSnapshot().error, undefined);
});

test('returning to projects cancels a pending display and catalog updates never reopen it', async t => {
  const f = await fixture(t, { deferred: true, timeout: true });
  await f.runtime.initialize();
  const pending = f.runtime.openDocument(f.saved.documentId);
  await f.displayStarted;
  f.runtime.showProjects();
  f.changeData();
  await f.runtime.refreshStorage(true);
  f.releaseDisplay();
  await pending;
  assert.equal(f.runtime.getSnapshot().workspaceHome, true);
  assert.equal(f.runtime.getSnapshot().displayStatus, undefined);
  assert.equal(f.runtime.getSnapshot().error, undefined);
  assert.equal(f.commands.filter(c => c.type === 'inspect_model' && !c.params.definitionsOnly).length, 1);
});

test('reconnecting to the same bridge restores the open document', async t => {
  const f = await fixture(t);
  await f.runtime.initialize();
  await f.runtime.openDocument(f.healthy.documentId);
  assert.equal(f.runtime.getSnapshot().workspaceHome, false);
  const modelReads = () => f.commands.filter(c => c.type === 'inspect_model' && !c.params.definitionsOnly).length;
  const before = modelReads();
  await f.runtime.retryInitialization();
  await f.runtime.refreshStorage(true);
  assert.equal(f.runtime.getSnapshot().workspaceHome, false);
  assert.equal(modelReads(), before + 2);
});

test('a restarted bridge returns an open browser to the picker without rebuilding its model', async t => {
  const f = await fixture(t);
  await f.runtime.initialize();
  await f.runtime.openDocument(f.healthy.documentId);
  const modelReads = () => f.commands.filter(c => c.type === 'inspect_model' && !c.params.definitionsOnly).length;
  const before = modelReads();
  f.restartBridge();
  await f.runtime.refreshStorage(true);
  await f.runtime.refreshStorage(true);
  assert.equal(f.runtime.getSnapshot().phase, 'ready');
  assert.equal(f.runtime.getSnapshot().workspaceHome, true);
  assert.equal(modelReads(), before);
});


test('temporary transport failures retain the open model and recover without leaving Studio', async t => {
  const f = await fixture(t);
  await f.runtime.initialize();
  await f.runtime.openDocument(f.healthy.documentId);
  const before = f.runtime.getSnapshot();
  f.setOffline();
  await f.runtime.refreshStorage(true);
  assert.equal(f.runtime.getSnapshot().phase, 'error');
  assert.equal(f.runtime.getSnapshot().workspaceHome, false);
  assert.equal(f.runtime.getSnapshot().evaluation, before.evaluation, 'the committed display remains available offline');
  await f.runtime.refreshStorage(true);
  assert.equal(f.runtime.getSnapshot().workspaceHome, false, 'repeated failures do not unmount the editor');
  f.setOnline();
  await f.runtime.refreshStorage(true);
  assert.equal(f.runtime.getSnapshot().phase, 'ready');
  assert.equal(f.runtime.getSnapshot().workspaceHome, false);
  assert.equal(f.runtime.getSnapshot().document.documentId, f.healthy.documentId);
});

test('unchanged workspace cursors do not resend full display geometry on idle polls', async t => {
  const f = await fixture(t);
  await f.runtime.initialize();
  await f.runtime.openDocument(f.healthy.documentId);
  await f.runtime.refreshStorage();
  const reads = () => f.commands.filter(c => c.type === 'inspect_model' && !c.params.definitionsOnly).length;
  const before = reads();
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  for(let i=0;i<5;i++){clock+=60_000;await f.runtime.refreshStorage();}
  assert.equal(reads(),before,'an unchanged cursor remains authoritative across minutes of idling');
  f.changeData();await f.runtime.refreshStorage();
  assert.equal(reads(),before+1,'a document change still delivers fresh geometry');
  await f.runtime.refreshStorage();assert.equal(reads(),before+1);
});

test('ordinary reload restores only the document opened during this bridge lifetime', async t => {
  const f = await fixture(t);
  await f.runtime.initialize();
  await f.runtime.openDocument(f.saved.documentId);
  const reloaded = f.reload();
  await reloaded.initialize();
  assert.equal(reloaded.getSnapshot().workspaceHome, false);
  assert.equal(reloaded.getSnapshot().document.documentId, f.saved.documentId);
  assert.equal(reloaded.getSnapshot().document.projectId, f.saved.projectId);
  assert.equal(reloaded.getSnapshot().displayStatus, undefined);
  f.restartBridge();
  const restarted = f.reload();
  const count = f.commands.length;
  await restarted.initialize();
  assert.equal(restarted.getSnapshot().workspaceHome, true);
  assert.ok(!f.commands.slice(count).some(c => c.type === 'inspect_model' && !c.params.definitionsOnly));
});

test('explicit All projects persists over reload even after an earlier document was opened', async t => {
  const f = await fixture(t);
  await f.runtime.initialize();
  await f.runtime.openDocument(f.saved.documentId);
  f.runtime.showProjects();
  const count = f.commands.length;
  const reloaded = f.reload();
  await reloaded.initialize();
  assert.equal(reloaded.getSnapshot().workspaceHome, true);
  assert.ok(!f.commands.slice(count).some(c => c.type === 'inspect_model' && !c.params.definitionsOnly));
});

test('a deleted remembered document recovers to Projects without asking for unknown geometry', async t => {
  const f = await fixture(t);
  f.preferences.set('vibeworks.view.navigation', JSON.stringify({ bridgeId: '00000000-0000-4000-8000-000000000001', documentId: crypto.randomUUID() }));
  await f.runtime.initialize();
  assert.equal(f.runtime.getSnapshot().workspaceHome, true);
  assert.deepEqual(f.unknownReads, []);
  assert.equal(JSON.parse(f.preferences.get('vibeworks.view.navigation')!).documentId, undefined);
});

test('returning to Projects during reload cancels the restored display and persists the destination', async t => {
  const f = await fixture(t, { deferred: true });
  f.preferences.set('vibeworks.view.navigation', JSON.stringify({ bridgeId: '00000000-0000-4000-8000-000000000001', documentId: f.saved.documentId }));
  const pending = f.runtime.initialize();
  await f.displayStarted;
  f.runtime.showProjects();
  f.releaseDisplay();
  await pending;
  assert.equal(f.runtime.getSnapshot().workspaceHome, true);
  const reloaded = f.reload();
  await reloaded.initialize();
  assert.equal(reloaded.getSnapshot().workspaceHome, true);
});

test('a restart during a transient disconnect discards the old view even without an authentication rejection', async t => {
  const f = await fixture(t);
  await f.runtime.initialize();
  await f.runtime.openDocument(f.healthy.documentId);
  f.setOffline();
  await f.runtime.refreshStorage(true);
  f.restartBridge();
  f.setOnline();
  await f.runtime.refreshStorage(true);
  assert.equal(f.runtime.getSnapshot().workspaceHome, true);
  assert.equal(f.runtime.getSnapshot().phase, 'ready');
});
