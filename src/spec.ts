/**
 * Spec lines: opt-in one-line contracts and executable examples that sit between a `fn` header and
 * its first node.
 *
 *   ex <literal args...> -> <literal>    an executable example (at most three per function)
 *   pre <node expr over p0..pN>          a precondition: one bool-typed operation on the parameters
 *   post <node expr over p0..pN and r>   a postcondition: the same, with `r` the result
 *
 * A literal is a u32 (`5`), a bool, an array `[1;2;3]` or a record `(1;true)` (a one-field record
 * is `(1;)`); the parser also takes spaces and commas between elements and prints the `;` form. A
 * spec expression is one node without its id: `pre lt p0 100`, `post call sorted r`.
 *
 * Spec lines are neither comments nor nodes: they have no id and no handle, they are stored as
 * `Func.spec`, and they are part of the canonical text and of `revision()`. `validate` checks them
 * after typing: every example runs on the reference interpreter under a small fuel and its result
 * is compared with the written one, and `pre` and `post` are evaluated on each example. A function
 * without spec lines has exactly the Func, text, hashes and emission it had before: no backend,
 * optimizer pass or cache key reads `spec` (`withoutSpec` is the function without it, which
 * `semanticRevision` hashes).
 */

import {
  A0Error,
  type Comments,
  containsIo,
  type Func,
  formatNode,
  formatType,
  isPrimitive,
  type Node,
  parseNode,
  run,
  type Type,
  type TypedFunc,
  type Value,
  validateFunction,
  valueEquals,
} from './core.js';
import { diag, formatTrap } from './diagnostics.js';

/** Examples per function. */
export const SPEC_MAX_EXAMPLES = 3;
/** Node evaluations an example, a `pre` or a `post` may spend. */
export const SPEC_FUEL = 10_000;

const U32_MAX = 0xffff_ffff;
const U32_LITERAL = /^(0|[1-9][0-9]*)$/;

export type Lit =
  | { readonly kind: 'u32'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'arr'; readonly items: readonly Lit[] }
  | { readonly kind: 'rec'; readonly items: readonly Lit[] };

export interface SpecExample {
  readonly args: readonly Lit[];
  readonly result: Lit;
  /** Source comments on the line; kept by the formatter, never part of the canonical form. */
  readonly comments?: Comments;
}

/**
 * The spec lines of one function. `pre` and `post` are nodes whose id is the word (`pre`,
 * `post`), so `formatNode` prints the line. In `post` the operand `r` (a node reference, since no
 * node of the function is visible there) is the result; typing maps it to an extra parameter.
 */
export interface Spec {
  readonly examples: readonly SpecExample[];
  readonly pre?: Node;
  readonly post?: Node;
}

export type SpecWord = 'ex' | 'pre' | 'post';

// ---------------------------------------------------------------------------
// Recognizing a spec line
// ---------------------------------------------------------------------------

const outsideQuotes = (text: string): string => text.replace(/"(?:[^"\\]|\\.)*"/g, '""');

/**
 * Is `text` (comment-free, trimmed) a spec line when it stands before the first node of a
 * function? `ex` lines contain the arrow `->`, which no node has (outside a text literal); `pre` and `post` are spec lines
 * there, so the first node of a function must not be named `pre` or `post`.
 */
export function specWordOf(text: string): SpecWord | undefined {
  const m = /^(ex|pre|post)(?![a-z0-9_])/.exec(text);
  if (m === null) return undefined;
  const word = m[1] as SpecWord;
  if (word !== 'ex') return word;
  return outsideQuotes(text).includes('->') ? 'ex' : undefined;
}

