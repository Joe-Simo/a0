/**
 * Summary of the word-key legend arm of the application-scale edit benchmark (docs/history/2026-10-06-app-edit-keys-preregistration.md):
 * the five tasks whose request changes with the legend (results/app-edit-keys/report.<model>.a0.json) replace their rows in the deps-view arm
 * (results/app-edit-deps/report.<model>.a0.json); the nine whose request is byte-identical carry over. Writes results/app-edit-keys.json with the
 * counts, tokens per accepted edit and the pre-registered rule per model, computed from the raw numbers. Wins, ties and losses are all written.
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
/** The tasks whose request differs with the legend on (a diff of the two dumps, recorded in the pre-registration). */
export const RERUN = [
  'op-alias-mod',
  'drop-unsigned-aliases',
  'number-leading-zero',
  'unreserve-patch',
  'use-alias-import',
] as const;

function load(path: string): Report {
  const rep = JSON.parse(readFileSync(path, 'utf8')) as Report;
  if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${path}`);
  return rep;
}

export function cell(
  trials: Trial[],
): Record<string, unknown> & { acceptedCount: number; cost: number } {
  const n = trials.length;
  const one = trials.filter((t) => t.acceptedOneShot === true).length;
  const acc = trials.filter((t) => t.accepted === true).length;
  const tpa = horizons(trials);
  return {
    n,
    oneShot: { k: one, ci95: wilson(one, n) },
    acceptedAfterRepair: { k: acc, ci95: wilson(acc, n) },
    tokensPerAcceptedEdit: tpa,
    notAcceptedAfterRepair: trials
      .filter((t) => t.accepted !== true)
      .map((t) => ({ task: t.task, first: t.failures[0]?.slice(0, 160) ?? null })),
    acceptedCount: acc,
    cost: tpa[PRIMARY] ?? Number.NaN,
  };
}

/** The pre-registered rule: more accepted, or equal and cheaper, overall; and not fewer on the rerun tasks. */
export function keysRule(
  all: { deps: { accepted: number; cost: number }; keys: { accepted: number; cost: number } },
  rerun: { deps: number; keys: number },
): { overall: boolean; rerunNotLower: boolean; met: boolean } {
  const overall =
    all.keys.accepted > all.deps.accepted ||
    (all.keys.accepted === all.deps.accepted && all.keys.cost < all.deps.cost);
  const rerunNotLower = rerun.keys >= rerun.deps;
  return { overall, rerunNotLower, met: overall && rerunNotLower };
}

async function main(): Promise<void> {
  const cells: Record<string, unknown> = {};
  const rule: Record<string, unknown> = {};
  let sha = '';
  let allModels = true;
  for (const m of MODELS) {
    const deps = load(`results/app-edit-deps/report.${m}.a0.json`);
    const keys = load(`results/app-edit-keys/report.${m}.a0.json`);
    sha = deps.taskSetSha256;
    const isRerun = (t: Trial): boolean => (RERUN as readonly string[]).includes(t.task);
    const keysRerun = keys.trials.filter(isRerun);
    if (keysRerun.length !== RERUN.length) throw new Error(`${m}: missing rerun trials`);
    const merged = [...deps.trials.filter((t) => !isRerun(t)), ...keysRerun];
    const ts = load(`results/app-edit/report.${m}.ts.json`);
    const d = cell(deps.trials);
    const k = cell(merged);
    const depsRerun = cell(deps.trials.filter(isRerun));
    const keysOnly = cell(keysRerun);
    cells[`${m}/ts`] = cell(ts.trials);
    cells[`${m}/a0-deps`] = d;
    cells[`${m}/a0-keys`] = k;
    cells[`${m}/a0-deps-on-rerun-tasks`] = depsRerun;
    cells[`${m}/a0-keys-on-rerun-tasks`] = keysOnly;
    const r = keysRule(
      {
        deps: { accepted: d.acceptedCount, cost: d.cost },
        keys: { accepted: k.acceptedCount, cost: k.cost },
      },
      { deps: depsRerun.acceptedCount, keys: keysOnly.acceptedCount },
    );
    allModels = allModels && r.met;
    rule[m] = {
      primaryHorizon: PRIMARY,
      accepted: { deps: d.acceptedCount, keys: k.acceptedCount },
      cost: { deps: d.cost, keys: k.cost },
      rerunTasksAccepted: { deps: depsRerun.acceptedCount, keys: keysOnly.acceptedCount },
      ...r,
    };
  }
  await writeReport('results/app-edit-keys.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/app-edit-keys-summary.ts',
    preRegistration: 'docs/history/2026-10-06-app-edit-keys-preregistration.md',
    taskSetSha256: sha,
    meaning:
      'The deps-view arm of the application-scale edit benchmark with the word-key legend in the A0 view (A0_KEY_LEGEND=on) against the same arm without it. Only the five tasks whose request changes were rerun with fresh Haiku and Sonnet subagents (one shot plus one repair); the other nine carry over from the deps arm because their requests are byte-identical.',
    rerunTasks: RERUN,
    cells,
    preRegisteredRule: { perModel: rule, metOnBothModels: allModels },
  });
  console.log(JSON.stringify({ perModel: rule, metOnBothModels: allModels }, null, 1));
}

if (/app-edit-keys-summary\.[jt]s$/.test(process.argv[1] ?? '')) await main();
