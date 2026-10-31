/** Build the existing A0 formatter/revision closure as an optional live-arena capability. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compile } from '../src/backends.js';
import { writeReport } from './scrub-results.js';
import { FORMAT_OPTIONS, FORMAT_ROOTS, formatInputs } from './source-format-inputs.js';

const args = process.argv.slice(2);
assert.ok(args.length === 1 && args[0]?.startsWith('--out='), '--out=DIR required');
const out = resolve((args[0] as string).slice(6));
const { linked, inputs, sourceSHA256 } = await formatInputs();
const options = FORMAT_OPTIONS;
const bytes = Buffer.from(compile(linked.program, 'wasm', options).text, 'base64');
assert.ok(WebAssembly.validate(bytes), 'invalid formatting Wasm');
const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'format.wasm'), bytes);
await writeReport(join(out, 'build.json'), {
  schema: 1,
  capability: 'arena-format-v2',
  formatScopes: ['function', 'program', 'source', 'signature'],
  authoringSchema: 1,
  authoringWords: 128,
  entry: 'compiler/revision_arena.a0',
  roots: FORMAT_ROOTS,
  options,
  wasmSHA256: hash(bytes),
  wasmBytes: bytes.length,
  sourceSHA256,
  parsedWords: 128,
  specWords: 128,
  eventWords: 6,
  requiredWasmFeatures: ['bulk-memory', 'simd'],
  inputs,
});
console.log(`Built optional A0 formatter/revisions: ${bytes.length} Wasm bytes`);
