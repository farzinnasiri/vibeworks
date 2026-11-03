import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument } from '../src/cad/document';
import { applyEdits } from '../src/cad/edits';
import { analysisWarnings } from '../src/cad/runtime';
import { modelHealth, publicAnalysis, healthHints, floatingDescription } from '../src/cad/health';
import { createModelScene, addInterferenceVolumes, disposeScene, WORKBENCH } from '../src/web/scene';
import * as THREE from 'three';
import { parseCommand } from '../src/shared/protocol';
import type { CadDocument, Feature } from '../src/shared/protocol';

const box = (id: string, origin: [number, number, number], size: [number, number, number]): Feature => ({ id, kind: 'box', params: { origin, size } });

test('analysis finds contacts, interferences, floating parts and verifies declared checks exactly', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  try {
    // A chassis, an upright touching it, an arm overlapping it, and a wishbone hanging 7 mm away in the air.
    const chassis = box('chassis', [0, 0, 0], [100, 40, 10]);
    const upright = box('upright', [100, 0, 0], [5, 40, 30]);          // face contact with chassis at x = 100
    const arm = box('arm', [80, 10, 2], [20, 5, 5]);                   // overlaps chassis by 20 × 5 × 5 = 500 mm³, touches upright
    const wishboneRaw = box('wishbone_raw', [112, 10, 20], [30, 4, 4]); // 7 mm right of the upright: floating
    const wishbone: Feature = { id: 'wishbone', kind: 'fillet', params: { target: 'wishbone_raw', radius: 0.5, edges: 'vertical' } };
    let doc: CadDocument = { ...emptyDocument(), features: [chassis, upright, arm, wishboneRaw, wishbone] };
    doc = applyEdits(doc, [
      { op: 'set_analysis', ground: 'chassis' },
      // Declared against the hidden raw feature: checked through its visible result 'wishbone'.
      { op: 'set_check', check: { id: 'wishbone_mounted', a: 'wishbone_raw', b: 'upright', expect: 'contact' } },
      { op: 'set_check', check: { id: 'arm_clear', a: 'arm', b: 'chassis', expect: 'no_interference' } },
      { op: 'set_check', check: { id: 'gap_ok', a: 'wishbone', b: 'chassis', expect: 'clearance', minGapMm: 5 } },
    ]).document;
    const evaluation = engine.evaluate(doc);
    const report = engine.analyze(doc, evaluation.geometry);
    assert.equal(report.parts, 4); assert.equal(report.ground, 'chassis');
    assert.deepEqual(report.contacts.map(c => [c.a, c.b].sort().join('+')).sort(), ['arm+upright', 'chassis+upright'].sort());
    assert.equal(report.interferences.length, 1);
    assert.ok(Math.abs(report.interferences[0].overlapMm3 - 500) < 1e-3, String(report.interferences[0].overlapMm3));
    assert.deepEqual(report.floating.map(f => f.featureId), ['wishbone']);
    assert.equal(report.floating[0].nearest, 'upright'); assert.ok(Math.abs(report.floating[0].gapMm! - 7) < 1e-3);
    const byId = Object.fromEntries(report.checks.map(c => [c.id, c]));
    assert.equal(byId.wishbone_mounted.ok, false); assert.ok(Math.abs(byId.wishbone_mounted.gapMm! - 7) < 1e-3);
    assert.equal(byId.arm_clear.ok, false);
    assert.equal(byId.gap_ok.ok, true);
    const warnings = analysisWarnings(report).join('\n');
    assert.match(warnings, /1 part is not connected through contact.*wishbone 7 mm from 'upright'/);
    assert.match(warnings, /(arm ∩ chassis|chassis ∩ arm) 500 mm³/);
    assert.match(warnings, /Check 'wishbone_mounted' failed/);
    // featureIds narrows the analysis to those parts.
    assert.equal(engine.analyze(doc, evaluation.geometry, ['chassis', 'upright']).parts, 2);
    // Deleting a checked feature removes its checks rather than leaving dangling references.
    const trimmed = applyEdits(doc, [{ op: 'delete', featureIds: ['arm'], cascade: false }]).document;
    assert.deepEqual(trimmed.analysis!.checks!.map(c => c.id), ['wishbone_mounted', 'gap_ok']);
  } finally { engine.dispose(); }
});


