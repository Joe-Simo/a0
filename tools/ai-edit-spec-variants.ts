/**
 * Spec-line variants of a set-g starting program (tools/ai-edit-tasks-g.ts, the spec-line
 * experiment): which `ex` / `post` lines the function the edit targets carries.
 *
 *   none   no spec line (cell A, and the control cell whose primer teaches them)
 *   ex1    the first preserved example
 *   ex3    the first three preserved examples
 *   post   one `post` property
 *   stale  one wrong example: true of the starting program, false of the intended edit
 *
 * A preserved example is one the starting program and the intended edit agree on, so a correct edit
 * keeps it true and a plausible wrong edit may break it. The reference solution carries the same
 * lines (it must pass the same validation), except in `stale`, where the correct edit has to drop
 * the example: its reference is the program without it.
 */

import { parseAndValidate, type TypedFunc } from '../src/core.js';
import { formatLit, litOf } from '../src/spec.js';
import type { TaskG } from './ai-edit-tasks-g.js';

export type SpecVariant = 'none' | 'ex1' | 'ex3' | 'post' | 'stale';

export const SPEC_VARIANTS: readonly SpecVariant[] = ['none', 'ex1', 'ex3', 'post', 'stale'];

function lineOf(fn: TypedFunc, ex: NonNullable<TaskG['specs']['stale']>): string {
  const args = ex.args.map((a, i) => formatLit(litOf(a, fn.params[i] as never)));
  return `ex ${[...args, '->', formatLit(litOf(ex.result, fn.result))].join(' ')}`;
}

/** The spec lines (canonical text) of `variant` for `task`. */
export function specLinesOf(task: TaskG, variant: SpecVariant): string[] {
  const fn = parseAndValidate(task.a0Source).byName.get(task.target);
  if (fn === undefined) throw new Error(`${task.id}: no target ${task.target}`);
  switch (variant) {
    case 'none':
      return [];
    case 'ex1':
      return task.specs.preserved.slice(0, 1).map((e) => lineOf(fn, e));
    case 'ex3':
      return task.specs.preserved.slice(0, 3).map((e) => lineOf(fn, e));
    case 'post':
      return [`post ${task.specs.post}`];
    case 'stale':
      if (task.specs.stale === null) throw new Error(`${task.id}: no stale example`);
      return [lineOf(fn, task.specs.stale)];
  }
}

function insert(source: string, target: string, lines: readonly string[]): string {
  if (lines.length === 0) return source;
  const all = source.split('\n');
  const at = all.findIndex((l) => l.startsWith(`fn ${target} `) || l === `fn ${target}`);
  if (at < 0) throw new Error(`no header of ${target}`);
  all.splice(at + 1, 0, ...lines);
  return all.join('\n');
}

/** `task` with the variant's spec lines on its target function (and on its reference, see above). */
export function specVariantOf(task: TaskG, variant: SpecVariant): TaskG {
  const lines = specLinesOf(task, variant);
  return {
    ...task,
    a0Source: insert(task.a0Source, task.target, lines),
    reference: {
      ...task.reference,
      a0: variant === 'stale' ? task.reference.a0 : insert(task.reference.a0, task.target, lines),
    },
  };
}
