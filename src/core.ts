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
  | 'lt'
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
  'lt',
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
  lt: 2,
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
  /** Resolved callees (each defined earlier in the same program). */
  readonly calls: ReadonlyMap<string, TypedFunc>;
}

export interface TypedProgram {
  readonly functions: readonly TypedFunc[];
  readonly byName: ReadonlyMap<string, TypedFunc>;
}

export class A0Error extends Error {
  override readonly name = 'A0Error';
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Limits (hostile-input bounds)
// ---------------------------------------------------------------------------

export const LIMITS = {
  maxSourceBytes: 1 << 20,
  maxFunctions: 1024,
  maxNodesPerFunction: 4096,
  maxParams: 64,
  maxIdentifierLength: 64,
  maxArrayLength: 1024,
  maxAggregateBits: 1 << 16,
  /** Product of literal trip counts along any nesting path a validator will accept (compute bound). */
  maxStaticIterations: 1 << 24,
  /** Default interpreter fuel: node evaluations before `run` aborts with A0Error. */
  defaultFuel: 100_000_000,
} as const;

const IDENT = /^[a-z][a-z0-9_]{0,63}$/;
const PARAM = /^p(0|[1-9][0-9]*)$/;
const U32_LITERAL = /^(0|[1-9][0-9]*)$/;
const RESERVED = new Set(['fn', 'ret', 'end', 'patch', 'true', 'false']);
const U32_MAX = 0xffff_ffff;

export function isValidIdentifier(id: string): boolean {
  return IDENT.test(id) && !RESERVED.has(id) && !PARAM.test(id);
}

export function isValidFunctionName(name: string): boolean {
  return IDENT.test(name) && !RESERVED.has(name);
}

export function parseType(text: string, line?: number): Type {
  let pos = 0;
  const fail = (msg: string): never => {
    throw new A0Error(`type '${text}': ${msg}`, line);
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
    if (value > U32_MAX) throw new A0Error(`literal ${text} exceeds u32`, line);
    return { kind: 'u32', value };
  }
  if (isValidIdentifier(text)) return { kind: 'node', id: text };
  throw new A0Error(`invalid operand '${text}'`, line);
}

function isOp(text: string): text is Op {
  return (OPS as readonly string[]).includes(text);
}

/** Parse one instruction line `id op operand...` (no validation of references). */
export function parseNode(lineText: string, line?: number): Node {
  const textMatch = TEXT_LINE.exec(lineText.trim());
  if (textMatch !== null) {
    // `id text "..."` desugars to `arr` of UTF-8 byte words; the source form is retained.
    const [, id, raw] = textMatch;
    if (id === undefined || !isValidIdentifier(id)) {
      throw new A0Error(`invalid node identifier '${id ?? ''}'`, line);
    }
    const text = decodeText(raw ?? '', line);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length === 0) throw new A0Error('text literal must not be empty', line);
    if (bytes.length > LIMITS.maxArrayLength) {
      throw new A0Error(`text literal exceeds ${LIMITS.maxArrayLength} bytes`, line);
    }
    return { id, op: 'arr', args: [...bytes].map((value) => ({ kind: 'u32', value })), text };
  }
  const parts = lineText.trim().split(/\s+/);
  const [id, op, ...rest] = parts;
  if (id === undefined || op === undefined) throw new A0Error('expected `id op operands`', line);
  if (!isValidIdentifier(id)) throw new A0Error(`invalid node identifier '${id}'`, line);
  if (!isOp(op)) throw new A0Error(`unknown operation '${op}'`, line);
  if (op === 'loop') {
    const [pred, callee, ...args] = rest;
    if (
      pred === undefined ||
      !isValidFunctionName(pred) ||
      callee === undefined ||
      !isValidFunctionName(callee)
    ) {
      throw new A0Error('loop expects a predicate and a body function name', line);
    }
    return { id, op, pred, callee, args: args.map((r) => parseOperand(r, line)) };
  }
  if (op === 'call' || op === 'fold') {
    const [callee, ...args] = rest;
    if (callee === undefined || !isValidFunctionName(callee)) {
      throw new A0Error(`${op} expects a function name, got '${callee ?? ''}'`, line);
    }
    return { id, op, callee, args: args.map((r) => parseOperand(r, line)) };
  }
  if (OP_ARITY[op] >= 0 && rest.length !== OP_ARITY[op]) {
    throw new A0Error(`${op} expects ${OP_ARITY[op]} operands, got ${rest.length}`, line);
  }
  if (OP_ARITY[op] < 0 && rest.length === 0)
    throw new A0Error(`${op} expects at least one operand`, line);
  return { id, op, args: rest.map((r) => parseOperand(r, line)) };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse A0 source text. Comments (`#` to end of line) and blank lines are
 * discarded; there is no separate intent store in v0.1.
 */
export function parse(source: string): Program {
  if (Buffer.byteLength(source, 'utf8') > LIMITS.maxSourceBytes) {
    throw new A0Error(`source exceeds ${LIMITS.maxSourceBytes} bytes`);
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

  for (let cur = next(); cur !== undefined; cur = next()) {
    const head = cur.text.split(/\s+/);
    if (head[0] !== 'fn') throw new A0Error(`expected 'fn', got '${head[0]}'`, cur.line);
    const name = head[1];
    if (name === undefined || !isValidFunctionName(name)) {
      throw new A0Error(`invalid function name '${name ?? ''}'`, cur.line);
    }
    if (names.has(name)) throw new A0Error(`duplicate function '${name}'`, cur.line);
    const arrow = head.indexOf('->');
    if (arrow < 2 || arrow !== head.length - 2) {
      throw new A0Error("expected 'fn name types... -> type'", cur.line);
    }
    const params = head.slice(2, arrow).map((t) => parseType(t, cur.line));
    if (params.length > LIMITS.maxParams) throw new A0Error('too many parameters', cur.line);
    const result = parseType(head[arrow + 1] ?? '', cur.line);

    const nodes: Node[] = [];
    let ret: Operand | undefined;
    let closed = false;
    for (let body = next(); body !== undefined; body = next()) {
      const first = body.text.split(/\s+/)[0];
      if (first === 'ret') {
        const parts = body.text.split(/\s+/);
        if (parts.length !== 2) throw new A0Error('ret expects one operand', body.line);
        ret = parseOperand(parts[1] ?? '', body.line);
        const endLine = next();
        if (endLine === undefined || endLine.text !== 'end') {
          throw new A0Error("expected 'end' after ret", endLine?.line ?? body.line);
        }
        closed = true;
        break;
      }
      if (first === 'end' || first === 'fn') {
        throw new A0Error(`unexpected '${first}' before ret`, body.line);
      }
      if (nodes.length >= LIMITS.maxNodesPerFunction) {
        throw new A0Error('too many nodes in function', body.line);
      }
      nodes.push(parseNode(body.text, body.line));
    }
    if (!closed || ret === undefined) throw new A0Error(`function '${name}' not terminated`);
    if (functions.length >= LIMITS.maxFunctions) throw new A0Error('too many functions');
    names.add(name);
    functions.push({ name, params, result, nodes, ret });
  }
  return { functions };
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
      if (t === undefined) throw new A0Error(`${where}: parameter p${operand.index} out of range`);
      return t;
    }
    case 'node': {
      if (!defined.has(operand.id)) {
        throw new A0Error(`${where}: reference to undefined or later node '${operand.id}'`);
      }
      const t = types.get(operand.id);
      if (t === undefined) throw new A0Error(`${where}: untyped node '${operand.id}'`);
      return t;
    }
  }
}

