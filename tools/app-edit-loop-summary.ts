/**
 * Summary of the tool-loop arm of the application-scale edit benchmark
 * (docs/history/2026-10-06-app-edit-loop-preregistration.md): reads
 * results/app-edit-loop/report.<model>.<side>.json (tools/app-edit-loop.ts score) and writes
 * results/app-edit-loop.json with acceptance (Wilson 95% intervals), tool runs, tokens per accepted edit
 * at the three horizons of tools/app-edit-summary.ts (the same cost model), the secondary re-read
 * context, and the pre-registered verdict per model (the rule of the one-shot arm). Wins, ties and losses
 * are all written; nothing is dropped.
 */

import { readFileSync } from 'node:fs';
import { BUDGET, type LoopTrial } from './app-edit-loop.js';
import { horizons, verdict, wilson } from './app-edit-summary.js';
import { writeReport } from './scrub-results.js';

interface Report {
  taskSetSha256: string;
  budget: number;
  harnessSelfCheck: { ok: boolean };
  trials: LoopTrial[];
}

const MODELS = ['haiku', 'sonnet'] as const;
const SIDES = ['a0', 'ts'] as const;
const PRIMARY = 'session10';
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const r1 = (x: number): number => Math.round(x * 10) / 10;

/** One cell (model, side) of the summary. */
export function cell(trials: readonly LoopTrial[]): Record<string, unknown> & {
  accepted: { k: number; ci95: [number, number] };
  tokensPerAcceptedEdit: Record<string, number>;
} {
  const n = trials.length;
  const acc = trials.filter((t) => t.accepted).length;
  const calls = sum(trials.map((t) => t.toolCalls));
  return {
    n,
    system: trials[0]?.setupTokensLocal.o200k_base,
    accepted: { k: acc, ci95: wilson(acc, n) },
    toolCallsPerTask: r1(calls / n),
    toolCallsPerAcceptedEdit: acc === 0 ? Number.NaN : r1(calls / acc),
    budgetExhausted: trials.filter((t) => t.toolCalls >= BUDGET || t.refusedCalls > 0).length,
    editedOutsideTool: trials.filter((t) => t.editedOutsideTool).length,
    tokensPerAcceptedEdit: horizons(trials),
    rereadTokensPerAcceptedEdit:
      acc === 0 ? Number.NaN : r1(sum(trials.map((t) => t.rereadTokensLocal.o200k_base)) / acc),
    notAccepted: trials
      .filter((t) => !t.accepted)
      .map((t) => ({ task: t.task, first: t.failures[0]?.slice(0, 160) ?? null })),
  };
}

async function main(): Promise<void> {
  const cells: Record<string, unknown> = {};
  const verdicts: Record<string, unknown> = {};
  let sha = '';
  let budget = 0;
  for (const m of MODELS) {
    const per: Record<string, { accepted: number; cost: number }> = {};
    for (const side of SIDES) {
      const rep = JSON.parse(
        readFileSync(`results/app-edit-loop/report.${m}.${side}.json`, 'utf8'),
      ) as Report;
      if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${m} ${side}`);
      sha = rep.taskSetSha256;
      budget = rep.budget;
      const c = cell(rep.trials);
      per[side] = { accepted: c.accepted.k, cost: c.tokensPerAcceptedEdit[PRIMARY] ?? Number.NaN };
      cells[`${m}/${side}`] = c;
    }
    const a0 = per.a0 as { accepted: number; cost: number };
    const ts = per.ts as { accepted: number; cost: number };
    verdicts[m] = {
      primaryHorizon: PRIMARY,
      outcome: verdict(a0, ts),
      accepted: { a0: a0.accepted, ts: ts.accepted },
      cost: { a0: a0.cost, ts: ts.cost },
    };
  }
  await writeReport('results/app-edit-loop.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/app-edit-loop-summary.ts',
    preRegistration: 'docs/history/2026-10-06-app-edit-loop-preregistration.md',
    taskSetSha256: sha,
    budget,
    meaning:
      'Tool-loop arm of the application-scale edits (14 sealed tasks, the A0 front end): fresh Haiku and Sonnet subagents work in a scratch directory through a counted tool (A0: views, edit session, check, revision, explain, run; TypeScript: show, unified diff, tsc check; both: lex and parse on a test input; hidden tests never shown), final state scored by the hidden tests; tokens per accepted edit in the cost model of tools/app-edit-summary.ts.',
    cells,
    preRegisteredRule: verdicts,
  });
  console.log(JSON.stringify(verdicts, null, 1));
}

if (/app-edit-loop-summary\.[jt]s$/.test(process.argv[1] ?? '')) await main();
