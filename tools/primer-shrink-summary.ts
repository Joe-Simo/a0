/**
 * Summary of the primer-shrink measurement (docs/history/2026-10-07-primer-shrink-preregistration.md): reads
 * results/primer-shrink/report.<model>.<variant>.json (tools/ai-edit-experiment.ts, scripted replies from fresh
 * subagents, set X, one shot plus one repair) and writes results/primer-shrink.json: per model and variant the counts,
 * Wilson 95% intervals, tokens per accepted edit at the cold, 10-task (primary) and unbounded horizons, the per-task
 * flips against the shipped guide, and the pre-registered rule per model and per variant. Wins, ties and losses are all
 * written; nothing is dropped.
 */

import { readFileSync } from 'node:fs';
import { getEncoding } from 'js-tiktoken';
import { horizons, wilson } from './app-edit-summary.js';
import { writeReport } from './scrub-results.js';

const MODELS = ['haiku', 'sonnet'] as const;
export const VARIANTS = ['S', 'V1', 'V2'] as const;
const PRIMARY = 'session10';
/** The accepted count may be lower than the shipped guide's by at most this many tasks (declared before collection). */
export const MARGIN = 1;

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

/**
 * The pre-registered rule for one model and one variant against the shipped guide `S`: the accepted count (after one
 * repair) is not lower by more than MARGIN tasks, and tokens per accepted edit at the 10-task horizon is lower (raw
 * numbers, no band).
 */
export function shrinkRule(
  shipped: { accepted: number; cost: number },
  variant: { accepted: number; cost: number },
): { acceptanceHeld: boolean; cheaper: boolean; pass: boolean } {
  const acceptanceHeld = variant.accepted >= shipped.accepted - MARGIN;
  const cheaper = Number.isFinite(variant.cost) && variant.cost < shipped.cost;
  return { acceptanceHeld, cheaper, pass: acceptanceHeld && cheaper };
}

/** Both models must pass; when both variants pass, the one with the lower summed 10-task cost is chosen. */
export function decide(
  rule: Record<string, Record<string, { pass: boolean }>>,
  cost: Record<string, Record<string, number>>,
): { change: boolean; chosen: string | null } {
  const passing = VARIANTS.filter(
    (v) => v !== 'S' && MODELS.every((m) => rule[m]?.[v]?.pass === true),
  );
  if (passing.length === 0) return { change: false, chosen: null };
  const total = (v: string): number => MODELS.reduce((a, m) => a + (cost[m]?.[v] ?? 0), 0);
  const chosen = [...passing].sort((a, b) => total(a) - total(b))[0] ?? null;
  return { change: chosen !== null, chosen };
}

async function main(): Promise<void> {
  const enc = getEncoding('o200k_base');
  const primers: Record<string, number> = {};
  primers.S = enc.encode(readFileSync('MODEL_GUIDE.min.txt', 'utf8')).length;
  for (const v of ['V1', 'V2', 'V3'])
    primers[v] = enc.encode(readFileSync(`experiments/primers/shrink/${v}.txt`, 'utf8')).length;
  const cells: Record<string, unknown> = {};
  const rule: Record<string, Record<string, { pass: boolean }>> = {};
  const cost: Record<string, Record<string, number>> = {};
  const flips: Record<string, unknown> = {};
  let sha = '';
  for (const m of MODELS) {
    const per: Record<string, { accepted: number; cost: number }> = {};
    const reports: Record<string, Report> = {};
    for (const v of VARIANTS) {
      const rep = JSON.parse(
        readFileSync(`results/primer-shrink/report.${m}.${v}.json`, 'utf8'),
      ) as Report;
      if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${m} ${v}`);
      reports[v] = rep;
      sha = rep.taskSetSha256;
      const n = rep.trials.length;
      const one = rep.trials.filter((t) => t.acceptedOneShot === true).length;
      const acc = rep.trials.filter((t) => t.accepted === true).length;
      const tpa = horizons(rep.trials);
      per[v] = { accepted: acc, cost: tpa[PRIMARY] ?? Number.NaN };
      cells[`${m}/${v}`] = {
        n,
        system: rep.trials[0]?.setupTokensLocal.o200k_base,
        oneShot: { k: one, ci95: wilson(one, n) },
        accepted: { k: acc, ci95: wilson(acc, n) },
        callsPerTask:
          Math.round((rep.trials.reduce((a, t) => a + Math.max(1, t.modelCalls), 0) / n) * 100) /
          100,
        tokensPerAcceptedEdit: tpa,
        notAccepted: rep.trials
          .filter((t) => t.accepted !== true)
          .map((t) => ({ task: t.task, first: t.failures[0]?.slice(0, 160) ?? null })),
      };
    }
    const base = per.S as { accepted: number; cost: number };
    rule[m] = {};
    cost[m] = {};
    for (const v of VARIANTS) {
      const p = per[v] as { accepted: number; cost: number };
      cost[m][v] = p.cost;
      if (v === 'S') continue;
      rule[m][v] = {
        primaryHorizon: PRIMARY,
        shipped: base,
        variant: p,
        ...shrinkRule(base, p),
      } as {
        pass: boolean;
      };
      const s = reports.S as Report;
      const r = reports[v] as Report;
      flips[`${m}/${v}`] = {
        gained: r.trials
          .filter(
            (t) =>
              t.accepted === true && s.trials.find((x) => x.task === t.task)?.accepted !== true,
          )
          .map((t) => t.task),
        lost: r.trials
          .filter(
            (t) =>
              t.accepted !== true && s.trials.find((x) => x.task === t.task)?.accepted === true,
          )
          .map((t) => t.task),
      };
    }
  }
  const decision = decide(rule, cost);
  await writeReport('results/primer-shrink.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/primer-shrink-summary.ts',
    preRegistration: 'docs/history/2026-10-07-primer-shrink-preregistration.md',
    taskSetSha256: sha,
    meaning:
      'Primer shrink on sealed set X (16 single-function tasks, A0 canonical, structured protocol): the shipped guide S (MODEL_GUIDE.min.txt) against V1 (rarely needed rules moved to diagnostics) and V2 (V1 plus a rewritten edit line and no worked example), fresh Haiku and Sonnet subagents, one subagent per prompt, one shot plus one repair; tokens per accepted edit at the cold, 10-task (primary) and unbounded horizons.',
    primerTokensO200k: primers,
    marginTasks: MARGIN,
    cells,
    flipsAgainstShipped: flips,
    preRegisteredRule: rule,
    decision,
  });
  console.log(JSON.stringify({ rule, decision }, null, 1));
}

if (/primer-shrink-summary\.[jt]s$/.test(process.argv[1] ?? '')) await main();
