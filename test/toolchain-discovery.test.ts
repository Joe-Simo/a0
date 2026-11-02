import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// A fresh process isolates environment and builtin interception from other tests.
// Only file existence is simulated; the production discovery function selects paths.
function discover(version: number, override = false): unknown {
  const prefix = `/opt/homebrew/opt/llvm@${version}/bin`;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const available = new Set(${JSON.stringify([
      `${prefix}/clang`,
      `${prefix}/wasm-ld`,
      '/explicit/clang',
      '/explicit/wasm-ld',
    ])});
    fs.existsSync = (path) => available.has(String(path));
    syncBuiltinESMExports();
    const { findWasmClang } = await import(${JSON.stringify(new URL('../src/toolchain.js', import.meta.url).href)});
    const result = findWasmClang();
    process.stdout.write(JSON.stringify({path:result.path,wasmLd:result.wasmLd}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: '',
      Path: '',
      A0_WASM_CLANG: override ? '/explicit/clang' : '',
      A0_WASM_LD: override ? '/explicit/wasm-ld' : '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const version of [18, 19, 20]) {
  test(`versioned LLVM ${version} discovers both Wasm compiler and linker`, () => {
    const prefix = `/opt/homebrew/opt/llvm@${version}/bin`;
    assert.deepEqual(discover(version), {
      path: `${prefix}/clang`,
      wasmLd: `${prefix}/wasm-ld`,
    });
  });
}

test('explicit Wasm toolchain paths retain precedence over versioned installations', () => {
  assert.deepEqual(discover(18, true), {
    path: '/explicit/clang',
    wasmLd: '/explicit/wasm-ld',
  });
});

function discoverSimavr(mode: string): unknown {
  const script = `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import {join, resolve, relative, sep} from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const mode = ${JSON.stringify(mode)};
    const prefix = resolve('simavr-fixture');
    const library = mode === 'direct' ? join(prefix, 'lib') : join(prefix, 'lib', 'host-multiarch');
    const pkg = join(prefix, 'bin', 'pkg-config' + (process.platform === 'win32' ? '.EXE' : ''));
    const available = new Set([join(prefix, 'include', 'simavr', 'sim_avr.h')]);
    if (mode !== 'missing-library') available.add(join(library, 'libsimavr.a'));
    fs.existsSync = path => available.has(String(path));
    fs.statSync = path => { if (String(path) === pkg) return {isFile:()=>true}; throw new Error('absent'); };
    let queries = 0;
    cp.spawnSync = (path, args) => {
      queries++;
      if (String(path) !== pkg || mode === 'failed-metadata') return {status:1,stdout:'',stderr:'absent'};
      return {status:0,stdout:args[0] === '--variable=prefix' ? (mode === 'foreign-prefix' ? resolve('other') : prefix) : library,stderr:''};
    };
    process.env.PATH = join(prefix, 'bin');
    process.env.Path = process.env.PATH;
    process.env.PATHEXT = '.EXE';
    process.env.A0_SIMAVR_PREFIX = prefix;
    syncBuiltinESMExports();
    const {findSimavr} = await import(${JSON.stringify(new URL('../src/toolchain.js', import.meta.url).href)});
    const found = findSimavr();
    console.log(JSON.stringify({found:found.prefix===prefix,library:found.libraryDirectory === undefined ? null : relative(prefix,found.libraryDirectory).split(sep).join('/'),queries}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('simavr discovers a matching pkg-config multiarch library', () => {
  assert.deepEqual(discoverSimavr('metadata'), {
    found: true,
    library: 'lib/host-multiarch',
    queries: 2,
  });
});

test('simavr retains direct prefix precedence without consulting metadata', () => {
  assert.deepEqual(discoverSimavr('direct'), { found: true, library: 'lib', queries: 0 });
});

for (const mode of ['foreign-prefix', 'missing-library', 'failed-metadata'])
  test(`simavr refuses ${mode}`, () => {
    const result = discoverSimavr(mode) as { found: boolean; library: string | null };
    assert.equal(result.found, false);
    assert.equal(result.library, null);
  });
