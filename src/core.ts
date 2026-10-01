/**
 * A0 v0.1 core: grammar, typed representation, validation, and reference interpreter.
 *
 * Semantics (exact, target-independent):
 * - Types: u32 (unsigned 32-bit integer) and bool.
 * - add/sub/mul wrap modulo 2^32. and/or/xor are bitwise on u32.
 * - shl/shr shift by the low five bits of the distance; shr is logical.
 * - eq/lt are unsigned comparisons yielding bool.
 * - select(c, a, b) chooses a when c is true, else b; a and b share a type
 *   and are both already computed (no laziness, no effects).
 * - mov is the identity on either type.
 * - call f a... applies an earlier-defined function of this program to arguments
 *   whose types match its parameters; the result has the callee's result type.
 *   Callees must precede callers, so the call graph is acyclic (no recursion).
 * - fold f n s a... runs state = f(state, i, a...) for i = 0..n-1 starting from s and
 *   yields the final state; f is an earlier function of type (T, u32, A...) -> T.
 *   The u32 trip count guarantees termination; iterations are sequential and exact.
 * - loop p f n s a... is fold with early exit: before each iteration i < n the
 *   predicate p(state, i, a...) : bool is evaluated; when false the loop stops and
 *   the current state is the result; otherwise state = f(state, i, a...). n caps
 *   the iteration count so termination is still guaranteed.
 * All operations are pure and total on validated input.
 */

export const LANGUAGE_VERSION = 'a0-0.1';

/**
 * Types: scalars, fixed-length arrays (`u32x4`, left-associative so `u32x4x2` is two
 * u32x4), and positional records (`(u32,bool)`). Aggregates are values: every operation
 * yields a fresh value, so no aliasing exists in the language.
 */
export type Type = 'u32' | 'bool' | 'io' | ArrayType | RecordType;

/**
 * `io` is the effect capability: a linear token whose data dependencies define effect
 * order. `read t` consumes t and yields `(u32,io)`; `write t v` consumes t and yields
 * `io`. A token is consumed at most once, a function takes at most one `io` parameter,
 * arrays cannot hold tokens, and `select` cannot choose between tokens.
 */
export function containsIo(t: Type): boolean {
  if (t === 'io') return true;
  if (typeof t === 'string') return false;
  if (t.kind === 'arr') return containsIo(t.elem);
  return t.fields.some(containsIo);
}
export interface ArrayType {
  readonly kind: 'arr';
  readonly length: number;
  readonly elem: Type;
}
export interface RecordType {
  readonly kind: 'rec';
  readonly fields: readonly Type[];
}

export function isScalar(t: Type): t is 'u32' | 'bool' {
  return t === 'u32' || t === 'bool';
}

/** Scalars and the io token: every type that is not an array or record. */
export function isPrimitive(t: Type): t is 'u32' | 'bool' | 'io' {
  return typeof t === 'string';
}

export function typeEquals(a: Type, b: Type): boolean {
  if (isScalar(a) || isScalar(b) || a === 'io' || b === 'io') return a === b;
  if (a.kind === 'arr')
    return b.kind === 'arr' && a.length === b.length && typeEquals(a.elem, b.elem);
  return (
    b.kind === 'rec' &&
    a.fields.length === b.fields.length &&
    a.fields.every((f, i) => typeEquals(f, b.fields[i] as Type))
  );
}

export function formatType(t: Type): string {
  if (isScalar(t) || t === 'io') return t;
  if (t.kind === 'arr') return `${formatType(t.elem)}x${t.length}`;
  return `(${t.fields.map(formatType).join(',')})`;
}

/** Bit width of a value of this type (u32 = 32, bool = 1, aggregates packed). */
export function bitWidth(t: Type): number {
  if (t === 'u32') return 32;
  if (t === 'bool') return 1;
  if (t === 'io')
    throw new A0Error(
      'io has no bit-level representation (sequential hardware state is not implemented)',
    );
  if (t.kind === 'arr') return t.length * bitWidth(t.elem);
  return t.fields.reduce((n, f) => n + bitWidth(f), 0);
}

/** Longest array dimension anywhere inside a type (0 for a type without arrays). */
export function longestArray(t: Type): number {
  if (isPrimitive(t)) return 0;
  if (t.kind === 'arr') return Math.max(t.length, longestArray(t.elem));
  return t.fields.reduce((n, f) => Math.max(n, longestArray(f)), 0);
}

/**
 * Refuse a function whose parameters, result, or nodes use an array longer than
 * LIMITS.maxVectorArrayLength on a target that keeps aggregates in registers or bit vectors.
 */
export function assertVectorSized(fn: TypedFunc, target: string): void {
  const types = [...fn.params, fn.result, ...fn.types.values()];
  const longest = types.reduce((n, t) => Math.max(n, longestArray(t)), 0);
  if (longest > LIMITS.maxVectorArrayLength) {
    throw new A0Error(
      `${fn.name}: array length ${longest} exceeds the ${target} limit ${LIMITS.maxVectorArrayLength}`,
      undefined,
      {
        code: 'limit',
        fix: `keep arrays at most ${LIMITS.maxVectorArrayLength} long for ${target}, or compile to a native target`,
      },
    );
  }
}

export type Op =
  | 'mov'
  | 'add'
  | 'sub'
  | 'mul'
  | 'and'
  | 'or'
  | 'xor'
  | 'shl'
  | 'shr'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'select'
  | 'call'
  | 'fold'
  | 'loop'
  | 'arr'
  | 'rec'
  | 'get'
  | 'set'
  | 'at'
  | 'put'
  | 'read'
  | 'write'
  | 'div'
  | 'rem'
  | 'puts';

export const OPS: readonly Op[] = [
  'mov',
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'select',
  'call',
  'fold',
  'loop',
  'arr',
  'rec',
  'get',
  'set',
  'at',
  'put',
  'read',
  'write',
  'div',
  'rem',
  'puts',
];

/** Operand counts; `call` is variable (the callee's parameter count) and marked -1. */
export const OP_ARITY: Readonly<Record<Op, number>> = {
  mov: 1,
  add: 2,
  sub: 2,
  mul: 2,
  and: 2,
  or: 2,
  xor: 2,
  shl: 2,
  shr: 2,
  eq: 2,
  ne: 2,
  lt: 2,
  le: 2,
  gt: 2,
  ge: 2,
  select: 3,
  call: -1,
  fold: -1,
  loop: -1,
  arr: -1,
  rec: -1,
  get: 2,
  set: 3,
  at: 2,
  put: 3,
  read: 1,
  write: 2,
  div: 2,
  rem: 2,
  puts: 2,
};

export type Operand =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'param'; readonly index: number }
  | { readonly kind: 'u32'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean };

export interface Node {
  readonly id: string;
  readonly op: Op;
  readonly args: readonly Operand[];
  /** Present exactly when op is 'call', 'fold', or 'loop' (the body). */
  readonly callee?: string;
  /** Present exactly when op is 'loop': the continue-predicate function. */
  readonly pred?: string;
  /** Source form of an `arr` node written as `text "..."`: UTF-8 bytes as u32 elements. */
  readonly text?: string;
}

/** Remove a `#` comment unless the `#` sits inside a double-quoted text literal. */
export function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && quoted) {
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === '#' && !quoted) {
      return line.slice(0, i);
    }
  }
  return line;
}

const TEXT_LINE = /^(\S+)\s+text\s+"((?:[^"\\]|\\.)*)"\s*$/;

function decodeText(raw: string, line?: number): string {
  return raw.replace(/\\(.)/g, (_, c: string) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === '"' || c === '\\') return c;
    throw new A0Error(`unknown escape \\${c} in text literal`, line);
  });
}

