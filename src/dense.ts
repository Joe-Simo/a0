/**
 * Dense view: a token-minimal surface syntax over exactly the same programs as the canonical
 * form (DESIGN.md, "Dense view"). The converter is lossless in both directions:
 * `parseDense(formatDense(p))` has the canonical form of `p` (every id, node order and
 * revision), and `parse(canonical)` converts to a dense text that converts back to it.
 * Nothing downstream changes: validation, hashes, backends, proofs and edits all work on the
 * same `Program`.
 *
 * What the dense text drops, each by a deterministic rule the parser inverts:
 *   - `ret`/`end` (the last statement is the result; a function ends at the next `fn`);
 *   - operand separators and temporaries: operations are written in prefix form with fixed
 *     arity, so a value used once is nested into its consumer instead of getting an id line;
 *   - ids that equal the default name of their position (`a`, `b`, ... in order, skipping
 *     explicit names): only values that are referenced by name carry an id;
 *   - `u32` types and the `-> u32` result (parameters are `A`, `B`, ...; their number is the
 *     highest one used unless the header lists the types, `_` standing for `u32`);
 *   - `shl`/`shr` are `<<`/`>>` (two tokens versus one in o200k).
 */

import {
  A0Error,
  ALL_OPS,
  type Comments,
  type Func,
  formatTextLiteral,
  formatType,
  freshRetId,
  isValidIdentifier,
  LIMITS,
  lineComment,
  type Node,
  OP_ARITY,
  type Op,
  type Operand,
  opOf,
  type Program,
  parseType,
  resultType,
  stripComment,
  type Type,
  typeEquals,
} from './core.js';

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** Function name to parameter count: what the parser needs to know a call's arity. */
export type Arities = ReadonlyMap<string, number>;

const SYMBOL_OPS: Readonly<Record<string, Op>> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'rem',
  '&': 'and',
  '|': 'or',
  '^': 'xor',
  '<<': 'shl',
  '>>': 'shr',
  '==': 'eq',
  '!=': 'ne',
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
};

/** Words that are never an unescaped id: ops, aliases, structure words and type names. */
const KEYWORDS = new Set<string>([
  ...ALL_OPS,
  'udiv',
  'urem',
  'text',
  'fn',
  'ret',
  'end',
  'use',
  'patch',
  'true',
  'false',
]);

const TYPE_LIKE = /^(u32|bool|io)(x[0-9]+)*$/;
const PARAM_WORD = /^p(0|[1-9][0-9]*)$/;
const NUMBER = /^(0|[1-9][0-9]*)$/;
const U32_MAX = 0xffff_ffff;

/** Words the dense text cannot use as a bare id (they need the `$` escape). */
function needsEscape(name: string, fnNames: ReadonlySet<string>): boolean {
  return KEYWORDS.has(name) || TYPE_LIKE.test(name) || fnNames.has(name);
}

/** The op a dense word names: an op, a canonical alias, or a symbol. */
function denseOp(word: string): Op | undefined {
  return SYMBOL_OPS[word] ?? opOf(word);
}

function paramWord(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `p${index}`;
}

/** The default names with a one-name lookahead (`current`), skipping names added to `taken`. */
class NameSeq {
  readonly #it: Generator<string>;
  #cur: string;
  constructor(taken: ReadonlySet<string>) {
    this.#it = defaultNames(taken);
    this.#cur = this.#it.next().value as string;
  }
  get current(): string {
    return this.#cur;
  }
  advance(): void {
    this.#cur = this.#it.next().value as string;
  }
}

/** The i-th default id: a..z, aa..zz, aaa.. (skipping words that would be ambiguous). */
export function* defaultNames(taken: ReadonlySet<string>): Generator<string> {
  for (let len = 1; len <= 4; len += 1) {
    const idx = new Array<number>(len).fill(0);
    for (;;) {
      const name = idx.map((c) => String.fromCharCode(97 + c)).join('');
      if (!taken.has(name) && isValidIdentifier(name) && !KEYWORDS.has(name)) yield name;
      let k = len - 1;
      while (k >= 0 && idx[k] === 25) {
        idx[k] = 0;
        k -= 1;
      }
      if (k < 0) break;
      idx[k] = (idx[k] as number) + 1;
    }
  }
  throw new A0Error('too many nodes for default names', undefined, { code: 'limit' });
}

