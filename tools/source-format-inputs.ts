/** Exact formatter closure and ABI shared by its builder and provenance guard. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { formatProgram, formatType } from '../src/core.js';
import { link } from '../src/link.js';

export const FORMAT_ROOTS = {
  arena_format_described: {
    params: ['io', 'u32x128', 'u32x128', 'u32', 'u32', 'bool', 'bool'],
    result: '(u32,(u32,u32,u32),u32x128,io)',
    resultWords: 133,
  },
  arena_format_authoring: {
    params: ['io', 'u32x128', 'u32x128', 'u32x128', 'u32', 'u32', 'bool', 'bool'],
    result: '(u32,(u32,u32,u32),u32x128,io)',
    resultWords: 133,
  },
  arena_revision_authoring: {
    params: ['io', 'u32x128', 'u32x128', 'u32x128', 'u32', 'u32'],
    result: '(u32,(u32,u32,u32),io)',
    resultWords: 5,
  },
  arena_revision: {
    params: ['io', 'u32x128', 'u32x128', 'u32', 'u32'],
    result: '(u32,(u32,u32,u32),io)',
    resultWords: 5,
  },
};
export const FORMAT_OPTIONS = {
  wasmExports: Object.keys(FORMAT_ROOTS),
  wasmSimd: true,
  optimize: true,
  wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
} as const;

export async function formatInputs() {
  const linked = await link('compiler/revision_arena.a0', (path) => readFile(path, 'utf8'));
  for (const [name, signature] of Object.entries(FORMAT_ROOTS)) {
    const root = linked.program.byName.get(name);
    assert.ok(root, name);
    assert.deepEqual(root.params.map(formatType), signature.params, `${name}: parameters`);
    assert.equal(formatType(root.result), signature.result, `${name}: result`);
  }
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const inputs = await Promise.all(
    [
      ...new Set([
        ...linked.sources.map(({ path }) => relative(process.cwd(), path)),
        ...execFileSync('git', ['ls-files', 'src/*.ts'], { encoding: 'utf8' }).trim().split('\n'),
        'tools/source-format-build.ts',
        'tools/source-format-inputs.ts',
        'tools/source-native-load.ts',
      ]),
    ]
      .sort()
      .map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  );
  return { linked, inputs, sourceSHA256: hash(formatProgram(linked.program)) };
}
