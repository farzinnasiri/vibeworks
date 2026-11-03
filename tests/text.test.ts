import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine, loadTextFont } from '../src/cad/geometry';
import { emptyDocument } from '../src/cad/document';
import type { CadDocument, Feature } from '../src/shared/protocol';

test('text makes raised letters, engraves into a face and embosses out of it, exactly', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const font = await readFile(new URL('../src/cad/fonts/IBMPlexSans-Bold.ttf', import.meta.url));
  await loadTextFont(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
  const engine = new GeometryEngine(oc);
  const plate: Feature = { id: 'plate', kind: 'box', params: { origin: [0, 0, 0], size: [80, 30, 5] } };
  const evaluate = (text: Feature) => {
    const doc: CadDocument = { ...emptyDocument(), features: [plate, text] };
    const result = engine.evaluate(doc);
    return result.geometry.find(g => g.featureId === text.id)!;
  };
  try {
    const raised = evaluate({ id: 'letters', kind: 'text', params: { text: 'VW', plane: 'XY', origin: [40, 15, 5], size: 10, depth: 1 } });
    assert.equal(raised.valid, true); assert.ok(raised.volumeMm3 > 10);
    assert.ok(Math.abs(raised.bounds.min[2] - 5) < 1e-6 && Math.abs(raised.bounds.max[2] - 6) < 1e-6, 'raised letters stand on origin');
    const engraved = evaluate({ id: 'engraved', kind: 'text', params: { text: 'VW', plane: 'XY', origin: [40, 15, 5], size: 10, depth: 1, target: 'plate', mode: 'engrave' } });
    assert.equal(engraved.solidCount, 1);
    // Engraving removes exactly the letters' volume, one depth deep, and keeps the plate's outer size.
    assert.ok(Math.abs((80 * 30 * 5 - engraved.volumeMm3) - raised.volumeMm3) < 1e-3, `${80 * 30 * 5 - engraved.volumeMm3} vs ${raised.volumeMm3}`);
    assert.ok(Math.abs(engraved.bounds.size[2] - 5) < 1e-6);
    const embossed = evaluate({ id: 'embossed', kind: 'text', params: { text: 'VW', plane: 'XY', origin: [40, 15, 5], size: 10, depth: 1, target: 'plate', mode: 'emboss' } });
    assert.ok(Math.abs((embossed.volumeMm3 - 80 * 30 * 5) - raised.volumeMm3) < 1e-3);
    assert.ok(Math.abs(embossed.bounds.size[2] - 6) < 1e-6);
    assert.throws(() => evaluate({ id: 'miss', kind: 'text', params: { text: 'VW', plane: 'XY', origin: [40, 15, 50], size: 10, depth: 1, target: 'plate', mode: 'engrave' } }), /does not touch 'plate'/);
  } finally { engine.dispose(); }
});
