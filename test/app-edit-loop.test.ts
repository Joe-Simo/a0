import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkStart, startPrograms } from '../tools/app-edit-bench.js';
import {
  BUDGET,
  execTool,
  readLog,
  SUBAGENT_PROMPT,
  scoreDir,
  setupTask,
  tok,
} from '../tools/app-edit-loop.js';
import { cell } from '../tools/app-edit-loop-summary.js';
import { APP_TASKS, type AppTask } from '../tools/app-edit-tasks.js';

const task = APP_TASKS[0] as AppTask;

async function fixture(): Promise<{
  root: string;
  programs: Awaited<ReturnType<typeof startPrograms>>;
  guide: string;
}> {
  const programs = await startPrograms();
  checkStart(programs);
  const guide = await readFile('MODEL_GUIDE.min.txt', 'utf8');
  return { root: await mkdtemp(join(tmpdir(), 'a0-loop-test-')), programs, guide };
}

test('app-edit loop: setup writes only the working files, the prompt is side-neutral', async () => {
  const { root, programs, guide } = await fixture();
  try {
    for (const side of ['a0', 'ts'] as const) {
      const dir = join(root, side);
      await setupTask(dir, side, task, programs, guide);
      const taskMd = await readFile(join(dir, 'TASK.md'), 'utf8');
      assert.ok(taskMd.includes(task.instruction));
      assert.ok(taskMd.includes('./tool apply'));
      // the hidden tests are not in what the subject sees
      for (const t of task.tests)
        if (t.kind !== 'same') assert.ok(!taskMd.includes(JSON.stringify(t.src)));
      const guideMd = await readFile(join(dir, 'GUIDE.md'), 'utf8');
      if (side === 'a0') assert.ok(guideMd.startsWith(guide.trimEnd()));
      else assert.ok(!guideMd.includes('A0:'));
      assert.deepEqual(await readLog(dir), []);
    }
    assert.ok(!SUBAGENT_PROMPT.includes('A0') && !SUBAGENT_PROMPT.includes('TypeScript'));
    assert.ok(SUBAGENT_PROMPT.includes(`at most ${BUDGET} tool runs`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app-edit loop: the reference through the tool passes, the start fails, every run is logged', async () => {
  const { root, programs, guide } = await fixture();
  try {
    for (const side of ['a0', 'ts'] as const) {
      const start = join(root, `${side}-start`);
      await setupTask(start, side, task, programs, guide);
      const s = await scoreDir(start, programs, guide);
      assert.equal(s.accepted, false);
      assert.equal(s.toolCalls, 0);
      assert.equal(s.modelCalls, 1);

      const dir = join(root, `${side}-ref`);
      await setupTask(dir, side, task, programs, guide);
      const lex = await execTool(dir, ['lex', '"a ;x\\n"'], '');
      assert.equal(lex.code, 0);
      assert.match(lex.output, /^\[\[1,0,1\]/);
      const bad = await execTool(dir, ['lex', 'not json'], '');
      assert.equal(bad.code, 2);
      const applied = await execTool(dir, ['apply'], task.reference[side]);
      assert.equal(applied.code, 0, applied.output);
      const r = await scoreDir(dir, programs, guide);
      assert.equal(r.accepted, true, r.failures.join('\n'));
      assert.equal(r.toolCalls, 3);
      assert.equal(r.modelCalls, 4);
      assert.deepEqual(r.applies, { tried: 1, accepted: 1 });
      // tokens: the commands and their stdin are output, the logged outputs are context
      const log = await readLog(dir);
      assert.equal(log.length, 3);
      assert.ok(r.tokenBucketsLocal.output >= tok(task.reference[side]));
      assert.ok(r.tokenBucketsLocal.toolContext >= log.reduce((a, e) => a + tok(e.output), 0));
      assert.ok(r.rereadTokensLocal.o200k_base > 4 * r.setupTokensLocal.o200k_base);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app-edit loop: a rejected edit changes nothing; editing outside the tool is caught', async () => {
  const { root, programs, guide } = await fixture();
  try {
    const dir = join(root, 'a0');
    await setupTask(dir, 'a0', task, programs, guide);
    const r = await execTool(dir, ['apply'], 'e0\nzz frob 1 2\n');
    assert.equal(r.code, 1);
    assert.match(r.output, /"code"/);
    assert.equal(await readFile(join(dir, 'front.a0'), 'utf8'), programs.a0);

    const ts = join(root, 'ts');
    await setupTask(ts, 'ts', task, programs, guide);
    const nothing = await execTool(
      ts,
      ['apply'],
      '--- a/front.ts\n+++ b/front.ts\n@@ -1 +1 @@\n-nope\n+x\n',
    );
    assert.match(nothing.output, /^Nothing was applied/);
    await writeFile(join(ts, 'front.ts'), programs.ts.replace(/;/, ';;'), 'utf8');
    const s = await scoreDir(ts, programs, guide);
    assert.equal(s.editedOutsideTool, true);
    assert.equal(s.accepted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app-edit loop: the budget refuses the run after the last, and the summary cell counts it', async () => {
  const { root, programs, guide } = await fixture();
  try {
    const dir = join(root, 'ts');
    await setupTask(dir, 'ts', task, programs, guide);
    for (let i = 0; i < BUDGET; i += 1) assert.equal((await execTool(dir, ['help'], '')).code, 0);
    const over = await execTool(dir, ['apply'], task.reference.ts);
    assert.equal(over.code, 3);
    assert.match(over.output, /^refused/);
    const t = await scoreDir(dir, programs, guide);
    assert.equal(t.accepted, false);
    assert.equal(t.toolCalls, BUDGET);
    assert.equal(t.refusedCalls, 1);
    const c = cell([t, { ...t, accepted: true, failures: [] }]);
    assert.equal(c.accepted.k, 1);
    assert.equal(c.budgetExhausted, 2);
    assert.ok((c.tokensPerAcceptedEdit.session10 ?? 0) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
