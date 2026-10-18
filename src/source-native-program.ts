/** Encode structured compiler IR for the shared A0 checker; no source formatting or parsing. */
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
import {
  installNativeVectors,
  type NativeIrBuilder,
  PARSED_VECTOR_WIDTHS,
  SPEC_VECTOR_WIDTHS,
} from './source-native-compose.js';
import { losslessSourceString } from './source-utf8.js';
import type { Lit } from './spec.js';
import { irOp } from './word-ir.js';

const NONE = 0xffff_ffff;
function fail(message: string): never {
  throw new Error(`unrepresentable native program IR: ${message}`);
}
function word(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > NONE) fail('expected a u32 word');
  return value;
}
function append(table: number[], row: readonly number[]): number {
  const first = word(table.length);
  word(first + row.length);
  for (const value of row) table.push(word(value));
  return first;
}
function boolean(value: boolean): number {
  if (typeof value !== 'boolean') fail('expected a boolean');
  return value ? 1 : 0;
}

/** Arena strings are UTF-8; refuse host strings that would lose original code units. */
function transportString(value: string): string {
  if (typeof value !== 'string') fail('expected an IR string');
  return losslessSourceString(value, 'unrepresentable native program IR');
}

/**
 * Program is internal structured IR; locations are synthetic. The shared native grammar
 * classifies names and the A0 checker enforces the program/function/node limits.
 * This host boundary checks representation and extents, never repeats the type checker.
 */
