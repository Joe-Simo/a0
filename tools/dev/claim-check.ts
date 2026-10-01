/**
 * claim-check: numeric or comparative claims in STATUS.md, docs/history/*.md and site/gen/*.tpl
 * need a nearby results/*.json reference or a recorded value, and a speed claim recorded at a
 * machine load above 10 is flagged (the repo's rule: performance claims only from quiet or
 * interleaved runs). A history file marked `claim-check: archive` in its first lines is a dated
 * record: it is scanned and counted, but only a reference to a missing results file is flagged.
 *
 *   bun tools/dev/claim-check.ts [--since=<ref>] [--strict] [--files=a.md,b.tpl] [--json]
 *
 * No flag: scan everything, report, exit 0 (the existing ledger carries old unsupported claims).
 * --since=<ref>: only claims on lines added or changed since the ref are checked, and any flag
 * fails the run (this is what lint runs, so new claims must be supported). --strict fails on any.
 * `--json` prints every finding with its problems and the results files found.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultRepo, refExists, vcs } from './repo.js';

export type ClaimKind = 'ratio' | 'percent' | 'comparative';
export interface Claim {
  readonly file: string;
  readonly line: number;
  readonly kind: ClaimKind;
  readonly text: string;
  readonly speed: boolean;
}
export interface Finding extends Claim {
  readonly problems: string[];
  readonly refs: string[];
}

const RATIO = /(?<![0-9A-Za-z_.])\d+(?:\.\d+)?\s?(?:×|x)(?![0-9A-Za-z_])/;
const PERCENT = /(?<![0-9A-Za-z_])\d+(?:\.\d+)?\s?%/;
const COMPARATIVE = /\b(faster|slower|fewer|fastest|cheaper|speed-?up)\b/i;
const SPEED =
  /\b(faster|slower|fastest|speed-?up|ns per call|geomean|ahead of|behind clang|behind)\b|(?:×|x)\s+(?:faster|slower)/i;
const RESULT_REF = /results\/[A-Za-z0-9_.*-]+\.json/g;
const WAIVER = /claim-ok:\s*\S+/;
const LOAD_THRESHOLD = 10;
const WINDOW = 10;

function detect(text: string): ClaimKind | null {
  if (RATIO.test(text)) return 'ratio';
  if (PERCENT.test(text)) return 'percent';
  if (COMPARATIVE.test(text)) return 'comparative';
  return null;
}

/** Load averages stated in prose or JSON near a claim ("load average 10-23", "loadAverage": [..]). */
export function loadsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(
    /load(?:\s*average|avg| avg)?[^0-9\n]{0,24}(\d+(?:\.\d+)?)(?:\s*[-–to]+\s*(\d+(?:\.\d+)?))?/gi,
  )) {
    out.push(Number(m[1]));
    if (m[2]) out.push(Number(m[2]));
  }
  return out.filter((n) => Number.isFinite(n));
}

function resultsExist(root: string, ref: string): boolean {
  if (!ref.includes('*')) return existsSync(join(root, ref));
  const rx = new RegExp(
    `^${ref.replace('results/', '').replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`,
  );
  return (
    existsSync(join(root, 'results')) && readdirSync(join(root, 'results')).some((f) => rx.test(f))
  );
}

