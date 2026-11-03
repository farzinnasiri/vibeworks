import assert from 'node:assert/strict';
import test from 'node:test';
import { Children, isValidElement, type ReactElement } from 'react';
import { ComponentReplayControls } from '../src/web/ComponentReplayControls';
import { ViewControls } from '../src/web/ViewControls';
import { ComponentReplay } from '../src/web/component-replay';
import { emptyDocument } from '../src/cad/document';
import { unknownHealth, type Replay } from '../src/shared/protocol';
import type { RuntimeState, Outcome } from '../src/cad/runtime';

function control(tree: ReactElement, label: string): ReactElement<any> {
  if ((tree.props as any)['aria-label'] === label) return tree;
  for (const child of Children.toArray((tree.props as any).children)) {
    if (isValidElement(child)) {
      try { return control(child, label); } catch { /* Search the next child. */ }
    }
  }
  throw new Error(`Missing control: ${label}`);
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('component controls stop orbit before real controller play, pause, scrub, retry and exits', async () => {
  const document = emptyDocument();
  const snapshot: RuntimeState = {
    phase: 'ready', busy: false, activity: 'Ready', health: unknownHealth(), canUndo: false, canRedo: false,
    persistence: 'Test', documents: [], projects: [], document, storageVersion: 1,
    evaluation: { geometry: [], meshes: [], visibleFeatureIds: [] },
  };
  let orbiting = true, requests = 0, refreshes = 0;
  let resolve: (outcome: Outcome) => void = () => {};
  const controller = new ComponentReplay({
    getSnapshot: () => snapshot,
    refreshStorage: async () => { assert.equal(orbiting, false); refreshes++; },
    replay: () => {
      assert.equal(orbiting, false, 'orbit must stop before the read starts, including loading/error retry');
      requests++;
      return new Promise(r => { resolve = r; });
    },
  });
  const render = () => ComponentReplayControls({
    controller, state: controller.getSnapshot(), speed: 1, onSpeed: () => {},
    onInteract: () => { orbiting = false; }, disabled: false,
  });
  const click = (label: string) => control(render(), label).props.onClick();
  const reply = (step: number) => {
    const replay: Replay = { key: 'graph', step, steps: [1, 2, 3].map(n => ({
      rootStep: 1, kind: 'box', path: [{ documentId: document.documentId, name: 'Part', featureId: `box${n}`, label: `Box ${n}` }],
    })) };
    resolve({ result: { operation: 'inspect_model', status: 'success', created: [], updated: [], warnings: [], replay },
      evaluation: { ...snapshot.evaluation, replay } });
  };
  assert.equal(control(render(), 'Component build history').props.disabled, true, 'inactive scrub cannot enter replay');
  assert.equal(requests, 0);
  click('Play component build');
  assert.equal(orbiting, false); assert.equal(controller.getSnapshot().loading, true);
  orbiting = true; click('Pause component replay');
  assert.equal(orbiting, false); assert.equal(controller.getSnapshot().playing, false);
  reply(1); await settle();
  orbiting = true;
  control(render(), 'Component build history').props.onChange({ target: { value: '2' } });
  assert.equal(orbiting, false); assert.equal(controller.getSnapshot().loading, true);
  reply(2); await settle();
  assert.equal(controller.getSnapshot().replay?.step, 2);
  orbiting = true; click('Play component build');
  assert.equal(orbiting, false); assert.equal(controller.getSnapshot().playing, true);
  orbiting = true; click('Back to latest');
  assert.equal(orbiting, false); assert.equal(controller.getSnapshot().active, false);
  assert.equal(refreshes, 1);

  orbiting = true; click('Play component build');
  resolve({ result: { operation: 'inspect_model', status: 'error', created: [], updated: [], warnings: [],
    error: { code: 'WORKER_TIMEOUT', message: 'Controlled read failure' } } });
  await settle();
  assert.equal(controller.getSnapshot().active, true); assert.ok(controller.getSnapshot().error);
  assert.equal(orbiting, false);
  orbiting = true; click('Retry component replay');
  assert.equal(orbiting, false); reply(1); await settle();
  orbiting = true;
  let prevented = false;
  control(render(), 'Component build history').props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(orbiting, false); assert.equal(controller.getSnapshot().active, false);
  assert.equal(snapshot.document, document); assert.equal(snapshot.document.revision, 0);
  await settle(); assert.equal(orbiting, false, 'exit never resumes orbit');
});

test('rendered Stop remains operable while orbiting even when replay or authority disables Start', () => {
  let orbiting = true;
  const props: Parameters<typeof ViewControls>[0] = {
    navigation: 'trackpad', onNavigation: () => {}, orbiting, orbitDisabled: true, onOrbit: () => { orbiting = !orbiting; },
    edges: true, onEdges: () => {}, view: 'isometric', setCamera: () => {}, menu: null, setMenu: () => {},
    section: null, setSection: () => {}, sectionAxis: () => {}, sectionRange: { min: [0,0,0], max: [1,1,1] },
    toggleSection: () => {}, measuring: false, snap: false, onFit: () => {}, onMeasure: () => {}, onSnap: () => {},
  };
  // Stop stays a visible toolbar button while orbiting; starting is an occasional choice in View options.
  const stop = control(ViewControls(props), 'Stop turntable orbit');
  assert.equal(stop.props['aria-pressed'], true); assert.equal(stop.props.disabled, undefined);
  stop.props.onClick(); assert.equal(orbiting, false);
  assert.throws(() => control(ViewControls({ ...props, orbiting }), 'Stop turntable orbit'));
  const start = control(ViewControls({ ...props, orbiting }), 'Turntable orbit');
  assert.equal(start.props['aria-checked'], false); assert.equal(start.props.disabled, true);
});
