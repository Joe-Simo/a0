/** Build the candidate A0 frontend from compiler modules, using generic arena transport. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { C_LARGE_BYTES, COMPILER_VERSION, compile } from '../src/backends.js';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findWasmClang, runTool } from '../src/toolchain.js';
import { writeReport } from './scrub-results.js';
import {
  nativeCompileCommandSHA256,
  nativeCompileInputs,
  sourceCompilerInputs,
  sourceFunctionSignatures,
} from './source-compiler-inputs.js';

const options = new Map(
  process.argv.slice(2).map((arg) => {
    const at = arg.indexOf('=');
    assert.ok(at > 2, 'arguments use --name=value');
    return [arg.slice(2, at), arg.slice(at + 1)];
  }),
);
for (const name of options.keys())
  assert.ok(
    [
      'out',
      'sysroot',
      'builtins',
      'wasm-features',
      'symbols',
      'opt-level',
      'diagnostic-ports',
    ].includes(name),
    `unknown argument ${name}`,
  );
for (const name of ['out', 'sysroot', 'builtins'])
  assert.ok(options.get(name), `required: --${name}=PATH`);
const wasmFeatures = options.get('wasm-features') ?? 'mvp';
assert.ok(
  ['mvp', 'bulk-memory'].includes(wasmFeatures),
  'wasm-features must be mvp or bulk-memory',
);
const optimization = options.get('opt-level') ?? 'O3';
assert.ok(['O2', 'O3', 'Os', 'Oz'].includes(optimization), 'opt-level must be O2, O3, Os or Oz');
const symbols = options.get('symbols') ?? 'strip';
assert.ok(['strip', 'keep'].includes(symbols), 'symbols must be strip or keep');
const featureFlags = wasmFeatures === 'bulk-memory' ? ['-mbulk-memory'] : [];
const diagnosticPorts = options.get('diagnostic-ports') ?? 'disabled';
assert.ok(
  ['disabled', 'arena-v1'].includes(diagnosticPorts),
  'diagnostic-ports must be disabled or arena-v1',
);
const diagnosticFlags = diagnosticPorts === 'arena-v1' ? ['-DA0_FRONTEND_DIAGNOSTIC_PORTS'] : [];
const out = resolve(options.get('out') as string);
const sysroot = resolve(options.get('sysroot') as string);
const builtins = resolve(options.get('builtins') as string);
const clang = findWasmClang();
assert.ok(clang.path && clang.wasmLd, 'Wasm clang and wasm-ld are required');
const nativeEnvironment = { ...process.env };
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const compiler = await sourceCompilerInputs(process.cwd());
const frontendOptions = { cIo: 'host', optimize: true } as const;
const linked = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const frontendFunctions = sourceFunctionSignatures(linked.program, [
  'arena_parse_verify_begin',
  'arena_source_unit',
  'arena_verify_resume',
  'arena_verify_status',
  'arena_verify_begin',
  'source_ir_init',
  'source_ir_symbol',
  'source_ir_type',
]);
const source = formatProgram(linked.program);
const c = compile(linked.program, 'c', frontendOptions).text;
const normal = /^(a0t_[A-Za-z0-9_]+) a0_arena_verify_begin\(/m.exec(c);
const large = /^void a0_arena_verify_begin\((a0t_[A-Za-z0-9_]+) \*out/m.exec(c);
assert.ok(normal || large, 'unsupported C ABI');
const stateType = (normal ?? large)?.[1];
assert.ok(stateType);
const irStateType = /^(a0t_[A-Za-z0-9_]+) a0_source_ir_init\(/m.exec(c)?.[1];
const irResultType = /^(a0t_[A-Za-z0-9_]+) a0_source_ir_symbol\(/m.exec(c)?.[1];
assert.ok(irStateType && irResultType, 'unsupported IR construction ABI');
await mkdir(out, { recursive: true });
const driver = await readFile('tools/native/source_frontend.c', 'utf8');
await writeFile(join(out, 'module.c'), c);
await writeFile(join(out, 'driver.c'), driver);
await writeFile(
  join(out, 'api.h'),
  `#define SV_STATE ${stateType}
#define IR_STATE ${irStateType}
#define IR_RESULT ${irResultType}
#define FRONTEND_BEGIN(s,t,h,n) ${normal ? '((s)=a0_arena_parse_verify_begin((t),(h),(n)))' : 'a0_arena_parse_verify_begin(&(s),(t),(h),(n))'}
#define FRONTEND_UNIT(s,t,h,n) ${normal ? '((s)=a0_arena_source_unit((t),(h),(n)))' : 'a0_arena_source_unit(&(s),(t),(h),(n))'}
#define FRONTEND_RESUME(s,n) ${normal ? '((s)=a0_arena_verify_resume((s),(n)))' : 'a0o_arena_verify_resume(&(s),(n))'}
#define FRONTEND_STATUS(m) ${normal ? 'a0_arena_verify_status(m)' : 'a0_arena_verify_status(&(m))'}
`,
);
function checkedTool(path: string, args: string[]) {
  const result = runTool(path, args, { timeoutMs: 300_000, env: nativeEnvironment });
  assert.ok(result.ok, `${path}: ${result.stderr}`);
  return result;
}
const tool = (path: string, args: string[]) => checkedTool(path, args).stdout.trim();
const compileFlags = [
  '--target=wasm32-wasi',
  `--sysroot=${sysroot}`,
  `-${optimization}`,
  ...featureFlags,
  '-flto',
  '-DNDEBUG',
  ...diagnosticFlags,
  '-v',
  '-H',
  '-c',
  join(out, 'driver.c'),
  '-I',
  resolve('tools/native'),
  '-o',
  join(out, 'frontend.o'),
];
const roots = {
  checkout: process.cwd(),
  artifact: out,
  sysroot,
  resource: tool(clang.path, ['-print-resource-dir']),
};
const compiled = checkedTool(clang.path, compileFlags);
const compileInputs = await nativeCompileInputs(compiled.stderr, roots);
const exports = [
  'frontend_ir_init',
  'frontend_ir_upload',
  'frontend_ir_symbol',
  'frontend_ir_type',
  'frontend_ir_state',
  'frontend_ir_value',
  'frontend_ir_finish',
  'frontend_status',
  'frontend_abi',
  'frontend_parse',
  'frontend_parse_unit',
  'frontend_state',
  'frontend_specs',
  'frontend_view',
  'frontend_view_length',
  'frontend_close',
  'malloc',
  'free',
  ...(diagnosticPorts === 'arena-v1'
    ? ['a0_runtime_read', 'a0_runtime_write', 'frontend_arena_token']
    : []),
];
const linkerFlags = [
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
  ...(symbols === 'strip' ? ['--strip-all'] : []),
  '-o',
  join(out, 'frontend.wasm'),
];
tool(clang.wasmLd, linkerFlags);
const portableFlags = (flags: readonly string[]) =>
  flags.map((flag) =>
    flag
      .replaceAll(builtins, '<builtins>')
      .replaceAll(out, '<artifact>')
      .replaceAll(sysroot, '<wasi-sysroot>')
      .replaceAll(process.cwd(), '<repo>'),
  );
const wasm = await readFile(join(out, 'frontend.wasm'));
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(wasm)), []);
await writeReport(join(out, 'build.json'), {
  scope:
    'Candidate A0 source frontend built from shared compiler modules. Public TypeScript C backend bootstraps this artifact. No official source cutover or performance claim.',
  entry: 'compiler/source_frontend.a0',
  frontendABI: 3,
  diagnosticPorts,
  frontendOptions,
  frontendFunctions,
  compilerVersion: COMPILER_VERSION,
  compilerInputs: compiler.inputs,
  compilerConfiguration: compiler.configuration,
  compilerBuild: compiler.build,
  compilerCheckout: compiler.checkout,
  nativeCompileInputs: compileInputs,
  effectiveCompileSHA256: nativeCompileCommandSHA256(compiled.stderr, roots),
  nativeInputs: await Promise.all(
    [
      'tools/native/source_frontend.c',
      'tools/native/arena_runtime.c',
      'tools/native/arena_runtime.h',
      'tools/source-native-build.ts',
    ].map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  ),
  libcSHA256: hash(await readFile(join(sysroot, 'lib/wasm32-wasi/libc.a'))),
  builtinsSHA256: hash(await readFile(builtins)),
  sourceSHA256: hash(source),
  cSHA256: hash(c),
  wasmSHA256: hash(wasm),
  driverSHA256: hash(driver),
  functions: linked.program.functions.length,
  clangFlags: [
    '--target=wasm32-wasi',
    `-${optimization}`,
    ...featureFlags,
    '-flto',
    '-DNDEBUG',
    ...diagnosticFlags,
  ],
  compileFlags: portableFlags(compileFlags),
  linkerFlags: portableFlags(linkerFlags),
  requiredWasmFeatures: wasmFeatures === 'bulk-memory' ? ['bulk-memory'] : [],
  optimization,
  symbols,
  symbolFlags: symbols === 'strip' ? ['--strip-all'] : [],
  compilerHost: 'Node >=22 or a WebAssembly engine supporting the recorded required features',
  aggregateBytes: C_LARGE_BYTES,
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
