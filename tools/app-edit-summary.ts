/**
 * Summary of the application-scale edit benchmark (docs/history/2026-10-06-app-edit-preregistration.md):
 * reads results/app-edit/report.<model>.<side>.json (tools/app-edit-bench.ts run, scripted replies from fresh
 * subagents, after the repair round) and writes results/app-edit.json with the counts, Wilson 95% intervals,
 * tokens per accepted edit at the three horizons of tools/set-h-summary.ts and the pre-registered verdict per
 * model (A0 win, TypeScript win, tie, or mixed), computed from the raw numbers. Wins, ties and losses are all
 * written; nothing is dropped.
 */

import { readFileSync } from 'node:fs';
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
const SIDES = ['a0', 'ts'] as const;
const PRIMARY = 'session10';
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const r1 = (x: number): number => Math.round(x * 10) / 10;
export function wilson(k: number, n: number): [number, number] {
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.round((c - h) * 1000) / 1000, Math.round((c + h) * 1000) / 1000];
}

/** Tokens per accepted edit at the cold task, 10-task session and unbounded horizons (tools/set-h-summary.ts). */
export function horizons(trials: readonly Trial[]): Record<string, number> {
  const rs = trials.map((t) => ({
    system: t.setupTokensLocal.o200k_base ?? 0,
    calls: Math.max(1, t.modelCalls),
    context: t.tokenBucketsLocal?.toolContext ?? 0,
    output: t.tokenBucketsLocal?.output ?? 0,
  }));
  const acc = trials.filter((t) => t.accepted === true).length;
  const cost = (first: number, later: number): number[] =>
    rs.map((r) => r.system * (first + later * (r.calls - 1)) + r.context + r.output);
  const h = {
    task1: cost(1.25, 0.05),
    session10: cost(0.17, 0.05),
    unbounded: rs.map((r) => r.system * 0.05 * r.calls + r.context + r.output),
  };
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k, acc === 0 ? Number.NaN : r1(sum(v) / acc)]),
  );
}

/**
 * The pre-registered verdict for one model: `a0` when A0 accepts at least as many tasks after the repair
 * AND costs fewer tokens per accepted edit at the 10-task horizon; `ts` the same the other way; `tie` when
 * the accepted counts are equal and the costs are within 5 percent of the lower; otherwise `mixed`.
 */
export function verdict(
  a0: { accepted: number; cost: number },
  ts: { accepted: number; cost: number },
): 'a0' | 'ts' | 'tie' | 'mixed' {
  if (
    a0.accepted === ts.accepted &&
    Math.abs(a0.cost - ts.cost) <= 0.05 * Math.min(a0.cost, ts.cost)
  )
    return 'tie';
  if (a0.accepted >= ts.accepted && a0.cost < ts.cost) return 'a0';
  if (ts.accepted >= a0.accepted && ts.cost < a0.cost) return 'ts';
  return 'mixed';
}

async function main(): Promise<void> {
  const cells: Record<string, unknown> = {};
  const verdicts: Record<string, unknown> = {};
  let sha = '';
  for (const m of MODELS) {
    const per: Record<string, { accepted: number; oneShot: number; cost: number }> = {};
    for (const side of SIDES) {
      const rep = JSON.parse(
        readFileSync(`results/app-edit/report.${m}.${side}.json`, 'utf8'),
      ) as Report;
      if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${m} ${side}`);
      sha = rep.taskSetSha256;
      const n = rep.trials.length;
      const one = rep.trials.filter((t) => t.acceptedOneShot === true).length;
      const acc = rep.trials.filter((t) => t.accepted === true).length;
      const tpa = horizons(rep.trials);
      per[side] = { accepted: acc, oneShot: one, cost: tpa[PRIMARY] ?? Number.NaN };
      cells[`${m}/${side}`] = {
        n,
        system: rep.trials[0]?.setupTokensLocal.o200k_base,
        oneShot: { k: one, ci95: wilson(one, n) },
        accepted: { k: acc, ci95: wilson(acc, n) },
        callsPerTask: r1(sum(rep.trials.map((t) => Math.max(1, t.modelCalls))) / n),
        tokensPerAcceptedEdit: tpa,
        notAcceptedAfterRepair: rep.trials
          .filter((t) => t.accepted !== true)
          .map((t) => ({ task: t.task, first: t.failures[0]?.slice(0, 160) ?? null })),
      };
    }
    const a0 = per.a0 as { accepted: number; oneShot: number; cost: number };
    const ts = per.ts as { accepted: number; oneShot: number; cost: number };
    verdicts[m] = {
      primaryHorizon: PRIMARY,
      outcome: verdict(a0, ts),
      oneShot: { a0: a0.oneShot, ts: ts.oneShot },
      accepted: { a0: a0.accepted, ts: ts.accepted },
      cost: { a0: a0.cost, ts: ts.cost },
    };
  }
  await writeReport('results/app-edit.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/app-edit-summary.ts',
    preRegistration: 'docs/history/2026-10-06-app-edit-preregistration.md',
    taskSetSha256: sha,
    meaning:
      'Application-scale edits of the A0 front end (lexer and parser, 14 sealed tasks), A0 (MODEL_GUIDE.min.txt, structured edit protocol, function views) against TypeScript (one reply-format sentence, whole-file view, unified diff), fresh Haiku and Sonnet subagents, one shot plus one repair; tokens per accepted edit at the cold, 10-task (primary) and unbounded horizons.',
    cells,
    preRegisteredRule: verdicts,
  });
  console.log(JSON.stringify(verdicts, null, 1));
}

if (/app-edit-summary\.[jt]s$/.test(process.argv[1] ?? '')) await main();