export function formatTextLiteral(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

export interface Func {
  readonly name: string;
  readonly params: readonly Type[];
  readonly result: Type;
  readonly nodes: readonly Node[];
  readonly ret: Operand;
}

export interface Program {
  readonly functions: readonly Func[];
  /**
   * `use "path"` lines from the head of the file: other A0 files whose functions this one
   * calls. Resolved by the linker (src/link.ts) into one flat program; `validate` on an
   * unlinked program with uses fails on the first unresolved callee.
   */
  readonly uses?: readonly string[];
}

/** A function whose every node has an inferred result type. */
export interface TypedFunc extends Func {
  readonly types: ReadonlyMap<string, Type>;
  /**
   * Static upper bound on body evaluations per call: products of trip counts (a variable
   * count is 2^32) through callees. Used to reject programs whose literal iteration alone
   * exceeds LIMITS.maxStaticIterations; variable counts are reported, not rejected.
   */
  readonly staticIterations: number;
  /**
   * Largest product of literal trip counts along any nesting path through callees (a variable
   * count contributes a factor of 1, since fuel bounds it at run time). This, not
   * `staticIterations`, is what LIMITS.maxStaticIterations bounds.
   */
  readonly literalIterations: number;
  /** Resolved callees (each defined earlier in the same program). */
  readonly calls: ReadonlyMap<string, TypedFunc>;
}

export interface TypedProgram {
  readonly functions: readonly TypedFunc[];
  readonly byName: ReadonlyMap<string, TypedFunc>;
}

/**
 * Borrowed reads (backends with flat aggregate storage: C, the native targets, wasm). A `get`
 * or `at` whose result is an aggregate names a part of its container's storage instead of
 * copying it; `mov` and `select` of a borrow alias it too. Value semantics then require that
 * the container is not updated in place while a borrow of it is still read. Is some borrow of
 * `o` read after the node at `index` (or by that node itself, unless `selfRead`: a `set`/`put`
 * reads its value operand before writing its target, whereas a fold's body keeps reading its
 * extras while the state changes), or returned?
 */
export function borrowLive(fn: TypedFunc, o: Operand, index: number, selfRead: boolean): boolean {
  const same = (x: Operand): boolean =>
    (x.kind === 'node' && o.kind === 'node' && x.id === o.id) ||
    (x.kind === 'param' && o.kind === 'param' && x.index === o.index);
  const borrows = new Set<string>();
  for (const n of fn.nodes) {
    const t = fn.types.get(n.id);
    if (t === undefined || isPrimitive(t)) continue;
    const from = (x: Operand | undefined): boolean =>
      x !== undefined && (same(x) || (x.kind === 'node' && borrows.has(x.id)));
    const borrowed =
      ((n.op === 'get' || n.op === 'at') && from(n.args[0])) ||
      (n.op === 'mov' && from(n.args[0])) ||
      (n.op === 'select' && (from(n.args[1]) || from(n.args[2])));
    // From `o` itself or from an earlier borrow of it (nodes are in definition order).
    if (borrowed) borrows.add(n.id);
  }
  if (borrows.size === 0) return false;
  const isBorrow = (x: Operand): boolean => x.kind === 'node' && borrows.has(x.id);
  if (isBorrow(fn.ret)) return true;
  for (const [j, n] of fn.nodes.entries()) {
    if (j < index || (j === index && selfRead)) continue;
    if (n.args.some(isBorrow)) return true;
  }
  return false;
}

/**
 * Stable diagnostic classes. A model repairing a rejected edit keys on `code` and `fix`,
 * never on message text: `parse` (source line does not follow the grammar), `type`
 * (operand or result type mismatch), `structure` (identifiers, arity, io token use),
 * `limit` (a hostile-input bound), `edit` (a session edit body), `patch` (a standalone
 * patch header), `revision` (the target changed since the view was opened), `handle`
 * (unknown, consumed, or exhausted view handle), `runtime` (evaluation), `cli`.
 */
export type DiagnosticCode =
  | 'parse'
  | 'type'
  | 'structure'
  | 'limit'
  | 'edit'
  | 'patch'
  | 'revision'
  | 'handle'
  | 'runtime'
  | 'cli';

/**
 * Why a run stopped before returning: the budget that ran out (`fuel`: node evaluations,
 * `iter`: the total fold/loop trip cap, `io`: the io output cap), where, and how it got there.
 */
export type TrapKind = 'fuel' | 'iter' | 'io';

export interface Trap {
  readonly kind: TrapKind;
  /** The function that was executing when the budget ran out. */
  readonly fn: string;
  /** The innermost running fold/loop as `function.node`, or null outside any iteration. */
  readonly at: string | null;
  /** Index of the trip that was refused or running, or null outside any iteration. */
  readonly trip: number | null;
  /** Call chain from the entry function down to `fn`. */
  readonly chain: readonly string[];
}

export const TRAP_FIX: Record<TrapKind, string> = {
  fuel: 'raise the fuel budget or lower the fold/loop counts on the chain',
  iter: 'raise the trip cap or lower the fold/loop counts on the chain',
  io: 'write fewer words, or return the output in smaller pieces',
};

/**
 * The one-line trap code, the same `code: message fix: fix` shape as every other diagnostic:
 * `limit: trap fuel fn=step at=main.n3 trip=412 chain=main>step fix: ...`. The C backend's
 * trap runtime (CompileOptions.cTrap) prints exactly this line for an iteration-cap stop.
 */
export function formatTrap(t: Trap): string {
  return `limit: trap ${t.kind} fn=${t.fn} at=${t.at ?? '-'} trip=${t.trip ?? '-'} chain=${t.chain.join('>')} fix: ${TRAP_FIX[t.kind]}`;
}

export interface DiagnosticDetail {
  readonly code?: DiagnosticCode;
  /** Set when the run stopped on a budget (fuel, iteration cap, io output cap). */
  readonly trap?: Trap;
  /** What the checker required, when it is a single thing (a type, a count, a token). */
  readonly expected?: string;
  /** What it found instead. */
  readonly actual?: string;
  /** The one action that resolves this diagnostic, stated for the editor, not a human. */
  readonly fix?: string;
}

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly line: number | null;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly fix: string | null;
}

export class A0Error extends Error {
  override readonly name = 'A0Error';
  readonly code: DiagnosticCode;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  readonly fix: string | undefined;
  readonly trap: Trap | undefined;
  constructor(
    message: string,
    readonly line?: number,
    detail: DiagnosticDetail = {},
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.code = detail.code ?? 'structure';
    this.expected = detail.expected;
    this.actual = detail.actual;
    this.fix = detail.fix;
    this.trap = detail.trap;
  }

  /** Machine-readable form; every field is present (null when absent). */
  toJSON(): Diagnostic {
    return {
      code: this.code,
      message: this.message,
      line: this.line ?? null,
      expected: this.expected ?? null,
      actual: this.actual ?? null,
      fix: this.fix ?? null,
    };
  }
}

