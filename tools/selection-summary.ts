/**
 * Summary of the pre-registered primer selection (docs/history/2026-10-06-primer-reference-selection-preregistration.md): the candidates
 * `canon.KR3a`, `canon.KR3b` and `canon.KR3c` on sets K, L and M, with the baselines `S` (the shipped guide) and `KR3` re-scored by replay under the current
 * edit protocol. Reads results/selection/<set>/report.<model>.<cand>.json and base.<model>.<guide|KR3>.json; writes results/selection.json with the counts,
 * tokens per accepted edit at the three horizons (the formulas of tools/primer-ablation-summary.ts) and the eligibility of each candidate, computed from the raw numbers.
 *
 *   node dist/tools/selection-summary.js
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface Trial {
  setupTokensLocal: { o200k_base: number | null };
  tokenBucketsLocal?: { toolContext: number; output: number };
  modelCalls: number;
  acceptedOneShot: boolean | null;
  accepted: boolean | null;
}
interface Report {
  harnessSelfCheck: { ok: boolean };
  trials: Trial[];
}

const SETS = ['k', 'l', 'm'] as const;
const MODELS = ['haiku', 'sonnet'] as const;
const CANDS = ['KR3a', 'KR3b', 'KR3c'] as const;
const BASES = ['guide', 'KR3'] as const;
const r1 = (x: number): number => Math.round(x * 10) / 10;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function cell(model: string, name: string, kind: 'cand' | 'base') {
  const trials: Trial[] = [];
  for (const s of SETS) {
    const file =
      kind === 'cand'
        ? `results/selection/${s}/report.${model}.${name}.json`
        : `results/selection/${s}/base.${model}.${name}.json`;
    const rep = JSON.parse(readFileSync(file, 'utf8')) as Report;
    if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${file}`);
    trials.push(...rep.trials);
  }
  const rs = trials.map((t) => ({
    system: t.setupTokensLocal.o200k_base ?? 0,
    calls: Math.max(1, t.modelCalls),
    context: t.tokenBucketsLocal?.toolContext ?? 0,
    output: t.tokenBucketsLocal?.output ?? 0,
  }));
  const one = trials.filter((t) => t.acceptedOneShot === true).length;
  const acc = trials.filter((t) => t.accepted === true).length;
  const cost = (first: number, later: number): number[] =>
    rs.map((r) => r.system * (first + later * (r.calls - 1)) + r.context + r.output);
  const per = (xs: number[]): number | null => (acc === 0 ? null : r1(sum(xs) / acc));
  return {
    n: trials.length,
    system: rs[0]?.system ?? 0,
    oneShot: one,
    accepted: acc,
    callsPerTask: r1(sum(rs.map((r) => r.calls)) / trials.length),
    tokensPerAcceptedEdit: {
      task1: per(cost(1.25, 0.05)),
      session10: per(cost(0.17, 0.05)),
      unbounded: per(rs.map((r) => r.system * 0.05 * r.calls + r.context + r.output)),
    },
  };
}

const cells: Record<string, ReturnType<typeof cell>> = {};
for (const m of MODELS) {
  for (const c of CANDS) cells[`${m}/${c}`] = cell(m, c, 'cand');
  for (const b of BASES) cells[`${m}/${b}`] = cell(m, b, 'base');
}
const eligibility = Object.fromEntries(
  CANDS.map((c) => {
    const per = Object.fromEntries(
      MODELS.map((m) => {
        const k = cells[`${m}/${c}`];
        const s = cells[`${m}/guide`];
        const oneShotNotLower = (k?.oneShot ?? 0) >= (s?.oneShot ?? 0);
        const coldLower =
          k?.tokensPerAcceptedEdit.task1 != null &&
          s?.tokensPerAcceptedEdit.task1 != null &&
          k.tokensPerAcceptedEdit.task1 < s.tokensPerAcceptedEdit.task1;
        return [m, { oneShotNotLower, coldLower, eligible: oneShotNotLower && coldLower }];
      }),
    );
    return [
      c,
      { ...per, eligible: MODELS.every((m) => (per[m] as { eligible: boolean }).eligible) },
    ];
  }),
);
const eligible = CANDS.filter((c) => (eligibility[c] as { eligible: boolean }).eligible);
const selected =
  [...eligible].sort(
    (a, b) =>
      (cells[`haiku/${a}`]?.system ?? 0) - (cells[`haiku/${b}`]?.system ?? 0) ||
      (cells[`haiku/${b}`]?.oneShot ?? 0) +
        (cells[`sonnet/${b}`]?.oneShot ?? 0) -
        ((cells[`haiku/${a}`]?.oneShot ?? 0) + (cells[`sonnet/${a}`]?.oneShot ?? 0)),
  )[0] ?? null;

writeFileSync(
  'results/selection.json',
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      tool: 'tools/selection-summary.ts',
      preRegistration: 'docs/history/2026-10-06-primer-reference-selection-preregistration.md',
      meaning:
        'Selection of a short edit primer with the language reference added back, on sets K, L and M pooled (48 tasks per cell), fresh Haiku and Sonnet subagents, one shot plus one repair, edit protocol as of this commit. Baselines guide (the shipped guide) and KR3 are their already collected replies re-scored by replay under the current protocol.',
      cells,
      eligibility,
      selected,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ cells, eligibility, selected }, null, 1));
