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