function expect(actual: Type, wanted: Type, where: string): void {
  if (!typeEquals(actual, wanted)) {
    throw new A0Error(`${where}: expected ${formatType(wanted)}, got ${formatType(actual)}`);
  }
}

/** Infer the result type of an operation given operand types; throws on mismatch. */
export function resultType(op: Op, argTypes: readonly Type[], where: string): Type {
  const a = argTypes[0];
  const b = argTypes[1];
  const c = argTypes[2];
  if (a === undefined) throw new A0Error(`${where}: missing operand`);
  switch (op) {
    case 'mov':
      return a;
    case 'add':
    case 'sub':
    case 'mul':
    case 'and':
    case 'or':
    case 'xor':
    case 'shl':
    case 'shr':
    case 'div':
    case 'rem':
      if (b === undefined) throw new A0Error(`${where}: missing operand`);
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return 'u32';
    case 'eq':
    case 'lt':
      if (b === undefined) throw new A0Error(`${where}: missing operand`);
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return 'bool';
    case 'select':
      if (b === undefined || c === undefined) throw new A0Error(`${where}: missing operand`);
      expect(a, 'bool', where);
      if (!typeEquals(b, c)) {
        throw new A0Error(
          `${where}: select branches differ (${formatType(b)} vs ${formatType(c)})`,
        );
      }
      if (containsIo(b)) throw new A0Error(`${where}: select cannot choose between io tokens`);
      return b;
    case 'arr': {
      for (const [i, t] of argTypes.entries()) expect(t, a, `${where} element ${i}`);
      if (containsIo(a)) throw new A0Error(`${where}: arrays cannot hold io tokens`);
      const t: Type = { kind: 'arr', length: argTypes.length, elem: a };
      if (bitWidth(t) > LIMITS.maxAggregateBits) throw new A0Error(`${where}: aggregate too large`);
      return t;
    }
    case 'rec': {
      const t: Type = { kind: 'rec', fields: [...argTypes] };
      if (argTypes.filter(containsIo).length > 1)
        throw new A0Error(`${where}: a record holds at most one io token`);
      if (!containsIo(t) && bitWidth(t) > LIMITS.maxAggregateBits)
        throw new A0Error(`${where}: aggregate too large`);
      return t;
    }
    case 'read':
      expect(a, 'io', `${where} token`);
      return { kind: 'rec', fields: ['u32', 'io'] };
    case 'write':
      if (b === undefined) throw new A0Error(`${where}: missing operand`);
      expect(a, 'io', `${where} token`);
      expect(b, 'u32', `${where} value`);
      return 'io';
    case 'puts':
      if (b === undefined) throw new A0Error(`${where}: missing operand`);
      expect(a, 'io', `${where} token`);
      if (isPrimitive(b) || b.kind !== 'arr' || b.elem !== 'u32') {
        throw new A0Error(`${where}: puts expects a u32 array, got ${formatType(b)}`);
      }
      return 'io';
    case 'get':
      if (b === undefined) throw new A0Error(`${where}: missing operand`);
      if (isPrimitive(a) || a.kind !== 'arr')
        throw new A0Error(`${where}: get expects an array, got ${formatType(a)}`);
      expect(b, 'u32', `${where} index`);
      return a.elem;
    case 'set':
      if (b === undefined || c === undefined) throw new A0Error(`${where}: missing operand`);
      if (isPrimitive(a) || a.kind !== 'arr')
        throw new A0Error(`${where}: set expects an array, got ${formatType(a)}`);
      expect(b, 'u32', `${where} index`);
      expect(c, a.elem, `${where} element`);
      return a;
    case 'at':
    case 'put':
      throw new A0Error(`${where}: ${op} is typed with its literal field index`);
    case 'call':
    case 'fold':
    case 'loop':
      throw new A0Error(`${where}: ${op} is typed against its callee`);
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
  if (!isValidFunctionName(fn.name)) throw new A0Error(`invalid function name '${fn.name}'`);
  if (fn.params.length > LIMITS.maxParams) throw new A0Error(`${fn.name}: too many parameters`);
  if (fn.nodes.length > LIMITS.maxNodesPerFunction) throw new A0Error(`${fn.name}: too many nodes`);
  const types = new Map<string, Type>();
  const defined = new Set<string>();
  const calls = new Map<string, TypedFunc>();
  const consumed = new Set<string>();
  let staticIterations = 1;
  let literalIterations = 1;
  if (fn.params.filter(containsIo).length > 1) {
    throw new A0Error(`${fn.name}: at most one parameter may carry an io token`);
  }
  for (const node of fn.nodes) {
    const where = `${fn.name}.${node.id}`;
    if (!isValidIdentifier(node.id)) throw new A0Error(`${where}: invalid identifier`);
    if (defined.has(node.id)) throw new A0Error(`${where}: duplicate definition`);
    const hasCallee = node.op === 'call' || node.op === 'fold' || node.op === 'loop';
    if (hasCallee !== (node.callee !== undefined)) {
      throw new A0Error(`${where}: callee present iff op is call, fold, or loop`);
    }
    if ((node.op === 'loop') !== (node.pred !== undefined)) {
      throw new A0Error(`${where}: predicate present iff op is loop`);
    }
    if (!hasCallee && OP_ARITY[node.op] >= 0 && node.args.length !== OP_ARITY[node.op]) {
      throw new A0Error(`${where}: wrong arity`);
    }
    if (OP_ARITY[node.op] < 0 && !hasCallee && node.args.length === 0) {
      throw new A0Error(`${where}: ${node.op} expects at least one operand`);
    }
    const argTypes = node.args.map((arg) => operandType(arg, fn, types, defined, where));
    for (const arg of node.args) {
      if (
        arg.kind === 'u32' &&
        (!Number.isInteger(arg.value) || arg.value < 0 || arg.value > U32_MAX)
      ) {
        throw new A0Error(`${where}: literal out of u32 range`);
      }
    }
    // Linearity: an io-carrying value is consumed at most once; `at` reads do not consume.
    for (const [k, arg] of node.args.entries()) {
      const t = argTypes[k] as Type;
      if (!containsIo(t)) continue;
      if (node.op === 'at' && k === 0) continue;
      const key = arg.kind === 'param' ? `p${arg.index}` : arg.kind === 'node' ? arg.id : '';
      if (consumed.has(key)) throw new A0Error(`${where}: io token '${key}' was already consumed`);
      consumed.add(key);
    }
    if (node.op === 'at' || node.op === 'put') {
      const [recT, idx] = argTypes;
      const index = node.args[1];
      if (recT === undefined || isPrimitive(recT) || recT.kind !== 'rec') {
        throw new A0Error(
          `${where}: ${node.op} expects a record, got ${recT === undefined ? 'nothing' : formatType(recT)}`,
        );
      }
      if (index === undefined || index.kind !== 'u32' || idx !== 'u32') {
        throw new A0Error(`${where}: ${node.op} field index must be a u32 literal`);
      }
      const field = recT.fields[index.value];
      if (field === undefined)
        throw new A0Error(`${where}: field ${index.value} out of range for ${formatType(recT)}`);
      if (node.op === 'put') expect(argTypes[2] as Type, field, `${where} field value`);
      types.set(node.id, node.op === 'at' ? field : recT);
    } else if (node.op === 'call') {
      const callee = scope.get(node.callee ?? '');
      if (callee === undefined) {
        throw new A0Error(
          `${where}: unknown callee '${node.callee ?? ''}' (callees must be defined earlier; recursion is unsupported)`,
        );
      }
      if (argTypes.length !== callee.params.length) {
        throw new A0Error(
          `${where}: ${callee.name} expects ${callee.params.length} arguments, got ${argTypes.length}`,
        );
      }
      for (const [i, t] of callee.params.entries()) {
        expect(argTypes[i] as Type, t, `${where} argument ${i}`);
      }
      calls.set(callee.name, callee);
      types.set(node.id, callee.result);
      staticIterations = Math.max(staticIterations, callee.staticIterations);
      literalIterations = Math.max(literalIterations, callee.staticIterations);
    } else if (node.op === 'fold' || node.op === 'loop') {
      const callee = scope.get(node.callee ?? '');
      if (callee === undefined) {
        throw new A0Error(
          `${where}: unknown ${node.op} body '${node.callee ?? ''}' (must be defined earlier)`,
        );
      }
      // fold f n s a...  with f : (T, u32, A...) -> T
      // loop p f n s a... additionally p : (T, u32, A...) -> bool with identical parameters
      const [count, init, ...extra] = argTypes;
      if (count === undefined || init === undefined) {
        throw new A0Error(`${where}: fold expects a trip count and an initial state`);
      }
      expect(count, 'u32', `${where} trip count`);
      const [stateT, indexT, ...extraT] = callee.params;
      if (stateT === undefined || indexT === undefined) {
        throw new A0Error(
          `${where}: fold body ${callee.name} needs (state, index, ...) parameters`,
        );
      }
      expect(indexT, 'u32', `${where} body index parameter`);
      expect(init, stateT, `${where} initial state`);
      expect(callee.result, stateT, `${where} body result`);
      if (extra.length !== extraT.length) {
        throw new A0Error(
          `${where}: ${callee.name} expects ${extraT.length} extra arguments, got ${extra.length}`,
        );
      }
      for (const [i, t] of extraT.entries())
        expect(extra[i] as Type, t, `${where} extra argument ${i}`);
      calls.set(callee.name, callee);
      if (node.op === 'loop') {
        const pred = scope.get(node.pred ?? '');
        if (pred === undefined) {
          throw new A0Error(
            `${where}: unknown loop predicate '${node.pred ?? ''}' (must be defined earlier)`,
          );
        }
        expect(pred.result, 'bool', `${where} predicate result`);
        if (
          pred.params.length !== callee.params.length ||
          pred.params.some((t, i) => t !== callee.params[i])
        ) {
          throw new A0Error(
            `${where}: predicate ${pred.name} must take the same parameters as body ${callee.name}`,
          );
        }
        calls.set(pred.name, pred);
      }
      const countOp = node.args[0];
      const trips = countOp?.kind === 'u32' ? countOp.value : 2 ** 32;
      staticIterations = Math.max(staticIterations, trips * callee.staticIterations);
      if (countOp?.kind === 'u32') {
        literalIterations = Math.max(literalIterations, trips * callee.staticIterations);
        if (literalIterations > LIMITS.maxStaticIterations) {
          throw new A0Error(
            `${where}: literal iteration count ${literalIterations} exceeds the compute bound ${LIMITS.maxStaticIterations}`,
          );
        }
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
      throw new A0Error(`${fn.name}.ret: io token '${key}' was already consumed`);
  }
  return { ...fn, types, calls, staticIterations };
}

export function validate(program: Program): TypedProgram {
  if (program.functions.length > LIMITS.maxFunctions) throw new A0Error('too many functions');
  const byName = new Map<string, TypedFunc>();
  const functions: TypedFunc[] = [];
  for (const fn of program.functions) {
    if (byName.has(fn.name)) throw new A0Error(`duplicate function '${fn.name}'`);
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
    if (typeof v !== 'number') throw new A0Error(`${op}: expected u32 value`);
    return v;
  };
  switch (op) {
    case 'mov':
      if (a === undefined) throw new A0Error('mov: missing operand');
      return a;
    case 'add':
      return (num(a) + num(b)) >>> 0;
    case 'sub':
      return (num(a) - num(b)) >>> 0;
    case 'mul':
      return Math.imul(num(a), num(b)) >>> 0;
    case 'and':
      return (num(a) & num(b)) >>> 0;
    case 'or':
      return (num(a) | num(b)) >>> 0;
    case 'xor':
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
      return num(a) === num(b);
    case 'lt':
      return num(a) < num(b);
    case 'select':
      if (typeof a !== 'boolean' || b === undefined || c === undefined) {
        throw new A0Error('select: expected bool and two values');
      }
      return a ? b : c;
    case 'arr':
    case 'rec':
      return [...args];
    case 'get': {
      if (!Array.isArray(a) || a.length === 0) throw new A0Error('get: expected array');
      return a[num(b) % a.length] as Value;
    }
    case 'set': {
      if (!Array.isArray(a) || a.length === 0 || c === undefined)
        throw new A0Error('set: expected array');
      const copy = [...a];
      copy[num(b) % a.length] = c;
      return copy;
    }
    case 'at': {
      if (!Array.isArray(a)) throw new A0Error('at: expected record');
      const v = a[num(b)];
      if (v === undefined) throw new A0Error('at: field out of range');
      return v;
    }
    case 'put': {
      if (!Array.isArray(a) || c === undefined || num(b) >= a.length)
        throw new A0Error('put: bad field');
      const copy = [...a];
      copy[num(b)] = c;
      return copy;
    }
    case 'read': {
      // Exhausted input reads as 0; the token identity is the state itself.
      if (a === undefined || !isIoState(a)) throw new A0Error('read: expected io token');
      const v = a.input[a.position] ?? 0;
      if (a.position < a.input.length) a.position += 1;
      return [v, a];
    }
    case 'write': {
      if (a === undefined || !isIoState(a)) throw new A0Error('write: expected io token');
      a.output.push(num(b));
      return a;
    }
    case 'puts': {
      // Length word, then every element, in order.
      if (a === undefined || !isIoState(a) || !Array.isArray(b))
        throw new A0Error('puts: expected io token and array');
      a.output.push(b.length);
      for (const v of b) a.output.push(num(v));
      return a;
    }
    case 'call':
    case 'fold':
    case 'loop':
      throw new A0Error(`${op} is evaluated by run, not evalOp`);
  }
}

export function checkArgument(type: Type, value: Value, where: string): void {
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new A0Error(`${where}: expected bool`);
    return;
  }
  if (type === 'u32') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
      throw new A0Error(`${where}: expected u32`);
    }
    return;
  }
  if (type === 'io') {
    if (!isIoState(value)) throw new A0Error(`${where}: expected io token`);
    return;
  }
  if (!Array.isArray(value)) throw new A0Error(`${where}: expected ${formatType(type)}`);
  if (type.kind === 'arr') {
    if (value.length !== type.length)
      throw new A0Error(`${where}: expected ${type.length} elements`);
    for (const [i, v] of value.entries()) checkArgument(type.elem, v, `${where}[${i}]`);
    return;
  }
  if (value.length !== type.fields.length)
    throw new A0Error(`${where}: expected ${type.fields.length} fields`);
  for (const [i, f] of type.fields.entries()) checkArgument(f, value[i] as Value, `${where}.${i}`);
}

