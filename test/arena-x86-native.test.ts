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
const runtimeSkip =
  skip ||
  (process.platform !== 'linux' || process.arch !== 'x64'
    ? 'actual Linux x86-64 target execution requires a Linux x86-64 host'
    : false);
const fixtures = resolve('test/fixtures/arena-x86');
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
  const context = /^a0t\d+ a0_ax_emit_context\(a0_io \* p0, (a0t\d+) p1,/m.exec(c)?.[1];
  const vector = /^a0t\d+ a0_ew_emit\(a0_io \* p0, (a0t\d+) p1/m.exec(c)?.[1];
  assert.ok(context && vector);
  return `#define AX_STATE ${result('arena_x86_source_begin')}\n#define AX_RESULT ${result('ax_emit_context')}\n#define HELLO ${result('fs_hello')}\n#define COMMIT ${result('ew_emit')}\n#define CONTEXT ${context}\n#define VECTOR ${vector}\n`;
}
function prepare(): Promise<string> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-x86-'));
    scratch = dir;
    const built = await buildNativeArenaCompiler({
      module: 'compiler/x86_link_service_arena.a0',
      roots: [
        'arena_x86_source_begin',
        'arena_x86_source_pump',
        'arena_x86_link_begin',
        'ax_emit_context',
        'fs_hello',
        'arena_finish',
        'ew_emit',
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
  'seed-built arena x86 source service preserves ordered grammar/spec failures, pending, source cap and complete framing',
  { skip },
  async () => compare('boundaries'),
);
test(
  'seed-built arena x86 source/table assembly passes independent arithmetic, IO, checked records and aggregate ABI oracles with instruction fault control',
  { skip: runtimeSkip },
  async () => compare('semantic'),
);
test(
  'seed-built arena x86 crosses legacy function/node/operand/record ceilings and preserves language aggregate bounds',
  { skip: runtimeSkip },
  async () => compare('capacity'),
);
test(
  'seed-built arena x86 links through A0 with OS/root/cycle controls, configured IO layout and Darwin crossassembly',
  { skip: runtimeSkip },
  async () => compare('link-profiles'),
);
