/** Build only the existing A0 diagnostic renderer, with generic live arena ports. */
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
const argument = args[0];
assert.ok(
  args.length === 1 && typeof argument === 'string' && argument.startsWith('--out='),
  '--out=DIR required',
);
const out = resolve(argument.slice(6));
const linked = await link('compiler/diagnostics_arena.a0', (path) => readFile(path, 'utf8'));
const root = linked.program.byName.get('arena_diagnostic_options');
assert.ok(root, 'missing renderer root');
assert.deepEqual(
  root.params.map(formatType),
  ['io', 'u32x128', 'u32'],
  'renderer parameter ABI differs',
);
assert.equal(
  formatType(root.result),
  '(u32,(u32,u32,u32),u32x128,io)',
  'renderer result ABI differs',
);
const options = {
  wasmExports: ['arena_diagnostic_options'],
  wasmSimd: true,
  optimize: true,
  wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
} as const;
const bytes = Buffer.from(compile(linked.program, 'wasm', options).text, 'base64');
assert.ok(WebAssembly.validate(bytes), 'invalid diagnostic Wasm');
const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'diagnostic.wasm'), bytes);
await writeReport(join(out, 'build.json'), {
  schema: 1,
  capability: 'arena-v1',
  entry: 'compiler/diagnostics_arena.a0',
  root: 'arena_diagnostic_options',
  options,
  wasmSHA256: hash(bytes),
  wasmBytes: bytes.length,
  sourceSHA256: hash(formatProgram(linked.program)),
  resultWords: 133,
  parsedWords: 128,
  requiredWasmFeatures: ['bulk-memory', 'simd'],
  inputs: await Promise.all(
    [
      ...new Set([
        ...linked.sources.map(({ path }) => relative(process.cwd(), path)),
        ...execFileSync('git', ['ls-files', 'src/*.ts'], { encoding: 'utf8' }).trim().split('\n'),
        'src/source-native-render.ts',
        'src/source-component.ts',
        'tools/source-diagnostic-build.ts',
      ]),
    ]
      .sort()
      .map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  ),
});
console.log(`Built failure-only A0 diagnostic renderer: ${bytes.length} Wasm bytes`);
