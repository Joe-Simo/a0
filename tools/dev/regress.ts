/**
 * regress / decide: sorts a failed gate step into real regression, flake, pre-existing failure or
 * unexplained (needs evidence), from the recorded history. A flake is quarantined only when two
 * distinct runs on the same tree disagree; a single failing run is never called a flake or a
 * regression, it is "unexplained" with the evidence still to gather.
 *
 *   node dist/tools/dev/regress.js --step=verify [--tree=<tree>] [--base=<ref>] [--json]
 *
 * Quarantined steps are listed in .a0-cache/quarantine.json (git-ignored).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { treeOf } from './gate-note.js';
import { type Decision, decideFailure, loadHistory } from './history.js';
import { defaultBase, defaultRepo } from './repo.js';

export function quarantine(repo: string, step: string): void {
  const p = join(repo, '.a0-cache', 'quarantine.json');
  mkdirSync(join(repo, '.a0-cache'), { recursive: true });
  const cur: string[] = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as string[]) : [];
  if (!cur.includes(step)) writeFileSync(p, `${JSON.stringify([...cur, step])}\n`);
}

function arg(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function decideStep(repo: string, step: string, tree: string, baseRef: string): Decision {
  return decideFailure(loadHistory(repo), step, tree, treeOf(repo, baseRef));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const repo = defaultRepo();
  const step = arg(args, 'step');
  const tree = arg(args, 'tree') ?? treeOf(repo, 'HEAD');
  if (!step || !tree) {
    process.stderr.write('usage: regress --step=<step> [--tree=<tree>] [--base=<ref>] [--json]\n');
    process.exit(2);
  }
  const d = decideStep(repo, step, tree, arg(args, 'base') ?? defaultBase(repo));
  if (d.quarantine) quarantine(repo, step);
  process.stdout.write(
    args.includes('--json')
      ? `${JSON.stringify({ step, tree, ...d }, null, 2)}\n`
      : `${step}: ${d.verdict}. ${d.reason}. next: ${d.next}\n`,
  );
}
