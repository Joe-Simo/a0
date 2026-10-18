/** Conservative fixed-frame bound for an import-free, acyclic LLVM Wasm module. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

function requireProof(condition: unknown, message: string): asserts condition {
  assert.ok(condition, `Wasm stack bound: ${message}`);
}

class Reader {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(count: number): Uint8Array {
    requireProof(count >= 0 && this.at + count <= this.bytes.length, 'truncated binary');
    const result = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return result;
  }
  byte(): number {
    return this.take(1)[0] as number;
  }
  leb(signed = false, bits = 32): number {
    let value = 0n,
      shift = 0n;
    for (let n = 0; n < Math.ceil(bits / 7); n++) {
      const byte = this.byte();
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
      if (byte < 128) {
        if (signed && byte & 64) value -= 1n << shift;
        const width = BigInt(bits - (signed ? 1 : 0));
        requireProof(
          value >= (signed ? -(1n << width) : 0n) && value < 1n << width,
          'LEB overflow',
        );
        return Number(value);
      }
    }
    throw new Error('Wasm stack bound: overlong LEB');
  }
  name(): string {
    return new TextDecoder().decode(this.take(this.leb()));
  }
  done(): void {
    requireProof(this.at === this.bytes.length, 'trailing section bytes');
  }
}

interface Instruction {
  readonly op: number;
  readonly args: readonly number[];
}
const numericTypes = new Set([0x7f, 0x7e, 0x7d, 0x7c]);
const matches = (instruction: Instruction | undefined, op: number, ...args: number[]): boolean =>
  instruction?.op === op &&
  instruction.args.length === args.length &&
  args.every((arg, index) => instruction.args[index] === arg);

function decode(bytes: Uint8Array): Instruction[] {
  const reader = new Reader(bytes);
  for (let n = reader.leb(); n > 0; n--) {
    reader.leb();
    requireProof(numericTypes.has(reader.byte()), 'unsupported local type');
  }
  const result: Instruction[] = [];
  while (reader.at < bytes.length) {
    const op = reader.byte();
    let args: number[] = [];
    if (op === 2 || op === 3 || op === 4) {
      args = [reader.leb(true, 33)];
      requireProof([-64, -1, -2, -3, -4].includes(args[0] as number), 'unsupported block type');
    } else if ([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24].includes(op)) args = [reader.leb()];
    else if (op === 0x0e) args = Array.from({ length: reader.leb() + 1 }, () => reader.leb());
    else if (op >= 0x28 && op <= 0x3e) args = [reader.leb(), reader.leb()];
    else if (op === 0x3f || op === 0x40) {
      args = [reader.leb()];
      requireProof(args[0] === 0, 'nonzero memory index');
    } else if (op === 0x41 || op === 0x42) args = [reader.leb(true, op === 0x41 ? 32 : 64)];
    else if (op === 0x43 || op === 0x44) reader.take(op === 0x43 ? 4 : 8);
    else if (op === 0xfc) {
      const sub = reader.leb();
      requireProof(sub === 10 || sub === 11, `unsupported prefixed opcode ${sub}`);
      args = [sub, ...Array.from({ length: sub === 10 ? 2 : 1 }, () => reader.leb())];
      requireProof(
        args.slice(1).every((index) => index === 0),
        'nonzero memory index',
      );
    } else
      requireProof(
        [0, 1, 5, 0x0b, 0x0f, 0x1a, 0x1b].includes(op) || (op >= 0x45 && op <= 0xc4),
        `unsupported opcode 0x${op.toString(16)}`,
      );
    result.push({ op, args });
  }
  return result;
}

export interface WasmStackFunction {
  readonly index: number;
  readonly frameBytes: number;
  readonly calls: readonly number[];
  readonly globalAccesses: readonly { instruction: number; op: 'get' | 'set'; global: number }[];
  readonly cumulativeFrameBytes: number;
  readonly maxCallDepth: number;
}
export interface WasmStackProof {
  readonly schema: 1;
  readonly artifactSHA256: string;
  readonly artifactBytes: number;
  readonly method: string;
  readonly stackGlobal: { index: 0; initialValue: number };
  readonly imports: 0;
  readonly indirectCalls: 0;
  readonly unknownOpcodes: 0;
  readonly acyclic: true;
  readonly maxLinearStackBytes: number;
  readonly maxCallDepth: number;
  readonly opcodeHistogram: Readonly<Record<string, number>>;
  readonly functions: readonly WasmStackFunction[];
  readonly exports: Readonly<
    Record<
      string,
      { function: number; linearStackBytes: number; maxCallDepth: number; frameBoundPath: number[] }
    >
  >;
}

/**
 * Decode all final linked instructions, including libc. Unsupported code fails closed.
 * The result bounds the linear-memory C stack; the engine's call/operand stack is separate.
 * A trapping invocation can leave LLVM's stack global changed; this does not authorize reuse
 * after traps. Frame restoration is proved for every normal return.
 */
