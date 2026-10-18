/** Comment composition shared by source readers and parsed native IR. */
import type { Func } from './core.js';

export interface CommentMetadata<T> {
  readonly leading?: readonly T[];
  readonly trailing?: T;
}
export interface FunctionCommentMetadata<T> {
  readonly comments?: CommentMetadata<T>;
  readonly afterComments?: readonly T[];
}
export interface SourceUnitCommentMetadata<T> {
  readonly profileComments?: CommentMetadata<T>;
  readonly useComments?: readonly (CommentMetadata<T> | undefined)[];
  readonly tailComments?: readonly T[];
  readonly functions: readonly FunctionCommentMetadata<T>[];
}
export interface ComposedCommentMetadata<T> {
  readonly functions: readonly FunctionCommentMetadata<T>[];
  readonly tailComments?: readonly T[];
}
export type FunctionComments = FunctionCommentMetadata<string>;
export type SourceUnitComments = SourceUnitCommentMetadata<string>;
export type ComposedComments = ComposedCommentMetadata<string>;

/** One ownership policy for host strings and original native comment row references. */
export function composeCommentMetadata<T>(
  units: readonly SourceUnitCommentMetadata<T>[],
): ComposedCommentMetadata<T> {
  const functions: FunctionCommentMetadata<T>[] = [];
  let pending: T[] = [];
  for (const unit of units) {
    pending.push(...(unit.profileComments?.leading ?? []));
    if (unit.profileComments?.trailing !== undefined) pending.push(unit.profileComments.trailing);
    for (const comments of unit.useComments ?? []) {
      pending.push(...(comments?.leading ?? []));
      if (comments?.trailing !== undefined) pending.push(comments.trailing);
    }
    for (const fn of unit.functions) {
      const comments =
        pending.length === 0
          ? fn.comments
          : { ...fn.comments, leading: [...pending, ...(fn.comments?.leading ?? [])] };
      functions.push(comments === undefined ? {} : { comments });
      pending = [...(fn.afterComments ?? [])];
    }
    pending.push(...(unit.tailComments ?? []));
  }
  const last = functions.at(-1);
  if (last !== undefined && pending.length)
    functions[functions.length - 1] = { ...last, afterComments: pending };
  return {
    functions,
    ...(last === undefined && pending.length ? { tailComments: pending } : {}),
  };
}

export function composeSourceComments(units: readonly SourceUnitComments[]): ComposedComments {
  return composeCommentMetadata(units);
}

export function applyFunctionComments(fn: Func, metadata: FunctionComments): Func {
  if (fn.comments === metadata.comments && fn.afterComments === metadata.afterComments) return fn;
  const { comments: _comments, afterComments: _tail, ...body } = fn;
  return {
    ...body,
    ...(metadata.comments === undefined ? {} : { comments: metadata.comments }),
    ...(metadata.afterComments === undefined ? {} : { afterComments: metadata.afterComments }),
  };
}