/** An `ex` line, wherever it stands (to say it belongs before the first node). */
export function isExampleLine(text: string): boolean {
  return specWordOf(text) === 'ex';
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

const specError = (fn: string, what: string, line?: number, fix?: string): A0Error =>
  diag('A0714', [fn, what], {
    ...(line === undefined ? {} : { line }),
    ...(fix === undefined ? {} : { fix }),
  });

class Scanner {
  pos = 0;
  constructor(
    readonly text: string,
    readonly fn: string,
    readonly line: number | undefined,
  ) {}

  fail(what: string, fix?: string): never {
    throw specError(this.fn, what, this.line, fix);
  }

  ws(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] as string)) this.pos += 1;
  }

  done(): boolean {
    this.ws();
    return this.pos >= this.text.length;
  }

  atArrow(): boolean {
    this.ws();
    return this.text.startsWith('->', this.pos);
  }

  /** Skip one element separator (`;` or `,`) and the blanks around it; true when one was there. */
  separator(): boolean {
    this.ws();
    const c = this.text[this.pos];
    if (c === ';' || c === ',') {
      this.pos += 1;
      return true;
    }
    return false;
  }

  literal(): Lit {
    this.ws();
    const c = this.text[this.pos];
    if (c === undefined) return this.fail('a literal is missing');
    if (/[0-9]/.test(c)) {
      const word = /^[0-9]+/.exec(this.text.slice(this.pos))?.[0] as string;
      this.pos += word.length;
      if (!U32_LITERAL.test(word) || Number(word) > U32_MAX)
        return this.fail(`'${word}' is not a u32 literal`, 'literals are decimal, 0 to 4294967295');
      return { kind: 'u32', value: Number(word) };
    }
    if (c === '[' || c === '(') return this.aggregate(c);
    const word = /^[a-z_0-9]+/.exec(this.text.slice(this.pos))?.[0] ?? c;
    if (word === 'true' || word === 'false') {
      this.pos += word.length;
      return { kind: 'bool', value: word === 'true' };
    }
    return this.fail(
      `'${word}' is not a literal`,
      'a literal is a number, true, false, an array [1;2;3] or a record (1;true)',
    );
  }

  private aggregate(open: '[' | '('): Lit {
    const close = open === '[' ? ']' : ')';
    this.pos += 1;
    const items: Lit[] = [];
    let separated = false;
    for (;;) {
      this.ws();
      if (this.pos >= this.text.length) return this.fail(`missing '${close}'`);
      if (this.text[this.pos] === close) {
        this.pos += 1;
        break;
      }
      items.push(this.literal());
      separated = this.separator();
    }
    if (items.length === 0) return this.fail(`${open}${close} needs at least one element`);
    if (open === '(' && items.length === 1 && !separated)
      return this.fail(
        'a record of one field is written with a closing separator',
        `write (${formatLit(items[0] as Lit)};)`,
      );
    return { kind: open === '[' ? 'arr' : 'rec', items };
  }
}

export function formatLit(lit: Lit): string {
  switch (lit.kind) {
    case 'u32':
      return String(lit.value);
    case 'bool':
      return lit.value ? 'true' : 'false';
    case 'arr':
      return `[${lit.items.map(formatLit).join(';')}]`;
    case 'rec':
      return lit.items.length === 1
        ? `(${formatLit(lit.items[0] as Lit)};)`
        : `(${lit.items.map(formatLit).join(';')})`;
  }
}

/** The literal that spells `value` of type `type`. */
export function litOf(value: Value, type: Type): Lit {
  if (type === 'bool') return { kind: 'bool', value: value === true };
  if (type === 'u32') return { kind: 'u32', value: value as number };
  const items = value as readonly Value[];
  if (isPrimitive(type)) return { kind: 'u32', value: 0 };
  return type.kind === 'arr'
    ? { kind: 'arr', items: items.map((v) => litOf(v, type.elem)) }
    : { kind: 'rec', items: items.map((v, i) => litOf(v, type.fields[i] as Type)) };
}

/** The interpreter value of a literal of the given type (A0714 when the shapes differ). */
function litValue(lit: Lit, type: Type, fn: string, what: string): Value {
  const mismatch = (): never => {
    throw diag('A0714', [fn, `${what} is ${formatLit(lit)}, which is not a ${formatType(type)}`], {
      expected: formatType(type),
      actual: formatLit(lit),
    });
  };
  if (type === 'u32') return lit.kind === 'u32' ? lit.value : mismatch();
  if (type === 'bool') return lit.kind === 'bool' ? lit.value : mismatch();
  if (type === 'io') return mismatch();
  if (type.kind === 'arr') {
    if (lit.kind !== 'arr' || lit.items.length !== type.length) return mismatch();
    return lit.items.map((l, i) => litValue(l, type.elem, fn, `${what}[${i}]`));
  }
  if (lit.kind !== 'rec' || lit.items.length !== type.fields.length) return mismatch();
  return lit.items.map((l, i) => litValue(l, type.fields[i] as Type, fn, `${what}.${i}`));
}

// ---------------------------------------------------------------------------
// Parsing and printing
// ---------------------------------------------------------------------------

