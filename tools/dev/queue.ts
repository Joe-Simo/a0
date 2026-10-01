/**
 * queue / brief: what to fix next, from the recorded results. Failed or blocked targets in
 * results/*.json are grouped by their first failure signature and ranked by rows unlocked (cases),
 * generality (how many targets or files share the signature) and cost (blocked-by-environment groups
 * rank last: nothing in the repo fixes a missing tool). `brief` adds, for the top group, the failing
 * rows' evidence and the gate steps a fix would need. Agents start from the brief.
 *
 *   node dist/tools/dev/queue.js [--json] [--brief]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { signature } from './history.js';
import { defaultRepo } from './repo.js';

export interface Group {
  readonly signature: string;
  readonly sample: string;
  readonly targets: readonly string[];
  readonly files: readonly string[];
  readonly rows: number;
  readonly blocked: boolean;
  readonly score: number;
}

interface Target {
  status?: string;
  cases?: number;
  detail?: string;
  failures?: string[];
}

/** Walk a results JSON for objects shaped like a target report. */
function targetsIn(node: unknown, path: string, out: [string, Target][]): void {
  if (Array.isArray(node)) return;
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.status === 'string' && ('cases' in o || 'detail' in o || 'failures' in o)) {
      out.push([path, o as Target]);
      return;
    }
    for (const [k, v] of Object.entries(o)) targetsIn(v, path ? `${path}.${k}` : k, out);
  }
}

const BAD = /^(failed|blocked|unverified)$/;

export function buildQueue(results: Record<string, unknown>): Group[] {
  const groups = new Map<
    string,
    { sample: string; targets: Set<string>; files: Set<string>; rows: number; blocked: boolean }
  >();
  for (const [file, json] of Object.entries(results)) {
    const found: [string, Target][] = [];
    targetsIn(json, '', found);
    for (const [path, t] of found) {
      if (!t.status || !BAD.test(t.status)) continue;
      const text = (t.failures?.[0] ?? t.detail ?? t.status).slice(0, 300);
      const sig = signature(text);
      const g = groups.get(sig) ?? {
        sample: text,
        targets: new Set<string>(),
        files: new Set<string>(),
        rows: 0,
        blocked: t.status !== 'failed',
      };
      g.targets.add(path);
      g.files.add(file);
      g.rows += t.cases ?? 1;
      g.blocked = g.blocked && t.status !== 'failed';
      groups.set(sig, g);
    }
  }
  return [...groups.entries()]
    .map(([sig, g]) => ({
      signature: sig,
      sample: g.sample,
      targets: [...g.targets].sort(),
      files: [...g.files].sort(),
      rows: g.rows,
      blocked: g.blocked,
      score: (g.blocked ? 0.1 : 1) * g.rows * (1 + Math.log2(g.targets.size)),
    }))
    .sort((a, b) => Number(a.blocked) - Number(b.blocked) || b.score - a.score);
}

export function loadResults(repo: string): Record<string, unknown> {
  const dir = join(repo, 'results');
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('ai-edit'))) {
    try {
      out[`results/${f}`] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      // unreadable result files are not queue input
    }
  }
  return out;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const q = buildQueue(loadResults(defaultRepo()));
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(q, null, 2)}\n`);
  } else if (q.length === 0) {
    process.stdout.write('queue: no failed or blocked targets in results/*.json\n');
  } else {
    for (const [i, g] of q.slice(0, args.includes('--brief') ? 1 : 15).entries()) {
      process.stdout.write(
        `${i + 1}. score ${g.score.toFixed(1)}  ${g.rows} rows  ${g.targets.length} targets${g.blocked ? '  BLOCKED by environment' : ''}\n   ${g.targets.slice(0, 4).join(', ')}\n   ${g.sample}\n`,
      );
    }
  }
}