export function wasmStackBound(input: Uint8Array): WasmStackProof {
  const bytes = new Uint8Array(input);
  requireProof(WebAssembly.validate(bytes), 'invalid module');
  const reader = new Reader(bytes);
  reader.take(8); // The engine validated the magic and version.
  const sections = new Map<number, Uint8Array>();
  while (reader.at < bytes.length) {
    const id = reader.byte(),
      payload = reader.take(reader.leb());
    if (id === 0) continue;
    requireProof([1, 2, 3, 4, 5, 6, 7, 10].includes(id), `unsupported section ${id}`);
    sections.set(id, payload);
  }
  const section = (id: number): Reader => {
    const value = sections.get(id);
    requireProof(value, `missing section ${id}`);
    return new Reader(value);
  };
  const imports = sections.get(2);
  if (imports) {
    const part = new Reader(imports);
    requireProof(part.leb() === 0, 'imports cannot be bounded');
    part.done();
  }
  const types = section(1);
  for (let n = types.leb(); n > 0; n--) {
    requireProof(types.byte() === 0x60, 'unsupported function type');
    for (let p = types.leb(); p > 0; p--)
      requireProof(numericTypes.has(types.byte()), 'unsupported parameter type');
    const results = types.leb();
    requireProof(results <= 1, 'unsupported multivalue result');
    if (results) requireProof(numericTypes.has(types.byte()), 'unsupported result type');
  }
  types.done();
  const checkLimits = (part: Reader): void => {
    const flags = part.leb();
    requireProof(flags <= 1, 'unsupported memory/table limits');
    part.leb();
    if (flags) part.leb();
  };
  const tables = sections.get(4);
  if (tables) {
    const part = new Reader(tables);
    for (let n = part.leb(); n > 0; n--) {
      requireProof(part.byte() === 0x70, 'unsupported table type');
      checkLimits(part);
    }
    part.done();
  }
  const memories = section(5);
  requireProof(memories.leb() === 1, 'exactly one memory required');
  checkLimits(memories);
  memories.done();
  const globals = section(6);
  requireProof(globals.leb() === 1, 'exactly one stack global required');
  requireProof(
    globals.byte() === 0x7f && globals.byte() === 1 && globals.byte() === 0x41,
    'mutable i32 const stack global required',
  );
  const stackTop = globals.leb(true);
  requireProof(globals.byte() === 0x0b, 'unsupported stack initializer');
  globals.done();
  const exported = section(7),
    roots = new Map<string, number>();
  for (let n = exported.leb(); n > 0; n--) {
    const name = exported.name(),
      kind = exported.byte(),
      index = exported.leb();
    requireProof(kind === 0 || kind === 2, 'unsupported export kind');
    if (kind === 0) roots.set(name, index);
  }
  exported.done();
  requireProof(roots.size > 0, 'no exported function');
  const code = section(10),
    bodies = Array.from({ length: code.leb() }, () => decode(code.take(code.leb()))),
    histogram: Record<string, number> = {};
  code.done();
  const functions = bodies.map((body, index) => {
    const calls = [
      ...new Set(body.filter(({ op }) => op === 0x10).map(({ args }) => args[0] as number)),
    ].sort((a, b) => a - b);
    const accesses = body.flatMap(({ op, args }, instruction) =>
      op === 0x23 || op === 0x24
        ? [
            {
              instruction,
              op: op === 0x23 ? ('get' as const) : ('set' as const),
              global: args[0] as number,
            },
          ]
        : [],
    );
    let frameBytes = 0;
    if (accesses.length) {
      const local = body[3]?.args[0];
      frameBytes = body[1]?.args[0] ?? 0;
      requireProof(
        matches(body[0], 0x23, 0) &&
          body[1]?.op === 0x41 &&
          matches(body[2], 0x6b) &&
          local !== undefined &&
          matches(body[3], 0x22, local) &&
          matches(body[4], 0x24, 0),
        `unsupported prologue in function ${index}`,
      );
      requireProof(frameBytes > 0 && frameBytes % 16 === 0, 'positive aligned frame required');
      // LLVM's outermost restoration is identical for void and scalar returns.
      // A scalar result has one final local.get; a void result ends immediately.
      const epilogueLength = body.at(-2)?.op === 0x20 ? 6 : 5;
      const epilogue = body.length - epilogueLength;
      requireProof(
        matches(body[epilogue], 0x20, local) &&
          matches(body[epilogue + 1], 0x41, frameBytes) &&
          matches(body[epilogue + 2], 0x6a) &&
          matches(body[epilogue + 3], 0x24, 0) &&
          matches(body.at(-1), 0x0b),
        `unsupported epilogue in function ${index}`,
      );
      requireProof(
        accesses.length === 3 &&
          accesses[0]?.instruction === 0 &&
          accesses[1]?.instruction === 4 &&
          accesses[2]?.instruction === epilogue + 3,
        'unexpected stack global access',
      );
      let depth = 0;
      for (const [position, { op, args }] of body.entries()) {
        if ((op === 0x21 || op === 0x22) && args[0] === local)
          requireProof(position === 3, 'frame local modified');
        if (op === 2 || op === 3 || op === 4) depth++;
        else if (op === 0x0b) depth--;
        else if (op === 0x0f) requireProof(false, 'early return skips restoration');
        else if (op === 0x0c || op === 0x0d || op === 0x0e)
          requireProof(
            args.every((label) => label < depth),
            'branch skips restoration',
          );
        if (position === epilogue) requireProof(depth === 0, 'epilogue not outermost');
      }
      requireProof(depth === -1, 'unbalanced function controls');
    }
    for (const { op, args } of body) {
      const key = `0x${op.toString(16).padStart(2, '0')}${op === 0xfc ? `/${args[0]}` : ''}`;
      histogram[key] = (histogram[key] ?? 0) + 1;
    }
    return {
      index,
      frameBytes,
      calls,
      globalAccesses: accesses,
      cumulativeFrameBytes: 0,
      maxCallDepth: 0,
    };
  });
  const active = new Set<number>(),
    done = new Set<number>(),
    paths = new Map<number, number[]>();
  const visit = (index: number): void => {
    requireProof(!active.has(index), 'recursive call graph');
    if (done.has(index)) return;
    const fn = functions[index];
    requireProof(fn, 'unknown called function');
    active.add(index);
    for (const callee of fn.calls) visit(callee);
    let longest: number | undefined;
    for (const callee of fn.calls)
      if (
        longest === undefined ||
        (functions[callee]?.cumulativeFrameBytes ?? 0) >
          (functions[longest]?.cumulativeFrameBytes ?? 0)
      )
        longest = callee;
    fn.cumulativeFrameBytes =
      fn.frameBytes + (longest === undefined ? 0 : (functions[longest]?.cumulativeFrameBytes ?? 0));
    requireProof(fn.cumulativeFrameBytes <= 0xffffffff, 'frame chain exceeds wasm32 memory');
    fn.maxCallDepth =
      1 + Math.max(0, ...fn.calls.map((callee) => functions[callee]?.maxCallDepth ?? 0));
    paths.set(index, [index, ...(longest === undefined ? [] : (paths.get(longest) ?? []))]);
    active.delete(index);
    done.add(index);
  };
  for (const fn of functions) visit(fn.index);
  const exports = Object.fromEntries(
    [...roots].map(([name, index]) => {
      const fn = functions[index];
      requireProof(fn, 'unknown exported function');
      return [
        name,
        {
          function: index,
          linearStackBytes: fn.cumulativeFrameBytes,
          maxCallDepth: fn.maxCallDepth,
          frameBoundPath: paths.get(index) as number[],
        },
      ];
    }),
  );
  return {
    schema: 1,
    artifactSHA256: createHash('sha256').update(bytes).digest('hex'),
    artifactBytes: bytes.length,
    method:
      'All linked instructions decoded; constant balanced frames summed over an acyclic direct call graph. Linear-memory C stack only; traps terminate an invocation.',
    stackGlobal: { index: 0, initialValue: stackTop },
    imports: 0,
    indirectCalls: 0,
    unknownOpcodes: 0,
    acyclic: true,
    maxLinearStackBytes: Math.max(...Object.values(exports).map((fn) => fn.linearStackBytes)),
    maxCallDepth: Math.max(...Object.values(exports).map((fn) => fn.maxCallDepth)),
    opcodeHistogram: Object.fromEntries(Object.entries(histogram).sort()),
    functions,
    exports,
  };
}
