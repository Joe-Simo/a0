/**
 * Cost anatomy of an accepted edit (docs/design/cost-anatomy.md): splits the tokens per accepted edit of
 * A0 canonical, A0 dense and TypeScript into the primer (system text, first call), the code read (the view),
 * the task text and repair messages (tool overhead), the repair re-pay of the system text, and the reply,
 * at the cold (1-task), 10-task session and unbounded horizons of tools/app-edit-summary.ts (system text
 * counted 1.25 / 0.17 / 0.05 times on the first call and 0.05 times on later calls) and at the raw weight 1
 * that the loss ledger's ai-tokens-* entries use. Reads only recorded results; calls no model.
 *
 *   bun tools/cost-anatomy.ts          writes results/cost-anatomy.json
 */

import { readFileSync } from 'node:fs';
import { writeReport } from './scrub-results.js';

interface Trial {
  representation?: string;
  protocol?: string;
  accepted: boolean | null;
  modelCalls: number;
  setupTokensLocal: { o200k_base: number | null };
  viewTokensLocal?: { o200k_base: number | null };
  tokenBucketsLocal?: {
    languagePrimer: number;
    workflowPrimer: number;
    toolContext: number;
    output: number;
  };
}

export const HORIZONS = {
  raw: [1, 1],
  task1: [1.25, 0.05],
  session10: [0.17, 0.05],
  unbounded: [0.05, 0.05],
} as const;
export type Horizon = keyof typeof HORIZONS;

export interface Parts {
  primer: number;
  workflow: number;
  codeRead: number;
  taskAndRepairText: number;
  repairRepay: number;
  reply: number;
  total: number;
}
const ZERO = (): Parts => ({
  primer: 0,
  workflow: 0,
  codeRead: 0,
  taskAndRepairText: 0,
  repairRepay: 0,
  reply: 0,
  total: 0,
});
const r1 = (x: number): number => Math.round(x * 10) / 10;

/** Components of one trial at one horizon (tokens, not yet divided by accepted edits). */
export function partsOf(t: Trial, h: Horizon): Parts {
  const b = t.tokenBucketsLocal;
  const calls = Math.max(1, t.modelCalls);
  const [first, later] = HORIZONS[h];
  const langPerCall = (b?.languagePrimer ?? 0) / calls;
  const flowPerCall = (b?.workflowPrimer ?? 0) / calls;
  const view = t.viewTokensLocal?.o200k_base ?? 0;
  const context = b?.toolContext ?? 0;
  const p: Parts = ZERO();
  p.primer = langPerCall * first;
  p.workflow = flowPerCall * first;
  p.repairRepay = (langPerCall + flowPerCall) * later * (calls - 1);
  p.codeRead = Math.min(view, context);
  p.taskAndRepairText = context - p.codeRead;
  p.reply = b?.output ?? 0;
  p.total = p.primer + p.workflow + p.codeRead + p.taskAndRepairText + p.repairRepay + p.reply;
  return p;
}

/** Per accepted edit: the sum over a cell's trials divided by its accepted count. */
export function perAccepted(
  trials: readonly Trial[],
  h: Horizon,
): Parts & { n: number; k: number } {
  const acc = trials.filter((t) => t.accepted === true).length;
  const sum = ZERO();
  for (const t of trials) {
    const p = partsOf(t, h);
    for (const key of Object.keys(sum) as (keyof Parts)[]) sum[key] += p[key];
  }
  const out = ZERO();
  for (const key of Object.keys(sum) as (keyof Parts)[])
    out[key] = acc === 0 ? Number.NaN : r1(sum[key] / acc);
  return { ...out, n: trials.length, k: acc };
}

const read = (f: string): { trials: Trial[] } =>
  JSON.parse(readFileSync(`results/${f}`, 'utf8')) as { trials: Trial[] };

