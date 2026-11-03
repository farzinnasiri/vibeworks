import assert from "node:assert/strict";
import test from "node:test";
import { BrowserBridge, type ConnectionState } from "../src/web/bridge";
import type { RuntimeClient, RuntimeState } from "../src/cad/runtime";

test("browser connection observes the remote client and never becomes a geometry controller", () => {
  let listener = () => {};
  let retries = 0;
  let stopped = false;
  let state = {
    phase: "ready",
    persistence: "Node authority · local SQLite",
  } as RuntimeState;
  const runtime = {
    subscribe: (fn: () => void) => {
      listener = fn;
      return () => {
        stopped = true;
      };
    },
    getSnapshot: () => state,
    retryInitialization: async () => {
      retries++;
    },
  } as RuntimeClient;
  const states: ConnectionState[] = [];
  const bridge = new BrowserBridge(runtime, (s) => states.push(s));
  bridge.start();
  assert.equal(states.at(-1)?.phase, "connected");
  state = {
    ...state,
    persistence: "Node authority unavailable",
    error: "WORKER_TIMEOUT",
  };
  listener();
  assert.equal(states.at(-1)?.phase, "offline");
  bridge.reconnect();
  assert.equal(retries, 1);
  bridge.stop();
  assert.equal(stopped, true);
});

test('remote client disables edits after a failed read, recovers by polling and never repeats an uncertain mutation', { timeout: 5000 }, async (t) => {
  // Vite supplies this constant in the product. Keep the same validated fetch boundary in this unit test.
  (globalThis as any).__VIBEWORKS_FINGERPRINT__ = 'remote-test';
  const { RemoteRuntime } = await import('../src/web/remote-runtime');
  const { emptyDocument } = await import('../src/cad/document');
  const { modelHealth } = await import('../src/cad/health');
  const document = emptyDocument();
  const evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
  const preferences = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (previousStorage) Object.defineProperty(globalThis, 'sessionStorage', previousStorage); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => { preferences.set(key, value); }, removeItem: (key: string) => { preferences.delete(key); }, clear: () => preferences.clear(), key: (index: number) => [...preferences.keys()][index] ?? null, get length() { return preferences.size; } } satisfies Storage });
  let offline = false, loseMutation = false;
  const commands: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    if (offline) throw new Error('Controlled authority disconnection');
    if (url === '/api/connection') return Response.json({ token: 'unit-only', fingerprint: 'remote-test', bridgeId: '00000000-0000-4000-8000-000000000001', wsUrl: 'ws://127.0.0.1' });
    const { requestId, command } = JSON.parse(options!.body as string);
    commands.push(command.type);
    if (loseMutation && command.type === 'document_action') throw new Error('Reply lost after dispatch');
    return Response.json({ result: { operation: command.type, requestId, status: 'success', documentId: document.documentId, revision: 0, storageVersion: 1, created: [], updated: [], warnings: [], document, geometry: [], visibleFeatureIds: [], health: modelHealth(document, evaluation, null), history: { canUndo: true, canRedo: false } }, evaluation }, { headers: { 'x-vibeworks-fingerprint': 'remote-test' } });
  });
  const runtime = new RemoteRuntime();
  await runtime.initialize();
  assert.equal(runtime.getSnapshot().phase, 'ready');
  const display = runtime.getSnapshot().document;
  offline = true;
  await runtime.refreshStorage();
  assert.equal(runtime.getSnapshot().phase, 'error');
  assert.equal(runtime.getSnapshot().document, display);
  const before = commands.length;
  const command = { type: 'document_action', params: { documentId: document.documentId, expectedRevision: 0, action: 'undo' } } as const;
  assert.equal((await runtime.execute(command)).error?.code, 'RUNTIME_NOT_READY');
  assert.equal((await runtime.preview({ type: 'apply_edits', params: { documentId: document.documentId, expectedRevision: 0, edits: [{ op: 'set_parameter', name: 'width', value: 20 }] } })).result.error?.code, 'RUNTIME_NOT_READY');
  assert.equal(commands.length, before);
  offline = false;
  await runtime.refreshStorage();
  assert.equal(runtime.getSnapshot().phase, 'ready');
  assert.equal(runtime.getSnapshot().document, display);
  loseMutation = true;
  const uncertain = await runtime.execute(command);
  assert.equal(uncertain.error?.outcomeUnknown, true);
  assert.equal(runtime.getSnapshot().phase, 'error');
  await runtime.refreshStorage();
  await runtime.refreshStorage();
  assert.equal(runtime.getSnapshot().phase, 'ready');
  assert.equal(commands.filter(c => c === 'document_action').length, 1);
  assert.equal(runtime.getSnapshot().lastResult?.error?.outcomeUnknown, true);
});