function fail(message: string, line: number | undefined, fix?: string): never {
  throw new A0Error(message, line, { code: 'parse', ...(fix === undefined ? {} : { fix }) });
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

/**
 * Spellings the printer can turn off one at a time. Every one prints text the parser reads back
 * to the same program, so they are lossless; they exist to measure what each feature saves
 * (tools/dense-tokens.ts) and default to on.
 */
export interface DenseStyle {
  /** Nest a value used once into its consumer (off: one operation per statement). */
  readonly nest?: boolean;
  /** Leave out ids that equal their default name (off: every statement carries its id). */
  readonly implicitIds?: boolean;
  /** Leave out `u32` parameter types and `-> u32` (off: the canonical header). */
  readonly implicitTypes?: boolean;
  /** `A`, `B`, ... for parameters (off: `p0`, `p1`, ...). */
  readonly letters?: boolean;
  /** `<<` and `>>` (off: `shl` and `shr`). */
  readonly symbols?: boolean;
  /** `[x;N]` for N equal elements (off: every element). */
  readonly repeat?: boolean;
  /** The first statement of a one-statement function on the header line. */
  readonly join?: boolean;
  /** The last statement is the result (off: `ret` before it and `end` after the function). */
  readonly implicitRet?: boolean;
  /** Fold and loop bodies called once and named `CALLER_1`, ... written as `{statements}`. */
  readonly inline?: boolean;
}

export interface DenseOptions {
  /** Keep source comments in place (a formatter); the canonical-equivalent view omits them. */
  readonly comments?: boolean;
  readonly style?: DenseStyle;
  /** Parameter counts of functions defined outside the printed program (`use`d files). */
  readonly known?: Arities;
}

interface PrintCtx {
  readonly program: Program;
  /** Fold and loop bodies written inline, by the function that contains them (see `planLambdas`). */
  readonly lambdas: ReadonlyMap<string, readonly string[]>;
  /** For the function being printed: callee name to its inline `{body}` text. */
  readonly inline: ReadonlyMap<string, string>;
  readonly arities: Arities;
  readonly fnNames: ReadonlySet<string>;
  readonly comments: boolean;
  readonly style: Required<DenseStyle>;
}

function operandWord(o: Operand, ctx: PrintCtx): string {
  switch (o.kind) {
    case 'node':
      return needsEscape(o.id, ctx.fnNames) ? `$${o.id}` : o.id;
    case 'param':
      return ctx.style.letters ? paramWord(o.index) : `p${o.index}`;
    case 'u32':
      return String(o.value);
    case 'bool':
      return o.value ? 'true' : 'false';
  }
}

/** The word an op is spelled with in messages (the dense symbol for shifts). */
function opWordFor(op: Op): string {
  return op === 'shl' ? '<<' : op === 'shr' ? '>>' : op;
}

/** The word printed for an op (`shl` and `shr` use their symbols). */
function opWord(op: Op, ctx: PrintCtx): string {
  if (!ctx.style.symbols) return op;
  return op === 'shl' ? '<<' : op === 'shr' ? '>>' : op;
}

interface Plan {
  /** nest[k][i] is the node nested at argument i of node k, or undefined. */
  readonly nest: readonly (readonly (number | undefined)[])[];
  readonly roots: readonly number[];
  readonly named: ReadonlySet<number>;
  /** The result is the last statement (no separate result line). */
  readonly tail: boolean;
  /**
   * The result node when it is written `ret EXPR` (its id is the fresh `retval` the canonical
   * `ret OP ARGS` sugar gives it, so neither a name nor a default id is spent on it).
   */
  readonly retNode: number | undefined;
}

/** A function printed with its `ret` and `end` lines: asked for, or they carry comments. */
function explicitRet(fn: Func, ctx: PrintCtx): boolean {
  return (
    !ctx.style.implicitRet ||
    (ctx.comments && (fn.retComments !== undefined || fn.endComments !== undefined))
  );
}

function highestParam(fn: Func): number {
  let top = -1;
  const see = (o: Operand): void => {
    if (o.kind === 'param' && o.index > top) top = o.index;
  };
  for (const n of fn.nodes) n.args.forEach(see);
  see(fn.ret);
  return top;
}

/** Decide which nodes are nested, which statements carry ids (see the module comment). */
function planFunction(fn: Func, ctx: PrintCtx): Plan {
  const n = fn.nodes.length;
  const index = new Map(fn.nodes.map((node, k) => [node.id, k] as const));
  const uses = new Array<number>(n).fill(0);
  fn.nodes.forEach((node, k) => {
    for (const a of node.args) {
      if (a.kind !== 'node') continue;
      const c = index.get(a.id);
      if (c === undefined || c >= k)
        throw new A0Error(`${fn.name}: '${a.id}' is not defined before ${node.id}`, undefined, {
          code: 'structure',
        });
      uses[c] = (uses[c] as number) + 1;
    }
  });
  let retIndex: number | undefined;
  if (fn.ret.kind === 'node') {
    retIndex = index.get(fn.ret.id);
    if (retIndex === undefined)
      throw new A0Error(`${fn.name}: ret '${fn.ret.id}' is not defined`, undefined, {
        code: 'structure',
      });
  }
  const keepRet = explicitRet(fn, ctx);
  // The result is the last statement when it is the last node, unless `ret` carries comments.
  const tail = retIndex === n - 1 && !keepRet;
  if (retIndex !== undefined && !tail) uses[retIndex] = (uses[retIndex] as number) + 1;
  const retNode =
    tail && ctx.style.implicitIds && fn.nodes[n - 1]?.id === freshRetId(fn.nodes.slice(0, n - 1))
      ? n - 1
      : undefined;

  const forced = new Set<number>();
  if (!ctx.style.implicitIds) for (let k = 0; k < n; k += 1) forced.add(k);
  for (;;) {
    const nest: (number | undefined)[][] = fn.nodes.map((node) => node.args.map(() => undefined));
    const claimed = new Array<boolean>(n).fill(false);
    let cursor = n - 1;
    const canNest = (c: number): boolean =>
      ctx.style.nest &&
      uses[c] === 1 &&
      !forced.has(c) &&
      !(ctx.comments && fn.nodes[c]?.comments !== undefined) &&
      !claimed[c];
    const build = (j: number): void => {
      const args = (fn.nodes[j] as Node).args;
      for (let i = args.length - 1; i >= 0; i -= 1) {
        const a = args[i] as Operand;
        if (a.kind !== 'node') continue;
        const c = index.get(a.id) as number;
        if (c === cursor && canNest(c)) {
          claimed[c] = true;
          (nest[j] as (number | undefined)[])[i] = c;
          cursor = c - 1;
          build(c);
        }
      }
    };
    const roots: number[] = [];
    let i = n - 1;
    while (i >= 0) {
      roots.push(i);
      cursor = i - 1;
      build(i);
      i = cursor;
    }
    roots.reverse();
    // A root is named when something refers to it, or when its id is not the default.
    const named = new Set<number>(forced);
    for (const r of roots) if ((uses[r] as number) > 0 && r !== retNode) named.add(r);
    const explicit = new Set<string>();
    for (const k of named) explicit.add((fn.nodes[k] as Node).id);
    // Walk the unnamed nodes in order against the default names they would get; a node whose id
    // is not the next name must be named (it then takes no default name). One pass names every
    // such node: a node named later never changes the name an earlier node was compared with.
    const names = new NameSeq(explicit);
    let grew = false;
    for (let k = 0; k < n; k += 1) {
      if (named.has(k) || k === retNode) continue;
      const id = (fn.nodes[k] as Node).id;
      if (id === names.current) names.advance();
      else {
        forced.add(k);
        explicit.add(id);
        grew = true;
      }
    }
    if (!grew) return { nest, roots, named, tail, retNode };
  }
}

function printNodeTokens(fn: Func, k: number, plan: Plan, ctx: PrintCtx): string {
  const node = fn.nodes[k] as Node;
  const arg = (i: number): string => {
    const child = plan.nest[k]?.[i];
    return child === undefined
      ? operandWord(node.args[i] as Operand, ctx)
      : printNodeTokens(fn, child, plan, ctx);
  };
  const args = node.args.map((_, i) => arg(i));
  if (node.op === 'arr' && node.text !== undefined) return formatTextLiteral(node.text);
  if (node.op === 'arr') {
    const first = node.args[0] as Operand;
    const same =
      ctx.style.repeat &&
      node.args.length >= 3 &&
      first.kind !== 'node' &&
      plan.nest[k]?.every((c) => c === undefined) === true &&
      node.args.every((a) => operandWord(a, ctx) === operandWord(first, ctx));
    return same ? `[${args[0]};${args.length}]` : `[${args.join(' ')}]`;
  }
  // a one-field record needs its comma: `(x,)` ((x) is just x)
  if (node.op === 'rec') return args.length === 1 ? `(${args[0]},)` : `(${args.join(' ')})`;
  if (node.op === 'call') {
    const callee = node.callee as string;
    const direct = opOf(callee) === undefined && callee !== 'text' && !KEYWORDS.has(callee);
    return [direct ? callee : `call ${callee}`, ...args].join(' ');
  }
  const callee = (name: string): string => ctx.inline.get(name) ?? name;
  if (node.op === 'fold') return ['fold', callee(node.callee as string), ...args].join(' ');
  if (node.op === 'loop')
    return ['loop', callee(node.pred as string), callee(node.callee as string), ...args].join(' ');
  return [opWord(node.op, ctx), ...args].join(' ');
}

function commentLines(c: Comments | undefined): string[] {
  return c?.leading === undefined ? [] : [...c.leading];
}

function trailing(c: Comments | undefined): string {
  return c?.trailing === undefined ? '' : ` ${c.trailing}`;
}

/** One function as dense text lines. */
function printFunction(fn: Func, outer: PrintCtx): string[] {
  const own = outer.lambdas.get(fn.name) ?? [];
  const byName = new Map(outer.program.functions.map((f) => [f.name, f] as const));
  const inline = new Map<string, string>();
  for (const name of own) {
    const f = byName.get(name) as Func;
    const text = statementsOf(f, { ...outer, inline: new Map() }).body.map((b) => b.text);
    inline.set(name, `{${text.join(';')}}`);
  }
  const ctx: PrintCtx = { ...outer, inline };
  const { body } = statementsOf(fn, ctx);
  return printLines(fn, ctx, body, explicitRet(fn, ctx));
}

function statementsOf(
  fn: Func,
  ctx: PrintCtx,
): { body: { text: string; comments: Comments | undefined; named: boolean }[]; plan: Plan } {
  const plan = planFunction(fn, ctx);
  const keepRet = explicitRet(fn, ctx);
  const idWord = (id: string): string => (needsEscape(id, ctx.fnNames) ? `$${id}` : id);
  const body: { text: string; comments: Comments | undefined; named: boolean }[] = [];
  for (const r of plan.roots) {
    const node = fn.nodes[r] as Node;
    const expr = printNodeTokens(fn, r, plan, ctx);
    body.push({
      text: plan.named.has(r)
        ? `${idWord(node.id)} ${expr}`
        : r === plan.retNode
          ? `ret ${expr}`
          : expr,
      comments: ctx.comments ? node.comments : undefined,
      named: plan.named.has(r),
    });
  }
  if (!plan.tail) {
    body.push({
      text: `${keepRet ? 'ret ' : ''}${operandWord(fn.ret, ctx)}`,
      comments: ctx.comments ? fn.retComments : undefined,
      named: false,
    });
  }
  return { body, plan };
}

function printLines(
  fn: Func,
  ctx: PrintCtx,
  body: { text: string; comments: Comments | undefined; named: boolean }[],
  keepRet: boolean,
): string[] {
  const needed = highestParam(fn) + 1;
  const plain =
    ctx.style.implicitTypes && fn.params.length === needed && fn.params.every((t) => t === 'u32');
  // A type list always ends with its `->`; without a list a u32 result is left out.
  const implicitResult = plain && fn.result === 'u32';
  const sig =
    (plain ? '' : fn.params.map(formatType).join(' ')) +
    (implicitResult
      ? ''
      : `${plain || fn.params.length === 0 ? '' : ' '}-> ${formatType(fn.result)}`);
  const head = `fn ${fn.name}${sig === '' ? '' : ` ${sig}`}`;
  const lines: string[] = [...commentLines(ctx.comments ? fn.comments : undefined)];
  const first = body[0] as { text: string; comments: Comments | undefined; named: boolean };
  // A function of one unnamed statement keeps it on the header line; a named statement and
  // longer bodies list their statements below it.
  const joinable =
    ctx.style.join &&
    body.length === 1 &&
    !first.named &&
    (!ctx.comments || (fn.comments === undefined && first.comments === undefined)) &&
    !keepRet;
  if (joinable) {
    lines.push(`${head} ${first.text}`);
    body.shift();
  } else {
    lines.push(`${head}${ctx.comments ? trailing(fn.comments) : ''}`);
  }
  for (const b of body) {
    lines.push(...commentLines(b.comments));
    lines.push(`${b.text}${trailing(b.comments)}`);
  }
  if (keepRet) {
    lines.push(
      ...commentLines(ctx.comments ? fn.endComments : undefined),
      `end${ctx.comments ? trailing(fn.endComments) : ''}`,
    );
  }
  if (ctx.comments && fn.afterComments !== undefined) lines.push('', ...fn.afterComments);
  return lines;
}

function contextFor(program: Program, options: DenseOptions): PrintCtx {
  const arities = new Map<string, number>(options.known ?? []);
  for (const f of program.functions) arities.set(f.name, f.params.length);
  const base = {
    program,
    lambdas: new Map<string, readonly string[]>(),
    inline: new Map<string, string>(),
    arities,
    fnNames: new Set(arities.keys()),
    comments: options.comments === true,
    style: {
      nest: options.style?.nest !== false,
      implicitIds: options.style?.implicitIds !== false,
      implicitTypes: options.style?.implicitTypes !== false,
      letters: options.style?.letters !== false,
      symbols: options.style?.symbols !== false,
      repeat: options.style?.repeat !== false,
      join: options.style?.join !== false,
      implicitRet: options.style?.implicitRet !== false,
      inline: options.style?.inline !== false,
    },
  };
  return options.comments === true || options.style?.inline === false
    ? base
    : { ...base, lambdas: planLambdas(program) };
}

/**
 * The dense text of each node of a function, by canonical id: what a diagnostic can show in
 * place of an id the dense text does not carry (`sumsq.a` becomes `fold addel 4 0 A`).
 */
export function denseNodeTexts(
  fn: Func,
  program: Program,
  options: DenseOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const ctx = contextFor(program, options);
    const plan = planFunction(fn, ctx);
    for (const [k, node] of fn.nodes.entries()) out.set(node.id, printNodeTokens(fn, k, plan, ctx));
  } catch {
    // an invalid function has no dense text; its diagnostics keep the canonical ids
  }
  return out;
}

