/**
 * Candidate unified A0 source frontend, developed from the Surface v2 study.
 * parseSource constructs the shared Program directly; formatSource preserves its
 * node order, identifiers, types, imports, contracts, profiles and source comments.
 * The legacy compiler entry points remain active until the migration and native
 * frontend cutover are verified. Research style ablations reuse this print engine
 * through tools/surface-v2.ts; they are not compiler source modes.
 */

import {
  ALL_OPS,
  type Comments,
  type Func,
  formatTextLiteral,
  formatType,
  isSpaceCode,
  isValidFunctionName,
  isValidIdentifier,
  LIMITS,
  lineComment,
  type Node,
  OP_ARITY,
  type Op,
  type Operand,
  type Program,
  parseOperand,
  parseType,
  stripComment,
  type Type,
  textNode,
  utf8Length,
  withComments,
} from '../src/core.js';
import { A0Error, diag } from '../src/diagnostics.js';
import { defaultNames } from '../src/names.js';
import { SpecBuilder, specLinesWithComments, specWordOf } from '../src/spec.js';

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
function nestable(fn: Func, enabled: boolean, comments = false): Set<string> {
  const uses = new Map<string, number>();
  const bump = (o: Operand): void => {
    if (o.kind === 'node') uses.set(o.id, (uses.get(o.id) ?? 0) + 1);
  };
  for (const n of fn.nodes) n.args.forEach(bump);
  bump(fn.ret);
  const inl = new Set<string>();
  if (!enabled) return inl;
  for (const n of fn.nodes)
    if (uses.get(n.id) === 1 && (!comments || n.comments === undefined)) inl.add(n.id);
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

function formatFn(fn: Func, style: Required<V2Style>, comments = false): string {
  const inl = nestable(fn, style.nest, comments);
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const comma = style.spaced || style.gapComma ? ', ' : ',';

  const printed = new Map<string, { top: string; operand: string }>();
  const operandText = (o: Operand): string => {
    if (o.kind === 'node' && inl.has(o.id))
      return (printed.get(o.id) as { operand: string }).operand;
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
    if (n.op === 'call')
      return ALL_OPS.includes(n.callee as Op)
        ? `call(${[n.callee, ...args].join(comma)})`
        : `${n.callee}(${args.join(comma)})`;
    if (n.op === 'loop') return `loop(${[n.pred, n.callee, ...args].join(comma)})`;
    if (n.op === 'fold') return `fold(${[n.callee, ...args].join(comma)})`;
    return `${n.op}(${args.join(comma)})`;
  };
  /** an argument position: no parentheses needed around an infix expression */
  const nodeTop = (n: Node): string => (printed.get(n.id) as { top: string }).top;
  /** a chain member: same as top but a chain within it keeps flowing */
  const nodeBare = nodeTop;
  for (const n of fn.nodes) {
    const top = nodeText(n, false);
    printed.set(n.id, {
      top,
      operand: style.infix && INFIX[n.op] !== undefined && n.args.length === 2 ? `(${top})` : top,
    });
  }

  const header = (() => {
    const ps = fn.params.map((t, i) => {
      const name = paramName(i, style.letters);
      return t === 'u32' ? name : `${name}:${formatType(t)}`;
    });
    const res = style.inferResult || fn.result === 'u32' ? '' : ` -> ${formatType(fn.result)}`;
    return `fn ${fn.name}(${ps.join(comma)})${res}`;
  })();

  const lines: string[] = [];
  for (const [c, line] of specLinesWithComments(fn.spec))
    lines.push(comments ? withComments(line, c) : line);
  for (const n of fn.nodes) {
    if (inl.has(n.id)) continue;
    const line = `${n.id}${style.spaced || style.gapBind ? ' = ' : '='}${nodeText(n, false)}`;
    lines.push(comments ? withComments(line, n.comments) : line);
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
  return [
    comments ? withComments(header, fn.comments) : header,
    ...lines,
    comments ? withComments(result, fn.retComments) : result,
    ...(comments && fn.endComments !== undefined ? [withComments('end', fn.endComments)] : []),
    ...(comments && fn.afterComments !== undefined ? ['', ...fn.afterComments] : []),
  ].join('\n');
}

function printSource(program: Program, style: V2Style, comments: boolean): string {
  const s: Required<V2Style> = { ...STYLE, ...style };
  const head: string[] = [];
  if (program.profile === 'strict')
    head.push(
      comments ? withComments('profile strict', program.profileComments) : 'profile strict',
    );
  for (const [k, u] of (program.uses ?? []).entries())
    head.push(comments ? withComments(`use "${u}"`, program.useComments?.[k]) : `use "${u}"`);
  const fns = program.functions.map((f) => formatFn(f, s, comments));
  const parts = [
    head.join('\n'),
    fns.join('\n\n'),
    comments ? (program.tailComments ?? []).join('\n') : '',
  ].filter((p) => p !== '');
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

// ---------------------------------------------------------------------------
// Source parser (direct IR construction)
// ---------------------------------------------------------------------------

function fail(msg: string, line?: number): never {
  throw new A0Error(msg, line, { code: 'parse' });
}

type Tok = { k: 'num' | 'id' | 'str' | 'sym'; t: string };

function lex(text: string, line: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (isSpaceCode(c.charCodeAt(0))) {
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
  done(): boolean {
    return this.pos === this.toks.length;
  }
  /** Explicit frames keep the language's node limit independent of the JS call stack. */
  top(): Ast {
    type Frame = {
      kind: 'root' | 'group' | 'call' | 'arr';
      name?: string;
      args: Ast[];
      left?: Ast;
      operator?: string;
      chain?: string;
    };
    const frames: Frame[] = [{ kind: 'root', args: [] }];
    const give = (frame: Frame, value: Ast): void => {
      if (frame.operator !== undefined) {
        frame.left = {
          k: 'bin',
          op: INFIX_OP[frame.operator] as string,
          l: frame.left as Ast,
          r: value,
        };
        delete frame.operator;
      } else if (frame.left === undefined) frame.left = value;
      else fail('expected an operator or delimiter', this.line);
    };
    while (this.pos < this.toks.length) {
      const f = frames[frames.length - 1] as Frame;
      const t = this.toks[this.pos] as Tok;
      if (f.left !== undefined && f.operator === undefined && INFIX_OP[t.t] !== undefined) {
        if (f.chain !== undefined && f.chain !== t.t)
          fail(
            `'${f.chain}' and '${t.t}' in one expression: parenthesise one of them (there is no operator precedence)`,
            this.line,
          );
        if (f.chain !== undefined && !CHAIN.has(INFIX_OP[t.t] as string))
          fail(`'${t.t}' does not chain: write (a${t.t}b)${t.t}c`, this.line);
        f.chain = t.t;
        f.operator = t.t;
        this.pos++;
        continue;
      }
      if (t.t === ')' || t.t === ']') {
        const wanted = f.kind === 'arr' ? ']' : ')';
        if (f.kind === 'root' || t.t !== wanted || f.operator !== undefined)
          fail(`unexpected '${t.t}'`, this.line);
        if (f.left === undefined && (f.kind === 'group' || f.args.length))
          fail('expected an expression', this.line);
        if (f.left !== undefined) f.args.push(f.left);
        let value: Ast;
        if (f.kind === 'group') value = f.args[0] as Ast;
        else if (f.kind === 'arr') value = { k: 'arr', items: f.args };
        else value = { k: 'call', name: f.name as string, args: f.args };
        frames.pop();
        this.pos++;
        give(frames[frames.length - 1] as Frame, value);
        continue;
      }
      if (t.t === ',') {
        if (
          (f.kind !== 'call' && f.kind !== 'arr') ||
          f.left === undefined ||
          f.operator !== undefined
        )
          fail("unexpected ','", this.line);
        f.args.push(f.left);
        delete f.left;
        delete f.chain;
        this.pos++;
        continue;
      }
      if (t.t === ';') {
        const count = this.toks[this.pos + 1],
          close = this.toks[this.pos + 2];
        if (
          f.kind !== 'arr' ||
          f.args.length ||
          f.left === undefined ||
          f.operator !== undefined ||
          count?.k !== 'num' ||
          close?.t !== ']'
        )
          fail('expected [expression;count]', this.line);
        const value: Ast = { k: 'arr', items: [f.left as Ast], rep: Number((count as Tok).t) };
        frames.pop();
        this.pos += 3;
        give(frames[frames.length - 1] as Frame, value);
        continue;
      }
      if (f.left !== undefined && f.operator === undefined) fail(`unexpected '${t.t}'`, this.line);
      if (t.t === '(' || t.t === '[') {
        frames.push({ kind: t.t === '(' ? 'group' : 'arr', args: [] });
        this.pos++;
        continue;
      }
      if (t.k === 'id' && this.toks[this.pos + 1]?.t === '(') {
        frames.push({ kind: 'call', name: t.t, args: [] });
        this.pos += 2;
        continue;
      }
      if (t.k === 'id' || t.k === 'num') give(f, { k: 'atom', t: t.t });
      else if (t.k === 'str') give(f, { k: 'str', t: t.t });
      else fail(`unexpected '${t.t}'`, this.line);
      this.pos++;
    }
    const root = frames[0] as Frame;
    if (frames.length !== 1 || root.left === undefined || root.operator !== undefined)
      fail('expected an expression or closing delimiter', this.line);
    return root.left as Ast;
  }
}

interface SourceItem {
  readonly text: string;
  readonly line: number;
  readonly comments?: Comments;
}

/** Parse the candidate source grammar directly into the shared, backend-independent IR. */
export interface ParsedSource {
  readonly program: Program;
  readonly locate: (fn: string, node?: string) => number | undefined;
}

export function parseSource(source: string): Program {
  return parseSourceUnit(source).program;
}

/** Parse once, retaining physical origins for linked validation diagnostics. */
export function parseSourceUnit(source: string): ParsedSource {
  const origins = new Map<string, { line: number; nodes: Map<string, number> }>();
  if (source.length * 3 > LIMITS.maxSourceBytes && utf8Length(source) > LIMITS.maxSourceBytes)
    throw diag('A0016', [LIMITS.maxSourceBytes]);
  const items: SourceItem[] = [];
  let pending: string[] = [];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const text = stripComment(raw).trim();
    const comment = lineComment(raw);
    if (text === '') {
      if (comment !== undefined) pending.push(comment);
      continue;
    }
    const comments =
      pending.length || comment !== undefined
        ? {
            ...(pending.length ? { leading: pending } : {}),
            ...(comment === undefined ? {} : { trailing: comment }),
          }
        : undefined;
    items.push({ text, line: index + 1, ...(comments === undefined ? {} : { comments }) });
    pending = [];
  }
  const functions: Func[] = [];
  const names = new Set<string>();
  const uses: string[] = [];
  const useComments: (Comments | undefined)[] = [];
  let profile: 'strict' | undefined;
  let profileComments: Comments | undefined;
  let i = 0;
  while (i < items.length) {
    const item = items[i++] as SourceItem;
    const raw = item.text;
    if (/^profile(?:\s|$)/.test(raw)) {
      if (i !== 1 || raw !== 'profile strict') throw diag('A0031', [], { line: item.line });
      profile = 'strict';
      profileComments = item.comments;
      continue;
    }
    if (/^use(?:\s|$)/.test(raw)) {
      const m = /^use\s+"([^"\\]+)"$/.exec(raw);
      if (m === null || functions.length) throw diag('A0017', [], { line: item.line });
      uses.push(m[1] as string);
      useComments.push(item.comments);
      continue;
    }
    if (!raw.startsWith('fn ')) fail(`expected a function, got '${raw}'`, item.line);
    const open = raw.indexOf('(');
    const name = raw.slice(3, open).trim();
    if (open < 0 || !isValidFunctionName(name)) throw diag('A0019', [name], { line: item.line });
    if (names.has(name)) throw diag('A0020', [name], { line: item.line });
    if (functions.length >= LIMITS.maxFunctions) throw diag('A0029');
    let depth = 0,
      close = -1;
    for (let k = open; k < raw.length; k++) {
      if (raw[k] === '(') depth++;
      else if (raw[k] === ')' && --depth === 0) {
        close = k;
        break;
      }
    }
    if (close < 0) fail('malformed header', item.line);
    const inner = raw.slice(open + 1, close);
    const params: string[] = [];
    let d = 0,
      cur = '';
    for (const ch of inner) {
      if (ch === '(') d++;
      if (ch === ')') d--;
      if (ch === ',' && d === 0) {
        params.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim() !== '') params.push(cur.trim());
    else if (params.length) fail('expected a parameter after comma', item.line);
    if (params.length > LIMITS.maxParams) throw diag('A0024', [], { line: item.line });
    const pnames = new Map<string, number>();
    const types = params.map((p, index): Type => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::(.+))?$/.exec(p);
      if (match === null) return fail(`bad parameter '${p}'`, item.line);
      const pname = match[1] as string;
      if (pname === 'true' || pname === 'false' || pname.length > LIMITS.maxIdentifierLength)
        fail(`invalid parameter '${pname}'`, item.line);
      if (pnames.has(pname)) fail(`parameter '${pname}' is named twice`, item.line);
      pnames.set(pname, index);
      return match[2] === undefined ? 'u32' : parseType(match[2], item.line);
    });
    let tail = raw.slice(close + 1).trim();
    let result: Type = 'u32';
    if (tail.startsWith('->')) {
      const arrow = /^->\s*([^=\s]+)\s*(.*)$/.exec(tail);
      if (arrow === null) fail('expected a result type', item.line);
      result = parseType((arrow as RegExpExecArray)[1] as string, item.line);
      tail = ((arrow as RegExpExecArray)[2] as string).trim();
    }
    const body: SourceItem[] = [];
    if (tail.startsWith('=')) body.push({ text: tail.slice(1).trim(), line: item.line });
    else if (tail !== '') fail(`unexpected '${tail}' after the header`, item.line);
    let endComments: Comments | undefined;
    while (i < items.length && !(items[i] as SourceItem).text.startsWith('fn ')) {
      const next = items[i++] as SourceItem;
      if (next.text === 'end') {
        endComments = next.comments;
        break;
      }
      body.push(next);
    }
    const spec = new SpecBuilder(name);
    while (body.length) {
      const first = body[0] as SourceItem;
      const word = specWordOf(first.text);
      if (word === undefined) break;
      spec.add(word, first.text.slice(word.length).trim(), first.line, first.comments);
      body.shift();
    }
    if (!body.length) fail(`function '${name}' has no result line`, item.line);
    const explicit = new Set<string>();
    for (const b of body.slice(0, -1)) {
      const m = /^([a-z][a-z0-9_]*)\s*=(?!=)/.exec(b.text);
      if (m === null) fail(`a statement is 'name=expression': '${b.text}'`, b.line);
      const id = (m as RegExpExecArray)[1] as string;
      if (!isValidIdentifier(id) || pnames.has(id)) fail(`invalid binding '${id}'`, b.line);
      if (explicit.has(id)) fail(`binding '${id}' is named twice`, b.line);
      explicit.add(id);
    }
    const gen = defaultNames(explicit);
    const nodes: Node[] = [];
    const nodeLines = new Map<string, number>();
    const ops = new Set<string>(ALL_OPS);
    const emit = (root: Ast, id: string | undefined, line: number): Operand => {
      const values = new Map<Ast, Operand>();
      type Frame = {
        ast: Ast;
        id?: string;
        children?: Ast[];
        op?: Op;
        callee?: string;
        pred?: string;
      };
      const stack: Frame[] = [{ ast: root, ...(id === undefined ? {} : { id }) }];
      while (stack.length) {
        const f = stack[stack.length - 1] as Frame,
          a = f.ast;
        if (a.k === 'atom') {
          if (f.id !== undefined)
            fail(`'${f.id}=${a.t}' is not an operation: write mov(${a.t})`, line);
          const pi = pnames.get(a.t);
          values.set(a, pi === undefined ? parseOperand(a.t, line) : { kind: 'param', index: pi });
          stack.pop();
          continue;
        }
        if (f.children === undefined) {
          let children: Ast[];
          if (a.k === 'str') {
            children = [];
            f.op = 'arr';
          } else if (a.k === 'arr') {
            if (
              a.rep !== undefined &&
              (!Number.isSafeInteger(a.rep) || a.rep < 1 || a.rep > LIMITS.maxArrayLength)
            )
              fail(`array repeat count must be 1..${LIMITS.maxArrayLength}`, line);
            children = a.items;
            f.op = 'arr';
          } else if (a.k === 'bin') {
            children = [a.l, a.r];
            f.op = a.op as Op;
          } else {
            const symbols = a.name === 'loop' ? 2 : a.name === 'fold' || a.name === 'call' ? 1 : 0;
            const symbol = (index: number): string => {
              const value = a.args[index];
              if (value?.k !== 'atom' || !isValidFunctionName(value.t))
                return fail(`expected a function name in ${a.name}`, line);
              return value.t;
            };
            if (symbols) {
              f.op = a.name as Op;
              if (symbols === 2) {
                f.pred = symbol(0);
                f.callee = symbol(1);
              } else f.callee = symbol(0);
            } else if (ops.has(a.name)) f.op = a.name as Op;
            else {
              if (!isValidFunctionName(a.name)) fail(`invalid function name '${a.name}'`, line);
              f.op = 'call';
              f.callee = a.name;
            }
            children = a.args.slice(symbols);
          }
          f.children = children;
          for (let k = children.length - 1; k >= 0; k--) stack.push({ ast: children[k] as Ast });
          continue;
        }
        if (nodes.length >= LIMITS.maxNodesPerFunction) throw diag('A0027', [], { line });
        const nid = f.id ?? (gen.next().value as string);
        let node: Node;
        if (a.k === 'str') node = textNode(nid, a.t.slice(1, -1), line);
        else {
          let args = f.children.map((c) => values.get(c) as Operand);
          if (a.k === 'arr' && a.rep !== undefined)
            args = new Array<Operand>(a.rep).fill(args[0] as Operand);
          if (f.op === 'arr' && args.length > LIMITS.maxArrayLength)
            throw diag('A0007', [LIMITS.maxArrayLength], { line });
          const op = f.op as Op;
          const arity = OP_ARITY[op];
          if (arity >= 0 && args.length !== arity)
            fail(`${op} expects ${arity} operands, got ${args.length}`, line);
          node = {
            id: nid,
            op,
            args,
            ...(f.callee === undefined ? {} : { callee: f.callee }),
            ...(f.pred === undefined ? {} : { pred: f.pred }),
          };
        }
        nodes.push(node);
        nodeLines.set(nid, line);
        values.set(a, { kind: 'node', id: nid });
        stack.pop();
      }
      return values.get(root) as Operand;
    };
    const expression = (text: string, line: number): Ast => {
      const p = new ExprParser(lex(text, line), line),
        ast = p.top();
      if (!p.done()) fail(`unexpected '${p.peek()?.t}'`, line);
      return ast;
    };
    for (const b of body.slice(0, -1)) {
      const match = /^([a-z][a-z0-9_]*)\s*=(?!=)\s*(.*)$/.exec(b.text) as RegExpExecArray;
      emit(expression(match[2] as string, b.line), match[1] as string, b.line);
      if (b.comments !== undefined)
        nodes[nodes.length - 1] = { ...(nodes[nodes.length - 1] as Node), comments: b.comments };
    }
    const last = body[body.length - 1] as SourceItem;
    const lastText = /^ret(?:\s|$)/.test(last.text) ? last.text.slice(3).trim() : last.text;
    const ret = emit(expression(lastText, last.line), undefined, last.line);
    nodeLines.set('ret', last.line);
    origins.set(name, { line: item.line, nodes: nodeLines });
    const built = spec.build();
    functions.push({
      name,
      params: types,
      result,
      nodes,
      ret,
      ...(built === undefined ? {} : { spec: built }),
      ...(item.comments === undefined ? {} : { comments: item.comments }),
      ...(last.comments === undefined ? {} : { retComments: last.comments }),
      ...(endComments === undefined ? {} : { endComments }),
    });
    names.add(name);
  }
  const last = functions[functions.length - 1];
  if (last !== undefined && pending.length)
    functions[functions.length - 1] = { ...last, afterComments: pending };
  const program: Program = {
    functions,
    uses,
    ...(profile === undefined ? {} : { profile }),
    ...(profileComments === undefined ? {} : { profileComments }),
    ...(useComments.some((c) => c !== undefined) ? { useComments } : {}),
    ...(last === undefined && pending.length ? { tailComments: pending } : {}),
  };
  return {
    program,
    locate(fn, node) {
      const origin = origins.get(fn);
      return node === undefined ? origin?.line : (origin?.nodes.get(node) ?? origin?.line);
    },
  };
}

/** The single default spelling of the candidate frontend; research variants stay in tools. */
export function formatSource(program: Program): string {
  return printSource(program, {}, true);
}

/** Historical style ablations, consumed only by research tools. The compiler has one default formatter. */
export function formatStudySource(program: Program, style: V2Style = {}): string {
  return printSource(program, style, false);
}
