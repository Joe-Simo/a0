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

import {
  A0Error,
  type DiagnosticCode,
  diag,
  type FixEdit,
  spellingSuggestion,
  type Trap,
  type TrapKind,
} from './diagnostics.js';
import {
  isExampleLine,
  type Spec,
  SpecBuilder,
  specLinesWithComments,
  specWordOf,
  verifySpec,
} from './spec.js';

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
  if (t === 'io') throw diag('A0708');
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
    throw diag('A0707', [fn.name, longest, target, LIMITS.maxVectorArrayLength]);
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
  | 'puts'
  | 'cadd'
  | 'csub'
  | 'cmul'
  | 'cdiv'
  | 'crem'
  | 'cget';

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

/**
 * The total (checked) operations, valid in both profiles: each yields the `(value, ok)` record
 * `(u32,bool)` and never traps. The reference interpreter and every target in
 * `STRICT_TARGETS` evaluate them; every target outside `STRICT_TARGETS` refuses a program that uses one (A0713, `assertTargetSupports`). They are not in
 * `OPS`, the 30 operations the self-hosted front end (compiler/*.a0) knows by number and name;
 * `ALL_OPS` is what the TypeScript parser, the dense form and the editor tools accept.
 */
export const CHECKED_OP_NAMES = ['cadd', 'csub', 'cmul', 'cdiv', 'crem', 'cget'] as const;
export const CHECKED_OPS: ReadonlySet<Op> = new Set<Op>(CHECKED_OP_NAMES);
export const ALL_OPS: readonly Op[] = [...OPS, ...CHECKED_OP_NAMES];

/**
 * The targets that implement the strict profile and the checked ops: `js`, `c` (with its C++ and
 * parallel variants, and the wasm build through clang), `java`, `dotnet`, the direct `wasm` backend
 * and the direct `arm64`, `x86_64`, `riscv64`, `arm32` and `avr` backends.
 */
export const STRICT_TARGETS: ReadonlySet<string> = new Set([
  'js',
  'c',
  'java',
  'dotnet',
  'wasm',
  'arm64',
  'x86_64',
  'riscv64',
  'arm32',
  'avr',
]);

/**
 * Refuse what a target cannot honour. A target outside `STRICT_TARGETS` implements the canonical
 * profile and none of the checked ops, and none may silently run the canonical semantics for a
 * program that depends on a trap or an `(u32,bool)` record: a program with a checked op, or a
 * `profile strict` program with a site that can trap, is a `structure` error (A0713) naming the
 * target and the construct. A strict program whose every index is proved below its length and
 * every divisor proved nonzero has no site: it cannot trap, so it means the same in both
 * profiles and compiles as the canonical program does (`trapSite` is `strictTrapSite` of
 * src/optimize.ts; without it a strict program is always refused). Canonical programs pass untouched.
 */
export function assertTargetSupports(
  target: string,
  p: { readonly profile?: 'strict'; readonly functions: readonly TypedFunc[] },
  trapSite?: (fn: TypedFunc) => string | undefined,
): void {
  if (STRICT_TARGETS.has(target)) return;
  for (const fn of p.functions) {
    const node = fn.nodes.find((n) => CHECKED_OPS.has(n.op));
    if (node !== undefined)
      throw diag('A0713', [target, `the checked op ${node.op} (${fn.name}.${node.id})`]);
  }
  if (p.profile !== 'strict') return;
  if (trapSite === undefined) throw diag('A0713', [target, 'a `profile strict` program']);
  for (const fn of p.functions) {
    const site = trapSite(fn);
    if (site !== undefined)
      throw diag('A0713', [
        target,
        `a \`profile strict\` program with a site that can trap (${site})`,
      ]);
  }
}

/**
 * `program` under the canonical profile: a target outside `STRICT_TARGETS` compiles a strict
 * program only when it has no site that can trap (`assertTargetSupports`), and then it means the
 * same as the canonical program, which is what such a target emits (the same text).
 */
export function withoutProfile(program: TypedProgram): TypedProgram {
  return program.profile === 'strict' ? validate({ functions: program.functions }) : program;
}

/** Operand counts; `call` is variable (the callee's parameter count) and marked -1. */
/** Binary ops whose result does not depend on how a run of operands is grouped. */
const ASSOCIATIVE_OPS: ReadonlySet<string> = new Set(['add', 'mul', 'and', 'or', 'xor']);

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
  cadd: 2,
  csub: 2,
  cmul: 2,
  cdiv: 2,
  crem: 2,
  cget: 2,
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
  /** Source comments on this line; kept by `formatSource`, never part of the canonical form. */
  readonly comments?: Comments;
}

/**
 * `#` comments attached to one source line: whole-line comments directly above it
 * (`leading`, in order) and the comment after its code (`trailing`). Comments carry no
 * meaning: the canonical form (`formatFunction`, `formatProgram`), and so every revision
 * and hash, excludes them; only `formatSource` prints them, so formatting keeps them.
 */
export interface Comments {
  readonly leading?: readonly string[];
  readonly trailing?: string;
}

/** Index of the `#` starting a comment (outside a double-quoted text literal), or -1. */
function commentStart(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && quoted) {
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === '#' && !quoted) {
      return i;
    }
  }
  return -1;
}

/** Remove a `#` comment unless the `#` sits inside a double-quoted text literal. */
export function stripComment(line: string): string {
  const at = commentStart(line);
  return at < 0 ? line : line.slice(0, at);
}

/** The `#` comment of a line (from `#`, trailing whitespace removed), if any. */
export function lineComment(line: string): string | undefined {
  const at = commentStart(line);
  return at < 0 ? undefined : line.slice(at).trimEnd();
}

const TEXT_LINE = /^(\S+)\s+text\s+"((?:[^"\\]|\\.)*)"\s*$/;

function decodeText(raw: string, line?: number): string {
  return raw.replace(/\\(.)/g, (_, c: string) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === '"' || c === '\\') return c;
    throw diag('A0008', [c], line === undefined ? {} : { line });
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
  /** Comments on the `fn` header line (and above it), the `ret` line, and the `end` line. */
  readonly comments?: Comments;
  readonly retComments?: Comments;
  readonly endComments?: Comments;
  /** Whole-line comments after `end` at the end of the file, printed after a blank line. */
  readonly afterComments?: readonly string[];
  /**
   * Spec lines (`ex`, `pre`, `post`) between the header and the first node (src/spec.ts). Part of
   * the canonical text and of `revision()`; no backend, optimizer pass or cache key reads it.
   */
  readonly spec?: Spec;
}

/**
 * The operations profile. `canonical` (the default, never written) is the total, wrapping
 * semantics every target implements: `get`/`set` wrap the index modulo the length, `div` by zero
 * is all ones, `rem` by zero is the dividend, an exhausted `read` yields 0. `strict` (the first
 * line `profile strict`, or `--profile strict`) makes those four cases trap instead; add, sub,
 * mul and the shifts still wrap. The reference interpreter, JS and C implement `strict`.
 */
export type Profile = 'canonical' | 'strict';
export const PROFILES: readonly Profile[] = ['canonical', 'strict'];

/**
 * The edit lines that change the profile (program-level, like `-fn`): `profile strict` sets it,
 * `-profile` restores the canonical default. Both are idempotent; neither belongs to a function body.
 */
export const isProfileEdit = (line: string): boolean => /^(profile\s+strict|-profile)$/.test(line);

/** The profile a program declares: `strict` only when it says so. */
export const profileOf = (p: { readonly profile?: Profile } | undefined): Profile =>
  p?.profile === 'strict' ? 'strict' : 'canonical';

