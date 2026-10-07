/**
 * Dev-loop timing: wall-clock of each loop step, recorded per mode so the measured speedup of an
 * assisted loop over the rules-only loop can be published from data, not assumed.
 * results/dev-loop.json holds {entries: [{step, mode, ms, load1, at}]}; `summarize` gives per-step
 * medians for each mode and their ratio, using only entries recorded at load 10 or below.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemLoad } from '../system-load.js';

export type LoopMode = 'baseline' | 'assisted' | 'fast';
export interface LoopEntry {
  readonly step: string;
  readonly mode: LoopMode;
  readonly ms: number;
  readonly load1: number;
  readonly at: string;
}
export interface LoopLog {
  readonly meaning: string;
  readonly entries: LoopEntry[];
}

const MEANING =
  'Wall-clock milliseconds per development-loop step. baseline: the rules-only loop (manual or deterministic tools). assisted: the same step with a decision-assisted wrapper. Medians per step; load1 is the 1-minute load average when the step ended (timings above load 10 are not publishable).';

export const logPath = (repo: string): string => join(repo, 'results', 'dev-loop.json');

export function readLog(repo: string): LoopLog {
  const p = logPath(repo);
  if (!existsSync(p)) return { meaning: MEANING, entries: [] };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as LoopLog;
    return { meaning: MEANING, entries: j.entries ?? [] };
  } catch {
    return { meaning: MEANING, entries: [] };
  }
}

export function record(repo: string, step: string, mode: LoopMode, ms: number): void {
  const log = readLog(repo);
  log.entries.push({
    step,
    mode,
    ms: Math.round(ms),
    load1: Number(systemLoad().toFixed(2)),
    at: new Date().toISOString(),
  });
  writeFileSync(logPath(repo), `${JSON.stringify(log, null, 2)}\n`);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export interface StepSummary {
  readonly step: string;
  readonly baselineMs: number | null;
  readonly assistedMs: number | null;
  readonly baselineN: number;
  readonly assistedN: number;
  /** baseline / assisted; null unless both modes have at least 3 entries at load 10 or below. */
  readonly speedup: number | null;
  readonly excludedLoaded: number;
}

export function summarize(log: LoopLog, maxLoad = 10): StepSummary[] {
  const steps = [...new Set(log.entries.map((e) => e.step))].sort();
  return steps.map((step) => {
    const all = log.entries.filter((e) => e.step === step);
    const quiet = all.filter((e) => e.load1 <= maxLoad);
    const b = quiet.filter((e) => e.mode === 'baseline').map((e) => e.ms);
    const a = quiet.filter((e) => e.mode === 'assisted').map((e) => e.ms);
    return {
      step,
      baselineMs: b.length ? median(b) : null,
      assistedMs: a.length ? median(a) : null,
      baselineN: b.length,
      assistedN: a.length,
      speedup: b.length >= 3 && a.length >= 3 ? Number((median(b) / median(a)).toFixed(2)) : null,
      excludedLoaded: all.length - quiet.length,
    };
  });
}
