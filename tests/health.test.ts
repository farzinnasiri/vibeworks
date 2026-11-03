import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDocument } from '../src/cad/document';
import { modelHealth, healthHints, publicAnalysis } from '../src/cad/health';
import { receipt, deliver } from '../src/bridge/deliver';
import { resultSchema } from '../src/bridge/validation';
import { MAX_FEATURES, commandError, type CadResult, type AnalysisReport } from '../src/shared/protocol';
import type { Evaluation } from '../src/cad/types';

const report = (revision: number): AnalysisReport => ({ revision, scope: 'document', parts: 1, toleranceMm: 0.01, contacts: [], interferences: [], floating: [], checks: [], durationMs: 1 });

test('health counts effective appearance and cannot certify stale, subset or partial evidence', () => {
  const document = { ...emptyDocument(), revision: 2, features: [
    { id: 'base', kind: 'box' as const, params: { origin: [0, 0, 0] as [number, number, number], size: [5, 5, 5] as [number, number, number] }, appearance: { color: '#888888' } },
    { id: 'round', kind: 'fillet' as const, params: { target: 'base', radius: 1, edges: 'vertical' as const } },
  ] };
  const evaluation: Evaluation = { geometry: [], meshes: [], visibleFeatureIds: ['round'], analysis: report(2) };
  assert.equal(modelHealth(document, evaluation, null).ok, true, 'appearance inherits along target');
  for (const analysis of [undefined, report(1), { ...report(2), scope: 'subset' as const }, { ...report(2), skipped: 'time budget' }]) {
    const health = modelHealth(document, { ...evaluation, analysis }, 1);
    assert.equal(health.ok, false);
    assert.equal(health.checkedRevision, 1);
    assert.equal(health.uncheckedChanges, 1);
  }
  const missing = structuredClone(document); delete (missing.features[0] as { appearance?: unknown }).appearance;
  assert.equal(modelHealth(missing, evaluation, null).partsWithoutAppearance, 1);
  assert.deepEqual(modelHealth(missing, evaluation, null).issues.partsWithoutAppearance, ['round']);
  assert.ok(healthHints(modelHealth(missing, evaluation, null))[0].includes('round'));
  assert.equal(commandError('inspect_model', 'OFFLINE', 'Disconnected').health?.analysis, 'unavailable');
});

test('receipts bound samples while inspect/analyze keep full health and strict result validation', async () => {
  const document = { ...emptyDocument(), revision: 4 };
  const full = report(4);
  full.floating = Array.from({ length: MAX_FEATURES }, (_, i) => ({ featureId: `part_${i}` }));
  full.checks = Array.from({ length: MAX_FEATURES }, (_, i) => ({ id: `check_${i}`, expect: 'contact' as const, a: 'a', b: 'b', ok: false, message: 'Not touching.' }));
  const health = modelHealth(document, { geometry: [], meshes: [], visibleFeatureIds: [], analysis: full }, null);
  const result: CadResult = { operation: 'apply_edits', status: 'success', documentId: document.documentId, revision: 4, document, created: [], updated: [], warnings: [], analysis: full, health, nextSteps: healthHints(health, full) };
  assert.equal(resultSchema.safeParse(result).success, true);
  const command = { type: 'apply_edits' as const, params: { documentId: document.documentId, expectedRevision: 3, edits: [{ op: 'set_analysis' as const, auto: true }] } };
  const compact = receipt(command, result) as { health: typeof health; analysis: Record<string, unknown> };
  assert.equal(compact.health.floating, MAX_FEATURES);
  assert.equal(compact.health.issues.floating.length, 4);
  assert.equal(compact.health.issues.failedChecks.length, 4);
  assert.equal(compact.analysis.floating, undefined, 'receipt does not duplicate full issue lists');
  for (const type of ['inspect_model', 'analyze_model'] as const) {
    const delivered = await deliver({ type, params: {} }, { ...result, operation: type });
    assert.equal((delivered.result.health as typeof health).issues.floating.length, MAX_FEATURES);
  }
  const tooMany = structuredClone(result); tooMany.health!.issues.floating = Array.from({length:2001},(_,i)=>`leaf_${i}`);
  assert.equal(resultSchema.safeParse(tooMany).success, false);
  const invalid = structuredClone(result); invalid.health!.floating = Infinity;
  assert.equal(resultSchema.safeParse(invalid).success, false);
  const pairs = Array.from({ length: MAX_FEATURES * (MAX_FEATURES - 1) / 2 }, () => ({ a: 'a', b: 'b', overlapMm3: 1, intendedBy: 'fit' }));
  const dense = { ...result, analysis: { ...full, interferences: pairs } };
  assert.equal(resultSchema.safeParse(dense).success, true, 'all feature pairs fit the boundary');
  dense.analysis.interferences.push({ a: 'a', b: 'b', overlapMm3: 1, intendedBy: 'fit' });
  assert.equal(resultSchema.safeParse(dense).success, false);
  assert.equal('interferenceMeshes' in publicAnalysis({ ...full, interferenceMeshes: [] }), false);
});

test('workflow hints are factual, deterministic, bounded and never prescribe browser operation', () => {
  const untargeted = { ...emptyDocument(), features: Array.from({ length: 3 }, (_, i) => ({ id: `block_${i}`, kind: 'box' as const, params: { origin: [0, 0, 0] as [number, number, number], size: [7, 7, i + 20] as [number, number, number] }, appearance: { material: 'steel' as const } })) };
  const evaluation: Evaluation = { geometry: [], meshes: [], visibleFeatureIds: untargeted.features.map(f => f.id), analysis: report(0) };
  let health = modelHealth(untargeted, evaluation, null);
  // Green health without any design target asks for targets, once, ahead of style hints.
  assert.match(healthHints(health, evaluation.analysis, untargeted)[0], /no design targets are declared/);
  const document = { ...untargeted, analysis: { checks: [{ id: 'length', expect: 'size' as const, axis: 'X' as const, mm: 7, toleranceMm: 0.1 }] } };
  assert.deepEqual(healthHints(health, evaluation.analysis, document), ['No parameters; 7 mm repeats in 3 features (block_0, block_1, block_2). If it is a shared design dimension, use set_parameter and bindings.']);
  assert.deepEqual(healthHints(health, evaluation.analysis, { ...document, parameters: [{ name: 'width', value: 7 }] }), []);
  assert.deepEqual(healthHints(health, evaluation.analysis, { ...document, features: document.features.slice(0, 2) }), []);
  const coordinatesOnly = { ...document, features: document.features.map((f, i) => ({ ...f, params: { origin: [7, 7, 7] as [number, number, number], size: [10 + i, 20 + i, 30 + i] as [number, number, number] } })) };
  assert.deepEqual(healthHints(health, evaluation.analysis, coordinatesOnly), []);
  health = { ...health, autoAnalysis: false };
  assert.match(healthHints(health, evaluation.analysis, document)[0], /off.*gaps and collisions.*auto:true/);
  health = { ...health, analysis: 'unchecked', interferences: 1, floating: 2, failedChecks: 1, partsWithoutAppearance: 3, issues: { ...health.issues, interferences: [{ a: 'block_0', b: 'block_1' }], failedChecks: ['mount'], partsWithoutAppearance: ['block_0'] } };
  const hints = healthHints(health, evaluation.analysis, document);
  assert.equal(hints.length, 5); assert.deepEqual(hints, healthHints(health, evaluation.analysis, document));
  assert.match(hints.join(' '), /union if these form one physical part/);
  assert.match(hints.join(' '), /Assign appearance/);
  assert.doesNotMatch(hints.join(' '), /browser|reconnect/i);
});
