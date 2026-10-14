/**
 * Content revisions: SHA-256 of the canonical source form of a function or a program. Its own
 * module so that `a0 check` (src/cli.ts), which prints revisions, does not load src/edit.ts;
 * src/edit.ts re-exports both.
 */

import { createRequire } from 'node:module';
import { type Func, formatFunction, formatProgram, type Program, reusing } from './core.js';

type CreateHash = typeof import('node:crypto').createHash;
let createHash: CreateHash | undefined;

/**
 * SHA-256 of the UTF-8 bytes of a text, lowercase hex. node:crypto is loaded at the first hash, and
 * through `require`: importing it as an ES module builds its namespace, which reads every lazy
 * export (webcrypto among them) and roughly doubles its load time at each start of the CLI.
 */
function sha256Hex(text: string): string {
  createHash ??= (createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto'))
    .createHash;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Content revision of a function: SHA-256 of its canonical source form. */
const revisions = new WeakMap<Func, string>();

export function revision(fn: Func): string {
  if (!reusing()) return sha256Hex(formatFunction(fn));
  let rev = revisions.get(fn);
  if (rev === undefined) {
    rev = sha256Hex(formatFunction(fn));
    revisions.set(fn, rev);
  }
  return rev;
}

/** Content revision of a whole program. */
const programRevisions = new WeakMap<Program, string>();

export function programRevision(program: Program): string {
  const hash = (): string => sha256Hex(formatProgram(program));
  if (!reusing()) return hash();
  let rev = programRevisions.get(program);
  if (rev === undefined) {
    rev = hash();
    programRevisions.set(program, rev);
  }
  return rev;
}
