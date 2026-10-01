/**
 * Gate history: every step run is recorded in .a0-cache/gate-history.json (git-ignored, per
 * worktree). `decideFailure` uses it to tell a real regression from a flake and from a failure that
 * was already there, and says what evidence is missing when it cannot.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HistoryRow {
  readonly tree: string;
  readonly step: string;
  readonly rc: number;
  /** Signature of the failure: hash of the normalised last lines of the log ('' on pass). */
  readonly sig: string;
  readonly run: string;
  readonly at: string;
  /** True when the run was made on the base (a reference run). */
  readonly base: boolean;
}

export type Verdict = 'real-regression' | 'flake' | 'pre-existing' | 'unexplained';
export interface Decision {
  readonly verdict: Verdict;
  readonly reason: string;
  /** What to do next; for unexplained results, the evidence to gather. */
  readonly next: string;
  /** Flake confirmed by two distinct runs on one tree with different outcomes. */
  readonly quarantine: boolean;
}

const file = (repo: string): string => join(repo, '.a0-cache', 'gate-history.json');

export function loadHistory(repo: string): HistoryRow[] {
  try {
    return existsSync(file(repo))
      ? (JSON.parse(readFileSync(file(repo), 'utf8')) as HistoryRow[])
      : [];
  } catch {
    return [];
  }
}

export function appendHistory(repo: string, rows: readonly HistoryRow[]): void {
  mkdirSync(join(repo, '.a0-cache'), { recursive: true });
  const all = [...loadHistory(repo), ...rows].slice(-5000);
  const tmp = `${file(repo)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all)}\n`);
  renameSync(tmp, file(repo));
}

/** A stable signature of a failing log: last 30 non-empty lines, with numbers, paths and times removed. */
export function signature(log: string): string {
  const tail = log
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-30)
    .map((l) =>
      l
        .replace(/\/[\w./@-]+/g, '<path>')
        .replace(/\d+(?:\.\d+)?(?:ms|s)?/g, '#')
        .replace(/\s+/g, ' '),
    )
    .join('\n');
  return createHash('sha256').update(tail).digest('hex').slice(0, 12);
}

/**
 * Classify a failed step on `tree` against the history.
 *  - the step both passed and failed on the same tree across distinct runs: flake (quarantine)
 *  - the base tree fails the step with the same signature: pre-existing, not this change
 *  - the base passes and the failure repeats (same signature, two distinct runs): real regression
 *  - anything else: unexplained, with the evidence still needed
 */
export function decideFailure(
  history: readonly HistoryRow[],
  step: string,
  tree: string,
  baseTree: string | null,
): Decision {
  const mine = history.filter((r) => r.step === step && r.tree === tree);
  const runs = new Set(mine.map((r) => r.run));
  const fails = mine.filter((r) => r.rc !== 0);
  const passes = mine.filter((r) => r.rc === 0);
  if (fails.length === 0) {
    return {
      verdict: 'unexplained',
      reason: 'no failing record on this tree',
      next: `run ${step} on this tree`,
      quarantine: false,
    };
  }
  if (passes.length > 0 && runs.size >= 2) {
    return {
      verdict: 'flake',
      reason: `${step} both passed and failed on the same tree across ${runs.size} distinct runs`,
      next: 'quarantine the failing check and track it; do not block the merge on it alone',
      quarantine: true,
    };
  }
  const base = baseTree ? history.filter((r) => r.step === step && r.tree === baseTree) : [];
  const sigs = new Set(fails.map((r) => r.sig));
  if (base.some((r) => r.rc !== 0 && sigs.has(r.sig))) {
    return {
      verdict: 'pre-existing',
      reason: 'the base fails this step with the same signature',
      next: 'not caused by this change; fix it on its own',
      quarantine: false,
    };
  }
  const failRuns = new Set(fails.map((r) => r.run));
  if (base.some((r) => r.rc === 0) && failRuns.size >= 2 && sigs.size === 1) {
    return {
      verdict: 'real-regression',
      reason: 'the base passes; this tree fails the same way in two distinct runs',
      next: 'revert or fix the branch that touches this step',
      quarantine: false,
    };
  }
  const need: string[] = [];
  if (failRuns.size < 2) need.push(`rerun ${step} on this tree (a second distinct run)`);
  if (!base.length) need.push(`run ${step} on the base tree`);
  if (sigs.size > 1) need.push('the failure signature changed between runs; read both logs');
  return {
    verdict: 'unexplained',
    reason: 'not enough evidence to separate a regression from a flake',
    next: need.join('; ') || 'gather another run',
    quarantine: false,
  };
}
