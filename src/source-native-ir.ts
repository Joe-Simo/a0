/** Decode checked native frontend tables. This reads internal IR; it never parses source or revalidates types. */
import type {
  Comments,
  Func,
  Node,
  Operand,
  Program,
  Type,
  TypedFunc,
  TypedProgram,
} from './core.js';
import { applyFunctionComments, type ComposedComments } from './source-metadata.js';
import type { Lit, Spec, SpecExample } from './spec.js';
import { IR_OPS } from './word-ir.js';

export type NativeTables = ReadonlyMap<number, Uint32Array>;
const NONE = 0xffff_ffff;
function need<T>(value: T | undefined, message = 'invalid frontend IR'): T {
  if (value === undefined) throw new Error(message);
  return value;
}
function table(tables: NativeTables, offset: number): Uint32Array {
  return need(tables.get(offset));
}
function slice(words: Uint32Array, start: number, count: number): Uint32Array {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(count) ||
    start < 0 ||
    count < 0 ||
    start + count > words.length
  )
    throw new Error('invalid frontend IR extent');
  return words.subarray(start, start + count);
}
const row = (tables: NativeTables, offset: number, width: number, id: number): Uint32Array =>
  slice(table(tables, offset), id * width, width);
const word = (words: Uint32Array | readonly number[], index: number): number => need(words[index]);

function decodeNativeData(
  state: readonly number[],
  tables: NativeTables,
  symbols: readonly string[],
  source: string,
  specTables: NativeTables,
  metadata?: ComposedComments,
): { program: Program; type: (id: number) => Type } {
  const raw = new TextEncoder().encode(source);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const span = (start: number, count: number): string => {
    if (start + count > raw.length) throw new Error('invalid frontend source span');
    return decoder.decode(raw.subarray(start, start + count));
  };
  const symbol = (id: number): string => need(symbols[id]);
  // Types are interned after their children. Iteration avoids a host stack limit on deep types.
  const types: Type[] = [];
  const type = (id: number): Type => need(types[id], 'native type children must precede parents');
  const typeRows = table(tables, 68);
  for (let id = 0; id < typeRows.length / 5; id++) {
    const r = row(tables, 68, 5, id),
      kind = word(r, 0);
    if (kind === 0) types.push('u32');
    else if (kind === 1) types.push('bool');
    else if (kind === 2) types.push('io');
    else if (kind === 3) types.push({ kind: 'arr', elem: type(word(r, 1)), length: word(r, 2) });
    else if (kind === 4)
      types.push({
        kind: 'rec',
        fields: Array.from(slice(table(tables, 71), word(r, 1), word(r, 2)), type),
      });
    else throw new Error('invalid native type kind');
  }
  const operand = (id: number, storage = tables): Operand => {
    const r = row(storage, storage === tables ? 47 : 50, 5, id),
      kind = word(r, 0);
    if (kind === 0) return { kind: 'node', id: symbol(word(r, 1)) };
    if (kind === 1)
      return {
        kind: 'param',
        index: word(r, 4) & 4 ? Number(span(word(r, 2), word(r, 3)).slice(1)) : word(r, 1),
      };
    if (kind === 2) return { kind: 'u32', value: word(r, 1) };
    if (kind === 3) return { kind: 'bool', value: word(r, 1) !== 0 };
    throw new Error('invalid native operand kind');
  };
  const comment = (id: number): string => {
    const r = row(tables, 38, 3, id);
    return span(word(r, 0), word(r, 1));
  };
  const comments = (id: number): Comments | undefined => {
    const r = row(tables, 32, 10, id);
    const leading = Array.from({ length: word(r, 9) }, (_, j) => comment(word(r, 8) + j));
    const trailing = word(r, 7) === NONE ? undefined : comment(word(r, 7));
    return leading.length || trailing !== undefined
      ? { ...(leading.length ? { leading } : {}), ...(trailing === undefined ? {} : { trailing }) }
      : undefined;
  };
  const node = (id: number, storage = tables): Node => {
    const r = row(storage, storage === tables ? 44 : 47, 14, id);
    const c = word(r, 11) & 1 ? undefined : comments(word(r, 6));
    const args = Array.from({ length: word(r, 3) }, (_, j) => operand(word(r, 2) + j, storage));
    const op = need(IR_OPS[word(r, 1) - 1]);
    return {
      id: symbol(word(r, 0)),
      op: op === 'text' ? 'arr' : op,
      args,
      ...(word(r, 4) === NONE ? {} : { callee: symbol(word(r, 4)) }),
      ...(word(r, 5) === NONE ? {} : { pred: symbol(word(r, 5)) }),
      ...(word(r, 11) & 2
        ? {
            text: decoder.decode(
              Uint8Array.from(
                args.map((arg) => {
                  if (arg.kind !== 'u32') throw new Error('invalid native text operand');
                  return arg.value;
                }),
              ),
            ),
          }
        : {}),
      ...(c === undefined ? {} : { comments: c }),
    };
  };
  const specs = new Map<number, Spec>();
  const literals: Lit[] = [];
  const literal = (id: number): Lit =>
    need(literals[id], 'native literal children must precede parents');
  for (let id = 0; id < table(specTables, 32).length / 6; id++) {
    const r = row(specTables, 32, 6, id),
      kind = word(r, 0);
    if (kind === 1) literals.push({ kind: 'u32', value: word(r, 1) });
    else if (kind === 2) literals.push({ kind: 'bool', value: word(r, 1) !== 0 });
    else if (kind === 3 || kind === 4)
      literals.push({
        kind: kind === 3 ? 'arr' : 'rec',
        items: Array.from(slice(table(specTables, 35), word(r, 2), word(r, 3)), literal),
      });
    else throw new Error('invalid native literal kind');
  }
  const example = (id: number): SpecExample => {
    const r = row(specTables, 41, 8, id),
      c = comments(word(r, 5));
    return {
      args: Array.from(slice(table(specTables, 38), word(r, 2), word(r, 3)), literal),
      result: literal(word(r, 4)),
      ...(c === undefined ? {} : { comments: c }),
    };
  };
  const contract = (id: number): Node => node(word(row(specTables, 44, 7, id), 3), specTables);
  for (let id = 0; id < table(specTables, 62).length / 5; id++) {
    const r = row(specTables, 62, 5, id);
    specs.set(word(r, 0), {
      examples: Array.from({ length: word(r, 2) }, (_, i) => example(word(r, 1) + i)),
      ...(word(r, 3) === NONE ? {} : { pre: contract(word(r, 3)) }),
      ...(word(r, 4) === NONE ? {} : { post: contract(word(r, 4)) }),
    });
  }
  let functions: Func[] = Array.from({ length: table(tables, 41).length / 14 }, (_, id) => {
    const r = row(tables, 41, 14, id),
      c = comments(word(r, 7)),
      rc = comments(word(r, 8)),
      ec = comments(word(r, 9));
    const spec = specs.get(id);
    return {
      name: symbol(word(r, 0)),
      params: Array.from(slice(table(tables, 50), word(r, 1), word(r, 2)), type),
      result: type(word(r, 3)),
      nodes: Array.from({ length: word(r, 5) }, (_, j) => node(word(r, 4) + j)),
      ret: operand(word(r, 6)),
      ...(spec === undefined ? {} : { spec }),
      ...(c === undefined ? {} : { comments: c }),
      ...(rc === undefined ? {} : { retComments: rc }),
      ...(ec === undefined ? {} : { endComments: ec }),
    };
  });
  const tail = Array.from({ length: word(state, 26) }, (_, j) => comment(word(state, 25) + j));
  if (functions.length && tail.length)
    Object.assign(functions.at(-1) as Func, { afterComments: tail });
  if (metadata !== undefined) {
    if (metadata.functions.length !== functions.length)
      throw new Error('native comment/function count mismatch');
    functions = functions.map((fn, id) => applyFunctionComments(fn, need(metadata.functions[id])));
  }
  const uses = Array.from({ length: table(tables, 53).length / 3 }, (_, id) => {
    const r = row(tables, 53, 3, id);
    return span(word(r, 0), word(r, 1));
  });
  const uc = uses.map((_, id) => comments(word(row(tables, 53, 3, id), 2)));
  const pc = word(state, 24) === NONE ? undefined : comments(word(state, 24));
  const profile = word(state, 8) ? { profile: 'strict' as const } : {};
  const program: Program = {
    functions,
    uses,
    ...profile,
    ...(pc === undefined ? {} : { profileComments: pc }),
    ...(uc.some((c) => c !== undefined) ? { useComments: uc } : {}),
    ...(!functions.length && (metadata?.tailComments ?? tail).length
      ? { tailComments: metadata?.tailComments ?? tail }
      : {}),
  };
  return { program, type };
}

