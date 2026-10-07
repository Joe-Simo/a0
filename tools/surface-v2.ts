/**
 * Surface v2: a prototype of a token-lean canonical spelling that keeps the A0 program model
 * (the same `Program`, node order and ids; nothing here is wired into the compiler). RESEARCH
 * CODE: see docs/design/surface-v2.md. It is a converter pair, like src/dense.ts:
 *
 *   formatV2(program)      the v2 text of a program, losslessly: parseV2(formatV2(p)) has the
 *                          canonical form of p (ids, node order, types, spec lines)
 *   canonicalOfV2(text)    the canonical text a v2 text means (then `parse` gives the Program)
 *   normalizeV2(program)   the same behavior with nodes ordered and named for the v2 text (what a
 *                          model writing v2 writes; the analogue of dense's `normalizeProgram`)
 *
 * The v2 rules (every one inverted by the parser, each chosen for a measured token saving AND for
 * regularity, see the design note):
 *   - one function per header line `fn name(A,B,C)`; parameters are the capital letters A, B, C, ...
 *     (ids are lowercase, so a parameter can never be mistaken for a node; `A:u32x8` types a
 *     non-u32 parameter, `-> T` a non-u32 result; no `ret`, no `end`: the last line is the result);
 *   - an operation is written as a call `op(x,y)` (every operation, same shape, explicit arity) or,
 *     for the 16 binary operators, infix `x+y` with NO precedence: any nested operator expression is
 *     parenthesised, except a left chain of one operator (`a+b+c` is `(a+b)+c`); mixed operators
 *     without parentheses are a parse error, never a silent regrouping;
 *   - a value used once is nested into its consumer; a value used twice or more, or one whose id is
 *     not the default name of its position, is a statement `id=expression`; nested values take the
 *     default names a, b, c, ... (skipping explicit names) in creation order;
 *   - `[x;N]` is N equal elements, `"..."` a text array; fold/loop/call name their helper function as
 *     the first argument, helpers stay separate functions (no lambdas).
 */

import {
  ALL_OPS,
  type Func,
  formatProgram,
  formatTextLiteral,
  formatType,
  type Node,
  type Operand,
  type Program,
  parse,
  parseType,
  type Type,
  type TypedFunc,
  validateFunction,
} from '../src/core.js';
import { defaultNames } from '../src/dense.js';
import { A0Error } from '../src/diagnostics.js';
import { specLinesWithComments } from '../src/spec.js';

// ---------------------------------------------------------------------------
// Spelling table
// ---------------------------------------------------------------------------

/** Binary operators with an infix spelling. */
export const INFIX: Readonly<Record<string, string>> = {
  add: '+',
  sub: '-',
  mul: '*',
  div: '/',
  rem: '%',
  and: '&',
  or: '|',
  xor: '^',
  shl: '<<',
  shr: '>>',
  eq: '==',
  ne: '!=',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
};
const INFIX_OP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(INFIX).map(([op, sym]) => [sym, op]),
);
/** Operators whose left chain `a+b+c` needs no parentheses (the same operator, left nested). */
const CHAIN = new Set(['add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr']);

export interface V2Style {
  /** `a+b+c` for a left chain of one operator (off: `(a+b)+c`). */
  readonly chain?: boolean;
  /** `[x;N]` for N equal atom elements (off: every element). */
  readonly repeat?: boolean;
  /** A function that is one expression goes on its header line: `fn f(A)=A+1`. */
  readonly join?: boolean;
  /** Spaces around binary operators and after commas. */
  readonly spaced?: boolean;
  /** Finer spacing switches (measurement only): spaces around binary operators, after commas, around `=`. */
  readonly gapOps?: boolean;
  readonly gapComma?: boolean;
  readonly gapBind?: boolean;
  /** Parameters `A`, `B`, ... (off: `p0`, `p1`, ...). */
  readonly letters?: boolean;
  /** Infix operators (off: `add(a,b)` for every operation). */
  readonly infix?: boolean;
  /** Nest a value used once (off: one operation per statement). */
  readonly nest?: boolean;
  /** A function's last line is its result (off: `ret x` and `end`). */
  readonly implicitRet?: boolean;
  /** The header leaves out the result type: the checker infers it (see inferResults). */
  readonly inferResult?: boolean;
}
const STYLE: Required<V2Style> = {
  chain: true,
  repeat: true,
  join: false,
  spaced: false,
  gapOps: false,
  gapComma: false,
  gapBind: false,
  letters: true,
  infix: true,
  nest: true,
  implicitRet: true,
  inferResult: false,
};

