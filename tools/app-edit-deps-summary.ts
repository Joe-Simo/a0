/**
 * Summary of the deps-view arm of the application-scale edit benchmark (docs/history/2026-10-06-app-edit-deps-preregistration.md):
 * reads results/app-edit-deps/report.<model>.a0.json (the A0 side with the program view scoped to dependencies), the sealed arm's
 * results/app-edit/report.<model>.a0.json (full signature listing) and report.<model>.ts.json (alongside), and writes
 * results/app-edit-deps.json with the counts, Wilson intervals, tokens per accepted edit at the three horizons and the pre-registered
 * rule per model, computed from the raw numbers. Wins, ties and losses are all written.
 */

import { readFileSync } from 'node:fs';
import { horizons, wilson } from './app-edit-summary.js';
import { writeReport } from './scrub-results.js';

interface Trial {
  task: string;
  setupTokensLocal: { o200k_base: number | null };
  tokenBucketsLocal?: { toolContext: number; output: number };
  modelCalls: number;
  acceptedOneShot: boolean | null;
  accepted: boolean | null;
  failures: string[];
}
interface Report {
  taskSetSha256: string;
  harnessSelfCheck: { ok: boolean };
  trials: Trial[];
}

const MODELS = ['haiku', 'sonnet'] as const;
const PRIMARY = 'session10';
/** Declared before collection: the deps view may accept this many fewer tasks than the full listing. */
const MARGIN = 1;

function load(path: string): Report {
  const rep = JSON.parse(readFileSync(path, 'utf8')) as Report;
  if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${path}`);
  return rep;
}

function cell(rep: Report): Record<string, unknown> & { acceptedCount: number; cost: number } {
  const n = rep.trials.length;
  const one = rep.trials.filter((t) => t.acceptedOneShot === true).length;
  const acc = rep.trials.filter((t) => t.accepted === true).length;
  const tpa = horizons(rep.trials);
  return {
    n,
    system: rep.trials[0]?.setupTokensLocal.o200k_base,
    oneShot: { k: one, ci95: wilson(one, n) },
    acceptedAfterRepair: { k: acc, ci95: wilson(acc, n) },
    tokensPerAcceptedEdit: tpa,
    notAcceptedAfterRepair: rep.trials
      .filter((t) => t.accepted !== true)
      .map((t) => ({ task: t.task, first: t.failures[0]?.slice(0, 160) ?? null })),
    acceptedCount: acc,
    cost: tpa[PRIMARY] ?? Number.NaN,
  };
}

async function main(): Promise<void> {
  const cells: Record<string, unknown> = {};
  const rule: Record<string, unknown> = {};
  let sha = '';
  let allModels = true;
  for (const m of MODELS) {
    const deps = load(`results/app-edit-deps/report.${m}.a0.json`);
    const full = load(`results/app-edit/report.${m}.a0.json`);
    const ts = load(`results/app-edit/report.${m}.ts.json`);
    sha = deps.taskSetSha256;
    const d = cell(deps);
    const f = cell(full);
    const t = cell(ts);
    cells[`${m}/a0-deps`] = d;
    cells[`${m}/a0-all`] = f;
    cells[`${m}/ts`] = t;
    const accOk = d.acceptedCount >= f.acceptedCount - MARGIN;
    const costLower = d.cost < f.cost;
    allModels = allModels && accOk && costLower;
    rule[m] = {
      primaryHorizon: PRIMARY,
      margin: MARGIN,
      accepted: { deps: d.acceptedCount, all: f.acceptedCount, ts: t.acceptedCount },
      cost: { deps: d.cost, all: f.cost, ts: t.cost },
      acceptanceNotLowerWithinMargin: accOk,
      costLower,
      met: accOk && costLower,
    };
  }
  await writeReport('results/app-edit-deps.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/app-edit-deps-summary.ts',
    preRegistration: 'docs/history/2026-10-06-app-edit-deps-preregistration.md',
    taskSetSha256: sha,
    meaning:
      'The A0 side of the application-scale edit benchmark with the program view scoped to the functions the first target reaches (deps) against the sealed arm with the full signature listing (all), fresh Haiku and Sonnet subagents, one shot plus one repair; the TypeScript side alongside.',
    cells,
    preRegisteredRule: { perModel: rule, metOnBothModels: allModels },
  });
  console.log(JSON.stringify({ perModel: rule, metOnBothModels: allModels }, null, 1));
}

if (/app-edit-deps-summary\.[jt]s$/.test(process.argv[1] ?? '')) await main();
