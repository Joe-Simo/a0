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

const SET = process.argv.find((a) => /^[hijklmnopq]+$/.test(a)) ?? 'h';
const SETS = [...SET];
// Sets K, L, M and N compare the shipped guide with the short primer; H, I and J compare dense with canonical.
const SHORT = 'klmnopq'.includes(SET[0] as string);
const MODELS = ['haiku', 'sonnet'] as const;
// Sets H, I and J compare the dense form (D) with the canonical one (K) on the 10-task session; set K compares the shipped guide (S)
// with the 101-token edit primer (K) on the cold single task (the horizon of the ai-tokens-* losses).
const FIRST = SHORT ? 'guide' : 'dense';
const PRIMARY = SHORT ? 'task1' : 'session10';
const FORMS = { [FIRST]: SHORT ? 'S' : 'D', canon: 'K' } as Record<string, string>;
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
  for (const form of Object.keys(FORMS)) {
    const reps = SETS.map(
      (L) =>
        JSON.parse(readFileSync(`results/set-${L}/report.${m}.${form}.json`, 'utf8')) as Report,
    );
    for (const r of reps)
      if (!r.harnessSelfCheck.ok) throw new Error(`self-check failed ${m} ${form}`);
    sha = reps.map((r) => r.taskSetSha256).join(',');
    const rep: Report = {
      taskSetSha256: sha,
      harnessSelfCheck: { ok: true },
      trials: reps.flatMap((r) => r.trials),
    };
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
    const d = counts[m]?.[FIRST];
    const k = counts[m]?.canon;
    const td = tpa[m]?.[FIRST]?.[PRIMARY];
    const tk = tpa[m]?.canon?.[PRIMARY];
    // Set K reverses the roles: the shorter primer (K) must not lose acceptance and must cost less than the shipped guide (S).
    const c1 =
      d !== undefined &&
      k !== undefined &&
      (SHORT ? k.oneShot >= d.oneShot : d.oneShot >= k.oneShot);
    const c2 = td !== undefined && tk !== undefined && (SHORT ? tk < td : td < tk);
    return [m, { oneShotNotLower: c1, primaryHorizon: PRIMARY, primaryLower: c2, met: c1 && c2 }];
  }),
);
const met = MODELS.every((m) => (verdict[m] as { met: boolean }).met);
writeFileSync(
  `results/set-${SET}.json`,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      tool: 'tools/set-h-summary.ts (set letter as the argument)',
      preRegistration: {
        h: 'docs/history/2026-10-06-dense-default-preregistration.md',
        i: 'docs/history/2026-10-06-set-i-preregistration.md',
        j: 'docs/history/2026-10-06-set-j-preregistration.md',
        k: 'docs/history/2026-10-06-set-k-preregistration.md',
        lmn: 'docs/history/2026-10-06-set-lmn-preregistration.md',
        opq: 'docs/history/2026-10-06-set-opq-preregistration.md',
      }[SET],
      taskSetSha256: sha,
      meaning: SHORT
        ? `Sets ${SETS.join('').toUpperCase()} pooled, the shipped guide (S: MODEL_GUIDE.min.txt) against the 101-token edit primer (K: canon.KR3), canonical form, fresh Haiku and Sonnet subagents, one shot plus one repair; tokens per accepted edit at the cold, 10-task and unbounded horizons, the cold task being primary.`
        : `Set ${SET.toUpperCase()}, dense (D: dense.D0 primer, dense view) against canonical (K: canon.KR3 primer, canonical view), fresh Haiku and Sonnet subagents, one shot plus one repair; D and K tokens per accepted edit at the cold, 10-task and unbounded horizons.`,
      cells,
      preRegisteredRule: { verdict, [SHORT ? 'shipShortPrimer' : 'recommendDense']: met },
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ counts, tpa, verdict, met }, null, 1));
