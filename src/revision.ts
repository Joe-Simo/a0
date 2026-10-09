/**
 * Content revisions: SHA-256 of the canonical source form of a function or a program. Its own
 * module so that `a0 check` (src/cli.ts), which prints revisions, does not load src/edit.ts;
 * src/edit.ts re-exports both.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type Func, formatFunction, formatProgram, type Program, reusing } from './core.js';

/** Content revision of a function: SHA-256 of its canonical source form. */
const revisions = new WeakMap<Func, string>();

export function revision(fn: Func): string {
  if (!reusing()) return bytesToHex(sha256(new TextEncoder().encode(formatFunction(fn))));
  let rev = revisions.get(fn);
  if (rev === undefined) {
    rev = bytesToHex(sha256(new TextEncoder().encode(formatFunction(fn))));
    revisions.set(fn, rev);
  }
  return rev;
}

/** Content revision of a whole program. */
const programRevisions = new WeakMap<Program, string>();

export function programRevision(program: Program): string {
  const hash = (): string => bytesToHex(sha256(new TextEncoder().encode(formatProgram(program))));
  if (!reusing()) return hash();
  let rev = programRevisions.get(program);
  if (rev === undefined) {
    rev = hash();
    programRevisions.set(program, rev);
  }
  return rev;
}