/** One-line diagnostic for a model: `code: message` plus the fix when there is one. */
export function formatDiagnostic(e: unknown): string {
  if (e instanceof A0Error && e.trap !== undefined) return formatTrap(e.trap);
  if (e instanceof A0Error)
    return `${e.code}: ${e.message}${e.fix === undefined ? '' : ` fix: ${e.fix}`}`;
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Limits (hostile-input bounds)
// ---------------------------------------------------------------------------

export const LIMITS = {
  maxSourceBytes: 1 << 20,
  /** Functions per program, also after linking (a0c-0.1.14: raised from 1024). */
  maxFunctions: 65536,
  maxNodesPerFunction: 4096,
  maxParams: 64,
  maxIdentifierLength: 64,
  /** Elements per array dimension; the native paths (C, JS, JVM, .NET, arm64) hold these in memory. */
  maxArrayLength: 65536,
  /** Total bits of one aggregate value (bounds nested arrays): 65536 u32 words. */
  maxAggregateBits: 1 << 21,
  /**
   * Longest array the hardware (SystemVerilog) and GPU (Metal) backends accept: these targets
   * hold aggregates as bit vectors or thread-local registers, so larger values are refused
   * with a `limit` diagnostic instead of being emitted as multi-megabit vectors.
   */
  maxVectorArrayLength: 1024,
  /** Product of literal trip counts along any nesting path a validator will accept (compute bound). */
  maxStaticIterations: 1 << 24,
  /** Default interpreter fuel: node evaluations before `run` aborts with A0Error. */
  defaultFuel: 100_000_000,
  /** Maximum words an io state may accumulate on its output in the reference evaluator. */
  maxIoOutput: 1 << 20,
} as const;

const IDENT = /^[a-z][a-z0-9_]{0,63}$/;
const PARAM = /^p(0|[1-9][0-9]*)$/;
const U32_LITERAL = /^(0|[1-9][0-9]*)$/;
const RESERVED = new Set(['fn', 'ret', 'end', 'patch', 'true', 'false']);
const U32_MAX = 0xffff_ffff;

/** UTF-8 byte length without Node's Buffer (the compiler core also runs in the browser). */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isValidIdentifier(id: string): boolean {
  return IDENT.test(id) && !RESERVED.has(id) && !PARAM.test(id);
}

export function isValidFunctionName(name: string): boolean {
  return IDENT.test(name) && !RESERVED.has(name);
}

export function parseType(text: string, line?: number): Type {
  let pos = 0;
  const fail = (msg: string): never => {
    throw new A0Error(`type '${text}': ${msg}`, line, { code: 'parse' });
  };
  const parseOne = (): Type => {
    let base: Type;
    if (text.startsWith('u32', pos)) {
      base = 'u32';
      pos += 3;
    } else if (text.startsWith('bool', pos)) {
      base = 'bool';
      pos += 4;
    } else if (text.startsWith('io', pos)) {
      base = 'io';
      pos += 2;
    } else if (text[pos] === '(') {
      pos += 1;
      const fields: Type[] = [parseOne()];
      while (text[pos] === ',') {
        pos += 1;
        fields.push(parseOne());
      }
      if (text[pos] !== ')') fail("expected ')'");
      pos += 1;
      base = { kind: 'rec', fields };
    } else {
      return fail(`unexpected '${text[pos] ?? 'end'}'`);
    }
    while (text[pos] === 'x') {
      const m = /^x([1-9][0-9]*)/.exec(text.slice(pos));
      if (!m) fail('expected array length after x');
      const length = Number(m?.[1]);
      if (length > LIMITS.maxArrayLength) fail(`array length exceeds ${LIMITS.maxArrayLength}`);
      pos += (m?.[0] ?? '').length;
      if (containsIo(base)) fail('arrays cannot hold io tokens');
      base = { kind: 'arr', length, elem: base };
    }
    if (!containsIo(base) && bitWidth(base) > LIMITS.maxAggregateBits)
      fail(`type exceeds ${LIMITS.maxAggregateBits} bits`);
    return base;
  };
  const t = parseOne();
  if (pos !== text.length) fail(`trailing '${text.slice(pos)}'`);
  return t;
}

export function parseOperand(text: string, line?: number): Operand {
  if (text === 'true') return { kind: 'bool', value: true };
  if (text === 'false') return { kind: 'bool', value: false };
  if (PARAM.test(text)) return { kind: 'param', index: Number(text.slice(1)) };
  if (U32_LITERAL.test(text)) {
    const value = Number(text);
    if (value > U32_MAX) throw new A0Error(`literal ${text} exceeds u32`, line, { code: 'limit' });
    return { kind: 'u32', value };
  }
  if (isValidIdentifier(text)) return { kind: 'node', id: text };
  throw new A0Error(`invalid operand '${text}'`, line, { code: 'parse' });
}

function isOp(text: string): text is Op {
  return (OPS as readonly string[]).includes(text);
}

/**
 * Accepted spellings of an op, parsed as the op itself (the canonical form prints the op). Every
 * A0 integer op is unsigned, so `udiv`/`urem` name exactly `div`/`rem`.
 */
export const OP_ALIASES: Readonly<Record<string, Op>> = { udiv: 'div', urem: 'rem' };

/** The op a word names (an op or an accepted alias), or undefined. */
export function opOf(word: string): Op | undefined {
  return isOp(word) ? word : Object.hasOwn(OP_ALIASES, word) ? OP_ALIASES[word] : undefined;
}

/**
 * Whether `word` in op position is a direct call `id F args…` (short for `id call F args…`):
 * any valid function name that is not an op, an alias, or the `text` form. Ops take precedence,
 * so a function named like an op is called only with `call`.
 */
export function isDirectCallee(word: string): boolean {
  return opOf(word) === undefined && word !== 'text' && isValidFunctionName(word);
}

/**
 * Fix hint for a line with a parenthesised operand, which A0 does not have (one op per line):
 * the inner op on its own line above, then the line using that node. `ret (a, b)` builds a
 * record.
 */
function nestedFix(id: string, head: readonly string[], rest: readonly string[]): string {
  const text = rest.join(' ');
  const open = text.indexOf('(');
  const close = text.indexOf(')', open);
  const inner = (close < 0 ? text.slice(open + 1) : text.slice(open + 1, close))
    .replaceAll(',', ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const innerOp = inner[0] ?? '';
  // `(a, b)` or `(a b)` is a record; `(OP …)` or `(F …)` an inner op or call.
  const tuple =
    text.slice(open, close < 0 ? undefined : close).includes(',') ||
    (opOf(innerOp) === undefined && !(isDirectCallee(innerOp) && inner.length > 1));
  if (tuple) inner.unshift('rec');
  if (id === 'ret' && text.startsWith('(') && (close < 0 || close === text.length - 1))
    return `write \`ret ${inner.join(' ')}\``;
  const t = `${id === 'ret' ? 'r' : id}1`;
  const outer = `${text.slice(0, open)}${t}${close < 0 ? '' : text.slice(close + 1)}`
    .trim()
    .replace(/\s+/g, ' ');
  return `one op per line: write \`${t} ${inner.join(' ')}\` above, then \`${[...head, outer].join(' ')}\``;
}

/** Parse one instruction line `id op operand...` (no validation of references). */
export function parseNode(lineText: string, line?: number): Node {
  const textMatch = TEXT_LINE.exec(lineText.trim());
  if (textMatch !== null) {
    // `id text "..."` desugars to `arr` of UTF-8 byte words; the source form is retained.
    const [, id, raw] = textMatch;
    if (id === undefined || !isValidIdentifier(id)) {
      throw new A0Error(`invalid node identifier '${id ?? ''}'`, line, { code: 'parse' });
    }
    const text = decodeText(raw ?? '', line);
    const bytes = new TextEncoder().encode(text);
    if (bytes.length === 0)
      throw new A0Error('text literal must not be empty', line, { code: 'parse' });
    if (bytes.length > LIMITS.maxArrayLength) {
      throw new A0Error(`text literal exceeds ${LIMITS.maxArrayLength} bytes`, line, {
        code: 'limit',
      });
    }
    return { id, op: 'arr', args: [...bytes].map((value) => ({ kind: 'u32', value })), text };
  }
  const parts = lineText.trim().split(/\s+/);
  const [id, word, ...rest] = parts;
  if (id === undefined || word === undefined)
    throw new A0Error('expected `id op operands`', line, { code: 'parse' });
  if (!isValidIdentifier(id))
    throw new A0Error(`invalid node identifier '${id}'`, line, { code: 'parse' });
  if (rest.some((r) => r.startsWith('(') || r.endsWith(')')))
    throw new A0Error('nested operand: A0 has one op per line', line, {
      code: 'parse',
      fix: nestedFix(id, [id, word], rest),
    });
  // `id F args…` with F a function name (not an op) is the direct form of `id call F args…`.
  if (isDirectCallee(word))
    return { id, op: 'call', callee: word, args: rest.map((r) => parseOperand(r, line)) };
  const op = opOf(word);
  if (op === undefined)
    throw new A0Error(`unknown operation '${word}'`, line, {
      code: 'parse',
      fix: `use one of ${OPS.join(' ')}, or call a function F defined above: \`${id} F args…\``,
    });
  if (op === 'loop') {
    const [pred, callee, ...args] = rest;
    if (
      pred === undefined ||
      !isValidFunctionName(pred) ||
      callee === undefined ||
      !isValidFunctionName(callee)
    ) {
      throw new A0Error('loop expects a predicate and a body function name', line, {
        code: 'parse',
      });
    }
    return { id, op, pred, callee, args: args.map((r) => parseOperand(r, line)) };
  }
  if (op === 'call' || op === 'fold') {
    const [callee, ...args] = rest;
    if (callee === undefined || !isValidFunctionName(callee)) {
      throw new A0Error(`${op} expects a function name, got '${callee ?? ''}'`, line, {
        code: 'parse',
      });
    }
    return { id, op, callee, args: args.map((r) => parseOperand(r, line)) };
  }
  if (OP_ARITY[op] >= 0 && rest.length !== OP_ARITY[op]) {
    throw new A0Error(`${op} expects ${OP_ARITY[op]} operands, got ${rest.length}`, line, {
      code: 'parse',
      expected: String(OP_ARITY[op]),
      actual: String(rest.length),
      fix: `write exactly ${OP_ARITY[op]} operands after ${op}`,
    });
  }
  if (OP_ARITY[op] < 0 && rest.length === 0)
    throw new A0Error(`${op} expects at least one operand`, line, { code: 'parse' });
  return { id, op, args: rest.map((r) => parseOperand(r, line)) };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse A0 source text. Comments (`#` to end of line) and blank lines are
 * discarded; there is no separate intent store in v0.1.
 */
/** Node id for a `ret OP …` line: `retval`, or `retval2`, `retval3`… if taken. */
export function freshRetId(nodes: readonly { readonly id: string }[]): string {
  const taken = new Set(nodes.map((n) => n.id));
  if (!taken.has('retval')) return 'retval';
  for (let k = 2; ; k += 1) if (!taken.has(`retval${k}`)) return `retval${k}`;
}

/**
 * Whether a `ret` line (split on whitespace) is `ret OP ARGS…` or `ret F ARGS…`: sugar for a
 * fresh node computing the value and `ret` of it. `ret NAME` alone is always the operand NAME.
 */
export function isRetNodeForm(parts: readonly string[]): boolean {
  const word = parts[1] ?? '';
  return parts.length > 2 && (opOf(word) !== undefined || isDirectCallee(word));
}

/** The error for a `ret` line with more than one word that is not `ret OP ARGS…`. */
export function retOperandError(
  parts: readonly string[],
  line: number | undefined,
  code: DiagnosticCode,
): A0Error {
  const rest = parts.slice(1);
  const nested = rest.some((r) => r.includes('('));
  return new A0Error(
    nested ? 'nested operand: A0 has one op per line' : 'ret expects one operand',
    line,
    { code, fix: nested ? nestedFix('ret', ['ret'], rest) : 'write `ret ID` or `ret OP ARGS…`' },
  );
}

export function parse(source: string): Program {
  if (utf8Length(source) > LIMITS.maxSourceBytes) {
    throw new A0Error(`source exceeds ${LIMITS.maxSourceBytes} bytes`, undefined, {
      code: 'limit',
    });
  }
  const lines = source.split(/\r?\n/);
  const functions: Func[] = [];
  const names = new Set<string>();
  let i = 0;
  const next = (): { text: string; line: number } | undefined => {
    while (i < lines.length) {
      const raw = lines[i] ?? '';
      i += 1;
      const text = stripComment(raw).trim();
      if (text.length > 0) return { text, line: i };
    }
    return undefined;
  };

  const uses: string[] = [];
  for (let cur = next(); cur !== undefined; cur = next()) {
    const head = cur.text.split(/\s+/);
    if (head[0] === 'use') {
      const m = /^use\s+"([^"\\]+)"$/.exec(cur.text);
      if (m === null || functions.length > 0)
        throw new A0Error('use expects `use "path.a0"` before the first fn', cur.line, {
          code: 'parse',
          fix: 'write use "relative/path.a0" as its own line at the top of the file',
        });
      uses.push(m[1] as string);
      continue;
    }
    if (head[0] !== 'fn')
      throw new A0Error(`expected 'fn', got '${head[0]}'`, cur.line, {
        code: 'parse',
        fix: 'instruction lines belong inside a function: start it with `fn NAME T... -> T` and close it with `ret X` and `end`',
      });
    const name = head[1];
    if (name === undefined || !isValidFunctionName(name)) {
      throw new A0Error(`invalid function name '${name ?? ''}'`, cur.line, { code: 'parse' });
    }
    if (names.has(name))
      throw new A0Error(`duplicate function '${name}'`, cur.line, { code: 'parse' });
    const arrow = head.indexOf('->');
    if (arrow < 2 || arrow !== head.length - 2) {
      throw new A0Error("expected 'fn name types... -> type'", cur.line, { code: 'parse' });
    }
    const params = head.slice(2, arrow).map((t) => parseType(t, cur.line));
    if (params.length > LIMITS.maxParams)
      throw new A0Error('too many parameters', cur.line, { code: 'limit' });
    const result = parseType(head[arrow + 1] ?? '', cur.line);

    const nodes: Node[] = [];
    let ret: Operand | undefined;
    let closed = false;
    for (let body = next(); body !== undefined; body = next()) {
      const first = body.text.split(/\s+/)[0];
      if (first === 'ret') {
        const parts = body.text.split(/\s+/);
        if (isRetNodeForm(parts)) {
          // `ret OP ARGS…` is sugar for a fresh node followed by `ret` of it.
          const id = freshRetId(nodes);
          nodes.push(parseNode(`${id} ${parts.slice(1).join(' ')}`, body.line));
          ret = { kind: 'node', id };
        } else {
          if (parts.length !== 2) throw retOperandError(parts, body.line, 'parse');
          ret = parseOperand(parts[1] ?? '', body.line);
        }
        const endLine = next();
        if (endLine === undefined || endLine.text !== 'end') {
          throw new A0Error("expected 'end' after ret", endLine?.line ?? body.line, {
            code: 'parse',
          });
        }
        closed = true;
        break;
      }
      if (first === 'end' || first === 'fn') {
        throw new A0Error(`unexpected '${first}' before ret`, body.line, { code: 'parse' });
      }
      if (nodes.length >= LIMITS.maxNodesPerFunction) {
        throw new A0Error('too many nodes in function', body.line, { code: 'limit' });
      }
      nodes.push(parseNode(body.text, body.line));
    }
    if (!closed || ret === undefined)
      throw new A0Error(`function '${name}' not terminated`, undefined, { code: 'parse' });
    if (functions.length >= LIMITS.maxFunctions)
      throw new A0Error('too many functions', undefined, { code: 'limit' });
    names.add(name);
    functions.push({ name, params, result, nodes, ret });
  }
  return { functions, uses };
}

// ---------------------------------------------------------------------------
// Validation and type inference
// ---------------------------------------------------------------------------

function operandType(
  operand: Operand,
  fn: Func,
  types: ReadonlyMap<string, Type>,
  defined: ReadonlySet<string>,
  where: string,
): Type {
  switch (operand.kind) {
    case 'u32':
      return 'u32';
    case 'bool':
      return 'bool';
    case 'param': {
      const t = fn.params[operand.index];
      if (t === undefined)
        throw new A0Error(`${where}: parameter p${operand.index} out of range`, undefined, {
          code: 'type',
        });
      return t;
    }
    case 'node': {
      if (!defined.has(operand.id)) {
        throw new A0Error(
          `${where}: reference to undefined or later node '${operand.id}'`,
          undefined,
          {
            code: 'structure',
            fix: `define '${operand.id}' on an earlier line of this function, or reference a node defined above ${where}`,
          },
        );
      }
      const t = types.get(operand.id);
      if (t === undefined)
        throw new A0Error(`${where}: untyped node '${operand.id}'`, undefined, { code: 'type' });
      return t;
    }
  }
}

/**
 * Fix text for a fold/loop whose body does not fit its operands. The body is called as
 * `F(state, i, extras...)` once per step, so the operands fix one header,
 * `fn F S u32 X... -> S` (S the initial state's type, X the extras'). The text names that
 * header, the body's actual header, and the operand shape the actual header accepts.
 */
function foldBodyFix(
  op: 'fold' | 'loop',
  callee: { readonly name: string; readonly params: readonly Type[]; readonly result: Type },
  init: Type,
  extra: readonly Type[],
): string {
  const header = (params: readonly Type[], result: Type): string =>
    `\`fn ${[callee.name, ...params.map(formatType)].join(' ')} -> ${formatType(result)}\``;
  const head = op === 'loop' ? `loop P ${callee.name}` : `fold ${callee.name}`;
  const wanted = header([init, 'u32', ...extra], init);
  const actual = header(callee.params, callee.result);
  const [stateT, indexT, ...extraT] = callee.params;
  const shape =
    stateT !== undefined &&
    indexT !== undefined &&
    typeEquals(indexT, 'u32') &&
    typeEquals(callee.result, stateT)
      ? `; as declared, write \`${[head, 'N', 'S', ...extraT.map((_, i) => `X${i}`)].join(' ')}\` with S a ${formatType(stateT)}${extraT.length === 0 ? ' and no extras' : ` and extras ${extraT.map(formatType).join(' ')}`}`
      : '';
  return `each step runs state = ${callee.name}(state, i, extras...) where i is the u32 step index, not an element, so these operands need ${wanted}; ${callee.name} is ${actual}${shape}`;
}

function expect(actual: Type, wanted: Type, where: string): void {
  if (!typeEquals(actual, wanted)) {
    throw new A0Error(
      `${where}: expected ${formatType(wanted)}, got ${formatType(actual)}`,
      undefined,
      {
        code: 'type',
        expected: formatType(wanted),
        actual: formatType(actual),
        fix: `replace the operand at ${where} with a value of type ${formatType(wanted)}`,
      },
    );
  }
}

/** Infer the result type of an operation given operand types; throws on mismatch. */
export function resultType(op: Op, argTypes: readonly Type[], where: string): Type {
  const a = argTypes[0];
  const b = argTypes[1];
  const c = argTypes[2];
  if (a === undefined) throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
  switch (op) {
    case 'mov':
      return a;
    case 'and':
    case 'or':
    case 'xor':
      // Bitwise on u32, logical on bool: both operands must share the type.
      if (b === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      if (a === 'bool') {
        expect(b, 'bool', where);
        return 'bool';
      }
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return 'u32';
    case 'add':
    case 'sub':
    case 'mul':
    case 'shl':
    case 'shr':
    case 'div':
    case 'rem':
      if (b === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return 'u32';
    case 'eq':
    case 'ne':
      if (b === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      if (a === 'bool') {
        expect(b, 'bool', where);
        return 'bool';
      }
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return 'bool';
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge':
      if (b === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return 'bool';
    case 'select':
      if (b === undefined || c === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      expect(a, 'bool', where);
      if (!typeEquals(b, c)) {
        throw new A0Error(
          `${where}: select branches differ (${formatType(b)} vs ${formatType(c)})`,
          undefined,
          { code: 'type' },
        );
      }
      if (containsIo(b))
        throw new A0Error(`${where}: select cannot choose between io tokens`, undefined, {
          code: 'type',
        });
      return b;
    case 'arr': {
      for (const [i, t] of argTypes.entries()) expect(t, a, `${where} element ${i}`);
      if (containsIo(a))
        throw new A0Error(`${where}: arrays cannot hold io tokens`, undefined, { code: 'type' });
      const t: Type = { kind: 'arr', length: argTypes.length, elem: a };
      if (bitWidth(t) > LIMITS.maxAggregateBits)
        throw new A0Error(`${where}: aggregate too large`, undefined, { code: 'limit' });
      return t;
    }
    case 'rec': {
      const t: Type = { kind: 'rec', fields: [...argTypes] };
      if (argTypes.filter(containsIo).length > 1)
        throw new A0Error(`${where}: a record holds at most one io token`, undefined, {
          code: 'type',
        });
      if (!containsIo(t) && bitWidth(t) > LIMITS.maxAggregateBits)
        throw new A0Error(`${where}: aggregate too large`, undefined, { code: 'limit' });
      return t;
    }
    case 'read':
      expect(a, 'io', `${where} token`);
      return { kind: 'rec', fields: ['u32', 'io'] };
    case 'write':
      if (b === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      expect(a, 'io', `${where} token`);
      expect(b, 'u32', `${where} value`);
      return 'io';
    case 'puts':
      if (b === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      expect(a, 'io', `${where} token`);
      if (isPrimitive(b) || b.kind !== 'arr' || b.elem !== 'u32') {
        throw new A0Error(`${where}: puts expects a u32 array, got ${formatType(b)}`, undefined, {
          code: 'type',
        });
      }
      return 'io';
    case 'get':
      if (b === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      if (isPrimitive(a) || a.kind !== 'arr')
        throw new A0Error(`${where}: get expects an array, got ${formatType(a)}`, undefined, {
          code: 'type',
          ...(!isPrimitive(a) && a.kind === 'rec'
            ? { fix: 'records use at with a literal field index: `at R K` (get is for arrays)' }
            : {}),
        });
      expect(b, 'u32', `${where} index`);
      return a.elem;
    case 'set':
      if (b === undefined || c === undefined)
        throw new A0Error(`${where}: missing operand`, undefined, { code: 'type' });
      if (isPrimitive(a) || a.kind !== 'arr')
        throw new A0Error(`${where}: set expects an array, got ${formatType(a)}`, undefined, {
          code: 'type',
          ...(!isPrimitive(a) && a.kind === 'rec'
            ? { fix: 'records use put with a literal field index: `put R K V` (set is for arrays)' }
            : {}),
        });
      expect(b, 'u32', `${where} index`);
      expect(c, a.elem, `${where} element`);
      return a;
    case 'at':
    case 'put':
      throw new A0Error(`${where}: ${op} is typed with its literal field index`, undefined, {
        code: 'type',
      });
    case 'call':
    case 'fold':
    case 'loop':
      throw new A0Error(`${where}: ${op} is typed against its callee`, undefined, { code: 'type' });
  }
}

/**
 * Validate one function. `scope` holds the functions defined earlier in the program
 * (the only legal call targets); a function cannot call itself or a later function.
 */
export function validateFunction(
  fn: Func,
  scope: ReadonlyMap<string, TypedFunc> = new Map(),
): TypedFunc {
  if (!isValidFunctionName(fn.name))
    throw new A0Error(`invalid function name '${fn.name}'`, undefined, { code: 'structure' });
  if (fn.params.length > LIMITS.maxParams)
    throw new A0Error(`${fn.name}: too many parameters`, undefined, { code: 'limit' });
  if (fn.nodes.length > LIMITS.maxNodesPerFunction)
    throw new A0Error(`${fn.name}: too many nodes`, undefined, { code: 'limit' });
  const types = new Map<string, Type>();
  const defined = new Set<string>();
  const calls = new Map<string, TypedFunc>();
  const consumed = new Set<string>();
  /** Records whose io-carrying field (the value) was taken out by `at`. */
  const taken = new Map<string, number>();
  let staticIterations = 1;
  let literalIterations = 1;
  if (fn.params.filter(containsIo).length > 1) {
    throw new A0Error(`${fn.name}: at most one parameter may carry an io token`, undefined, {
      code: 'structure',
    });
  }
  for (const node of fn.nodes) {
    const where = `${fn.name}.${node.id}`;
    if (!isValidIdentifier(node.id))
      throw new A0Error(`${where}: invalid identifier`, undefined, { code: 'structure' });
    if (defined.has(node.id))
      throw new A0Error(`${where}: duplicate definition`, undefined, { code: 'structure' });
    const hasCallee = node.op === 'call' || node.op === 'fold' || node.op === 'loop';
    if (hasCallee !== (node.callee !== undefined)) {
      throw new A0Error(`${where}: callee present iff op is call, fold, or loop`, undefined, {
        code: 'structure',
      });
    }
    if ((node.op === 'loop') !== (node.pred !== undefined)) {
      throw new A0Error(`${where}: predicate present iff op is loop`, undefined, {
        code: 'structure',
      });
    }
    if (!hasCallee && OP_ARITY[node.op] >= 0 && node.args.length !== OP_ARITY[node.op]) {
      throw new A0Error(`${where}: wrong arity`, undefined, { code: 'structure' });
    }
    if (OP_ARITY[node.op] < 0 && !hasCallee && node.args.length === 0) {
      throw new A0Error(`${where}: ${node.op} expects at least one operand`, undefined, {
        code: 'structure',
      });
    }
    const argTypes = node.args.map((arg) => operandType(arg, fn, types, defined, where));
    for (const arg of node.args) {
      if (
        arg.kind === 'u32' &&
        (!Number.isInteger(arg.value) || arg.value < 0 || arg.value > U32_MAX)
      ) {
        throw new A0Error(`${where}: literal out of u32 range`, undefined, { code: 'structure' });
      }
    }
    // Linearity: an io-carrying value is consumed at most once. `at` of a field without io
    // only reads; `at` of the io-carrying field takes the token out of the record, which may
    // then only read its other fields or get that field back with `put` (anything else would
    // use the token twice).
    for (const [k, arg] of node.args.entries()) {
      const t = argTypes[k] as Type;
      if (!containsIo(t)) continue;
      const key = arg.kind === 'param' ? `p${arg.index}` : arg.kind === 'node' ? arg.id : '';
      const field = node.args[1]?.kind === 'u32' ? node.args[1].value : -1;
      if (node.op === 'at' && k === 0) {
        const ft = !isPrimitive(t) && t.kind === 'rec' ? t.fields[field] : undefined;
        if (ft === undefined || !containsIo(ft)) continue;
        if (consumed.has(key))
          throw new A0Error(`${where}: io token '${key}' was already consumed`, undefined, {
            code: 'structure',
          });
        if (taken.has(key))
          throw new A0Error(
            `${where}: the io field ${taken.get(key)} of '${key}' was already taken by \`at\``,
            undefined,
            {
              code: 'structure',
              fix: `use the value that \`at\` returned, or put a token back first with \`put ${key} ${taken.get(key)} <io>\``,
            },
          );
        taken.set(key, field);
        continue;
      }
      if (consumed.has(key))
        throw new A0Error(`${where}: io token '${key}' was already consumed`, undefined, {
          code: 'structure',
        });
      const out = taken.get(key);
      if (out !== undefined && !(node.op === 'put' && k === 0 && field === out))
        throw new A0Error(
          `${where}: '${key}' is used after \`at\` took its io field ${out}; its token would be used twice`,
          undefined,
          {
            code: 'structure',
            fix: `read the other fields first, or put the token back with \`put ${key} ${out} <io>\` and use that record`,
          },
        );
      consumed.add(key);
    }
    if (node.op === 'at' || node.op === 'put') {
      const [recT, idx] = argTypes;
      const index = node.args[1];
      if (recT === undefined || isPrimitive(recT) || recT.kind !== 'rec') {
        throw new A0Error(
          `${where}: ${node.op} expects a record, got ${recT === undefined ? 'nothing' : formatType(recT)}`,
          undefined,
          {
            code: 'structure',
            ...(recT !== undefined && !isPrimitive(recT) && recT.kind === 'arr'
              ? {
                  fix: `arrays use ${node.op === 'at' ? 'get: `get A I`' : 'set: `set A I V`'} (${node.op} is for records)`,
                }
              : {}),
          },
        );
      }
      if (index === undefined || index.kind !== 'u32' || idx !== 'u32') {
        throw new A0Error(`${where}: ${node.op} field index must be a u32 literal`, undefined, {
          code: 'structure',
        });
      }
      const field = recT.fields[index.value];
      if (field === undefined)
        throw new A0Error(
          `${where}: field ${index.value} out of range for ${formatType(recT)}`,
          undefined,
          {
            code: 'structure',
          },
        );
      if (node.op === 'put') expect(argTypes[2] as Type, field, `${where} field value`);
      types.set(node.id, node.op === 'at' ? field : recT);
    } else if (node.op === 'call') {
      const callee = scope.get(node.callee ?? '');
      if (callee === undefined) {
        throw new A0Error(
          `${where}: unknown callee '${node.callee ?? ''}' (callees must be defined earlier; recursion is unsupported)`,
          undefined,
          {
            code: 'structure',
            fix: `'${node.callee ?? ''}' is neither an op nor a function defined above ${fn.name}: define it above, or use one of ${OPS.join(' ')}`,
          },
        );
      }
      if (argTypes.length !== callee.params.length) {
        throw new A0Error(
          `${where}: ${callee.name} expects ${callee.params.length} arguments, got ${argTypes.length}`,
          undefined,
          { code: 'structure' },
        );
      }
      for (const [i, t] of callee.params.entries()) {
        expect(argTypes[i] as Type, t, `${where} argument ${i}`);
      }
      calls.set(callee.name, callee);
      types.set(node.id, callee.result);
      staticIterations = Math.max(staticIterations, callee.staticIterations);
      literalIterations = Math.max(literalIterations, callee.literalIterations);
    } else if (node.op === 'fold' || node.op === 'loop') {
      const callee = scope.get(node.callee ?? '');
      if (callee === undefined) {
        throw new A0Error(
          `${where}: unknown ${node.op} body '${node.callee ?? ''}' (must be defined earlier)`,
          undefined,
          { code: 'structure' },
        );
      }
      // fold f n s a...  with f : (T, u32, A...) -> T
      // loop p f n s a... additionally p : (T, u32, A...) -> bool with identical parameters
      const [count, init, ...extra] = argTypes;
      if (count === undefined || init === undefined) {
        throw new A0Error(`${where}: fold expects a trip count and an initial state`, undefined, {
          code: 'structure',
        });
      }
      expect(count, 'u32', `${where} trip count`);
      // Every body mismatch names the step's expected header and the call shape it implies.
      const bodyFix = foldBodyFix(node.op, callee, init, extra);
      const bodyError = (message: string, types?: { expected: Type; actual: Type }): A0Error =>
        new A0Error(`${where}: ${message}`, undefined, {
          code: types === undefined ? 'structure' : 'type',
          ...(types === undefined
            ? {}
            : { expected: formatType(types.expected), actual: formatType(types.actual) }),
          fix: bodyFix,
        });
      const expectBody = (actual: Type, wanted: Type, what: string): void => {
        if (!typeEquals(actual, wanted))
          throw bodyError(`${what}: expected ${formatType(wanted)}, got ${formatType(actual)}`, {
            expected: wanted,
            actual,
          });
      };
      const [stateT, indexT, ...extraT] = callee.params;
      if (stateT === undefined || indexT === undefined)
        throw bodyError(`fold body ${callee.name} needs (state, index, ...) parameters`);
      expectBody(indexT, 'u32', 'body index parameter');
      expectBody(init, stateT, 'initial state');
      expectBody(callee.result, stateT, 'body result');
      if (extra.length !== extraT.length)
        throw bodyError(
          `${callee.name} expects ${extraT.length} extra arguments, got ${extra.length}`,
        );
      for (const [i, t] of extraT.entries()) expectBody(extra[i] as Type, t, `extra argument ${i}`);
      calls.set(callee.name, callee);
      if (node.op === 'loop') {
        const pred = scope.get(node.pred ?? '');
        if (pred === undefined) {
          throw new A0Error(
            `${where}: unknown loop predicate '${node.pred ?? ''}' (must be defined earlier)`,
            undefined,
            { code: 'structure' },
          );
        }
        expect(pred.result, 'bool', `${where} predicate result`);
        if (
          pred.params.length !== callee.params.length ||
          pred.params.some((t, i) => !typeEquals(t, callee.params[i] as Type))
        ) {
          throw new A0Error(
            `${where}: predicate ${pred.name} must take the same parameters as body ${callee.name}`,
            undefined,
            { code: 'structure' },
          );
        }
        calls.set(pred.name, pred);
      }
      const countOp = node.args[0];
      const trips = countOp?.kind === 'u32' ? countOp.value : 2 ** 32;
      staticIterations = Math.max(staticIterations, trips * callee.staticIterations);
      if (countOp?.kind === 'u32') {
        literalIterations = Math.max(literalIterations, trips * callee.literalIterations);
        if (literalIterations > LIMITS.maxStaticIterations) {
          throw new A0Error(
            `${where}: literal iteration count ${literalIterations} exceeds the compute bound ${LIMITS.maxStaticIterations}`,
            undefined,
            { code: 'structure' },
          );
        }
      } else {
        literalIterations = Math.max(literalIterations, callee.literalIterations);
      }
      types.set(node.id, stateT);
    } else {
      types.set(node.id, resultType(node.op, argTypes, where));
    }
    defined.add(node.id);
  }
  const retType = operandType(fn.ret, fn, types, defined, `${fn.name}.ret`);
  expect(retType, fn.result, `${fn.name}.ret`);
  if (containsIo(retType)) {
    const key =
      fn.ret.kind === 'param' ? `p${fn.ret.index}` : fn.ret.kind === 'node' ? fn.ret.id : '';
    if (consumed.has(key))
      throw new A0Error(`${fn.name}.ret: io token '${key}' was already consumed`, undefined, {
        code: 'structure',
      });
    if (taken.has(key))
      throw new A0Error(
        `${fn.name}.ret: '${key}' is returned after \`at\` took its io field ${taken.get(key)}`,
        undefined,
        {
          code: 'structure',
          fix: `return the record with the token put back: \`put ${key} ${taken.get(key)} <io>\``,
        },
      );
  }
  return { ...fn, types, calls, staticIterations, literalIterations };
}

export function validate(program: Program): TypedProgram {
  if (program.functions.length > LIMITS.maxFunctions)
    throw new A0Error('too many functions', undefined, { code: 'limit' });
  const byName = new Map<string, TypedFunc>();
  const functions: TypedFunc[] = [];
  for (const fn of program.functions) {
    if (byName.has(fn.name))
      throw new A0Error(`duplicate function '${fn.name}'`, undefined, { code: 'structure' });
    const typed = validateFunction(fn, byName);
    byName.set(fn.name, typed);
    functions.push(typed);
  }
  return { functions, byName };
}

// ---------------------------------------------------------------------------
// Printing (canonical source form)
// ---------------------------------------------------------------------------

export function formatOperand(operand: Operand): string {
  switch (operand.kind) {
    case 'node':
      return operand.id;
    case 'param':
      return `p${operand.index}`;
    case 'u32':
      return String(operand.value);
    case 'bool':
      return operand.value ? 'true' : 'false';
  }
}

export function formatNode(node: Node): string {
  if (node.op === 'arr' && node.text !== undefined)
    return `${node.id} text ${formatTextLiteral(node.text)}`;
  const pred = node.op === 'loop' ? ` ${node.pred ?? ''}` : '';
  const callee = node.callee !== undefined ? ` ${node.callee}` : '';
  const args = node.args.length > 0 ? ` ${node.args.map(formatOperand).join(' ')}` : '';
  return `${node.id} ${node.op}${pred}${callee}${args}`;
}

export function formatFunction(fn: Func): string {
  const sig = fn.params.length > 0 ? ` ${fn.params.map(formatType).join(' ')}` : '';
  const body = fn.nodes.map(formatNode).join('\n');
  return `fn ${fn.name}${sig} -> ${formatType(fn.result)}\n${body}${body ? '\n' : ''}ret ${formatOperand(fn.ret)}\nend`;
}

export function formatProgram(program: Program): string {
  return `${program.functions.map(formatFunction).join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Reference interpreter
// ---------------------------------------------------------------------------

/** Runtime state behind an io token: an input word stream and an output sink. */
export interface IoState {
  readonly input: readonly number[];
  position: number;
  readonly output: number[];
}

export function makeIo(input: readonly number[] = []): IoState {
  return { input, position: 0, output: [] };
}

/** Append one output word, bounded so a runaway program cannot exhaust memory. */
function emit(state: IoState, word: number): void {
  if (state.output.length >= LIMITS.maxIoOutput) {
    throw new A0Error(`io output exceeds ${LIMITS.maxIoOutput} words`, undefined, {
      code: 'limit',
    });
  }
  state.output.push(word);
}

export function isIoState(v: Value): v is IoState {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'output' in v;
}

export type Value = number | boolean | IoState | readonly Value[];

export function valueEquals(a: Value, b: Value): boolean {
  if (isIoState(a) || isIoState(b)) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => valueEquals(x, b[i] as Value))
    );
  }
  return a === b;
}

export function evalOp(op: Op, args: readonly Value[]): Value {
  const a = args[0];
  const b = args[1];
  const c = args[2];
  const num = (v: Value | undefined): number => {
    if (typeof v !== 'number')
      throw new A0Error(`${op}: expected u32 value`, undefined, { code: 'structure' });
    return v;
  };
  switch (op) {
    case 'mov':
      if (a === undefined)
        throw new A0Error('mov: missing operand', undefined, { code: 'structure' });
      return a;
    case 'add':
      return (num(a) + num(b)) >>> 0;
    case 'sub':
      return (num(a) - num(b)) >>> 0;
    case 'mul':
      return Math.imul(num(a), num(b)) >>> 0;
    case 'and':
      if (typeof a === 'boolean') return a && b === true;
      return (num(a) & num(b)) >>> 0;
    case 'or':
      if (typeof a === 'boolean') return a || b === true;
      return (num(a) | num(b)) >>> 0;
    case 'xor':
      if (typeof a === 'boolean') return a !== (b === true);
      return (num(a) ^ num(b)) >>> 0;
    case 'shl':
      return (num(a) << (num(b) & 31)) >>> 0;
    case 'shr':
      return num(a) >>> (num(b) & 31);
    case 'div':
      // Unsigned division; division by zero yields all ones (total, as on RISC-V).
      return num(b) === 0 ? 0xffff_ffff : Math.floor(num(a) / num(b));
    case 'rem':
      return num(b) === 0 ? num(a) : num(a) % num(b);
    case 'eq':
      if (typeof a === 'boolean') return a === b;
      return num(a) === num(b);
    case 'ne':
      if (typeof a === 'boolean') return a !== b;
      return num(a) !== num(b);
    case 'lt':
      return num(a) < num(b);
    case 'le':
      return num(a) <= num(b);
    case 'gt':
      return num(a) > num(b);
    case 'ge':
      return num(a) >= num(b);
    case 'select':
      if (typeof a !== 'boolean' || b === undefined || c === undefined) {
        throw new A0Error('select: expected bool and two values', undefined, { code: 'structure' });
      }
      return a ? b : c;
    case 'arr':
    case 'rec':
      return [...args];
    case 'get': {
      if (!Array.isArray(a) || a.length === 0)
        throw new A0Error('get: expected array', undefined, { code: 'structure' });
      return a[num(b) % a.length] as Value;
    }
    case 'set': {
      if (!Array.isArray(a) || a.length === 0 || c === undefined)
        throw new A0Error('set: expected array', undefined, { code: 'structure' });
      const copy = [...a];
      copy[num(b) % a.length] = c;
      return copy;
    }
    case 'at': {
      if (!Array.isArray(a))
        throw new A0Error('at: expected record', undefined, { code: 'structure' });
      const v = a[num(b)];
      if (v === undefined)
        throw new A0Error('at: field out of range', undefined, { code: 'structure' });
      return v;
    }
    case 'put': {
      if (!Array.isArray(a) || c === undefined || num(b) >= a.length)
        throw new A0Error('put: bad field', undefined, { code: 'structure' });
      const copy = [...a];
      copy[num(b)] = c;
      return copy;
    }
    case 'read': {
      // Exhausted input reads as 0; the token identity is the state itself.
      if (a === undefined || !isIoState(a))
        throw new A0Error('read: expected io token', undefined, { code: 'structure' });
      const v = a.input[a.position] ?? 0;
      if (a.position < a.input.length) a.position += 1;
      return [v, a];
    }
    case 'write': {
      if (a === undefined || !isIoState(a))
        throw new A0Error('write: expected io token', undefined, { code: 'structure' });
      emit(a, num(b));
      return a;
    }
    case 'puts': {
      // Length word, then every element, in order.
      if (a === undefined || !isIoState(a) || !Array.isArray(b))
        throw new A0Error('puts: expected io token and array', undefined, { code: 'structure' });
      emit(a, b.length);
      for (const v of b) emit(a, num(v));
      return a;
    }
    case 'call':
    case 'fold':
    case 'loop':
      throw new A0Error(`${op} is evaluated by run, not evalOp`, undefined, { code: 'structure' });
  }
}

export function checkArgument(type: Type, value: Value, where: string): void {
  if (type === 'bool') {
    if (typeof value !== 'boolean')
      throw new A0Error(`${where}: expected bool`, undefined, { code: 'structure' });
    return;
  }
  if (type === 'u32') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
      throw new A0Error(`${where}: expected u32`, undefined, { code: 'structure' });
    }
    return;
  }
  if (type === 'io') {
    if (!isIoState(value))
      throw new A0Error(`${where}: expected io token`, undefined, { code: 'structure' });
    return;
  }
  if (!Array.isArray(value))
    throw new A0Error(`${where}: expected ${formatType(type)}`, undefined, { code: 'structure' });
  if (type.kind === 'arr') {
    if (value.length !== type.length)
      throw new A0Error(`${where}: expected ${type.length} elements`, undefined, {
        code: 'structure',
      });
    for (const [i, v] of value.entries()) checkArgument(type.elem, v, `${where}[${i}]`);
    return;
  }
  if (value.length !== type.fields.length)
    throw new A0Error(`${where}: expected ${type.fields.length} fields`, undefined, {
      code: 'structure',
    });
  for (const [i, f] of type.fields.entries()) checkArgument(f, value[i] as Value, `${where}.${i}`);
}

export interface RunOptions {
  /** Remaining node evaluations; shared across nested calls. Exhaustion throws A0Error. */
  fuel: number;
  /**
   * Remaining fold/loop trips over the whole run (the iteration cap); absent means unbounded
   * (fuel still applies). Each trip, counted before its predicate runs, takes one.
   */
  maxTrips?: number;
  /** Internal: the running call chain, kept so a budget stop can name where it happened. */
  frames?: Frame[];
}

interface Frame {
  readonly fn: TypedFunc;
  /** The fold/loop node this frame is iterating, or null. */
  node: string | null;
  trip: number;
}

/** The trap for a budget stop, read off the running call chain. */
function trapOf(kind: TrapKind, options: RunOptions): Trap {
  const frames = options.frames ?? [];
  const top = frames[frames.length - 1];
  let at: string | null = null;
  let trip: number | null = null;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const f = frames[i] as Frame;
    if (f.node !== null) {
      at = `${f.fn.name}.${f.node}`;
      trip = f.trip;
      break;
    }
  }
  return { kind, fn: top?.fn.name ?? '-', at, trip, chain: frames.map((f) => f.fn.name) };
}

/**
 * Evaluate a validated function on concrete arguments with the reference semantics.
 * `options.fuel` bounds total node evaluations (default LIMITS.defaultFuel) so a hostile
 * or runaway program cannot consume unbounded compute in the reference evaluator.
 */
export function run(
  fn: TypedFunc,
  args: readonly Value[],
  options: RunOptions = { fuel: LIMITS.defaultFuel },
): Value {
  if (args.length !== fn.params.length) {
    throw new A0Error(
      `${fn.name}: expected ${fn.params.length} arguments, got ${args.length}`,
      undefined,
      {
        code: 'runtime',
      },
    );
  }
  for (const [index, type] of fn.params.entries()) {
    checkArgument(type, args[index] as Value, `${fn.name} p${index}`);
  }
  options.frames = [];
  return exec(fn, args, options);
}

/** Charge `units` of fuel; exhaustion throws a `limit` A0Error. */
function charge(fn: TypedFunc, options: RunOptions, units: number): void {
  options.fuel -= units;
  if (options.fuel < 0) {
    const trap = trapOf('fuel', options);
    throw new A0Error(`${fn.name}: fuel exhausted (execution budget exceeded)`, undefined, {
      code: 'limit',
      trap,
      fix: TRAP_FIX.fuel,
    });
  }
}

/** Take one trip from the iteration cap, when there is one. */
function takeTrip(fn: TypedFunc, options: RunOptions): void {
  if (options.maxTrips === undefined) return;
  if (options.maxTrips <= 0) {
    const trap = trapOf('iter', options);
    throw new A0Error(`${fn.name}: iteration cap reached`, undefined, {
      code: 'limit',
      trap,
      fix: TRAP_FIX.iter,
    });
  }
  options.maxTrips -= 1;
}

const AGGREGATE_OPS: ReadonlySet<Op> = new Set<Op>(['arr', 'rec', 'set', 'put']);

/**
 * Internal evaluation: arguments come from validator-typed values (the entry check or
 * well-typed nodes), so they are not re-walked. Each entry costs one fuel unit, each node
 * one, and each aggregate-producing node max(1, length) for the copy it makes.
 */
function exec(fn: TypedFunc, args: readonly Value[], options: RunOptions): Value {
  if (options.frames === undefined) options.frames = [];
  const frames = options.frames;
  const frame: Frame = { fn, node: null, trip: 0 };
  frames.push(frame);
  charge(fn, options, 1);
  const env = new Map<string, Value>();
  const read = (operand: Operand): Value => {
    switch (operand.kind) {
      case 'u32':
      case 'bool':
        return operand.value;
      case 'param':
        return args[operand.index] as Value;
      case 'node': {
        const v = env.get(operand.id);
        if (v === undefined)
          throw new A0Error(`${fn.name}: unbound node '${operand.id}'`, undefined, {
            code: 'runtime',
          });
        return v;
      }
    }
  };
  for (const node of fn.nodes) {
    charge(fn, options, 1);
    if (node.op === 'call') {
      const callee = fn.calls.get(node.callee ?? '');
      if (callee === undefined)
        throw new A0Error(`${fn.name}: unresolved callee '${node.callee ?? ''}'`, undefined, {
          code: 'runtime',
        });
      env.set(node.id, exec(callee, node.args.map(read), options));
    } else if (node.op === 'fold') {
      const body = fn.calls.get(node.callee ?? '');
      if (body === undefined)
        throw new A0Error(`${fn.name}: unresolved fold body '${node.callee ?? ''}'`, undefined, {
          code: 'runtime',
        });
      const [count, init, ...extra] = node.args.map(read);
      let state = init as Value;
      const n = count as number;
      frame.node = node.id;
      for (let i = 0; i < n; i += 1) {
        frame.trip = i;
        charge(fn, options, 1);
        takeTrip(fn, options);
        state = exec(body, [state, i, ...extra], options);
      }
      frame.node = null;
      env.set(node.id, state);
    } else if (node.op === 'loop') {
      const body = fn.calls.get(node.callee ?? '');
      const pred = fn.calls.get(node.pred ?? '');
      if (body === undefined || pred === undefined)
        throw new A0Error(`${fn.name}: unresolved loop functions`, undefined, { code: 'runtime' });
      const [count, init, ...extra] = node.args.map(read);
      let state = init as Value;
      const n = count as number;
      frame.node = node.id;
      for (let i = 0; i < n; i += 1) {
        frame.trip = i;
        charge(fn, options, 1);
        takeTrip(fn, options);
        if (exec(pred, [state, i, ...extra], options) !== true) break;
        state = exec(body, [state, i, ...extra], options);
      }
      frame.node = null;
      env.set(node.id, state);
    } else {
      const operands = node.args.map(read);
      if (AGGREGATE_OPS.has(node.op)) {
        const source = node.op === 'set' || node.op === 'put' ? operands[0] : operands;
        charge(fn, options, Math.max(1, Array.isArray(source) ? source.length : 1));
      }
      env.set(
        node.id,
        node.op === 'write' || node.op === 'puts'
          ? ioOp(node, operands, options)
          : evalOp(node.op, operands),
      );
    }
  }
  frames.pop();
  return read(fn.ret);
}

/** An io-writing op; the output cap stops it with the same trap line as the other budgets. */
function ioOp(node: Node, operands: readonly Value[], options: RunOptions): Value {
  try {
    return evalOp(node.op, operands);
  } catch (e) {
    if (e instanceof A0Error && e.code === 'limit' && e.trap === undefined)
      throw new A0Error(e.message, undefined, {
        code: 'limit',
        trap: trapOf('io', options),
        fix: TRAP_FIX.io,
      });
    throw e;
  }
}

export function parseAndValidate(source: string): TypedProgram {
  return validate(parse(source));
}
