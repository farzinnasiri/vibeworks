import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { decodeBase64, resultSchema } from '../src/bridge/validation.ts';
import { boxParamsSchema, vectorSchema } from '../src/shared/protocol.ts';

test('coordinate schemas advertise numeric homogeneous arrays to agent clients', () => {
  const schema = z.toJSONSchema(boxParamsSchema);
  for (const field of ['origin', 'size']) {
    const property = schema.properties![field] as Record<string, any>;
    assert.equal(property.items.type, 'number');
    assert.equal(property.minItems, 3);
    assert.equal(property.maxItems, 3);
    assert.equal(property.prefixItems, undefined);
  }
  assert.equal(vectorSchema.safeParse([0, 0, 0]).success, true);
  assert.equal(vectorSchema.safeParse(['0', '0', '0']).success, false);
  assert.equal(vectorSchema.safeParse([0, 0]).success, false);
});

test('base64 delivery accepts the full 20 MiB limit without regexp stack overflow', () => {
  const bytes = Buffer.alloc(20 * 1024 * 1024, 42);
  assert.deepEqual(decodeBase64(bytes.toString('base64')), bytes);
  for (const malformed of ['AA=A', 'A===', 'AAAA====', 'AA A', 'AB==']) {
    assert.throws(() => decodeBase64(malformed));
  }
  assert.throws(() => decodeBase64(Buffer.alloc(4).toString('base64'), 3));
});

test('geometry bounds allow valid origin plus dimension while rejecting non-finite and negative size', () => {
  const result = {
    operation: 'apply_edits', status: 'success',
    documentId: '5c7d00d3-0168-44a6-9204-0373f6151739', revision: 1,
    created: ['box'], updated: [], warnings: [],
    geometry: [{
      featureId: 'box', valid: true, validationMethod: 'OCCT', solidCount: 1, volumeMm3: 1e12,
      bounds: { min: [100000, 100000, 100000], max: [110000, 110000, 110000], size: [10000, 10000, 10000] },
    }],
  };
  assert.equal(resultSchema.safeParse(result).success, true);
  result.geometry[0].bounds.max[0] = Infinity;
  assert.equal(resultSchema.safeParse(result).success, false);
  result.geometry[0].bounds.max[0] = 110000;
  result.geometry[0].bounds.size[0] = -1;
  assert.equal(resultSchema.safeParse(result).success, false);
});