/** The text after `ex`: `ARGS -> RESULT`. */
export function parseExample(
  rest: string,
  fn: string,
  line?: number,
  comments?: Comments,
): SpecExample {
  const s = new Scanner(rest, fn, line);
  const args: Lit[] = [];
  for (;;) {
    if (s.atArrow()) break;
    if (s.done())
      return s.fail(
        'an example needs `->` and its result',
        'write `ex ARGS -> RESULT`, for example `ex 3 4 -> 7`',
      );
    args.push(s.literal());
  }
  s.pos += 2;
  const result = s.literal();
  if (!s.done())
    return s.fail(
      `unexpected '${rest.slice(s.pos).trim()}' after the result`,
      'an example is `ex ARGS -> RESULT` on one line',
    );
  return { args, result, ...(comments === undefined ? {} : { comments }) };
}

/** The text after `pre` or `post`: one node without its id, as `Node` with the id `pre`/`post`. */
export function parseExpression(
  word: 'pre' | 'post',
  rest: string,
  fn: string,
  line?: number,
  comments?: Comments,
): Node {
  if (rest.trim() === '')
    throw specError(
      fn,
      `${word} needs an operation`,
      line,
      `write \`${word} lt p0 100\`: one operation over the parameters${word === 'post' ? ' and r (the result)' : ''}`,
    );
  try {
    const node = parseNode(`${word} ${rest}`, line);
    return comments === undefined ? node : { ...node, comments };
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    throw specError(fn, `${word}: ${e.detail}`, line, e.fix);
  }
}

export function formatExample(ex: SpecExample): string {
  return `ex ${[...ex.args.map(formatLit), '->', formatLit(ex.result)].join(' ')}`;
}

/** The canonical lines of a spec, in order: examples, `pre`, `post`. */
export function specLines(spec: Spec | undefined): string[] {
  if (spec === undefined) return [];
  return [
    ...spec.examples.map(formatExample),
    ...(spec.pre === undefined ? [] : [formatNode(spec.pre)]),
    ...(spec.post === undefined ? [] : [formatNode(spec.post)]),
  ];
}

/** The spec lines with the comments they carry: `[comments, canonical line]` in canonical order. */
export function specLinesWithComments(
  spec: Spec | undefined,
): readonly (readonly [Comments | undefined, string])[] {
  if (spec === undefined) return [];
  return [
    ...spec.examples.map((e) => [e.comments, formatExample(e)] as const),
    ...(spec.pre === undefined ? [] : [[spec.pre.comments, formatNode(spec.pre)] as const]),
    ...(spec.post === undefined ? [] : [[spec.post.comments, formatNode(spec.post)] as const]),
  ];
}

/** Collects the spec lines of one function while it is parsed. */
export class SpecBuilder {
  readonly #examples: SpecExample[] = [];
  #pre: Node | undefined;
  #post: Node | undefined;

  constructor(readonly fn: string) {}

  get empty(): boolean {
    return this.#examples.length === 0 && this.#pre === undefined && this.#post === undefined;
  }

