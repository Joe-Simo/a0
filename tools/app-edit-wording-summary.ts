/**
 * Summary of the wording arm of the application-scale edit benchmark
 * (docs/history/2026-10-06-app-edit-wording-preregistration.md): reads
 * results/app-edit-wording/report.<model>.<variant>.json (tools/app-edit-loop.ts score --arm wording)
 * and writes results/app-edit-wording.json: per model and variant, acceptance (Wilson 95% intervals),
 * tool runs, tokens per accepted edit at the horizons of tools/app-edit-summary.ts, the share of
 * subjects that asked for the bare program listing, and the pre-registered rule per model. Wins, ties
 * and losses are all written; nothing is dropped.
 */

import { readFileSync } from 'node:fs';
import { type LoopTrial, VARIANTS } from './app-edit-loop.js';
import { cell } from './app-edit-loop-summary.js';
import { wilson } from './app-edit-summary.js';
import { writeReport } from './scrub-results.js';

const MODELS = ['haiku', 'sonnet'] as const;
const PRIMARY = 'session10';

interface Report {
  taskSetSha256: string;
  budget: number;
  variant: string;
  harnessSelfCheck: { ok: boolean };
  trials: LoopTrial[];
}

/** One cell (model, variant): the loop arm's cell plus the program views asked for. */
export function wordingCell(trials: readonly LoopTrial[]): ReturnType<typeof cell> & {
  bareListing: { k: number; share: number; ci95: [number, number] };
} {
  const n = trials.length;
  const bare = trials.filter((t) => (t.programViews ?? []).includes('bare')).length;
  return {
    ...cell(trials),
    bareListing: { k: bare, share: Math.round((bare / n) * 1000) / 1000, ci95: wilson(bare, n) },
    targetedListing: trials.filter((t) => (t.programViews ?? []).some((v) => v !== 'bare')).length,
    programViews: trials.map((t) => ({ task: t.task, views: t.programViews ?? [] })),
  };
}

/**
 * The pre-registered rule for one model: the revised wording passes when its accepted count is not
 * lower than the current wording's by more than one task and its tokens per accepted edit (10-task
 * horizon) is lower.
 */
export function wordingRule(
  current: { accepted: number; cost: number },
  revised: { accepted: number; cost: number },
): { acceptanceHeld: boolean; cheaper: boolean; pass: boolean } {
  const acceptanceHeld = revised.accepted >= current.accepted - 1;
  const cheaper = Number.isFinite(revised.cost) && revised.cost < current.cost;
  return { acceptanceHeld, cheaper, pass: acceptanceHeld && cheaper };
}

async function main(): Promise<void> {
  const cells: Record<string, unknown> = {};
  const rule: Record<string, unknown> = {};
  let sha = '';
  let budget = 0;
  for (const m of MODELS) {
    const per: Record<string, { accepted: number; cost: number }> = {};
    for (const v of VARIANTS) {
      const rep = JSON.parse(
        readFileSync(`results/app-edit-wording/report.${m}.${v}.json`, 'utf8'),
      ) as Report;
      if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${m} ${v}`);
      if (rep.variant !== v) throw new Error(`report ${m} ${v} holds variant ${rep.variant}`);
      sha = rep.taskSetSha256;
      budget = rep.budget;
      const c = wordingCell(rep.trials);
      per[v] = { accepted: c.accepted.k, cost: c.tokensPerAcceptedEdit[PRIMARY] ?? Number.NaN };
      cells[`${m}/${v}`] = c;
    }
    const cur = per.current as { accepted: number; cost: number };
    const rev = per.revised as { accepted: number; cost: number };
    rule[m] = { primaryHorizon: PRIMARY, current: cur, revised: rev, ...wordingRule(cur, rev) };
  }
  const change = MODELS.every((m) => (rule[m] as { pass: boolean }).pass);
  await writeReport('results/app-edit-wording.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/app-edit-wording-summary.ts',
    preRegistration: 'docs/history/2026-10-06-app-edit-wording-preregistration.md',
    taskSetSha256: sha,
    budget,
    meaning:
      'Wording arm of the application-scale edits (14 sealed tasks, A0 side): fresh Haiku and Sonnet subagents start from the instruction alone and work through the counted tool, with the shipped skill and view descriptions (current) or the same text reworded only on the choice of program view (revised); final state scored by the hidden tests; tokens per accepted edit in the cost model of tools/app-edit-summary.ts; bareListing counts subjects that asked for the program view without a target.',
    cells,
    preRegisteredRule: rule,
    outcome: change ? 'change: the shipped wording becomes the revised text' : 'no change',
  });
  console.log(JSON.stringify({ rule, change }, null, 1));
}

if (/app-edit-wording-summary\.[jt]s$/.test(process.argv[1] ?? '')) await main();
