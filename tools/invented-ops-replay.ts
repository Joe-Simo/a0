/**
 * Deterministic replay of recorded replies through the exact fixes (evidence about the fixes, not a model measurement).
 *
 *   bun tools/invented-ops-replay.ts      writes results/invented-ops-replay.json
 *
 * For every recorded cell (the V3 and V4 arms on set Z, the V3 arm on set Y, the canonical arm on set X), each recorded
 * reply of each task is applied to the task's starting program in the harness's own session (`fix all`: the exact fixes of
 * its diagnostics are applied until the checker accepts the reply or a diagnostic has no exact fix). The replies, so
 * rewritten, are scored by the repository's scorer (`tools/ai-edit-experiment.ts` with scripted replies, the arm's own
 * settings), and compared with the recorded report: tasks accepted before, tasks accepted with the fixes applied, and for
 * the tasks that changed which exact-fix rules did it. A reply the fixes do not change is passed on unchanged, so a task
 * can only change through a rule that fired. This applies the fixes to replies a model wrote WITHOUT them: the model's
 * own repair after seeing the new diagnostic is not simulated and no model is called.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAndValidate } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { fixAll } from '../src/fix.js';
import { extractBlock } from './ai-edit-apply.js';
import { TASKS_X } from './ai-edit-tasks-x.js';
import { TASKS_Y } from './ai-edit-tasks-y.js';
import { TASKS_Z } from './ai-edit-tasks-z.js';
import { writeReport } from './scrub-results.js';

/** The rules added by this change; any other rule that fired is a rule that already existed. */
const NEW_RULES = new Set(['symbol', 'chain', 'not', 'max', 'min']);

interface Cell {
  readonly set: 'x' | 'y' | 'z';
  readonly model: string;
  readonly arm: string;
  readonly replies: string;
  readonly report: string;
  readonly env: Record<string, string>;
}
const V3 = { A0_EXPERIMENT_PRIMER: 'always', A0_EXPERIMENT_GUIDE: 'MODEL_GUIDE.min.txt' };
const V4 = {
  A0_EXPERIMENT_PRIMER: 'rules-merged',
  A0_EXPERIMENT_GUIDE: 'experiments/primers/lazy/V4.txt',
  A0_LAZY_HINTS: 'on',
};
const CELLS: readonly Cell[] = [
  ...(['haiku', 'sonnet'] as const).flatMap((model): Cell[] => [
    {
      set: 'z',
      model,
      arm: 'V3',
      replies: `results/primer-v4/replies.z.${model}.V3.json`,
      report: `results/primer-v4/report.z.${model}.V3.json`,
      env: V3,
    },
    {
      set: 'z',
      model,
      arm: 'V4',
      replies: `results/primer-v4/replies.z.${model}.V4.json`,
      report: `results/primer-v4/report.z.${model}.V4.json`,
      env: V4,
    },
    {
      set: 'y',
      model,
      arm: 'V3',
      replies: `results/primer-v3/replies.y.${model}.V3.json`,
      report: `results/primer-v3/report.y.${model}.V3.json`,
      env: V3,
    },
    {
      set: 'x',
      model,
      arm: 'canon',
      replies: `results/dense-default/replies.x.${model}.canon.json`,
      report: `results/dense-default/report.x.${model}.canon.json`,
      env: V3,
    },
  ]),
];

const TASKS = { x: TASKS_X, y: TASKS_Y, z: TASKS_Z } as const;

const scratch = join(tmpdir(), 'a0-invented-ops-replay');
mkdirSync(scratch, { recursive: true });

function fixed(
  src: string,
  fn: string,
  reply: string,
): { text: string; rules: string[]; accepted: boolean } {
  const open = (): EditSession => {
    const session = new EditSession(parseAndValidate(src));
    session.open(fn, { scope: 'deps' });
    session.openProgram({ scope: 'all', target: fn });
    return session;
  };
  const body = extractBlock(reply);
  const out = fixAll(body, (t) => {
    open().apply(t);
  });
  return {
    text: out.text,
    rules: out.applied.map((a) => a.edit.rule),
    accepted: out.error === undefined,
  };
}