/** `A`..`Z`, then `A1`.. for the 27th parameter on (a function has at most 64). */
export function paramName(i: number, letters = true): string {
  if (!letters) return `p${i}`;
  if (i < 26) return String.fromCharCode(65 + i);
  return `${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`;
}

// ---------------------------------------------------------------------------
// Normal form: nodes in the order a v2 text creates them, default names
// ---------------------------------------------------------------------------

/**
 * The function with its nodes ordered as a v2 text creates them (a depth-first walk from the result,
 * operands left to right, values used more than once where first needed) and named a, b, c, ... in
 * that order. Behavior is unchanged; an unused node is dropped (a valid program has none).
 */
export function normalizeFunction(fn: Func): Func {
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const names = defaultNames(new Set());
  const newId = new Map<string, string>();
  const out: Node[] = [];
  const visit = (o: Operand): Operand => {
    if (o.kind !== 'node') return o;
    const seen = newId.get(o.id);
    if (seen !== undefined) return { kind: 'node', id: seen };
    const n = byId.get(o.id) as Node;
    const args = n.args.map(visit);
    const id = names.next().value as string;
    newId.set(o.id, id);
    const { comments: _c, ...rest } = n;
    out.push({ ...rest, id, args });
    return { kind: 'node', id };
  };
  const ret = visit(fn.ret);
  const { comments: _a, retComments: _b, endComments: _d, afterComments: _e, ...base } = fn;
  return { ...base, nodes: out, ret };
}