/** One function in dense form (callable only inside the program it belongs to). */
export function formatDenseFunction(
  fn: Func,
  program: Program,
  options: DenseOptions = {},
): string {
  return printFunction(fn, contextFor(program, options)).join('\n');
}

/** The dense text of a program: its `use` lines, then every function, blank-line separated. */
export function formatDense(program: Program, options: DenseOptions = {}): string {
  const ctx = contextFor(program, options);
  const comments = ctx.comments;
  const withUse = (program.uses ?? []).map((u, k) => {
    const c = comments ? program.useComments?.[k] : undefined;
    return [...commentLines(c), `use "${u}"${trailing(c)}`].join('\n');
  });
  const skipped = new Set([...ctx.lambdas.values()].flat());
  const fns = program.functions
    .filter((f) => !skipped.has(f.name))
    .map((f) => printFunction(f, ctx).join('\n'));
  const tail = comments ? (program.tailComments ?? []) : [];
  const directive =
    program.profile === 'strict'
      ? (() => {
          const c = comments ? program.profileComments : undefined;
          return [...commentLines(c), `profile strict${trailing(c)}`].join('\n');
        })()
      : '';
  const head = [directive, ...withUse].filter((p) => p !== '').join('\n');
  const body = fns.join('\n\n');
  const parts = [head, body, tail.join('\n')].filter((p) => p !== '');
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
}

/**
 * The signature line of a function in dense form, as its header would be written with types:
 * `fn name T... -> T` (what a view shows for a callee; the result is always given).
 */
export function formatDenseSignature(fn: Func): string {
  const params = fn.params.map(formatType);
  return `fn ${fn.name}${params.length === 0 ? '' : ` ${params.join(' ')}`} -> ${formatType(fn.result)}`;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

export interface Tok {
  readonly kind: 'word' | 'str' | 'open' | 'close' | 'semi' | 'comma' | 'lbrace' | 'rbrace';
  readonly text: string;
}

/** Split one statement into tokens: words, string literals, `[ ] ( ) ;`; commas are blanks. */
export function lexDense(text: string, line: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === ' ' || c === '\t') {
      i += 1;
    } else if (c === ',') {
      out.push({ kind: 'comma', text: c });
      i += 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) fail('unterminated text literal', line);
      out.push({ kind: 'str', text: text.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '[' || c === '(') {
      out.push({ kind: 'open', text: c });
      i += 1;
    } else if (c === ']' || c === ')') {
      out.push({ kind: 'close', text: c });
      i += 1;
    } else if (c === ';') {
      out.push({ kind: 'semi', text: c });
      i += 1;
    } else if (c === '{' || c === '}') {
      out.push({ kind: c === '{' ? 'lbrace' : 'rbrace', text: c });
      i += 1;
    } else {
      let j = i;
      while (j < text.length && !' \t,"[]();{}'.includes(text[j] as string)) j += 1;
      out.push({ kind: 'word', text: text.slice(i, j) });
      i = j;
    }
  }
  return out;
}

function decodeText(raw: string, line: number): string {
  return raw.slice(1, -1).replace(/\\(.)/g, (_, c: string) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === '"' || c === '\\') return c;
    return fail(`unknown escape \\${c} in text literal`, line);
  });
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Item {
  readonly text: string;
  readonly line: number;
  readonly comments?: Comments;
}

function commentsOf(leading: readonly string[], trail: string | undefined): Comments | undefined {
  if (leading.length === 0 && trail === undefined) return undefined;
  return {
    ...(leading.length > 0 ? { leading } : {}),
    ...(trail === undefined ? {} : { trailing: trail }),
  };
}

