/**
 * C# emission for .NET (Gate 8). C# has a native `uint` with wrapping arithmetic in the
 * default unchecked context, unsigned comparison, and shift counts masked to five bits,
 * so the mapping is direct. Arrays are `uint[]`/`bool[]` with clone-on-write, records are
 * `readonly record struct`s, and io is an `A0Io` class with the same stream protocol as
 * the C and Java runtimes. Semantics are unchanged.
 */

import {
  aggregateTypes,
  C_IO_INPUT_CAPACITY,
  C_IO_OUTPUT_CAPACITY,
  type CompileOptions,
  mangleType,
  usesIo,
} from './backends.js';
import {
  A0Error,
  containsIo,
  isPrimitive,
  type Node,
  type Operand,
  type Type,
  type TypedFunc,
  type TypedProgram,
} from './core.js';
import { optimizeFunction } from './optimize.js';

export const CS_CLASS = 'A0Module';

const csType = (t: Type): string =>
  t === 'u32'
    ? 'uint'
    : t === 'bool'
      ? 'bool'
      : t === 'io'
        ? 'A0Io'
        : t.kind === 'arr'
          ? `${csType(t.elem)}[]`
          : `R_${mangleType(t)}`;

function csOperand(o: Operand): string {
  switch (o.kind) {
    case 'node':
      return `n_${o.id}`;
    case 'param':
      return `p${o.index}`;
    case 'u32':
      return `${o.value}u`;
    case 'bool':
      return o.value ? 'true' : 'false';
  }
}

function operandTypeOf(fn: TypedFunc, o: Operand): Type {
  switch (o.kind) {
    case 'u32':
      return 'u32';
    case 'bool':
      return 'bool';
    case 'param':
      return fn.params[o.index] ?? 'u32';
    case 'node':
      return fn.types.get(o.id) ?? 'u32';
  }
}

function csTypeDecl(t: Type): string {
  if (isPrimitive(t)) return '';
  const m = mangleType(t);
  if (t.kind === 'arr') {
    const jt = csType(t);
    const e = csType(t.elem);
    return `  static ${jt} set_${m}(${jt} a, uint i, ${e} v) { var c = (${jt})a.Clone(); c[i % ${t.length}u] = v; return c; }`;
  }
  const name = csType(t);
  const comps = t.fields.map((f, i) => `${csType(f)} f${i}`).join(', ');
  const puts = t.fields.map(
    (f, i) =>
      `  static ${name} put_${m}_${i}(${name} r, ${csType(f)} v) { return r with { f${i} = v }; }`,
  );
  return [`  public readonly record struct ${name}(${comps});`, ...puts].join('\n');
}

/** C# io runtime with the C runtime's fixed capacities: input truncated to inCap words, writes past outCap dropped. */
const csIoRuntime = (inCap: number, outCap: number): string => `  public sealed class A0Io {
    public readonly uint[] Input = new uint[${inCap}]; public readonly int NInput; public int Position; public readonly uint[] Output = new uint[${outCap}]; public int NOutput;
    public A0Io(uint[] input) { NInput = System.Math.Min(input.Length, ${inCap}); System.Array.Copy(input, Input, NInput); }
  }
  static R_r2_u_io read(A0Io t) { uint v = t.Position < t.NInput ? t.Input[t.Position++] : 0u; return new R_r2_u_io(v, t); }
  static A0Io write(A0Io t, uint v) { if (t.NOutput < ${outCap}) t.Output[t.NOutput++] = v; return t; }
  static A0Io puts(A0Io t, uint[] a) { write(t, (uint)a.Length); foreach (uint v in a) write(t, v); return t; }`;

