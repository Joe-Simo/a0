/**
 * Summary of the pre-registered tiebreak of docs/history/2026-10-07-primer-v4-tiebreak-preregistration.md.
 *
 *   bun tools/primer-v4-tiebreak-summary.ts      writes results/primer-v4-tiebreak.json
 *
 * V3 (the shipped text) against V4 (the lazy text, hints on, new fixes on) pooled over sets Z, AA and BB. Sets Z and AA are
 * the recorded subject results (results/primer-v4/ and results/invented-ops/, where V3 is the V3old arm, identical to V3new);
 * only set BB is new (results/primer-v4-tiebreak/). Rule per model: pooled accepted after repair not lower than V3's by
 * more than 3 tasks, pooled tokens per accepted edit at the 10-task horizon lower, and no single set lower by more than 3
 * tasks. Both models or no change.
 */

import { readFileSync } from 'node:fs';
import { horizons } from './app-edit-summary.js';
import { summarize, type Trial } from './primer-compare-summary.js';
import { writeReport } from './scrub-results.js';

const MODELS = ['haiku', 'sonnet'] as const;
const SETS = ['z', 'aa', 'bb'] as const;
const MARGIN = 3;
const file = (set: string, model: string, arm: 'V3' | 'V4'): string =>
  set === 'z'
    ? `results/primer-v4/report.z.${model}.${arm}.json`
    : set === 'aa'
      ? `results/invented-ops/report.aa.${model}.${arm === 'V3' ? 'V3old' : 'V4new'}.json`
      : `results/primer-v4-tiebreak/report.bb.${model}.${arm}.json`;

interface Rep {
  taskSetSha256: string;
  harnessSelfCheck: { ok: boolean };
  trials: Trial[];
}
const acc = (ts: readonly Trial[]): number => ts.filter((t) => t.accepted === true).length;
const cells: Record<string, unknown> = {};
const rule: Record<string, unknown> = {};
const pass: Record<string, boolean> = {};
const shas: Record<string, string> = {};
for (const m of MODELS) {
  const pooled: Record<string, Trial[]> = { V3: [], V4: [] };
  const perSet: Record<string, { V3: number; V4: number }> = {};
  for (const set of SETS) {
    const one: Record<string, number> = {};
    for (const arm of ['V3', 'V4'] as const) {
      const rep = JSON.parse(readFileSync(file(set, m, arm), 'utf8')) as Rep;
      if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${set} ${m} ${arm}`);
      shas[set] = rep.taskSetSha256;
      pooled[arm]?.push(...rep.trials.map((t) => ({ ...t, task: `${set}:${t.task}` })));
      cells[`${set}/${m}/${arm}`] = summarize(rep.trials);
      one[arm] = acc(rep.trials);
    }
    perSet[set] = { V3: one.V3 as number, V4: one.V4 as number };
  }
  const v3 = pooled.V3 as Trial[];
  const v4 = pooled.V4 as Trial[];
  const c3 = horizons(v3).session10 ?? Number.NaN;
  const c4 = horizons(v4).session10 ?? Number.NaN;
  const acceptanceHeld = acc(v4) >= acc(v3) - MARGIN;
  const cheaper = c4 < c3;
  const everySetHeld = SETS.every(
    (s) => (perSet[s]?.V4 as number) >= (perSet[s]?.V3 as number) - MARGIN,
  );
  cells[`pooled/${m}/V3`] = summarize(v3);
  cells[`pooled/${m}/V4`] = summarize(v4);
  rule[m] = {
    pooled: { V3: { accepted: acc(v3), cost: c3 }, V4: { accepted: acc(v4), cost: c4 } },
    perSet,
    acceptanceHeld,
    cheaper,
    everySetHeld,
    pass: acceptanceHeld && cheaper && everySetHeld,
  };
  pass[m] = acceptanceHeld && cheaper && everySetHeld;
}
const decision = { shipV4: MODELS.every((m) => pass[m]) };
await writeReport('results/primer-v4-tiebreak.json', {
  generatedAt: new Date().toISOString(),
  tool: 'tools/primer-v4-tiebreak-summary.ts',
  preRegistration: 'docs/history/2026-10-07-primer-v4-tiebreak-preregistration.md',
  taskSetSha256: shas,
  marginTasks: MARGIN,
  cells,
  preRegisteredRule: rule,
  decision,
});
console.log(JSON.stringify({ rule, decision }, null, 1));
