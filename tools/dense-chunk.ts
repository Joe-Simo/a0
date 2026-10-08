/**
 * Host side of the dense reader in A0 (compiler/dense.a0): what the host passes to the reader besides the
 * dense text of a program.
 *
 * Stubs. A call needs the parameter count of its callee. When the callee is defined in a file the program
 * `use`s, or in an earlier chunk of the same program, the reader cannot see it; the host writes its canonical
 * header as a stub line in front of the text,
 *
 *     use fn NAME TYPES -> RESULT
 *
 * and the reader reads the header (the parameter types, the result) and writes nothing for it. A stub
 * line comes after the `use "file"` lines or before them, never after a function.
 *
 * Chunks. The reader's capacities are per input, so a program larger than one input is cut at function
 * boundaries into chunks (`planChunks`); the chunk of functions F gets, as stubs, the headers of the
 * functions it calls that earlier chunks (or used files) define. The canonical text of the program is the
 * outputs of the chunks joined with one newline: the reader ends each function with a blank line, so the
 * chunk outputs are the functions in order.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type Func, formatType, type Program, parse, type Type } from '../src/core.js';
import { formatDense } from '../src/dense.js';

/** A function's signature, as its canonical header writes it. */
export interface Signature {
  readonly params: readonly Type[];
  readonly result: Type;
}

/** The stub line of a function: its canonical header after `use `. */
export function stubLine(name: string, sig: Signature): string {
  const types = sig.params.length > 0 ? ` ${sig.params.map(formatType).join(' ')}` : '';
  return `use fn ${name}${types} -> ${formatType(sig.result)}`;
}

/** The names a function calls, folds or loops over. */
export function callees(f: Func): string[] {
  const out: string[] = [];
  for (const n of f.nodes) {
    if (n.callee !== undefined) out.push(n.callee);
    if (n.pred !== undefined) out.push(n.pred);
  }
  return out;
}

/** The signatures of every function the file `abs` uses, transitively (a file's own functions excluded). */
export function usedSignatures(abs: string): Map<string, Signature> {
  const sigs = new Map<string, Signature>();
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const program = parse(readFileSync(path, 'utf8'));
    for (const u of program.uses ?? []) visit(resolve(dirname(path), u));
    for (const f of program.functions) sigs.set(f.name, { params: f.params, result: f.result });
  };
  const program = parse(readFileSync(abs, 'utf8'));
  for (const u of program.uses ?? []) visit(resolve(dirname(abs), u));
  return sigs;
}

/** The parameter counts of a map of signatures (the `known` option of the reference). */
export function arities(sigs: ReadonlyMap<string, Signature>): Map<string, number> {
  return new Map([...sigs].map(([k, v]) => [k, v.params.length] as const));
}

/** Stub lines for the functions of `program` that are called and not defined in it, in a stable order. */
export function stubsOf(program: Program, sigs: ReadonlyMap<string, Signature>): string[] {
  const own = new Set(program.functions.map((f) => f.name));
  const need = new Set<string>();
  for (const f of program.functions) for (const c of callees(f)) if (!own.has(c)) need.add(c);
  const out: string[] = [];
  for (const name of [...need].sort()) {
    const sig = sigs.get(name);
    if (sig !== undefined) out.push(stubLine(name, sig));
  }
  return out;
}

/**
 * The dense text of a program written with the functions of its used files as known arities (`text`), and the
 * text the reader gets (`dense`): the same with the stub lines in front.
 */
export function denseWithStubs(
  program: Program,
  sigs: ReadonlyMap<string, Signature>,
): { dense: string; text: string } {
  const dense = formatDense(program, { known: arities(sigs) });
  const stubs = stubsOf(program, sigs);
  return { dense: stubs.length > 0 ? `${stubs.join('\n')}\n${dense}` : dense, text: dense };
}
