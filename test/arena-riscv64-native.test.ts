import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, type TestContext, test } from 'node:test';
import { findClang, runTool } from '../src/toolchain.js';
import { buildNativeArenaCompiler } from './helpers/native-arena-compiler.js';
import { crossLinkUnavailable } from './helpers/native-port-model.js';

const clang = findClang();
const skip =
  clang.path === undefined
    ? 'clang is unavailable'
    : process.platform === 'win32'
      ? 'generic filesystem transport requires POSIX'
      : false;
const fixtures = resolve('test/fixtures/arena-riscv64');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
let crossUnavailable: Promise<string | false> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});
function apiHeader(c: string): string {
  const result = (name: string): string => {
    const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(c)?.[1];
    assert.ok(type, name);
    return type;
  };
  const context = /^a0t\d+ a0_arena_riscv64_emit_context\(a0_io \* p0, (a0t\d+) p1,/m.exec(c)?.[1];
  const page = /^a0t\d+ a0_arena_riscv64_emit_context\(a0_io \* p0, a0t\d+ p1, (a0t\d+) p2,/m.exec(
    c,
  )?.[1];
  const vector = /^a0t\d+ a0_ew_emit\(a0_io \* p0, (a0t\d+) p1/m.exec(c)?.[1];
  assert.ok(context && vector && page);
  return `#define AX_STATE ${result('arena_riscv64_source_begin')}\n#define AX_LINK ${result('arena_riscv64_link_begin')}\n#define PAGE ${page}\n#define AX_RESULT ${result('arena_riscv64_emit_context')}\n#define HELLO ${result('fs_hello')}\n#define COMMIT ${result('ew_emit')}\n#define CONTEXT ${context}\n#define VECTOR ${vector}\n`;
}
function prepare(): Promise<string> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-riscv64-'));
    scratch = dir;
    const built = await buildNativeArenaCompiler({
      module: 'compiler/riscv64_link_service_arena.a0',
      roots: [
        'arena_riscv64_source_begin',
        'arena_riscv64_source_pump',
        'arena_riscv64_link_begin',
        'arena_riscv64_link_pump',
        'arena_riscv64_emit_context',
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
  await mkdir(join(dir, 'tests'), { recursive: true });
  const ran = runTool(
    process.execPath,
    [join(fixtures, `${group}.mjs`), exe, dir, clang.path ?? 'clang'],
    {
      timeoutMs: 180_000,
    },
  );
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}
test(
  'seed-built arena RISC-V64 preserves ordered grammar/spec errors, framing, source bounds and explicit refusals',
  { skip },
  async () => compare('boundaries'),
);
test(
  'seed-built arena RISC-V64 source/table passes independent BigInt, checked, aggregate and ABI instruction models with faults',
  { skip },
  async (t) => compareModel('semantic', t),
);
test(
  'seed-built arena RISC-V64 strict preserves original frames, trip, first trap and external host ABI record',
  { skip },
  async (t) => compareModel('strict', t),
);
test(
  'seed-built arena RISC-V64 crosses legacy function/node/operand/record ceilings and preserves semantic bounds',
  { skip },
  async (t) => compareModel('capacity', t),
);
test(
  'seed-built arena RISC-V64 composes ordered linked verification and retains source origins and terminal states',
  { skip },
  async (t) => compareModel('link', t),
);
test(
  'seed-built arena RISC-V64 deep records and sret alias survive wide frames and distant strict branches',
  { skip },
  async (t) => compareModel('geometry', t),
);

async function compareModel(group: string, t: TestContext): Promise<void> {
  await prepare();
  assert.ok(scratch);
  crossUnavailable ??= crossLinkUnavailable('riscv64', clang, scratch);
  const missing = await crossUnavailable;
  if (missing) {
    t.skip(missing);
    return;
  }
  await compare(group);
}
