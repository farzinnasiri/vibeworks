import test from 'node:test';
import assert from 'node:assert/strict';
import { boltCircle, holeGrid } from '../src/web/HolePattern';

test('bolt circles and grids place centers across the drilling axis', () => {
  const circle = boltCircle([50, 30, 5], 2, 20, 4, 0);
  assert.deepEqual(circle, [[70, 30, 5], [50, 50, 5], [30, 30, 5], [50, 10, 5]]);
  // Drilling along X: the pattern lies in Y/Z and keeps the X coordinate.
  assert.ok(boltCircle([7, 0, 0], 0, 10, 6, 30).every(([x, y, z]) => x === 7 && Math.abs(Math.hypot(y, z) - 10) < 1e-3));
  assert.deepEqual(holeGrid([10, 10, 0], 2, [2, 2], [80, 40]), [[10, 10, 0], [90, 10, 0], [10, 50, 0], [90, 50, 0]]);
});
