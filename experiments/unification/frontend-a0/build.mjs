import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAndValidate } from '../../../dist/src/core.js';
import { compile } from '../../../dist/src/backends.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = new Map(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('=');
  assert.ok(at > 2, 'arguments use --name=value');
  return [arg.slice(0, at), arg.slice(at + 1)];
}));
for (const name of ['--out', '--sysroot', '--builtins']) assert.ok(args.get(name), `required: ${name}=PATH`);
for (const name of args.keys()) assert.ok(['--out','--sysroot','--builtins','--clang','--wasm-ld','--aggregate-bytes'].includes(name), `unknown argument ${name}`);
const out = resolve(args.get('--out'));
const threshold = Number(args.get('--aggregate-bytes') ?? 4096);
assert.ok(threshold === 4096 || threshold === 256, 'only the recorded default and private experimental thresholds are supported');
mkdirSync(out, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const source = readFileSync(join(here, 'frontend.ir-v1.txt'), 'utf8');
const program = parseAndValidate(source); // Explicit frozen bootstrap IR-v1, never user source.
let backend = compile;
if (threshold !== 4096) {
  // A research backend parameter, not another source parser or a production option.
  const { default: ts } = await import('typescript');
  const before = readFileSync(join(repo, 'src/backends.ts'), 'utf8');
  const needle = 'export const C_LARGE_BYTES = 4096;';
  assert.equal(before.split(needle).length, 2, 'backend changed: review this experiment before rerunning');
  const text = ts.transpileModule(before.replace(needle, `export const C_LARGE_BYTES = ${threshold};`), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 },
  }).outputText.replaceAll("from './", `from '${pathToFileURL(join(repo, 'dist/src/')).href}`)
    .replaceAll("import('./", `import('${pathToFileURL(join(repo, 'dist/src/')).href}`);
  const file = join(out, 'research-backend.mjs');
  writeFileSync(file, text);
  backend = (await import(pathToFileURL(file).href)).compile;
}
const c = backend(program, 'c', { cIo: 'host' }).text;
const normal = /^(a0t_[A-Za-z0-9_]+) a0_arena_verify_begin\(/m.exec(c);
const large = /^void a0_arena_verify_begin\((a0t_[A-Za-z0-9_]+) \*out/m.exec(c);
assert.ok(normal || large, 'unsupported C ABI');
writeFileSync(join(out, 'module.c'), c);
writeFileSync(join(out, 'driver.c'), readFileSync(join(here, 'driver.c')));
writeFileSync(join(out, 'api.h'), `#define SV_STATE ${(normal ?? large)[1]}
#define FRONTEND_BEGIN(s,t,h,n) ${normal ? '((s)=a0_arena_parse_verify_begin((t),(h),(n)))' : 'a0_arena_parse_verify_begin(&(s),(t),(h),(n))'}
#define FRONTEND_RESUME(s,n) ${normal ? '((s)=a0_arena_verify_resume((s),(n)))' : 'a0o_arena_verify_resume(&(s),(n))'}
#define FRONTEND_STATUS(m) ${normal ? 'a0_arena_verify_status(m)' : 'a0_arena_verify_status(&(m))'}
`);
function tool(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command}: ${result.error ?? ''}\n${result.stderr}`);
  return result.stdout.trim();
}
const clang = args.get('--clang') ?? 'clang', ld = args.get('--wasm-ld') ?? 'wasm-ld';
const sysroot = resolve(args.get('--sysroot')), builtins = resolve(args.get('--builtins'));
tool(clang, ['--target=wasm32-wasi', `--sysroot=${sysroot}`, '-O3','-flto','-DNDEBUG','-c', join(out,'driver.c'), '-I',join(repo,'tools/native'),'-o',join(out,'frontend.o')]);
const exports = ['frontend_parse','frontend_state','frontend_specs','frontend_view','frontend_view_length','frontend_close','malloc','free'];
tool(ld, [join(out,'frontend.o'),'-L',join(sysroot,'lib/wasm32-wasi'),'-lc',builtins,'--no-entry',...exports.map(name => `--export=${name}`),'--export-memory','-z','stack-size=16777216','--lto-O3','-o',join(out,'frontend.wasm')]);
const wasm = readFileSync(join(out,'frontend.wasm'));
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(wasm)), []);
writeFileSync(join(out,'build.json'), JSON.stringify({
  scope: 'Research prototype only. Same frozen A0 frontend, generic C arena transport, no Wasm imports. Public C backend builds this artifact; this is not entirely A0-bootstrapped. No production syntax cutover or performance eligibility.',
  sourceSHA256:sha(source), cSHA256:sha(c), wasmSHA256:sha(wasm), functions:program.functions.length,
  aggregateBytes:threshold, stackBytes:16777216, wasmBytes:wasm.length,
  clang:tool(clang,['--version']), linker:tool(ld,['--version']),
},null,2)+'\n');
console.log(`Built ${program.functions.length} A0 functions; ${wasm.length} Wasm bytes. Run proof.mjs with --artifact=${out}`);
