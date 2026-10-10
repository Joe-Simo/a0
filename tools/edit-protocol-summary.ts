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
 * Cache rule (the modelled cost metric; subjects ran as Claude Code subagents, so nothing here is
 * billed): the system text of a cell (primer, protocol paragraph and, when counted, the tool schemas,
 * which the provider renders before the system text) is priced at the cached weights of a horizon
 * only when it reaches the provider's minimum cacheable prefix for the model (CACHE_MINIMUM); a
 * shorter prefix is never cached, so every call bills it at weight 1.
 * Cached weights follow the provider's prompt-caching rule (Claude API documentation,
 * shared/prompt-caching.md of the claude-api skill): the first call of a session writes the cache at
 * 1.25x (5-minute write), every later call reads it at CACHE_READ[model] (0.1x for Haiku and Sonnet,
 * 0.05x for Opus). A horizon of N edits shares one session, so the write is paid once and its share
 * per edit is 1.25/N: the first call of an edit weighs (1.25 + (N-1) * read) / N, later calls weigh
 * read. Unbounded is the limit N -> infinity (the write's share tends to 0). The count is the local
 * o200k count, not the vendor tokenizer, and the minimum is compared against it.
 */

import { readFileSync } from 'node:fs';
import { writeReport } from './scrub-results.js';

/** Minimum cacheable prefix (tokens) per model, from the provider's prompt-caching documentation. */
export const CACHE_MINIMUM: Readonly<Record<string, number>> = { haiku: 512, sonnet: 512 };

/** Cache write weight (5-minute cache), paid once on the first call of a session. */
export const CACHE_WRITE = 1.25;

/** Cache read weight per model (provider prompt-caching documentation). */
export const CACHE_READ: Readonly<Record<string, number>> = { haiku: 0.1, sonnet: 0.1, opus: 0.05 };

/** Edits per session at each horizon (unbounded is the limit). */
export const HORIZONS = {
  cold: 1,
  session10: 10,
  session50: 50,
  unbounded: Number.POSITIVE_INFINITY,
} as const;
export type Horizon = keyof typeof HORIZONS;

/** Horizons the pre-registered rule scores; session50 is reported, not scored. */
export const SCORED_HORIZONS: readonly Horizon[] = ['cold', 'session10', 'unbounded'];

/** Cached weights (first call of an edit, each later call) for `model` at `h`. */
export function cachedWeights(model: string, h: Horizon): readonly [number, number] {
  const read = CACHE_READ[model];
  if (read === undefined) throw new Error(`no cache read weight recorded for model ${model}`);
  const n = HORIZONS[h];
  const first = Number.isFinite(n) ? (CACHE_WRITE + (n - 1) * read) / n : read;
  return [first, read];
}

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
  return systemTokens >= min ? cachedWeights(model, h) : [1, 1];
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
    perAccepted: {
      cold: per('cold'),
      session10: per('session10'),
      session50: per('session50'),
      unbounded: per('unbounded'),
    },
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
  for (const h of SCORED_HORIZONS)
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
    pricing:
      'Costs are modelled from local o200k token counts, not billed (subjects ran as Claude Code subagents). Weights from the Claude API prompt-caching documentation (claude-api skill, shared/prompt-caching.md): 5-minute cache write 1.25x on the first call of a session, paid once per horizon (share 1.25/N per edit); cache read 0.1x for Haiku and Sonnet (0.05x is the Opus rate and is not used here); minimum cacheable prefix 512 tokens for both models; a shorter system text bills weight 1 on every call. Unbounded is the limit N -> infinity. session50 is reported, not scored by the pre-registered rule.',
    cacheMinimum: CACHE_MINIMUM,
    cacheWrite: CACHE_WRITE,
    cacheRead: CACHE_READ,
    cachedWeights: Object.fromEntries(
      Object.keys(CACHE_MINIMUM).map((m) => [
        m,
        Object.fromEntries(
          (Object.keys(HORIZONS) as Horizon[]).map((h) => [h, cachedWeights(m, h)]),
        ),
      ]),
    ),
    cells,
    verdicts,
  });
  process.stdout.write(`${JSON.stringify(verdicts, null, 1)}\n`);
}
