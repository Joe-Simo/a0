import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkStart, startPrograms } from '../tools/app-edit-bench.js';
import {
  execTool,
  programViews,
  readLog,
  SUBAGENT_PROMPT,
  scoreDir,
  setupTask,
  setupWordingTask,
  toolHelp,
  WORDING_PROMPT,
  wordingFlags,
  wordingTexts,
} from '../tools/app-edit-loop.js';
import { APP_TASKS, type AppTask } from '../tools/app-edit-tasks.js';
import { wordingCell, wordingRule } from '../tools/app-edit-wording-summary.js';

const task = APP_TASKS[0] as AppTask;

test('app-edit wording: the current variant is the shipped text, the revised one differs only on the view', async () => {
  const cur = wordingTexts('current');
  const rev = wordingTexts('revised');
  assert.equal(cur.skill, await readFile('skills/a0/SKILL.md', 'utf8'));
  const mcp = await readFile('src/mcp.ts', 'utf8');
  // the shipped descriptions, as written in src/mcp.ts (string literals, quotes escaped there)
  assert.ok(mcp.includes(`'${cur.open}'`), 'a0_open description drifted');
  assert.ok(mcp.includes(`'${cur.program}'`), 'a0_program description drifted');
  assert.equal(rev.open, cur.open);
  assert.notEqual(rev.program, cur.program);
  const curLines = cur.skill.split('\n');
  const revLines = rev.skill.split('\n');
  assert.equal(curLines.length, revLines.length);
  const changed = curLines.filter((l, i) => l !== revLines[i]);
  assert.equal(changed.length, 1);
  assert.match(changed[0] ?? '', /a0_program` for whole-program work/);
});

test('app-edit wording: setup writes the instruction alone, the variant skill and help; scoring logs program views', async () => {
  const programs = await startPrograms();
  checkStart(programs);
  const guide = await readFile('MODEL_GUIDE.min.txt', 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'a0-wording-test-'));
  try {
    for (const variant of ['current', 'revised'] as const) {
      const dir = join(root, variant);
      await setupWordingTask(dir, task, programs, guide, variant);
      assert.equal(await readFile(join(dir, 'TASK.md'), 'utf8'), `# Task\n\n${task.instruction}\n`);
      assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), wordingTexts(variant).skill);
      const loop = join(root, `${variant}-loop`);
      await setupTask(loop, 'a0', task, programs, guide);
      assert.equal(
        await readFile(join(dir, 'GUIDE.md'), 'utf8'),
        await readFile(join(loop, 'GUIDE.md'), 'utf8'),
      );
      const start = await scoreDir(dir, programs, guide);
      assert.equal(start.accepted, false);
      assert.equal(start.variant, variant);
      assert.deepEqual(start.programViews, []);

      const help = await execTool(dir, ['help'], '');
      assert.ok(help.output.includes(wordingTexts(variant).program));
      assert.ok(help.output.includes('No handle is open at the start.'));
      // the reference through the tool: open the handles the loop arm opens at the start
      for (const f of task.a0Targets) assert.equal((await execTool(dir, ['view', f], '')).code, 0);
      assert.equal((await execTool(dir, ['program', task.a0Targets[0] as string], '')).code, 0);
      assert.equal((await execTool(dir, ['program'], '')).code, 0);
      const applied = await execTool(dir, ['apply'], task.reference.a0);
      assert.equal(applied.code, 0, applied.output);
      const r = await scoreDir(dir, programs, guide);
      assert.equal(r.accepted, true, r.failures.join('\n'));
      assert.deepEqual(r.programViews, [task.a0Targets[0], 'bare']);
      assert.deepEqual(programViews(await readLog(dir)), r.programViews);
      // the system part counts the prompt, GUIDE.md and the variant's SKILL.md
      assert.ok(r.setupTokensLocal.o200k_base > 0);
      const c = wordingCell([r, start]);
      assert.equal(c.bareListing.k, 1);
      assert.equal(c.accepted.k, 1);
    }
    // the loop arm is untouched: no variant fields, the same help
    const loop = await scoreDir(join(root, 'current-loop'), programs, guide);
    assert.equal(loop.variant, undefined);
    assert.equal(loop.programViews, undefined);
    const h = await execTool(join(root, 'current-loop'), ['help'], '');
    assert.ok(h.output.startsWith(toolHelp('a0').split('<HANDLES>')[0] as string));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app-edit wording: prompt, flags and the pre-registered rule', () => {
  assert.notEqual(WORDING_PROMPT, SUBAGENT_PROMPT);
  assert.ok(WORDING_PROMPT.includes('<dir>/SKILL.md'));
  assert.deepEqual(wordingFlags(['out', 'a0']), { args: ['out', 'a0'] });
  assert.deepEqual(wordingFlags(['out', 'a0', '--arm', 'wording', '--variant', 'revised']), {
    args: ['out', 'a0'],
    variant: 'revised',
  });
  assert.throws(() => wordingFlags(['--arm', 'wording', '--variant', 'other']));
  assert.throws(() => wordingFlags(['--arm', 'deps', '--variant', 'current']));
  assert.equal(wordingRule({ accepted: 9, cost: 100 }, { accepted: 8, cost: 90 }).pass, true);
  assert.equal(wordingRule({ accepted: 9, cost: 100 }, { accepted: 7, cost: 50 }).pass, false);
  assert.equal(wordingRule({ accepted: 9, cost: 100 }, { accepted: 12, cost: 100 }).pass, false);
  assert.equal(
    wordingRule({ accepted: 9, cost: 100 }, { accepted: 0, cost: Number.NaN }).pass,
    false,
  );
});