export function normalizeV2(program: Program): Program {
  return { ...program, functions: program.functions.map(normalizeFunction) };
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

interface Tree {
  /** id of the node, when it is a binding; undefined for a nested value */
  readonly node: Node;
  readonly args: readonly Arg[];
}
type Arg =
  | { readonly k: 'atom'; readonly text: string }
  | { readonly k: 'tree'; readonly tree: Tree };

/** Which single-use nodes can be nested without changing node order or ids (fixpoint). */
function nestable(fn: Func, enabled: boolean): Set<string> {
  const uses = new Map<string, number>();
  const bump = (o: Operand): void => {
    if (o.kind === 'node') uses.set(o.id, (uses.get(o.id) ?? 0) + 1);
  };
  for (const n of fn.nodes) n.args.forEach(bump);
  bump(fn.ret);
  const inl = new Set<string>();
  if (!enabled) return inl;
  for (const n of fn.nodes) if (uses.get(n.id) === 1) inl.add(n.id);
  for (;;) {
    const drop = new Set<string>();
    const explicit = new Set(fn.nodes.filter((n) => !inl.has(n.id)).map((n) => n.id));
    const gen = defaultNames(explicit);
    const stack: string[] = [];
    const popOperands = (args: readonly Operand[]): void => {
      for (let k = args.length - 1; k >= 0; k -= 1) {
        const a = args[k] as Operand;
        if (a.kind !== 'node' || !inl.has(a.id)) continue;
        if (stack[stack.length - 1] === a.id) stack.pop();
        else drop.add(a.id);
      }
    };
    for (const n of fn.nodes) {
      popOperands(n.args);
      if (inl.has(n.id)) {
        // the name the parser will give this nested value
        if (n.id !== (gen.next().value as string)) drop.add(n.id);
        stack.push(n.id);
      } else {
        for (const s of stack) drop.add(s);
        stack.length = 0;
      }
    }
    popOperands([fn.ret]);
    for (const s of stack) drop.add(s);
    if (drop.size === 0) return inl;
    for (const d of drop) inl.delete(d);
  }
}

function atomText(o: Operand, style: Required<V2Style>): string {
  switch (o.kind) {
    case 'param':
      return paramName(o.index, style.letters);
    case 'u32':
      return String(o.value);
    case 'bool':
      return o.value ? 'true' : 'false';
    case 'node':
      return o.id;
  }
}

function formatFn(fn: Func, style: Required<V2Style>): string {
  const inl = nestable(fn, style.nest);
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const comma = style.spaced || style.gapComma ? ', ' : ',';

  const operandText = (o: Operand): string => {
    if (o.kind === 'node' && inl.has(o.id)) return nodeText(byId.get(o.id) as Node, true);
    return atomText(o, style);
  };
  /** nested: written as an operand of an infix operator */
  const nodeText = (n: Node, nested: boolean): string => {
    if (n.op === 'arr' && n.text !== undefined) {
      return formatTextLiteral(n.text);
    }
    if (n.op === 'arr') {
      const first = n.args[0];
      if (
        style.repeat &&
        n.args.length > 1 &&
        first !== undefined &&
        n.args.every(
          (a) => a.kind === first.kind && atomText(a, style) === atomText(first, style),
        ) &&
        !(first.kind === 'node' && inl.has(first.id))
      ) {
        return `[${atomText(first, style)};${n.args.length}]`;
      }
      return `[${n.args.map(operandText).join(comma)}]`;
    }
    const sym = style.infix ? INFIX[n.op] : undefined;
    if (sym !== undefined && n.args.length === 2) {
      const [l, r] = n.args as [Operand, Operand];
      const lNode = l.kind === 'node' && inl.has(l.id) ? (byId.get(l.id) as Node) : undefined;
      let lt: string;
      if (lNode !== undefined && style.chain && lNode.op === n.op && CHAIN.has(n.op)) {
        // a left chain of one operator: the child is written unparenthesised
        lt = nodeBare(lNode);
      } else lt = operandText(l);
      const rt = operandText(r);
      const gap = style.spaced || style.gapOps ? ` ${sym} ` : sym;
      const text = `${lt}${gap}${rt}`;
      return nested ? `(${text})` : text;
    }
    const args = n.args.map((a) =>
      a.kind === 'node' && inl.has(a.id) ? nodeTop(byId.get(a.id) as Node) : atomText(a, style),
    );
    if (n.op === 'call') return `${n.callee}(${args.join(comma)})`;
    if (n.op === 'loop') return `loop(${[n.pred, n.callee, ...args].join(comma)})`;
    if (n.op === 'fold') return `fold(${[n.callee, ...args].join(comma)})`;
    return `${n.op}(${args.join(comma)})`;
  };
  /** an argument position: no parentheses needed around an infix expression */
  const nodeTop = (n: Node): string => nodeText(n, false);
  /** a chain member: same as top but a chain within it keeps flowing */
  const nodeBare = (n: Node): string => nodeText(n, false);

  const header = (() => {
    const ps = fn.params.map((t, i) => {
      const name = paramName(i, style.letters);
      return t === 'u32' ? name : `${name}:${formatType(t)}`;
    });
    const res = style.inferResult || fn.result === 'u32' ? '' : ` -> ${formatType(fn.result)}`;
    return `fn ${fn.name}(${ps.join(comma)})${res}`;
  })();

  const lines: string[] = [];
  for (const [, line] of specLinesWithComments(fn.spec)) lines.push(line);
  for (const n of fn.nodes) {
    if (inl.has(n.id)) continue;
    lines.push(`${n.id}${style.spaced || style.gapBind ? ' = ' : '='}${nodeText(n, false)}`);
  }
  const result =
    fn.ret.kind === 'node' && inl.has(fn.ret.id)
      ? nodeText(byId.get(fn.ret.id) as Node, false)
      : atomText(fn.ret, style);
  if (!style.implicitRet) {
    return [header, ...lines, `ret ${result}`, 'end'].join('\n');
  }
  if (style.join && lines.length === 0)
    return `${header}${style.spaced || style.gapBind ? ' = ' : '='}${result}`;
  return [header, ...lines, result].join('\n');
}

export function formatV2(program: Program, style: V2Style = {}): string {
  const s: Required<V2Style> = { ...STYLE, ...style };
  const head: string[] = [];
  if (program.profile === 'strict') head.push('profile strict');
  for (const u of program.uses ?? []) head.push(`use "${u}"`);
  const fns = program.functions.map((f) => formatFn(f, s));
  const parts = [head.join('\n'), fns.join('\n\n')].filter((p) => p !== '');
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Parser (to canonical text)
// ---------------------------------------------------------------------------

class V2Error extends Error {}
const fail = (msg: string, line?: number): never => {
  throw new V2Error(line === undefined ? msg : `line ${line}: ${msg}`);
};

type Tok = { k: 'num' | 'id' | 'str' | 'sym'; t: string };

function lex(text: string, line: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === ' ' || c === '\t') {
      i += 1;
      continue;
    }
    const rest = text.slice(i);
    const rules: readonly [Tok['k'], RegExp][] = [
      ['num', /^[0-9]+/],
      ['id', /^[A-Za-z_][A-Za-z0-9_]*/],
      ['str', /^"(?:[^"\\]|\\.)*"/],
      ['sym', /^(<<|>>|<=|>=|==|!=|->|[()[\],;+\-*/%&|^<>=:])/],
    ];
    let hit: Tok | undefined;
    for (const [k, re] of rules) {
      const m = re.exec(rest);
      if (m !== null) {
        hit = { k, t: m[0] };
        break;
      }
    }
    if (hit === undefined) return fail(`unexpected character '${c}'`, line);
    out.push(hit);
    i += hit.t.length;
  }
  return out;
}