/** Where a type token starting at `pos` ends, or undefined when the text there is no type. */
function typeTokenEnd(text: string, pos: number): { end: number; type: Type } | undefined {
  let end = pos;
  if (text[pos] === '(') {
    let depth = 0;
    for (; end < text.length; end += 1) {
      if (text[end] === '(') depth += 1;
      else if (text[end] === ')') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    if (depth !== 0) return undefined;
    while (end < text.length && /[x0-9]/.test(text[end] as string)) end += 1;
  } else {
    while (end < text.length && !/[\s]/.test(text[end] as string)) end += 1;
  }
  const word = text.slice(pos, end).replace(/\s+/g, '');
  if (!/^(\(|u32|bool|io)/.test(word)) return undefined;
  try {
    return { end, type: parseType(word) };
  } catch {
    return undefined;
  }
}

export interface Pending {
  id: string;
  op: Op;
  args: Operand[];
  callee?: string;
  pred?: string;
  text?: string;
  comments?: Comments;
}

type Sig = { readonly params: readonly Type[]; readonly result: Type };

/**
 * What a function body parser needs to write a fold or loop body inline (`fold {A+B} ...`): the
 * enclosing function's name (the lifted body is `NAME_1`, `NAME_2`, ... in node order), the list
 * the lifted functions go to (they precede the function), and the types that give the lifted
 * function its signature (state type of the initial value, the extra operands' types).
 */
export interface LambdaCtx {
  readonly fnName: string;
  readonly lifted: Func[];
  readonly sigs: Map<string, Sig>;
  readonly paramTypes: readonly Type[] | undefined;
  readonly nested: boolean;
  readonly counter: { n: number };
}

interface Inline {
  readonly arity: number;
  readonly nodes: Node[];
  readonly ret: Operand;
}

/** Statement parser for one function body; the edit protocol drives it line by line too. */
export class FunctionParser {
  readonly nodes: Pending[] = [];
  readonly names = new Map<string, number>();
  readonly explicit: (string | undefined)[] = [];
  /** The node a `ret EXPR` statement created: its id is the fresh `retval`. */
  retNode: number | undefined;
  line = 0;
  toks: Tok[] = [];
  pos = 0;

  constructor(
    readonly arities: Arities,
    readonly fnNames: ReadonlySet<string>,
    /** Ids of nodes that already exist (an edit refers to them by name). */
    readonly external: ReadonlySet<string> = new Set(),
    readonly lam?: LambdaCtx,
  ) {}

  private typeOf(o: Operand): Type {
    if (o.kind === 'u32') return 'u32';
    if (o.kind === 'bool') return 'bool';
    if (o.kind === 'param') return this.lam?.paramTypes?.[o.index] ?? 'u32';
    if (!o.id.startsWith('\u0000'))
      return fail(
        'an inline body needs the type of a value defined by an earlier edit',
        this.line,
        'write the body as a function instead',
      );
    return this.nodeType(Number(o.id.slice(1)));
  }

  private nodeType(k: number): Type {
    const p = this.nodes[k] as Pending;
    const args = p.args.map((a) => this.typeOf(a));
    if (p.op === 'call') {
      const sig = this.lam?.sigs.get(p.callee as string);
      if (sig === undefined)
        return fail(
          `an inline body needs the result type of '${p.callee}'`,
          this.line,
          'define that function above, in this file',
        );
      return sig.result;
    }
    if (p.op === 'fold' || p.op === 'loop') return args[1] as Type;
    if (p.op === 'arr') return { kind: 'arr', length: args.length, elem: args[0] as Type };
    if (p.op === 'rec') return { kind: 'rec', fields: args };
    return resultType(p.op, args, `line ${this.line}`);
  }

  /** `{ statement ; statement }` after `fold` or `loop`: the body as a function of its own. */
  private inlineBody(): Inline {
    if (this.lam === undefined || this.lam.nested)
      return fail(
        'an inline body is only allowed in a function, not inside another inline body',
        this.line,
      );
    const groups: Tok[][] = [[]];
    let depth = 0;
    for (;;) {
      const t = this.toks[this.pos];
      if (t === undefined) return fail("missing '}'", this.line);
      this.pos += 1;
      if (t.kind === 'rbrace') break;
      if (t.kind === 'lbrace') return fail('inline bodies do not nest', this.line);
      if (t.kind === 'open') depth += 1;
      if (t.kind === 'close') depth -= 1;
      if (t.kind === 'semi' && depth === 0) groups.push([]);
      else (groups[groups.length - 1] as Tok[]).push(t);
    }
    const sub = new FunctionParser(this.arities, this.fnNames, new Set(), {
      ...this.lam,
      nested: true,
    });
    const stmts: { value: Operand; ret: boolean; line: number }[] = [];
    for (const g of groups.filter((x) => x.length > 0)) {
      const st = sub.statement(g, this.line, undefined);
      stmts.push({ value: st.value, ret: st.ret, line: this.line });
    }
    const { nodes, ret } = assemble(sub, stmts, 'an inline body', this.line);
    let top = 1;
    const see = (o: Operand): void => {
      if (o.kind === 'param' && o.index > top) top = o.index;
    };
    for (const n of nodes) n.args.forEach(see);
    see(ret);
    return { arity: top + 1, nodes, ret };
  }

  /** The lifted function of an inline body once the call's operands are known. */
  private lift(body: Inline, args: readonly Operand[], result: 'state' | 'bool'): string {
    const lam = this.lam as LambdaCtx;
    lam.counter.n += 1;
    const name = `${lam.fnName}_${lam.counter.n}`;
    const state = this.typeOf(args[1] as Operand);
    const params: Type[] = [state, 'u32', ...args.slice(2).map((a) => this.typeOf(a))];
    const f: Func = {
      name,
      params,
      result: result === 'bool' ? 'bool' : state,
      nodes: body.nodes,
      ret: body.ret,
    };
    lam.lifted.push(f);
    lam.sigs.set(name, { params, result: f.result });
    return name;
  }

  private temp(k: number): string {
    return `\u0000${k}`;
  }

  private ref(k: number): Operand {
    return { kind: 'node', id: this.temp(k) };
  }

  private make(p: Omit<Pending, 'id'>): Operand {
    const k = this.nodes.length;
    if (k >= LIMITS.maxNodesPerFunction) fail('too many nodes in function', this.line);
    this.nodes.push({ ...p, id: this.temp(k) });
    return this.ref(k);
  }

  /** Skip commas (blanks, except after the one element of `(x,)`). */
  private skipCommas(): void {
    while (this.toks[this.pos]?.kind === 'comma') this.pos += 1;
  }

  private peek(): Tok | undefined {
    this.skipCommas();
    return this.toks[this.pos];
  }

  private eat(what: string): Tok {
    this.skipCommas();
    const t = this.toks[this.pos];
    if (t === undefined)
      return fail(
        `the line ended where ${what} was expected`,
        this.line,
        'every operation takes its operands right after it; a value used twice needs a name on its own line above (`x op ...`)',
      );
    this.pos += 1;
    return t;
  }

  private callArity(name: string): number {
    const n = this.arities.get(name);
    if (n === undefined)
      return fail(
        `unknown function '${name}'`,
        this.line,
        'a callee must be defined above its caller',
      );
    return n;
  }

  private functionName(what: string): string {
    const t = this.eat(what);
    if (t.kind !== 'word') return fail(`expected ${what}, got '${t.text}'`, this.line);
    return t.text;
  }

  expr(): Operand {
    const t = this.eat('an operand');
    if (t.kind === 'str') {
      const text = decodeText(t.text, this.line);
      const bytes = new TextEncoder().encode(text);
      if (bytes.length === 0) fail('text literal must not be empty', this.line);
      if (bytes.length > LIMITS.maxArrayLength)
        fail(`text literal exceeds ${LIMITS.maxArrayLength} bytes`, this.line);
      return this.make({
        op: 'arr',
        args: [...bytes].map((value) => ({ kind: 'u32' as const, value })),
        text,
      });
    }
    if (t.kind === 'open') return this.aggregate(t.text === '[' ? 'arr' : 'rec');
    if (t.kind !== 'word') return fail(`unexpected '${t.text}'`, this.line);
    return this.word(t.text);
  }

  private aggregate(op: 'arr' | 'rec'): Operand {
    const close = op === 'arr' ? ']' : ')';
    const args: Operand[] = [];
    let comma = false;
    for (;;) {
      const t = this.peek();
      if (t === undefined) return fail(`missing '${close}'`, this.line);
      if (t.kind === 'close') {
        if (t.text !== close) return fail(`expected '${close}', got '${t.text}'`, this.line);
        this.pos += 1;
        break;
      }
      if (t.kind === 'semi') {
        if (op !== 'arr' || args.length !== 1) return fail("unexpected ';'", this.line);
        this.pos += 1;
        const count = this.eat('a repeat count');
        if (count.kind !== 'word' || !NUMBER.test(count.text) || Number(count.text) < 1)
          return fail(`repeat count '${count.text}' is not a positive number`, this.line);
        const n = Number(count.text);
        if (n > LIMITS.maxArrayLength)
          fail(`array length exceeds ${LIMITS.maxArrayLength}`, this.line);
        const only = args[0] as Operand;
        for (let i = 1; i < n; i += 1) args.push(only);
        continue;
      }
      args.push(this.expr());
      if (this.toks[this.pos]?.kind === 'comma') comma = true;
    }
    if (args.length === 0)
      return fail(`${op === 'arr' ? '[]' : '()'} needs at least one element`, this.line);
    // `(EXPR)` is EXPR (grouping); a record has two or more fields, or one with a comma: `(x,)`.
    if (op === 'rec' && args.length === 1 && !comma) return args[0] as Operand;
    return this.make({ op, args });
  }

  /** Elements of `arr e...`/`rec e...` up to the end of the line or the closing delimiter. */
  private rest(): Operand[] {
    const args: Operand[] = [];
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.kind === 'close' || t.kind === 'semi') break;
      args.push(this.expr());
    }
    return args;
  }

  private operands(count: number, label: string, note = ''): Operand[] {
    const args: Operand[] = [];
    for (let i = 0; i < count; i += 1) {
      if (this.peek() === undefined)
        fail(
          `\`${label}\` needs ${count} operand${count === 1 ? '' : 's'}${note} but the line ended after ${i}`,
          this.line,
          `an operation takes its operands right after it, each a parameter, a number, a named value or another operation; write \`${label}\` followed by exactly ${count}`,
        );
      args.push(this.expr());
    }
    return args;
  }

  private word(w: string): Operand {
    if (w === 'true' || w === 'false') return { kind: 'bool', value: w === 'true' };
    if (NUMBER.test(w)) {
      const value = Number(w);
      if (value > U32_MAX) fail(`literal ${w} exceeds u32`, this.line);
      return { kind: 'u32', value };
    }
    if (/^[A-Z]$/.test(w)) return { kind: 'param', index: w.charCodeAt(0) - 65 };
    if (PARAM_WORD.test(w)) return { kind: 'param', index: Number(w.slice(1)) };
    if (w.startsWith('$')) {
      const k = this.names.get(w.slice(1));
      if (k === undefined)
        return fail(`'${w}' is not defined above`, this.line, 'name a value before using it');
      return this.ref(k);
    }
    const op = denseOp(w);
    if (op !== undefined) return this.operation(op);
    if (w === 'text') {
      const s = this.eat('a text literal');
      if (s.kind !== 'str') return fail('text expects a quoted string', this.line);
      this.pos -= 1;
      return this.expr();
    }
    if (this.fnNames.has(w) || this.arities.has(w)) {
      const n = this.callArity(w);
      return this.make({
        op: 'call',
        callee: w,
        args: this.operands(n, w, ` (${w} has ${n} parameter${n === 1 ? '' : 's'})`),
      });
    }
    const local = this.names.get(w);
    if (local !== undefined) return this.ref(local);
    if (this.external.has(w)) return { kind: 'node', id: w };
    return fail(
      `'${w}' is not an operation, a function, or a named value defined above`,
      this.line,
      `parameters are written A, B, C by position (no names); use an operation, a function defined above, or name a value first (\`${w} op ...\` on its own line)`,
    );
  }

  private operation(op: Op): Operand {
    if (op === 'arr' || op === 'rec') {
      const args = this.rest();
      if (args.length === 0) fail(`${op} expects at least one operand`, this.line);
      return this.make({ op, args });
    }
    if (op === 'call') {
      const callee = this.functionName(`a function name after ${op}`);
      const n = this.callArity(callee);
      return this.make({
        op,
        callee,
        args: this.operands(n, `${op} ${callee}`, ` (${callee} has ${n} parameters)`),
      });
    }
    if (op === 'fold') {
      const spec = this.bodySpec('a function name or {body} after fold');
      const n = spec.name === undefined ? (spec.inline as Inline).arity : this.callArity(spec.name);
      const label = `fold ${spec.name ?? '{...}'}`;
      const args = this.operands(
        n,
        label,
        spec.name === undefined ? '' : ` (${spec.name} has ${n} parameters)`,
      );
      const callee = spec.name ?? this.lift(spec.inline as Inline, args, 'state');
      return this.make({ op, callee, args });
    }
    if (op === 'loop') {
      const pred = this.bodySpec('a predicate name or {body} after loop');
      const body = this.bodySpec('a body function name or {body} after the predicate');
      const named = body.name ?? pred.name;
      let n: number;
      if (named !== undefined) n = this.callArity(named);
      else n = Math.max((pred.inline as Inline).arity, (body.inline as Inline).arity);
      for (const sp of [pred, body])
        if (sp.inline !== undefined && sp.inline.arity > n)
          fail(
            `an inline body uses parameter ${paramWord(sp.inline.arity - 1)} but the loop takes ${n}`,
            this.line,
          );
      const args = this.operands(
        n,
        `loop ${pred.name ?? '{...}'} ${body.name ?? '{...}'}`,
        named === undefined ? '' : ` (${named} has ${n} parameters)`,
      );
      const predName = pred.name ?? this.lift(pred.inline as Inline, args, 'bool');
      const callee = body.name ?? this.lift(body.inline as Inline, args, 'state');
      return this.make({ op, pred: predName, callee, args });
    }
    return this.make({ op, args: this.operands(OP_ARITY[op], opWordFor(op)) });
  }

  private bodySpec(what: string): { name?: string; inline?: Inline } {
    const t = this.peek();
    if (t?.kind === 'lbrace') {
      this.pos += 1;
      return { inline: this.inlineBody() };
    }
    const name = this.functionName(what);
    this.callArity(name);
    return { name };
  }

  /** Parse one statement line; returns its value operand and whether it is `ret`-prefixed. */
  statement(
    tokens: Tok[],
    line: number,
    comments: Comments | undefined,
  ): { value: Operand; ret: boolean; named: boolean } {
    this.toks = tokens;
    this.pos = 0;
    this.line = line;
    let ret = false;
    if (tokens[0]?.kind === 'word' && tokens[0].text === 'ret') {
      ret = true;
      this.pos = 1;
    }
    let name: string | undefined;
    const t0 = this.peek();
    if (t0?.kind === 'word' && !ret) {
      const t1 = tokens[this.pos + 1];
      if (t1 !== undefined && t0.text.startsWith('$') && isValidIdentifier(t0.text.slice(1))) {
        name = t0.text.slice(1);
        this.pos += 1;
      } else if (
        isValidIdentifier(t0.text) &&
        t1 !== undefined &&
        ((t1.kind === 'word' && t1.text === '=') ||
          (!KEYWORDS.has(t0.text) &&
            !TYPE_LIKE.test(t0.text) &&
            !this.fnNames.has(t0.text) &&
            !this.arities.has(t0.text) &&
            denseOp(t0.text) === undefined))
      ) {
        name = t0.text;
        this.pos += 1;
      }
      if (name !== undefined && this.peek()?.kind === 'word' && this.peek()?.text === '=')
        this.pos += 1;
    }
    const before = this.nodes.length;
    let value = this.expr();
    this.skipCommas();
    if (this.pos < tokens.length) {
      const extra = tokens[this.pos] as Tok;
      fail(
        `unexpected '${extra.text}' after a complete expression`,
        line,
        'one statement per line; a value used twice needs a name on its own line above (`x op ...`), then use `x`',
      );
    }
    if (name !== undefined) {
      // `x y` with y a value defined above names a copy of it (`x mov y`): a guessable spelling.
      if (value.kind === 'node' && this.nodes.length === before && !this.external.has(value.id))
        value = this.make({ op: 'mov', args: [value] });
      if (value.kind !== 'node' || this.nodes.length === before)
        fail(
          `'${name}' is neither an operation nor a function defined above`,
          line,
          `to name a value write \`${name} OP ...\` (for example \`${name} add A 1\`); to call a function it must be defined above`,
        );
      if (this.names.has(name)) fail(`duplicate id '${name}'`, line);
      const k = this.nodes.length - 1;
      this.names.set(name, k);
      this.explicit[k] = name;
    }
    const k = value.kind === 'node' ? this.nodes.length - 1 : -1;
    if (comments !== undefined && k >= 0 && this.nodes.length > before && !ret)
      (this.nodes[k] as Pending).comments = comments;
    if (ret && k >= 0 && this.nodes.length > before) this.retNode = k;
    return { value, ret, named: name !== undefined };
  }

  /** Final ids: explicit names, then default names for the rest, in node order. */
  finish(): { nodes: Node[]; resolve: (o: Operand) => Operand } {
    const explicit = new Set(this.explicit.filter((e): e is string => e !== undefined));
    const names = defaultNames(explicit);
    const ids = this.nodes.map((_, k) =>
      this.retNode === k ? '' : (this.explicit[k] ?? (names.next().value as string)),
    );
    if (this.retNode !== undefined)
      ids[this.retNode] = freshRetId(ids.filter((id) => id !== '').map((id) => ({ id })));
    return this.finishWith(ids);
  }

  /** The nodes with the given final ids (one per node, in order). */
  finishWith(finalIds: readonly string[]): { nodes: Node[]; resolve: (o: Operand) => Operand } {
    const map = (o: Operand): Operand =>
      o.kind === 'node' && o.id.startsWith('\u0000')
        ? { kind: 'node', id: finalIds[Number(o.id.slice(1))] as string }
        : o;
    const nodes = this.nodes.map((p, k): Node => {
      const base = { id: finalIds[k] as string, op: p.op, args: p.args.map(map) };
      const n: Node =
        p.op === 'loop'
          ? { ...base, pred: p.pred as string, callee: p.callee as string }
          : p.callee !== undefined
            ? { ...base, callee: p.callee }
            : p.text !== undefined
              ? { ...base, text: p.text }
              : base;
      return p.comments === undefined ? n : { ...n, comments: p.comments };
    });
    return { nodes, resolve: map };
  }
}

