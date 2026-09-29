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

export type Type = 'u32' | 'bool';

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
  | 'loop';

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

function parseType(text: string, line: number): Type {
  if (text === 'u32' || text === 'bool') return text;
  throw new A0Error(`unknown type '${text}'`, line);
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
  if (rest.length !== OP_ARITY[op]) {
    throw new A0Error(`${op} expects ${OP_ARITY[op]} operands, got ${rest.length}`, line);
  }
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
      const text = raw.replace(/#.*$/, '').trim();
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
  if (actual !== wanted) throw new A0Error(`${where}: expected ${wanted}, got ${actual}`);
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
      if (b !== c) throw new A0Error(`${where}: select branches differ (${b} vs ${c})`);
      return b;
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
    if (!hasCallee && node.args.length !== OP_ARITY[node.op]) {
      throw new A0Error(`${where}: wrong arity`);
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
    if (node.op === 'call') {
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
      types.set(node.id, stateT);
    } else {
      types.set(node.id, resultType(node.op, argTypes, where));
    }
    defined.add(node.id);
  }
  const retType = operandType(fn.ret, fn, types, defined, `${fn.name}.ret`);
  expect(retType, fn.result, `${fn.name}.ret`);
  return { ...fn, types, calls };
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
  const pred = node.op === 'loop' ? ` ${node.pred ?? ''}` : '';
  const callee = node.callee !== undefined ? ` ${node.callee}` : '';
  const args = node.args.length > 0 ? ` ${node.args.map(formatOperand).join(' ')}` : '';
  return `${node.id} ${node.op}${pred}${callee}${args}`;
}

export function formatFunction(fn: Func): string {
  const sig = fn.params.length > 0 ? ` ${fn.params.join(' ')}` : '';
  const body = fn.nodes.map(formatNode).join('\n');
  return `fn ${fn.name}${sig} -> ${fn.result}\n${body}${body ? '\n' : ''}ret ${formatOperand(fn.ret)}\nend`;
}

export function formatProgram(program: Program): string {
  return `${program.functions.map(formatFunction).join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Reference interpreter
// ---------------------------------------------------------------------------

export type Value = number | boolean;

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
    case 'eq':
      return num(a) === num(b);
    case 'lt':
      return num(a) < num(b);
    case 'select':
      if (typeof a !== 'boolean' || b === undefined || c === undefined) {
        throw new A0Error('select: expected bool and two values');
      }
      return a ? b : c;
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new A0Error(`${where}: expected u32`);
  }
}

/** Evaluate a validated function on concrete arguments with the reference semantics. */
export function run(fn: TypedFunc, args: readonly Value[]): Value {
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
    if (node.op === 'call') {
      const callee = fn.calls.get(node.callee ?? '');
      if (callee === undefined)
        throw new A0Error(`${fn.name}: unresolved callee '${node.callee ?? ''}'`);
      env.set(node.id, run(callee, node.args.map(read)));
    } else if (node.op === 'fold') {
      const body = fn.calls.get(node.callee ?? '');
      if (body === undefined)
        throw new A0Error(`${fn.name}: unresolved fold body '${node.callee ?? ''}'`);
      const [count, init, ...extra] = node.args.map(read);
      let state = init as Value;
      const n = count as number;
      for (let i = 0; i < n; i += 1) state = run(body, [state, i, ...extra]);
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
        if (run(pred, [state, i, ...extra]) !== true) break;
        state = run(body, [state, i, ...extra]);
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
