/** Experimental direct-Wasm build of the unchanged A0 frontend plus generic arena storage. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { type CompileOptions, compile } from '../src/backends.js';
import { formatProgram, isPrimitive, type Type } from '../src/core.js';
import { link } from '../src/link.js';
import type { DirectFunction } from '../src/source-direct.js';
import { findWasmClang, runTool } from '../src/toolchain.js';
import { committedTree } from './measurement-checkout.js';
import { writeReport } from './scrub-results.js';

const args = process.argv.slice(2);
for (const arg of args)
  assert.ok(/^--(?:out|sysroot|builtins)=.+$/.test(arg), `unsupported argument ${arg}`);
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const outArg = option('out'),
  sysrootArg = option('sysroot'),
  builtinsArg = option('builtins');
assert.ok(outArg && sysrootArg && builtinsArg, '--out=DIR --sysroot=DIR --builtins=FILE required');
const out = resolve(outArg),
  sysroot = resolve(sysrootArg),
  builtins = resolve(builtinsArg);
const identity = committedTree(process.cwd());
const names = [
  'arena_parse_verify_begin',
  'arena_source_unit',
  'arena_verify_resume',
  'arena_verify_status',
  'arena_verify_begin',
  'source_ir_init',
  'source_ir_symbol',
  'source_ir_type',
];
const linked = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const wordsOf = (type: Type): number =>
  isPrimitive(type)
    ? 1
    : type.kind === 'arr'
      ? type.length * wordsOf(type.elem)
      : type.fields.reduce((sum, field) => sum + wordsOf(field), 0);
const value = (type: Type) => ({ words: wordsOf(type), scalar: isPrimitive(type) });
const functions: Record<string, DirectFunction> = {};
for (const name of names) {
  const fn = linked.program.byName.get(name);
  assert.ok(fn, `missing frontend export ${name}`);
  functions[name] = { params: fn.params.map(value), result: value(fn.result) };
}
const frontendOptions = {
  wasmExports: names,
  wasmSimd: true,
  optimize: true,
  wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
} satisfies CompileOptions;
const frontend = Buffer.from(compile(linked.program, 'wasm', frontendOptions).text, 'base64');
assert.ok(WebAssembly.validate(frontend), 'direct frontend is invalid Wasm');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'frontend.wasm'), frontend);
const toolchain = findWasmClang();
assert.ok(toolchain.path && toolchain.wasmLd, 'Wasm clang and wasm-ld required for generic arena');
const run = (path: string, commandArgs: string[]): string => {
  const result = runTool(path, commandArgs, { timeoutMs: 300_000 });
  assert.ok(result.ok, result.stderr);
  return result.stdout.trim();
};
const transportClangFlags = [
  '--target=wasm32-wasi',
  `--sysroot=${sysroot}`,
  '-O3',
  '-flto',
  '-DNDEBUG',
  '-c',
  resolve('tools/native/arena_memory.c'),
  '-I',
  resolve('tools/native'),
  '-o',
  join(out, 'arena.o'),
];
run(toolchain.path, transportClangFlags);
const exports = [
  'malloc',
  'free',
  'a0_arena_create',
  'a0_arena_destroy',
  'a0_runtime_read',
  'a0_runtime_write',
  'a0_memory_view',
  'a0_memory_view_length',
];
const transportLinkerFlags = [
  join(out, 'arena.o'),
  '-L',
  join(sysroot, 'lib/wasm32-wasi'),
  '-lc',
  builtins,
  '--no-entry',
  ...exports.map((name) => `--export=${name}`),
  '--export-memory',
  '-z',
  'stack-size=16777216',
  '--lto-O3',
  '--strip-all',
  '-o',
  join(out, 'arena.wasm'),
];
run(toolchain.wasmLd, transportLinkerFlags);
const arena = await readFile(join(out, 'arena.wasm'));
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(arena)), []);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
assert.deepEqual(committedTree(process.cwd()), identity, 'source changed during build');
await writeReport(join(out, 'build.json'), {
  schema: 1,
  backend: 'direct-wasm',
  candidate: identity,
  frontendABI: 3,
  frontendOptions,
  transportClangFlags: transportClangFlags.map((arg) =>
    arg
      .replace(out, '<artifact>')
      .replace(sysroot, '<wasi-sysroot>')
      .replace(builtins, '<wasi-builtins>')
      .replace(process.cwd(), '<repo>'),
  ),
  transportLinkerFlags: transportLinkerFlags.map((arg) =>
    arg
      .replace(out, '<artifact>')
      .replace(sysroot, '<wasi-sysroot>')
      .replace(builtins, '<wasi-builtins>')
      .replace(process.cwd(), '<repo>'),
  ),
  scope:
    'Experimental compiled backend of the same A0 parser/checker; no syntax or shipping cutover claim.',
  entry: 'compiler/source_frontend.a0',
  functions,
  functionCount: linked.program.functions.length,
  sourceSHA256: hash(formatProgram(linked.program)),
  frontendSHA256: hash(frontend),
  frontendBytes: frontend.length,
  arenaSHA256: hash(arena),
  arenaBytes: arena.length,
  totalWasmBytes: frontend.length + arena.length,
  requiredWasmFeatures: ['bulk-memory', 'simd'],
  transportStackBytes: 16777216,
  libcSHA256: hash(await readFile(join(sysroot, 'lib/wasm32-wasi/libc.a'))),
  builtinsSHA256: hash(await readFile(builtins)),
  clang: run(toolchain.path, ['--version']).split('\n')[0],
  linker: run(toolchain.wasmLd, ['--version']).split('\n')[0],
  inputs: await Promise.all(
    [
      ...new Set([
        ...linked.sources.map((source) => relative(process.cwd(), resolve(source.path))),
        ...execFileSync('git', ['ls-files', 'src/*.ts'], { encoding: 'utf8' }).trim().split('\n'),
        'tools/native/arena_runtime.c',
        'tools/native/arena_runtime.h',
        'tools/native/arena_memory.c',
        'tools/source-direct-build.ts',
      ]),
    ]
      .sort()
      .map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  ),
});
console.log(`Direct frontend: ${frontend.length} bytes; arena: ${arena.length} bytes`);