export function decodeNativeUnit(
  state: readonly number[],
  tables: NativeTables,
  symbols: readonly string[],
  source: string,
  specTables: NativeTables,
): Program {
  return decodeNativeData(state, tables, symbols, source, specTables).program;
}

export function decodeNativeSource(
  state: readonly number[],
  tables: NativeTables,
  symbols: readonly string[],
  source: string,
  specTables: NativeTables,
  metadata?: ComposedComments,
): { program: Program; typed: TypedProgram } {
  const { program, type } = decodeNativeData(state, tables, symbols, source, specTables, metadata);
  const functions = program.functions;
  const profile = program.profile === 'strict' ? { profile: 'strict' as const } : {};
  const byName = new Map<string, TypedFunc>();
  const float = new DataView(new ArrayBuffer(8));
  const typedFunctions = functions.map((fn, id): TypedFunc => {
    const r = row(tables, 41, 14, id),
      metric = row(tables, 103, 3, id);
    const nodeTypes = new Map(
      fn.nodes.map((n, i) => [n.id, type(word(table(tables, 97), word(r, 4) + i))]),
    );
    const calls = new Map<string, TypedFunc>();
    for (const n of fn.nodes)
      for (const callee of [n.callee, n.pred])
        if (callee !== undefined)
          calls.set(callee, need(byName.get(callee), 'invalid native typed callee'));
    float.setUint32(0, word(metric, 1), true);
    float.setUint32(4, word(metric, 2), true);
    const typed: TypedFunc = {
      ...fn,
      ...profile,
      types: nodeTypes,
      calls,
      literalIterations: word(metric, 0),
      staticIterations: float.getFloat64(0, true),
    };
    byName.set(fn.name, typed);
    return typed;
  });
  return { program, typed: { functions: typedFunctions, byName, ...profile } };
}
