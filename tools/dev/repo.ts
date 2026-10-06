import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo this tool lives in (two or three levels above dist/tools/dev or tools/dev). */
export function defaultRepo(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'STATUS.md'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

export interface GitResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
}

/** Runs the version-control binary in `repo` (always an explicit cwd). */
export function vcs(repo: string, args: readonly string[]): GitResult {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer };
    return { ok: false, code: err.status ?? 1, stdout: String(err.stdout ?? '') };
  }
}

export function refExists(repo: string, ref: string): boolean {
  return vcs(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).ok;
}

/**
 * The branch a change is measured against: `upstream/main` when the clone is a fork with an `upstream` remote (so a stale fork `origin/main` is
 * not used), else `origin/main`, else `main`.
 */
export function defaultBase(repo: string): string {
  if (refExists(repo, 'upstream/main')) return 'upstream/main';
  return refExists(repo, 'origin/main') ? 'origin/main' : 'main';
}

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Files changed from the merge base of `base` and HEAD to the working tree, plus untracked files. */
export function changedFiles(repo: string, base: string): string[] {
  const mb = vcs(repo, ['merge-base', base, 'HEAD']);
  const from = mb.ok ? mb.stdout.trim() : base;
  const diff = vcs(repo, ['diff', '--name-only', from]);
  const untracked = vcs(repo, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...lines(diff.stdout), ...lines(untracked.stdout)])].sort();
}

/** Files a branch changed relative to its merge base with `base`. */
export function branchFiles(repo: string, base: string, branch: string): string[] {
  return lines(vcs(repo, ['diff', '--name-only', `${base}...${branch}`]).stdout).sort();
}

export { lines };

/**
 * Two merge drivers for results/*.json (the attributes file maps each file to one):
 *   `a0-results`      the gate-regenerated pass/fail files (verification, equivalence, hardware,
 *                     behavior, selfhost, bootstrap, app, dotnet, gpu): keep the current side; the
 *                     gate regenerates them after the merge.
 *   `a0-measurements` every other results file, which records a timing or a measurement: chosen by
 *                     tools/dev/merge-results.ts (a load-gated run is never dropped for an ungated
 *                     one; see that file). It runs the built script next to this one (dist/tools/dev); without
 *                     the build the merge conflicts instead of dropping a side silently.
 * A merge driver must be configured per clone; `a0-dev setup` does it.
 */
export function ensureMergeDriver(
  repo: string,
  measurementScript = join(dirname(fileURLToPath(import.meta.url)), 'merge-results.js'),
): boolean {
  const a = vcs(repo, [
    'config',
    'merge.a0-results.name',
    'A0 results: regenerate, keep ours on merge',
  ]);
  const b = vcs(repo, ['config', 'merge.a0-results.driver', 'true']);
  const c = vcs(repo, [
    'config',
    'merge.a0-measurements.name',
    'A0 measurements: keep the load-gated, quieter, newer run',
  ]);
  const d = vcs(repo, [
    'config',
    'merge.a0-measurements.driver',
    `node "${measurementScript.replaceAll('\\', '/')}" %O %A %B %P`,
  ]);
  return a.ok && b.ok && c.ok && d.ok;
}