  add(word: SpecWord, rest: string, line?: number, comments?: Comments): void {
    if (word === 'ex') {
      if (this.#examples.length >= SPEC_MAX_EXAMPLES)
        throw specError(
          this.fn,
          `at most ${SPEC_MAX_EXAMPLES} ex lines`,
          line,
          'keep the examples that pin the behavior down and remove the others',
        );
      this.#examples.push(parseExample(rest, this.fn, line, comments));
    } else if (this.#get(word) !== undefined) {
      throw specError(this.fn, `a second ${word} line`, line, `a function has one ${word} line`);
    } else {
      const node = parseExpression(word, rest, this.fn, line, comments);
      if (word === 'pre') this.#pre = node;
      else this.#post = node;
    }
  }

  /** A `pre`/`post` that was parsed elsewhere (the dense spelling of the expression). */
  addNode(word: 'pre' | 'post', node: Node, line?: number): void {
    if (this.#get(word) !== undefined)
      throw specError(this.fn, `a second ${word} line`, line, `a function has one ${word} line`);
    if (word === 'pre') this.#pre = node;
    else this.#post = node;
  }

  #get(word: 'pre' | 'post'): Node | undefined {
    return word === 'pre' ? this.#pre : this.#post;
  }

  build(): Spec | undefined {
    if (this.empty) return undefined;
    return {
      examples: this.#examples,
      ...(this.#pre === undefined ? {} : { pre: this.#pre }),
      ...(this.#post === undefined ? {} : { post: this.#post }),
    };
  }
}

/** `fn` without its spec lines: what the optimizer, the backends and the cache keys see. */
export function withoutSpec<T extends Func>(fn: T): T {
  if (fn.spec === undefined) return fn;
  const { spec: _spec, ...rest } = fn;
  return rest as T;
}

/** `fn` with `spec` as its spec lines (none when `spec` is undefined). */
export function withSpec<T extends Func>(fn: T, spec: Spec | undefined): T {
  const bare = withoutSpec(fn);
  return spec === undefined ? bare : { ...bare, spec };
}

/**
 * One spec line of an edit reply: `+ex ARGS -> RESULT` adds an example (nothing happens when the
 * same one is there), `-ex ARGS -> RESULT` removes the one written so, `+pre EXPR` and
 * `+post EXPR` set the contract line, `-pre` and `-post` remove it (with the line's text after
 * them it must be the line the function has).
 */
export interface SpecEdit {
  readonly sign: '+' | '-';
  readonly word: SpecWord;
  readonly rest: string;
  readonly line?: number;
}

/** The spec of `fn` after the edits, in order (A0714 for a malformed line, A0720 for a missing one). */
export function applySpecEdits(fn: Func, edits: readonly SpecEdit[]): Spec | undefined {
  const examples = [...(fn.spec?.examples ?? [])];
  let pre = fn.spec?.pre;
  let post = fn.spec?.post;
  for (const e of edits) {
    if (e.word === 'ex') {
      const ex = parseExample(e.rest, fn.name, e.line);
      const text = formatExample(ex);
      const at = examples.findIndex((x) => formatExample(x) === text);
      if (e.sign === '+') {
        if (at < 0) examples.push(ex);
      } else if (at < 0) throw diag('A0720', [fn.name, text]);
      else examples.splice(at, 1);
      continue;
    }
    const current = e.word === 'pre' ? pre : post;
    let next: Node | undefined;
    if (e.sign === '+') next = parseExpression(e.word, e.rest, fn.name, e.line);
    else {
      const shown =
        e.rest === '' ? undefined : formatNode(parseExpression(e.word, e.rest, fn.name, e.line));
      if (current === undefined || (shown !== undefined && shown !== formatNode(current)))
        throw diag('A0720', [fn.name, shown ?? e.word]);
    }
    if (e.word === 'pre') pre = next;
    else post = next;
  }
  if (examples.length === 0 && pre === undefined && post === undefined) return undefined;
  return {
    examples,
    ...(pre === undefined ? {} : { pre }),
    ...(post === undefined ? {} : { post }),
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Type a `pre`/`post` node as a bool function of the parameters (and the result, in `post`). */
function typeExpression(
  fn: TypedFunc,
  word: 'pre' | 'post',
  node: Node,
  scope: ReadonlyMap<string, TypedFunc>,
): TypedFunc {
  const params = word === 'post' ? [...fn.params, fn.result] : fn.params;
  const args = node.args.map((a) => {
    if (a.kind !== 'node') return a;
    if (word === 'post' && a.id === 'r') return { kind: 'param' as const, index: fn.params.length };
    throw specError(
      fn.name,
      `${word} uses '${a.id}'`,
      undefined,
      word === 'post'
        ? `${word} sees the parameters p0..p${Math.max(0, fn.params.length - 1)}, literals and r (the result), not the nodes of the function`
        : `${word} sees only the parameters p0..p${Math.max(0, fn.params.length - 1)} and literals; r (the result) is for post`,
    );
  });
  const synthetic: Func = {
    name: fn.name,
    params,
    result: 'bool',
    nodes: [{ ...node, id: word, args }],
    ret: { kind: 'node', id: word },
  };
  try {
    return validateFunction(synthetic, scope, undefined, fn.profile);
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    if (e.id === 'A0201' && e.detail.startsWith(`${fn.name}.ret`))
      throw diag('A0714', [fn.name, `${word} is ${e.actual ?? 'not'}, a ${word} must be bool`], {
        expected: 'bool',
        actual: e.actual ?? '',
        fix: `${word} is one operation whose result is bool (lt, eq, a call of a bool function, ...)`,
      });
    throw specError(fn.name, `${word}: ${e.detail}`, undefined, e.fix);
  }
}

function evaluate(
  fn: TypedFunc,
  typed: TypedFunc,
  args: readonly Value[],
  index: number,
): boolean | { readonly failed: string } {
  try {
    return run(typed, args, { fuel: SPEC_FUEL }) === true;
  } catch (e) {
    if (e instanceof A0Error && e.id === 'A0701')
      throw diag('A0719', [fn.name, `ex ${index}`, SPEC_FUEL]);
    if (e instanceof A0Error)
      return { failed: e.trap === undefined ? e.detail : formatTrap(e.trap) };
    throw e;
  }
}

/**
 * Check the spec of a typed function against the reference interpreter, after its own typing and
 * with its callees (defined above it) in `scope`: types of every line first, then each example in
 * order (the precondition, the result, the postcondition). Throws A0714, A0715, A0716 or A0719.
 */
export function verifySpec(fn: TypedFunc, scope: ReadonlyMap<string, TypedFunc>): void {
  const spec = fn.spec;
  if (spec === undefined) return;
  if ([...fn.params, fn.result].some(containsIo))
    throw specError(
      fn.name,
      'spec lines are not allowed on a function that takes or returns io',
      undefined,
      'remove the spec lines, or move the pure part into a function without io and give that one the spec',
    );
  if (spec.examples.length > SPEC_MAX_EXAMPLES)
    throw specError(fn.name, `at most ${SPEC_MAX_EXAMPLES} ex lines`);
  const pre = spec.pre === undefined ? undefined : typeExpression(fn, 'pre', spec.pre, scope);
  const post = spec.post === undefined ? undefined : typeExpression(fn, 'post', spec.post, scope);
  const signature = `fn ${[fn.name, ...fn.params.map(formatType)].join(' ')} -> ${formatType(fn.result)}`;
  const inputs: Value[][] = [];
  const expected: Value[] = [];
  for (const [k, ex] of spec.examples.entries()) {
    const label = `ex ${k + 1}`;
    if (ex.args.length !== fn.params.length)
      throw specError(
        fn.name,
        `${label} has ${ex.args.length} argument${ex.args.length === 1 ? '' : 's'}, ${fn.name} takes ${fn.params.length}`,
        undefined,
        `write ${fn.params.length} literal${fn.params.length === 1 ? '' : 's'} before the \`->\`: ${signature}`,
      );
    inputs.push(
      ex.args.map((a, i) => litValue(a, fn.params[i] as Type, fn.name, `${label} argument ${i}`)),
    );
    expected.push(litValue(ex.result, fn.result, fn.name, `${label} result`));
  }
  for (const [k, ex] of spec.examples.entries()) {
    const index = k + 1;
    const args = inputs[k] as Value[];
    const input = ex.args.map(formatLit).join(' ');
    if (pre !== undefined) {
      const held = evaluate(fn, pre, args, index);
      if (held !== true)
        throw diag('A0716', [
          fn.name,
          index,
          'pre',
          typeof held === 'object'
            ? `pre cannot be evaluated on the input: ${held.failed}`
            : `the input ${input === '' ? '(none)' : input} does not satisfy pre`,
        ]);
    }
    let actual: Value;
    try {
      actual = run(fn, args, { fuel: SPEC_FUEL });
    } catch (e) {
      if (e instanceof A0Error && e.id === 'A0701')
        throw diag('A0719', [fn.name, `ex ${index}`, SPEC_FUEL]);
      if (!(e instanceof A0Error)) throw e;
      const got = e.trap === undefined ? e.detail : formatTrap(e.trap);
      throw diag('A0715', [fn.name, index, input, formatLit(ex.result), got], {
        expected: formatLit(ex.result),
        actual: got,
      });
    }
    if (!valueEquals(actual, expected[k] as Value)) {
      const got = formatLit(litOf(actual, fn.result));
      throw diag('A0715', [fn.name, index, input, formatLit(ex.result), got], {
        expected: formatLit(ex.result),
        actual: got,
        fix: `if ${fn.name} is right, change the line to \`ex ${[...ex.args.map(formatLit), '->', got].join(' ')}\`; if the example is right, fix ${fn.name}; \`-ex ${[...ex.args.map(formatLit), '->', formatLit(ex.result)].join(' ')}\` removes it`,
      });
    }
    if (post !== undefined) {
      const held = evaluate(fn, post, [...args, actual], index);
      if (held !== true)
        throw diag('A0716', [
          fn.name,
          index,
          'post',
          typeof held === 'object'
            ? `post cannot be evaluated: ${held.failed}`
            : `the input ${input === '' ? '(none)' : input} gives ${formatLit(litOf(actual, fn.result))}, which does not satisfy post`,
        ]);
    }
  }
}