/** The nodes and result of a parsed body: its statements, the last one being the result. */
function assemble(
  fp: FunctionParser,
  stmts: readonly { value: Operand; ret: boolean; line: number }[],
  what: string,
  line: number,
): { nodes: Node[]; ret: Operand } {
  if (stmts.length === 0) fail(`${what} has no result`, line);
  for (const [si, st] of stmts.entries())
    if (si < stmts.length - 1 && st.value.kind !== 'node')
      fail(
        'a bare value is only allowed as the last statement (the result)',
        st.line,
        'delete it, or write it last',
      );
  const { nodes, resolve } = fp.finish();
  return { nodes, ret: resolve((stmts[stmts.length - 1] as { value: Operand }).value) };
}

/** Parse a function header line (after `fn`): name, optional type list and result, rest. */
export function parseDenseHeader(
  text: string,
  line: number,
  /** Accept a type list without `->` (the signature lines of a view). */
  lenient = false,
): { name: string; params: Type[] | undefined; result: Type; rest: string } {
  const m = /^(\S+)\s*(.*)$/.exec(text);
  const name = m?.[1] ?? '';
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || KEYWORDS.has(name))
    fail(`invalid function name '${name}'`, line);
  let rest = m?.[2] ?? '';
  let params: Type[] | undefined;
  let result: Type = 'u32';
  let arrow = false;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith('->') && (rest.length === 2 || /\s/.test(rest[2] as string))) {
      arrow = true;
      rest = rest.slice(2).trimStart();
      const tok = typeTokenEnd(rest, 0);
      if (tok === undefined) fail(`expected a result type after '->'`, line);
      result = (tok as { type: Type }).type;
      rest = rest.slice((tok as { end: number }).end);
      break;
    }
    if (rest.startsWith('_') && (rest.length === 1 || /\s/.test(rest[1] as string))) {
      params = [...(params ?? []), 'u32'];
      rest = rest.slice(1);
      continue;
    }
    const tok = typeTokenEnd(rest, 0);
    if (tok === undefined) break;
    params = [...(params ?? []), tok.type];
    rest = rest.slice(tok.end);
  }
  if (params !== undefined && params.length > LIMITS.maxParams) fail('too many parameters', line);
  if (params !== undefined && !arrow && !lenient)
    fail(
      `the type list of '${name}' needs '-> RESULT' after it`,
      line,
      `write \`fn ${name} ${params.map((t) => (t === 'u32' ? 'u32' : formatType(t))).join(' ')} -> u32\` (the last type after \`->\` is the result), or leave the type list out when every parameter is u32 (\`fn ${name} ...\`: parameters are A, B, C by position)`,
    );
  return { name, params, result, rest: rest.trim() };
}