type Ast =
  | { k: 'atom'; t: string }
  | { k: 'str'; t: string }
  | { k: 'call'; name: string; args: Ast[] }
  | { k: 'bin'; op: string; l: Ast; r: Ast }
  | { k: 'arr'; items: Ast[]; rep?: number };

class ExprParser {
  pos = 0;
  constructor(
    readonly toks: Tok[],
    readonly line: number,
  ) {}
  peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  eat(t?: string): Tok {
    const x = this.toks[this.pos];
    if (x === undefined || (t !== undefined && x.t !== t))
      fail(`expected '${t ?? 'more'}'`, this.line);
    this.pos += 1;
    return x as Tok;
  }
  done(): boolean {
    return this.pos >= this.toks.length;
  }
  /** `unit (op unit)*` where every operator is the same left chain (or there is one) */
  top(): Ast {
    let left = this.unit();
    let first: string | undefined;
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.k !== 'sym' || INFIX_OP[t.t] === undefined) return left;
      const op = INFIX_OP[t.t] as string;
      if (first === undefined) first = t.t;
      else if (first !== t.t)
        return fail(
          `'${first}' and '${t.t}' in one expression: parenthesise one of them (there is no operator precedence)`,
          this.line,
        );
      else if (!CHAIN.has(op))
        return fail(`'${t.t}' does not chain: write (a${t.t}b)${t.t}c`, this.line);
      this.pos += 1;
      left = { k: 'bin', op, l: left, r: this.unit() };
    }
  }
  unit(): Ast {
    const t = this.eat();
    if (t.k === 'num') return { k: 'atom', t: t.t };
    if (t.k === 'str') return { k: 'str', t: t.t };
    if (t.t === '(') {
      const e = this.top();
      this.eat(')');
      return e;
    }
    if (t.t === '[') {
      const items: Ast[] = [];
      if (this.peek()?.t !== ']') {
        items.push(this.top());
        if (this.peek()?.t === ';') {
          this.eat(';');
          const n = this.eat();
          this.eat(']');
          if (n.k !== 'num') fail('expected a repeat count', this.line);
          return { k: 'arr', items, rep: Number(n.t) };
        }
        while (this.peek()?.t === ',') {
          this.eat(',');
          items.push(this.top());
        }
      }
      this.eat(']');
      return { k: 'arr', items };
    }
    if (t.k === 'id') {
      if (this.peek()?.t === '(') {
        this.eat('(');
        const args: Ast[] = [];
        if (this.peek()?.t !== ')') {
          args.push(this.top());
          while (this.peek()?.t === ',') {
            this.eat(',');
            args.push(this.top());
          }
        }
        this.eat(')');
        return { k: 'call', name: t.t, args };
      }
      return { k: 'atom', t: t.t };
    }
    return fail(`unexpected '${t.t}'`, this.line);
  }
}

