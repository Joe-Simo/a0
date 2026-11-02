import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diagnosticInputs } from '../tools/source-diagnostic-inputs.js';
import { formatInputs } from '../tools/source-format-inputs.js';
import {
  prepareSourceDiagnostic,
  prepareSourceFormat,
  prepareSourceFrontend,
} from '../tools/source-native-load.js';

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('companion builders record portable labels with the exact consumed input bytes', async () => {
  for (const build of [
    await formatInputs(),
    await diagnosticInputs('compiler/diagnostic_specs_arena.a0'),
  ]) {
    assert.ok(build.inputs.some((input) => input.path === 'tools/source-native-load.ts'));
    for (const input of build.inputs) {
      assert.equal(input.path.includes('\\'), false, input.path);
      assert.equal(input.sha256, hash(await readFile(input.path)), input.path);
    }
  }
});

for (const kind of ['direct', 'diagnostic', 'format'] as const) {
  test(`${kind} companion validates portable input paths before reading and retains hashes`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'a0-companion-paths-'));
    const input = {
      path: 'tools/source-native-load.ts',
      sha256: hash(await readFile('tools/source-native-load.ts')),
    };
    const build =
      kind === 'direct'
        ? {
            backend: 'direct-wasm',
            frontendSHA256: hash(wasm),
            frontendBytes: wasm.length,
            arenaSHA256: hash(wasm),
            arenaBytes: wasm.length,
            totalWasmBytes: wasm.length * 2,
            inputs: [input],
            functions: [],
          }
        : {
            schema: 1,
            capability: kind === 'format' ? 'arena-format-v1' : 'arena-v1',
            entry:
              kind === 'format' ? 'compiler/revision_arena.a0' : 'compiler/diagnostics_arena.a0',
            root: 'arena_diagnostic_options',
            parsedWords: 128,
            resultWords: 133,
            specWords: 128,
            eventWords: 6,
            roots: {
              arena_format_described: { resultWords: 133 },
              arena_revision: { resultWords: 5 },
            },
            wasmSHA256: hash(wasm),
            wasmBytes: wasm.length,
            inputs: [input],
          };
    const prepare =
      kind === 'direct'
        ? prepareSourceFrontend
        : kind === 'format'
          ? prepareSourceFormat
          : prepareSourceDiagnostic;
    const save = async (inputs: typeof build.inputs) =>
      writeFile(join(root, 'build.json'), JSON.stringify({ ...build, inputs }));
    try {
      for (const file of ['frontend.wasm', 'arena.wasm', 'diagnostic.wasm', 'format.wasm']) {
        await writeFile(join(root, file), wasm);
      }
      await save([input]);
      await prepare(root);
      for (const path of [
        '',
        '../package.json',
        'tools/../package.json',
        './package.json',
        'tools//source-native-load.ts',
        '/package.json',
        'C:/package.json',
        'C:package.json',
        '\\\\server\\share',
        'tools\\source-native-load.ts',
        'package.json\0suffix',
      ]) {
        await save([{ ...input, path }]);
        await assert.rejects(prepare(root), /invalid .*input path/, JSON.stringify(path));
      }
      await save([input, input]);
      await assert.rejects(prepare(root), /invalid .*input path/);
      await save([{ ...input, sha256: '0'.repeat(64) }]);
      await assert.rejects(prepare(root), /stale .*input/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
