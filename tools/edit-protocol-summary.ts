/**
 * Edit-protocol run summary (docs/history/2026-10-10-edit-protocol-preregistration.md). Reads the
 * scripted-reply reports of the harness (tools/ai-edit-experiment.ts) and applies the pre-registered
 * rule per model: the combined A0 arm against the shipped dense control, TypeScript and Rust. Calls
 * no model.
 *
 *   bun tools/edit-protocol-summary.ts CONFIG.json OUT.json
 *
 * CONFIG: { "<arm>": { "<model>": ["report.json", ...] } }, arms `a0-combined`, `a0-control`, `ts`, `rust`.
 *
 * Cache rule (the billing metric): the system text of a cell (primer, protocol paragraph and, when
 * counted, the tool schemas, which the provider renders before the system text) is priced at the
 * cached weights of a horizon only when it reaches the provider's minimum cacheable prefix for the
 * model (CACHE_MINIMUM); a shorter prefix is never cached, so every call bills it at weight 1.
 * Cached weights (first call, later calls) are those of tools/cost-anatomy.ts: cold 1.25/0.05,
 * 10-task 0.17/0.05, unbounded 0.05/0.05. The count is the local o200k count, not the vendor
 * tokenizer, and the minimum is compared against it.
 */

import { readFileSync } from 'node:fs';
import { writeReport } from './scrub-results.js';

/** Minimum cacheable prefix (tokens) per model, from the provider's prompt-caching documentation. */
export const CACHE_MINIMUM: Readonly<Record<string, number>> = { haiku: 512, sonnet: 512 };

export const CACHED_WEIGHTS = {
  cold: [1.25, 0.05],
  session10: [0.17, 0.05],
  unbounded: [0.05, 0.05],
} as const;
export type Horizon = keyof typeof CACHED_WEIGHTS;

export interface SummaryTrial {
  readonly accepted: boolean | null;
  readonly acceptedOneShot: boolean | null;
  readonly modelCalls: number;
  readonly tokenBucketsLocal: {
    readonly languagePrimer: number;
    readonly workflowPrimer: number;
    readonly toolContext: number;
    readonly output: number;
    readonly toolSchema?: number;
  } | null;
}

/** Weights (first call, each later call) of the system text at `h`, after the cache rule. */
export function systemWeights(
  systemTokens: number,
  model: string,
  h: Horizon,
): readonly [number, number] {
  const min = CACHE_MINIMUM[model];
  if (min === undefined) throw new Error(`no cache minimum recorded for model ${model}`);
  return systemTokens >= min ? CACHED_WEIGHTS[h] : [1, 1];
}

/** Billed tokens of one trial at horizon `h` under the cache rule. */
export function billed(t: SummaryTrial, model: string, h: Horizon): number {
  const b = t.tokenBucketsLocal;
  if (b === null) return 0;
  const calls = Math.max(1, t.modelCalls);
  const perCall = (b.languagePrimer + b.workflowPrimer + (b.toolSchema ?? 0)) / calls;
  const [first, later] = systemWeights(perCall, model, h);
  return perCall * first + perCall * later * (calls - 1) + b.toolContext + b.output;
}

/** Wilson 95% interval of k successes in n. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const w = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - w), Math.min(1, c + w)];
}

export interface CellStats {
  n: number;
  oneShot: number;
  accepted: number;
  perAccepted: Record<Horizon, number>;
}

export function stats(trials: readonly SummaryTrial[], model: string): CellStats {
  const accepted = trials.filter((t) => t.accepted === true).length;
  const per = (h: Horizon): number =>
    accepted === 0
      ? Number.POSITIVE_INFINITY
      : Math.round((trials.reduce((s, t) => s + billed(t, model, h), 0) / accepted) * 10) / 10;
  return {
    n: trials.length,
    oneShot: trials.filter((t) => t.acceptedOneShot === true).length,
    accepted,
    perAccepted: { cold: per('cold'), session10: per('session10'), unbounded: per('unbounded') },
  };
}

/**
 * The pre-registered verdict of `a` (the combined arm) against `b` (one comparator), one model:
 * pass when after-repair acceptance is no lower, the one-shot rate is not a loss under Wilson 95%
 * (a's interval upper bound is not below b's lower bound), and tokens per accepted edit are lower
 * than b's by more than 1% at every horizon. Anything else is a loss on the axes that failed.
 */
export function verdict(a: CellStats, b: CellStats): { pass: boolean; losses: string[] } {
  const losses: string[] = [];
  if (a.accepted / a.n < b.accepted / b.n) losses.push('after-repair acceptance');
  const [, aHi] = wilson(a.oneShot, a.n);
  const [bLo] = wilson(b.oneShot, b.n);
  if (aHi < bLo) losses.push('one-shot (Wilson 95%)');
  for (const h of Object.keys(CACHED_WEIGHTS) as Horizon[])
    if (!(a.perAccepted[h] < b.perAccepted[h] * 0.99))
      losses.push(`tokens per accepted edit (${h})`);
  return { pass: losses.length === 0, losses };
}

if (import.meta.main) {
  const [configPath, out] = process.argv.slice(2) as [string, string];
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    Record<string, string[]>
  >;
  const cells: Record<string, Record<string, CellStats>> = {};
  for (const [arm, byModel] of Object.entries(config))
    for (const [model, files] of Object.entries(byModel)) {
      const trials = files.flatMap(
        (f) => (JSON.parse(readFileSync(f, 'utf8')) as { trials: SummaryTrial[] }).trials,
      );
      cells[arm] = { ...(cells[arm] ?? {}), [model]: stats(trials, model) };
    }
  const verdicts: Record<string, Record<string, unknown>> = {};
  for (const model of Object.keys(config['a0-combined'] ?? {}))
    for (const other of ['a0-control', 'ts', 'rust']) {
      const a = cells['a0-combined']?.[model];
      const b = cells[other]?.[model];
      if (a === undefined || b === undefined) continue;
      verdicts[model] = { ...(verdicts[model] ?? {}), [other]: verdict(a, b) };
    }
  await writeReport(out, {
    method:
      'Pre-registered edit-protocol run (docs/history/2026-10-10-edit-protocol-preregistration.md); tokens per accepted edit with the system text priced under the cache rule (CACHE_MINIMUM).',
    cacheMinimum: CACHE_MINIMUM,
    cachedWeights: CACHED_WEIGHTS,
    cells,
    verdicts,
  });
  process.stdout.write(`${JSON.stringify(verdicts, null, 1)}\n`);
}
