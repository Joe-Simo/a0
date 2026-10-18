import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseAndValidate } from '../src/core.js';
import { applicationReply, applicationRuntime } from '../tools/app-edit-application-runtime.js';
import {
  APPLICATION_PACKET_DIRECTORY,
  approvedApplicationSources,
} from '../tools/app-edit-application-sources.js';
import { controlReply, prompt, startPrograms } from '../tools/app-edit-bench.js';
import { sentinelState } from '../tools/app-edit-sentinel-oracle.js';
import { applicationUiContents } from '../tools/app-edit-sitegen-oracle.js';
import { APP_TASKS } from '../tools/app-edit-tasks.js';

async function scratch() {
  const root = resolve('.a0-tmp');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'application-test-'));
}

test('application historical import binds the complete source manifest before any reader', async () => {
  const sources = await approvedApplicationSources();
  const sentinel = await sources.historical('sentinel');
  assert.equal(sentinel.program.functions.length, 188);
  assert.throws(() => sources.text('../outside.a0'), /outside approved/);
  const root = await scratch();
  try {
    await cp(APPLICATION_PACKET_DIRECTORY, root, { recursive: true });
    await writeFile(join(root, 'source/site/sentinel/env.a0'), 'not A0 source');
    await assert.rejects(approvedApplicationSources(root), /source differs from approved/);
    await writeFile(join(root, 'source-manifest.json'), '{}');
    await assert.rejects(approvedApplicationSources(root), /manifest differs from approved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native historical control derivation refuses an unapproved source before parsing', () => {
  const task = APP_TASKS[0];
  assert.ok(task);
  assert.throws(
    () => controlReply(task, 'not source', task.reference.a0, 'native'),
    /outside the sealed task packet/,
  );
});

test('application child replies reject malformed framing, metadata, values and ownership', () => {
  const valid = {
    calls: [{ value: 0, position: 1, output: [7], inputUnchanged: true }],
    node: 'v24.0.0',
    peakRssKiB: 1,
  };
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  assert.deepEqual(applicationReply(bytes(valid), [[2]]), valid);
  for (const value of [
    null,
    {},
    { ...valid, calls: [] },
    { ...valid, node: 4 },
    { ...valid, calls: [{ ...valid.calls[0], position: 2 }] },
    { ...valid, calls: [{ ...valid.calls[0], output: [-1] }] },
    { ...valid, calls: [{ ...valid.calls[0], output: [null] }] },
    { ...valid, calls: [{ ...valid.calls[0], inputUnchanged: false }] },
    { ...valid, calls: [{ ...valid.calls[0], value: 0.5 }] },
  ])
    assert.throws(() => applicationReply(bytes(value), [[2]]));
  assert.throws(() => applicationReply(Buffer.from('{'), [[2]]));
});

test('UI oracle rejects ignored late attributes and unknown tags instead of inventing rendered output', () => {
  const value = [120];
  assert.deepEqual(applicationUiContents([1, 5, 4, 7, 1, ...value, 2, 1, ...value, 3]).attributes, [
    [7, 'x'],
  ]);
  assert.throws(() => applicationUiContents([1, 5, 2, 1, ...value, 4, 7, 1, ...value, 3]), /late/);
  assert.throws(() => applicationUiContents([1, 999, 3]), /unknown UI tag/);
  assert.throws(() => applicationUiContents([1, 5, 4, 999, 0, 3]), /unknown UI attribute/);
  assert.throws(() => applicationUiContents([1, 5, 2, 2, 65, 3]), /bounds|unclosed/);
  assert.throws(() => applicationUiContents([1, 5, 2, 1, 256, 3]), /byte range/);
  assert.throws(() => applicationUiContents([1, 5]), /unclosed/);
  assert.equal(applicationUiContents([1, 5], 1).rendered.html, '<div></div>');
});

test('Sentinel oracle rejects truncated host commands before the tolerant browser decoder', () => {
  const state = Array<number>(1024).fill(0);
  const reply = (output: number[]) => ({ value: 0, position: 1729, inputUnchanged: true, output });
  assert.deepEqual(sentinelState(reply([1, 1024, ...state])), state);
  for (const output of [
    [1, 4096, ...state],
    [1, 1024, ...state.slice(1)],
    [1, 1024, ...state, 2, 1, 99, 65],
    [1, 1024, ...state, 3],
    [1, 1024, ...state, 1, 1024, ...state],
    [1, 1024, ...state, 2, 1, 1, 256],
    [1, 1024, ...state, 16, 999],
  ])
    assert.throws(() => sentinelState(reply(output)));
});

test('fixed generated-JS execution preserves IO and closes its own runtime', async () => {
  const runtime = await applicationRuntime();
  const program = parseAndValidate(
    'fn session io -> u32\nr read p0\nx at r 0\nt at r 1\nw write t x\nret x\nend\n',
  );
  try {
    const result = await runtime.execute(program, 'session', [[42]]);
    assert.deepEqual(result, [{ value: 42, position: 1, output: [42], inputUnchanged: true }]);
    await assert.rejects(runtime.execute(program, 'missing', [[42]]), /process failed/);
    assert.deepEqual(await runtime.execute(program, 'session', [[42]]), result);
    await assert.rejects(runtime.execute(program, 'session', []), /call count limit/);
    await assert.rejects(
      runtime.execute(
        program,
        'session',
        Array.from({ length: 513 }, () => [42]),
      ),
      /call count limit/,
    );
    await assert.rejects(runtime.execute(program, 'session', [[-1]]), /invalid application input/);
  } finally {
    await runtime.close();
  }
  await runtime.close();
  await assert.rejects(runtime.execute(program, 'session', [[42]]), /closed/);
});

// Exact baseline output, computed from the untouched fcf07028 harness before this seam.
test('application packet leaves all 28 historical default prompt bytes unchanged', async () => {
  const programs = await startPrograms();
  const guide = 'fixed legacy prompt regression guide';
  const dump = Object.fromEntries(
    APP_TASKS.flatMap((task) =>
      (['a0', 'ts'] as const).map((side) => [
        `${task.id}/${side}`,
        prompt(side, task, programs, guide),
      ]),
    ),
  );
  assert.equal(
    createHash('sha256').update(JSON.stringify(dump)).digest('hex'),
    'baed0e951c521bb8ef8911bd877f9d071ed496c83521617f475d2d216f5c6831',
  );
});

test('runtime initialization refuses a non-directory without changing it', async () => {
  const root = await scratch();
  const file = join(root, 'not-a-directory');
  try {
    await writeFile(file, 'preserved');
    await assert.rejects(applicationRuntime(file));
    assert.equal(await readFile(file, 'utf8'), 'preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
