/**
 * The cold single-task cost of the shipped guide and of the 101-token edit primer against TypeScript, on the same task sets (e and f), from results
 * already collected: no new subject. The three numbers come from different collections (the ai-edit-experiment runs with the shipped guide and the
 * TypeScript cell, the primer-ablation run with `canon.KR3`), so this is a cross-session comparison, not a same-session one, and is labelled that way.
 *
 *   node dist/tools/primer-vs-ts-cold.js   -> results/primer-vs-ts-cold.json
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface Entry {
  source: string;
  axis: string;
  competitor: string;
  a0: number;
  other: number;
}
const ledger = JSON.parse(readFileSync('results/loss-ledger.json', 'utf8')) as { entries: Entry[] };
const ablation = JSON.parse(readFileSync('results/primer-ablation.json', 'utf8')) as {
  cells: Record<string, Record<string, { costPerTask: { task1: number }; n: number }>>;
};
const N = { e: 11, f: 13 } as const;

const rows: Record<string, unknown> = {};
for (const model of ['haiku', 'sonnet'] as const) {
  const shipped = (set: 'e' | 'f', who: 'a0' | 'ts'): number => {
    const e = ledger.entries.find(
      (x) =>
        x.source === `ai-edit:${set}.${model}-min` &&
        x.axis === 'ai-tokens-structured' &&
        x.competitor === 'ts',
    );
    if (e === undefined) throw new Error(`no ledger entry ${set} ${model}`);
    return who === 'a0' ? e.a0 : e.other;
  };
  const pool = (f: (set: 'e' | 'f') => number): number =>
    Math.round(((f('e') * N.e + f('f') * N.f) / (N.e + N.f)) * 10) / 10;
  const kr3 = ablation.cells[`confirm(e+f)/${model}`]?.['canon.KR3']?.costPerTask.task1;
  const k0 = ablation.cells[`confirm(e+f)/${model}`]?.['canon.K0']?.costPerTask.task1;
  const tsStructured = pool((s) => shipped(s, 'ts'));
  const a0Shipped = pool((s) => shipped(s, 'a0'));
  rows[model] = {
    tasks: N.e + N.f,
    coldCostPerTask: {
      a0WithShippedGuide: a0Shipped,
      typescriptStructured: tsStructured,
      a0WithCanonKR3Primer: kr3,
      a0WithCanonK0Primer: k0,
    },
    kr3OverTypescript: kr3 === undefined ? null : Math.round((kr3 / tsStructured) * 1000) / 1000,
    shippedOverTypescript: Math.round((a0Shipped / tsStructured) * 1000) / 1000,
  };
}
writeFileSync(
  'results/primer-vs-ts-cold.json',
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      tool: 'tools/primer-vs-ts-cold.ts',
      meaning:
        'Cold single-task cost per task (o200k tokens, local counts) on sets e and f pooled by task count: A0 with the shipped guide and TypeScript structured from the ai-edit-experiment collections (the loss-ledger source rows), A0 with the 101-token canon.KR3 edit primer from the primer-ablation collection. Cross-session: the three come from different collections of fresh subagents with the same harness accounting, not from one session. No new subject was run.',
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(rows, null, 1));