export interface DenseParseOptions {
  /** Functions defined outside the text (`use`d files): name to parameter count. */
  readonly known?: Arities;
  /** More function names that exist but whose parameter count is not known yet. */
  readonly names?: ReadonlySet<string>;
}

/** Parse dense text into the same `Program` the canonical form of it would give. */
export function parseDense(source: string, options: DenseParseOptions = {}): Program {
  const rawLines = source.split(/\r?\n/);
  const items: Item[] = [];
  let pending: string[] = [];
  rawLines.forEach((raw, i) => {
    const text = stripComment(raw).trim();
    const comment = lineComment(raw);
    if (text.length === 0) {
      if (comment !== undefined) pending.push(comment);
      return;
    }
    const comments = commentsOf(pending, comment);
    pending = [];
    items.push(comments === undefined ? { text, line: i + 1 } : { text, line: i + 1, comments });
  });
  const trailingPending = pending;

  const arities = new Map<string, number>(options.known ?? []);
  const fnNames = new Set<string>([...arities.keys(), ...(options.names ?? [])]);
  for (const it of items) {
    const m = /^fn\s+(\S+)/.exec(it.text);
    if (m !== null) fnNames.add(m[1] as string);
  }

  const sigs = new Map<string, Sig>();
  const uses: string[] = [];
  const useComments: (Comments | undefined)[] = [];
  const functions: Func[] = [];
  let k = 0;
  let profile: 'strict' | undefined;
  let profileComments: Comments | undefined;
  const firstItem = items[0];
  if (firstItem !== undefined && /^profile(\s|$)/.test(firstItem.text)) {
    if (firstItem.text !== 'profile strict')
      fail(
        'profile expects `profile strict` as the first line of the file',
        firstItem.line,
        'write `profile strict` as the very first line, before any use or fn, or remove the line for the canonical profile',
      );
    profile = 'strict';
    profileComments = firstItem.comments;
    k = 1;
  }
  while (k < items.length) {
    const it = items[k] as Item;
    if (/^profile(\s|$)/.test(it.text))
      fail(
        'profile expects `profile strict` as the first line of the file',
        it.line,
        'write `profile strict` as the very first line, before any use or fn, or remove the line for the canonical profile',
      );
    if (/^use(\s|$)/.test(it.text)) {
      const m = /^use\s+"([^"\\]+)"$/.exec(it.text);
      if (m === null || functions.length > 0)
        fail(
          'use expects `use "path.a0"` before the first fn',
          it.line,
          'write use "relative/path.a0" as its own line at the top of the file',
        );
      uses.push(m[1] as string);
      useComments.push(it.comments);
      k += 1;
      continue;
    }
    if (!/^fn(\s|$)/.test(it.text))
      fail(
        `expected 'fn', got '${it.text.split(/\s+/)[0]}'`,
        it.line,
        'statements belong inside a function: start it with `fn NAME`',
      );
    const head = parseDenseHeader(it.text.slice(2).trim(), it.line);
    if (functions.some((f) => f.name === head.name) || arities.has(head.name))
      fail(`duplicate function '${head.name}'`, it.line);
    const lifted: Func[] = [];
    const fp = new FunctionParser(arities, fnNames, new Set(), {
      fnName: head.name,
      lifted,
      sigs,
      paramTypes: head.params,
      nested: false,
      counter: { n: 0 },
    });
    const stmts: { value: Operand; ret: boolean; line: number; comments?: Comments }[] = [];
    let endComments: Comments | undefined;
    const body: { text: string; line: number; comments?: Comments }[] = [];
    if (head.rest !== '') body.push({ text: head.rest, line: it.line });
    k += 1;
    while (k < items.length) {
      const nx = items[k] as Item;
      if (/^fn(\s|$)/.test(nx.text) || /^use(\s|$)/.test(nx.text)) break;
      k += 1;
      if (nx.text === 'end') {
        endComments = nx.comments;
        break;
      }
      body.push(
        nx.comments === undefined
          ? { text: nx.text, line: nx.line }
          : { text: nx.text, line: nx.line, comments: nx.comments },
      );
    }
    let retComments: Comments | undefined;
    body.forEach((b, bi) => {
      const toks = lexDense(b.text, b.line);
      const s = fp.statement(toks, b.line, b.comments);
      if (s.ret) retComments = b.comments;
      stmts.push({ value: s.value, ret: s.ret, line: b.line });
      if (s.ret && bi !== body.length - 1) fail("'ret' must be the last statement", b.line);
    });
    if (stmts.length === 0)
      fail(
        `function '${head.name}' has no result`,
        it.line,
        'write the result expression after the header (same line or below), e.g. `fn id A`; do not repeat `fn NAME` for the body',
      );
    stmts.forEach((s, si) => {
      if (si < stmts.length - 1 && s.value.kind !== 'node')
        fail(
          'a bare value is only allowed as the last statement (the result)',
          s.line,
          'delete it, or write it last',
        );
    });
    const { nodes, resolve } = fp.finish();
    const lastStmt = stmts[stmts.length - 1] as (typeof stmts)[number];
    const ret = resolve(lastStmt.value);
    const header = it.comments;
    let needed = 0;
    const see = (o: Operand): void => {
      if (o.kind === 'param' && o.index + 1 > needed) needed = o.index + 1;
    };
    for (const n of nodes) n.args.forEach(see);
    see(ret);
    const params = head.params ?? new Array<Type>(needed).fill('u32');
    if (params.length > LIMITS.maxParams) fail('too many parameters', it.line);
    for (const lf of lifted) {
      if (
        functions.some((f) => f.name === lf.name) ||
        arities.has(lf.name) ||
        lf.name === head.name
      )
        fail(`the inline body name '${lf.name}' is already a function`, it.line);
      functions.push(lf);
      arities.set(lf.name, lf.params.length);
    }
    functions.push({
      name: head.name,
      params,
      result: head.result,
      nodes,
      ret,
      ...(header === undefined ? {} : { comments: header }),
      ...(retComments === undefined ? {} : { retComments }),
      ...(endComments === undefined ? {} : { endComments }),
    });
    sigs.set(head.name, { params, result: head.result });
    arities.set(head.name, params.length);
  }
  const last = functions[functions.length - 1];
  if (last !== undefined && trailingPending.length > 0)
    functions[functions.length - 1] = { ...last, afterComments: trailingPending };
  return {
    functions,
    ...(profile === undefined ? {} : { profile }),
    ...(profileComments === undefined ? {} : { profileComments }),
    uses,
    ...(useComments.some((c) => c !== undefined) ? { useComments } : {}),
    ...(last === undefined && trailingPending.length > 0 ? { tailComments: trailingPending } : {}),
  };
}

