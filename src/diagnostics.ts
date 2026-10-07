/**
 * The diagnostics table: every checker, parser, linker, edit-protocol and runtime diagnostic of A0
 * is one row here, with a stable code (A0nnnn), a coarse class, a message template with `{0}`
 * placeholders, an optional static fix template, and the text `a0 explain` prints (3-6 lines plus a
 * minimal failing and a fixed example). Nothing else in the repository spells a diagnostic message:
 * the throw sites call `diag(id, args, detail)`.
 *
 * Three fields of a diagnostic exist for an agent that repairs it, and none of them is message text:
 *   - `code`: the coarse class (`parse`, `type`, `structure`, `limit`, `edit`, `patch`, `revision`,
 *     `handle`, `runtime`, `cli`), unchanged since the first release;
 *   - `id`: the stable code of the row (A0011, ...), the key of `a0 explain`;
 *   - `fix` and `applicability`: the one action that resolves it, and whether it is `exact` (safe to
 *     apply blindly, like Rust's MachineApplicable: the edits below produce text the checker
 *     accepts) or `maybe` (a suggestion a reader should look at). `edits` are the exact edits.
 *
 * The explain examples are executed by test/diagnostics.test.ts and by `a0 explain --verify`, so
 * the text cannot drift from the checker (the way Rust runs its `compile_fail` doctests). The
 * module imports nothing: src/core.ts depends on it, never the other way around.
 */

// ---------------------------------------------------------------------------
// Diagnostic values
// ---------------------------------------------------------------------------

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

/** `exact`: safe to apply blindly (the result is accepted). `maybe`: a suggestion to look at. */
export type Applicability = 'exact' | 'maybe';

/**
 * One machine-applicable edit of the text a diagnostic was raised on (a source file or an edit
 * reply). `lines` replaces the whole line whose comment-free, whitespace-normalised text is `text`
 * (`line` is a 1-based hint) with `to` (split on newlines; empty deletes it). `rename` replaces
 * every whole word `from` after the first on the line of node `node` of function `fn` (or the
 * `ret` line when node is `ret`) with `to`: the validator knows names, not source lines.
 */
export type FixEdit =
  | {
      readonly op: 'lines';
      /** The fix rule that made it (see EXACT_FIXES). */
      readonly rule: string;
      readonly text: string;
      readonly line?: number;
      readonly to: string;
    }
  | {
      readonly op: 'rename';
      readonly rule: string;
      readonly fn: string;
      readonly node: string;
      readonly from: string;
      readonly to: string;
    };

/**
 * Why a run stopped before returning: the budget that ran out (`fuel`: node evaluations,
 * `iter`: the total fold/loop trip cap, `io`: the io output cap), where, and how it got there.
 */
export type TrapKind = 'fuel' | 'iter' | 'io' | 'bounds' | 'divzero' | 'input';

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
  bounds: 'keep the index below the length (check it, or use cget for a total read)',
  divzero: 'test the divisor first, or use cdiv/crem, which return (0,false) for a zero divisor',
  input: 'supply more input words, or stop reading when the input is exhausted',
};

/** The strict profile's traps (a program fault), as against the budget traps (a resource stop). */
const PROGRAM_TRAPS: ReadonlySet<TrapKind> = new Set<TrapKind>(['bounds', 'divzero', 'input']);

/**
 * The one-line trap code, the same `code: message fix: fix` shape as every other diagnostic:
 * `limit: trap fuel fn=step at=main.n3 trip=412 chain=main>step fix: ...`. The C backend's
 * trap runtime (CompileOptions.cTrap) prints exactly this line for an iteration-cap stop.
 */
export function formatTrap(t: Trap): string {
  return `${PROGRAM_TRAPS.has(t.kind) ? 'runtime' : 'limit'}: trap ${t.kind} fn=${t.fn} at=${t.at ?? '-'} trip=${t.trip ?? '-'} chain=${t.chain.join('>')} fix: ${TRAP_FIX[t.kind]}`;
}

/**
 * Which spec line (src/spec.ts) a diagnostic is about: the function, the 1-based example it broke
 * (`ex`), the line kind, and for a wrong example the input, the written result and the actual one.
 */
export interface SpecFault {
  readonly function: string;
  readonly ex: number | null;
  /** Absent when the diagnostic is about the function's spec as a whole (A0714). */
  readonly line?: 'ex' | 'pre' | 'post';
  readonly input?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface DiagnosticDetail {
  readonly code?: DiagnosticCode;
  /** The spec line the diagnostic is about (A0714, A0715, A0716, A0719). */
  readonly spec?: SpecFault;
  /** Set when the run stopped on a budget (fuel, iteration cap, io output cap). */
  readonly trap?: Trap;
  /** What the checker required, when it is a single thing (a type, a count, a token). */
  readonly expected?: string;
  /** What it found instead. */
  readonly actual?: string;
  /** The one action that resolves this diagnostic, stated for the editor, not a human. */
  readonly fix?: string;
  /** The row of the diagnostics table (A0nnnn); absent for backend-internal errors. */
  readonly id?: string;
  readonly applicability?: Applicability;
  readonly edits?: readonly FixEdit[];
}

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly id: string | null;
  readonly message: string;
  readonly line: number | null;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly fix: string | null;
  readonly applicability: Applicability | null;
  readonly edits: readonly FixEdit[];
  /** Present only on the spec rows (A0715, A0716, A0719). */
  readonly spec?: SpecFault;
}

export class A0Error extends Error {
  override readonly name = 'A0Error';
  readonly code: DiagnosticCode;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  readonly fix: string | undefined;
  readonly id: string | undefined;
  readonly applicability: Applicability | undefined;
  readonly edits: readonly FixEdit[];
  readonly trap: Trap | undefined;
  readonly spec: SpecFault | undefined;
  /** The message without the `line N: ` prefix. */
  readonly detail: string;
  constructor(
    message: string,
    readonly line?: number,
    detail: DiagnosticDetail = {},
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.detail = message;
    this.code = detail.code ?? 'structure';
    this.expected = detail.expected;
    this.actual = detail.actual;
    this.fix = detail.fix;
    this.id = detail.id;
    this.applicability =
      detail.fix === undefined && detail.edits === undefined ? undefined : detail.applicability;
    this.edits = detail.edits ?? [];
    this.trap = detail.trap;
    this.spec = detail.spec;
  }

  /** The same diagnostic with another message and/or line (the linker maps lines to files). */
  rewrite(message: string, line?: number): A0Error {
    return new A0Error(message, line, this.detailOf());
  }

  /**
   * The same diagnostic worded for another surface syntax (the dense view): its own message and
   * fix text, no edits (they are canonical lines) and so no applicability.
   */
  reworded(message: string, line: number | undefined, fix: string | undefined): A0Error {
    const { expected, actual, id } = this.detailOf();
    return new A0Error(message, line, {
      code: this.code,
      ...(fix === undefined ? {} : { fix }),
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
      ...(id === undefined ? {} : { id }),
      ...(this.spec === undefined ? {} : { spec: this.spec }),
    });
  }

  /** The same diagnostic with edits added or replaced. */
  withEdits(edits: readonly FixEdit[], applicability?: Applicability): A0Error {
    return new A0Error(this.detail, this.line, {
      ...this.detailOf(),
      edits,
      ...(applicability === undefined ? {} : { applicability }),
    });
  }

  detailOf(): DiagnosticDetail {
    return {
      code: this.code,
      ...(this.expected === undefined ? {} : { expected: this.expected }),
      ...(this.actual === undefined ? {} : { actual: this.actual }),
      ...(this.fix === undefined ? {} : { fix: this.fix }),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.applicability === undefined ? {} : { applicability: this.applicability }),
      ...(this.edits.length === 0 ? {} : { edits: this.edits }),
      ...(this.trap === undefined ? {} : { trap: this.trap }),
      ...(this.spec === undefined ? {} : { spec: this.spec }),
    };
  }

  /** Machine-readable form; every field is present (null or [] when absent). */
  toJSON(): Diagnostic {
    return {
      code: this.code,
      id: this.id ?? null,
      message: this.message,
      line: this.line ?? null,
      expected: this.expected ?? null,
      actual: this.actual ?? null,
      fix: this.fix ?? null,
      applicability: this.applicability ?? null,
      edits: this.edits,
      ...(this.spec === undefined ? {} : { spec: this.spec }),
    };
  }
}

/**
 * One-line diagnostic for a model: `class: message fix: ...`, compact by default (measured: the
 * id and the `fix all` line cost about 36 tokens per rejection and did not help a repair). With
 * `hints` naming the reply that applies exact fixes (`fix all` in the edit protocol, `a0 check --fix`
 * on the command line) a diagnostic that has exact edits ends with that reply, and every
 * diagnostic with its code, `[A0nnnn]`, the key of `a0 explain`. The class stays first; the
 * structured fields (`id`, `applicability`, `edits`) are always in `toJSON`.
 */
export function formatDiagnostic(e: unknown, hints: string | false = false): string {
  if (!(e instanceof A0Error)) return e instanceof Error ? e.message : String(e);
  if (e.trap !== undefined) return formatTrap(e.trap);
  const fix = e.fix === undefined ? '' : ` fix: ${e.fix}`;
  const all =
    hints !== false && e.applicability === 'exact' && e.edits.length > 0
      ? ` Reply ${hints} to apply it.`
      : '';
  const id = hints !== false && e.id !== undefined ? ` [${e.id}]` : '';
  return `${e.code}: ${e.message}${fix}${all}${id}`;
}

// ---------------------------------------------------------------------------
// Spelling suggestions (the rule of TypeScript's getSpellingSuggestion)
// ---------------------------------------------------------------------------

/**
 * Edit distance in tenths, bounded: insertion and deletion cost 1 (10), substitution 2 (20) and a
 * case-only substitution 0.1 (1); undefined when the distance exceeds `max10` (tenths). TypeScript
 * v5.9.3 `levenshteinWithMax` computes the same table in floating point; tenths keep it exact and
 * give the A0 implementation (compiler/suggest.a0) integer arithmetic.
 */