test('piercing, face contact and a floating rod stay distinct; intent never changes physical contact', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  try {
    const rod = (id: string, x: number, z: number): Feature => ({ id, kind: 'cylinder', params: { origin: [x, 20, z], radius: 1, height: 10 }, appearance: { material: 'steel' } });
    let doc: CadDocument = { ...emptyDocument(), revision: 7, features: [
      { ...box('plate', [0, 0, 0], [100, 100, 2]), appearance: { color: '#888888' } },
      rod('piercing', 20, -5), rod('touching', 40, 2), rod('loose', 60, 5),
    ], analysis: { ground: 'plate', checks: [{ id: 'attachment', a: 'piercing', b: 'plate', expect: 'contact' }] } };
    const evaluation = engine.evaluate(doc);
    let report = engine.analyze(doc, evaluation.geometry);
    assert.equal(report.skipped, undefined);
    assert.deepEqual(report.contacts.map(c => c.b), ['touching']);
    assert.deepEqual(report.floating.map(f => f.featureId), ['piercing', 'loose']);
    assert.equal(report.checks[0].ok, false, 'passing through a plate is not attachment');
    assert.ok(Math.abs(report.interferences[0].overlapMm3 - 2 * Math.PI) < 0.001);
    assert.equal(report.floating.find(f => f.featureId === 'loose')!.gapMm, 3);
    const warning = analysisWarnings(report).join(' ');
    assert.match(warning, /piercing passes through 'plate' \(overlap, not contact\)/);
    assert.doesNotMatch(warning, /piercing.*0 mm from/);
    assert.match(warning, /union it.*make it touch without overlap.*declare an overlap check/);
    assert.match(warning, /loose 3 mm from 'plate'/);
    const hints = healthHints(modelHealth(doc, { ...evaluation, analysis: report }, null), report).join(' ');
    assert.match(hints, /piercing passes through 'plate'/);
    assert.match(hints, /1 unintended overlap/);
    assert.equal(floatingDescription(report.floating[0], report, id => id === 'plate' ? 'Base plate' : id), "passes through 'Base plate' (overlap, not contact)");
    const meshes = report.interferenceMeshes!;
    assert.equal(meshes.length, 1);
    assert.ok(meshes[0].triangles.length > 0);
    const zs = meshes[0].vertices.filter((_, i) => i % 3 === 2);
    assert.ok(Math.min(...zs) >= -1e-6 && Math.max(...zs) <= 2 + 1e-6, 'mesh is the common solid inside the plate');
    const scene = createModelScene({ ...evaluation, analysis: report });
    addInterferenceVolumes(scene, { ...evaluation, analysis: report });
    const overlays = scene.children.filter(o => o.userData.interference) as THREE.Mesh[];
    assert.equal(overlays.length, 1);
    assert.equal((overlays[0].material as THREE.MeshBasicMaterial).color.getHex(), WORKBENCH.flaggedEdge);
    assert.equal((overlays[0].material as THREE.MeshBasicMaterial).depthTest, false);
    assert.deepEqual(Array.from(overlays[0].geometry.index!.array), meshes[0].triangles);
    disposeScene(scene);
    assert.equal('interferenceMeshes' in publicAnalysis(report), false, 'triangles are browser-only');
    assert.equal(modelHealth(doc, { ...evaluation, analysis: report }, null).ok, false);
    doc = applyEdits(doc, [
      { op: 'delete_check', id: 'attachment' },
      { op: 'set_check', check: { id: 'press_fit', a: 'piercing', b: 'plate', expect: 'overlap', note: ' Intentional press fit ' } },
      { op: 'set_check', check: { id: 'exploded', a: 'loose', b: 'plate', expect: 'clearance', minGapMm: 3, note: 'Exploded assembly view' } },
    ]).document;
    assert.equal(doc.analysis!.checks![0].note, 'Intentional press fit');
    report = engine.analyze(doc, evaluation.geometry);
    assert.equal(report.interferences[0].intendedBy, 'press_fit');
    assert.deepEqual(report.floating.map(f => f.intendedBy), [['press_fit'], ['exploded']]);
    assert.equal(report.contacts.length, 1, 'intent is not a physical contact');
    assert.deepEqual(analysisWarnings(report), []);
    assert.equal(modelHealth(doc, { ...evaluation, analysis: report }, null).ok, true);
    const intendedScene = createModelScene(evaluation);
    addInterferenceVolumes(intendedScene, { ...evaluation, analysis: report });
    assert.equal(intendedScene.children.filter(o => o.userData.interference).length, 0);
    disposeScene(intendedScene);
    const partial = engine.analyze(doc, evaluation.geometry, undefined, -1);
    assert.ok(partial.skipped);
    assert.equal(modelHealth(doc, { ...evaluation, analysis: partial }, 6).ok, false);
    assert.equal(modelHealth(doc, { ...evaluation, analysis: partial }, 6).checkedRevision, 6);
    assert.equal(engine.analyze(doc, evaluation.geometry, ['plate', 'touching']).scope, 'subset');
    // An isolated gap declaration does not excuse a whole disconnected group.
    doc.analysis!.checks = [{ id: 'isolated', a: 'loose', b: 'piercing', expect: 'clearance', note: 'Gap inside a disconnected assembly' }];
    report = engine.analyze(doc, evaluation.geometry);
    assert.ok(report.floating.every(f => !f.intendedBy));
    // A union removes the seam and the separate interference altogether.
    doc = applyEdits(doc, [{ op: 'add', feature: { id: 'fused', kind: 'union', params: { target: 'plate', tools: ['piercing'] } } }]).document;
    const fused = engine.evaluate(doc);
    assert.equal(engine.analyze(doc, fused.geometry).interferences.length, 0);
  } finally { engine.dispose(); }
});