interface Row {
  readonly cell: string;
  readonly tasks: number;
  readonly acceptedRecorded: number;
  readonly acceptedWithFixes: number;
  readonly oneShotRecorded: number;
  readonly oneShotWithFixes: number;
  readonly gainedByNewRules: string[];
  readonly gainedByOldRulesOnly: string[];
  readonly lost: string[];
  readonly rulesFired: Record<string, number>;
}
const rows: Row[] = [];
for (const c of CELLS) {
  const tasks = TASKS[c.set] as readonly { id: string; target: string; a0Source: string }[];
  const replies = JSON.parse(readFileSync(c.replies, 'utf8')) as Record<string, string[]>;
  const recorded = JSON.parse(readFileSync(c.report, 'utf8')) as {
    trials: { task: string; accepted: boolean; acceptedOneShot: boolean }[];
  };
  const newReplies: Record<string, string[]> = {};
  const rulesByTask = new Map<string, string[]>();
  const fired: Record<string, number> = {};
  for (const t of tasks) {
    const key = `${t.id}/a0/structured`;
    const list = replies[key];
    if (list === undefined) continue;
    const out: string[] = [];
    for (const r of list) {
      const f = fixed(t.a0Source, t.target, r);
      if (f.accepted && f.rules.length > 0) {
        out.push(f.text);
        rulesByTask.set(t.id, [...(rulesByTask.get(t.id) ?? []), ...f.rules]);
        for (const rule of f.rules) fired[rule] = (fired[rule] ?? 0) + 1;
      } else out.push(r);
    }
    newReplies[key] = out;
  }
  const tag = `${c.set}.${c.model}.${c.arm}`;
  const repliesOut = join(scratch, `replies.${tag}.json`);
  const reportOut = join(scratch, `report.${tag}.json`);
  writeFileSync(repliesOut, JSON.stringify(newReplies));
  const run = spawnSync('bun', ['tools/ai-edit-experiment.ts'], {
    env: {
      ...process.env,
      ...c.env,
      A0_EXPERIMENT_TASKSET: c.set,
      A0_EXPERIMENT_REPS: 'a0',
      A0_EXPERIMENT_PROTOCOLS: 'structured',
      A0_EXPERIMENT_SPECS: 'none',
      A0_EXPERIMENT_REPLIES: repliesOut,
      A0_EXPERIMENT_OUT: reportOut,
    },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (run.status !== 0) throw new Error(`harness failed for ${tag}: ${run.stderr}${run.stdout}`);
  const replay = JSON.parse(readFileSync(reportOut, 'utf8')) as {
    trials: { task: string; accepted: boolean; acceptedOneShot: boolean }[];
  };
  const before = new Map(recorded.trials.map((t) => [t.task, t]));
  const after = new Map(replay.trials.map((t) => [t.task, t]));
  const gainedNew: string[] = [];
  const gainedOld: string[] = [];
  const lost: string[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (b === undefined) continue;
    if (a.accepted && !b.accepted) {
      const rules = rulesByTask.get(id) ?? [];
      (rules.some((r) => NEW_RULES.has(r)) ? gainedNew : gainedOld).push(id);
    }
    if (!a.accepted && b.accepted) lost.push(id);
  }
  rows.push({
    cell: tag,
    tasks: after.size,
    acceptedRecorded: [...before.values()].filter((t) => t.accepted).length,
    acceptedWithFixes: [...after.values()].filter((t) => t.accepted).length,
    oneShotRecorded: [...before.values()].filter((t) => t.acceptedOneShot).length,
    oneShotWithFixes: [...after.values()].filter((t) => t.acceptedOneShot).length,
    gainedByNewRules: gainedNew,
    gainedByOldRulesOnly: gainedOld,
    lost,
    rulesFired: fired,
  });
}
await writeReport('results/invented-ops-replay.json', {
  generatedAt: new Date().toISOString(),
  tool: 'tools/invented-ops-replay.ts',
  meaning:
    'Recorded replies of the V3 and V4 arms (sets X, Y, Z) rewritten by the exact fixes (fix all) and scored by the harness with scripted replies; no model call. A task counts as gained when it was not accepted in the recorded run and is with the fixes applied.',
  newRules: [...NEW_RULES],
  rows,
});
for (const r of rows)
  console.log(
    `${r.cell}: accepted ${r.acceptedRecorded} -> ${r.acceptedWithFixes}, one shot ${r.oneShotRecorded} -> ${r.oneShotWithFixes}, new-rule gains ${r.gainedByNewRules.length}, old-rule gains ${r.gainedByOldRulesOnly.length}, lost ${r.lost.length}, fired ${JSON.stringify(r.rulesFired)}`,
  );
