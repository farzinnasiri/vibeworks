import test from 'node:test';
import assert from 'node:assert/strict';
import { studioImageLayout } from '../src/web/studio-image-output';

test('product sheets cover every output pixel once for one through sixteen views, including odd dimensions', () => {
  for (const count of Array.from({ length: 16 }, (_, i) => i + 1)) {
    const width = 101, height = 79, pixels = new Uint8Array(width * height);
    const tiles = studioImageLayout(count, width, height);
    assert.equal(tiles.length, count);
    for (const tile of tiles) {
      assert.ok(tile.width > 0 && tile.imageHeight > 0);
      assert.equal(tile.imageHeight, tile.height, 'Clean output has no label strip.');
      assert.equal(tile.labelHeight, 0);
      for (let y = tile.y; y < tile.y + tile.height; y++) for (let x = tile.x; x < tile.x + tile.width; x++) pixels[y * width + x]++;
    }
    assert.ok(pixels.every(coverage => coverage === 1), `${count} views must leave no gap or overlap.`);
  }
});

test('three views occupy one full row and larger odd counts fill their last row', () => {
  const three = studioImageLayout(3, 1920, 1080);
  assert.deepEqual(three.map(tile => [tile.x, tile.y, tile.width, tile.height]), [[0, 0, 640, 1080], [640, 0, 640, 1080], [1280, 0, 640, 1080]]);
  for (const count of [5, 7]) {
    const tiles = studioImageLayout(count, 1920, 1080), bottom = Math.max(...tiles.map(tile => tile.y));
    assert.equal(tiles.filter(tile => tile.y === bottom).reduce((sum, tile) => sum + tile.width, 0), 1920);
  }
});

test('labels explicitly reserve a bounded strip while tiny sheets preserve positive image dimensions', () => {
  const labeled = studioImageLayout(3, 1920, 1080, true);
  assert.ok(labeled.every(tile => tile.labelHeight === 32 && tile.imageHeight === 1048));
  const tiny = studioImageLayout(7, 3, 3, true);
  assert.ok(tiny.every(tile => tile.imageHeight >= 1));
  assert.throws(() => studioImageLayout(7, 2, 2), RangeError);
  assert.throws(() => studioImageLayout(0, 1920, 1080), RangeError);
  assert.throws(() => studioImageLayout(17, 1920, 1080), RangeError);
});
