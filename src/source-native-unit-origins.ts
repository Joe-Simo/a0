/** Detached ownership spans from authentic copied A0 unit tables; no source grammar. */
import type { NativeUnitSnapshot } from './source-native-compose.js';

const NONE = 0xffff_ffff;
export interface NativeUnitSourceSpan {
  readonly line: number;
  readonly byteStart: number;
  readonly byteLength: number;
  readonly utf16Start: number;
  readonly utf16Length: number;
}
export interface NativeUnitSourceOrigins {
  readonly functions: readonly {
    readonly functionIndex: number;
    readonly header: NativeUnitSourceSpan;
    readonly nodes: readonly {
      readonly nodeIndex: number;
      readonly syntheticReturn: boolean;
      readonly span: NativeUnitSourceSpan;
    }[];
    readonly ret: NativeUnitSourceSpan;
    readonly end: NativeUnitSourceSpan;
    readonly examples: readonly {
      readonly exampleIndex: number;
      readonly span: NativeUnitSourceSpan;
    }[];
    readonly pre?: NativeUnitSourceSpan;
    readonly post?: NativeUnitSourceSpan;
  }[];
}

const need = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('invalid native unit origin metadata');
  return value;
};

/** Called only after nativeSourceApi verifies its private unit ownership. */
export function decodeNativeUnitOrigins(unit: NativeUnitSnapshot): NativeUnitSourceOrigins {
  const table = (slot: number, width: number, spec = false): Uint32Array => {
    const value = need((spec ? unit.specs : unit.tables).get(slot));
    if (!(value instanceof Uint32Array) || value.length % width !== 0)
      throw new Error('invalid native unit origin table extent');
    return value;
  };
  const lines = table(32, 10),
    functions = table(41, 14),
    nodes = table(44, 14),
    directories = table(62, 5, true),
    examples = table(41, 8, true),
    contracts = table(44, 7, true),
    expressions = table(47, 14, true);
  const word = (rows: Uint32Array, width: number, id: number, field: number): number => {
    if (!Number.isInteger(id) || id < 0 || id >= rows.length / width || field >= width)
      throw new Error('invalid native unit origin row');
    return need(rows[id * width + field]);
  };
  const spans: { line: number; start: number; end: number }[] = [];
  const span = (id: number) => {
    const line = word(lines, 10, id, 0),
      start = word(lines, 10, id, 3),
      length = word(lines, 10, id, 4);
    if (line === 0 || start > unit.byteLength || length > unit.byteLength - start)
      throw new Error('invalid native unit origin source range');
    const value = { line, start, end: start + length };
    spans.push(value);
    return value;
  };
  const specByFunction = new Map<number, number>();
  for (let id = 0; id < directories.length / 5; id++) {
    const fn = word(directories, 5, id, 0);
    if (fn >= functions.length / 14 || specByFunction.has(fn))
      throw new Error('invalid native unit origin spec ownership');
    specByFunction.set(fn, id);
  }
  const staged = Array.from({ length: functions.length / 14 }, (_, functionIndex) => {
    const first = word(functions, 14, functionIndex, 4),
      count = word(functions, 14, functionIndex, 5);
    if (first > nodes.length / 14 || count > nodes.length / 14 - first)
      throw new Error('invalid native unit origin node ownership');
    const directory = specByFunction.get(functionIndex);
    const exampleFirst = directory === undefined ? 0 : word(directories, 5, directory, 1),
      exampleCount = directory === undefined ? 0 : word(directories, 5, directory, 2);
    if (exampleFirst > examples.length / 8 || exampleCount > examples.length / 8 - exampleFirst)
      throw new Error('invalid native unit origin example ownership');
    const contract = (field: number) => {
      if (directory === undefined) return undefined;
      const id = word(directories, 5, directory, field);
      if (id === NONE) return undefined;
      const expression = word(contracts, 7, id, 3);
      return span(word(expressions, 14, expression, 6));
    };
    return {
      functionIndex,
      header: span(word(functions, 14, functionIndex, 7)),
      nodes: Array.from({ length: count }, (_, offset) => {
        const nodeIndex = first + offset;
        return {
          nodeIndex,
          syntheticReturn: (word(nodes, 14, nodeIndex, 11) & 1) !== 0,
          span: span(word(nodes, 14, nodeIndex, 6)),
        };
      }),
      ret: span(word(functions, 14, functionIndex, 8)),
      end: span(word(functions, 14, functionIndex, 9)),
      examples: Array.from({ length: exampleCount }, (_, offset) => {
        const exampleIndex = exampleFirst + offset;
        return { exampleIndex, span: span(word(examples, 8, exampleIndex, 5)) };
      }),
      pre: contract(3),
      post: contract(4),
    };
  });
  const boundaries = [...new Set(spans.flatMap(({ start, end }) => [start, end]))].sort(
      (a, b) => a - b,
    ),
    offsets = new Map<number, number>();
  let byte = 0,
    utf16 = 0,
    selected = 0;
  // Walk each Unicode scalar once. Mid-scalar source ranges cannot claim a UTF16 location.
  for (const character of unit.source) {
    while (boundaries[selected] === byte) {
      offsets.set(byte, utf16);
      selected++;
    }
    const code = character.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new Error('invalid native unit origin UTF16 source');
    byte += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x1_0000 ? 3 : 4;
    utf16 += character.length;
    if ((boundaries[selected] ?? byte) < byte)
      throw new Error('native unit origin splits a UTF8 scalar');
  }
  while (boundaries[selected] === byte) {
    offsets.set(byte, utf16);
    selected++;
  }
  if (byte !== unit.byteLength || selected !== boundaries.length)
    throw new Error('invalid native unit origin byte inventory');
  const finished = (value: { line: number; start: number; end: number }): NativeUnitSourceSpan => {
    const utf16Start = need(offsets.get(value.start));
    return {
      line: value.line,
      byteStart: value.start,
      byteLength: value.end - value.start,
      utf16Start,
      utf16Length: need(offsets.get(value.end)) - utf16Start,
    };
  };
  return {
    functions: staged.map((fn) => ({
      functionIndex: fn.functionIndex,
      header: finished(fn.header),
      nodes: fn.nodes.map((node) => ({ ...node, span: finished(node.span) })),
      ret: finished(fn.ret),
      end: finished(fn.end),
      examples: fn.examples.map((example) => ({ ...example, span: finished(example.span) })),
      ...(fn.pre === undefined ? {} : { pre: finished(fn.pre) }),
      ...(fn.post === undefined ? {} : { post: finished(fn.post) }),
    })),
  };
}
