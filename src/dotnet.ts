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
  STRICT_TRAPS,
  usesIo,
} from './backends.js';
import {
  A0Error,
  assertTargetSupports,
  CHECKED_OPS,
  containsIo,
  isPrimitive,
  type Node,
  type Operand,
  type Type,
  type TypedFunc,
  type TypedProgram,
} from './core.js';
import { DIAGNOSTICS, TRAP_FIX } from './diagnostics.js';
import { callTraps, mayTrapFn, optimizeFunction, siteOf } from './optimize.js';

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

const CS_BOOL = 'R_r2_u_b';

/** The runtime of the six checked ops: total `(value, ok)` records, the same in both profiles. */
const CS_CHECKED = `  static ${CS_BOOL} a0_cadd(uint a, uint b) => new ${CS_BOOL}(unchecked(a + b), (ulong)a + b <= uint.MaxValue);
  static ${CS_BOOL} a0_csub(uint a, uint b) => new ${CS_BOOL}(unchecked(a - b), a >= b);
  static ${CS_BOOL} a0_cmul(uint a, uint b) => new ${CS_BOOL}(unchecked(a * b), (ulong)a * b <= uint.MaxValue);
  static ${CS_BOOL} a0_cdiv(uint a, uint b) => b == 0u ? new ${CS_BOOL}(0u, false) : new ${CS_BOOL}(a / b, true);
  static ${CS_BOOL} a0_crem(uint a, uint b) => b == 0u ? new ${CS_BOOL}(0u, false) : new ${CS_BOOL}(a % b, true);
  static ${CS_BOOL} a0_cget(uint[] a, uint i) => i < (uint)a.Length ? new ${CS_BOOL}(a[i], true) : new ${CS_BOOL}(0u, false);`;

const strictTable = (field: (k: (typeof STRICT_TRAPS)[number]) => string): string =>
  STRICT_TRAPS.map((k) => JSON.stringify(field(k))).join(', ');

/** The strict profile's runtime for C#: the shadow stack of frames and the trap raiser (`A0Trap.Line()` is the interpreter's trap line). */
const csStrictRuntime = (program: TypedProgram): string => {
  const depth = program.functions.length + 1;
  return `  public sealed class A0Trap : System.Exception {
    public readonly string Id; public readonly string Kind; public readonly string Fn; public readonly string? At; public readonly string? Trip; public readonly string[] Chain; public readonly string Fix;
    public A0Trap(string id, string kind, string fn, string? at, string? trip, string[] chain, string fix, string message) : base(message) {
      Id = id; Kind = kind; Fn = fn; At = at; Trip = trip; Chain = chain; Fix = fix;
    }
    /// <summary>The reference interpreter's trap line (formatTrap).</summary>
    public string Line() => "runtime: trap " + Kind + " fn=" + Fn + " at=" + (At ?? "-") + " trip=" + (Trip ?? "-") + " chain=" + string.Join(">", Chain) + " fix: " + Fix;
  }
  static readonly string[] a0_ch = new string[${depth}];
  static readonly string?[] a0_nd = new string?[${depth}];
  static readonly uint[] a0_tr = new uint[${depth}];
  static int a0_depth;
  static readonly string[] A0_ID = { ${strictTable(([, id]) => id)} };
  static readonly string[] A0_KIND = { ${strictTable(([k]) => k)} };
  static readonly string[] A0_MSG = { ${strictTable(([, id]) => DIAGNOSTICS[id].message)} };
  static readonly string[] A0_FIX = { ${strictTable(([k]) => TRAP_FIX[k])} };
  static void a0_enter(string fn) { a0_ch[a0_depth] = fn; a0_nd[a0_depth] = null; a0_depth++; }
  static uint a0_strap(int k) {
    int top = a0_depth - 1;
    string? at = null, trip = null;
    for (int i = top; i >= 0; i--) if (a0_nd[i] != null) { at = a0_ch[i] + "." + a0_nd[i]; trip = a0_tr[i].ToString(); break; }
    string fn = top >= 0 ? a0_ch[top] : "-";
    string[] chain = new string[a0_depth];
    System.Array.Copy(a0_ch, chain, a0_depth);
    a0_depth = 0;
    throw new A0Trap(A0_ID[k], A0_KIND[k], fn, at, trip, chain, A0_FIX[k], A0_MSG[k].Replace("{0}", fn));
  }
  static uint a0_ck(uint i, uint n) => i < n ? i : a0_strap(0);${
    usesIo(program)
      ? `
  static R_r2_u_io a0_sread(A0Io t) { if (t.Position >= t.NInput) a0_strap(2); uint v = t.Input[t.Position++]; return new R_r2_u_io(v, t); }`
      : ''
  }`;
};

