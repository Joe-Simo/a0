/**
 * Summary of the two pre-registered comparisons of docs/history/2026-10-07-primer-v3-dense-ledger-preregistration.md:
 *
 *   bun tools/primer-compare-summary.ts v3      phase A: primer V3 against V2 on sealed set Y
 *   bun tools/primer-compare-summary.ts dense   phase B: dense primer and view against the canonical shipped primer on sets X and Y
 *
 * Reads results/<dir>/report.<set>.<model>.<variant>.json (tools/ai-edit-experiment.ts, scripted replies from fresh
 * subagents, one shot plus one repair) and writes results/<dir>.json: per model, set and variant the counts, Wilson 95%
 * intervals, tokens per accepted edit at the cold, 10-task (primary) and unbounded horizons, the per-task flips against
 * the baseline, the first failure of each task not accepted, and the pre-registered rule per model. Wins, ties and
 * losses are all written; nothing is dropped.
 */

import { readFileSync } from 'node:fs';
import { getEncoding } from 'js-tiktoken';
import { horizons, wilson } from './app-edit-summary.js';
import { writeReport } from './scrub-results.js';

const MODELS = ['haiku', 'sonnet'] as const;
const PRIMARY = 'session10';

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

interface Phase {
  readonly dir: string;
  readonly sets: readonly string[];
  readonly baseline: string;
  readonly variant: string;
  /** Accepted (after the repair) may be lower than the baseline's by at most this many tasks, pooled over the sets. */
  readonly margin: number;
  /** Accepted may be lower than the baseline's by at most this many tasks on every single set (null: not a condition). */
  readonly perSetMargin: number | null;
  /** The variant's 10-task cost may equal the baseline's (docs/history/2026-10-07-primer-v4-lazy-preregistration.md: `not higher`). */
  readonly costTie?: boolean;
  readonly preRegistration: string;
  readonly meaning: string;
  readonly primers: Readonly<Record<string, string>>;
}

export const PHASES: Readonly<Record<string, Phase>> = {
  v3: {
    dir: 'primer-v3',
    sets: ['y'],
    baseline: 'V2',
    variant: 'V3',
    margin: 1,
    perSetMargin: null,
    preRegistration: 'docs/history/2026-10-07-primer-v3-dense-ledger-preregistration.md',
    meaning:
      'Phase A: primer V3 (244 tokens) against the shipped V2 (299) on sealed set Y (28 tasks that exercise loop, text, io and a new helper), A0 canonical, structured protocol, fresh Haiku and Sonnet subagents, one shot plus one repair.',
    primers: {
      V2: 'experiments/primers/shrink/V2.txt',
      V3: 'experiments/primers/shrink/V3.txt',
    },
  },
  v4: {
    dir: 'primer-v4',
    sets: ['z'],
    baseline: 'V3',
    variant: 'V4',
    margin: 1,
    perSetMargin: null,
    costTie: true,
    preRegistration: 'docs/history/2026-10-07-primer-v4-lazy-preregistration.md',
    meaning:
      'Primer V4 (the lazy primer, 137 tokens, with the lazy hints on) against the shipped V3 (244, hints off) on sealed set Z (32 tasks: loop, text, io, helper-before-caller, plain), A0 canonical, structured protocol, fresh Haiku and Sonnet subagents, one shot plus one repair.',
    primers: {
      V3: 'experiments/primers/shrink/V3.txt',
      V4: 'experiments/primers/lazy/V4.txt',
    },
  },
  dense: {
    dir: 'dense-default',
    sets: ['x', 'y'],
    baseline: 'canon',
    variant: 'dense',
    margin: 2,
    perSetMargin: 2,
    preRegistration: 'docs/history/2026-10-07-primer-v3-dense-ledger-preregistration.md',
    meaning:
      'Phase B: the dense primer (MODEL_GUIDE.dense.txt, 145 tokens) with the dense view against the shipped canonical primer with the canonical view on sealed sets X and Y, fresh Haiku and Sonnet subagents, one shot plus one repair.',
    primers: {
      canon: 'MODEL_GUIDE.min.txt',
      dense: 'MODEL_GUIDE.dense.txt',
    },
  },
};

export interface Cell {
  readonly accepted: number;
  readonly cost: number;
}

/**
 * The pre-registered rule for one model: the pooled accepted count after one repair is not lower than the baseline's by
 * more than `margin` tasks, no single set is lower by more than `perSetMargin` (when it is a condition), and tokens per
 * accepted edit at the 10-task horizon (pooled) is lower than the baseline's (raw numbers, no band).
 */
export function compareRule(
  base: Cell,
  variant: Cell,
  margin: number,
  perSet: readonly { base: number; variant: number }[] = [],
  perSetMargin: number | null = null,
  costTie = false,
): { acceptanceHeld: boolean; everySetHeld: boolean; cheaper: boolean; pass: boolean } {
  const acceptanceHeld = variant.accepted >= base.accepted - margin;
  const everySetHeld =
    perSetMargin === null || perSet.every((s) => s.variant >= s.base - perSetMargin);
  const cheaper =
    Number.isFinite(variant.cost) &&
    (costTie ? variant.cost <= base.cost : variant.cost < base.cost);
  return { acceptanceHeld, everySetHeld, cheaper, pass: acceptanceHeld && everySetHeld && cheaper };
}

