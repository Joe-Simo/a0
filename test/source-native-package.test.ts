import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  loadNativeSourcePackage,
  SOURCE_PACKAGE_FILES,
  type SourcePackageManifest,
} from '../src/source-native-package.js';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile('seed/source-frontend/frontend.wasm');
const sha256 = hash(bytes);
const manifest: SourcePackageManifest = {
  schema: 1,
  compilerVersion: 'a0c-0.1.68',
  frontendABI: 3,
  formatCapability: 'arena-format-v2',
  diagnosticCapability: 'arena-v1',
  verificationWords: 768,
  // The ordinary fixture deliberately has no companion capability. These transport tests do
  // not claim working formatting/diagnostics; real companions are exercised by explicit controls.
  components: Object.fromEntries(
    SOURCE_PACKAGE_FILES.map((name) => [
      name,
      { bytes: bytes.length, sha256, buildSHA256: sha256, sourceSHA256: sha256 },
    ]),
  ) as unknown as SourcePackageManifest['components'],
};
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

test('source packages require release-bound metadata before requesting any asset', async () => {
  let reads = 0;
  const read = async () => {
    reads++;
    return bytes;
  };
  const data = encode(manifest);
  await assert.rejects(loadNativeSourcePackage(data, '0'.repeat(64), read), /manifest identity/);
  for (const mutation of [
    { schema: 2 },
    { frontendABI: 2 },
    { verificationWords: 128 },
    { formatCapability: 'arena-format-v1' },
    {
      components: { ...manifest.components, '../other.wasm': manifest.components['frontend.wasm'] },
    },
    { components: { ...manifest.components, 'format.wasm': { bytes: -1 } } },
  ]) {
    const value = encode({ ...manifest, ...mutation });
    await assert.rejects(loadNativeSourcePackage(value, hash(value), read), /source package/);
  }
  assert.equal(reads, 0);
});

test('source packages refuse changed, truncated and missing components without fallback', async () => {
  const data = encode(manifest);
  for (const file of SOURCE_PACKAGE_FILES) {
    for (const changed of [bytes.subarray(0, -1), Uint8Array.from(bytes, (value) => value ^ 1)])
      await assert.rejects(
        loadNativeSourcePackage(data, hash(data), async (name) =>
          name === file ? changed : bytes,
        ),
        new RegExp(`identity differs: ${file}`),
      );
    const missing = new Error('independent asset store failure');
    await assert.rejects(
      loadNativeSourcePackage(data, hash(data), async (name) => {
        if (name === file) throw missing;
        return bytes;
      }),
      (error) => error === missing,
    );
  }
});

test('package snapshots and immutable modules preserve independent frontend lifetimes', async () => {
  const data = encode(manifest);
  const supplied = Uint8Array.from(bytes);
  const artifact = await loadNativeSourcePackage(data, hash(data), async () => supplied);
  supplied.fill(0);
  data.fill(0);
  assert.equal(artifact.artifactBytes, bytes.length * 3);
  assert.ok(Object.isFrozen(artifact.manifest));
  assert.ok(Object.isFrozen(artifact.manifest.components['frontend.wasm']));
  const first = artifact.instantiate();
  const second = artifact.instantiate();
  try {
    assert.ok(first.parse('fn first\nret A\nend\n').ok);
    assert.ok(second.parse('fn second\nret A\nend\n').ok);
    first.close();
    assert.throws(() => first.parse('fn closed\nret A\nend\n'), /closed/);
    const result = second.parse('fn live\nret A\nend\n');
    assert.ok(result.ok);
    assert.equal(result.program.functions[0]?.name, 'live');
    assert.deepEqual(second.format(result), { ok: false, reason: 'unavailable' });
  } finally {
    first.close();
    second.close();
  }
});

test('asset callbacks cannot change the inventory or later lazy component selection', async () => {
  const data = encode(manifest);
  let reads = 0;
  const artifact = await loadNativeSourcePackage(data, hash(data), async () => {
    reads++;
    assert.throws(() => (SOURCE_PACKAGE_FILES as unknown as string[]).reverse(), TypeError);
    return bytes;
  });
  assert.equal(reads, 3);
  assert.deepEqual(SOURCE_PACKAGE_FILES, ['frontend.wasm', 'format.wasm', 'diagnostic.wasm']);
  const engine = artifact.instantiate();
  try {
    assert.ok(engine.parse('fn stable\nret A\nend\n').ok);
  } finally {
    engine.close();
  }
});
