/** Build the existing A0 formatter/revision closure as an optional live-arena capability. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { compile } from '../src/backends.js';
import { formatProgram, formatType } from '../src/core.js';
import { link } from '../src/link.js';
import { writeReport } from './scrub-results.js';

const args = process.argv.slice(2);
assert.ok(args.length === 1 && args[0]?.startsWith('--out='), '--out=DIR required');
const out = resolve((args[0] as string).slice(6));
const linked = await link('compiler/revision_arena.a0', (path) => readFile(path, 'utf8'));
const roots = {
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
for (const [name, signature] of Object.entries(roots)) {
  const root = linked.program.byName.get(name);
  assert.ok(root, name);
  assert.deepEqual(root.params.map(formatType), signature.params, `${name}: parameters`);
  assert.equal(formatType(root.result), signature.result, `${name}: result`);
}
const options = {
  wasmExports: Object.keys(roots),
  wasmSimd: true,
  optimize: true,
  wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
} as const;
const bytes = Buffer.from(compile(linked.program, 'wasm', options).text, 'base64');
assert.ok(WebAssembly.validate(bytes), 'invalid formatting Wasm');
const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'format.wasm'), bytes);
await writeReport(join(out, 'build.json'), {
  schema: 1,
  capability: 'arena-format-v2',
  authoringSchema: 1,
  authoringWords: 128,
  entry: 'compiler/revision_arena.a0',
  roots,
  options,
  wasmSHA256: hash(bytes),
  wasmBytes: bytes.length,
  sourceSHA256: hash(formatProgram(linked.program)),
  parsedWords: 128,
  specWords: 128,
  eventWords: 6,
  requiredWasmFeatures: ['bulk-memory', 'simd'],
  inputs: await Promise.all(
    [
      ...new Set([
        ...linked.sources.map(({ path }) => relative(process.cwd(), path)),
        ...execFileSync('git', ['ls-files', 'src/*.ts'], { encoding: 'utf8' }).trim().split('\n'),
        'src/source-component.ts',
        'src/source-native-format.ts',
        'src/source-utf8.ts',
        'tools/source-format-build.ts',
      ]),
    ]
      .sort()
      .map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  ),
});
console.log(`Built optional A0 formatter/revisions: ${bytes.length} Wasm bytes`);
