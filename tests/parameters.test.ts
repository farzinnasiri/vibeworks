import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression, expressionNames, parameterUsage, pruneBindings, resolveBindings, valueAt, withField } from '../src/cad/parameters';
import { applyEdits } from '../src/cad/edits';
import { demoFeatures, demoParameters } from '../src/cad/demo';
import { emptyDocument } from '../src/cad/document';
import { parseCommand, type CadDocument, type Feature } from '../src/shared/protocol';

const values = new Map([['thickness', 5], ['width', 100], ['hole_inset', 10]]);

test('expressions are arithmetic over parameters, never code', () => {
  assert.equal(evaluateExpression('thickness', values), 5);
  assert.equal(evaluateExpression('width - 2 * hole_inset', values), 80);
  assert.equal(evaluateExpression('-(thickness + 1) / 2', values), -3);
  assert.equal(evaluateExpression(' 1.5e1 + .5 ', values), 15.5);
  assert.deepEqual(expressionNames('width - hole_inset * width'), ['width', 'hole_inset']);
  assert.throws(() => evaluateExpression('nope + 1', values), /Unknown parameter 'nope'/);
  assert.throws(() => evaluateExpression('thickness / 0', values), /finite/);
  assert.throws(() => evaluateExpression('(1 + 2', values), /Missing \)/);
  assert.throws(() => evaluateExpression('1 2', values), /Unexpected/);
  assert.throws(() => evaluateExpression('alert(1)', values), /Unknown parameter 'alert'|Unexpected/);
  assert.throws(() => evaluateExpression('a.b', values), /Cannot read/);
});

test('bindings resolve into params, prune when paths disappear and report usage', () => {
  const doc: CadDocument = { ...emptyDocument(), parameters: demoParameters(), features: demoFeatures() };
  doc.parameters!.find(p => p.name === 'thickness')!.value = 9;
  resolveBindings(doc);
  assert.equal(valueAt(doc.features[0].params, 'size.2'), 9);
  assert.equal(valueAt(doc.features[2].params, 'height'), 29);
  assert.deepEqual(parameterUsage(doc, 'thickness').map(u => u.featureId), ['plate', 'hole_1', 'hole_2', 'hole_3', 'hole_4']);
  const extrude: Feature = { id: 'e', kind: 'extrude', params: { profile: { type: 'rectangle', width: 10, height: 5 }, plane: 'XY', origin: [0, 0, 0], distance: 2 }, bindings: { 'profile.width': 'width' } };
  assert.deepEqual(pruneBindings({ ...extrude, params: { ...extrude.params, profile: { type: 'circle', radius: 3 } } } as Feature).bindings, undefined);
  const bound = withField(extrude, 'distance', 5, 'thickness');
  assert.deepEqual([bound.bindings, (bound.params as { distance: number }).distance], [{ 'profile.width': 'width', distance: 'thickness' }, 5]);
  assert.deepEqual(withField(bound, 'distance', 7).bindings, { 'profile.width': 'width' });
  assert.throws(() => resolveBindings({ ...doc, features: [{ ...extrude, bindings: { 'profile.radius': 'width' } }] }), /not a numeric field/);
});

test('parameter edits are transactional: set, unknown names, in-use deletion and create-tool bindings', () => {
  const base = applyEdits(emptyDocument(), [...demoParameters().map(p => ({ op: 'set_parameter' as const, ...p })), ...demoFeatures().map(feature => ({ op: 'add' as const, feature }))]).document;
  const wider = applyEdits(base, [{ op: 'set_parameter', name: 'width', value: 150 }]);
  assert.equal(valueAt(wider.document.features.find(f => f.id === 'hole_2')!.params, 'origin.0'), 140);
  assert.ok(wider.updated.includes('plate'));
  assert.throws(() => applyEdits(base, [{ op: 'delete_parameter', name: 'width' }]), /drives/);
  assert.throws(() => applyEdits(base, [{ op: 'add', feature: { id: 'x', kind: 'box', params: { origin: [0, 0, 0], size: [1, 1, 1] }, bindings: { 'size.0': 'missing' } } }]), /Unknown parameter 'missing'.*No edit was applied/);
  const command = parseCommand({ type: 'apply_edits', params: { documentId: base.documentId, expectedRevision: 0, edits: [{ op: 'add', feature: { id: 'pad', bindings: { 'size.2': 'thickness * 2' }, kind: 'box', params: { origin: [0, 0, 0], size: [1, 1, 1] } } }] } });
  assert.equal(command.type, 'apply_edits');
  const pad = applyEdits(base, command.params.edits).document.features.at(-1)!;
  assert.equal(valueAt(pad.params, 'size.2'), 10);
  assert.deepEqual(applyEdits(base, [{ op: 'set_parameter', name: 'spare', value: 1 }, { op: 'delete_parameter', name: 'spare' }]).document.parameters, base.parameters);
});


test('binding range errors name params paths for leaf and cross-field validation', () => {
  const doc = emptyDocument();
  const check = (feature: Feature, field: string) => assert.throws(() => resolveBindings({ ...doc, features: [feature] }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: string }).code, 'BINDING_OUT_OF_RANGE');
    assert.ok(error.message.includes(`field 'params.${field}'`), error.message);
    assert.doesNotMatch(error.message, /field ''/);
    return true;
  });
  check({ id: 'box', kind: 'box', params: { origin: [0, 0, 0], size: [1, 1, 1] }, bindings: { 'size.2': '-1' } }, 'size.2');
  check({ id: 'rod', kind: 'rod', params: { from: [0, 0, 0], to: [1, 0, 0], radius: 1 }, bindings: { 'to.0': '0' } }, 'to.0');
});
