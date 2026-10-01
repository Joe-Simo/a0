/**
 * prereview: classifies each added hunk of a diff before the gate spends an hour on it.
 *   symptom-patch    a special case keyed to one input, test or task name, or a workaround marker
 *   hidden-fallback  an error swallowed or defaulted so a failure no longer shows
 *   fabricated-const a literal in code that also appears as an expected value in the same diff's tests
 *   thick-shim       a large addition to a shim, compat, polyfill, adapter or wrapper file
 *   framework-branch a branch in shared core code keyed to one kernel, task or corpus name
 * Each finding has a weight; a total of 1 or more means rework before the gate. These are
 * heuristics over added lines only: a flag asks for a look, it is not a verdict.
 *
 *   node dist/tools/dev/prereview.js [--base=<ref>] [--json]      (or --diff=<file>)
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SHARED_CORE } from './gate-scope.js';
import { defaultBase, defaultRepo, vcs } from './repo.js';

export type Kind =
  | 'symptom-patch'
  | 'hidden-fallback'
  | 'fabricated-const'
  | 'thick-shim'
  | 'framework-branch';
export interface Finding {
  readonly kind: Kind;
  readonly file: string;
  readonly line: number;
  readonly weight: number;
  readonly text: string;
}
export interface Review {
  readonly findings: readonly Finding[];
  readonly score: number;
  readonly verdict: 'rework' | 'look' | 'ok';
}

interface Added {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export function addedLines(diff: string): Added[] {
  const out: Added[] = [];
  let file = '';
  let line = 0;
  for (const l of diff.split('\n')) {
    const f = /^\+\+\+ b\/(.*)$/.exec(l);
    if (f) {
      file = f[1] as string;
      continue;
    }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      out.push({ file, line, text: l.slice(1) });
      line += 1;
    } else if (!l.startsWith('-')) line += 1;
  }
  return out;
}

const isTest = (f: string): boolean => f.startsWith('test/') || /\.test\.[tj]s$/.test(f);
const SHIMMY = /shim|compat|polyfill|adapter|wrapper/i;

export function reviewDiff(diff: string): Review {
  const added = addedLines(diff);
  const findings: Finding[] = [];
  const push = (kind: Kind, a: Added, weight: number): void => {
    findings.push({ kind, file: a.file, line: a.line, weight, text: a.text.trim().slice(0, 160) });
  };
  const testLits = new Set<string>();
  for (const a of added.filter((x) => isTest(x.file))) {
    for (const m of a.text.matchAll(/\b\d{5,}\b|0x[0-9a-fA-F]{5,}/g)) testLits.add(m[0]);
  }
  const perFile = new Map<string, number>();
  for (const a of added) {
    perFile.set(a.file, (perFile.get(a.file) ?? 0) + 1);
    if (isTest(a.file) || /\.(md|txt|json)$/.test(a.file)) continue;
    const t = a.text;
    if (/\b(workaround|hack|kludge|for now)\b|TODO:?\s*remove/i.test(t))
      push('symptom-patch', a, 0.4);
    if (/if\s*\(\s*[\w.]+\s*===?\s*['"][\w./-]+\.(?:a0|ts)['"]/.test(t))
      push('symptom-patch', a, 0.6);
    if (/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*)?\s*\}/.test(t))
      push('hidden-fallback', a, 0.5);
    if (/\.catch\(\s*\(\)\s*=>\s*(?:null|undefined|\{\}|\[\])\s*\)/.test(t))
      push('hidden-fallback', a, 0.5);
    if (
      /catch\s*(?:\([^)]*\))?\s*\{\s*return\s+(?:null|undefined|false|0|\[\]|\{\})\s*;?\s*\}/.test(
        t,
      )
    )
      push('hidden-fallback', a, 0.4);
    for (const m of t.matchAll(/\b\d{5,}\b|0x[0-9a-fA-F]{5,}/g)) {
      if (testLits.has(m[0])) push('fabricated-const', a, 0.7);
    }
    if (
      SHARED_CORE.includes(a.file) &&
      /\b(kernel|task|corpus|fixture|testName)\w*\s*===?\s*['"][\w./-]+['"]/.test(t)
    ) {
      push('framework-branch', a, 0.7);
    }
  }
  for (const [file, n] of perFile) {
    if (SHIMMY.test(file) && n > 80) {
      findings.push({
        kind: 'thick-shim',
        file,
        line: 0,
        weight: Math.min(1, n / 200),
        text: `${n} added lines in a shim-like file`,
      });
    }
  }
  const score = Number(findings.reduce((s, f) => s + f.weight, 0).toFixed(2));
  return { findings, score, verdict: score >= 1 ? 'rework' : score > 0 ? 'look' : 'ok' };
}

function arg(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const repo = defaultRepo();
  const file = arg(args, 'diff');
  const diff = file
    ? readFileSync(file, 'utf8')
    : vcs(repo, [
        'diff',
        '-U0',
        vcs(repo, ['merge-base', arg(args, 'base') ?? defaultBase(repo), 'HEAD']).stdout.trim(),
      ]).stdout;
  const r = reviewDiff(diff);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    for (const f of r.findings)
      process.stdout.write(`${f.kind} ${f.file}:${f.line} (${f.weight}) ${f.text}\n`);
    process.stdout.write(`prereview: score ${r.score}, ${r.verdict}\n`);
  }
  process.exit(r.verdict === 'rework' ? 1 : 0);
}
