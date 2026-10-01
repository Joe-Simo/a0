/**
 * Shape of one further AI-edit language (tools/ai-edit-langs.ts): its u32 semantics note,
 * file layout, hand translations of set B and of the set-C project filler, the generated
 * acceptance driver, and the build-and-run step. One module per language in this folder.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Type, TypedProgram, Value } from '../../src/core.js';
import type { FillerFunction } from '../ai-edit-tasks-c.js';

/** The twelve set-B task ids (tools/ai-edit-tasks-b.ts). */
export type BTaskId =
  | 'b-fits-inclusive'
  | 'b-sumfrom-eight'
  | 'b-rot8-constant'
  | 'b-onlyone-xor'
  | 'b-avgfloor-nowrap'
  | 'b-sumsq-array'
  | 'b-inrange-inclusive'
  | 'b-bounds-largest'
  | 'b-checksum-poly'
  | 'b-norm2-dot'
  | 'b-pctof-limit'
  | 'b-hamming-popcnt';

/** Unindented function texts of one task: the original and the reference solution. */
export interface Pair {
  readonly source: string;
  readonly reference: string;
}

export interface LangCase {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly expected: Value;
}

export type BuildResult = { readonly stdout: string } | { readonly error: string };

export interface LangSpec {
  /** Language primer (bucket 1), the counterpart of TS_SEMANTICS. */
  readonly semantics: string;
  /** Matches the first line of a top-level function text; group 1 is the name. */
  readonly head: RegExp;
  /** The whole source file around unindented function texts (module wrapper, imports). */
  readonly file: (body: string) => string;
  /** Set B: every task's original and reference function texts. */
  readonly b: Readonly<Record<BTaskId, Pair>>;
  /**
   * Set-A originals and set-C extras that fill the project program (unindented texts), and
   * one generated filler helper (generateFiller). Both are absent for languages translated
   * for set B only; set C is not available for them.
   */
  readonly filler?: string;
  readonly fillerText?: (f: FillerFunction) => string;
  /**
   * The driver program: for test i print one line `R<i> <canonical value>` (u32 decimal,
   * true/false, arrays and records as [a,b]), then `DONE`.
   */
  readonly driver: (tests: readonly LangCase[], typed: TypedProgram) => string;
  /** Writes the candidate and the driver into `dir`, builds, runs; stdout or `<label>: …`. */
  readonly buildAndRun: (dir: string, source: string, drv: string) => Promise<BuildResult>;
  /** Failure prefix of the static/build step (the harness's `compile` status). */
  readonly compileLabel: string;
}

/** A0 parameter and result types of the function a test calls. */
export function signature(
  typed: TypedProgram,
  fn: string,
): { params: readonly Type[]; result: Type | undefined } {
  const f = typed.byName.get(fn);
  return { params: f?.params ?? [], result: f?.result };
}

/** Record field types of `t`, or [] when `t` is not a record. */
export function recordFields(t: Type | undefined): readonly Type[] {
  return t !== undefined && typeof t !== 'string' && t.kind === 'rec' ? t.fields : [];
}

/** Element type of `t` when it is an array. */
export function arrayElem(t: Type | undefined): Type | undefined {
  return t !== undefined && typeof t !== 'string' && t.kind === 'arr' ? t.elem : undefined;
}

export function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, name);
    if (dir.length > 0 && existsSync(p)) return p;
  }
  return undefined;
}

/** A tool from `$env`, then `extra` candidates, then PATH. */
export function tool(name: string, env: string, extra: readonly string[] = []): string {
  const path = [process.env[env], ...extra, onPath(name)].find(
    (p): p is string => p !== undefined && p.length > 0 && existsSync(p),
  );
  if (path === undefined) throw new Error(`${name} not found (set ${env})`);
  return path;
}

export const BUILD_MS = 600_000;
export const RUN_MS = 60_000;

export const failure = (label: string, r: { stdout: string; stderr: string }): BuildResult => ({
  error: `${label}: ${(r.stderr || r.stdout).slice(0, 500)}`,
});
