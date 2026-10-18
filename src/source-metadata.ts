/** Comment composition shared by source readers and parsed native IR. */
import type { Comments, Func } from './core.js';

export interface FunctionComments {
  readonly comments?: Comments;
  readonly afterComments?: readonly string[];
}
export interface SourceUnitComments {
  readonly profileComments?: Comments;
  readonly useComments?: readonly (Comments | undefined)[];
  readonly tailComments?: readonly string[];
  readonly functions: readonly FunctionComments[];
}
export interface ComposedComments {
  readonly functions: readonly FunctionComments[];
  readonly tailComments?: readonly string[];
}

export function composeSourceComments(units: readonly SourceUnitComments[]): ComposedComments {
  const functions: FunctionComments[] = [];
  let pending: string[] = [];
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

export function applyFunctionComments(fn: Func, metadata: FunctionComments): Func {
  if (fn.comments === metadata.comments && fn.afterComments === metadata.afterComments) return fn;
  const { comments: _comments, afterComments: _tail, ...body } = fn;
  return {
    ...body,
    ...(metadata.comments === undefined ? {} : { comments: metadata.comments }),
    ...(metadata.afterComments === undefined ? {} : { afterComments: metadata.afterComments }),
  };
}