export function levenshteinTenths(s1: string, s2: string, max10: number): number | undefined {
  let previous: number[] = Array.from({ length: s2.length + 1 }, (_, j) => j * 10);
  let current: number[] = new Array<number>(s2.length + 1).fill(0);
  const big = max10 + 1;
  for (let i = 1; i <= s1.length; i += 1) {
    const c1 = s1.charCodeAt(i - 1);
    const minJ = Math.max(1, Math.ceil(i - max10 / 10));
    const maxJ = Math.min(s2.length, Math.floor(max10 / 10 + i));
    current[0] = i * 10;
    let colMin = i * 10;
    for (let j = 1; j < minJ; j += 1) current[j] = big;
    for (let j = minJ; j <= maxJ; j += 1) {
      const diag = previous[j - 1] as number;
      const sub =
        (s1[i - 1] as string).toLowerCase() === (s2[j - 1] as string).toLowerCase()
          ? diag + 1
          : diag + 20;
      const dist =
        c1 === s2.charCodeAt(j - 1)
          ? diag
          : Math.min((previous[j] as number) + 10, (current[j - 1] as number) + 10, sub);
      current[j] = dist;
      colMin = Math.min(colMin, dist);
    }
    for (let j = maxJ + 1; j <= s2.length; j += 1) current[j] = big;
    if (colMin > max10) return undefined;
    [previous, current] = [current, previous];
  }
  const res = previous[s2.length] as number;
  return res > max10 ? undefined : res;
}

/**
 * The candidate closest to `name` by TypeScript's rule: a candidate's length may differ from the
 * name's by at most max(2, floor(0.34 * the name's length)); its distance must be below `floor(0.4 * length) + 1`; a candidate shorter than 3 characters
 * counts only when it differs from the name by case alone; the name itself never counts. The
 * first of equally close candidates wins (candidates are tried in the order given).
 */
