/** Build the candidate A0 frontend from compiler modules, using generic arena transport. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { compile } from '../src/backends.js';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findWasmClang, runTool } from '../src/toolchain.js';
import { writeReport } from './scrub-results.js';

const options = new Map(
  process.argv.slice(2).map((arg) => {
    const at = arg.indexOf('=');
    assert.ok(at > 2, 'arguments use --name=value');
    return [arg.slice(2, at), arg.slice(at + 1)];
  }),
);
for (const name of options.keys())
  assert.ok(['out', 'sysroot', 'builtins'].includes(name), `unknown argument ${name}`);
for (const name of ['out', 'sysroot', 'builtins'])
  assert.ok(options.get(name), `required: --${name}=PATH`);
const out = resolve(options.get('out') as string);
const sysroot = resolve(options.get('sysroot') as string);
const builtins = resolve(options.get('builtins') as string);
const clang = findWasmClang();
assert.ok(clang.path && clang.wasmLd, 'Wasm clang and wasm-ld are required');
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const linked = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const source = formatProgram(linked.program);
const c = compile(linked.program, 'c', { cIo: 'host' }).text;
const normal = /^(a0t_[A-Za-z0-9_]+) a0_arena_verify_begin\(/m.exec(c);
const large = /^void a0_arena_verify_begin\((a0t_[A-Za-z0-9_]+) \*out/m.exec(c);
assert.ok(normal || large, 'unsupported C ABI');
const stateType = (normal ?? large)?.[1];
assert.ok(stateType);
await mkdir(out, { recursive: true });
const driver = await readFile('tools/native/source_frontend.c', 'utf8');
await writeFile(join(out, 'module.c'), c);
await writeFile(join(out, 'driver.c'), driver);
await writeFile(
  join(out, 'api.h'),
  `#define SV_STATE ${stateType}
#define FRONTEND_BEGIN(s,t,h,n) ${normal ? '((s)=a0_arena_parse_verify_begin((t),(h),(n)))' : 'a0_arena_parse_verify_begin(&(s),(t),(h),(n))'}
#define FRONTEND_RESUME(s,n) ${normal ? '((s)=a0_arena_verify_resume((s),(n)))' : 'a0o_arena_verify_resume(&(s),(n))'}
#define FRONTEND_STATUS(m) ${normal ? 'a0_arena_verify_status(m)' : 'a0_arena_verify_status(&(m))'}
`,
);
function tool(path: string, args: string[]): string {
  const result = runTool(path, args, { timeoutMs: 300_000 });
  assert.ok(result.ok, `${path}: ${result.stderr}`);
  return result.stdout.trim();
}
tool(clang.path, [
  '--target=wasm32-wasi',
  `--sysroot=${sysroot}`,
  '-O3',
  '-flto',
  '-DNDEBUG',
  '-c',
  join(out, 'driver.c'),
  '-I',
  resolve('tools/native'),
  '-o',
  join(out, 'frontend.o'),
]);
const exports = [
  'frontend_abi',
  'frontend_parse',
  'frontend_state',
  'frontend_specs',
  'frontend_view',
  'frontend_view_length',
  'frontend_close',
  'malloc',
  'free',
];
tool(clang.wasmLd, [
  join(out, 'frontend.o'),
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
  '-o',
  join(out, 'frontend.wasm'),
]);
const wasm = await readFile(join(out, 'frontend.wasm'));
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(wasm)), []);
await writeReport(join(out, 'build.json'), {
  scope:
    'Candidate A0 source frontend built from shared compiler modules. Public TypeScript C backend bootstraps this artifact. No official source cutover or performance claim.',
  entry: 'compiler/source_frontend.a0',
  sourceSHA256: hash(source),
  cSHA256: hash(c),
  wasmSHA256: hash(wasm),
  driverSHA256: hash(driver),
  functions: linked.program.functions.length,
  aggregateBytes: 4096,
  stackBytes: 16777216,
  wasmBytes: wasm.length,
  modules: await Promise.all(
    linked.sources.map(async ({ path }) => ({
      path: relative(process.cwd(), path),
      sha256: hash(await readFile(path)),
    })),
  ),
  clang: tool(clang.path, ['--version']).split('\n')[0],
  linker: tool(clang.wasmLd, ['--version']).split('\n')[0],
});
console.log(`Built candidate frontend from compiler modules: ${wasm.length} Wasm bytes`);
