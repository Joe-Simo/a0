/**
 * Summary of the failure-fixes arm of the application-scale edit benchmark (docs/history/2026-10-07-failure-fixes-preregistration.md):
 * the four tasks Haiku did not get accepted in the keys arm (results/app-edit-keys.json), rerun for Haiku and, as a non-regression
 * check, for Sonnet, replace their rows in the keys arm's 14 trials; the other ten carry over. Writes results/app-edit-fixes.json with
 * the counts, tokens per accepted edit and the pre-registered rule per model, computed from the raw numbers. Wins, ties and losses are all written.
 */

import { readFileSync } from 'node:fs';
import { RERUN as KEYS_RERUN } from './app-edit-keys-summary.js';
import { horizons, wilson } from './app-edit-summary.js';
import { writeReport } from './scrub-results.js';

interface Trial {
  task: string;
  setupTokensLocal: { o200k_base: number | null };
  tokenBucketsLocal?: { toolContext: number; output: number };
  modelCalls: number;
  acceptedOneShot: boolean | null;
  accepted: boolean | null;
  attempts?: { status: string; failures: string[] }[];
  failures: string[];
}
interface Report {
  taskSetSha256: string;
  harnessSelfCheck: { ok: boolean };
  trials: Trial[];
}

const MODELS = ['haiku', 'sonnet'] as const;
const PRIMARY = 'session10';
/** The tasks Haiku did not get accepted after repair in the keys arm (results/app-edit-keys.json), fixed in the pre-registration. */
export const FIX_TASKS = [
  'fat-arrow',
  'profile-canonical',
  'param-limit',
  'number-leading-zero',
] as const;

function load(path: string): Report {
  const rep = JSON.parse(readFileSync(path, 'utf8')) as Report;
  if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${path}`);
  return rep;
}

function cell(trials: Trial[]): Record<string, unknown> & { acceptedCount: number; cost: number } {
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

/** The pre-registered rule: Haiku accepts more of the four than before (0), Sonnet not fewer than before (4). */
export function fixesRule(
  before: { haiku: number; sonnet: number },
  after: { haiku: number; sonnet: number },
): { haikuRises: boolean; sonnetNotLower: boolean; met: boolean } {
  const haikuRises = after.haiku > before.haiku;
  const sonnetNotLower = after.sonnet >= before.sonnet;
  return { haikuRises, sonnetNotLower, met: haikuRises && sonnetNotLower };
}

/** The keys arm's 14 trials: the deps arm's, with the five keys-rerun tasks taken from the keys reports. */
function keysArm(m: string): Trial[] {
  const deps = load(`results/app-edit-deps/report.${m}.a0.json`);
  const keys = load(`results/app-edit-keys/report.${m}.a0.json`);
  const isRerun = (t: Trial): boolean => (KEYS_RERUN as readonly string[]).includes(t.task);
  return [...deps.trials.filter((t) => !isRerun(t)), ...keys.trials.filter(isRerun)];
}

async function main(): Promise<void> {
  const cells: Record<string, unknown> = {};
  const per: Record<
    string,
    { before: number; after: number; oneShotBefore: number; oneShotAfter: number }
  > = {};
  const trialsOut: Record<string, unknown> = {};
  let sha = '';
  for (const m of MODELS) {
    const base = keysArm(m);
    const fixes = load(`results/app-edit-fixes/report.${m}.a0.json`);
    sha = fixes.taskSetSha256;
    const inFix = (t: Trial): boolean => (FIX_TASKS as readonly string[]).includes(t.task);
    const rerun = fixes.trials.filter(inFix);
    if (rerun.length !== FIX_TASKS.length) throw new Error(`${m}: missing rerun trials`);
    const merged = [...base.filter((t) => !inFix(t)), ...rerun];
    const before = base.filter(inFix);
    cells[`${m}/a0-keys`] = cell(base);
    cells[`${m}/a0-fixes`] = cell(merged);
    cells[`${m}/a0-keys-on-fix-tasks`] = cell(before);
    cells[`${m}/a0-fixes-on-fix-tasks`] = cell(rerun);
    per[m] = {
      before: before.filter((t) => t.accepted === true).length,
      after: rerun.filter((t) => t.accepted === true).length,
      oneShotBefore: before.filter((t) => t.acceptedOneShot === true).length,
      oneShotAfter: rerun.filter((t) => t.acceptedOneShot === true).length,
    };
    trialsOut[m] = rerun.map((t) => ({
      task: t.task,
      oneShot: t.acceptedOneShot,
      accepted: t.accepted,
      modelCalls: t.modelCalls,
      attempts: (t.attempts ?? []).map((a) => ({
        status: a.status,
        first: a.failures[0]?.slice(0, 200) ?? null,
      })),
    }));
  }
  const rule = fixesRule(
    { haiku: per.haiku?.before ?? 0, sonnet: per.sonnet?.before ?? 0 },
    { haiku: per.haiku?.after ?? 0, sonnet: per.sonnet?.after ?? 0 },
  );
  await writeReport('results/app-edit-fixes.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/app-edit-fixes-summary.ts',
    preRegistration: 'docs/history/2026-10-07-failure-fixes-preregistration.md',
    taskSetSha256: sha,
    meaning:
      'The application-scale edit benchmark (deps view, word-key legend) rerun with fresh Haiku and Sonnet subagents (one shot plus one repair) on the four tasks Haiku did not get accepted in the keys arm, after the five failure-driven changes of docs/design/failure-taxonomy.md. The other ten tasks carry over from the keys arm. Four tasks and one trial per cell: the counts cannot separate a gain from sampling noise.',
    fixTasks: FIX_TASKS,
    cells,
    rerunTrials: trialsOut,
    acceptedOnFixTasks: per,
    preRegisteredRule: rule,
  });
  console.log(JSON.stringify({ per, rule }, null, 1));
}

if (/app-edit-fixes-summary\.[jt]s$/.test(process.argv[1] ?? '')) await main();