function csExpr(node: Node, fn: TypedFunc): string {
  const [a, b, c] = node.args.map(csOperand);
  const site = siteOf(fn, node);
  const arrLen = (): number => {
    const t = operandTypeOf(fn, node.args[0] as Operand);
    if (isPrimitive(t) || t.kind !== 'arr') throw new A0Error('expected array operand');
    return t.length;
  };
  // `index mod N`; under strict a site that can leave the array checks instead.
  const idx = (): string =>
    site === 'bounds' ? `a0_ck(${b}, ${arrLen()}u)` : `${b} % ${arrLen()}u`;
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
      // A divisor that is the literal zero is the trap itself (C# rejects a constant division by zero).
      if (site === 'divzero')
        return b === '0u' ? 'a0_strap(1)' : `(${b} == 0u ? a0_strap(1) : ${a} / ${b})`;
      if (fn.profile === 'strict') return `${a} / ${b}`;
      return `(${b} == 0u ? uint.MaxValue : ${a} / ${b})`;
    case 'rem':
      if (site === 'divzero')
        return b === '0u' ? 'a0_strap(1)' : `(${b} == 0u ? a0_strap(1) : ${a} % ${b})`;
      if (fn.profile === 'strict') return `${a} % ${b}`;
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
      return `${a}[${idx()}]`;
    case 'set':
      return `set_${mangleType(operandTypeOf(fn, node.args[0] as Operand))}(${a}, ${site === 'bounds' ? idx() : b}, ${c})`;
    case 'at':
      return `${a}.f${node.args[1]?.kind === 'u32' ? node.args[1].value : 0}`;
    case 'put':
      return `put_${mangleType(operandTypeOf(fn, node.args[0] as Operand))}_${node.args[1]?.kind === 'u32' ? node.args[1].value : 0}(${a}, ${c})`;
    case 'read':
      return fn.profile === 'strict' ? `a0_sread(${a})` : `read(${a})`;
    case 'write':
      return `write(${a}, ${b})`;
    case 'puts':
      return `puts(${a}, ${b})`;
    case 'cadd':
    case 'csub':
    case 'cmul':
    case 'cdiv':
    case 'crem':
    case 'cget':
      return `a0_${node.op}(${a}, ${b})`;
    case 'fold':
    case 'loop':
      throw new A0Error(`${node.op} is emitted as a statement`);
  }
}

function emitFunction(fn: TypedFunc): string {
  const params = fn.params.map((t, i) => `${csType(t)} p${i}`).join(', ');
  // Strict: a function that can trap keeps a frame (its name, and the fold it is iterating) on
  // the shadow stack, so a trap names the same fn/at/trip/chain as the interpreter's.
  const framed = mayTrapFn(fn);
  const body = fn.nodes.map((n) => {
    const t = csType(fn.types.get(n.id) ?? 'u32');
    if (n.op !== 'fold' && n.op !== 'loop') return `    ${t} n_${n.id} = ${csExpr(n, fn)};`;
    const [count, init, ...extra] = n.args.map(csOperand);
    const call = [`n_${n.id}`, 'i', ...extra].join(', ');
    const guard = n.op === 'loop' ? ` if (!${n.pred ?? ''}(${call})) break;` : '';
    const marked = framed && callTraps(fn, n);
    const trip = marked ? ' a0_tr[a0_depth - 1] = i;' : '';
    return `    ${t} n_${n.id} = ${init};\n${marked ? `    a0_nd[a0_depth - 1] = ${JSON.stringify(n.id)};\n` : ''}    for (uint i = 0; i < ${count}; i++) {${trip}${guard} n_${n.id} = ${n.callee ?? ''}(${call}); }${marked ? '\n    a0_nd[a0_depth - 1] = null;' : ''}`;
  });
  const result = csType(fn.result);
  return [
    `  public static ${result} ${fn.name}(${params}) {`,
    ...(framed ? [`    a0_enter(${JSON.stringify(fn.name)});`] : []),
    ...body,
    ...(framed
      ? [`    ${result} a0_r = ${csOperand(fn.ret)};`, '    a0_depth--;', '    return a0_r;']
      : [`    return ${csOperand(fn.ret)};`]),
    '  }',
  ].join('\n');
}

/** Emit a C# source file defining `A0Module` with one static method per function. */
export function emitCSharp(
  program: TypedProgram,
  options: Pick<CompileOptions, 'optimize' | 'ioInputCapacity' | 'ioOutputCapacity'> = {},
): string {
  assertTargetSupports('dotnet', program);
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
  if (program.functions.some((f) => f.nodes.some((n) => CHECKED_OPS.has(n.op))))
    decls.push(CS_CHECKED);
  if (program.functions.some(mayTrapFn)) decls.push(csStrictRuntime(program));
  const bodies = program.functions.map((fn) =>
    emitFunction(options.optimize === false ? fn : optimizeFunction(fn).fn),
  );
  return `// Generated by A0. uint carries exact u32 semantics (unchecked context).\npublic static class ${CS_CLASS} {\n${decls.join('\n')}\n\n${bodies.join('\n\n')}\n}\n`;
}

export function hasIoFunctions(program: TypedProgram): boolean {
  return program.functions.some((fn) => fn.params.some(containsIo));
}