test('intent and output bypasses use strict shared validation', () => {
  const ctx = { documentId: emptyDocument().documentId, expectedRevision: 0 };
  const check = { id: 'fit', a: 'a', b: 'b', expect: 'overlap' };
  for (const note of [undefined, '', '   ']) assert.throws(() => parseCommand({ type: 'apply_edits', params: { ...ctx, edits: [{ op: 'set_check', check: { ...check, note } }] } }));
  assert.doesNotThrow(() => parseCommand({ type: 'apply_edits', params: { ...ctx, edits: [{ op: 'set_check', check: { ...check, note: 'Press fit' } }] } }));
  assert.doesNotThrow(() => parseCommand({ type: 'render_views', params: { appearance: 'issues', skipAnalysis: true } }));
  assert.throws(() => parseCommand({ type: 'export_model', params: { format: 'step', skipAnalysis: 'yes' } }));
});

test('a failed exact common operation is incomplete, never silently a contact or clean health', async t => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  try {
    const doc = { ...emptyDocument(), features: [box('a', [0, 0, 0], [10, 10, 10]), box('b', [5, 0, 0], [10, 10, 10])] };
    const evaluation = engine.evaluate(doc);
    // The solids/distances are real OCCT; inject the Boolean failure at its exact boundary.
    const boundary = engine as unknown as { boolean: (...args: unknown[]) => unknown };
    const injected = t.mock.method(boundary, 'boolean', () => { throw new Error('Injected OCCT common failure'); });
    const report = engine.analyze(doc, evaluation.geometry);
    assert.match(report.skipped!, /Exact common operation failed/);
    assert.deepEqual(report.contacts, []);
    assert.equal(modelHealth(doc, { ...evaluation, analysis: report }, null).analysis, 'incomplete');
    assert.equal(modelHealth(doc, { ...evaluation, analysis: report }, null).ok, false);
    assert.match(analysisWarnings(report).join(' '), /Analysis incomplete/);
    assert.doesNotThrow(() => JSON.stringify(publicAnalysis(report)));
    assert.equal(evaluation.stats!.analysis!.pairEntries, 0, 'failed pair is not cached as clean');
    injected.mock.restore();
    const recovered = engine.analyze(doc, evaluation.geometry);
    assert.equal(recovered.skipped, undefined); assert.equal(recovered.interferences.length, 1);
    assert.equal(evaluation.stats!.analysis!.pairMisses, 1, 'retries the failed pair');
    assert.equal(engine.analyze(doc, evaluation.geometry).interferences.length, 1);
    assert.equal(evaluation.stats!.analysis!.pairMisses, 0);
  } finally { engine.dispose(); }
});
