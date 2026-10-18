import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { findClang, runTool } from '../src/toolchain.js';
import { buildNativeArenaCompiler } from './helpers/native-arena-compiler.js';

// Bootstrap linking/planning uses TS. Every per-request parse/check/spec/lowering
// decision and every target C byte is produced by the verified-seed A0 service.
const clang = findClang();
const skip =
  clang.path === undefined
    ? 'clang is unavailable'
    : process.platform === 'win32'
      ? 'generic filesystem transport requires POSIX'
      : false;
const fixtures = resolve('test/fixtures/arena-source-c');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-source-c-'));
    scratch = dir;
    const built = await buildNativeArenaCompiler({
      module: 'compiler/c_service_arena.a0',
      roots: [
        'arena_c_source_begin',
        'arena_c_source_resume',
        'arena_c_source_done',
        'arena_c_source_status',
        'arena_c_source_result',
        'arena_c_source_publish',
      ],
      driver: join(fixtures, 'driver.c'),
      apiHeader: (c) => {
        const type = (name: string): string => {
          const found = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(c)?.[1];
          assert.ok(found, name);
          return found;
        };
        return [
          `#define C_STATE ${type('arena_c_source_begin')}`,
          `#define C_RESULT ${type('arena_c_source_result')}`,
          `#define C_STATUSIO ${type('arena_c_source_publish')}`,
          '',
        ].join('\n');
      },
      dir,
      clang,
    });
    return built.exe;
  })();
  return prepared;
}

async function compare(group: string): Promise<void> {
  const exe = await prepare();
  assert.ok(scratch && clang.path);
  const dir = join(scratch, group);
  await mkdir(dir);
  const ran = runTool(process.execPath, [join(fixtures, `${group}.mjs`), exe, dir, clang.path], {
    timeoutMs: 360_000,
  });
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
  const report = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8')) as {
    status: string;
    rows: unknown[];
  };
  assert.equal(report.status, 'passed');
  assert.ok(report.rows.length > 0);
}

test(
  'raw-source arena C preserves ordered verification and independent native execution semantics',
  { skip, timeout: 900_000 },
  async () => compare('source'),
);
test(
  'raw-source arena C crosses legacy metadata ceilings and refuses unsupported/resource failures',
  { skip, timeout: 900_000 },
  async () => compare('boundaries'),
);
test(
  'raw-source arena C preserves large construction field and element indices',
  { skip, timeout: 900_000 },
  async () => compare('large-construction'),
);
