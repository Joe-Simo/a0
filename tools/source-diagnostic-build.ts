/** Build only the existing A0 diagnostic renderer, with generic live arena ports. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compile } from '../src/backends.js';
import { formatType } from '../src/core.js';
import { writeReport } from './scrub-results.js';
import { DIAGNOSTIC_OPTIONS, diagnosticInputs } from './source-diagnostic-inputs.js';

const args = process.argv.slice(2);
const argument = args[0];
assert.ok(
  args.length === 1 && typeof argument === 'string' && argument.startsWith('--out='),
  '--out=DIR required',
);
const out = resolve(argument.slice(6));
const entry = 'compiler/diagnostic_specs_arena.a0';
const { linked, inputs, sourceSHA256 } = await diagnosticInputs(entry);
const root = linked.program.byName.get('arena_diagnostic_options');
const verified = linked.program.byName.get('arena_verified_diagnostic_options');
assert.ok(root, 'missing renderer root');
assert.ok(verified, 'missing verified renderer root');
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
assert.deepEqual(verified.params.map(formatType), [
  'io',
  ...Array<string>(6).fill('u32x128'),
  'u32',
]);
assert.equal(formatType(verified.result), formatType(root.result));
const options = DIAGNOSTIC_OPTIONS;
const bytes = Buffer.from(compile(linked.program, 'wasm', options).text, 'base64');
assert.ok(WebAssembly.validate(bytes), 'invalid diagnostic Wasm');
const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'diagnostic.wasm'), bytes);
await writeReport(join(out, 'build.json'), {
  schema: 1,
  capability: 'arena-v1',
  entry,
  root: 'arena_diagnostic_options',
  options,
  wasmSHA256: hash(bytes),
  wasmBytes: bytes.length,
  sourceSHA256,
  resultWords: 133,
  parsedWords: 128,
  verificationWords: 768,
  roots: {
    arena_diagnostic_options: { params: [1, 128, 1], resultWords: 133 },
    arena_verified_diagnostic_options: {
      params: [1, 128, 128, 128, 128, 128, 128, 1],
      resultWords: 133,
    },
  },
  requiredWasmFeatures: ['bulk-memory', 'simd'],
  inputs,
});
console.log(`Built failure-only A0 diagnostic renderer: ${bytes.length} Wasm bytes`);
