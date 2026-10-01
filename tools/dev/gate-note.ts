/**
 * Gate notes: a passing gate run is recorded as a note on the commit (refs/notes/a0-gate) and bound
 * to that commit's TREE. A note is valid only while the tree of the commit it sits on equals the tree
 * it recorded, so a rebased or amended commit with different content cannot inherit a pass.
 *
 *   node dist/tools/dev/gate-note.js show [<rev>]
 */

import { pathToFileURL } from 'node:url';
import type { StepId } from './gate-scope.js';
import { defaultRepo, vcs } from './repo.js';

export const NOTES_REF = 'refs/notes/a0-gate';

export interface GateNote {
  readonly v: 1;
  readonly tree: string;
  readonly steps: readonly string[];
  readonly light: boolean;
  readonly result: 'pass' | 'fail';
  readonly at: string;
}

export function treeOf(repo: string, rev: string): string | null {
  const r = vcs(repo, ['rev-parse', '--verify', '-q', `${rev}^{tree}`]);
  return r.ok ? r.stdout.trim() : null;
}

export function commitOf(repo: string, rev: string): string | null {
  const r = vcs(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
}

export function writeNote(
  repo: string,
  rev: string,
  note: Omit<GateNote, 'v' | 'tree' | 'at'>,
): GateNote | null {
  const commit = commitOf(repo, rev);
  const tree = treeOf(repo, rev);
  if (!commit || !tree) return null;
  const full: GateNote = { v: 1, tree, at: new Date().toISOString(), ...note };
  const r = vcs(repo, [
    'notes',
    `--ref=${NOTES_REF}`,
    'add',
    '-f',
    '-m',
    JSON.stringify(full),
    commit,
  ]);
  return r.ok ? full : null;
}

export function readNote(repo: string, rev: string): GateNote | null {
  const commit = commitOf(repo, rev);
  if (!commit) return null;
  const r = vcs(repo, ['notes', `--ref=${NOTES_REF}`, 'show', commit]);
  if (!r.ok) return null;
  try {
    const n = JSON.parse(r.stdout.trim()) as GateNote;
    return n.v === 1 ? n : null;
  } catch {
    return null;
  }
}

/** Does `rev` carry a passing note for its current tree that covers every step in `needed`? */
export function noteCovers(
  repo: string,
  rev: string,
  needed: readonly StepId[],
): { readonly ok: boolean; readonly why: string } {
  const n = readNote(repo, rev);
  if (!n) return { ok: false, why: 'no gate note' };
  if (n.result !== 'pass') return { ok: false, why: 'the gate note records a failure' };
  if (n.tree !== treeOf(repo, rev)) {
    return {
      ok: false,
      why: 'the note is bound to a different tree (content changed since the gate)',
    };
  }
  const missing = needed.filter((s) => !n.steps.includes(s));
  if (missing.length) return { ok: false, why: `the note does not cover ${missing.join(', ')}` };
  return {
    ok: true,
    why: `passing note for tree ${n.tree.slice(0, 10)} (${n.light ? 'light' : 'full'}, ${n.steps.length} steps)`,
  };
}

/** True when tracked files have uncommitted changes (a gate on such a tree is not about the commit). */
export function dirtyTracked(repo: string): boolean {
  return vcs(repo, ['status', '--porcelain', '--untracked-files=no']).stdout.trim().length > 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, rev = 'HEAD'] = process.argv.slice(2);
  if (cmd === 'show') {
    process.stdout.write(`${JSON.stringify(readNote(defaultRepo(), rev), null, 2)}\n`);
  } else {
    process.stdout.write('usage: gate-note show [<rev>]  (notes are written by dev-gate)\n');
  }
}