/** Claim candidates in a STATUS-style markdown file (sections are `#` headings). */
export function scanMarkdown(file: string, text: string): { claims: Claim[]; lines: string[] } {
  const lines = text.split('\n');
  const claims: Claim[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence || /^\s*\|?\s*-{3,}/.test(l)) return;
    const kind = detect(l.replace(/`[^`]*`/g, ''));
    if (kind)
      claims.push({ file, line: i + 1, kind, text: l.trim().slice(0, 240), speed: SPEED.test(l) });
  });
  return { claims, lines };
}

/** Text lines of a site template: `"` text and `=tag text` lines; placeholders mean data-driven. */
export function scanTemplate(file: string, text: string): { claims: Claim[]; lines: string[] } {
  const lines = text.split('\n');
  const claims: Claim[] = [];
  lines.forEach((l, i) => {
    if (!/^(?:"|=\w+\s)/.test(l)) return;
    const kind = detect(l);
    if (kind)
      claims.push({ file, line: i + 1, kind, text: l.trim().slice(0, 240), speed: SPEED.test(l) });
  });
  return { claims, lines };
}

function sectionBounds(lines: string[], at: number, md: boolean): [number, number] {
  if (!md) return [Math.max(0, at - WINDOW), Math.min(lines.length - 1, at + WINDOW)];
  let s = at;
  while (s > 0 && !/^#{1,6}\s/.test(lines[s] ?? '')) s -= 1;
  let e = at + 1;
  while (e < lines.length && !/^#{1,6}\s/.test(lines[e] ?? '')) e += 1;
  return [Math.max(s, at - 40), Math.min(e - 1, at + 40)];
}

/** A history file says so in its first lines: its claims are dated records, not current claims. */
export const ARCHIVE_MARK = /^claim-check:\s*archive\b/m;

export function isArchive(text: string): boolean {
  return ARCHIVE_MARK.test(text.split('\n').slice(0, 12).join('\n'));
}

export function checkClaim(root: string, claim: Claim, lines: string[], archive = false): Finding {
  const md = claim.file.endsWith('.md');
  const idx = claim.line - 1;
  const [s, e] = sectionBounds(lines, idx, md);
  const near = lines.slice(Math.max(s, idx - WINDOW), Math.min(e, idx + WINDOW) + 1).join('\n');
  const own = lines[idx] ?? '';
  const refs = [...new Set(near.match(RESULT_REF) ?? [])];
  const existing = refs.filter((r) => resultsExist(root, r));
  const problems: string[] = [];
  // An archived record (docs/history) is not a current claim: it needs no results reference and a
  // timing taken under load is part of the record, but a reference it does make must still resolve.
  const waived = archive || WAIVER.test(near);
  // Templates: a placeholder on the line, or the page header's `f ... results/x.json` lines, mean
  // the number comes from a results file at generation time.
  const dataDriven = !md && (/\$[a-z_0-9]+\$|%[a-z]/i.test(own) || /^c\s+\w+/m.test(near));
  if (!waived && !dataDriven && existing.length === 0) {
    const hint = md
      ? 'no results/*.json reference within the section window'
      : 'hard-coded number with no results/*.json reference or `# claim-ok: reason` nearby';
    problems.push(`unsupported: ${hint}`);
  }
  if (refs.length > existing.length) {
    problems.push(
      `reference to a missing results file: ${refs.filter((r) => !existing.includes(r)).join(', ')}`,
    );
  }
  if (claim.speed && !archive) {
    const loads = loadsIn(near);
    const worst = loads.length ? Math.max(...loads) : 0;
    if (worst > LOAD_THRESHOLD) {
      problems.push(
        `speed claim recorded at machine load ${worst}, above ${LOAD_THRESHOLD}: no timing claim from a run above that load`,
      );
    }
  }
  return { ...claim, problems, refs: existing };
}

export function checkFile(root: string, file: string, text: string): Finding[] {
  const scan = file.endsWith('.tpl') ? scanTemplate(file, text) : scanMarkdown(file, text);
  const archive = file.endsWith('.md') && isArchive(text);
  return scan.claims.map((c) => checkClaim(root, c, scan.lines, archive));
}

/** Line numbers added or changed in `file` since `ref` (working tree included). */
export function changedLines(root: string, ref: string, file: string): Set<number> {
  const out = new Set<number>();
  // diff from the merge base, so lines that only the moving base added are not this branch's claims
  const mb = vcs(root, ['merge-base', ref, 'HEAD']);
  const from = mb.ok ? mb.stdout.trim() : ref;
  const diff = vcs(root, ['diff', '-U0', from, '--', file]);
  for (const m of diff.stdout.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < n; i += 1) out.add(start + i);
  }
  return out;
}

function arg(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export const CLAIM_FILES = (root: string): string[] => [
  'STATUS.md',
  ...(existsSync(join(root, 'docs', 'history'))
    ? readdirSync(join(root, 'docs', 'history'))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => `docs/history/${f}`)
    : []),
  ...(existsSync(join(root, 'site', 'gen'))
    ? readdirSync(join(root, 'site', 'gen'))
        .filter((f) => f.endsWith('.tpl'))
        .map((f) => `site/gen/${f}`)
    : []),
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = arg(args, 'repo') ?? defaultRepo();
  let since = arg(args, 'since');
  if (since && !refExists(root, since)) {
    const alt = refExists(root, 'main') ? 'main' : undefined;
    if (!alt) {
      process.stdout.write(`claim-check: ref ${since} not found; skipped\n`);
      return;
    }
    since = alt;
  }
  const findings: Finding[] = [];
  let total = 0;
  const only_files = arg(args, 'files');
  const targets = only_files ? only_files.split(',').filter(Boolean) : CLAIM_FILES(root);
  for (const file of targets) {
    const p = join(root, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const only = since ? changedLines(root, since, file) : null;
    const all = checkFile(root, file, text).filter((f) => !only || only.has(f.line));
    total += all.length;
    findings.push(...all.filter((f) => f.problems.length > 0));
  }
  if (args.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ since: since ?? null, claims: total, findings }, null, 2)}\n`,
    );
  } else {
    for (const f of findings) {
      process.stdout.write(`${f.file}:${f.line}: ${f.problems.join(' | ')}\n    ${f.text}\n`);
    }
    process.stdout.write(
      `claim-check: ${total} claims${since ? ` on lines changed since ${since}` : ''}, ${findings.length} flagged\n`,
    );
  }
  if (findings.length > 0 && (since || args.includes('--strict'))) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