export function spellingSuggestion(name: string, candidates: Iterable<string>): string | undefined {
  const maximumLengthDifference = Math.max(2, Math.floor(name.length * 0.34));
  let bestDistance10 = (Math.floor(name.length * 0.4) + 1) * 10;
  let best: string | undefined;
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - name.length) > maximumLengthDifference) continue;
    if (candidate === name) continue;
    if (candidate.length < 3 && candidate.toLowerCase() !== name.toLowerCase()) continue;
    const distance = levenshteinTenths(name, candidate, bestDistance10 - 1);
    if (distance === undefined) continue;
    bestDistance10 = distance;
    best = candidate;
  }
  return best;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * A runnable example of a diagnostic. `source`: `bad` fails to parse/validate with the row's id and
 * `good` is accepted. `edit`: both are replies to a session over `base` with function `fn` open;
 * `bad` is rejected with the id, `good` is accepted. `patch`: `bad`/`good` are patch texts for `fn`
 * of `base` (`REV` stands for the function's revision). `run`: `bad` and `good` are programs; `fn`
 * is run on `args` (`'io'` is a fresh io token) with `fuel` (default budget when absent), and only
 * the bad one fails with the id.
 */
export type ExampleArg = number | boolean | 'io' | readonly ExampleArg[];

export interface Example {
  readonly kind: 'source' | 'edit' | 'patch' | 'run';
  readonly bad: string | (() => string);
  readonly good: string | (() => string);
  readonly base?: string;
  readonly fn?: string;
  /** `edit`: the functions whose views are open (default: `fn`); a program view is always open. */
  readonly open?: readonly string[];
  /** Arguments of the failing run, and of the fixed one when `goodArgs` says otherwise. */
  readonly args?: readonly ExampleArg[];
  readonly goodArgs?: readonly ExampleArg[];
  readonly fuel?: number;
  /** What `a0 explain` prints in place of a generated example too large to show. */
  readonly shown?: { readonly bad: string; readonly good: string };
}

export interface Spec {
  readonly cls: DiagnosticCode;
  /** Message template: `{0}`, `{1}`... are the arguments of `diag`. */
  readonly message: string;
  /** Static fix template, used when the throw site passes none. */
  readonly fix?: string;
  /** What it means and how to fix it: 3 to 6 lines. */
  readonly why: readonly string[];
  /** One runnable failing example and its fixed form; absent only with `unrunnable`. */
  readonly example?: Example;
  /** Why no example can run (reachable only from the API, an internal invariant, ...). */
  readonly unrunnable?: string;
}

const SQ = 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n';
const F = (body: string, header = 'fn f u32 -> u32'): string => `${header}\n${body}\nend\n`;
const TWICE = `${SQ}\nfn twice u32 -> u32\nx call sq p0\ny add x x\nret y\nend\n`;

export type DiagId = keyof typeof DIAGNOSTICS;

export const DIAGNOSTICS = {
  // --- Source grammar (A00nn) ------------------------------------------------
  A0001: {
    cls: 'parse',
    message: "type '{0}': {1}",
    fix: 'types are u32, bool, io, arrays u32x4 (left to right: u32x4x2 is two u32x4), records (u32,bool)',
    why: [
      'A type in a function header is not one of A0 types: u32, bool, io, an array',
      'written as the element type then x then a length (u32x4), or a record of types in',
      'parentheses ((u32,bool)). An unknown type word gets a did-you-mean when one is close.',
    ],
    example: {
      kind: 'source',
      bad: F('a mov p0\nret a', 'fn f bol -> bool'),
      good: F('a mov p0\nret a', 'fn f bool -> bool'),
    },
  },
  A0003: {
    cls: 'parse',
    message: "invalid operand '{0}'",
    why: [
      'An operand is a node id, a parameter pN, a decimal u32 literal, true or false.',
      'Commas, hexadecimal and uppercase spellings are rewritten by the exact fix; a negative',
      'literal is the unsigned value it wraps to (maybe: check it is what you meant).',
    ],
    example: { kind: 'source', bad: F('a add p0 0x10\nret a'), good: F('a add p0 16\nret a') },
  },
  A0004: {
    cls: 'limit',
    message: 'literal {0} exceeds u32',
    why: [
      'A decimal literal is larger than 4294967295, the largest u32.',
      'Arithmetic wraps modulo 2^32, so use the wrapped value or build it from smaller parts.',
    ],
    example: {
      kind: 'source',
      bad: F('a add p0 4294967296\nret a'),
      good: F('a add p0 4294967295\nret a'),
    },
  },
  A0005: {
    cls: 'parse',
    message: "invalid node identifier '{0}'",
    why: [
      'A node id is lowercase letters, digits and underscores starting with a letter, at most 64',
      'long, and not a keyword (fn ret end patch true false) or a parameter name (p0, p1, ...).',
      'A trailing colon (`a: add p0 1`) is removed by the exact fix.',
    ],
    example: { kind: 'source', bad: F('a: add p0 1\nret a'), good: F('a add p0 1\nret a') },
  },
  A0006: {
    cls: 'parse',
    message: 'text literal must not be empty',
    why: [
      '`id text "..."` builds a u32 array of the UTF-8 bytes of the string, so it needs at least one byte.',
    ],
    example: {
      kind: 'source',
      bad: F('t text ""\nn get t 0\nret n'),
      good: F('t text "a"\nn get t 0\nret n'),
    },
  },
  A0007: {
    cls: 'limit',
    message: 'text literal exceeds {0} bytes',
    why: [
      'A text literal becomes one array, and an array holds at most 65536 elements.',
      'Split the text across several literals or load it through io.',
    ],
    example: {
      kind: 'source',
      bad: () => F(`t text "${'x'.repeat(65537)}"\nn get t 0\nret n`),
      good: F('t text "x"\nn get t 0\nret n'),
      shown: {
        bad: 'fn f u32 -> u32\nt text "xxxx...65537 bytes..."\n...',
        good: 'fn f u32 -> u32\nt text "x"\n...',
      },
    },
  },
  A0008: {
    cls: 'structure',
    message: 'unknown escape \\{0} in text literal',
    why: [
      'A text literal knows the escapes \\n, \\t, \\" and \\\\ only.',
      'Write the byte another way (a u32 array literal) or drop the escape.',
    ],
    example: {
      kind: 'source',
      bad: F('t text "a\\q"\nn get t 0\nret n'),
      good: F('t text "a\\n"\nn get t 0\nret n'),
    },
  },
  A0009: {
    cls: 'parse',
    message: 'expected `id op operands`',
    why: [
      'Every line inside a function is `id op operand...`: an id, then an op or a function name,',
      'then its operands. A line with only one word has no op.',
    ],
    example: { kind: 'source', bad: F('a'), good: F('a mov p0\nret a') },
  },
  A0010: {
    cls: 'parse',
    message: 'nested operand: A0 has one op per line',
    why: [
      'A0 has no parenthesised sub-expressions: each line holds one op whose operands are names',
      'or literals. The fix puts the inner op on its own line above the line that used it',
      '(`ret (a, b)` becomes `ret rec a b`). It is exact: the rewrite is mechanical.',
    ],
    example: {
      kind: 'source',
      bad: F('a add (mul p0 2) 1\nret a'),
      good: F('a1 mul p0 2\na add a1 1\nret a'),
    },
  },
  A0011: {
    cls: 'parse',
    message: "unknown operation '{0}'",
    why: [
      'The word after the id is neither an op nor the name of a function: ops are lowercase,',
      'so `ADD` is rewritten to `add` by the exact fix, and `a = add p0 1` loses its `=`.',
      'A word that is close to an op gets a did-you-mean (maybe).',
    ],
    example: { kind: 'source', bad: F('a ADD p0 1\nret a'), good: F('a add p0 1\nret a') },
  },
  A0012: {
    cls: 'parse',
    message: 'loop expects a predicate and a body function name',
    fix: 'write `loop P F n s args...`: P and F are functions defined above, F runs while P(state, i, args...) holds, at most n times, starting from state s',
    why: [
      '`loop P F n s args...` runs F while P(state, i, args...) holds, at most n times.',
      'It needs two function names before the trip count.',
    ],
    example: {
      kind: 'source',
      bad: `fn p u32 u32 -> bool\nb lt p0 5\nret b\nend\nfn s u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a loop p 10 0')}`,
      good: `fn p u32 u32 -> bool\nb lt p0 5\nret b\nend\nfn s u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a loop p s 10 0\nret a')}`,
    },
  },
  A0013: {
    cls: 'parse',
    message: "{0} expects a function name, got '{1}'",
    why: [
      '`call F args...` and `fold F n s args...` name a function in the position after the op.',
      'A function name is lowercase; an uppercase spelling is rewritten by the exact fix.',
    ],
    example: {
      kind: 'source',
      bad: `${SQ}${F('a call SQ p0\nret a')}`,
      good: `${SQ}${F('a call sq p0\nret a')}`,
    },
  },
  A0014: {
    cls: 'parse',
    message: '{0} expects {1} operands, got {2}',
    fix: 'write exactly {1} operands after {0}',
    why: [
      'Every op except call, fold, loop, arr and rec takes a fixed number of operands',
      '(binary ops 2, select 3, mov and read 1). The line has a different number.',
    ],
    example: { kind: 'source', bad: F('a add p0\nret a'), good: F('a add p0 1\nret a') },
  },
  A0015: {
    cls: 'parse',
    message: '{0} expects at least one operand',
    why: ['`arr` and `rec` build an aggregate from their operands, so they need at least one.'],
    example: {
      kind: 'source',
      bad: F('a arr\nn get a 0\nret n'),
      good: F('a arr 1\nn get a 0\nret n'),
    },
  },
  A0016: {
    cls: 'limit',
    message: 'source exceeds {0} bytes',
    why: [
      'A source file is at most 1 MiB; the limit bounds the work a hostile input can cause.',
      'Split the program across files joined with `use`.',
    ],
    example: {
      kind: 'source',
      bad: () => `# ${'x'.repeat(1 << 20)}\n${F('a mov p0\nret a')}`,
      good: F('a mov p0\nret a'),
      shown: {
        bad: '# xxxx... (more than 1 MiB)\nfn f u32 -> u32\n...',
        good: 'fn f u32 -> u32\n...',
      },
    },
  },
  A0017: {
    cls: 'parse',
    message: 'use expects `use "path.a0"` before the first fn',
    fix: 'write use "relative/path.a0" as its own line at the top of the file',
    why: [
      'A `use` line names another .a0 file whose functions this one calls; it must come before',
      'the first `fn` and quote one relative path.',
    ],
    example: {
      kind: 'source',
      bad: `use lib.a0\n${F('a mov p0\nret a')}`,
      good: `use "lib.a0"\n${F('a mov p0\nret a')}`,
    },
  },
  A0018: {
    cls: 'parse',
    message: "expected 'fn', got '{0}'",
    fix: 'instruction lines belong inside a function: start it with `fn NAME T... -> T` and close it with `ret X` and `end`',
    why: [
      'A file is a sequence of `fn NAME types -> type ... ret X end` blocks. A line outside a block',
      'is not allowed: in an edit reply, instruction lines are for the shown function, and a new',
      'function is a whole `fn` block.',
    ],
    example: {
      kind: 'source',
      bad: `a mov p0\n${F('a mov p0\nret a')}`,
      good: F('a mov p0\nret a'),
    },
  },
  A0019: {
    cls: 'parse',
    message: "invalid function name '{0}'",
    why: [
      'A function name is lowercase letters, digits and underscores starting with a letter, at',
      'most 64 long, and not a keyword (fn ret end patch true false).',
    ],
    example: {
      kind: 'source',
      bad: F('a mov p0\nret a', 'fn Foo u32 -> u32'),
      good: F('a mov p0\nret a', 'fn foo u32 -> u32'),
    },
  },
  A0020: {
    cls: 'parse',
    message: "duplicate function '{0}'",
    why: [
      'Two blocks define the same name; a program has one namespace. In an edit reply a `fn` block',
      'replaces the function of that name, so send it once.',
    ],
    example: { kind: 'source', bad: `${SQ}${SQ}`, good: SQ },
  },
  A0021: {
    cls: 'structure',
    message: "duplicate function '{0}'",
    why: [
      'A program value holds two functions of one name (built through the API; source text',
      'reports the duplicate while parsing, as A0020).',
    ],
    unrunnable:
      'reachable only from programs built through the API, not from source text (parse reports A0020 first)',
  },
  A0022: {
    cls: 'structure',
    message: "function '{0}' is defined in both {1} and {2}",
    fix: "rename one of the two '{0}' definitions; a linked program has one namespace",
    why: [
      'Two files of a `use` closure define the same function name.',
      'Rename one definition and its callers.',
    ],
    unrunnable: 'needs two files on disk; covered by the linker tests (test/core.test.ts)',
  },
  A0023: {
    cls: 'parse',
    message: "expected 'fn name types... -> type'",
    fix: 'write the header on one line: `fn NAME T... -> T` (parameter types, `->`, exactly one result type)',
    why: [
      'A function header is `fn`, the name, the parameter types, `->`, and the result type,',
      'with exactly one result type after the arrow.',
    ],
    example: {
      kind: 'source',
      bad: F('a mov p0\nret a', 'fn f u32 u32'),
      good: F('a mov p0\nret a', 'fn f u32 -> u32'),
    },
  },
  A0024: {
    cls: 'limit',
    message: 'too many parameters',
    why: [
      'A function takes at most 64 parameters.',
      'Pass an array or a record instead of many scalars.',
    ],
    example: {
      kind: 'source',
      bad: () => F('a mov p0\nret a', `fn f ${'u32 '.repeat(65)}-> u32`),
      good: F('a mov p0\nret a'),
      shown: { bad: 'fn f u32 u32 ... (65 parameters) -> u32', good: 'fn f u32 -> u32' },
    },
  },
  A0025: {
    cls: 'parse',
    message: "expected 'end' after ret",
    fix: 'close the function with `end` on the line after `ret`',
    why: [
      'A function body ends with `ret X` and then `end` on its own line.',
      'A missing `end` is added by the exact fix.',
    ],
    example: {
      kind: 'source',
      bad: 'fn f u32 -> u32\na mov p0\nret a\n',
      good: F('a mov p0\nret a'),
    },
  },
  A0026: {
    cls: 'parse',
    message: "unexpected '{0}' before ret",
    fix: 'a function is `fn ...` then instruction lines, `ret X`, `end`: write `ret X` before `end`, and start the next `fn` after that `end`',
    why: [
      '`end` or a new `fn` appeared before the function got its `ret`.',
      'Every block has instruction lines, then `ret X`, then `end`.',
    ],
    example: {
      kind: 'source',
      bad: 'fn f u32 -> u32\na mov p0\nend\n',
      good: F('a mov p0\nret a'),
    },
  },
  A0027: {
    cls: 'limit',
    message: 'too many nodes in function',
    why: [
      'A function has at most 4096 instruction lines.',
      'Split it into functions that call one another.',
    ],
    example: {
      kind: 'source',
      bad: () => F(`${Array.from({ length: 4097 }, (_, i) => `n${i} mov p0`).join('\n')}\nret n0`),
      good: F('n0 mov p0\nret n0'),
      shown: {
        bad: 'fn f u32 -> u32\nn0 mov p0\n... (4097 lines)',
        good: 'fn f u32 -> u32\nn0 mov p0\nret n0\nend',
      },
    },
  },
  A0028: {
    cls: 'parse',
    message: "function '{0}' not terminated",
    why: [
      'The file ended inside a function: no `ret X` followed by `end` was found.',
      'Add them, or remove the unfinished `fn` line.',
    ],
    example: { kind: 'source', bad: 'fn f u32 -> u32\na mov p0\n', good: F('a mov p0\nret a') },
  },
  A0029: {
    cls: 'limit',
    message: 'too many functions',
    why: [
      'A program has at most 65536 functions after linking.',
      'Drop unused functions or split the program.',
    ],
    unrunnable: 'the 1 MiB source limit (A0016) applies before 65537 functions fit in one file',
  },
  A0030: {
    cls: 'parse',
    message: 'ret expects one operand',
    fix: 'write `ret ID` or `ret OP ARGS…`',
    why: [
      '`ret X` returns one operand, and `ret OP ARGS...` is short for a fresh node plus `ret` of it.',
      'More than one word that is not an op is neither.',
    ],
    example: { kind: 'source', bad: F('a mov p0\nret 1 2'), good: F('a mov p0\nret a') },
  },
  A0031: {
    cls: 'parse',
    message: 'profile expects `profile strict` as the first line of the file',
    fix: 'write `profile strict` as the very first line, before any use or fn, or remove the line for the canonical profile',
    why: [
      'The operations profile is chosen once per program: `profile strict` makes an index past the',
      'length, a division or remainder by zero, and a read of exhausted input trap. No line means',
      'the canonical profile; `strict` is the only name, and the line comes before `use` and `fn`.',
    ],
    example: {
      kind: 'source',
      bad: `profile lax\n${F('a mov p0\nret a')}`,
      good: `profile strict\n${F('a mov p0\nret a')}`,
    },
  },

  // --- Names (A01nn) -----------------------------------------------------------
  A0101: {
    cls: 'structure',
    message: "{0}: reference to undefined or later node '{1}'",
    fix: "define '{1}' on an earlier line of this function, or reference a node defined above {0}",
    why: [
      'An operand names a node that is not defined on an earlier line of the same function',
      '(or a parameter pN, or a literal). A close spelling of a defined node gets a did-you-mean.',
    ],
    example: {
      kind: 'source',
      bad: F('a add p0 1\nb add aa 1\nret b'),
      good: F('a add p0 1\nb add a 1\nret b'),
    },
  },
  A0102: {
    cls: 'structure',
    message:
      "{0}: unknown callee '{1}' (callees must be defined earlier; recursion is unsupported)",
    why: [
      'The word after the id is not an op and no function of that name is defined above this one.',
      'Callees come first and there is no recursion. A close spelling of an op or of a function',
      'defined above gets a did-you-mean (maybe: a typo can name a different op).',
    ],
    example: { kind: 'source', bad: F('a mull p0 2\nret a'), good: F('a mul p0 2\nret a') },
  },
  A0103: {
    cls: 'structure',
    message: "{0}: unknown {1} body '{2}' (must be defined earlier)",
    why: [
      'The function a `fold` or `loop` runs each step is not defined above the caller.',
      'Define the body first (callees precede callers) or fix its spelling.',
    ],
    example: {
      kind: 'source',
      bad: F('a fold stp 4 0\nret a'),
      good: `fn stp u32 u32 -> u32\nr add p0 p1\nret r\nend\n${F('a fold stp 4 0\nret a')}`,
    },
  },
  A0104: {
    cls: 'structure',
    message: "{0}: unknown loop predicate '{1}' (must be defined earlier)",
    why: [
      'The predicate function of a `loop` is not defined above the caller.',
      'Define it first or fix its spelling.',
    ],
    example: {
      kind: 'source',
      bad: `fn s u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a loop pp s 10 0\nret a')}`,
      good: `fn pp u32 u32 -> bool\nb lt p0 5\nret b\nend\nfn s u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a loop pp s 10 0\nret a')}`,
    },
  },
  A0105: {
    cls: 'type',
    message: '{0}: parameter p{1} out of range',
    why: [
      'A parameter operand pN names a parameter the function does not have.',
      'Adding a parameter changes the signature, which is a `fn` block (program handle), not an',
      'instruction line.',
    ],
    example: { kind: 'source', bad: F('a add p0 p3\nret a'), good: F('a add p0 p0\nret a') },
  },

  // --- Types (A02nn) -------------------------------------------------------------
  A0201: {
    cls: 'type',
    message: '{0}: expected {1}, got {2}',
    fix: 'replace the operand at {0} with a value of type {1}',
    why: [
      'An operand or the returned value has a different type than the op or the signature needs.',
      'When `ret` has another type than the declared result, either change the value or change the',
      'result type in a `fn` block (the fix names both).',
    ],
    example: {
      kind: 'source',
      bad: F('a lt p0 1\nret a'),
      good: F('a lt p0 1\nb select a 1 0\nret b'),
    },
  },
  A0202: {
    cls: 'type',
    message: '{0}: missing operand',
    why: ['An op got fewer operands than it needs after parsing.'],
    unrunnable:
      'the parser rejects wrong operand counts first (A0014); reachable only through the API',
  },
  A0203: {
    cls: 'type',
    message: '{0}: select branches differ ({1} vs {2})',
    why: ['`select c a b` chooses between a and b, which must have the same type.'],
    example: {
      kind: 'source',
      bad: F('c lt p0 1\na select c p0 true\nret a'),
      good: F('c lt p0 1\na select c p0 1\nret a'),
    },
  },
  A0204: {
    cls: 'type',
    message: '{0}: select cannot choose between io tokens',
    why: [
      'An io token is linear: exactly one use. Choosing between two tokens would use both.',
      'Make both branches write, then thread the single result.',
    ],
    unrunnable:
      'the linearity check (A0310) rejects choosing between tokens before the type check runs: two tokens cannot be live at once',
  },
  A0205: {
    cls: 'type',
    message: '{0}: arrays cannot hold io tokens',
    why: ['An array may not contain an io token (the linear token must be threaded, not stored).'],
    example: {
      kind: 'source',
      bad: F('a arr p0\nn mov 1\nret n', 'fn f io -> u32'),
      good: F('a arr 1 2\nn get a 0\nret n', 'fn f io -> u32'),
    },
  },
  A0206: {
    cls: 'limit',
    message: '{0}: aggregate too large',
    why: [
      'An array or record value is at most 2^21 bits (65536 u32 words).',
      'Keep large data in several smaller arrays or stream it through io.',
    ],
    example: {
      kind: 'source',
      bad: () => F(`a arr ${Array.from({ length: 65537 }, () => '0').join(' ')}\nn get a 0\nret n`),
      good: F('a arr 0 0\nn get a 0\nret n'),
      shown: {
        bad: 'fn f u32 -> u32\na arr 0 0 0 ... (65537 operands)\n...',
        good: 'fn f u32 -> u32\na arr 0 0\n...',
      },
    },
  },
  A0207: {
    cls: 'type',
    message: '{0}: a record holds at most one io token',
    why: [
      'A record carrying two io tokens would let both be consumed independently.',
      'Thread one token through the program.',
    ],
    unrunnable: 'two io tokens cannot be live at once (A0309, A0310 reject first)',
  },
  A0208: {
    cls: 'type',
    message: '{0}: puts expects a u32 array, got {1}',
    why: ['`puts t a` writes the length and the elements of a u32 array to the io token t.'],
    example: {
      kind: 'source',
      bad: F('w puts p0 1\nret w', 'fn f io -> io'),
      good: F('a arr 1\nw puts p0 a\nret w', 'fn f io -> io'),
    },
  },
  A0209: {
    cls: 'type',
    message: '{0}: get expects an array, got {1}',
    why: ['`get A I` reads element I of an array; a record is read with `at R K` (K a literal).'],
    example: {
      kind: 'source',
      bad: F('r rec p0 p0\nx get r 0\nret x'),
      good: F('r rec p0 p0\nx at r 0\nret x'),
    },
  },
  A0210: {
    cls: 'type',
    message: '{0}: set expects an array, got {1}',
    why: ['`set A I V` replaces element I of an array; a record is updated with `put R K V`.'],
    example: {
      kind: 'source',
      bad: F('r rec p0 p0\ns set r 0 1\nx at s 0\nret x'),
      good: F('r rec p0 p0\ns put r 0 1\nx at s 0\nret x'),
    },
  },
  A0211: {
    cls: 'type',
    message: '{0}: {1} is typed with its literal field index',
    why: ['`at` and `put` are typed through their literal field index.'],
    unrunnable:
      'internal: validateFunction types at/put before resultType is asked; reachable only through the API',
  },
  A0212: {
    cls: 'type',
    message: '{0}: {1} is typed against its callee',
    why: ['`call`, `fold` and `loop` are typed against the function they name.'],
    unrunnable:
      'internal: validateFunction types calls before resultType is asked; reachable only through the API',
  },
  A0213: {
    cls: 'type',
    message: '{0}: {1}: expected {2}, got {3}',
    why: [
      'A `fold F n s args...` step runs state = F(state, i, args...): s must have the type of the',
      "state, i is the u32 step index (not an element), and F's result has the state's type.",
      'The fix prints the header the operands need and the shape the actual header accepts.',
    ],
    example: {
      kind: 'source',
      bad: `fn stp u32 u32 -> u32\nr add p0 p1\nret r\nend\n${F('a fold stp 4 true\nret a')}`,
      good: `fn stp u32 u32 -> u32\nr add p0 p1\nret r\nend\n${F('a fold stp 4 0\nret a')}`,
    },
  },
  A0214: {
    cls: 'structure',
    message: '{0}: fold body {1} needs (state, index, ...) parameters',
    why: ['The body of a fold or loop takes the state and the u32 step index first.'],
    example: {
      kind: 'source',
      bad: `fn stp u32 -> u32\nr add p0 1\nret r\nend\n${F('a fold stp 4 0\nret a')}`,
      good: `fn stp u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a fold stp 4 0\nret a')}`,
    },
  },
  A0215: {
    cls: 'structure',
    message: '{0}: {1} expects {2} extra arguments, got {3}',
    why: [
      'The operands after the initial state of a fold or loop are passed to every step',
      'after (state, i); their number must equal the body extra parameters.',
    ],
    example: {
      kind: 'source',
      bad: `fn stp u32 u32 -> u32\nr add p0 p1\nret r\nend\n${F('a fold stp 4 0 p0\nret a')}`,
      good: `fn stp u32 u32 -> u32\nr add p0 p1\nret r\nend\n${F('a fold stp 4 0\nret a')}`,
    },
  },
  A0216: {
    cls: 'structure',
    message: '{0}: fold expects a trip count and an initial state',
    why: [
      '`fold F n s ...` needs the trip count n and the initial state s after the function name.',
    ],
    example: {
      kind: 'source',
      bad: `fn stp u32 u32 -> u32\nr add p0 p1\nret r\nend\n${F('a fold stp\nret a')}`,
      good: `fn stp u32 u32 -> u32\nr add p0 p1\nret r\nend\n${F('a fold stp 4 0\nret a')}`,
    },
  },
  A0217: {
    cls: 'structure',
    message: '{0}: predicate {1} must take the same parameters as body {2}',
    why: [
      'A loop predicate is called with exactly the arguments of the body, so both headers',
      'have the same parameter types.',
    ],
    example: {
      kind: 'source',
      bad: `fn pp u32 -> bool\nb lt p0 5\nret b\nend\nfn s u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a loop pp s 10 0\nret a')}`,
      good: `fn pp u32 u32 -> bool\nb lt p0 5\nret b\nend\nfn s u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a loop pp s 10 0\nret a')}`,
    },
  },
  A0218: {
    cls: 'structure',
    message: '{0}: literal iteration count {1} exceeds the compute bound {2}',
    why: [
      'The product of literal trip counts along a nesting path is at most 2^24: A0 programs',
      'always terminate within a bounded amount of work. Use a smaller count or a variable one.',
    ],
    example: {
      kind: 'source',
      bad: `fn stp u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a fold stp 16777217 0\nret a')}`,
      good: `fn stp u32 u32 -> u32\nr add p0 1\nret r\nend\n${F('a fold stp 16777216 0\nret a')}`,
    },
  },
  A0219: {
    cls: 'structure',
    message: '{0}: {1} expects {2} arguments, got {3}',
    why: ['A call passes one argument per parameter of the callee, in order.'],
    example: {
      kind: 'source',
      bad: `${SQ}${F('a call sq p0 p0\nret a')}`,
      good: `${SQ}${F('a call sq p0\nret a')}`,
    },
  },
  A0220: {
    cls: 'structure',
    message: '{0}: {1} expects a record, got {2}',
    why: ['`at R K` and `put R K V` work on records; arrays use `get` and `set`.'],
    example: {
      kind: 'source',
      bad: F('a arr p0 p0\nx at a 0\nret x'),
      good: F('a arr p0 p0\nx get a 0\nret x'),
    },
  },
  A0221: {
    cls: 'structure',
    message: '{0}: {1} field index must be a u32 literal',
    why: [
      'The field of `at` and `put` is part of the type, so it is a literal, not a computed value.',
    ],
    example: {
      kind: 'source',
      bad: F('r rec p0 p0\nx at r p0\nret x'),
      good: F('r rec p0 p0\nx at r 1\nret x'),
    },
  },
  A0222: {
    cls: 'structure',
    message: '{0}: field {1} out of range for {2}',
    why: ['The record has fewer fields than the literal index; fields count from 0.'],
    example: {
      kind: 'source',
      bad: F('r rec p0 p0\nx at r 2\nret x'),
      good: F('r rec p0 p0\nx at r 1\nret x'),
    },
  },

  // --- Structure of hand-built programs (A03nn) -----------------------------------
  A0301: {
    cls: 'structure',
    message: "invalid function name '{0}'",
    why: ['A function value carries a name that is not a valid identifier.'],
    unrunnable: 'reachable only from programs built through the API (source text reports A0019)',
  },
  A0302: {
    cls: 'structure',
    message: '{0}: invalid identifier',
    why: ['A node value carries an id that is not a valid identifier.'],
    unrunnable: 'reachable only from programs built through the API (source text reports A0005)',
  },
  A0303: {
    cls: 'structure',
    message: '{0}: duplicate definition',
    why: [
      'Two nodes of one function have the same id; each id is defined once.',
      'In an edit reply a line with an existing id replaces that node.',
    ],
    example: {
      kind: 'source',
      bad: F('a add p0 1\na add p0 2\nret a'),
      good: F('a add p0 1\nb add p0 2\nret b'),
    },
  },
  A0304: {
    cls: 'structure',
    message: '{0}: callee present iff op is call, fold, or loop',
    why: ['A node value has a callee on a non-call op, or none on a call.'],
    unrunnable: 'reachable only from programs built through the API',
  },
  A0305: {
    cls: 'structure',
    message: '{0}: predicate present iff op is loop',
    why: ['A node value has a predicate on a non-loop op, or none on a loop.'],
    unrunnable: 'reachable only from programs built through the API',
  },
  A0306: {
    cls: 'structure',
    message: '{0}: wrong arity',
    why: ['A node value has a wrong operand count for its op.'],
    unrunnable: 'reachable only from programs built through the API (source text reports A0014)',
  },
  A0307: {
    cls: 'structure',
    message: '{0}: {1} expects at least one operand',
    why: ['An arr or rec node value has no operands.'],
    unrunnable: 'reachable only from programs built through the API (source text reports A0015)',
  },
  A0308: {
    cls: 'structure',
    message: '{0}: literal out of u32 range',
    why: ['A literal operand value is outside 0..4294967295.'],
    unrunnable: 'reachable only from programs built through the API (source text reports A0004)',
  },
  A0309: {
    cls: 'structure',
    message: '{0}: at most one parameter may carry an io token',
    why: [
      'A function may take one io token (directly or inside a record), so the effect order is',
      'the data dependency of that token.',
    ],
    example: {
      kind: 'source',
      bad: F('a mov 1\nret a', 'fn f io io -> u32'),
      good: F('a mov 1\nret a', 'fn f io u32 -> u32'),
    },
  },
  A0310: {
    cls: 'structure',
    message: "{0}: io token '{1}' was already consumed",
    why: [
      'An io token is used exactly once: `read` and `write` consume it and return the next one.',
      'Use the token the previous op returned.',
    ],
    example: {
      kind: 'source',
      bad: F('a write p0 1\nb write p0 2\nret b', 'fn f io -> io'),
      good: F('a write p0 1\nb write a 2\nret b', 'fn f io -> io'),
    },
  },
  A0311: {
    cls: 'structure',
    message: "{0}: the io field {1} of '{2}' was already taken by `at`",
    why: ['`at` of the io field of a record takes the token out of the record once.'],
    example: {
      kind: 'source',
      bad: F('r read p0\nt at r 1\nu at r 1\nret u', 'fn f io -> io'),
      good: F('r read p0\nt at r 1\nret t', 'fn f io -> io'),
    },
  },
  A0312: {
    cls: 'structure',
    message: "{0}: '{1}' is used after `at` took its io field {2}; its token would be used twice",
    why: [
      'After `at` took the token out of a record, the record may only be read for its other',
      'fields, or get the token back with `put`.',
    ],
    example: {
      kind: 'source',
      bad: F('r read p0\nt at r 1\nw write r 1\nret t', 'fn f io -> io'),
      good: F('r read p0\nt at r 1\nw write t 1\nret w', 'fn f io -> io'),
    },
  },
  A0313: {
    cls: 'structure',
    message: "{0}.ret: '{1}' is returned after `at` took its io field {2}",
    why: ['A record whose io field was taken cannot be returned; return the token or put it back.'],
    example: {
      kind: 'source',
      bad: F('r read p0\nt at r 1\nret r', 'fn f io -> (u32,io)'),
      good: F('r read p0\nt at r 1\nret t', 'fn f io -> io'),
    },
  },
  A0314: {
    cls: 'structure',
    message: "{0}.ret: io token '{1}' was already consumed",
    why: [
      'The returned io token was already consumed by an earlier op; return the one it produced.',
    ],
    example: {
      kind: 'source',
      bad: F('a write p0 1\nret p0', 'fn f io -> io'),
      good: F('a write p0 1\nret a', 'fn f io -> io'),
    },
  },
  A0315: {
    cls: 'limit',
    message: '{0}: too many parameters',
    why: ['A function value has more than 64 parameters.'],
    unrunnable: 'reachable only from programs built through the API (source text reports A0024)',
  },
  A0316: {
    cls: 'limit',
    message: '{0}: too many nodes',
    why: ['A function has more than 4096 nodes (an edit made it so).'],
    unrunnable:
      'an edit reply is bounded by A0502 and the source by A0027 first; reachable only through the API',
  },

  // --- Edit protocol (A05nn) ---------------------------------------------------------
  A0501: {
    cls: 'edit',
    message: 'edit contains no lines',
    why: ['The reply held a handle line and nothing else.', 'Send the instruction lines to apply.'],
    unrunnable:
      'a reply of only a handle line is accepted and changes nothing; parseEditOps rejects an empty list when called through the API',
  },
  A0502: {
    cls: 'limit',
    message: 'edit too large',
    why: [
      'An edit is at most 1 MiB or 4096 lines.',
      'Send the changed lines, not the whole program.',
    ],
    example: {
      kind: 'edit',
      base: SQ,
      fn: 'sq',
      bad: () => `a mul p0 3\n# ${'x'.repeat(1 << 20)}`,
      good: 'a mul p0 3',
      shown: { bad: 'a mul p0 3\n# xxxx... (more than 1 MiB)', good: 'a mul p0 3' },
    },
  },
  A0503: {
    cls: 'edit',
    message: "duplicate edit for '{0}'",
    why: [
      'A reply edits each node once; two lines named the same id.',
      'Keep the last intended line.',
      'When the second line reads the id (two successive updates, `r set p0 0 x` then `r set r 1 y`), the first gets a fresh id that the second reads.',
    ],
    example: {
      kind: 'edit',
      base: SQ,
      fn: 'sq',
      bad: 'a mul p0 3\na mul p0 4',
      good: 'a mul p0 4',
    },
  },
  A0504: {
    cls: 'edit',
    message: "invalid delete target '{0}'",
    why: ['`-id` deletes the node `id`; the text after the dash is not a node id.'],
    example: { kind: 'edit', base: TWICE, fn: 'twice', bad: '-Y', good: 'y add x 1' },
  },
  A0505: {
    cls: 'edit',
    message: 'duplicate ret in edit',
    why: ['A reply changes the result with one `ret` line.'],
    example: { kind: 'edit', base: SQ, fn: 'sq', bad: 'ret p0\nret a', good: 'ret a' },
  },
  A0506: {
    cls: 'edit',
    message: "{0}: cannot delete unknown node '{1}'",
    why: ['`-id` names a node that the function does not have.'],
    example: { kind: 'edit', base: TWICE, fn: 'twice', bad: '-z', good: '-y\nret x' },
  },
  A0507: {
    cls: 'edit',
    message: "{0}: cannot insert after unknown node '{1}'",
    why: ['`line @ id` inserts after node `id`, which does not exist.'],
    example: {
      kind: 'edit',
      base: TWICE,
      fn: 'twice',
      bad: 'z add x 1 @ q\nret z',
      good: 'z add x 1 @ x\nret z',
    },
  },
  A0508: {
    cls: 'edit',
    message: "{0}: new node '{1}' is not used by any node or by ret",
    fix: "add 'ret {1}' if it is the new result, or use it in another node",
    why: [
      'The reply added a node that nothing reads, which almost always means the result was',
      'forgotten (`ret` still names the old node). Nothing is committed.',
    ],
    example: { kind: 'edit', base: SQ, fn: 'sq', bad: 'b add a 1', good: 'b add a 1\nret b' },
  },
  A0509: {
    cls: 'edit',
    message: "bad line edit '{0}'",
    why: ['A line addressed by number is `N line`, `N-` or `N+ line`, optionally `f:N`.'],
    unrunnable:
      'every reply line that matches the line-edit shape is accepted by it; reachable only through the API',
  },
  A0510: {
    cls: 'edit',
    message: "line edit '{0}' names no function",
    fix: 'write `f:N line` with the function name',
    why: ['A numbered line edit under a program handle must say which function: `f:N line`.'],
    example: {
      kind: 'edit',
      base: SQ,
      fn: 'sq',
      bad: 'g0\n1 a mul p0 3',
      good: 'e0\n1 a mul p0 3',
    },
  },
  A0511: {
    cls: 'edit',
    message: "line edit '{0}': unknown function '{1}'",
    why: ['`f:N line` names a function that is not in the program.'],
    example: { kind: 'edit', base: SQ, fn: 'sq', bad: 'zz:1 a mul p0 3', good: 'sq:1 a mul p0 3' },
  },
  A0512: {
    cls: 'edit',
    message: "line edit '{0}': insert after line 0..{1} with text",
    why: ['`N+ line` inserts after line N (0 is the top) and needs the text to insert.'],
    example: { kind: 'edit', base: SQ, fn: 'sq', bad: '9+ b add a 1', good: '1+ b add a 1\nret b' },
  },
  A0513: {
    cls: 'edit',
    message: "line edit '{0}': {1} has lines 1..{2}",
    fix: 'use the line numbers shown in the view',
    why: ['A line number is outside the function body; lines count from 1 in the numbered view.'],
    example: { kind: 'edit', base: SQ, fn: 'sq', bad: '7 a mul p0 3', good: '1 a mul p0 3' },
  },
  A0514: {
    cls: 'edit',
    message: "line edit '{0}': line {1} edited twice",
    why: ['Each numbered line is replaced or deleted at most once per reply.'],
    example: {
      kind: 'edit',
      base: SQ,
      fn: 'sq',
      bad: '1 a mul p0 3\n1 a mul p0 4',
      good: '1 a mul p0 4',
    },
  },
  A0515: {
    cls: 'edit',
    message: "line edit '{0}' has no text",
    fix: "write '{1}-' to delete the line",
    why: ['`N` alone replaces nothing; to delete line N write `N-`.'],
    unrunnable:
      'a bare number is read as a handle or an operand-less line first; reachable only through the API',
  },
  A0516: {
    cls: 'edit',
    message: "'{0}' does not match {1}",
    fix: 'write `-fn {2}` alone; a new signature goes in the `fn {2} ...` block',
    why: [
      '`-fn name` removes a function; after the name only its current signature may follow.',
      'A different signature is a change, and that is a `fn name ...` block. The exact fix writes',
      '`-fn name` alone.',
    ],
    example: {
      kind: 'edit',
      base: TWICE,
      fn: 'twice',
      bad: '-fn sq u32 u32 -> u32\nfn sq u32 -> u32\na mul p0 p0\nret a\nend',
      good: '-fn sq\nfn sq u32 -> u32\na mul p0 p0\nret a\nend',
    },
  },
  A0517: {
    cls: 'edit',
    message: "cannot remove unknown function '{0}'",
    why: ['`-fn name` names a function that is not in the program.'],
    example: {
      kind: 'edit',
      base: TWICE,
      fn: 'twice',
      bad: '-fn nope',
      good: '-fn sq\nfn sq u32 -> u32\na mul p0 p0\nret a\nend',
    },
  },
  A0518: {
    cls: 'edit',
    message: 'edit would leave the program with no functions',
    why: ['A program keeps at least one function.'],
    unrunnable:
      'reaching it needs removing every function in one reply, which A0517 and the call checks reject first',
  },
  A0519: {
    cls: 'edit',
    message: "handle '{0}' edits '{1}', which this reply removes",
    fix: "keep '{1}' or send only whole function blocks",
    why: ['The reply has instruction lines for a function and also removes that function.'],
    unrunnable:
      'needs a removal of the handled function inside a reply that also edits it; covered by test/edit.test.ts',
  },
  A0520: {
    cls: 'limit',
    message: 'session handle limit ({0}) reached; close handles first',
    why: ['A session keeps at most 64 open handles; close views you no longer need.'],
    unrunnable: 'needs 64 open handles; covered by test/core.test.ts',
  },
  A0521: {
    cls: 'edit',
    message: 'fix all: no rejected reply to fix',
    fix: 'send edit lines; `fix all` applies the exact fixes of the last rejected reply',
    why: [
      '`fix all` replays the last rejected reply with every `exact` fix applied, atomically:',
      'all of it is validated before anything is committed. There is no rejected reply to fix',
      '(or the last reply was accepted).',
    ],
    example: { kind: 'edit', base: SQ, fn: 'sq', bad: 'fix all', good: 'a mul p0 3' },
  },

  // --- Patches, revisions, handles (A06nn) ----------------------------------------------
  A0601: {
    cls: 'patch',
    message: "expected 'patch <function> <revision>'",
    why: ['A standalone patch starts with `patch FUNCTION REVISION`.'],
    example: {
      kind: 'patch',
      base: SQ,
      fn: 'sq',
      bad: 'patch sq\na mul p0 3\nend',
      good: 'patch sq REV\na mul p0 3\nend',
    },
  },
  A0602: {
    cls: 'patch',
    message: 'revision must be 64 lowercase hex characters',
    why: ['The revision is the 64-hex SHA-256 shown by `a0 revision` and in the view.'],
    example: {
      kind: 'patch',
      base: SQ,
      fn: 'sq',
      bad: 'patch sq abc\na mul p0 3\nend',
      good: 'patch sq REV\na mul p0 3\nend',
    },
  },
  A0603: {
    cls: 'patch',
    message: "patch must end with 'end'",
    why: ['A patch is a header, replacement node lines, and a closing `end`.'],
    example: {
      kind: 'patch',
      base: SQ,
      fn: 'sq',
      bad: 'patch sq REV\na mul p0 3',
      good: 'patch sq REV\na mul p0 3\nend',
    },
  },
  A0604: {
    cls: 'patch',
    message: "unknown function '{0}'",
    why: ['The patch names a function that is not in the program.'],
    example: {
      kind: 'patch',
      base: SQ,
      fn: 'sq',
      bad: 'patch zz REV\na mul p0 3\nend',
      good: 'patch sq REV\na mul p0 3\nend',
    },
  },
  A0605: {
    cls: 'revision',
    message: "revision mismatch for '{0}': patch targets {1}…, current is {2}…",
    fix: "re-read '{0}' to obtain its current revision and re-issue the patch",
    why: [
      'The function changed since the patch was written; the revision is the content hash it',
      'was written against. Re-read the function and re-issue the patch.',
    ],
    example: {
      kind: 'patch',
      base: SQ,
      fn: 'sq',
      bad: `patch sq ${'0'.repeat(64)}\na mul p0 3\nend`,
      good: 'patch sq REV\na mul p0 3\nend',
    },
  },
  A0606: {
    cls: 'limit',
    message: 'patch too large',
    why: ['A patch is at most 1 MiB.'],
    unrunnable: 'needs a 1 MiB patch file; the size check is shared with A0016 and A0502',
  },
  A0610: {
    cls: 'handle',
    message: "unknown function '{0}'",
    why: ['A view or handle names a function that is not in the program.'],
    unrunnable:
      'raised by opening a view of a function that does not exist (session.open, a0_open, a0 view), not by a reply',
  },
  A0611: {
    cls: 'handle',
    message: "unknown handle '{0}'",
    fix: 'reply with the handle line exactly as shown at the top of the view',
    why: [
      'The reply names a handle that is not open (a view number you never opened, or a closed one).',
    ],
    example: { kind: 'edit', base: SQ, fn: 'sq', bad: 'e7\na mul p0 3', good: 'e0\na mul p0 3' },
  },
  A0612: {
    cls: 'handle',
    message: "invalid handle '{0}'",
    fix: 'start the reply with one of the handle lines shown in the view',
    why: ['The first line of a reply is a handle (e0, g0, ...) unless exactly one is open.'],
    example: {
      kind: 'edit',
      base: TWICE,
      fn: 'sq',
      open: ['sq', 'twice'],
      bad: 'x1\na mul p0 3',
      good: 'e0\na mul p0 3',
    },
  },
  A0613: {
    cls: 'handle',
    message: "handle '{0}' refers to a removed function",
    why: ['The function behind the handle was removed by an earlier edit; open a new view.'],
    unrunnable: 'a session closes the handle of a removed function; reachable only through the API',
  },
  A0614: {
    cls: 'handle',
    message: "handle '{0}' is stale: the program changed since the view was opened",
    why: ['A program handle is bound to the program revision it was opened at.'],
    unrunnable:
      'a session rebinds every handle after each edit, so only an out-of-session change makes one stale',
  },
  A0615: {
    cls: 'handle',
    message: "handle '{0}' is stale: '{1}' changed since the view was opened",
    why: ['A function handle is bound to the function revision it was opened at.'],
    unrunnable:
      'a session rebinds every handle after each edit, so only an out-of-session change makes one stale',
  },

  // --- Linker (A062n) -----------------------------------------------------------------
  A0620: {
    cls: 'structure',
    message: 'use cycle: {0} is already being linked{1}',
    fix: 'remove one direction of the use between these files',
    why: ['Two files `use` each other (directly or through others); a program is a DAG of files.'],
    unrunnable: 'needs files on disk; covered by the linker tests (test/core.test.ts)',
  },
  A0624: {
    cls: 'structure',
    message: 'profile mismatch: {0} is {1} but {2} is {3}',
    fix: 'give every file of the program the same `profile` line (or none): the profile is chosen per program',
    why: [
      'A file that `use`s another must declare the same profile as the files it uses: a library',
      'written for canonical wrapping cannot run under strict traps, or the other way round.',
      '`a0 ... --profile strict|canonical` overrides the choice for the whole program, not the',
      'agreement between the files.',
    ],
    unrunnable: 'needs files on disk; covered by the linker tests (test/profile.test.ts)',
  },
  A0621: {
    cls: 'limit',
    message: '{0}: source exceeds {1} bytes',
    why: ['One file of the program is larger than 1 MiB.'],
    unrunnable: 'needs a file on disk; same bound as A0016',
  },
  A0622: {
    cls: 'structure',
    message: 'use "{0}" in {1}: target {2} is not an .a0 file inside {3}',
    fix: 'use only .a0 files inside the project root',
    why: ['A `use` target must be an .a0 file inside the project root (after symlinks).'],
    unrunnable: 'needs files on disk; covered by the linker tests (test/core.test.ts)',
  },
  A0623: {
    cls: 'limit',
    message: 'linked program exceeds {0} bytes',
    why: ['The files of a program together are larger than 1 MiB.'],
    unrunnable: 'needs several large files on disk',
  },

  // --- Runtime and limits (A07nn) ----------------------------------------------------------
  A0701: {
    cls: 'limit',
    message: '{0}: fuel exhausted (execution budget exceeded)',
    why: [
      'The reference interpreter charges one unit of fuel per node evaluation and stops at',
      'the budget so a hostile program cannot run forever. Lower the work or raise `fuel`.',
    ],
    example: {
      kind: 'run',
      fn: 'f',
      args: [],
      fuel: 50,
      bad: `fn stp u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f -> u32\na fold stp 1000 0\nret a\nend\n`,
      good: `fn stp u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f -> u32\na fold stp 10 0\nret a\nend\n`,
    },
  },
  A0702: {
    cls: 'limit',
    message: 'io output exceeds {0} words',
    why: [
      'The reference evaluator keeps at most 2^20 output words per io state.',
      'Write less, or stream through a real target.',
    ],
    example: {
      kind: 'run',
      fn: 'f',
      args: ['io'],
      bad: `fn w io u32 -> io\nr write p0 p1\nret r\nend\nfn f io -> io\na fold w 1048577 p0\nret a\nend\n`,
      good: `fn w io u32 -> io\nr write p0 p1\nret r\nend\nfn f io -> io\na fold w 10 p0\nret a\nend\n`,
    },
  },
  A0703: {
    cls: 'runtime',
    message: '{0}: expected {1} arguments, got {2}',
    why: ['`run` got a different number of arguments than the function has parameters.'],
    example: { kind: 'run', fn: 'sq', args: [1, 2], goodArgs: [3], bad: SQ, good: SQ },
  },
  A0704: {
    cls: 'structure',
    message: '{0}: expected {1}',
    why: [
      'An argument value does not have the parameter type (a bool for u32, a number for bool,',
      'an array of the wrong length, a record of the wrong arity).',
    ],
    example: { kind: 'run', fn: 'sq', args: [true], goodArgs: [3], bad: SQ, good: SQ },
  },
  A0705: {
    cls: 'structure',
    message: '{0}: expected {1} elements',
    why: ['An array argument has a different length than the parameter type.'],
    example: {
      kind: 'run',
      fn: 'f',
      args: [[1]],
      goodArgs: [[1, 2]],
      bad: 'fn f u32x2 -> u32\na get p0 0\nret a\nend\n',
      good: 'fn f u32x2 -> u32\na get p0 0\nret a\nend\n',
    },
  },
  A0706: {
    cls: 'structure',
    message: '{0}: expected {1} fields',
    why: ['A record argument has a different number of fields than the parameter type.'],
    unrunnable:
      'covered by the interpreter tests; the shared argument checker is exercised with A0704',
  },
  A0707: {
    cls: 'limit',
    message: '{0}: array length {1} exceeds the {2} limit {3}',
    fix: 'keep arrays at most {3} long for {2}, or compile to a native target',
    why: [
      'Hardware and GPU targets keep aggregates in registers or bit vectors, so arrays are',
      'limited to 1024 elements there.',
    ],
    unrunnable:
      'raised by the SystemVerilog and Metal backends, which the explain examples do not run',
  },
  A0708: {
    cls: 'structure',
    message: 'io has no bit-level representation (sequential hardware state is not implemented)',
    why: ['The io token has no bit-vector form, so the hardware target cannot carry it.'],
    unrunnable: 'raised by the SystemVerilog backend, which the explain examples do not run',
  },
  A0709: {
    cls: 'limit',
    message: '{0}: iteration cap reached',
    why: [
      'A run with a total fold/loop trip cap (`--max-trips`, `maxTrips`) stops when the cap is spent.',
      'Raise the cap or lower the fold/loop counts on the call chain.',
    ],
    unrunnable: 'needs the trip cap option, which the explain examples do not set',
  },
  A0710: {
    cls: 'runtime',
    message: '{0}: index out of bounds (strict profile)',
    why: [
      'Under `profile strict`, get, set, at and put with an index at or past the length trap',
      'instead of wrapping the index. The trap names the function and, inside a fold or loop,',
      'the node and the trip. `cget A I` is the total read: (value, in range).',
    ],
    example: {
      kind: 'run',
      fn: 'f',
      args: [5],
      goodArgs: [1],
      bad: 'profile strict\nfn f u32 -> u32\na arr 1 2\nb get a p0\nret b\nend\n',
      good: 'profile strict\nfn f u32 -> u32\na arr 1 2\nb get a p0\nret b\nend\n',
    },
  },
  A0711: {
    cls: 'runtime',
    message: '{0}: division by zero (strict profile)',
    why: [
      'Under `profile strict`, div and rem with a zero divisor trap; the canonical profile',
      'yields all ones and the dividend. `cdiv` and `crem` return (0,false) for a zero divisor.',
    ],
    example: {
      kind: 'run',
      fn: 'f',
      args: [0],
      goodArgs: [3],
      bad: 'profile strict\nfn f u32 -> u32\na div 12 p0\nret a\nend\n',
      good: 'profile strict\nfn f u32 -> u32\na div 12 p0\nret a\nend\n',
    },
  },
  A0712: {
    cls: 'runtime',
    message: '{0}: read of exhausted input (strict profile)',
    why: [
      'Under `profile strict`, a read after the last input word traps; the canonical profile',
      'yields 0 and keeps the position.',
    ],
    unrunnable: 'needs an io token with a chosen input, which the explain examples do not set',
  },
  A0713: {
    cls: 'structure',
    message: 'target {0} cannot compile {1}',
    fix: 'compile it for js, c, java, dotnet, wasm, arm64, x86_64, riscv64, arm32 or avr, or run it with the reference interpreter (`a0 run`); or make every site provably safe (an index under an `and` mask, a literal, or `rem` by a literal; a divisor that is a nonzero literal or has one `or`ed in) so the strict program has nothing to trap on; or drop the checked op',
    why: [
      'A program that uses a checked op (cadd csub cmul cdiv crem cget) is refused by a target that does not',
      'implement it, and so is a `profile strict` program with a site that can trap: a get or set whose index',
      'is not proved below the length, a div or rem whose divisor is not proved nonzero, a read, or a call of',
      'a function that has one. js, c, java, dotnet, wasm, arm64, x86_64, riscv64, arm32 and avr implement',
      'both (STRICT_TARGETS). A strict program with every site proved safe cannot trap and compiles on the',
      'others as the canonical program; the message names the first site that blocks it, as function.node: why.',
    ],
    unrunnable: 'raised by the emitters, which the explain examples do not run',
  },
  A0714: {
    cls: 'structure',
    message: 'spec of {0}: {1}',
    why: [
      'Spec lines sit between the fn header and the first node: `ex ARGS -> RESULT` (an example, at most',
      'three), `pre OP ARGS` and `post OP ARGS` (one operation over p0..pN, and r in post, that is bool).',
      'A literal is a number, true, false, an array [1;2;3] or a record (1;true). The line is malformed,',
      'or its literals and operands do not fit the function signature, or the function takes io.',
    ],
    example: {
      kind: 'source',
      bad: 'fn f u32 -> u32\nex 1 2 -> 3\na add p0 1\nret a\nend\n',
      good: 'fn f u32 -> u32\nex 1 -> 2\na add p0 1\nret a\nend\n',
    },
  },
  A0715: {
    cls: 'structure',
    message: '{0}: ex {1} failed: input {2}, expected {3}, got {4}',
    fix: 'make {0} return {3} for {2}, or change ex {1}; `-ex ARGS -> RESULT` removes an example',
    why: [
      'Every `ex` line is run on the reference interpreter when the program is validated, so an edit',
      'that changes what the function returns is rejected by the example it breaks. Either the function',
      'or the example is wrong: fix the function, change the expected value, or remove the line with',
      '`-ex ARGS -> RESULT` (removing an example is always allowed).',
    ],
    example: {
      kind: 'source',
      bad: 'fn f u32 -> u32\nex 1 -> 3\na add p0 1\nret a\nend\n',
      good: 'fn f u32 -> u32\nex 1 -> 2\na add p0 1\nret a\nend\n',
    },
  },
  A0716: {
    cls: 'structure',
    message: '{0}: ex {1} breaks {2}: {3}',
    fix: 'make {0} satisfy its {2} on ex {1}, or change that example or the {2} line; `-ex ARGS -> RESULT` removes an example',
    why: [
      '`pre` and `post` are evaluated on every example: `pre` on its arguments, `post` on its arguments',
      'and the result r. An example outside the precondition, or a result that fails the postcondition,',
      'is rejected. Fix the function, the example or the contract line.',
    ],
    example: {
      kind: 'source',
      bad: 'fn f u32 -> u32\nex 20 -> 21\npre lt p0 10\na add p0 1\nret a\nend\n',
      good: 'fn f u32 -> u32\nex 5 -> 6\npre lt p0 10\na add p0 1\nret a\nend\n',
    },
  },
  A0717: {
    cls: 'structure',
    message: 'contract of {0} disproved: {1}',
    fix: 'make {0} satisfy its post for every input that satisfies pre, or change the pre or post line',
    why: [
      '`a0 check --prove` asks Z3 whether some input satisfies pre and breaks post (or makes the function,',
      'pre or post trap, under the strict profile). The message gives that input; the reference interpreter',
      'ran it and confirmed the failure. Reported as a warning unless `--deny-disproved` makes it an error.',
    ],
    unrunnable: 'raised by `a0 check --prove` (the solver), which the explain examples do not run',
  },
  A0718: {
    cls: 'limit',
    message: 'contract of {0} unknown: {1}',
    fix: 'keep {0} inside the proof scope (u32 and bool values, arrays up to 16 elements, fold and loop counts of at most 64 literals, no io), raise --prove-timeout, or leave the contract to the examples',
    why: [
      '`a0 check --prove` proves `pre` and `post` for all inputs with Z3 over 32-bit bitvectors, inside the',
      'same scope as the optimizer proof. A function outside it, an array that is too large, or a solver',
      'timeout leaves the contract unproved: a note, not a failure. The examples still check it.',
    ],
    unrunnable: 'raised by `a0 check --prove` (the solver), which the explain examples do not run',
  },
  A0719: {
    cls: 'limit',
    message: '{0}: {1} used more than {2} evaluations',
    fix: 'use a smaller input for the example, or remove the line: examples run with a small fuel',
    why: [
      'An example, a `pre` or a `post` runs under a fuel of 10000 node evaluations when the program is',
      'validated (`a0 run` has its own budget). A fold or loop over a large count does not fit; give',
      'the example a small input.',
    ],
    example: {
      kind: 'source',
      bad: 'fn inc u32 u32 -> u32\na add p0 1\nret a\nend\nfn f u32 -> u32\nex 1 -> 20001\nr fold inc 20000 p0\nret r\nend\n',
      good: 'fn inc u32 u32 -> u32\na add p0 1\nret a\nend\nfn f u32 -> u32\nex 1 -> 11\nr fold inc 10 p0\nret r\nend\n',
    },
  },
  A0720: {
    cls: 'edit',
    message: '{0}: no line `{1}` to remove',
    fix: 'remove a spec line exactly as the view shows it: `-ex ARGS -> RESULT`, `-pre` or `-post`',
    why: [
      'The edit `-ex ARGS -> RESULT` removes the example written exactly so (literals are compared',
      'after normalizing their spelling); `-pre` and `-post` remove the contract line, and name it only',
      'when the function has one. `+ex`, `+pre` and `+post` add or replace a line.',
    ],
    example: {
      kind: 'edit',
      base: 'fn f u32 -> u32\nex 1 -> 2\na add p0 1\nret a\nend\n',
      fn: 'f',
      bad: '-ex 9 -> 9',
      good: '-ex 1 -> 2',
    },
  },
  A0790: {
    cls: 'structure',
    message: '{0}',
    why: [
      'An evaluator invariant that holds for every validated program was violated.',
      'A validated program cannot reach it; report the program if one does.',
    ],
    unrunnable: 'internal invariant: unreachable from validated programs',
  },
  A0792: {
    cls: 'type',
    message: "{0}: untyped node '{1}'",
    why: [
      'The validator lost the type of a node it already checked.',
      'A validated program cannot reach it; report the program if one does.',
    ],
    unrunnable: 'internal invariant: unreachable from validated programs',
  },
  A0791: {
    cls: 'runtime',
    message: '{0}',
    why: [
      'The interpreter lost a binding that validation guarantees.',
      'A validated program cannot reach it; report the program if one does.',
    ],
    unrunnable: 'internal invariant: unreachable from validated programs',
  },

  // --- Tools (A08nn) ----------------------------------------------------------------------------
  A0801: {
    cls: 'limit',
    message: "path '{0}' is outside the server root",
    fix: 'use a path inside the directory the server was launched with',
    why: ['The MCP and language servers read and write only inside their root.'],
    unrunnable: 'needs a running server; covered by test/mcp.test.ts',
  },
  A0802: {
    cls: 'limit',
    message: "'{0}' is not an .a0 file",
    why: ['The servers handle .a0 files only, after symlinks are followed.'],
    unrunnable: 'needs a running server; covered by test/mcp.test.ts',
  },
  A0803: {
    cls: 'handle',
    message: "no such file '{0}'",
    why: ['The named file does not exist inside the server root.'],
    unrunnable: 'needs a running server; covered by test/mcp.test.ts',
  },
  A0804: {
    cls: 'limit',
    message: 'output exceeds {0} characters',
    why: ['A tool result is bounded; ask for one function instead of the whole program.'],
    unrunnable: 'needs a running server; covered by test/mcp.test.ts',
  },
  A0805: {
    cls: 'handle',
    message: 'file is required when the server root is a directory',
    fix: 'pass file: a path relative to the server root',
    why: ['The server was launched on a directory, so every tool call names its file.'],
    unrunnable: 'needs a running server; covered by test/mcp.test.ts',
  },
  A0806: {
    cls: 'edit',
    message: 'nothing to save: no edit has been applied',
    fix: 'call a0_apply first',
    why: ['`a0_save` writes an edited program; no edit was applied since the last save.'],
    unrunnable: 'needs a running server; covered by test/mcp.test.ts',
  },
  A0807: {
    cls: 'edit',
    message: 'program spans several files (use); save to a new path',
    fix: 'pass path: a new .a0 file inside the root',
    why: ['An edited program that uses other files is saved flat, to a new path.'],
    unrunnable: 'needs a running server; covered by test/mcp.test.ts',
  },
  A0808: {
    cls: 'structure',
    message: 'file system error {0}',
    why: ['A file operation failed; only the error code is reported, never a host path.'],
    unrunnable: 'needs a running server; covered by test/mcp.test.ts',
  },
  A0809: {
    cls: 'structure',
    message: 'internal error',
    why: ['An unexpected failure inside a tool; only this text is reported, never host details.'],
    unrunnable: 'internal: unreachable by construction',
  },
  A0810: {
    cls: 'structure',
    message: 'source too large',
    why: ['The file given to the command line is larger than 1 MiB.'],
    unrunnable: 'needs a file on disk; same bound as A0016',
  },
  A0811: {
    cls: 'structure',
    message: "invalid argument '{0}'",
    why: ['`a0 run` arguments are decimal u32 numbers, true or false.'],
    unrunnable: 'command-line input; covered by test/core.test.ts',
  },
  A0813: {
    cls: 'cli',
    message: "no diagnostic '{0}'",
    fix: 'run `a0 explain` for the list of codes',
    why: ['`a0 explain` takes a code of the form A0nnnn from the diagnostics table.'],
    unrunnable: 'command-line input; covered by test/diagnostics.test.ts',
  },
  A0814: {
    cls: 'structure',
    message: "invalid {0} '{1}'",
    why: [
      'A `--fuel=N` or `--max-trips=N` flag takes a non-negative decimal integer; `--profile` takes',
      '`strict` or `canonical`.',
    ],
    unrunnable: 'command-line input; covered by test/trap.test.ts',
  },
  A0812: {
    cls: 'structure',
    message: "unknown function '{0}'",
    why: ['The command names a function that is not in the program.'],
    unrunnable: 'command-line input; covered by test/core.test.ts',
  },
} as const satisfies Record<string, Spec>;

/**
 * The exact fixes: every (code, rule) pair a diagnostic can attach as `exact` edits. The reject
 * corpus (corpus/reject) has to exercise each pair; `a0 reject --coverage` lists the ones it does not.
 */
export const EXACT_FIXES: readonly {
  readonly id: DiagId;
  readonly rule: string;
  readonly what: string;
}[] = [
  { id: 'A0003', rule: 'comma', what: 'commas between operands become spaces' },
  { id: 'A0003', rule: 'hex', what: 'a hexadecimal literal becomes its decimal value' },
  { id: 'A0003', rule: 'case', what: 'an uppercase parameter, id or boolean is lowercased' },
  { id: 'A0005', rule: 'colon', what: 'a colon after the node id is removed' },
  { id: 'A0010', rule: 'nested', what: 'a parenthesised operand moves to its own line above' },
  { id: 'A0011', rule: 'case', what: 'an uppercase op or function name is lowercased' },
  { id: 'A0011', rule: 'assign', what: 'an `=` between the id and the op is removed' },
  { id: 'A0013', rule: 'case', what: 'an uppercase callee is lowercased' },
  { id: 'A0025', rule: 'end', what: 'a missing `end` after ret is added' },
  { id: 'A0102', rule: 'mod', what: 'a `mod` (or `umod`) op becomes `rem`, the same on u32' },
  {
    id: 'A0220',
    rule: 'array-op',
    what: '`at` or `put` written on an array becomes `get` or `set` at the same index',
  },
  {
    id: 'A0503',
    rule: 'sequence',
    what: 'a second line for an id that reads the first gets it under a fresh id',
  },
  { id: 'A0516', rule: 'signature', what: '`-fn name` loses the signature that follows it' },
];

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const fill = (template: string, args: readonly (string | number)[]): string =>
  template.replace(/\{(\d+)\}/g, (m, k: string) => {
    const v = args[Number(k)];
    return v === undefined ? m : String(v);
  });

export interface DiagOptions {
  readonly line?: number;
  readonly expected?: string;
  readonly actual?: string;
  /** Overrides the table's fix template (a fix computed from the failing input). */
  readonly fix?: string;
  readonly applicability?: Applicability;
  readonly edits?: readonly FixEdit[];
  /** The budget stop, for the limit rows of the interpreter. */
  readonly trap?: Trap;
  /** The spec line the diagnostic is about. */
  readonly spec?: SpecFault;
}

/** The error for row `id`: message and static fix from the table, the dynamic parts from `opts`. */
export function diag(
  id: DiagId,
  args: readonly (string | number)[] = [],
  opts: DiagOptions = {},
): A0Error {
  const spec: Spec = DIAGNOSTICS[id];
  const fix = opts.fix ?? (spec.fix === undefined ? undefined : fill(spec.fix, args));
  const edits = opts.edits ?? [];
  const applicability =
    opts.applicability ?? (edits.length > 0 ? 'maybe' : fix === undefined ? undefined : 'maybe');
  return new A0Error(fill(spec.message, args), opts.line, {
    code: spec.cls,
    id,
    ...(opts.expected === undefined ? {} : { expected: opts.expected }),
    ...(opts.actual === undefined ? {} : { actual: opts.actual }),
    ...(fix === undefined ? {} : { fix }),
    ...(applicability === undefined ? {} : { applicability }),
    ...(edits.length === 0 ? {} : { edits }),
    ...(opts.trap === undefined ? {} : { trap: opts.trap }),
    ...(opts.spec === undefined ? {} : { spec: opts.spec }),
  });
}

/** Rows in code order. */
export function diagnosticIds(): DiagId[] {
  return (Object.keys(DIAGNOSTICS) as DiagId[]).sort();
}

export function isDiagId(text: string): text is DiagId {
  return Object.hasOwn(DIAGNOSTICS, text);
}
