/**
 * Summary of the pre-registered run of docs/history/2026-10-07-invented-op-fixes-preregistration.md on sealed set AA.
 *
 *   bun tools/invented-ops-summary.ts      writes results/invented-ops-fixes.json
 *
 * Reads results/invented-ops/report.aa.<model>.<arm>.json for the arms V3old, V3new and V4new, applies the registered rule to
 * each candidate arm (V3new, V4new) against V3old per model, and chooses the shipping arm: the candidate that passes on both
 * models with the lowest sum of the two models' 10-task costs; V3new is preferred on a tie. Wins, ties and losses are written.
 */

import { readFileSync } from 'node:fs';
import { horizons } from './app-edit-summary.js';
import { compareRule, summarize, type Trial } from './primer-compare-summary.js';
import { writeReport } from './scrub-results.js';

const MODELS = ['haiku', 'sonnet'] as const;
const ARMS = ['V3old', 'V3new', 'V4new'] as const;
const PRIMARY = 'session10';
const MARGIN = 1;

interface Rep {
  taskSetSha256: string;
  harnessSelfCheck: { ok: boolean };
  trials: Trial[];
}
const cells: Record<string, unknown> = {};
const trials: Record<string, Trial[]> = {};
let sha = '';
for (const m of MODELS)
  for (const a of ARMS) {
    const rep = JSON.parse(
      readFileSync(`results/invented-ops/report.aa.${m}.${a}.json`, 'utf8'),
    ) as Rep;
    if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${m} ${a}`);
    sha = rep.taskSetSha256;
    trials[`${m}/${a}`] = rep.trials;
    cells[`${m}/${a}`] = summarize(rep.trials);
  }
const cell = (m: string, a: string): { accepted: number; cost: number } => {
  const ts = trials[`${m}/${a}`] as Trial[];
  return {
    accepted: ts.filter((t) => t.accepted === true).length,
    cost: horizons(ts)[PRIMARY] ?? Number.NaN,
  };
};
const rule: Record<string, Record<string, unknown>> = {};
const passes: Record<string, boolean> = {};
for (const cand of ['V3new', 'V4new'] as const) {
  let both = true;
  for (const m of MODELS) {
    const r = compareRule(cell(m, 'V3old'), cell(m, cand), MARGIN, [], null, true);
    const byModel = rule[cand] ?? {};
    rule[cand] = byModel;
    byModel[m] = { baseline: cell(m, 'V3old'), variant: cell(m, cand), ...r };
    both = both && r.pass;
  }
  passes[cand] = both;
}
const costSum = (a: string): number => MODELS.reduce((s, m) => s + cell(m, a).cost, 0);
const passing = (['V3new', 'V4new'] as const).filter((a) => passes[a]);
passing.sort((a, b) => costSum(a) - costSum(b) || (a === 'V3new' ? -1 : 1));
const flips: Record<string, unknown> = {};
for (const m of MODELS)
  for (const cand of ['V3new', 'V4new']) {
    const b = trials[`${m}/V3old`] as Trial[];
    const v = trials[`${m}/${cand}`] as Trial[];
    flips[`${m}/${cand}`] = {
      gained: v
        .filter((t) => t.accepted === true && b.find((x) => x.task === t.task)?.accepted !== true)
        .map((t) => t.task),
      lost: v
        .filter((t) => t.accepted !== true && b.find((x) => x.task === t.task)?.accepted === true)
        .map((t) => t.task),
    };
  }
const decision = { ships: passing[0] ?? 'none', passes };
await writeReport('results/invented-ops-fixes.json', {
  generatedAt: new Date().toISOString(),
  tool: 'tools/invented-ops-summary.ts',
  preRegistration: 'docs/history/2026-10-07-invented-op-fixes-preregistration.md',
  taskSetSha256: sha,
  cells,
  flipsAgainstV3old: flips,
  preRegisteredRule: rule,
  decision,
});
console.log(JSON.stringify({ rule, decision }, null, 1));