function csExpr(node: Node, fn: TypedFunc): string {
  const [a, b, c] = node.args.map(csOperand);
  const arrLen = (): number => {
    const t = operandTypeOf(fn, node.args[0] as Operand);
    if (isPrimitive(t) || t.kind !== 'arr') throw new A0Error('expected array operand');
    return t.length;
  };
  switch (node.op) {
    case 'mov':
      return `${a}`;
    case 'add':
      return `${a} + ${b}`;
    case 'sub':
      return `${a} - ${b}`;
    case 'mul':
      return `${a} * ${b}`;
    case 'and':
      return `${a} & ${b}`;
    case 'or':
      return `${a} | ${b}`;
    case 'xor':
      return `${a} ^ ${b}`;
    case 'shl':
      return `${a} << (int)(${b} & 31u)`;
    case 'shr':
      return `${a} >> (int)(${b} & 31u)`;
    case 'div':
      return `(${b} == 0u ? uint.MaxValue : ${a} / ${b})`;
    case 'rem':
      return `(${b} == 0u ? ${a} : ${a} % ${b})`;
    case 'eq':
      return `${a} == ${b}`;
    case 'lt':
      return `${a} < ${b}`;
    case 'le':
      return `${a} <= ${b}`;
    case 'gt':
      return `${a} > ${b}`;
    case 'ge':
      return `${a} >= ${b}`;
    case 'ne':
      return `${a} != ${b}`;
    case 'select':
      return `${a} ? ${b} : ${c}`;
    case 'call':
      return `${node.callee ?? ''}(${node.args.map(csOperand).join(', ')})`;
    case 'arr': {
      const t = fn.types.get(node.id) ?? 'u32';
      return `new ${csType(t)} { ${node.args.map(csOperand).join(', ')} }`;
    }
    case 'rec': {
      const t = fn.types.get(node.id) ?? 'u32';
      return `new ${csType(t)}(${node.args.map(csOperand).join(', ')})`;
    }
    case 'get':
      return `${a}[${b} % ${arrLen()}u]`;
    case 'set':
      return `set_${mangleType(operandTypeOf(fn, node.args[0] as Operand))}(${a}, ${b}, ${c})`;
    case 'at':
      return `${a}.f${node.args[1]?.kind === 'u32' ? node.args[1].value : 0}`;
    case 'put':
      return `put_${mangleType(operandTypeOf(fn, node.args[0] as Operand))}_${node.args[1]?.kind === 'u32' ? node.args[1].value : 0}(${a}, ${c})`;
    case 'read':
      return `read(${a})`;
    case 'write':
      return `write(${a}, ${b})`;
    case 'puts':
      return `puts(${a}, ${b})`;
    case 'fold':
    case 'loop':
      throw new A0Error(`${node.op} is emitted as a statement`);
  }
}

function emitFunction(fn: TypedFunc): string {
  const params = fn.params.map((t, i) => `${csType(t)} p${i}`).join(', ');
  const body = fn.nodes.map((n) => {
    const t = csType(fn.types.get(n.id) ?? 'u32');
    if (n.op !== 'fold' && n.op !== 'loop') return `    ${t} n_${n.id} = ${csExpr(n, fn)};`;
    const [count, init, ...extra] = n.args.map(csOperand);
    const call = [`n_${n.id}`, 'i', ...extra].join(', ');
    const guard = n.op === 'loop' ? ` if (!${n.pred ?? ''}(${call})) break;` : '';
    return `    ${t} n_${n.id} = ${init};\n    for (uint i = 0; i < ${count}; i++) {${guard} n_${n.id} = ${n.callee ?? ''}(${call}); }`;
  });
  return [
    `  public static ${csType(fn.result)} ${fn.name}(${params}) {`,
    ...body,
    `    return ${csOperand(fn.ret)};`,
    '  }',
  ].join('\n');
}

/** Emit a C# source file defining `A0Module` with one static method per function. */
export function emitCSharp(
  program: TypedProgram,
  options: Pick<CompileOptions, 'optimize' | 'ioInputCapacity' | 'ioOutputCapacity'> = {},
): string {
  const types = aggregateTypes(program);
  const io = usesIo(program);
  if (
    io &&
    !types.some(
      (t) =>
        !isPrimitive(t) &&
        t.kind === 'rec' &&
        t.fields.length === 2 &&
        t.fields[0] === 'u32' &&
        t.fields[1] === 'io',
    )
  ) {
    types.unshift({ kind: 'rec', fields: ['u32', 'io'] });
  }
  const decls = types.map(csTypeDecl).filter((d) => d.length > 0);
  if (io)
    decls.push(
      csIoRuntime(
        options.ioInputCapacity ?? C_IO_INPUT_CAPACITY,
        options.ioOutputCapacity ?? C_IO_OUTPUT_CAPACITY,
      ),
    );
  const bodies = program.functions.map((fn) =>
    emitFunction(options.optimize === false ? fn : optimizeFunction(fn).fn),
  );
  return `// Generated by A0. uint carries exact u32 semantics (unchecked context).\npublic static class ${CS_CLASS} {\n${decls.join('\n')}\n\n${bodies.join('\n\n')}\n}\n`;
}

export function hasIoFunctions(program: TypedProgram): boolean {
  return program.functions.some((fn) => fn.params.some(containsIo));
}