export function encodeNativeProgram(program: Program, builder: NativeIrBuilder): string {
  const tables = new Map<number, number[]>(PARSED_VECTOR_WIDTHS.map(([slot]) => [slot, []]));
  const specs = new Map<number, number[]>(SPEC_VECTOR_WIDTHS.map(([slot]) => [slot, []]));
  const table = (slot: number, spec = false): number[] => {
    const found = (spec ? specs : tables).get(slot);
    if (found === undefined) fail('unknown vector');
    return found;
  };
  // The verifier reads an operand's identity bytes for postcondition `r`. Store the
  // ordinary internal string pool, never a rendered A0 program or spec expression.
  const strings: string[] = [],
    spans = new Map<string, readonly [number, number]>();
  let stringBytes = 0;
  const span = (value: string): readonly [number, number] => {
    transportString(value);
    const known = spans.get(value);
    if (known !== undefined) return known;
    const count = new TextEncoder().encode(value).length;
    const extent = [stringBytes, count] as const;
    stringBytes = word(stringBytes + count);
    strings.push(value);
    spans.set(value, extent);
    return extent;
  };
  for (const path of program.uses ?? []) {
    const [start, count] = span(path);
    append(table(53), [start, count, 0]);
  }
  const rememberOperand = (value: Operand): void => {
    if (value.kind === 'node') span(value.id);
  };
  for (const fn of program.functions) {
    rememberOperand(fn.ret);
    for (const entry of [
      ...fn.nodes,
      ...(fn.spec?.pre === undefined ? [] : [fn.spec.pre]),
      ...(fn.spec?.post === undefined ? [] : [fn.spec.post]),
    ])
      for (const argument of entry.args) rememberOperand(argument);
  }
  const source = strings.join('');
  builder.initialize(source, program.profile === 'strict');
  // One synthetic IR location suffices: metadata is restored separately after checking.
  append(table(32), [0, 0, 0, 0, 0, 0, 0, NONE, 0, 0]);
  const symbols = new Map<string, number>();
  const symbol = (name: string): number => {
    transportString(name);
    const previous = symbols.get(name);
    if (previous !== undefined) return previous;
    const id = word(builder.symbol(name));
    symbols.set(name, id);
    return id;
  };
  const typeIds = new Map<Type, number>([
    ['u32', 0],
    ['bool', 1],
    ['io', 2],
  ]);
  const structuralTypes = new Map<string, number>();
  const type = (root: Type): number => {
    const active = new Set<Type>();
    const stack: { value: Type; children: boolean }[] = [{ value: root, children: false }];
    while (stack.length) {
      const current = stack.pop();
      if (current === undefined) fail('missing type frame');
      const value = current.value;
      if (typeIds.has(value)) continue;
      if (typeof value !== 'object' || value === null) fail('unknown type');
      if (!current.children) {
        if (active.has(value)) fail('cyclic type');
        active.add(value);
        stack.push({ value, children: true });
        const children =
          value.kind === 'arr'
            ? [value.elem]
            : value.kind === 'rec'
              ? value.fields
              : fail('unknown aggregate type');
        for (let index = children.length - 1; index >= 0; index--)
          stack.push({ value: children[index] as Type, children: false });
        continue;
      }
      active.delete(value);
      const kind = value.kind === 'arr' ? 3 : 4;
      const fields =
        value.kind === 'rec'
          ? value.fields.map((field) => typeIds.get(field) ?? fail('missing child type'))
          : [];
      const a =
        value.kind === 'arr' ? (typeIds.get(value.elem) ?? fail('missing element type')) : 0;
      const b = value.kind === 'arr' ? word(value.length) : word(fields.length);
      const key = kind === 4 ? `r:${fields.join(',')}` : `a:${a},${b}`;
      let id = structuralTypes.get(key);
      if (id === undefined) {
        id = word(builder.type(kind, a, b, Uint32Array.from(fields)));
        structuralTypes.set(key, id);
      }
      typeIds.set(value, id);
    }
    return typeIds.get(root) ?? fail('missing type');
  };
  const operand = (value: Operand, spec = false): number => {
    const target = table(spec ? 50 : 47, spec);
    const id = target.length / 5;
    if (value.kind === 'node') {
      const [start, count] = spans.get(value.id) ?? fail('missing operand identity bytes');
      append(target, [0, symbol(value.id), start, count, 0]);
    } else if (value.kind === 'param') append(target, [1, word(value.index), 0, 0, 0]);
    else if (value.kind === 'u32') append(target, [2, word(value.value), 0, 0, 0]);
    else if (value.kind === 'bool') append(target, [3, boolean(value.value), 0, 0, 0]);
    else fail('unknown operand kind');
    return id;
  };
  const node = (value: Node, spec = false): number => {
    const first = table(spec ? 50 : 47, spec).length / 5;
    for (const argument of value.args) operand(argument, spec);
    const op = irOp(value.op);
    if (op === 0) fail('unknown operation');
    return (
      append(table(spec ? 47 : 44, spec), [
        symbol(value.id),
        op,
        first,
        value.args.length,
        value.callee === undefined ? NONE : symbol(value.callee),
        value.pred === undefined ? NONE : symbol(value.pred),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ]) / 14
    );
  };
  const literal = (root: Lit): number => {
    // Each example's result closes the prefix visible to its execution. Reusing a
    // previous example's result ID would hide later argument literals from that view.
    const literalIds = new Map<Lit, number>();
    const active = new Set<Lit>();
    const stack: { value: Lit; children: boolean }[] = [{ value: root, children: false }];
    while (stack.length) {
      const current = stack.pop();
      if (current === undefined) fail('missing literal frame');
      const value = current.value;
      if (literalIds.has(value)) continue;
      if (!current.children && (value.kind === 'arr' || value.kind === 'rec')) {
        if (active.has(value)) fail('cyclic literal');
        active.add(value);
        stack.push({ value, children: true });
        for (let index = value.items.length - 1; index >= 0; index--)
          stack.push({ value: value.items[index] as Lit, children: false });
        continue;
      }
      active.delete(value);
      let row: readonly number[];
      if (value.kind === 'u32') row = [1, word(value.value), 0, 0, 0, 0];
      else if (value.kind === 'bool') row = [2, boolean(value.value), 0, 0, 0, 0];
      else if (value.kind === 'arr' || value.kind === 'rec') {
        const start = table(35, true).length;
        append(
          table(35, true),
          value.items.map((child) => literalIds.get(child) ?? fail('missing child literal')),
        );
        row = [value.kind === 'arr' ? 3 : 4, 0, start, value.items.length, 0, 0];
      } else fail('unknown literal kind');
      literalIds.set(value, append(table(32, true), row) / 6);
    }
    return literalIds.get(root) ?? fail('missing literal');
  };
  for (const [index, fn] of program.functions.entries()) {
    const parameters = table(50).length;
    for (const parameter of fn.params) append(table(50), [type(parameter)]);
    const result = type(fn.result);
    const first = table(44).length / 14;
    for (const entry of fn.nodes) node(entry);
    const returned = operand(fn.ret);
    const rawStart = table(56).length / 6;
    const exampleStart = table(41, true).length / 8;
    const contract = (entry: Node | undefined, kind: number): number => {
      if (entry === undefined) return NONE;
      const raw = append(table(56), [kind, index, 0, 0, 0, 0]) / 6;
      return append(table(44, true), [kind, index, 0, node(entry, true), raw, 0, 0]) / 7;
    };
    for (const example of fn.spec?.examples ?? []) {
      const raw = append(table(56), [1, index, 0, 0, 0, 0]) / 6;
      const args = example.args.map(literal);
      const start = append(table(38, true), args);
      append(table(41, true), [index, raw, start, args.length, literal(example.result), 0, 0, 0]);
    }
    const pre = contract(fn.spec?.pre, 2),
      post = contract(fn.spec?.post, 3);
    if (fn.spec !== undefined)
      append(table(62, true), [index, exampleStart, fn.spec.examples.length, pre, post]);
    append(table(41), [
      symbol(fn.name),
      parameters,
      fn.params.length,
      result,
      first,
      fn.nodes.length,
      returned,
      0,
      0,
      0,
      rawStart,
      table(56).length / 6 - rawStart,
      0,
      0,
    ]);
  }
  installNativeVectors(builder, tables, specs);
  return source;
}