export interface RunOptions {
  /** Remaining node evaluations; shared across nested calls. Exhaustion throws A0Error. */
  fuel: number;
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
    throw new A0Error(`${fn.name}: expected ${fn.params.length} arguments, got ${args.length}`);
  }
  for (const [index, type] of fn.params.entries()) {
    checkArgument(type, args[index] as Value, `${fn.name} p${index}`);
  }
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
        if (v === undefined) throw new A0Error(`${fn.name}: unbound node '${operand.id}'`);
        return v;
      }
    }
  };
  for (const node of fn.nodes) {
    options.fuel -= 1;
    if (options.fuel < 0)
      throw new A0Error(`${fn.name}: fuel exhausted (execution budget exceeded)`);
    if (node.op === 'call') {
      const callee = fn.calls.get(node.callee ?? '');
      if (callee === undefined)
        throw new A0Error(`${fn.name}: unresolved callee '${node.callee ?? ''}'`);
      env.set(node.id, run(callee, node.args.map(read), options));
    } else if (node.op === 'fold') {
      const body = fn.calls.get(node.callee ?? '');
      if (body === undefined)
        throw new A0Error(`${fn.name}: unresolved fold body '${node.callee ?? ''}'`);
      const [count, init, ...extra] = node.args.map(read);
      let state = init as Value;
      const n = count as number;
      for (let i = 0; i < n; i += 1) state = run(body, [state, i, ...extra], options);
      env.set(node.id, state);
    } else if (node.op === 'loop') {
      const body = fn.calls.get(node.callee ?? '');
      const pred = fn.calls.get(node.pred ?? '');
      if (body === undefined || pred === undefined)
        throw new A0Error(`${fn.name}: unresolved loop functions`);
      const [count, init, ...extra] = node.args.map(read);
      let state = init as Value;
      const n = count as number;
      for (let i = 0; i < n; i += 1) {
        if (run(pred, [state, i, ...extra], options) !== true) break;
        state = run(body, [state, i, ...extra], options);
      }
      env.set(node.id, state);
    } else {
      env.set(node.id, evalOp(node.op, node.args.map(read)));
    }
  }
  return read(fn.ret);
}

export function parseAndValidate(source: string): TypedProgram {
  return validate(parse(source));
}
