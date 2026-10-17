import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-evaluator');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-evaluator-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    assert.ok(seed.clang.path);
    const linked = await link(join(fixtures, 'probe.a0'), (path) => readFile(path, 'utf8'));
    const emitted = emitChunked(formatProgram(linked.program), (chunk, bounds) =>
      runStageChunk(seed.exe, chunk, bounds),
    );
    assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const result = (name: string): string => {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      return type;
    };
    const page = /a0_ae_empty\((a0t\d+) p0/.exec(emitted.text)?.[1];
    const vector = /a0_ae_run_begin\(a0t\d+ p0, uint32_t p1, (a0t\d+) p2/.exec(emitted.text)?.[1];
    assert.ok(page && vector);
    await writeFile(
      join(dir, 'api.h'),
      `#define AE_STATE ${result('ae_empty')}\n#define AE_PAGE ${page}\n#define AE_VEC ${vector}\n#define AE_PAIR ${result('ae_fsub')}\n`,
    );
    const exe = join(dir, 'evaluator');
    const built = runTool(
      seed.clang.path,
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Wno-unused-parameter',
        '-Werror',
        '-fsanitize=undefined',
        '-fno-sanitize-recover=all',
        '-I',
        dir,
        '-I',
        runtime,
        join(fixtures, 'driver.c'),
        join(runtime, 'arena_runtime.c'),
        '-o',
        exe,
      ],
      { cwd: dir, timeoutMs: 180_000 },
    );
    assert.ok(built.ok, built.stderr);
    return exe;
  })();
  return prepared;
}

async function compare(group: string): Promise<void> {
  const exe = await prepare();
  const ran = runTool(process.execPath, [join(fixtures, 'oracle.mjs'), exe, group], {
    timeoutMs: 180_000,
  });
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}

test(
  'seed-built arena evaluator preserves checked arithmetic, aliases and exact fuel',
  { skip },
  async () => compare('core'),
);
test(
  'seed-built arena evaluator preserves IEEE budgets, strict traps and IO effects once',
  { skip },
  async () => compare('budgets-io'),
);
test(
  'seed-built arena evaluator keeps full-width frames, values and original trap chains',
  { skip },
  async () => compare('capacity'),
);
test(
  'seed-built arena evaluator preserves spec values, immutable contract views and explicit failures',
  { skip },
  async () => compare('boundaries'),
);