/** The canonical text a v2 text means. */
export function canonicalOfV2(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  const OPS = new Set<string>(ALL_OPS);
  while (i < lines.length) {
    const raw = (lines[i] as string).trim();
    i += 1;
    if (raw === '') continue;
    if (raw === 'profile strict' || /^use\s+"/.test(raw)) {
      out.push(raw);
      continue;
    }
    if (!raw.startsWith('fn ')) fail(`expected a function, got '${raw}'`, i);
    // header
    const open = raw.indexOf('(');
    const name = raw.slice(3, open).trim();
    let depth = 0;
    let close = -1;
    for (let k = open; k < raw.length; k += 1) {
      if (raw[k] === '(') depth += 1;
      else if (raw[k] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (open < 0 || close < 0) fail('malformed header', i);
    const inner = raw.slice(open + 1, close);
    const params: string[] = [];
    {
      let d = 0;
      let cur = '';
      for (const ch of inner) {
        if (ch === '(') d += 1;
        if (ch === ')') d -= 1;
        if (ch === ',' && d === 0) {
          params.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      if (cur.trim() !== '') params.push(cur.trim());
    }
    // Parameter names are the writer's (x, y or A, B): the canonical text names them A, B, C by
    // position, and the formatter rewrites a header that says otherwise.
    const pnames = new Map<string, number>();
    const types: Type[] = params.map((p, k) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?::(.+))?$/.exec(p);
      if (m === null) return fail(`bad parameter '${p}'`, i);
      if (pnames.has(m[1] as string)) fail(`parameter '${m[1]}' is named twice`, i);
      pnames.set(m[1] as string, k);
      return m[2] === undefined ? 'u32' : parseType(m[2]);
    });
    let tail = raw.slice(close + 1).trim();
    let result: Type = 'u32';
    const arrow = /^->\s*([^=\s]+)\s*(.*)$/.exec(tail);
    if (arrow !== null) {
      result = parseType(arrow[1] as string);
      tail = (arrow[2] as string).trim();
    }
    let joined: string | undefined;
    if (tail.startsWith('=')) joined = tail.slice(1).trim();
    else if (tail !== '') fail(`unexpected '${tail}' after the header`, i);
    // body lines: until a blank line, EOF, or the next `fn`
    const body: { text: string; line: number }[] = [];
    if (joined !== undefined) body.push({ text: joined, line: i });
    else
      while (i < lines.length) {
        const b = (lines[i] as string).trim();
        if (b === '' || b.startsWith('fn ')) break;
        body.push({ text: b, line: i + 1 });
        i += 1;
      }
    // spec lines first (canonical text, verbatim)
    const spec: string[] = [];
    while (
      body.length > 0 &&
      /^(ex|pre|post)\s/.test((body[0] as { text: string }).text) &&
      !/^[a-z][a-z0-9_]*\s*=(?!=)/.test((body[0] as { text: string }).text)
    )
      spec.push((body.shift() as { text: string }).text);
    if (body.length === 0) fail(`function '${name}' has no result line`, i);
    // explicit names
    const explicit = new Set<string>();
    for (const b of body.slice(0, -1)) {
      const m = /^([a-z][a-z0-9_]*)\s*=(?!=)/.exec(b.text);
      if (m === null) fail(`a statement is 'name=expression': '${b.text}'`, b.line);
      const bound = (m as RegExpExecArray)[1] as string;
      if (pnames.has(bound))
        fail(`'${bound}' is a parameter: name the value something else`, b.line);
      explicit.add(bound);
    }
    const gen = defaultNames(explicit);
    const nodes: string[] = [];
    const known = new Set<string>(explicit);
    const emit = (a: Ast, id: string | undefined, line: number): string => {
      const operand = (x: Ast): string => emit(x, undefined, line);
      const mk = (op: string, rest: string[]): string => {
        const nid = id ?? (gen.next().value as string);
        nodes.push(`${nid} ${op}${rest.length > 0 ? ` ${rest.join(' ')}` : ''}`);
        return nid;
      };
      switch (a.k) {
        case 'atom': {
          if (id !== undefined) fail(`'${id}=${a.t}' is not an operation: write mov(${a.t})`, line);
          if (/^[0-9]+$/.test(a.t) || a.t === 'true' || a.t === 'false') return a.t;
          const pi = pnames.get(a.t);
          if (pi !== undefined) return `p${pi}`;
          if (!known.has(a.t) && !/^[a-z]/.test(a.t)) fail(`unknown name '${a.t}'`, line);
          return a.t;
        }
        case 'str': {
          const nid = id ?? (gen.next().value as string);
          nodes.push(`${nid} text ${a.t}`);
          return nid;
        }
        case 'arr': {
          if (a.rep !== undefined) {
            const x = operand(a.items[0] as Ast);
            return mk('arr', new Array<string>(a.rep).fill(x));
          }
          return mk('arr', a.items.map(operand));
        }
        case 'bin': {
          const l = operand(a.l);
          const r = operand(a.r);
          return mk(a.op, [l, r]);
        }
        case 'call': {
          if (a.name === 'fold' || a.name === 'call') {
            const callee = (a.args[0] as Ast & { k: 'atom' }).t;
            return mk('fold' === a.name ? 'fold' : 'call', [
              callee,
              ...a.args.slice(1).map(operand),
            ]);
          }
          if (a.name === 'loop') {
            const pred = (a.args[0] as Ast & { k: 'atom' }).t;
            const callee = (a.args[1] as Ast & { k: 'atom' }).t;
            return mk('loop', [pred, callee, ...a.args.slice(2).map(operand)]);
          }
          if (OPS.has(a.name)) return mk(a.name, a.args.map(operand));
          return mk('call', [a.name, ...a.args.map(operand)]);
        }
      }
    };
    for (const b of body.slice(0, -1)) {
      const m = /^([a-z][a-z0-9_]*)\s*=(?!=)\s*(.*)$/.exec(b.text) as RegExpExecArray;
      const p = new ExprParser(lex(m[2] as string, b.line), b.line);
      const ast = p.top();
      if (!p.done()) fail(`unexpected '${p.peek()?.t}'`, b.line);
      emit(ast, m[1] as string, b.line);
    }
    const last = body[body.length - 1] as { text: string; line: number };
    const p = new ExprParser(lex(last.text, last.line), last.line);
    const ast = p.top();
    if (!p.done()) fail(`unexpected '${p.peek()?.t}'`, last.line);
    const retOp = emit(ast, undefined, last.line);
    out.push(
      `fn ${name}${types.length > 0 ? ` ${types.map(formatType).join(' ')}` : ''} -> ${formatType(result)}`,
    );
    out.push(...spec, ...nodes, `ret ${retOp}`, 'end', '');
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Result-type inference (an option: the header leaves out `-> T`)
// ---------------------------------------------------------------------------

/**
 * Fill in the result type of every function of a canonical text whose header said `-> u32` as a
 * placeholder: the checker already knows the type of the value `ret` returns (A0201 carries it).
 */
export function inferResults(
  canonical: string,
  known: ReadonlyMap<string, TypedFunc> = new Map(),
): string {
  const program = parse(canonical);
  const scope = new Map<string, TypedFunc>(known);
  const functions: Func[] = [];
  for (const f of program.functions) {
    let fn = f;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        scope.set(fn.name, validateFunction(fn, scope));
        break;
      } catch (e) {
        if (e instanceof A0Error && e.id === 'A0201' && e.actual !== undefined)
          fn = { ...fn, result: parseType(e.actual) };
        else break;
      }
    }
    functions.push(fn);
  }
  return formatProgram({ ...program, functions });
}
