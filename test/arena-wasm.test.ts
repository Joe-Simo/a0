import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { findClang, runTool } from '../src/toolchain.js';
import { buildNativeArenaCompiler } from './helpers/native-arena-compiler.js';

const clang = findClang();
const skip =
  clang.path === undefined
    ? 'clang is unavailable'
    : process.platform === 'win32'
      ? 'generic filesystem transport requires POSIX'
      : false;
const fixtures = resolve('test/fixtures/arena-wasm');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function apiHeader(c: string): string {
  const result = (name: string): string => {
    const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(c)?.[1];
    assert.ok(type, name);
    return type;
  };
  return [
    `#define WASM_STATE ${result('arena_wasm_source_begin')}`,
    `#define WASM_STATUSIO ${result('arena_wasm_source_publish')}`,
    `#define WASM_OPTIONS ${result('arena_wasm_options')}`,
    '',
  ].join('\n');
}

function prepare(): Promise<string> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-wasm-'));
    scratch = dir;
    const built = await buildNativeArenaCompiler({
      module: 'compiler/wasm_service_arena.a0',
      roots: [
        'arena_wasm_source_begin',
        'arena_wasm_source_resume',
        'arena_wasm_source_done',
        'arena_wasm_source_status',
        'arena_wasm_source_publish',
        'arena_wasm_options',
      ],
      driver: join(fixtures, 'driver.c'),
      apiHeader,
      dir,
      clang,
    });
    return built.exe;
  })();
  return prepared;
}

async function compare(group: string): Promise<void> {
  const exe = await prepare();
  assert.ok(scratch);
  const dir = join(scratch, group);
  await mkdir(dir);
  const ran = runTool(process.execPath, [join(fixtures, `${group}.mjs`), exe, dir], {
    timeoutMs: 180_000,
  });
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}

test(
  'seed-built arena Wasm preserves ordered source/spec errors and checked canonical/strict runtime semantics',
  { skip },
  async () => compare('source'),
);
test(
  'seed-built arena Wasm crosses legacy array/function/type/global-node ceilings with original strict loop sites',
  { skip },
  async () => compare('boundaries'),
);
test(
  'seed-built arena Wasm preserves alias/sret/IO/trap semantics and explicit option/resource/framing failures',
  { skip },
  async () => compare('controls'),
);
test(
  'seed-built arena Wasm preserves text/boolean/many-argument ABI and predicate-first strict failures',
  { skip },
  async () => compare('abi'),
);