export interface Program {
  readonly functions: readonly Func[];
  /** `profile strict` on the first line; absent means canonical (and is never stored as such). */
  readonly profile?: 'strict';
  /**
   * `use "path"` lines from the head of the file: other A0 files whose functions this one
   * calls. Resolved by the linker (src/link.ts) into one flat program; `validate` on an
   * unlinked program with uses fails on the first unresolved callee.
   */
  readonly uses?: readonly string[];
  /** Comments on the `profile` line. */
  readonly profileComments?: Comments;
  /** Comments on each `use` line, parallel to `uses`. */
  readonly useComments?: readonly (Comments | undefined)[];
  /** Whole-line comments of a file without functions (otherwise the last one's `afterComments`). */
  readonly tailComments?: readonly string[];
}

/** A function whose every node has an inferred result type. */
export interface TypedFunc extends Func {
  /** `strict` when the program it belongs to is; absent means canonical. */
  readonly profile?: 'strict';
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
  /** `strict` when the program declares `profile strict` (or was linked with `--profile strict`). */
  readonly profile?: 'strict';
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

export {
  A0Error,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticDetail,
  type FixEdit,
  formatDiagnostic,
  formatTrap,
  TRAP_FIX,
  type Trap,
  type TrapKind,
} from './diagnostics.js';

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

/** A line of source as the checker compares it: comment removed, whitespace normalised. */
export function normalizeLine(raw: string): string {
  return stripComment(raw).trim().split(/\s+/).join(' ');
}

/** An exact or maybe edit replacing the failing line (matched by its normalised text). */
function lineEdit(rule: string, text: string, to: string, line?: number): FixEdit {
  return {
    op: 'lines',
    rule,
    text: normalizeLine(text),
    to,
    ...(line === undefined ? {} : { line }),
  };
}

/** `lineText` with the first whole word after the first equal to `from` replaced by `to`. */
function replaceWord(lineText: string, from: string, to: string): string {
  const words = normalizeLine(lineText).split(' ');
  const at = words.findIndex((w, i) => i > 0 && w === from);
  if (at >= 0) words[at] = to;
  return words.join(' ');
}

/** `newMin` as `new_min`: the lowercase spelling of a name, or undefined when none exists. */
function lowerName(name: string): string | undefined {
  const out = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  return /^[a-z]/.test(out) && out !== name ? out : undefined;
}

/** The types an unknown type word can be a misspelling of. */
const TYPE_WORDS: readonly string[] = ['u32', 'bool', 'io'];

/**
 * Parse a type. `header` (the whole `fn` line) lets a misspelt type word carry a did-you-mean
 * edit that rewrites it.
 */
export function parseType(text: string, line?: number, header?: string): Type {
  let pos = 0;
  const fail = (msg: string, word?: string): never => {
    let fix: string | undefined;
    let edits: FixEdit[] | undefined;
    if (word !== undefined && word === text) {
      const guess = spellingSuggestion(word, TYPE_WORDS);
      if (guess !== undefined) {
        fix = `did you mean '${guess}'? types are u32, bool, io, arrays u32x4, records (u32,bool)`;
        if (header !== undefined)
          edits = [lineEdit('typo', header, replaceWord(header, word, guess), line)];
      }
    }
    throw diag('A0001', [text, msg], {
      ...(line === undefined ? {} : { line }),
      ...(fix === undefined ? {} : { fix }),
      ...(edits === undefined ? {} : { edits }),
    });
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
      return fail(
        `unexpected '${text[pos] ?? 'end'}'`,
        /^[A-Za-z0-9_]+/.exec(text.slice(pos))?.[0],
      );
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

/**
 * Parse one operand. `lineText` (the whole source line it came from, when known) lets a
 * rewritable spelling carry the edit that fixes it: commas, hexadecimal, uppercase and negative
 * literals.
 */
export function parseOperand(text: string, line?: number, lineText?: string): Operand {
  if (text === 'true') return { kind: 'bool', value: true };
  if (text === 'false') return { kind: 'bool', value: false };
  if (PARAM.test(text)) return { kind: 'param', index: Number(text.slice(1)) };
  if (U32_LITERAL.test(text)) {
    const value = Number(text);
    if (value > U32_MAX) throw diag('A0004', [text], line === undefined ? {} : { line });
    return { kind: 'u32', value };
  }
  if (isValidIdentifier(text)) return { kind: 'node', id: text };
  const at = line === undefined ? {} : { line };
  if (lineText !== undefined) {
    const edit = (rule: string, to: string): FixEdit => lineEdit(rule, lineText, to, line);
    const lower = text.toLowerCase();
    if (text.includes(',') && !text.includes('(')) {
      const to = normalizeLine(lineText.replaceAll(',', ' '));
      throw diag('A0003', [text], {
        ...at,
        fix: `write \`${to}\`: operands are separated by spaces, not commas`,
        applicability: 'exact',
        edits: [edit('comma', to)],
      });
    }
    const hex = /^0x([0-9a-f]+)$/i.exec(text);
    if (hex !== null && Number.parseInt(hex[1] as string, 16) <= U32_MAX) {
      const value = String(Number.parseInt(hex[1] as string, 16));
      throw diag('A0003', [text], {
        ...at,
        fix: `write ${value}: literals are decimal`,
        applicability: 'exact',
        edits: [edit('hex', replaceWord(lineText, text, value))],
      });
    }
    if (
      lower !== text &&
      (lower === 'true' || lower === 'false' || PARAM.test(lower) || isValidIdentifier(lower))
    ) {
      throw diag('A0003', [text], {
        ...at,
        fix: `write '${lower}': operands are lowercase`,
        applicability: 'exact',
        edits: [edit('case', replaceWord(lineText, text, lower))],
      });
    }
    const negative = /^-([0-9]+)$/.exec(text);
    if (negative !== null && Number(negative[1]) >= 1 && Number(negative[1]) <= 2 ** 32) {
      const wrapped = String(2 ** 32 - Number(negative[1]));
      throw diag('A0003', [text], {
        ...at,
        fix: `literals are unsigned: ${text} wraps to ${wrapped} (or use sub); check that is what you meant`,
        edits: [edit('negative', replaceWord(lineText, text, wrapped))],
      });
    }
  }
  throw diag('A0003', [text], at);
}

function isOp(text: string): text is Op {
  return (ALL_OPS as readonly string[]).includes(text);
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
 * Fix for a line with a parenthesised operand, which A0 does not have (one op per line): the
 * inner op on its own line above, then the line using that node. `ret (a, b)` builds a record.
 * `to` is the rewritten text (one or two lines); `exact` when the line has one pair of
 * parentheses, so the rewrite leaves nothing nested.
 */
function nestedFix(
  id: string,
  head: readonly string[],
  rest: readonly string[],
): { fix: string; to: string; exact: boolean } {
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
  const pairs = text.split('(').length - 1 === 1 && text.split(')').length - 1 === 1;
  if (id === 'ret' && text.startsWith('(') && (close < 0 || close === text.length - 1)) {
    const to = `ret ${inner.join(' ')}`;
    return { fix: `write \`${to}\``, to, exact: pairs };
  }
  const t = `${id === 'ret' ? 'r' : id}1`;
  const outer = `${text.slice(0, open)}${t}${close < 0 ? '' : text.slice(close + 1)}`
    .trim()
    .replace(/\s+/g, ' ');
  const first = `${t} ${inner.join(' ')}`;
  const second = [...head, outer].join(' ');
  return {
    fix: `one op per line: write \`${first}\` above, then \`${second}\``,
    to: `${first}\n${second}`,
    exact: pairs && close >= 0,
  };
}

/** The error for a line with a parenthesised operand. */
function nestedError(
  id: string,
  head: readonly string[],
  rest: readonly string[],
  lineText: string,
  line: number | undefined,
  cls: DiagnosticCode,
): A0Error {
  const { fix, to, exact } = nestedFix(id, head, rest);
  const e = diag('A0010', [], {
    ...(line === undefined ? {} : { line }),
    fix,
    ...(exact ? { applicability: 'exact' as const } : {}),
    edits: [lineEdit('nested', lineText, to, line)],
  });
  return cls === e.code ? e : new A0Error(e.detail, e.line, { ...e.detailOf(), code: cls });
}

/** Parse one instruction line `id op operand...` (no validation of references). */
export function parseNode(lineText: string, line?: number): Node {
  const at = line === undefined ? {} : { line };
  const textMatch = TEXT_LINE.exec(lineText.trim());
  if (textMatch !== null) {
    // `id text "..."` desugars to `arr` of UTF-8 byte words; the source form is retained.
    const [, id, raw] = textMatch;
    if (id === undefined || !isValidIdentifier(id)) {
      throw diag('A0005', [id ?? ''], at);
    }
    const text = decodeText(raw ?? '', line);
    const bytes = new TextEncoder().encode(text);
    if (bytes.length === 0) throw diag('A0006', [], at);
    if (bytes.length > LIMITS.maxArrayLength) {
      throw diag('A0007', [LIMITS.maxArrayLength], at);
    }
    return { id, op: 'arr', args: [...bytes].map((value) => ({ kind: 'u32', value })), text };
  }
  const parts = lineText.trim().split(/\s+/);
  const [id, word, ...rest] = parts;
  if (id === undefined || word === undefined) throw diag('A0009', [], at);
  const operand = (r: string): Operand => parseOperand(r, line, lineText);
  if (!isValidIdentifier(id)) {
    const colon = id.endsWith(':') && isValidIdentifier(id.slice(0, -1));
    const snake = lowerName(id);
    throw diag('A0005', [id], {
      ...at,
      ...(colon
        ? {
            fix: `write '${id.slice(0, -1)}': a node id has no colon`,
            applicability: 'exact' as const,
            edits: [lineEdit('colon', lineText, [id.slice(0, -1), word, ...rest].join(' '), line)],
          }
        : snake !== undefined && isValidIdentifier(snake)
          ? {
              fix: `write '${snake}' and use it everywhere: ids are lowercase letters, numbers and _`,
            }
          : {}),
    });
  }
  if (rest.some((r) => r.startsWith('(') || r.endsWith(')')))
    throw nestedError(id, [id, word], rest, lineText, line, 'parse');
  // `id F args…` with F a function name (not an op) is the direct form of `id call F args…`.
  if (isDirectCallee(word)) return { id, op: 'call', callee: word, args: rest.map(operand) };
  const op = opOf(word);
  if (op === undefined) {
    const lower = word.toLowerCase();
    const assign = word === '=' && rest.length > 0;
    const caseFix = lower !== word && (opOf(lower) !== undefined || isDirectCallee(lower));
    throw diag('A0011', [word], {
      ...at,
      ...(assign
        ? {
            fix: `write \`${[id, ...rest].join(' ')}\`: there is no \`=\`, the op follows the id`,
            applicability: 'exact' as const,
            edits: [lineEdit('assign', lineText, [id, ...rest].join(' '), line)],
          }
        : caseFix
          ? {
              fix: `write '${lower}': ops and function names are lowercase`,
              applicability: 'exact' as const,
              edits: [lineEdit('case', lineText, replaceWord(lineText, word, lower), line)],
            }
          : {
              fix: `use one of ${OPS.join(' ')}, or call a function F defined above: \`${id} F args…\``,
            }),
    });
  }
  if (op === 'loop') {
    const [pred, callee, ...args] = rest;
    if (
      pred === undefined ||
      !isValidFunctionName(pred) ||
      callee === undefined ||
      !isValidFunctionName(callee)
    ) {
      throw diag('A0012', [], at);
    }
    return { id, op, pred, callee, args: args.map(operand) };
  }
  if (op === 'call' || op === 'fold') {
    const [callee, ...args] = rest;
    if (callee === undefined || !isValidFunctionName(callee)) {
      const lower = (callee ?? '').toLowerCase();
      const caseFix = callee !== undefined && lower !== callee && isValidFunctionName(lower);
      throw diag('A0013', [op, callee ?? ''], {
        ...at,
        ...(caseFix
          ? {
              fix: `write '${lower}': function names are lowercase`,
              applicability: 'exact' as const,
              edits: [lineEdit('case', lineText, replaceWord(lineText, callee, lower), line)],
            }
          : {}),
      });
    }
    return { id, op, callee, args: args.map(operand) };
  }
  if (OP_ARITY[op] >= 0 && rest.length !== OP_ARITY[op]) {
    // an associative binary op written with more operands: show the chain that says it
    const chain =
      OP_ARITY[op] === 2 && rest.length > 2 && ASSOCIATIVE_OPS.has(op)
        ? `write exactly 2 operands after ${op}; to combine ${rest.length} operands chain two at a time: ${rest
            .slice(1)
            .map(
              (r, i) =>
                `${id}${i === rest.length - 2 ? '' : `t${i}`} ${op} ${i === 0 ? rest[0] : `${id}t${i - 1}`} ${r}`,
            )
            .join(', then ')}`
        : undefined;
    throw diag('A0014', [op, OP_ARITY[op], rest.length], {
      ...at,
      expected: String(OP_ARITY[op]),
      actual: String(rest.length),
      ...(chain === undefined ? {} : { fix: chain }),
    });
  }
  if (OP_ARITY[op] < 0 && rest.length === 0) throw diag('A0015', [op], at);
  return { id, op, args: rest.map(operand) };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse A0 source text. Blank lines are discarded; comments (`#` to end of line) are kept
 * on the line they belong to (see `Comments`) for `formatSource` and never affect meaning.
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
  if (nested) return nestedError('ret', ['ret'], rest, parts.join(' '), line, code);
  const e = diag('A0030', [], line === undefined ? {} : { line });
  return code === e.code ? e : new A0Error(e.detail, e.line, { ...e.detailOf(), code });
}

export function parse(source: string): Program {
  if (utf8Length(source) > LIMITS.maxSourceBytes) {
    throw diag('A0016', [LIMITS.maxSourceBytes]);
  }
  const lines = source.split(/\r?\n/);
  const functions: Func[] = [];
  const names = new Set<string>();
  let i = 0;
  let pending: string[] = [];
  const next = (): { text: string; line: number; comments?: Comments } | undefined => {
    while (i < lines.length) {
      const raw = lines[i] ?? '';
      i += 1;
      const text = stripComment(raw).trim();
      const comment = lineComment(raw);
      if (text.length === 0) {
        if (comment !== undefined) pending.push(comment);
        continue;
      }
      const leading = pending;
      pending = [];
      const comments = commentsOf(leading, comment);
      return comments === undefined ? { text, line: i } : { text, line: i, comments };
    }
    return undefined;
  };

  const uses: string[] = [];
  const useComments: (Comments | undefined)[] = [];
  let profile: 'strict' | undefined;
  let profileComments: Comments | undefined;
  let first = true;
  for (let cur = next(); cur !== undefined; cur = next()) {
    const head = cur.text.split(/\s+/);
    const atStart = first;
    first = false;
    if (head[0] === 'profile') {
      if (!atStart || head.length !== 2 || head[1] !== 'strict')
        throw diag('A0031', [], { line: cur.line });
      profile = 'strict';
      profileComments = cur.comments;
      continue;
    }
    if (head[0] === 'use') {
      const m = /^use\s+"([^"\\]+)"$/.exec(cur.text);
      if (m === null || functions.length > 0) throw diag('A0017', [], { line: cur.line });
      uses.push(m[1] as string);
      useComments.push(cur.comments);
      continue;
    }
    if (head[0] !== 'fn') throw diag('A0018', [head[0] ?? ''], { line: cur.line });
    const name = head[1];
    if (name === undefined || !isValidFunctionName(name)) {
      const snake = lowerName(name ?? '');
      throw diag('A0019', [name ?? ''], {
        line: cur.line,
        ...(snake !== undefined && isValidFunctionName(snake)
          ? {
              fix: `write '${snake}' and use it everywhere: names are lowercase letters, numbers and _`,
            }
          : {}),
      });
    }
    if (names.has(name)) throw diag('A0020', [name], { line: cur.line });
    const arrow = head.indexOf('->');
    if (arrow < 2 || arrow !== head.length - 2) {
      throw diag('A0023', [], { line: cur.line });
    }
    const params = head.slice(2, arrow).map((t) => parseType(t, cur.line, cur.text));
    if (params.length > LIMITS.maxParams) throw diag('A0024', [], { line: cur.line });
    const result = parseType(head[arrow + 1] ?? '', cur.line, cur.text);

    const header = cur.comments;
    const nodes: Node[] = [];
    let ret: Operand | undefined;
    let retComments: Comments | undefined;
    let endComments: Comments | undefined;
    let closed = false;
    const specs = new SpecBuilder(name);
    for (let body = next(); body !== undefined; body = next()) {
      const first = body.text.split(/\s+/)[0];
      // Spec lines stand between the header and the first node (or `ret`).
      if (nodes.length === 0 && ret === undefined) {
        const word = specWordOf(body.text);
        if (word !== undefined) {
          specs.add(word, body.text.slice(word.length).trim(), body.line, body.comments);
          continue;
        }
      } else if (isExampleLine(body.text)) {
        // An example after the first node is unambiguous (the arrow); it joins the others under the
        // header, so the canonical text is the same whichever place the writer chose.
        specs.add('ex', body.text.slice(2).trim(), body.line, body.comments);
        continue;
      }
      if (first === 'ret') {
        retComments = body.comments;
        const parts = body.text.split(/\s+/);
        if (isRetNodeForm(parts)) {
          // `ret OP ARGS…` is sugar for a fresh node followed by `ret` of it.
          const id = freshRetId(nodes);
          try {
            nodes.push(parseNode(`${id} ${parts.slice(1).join(' ')}`, body.line));
          } catch (e) {
            // The failing line is the synthesised `retval OP …`, not the source line: no edits.
            throw e instanceof A0Error && e.edits.length > 0 ? e.withEdits([], 'maybe') : e;
          }
          ret = { kind: 'node', id };
        } else {
          if (parts.length !== 2) throw retOperandError(parts, body.line, 'parse');
          ret = parseOperand(parts[1] ?? '', body.line, body.text);
        }
        const endLine = next();
        if (endLine === undefined || endLine.text !== 'end') {
          // A missing `end` before the next function (or the end of the file) is added.
          const addable = endLine === undefined || endLine.text.split(/\s+/)[0] === 'fn';
          throw diag('A0025', [], {
            line: endLine?.line ?? body.line,
            ...(addable
              ? {
                  applicability: 'exact' as const,
                  edits: [
                    lineEdit('end', body.text, `${normalizeLine(body.text)}\nend`, body.line),
                  ],
                }
              : {}),
          });
        }
        endComments = endLine.comments;
        closed = true;
        break;
      }
      if (first === 'end' || first === 'fn') {
        throw diag('A0026', [first], { line: body.line });
      }
      if (nodes.length >= LIMITS.maxNodesPerFunction) {
        throw diag('A0027', [], { line: body.line });
      }
      const node = parseNode(body.text, body.line);
      nodes.push(body.comments === undefined ? node : { ...node, comments: body.comments });
    }
    if (!closed || ret === undefined) throw diag('A0028', [name]);
    if (functions.length >= LIMITS.maxFunctions) throw diag('A0029');
    names.add(name);
    const spec = specs.build();
    functions.push({
      name,
      params,
      result,
      nodes,
      ret,
      ...(spec === undefined ? {} : { spec }),
      ...(header === undefined ? {} : { comments: header }),
      ...(retComments === undefined ? {} : { retComments }),
      ...(endComments === undefined ? {} : { endComments }),
    });
  }
  // Comments after the last `end` travel with the last function, so edits that rebuild the
  // program keep them.
  const last = functions[functions.length - 1];
  if (last !== undefined && pending.length > 0)
    functions[functions.length - 1] = { ...last, afterComments: pending };
  return {
    functions,
    ...(profile === undefined ? {} : { profile }),
    ...(profileComments === undefined ? {} : { profileComments }),
    uses,
    ...(useComments.some((c) => c !== undefined) ? { useComments } : {}),
    ...(last === undefined && pending.length > 0 ? { tailComments: pending } : {}),
  };
}

function commentsOf(
  leading: readonly string[],
  trailing: string | undefined,
): Comments | undefined {
  if (leading.length === 0 && trailing === undefined) return undefined;
  return {
    ...(leading.length > 0 ? { leading } : {}),
    ...(trailing === undefined ? {} : { trailing }),
  };
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
      if (t === undefined) {
        const n = fn.params.length;
        const sig = `a \`fn ${fn.name} ...\` block with the parameter in its signature`;
        throw diag('A0105', [where, operand.index], {
          fix:
            n === 0
              ? `${fn.name} has no parameters: add them with ${sig}`
              : `${fn.name} has ${n} parameter${n === 1 ? '' : 's'} (p0..p${n - 1}): use one of them, or add the parameter with ${sig}`,
        });
      }
      return t;
    }
    case 'node': {
      if (!defined.has(operand.id)) {
        const node = where.slice(fn.name.length + 1);
        const later = fn.nodes.some((n) => n.id === operand.id);
        const guess = later ? undefined : spellingSuggestion(operand.id, defined);
        throw diag('A0101', [where, operand.id], {
          ...(later
            ? {
                fix: `'${operand.id}' is defined on a later line of ${fn.name}: move it above ${where}`,
              }
            : guess === undefined
              ? {}
              : {
                  fix: `did you mean '${guess}'?`,
                  edits: [
                    { op: 'rename', rule: 'typo', fn: fn.name, node, from: operand.id, to: guess },
                  ],
                }),
        });
      }
      const t = types.get(operand.id);
      if (t === undefined) throw diag('A0792', [where, operand.id]);
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
    throw diag('A0201', [where, formatType(wanted), formatType(actual)], {
      expected: formatType(wanted),
      actual: formatType(actual),
    });
  }
}

/** The declared result type disagrees with what `ret` returns: change the value or the signature. */
function expectResult(fn: Func, actual: Type): void {
  if (typeEquals(actual, fn.result)) return;
  const wanted = formatType(fn.result);
  const got = formatType(actual);
  const sig = `fn ${[fn.name, ...fn.params.map(formatType)].join(' ')} -> ${got}`;
  const bool =
    actual === 'bool' && fn.result === 'u32' ? ' (`select c 1 0` turns a bool c into a u32)' : '';
  throw diag('A0201', [`${fn.name}.ret`, wanted, got], {
    expected: wanted,
    actual: got,
    fix: `return a ${wanted} value${bool}, or change the declared result: send the function with its header as \`${sig}\``,
  });
}

/** Infer the result type of an operation given operand types; throws on mismatch. */
export function resultType(op: Op, argTypes: readonly Type[], where: string): Type {
  const a = argTypes[0];
  const b = argTypes[1];
  const c = argTypes[2];
  if (a === undefined) throw diag('A0202', [where]);
  switch (op) {
    case 'mov':
      return a;
    case 'and':
    case 'or':
    case 'xor':
      // Bitwise on u32, logical on bool: both operands must share the type.
      if (b === undefined) throw diag('A0202', [where]);
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
      if (b === undefined) throw diag('A0202', [where]);
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return 'u32';
    case 'eq':
    case 'ne':
      if (b === undefined) throw diag('A0202', [where]);
      if (a === 'bool') {
        if (typeEquals(b, 'u32')) {
          // A bool compared with a number (`eq c 1`): A0 has no truthiness, so say how to write it.
          throw diag('A0201', [where, 'bool', 'u32'], {
            expected: 'bool',
            actual: 'u32',
            fix: `a bool is compared only with a bool: for \`${op} C 1\` use the bool C itself (or \`${op} C true\`), and turn a u32 X into a bool with \`ne X 0\``,
          });
        }
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
      if (b === undefined) throw diag('A0202', [where]);
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return 'bool';
    case 'select':
      if (b === undefined || c === undefined) throw diag('A0202', [where]);
      if (typeEquals(a, 'u32')) {
        // A u32 condition (`c and p1 1` then `select c …`): A0 has no truthiness.
        throw diag('A0201', [where, 'bool', 'u32'], {
          expected: 'bool',
          actual: 'u32',
          fix: 'the select condition is a bool and A0 has no truthiness: for a u32 X write `t ne X 0` above (true when X is nonzero) and select on t',
        });
      }
      expect(a, 'bool', where);
      if (!typeEquals(b, c)) {
        throw diag('A0203', [where, formatType(b), formatType(c)]);
      }
      if (containsIo(b)) throw diag('A0204', [where]);
      return b;
    case 'arr': {
      for (const [i, t] of argTypes.entries()) expect(t, a, `${where} element ${i}`);
      if (containsIo(a)) throw diag('A0205', [where]);
      const t: Type = { kind: 'arr', length: argTypes.length, elem: a };
      if (bitWidth(t) > LIMITS.maxAggregateBits) throw diag('A0206', [where]);
      return t;
    }
    case 'rec': {
      const t: Type = { kind: 'rec', fields: [...argTypes] };
      if (argTypes.filter(containsIo).length > 1) throw diag('A0207', [where]);
      if (!containsIo(t) && bitWidth(t) > LIMITS.maxAggregateBits) throw diag('A0206', [where]);
      return t;
    }
    case 'read':
      expect(a, 'io', `${where} token`);
      return { kind: 'rec', fields: ['u32', 'io'] };
    case 'write':
      if (b === undefined) throw diag('A0202', [where]);
      expect(a, 'io', `${where} token`);
      expect(b, 'u32', `${where} value`);
      return 'io';
    case 'puts':
      if (b === undefined) throw diag('A0202', [where]);
      expect(a, 'io', `${where} token`);
      if (isPrimitive(b) || b.kind !== 'arr' || b.elem !== 'u32') {
        throw diag('A0208', [where, formatType(b)]);
      }
      return 'io';
    case 'cadd':
    case 'csub':
    case 'cmul':
    case 'cdiv':
    case 'crem':
      if (b === undefined) throw diag('A0202', [where]);
      expect(a, 'u32', where);
      expect(b, 'u32', where);
      return { kind: 'rec', fields: ['u32', 'bool'] };
    case 'cget':
      if (b === undefined) throw diag('A0202', [where]);
      if (isPrimitive(a) || a.kind !== 'arr' || a.elem !== 'u32')
        throw diag('A0209', [where, formatType(a)], {
          fix: 'cget reads an array of u32: `cget A I` gives (value, in-range)',
        });
      expect(b, 'u32', `${where} index`);
      return { kind: 'rec', fields: ['u32', 'bool'] };
    case 'get':
      if (b === undefined) throw diag('A0202', [where]);
      if (isPrimitive(a) || a.kind !== 'arr')
        throw diag('A0209', [where, formatType(a)], {
          ...(!isPrimitive(a) && a.kind === 'rec'
            ? { fix: 'records use at with a literal field index: `at R K` (get is for arrays)' }
            : {}),
        });
      expect(b, 'u32', `${where} index`);
      return a.elem;
    case 'set':
      if (b === undefined || c === undefined) throw diag('A0202', [where]);
      if (isPrimitive(a) || a.kind !== 'arr')
        throw diag('A0210', [where, formatType(a)], {
          ...(!isPrimitive(a) && a.kind === 'rec'
            ? { fix: 'records use put with a literal field index: `put R K V` (set is for arrays)' }
            : {}),
        });
      expect(b, 'u32', `${where} index`);
      expect(c, a.elem, `${where} element`);
      return a;
    case 'at':
    case 'put':
      throw diag('A0211', [where, op]);
    case 'call':
    case 'fold':
    case 'loop':
      throw diag('A0212', [where, op]);
  }
}

/** The error for a fold body or loop predicate naming a function that is not defined above. */
function unknownFunction(
  id: 'A0103' | 'A0104',
  where: string,
  fn: Func,
  node: Node,
  name: string,
  scope: ReadonlyMap<string, TypedFunc>,
  later: ReadonlySet<string> | undefined,
  args: readonly (string | number)[],
): A0Error {
  const guess = spellingSuggestion(name, scope.keys());
  const below = later?.has(name) === true;
  return diag(id, [where, ...args], {
    ...(below
      ? {
          fix: `'${name}' is defined below ${fn.name}: callees must be defined above their callers, so move '${name}' above ${fn.name}`,
        }
      : guess === undefined
        ? {
            fix: `'${name}' is no function defined above ${fn.name}: add a \`fn ${name} ...\` block that defines it (callees come first; a fold or loop body takes the state and the u32 step index), or name an existing function`,
          }
        : {
            fix: `did you mean '${guess}'?`,
            edits: [
              { op: 'rename', rule: 'typo', fn: fn.name, node: node.id, from: name, to: guess },
            ],
          }),
  });
}

/**
 * Validate one function. `scope` holds the functions defined earlier in the program
 * (the only legal call targets); a function cannot call itself or a later function. `later`
 * (the names defined after it) only sharpens the fix of an unknown callee.
 */
export function validateFunction(
  fn: Func,
  scope: ReadonlyMap<string, TypedFunc> = new Map(),
  later?: ReadonlySet<string>,
  profile?: 'strict',
): TypedFunc {
  if (!isValidFunctionName(fn.name)) throw diag('A0301', [fn.name]);
  if (fn.params.length > LIMITS.maxParams) throw diag('A0315', [fn.name]);
  if (fn.nodes.length > LIMITS.maxNodesPerFunction) throw diag('A0316', [fn.name]);
  const types = new Map<string, Type>();
  const defined = new Set<string>();
  const calls = new Map<string, TypedFunc>();
  const consumed = new Set<string>();
  /** Records whose io-carrying field (the value) was taken out by `at`. */
  const taken = new Map<string, number>();
  let staticIterations = 1;
  let literalIterations = 1;
  if (fn.params.filter(containsIo).length > 1) {
    throw diag('A0309', [fn.name]);
  }
  for (const node of fn.nodes) {
    const where = `${fn.name}.${node.id}`;
    if (!isValidIdentifier(node.id)) throw diag('A0302', [where]);
    if (defined.has(node.id)) throw diag('A0303', [where]);
    const hasCallee = node.op === 'call' || node.op === 'fold' || node.op === 'loop';
    if (hasCallee !== (node.callee !== undefined)) {
      throw diag('A0304', [where]);
    }
    if ((node.op === 'loop') !== (node.pred !== undefined)) {
      throw diag('A0305', [where]);
    }
    if (!hasCallee && OP_ARITY[node.op] >= 0 && node.args.length !== OP_ARITY[node.op]) {
      throw diag('A0306', [where]);
    }
    if (OP_ARITY[node.op] < 0 && !hasCallee && node.args.length === 0) {
      throw diag('A0307', [where, node.op]);
    }
    const argTypes = node.args.map((arg) => operandType(arg, fn, types, defined, where));
    for (const arg of node.args) {
      if (
        arg.kind === 'u32' &&
        (!Number.isInteger(arg.value) || arg.value < 0 || arg.value > U32_MAX)
      ) {
        throw diag('A0308', [where]);
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
        if (consumed.has(key)) throw diag('A0310', [where, key]);
        if (taken.has(key))
          throw diag('A0311', [where, taken.get(key) as number, key], {
            fix: `use the value that \`at\` returned, or put a token back first with \`put ${key} ${taken.get(key)} <io>\``,
          });
        taken.set(key, field);
        continue;
      }
      if (consumed.has(key)) throw diag('A0310', [where, key]);
      const out = taken.get(key);
      if (out !== undefined && !(node.op === 'put' && k === 0 && field === out))
        throw diag('A0312', [where, key, out], {
          fix: `read the other fields first, or put the token back with \`put ${key} ${out} <io>\` and use that record`,
        });
      consumed.add(key);
    }
    if (node.op === 'at' || node.op === 'put') {
      const [recT, idx] = argTypes;
      const index = node.args[1];
      if (recT === undefined || isPrimitive(recT) || recT.kind !== 'rec') {
        throw diag('A0220', [where, node.op, recT === undefined ? 'nothing' : formatType(recT)], {
          ...(recT !== undefined && !isPrimitive(recT) && recT.kind === 'arr'
            ? {
                fix: `arrays use ${node.op === 'at' ? 'get: `get A I`' : 'set: `set A I V`'} (${node.op} is for records)`,
                // `at`/`put` on an array has one meaning: `get`/`set` at that index (the index wraps by the length).
                applicability: 'exact' as const,
                edits: [
                  lineEdit(
                    'array-op',
                    formatNode(node),
                    formatNode({ ...node, op: node.op === 'at' ? 'get' : 'set' }),
                  ),
                ],
              }
            : {}),
        });
      }
      if (index === undefined || index.kind !== 'u32' || idx !== 'u32') {
        throw diag('A0221', [where, node.op]);
      }
      const field = recT.fields[index.value];
      if (field === undefined) throw diag('A0222', [where, index.value, formatType(recT)]);
      if (node.op === 'put') expect(argTypes[2] as Type, field, `${where} field value`);
      types.set(node.id, node.op === 'at' ? field : recT);
    } else if (node.op === 'call') {
      const callee = scope.get(node.callee ?? '');
      if (callee === undefined) {
        const name = node.callee ?? '';
        // `a mod x y` is `a rem x y`: every A0 number is a u32, where remainder and modulo agree.
        // Exact when the line is that two-operand op and no operand is a node of the same name.
        if (
          (name === 'mod' || name === 'umod') &&
          later?.has(name) !== true &&
          node.args.length === 2 &&
          node.args.every((a) => a.kind !== 'node' || a.id !== name)
        ) {
          throw diag('A0102', [where, name], {
            fix: `write \`${node.id} rem …\`: the remainder op is \`rem\` (on u32 it is the modulo)`,
            applicability: 'exact',
            edits: [
              { op: 'rename', rule: 'mod', fn: fn.name, node: node.id, from: name, to: 'rem' },
            ],
          });
        }
        const guess = spellingSuggestion(name, [
          ...OPS,
          ...Object.keys(OP_ALIASES),
          ...scope.keys(),
        ]);
        throw diag('A0102', [where, name], {
          fix:
            later?.has(name) === true
              ? `'${name}' is defined below ${fn.name}: callees must be defined above their callers, so move '${name}' above ${fn.name}`
              : guess !== undefined
                ? `did you mean '${guess}'?`
                : `'${name}' is neither an op nor a function defined above ${fn.name}: define it above, or use one of ${OPS.join(' ')}; rarely needed: text "s", loop P F n s a... (F while P(state,i,a...) holds, at most n times), io values are one linear token used once: read t -> (u32,io), write t v -> io, puts t a -> io`,
          ...(guess === undefined || later?.has(name) === true
            ? {}
            : {
                edits: [
                  {
                    op: 'rename',
                    rule: 'typo',
                    fn: fn.name,
                    node: node.id,
                    from: name,
                    to: guess,
                  },
                ],
              }),
        });
      }
      if (argTypes.length !== callee.params.length) {
        throw diag('A0219', [where, callee.name, callee.params.length, argTypes.length]);
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
        const name = node.callee ?? '';
        throw unknownFunction('A0103', where, fn, node, name, scope, later, [node.op, name]);
      }
      // fold f n s a...  with f : (T, u32, A...) -> T
      // loop p f n s a... additionally p : (T, u32, A...) -> bool with identical parameters
      const [count, init, ...extra] = argTypes;
      if (count === undefined || init === undefined) {
        throw diag('A0216', [where]);
      }
      expect(count, 'u32', `${where} trip count`);
      // Every body mismatch names the step's expected header and the call shape it implies.
      const bodyFix = foldBodyFix(node.op, callee, init, extra);
      const expectBody = (actual: Type, wanted: Type, what: string): void => {
        if (!typeEquals(actual, wanted))
          throw diag('A0213', [where, what, formatType(wanted), formatType(actual)], {
            expected: formatType(wanted),
            actual: formatType(actual),
            fix: bodyFix,
          });
      };
      const [stateT, indexT, ...extraT] = callee.params;
      if (stateT === undefined || indexT === undefined)
        throw diag('A0214', [where, callee.name], { fix: bodyFix });
      expectBody(indexT, 'u32', 'body index parameter');
      expectBody(init, stateT, 'initial state');
      expectBody(callee.result, stateT, 'body result');
      if (extra.length !== extraT.length)
        throw diag('A0215', [where, callee.name, extraT.length, extra.length], { fix: bodyFix });
      for (const [i, t] of extraT.entries()) expectBody(extra[i] as Type, t, `extra argument ${i}`);
      calls.set(callee.name, callee);
      if (node.op === 'loop') {
        const pred = scope.get(node.pred ?? '');
        if (pred === undefined) {
          const name = node.pred ?? '';
          throw unknownFunction('A0104', where, fn, node, name, scope, later, [name]);
        }
        expect(pred.result, 'bool', `${where} predicate result`);
        if (
          pred.params.length !== callee.params.length ||
          pred.params.some((t, i) => !typeEquals(t, callee.params[i] as Type))
        ) {
          throw diag('A0217', [where, pred.name, callee.name]);
        }
        calls.set(pred.name, pred);
      }
      const countOp = node.args[0];
      const trips = countOp?.kind === 'u32' ? countOp.value : 2 ** 32;
      staticIterations = Math.max(staticIterations, trips * callee.staticIterations);
      if (countOp?.kind === 'u32') {
        literalIterations = Math.max(literalIterations, trips * callee.literalIterations);
        if (literalIterations > LIMITS.maxStaticIterations) {
          throw diag('A0218', [where, literalIterations, LIMITS.maxStaticIterations]);
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
  expectResult(fn, retType);
  if (containsIo(retType)) {
    const key =
      fn.ret.kind === 'param' ? `p${fn.ret.index}` : fn.ret.kind === 'node' ? fn.ret.id : '';
    if (consumed.has(key)) throw diag('A0314', [fn.name, key]);
    if (taken.has(key))
      throw diag('A0313', [fn.name, key, taken.get(key) as number], {
        fix: `return the record with the token put back: \`put ${key} ${taken.get(key)} <io>\``,
      });
  }
  // The profile comes from the program being validated, never from an earlier typing of `fn`.
  const { profile: _earlier, ...base } = fn as Func & { profile?: 'strict' };
  return {
    ...base,
    ...(profile === 'strict' ? { profile } : {}),
    types,
    calls,
    staticIterations,
    literalIterations,
  };
}

/**
 * What a successful validation of a function read: every function it resolved by name (its
 * callees, and the callees of its `pre` and `post`) and the profile it was typed under. A typed
 * function is a pure result of its own text and of these; `validate` reuses it by identity when
 * all of them are the very objects the new program resolves.
 */
interface TypingInputs {
  readonly profile: 'strict' | undefined;
  readonly deps: ReadonlyMap<string, TypedFunc>;
}

/** Only objects `validate` itself produced are here: a spread copy of a typed function is not. */
const typingInputs = new WeakMap<TypedFunc, TypingInputs>();

function specCallees(fn: Func): string[] {
  const out: string[] = [];
  for (const n of [fn.spec?.pre, fn.spec?.post]) {
    if (n === undefined) continue;
    if (n.callee !== undefined) out.push(n.callee);
    if (n.pred !== undefined) out.push(n.pred);
  }
  return out;
}

let reuseEnabled = true;

/**
 * Run `run` with `validate` reusing nothing: every function is typed again, as before validation was
 * incremental. The reference for the differential tests and the baseline of tools/edit-incremental.ts.
 */
export function withoutReuse<T>(run: () => T): T {
  const was = reuseEnabled;
  reuseEnabled = false;
  try {
    return run();
  } finally {
    reuseEnabled = was;
  }
}

/** The typed result of `fn` from an earlier validation, if it is still exactly what validating it here gives. */
function reusable(
  fn: Func,
  scope: ReadonlyMap<string, TypedFunc>,
  profile: 'strict' | undefined,
): TypedFunc | undefined {
  if (!reuseEnabled) return undefined;
  const typed = fn as TypedFunc;
  const inputs = typingInputs.get(typed);
  if (inputs === undefined || inputs.profile !== profile) return undefined;
  for (const [name, callee] of inputs.deps) if (scope.get(name) !== callee) return undefined;
  return typed;
}

/**
 * Validate a whole program. Incremental by identity: a function that is a typed result of an
 * earlier `validate` (an edit passes every unchanged function back as it received it), under the
 * same profile, whose every resolved callee is the same object in this program, is reused as is;
 * only the functions whose text changed and the functions that (transitively) call them are typed
 * again. The result, and the first diagnostic of a program that fails, equal a validation from scratch.
 */
export function validate(program: Program): TypedProgram {
  if (program.functions.length > LIMITS.maxFunctions) throw diag('A0029');
  const byName = new Map<string, TypedFunc>();
  const functions: TypedFunc[] = [];
  const profile = program.profile === 'strict' ? 'strict' : undefined;
  let names: string[] | undefined;
  for (const [k, fn] of program.functions.entries()) {
    if (byName.has(fn.name)) throw diag('A0021', [fn.name]);
    const kept = reusable(fn, byName, profile);
    if (kept !== undefined) {
      byName.set(fn.name, kept);
      functions.push(kept);
      continue;
    }
    names ??= program.functions.map((f) => f.name);
    const typed = validateFunction(fn, byName, new Set(names.slice(k + 1)), profile);
    // Spec lines are checked once the function is typed, against its callees (all above it).
    if (typed.spec !== undefined) verifySpec(typed, byName);
    const deps = new Map(typed.calls);
    for (const name of specCallees(typed)) {
      const callee = byName.get(name);
      if (callee !== undefined) deps.set(name, callee);
    }
    typingInputs.set(typed, { profile, deps });
    byName.set(fn.name, typed);
    functions.push(typed);
  }
  return {
    ...(program.profile === 'strict' ? { profile: program.profile } : {}),
    functions,
    byName,
  };
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
  const spec = specLinesWithComments(fn.spec)
    .map(([, line]) => line)
    .join('\n');
  const body = fn.nodes.map(formatNode).join('\n');
  return `fn ${fn.name}${sig} -> ${formatType(fn.result)}\n${spec}${spec ? '\n' : ''}${body}${body ? '\n' : ''}ret ${formatOperand(fn.ret)}\nend`;
}

export function formatProgram(program: Program): string {
  // The directive is part of the canonical form, so a strict program has a different hash.
  const head = program.profile === 'strict' ? 'profile strict\n\n' : '';
  return `${head}${program.functions.map(formatFunction).join('\n\n')}\n`;
}

/** One source line with its comments: leading lines above it, trailing after one space. */
function withComments(line: string, comments: Comments | undefined): string {
  if (comments === undefined) return line;
  const above = (comments.leading ?? []).map((c) => `${c}\n`).join('');
  return `${above}${line}${comments.trailing === undefined ? '' : ` ${comments.trailing}`}`;
}

/** A function in canonical form with its source comments in place. */
export function formatFunctionSource(fn: Func): string {
  const sig = fn.params.length > 0 ? ` ${fn.params.map(formatType).join(' ')}` : '';
  return [
    withComments(`fn ${fn.name}${sig} -> ${formatType(fn.result)}`, fn.comments),
    ...specLinesWithComments(fn.spec).map(([comments, line]) => withComments(line, comments)),
    ...fn.nodes.map((n) => withComments(formatNode(n), n.comments)),
    withComments(`ret ${formatOperand(fn.ret)}`, fn.retComments),
    withComments('end', fn.endComments),
    ...(fn.afterComments === undefined ? [] : ['', ...fn.afterComments]),
  ].join('\n');
}

/**
 * The file a formatter writes: `use` lines, then the canonical form of every function,
 * with every source comment kept on the line it was attached to. Unlike `formatProgram`,
 * this is not a revision input; comments never change a hash.
 */
export function formatSource(program: Program): string {
  const directive =
    program.profile === 'strict'
      ? `${withComments('profile strict', program.profileComments)}\n`
      : '';
  const uses = (program.uses ?? [])
    .map((u, k) => `${withComments(`use "${u}"`, program.useComments?.[k])}\n`)
    .join('');
  const fns = program.functions.map(formatFunctionSource).join('\n\n');
  const body = fns.length > 0 ? `${fns}\n` : '';
  const tail = (program.tailComments ?? []).map((c) => `${c}\n`).join('');
  const head = `${directive}${uses}`;
  return `${head}${head && (body || tail) ? '\n' : ''}${body}${tail}`;
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
    throw diag('A0702', [LIMITS.maxIoOutput]);
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

/** What the strict profile does at a trapping case: raise the trap of that kind (never returns). */
export type StrictTrap = (kind: 'bounds' | 'divzero' | 'input') => never;

/**
 * One operation on concrete values. Canonical semantics unless `strict` is given: then an index
 * at or past the length (`get` `set` `at` `put`), a division or remainder by zero, and a `read`
 * on exhausted input call `strict` instead of wrapping. The checked ops (`cadd` ... `cget`) are
 * total and behave the same in both profiles.
 */
export function evalOp(op: Op, args: readonly Value[], strict?: StrictTrap): Value {
  const a = args[0];
  const b = args[1];
  const c = args[2];
  const num = (v: Value | undefined): number => {
    if (typeof v !== 'number') throw diag('A0790', [`${op}: expected u32 value`]);
    return v;
  };
  switch (op) {
    case 'mov':
      if (a === undefined) throw diag('A0790', ['mov: missing operand']);
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
      if (num(b) === 0 && strict !== undefined) return strict('divzero');
      return num(b) === 0 ? 0xffff_ffff : Math.floor(num(a) / num(b));
    case 'rem':
      if (num(b) === 0 && strict !== undefined) return strict('divzero');
      return num(b) === 0 ? num(a) : num(a) % num(b);
    case 'cadd':
      return [(num(a) + num(b)) >>> 0, num(a) + num(b) <= U32_MAX];
    case 'csub':
      return [(num(a) - num(b)) >>> 0, num(a) >= num(b)];
    case 'cmul':
      return [Math.imul(num(a), num(b)) >>> 0, BigInt(num(a)) * BigInt(num(b)) <= BigInt(U32_MAX)];
    case 'cdiv':
      return num(b) === 0 ? [0, false] : [Math.floor(num(a) / num(b)), true];
    case 'crem':
      return num(b) === 0 ? [0, false] : [num(a) % num(b), true];
    case 'cget': {
      if (!Array.isArray(a)) throw diag('A0790', ['cget: expected array']);
      return num(b) < a.length ? [a[num(b)] as Value, true] : [0, false];
    }
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
        throw diag('A0790', ['select: expected bool and two values']);
      }
      return a ? b : c;
    case 'arr':
    case 'rec':
      return [...args];
    case 'get': {
      if (!Array.isArray(a) || a.length === 0) throw diag('A0790', ['get: expected array']);
      if (num(b) >= a.length && strict !== undefined) return strict('bounds');
      return a[num(b) % a.length] as Value;
    }
    case 'set': {
      if (!Array.isArray(a) || a.length === 0 || c === undefined)
        throw diag('A0790', ['set: expected array']);
      if (num(b) >= a.length && strict !== undefined) return strict('bounds');
      const copy = [...a];
      copy[num(b) % a.length] = c;
      return copy;
    }
    case 'at': {
      if (!Array.isArray(a)) throw diag('A0790', ['at: expected record']);
      const v = a[num(b)];
      if (v === undefined && strict !== undefined) return strict('bounds');
      if (v === undefined) throw diag('A0790', ['at: field out of range']);
      return v;
    }
    case 'put': {
      if (Array.isArray(a) && num(b) >= a.length && strict !== undefined) return strict('bounds');
      if (!Array.isArray(a) || c === undefined || num(b) >= a.length)
        throw diag('A0790', ['put: bad field']);
      const copy = [...a];
      copy[num(b)] = c;
      return copy;
    }
    case 'read': {
      // Exhausted input reads as 0; the token identity is the state itself.
      if (a === undefined || !isIoState(a)) throw diag('A0790', ['read: expected io token']);
      if (a.position >= a.input.length && strict !== undefined) return strict('input');
      const v = a.input[a.position] ?? 0;
      if (a.position < a.input.length) a.position += 1;
      return [v, a];
    }
    case 'write': {
      if (a === undefined || !isIoState(a)) throw diag('A0790', ['write: expected io token']);
      emit(a, num(b));
      return a;
    }
    case 'puts': {
      // Length word, then every element, in order.
      if (a === undefined || !isIoState(a) || !Array.isArray(b))
        throw diag('A0790', ['puts: expected io token and array']);
      emit(a, b.length);
      for (const v of b) emit(a, num(v));
      return a;
    }
    case 'call':
    case 'fold':
    case 'loop':
      throw diag('A0790', [`${op} is evaluated by run, not evalOp`]);
  }
}

export function checkArgument(type: Type, value: Value, where: string): void {
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw diag('A0704', [where, 'bool']);
    return;
  }
  if (type === 'u32') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
      throw diag('A0704', [where, 'u32']);
    }
    return;
  }
  if (type === 'io') {
    if (!isIoState(value)) throw diag('A0704', [where, 'io token']);
    return;
  }
  if (!Array.isArray(value)) throw diag('A0704', [where, formatType(type)]);
  if (type.kind === 'arr') {
    if (value.length !== type.length) throw diag('A0705', [where, type.length]);
    for (const [i, v] of value.entries()) checkArgument(type.elem, v, `${where}[${i}]`);
    return;
  }
  if (value.length !== type.fields.length) throw diag('A0706', [where, type.fields.length]);
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
    throw diag('A0703', [fn.name, fn.params.length, args.length]);
  }
  for (const [index, type] of fn.params.entries()) {
    checkArgument(type, args[index] as Value, `${fn.name} p${index}`);
  }
  options.frames = [];
  return exec(fn, args, options);
}

const STRICT_TRAP_ID = { bounds: 'A0710', divzero: 'A0711', input: 'A0712' } as const;

/** The strict profile's trap raiser for a run: the `{kind, fn, at, trip, chain}` of the running frames. */
function strictTrap(options: RunOptions): StrictTrap {
  return (kind) => {
    throw diag(STRICT_TRAP_ID[kind], [trapOf(kind, options).fn], { trap: trapOf(kind, options) });
  };
}

/** Charge `units` of fuel; exhaustion throws a `limit` A0Error. */
function charge(fn: TypedFunc, options: RunOptions, units: number): void {
  options.fuel -= units;
  if (options.fuel < 0) throw diag('A0701', [fn.name], { trap: trapOf('fuel', options) });
}

/** Take one trip from the iteration cap, when there is one. */
function takeTrip(fn: TypedFunc, options: RunOptions): void {
  if (options.maxTrips === undefined) return;
  if (options.maxTrips <= 0) throw diag('A0709', [fn.name], { trap: trapOf('iter', options) });
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
        if (v === undefined) throw diag('A0791', [`${fn.name}: unbound node '${operand.id}'`]);
        return v;
      }
    }
  };
  for (const node of fn.nodes) {
    charge(fn, options, 1);
    if (node.op === 'call') {
      const callee = fn.calls.get(node.callee ?? '');
      if (callee === undefined)
        throw diag('A0791', [`${fn.name}: unresolved callee '${node.callee ?? ''}'`]);
      env.set(node.id, exec(callee, node.args.map(read), options));
    } else if (node.op === 'fold') {
      const body = fn.calls.get(node.callee ?? '');
      if (body === undefined)
        throw diag('A0791', [`${fn.name}: unresolved fold body '${node.callee ?? ''}'`]);
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
        throw diag('A0791', [`${fn.name}: unresolved loop functions`]);
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
          : evalOp(node.op, operands, fn.profile === 'strict' ? strictTrap(options) : undefined),
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
    if (e instanceof A0Error && e.code === 'limit' && e.trap === undefined && e.id === 'A0702')
      throw diag('A0702', [LIMITS.maxIoOutput], { trap: trapOf('io', options) });
    throw e;
  }
}

export function parseAndValidate(source: string): TypedProgram {
  return validate(parse(source));
}
