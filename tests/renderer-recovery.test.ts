import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessRenderer } from '../src/bridge/renderer';
import { emptyDocument } from '../src/cad/document';
import { unknownHealth } from '../src/shared/protocol';
import { NodeGeometryWorker } from '../src/cad/node-worker';

const evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
const command = { type: 'render_views' as const, params: {} };

test('renderer replaces a closed browser before the next output and survives a stopped bundler service', async () => {
  const renderer = new HeadlessRenderer();
  const worker = new NodeGeometryWorker();
  try {
    const document = { ...emptyDocument(), features: [{ id: 'body', kind: 'box' as const,
      params: { origin: [0, 0, 0] as [number, number, number], size: [20, 30, 5] as [number, number, number] },
      appearance: { material: 'aluminum' as const } }] };
    const model = await worker.evaluate(document);
    const output = { type: 'render_views' as const, params: { views: ['isometric' as const], tileSize: 128, appearance: 'materials' as const } };
    const render = async () => {
      const image = await renderer.render(model, output, document, unknownHealth(), 20000);
      assert.ok(image.base64.length > 1000);
      assert.equal(Buffer.from(image.base64, 'base64').subarray(1, 4).toString(), 'PNG');
    };
    await render();
    const first = await (renderer as any).initialize();
    assert.equal(first.isClosed(), false);
    await (renderer as any).browser.close();
    const { stop } = await import('esbuild');
    stop();
    const second = await (renderer as any).initialize();
    assert.notEqual(second, first);
    assert.equal(second.isClosed(), false);
    assert.equal(renderer.status.phase, 'ready');
    await render();
    // Force a fresh build too: the parent's stopped singleton cannot affect it.
    (renderer as any).bundle = undefined;
    await (renderer as any).browser.close();
    assert.equal((await (renderer as any).initialize()).isClosed(), false);
    await render();
  } finally { await renderer.close(); await worker.close(); }
});

test('exhausted output budget reports queue stage without initializing Chromium', async () => {
  const renderer = new HeadlessRenderer();
  try {
    await assert.rejects(renderer.render(evaluation, command, emptyDocument(), unknownHealth(), 0),
      (error: any) => error.code === 'RENDER_TIMEOUT' && /before initialization.*supplied budget 0/.test(error.message));
    assert.equal(renderer.status.phase, 'idle');
  } finally { await renderer.close(); }
});
