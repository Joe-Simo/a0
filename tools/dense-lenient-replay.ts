/**
 * Replay of recorded dense replies through the lenient dense parser (docs/history/2026-10-07-dense-leniency-preregistration.md).
 *
 *   bun tools/dense-lenient-replay.ts
 *
 * Every dense cell recorded under results/dense-default/ (sets X and Y) and results/set-h/ (set H), Haiku and Sonnet, is run
 * again through tools/ai-edit-experiment.ts with the same scripted replies (first reply and the recorded repair) on the
 * checked-out parser, and compared with the recorded report. This is recorded data only: evidence about what the parser
 * now accepts, not a measurement of new model behaviour (a recorded repair answered the old rejection text; a first reply
 * the parser now accepts needs none). Written to results/dense-lenient-replay.json.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReport } from './scrub-results.js';

interface Trial {
  task: string;
  acceptedOneShot: boolean | null;
  accepted: boolean | null;
  attempts: { failures: string[] }[];
}
interface Report {
  trials: Trial[];
}

const cells = [
  ...(['x', 'y'] as const).flatMap((set) =>
    (['haiku', 'sonnet'] as const).map((model) => ({
      set,
      model,
      recorded: `results/dense-default/report.${set}.${model}.dense.json`,
      replies: `results/dense-default/replies.${set}.${model}.dense.json`,
    })),
  ),
  ...(['haiku', 'sonnet'] as const).map((model) => ({
    set: 'h',
    model,
    recorded: `results/set-h/report.${model}.dense.json`,
    replies: `results/set-h/scripted.${model}.dense.json`,
  })),
];

const dir = mkdtempSync(join(tmpdir(), 'a0-lenient-replay-'));
const out: Record<string, unknown> = {};
const totals: Record<
  string,
  {
    cells: number;
    oneShotBefore: number;
    oneShotAfter: number;
    acceptedBefore: number;
    acceptedAfter: number;
  }
> = {};
for (const c of cells) {
  const path = join(dir, `${c.set}.${c.model}.json`);
  execFileSync('node', ['dist/tools/ai-edit-experiment.js'], {
    env: {
      ...process.env,
      A0_EXPERIMENT_TASKSET: c.set,
      A0_EXPERIMENT_DENSE: '1',
      A0_EXPERIMENT_PRIMER: 'rules-merged',
      A0_EXPERIMENT_GUIDE: 'MODEL_GUIDE.dense.txt',
      A0_EXPERIMENT_REPS: 'a0',
      A0_EXPERIMENT_PROTOCOLS: 'structured',
      A0_EXPERIMENT_SPECS: 'none',
      A0_EXPERIMENT_REPLIES: c.replies,
      A0_EXPERIMENT_OUT: path,
    },
    stdio: 'ignore',
  });
  const before = (JSON.parse(readFileSync(c.recorded, 'utf8')) as Report).trials;
  const after = (JSON.parse(readFileSync(path, 'utf8')) as Report).trials;
  const by = new Map(before.map((t) => [t.task, t] as const));
  const rows = after.map((t) => {
    const b = by.get(t.task) as Trial;
    return {
      task: t.task,
      oneShotBefore: b.acceptedOneShot === true,
      oneShotAfter: t.acceptedOneShot === true,
      acceptedBefore: b.accepted === true,
      acceptedAfter: t.accepted === true,
      firstRejectionBefore: b.attempts[0]?.failures[0]?.slice(0, 200) ?? null,
    };
  });
  const k = `${c.set}/${c.model}`;
  const n = (f: (r: (typeof rows)[number]) => boolean): number => rows.filter(f).length;
  out[k] = {
    n: rows.length,
    oneShot: { before: n((r) => r.oneShotBefore), after: n((r) => r.oneShotAfter) },
    accepted: { before: n((r) => r.acceptedBefore), after: n((r) => r.acceptedAfter) },
    newlyOneShot: rows.filter((r) => !r.oneShotBefore && r.oneShotAfter).map((r) => r.task),
    newlyAccepted: rows.filter((r) => !r.acceptedBefore && r.acceptedAfter).map((r) => r.task),
    lostOneShot: rows.filter((r) => r.oneShotBefore && !r.oneShotAfter).map((r) => r.task),
    lostAccepted: rows.filter((r) => r.acceptedBefore && !r.acceptedAfter).map((r) => r.task),
    rows,
  };
  const t = totals[c.model] ?? {
    cells: 0,
    oneShotBefore: 0,
    oneShotAfter: 0,
    acceptedBefore: 0,
    acceptedAfter: 0,
  };
  totals[c.model] = t;
  t.cells += rows.length;
  t.oneShotBefore += n((r) => r.oneShotBefore);
  t.oneShotAfter += n((r) => r.oneShotAfter);
  t.acceptedBefore += n((r) => r.acceptedBefore);
  t.acceptedAfter += n((r) => r.acceptedAfter);
}
await writeReport('results/dense-lenient-replay.json', {
  generatedAt: new Date().toISOString(),
  tool: 'tools/dense-lenient-replay.ts',
  preRegistration: 'docs/history/2026-10-07-dense-leniency-preregistration.md',
  meaning:
    'Recorded dense first replies (and the recorded repairs) of sets X, Y and H run again through the lenient dense parser; recorded data only, not a measurement of new model behaviour.',
  totals,
  cells: out,
});
console.log(JSON.stringify(totals, null, 1));
for (const [k, v] of Object.entries(out)) {
  const x = v as {
    oneShot: unknown;
    accepted: unknown;
    newlyOneShot: string[];
    newlyAccepted: string[];
    lostOneShot: string[];
    lostAccepted: string[];
  };
  console.log(
    k,
    JSON.stringify({
      oneShot: x.oneShot,
      accepted: x.accepted,
      newlyOneShot: x.newlyOneShot,
      newlyAccepted: x.newlyAccepted,
      lostOneShot: x.lostOneShot,
      lostAccepted: x.lostAccepted,
    }),
  );
}
