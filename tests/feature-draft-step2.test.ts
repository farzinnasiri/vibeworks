import test from 'node:test';
import assert from 'node:assert/strict';
import { changeFeatureParams } from '../src/web/feature-draft';
import { applyEdits } from '../src/cad/edits';
import { emptyDocument } from '../src/cad/document';
import { xyFrame } from '../src/cad/modeling-presets';
import type { Feature } from '../src/shared/protocol';

const loft = (): Extract<Feature, { kind: 'loft' }> => ({
  id: 'loft', kind: 'loft', params: { ruled: true, sections: [0, 10, 20].map(z => ({
    frame: xyFrame([0, 0, z]), profile: { type: 'circle', radius: 5 },
  })) }, bindings: {
    'sections.0.profile.radius': 'radius', 'sections.1.profile.radius': 'radius + 1',
    'sections.2.profile.radius': 'radius + 2', 'sections.2.frame.origin.2': 'height',
  },
});

test('loft append preserves bindings through Apply and later parameter edits, without binding the new copy', () => {
  const before = loft(), appended = structuredClone(before.params.sections[2]);
  appended.frame.origin[2] += 20;
  const after = changeFeatureParams(before, { sections: [...before.params.sections, appended] });
  assert.deepEqual(after.bindings, before.bindings);
  const doc = applyEdits(emptyDocument(), [
    { op: 'set_parameter', name: 'radius', value: 5 }, { op: 'set_parameter', name: 'height', value: 20 },
    { op: 'add', feature: after },
  ]).document;
  const edited = applyEdits(doc, [{ op: 'set_parameter', name: 'radius', value: 8 }, { op: 'set_parameter', name: 'height', value: 25 }]).document.features[0];
  assert.equal(edited.kind, 'loft');
  if (edited.kind !== 'loft') throw Error('Expected loft');
  assert.deepEqual(edited.params.sections.map(s => s.profile), [8, 9, 10, 5].map(radius => ({ type: 'circle', radius })));
  assert.equal(edited.params.sections[2].frame.origin[2], 25);
  assert.deepEqual(before, loft(), 'Draft edits must not mutate the committed input');
});

test('loft first/middle/last removal keeps each surviving section binding at its new path', () => {
  for (const removed of [0, 1, 2]) {
    const before = loft();
    const expected = Object.fromEntries(Object.entries(before.bindings!).flatMap(([path, expr]) => {
      const parts = path.split('.'), old = Number(parts[1]);
      if (old === removed) return [];
      parts[1] = String(old > removed ? old - 1 : old);
      return [[parts.join('.'), expr]];
    }));
    const after = changeFeatureParams(before, { sections: before.params.sections.filter((_, i) => i !== removed) });
    assert.deepEqual(after.bindings, expected, `Remove section ${removed}`);
    const base = applyEdits(emptyDocument(), [
      { op: 'set_parameter', name: 'radius', value: 5 }, { op: 'set_parameter', name: 'height', value: 20 },
      { op: 'add', feature: before },
    ]).document;
    const live = base.features[0]; if (live.kind !== 'loft') throw Error('Expected loft');
    const draft = changeFeatureParams(live, { sections: live.params.sections.filter((_, i) => i !== removed) });
    const updated = applyEdits(base, [{ op: 'update', feature: draft }, { op: 'set_parameter', name: 'radius', value: 8 }]).document.features[0];
    if (updated.kind !== 'loft') throw Error('Expected loft');
    assert.deepEqual(updated.params.sections.map(s => s.profile), [8,9,10].filter((_, i) => i !== removed).map(radius => ({ type: 'circle', radius })));
  }
});

test('changing one loft profile type drops only that profile binding and preserves its frame and other sections', () => {
  const before = loft();
  const after = changeFeatureParams(before, { sections: before.params.sections.map((s, i) => i === 2 ? { ...s, profile: { type: 'ellipse', radiusX: 5, radiusY: 3 } } : s) });
  const expected = { ...before.bindings }; delete expected['sections.2.profile.radius'];
  assert.deepEqual(after.bindings, expected);
});

test('loft presets replace section bindings deliberately, even when some numeric values coincide', () => {
  const before = loft();
  const after = changeFeatureParams(before, { sections: structuredClone(before.params.sections), ruled: false }, ['sections']);
  assert.equal(after.bindings, undefined);
});

test('curve append/remove/type and cubic/quadratic edits preserve only surviving bound fields', () => {
  const before: Extract<Feature, { kind: 'extrude' }> = {
    id: 'curve', kind: 'extrude', params: { plane: 'XY', origin: [0, 0, 0], distance: 2,
      profile: { type: 'path', start: [0, 0], segments: [
        { type: 'line', to: [20, 0] },
        { type: 'bezier', to: [0, 10], controls: [[20, 10], [10, 10]] },
        { type: 'line', to: [0, 0] },
      ] },
    }, bindings: { distance: 'depth', 'profile.start.0': 'start', 'profile.segments.0.to.0': 'end',
      'profile.segments.1.controls.0.1': 'first', 'profile.segments.1.controls.1.1': 'second',
      'profile.segments.2.to.0': 'closing' },
  };
  if (before.params.profile.type !== 'path') throw Error('Expected path');
  const profile = before.params.profile, segments = profile.segments;
  const appended = changeFeatureParams(before, { profile: { ...profile, segments: [...segments, { type: 'line', to: [1, 0] }] } });
  assert.deepEqual(appended.bindings, before.bindings);
  const removed = changeFeatureParams(before, { profile: { ...profile, segments: segments.filter((_, i) => i !== 0) } });
  assert.deepEqual(removed.bindings, { distance: 'depth', 'profile.start.0': 'start',
    'profile.segments.0.controls.0.1': 'first', 'profile.segments.0.controls.1.1': 'second', 'profile.segments.1.to.0': 'closing' });
  const bezier = segments[1]; if (bezier.type !== 'bezier') throw Error('Expected Bezier');
  const quadratic = changeFeatureParams(before, { profile: { ...profile, segments: segments.map((s, i) => i === 1 ? { ...bezier, controls: [bezier.controls[0]] } : s) } });
  const expected = { ...before.bindings }; delete expected['profile.segments.1.controls.1.1'];
  assert.deepEqual(quadratic.bindings, expected);
  const replaced = changeFeatureParams(before, { profile: { ...profile, segments: segments.map((s, i) => i === 1 ? { type: 'arc', to: [0, 10], via: [20, 10] } : s) } });
  delete expected['profile.segments.1.controls.0.1'];
  assert.deepEqual(replaced.bindings, expected);
});
