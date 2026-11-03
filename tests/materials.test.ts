import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { importSTEP, setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { effectiveAppearance, emptyDocument } from '../src/cad/document';
import { applyEdits } from '../src/cad/edits';
import { NEUTRAL_COLOR } from '../src/shared/materials';
import type { CadDocument, Feature } from '../src/shared/protocol';

test('materials give exact mass, results inherit appearance, and STEP keeps named colored parts', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  try {
    const block: Feature = { id: 'block', label: 'Block', kind: 'box', params: { origin: [0, 0, 0], size: [100, 50, 10] }, appearance: { material: 'aluminum' } };
    const rounded: Feature = { id: 'rounded', label: 'Bracket', kind: 'fillet', params: { target: 'block', radius: 2, edges: 'vertical' } };
    const pin: Feature = { id: 'pin', label: 'Pin', kind: 'cylinder', params: { origin: [200, 0, 0], radius: 5, height: 20 }, appearance: { material: 'steel', color: '#ff0000', finish: 'gloss' } };
    const gasket: Feature = { id: 'gasket', label: 'Rubber gasket', kind: 'cylinder', params: { origin: [300, 0, 0], radius: 6, height: 2 }, appearance: { material: 'rubber' } };
    const doc: CadDocument = { ...emptyDocument(), features: [block, rounded, pin, gasket] };
    assert.equal(effectiveAppearance(doc, 'rounded')?.material, 'aluminum', 'a fillet inherits its target material');
    const evaluation = engine.evaluate(doc);
    const bracket = evaluation.geometry.find(g => g.featureId === 'rounded')!;
    assert.equal(bracket.material, 'aluminum');
    assert.ok(Math.abs(bracket.massG! - bracket.volumeMm3 * 2.7 / 1000) <= 5e-4, "rounded to the milligram");
    const pinInfo = evaluation.geometry.find(g => g.featureId === 'pin')!;
    assert.ok(Math.abs(pinInfo.massG! - Math.PI * 25 * 20 * 7.85 / 1000) <= 5e-4);
    const rubberInfo = evaluation.geometry.find(g => g.featureId === 'gasket')!;
    assert.equal(rubberInfo.material, 'rubber');
    assert.ok(Math.abs(rubberInfo.massG! - Math.PI * 36 * 2 * 1.35 / 1000) <= 5e-4);
    // Unknown materials are rejected by the schema before anything evaluates.
    assert.throws(() => applyEdits(doc, [{ op: 'update', feature: { ...pin, appearance: { material: 'unobtainium' } } as unknown as Feature }]));
    const step = await engine.export('step', ['rounded', 'pin', 'gasket'], doc);
    const text = new TextDecoder().decode(step.bytes);
    assert.match(text, /Bracket/); assert.match(text, /Pin/); assert.match(text, /Rubber gasket/);
    assert.match(text, /COLOUR_RGB/);
    const imported = await importSTEP(new Blob([step.bytes]));
    try { assert.ok(Math.abs(engine.measure('roundtrip', imported.asShape3D()).volumeMm3 - (bracket.volumeMm3 + pinInfo.volumeMm3 + rubberInfo.volumeMm3)) < 1e-3); }
    finally { imported.delete(); }
  } finally { engine.dispose(); }
});


test('unstyled parts and nested assembly instances export the neutral display grey in STEP', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const source: CadDocument = { ...emptyDocument(), features: [{ id: 'neutral', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] } }] };
  const instance = (document: CadDocument): Feature => ({ id: 'copy', kind: 'instance', params: { document: document.documentId, translation: [20, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0] } });
  const assembly: CadDocument = { ...emptyDocument(), kind: 'assembly', features: [instance(source)] };
  const nested: CadDocument = { ...emptyDocument(), kind: 'assembly', features: [instance(assembly)] };
  try {
    for (const document of [source, assembly, nested]) {
      engine.evaluate(document, [source, assembly].filter(d => d !== document));
      const step = await engine.export('step', [document.features[0].id], document);
      const text = new TextDecoder().decode(step.bytes);
      assert.doesNotMatch(text, /DRAUGHTING_PRE_DEFINED_COLOUR\('red'\)/);
      const colors = [...text.matchAll(/COLOUR_RGB\(\s*'[^']*'\s*,\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/g)].map(match => match.slice(1).map(Number));
      assert.ok(colors.length, 'STEP must explicitly specify a color');
      const expected = NEUTRAL_COLOR.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255);
      for (const color of colors) color.forEach((channel, i) => assert.ok(Math.abs(channel - expected[i]) < 2 / 255, `${channel} != ${expected[i]} (colours pass through 8-bit hex, so allow rounding)`));
    }
  } finally { engine.dispose(); }
});