// ---------------------------------------------------------------------------
// Inline fold and loop bodies
// ---------------------------------------------------------------------------

/** Type of an operand of `fn`'s nodes (undefined when a callee's signature is unknown). */
function typerFor(fn: Func, sigs: ReadonlyMap<string, Sig>): (o: Operand) => Type | undefined {
  const byId = new Map(fn.nodes.map((n, k) => [n.id, k] as const));
  const memo = new Map<string, Type | undefined>();
  const operand = (o: Operand): Type | undefined => {
    if (o.kind === 'u32') return 'u32';
    if (o.kind === 'bool') return 'bool';
    if (o.kind === 'param') return fn.params[o.index];
    if (memo.has(o.id)) return memo.get(o.id);
    const node = fn.nodes[byId.get(o.id) as number] as Node;
    let t: Type | undefined;
    try {
      const args = node.args.map(operand);
      if (args.some((a) => a === undefined)) t = undefined;
      else if (node.op === 'call') t = sigs.get(node.callee as string)?.result;
      else if (node.op === 'fold' || node.op === 'loop') t = args[1];
      else if (node.op === 'arr') t = { kind: 'arr', length: args.length, elem: args[0] as Type };
      else if (node.op === 'rec') t = { kind: 'rec', fields: args as Type[] };
      else t = resultType(node.op, args as Type[], fn.name);
    } catch {
      t = undefined;
    }
    memo.set(o.id, t);
    return t;
  };
  return operand;
}

/** The parameters a body that mentions up to parameter `top` has when written inline (at least 2). */
function inlineArity(f: Func): number {
  return Math.max(2, highestParam(f) + 1);
}

/**
 * Which functions are written inline in which caller. `F` is a fold or loop body (a loop's
 * predicate too) written `{...}` when it is called from exactly one node of exactly one caller `G`,
 * is named `G_1`, `G_2`, ... in the order those nodes appear, sits immediately before `G`, has no
 * fold or loop of its own, and has the signature the parser derives from the call (state type of
 * the initial value, `u32` index, the extra operands' types; result the state type, or bool for a
 * predicate). Nothing else is inlined, so converting back restores the program exactly.
 */
