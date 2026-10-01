/**
 * scrub-results: results files record subject replies and tool errors, and those carry local
 * path fragments (a home directory, a temp directory, an agent worktree, a session folder). They
 * say nothing about a measurement, so they are replaced with neutral placeholders:
 *
 *   <repo>   a checkout of this repository (including an agent worktree of it)
 *   <home>   some other home directory
 *   <tmp>    a temp or scratch directory (the file name inside it is kept)
 *
 * The scrub is deterministic and idempotent (a placeholder never matches a rule), it works on the
 * raw JSON text and only ever swaps characters inside strings, so no number, key order or
 * structure changes. Every tool that writes a results file goes through `reportJson` /
 * `writeReport`, so new results stay clean; `bun tools/scrub-results.ts` cleans existing ones.
 *
 *   bun tools/scrub-results.ts [--check] [paths...]   (default path: results)
 *
 * `--check` changes nothing and exits 1 when a file would change (lint runs it).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATH_CHARS = String.raw`[^\s"'\\,;)\]\x60]`;

/** A per-session agent scratch folder under the system temp root (claude-<uid>/<project>/<session>/scratchpad/...). */
const SESSION_TMP = new RegExp(String.raw`(?:/private)?/tmp/claude-\d+(?:/${PATH_CHARS}*)?`, 'g');
/** macOS per-user temp roots (the var folders tree), whole or cut short by a truncated message. */
const VAR_FOLDERS =
  /(?:\/private)?\/var\/fol(?:d(?:e(?:rs?)?)?)?(?:\/[A-Za-z0-9_]+){0,2}(?:\/[TC0](?![A-Za-z0-9_]))?/g;
const WORKTREE =
  /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+)\/[^\s"'\\]*?\.claude\/worktrees\/agent-[0-9a-f]+/g;
const CHECKOUT = /\/Users\/[A-Za-z0-9._-]+\/Downloads\/a0(?![A-Za-z0-9._-])/g;
const HOME = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/g;
const BARE_WORKTREE = /\.claude\/worktrees\/agent-[0-9a-f]+/g;
const ENCODED = /-Users-[A-Za-z0-9._]+-Downloads-a0/g;

function sessionTmp(path: string): string {
  const parts = path.split('/');
  const at = parts.indexOf('scratchpad');
  if (at < 0) return '<tmp>';
  const rest = parts.slice(at + 1).filter((p) => p !== '');
  const last = rest[rest.length - 1];
  return last === undefined ? '<tmp>' : `<tmp>/${last}`;
}

export function scrubText(text: string): string {
  return text
    .replace(SESSION_TMP, (m) => sessionTmp(m))
    .replace(VAR_FOLDERS, '<tmp>')
    .replace(/(?:\.\.\/)*\.\.<tmp>/g, '<tmp>')
    .replace(WORKTREE, '<repo>')
    .replace(CHECKOUT, '<repo>')
    .replace(HOME, '<home>')
    .replace(BARE_WORKTREE, '<repo>')
    .replace(ENCODED, '<repo>');
}

/** The text a results writer stores: indented JSON, a trailing newline, local paths scrubbed. */
export function reportJson(value: unknown): string {
  return scrubText(`${JSON.stringify(value, null, 2)}\n`);
}

export async function writeReport(path: string, value: unknown): Promise<void> {
  await writeFile(path, reportJson(value), 'utf8');
}

function walk(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((n) => walk(join(path, n)));
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const roots = args.filter((a) => !a.startsWith('--'));
  const files = (roots.length > 0 ? roots : ['results']).flatMap(walk);
  let changed = 0;
  for (const f of files) {
    if (!/\.(json|txt|md)$/.test(f)) continue;
    const before = readFileSync(f, 'utf8');
    const after = scrubText(before);
    if (after === before) continue;
    changed += 1;
    if (check) process.stdout.write(`${f}: local paths present\n`);
    else writeFileSync(f, after, 'utf8');
  }
  process.stdout.write(
    `scrub-results: ${files.length} files, ${changed} ${check ? 'need a scrub' : 'rewritten'}\n`,
  );
  if (check && changed > 0) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
