// Verify an exported model with a separately distributed STEP reader.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const init = require('occt-import-js');

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node scripts/check-step.cjs <model.step> [sizeX sizeY sizeZ meshCount]. Defaults to the 100 x 60 x 5 plate.');
  const expected = process.argv.length >= 6 ? process.argv.slice(3, 6).map(Number) : [100, 60, 5];
  const expectedMeshes = Number(process.argv[6] ?? 1);
  assert.ok(expected.length === 3 && expected.every(n => Number.isFinite(n) && n > 0));
  assert.ok(Number.isInteger(expectedMeshes) && expectedMeshes > 0);
  const reader = await init();
  const result = reader.ReadStepFile(fs.readFileSync(path), {
    linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.01,
    angularDeflection: 0.1,
  });
  assert.equal(result.success, true, 'STEP reader must accept the file');
  assert.equal(result.meshes.length, expectedMeshes, 'Expected exported solid meshes');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const mesh of result.meshes) {
    triangles += mesh.index.array.length / 3;
    mesh.attributes.position.array.forEach((n, i) => {
      assert.ok(Number.isFinite(n));
      min[i % 3] = Math.min(min[i % 3], n);
      max[i % 3] = Math.max(max[i % 3], n);
    });
  }
  assert.ok(triangles > 100, 'Expected a tessellated solid with curved faces');
  const size = max.map((n, i) => n - min[i]);
  size.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-3, `Axis ${i} bounds mismatch`));
  console.log(JSON.stringify({ status: 'passed', reader: 'occt-import-js', path, meshCount: result.meshes.length, triangles, bounds: { min, max, size }, note: 'Separate STEP reader distribution; both libraries use OCCT. This is an import/bounds check, not certification across commercial CAD applications.' }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
