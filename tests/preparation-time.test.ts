import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationEstimate, recordPreparation } from '../src/web/preparation-time';

test('loading estimates use bounded successful measurements, tolerate storage failure and reject corrupt samples', t => {
  const stored = new Map<string, string>();
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
  t.after(() => { if (old) Object.defineProperty(globalThis, 'localStorage', old); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  assert.equal(preparationEstimate('part'), undefined, 'A first load has no invented duration.');
  for (const duration of [1000, 3000, 2000]) recordPreparation('part', duration);
  assert.equal(preparationEstimate('part'), 2000);
  for (const invalid of [NaN, Infinity, -1, 10, 700000]) recordPreparation('part', invalid);
  assert.equal(preparationEstimate('part'), 2000);
  for (let i = 0; i < 30; i++) recordPreparation(`part-${i}`, 1000 + i);
  const entries = JSON.parse([...stored.values()][0]);
  assert.equal(entries.length, 24); assert.equal(preparationEstimate('part'), undefined);
  stored.set('vibeworks.preparation-times.v1', '[{"id":"bad","times":[-9]}]');
  assert.equal(preparationEstimate('bad'), undefined);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('Storage denied'); } });
  assert.equal(preparationEstimate('part'), undefined); assert.doesNotThrow(() => recordPreparation('part', 1000));
});
