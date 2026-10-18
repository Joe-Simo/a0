import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { verifySourceCostControl } from '../tools/source-cost-control.js';
import { verifyNativeInputs } from '../tools/source-native-artifact.js';

test('matched source cost controls reject compiler and transport confounders', async () => {
  const build = JSON.parse(await readFile('seed/source-frontend/build.json', 'utf8'));
  for (const transport of [false, true]) {
    verifySourceCostControl(build, structuredClone(build), transport);
    for (const field of ['clang', 'linker', 'sourceSHA256']) {
      assert.throws(
        () => verifySourceCostControl(build, { ...build, [field]: 'different' }, transport),
        new RegExp(field),
      );
    }
  }
  assert.throws(
    () => verifySourceCostControl(build, { ...build, nativeInputs: [] }, false),
    /nativeInputs/,
  );
  assert.throws(
    () => verifySourceCostControl(build, { ...build, clangFlags: [] }, true),
    /clangFlags/,
  );
});

test('native provenance rejects changed transport code and incomplete inventories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-native-inputs-'));
  const paths = [
    'tools/native/source_frontend.c',
    'tools/native/arena_runtime.c',
    'tools/native/arena_runtime.h',
    'tools/source-native-build.ts',
  ];
  try {
    const inputs = await Promise.all(
      paths.map(async (path) => {
        const text = `independent input: ${path}\n`;
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
        return { path, sha256: createHash('sha256').update(text).digest('hex') };
      }),
    );
    await verifyNativeInputs(root, inputs);
    await assert.rejects(verifyNativeInputs(root, inputs.slice(0, 3)), /inventory differs/);
    const first = inputs[0];
    assert.ok(first);
    await assert.rejects(verifyNativeInputs(root, [...inputs, first]), /inventory differs/);
    await writeFile(join(root, 'tools/native/arena_runtime.c'), 'changed arena transport\n');
    await assert.rejects(verifyNativeInputs(root, inputs), /arena_runtime\.c/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