const comments = (value: Comments): Comments => ({
  ...(value.leading === undefined ? {} : { leading: [...value.leading] }),
  ...(value.trailing === undefined ? {} : { trailing: value.trailing }),
});
function nodeMetadata(value: Node, original: Node): Node {
  return {
    ...value,
    ...(original.text === undefined ? {} : { text: original.text }),
    ...(original.comments === undefined ? {} : { comments: comments(original.comments) }),
  };
}
function functionMetadata(value: Func, original: Func): Func {
  return {
    ...value,
    nodes: value.nodes.map((entry, index) => nodeMetadata(entry, original.nodes[index] as Node)),
    ...(original.comments === undefined ? {} : { comments: comments(original.comments) }),
    ...(original.retComments === undefined ? {} : { retComments: comments(original.retComments) }),
    ...(original.endComments === undefined ? {} : { endComments: comments(original.endComments) }),
    ...(original.afterComments === undefined ? {} : { afterComments: [...original.afterComments] }),
    ...(value.spec === undefined
      ? {}
      : {
          spec: {
            ...value.spec,
            examples: value.spec.examples.map((example, index) => {
              const metadata = original.spec?.examples[index]?.comments;
              return {
                ...example,
                ...(metadata === undefined ? {} : { comments: comments(metadata) }),
              };
            }),
            ...(value.spec.pre === undefined
              ? {}
              : { pre: nodeMetadata(value.spec.pre, original.spec?.pre as Node) }),
            ...(value.spec.post === undefined
              ? {}
              : { post: nodeMetadata(value.spec.post, original.spec?.post as Node) }),
          },
        }),
  };
}

/** Metadata never participates in the type check; restore detached copies after success. */
export function restoreNativeProgramMetadata(
  decoded: { readonly program: Program; readonly typed: TypedProgram },
  original: Program,
): { program: Program; typed: TypedProgram } {
  const programFunctions = decoded.program.functions.map((fn, index) =>
    functionMetadata(fn, original.functions[index] as Func),
  );
  const byName = new Map<string, TypedFunc>();
  const functions = decoded.typed.functions.map((fn, index): TypedFunc => {
    const calls = new Map(
      [...fn.calls].map(([name]) => [name, byName.get(name) ?? fail('missing checked callee')]),
    );
    const restored = { ...fn, ...programFunctions[index], calls };
    byName.set(restored.name, restored);
    return restored;
  });
  return {
    program: {
      ...decoded.program,
      functions: programFunctions,
      ...(original.profileComments === undefined
        ? {}
        : { profileComments: comments(original.profileComments) }),
      ...(original.useComments === undefined
        ? {}
        : {
            useComments: original.useComments.map((entry) =>
              entry === undefined ? undefined : comments(entry),
            ),
          }),
      ...(original.tailComments === undefined ? {} : { tailComments: [...original.tailComments] }),
    },
    typed: { ...decoded.typed, functions, byName },
  };
}