export function planLambdas(program: Program): Map<string, string[]> {
  const sigs = new Map<string, Sig>(
    program.functions.map((f) => [f.name, { params: f.params, result: f.result }] as const),
  );
  const index = new Map(program.functions.map((f, i) => [f.name, i] as const));
  const foldUses = new Map<string, number>();
  const called = new Set<string>();
  for (const f of program.functions)
    for (const n of f.nodes) {
      if (n.op === 'call') called.add(n.callee as string);
      if (n.op === 'fold' || n.op === 'loop') {
        foldUses.set(n.callee as string, (foldUses.get(n.callee as string) ?? 0) + 1);
        if (n.op === 'loop')
          foldUses.set(n.pred as string, (foldUses.get(n.pred as string) ?? 0) + 1);
      }
    }
  const out = new Map<string, string[]>();
  for (const [gi, g] of program.functions.entries()) {
    const typeOf = typerFor(g, sigs);
    const chosen: string[] = [];
    for (const node of g.nodes) {
      if (node.op !== 'fold' && node.op !== 'loop') continue;
      const slots: { name: string; result: 'state' | 'bool' }[] =
        node.op === 'loop'
          ? [
              { name: node.pred as string, result: 'bool' },
              { name: node.callee as string, result: 'state' },
            ]
          : [{ name: node.callee as string, result: 'state' }];
      const state = typeOf(node.args[1] as Operand);
      const extras = node.args.slice(2).map(typeOf);
      if (state === undefined || extras.some((e) => e === undefined)) continue;
      const params: Type[] = [state, 'u32', ...(extras as Type[])];
      const before = chosen.length;
      const picked: Func[] = [];
      for (const slot of slots) {
        const fi = index.get(slot.name);
        const f = fi === undefined ? undefined : (program.functions[fi] as Func);
        if (
          f === undefined ||
          fi === gi ||
          foldUses.get(slot.name) !== 1 ||
          called.has(slot.name) ||
          f.name !== `${g.name}_${chosen.length + 1}` ||
          f.comments !== undefined ||
          f.nodes.some((n) => n.op === 'fold' || n.op === 'loop') ||
          f.params.length !== params.length ||
          !f.params.every((t, i) => typeEquals(t, params[i] as Type)) ||
          !typeEquals(f.result, slot.result === 'bool' ? 'bool' : state)
        )
          continue;
        chosen.push(f.name);
        picked.push(f);
      }
      // The parser takes the loop's operand count from a named body, or else from the inline
      // bodies' own parameter use: that must be the call's count.
      const named = slots.find((sl) => !picked.some((f) => f.name === sl.name));
      const n = params.length;
      const natural = Math.max(...picked.map(inlineArity), 0);
      const ok =
        picked.length === 0 ||
        (picked.every((f) => inlineArity(f) <= n) && (named !== undefined || natural === n));
      if (!ok) chosen.length = before;
    }
    if (chosen.length === 0) continue;
    const prior = program.functions.slice(gi - chosen.length, gi).map((f) => f.name);
    if (gi >= chosen.length && prior.every((nm, i) => nm === chosen[i])) out.set(g.name, chosen);
  }
  return out;
}

/**
 * Rename each helper that only a fold or loop in the function right after it calls to the name
 * the dense form writes inline (`G_1`, ...), moving it directly before that function: part of
 * the normal form, since the rename changes the program text (not its behavior).
 */
export function liftHelpers(program: Program): Program {
  let fns = [...program.functions];
  const sigs = (): Map<string, Sig> =>
    new Map(fns.map((f) => [f.name, { params: f.params, result: f.result }] as const));
  const uses = new Map<string, number>();
  const called = new Set<string>();
  for (const f of fns)
    for (const n of f.nodes) {
      if (n.op === 'call') called.add(n.callee as string);
      if (n.op === 'fold' || n.op === 'loop') {
        uses.set(n.callee as string, (uses.get(n.callee as string) ?? 0) + 1);
        if (n.op === 'loop') uses.set(n.pred as string, (uses.get(n.pred as string) ?? 0) + 1);
      }
    }
  for (const gName of program.functions.map((f) => f.name)) {
    const g = fns.find((f) => f.name === gName) as Func;
    const typeOf = typerFor(g, sigs());
    const renames = new Map<string, string>();
    for (const node of g.nodes) {
      if (node.op !== 'fold' && node.op !== 'loop') continue;
      const state = typeOf(node.args[1] as Operand);
      if (state === undefined) continue;
      const slots =
        node.op === 'loop' ? [node.pred as string, node.callee as string] : [node.callee as string];
      for (const name of slots) {
        const f = fns.find((x) => x.name === name);
        if (
          f === undefined ||
          name === gName ||
          uses.get(name) !== 1 ||
          called.has(name) ||
          f.comments !== undefined ||
          f.nodes.some((n) => n.op === 'fold' || n.op === 'loop') ||
          fns.indexOf(f) > fns.findIndex((x) => x.name === gName) ||
          renames.has(name)
        )
          continue;
        renames.set(name, `${gName}_${renames.size + 1}`);
      }
    }
    if (renames.size === 0) continue;
    const moved = [...renames.keys()].map((n) => fns.find((f) => f.name === n) as Func);
    const rest = fns.filter((f) => !moved.includes(f));
    const at = rest.findIndex((f) => f.name === gName);
    const rn = (n: string | undefined): string | undefined =>
      n === undefined ? n : (renames.get(n) ?? n);
    const newG: Func = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.callee === undefined && n.pred === undefined
          ? n
          : {
              ...n,
              ...(n.callee === undefined ? {} : { callee: rn(n.callee) as string }),
              ...(n.pred === undefined ? {} : { pred: rn(n.pred) as string }),
            },
      ),
    };
    rest[at] = newG;
    const lifted = moved.map((f) => ({ ...f, name: renames.get(f.name) as string }));
    fns = [...rest.slice(0, at), ...lifted, ...rest.slice(at)];
  }
  return { ...program, functions: fns };
}

// ---------------------------------------------------------------------------
// Normal form
// ---------------------------------------------------------------------------

/**
 * A semantics-preserving rewrite of a function into the order and ids the dense form writes
 * most compactly: nodes a value is used more than once or never are statements, everything
 * else is placed right before its consumer, and ids become the default names by position.
 * It changes the canonical text (so the revision), which is why it is a separate, explicit
 * step (`a0 dense --normalize`) and never part of the lossless conversion.
 */
export function normalizeFunction(fn: Func): Func {
  const n = fn.nodes.length;
  const index = new Map(fn.nodes.map((node, k) => [node.id, k] as const));
  const uses = new Array<number>(n).fill(0);
  for (const node of fn.nodes)
    for (const a of node.args)
      if (a.kind === 'node') {
        const c = index.get(a.id) as number;
        uses[c] = (uses[c] as number) + 1;
      }
  const retIndex = fn.ret.kind === 'node' ? (index.get(fn.ret.id) as number) : -1;
  if (retIndex >= 0) uses[retIndex] = (uses[retIndex] as number) + 1;
  const isRoot = (k: number): boolean => uses[k] !== 1 || k === retIndex;
  const order: number[] = [];
  const done = new Array<boolean>(n).fill(false);
  const childNodes = (k: number): number[] =>
    (fn.nodes[k] as Node).args.flatMap((a) =>
      a.kind === 'node' ? [index.get(a.id) as number] : [],
    );
  const hoist = (k: number): void => {
    for (const c of childNodes(k)) {
      if (isRoot(c)) emitRoot(c);
      else hoist(c);
    }
  };
  const tree = (k: number): void => {
    for (const c of childNodes(k)) if (!isRoot(c)) tree(c);
    order.push(k);
  };
  const emitRoot = (k: number): void => {
    if (done[k]) return;
    done[k] = true;
    hoist(k);
    tree(k);
  };
  for (let k = 0; k < n; k += 1) if (uses[k] === 0) emitRoot(k);
  if (retIndex >= 0) emitRoot(retIndex);
  const names = defaultNames(new Set());
  const ids = order.map(() => names.next().value as string);
  const newId = new Map(
    order.map((old, i) => [(fn.nodes[old] as Node).id, ids[i] as string] as const),
  );
  const map = (o: Operand): Operand =>
    o.kind === 'node' ? { kind: 'node', id: newId.get(o.id) as string } : o;
  const nodes = order.map((old, i): Node => {
    const node = fn.nodes[old] as Node;
    return { ...node, id: ids[i] as string, args: node.args.map(map) };
  });
  return { ...fn, nodes, ret: map(fn.ret) };
}

/** `normalizeFunction` on every function of a program. */
export function normalizeProgram(program: Program): Program {
  return liftHelpers({ ...program, functions: program.functions.map(normalizeFunction) });
}
