/**
 * Summary of the set-H comparison, dense against canonical (docs/history/2026-10-06-dense-default-preregistration.md):
 * reads results/set-h/report.<model>.<form>.json (the harness's reports, scripted replies from fresh subagents) and writes
 * results/set-h.json with the counts, Wilson 95% intervals, tokens per accepted edit at the three horizons (the formulas
 * of tools/primer-ablation-summary.ts) and the verdict of the pre-registered rule, computed from the raw numbers.
 */

import { readFileSync, writeFileSync } from 'node:fs';

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

const SET = process.argv.find((a) => /^[hi]$/.test(a)) ?? 'h';
const MODELS = ['haiku', 'sonnet'] as const;
const FORMS = { dense: 'D', canon: 'K' } as const;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const r1 = (x: number): number => Math.round(x * 10) / 10;
function wilson(k: number, n: number): [number, number] {
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.round((c - h) * 1000) / 1000, Math.round((c + h) * 1000) / 1000];
}

const cells: Record<string, unknown> = {};
const tpa: Record<string, Record<string, Record<string, number>>> = {};
const counts: Record<string, Record<string, { oneShot: number; accepted: number }>> = {};
let sha = '';
for (const m of MODELS) {
  for (const form of Object.keys(FORMS) as (keyof typeof FORMS)[]) {
    const rep = JSON.parse(
      readFileSync(`results/set-${SET}/report.${m}.${form}.json`, 'utf8'),
    ) as Report;
    if (!rep.harnessSelfCheck.ok) throw new Error(`self-check failed ${m} ${form}`);
    sha = rep.taskSetSha256;
    const rs = rep.trials.map((t) => ({
      system: t.setupTokensLocal.o200k_base ?? 0,
      calls: Math.max(1, t.modelCalls),
      context: t.tokenBucketsLocal?.toolContext ?? 0,
      output: t.tokenBucketsLocal?.output ?? 0,
    }));
    const n = rs.length;
    const one = rep.trials.filter((t) => t.acceptedOneShot === true).length;
    const acc = rep.trials.filter((t) => t.accepted === true).length;
    const cost = (first: number, later: number): number[] =>
      rs.map((r) => r.system * (first + later * (r.calls - 1)) + r.context + r.output);
    const horizons = {
      task1: cost(1.25, 0.05),
      session10: cost(0.17, 0.05),
      unbounded: rs.map((r) => r.system * 0.05 * r.calls + r.context + r.output),
    };
    const per = Object.fromEntries(
      Object.entries(horizons).map(([k, v]) => [k, acc === 0 ? Number.NaN : r1(sum(v) / acc)]),
    ) as Record<string, number>;
    tpa[m] = { ...tpa[m], [form]: per };
    counts[m] = { ...counts[m], [form]: { oneShot: one, accepted: acc } };
    cells[`${m}/${form}`] = {
      variant: FORMS[form],
      n,
      system: rs[0]?.system,
      oneShot: { k: one, ci95: wilson(one, n) },
      accepted: { k: acc, ci95: wilson(acc, n) },
      callsPerTask: r1(sum(rs.map((r) => r.calls)) / n),
      tokensPerAcceptedEdit: per,
      notAcceptedAfterRepair: rep.trials
        .filter((t) => !t.accepted)
        .map((t) => ({ task: t.task, first: t.failures[0]?.slice(0, 120) ?? null })),
    };
  }
}
const verdict = Object.fromEntries(
  MODELS.map((m) => {
    const d = counts[m]?.dense;
    const k = counts[m]?.canon;
    const td = tpa[m]?.dense?.session10;
    const tk = tpa[m]?.canon?.session10;
    const c1 = d !== undefined && k !== undefined && d.oneShot >= k.oneShot;
    const c2 = td !== undefined && tk !== undefined && td < tk;
    return [m, { oneShotNotLower: c1, session10Lower: c2, met: c1 && c2 }];
  }),
);
const met = MODELS.every((m) => (verdict[m] as { met: boolean }).met);
writeFileSync(
  `results/set-${SET}.json`,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      tool: 'tools/set-h-summary.ts (set letter as the argument)',
      preRegistration:
        SET === 'h'
          ? 'docs/history/2026-10-06-dense-default-preregistration.md'
          : 'docs/history/2026-10-06-set-i-preregistration.md',
      taskSetSha256: sha,
      meaning: `Set ${SET.toUpperCase()}, dense (D: dense.D0 primer, dense view) against canonical (K: canon.KR3 primer, canonical view), fresh Haiku and Sonnet subagents, one shot plus one repair; D and K tokens per accepted edit at the cold, 10-task and unbounded horizons.`,
      cells,
      preRegisteredRule: { verdict, recommendDense: met },
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ counts, tpa, verdict, recommendDense: met }, null, 1));