async function main(): Promise<void> {
  const sets = ['a', 'b', 'd', 'e', 'f'];
  const models = ['haiku', 'sonnet'];
  // (A) shipped guide (MODEL_GUIDE.min.txt), single-function tasks, the cells of the ledger's ai-tokens-* entries.
  const shipped: Record<string, unknown> = {};
  for (const [name, rep] of [
    ['a0-canonical', 'a0'],
    ['typescript', 'ts'],
  ] as const) {
    const trials: Trial[] = [];
    for (const s of sets)
      for (const m of models)
        for (const t of read(
          s === 'a' ? `ai-edit-experiment.${m}-min.json` : `ai-edit-experiment.${s}.${m}-min.json`,
        ).trials)
          if (t.representation === rep && t.protocol === 'structured') trials.push(t);
    shipped[name] = Object.fromEntries(
      (Object.keys(HORIZONS) as Horizon[]).map((h) => [h, perAccepted(trials, h)]),
    );
  }
  // (B) scoped matrix (results/ai-edit-scoped.json): canonical edit primer, dense, TypeScript, pooled sets b c c400 c4000.
  const scopedFile = JSON.parse(readFileSync('results/ai-edit-scoped.json', 'utf8')) as {
    cells: Record<
      string,
      Record<
        string,
        {
          n: number;
          accepted: number;
          system: number;
          callsPerTask: number;
          buckets: {
            languagePrimer: number;
            workflowPrimer: number;
            toolContext: number;
            output: number;
          };
        }
      >
    >;
  };
  const scoped: Record<string, unknown> = {};
  for (const form of ['a0', 'dense', 'ts'] as const) {
    const c = scopedFile.cells.all?.[form];
    if (c === undefined) throw new Error(`no scoped cell ${form}`);
    const out: Record<string, unknown> = {};
    for (const h of Object.keys(HORIZONS) as Horizon[]) {
      const calls = c.callsPerTask;
      const [first, later] = HORIZONS[h];
      const sys = c.system;
      const primer = ((c.buckets.languagePrimer + c.buckets.workflowPrimer) / calls) * first;
      const repay = sys * later * (calls - 1);
      const total = primer + repay + c.buckets.toolContext + c.buckets.output;
      const per = c.n / c.accepted;
      out[h] = {
        primer: r1(primer * per),
        codeReadAndTaskText: r1(c.buckets.toolContext * per),
        repairRepay: r1(repay * per),
        reply: r1(c.buckets.output * per),
        total: r1(total * per),
        n: c.n,
        k: c.accepted,
      };
    }
    scoped[form === 'a0' ? 'a0-canonical' : form === 'ts' ? 'typescript' : 'a0-dense'] = out;
  }
  // (C) application-scale edits (results/app-edit/report.<model>.<side>.json): one shot plus one repair.
  const app: Record<string, unknown> = {};
  for (const side of ['a0', 'ts'] as const) {
    const trials = models.flatMap((m) => read(`app-edit/report.${m}.${side}.json`).trials);
    app[side === 'a0' ? 'a0-canonical' : 'typescript'] = Object.fromEntries(
      (Object.keys(HORIZONS) as Horizon[]).map((h) => [h, perAccepted(trials, h)]),
    );
  }
  await writeReport('results/cost-anatomy.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/cost-anatomy.ts',
    meaning:
      'Tokens per accepted edit split into primer (first call), protocol paragraph, code read (view), task and repair text, system-text re-pay on repair calls, and reply, at the raw (ledger), cold, 10-task and unbounded horizons. shippedGuide: single-function sets a b d e f, both models, structured protocol, MODEL_GUIDE.min.txt (the ledger cells); scopedMatrix: results/ai-edit-scoped.json pooled (code read and task text are one bucket there); appEdit: the 14 application-scale tasks, both models.',
    horizonWeights: HORIZONS,
    shippedGuide: shipped,
    scopedMatrix: scoped,
    appEdit: app,
  });
}

if (/cost-anatomy\.[jt]s$/.test(process.argv[1] ?? '')) await main();