/** Both models must pass, or no change. */
export function decide(rule: Record<string, { pass: boolean }>): { change: boolean } {
  return { change: MODELS.every((m) => rule[m]?.pass === true) };
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? '';
  const phase = PHASES[name];
  if (phase === undefined) throw new Error('usage: primer-compare-summary.ts v3|v4|dense');
  const enc = getEncoding('o200k_base');
  const primerTokens = Object.fromEntries(
    Object.entries(phase.primers).map(([k, p]) => [k, enc.encode(readFileSync(p, 'utf8')).length]),
  );
  const cells: Record<string, unknown> = {};
  const rule: Record<string, { pass: boolean }> = {};
  const flips: Record<string, unknown> = {};
  const shas: Record<string, string> = {};
  for (const m of MODELS) {
    const pooled: Record<string, Trial[]> = { [phase.baseline]: [], [phase.variant]: [] };
    const perSet: { base: number; variant: number }[] = [];
    for (const set of phase.sets) {
      const per: Record<string, Trial[]> = {};
      for (const v of [phase.baseline, phase.variant]) {
        const rep = JSON.parse(
          readFileSync(`results/${phase.dir}/report.${set}.${m}.${v}.json`, 'utf8'),
        ) as Report;
        if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${set} ${m} ${v}`);
        shas[set] = rep.taskSetSha256;
        per[v] = rep.trials;
        pooled[v]?.push(...rep.trials.map((t) => ({ ...t, task: `${set}:${t.task}` })));
        cells[`${set}/${m}/${v}`] = summarize(rep.trials);
      }
      const count = (v: string): number =>
        (per[v] as Trial[]).filter((t) => t.accepted === true).length;
      perSet.push({ base: count(phase.baseline), variant: count(phase.variant) });
    }
    const sum = (v: string): { accepted: number; cost: number } => {
      const ts = pooled[v] as Trial[];
      return {
        accepted: ts.filter((t) => t.accepted === true).length,
        cost: horizons(ts)[PRIMARY] ?? Number.NaN,
      };
    };
    for (const v of [phase.baseline, phase.variant])
      cells[`pooled/${m}/${v}`] = summarize(pooled[v] as Trial[]);
    rule[m] = {
      primaryHorizon: PRIMARY,
      baseline: sum(phase.baseline),
      variant: sum(phase.variant),
      perSet: Object.fromEntries(phase.sets.map((s, i) => [s, perSet[i]])),
      ...compareRule(
        sum(phase.baseline),
        sum(phase.variant),
        phase.margin,
        perSet,
        phase.perSetMargin,
        phase.costTie === true,
      ),
    } as { pass: boolean };
    const b = pooled[phase.baseline] as Trial[];
    const v = pooled[phase.variant] as Trial[];
    flips[m] = {
      gained: v
        .filter((t) => t.accepted === true && b.find((x) => x.task === t.task)?.accepted !== true)
        .map((t) => t.task),
      lost: v
        .filter((t) => t.accepted !== true && b.find((x) => x.task === t.task)?.accepted === true)
        .map((t) => t.task),
    };
  }
  await writeReport(`results/${phase.dir}.json`, {
    generatedAt: new Date().toISOString(),
    tool: 'tools/primer-compare-summary.ts',
    preRegistration: phase.preRegistration,
    taskSetSha256: shas,
    meaning: phase.meaning,
    primerTokensO200k: primerTokens,
    baseline: phase.baseline,
    variant: phase.variant,
    marginTasks: phase.margin,
    perSetMarginTasks: phase.perSetMargin,
    cells,
    flipsAgainstBaseline: flips,
    preRegisteredRule: rule,
    decision: decide(rule),
  });
  console.log(JSON.stringify({ rule, decision: decide(rule) }, null, 1));
}

function summarize(trials: readonly Trial[]): unknown {
  const n = trials.length;
  const one = trials.filter((t) => t.acceptedOneShot === true).length;
  const acc = trials.filter((t) => t.accepted === true).length;
  return {
    n,
    system: trials[0]?.setupTokensLocal.o200k_base,
    oneShot: { k: one, ci95: wilson(one, n) },
    accepted: { k: acc, ci95: wilson(acc, n) },
    callsPerTask:
      Math.round((trials.reduce((a, t) => a + Math.max(1, t.modelCalls), 0) / n) * 100) / 100,
    tokensPerAcceptedEdit: horizons(trials),
    notAccepted: trials
      .filter((t) => t.accepted !== true)
      .map((t) => ({ task: t.task, first: t.failures[0]?.slice(0, 160) ?? null })),
  };
}

if (/primer-compare-summary\.[jt]s$/.test(process.argv[1] ?? '')) await main();
