/** Explicit bootstrap IR handoff through the shared A0 source frontend.
 * Target emission remains the existing TypeScript backend; no source is sent
 * through the historical bootstrap lexer/parser on this path. */
import type { TypedFunc, TypedProgram } from '../src/core.js';
import type { ProjectLinkOptions, ReadSource } from '../src/linker.js';
import type { nativeSource } from '../src/source-native.js';
import { linkNativeSource } from '../src/source-native-link.js';

type Frontend = ReturnType<typeof nativeSource>;

/** Select checked functions without rebuilding them or losing resolved callees.
 * Program order and profile are retained. A bad or incomplete graph is refused
 * before any backend receives it. This helper interprets no source grammar. */
export function bootstrapProgramClosure(
  program: TypedProgram,
  roots: readonly string[],
): TypedProgram {
  if (roots.length === 0) throw new Error('bootstrap needs at least one entry');
  const order = new Map<TypedFunc, number>();
  for (const [index, fn] of program.functions.entries()) {
    if (program.byName.get(fn.name) !== fn || order.has(fn) || fn.profile !== program.profile)
      throw new Error('bootstrap program has inconsistent function identity');
    order.set(fn, index);
  }
  if (program.byName.size !== order.size)
    throw new Error('bootstrap program has inconsistent function names');
  const needed = new Set<TypedFunc>();
  const pending = roots.map((name) => {
    const fn = program.byName.get(name);
    if (!fn) throw new Error(`bootstrap entry does not exist: ${name}`);
    return fn;
  });
  while (pending.length) {
    const fn = pending.pop() as TypedFunc;
    if (needed.has(fn)) continue;
    needed.add(fn);
    for (const [name, callee] of fn.calls) {
      const callerIndex = order.get(fn),
        calleeIndex = order.get(callee);
      if (
        program.byName.get(name) !== callee ||
        callee.name !== name ||
        callerIndex === undefined ||
        calleeIndex === undefined ||
        calleeIndex >= callerIndex
      )
        throw new Error('bootstrap program has an unresolved or unordered callee');
      pending.push(callee);
    }
    const body = new Set(fn.nodes);
    for (const node of [...fn.nodes, fn.spec?.pre, fn.spec?.post]) {
      if (node === undefined) continue;
      for (const name of [node.callee, node.pred]) {
        if (name === undefined) continue;
        const callee = program.byName.get(name),
          calleeIndex = callee === undefined ? undefined : order.get(callee),
          callerIndex = order.get(fn);
        if (
          !callee ||
          calleeIndex === undefined ||
          callerIndex === undefined ||
          calleeIndex >= callerIndex ||
          (body.has(node) && fn.calls.get(name) !== callee)
        )
          throw new Error('bootstrap program has an unresolved node callee');
        pending.push(callee);
      }
    }
  }
  const functions = program.functions.filter((fn) => needed.has(fn));
  return {
    ...(program.profile === 'strict' ? { profile: 'strict' as const } : {}),
    functions,
    byName: new Map(functions.map((fn) => [fn.name, fn])),
  };
}

export interface NativeBootstrapProgram {
  /** Authentic checked IR, with the original function/callee objects. */
  readonly program: TypedProgram;
  /** Flat source emitted by the shared A0 formatter, suitable for later stages. */
  readonly source: string;
}

/** Borrow the caller's frontend serially; one-shot linking retains no project.
 * Formatting is required, and an unavailable/refused capability never falls
 * back to the TypeScript source parser, validator or formatter. */
export async function loadNativeBootstrapProgram(
  entry: string,
  roots: readonly string[],
  read: ReadSource,
  frontend: Frontend,
  options?: ProjectLinkOptions,
): Promise<NativeBootstrapProgram> {
  const linked = await linkNativeSource(entry, read, frontend, options);
  const program = bootstrapProgramClosure(linked.program, roots);
  const active = frontend.activateProgramForFormat(program);
  if (!active.ok) throw new Error('native bootstrap formatting activation refused');
  const output = frontend.format(active.input, { scope: 'program' });
  if (!output.ok) throw new Error('native bootstrap formatting refused');
  return { program, source: output.text };
}
