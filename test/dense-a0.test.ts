/**
 * The Stage A and B1 dense reader, written in A0 (compiler/dense.a0, entry `canonfn`): the node check.
 *
 * A dense text (src/dense.ts formatDense) is read by the A0 program through the reference
 * interpreter, and its canonical text must equal formatProgram of the program and its error flag
 * must be clear. Two sets are checked:
 *   corpus   every accepted program (corpus, examples, compiler, site) whose forms are Stage A: no
 *            calls or direct callees, fold, loop, arrays (their ops and types), text, io, comments,
 *            `$` escapes, `=`, inline bodies, repeat, spec lines, hex literals, profile lines. The
 *            Stage A forms are ids, nesting, default names, records, `use` lines, and the
 *            arithmetic, comparison, select, mov, rec, at and put operations.
 *   random   programs of the same forms, generated from a fixed seed: records of one to four
 *            fields, nesting, default and explicit names, parameters, literals and `use` lines.
 * Stage B1 adds calls: a call of a function defined earlier in the same input (bare `g A B` or
 * `call g A B`), whose arity is the callee header's type count or, for an untyped header, the
 * body's highest parameter. A callee in a used file, a later function or the function itself, a
 * wrong operand count and an overflow of a capacity must set the error flag.
 * Stage B2 adds fold and loop, with a function name or an inline body `{statements}` after the word
 * (the bodies of a function are lifted to the helpers CALLER_1, CALLER_2, ..., with the signature
 * the reference reader derives), and the type the reference reader gives an unwritten result. The
 * corpus set takes in every program that uses only these forms and fits the input capacity; 300
 * generated programs of fold and loop (inline and named bodies, extra operands, nesting, names and
 * `ret` in bodies, bool states) and 300 token-level mutants of them must read as the reference
 * reads them (a program the reference rejects must set the error flag; one it accepts must read to
 * the same text, or set the error flag when it uses a form outside the reader).
 * Stage B3.1 adds arrays: the types (u32x4, boolx2x3, (u32,bool)x128x32), the literal `[a b c]`, get
 * and set. The corpus set takes in every program of these forms that fits the input capacity and
 * the array regions; 250 generated programs (typed headers, nested literals, arrays and records in
 * arrays, calls with array parameters and results, an unwritten result inferred from get), 400
 * token-level mutants of 60 of them, a curated list of types at their size limits, and the
 * capacities of the regions of the array elements must read as the reference reads them.
 * Stage B3.2 adds the repeat form `[x;n]`, the `$` escape of an id (a keyword, a function name or a
 * type-like word) and `=` after the name of a statement; 250 generated programs, each as the
 * printer writes it, with `=` after names and with more ids escaped, and 500 mutants of 60 of them.
 * Stage B3.3 adds the type io (a parameter, a result, a field of a record, never an element of an
 * array) and the operations read, write and puts; 250 generated programs that use the token once as
 * the checker demands, 500 mutants of 60 of them, and a curated list. The `io` word for the one io
 * parameter of a function (the reference reads it) is outside the reader.
 * Stage B3.4 adds text literals, `"abc"` and `text "abc"` (the escapes \n, \t, \" and \\; a raw tab
 * is written \t), and the `use` line as one string: 250 generated programs with texts of every
 * byte the lexer marks, 500 mutants of 60 of them, and a curated list.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import {
  A0Error,
  formatProgram,
  formatTextLiteral,
  type Program,
  parse,
  parseAndValidate,
  run,
  type Type,
  type TypedFunc,
  type Value,
} from '../src/core.js';
import { defaultNames, formatDense, parseDense } from '../src/dense.js';
import { isReject, listSources, ROOT } from '../tools/dense-loader.js';

/** The reader's input and output capacity: 128 pages of 128 bytes (compiler/dense.a0). */
const PAGES = 128;
const PAGE = 128;

const STAGE_A_OPS: ReadonlySet<string> = new Set([
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
  'rec',
  'at',
  'put',
  'div',
  'rem',
]);

/** A type of the Stage A forms: u32, bool, or a record of such types (no arrays, no io). */
function stageAType(t: Type): boolean {
  if (t === 'u32' || t === 'bool') return true;
  return typeof t !== 'string' && t.kind === 'rec' && t.fields.every(stageAType);
}

/** A type of the reader's forms: u32, bool, io, or a record or an array of such types. */
function stageType(t: Type): boolean {
  if (t === 'u32' || t === 'bool' || t === 'io') return true;
  if (typeof t === 'string') return false;
  return t.kind === 'rec' ? t.fields.every(stageType) : stageType(t.elem);
}

/** The array operations of Stage B3.1: the literal `[a b c]`, get and set; and of B3.3: read, write, puts. */
const ARRAY_OPS: ReadonlySet<string> = new Set(['arr', 'get', 'set', 'read', 'write', 'puts']);

/** Whether a canonical program is in the Stage A forms (the dense text is checked separately). */
function isStageA(p: Program): boolean {
  if (p.profile !== undefined) return false;
  return p.functions.every(
    (f) =>
      f.spec === undefined &&
      f.params.every(stageAType) &&
      stageAType(f.result) &&
      f.nodes.every((n) => STAGE_A_OPS.has(n.op)),
  );
}

/** A type with no record in it (the type of an inline body's state and extra operands). */
function scalarType(t: Type): boolean {
  return t === 'u32' || t === 'bool';
}

/**
 * Stage B3: the Stage A forms plus calls, folds and loops of functions defined earlier in the same
 * program, arrays (their types and the operations arr, get and set), and io (the type and the
 * operations read, write and puts). A program with an inline body `{...}` has scalar types only and
 * no array or io operation (a record or array state is outside the reader: the lifted body's
 * signature would have to write it).
 */
function isStageB3(p: Program, dense: string): boolean {
  if (p.profile !== undefined) return false;
  const defined = new Set<string>();
  const folds = dense.replace(/"(?:[^"\\]|\\.)*"/g, '""').includes('{');
  for (const f of p.functions) {
    const earlier = (name: string | undefined): boolean =>
      name !== undefined && defined.has(name) && name !== f.name;
    const ok =
      f.spec === undefined &&
      f.params.every(stageType) &&
      stageType(f.result) &&
      (!folds || (f.params.every(scalarType) && scalarType(f.result))) &&
      f.nodes.every(
        (n) =>
          STAGE_A_OPS.has(n.op) ||
          (!folds && ARRAY_OPS.has(n.op)) ||
          (n.op === 'call' && earlier(n.callee)) ||
          (n.op === 'fold' && earlier(n.callee)) ||
          (n.op === 'loop' && earlier(n.callee) && earlier(n.pred)),
      );
    if (!ok) return false;
    defined.add(f.name);
  }
  return true;
}

/** The reader over the A0 source: the dense text in, the canonical text and the error flag out. */
function loadReader(): (text: string) => { text: string; err: boolean } {
  const source = readFileSync(join(ROOT, 'compiler', 'dense.a0'), 'utf8');
  const fn = parseAndValidate(source).functions.find((f: TypedFunc) => f.name === 'canonfn');
  assert.ok(fn, 'compiler/dense.a0 defines canonfn');
  return (text) => {
    const bytes = Buffer.from(text, 'utf8');
    assert.ok(bytes.length <= PAGES * PAGE, 'the dense text is within the reader capacity');
    const pages: Value[] = [];
    for (let p = 0; p < PAGES; p += 1) {
      const page: Value[] = [];
      for (let k = 0; k < PAGE; k += 1) page.push(bytes[p * PAGE + k] ?? 0);
      pages.push(page);
    }
    // A program near the capacity costs more than the default budget of run.
    const options = { fuel: 4_000_000_000 };
    const result = run(fn, [pages, bytes.length], options) as [[Value[], number], boolean];
    const [[out, pos], err] = result;
    const outBytes: number[] = [];
    // An output past the page capacity is flagged by the reader; its text is the pages it has.
    for (let i = 0; i < Math.min(pos, PAGES * PAGE); i += 1) {
      const page = out[i >> 7] as Value[];
      outBytes.push(page[i & 127] as number);
    }
    return { text: Buffer.from(outBytes).toString('utf8'), err };
  };
}

/** A deterministic generator of canonical programs of the Stage A forms (the seed fixes them). */
function generator(seed0: number): {
  rnd: (n: number) => number;
  program: () => string;
  callProgram: (t: number) => string;
} {
  let seed = seed0 | 0;
  const rnd = (n: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let z = seed;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) % n;
  };
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  // The words the dense text reads as keywords, types and spec words: never a plain id.
  const reserved = new Set([
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
    'cadd',
    'csub',
    'cmul',
    'cdiv',
    'crem',
    'cget',
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
    'u32',
    'bool',
    'io',
    'mod',
    'retval',
    'pre',
    'post',
    's',
    'i',
  ]);
  /** The default id sequence a, b, ..., z, aa, ... (the k-th name, before the skips). */
  const defaultName = (k: number): string => {
    let n = k + 1;
    let s = '';
    while (n > 0) {
      n -= 1;
      s = String.fromCharCode(97 + (n % 26)) + s;
      n = Math.floor(n / 26);
    }
    return s;
  };
  const explicitName = (taken: Set<string>): string => {
    for (;;) {
      let s = '';
      const len = 1 + rnd(3);
      for (let k = 0; k < len; k += 1) s += String.fromCharCode(97 + rnd(26));
      if (!reserved.has(s) && !taken.has(s)) return s;
    }
  };
  const binary = ['add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr', 'div', 'rem'];
  const compare = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];
  /** Call programs: u32 only, with calls of earlier functions (opts); else the Stage A forms. */
  interface CallOpts {
    readonly np: number;
    readonly callees: readonly { readonly name: string; readonly arity: number }[];
    /** The first node calls the first callee (so its arity is exercised), or uses the last parameter. */
    readonly forceFirst: boolean;
    readonly useLast: boolean;
  }
  const fn = (fname: string, opts?: CallOpts): string => {
    const np = opts?.np ?? rnd(4);
    const params =
      opts === undefined
        ? Array.from({ length: np }, () => pick(['u32', 'u32', 'bool', '(u32,bool)', 'u32']))
        : Array.from({ length: np }, () => 'u32');
    const result = opts === undefined ? pick(['u32', 'u32', 'bool', '(u32,bool)']) : 'u32';
    const lines: string[] = [];
    const ids: string[] = [];
    const taken = new Set([fname]);
    let dk = 0;
    const nodes = opts === undefined ? 1 + rnd(8) : 1 + rnd(6);
    let pending: string | null = null;
    const operand = (): string => {
      if (pending !== null && rnd(8) !== 0) {
        const p = pending;
        pending = null;
        return p;
      }
      const r = rnd(10);
      if (r < 6 && np > 0) return `p${rnd(np)}`;
      if (r < 7 && opts === undefined) return pick(['true', 'false']);
      return String(rnd(40));
    };
    for (let k = 0; k < nodes; k += 1) {
      let id: string;
      if (rnd(8) !== 0) {
        let cand: string;
        do {
          cand = defaultName(dk);
          dk += 1;
        } while (reserved.has(cand) || taken.has(cand));
        id = cand;
      } else {
        id = explicitName(taken);
      }
      taken.add(id);
      const kind = rnd(10);
      let rhs: string;
      if (opts !== undefined) {
        const first = opts.callees[0];
        if (k === 0 && opts.forceFirst && first !== undefined) {
          const args = Array.from({ length: first.arity }, operand);
          rhs = ['call', first.name, ...args].join(' ');
        } else if (k === 0 && opts.useLast && np > 0) {
          rhs = `${pick(binary)} p${np - 1} ${operand()}`;
        } else if (kind < 5 && opts.callees.length > 0) {
          const c = pick(opts.callees);
          const args = Array.from({ length: c.arity }, operand);
          rhs = ['call', c.name, ...args].join(' ');
        } else if (kind < 8) rhs = `${pick(binary)} ${operand()} ${operand()}`;
        else rhs = `mov ${operand()}`;
      } else if (kind < 5) rhs = `${pick(binary.concat(compare))} ${operand()} ${operand()}`;
      else if (kind < 6) rhs = `select ${operand()} ${operand()} ${operand()}`;
      else if (kind < 7) rhs = `mov ${operand()}`;
      else if (kind < 8) {
        const fields = Array.from({ length: 1 + rnd(4) }, operand);
        rhs = `rec ${fields.join(' ')}`;
      } else if (kind < 9) rhs = `at ${operand()} ${rnd(3)}`;
      else rhs = `put ${operand()} ${rnd(3)} ${operand()}`;
      lines.push(`${id} ${rhs}`);
      ids.push(id);
      pending = rnd(4) !== 0 ? id : null;
    }
    const ret = rnd(3) === 0 ? pick(ids) : (ids[ids.length - 1] as string);
    const header = `fn ${fname}${params.length > 0 ? ` ${params.join(' ')}` : ''} -> ${result}`;
    return `${header}\n${lines.join('\n')}\nret ${ret}\nend\n`;
  };
  const program = (): string => {
    const nf = 1 + rnd(3);
    const fns: string[] = [];
    for (let f = 0; f < nf; f += 1) fns.push(fn(`f${f}x${rnd(9)}`));
    return fns.join('\n');
  };
  /**
   * A program of u32 functions where later ones call earlier ones. Helper 0 takes `(t % 44) + 1`
   * parameters, so 44 programs cover every arity from 1 to 44, and the last function calls it.
   */
  const callProgram = (t: number): string => {
    const callees: { name: string; arity: number }[] = [];
    const fns: string[] = [];
    const nf = 2 + rnd(3);
    for (let f = 0; f < nf; f += 1) {
      const name = `h${f}x${rnd(9)}`;
      const np = f === 0 ? (t % 44) + 1 : rnd(4) === 0 ? 0 : 1 + rnd(f === nf - 1 ? 5 : 12);
      fns.push(
        fn(name, {
          np,
          callees: callees.slice(),
          forceFirst: f === nf - 1 || (f > 0 && rnd(3) === 0),
          useLast: f === 0 && t % 2 === 0,
        }),
      );
      callees.push({ name, arity: np });
    }
    return fns.join('\n');
  };
  return { rnd, program, callProgram };
}

/** Programs with an expression that nests deeper than the 8 frames of the reader (ten writes in one). */
const DEEP: ReadonlySet<string> = new Set(['compiler/macho.a0', 'site/lib/frame.a0']);

/** Whether the sizes of a program are within the capacities of the reader (see compiler/dense.a0). */
function withinCapacity(p: Program, dense: string): boolean {
  if (Buffer.byteLength(dense, 'utf8') > PAGES * PAGE) return false;
  const tokens = dense.match(/[^\s()[\],;{}]+|[()[\],;{}]/g) ?? [];
  if (tokens.length > 4096 || dense.split('\n').length > 2048) return false;
  if (p.functions.length > 512) return false;
  let nodes = 0;
  const regions = [2112, 448, 64, 64, 64, 64, 64, 64];
  const used = regions.map(() => 0);
  for (const f of p.functions) {
    nodes += f.nodes.length;
    // the depth of an array node: the frames open around it in the dense text are not known here, so
    // the size of every array is held against the largest region (the first level) and the total
    for (const n of f.nodes) {
      // a text literal keeps its token, not its bytes
      if (n.op === 'arr' && n.text === undefined) used[0] = (used[0] as number) + n.args.length;
      // a record has up to four fields in a frame of the reader
      if (n.op === 'rec' && n.args.length > 4) return false;
    }
  }
  return nodes <= 2048 && (used[0] as number) <= (regions[0] as number);
}

test('the Stage A, B1, B2 and B3.1 reader: accepted programs in the Stage A forms plus calls, folds, loops and arrays read to their canonical text', (t) => {
  const read = loadReader();
  const members: string[] = [];
  const refusedMembers: string[] = [];
  let checked = 0;
  let withCalls = 0;
  let withFolds = 0;
  let stageA = 0;
  let tooBig = 0;
  let sources = 0;
  for (const abs of listSources(ROOT)) {
    if (isReject(abs, ROOT)) continue;
    sources += 1;
    const program = parse(readFileSync(abs, 'utf8'));
    const dense = formatDense(program);
    if (!isStageB3(program, dense)) continue;
    const name = relative(ROOT, abs).split(sep).join('/');
    if (!withinCapacity(program, dense) || DEEP.has(name)) {
      tooBig += 1;
      continue;
    }
    members.push(name);
    const got = read(dense);
    if (got.err) {
      refusedMembers.push(name);
      continue;
    }
    assert.equal(got.text, formatProgram(program), `${name}: canonical text`);
    checked += 1;
    if (isStageA(program)) stageA += 1;
    else if (program.functions.some((f) => f.nodes.some((n) => n.op === 'fold' || n.op === 'loop')))
      withFolds += 1;
    else withCalls += 1;
  }
  t.diagnostic(
    `${checked} of ${sources} accepted programs read (${stageA} in the Stage A forms, ${withCalls} with calls or arrays, ${withFolds} with folds or loops); ${tooBig} over the capacities`,
  );
  assert.deepEqual(refusedMembers, [], 'the reader refuses a program of the forms it reads');
  assert.ok(withCalls > 0, 'some accepted programs use calls');
  assert.ok(withFolds > 0, 'some accepted programs use fold or loop');
  assert.ok(
    members.includes('site/sentinel/layout.a0') &&
      members.includes('corpus/reject/array-at.fixed.a0'),
    'programs with arrays are members',
  );
  assert.ok(
    members.includes('examples/life.a0') && members.includes('corpus/reject/io-twice.fixed.a0'),
    'programs with io are members',
  );
  assert.ok(members.includes('site/gen/sgwords.a0'), 'programs with text literals are members');
  assert.ok(
    members.includes('corpus/reject/typo-loop-pred.fixed.a0'),
    'a program with a loop of named functions is a member',
  );
  assert.ok(
    members.includes('examples/kernels.a0'),
    'examples/kernels.a0 (nesting, parameters, every Stage A operation) is a member',
  );
});

test('the Stage A reader: generated programs of the Stage A forms read to their canonical text', () => {
  const read = loadReader();
  const gen = generator(12345);
  let checked = 0;
  for (let t = 0; t < 300; t += 1) {
    const canonical = gen.program();
    const program = parse(canonical);
    let dense = formatDense(program);
    if (gen.rnd(4) === 0) dense = `use "lex.a0"\n${dense}`;
    const got = read(dense);
    assert.equal(got.err, false, `program ${t}: the error flag is clear\n${dense}`);
    assert.equal(got.text, formatProgram(program), `program ${t}\n${dense}`);
    checked += 1;
  }
  assert.equal(checked, 300);
});

/** The reference reading of dense text: the canonical text of parseDense, or null when it rejects. */
function reference(text: string): string | null {
  try {
    return formatProgram(parseDense(text));
  } catch (e) {
    if (e instanceof A0Error) return null;
    throw e;
  }
}

/** The reader and the reference agree: both reject, or both accept with the same canonical text. */
function agree(
  read: (text: string) => { text: string; err: boolean },
  text: string,
  label: string,
) {
  const want = reference(text);
  const got = read(text);
  if (want === null)
    assert.equal(got.err, true, `${label}: the reader flags what the reference rejects\n${text}`);
  else {
    assert.equal(got.err, false, `${label}: the error flag is clear\n${text}`);
    assert.equal(got.text, want, `${label}: canonical text\n${text}`);
  }
  return want !== null;
}

test('the B1 reader: generated call programs (arities 1 to 44, nesting, earlier callees) read to their canonical text', () => {
  const read = loadReader();
  const gen = generator(777);
  const arities = new Set<number>();
  let nested = 0;
  for (let t = 0; t < 300; t += 1) {
    const canonical = gen.callProgram(t);
    const program = parse(canonical);
    for (const f of program.functions)
      for (const n of f.nodes) {
        if (n.op === 'call') arities.add(n.args.length);
      }
    const dense = formatDense(program);
    if (/\b[a-z0-9]+ [a-z0-9]+ [A-Zp0-9]/.test(dense) && /\bh\dx\d [a-z]+ /.test(dense))
      nested += 1;
    const got = read(dense);
    assert.equal(got.err, false, `call program ${t}: the error flag is clear\n${dense}`);
    assert.equal(got.text, formatProgram(program), `call program ${t}\n${dense}`);
  }
  for (let a = 1; a <= 44; a += 1) assert.ok(arities.has(a), `a call of ${a} arguments is covered`);
  assert.ok(nested > 0, 'nested calls are covered');
});

/** The dense lines of a program with, per line, the function it belongs to. */
function callSites(dense: string, names: readonly string[]) {
  const lines = dense.split('\n');
  const sites: { line: number; tok: number; fnIndex: number }[] = [];
  let cur = -1;
  lines.forEach((l, li) => {
    const toks = l.split(' ');
    if (toks[0] === 'fn') cur += 1;
    toks.forEach((tk, ti) => {
      if (names.includes(tk) && !(toks[0] === 'fn' && ti === 1))
        sites.push({ line: li, tok: ti, fnIndex: cur });
    });
  });
  return { lines, sites };
}

test('the B1 reader: mutants of call programs are rejected exactly when the reference rejects them', (t) => {
  const read = loadReader();
  const gen = generator(4242);
  let accepted = 0;
  let rejected = 0;
  for (let m = 0; m < 160; m += 1) {
    const program = parse(gen.callProgram(m));
    const names = program.functions.map((f) => f.name);
    const dense = formatDense(program);
    const { lines, sites } = callSites(dense, names);
    const site = sites[gen.rnd(sites.length)];
    if (site === undefined) continue;
    const toks = (lines[site.line] as string).split(' ');
    const set = (next: string[]): string =>
      lines.map((l, li) => (li === site.line ? next.join(' ') : l)).join('\n');
    const callee = toks[site.tok] as string;
    const kinds = [
      'drop-arg',
      'extra-arg',
      'unknown-callee',
      'later-callee',
      'call-keyword',
      'call-no-name',
      'call-last',
    ];
    const kind = kinds[m % kinds.length] as string;
    let mutant: string;
    if (kind === 'drop-arg') mutant = set(toks.filter((_, i) => i !== site.tok + 1));
    else if (kind === 'extra-arg') mutant = set([...toks, '7']);
    else if (kind === 'unknown-callee')
      mutant = set(toks.map((x, i) => (i === site.tok ? `${callee}z` : x)));
    else if (kind === 'later-callee') {
      const later = names[Math.max(site.fnIndex, names.length - 1)] as string;
      mutant = set(toks.map((x, i) => (i === site.tok ? later : x)));
    } else if (kind === 'call-keyword')
      mutant = set(toks.flatMap((x, i) => (i === site.tok ? ['call', x] : [x])));
    else if (kind === 'call-no-name')
      mutant = set(toks.map((x, i) => (i === site.tok ? 'call' : x)));
    else mutant = set([...toks, 'call']);
    if (agree(read, mutant, `mutant ${m} (${kind})`)) accepted += 1;
    else rejected += 1;
  }
  t.diagnostic(`${rejected} mutants rejected and ${accepted} accepted, each as the reference does`);
  assert.ok(rejected > 40, 'many mutants are rejected');
  assert.ok(accepted > 10, 'some mutants (the call keyword) are accepted');
});

test('the B1 reader: calls it must flag, and calls it must read', () => {
  const read = loadReader();
  const g = 'fn g add A 1\n\n';
  const cases: [string, string][] = [
    ['a later callee', 'fn f h A\n\nfn h add A 1\n'],
    ['the function itself', 'fn f f A\n'],
    ['a callee of a used file', 'use "x.a0"\nfn f g A\n'],
    ['too few operands', `${g}fn f g\n`],
    ['too many operands', `${g}fn f g A 1\n`],
    ['an operand that is no value', `${g}fn f g )\n`],
    ['call with no name', `${g}fn f call\n`],
    ['call of a value', `${g}fn f u32 -> u32\nx add A 1\ncall x\n`],
    ['a duplicate function', `${g}fn g add A 2\n`],
    ['an id that is a later function name', 'fn f x add A 1\nx\n\nfn x add A 2\n'],
    ['call keyword', `${g}fn f call g A\n`],
    ['call keyword, nested', `${g}fn f add call g A call g 2\n`],
    ['a callee named by the call keyword and used as a value', `${g}fn f call g call g call g A\n`],
    ['an id used as a call operand', `${g}fn f u32 -> u32\nx add A 1\ng x\n`],
    ['a call result named and reused', `${g}fn f u32 -> u32\nx g A\nadd x x\n`],
    ['a record argument', 'fn g (u32,u32) -> u32\nat A 0\n\nfn f u32 -> u32\ng (A 1)\n'],
    ['a zero-arity callee', 'fn z -> u32\nmov 7\n\nfn f u32 -> u32\nadd z A\n'],
    [
      'a zero-arity callee, the call keyword',
      'fn z -> u32\nmov 7\n\nfn f u32 -> u32\nadd call z A\n',
    ],
    ['an implicit arity from the return', 'fn g A\n\nfn f g 5\n'],
    ['an implicit arity from a nested operand', 'fn g add mul A 2 C\n\nfn f g 1 2 3\n'],
    ['a callee of arity 2 called with one nested call', `fn g add A B\n\nfn f g g 1 2 3\n`],
  ];
  let accepted = 0;
  for (const [label, text] of cases) if (agree(read, text, label)) accepted += 1;
  assert.ok(accepted >= 8, `the reader reads ${accepted} of the call cases`);
});

test('the B1 reader: the argument pool sets the error flag on overflow, never wrong output', () => {
  const read = loadReader();
  const wide = (calls: number): string => {
    const params = Array.from({ length: 44 }, () => 'u32').join(' ');
    const args = Array.from({ length: 44 }, () => '1').join(' ');
    const lines = Array.from({ length: calls }, (_, i) => `n${i} call big ${args}`);
    return [
      `fn big ${params} -> u32\na add p0 p43\nret a\nend`,
      `fn top -> u32\n${lines.join('\n')}\nret n${calls - 1}\nend`,
    ].join('\n\n');
  };
  // 50 calls of 44 arguments: 2200 pool entries, within the pool
  const fits = wide(50);
  const fitsDense = formatDense(parse(fits));
  assert.ok(Buffer.byteLength(fitsDense) <= PAGES * PAGE);
  const fitsGot = read(fitsDense);
  assert.equal(fitsGot.err, false);
  assert.equal(fitsGot.text, formatProgram(parse(fits)));
  // 100 calls: 4400 entries, over the pool: the error flag
  const over = wide(100);
  const overDense = formatDense(parse(over));
  assert.ok(Buffer.byteLength(overDense) <= PAGES * PAGE, 'the overflow program fits the input');
  assert.equal(read(overDense).err, true);
});

// ---------------------------------------------------------------------------
// Stage B2: fold and loop
// ---------------------------------------------------------------------------

type Reader = (text: string) => { text: string; err: boolean };

/** A deterministic generator of numbers below n. */
function rngFrom(seed0: number): (n: number) => number {
  let seed = seed0 | 0;
  return (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let z = seed;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) % n;
  };
}

const LETTERS = 'ABCDEFG';
const BIN_OPS = ['add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr', 'div', 'rem'];
const CMP_OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];
const BODY_NAMES = ['x', 'y', 'q', 'rr', 'k1'];

/** What the generated programs use, to show that the generator covers the forms. */
interface FoldUse {
  inline: number;
  named: number;
  loops: number;
  boolState: number;
  nested: number;
  extras: number;
}

/**
 * Generated dense programs of fold and loop: helper functions (a body and a predicate, implicit
 * headers), then functions that fold and loop with inline bodies `{a; b}` (named statements, up to
 * parameter G), with the helpers, with extra operands, with a bool state, nested in an operand, and
 * as the result of a function whose header has no result type. `canonicalProgram` makes canonical
 * programs whose lifted helpers are named CALLER_N, so that formatDense writes them inline.
 */
function foldGenerator(seed0: number) {
  const rnd = rngFrom(seed0);
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  const use: FoldUse = { inline: 0, named: 0, loops: 0, boolState: 0, nested: 0, extras: 0 };
  /** A u32 expression over parameters 0..np-1 and the names in scope. */
  const u32e = (np: number, names: readonly string[], depth: number): string => {
    const r = rnd(10);
    if (depth <= 0 || r < 3) {
      const c = rnd(3);
      if (c === 0 && np > 0) return LETTERS[rnd(np)] as string;
      if (c === 1 && names.length > 0) return pick(names);
      return String(rnd(30));
    }
    if (r < 8)
      return `${pick(BIN_OPS)} ${u32e(np, names, depth - 1)} ${u32e(np, names, depth - 1)}`;
    if (r < 9)
      return `select ${bole(np, names, depth - 1)} ${u32e(np, names, depth - 1)} ${u32e(np, names, depth - 1)}`;
    return `mov ${u32e(np, names, depth - 1)}`;
  };
  const bole = (np: number, names: readonly string[], depth: number): string => {
    const r = rnd(6);
    if (r < 4 || depth <= 0)
      return `${pick(CMP_OPS)} ${u32e(np, names, depth - 1)} ${u32e(np, names, depth - 1)}`;
    if (r < 5) return pick(['true', 'false']);
    return `${pick(['and', 'or', 'xor'])} ${bole(np, names, depth - 1)} ${bole(np, names, depth - 1)}`;
  };
  /** Statements over np parameters; the last uses the highest parameter, so the arity is np. */
  const statements = (np: number, kind: 'u32' | 'bool' | 'boolstate'): string[] => {
    const n = 1 + rnd(3);
    const names: string[] = [];
    const out: string[] = [];
    const named = (e: string): string =>
      /^[a-z]+ /.test(e) && !/^(x|y|q|rr|k1) /.test(e) ? e : `mov ${e}`;
    for (let i = 0; i < n; i += 1) {
      if (i < n - 1) {
        const nm = pick(BODY_NAMES);
        if (names.includes(nm)) continue;
        out.push(`${nm} ${named(u32e(np, names, 2))}`);
        names.push(nm);
        continue;
      }
      const hp = LETTERS[np - 1] as string;
      if (kind === 'boolstate') {
        // the state (A) is a bool, the other parameters are u32
        out.push(`${pick(['and', 'or', 'xor'])} A ${np > 1 ? `lt ${hp} ${rnd(9)}` : 'true'}`);
      } else if (kind === 'bool') out.push(`and ${bole(np, names, 2)} lt ${hp} 3`);
      else out.push(`add ${u32e(np, names, 2)} ${hp}`);
    }
    return out;
  };
  interface Helper {
    name: string;
    arity: number;
  }
  interface Helpers {
    body: Helper[];
    pred: Helper[];
  }
  /** A helper function (implicit header): its text and arity. */
  const helper = (name: string, isPred: boolean): { text: string; arity: number } => {
    const arity = 2 + rnd(3);
    const st = statements(arity, isPred ? 'bool' : 'u32');
    const text = st.length === 1 ? `fn ${name} ${st[0]}` : `fn ${name}\n${st.join('\n')}`;
    return { text, arity };
  };
  /** A fold or loop expression and its type. */
  const foldExpr = (
    np: number,
    depth: number,
    helpers: Helpers,
  ): { text: string; type: string } => {
    const isLoop = rnd(3) === 0;
    const boolState = rnd(7) === 0;
    if (isLoop) use.loops += 1;
    if (boolState) use.boolState += 1;
    const kind = boolState ? 'boolstate' : 'u32';
    const namedBody = !boolState && helpers.body.length > 0 && rnd(3) === 0;
    const namedPred = !boolState && helpers.pred.length > 0 && rnd(3) === 0;
    // The operand count n is the arity of a named body, else of a named predicate, else the larger
    // of the inline bodies' arities; an inline body takes at most n parameters.
    const inlinePred = (pa: number): string => {
      const stmts = boolState ? [`and A lt ${LETTERS[pa - 1]} 9`] : statements(pa, 'bool');
      use.inline += 1;
      return `{${stmts.join('; ')}}`;
    };
    const inlineBody = (ba: number): string => {
      use.inline += 1;
      return `{${statements(ba, kind).join('; ')}}`;
    };
    let n: number;
    let bodySpec: string;
    let predSpec = '';
    if (!isLoop) {
      if (namedBody) {
        const h = pick(helpers.body);
        bodySpec = h.name;
        n = h.arity;
        use.named += 1;
      } else {
        n = 2 + rnd(3);
        bodySpec = inlineBody(n);
      }
    } else if (namedBody) {
      const h = pick(helpers.body);
      bodySpec = h.name;
      n = h.arity;
      use.named += 1;
      if (namedPred) {
        predSpec = (pick(helpers.pred) as Helper).name;
        use.named += 1;
      } else predSpec = inlinePred(2 + rnd(n - 1));
    } else if (namedPred) {
      predSpec = (pick(helpers.pred) as Helper).name;
      use.named += 1;
      n = (helpers.pred.find((h) => h.name === predSpec) as Helper).arity;
      bodySpec = inlineBody(2 + rnd(n - 1));
    } else {
      const ba = 2 + rnd(3);
      const pa = 2 + rnd(3);
      bodySpec = inlineBody(ba);
      predSpec = inlinePred(pa);
      n = Math.max(ba, pa);
    }
    const count = rnd(4) === 0 && np > 0 ? 'A' : String(1 + rnd(9));
    let init = boolState ? pick(['true', 'false']) : u32e(np, [], depth - 1);
    if (!boolState && depth > 0 && rnd(5) === 0) {
      init = foldExpr(np, depth - 1, helpers).text;
      use.nested += 1;
    }
    const ops = [count, init];
    for (let i = 2; i < n; i += 1) ops.push(u32e(np, [], depth - 1));
    if (n > 2) use.extras += 1;
    const text = isLoop
      ? `loop ${predSpec} ${bodySpec} ${ops.join(' ')}`
      : `fold ${bodySpec} ${ops.join(' ')}`;
    return { text, type: boolState ? 'bool' : 'u32' };
  };
  const program = (): string => {
    const helpers: Helpers = { body: [], pred: [] };
    const parts: string[] = [];
    const nh = rnd(3);
    for (let h = 0; h < nh; h += 1) {
      const isPred = rnd(3) === 0;
      const name = `${isPred ? 'p' : 'h'}${h}x${rnd(9)}`;
      const made = helper(name, isPred);
      parts.push(made.text);
      (isPred ? helpers.pred : helpers.body).push({ name, arity: made.arity });
    }
    const nf = 1 + rnd(3);
    for (let f = 0; f < nf; f += 1) {
      const np = rnd(3);
      const lines: string[] = [];
      const ns = 1 + rnd(3);
      let lastType = 'u32';
      for (let i = 0; i < ns; i += 1) {
        const fe = foldExpr(np, 2, helpers);
        const wrap = rnd(3) === 0 && fe.type === 'u32';
        const e = wrap ? `add ${fe.text} ${u32e(np, [], 1)}` : fe.text;
        if (i === ns - 1) lastType = fe.type;
        lines.push(i < ns - 1 ? `v${i} ${e}` : e);
      }
      const last = lines[lines.length - 1] as string;
      // a header with types ends with its result type; one without types lets the reader infer it
      const typed = np > 0 && rnd(2) === 0;
      const header = typed
        ? `fn f${f}${' u32'.repeat(np)} -> ${last.startsWith('add ') ? 'u32' : lastType}`
        : `fn f${f}${np === 0 && lastType === 'bool' && rnd(2) === 0 ? ' -> bool' : ''}`;
      parts.push(lines.length === 1 ? `${header} ${last}` : [header, ...lines].join('\n'));
    }
    return `${parts.join('\n\n')}\n`;
  };
  /** A helper in canonical form: np u32 parameters, ending in an operation on the highest. */
  const canonicalHelper = (name: string, np: number, result: 'u32' | 'bool'): string => {
    const ids: string[] = [];
    const lines: string[] = [];
    const count = 1 + rnd(3);
    const operand = (): string => {
      const r = rnd(10);
      if (r < 4) return `p${rnd(np)}`;
      if (r < 7 && ids.length > 0) return pick(ids);
      return String(rnd(40));
    };
    for (let k = 0; k < count; k += 1) {
      const id = String.fromCharCode(97 + k);
      const last = k === count - 1;
      if (!last) lines.push(`${id} ${pick(BIN_OPS)} ${operand()} ${operand()}`);
      else if (result === 'bool') lines.push(`${id} ${pick(CMP_OPS)} p${np - 1} ${operand()}`);
      else lines.push(`${id} ${pick(BIN_OPS)} ${operand()} p${np - 1}`);
      ids.push(id);
    }
    const params = Array.from({ length: np }, () => 'u32').join(' ');
    return `fn ${name} ${params} -> ${result}\n${lines.join('\n')}\nret ${ids[ids.length - 1]}\nend`;
  };
  const canonicalProgram = (): string => {
    const parts: string[] = [];
    // a shared helper of two parameters, used by folds of two operands (never inlined)
    const sharedName = `sh${rnd(9)}`;
    parts.push(canonicalHelper(sharedName, 2, 'u32'));
    const ncallers = 1 + rnd(2);
    for (let c = 0; c < ncallers; c += 1) {
      const cname = `c${c}x${rnd(9)}`;
      const lifted: string[] = [];
      const nodes: string[] = [];
      const cnp = 1 + rnd(2);
      let seq = 0;
      const nfold = 1 + rnd(3);
      const ids: string[] = [];
      for (let k = 0; k < nfold; k += 1) {
        const isLoop = rnd(3) === 0;
        const arity = 2 + rnd(3);
        const spec = (result: 'u32' | 'bool'): string => {
          if (result === 'u32' && arity === 2 && rnd(3) === 0) {
            use.named += 1;
            return sharedName;
          }
          seq += 1;
          const name = `${cname}_${seq}`;
          lifted.push(canonicalHelper(name, arity, result));
          use.inline += 1;
          return name;
        };
        const ops = [String(1 + rnd(9)), rnd(2) === 0 ? 'p0' : String(rnd(30))];
        for (let i = 2; i < arity; i += 1)
          ops.push(rnd(2) === 0 ? `p${rnd(cnp)}` : String(rnd(30)));
        const pred = isLoop ? spec('bool') : '';
        const body = spec('u32');
        if (isLoop) use.loops += 1;
        const id = String.fromCharCode(97 + k);
        ids.push(id);
        nodes.push(
          isLoop
            ? `${id} loop ${pred} ${body} ${ops.join(' ')}`
            : `${id} fold ${body} ${ops.join(' ')}`,
        );
      }
      parts.push(...lifted);
      const params = Array.from({ length: cnp }, () => 'u32').join(' ');
      parts.push(
        `fn ${cname} ${params} -> u32\n${nodes.join('\n')}\nret ${ids[ids.length - 1]}\nend`,
      );
    }
    return parts.join('\n\n');
  };
  return { program, canonicalProgram, rnd, pick, use };
}

/** Whether a generated program reads as the reference reads it, and how. */
function foldCheck(read: Reader, text: string, label: string): 'equal' | 'rejected' {
  const want = reference(text);
  const got = read(text);
  if (want === null) {
    assert.equal(got.err, true, `${label}: the reader flags what the reference rejects\n${text}`);
    return 'rejected';
  }
  assert.equal(got.err, false, `${label}: the error flag is clear\n${text}`);
  assert.equal(got.text, want, `${label}: canonical text\n${text}`);
  return 'equal';
}

test('the B2 reader: 300 generated programs of fold and loop read to the reference text', (t) => {
  const read = loadReader();
  const gen = foldGenerator(2024);
  let inlineBodies = 0;
  for (let k = 0; k < 300; k += 1) {
    const text = gen.program();
    assert.ok(Buffer.byteLength(text) <= PAGES * PAGE, `program ${k} fits the input`);
    assert.notEqual(
      reference(text),
      null,
      `program ${k}: the generator writes what the reference reads\n${text}`,
    );
    foldCheck(read, text, `program ${k}`);
    if (text.includes('{')) inlineBodies += 1;
  }
  const u = gen.use;
  t.diagnostic(
    `inline ${u.inline}, named ${u.named}, loops ${u.loops}, bool state ${u.boolState}, nested ${u.nested}, extra operands ${u.extras}; ${inlineBodies} programs with an inline body`,
  );
  assert.ok(
    u.inline > 200 && u.named > 20 && u.loops > 60,
    'inline, named and loop forms are covered',
  );
  assert.ok(
    u.boolState > 10 && u.nested > 10 && u.extras > 60,
    'bool states, nesting and extra operands are covered',
  );
});

test('the B2 reader: canonical programs with lifted helpers read back from the formatter', (t) => {
  const read = loadReader();
  const gen = foldGenerator(31337);
  let inlined = 0;
  let programs = 0;
  for (let k = 0; k < 120; k += 1) {
    const canonical = gen.canonicalProgram();
    const program = parse(canonical);
    const dense = formatDense(program);
    if (dense.includes('{')) inlined += 1;
    const got = read(dense);
    assert.equal(got.err, false, `program ${k}: the error flag is clear\n${dense}`);
    assert.equal(got.text, formatProgram(program), `program ${k}\n${dense}`);
    programs += 1;
  }
  t.diagnostic(`${programs} canonical programs, ${inlined} written with inline bodies`);
  assert.ok(inlined > 60, 'most programs are written with inline bodies');
});

/** The dense words and punctuation a mutant is made of. */
const MUTANT_TOKENS = [
  '{',
  '}',
  ';',
  'fold',
  'loop',
  'A',
  'B',
  'C',
  '5',
  '0',
  'true',
  'false',
  '(',
  ')',
  'x',
  'add',
  'select',
  'call',
  'ret',
  'f',
  'lt',
  'mov',
  ',',
  '$x',
  'fn',
  'u32',
  '->',
  'end',
];

/** The pieces of a dense text: words, punctuation, spaces and newlines, which join back to the text. */
function pieces(text: string): string[] {
  return text.match(/\n|[{};(),]|[^\s{};(),]+| +/g) ?? [];
}

/** One mutation of a dense text, chosen by `rnd` and `pick`. */
function mutate(
  text: string,
  rnd: (n: number) => number,
  pick: <T>(xs: readonly T[]) => T,
): string {
  const ps = pieces(text);
  const words = ps.flatMap((p, i) => (/^\s*$/.test(p) ? [] : [i]));
  const k = words[rnd(words.length)] as number;
  const out = ps.slice();
  const op = rnd(6);
  if (op === 0) out.splice(k, 1);
  else if (op === 1) out.splice(k, 0, pick(MUTANT_TOKENS), ' ');
  else if (op === 2) out[k] = pick(MUTANT_TOKENS);
  else if (op === 3) {
    const next = words[Math.min(words.length - 1, words.indexOf(k) + 1)] as number;
    [out[k], out[next]] = [out[next] as string, out[k] as string];
  } else if (op === 4) out.splice(k, 0, pick(MUTANT_TOKENS));
  else {
    out[k] = pick(MUTANT_TOKENS);
    out.splice(words[rnd(words.length)] as number, 0, pick(MUTANT_TOKENS), ' ');
  }
  return out.join('');
}

/**
 * A text the reference reads but the reader leaves to the error flag uses a form outside the reader:
 * a comma used as a blank, a `$` escape, the `rec` word, or a record type in a signature.
 */
function outsideTheReader(text: string, canonical: string): boolean {
  return /[,$]|\brec\b/.test(text) || /\((u32|bool)/.test(canonical);
}

test('the B2 reader: mutants of fold and loop programs are rejected exactly when the reference rejects them', (t) => {
  const read = loadReader();
  const gen = foldGenerator(555);
  const bases = Array.from({ length: 60 }, () => gen.program());
  const rnd = rngFrom(99);
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (let m = 0; m < 300; m += 1) {
    const text = mutate(pick(bases), rnd, pick);
    if (Buffer.byteLength(text) > PAGES * PAGE) continue;
    const want = reference(text);
    const got = read(text);
    if (want === null) {
      assert.equal(
        got.err,
        true,
        `mutant ${m}: the reader flags what the reference rejects\n${text}`,
      );
      rejected += 1;
    } else if (got.err) {
      assert.ok(
        outsideTheReader(text, want),
        `mutant ${m}: the reader refuses a text of the forms it reads\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.text, want, `mutant ${m}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(
    `${rejected} mutants rejected, ${equal} read to the reference text, ${refused} refused`,
  );
  assert.ok(rejected > 150, 'most mutants are rejected');
  assert.ok(equal > 10, 'some mutants are accepted');
});

/** A curated text: the label, the text, and whether the reader leaves it to the error flag. */
type Curated = [string, string, boolean?];

const STEP = 'fn step u32 u32 -> u32\nadd A 1\n\n';
const BELOW = 'fn below u32 u32 -> bool\nlt A 5\n\n';
const CURATED: Curated[] = [
  ['a fold of a named body', `${STEP}fn f fold step 4 0\n`],
  ['a fold, its result nested', `${STEP}fn f add fold step 4 0 1\n`],
  ['a fold in the operand of a fold', `${STEP}fn f fold step fold step 3 0 1\n`],
  ['a fold with extra operands', 'fn s3 u32 u32 u32 -> u32\nadd A C\n\nfn f fold s3 4 0 7\n'],
  ['a fold with too few operands', 'fn s3 u32 u32 u32 -> u32\nadd A C\n\nfn f fold s3 4 0\n'],
  ['a fold with too many operands', 'fn s3 u32 u32 u32 -> u32\nadd A C\n\nfn f fold s3 4 0 7 9\n'],
  ['a body defined below', `fn f fold step 4 0\n\n${STEP}`],
  ['an unknown body', `${STEP}fn f fold stepz 4 0\n`],
  ['no body', `${STEP}fn f fold 4 0\n`],
  ['a fold with nothing after it', `${STEP}fn f fold\n`],
  ['the call keyword before a fold', `${STEP}fn f call fold step 4 0\n`],
  ['a fold named and reused', `${STEP}fn f x fold step 4 0\nmul x x\n`],
  ['a fold as a result', `${STEP}fn f u32 -> u32\nret fold step 4 A\nend\n`],
  ['a zero-arity body', 'fn z -> u32\nmov 7\n\nfn f fold z\n'],
  [
    'a loop of named functions',
    `${STEP}${BELOW.replace('fn below', 'fn below')}fn f loop below step 10 0\n`,
  ],
  ['a loop with the body first', `${STEP}${BELOW}fn f loop step below 10 0\n`],
  ['a loop with one function', `${STEP}${BELOW}fn f loop below 10 0\n`],
  ['a loop with no operands', `${STEP}${BELOW}fn f loop below step\n`],
  [
    'a loop in the operand of a loop',
    `${STEP}${BELOW}fn f add loop below step 10 0 loop below step 3 1\n`,
  ],
  ['an inline fold body', 'fn f fold {add A B} 4 0\n'],
  ['an inline body with an extra operand', 'fn f fold {add A C} 4 0 7\n'],
  ['inline statements', 'fn f fold {add A B; mul A 2} 4 0\n'],
  ['inline statements with names', 'fn f fold {x add A B; y mul x 2; sub y 1} 4 0\n'],
  ['an inline loop', 'fn f loop {lt A 5} {add A 1} 10 0\n'],
  ['an inline predicate and a named body', `${STEP}fn f loop {lt A 5} step 10 0\n`],
  ['a named predicate and an inline body', 'fn below lt A 5\n\nfn f loop below {add A 1} 10 0\n'],
  ['two inline folds', 'fn f add fold {add A B} 4 0 fold {mul A 2} 3 1\n'],
  ['an inline fold nested in the initial value', 'fn f fold {add A B} 4 fold {mul A B} 3 1\n'],
  ['a body that is a parameter', 'fn f fold {A} 4 0\n'],
  ['a body that is a number', 'fn f fold {2} 4 0\n'],
  ['an empty body', 'fn f fold {} 4 0\n'],
  ['a body of separators', 'fn f fold {;} 4 0\n'],
  ['a body with no closing brace', 'fn f fold {add A B 4 0\n'],
  ['a body with a closing brace too many', 'fn f fold {add A B}} 4 0\n'],
  ['a body in a body', 'fn f fold {add {A} B} 4 0\n'],
  ['a fold in a body', 'fn f fold {fold {A} 3 0} 4 0\n'],
  ['a named fold in a body', `${STEP}fn f fold {fold step 3 A} 4 0\n`],
  ['an inline fold with one operand', 'fn f fold {add A B} 4\n'],
  ['an inline fold with an operand too many', 'fn f fold {add A B} 4 0 1\n'],
  ['inline bodies in two statements', 'fn f fold {add A B} 4 0\nx fold {mul A B} 3 1\nadd x 1\n'],
  ['a bool state', 'fn f u32 -> bool fold {lt A 3} 4 true\n'],
  ['a bool state written by its type', 'fn f -> bool fold {and A true} 4 true\n'],
  ['a bool state with a select body', 'fn f fold {select A 1 2} 4 true\n'],
  ['a state that is a record', 'fn f fold {add A B} 4 (1 2)\n', true],
  ['parameters of the caller as operands', 'fn f u32 u32 -> u32 fold {add A C} A B B\n'],
  ['a bool parameter as an extra operand', 'fn f u32 bool -> u32 fold {select C A B} 4 A C\n'],
  ['a call in a body', 'fn g add A 1\n\nfn f fold {g A} 4 0\n'],
  ['a call with an operand too many in a body', 'fn g add A 1\n\nfn f fold {g g A} 4 0\n'],
  ['ret in a body', 'fn f fold {ret add A B} 4 0\n'],
  ['ret after a name in a body', 'fn f fold {a add A B; ret mul a 2} 4 0\n'],
  ['two ret in a body', 'fn f fold {ret add A B; ret mul A 2} 4 0\n'],
  ['a bare value before the last statement', 'fn f fold {a add A B; A; add A B} 4 0\n'],
  ['a name written twice in a body', 'fn f fold {x add A B; x add A 1; x} 4 0\n'],
  [
    'the same name in two bodies',
    'fn f add fold {x add A B; mul x 2} 4 0 fold {x add A 1; mul x 3} 2 3\n',
  ],
  [
    'a body that names a value of the caller',
    'fn f x add 1 2\nadd fold {y add A B; mul y x} 4 0 1\n',
  ],
  ['a body using a parameter beyond the operands', 'fn f fold {add A D} 4 0 1 2\n'],
  [
    'three inline folds in a function',
    'fn f x fold {add A B} 4 0\ny fold {mul A 3} 2 x\nz fold {sub A B} 3 y\nadd z y\n',
  ],
  ['a function named like an inline body', 'fn f_1 add A B\n\nfn f fold {mul A 2} 3 1\n'],
  ['a later function named like an inline body', 'fn f fold {mul A 2} 3 1\n\nfn f_1 add A B\n'],
  [
    'a name that ends with digits, beside an inline body',
    'fn f_2 add A B\n\nfn f fold {mul A 2} 3 1\n',
    true,
  ],
  ['a name that ends with digits, with no inline body', 'fn f_2 add A B\n\nfn f add 1 2\n'],
  ['spaces inside braces', 'fn f fold { add A B } 4 0\n'],
  ['no space after a brace', 'fn f fold {add A B}4 0\n'],
  ['a separator after the closing brace', 'fn f fold {add A B}; 4 0\n'],
  ['an unwritten result that is a bool', 'fn f eq A 1\n'],
  ['an unwritten result that is a bool, called', 'fn g lt A 2\n\nfn f select g A 1 2\n'],
  ['an unwritten result that is a fold of bool state', `${STEP}fn f fold step 4 true\n`],
  ['an unwritten result that is ill-typed', 'fn f add true 1\n'],
  ['an unwritten result that is a record', 'fn f (1 2)\n', true],
  ['at and put are undefined for the reference', 'fn f at (1 true) 1\n'],
  ['a keyword as a function name', 'fn add A\n'],
  ['rec as a function name', 'fn rec A\n'],
  ['a parameter letter as a function name', 'fn A A\n'],
  ['a number as a function name', 'fn 5 A\n'],
  ['u32 as a function name', 'fn u32 A\n'],
  ['a type that is no type', 'fn f u33 -> u32 A\n'],
  ['a result type that is no type', 'fn f u32 -> loopbool A\n'],
  ['an empty record type', 'fn f () -> u32 A\n'],
  ['a record type with a trailing comma', 'fn f (u32,) -> u32 A\n'],
  ['a record type', 'fn f (u32,bool) bool -> (bool,u32) A\n'],
  ['an array type', 'fn f u32x4 -> u32 A\n'],
  ['a name written twice', 'fn f u32 -> u32\na add A 1\na add A 2\na\n'],
  ['a statement after ret', 'fn f u32 -> u32\nret add A 1\nadd A 2\n'],
  ['two ret statements', 'fn f u32 -> u32\nret add A 1\nret add A 2\n'],
  ['a function with no statement', 'fn f\n'],
  ['a function with a type list and no statement', 'fn f u32 -> u32\n'],
  ['rec as an id', 'fn f rec add 1 true\n', true],
];

test('the B2 reader: fold, loop, inline bodies, result types and header checks read as the reference reads them', (t) => {
  const read = loadReader();
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (const [label, text, refuse] of CURATED) {
    const want = reference(text);
    const got = read(text);
    if (want === null) {
      assert.equal(got.err, true, `${label}: the reader flags what the reference rejects\n${text}`);
      rejected += 1;
    } else if (refuse === true) {
      assert.equal(
        got.err,
        true,
        `${label}: a form outside the reader sets the error flag\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.err, false, `${label}: the error flag is clear\n${text}`);
      assert.equal(got.text, want, `${label}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(`${equal} read to the reference text, ${rejected} rejected, ${refused} refused`);
  assert.ok(equal > 30 && rejected > 20, 'both kinds are covered');
});

test('the B2 reader: capacities set the error flag, never wrong output', () => {
  const read = loadReader();
  // 100 functions, each with an inline body, fit
  const fns = (n: number, body: string): string =>
    `${Array.from({ length: n }, (_, i) => `fn f${i} fold {${body}} 4 0`).join('\n\n')}\n`;
  const fits = fns(100, 'add A B');
  const got = read(fits);
  assert.equal(got.err, false);
  assert.equal(got.text, reference(fits));
  // a body of 700 nodes fits the body nodes; two bodies of 520 do not
  const bodyOf = (n: number): string =>
    `${Array.from({ length: n }, (_, i) => `x${i} add A ${i % 9}`).join('; ')}; add x0 B`;
  const one = `fn f fold {${bodyOf(700)}} 4 0\n`;
  assert.ok(Buffer.byteLength(one) <= PAGES * PAGE);
  const oneGot = read(one);
  assert.equal(oneGot.err, false);
  assert.equal(oneGot.text, reference(one));
  const two = `fn f fold {${bodyOf(520)}} 4 0\n\nfn g fold {${bodyOf(520)}} 4 0\n`;
  assert.ok(Buffer.byteLength(two) <= PAGES * PAGE);
  assert.equal(read(two).err, true, 'more body nodes than the body region holds');
  // the output over its capacity: 300 functions with a body write more than 16384 bytes
  const wide = fns(300, 'add A B');
  assert.ok(Buffer.byteLength(wide) <= PAGES * PAGE);
  assert.equal(read(wide).err, true, 'an output over its capacity');
  // frames: nesting of folds takes two frames a level (the fold and the operation around it)
  const nest = (d: number): string => `fn f ${'add 1 fold {A} 3 '.repeat(d)}0\n`;
  assert.equal(read(nest(3)).err, false);
  assert.equal(read(nest(3)).text, reference(nest(3)));
  assert.equal(read(nest(9)).err, true, 'more nested frames than the stack holds');
});

// ---------------------------------------------------------------------------
// Stage B3.1: array types and the operations arr (`[a b c]`), get and set
// ---------------------------------------------------------------------------

/** The element type and length of an array type text (`u32x2x3` is three of `u32x2`), or undefined. */
function arrayParts(t: string): { elem: string; n: number } | undefined {
  const m = /^(.*)x([1-9][0-9]*)$/.exec(t);
  return m === null ? undefined : { elem: m[1] as string, n: Number(m[2]) };
}

/** Ids of nodes that the dense text writes with the `$` escape: keywords and type-like words. */
const ESCAPED_IDS = [
  'add',
  'sub',
  'mul',
  'rem',
  'get',
  'set',
  'mov',
  'select',
  'at',
  'put',
  'call',
  'fold',
  'loop',
  'arr',
  'rec',
  'text',
  'u32',
  'bool',
  'io',
  'u32x2',
  'boolx3',
  'u32x2x3',
];

/**
 * Generated canonical programs with arrays: typed headers (arrays of u32, bool and records, up to
 * two dimensions deep and more), array literals of values in scope, get and set, select and mov of
 * arrays, calls of earlier functions with array parameters and results, records and `at`. The
 * programs are well typed (parse checks them); formatDense writes them in dense form, nesting
 * included, which the reader reads back.
 */
function arrayGenerator(seed0: number, opts: { repeat?: boolean; escapes?: boolean } = {}) {
  const rnd = rngFrom(seed0);
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  interface Val {
    ref: string;
    ty: string;
  }
  interface Sig {
    name: string;
    params: string[];
    result: string;
  }
  const randType = (): string => {
    const r = rnd(16);
    if (r < 3) return 'u32';
    if (r < 4) return 'bool';
    if (r < 7) return `u32x${1 + rnd(5)}`;
    if (r < 8) return `boolx${1 + rnd(4)}`;
    if (r < 10) return `u32x${1 + rnd(3)}x${1 + rnd(3)}`;
    if (r < 11) return `boolx${1 + rnd(3)}x${1 + rnd(2)}`;
    if (r < 12) return '(u32,bool)';
    if (r < 13) return `(u32,bool)x${1 + rnd(3)}`;
    if (r < 14) return `(u32,u32)x${1 + rnd(3)}x${1 + rnd(2)}`;
    if (r < 15) return `u32x${1 + rnd(40)}`;
    return `u32x${1 + rnd(9)}x${1 + rnd(9)}`;
  };
  const fn = (name: string, sigs: readonly Sig[]): { text: string; sig: Sig } => {
    const params = Array.from({ length: rnd(4) }, randType);
    const vals: Val[] = params.map((ty, i) => ({ ref: `p${i}`, ty }));
    const lines: string[] = [];
    const dn = defaultNames(new Set<string>([name, ...ESCAPED_IDS, ...sigs.map((s) => s.name)]));
    let explicit = 0;
    const usedEscapes = new Set<string>();
    const emit = (op: string, args: string[], ty: string): Val => {
      let id: string;
      if (opts.escapes === true && rnd(6) === 0) {
        // an id that needs the `$` escape: a keyword, a type-like word, a function name
        const free = [...ESCAPED_IDS, ...sigs.map((s) => s.name)].filter(
          (e) => !usedEscapes.has(e),
        );
        id = pick(free);
        usedEscapes.add(id);
      } else if (rnd(7) === 0) {
        explicit += 1;
        id = `w${explicit}x`;
      } else id = dn.next().value as string;
      lines.push(`${id} ${op} ${args.join(' ')}`);
      const v = { ref: id, ty };
      vals.push(v);
      return v;
    };
    const mk = (ty: string, depth: number): string => {
      const cands = vals.filter((v) => v.ty === ty);
      if (cands.length > 0 && (depth <= 0 || rnd(3) > 0)) return (pick(cands) as Val).ref;
      if (ty === 'u32') return String(rnd(50));
      if (ty === 'bool') return pick(['true', 'false']);
      const ap = arrayParts(ty);
      if (ap !== undefined) {
        if (opts.repeat === true && ap.n >= 3 && (ap.elem === 'u32' || ap.elem === 'bool')) {
          if (rnd(2) === 0) {
            // n equal elements: a literal or a parameter, which the printer writes as [x;n]
            const one = mk(ap.elem, 0);
            return emit(
              'arr',
              Array.from({ length: ap.n }, () => one),
              ty,
            ).ref;
          }
        }
        const elems = Array.from({ length: ap.n }, () => mk(ap.elem, depth - 1));
        return emit('arr', elems, ty).ref;
      }
      // a record type (a,b)
      const fields = ty.slice(1, -1).split(',');
      return emit(
        'rec',
        fields.map((f) => mk(f, depth - 1)),
        ty,
      ).ref;
    };
    const steps = 1 + rnd(7);
    for (let s = 0; s < steps; s += 1) {
      const k = rnd(12);
      const arrays = vals.filter((v) => arrayParts(v.ty) !== undefined);
      if (k < 2)
        emit(pick(['add', 'sub', 'mul', 'and', 'or', 'xor']), [mk('u32', 1), mk('u32', 1)], 'u32');
      else if (k < 3) emit(pick(['lt', 'eq', 'ne', 'ge']), [mk('u32', 1), mk('u32', 1)], 'bool');
      else if (k < 6 && arrays.length > 0) {
        const a = pick(arrays) as Val;
        emit('get', [a.ref, mk('u32', 1)], (arrayParts(a.ty) as { elem: string }).elem);
      } else if (k < 8 && arrays.length > 0) {
        const a = pick(arrays) as Val;
        const e = (arrayParts(a.ty) as { elem: string }).elem;
        emit('set', [a.ref, mk('u32', 1), mk(e, 2)], a.ty);
      } else if (k < 9) {
        const ty = randType();
        emit('select', [mk('bool', 1), mk(ty, 2), mk(ty, 2)], ty);
      } else if (k < 10) {
        const ty = randType();
        emit('mov', [mk(ty, 2)], ty);
      } else if (k < 11 && sigs.length > 0) {
        const sg = pick(sigs) as Sig;
        emit('call', [sg.name, ...sg.params.map((p) => mk(p, 2))], sg.result);
      } else {
        mk(randType(), 3);
      }
    }
    // the result: the last node, or a parameter
    if (lines.length === 0) emit('mov', ['7'], 'u32');
    const last = vals[vals.length - 1] as Val;
    const header = `fn ${name}${params.length > 0 ? ` ${params.join(' ')}` : ''} -> ${last.ty}`;
    const text = `${header}\n${lines.join('\n')}\nret ${last.ref}\nend`;
    return { text, sig: { name, params, result: last.ty } };
  };
  const program = (): string => {
    const sigs: Sig[] = [];
    const parts: string[] = [];
    const nf = 1 + rnd(3);
    for (let f = 0; f < nf; f += 1) {
      const made = fn(`g${f}x${rnd(9)}`, sigs);
      parts.push(made.text);
      sigs.push(made.sig);
    }
    return parts.join('\n\n');
  };
  return { program, rnd, pick };
}

test('the B3.1 reader: generated programs with arrays read to their canonical text', (t) => {
  const read = loadReader();
  const gen = arrayGenerator(8080);
  let withGet = 0;
  let withSet = 0;
  let withArr = 0;
  let nested = 0;
  let checked = 0;
  for (let k = 0; k < 250; k += 1) {
    const canonical = gen.program();
    const program = parse(canonical);
    // every element written (the repeat form `[x;n]` is read from Stage B3.2 on)
    const dense = formatDense(program, { style: { repeat: false } });
    if (Buffer.byteLength(dense) > PAGES * PAGE) continue;
    const got = read(dense);
    assert.equal(got.err, false, `program ${k}: the error flag is clear\n${dense}`);
    assert.equal(got.text, formatProgram(program), `program ${k}\n${dense}`);
    checked += 1;
    if (/\bget\b/.test(dense)) withGet += 1;
    if (/\bset\b/.test(dense)) withSet += 1;
    if (dense.includes('[')) withArr += 1;
    if (/\[[^\]]*\[/.test(dense)) nested += 1;
  }
  t.diagnostic(
    `${checked} programs, ${withArr} with a literal, ${withGet} with get, ${withSet} with set, ${nested} with nested literals`,
  );
  assert.ok(checked > 200, 'most programs fit the input');
  assert.ok(withArr > 100 && withGet > 60 && withSet > 30 && nested > 10, 'the forms are covered');
});

/** The dense words and punctuation an array mutant is made of. */
const ARRAY_MUTANT_TOKENS = [
  '[',
  ']',
  '(',
  ')',
  'get',
  'set',
  'A',
  'B',
  '0',
  '3',
  'true',
  'false',
  'u32',
  'bool',
  'u32x2',
  'boolx3',
  'u32x2x3',
  'u32x0',
  'x2',
  'x',
  '->',
  'add',
  'select',
  'mov',
  'call',
  'ret',
  'at',
  'put',
  'fold',
  'rec',
  'arr',
  ',',
  ';',
  '$x',
  'fn',
  'a',
  'b',
  'c',
];

/** The pieces of a dense text with arrays: words, punctuation, spaces and newlines. */
function arrayPieces(text: string): string[] {
  return text.match(/\n|[{};()[\],]|[^\s{};()[\],]+| +/g) ?? [];
}

/** One mutation of a dense text with arrays. */
function mutateArrays(
  text: string,
  rnd: (n: number) => number,
  pick: <T>(xs: readonly T[]) => T,
  tokens: readonly string[] = ARRAY_MUTANT_TOKENS,
): string {
  const ps = arrayPieces(text);
  const words = ps.flatMap((p, i) => (/^\s*$/.test(p) ? [] : [i]));
  const k = words[rnd(words.length)] as number;
  const out = ps.slice();
  const op = rnd(6);
  if (op === 0) out.splice(k, 1);
  else if (op === 1) out.splice(k, 0, pick(tokens), ' ');
  else if (op === 2) out[k] = pick(tokens);
  else if (op === 3) {
    const next = words[Math.min(words.length - 1, words.indexOf(k) + 1)] as number;
    [out[k], out[next]] = [out[next] as string, out[k] as string];
  } else if (op === 4) out.splice(k, 0, pick(tokens));
  else {
    out[k] = pick(tokens);
    out.splice(words[rnd(words.length)] as number, 0, pick(tokens), ' ');
  }
  return out.join('');
}

/**
 * A text the reference reads but the reader leaves to the error flag uses a form outside the reader:
 * a comma used as a blank, a `$` escape, `=`, the repeat form, a text literal, the `rec` or `arr`
 * word, an inline body, a type written with spaces, or an unwritten result that is not u32 or bool.
 */
function outsideTheArrayReader(text: string, program: Program): boolean {
  if (/[,$;"={]|\brec\b|\barr\b|\btext\b|\bio\b|#/.test(text)) return true;
  const lines = text.split('\n');
  for (const l of lines) if (/^fn /.test(l) && /\([^)]*\s[^)]*\)/.test(l)) return true;
  const heads = lines.filter((l) => /^fn /.test(l));
  for (const [i, f] of program.functions.entries()) {
    const h = heads[i];
    if (h !== undefined && !h.includes('->') && f.result !== 'u32' && f.result !== 'bool')
      return true;
  }
  return false;
}

test('the B3.1 reader: mutants of programs with arrays are rejected exactly when the reference rejects them', (t) => {
  const read = loadReader();
  const gen = arrayGenerator(9191);
  const bases = Array.from({ length: 60 }, () =>
    formatDense(parse(gen.program()), { style: { repeat: false } }),
  );
  const rnd = rngFrom(31);
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (let m = 0; m < 400; m += 1) {
    const text = mutateArrays(pick(bases), rnd, pick);
    if (Buffer.byteLength(text) > PAGES * PAGE) continue;
    let program: Program | undefined;
    let want: string | null = null;
    try {
      program = parseDense(text);
      want = formatProgram(program);
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
    }
    const got = read(text);
    if (want === null) {
      assert.equal(
        got.err,
        true,
        `mutant ${m}: the reader flags what the reference rejects\n${text}`,
      );
      rejected += 1;
    } else if (got.err) {
      assert.ok(
        outsideTheArrayReader(text, program as Program),
        `mutant ${m}: the reader refuses a text of the forms it reads\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.text, want, `mutant ${m}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(
    `${rejected} mutants rejected, ${equal} read to the reference text, ${refused} refused`,
  );
  assert.ok(rejected > 150, 'most mutants are rejected');
  assert.ok(equal > 10, 'some mutants are accepted');
});

const ARRAY_CURATED: Curated[] = [
  ['an array literal', 'fn f -> u32\nx [1 2 3]\nget x 1\n'],
  ['an array literal as an operand', 'fn f -> u32\nget [1 2 3] A\n'],
  ['an array of parameters', 'fn f u32 u32 -> u32\nx [A B 7]\nget x 1\n'],
  ['an array of arrays', 'fn f -> u32x2x3\n[[1 2] [3 4] [5 6]]\n'],
  [
    'an array of arrays, read twice',
    'fn f u32 u32 -> u32\nx [A B]\ny [x [1 2] x]\nget get y 0 1\n',
  ],
  ['an array of records', 'fn f u32 bool -> (u32,bool)x2\n[(A B) (1 true)]\n'],
  ['an array of bools', 'fn f bool -> boolx2\n[A true]\n'],
  ['a one-element array', 'fn f u32 -> u32x1\n[A]\n'],
  ['set, then get', 'fn f u32x3 -> u32\nx set A 1 7\nget x 1\n'],
  ['set, get on a parameter', 'fn f u32x4 u32 u32 -> u32x4\nset A B C\n'],
  ['get on an array result', 'fn g -> u32x3\n[1 2 3]\n\nfn f -> u32\nget g 2\n'],
  ['an array argument', 'fn g u32x3 -> u32\nget A 0\n\nfn f -> u32\ng [4 5 6]\n'],
  ['an array of calls', 'fn g u32 -> u32\nadd A 1\n\nfn f u32 -> u32x2\n[g A g 2]\n'],
  ['an array of an array operation', 'fn f u32 -> u32x3\n[A add A 1 mul A 2]\n'],
  ['an implicit arity from an array', 'fn f -> u32x3\n[A B C]\n'],
  ['an implicit result from get', 'fn f\nx [1 2]\nget x 0\n'],
  ['an implicit result from get, bool', 'fn f\nx [true false]\nget x A\n'],
  ['an implicit result from a get of a get', 'fn f\nx [1 2]\ny [x x]\nget get y 0 1\n'],
  ['a get with a bool index', 'fn f\nx [1 2]\nget x true\n'],
  ['a set of the wrong element type', 'fn f\nx [1 2]\nset x 0 true\n'],
  ['a set whose array has two shapes', 'fn f\nx select true [1 2] [3 4 5]\nget x 0\n'],
  [
    'an implicit result from a call returning an array',
    'fn g -> u32x4\n[1 2 3 4]\n\nfn f\nx g\nget x 1\n',
  ],
  ['an unwritten result that is an array', 'fn f\nx [1 2]\nx\n', true],
  ['an unwritten result that is a get of arrays', 'fn f\nget [[true] [false]] 0\n', true],
  ['an unwritten result that is a select of arrays', 'fn f\nselect true [1 2] [3 4]\n', true],
  ['an empty array', 'fn f u32 -> u32\nget [] A\n'],
  ['an array not closed', 'fn f u32 -> u32\nget [1 2 A\n'],
  ['an array closed without a start', 'fn f u32 -> u32\nget 1 2] A\n'],
  ['an array closed by a parenthesis', 'fn f u32 -> u32\nget [1 2) A\n'],
  ['a group closed by a bracket', 'fn f u32 -> u32\nget (1 2] A\n'],
  ['get with one operand', 'fn f u32x2 -> u32\nget A\n'],
  ['get with three operands', 'fn f u32x2 -> u32\nget A 0 1\n'],
  ['set with two operands', 'fn f u32x2 -> u32x2\nset A 0\n'],
  ['a comma in an array', 'fn f -> u32x3\n[1, 2, 3]\n', true],
  ['a record in an array literal', 'fn f -> u32\nget [1 (2 3)] A\n'],
  ['an array named and reused', 'fn f u32 -> u32\nx [A A]\nadd get x 0 get x 1\n'],
  ['an array type with a record', 'fn f (u32,bool)x2 u32 -> (u32,bool)\nget A B\n'],
  [
    'an array of arrays of records',
    'fn f (u32,u32)x3x2 u32 -> u32\nx get A 1\ny get x B\nat y 0\n',
  ],
  ['a record of arrays', 'fn f (u32x2,bool) -> u32x2\nat A 0\n'],
  ['a record of arrays in an array', 'fn f (u32x2,bool)x3 -> (u32x2,bool)\nget A 0\n'],
  ['a three-dimensional array type', 'fn f u32x2x2x2 -> u32x2x2\nget A 1\n'],
  ['an array of one record field', 'fn f (u32)x2 -> (u32)\nget A 0\n'],
  ['the largest u32 array type', 'fn f u32x65536 -> u32\nget A 0\n'],
  ['an array type over its length', 'fn f u32x65537 -> u32\nA\n'],
  ['an array of bool over its length', 'fn f boolx65537 -> u32\nA\n'],
  ['the largest bool array type', 'fn f boolx65536 -> u32\nA\n'],
  ['an array type over its size', 'fn f u32x2049x32 -> u32\nA\n'],
  ['an array type at its size', 'fn f u32x2048x32 -> u32\nA\n'],
  ['a record type over its size', 'fn f (u32x65536,u32) -> u32\nA\n'],
  ['a record array over its size', 'fn f (u32x1000,u32x1000)x100 -> u32\nA\n'],
  ['a record array at its size', 'fn f (u32x1000,u32x1000)x32 -> u32\nA\n'],
  ['an array of length zero', 'fn f u32x0 -> u32\nA\n'],
  ['an array length with a leading zero', 'fn f u32x01 -> u32\nA\n'],
  ['an array of an unknown type', 'fn f u33x2 -> u32\nA\n'],
  ['an array of io', 'fn f iox2 -> u32\nA\n'],
  ['an array length that is no number', 'fn f u32xa -> u32\nA\n'],
  ['dimensions after a group', 'fn f (u32,bool)x2x3 -> u32\nA\n'],
  ['dimensions after a group, spaced', 'fn f (u32,bool) x2 -> u32\nA\n'],
  ['dimensions twice after a group', 'fn f (u32)x2 x3 -> u32\nA\n'],
  ['a dimension word alone', 'fn f x2 -> u32\nA\n'],
  ['an array result type', 'fn f -> boolx2x3\n[[true false] [true false] [false true]]\n'],
  ['an array type as a name', 'fn f u32x2 -> u32\nu32x2 add 1 2\n'],
  ['a name that looks like a dimension', 'fn f u32 -> u32\nx2 add A 1\nmul x2 x2\n'],
  ['a name that looks like a dimension, long', 'fn f u32 -> u32\nx128x32 add A 1\nmul x128x32 2\n'],
  ['get as a function name', 'fn get A\n'],
  ['set as an id', 'fn f set add 1 2\n'],
  [
    'a fold with an array extra operand',
    'fn g u32 u32 u32x2 -> u32\nA\n\nfn f u32x2 -> u32\nfold g 3 0 A\n',
  ],
  ['an inline fold over an array', 'fn f u32x2 -> u32\nfold {add A get C 0} 3 0 A\n', true],
];

test('the B3.1 reader: arrays, array types, get and set read as the reference reads them', (t) => {
  const read = loadReader();
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (const [label, text, refuse] of ARRAY_CURATED) {
    const want = reference(text);
    const got = read(text);
    if (want === null) {
      assert.equal(got.err, true, `${label}: the reader flags what the reference rejects\n${text}`);
      rejected += 1;
    } else if (refuse === true) {
      assert.equal(
        got.err,
        true,
        `${label}: a form outside the reader sets the error flag\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.err, false, `${label}: the error flag is clear\n${text}`);
      assert.equal(got.text, want, `${label}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(`${equal} read to the reference text, ${rejected} rejected, ${refused} refused`);
  assert.ok(equal > 35 && rejected > 15, 'both kinds are covered');
});

test('the B3.1 reader: the array regions set the error flag on overflow, never wrong output', () => {
  const read = loadReader();
  const elems = (n: number): string =>
    Array.from({ length: n }, (_, i) => String(i % 10)).join(' ');
  // depth 0: 2112 places; the arrays of a program share them
  const fits = `fn f -> u32x2112\n[${elems(2112)}]\n`;
  // the input holds 16384 bytes: a 2112 place array of one digit and a space fits
  assert.ok(Buffer.byteLength(fits) <= PAGES * PAGE);
  const fitsGot = read(fits);
  assert.equal(fitsGot.err, false, 'an array that fills its region');
  assert.equal(fitsGot.text, reference(fits));
  const over = `fn f -> u32x2113\n[${elems(2113)}]\n`;
  assert.equal(read(over).err, true, 'an array over its region');
  const two = `fn f -> u32x1100\n[${elems(1100)}]\n\nfn g -> u32x1100\n[${elems(1100)}]\n`;
  assert.equal(read(two).err, true, 'two arrays over the region of their depth');
  const two2 = `fn f -> u32x1000\n[${elems(1000)}]\n\nfn g -> u32x1000\n[${elems(1000)}]\n`;
  const two2Got = read(two2);
  assert.equal(two2Got.err, false, 'two arrays within the region');
  assert.equal(two2Got.text, reference(two2));
  // depth 1: an operand of an operation
  const d1 = (n: number): string => `fn f -> u32\nget [${elems(n)}] 0\n`;
  assert.equal(read(d1(448)).err, false, 'an array that fills the region of depth 1');
  assert.equal(read(d1(448)).text, reference(d1(448)));
  assert.equal(read(d1(449)).err, true, 'an array over the region of depth 1');
  // depth 2
  const d2 = (n: number): string => `fn f -> u32\nadd 1 get [${elems(n)}] 0\n`;
  assert.equal(read(d2(64)).err, false, 'an array that fills the region of depth 2');
  assert.equal(read(d2(64)).text, reference(d2(64)));
  assert.equal(read(d2(65)).err, true, 'an array over the region of depth 2');
  // nesting: the frames hold eight levels
  const deep = (d: number): string => `fn f -> u32\n${'get ['.repeat(d)}1${' ] 0'.repeat(d)}\n`;
  assert.equal(read(deep(3)).err, false, 'arrays nested three deep');
  assert.equal(read(deep(3)).text, reference(deep(3)));
  assert.equal(read(deep(5)).err, true, 'arrays nested over the frames');
});

// ---------------------------------------------------------------------------
// Stage B3.2: the repeat form [x;n], the $ escape and `=` after a name
// ---------------------------------------------------------------------------

/** A dense text with `=` after the name of a statement (the printer never writes it). */
function withEquals(text: string, rnd: (n: number) => number): string {
  const words = new Set<string>([
    ...BIN_OPS,
    ...CMP_OPS,
    ...['select', 'get', 'set', 'mov', 'at', 'put', 'rec', 'call', 'fold', 'loop', 'arr'],
    ...['ret', 'fn', 'end', 'use', 'true', 'false'],
    ...[...text.matchAll(/^fn (\S+)/gm)].map((m) => m[1] as string),
  ]);
  return text
    .split('\n')
    .map((l) => {
      const m = /^(\$?[a-z][a-z0-9_]*) (?!=)(.+)$/.exec(l);
      if (m === null || (!(m[1] as string).startsWith('$') && words.has(m[1] as string))) return l;
      return rnd(3) !== 0 ? l : `${m[1]} = ${m[2]}`;
    })
    .join('\n');
}

/** A dense text with some uses of the names of nodes written with the `$` escape. */
function withEscapes(text: string, rnd: (n: number) => number): string {
  const words = new Set<string>([
    ...BIN_OPS,
    ...CMP_OPS,
    ...['select', 'get', 'set', 'mov', 'at', 'put', 'rec', 'call', 'fold', 'loop', 'arr'],
    ...['ret', 'fn', 'end', 'use', 'true', 'false'],
    ...[...text.matchAll(/^fn (\S+)/gm)].map((m) => m[1] as string),
  ]);
  const names = new Set<string>();
  for (const l of text.split('\n')) {
    const m = /^(\$?)([a-z][a-z0-9_]*) (?!=)/.exec(l);
    if (m !== null && (m[1] === '$' || !words.has(m[2] as string))) names.add(m[2] as string);
  }
  // a name that is also a word of the text (an op, a function) is written with `$` already, or not at all
  const chosen = new Set([...names].filter((n) => !words.has(n) && rnd(3) === 0));
  if (chosen.size === 0) return text;
  return text
    .split('\n')
    .map((l) =>
      l.startsWith('fn ')
        ? l
        : l.replace(/(\$?)\b([a-z][a-z0-9_]*)\b/g, (all, d: string, w: string) =>
            d === '' && chosen.has(w) ? `$${w}` : all,
          ),
    )
    .join('\n');
}

test('the B3.2 reader: generated programs with repeats and escapes read to their canonical text', (t) => {
  const read = loadReader();
  const gen = arrayGenerator(5150, { repeat: true, escapes: true });
  const rnd = rngFrom(77);
  let repeats = 0;
  let escapes = 0;
  let equals = 0;
  let checked = 0;
  for (let k = 0; k < 250; k += 1) {
    const program = parse(gen.program());
    const base = formatDense(program);
    // the printer's text, the same with `=` after names, and with more names escaped
    const variants = [base, withEquals(base, rnd), withEscapes(base, rnd)];
    for (const dense of variants) {
      if (Buffer.byteLength(dense) > PAGES * PAGE) continue;
      const want = reference(dense);
      assert.equal(
        want,
        formatProgram(program),
        `program ${k}: a variant means the same program\n${dense}`,
      );
      const got = read(dense);
      assert.equal(got.err, false, `program ${k}: the error flag is clear\n${dense}`);
      assert.equal(got.text, want, `program ${k}\n${dense}`);
      checked += 1;
      if (/;\d/.test(dense)) repeats += 1;
      if (/\$[a-z]/.test(dense)) escapes += 1;
      if (/^[$a-z][a-z0-9_]* = /m.test(dense)) equals += 1;
    }
  }
  t.diagnostic(
    `${checked} texts, ${repeats} with a repeat, ${escapes} with an escape, ${equals} with =`,
  );
  assert.ok(checked > 600, 'most programs fit the input');
  assert.ok(repeats > 80 && escapes > 100 && equals > 60, 'the forms are covered');
});

/**
 * A text the reference reads but the reader leaves to the error flag, for the reader of Stage B3.2:
 * a comma used as a blank, a text literal, the `rec` or `arr` word, an inline body, an `io` word, a
 * type written with spaces, or an unwritten result that is not u32 or bool.
 */
function outsideTheReaderB32(text: string, program: Program): boolean {
  if (/[,"{]|\brec\b|\barr\b|\btext\b|\bio\b|#/.test(text)) return true;
  const lines = text.split('\n');
  for (const l of lines) if (/^fn /.test(l) && /\([^)]*\s[^)]*\)/.test(l)) return true;
  const heads = lines.filter((l) => /^fn /.test(l));
  for (const [i, f] of program.functions.entries()) {
    const h = heads[i];
    if (h !== undefined && !h.includes('->') && f.result !== 'u32' && f.result !== 'bool')
      return true;
  }
  // a repeat or an array literal that does not fit the regions of its depth
  return /\[[^\]]*;(\d{4,}|[3-9]\d{2})\b/.test(text);
}

test('the B3.2 reader: mutants of programs with repeats and escapes are rejected exactly when the reference rejects them', (t) => {
  const read = loadReader();
  const gen = arrayGenerator(6262, { repeat: true, escapes: true });
  const rnd = rngFrom(404);
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  const bases = Array.from({ length: 60 }, () => {
    const b = formatDense(parse(gen.program()));
    return rnd(3) === 0 ? withEquals(b, rnd) : b;
  });
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (let m = 0; m < 500; m += 1) {
    const text = mutateArrays(pick(bases), rnd, pick);
    if (Buffer.byteLength(text) > PAGES * PAGE) continue;
    let program: Program | undefined;
    let want: string | null = null;
    try {
      program = parseDense(text);
      want = formatProgram(program);
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
    }
    const got = read(text);
    if (want === null) {
      assert.equal(
        got.err,
        true,
        `mutant ${m}: the reader flags what the reference rejects\n${text}`,
      );
      rejected += 1;
    } else if (got.err) {
      assert.ok(
        outsideTheReaderB32(text, program as Program),
        `mutant ${m}: the reader refuses a text of the forms it reads\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.text, want, `mutant ${m}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(
    `${rejected} mutants rejected, ${equal} read to the reference text, ${refused} refused`,
  );
  assert.ok(rejected > 150, 'most mutants are rejected');
  assert.ok(equal > 30, 'some mutants are accepted');
});

const ESCAPE_CURATED: Curated[] = [
  ['a repeat of a literal', 'fn f -> u32x5\n[0;5]\n'],
  ['a repeat of a parameter', 'fn f u32 -> u32x3\n[A;3]\n'],
  ['a repeat of an operation', 'fn f u32 -> u32x4\n[add A 1;4]\n'],
  ['a repeat of an array', 'fn f u32 -> u32x3x2\n[[1 2 3];2]\n'],
  ['a repeat of a bool', 'fn f -> boolx3\n[true;3]\n'],
  ['a repeat of one', 'fn f u32 -> u32x2\n[7;1]\n'],
  ['elements after a repeat', 'fn f -> u32x3\n[7;1 8 9]\n'],
  ['elements after a repeat, the form of the reference', 'fn f -> u32x4\n[7;2 8 9]\n'],
  ['a repeat in an operand', 'fn f u32 -> u32\nget [A;4] 2\n'],
  ['a repeat in a call', 'fn g u32x4 -> u32\nget A 1\n\nfn f u32 -> u32\ng [A;4]\n'],
  ['a repeat in an array', 'fn f u32 -> u32x2x3\n[[A;2] [1;2] [2;2]]\n'],
  ['a repeat of zero', 'fn f -> u32x2\n[7;0]\n'],
  ['a repeat over its length', 'fn f -> u32x2\n[7;65537]\n'],
  ['a repeat after two elements', 'fn f -> u32x2\n[7 8;2]\n'],
  ['a repeat of nothing', 'fn f -> u32x2\n[;2]\n'],
  ['a repeat twice', 'fn f -> u32x2\n[7;2;3]\n'],
  ['a repeat by a parameter', 'fn f -> u32x2\n[7;A]\n'],
  ['a repeat in a group', 'fn f -> u32x2\n(7;2)\n'],
  ['a repeat not closed', 'fn f -> u32x2\n[7;2\n'],
  ['a repeat by a number with a zero', 'fn f -> u32x2\n[7;02]\n'],
  ['a repeat by a hex number', 'fn f -> u32x2\n[7;0x2]\n'],
  ['a repeat by a number too big', 'fn f -> u32x2\n[7;99999999999]\n'],
  ['a repeat by the count of an array region', 'fn f -> u32x2112\n[0;2112]\n'],
  ['a repeat over the region', 'fn f -> u32x2113\n[0;2113]\n', true],
  ['a repeat by the greatest length', 'fn f -> u32x65536\n[0;65536]\n', true],
  ['a repeat of a node', 'fn f u32 -> u32x2\nx add A 1\n[x;2]\n'],
  ['a repeat after a name', 'fn f u32 -> u32x3\nx [A;3]\nset x 1 7\n'],
  ['the semicolon in a body', 'fn f fold {a [A;3]; get a 1} 3 0\n'],
  ['a keyword as an id', 'fn f u32 -> u32\n$rem add A 1\nmul $rem $rem\n'],
  [
    'a keyword as an id, the second',
    'fn f u32 -> u32\n$add add A 1\n$get mul $add 2\nget [1 2 3] $get\n',
  ],
  ['a keyword as an id without the escape', 'fn f u32 -> u32\nrem add A 1\nmul rem rem\n'],
  ['a function name as an id', 'fn g A\n\nfn f u32 -> u32\n$g add A 1\nmul $g $g\n'],
  [
    'a function name as an id without the escape',
    'fn g A\n\nfn f u32 -> u32\ng add A 1\nmul g g\n',
  ],
  ['a type-like word as an id', 'fn f u32 -> u32\n$u32x2 add A 1\nmul $u32x2 2\n'],
  ['u32 as an id', 'fn f u32 -> u32\n$u32 add A 1\nmul $u32 2\n'],
  ['an id, escaped for no reason', 'fn f u32 -> u32\n$x add A 1\nmul $x $x\n'],
  ['an escaped use of a plain id', 'fn f u32 -> u32\nx add A 1\nmul $x $x\n'],
  ['an escape of a name not defined', 'fn f u32 -> u32\nx add A 1\nadd $y x\n'],
  ['an escape of a name defined later', 'fn f u32 -> u32\nadd $y 1\ny add A 1\n'],
  ['an escape of a function name', 'fn g A\n\nfn f u32 -> u32\nadd $g 1\n'],
  ['an escape of a keyword never defined', 'fn f u32 -> u32\nadd $add 1\n'],
  ['an escape of a reserved word', 'fn f u32 -> u32\n$fn add A 1\n$fn\n'],
  ['an escape of ret', 'fn f u32 -> u32\n$ret add A 1\n$ret\n'],
  ['an escape of true', 'fn f u32 -> u32\n$true add A 1\n$true\n'],
  ['an escape of a parameter word', 'fn f u32 -> u32\n$p3 add A 1\n$p3\n'],
  ['an escape of a letter', 'fn f u32 -> u32\n$A add A 1\nA\n'],
  ['an escape of a number', 'fn f u32 -> u32\n$5 add A 1\n$5\n'],
  ['an escape of a symbol', 'fn f u32 -> u32\n$+ add A 1\n$+\n'],
  ['an escape followed by a space', 'fn f u32 -> u32\n$ x add A 1\nx\n'],
  ['two escapes', 'fn f u32 -> u32\n$$x add A 1\nx\n'],
  ['an escape inside a word', 'fn f u32 -> u32\nx$y add A 1\nx\n'],
  ['an escape alone on a line', 'fn f u32 -> u32\nadd A 1\n$\n'],
  ['an escape of the result', 'fn f u32 -> u32\nx add A 1\nret $x\n'],
  ['an escape of the result, as a statement', 'fn f u32 -> u32\nx add A 1\n$x\n'],
  ['an escaped name defined twice', 'fn f u32 -> u32\n$x add A 1\n$x add A 2\n$x\n'],
  ['an escaped name and a plain name', 'fn f u32 -> u32\n$x add A 1\nx add A 2\nx\n'],
  ['an escaped name as a function name', 'fn $f A\n'],
  ['an escape in a header', 'fn f $x -> u32\nA\n'],
  ['an escape in a comment', 'fn f u32 -> u32\nadd A 1 # $x\n'],
  ['an escape in an inline body', 'fn f fold {$x add A B; mul $x 2} 3 0\n'],
  ['a name taken from a fold body', 'fn f x fold {add A B} 3 0\nadd $x 1\n'],
  ['= after a name', 'fn f u32 -> u32\nx = add A 1\nmul x x\n'],
  ['= after a keyword', 'fn f u32 -> u32\nadd = add A 1\nmul $add $add\n'],
  ['= after a function name', 'fn g A\n\nfn f u32 -> u32\ng = add A 1\nmul $g $g\n'],
  ['= after an escaped name', 'fn f u32 -> u32\n$x = add A 1\nmul $x $x\n'],
  ['= after a reserved word', 'fn f u32 -> u32\ntrue = add A 1\ntrue\n'],
  ['= after ret', 'fn f u32 -> u32\nret = add A 1\nret\n'],
  ['= after a parameter word', 'fn f u32 -> u32\np3 = add A 1\np3\n'],
  ['= after a letter', 'fn f u32 -> u32\nA = add A 1\nA\n'],
  ['= after a number', 'fn f u32 -> u32\n5 = add A 1\n5\n'],
  ['= alone after a name', 'fn f u32 -> u32\nx =\nmul x x\n'],
  ['= twice', 'fn f u32 -> u32\nx = y = add A 1\nx\n'],
  ['= at the end of an expression', 'fn f u32 -> u32\nadd A =\n'],
  ['= as an operand', 'fn f u32 -> u32\nadd = A\n'],
  ['= in an array', 'fn f u32 -> u32x2\n[A = 1]\n'],
  ['= after a name already defined', 'fn f u32 -> u32\nx add A 1\nx = add A 2\nx\n'],
  ['= after a copied value', 'fn f u32 -> u32\nx add A 1\ny = x\nadd y x\n'],
  ['= after a name, on the header line', 'fn f u32 -> u32 x = add A 1\n'],
  ['= before a call', 'fn g A\n\nfn f u32 -> u32\nx = g A\nadd x 1\n'],
  ['= before an array', 'fn f u32 -> u32\nx = [A A]\nget x 1\n'],
  ['= in an inline body', 'fn f fold {x = add A B; mul x 2} 3 0\n'],
  ['mod after a name', 'fn f u32 -> u32\nmod = add A 1\nmul $mod $mod\n'],
];

test('the B3.2 reader: repeats, escapes and = read as the reference reads them', (t) => {
  const read = loadReader();
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (const [label, text, refuse] of ESCAPE_CURATED) {
    const want = reference(text);
    const got = read(text);
    if (want === null) {
      assert.equal(got.err, true, `${label}: the reader flags what the reference rejects\n${text}`);
      rejected += 1;
    } else if (refuse === true) {
      assert.equal(
        got.err,
        true,
        `${label}: a form outside the reader sets the error flag\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.err, false, `${label}: the error flag is clear\n${text}`);
      assert.equal(got.text, want, `${label}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(`${equal} read to the reference text, ${rejected} rejected, ${refused} refused`);
  assert.ok(equal > 20 && rejected > 25, 'both kinds are covered');
});

test('the B3.2 reader: a repeat that does not fit its region sets the error flag, never wrong output', () => {
  const read = loadReader();
  const rep = (n: number, at: string): string =>
    `fn f -> u32\n${at === '' ? '' : `${at} `}get [0;${n}] 0\n`;
  // depth 1: 448 places, shared with the other arrays of that depth
  assert.equal(read(rep(448, '')).err, false);
  assert.equal(read(rep(448, '')).text, reference(rep(448, '')));
  assert.equal(read(rep(449, '')).err, true);
  // two arrays of the same depth share the region
  const two = `fn f -> u32\nx get [0;300] 0\ny get [0;300] 0\nadd x y\n`;
  assert.equal(read(two).err, true, 'two repeats over the region of their depth');
  const twoOk = `fn f -> u32\nx get [0;200] 0\ny get [0;200] 0\nadd x y\n`;
  assert.equal(read(twoOk).err, false);
  assert.equal(read(twoOk).text, reference(twoOk));
  // a repeat then more elements fills the region
  const tail = `fn f -> u32\nget [0;447 1] 0\n`;
  assert.equal(read(tail).err, false);
  assert.equal(read(tail).text, reference(tail));
  const tailOver = `fn f -> u32\nget [0;448 1] 0\n`;
  assert.equal(read(tailOver).err, true);
});

// ---------------------------------------------------------------------------
// Stage B3.3: the type io and the operations read, write and puts
// ---------------------------------------------------------------------------

/**
 * Generated canonical programs with io: functions that take an io token among other parameters,
 * write, puts and read through it, call earlier functions with it, and give it back (alone, or
 * with a u32 in a record). The token is used once, as the checker demands.
 */
function ioGenerator(seed0: number) {
  const rnd = rngFrom(seed0);
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  interface Val {
    ref: string;
    ty: string;
  }
  interface Sig {
    name: string;
    params: string[];
    result: string;
  }
  const fn = (name: string, sigs: readonly Sig[]): { text: string; sig: Sig } => {
    const np = 1 + rnd(3);
    const ioAt = rnd(np);
    const params = Array.from({ length: np }, (_, i) =>
      i === ioAt ? 'io' : pick(['u32', 'u32', 'bool', 'u32x3', 'u32x4']),
    );
    const vals: Val[] = params.flatMap((ty, i) => (ty === 'io' ? [] : [{ ref: `p${i}`, ty }]));
    let cur = `p${ioAt}`;
    const lines: string[] = [];
    const dn = defaultNames(new Set<string>([name]));
    const emit = (op: string, args: string[], ty: string): string => {
      const id = dn.next().value as string;
      lines.push(`${id} ${op} ${args.join(' ')}`);
      vals.push({ ref: id, ty });
      return id;
    };
    const u32 = (): string => {
      const c = vals.filter((v) => v.ty === 'u32');
      return c.length > 0 && rnd(3) > 0 ? (pick(c) as Val).ref : String(rnd(300));
    };
    const arr = (n: number): string => {
      const ty = `u32x${n}`;
      const c = vals.filter((v) => v.ty === ty);
      if (c.length > 0 && rnd(2) === 0) return (pick(c) as Val).ref;
      return emit('arr', Array.from({ length: n }, u32), ty);
    };
    const arg = (ty: string): string => {
      if (ty === 'u32') return u32();
      if (ty === 'bool') return pick(['true', 'false']);
      return arr(Number(ty.slice(4)));
    };
    const steps = 1 + rnd(5);
    for (let s = 0; s < steps; s += 1) {
      const k = rnd(8);
      if (k < 2) cur = emit('write', [cur, u32()], 'io');
      else if (k < 4) cur = emit('puts', [cur, arr(3 + rnd(2))], 'io');
      else if (k < 5) {
        const r = emit('read', [cur], '(u32,io)');
        emit('at', [r, '0'], 'u32');
        cur = emit('at', [r, '1'], 'io');
      } else if (k < 6 && sigs.length > 0) {
        const sg = pick(sigs) as Sig;
        const args = sg.params.map((ty) => (ty === 'io' ? cur : arg(ty)));
        const id = emit('call', [sg.name, ...args], sg.result);
        if (sg.result === 'io') cur = id;
        else {
          emit('at', [id, '0'], 'u32');
          cur = emit('at', [id, '1'], 'io');
        }
      } else emit(pick(['add', 'mul', 'xor', 'sub']), [u32(), u32()], 'u32');
    }
    let result = 'io';
    let ret = cur;
    if (rnd(3) === 0) {
      ret = emit('read', [cur], '(u32,io)');
      result = '(u32,io)';
    }
    const text = `fn ${name} ${params.join(' ')} -> ${result}\n${lines.join('\n')}\nret ${ret}\nend`;
    return { text, sig: { name, params, result } };
  };
  const program = (): string => {
    const sigs: Sig[] = [];
    const parts: string[] = [];
    const nf = 1 + rnd(3);
    for (let f = 0; f < nf; f += 1) {
      const made = fn(`g${f}x${rnd(9)}`, sigs);
      parts.push(made.text);
      sigs.push(made.sig);
    }
    return parts.join('\n\n');
  };
  return { program, rnd, pick };
}

/** A generated io program that the checker accepts (the generator is retried until it does). */
function validIoProgram(gen: ReturnType<typeof ioGenerator>): Program {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return parse(gen.program());
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
    }
  }
  throw new Error('the io generator writes no valid program');
}

test('the B3.3 reader: generated programs with io read to their canonical text', (t) => {
  const read = loadReader();
  const gen = ioGenerator(4711);
  let withRead = 0;
  let withWrite = 0;
  let withPuts = 0;
  let withIoResult = 0;
  let checked = 0;
  for (let k = 0; k < 250; k += 1) {
    const program = validIoProgram(gen);
    const dense = formatDense(program);
    if (Buffer.byteLength(dense) > PAGES * PAGE) continue;
    const got = read(dense);
    assert.equal(got.err, false, `program ${k}: the error flag is clear\n${dense}`);
    assert.equal(got.text, formatProgram(program), `program ${k}\n${dense}`);
    checked += 1;
    if (/\bread\b/.test(dense)) withRead += 1;
    if (/\bwrite\b/.test(dense)) withWrite += 1;
    if (/\bputs\b/.test(dense)) withPuts += 1;
    if (/-> \(u32,io\)/.test(dense)) withIoResult += 1;
  }
  t.diagnostic(
    `${checked} programs, ${withRead} with read, ${withWrite} with write, ${withPuts} with puts, ${withIoResult} with a record result`,
  );
  assert.ok(checked > 200, 'most programs fit the input');
  assert.ok(withRead > 60 && withWrite > 60 && withPuts > 60 && withIoResult > 30, 'forms covered');
});

/**
 * A text the reference reads but the reader leaves to the error flag, for the reader of Stage B3.3:
 * a comma used as a blank, a text literal, the `rec` or `arr` word, an inline body, the `io` word
 * in a body, a checked op, a type written with spaces, or an unwritten result that is not u32 or
 * bool.
 */
function outsideTheReaderB33(text: string, program: Program): boolean {
  if (/[,"{]|\brec\b|\barr\b|\btext\b|#|\b(cadd|csub|cmul|cdiv|crem|cget)\b/.test(text))
    return true;
  const lines = text.split('\n');
  for (const l of lines) {
    if (/^fn /.test(l) && /\([^)]*\s[^)]*\)/.test(l)) return true;
    // the `io` word as a value: after the types of a header, or in a statement
    const body = /^fn /.test(l) ? l.replace(/^fn \S+( .*?->)? \S+/, '') : l;
    if (/\bio\b/.test(/^fn /.test(l) && !l.includes('->') ? l : body)) return true;
  }
  const heads = lines.filter((l) => /^fn /.test(l));
  for (const [i, f] of program.functions.entries()) {
    const h = heads[i];
    if (h !== undefined && !h.includes('->') && f.result !== 'u32' && f.result !== 'bool')
      return true;
  }
  return /\[[^\]]*;(\d{4,}|[3-9]\d{2})\b/.test(text);
}

test('the B3.3 reader: mutants of programs with io are rejected exactly when the reference rejects them', (t) => {
  const read = loadReader();
  const gen = ioGenerator(1234);
  const rnd = rngFrom(808);
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  const tokens = [...ARRAY_MUTANT_TOKENS, 'io', 'io', 'read', 'write', 'puts', 'iox2', '(u32,io)'];
  const bases = Array.from({ length: 60 }, () => formatDense(validIoProgram(gen)));
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (let m = 0; m < 500; m += 1) {
    const text = mutateArrays(pick(bases), rnd, pick, tokens);
    if (Buffer.byteLength(text) > PAGES * PAGE) continue;
    let program: Program | undefined;
    let want: string | null = null;
    try {
      program = parseDense(text);
      want = formatProgram(program);
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
    }
    const got = read(text);
    if (want === null) {
      assert.equal(
        got.err,
        true,
        `mutant ${m}: the reader flags what the reference rejects\n${text}`,
      );
      rejected += 1;
    } else if (got.err) {
      assert.ok(
        outsideTheReaderB33(text, program as Program),
        `mutant ${m}: the reader refuses a text of the forms it reads\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.text, want, `mutant ${m}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(
    `${rejected} mutants rejected, ${equal} read to the reference text, ${refused} refused`,
  );
  assert.ok(rejected > 100, 'many mutants are rejected');
  assert.ok(equal > 30, 'some mutants are accepted');
});

const IO_CURATED: Curated[] = [
  ['an io parameter and result', 'fn f io -> io\nA\n'],
  ['an io parameter, a u32 result', 'fn f io u32 -> u32\nB\n'],
  ['an io result from a write', 'fn f io u32 -> io\nwrite A B\n'],
  ['a write of a literal', 'fn f io -> io\nwrite A 65\n'],
  ['two writes', 'fn f io -> io\nx write A 65\nwrite x 10\n'],
  ['two writes, nested', 'fn f io -> io\nwrite write A 65 10\n'],
  ['a puts of a literal array', 'fn f io -> io\nputs A [72 105]\n'],
  ['a puts of a parameter', 'fn f io u32x4 -> io\nputs A B\n'],
  ['a puts of a repeat', 'fn f io -> io\nputs A [65;4]\n'],
  ['a read', 'fn f io -> (u32,io)\nread A\n'],
  ['a read, its parts', 'fn f io -> io\nr read A\nv at r 0\nat r 1\n'],
  ['a read, then a write', 'fn f io -> io\nr read A\nv at r 0\nt at r 1\nwrite t v\n'],
  ['a result of a record with io', 'fn f io u32 -> (u32,io)\nr write A B\nread r\n'],
  ['a record of io and u32', 'fn f io u32 -> (io,u32)\n(A B)\n'],
  ['a record of io, nested', 'fn f io -> ((u32,io),u32)\n((1 A) 2)\n'],
  ['two io fields in a type', 'fn f (io,io) -> u32\n0\n'],
  ['an io type in the middle', 'fn f u32 io u32 -> u32\nC\n'],
  ['an io callee', 'fn g io u32 -> io\nwrite A B\n\nfn f io -> io\ng A 7\n'],
  ['an io callee with call', 'fn g io u32 -> io\nwrite A B\n\nfn f io -> io\ncall g A 7\n'],
  [
    'an io arg of a callee in a callee',
    'fn g io u32 -> io\nwrite A B\n\nfn h io -> io\ng g A 1 2\n',
  ],
  ['an array of io', 'fn f iox2 -> u32\n0\n'],
  ['a record of io in an array', 'fn f (io,u32)x2 -> u32\n0\n'],
  ['a record array of io, spaced', 'fn f (io,u32) x2 -> u32\n0\n'],
  ['io with a dimension word', 'fn f io x2 -> u32\n0\n'],
  ['a type with io and a big array', 'fn f (io,u32x65536,u32x65536) -> u32\n0\n'],
  ['a record array over its size without io', 'fn f (u32x65536,u32x65536) -> u32\n0\n'],
  ['a record with io, its array over its size', 'fn f ((io,u32x65536)) -> u32\n0\n'],
  ['an inner record over its size beside io', 'fn f (io,(u32x65536,u32x65536)) -> u32\n0\n'],
  ['a read with too many operands', 'fn f io -> (u32,io)\nread A B\n'],
  ['a read with none', 'fn f io -> (u32,io)\nread\n'],
  ['a write with one operand', 'fn f io -> io\nwrite A\n'],
  ['a puts with three', 'fn f io -> io\nputs A [1] 2\n'],
  ['a read as an id', 'fn f io -> io\nread = write A 1\n$read\n'],
  ['write as a function name', 'fn write A\n'],
  ['puts as an id', 'fn f io -> io\n$puts write A 1\n$puts\n'],
  ['an implicit read', 'fn f\nr read A\nat r 0\n'],
  ['an implicit write on a u32', 'fn f\nwrite A 1\n'],
  ['an implicit puts', 'fn f\nputs A [1 2]\n'],
  ['the io word', 'fn f io u32 -> io\nwrite io B\n', true],
  ['the io word, two io parameters', 'fn f io io -> io\nwrite io 1\n'],
  ['the io word, no io parameter', 'fn f u32 -> u32\nwrite io 1\n'],
  ['io as a name', 'fn f io -> io\nio write A 1\nio\n'],
  ['a checked op', 'fn f u32 u32 -> (u32,bool)\ncadd A B\n', true],
  ['an io type as a function name', 'fn io A\n'],
  ['an arrow as a function name', 'fn -> u32 -> u32 add A 62\n'],
  ['an arrow as a function name, the types of io', 'fn -> io -> io write A 62\n'],
  ['= as a function name', 'fn = A\n'],
  ['a symbol as a function name', 'fn + A\n'],
  ['a function name that starts with an underscore', 'fn _f A\n'],
  ['an io parameter in a fold', 'fn g u32 u32 -> u32\nA\n\nfn f io -> u32\nfold g 3 0\n'],
];

test('the B3.3 reader: io types and the operations read, write and puts read as the reference reads them', (t) => {
  const read = loadReader();
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (const [label, text, refuse] of IO_CURATED) {
    const want = reference(text);
    const got = read(text);
    if (want === null) {
      assert.equal(got.err, true, `${label}: the reader flags what the reference rejects\n${text}`);
      rejected += 1;
    } else if (refuse === true) {
      assert.equal(
        got.err,
        true,
        `${label}: a form outside the reader sets the error flag\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.err, false, `${label}: the error flag is clear\n${text}`);
      assert.equal(got.text, want, `${label}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(`${equal} read to the reference text, ${rejected} rejected, ${refused} refused`);
  assert.ok(equal > 25 && rejected > 8, 'both kinds are covered');
});

// ---------------------------------------------------------------------------
// Stage B3.4: text literals, `"..."` and `text "..."`
// ---------------------------------------------------------------------------

/** The characters a generated text is made of: one byte each, the escaped ones and the lexer's marks. */
const TEXT_CHARS = [
  ...'abcdefghij klmnopqrst 0123456789',
  '#',
  ';',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  '=',
  '$',
  '\\',
  '"',
  '\n',
  '\t',
  '_',
  '-',
  '>',
];

/** A text of exactly n bytes of UTF-8 (a two- and a three-byte character now and then). */
function textOfBytes(n: number, rnd: (n: number) => number): string {
  let s = '';
  let left = n;
  while (left > 0) {
    const r = rnd(24);
    if (r === 0 && left >= 2) {
      s += 'é';
      left -= 2;
    } else if (r === 1 && left >= 3) {
      s += '€';
      left -= 3;
    } else {
      s += TEXT_CHARS[rnd(TEXT_CHARS.length)] as string;
      left -= 1;
    }
  }
  return s;
}

/** The canonical text of a function with a text node. */
function textProgram(rnd: (n: number) => number): string {
  const parts: string[] = [];
  const nf = 1 + rnd(3);
  for (let f = 0; f < nf; f += 1) {
    const lines: string[] = [];
    const n = 1 + rnd(40);
    const text = textOfBytes(n, rnd);
    lines.push(`a text ${formatTextLiteral(text)}`);
    let last = 'a';
    let ty = `u32x${n}`;
    const k = rnd(4);
    if (k === 1) {
      lines.push(`b get a ${rnd(60)}`);
      last = 'b';
      ty = 'u32';
    } else if (k === 2) {
      const m = 1 + rnd(30);
      lines.push(`b text ${formatTextLiteral(textOfBytes(m, rnd))}`);
      lines.push(`c get b ${rnd(30)}`);
      lines.push(`d get a ${rnd(30)}`);
      lines.push('e add c d');
      last = 'e';
      ty = 'u32';
    } else if (k === 3) {
      lines.push(`b set a ${rnd(n)} ${rnd(256)}`);
      last = 'b';
    }
    parts.push(`fn t${f}x${rnd(9)} -> ${ty}\n${lines.join('\n')}\nret ${last}\nend`);
  }
  return parts.join('\n\n');
}

test('the B3.4 reader: generated programs with text literals read to their canonical text', (t) => {
  const read = loadReader();
  const rnd = rngFrom(2718);
  let withEscape = 0;
  let checked = 0;
  for (let k = 0; k < 250; k += 1) {
    const program = parse(textProgram(rnd));
    const dense = formatDense(program);
    if (Buffer.byteLength(dense) > PAGES * PAGE) continue;
    const got = read(dense);
    assert.equal(got.err, false, `program ${k}: the error flag is clear\n${dense}`);
    assert.equal(got.text, formatProgram(program), `program ${k}\n${dense}`);
    checked += 1;
    if (/\\[nt"\\]/.test(dense)) withEscape += 1;
  }
  t.diagnostic(`${checked} programs, ${withEscape} with an escape`);
  assert.ok(checked > 200 && withEscape > 60, 'the forms are covered');
});

/**
 * A text the reference reads but the reader leaves to the error flag, for the reader of Stage B3.4:
 * a comma used as a blank, the `rec` or `arr` word, an inline body, the `io` word in a body, a
 * checked op, a type written with spaces, or an unwritten result that is not u32 or bool.
 */
function outsideTheReaderB34(text: string, program: Program): boolean {
  const lines = text.split('\n').map((l) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
  const flat = lines.join('\n');
  if (/[,{]|\brec\b|\barr\b|#|\b(cadd|csub|cmul|cdiv|crem|cget)\b/.test(flat)) return true;
  for (const l of lines) {
    if (/^fn /.test(l) && /\([^)]*\s[^)]*\)/.test(l)) return true;
    const body = /^fn /.test(l) ? l.replace(/^fn \S+( .*?->)? \S+/, '') : l;
    if (/\bio\b/.test(/^fn /.test(l) && !l.includes('->') ? l : body)) return true;
  }
  const heads = lines.filter((l) => /^fn /.test(l));
  for (const [i, f] of program.functions.entries()) {
    const h = heads[i];
    if (h !== undefined && !h.includes('->') && f.result !== 'u32' && f.result !== 'bool')
      return true;
  }
  return /\[[^\]]*;(\d{4,}|[3-9]\d{2})\b/.test(flat);
}

test('the B3.4 reader: mutants of programs with text literals are rejected exactly when the reference rejects them', (t) => {
  const read = loadReader();
  const rnd = rngFrom(909);
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  const tokens = [
    ...ARRAY_MUTANT_TOKENS,
    '"',
    '""',
    '"ab"',
    '"a\\nb"',
    '"a\\qb"',
    'text',
    'text',
    '"x',
    '\\',
  ];
  const bases = Array.from({ length: 60 }, () => formatDense(parse(textProgram(rnd))));
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (let m = 0; m < 500; m += 1) {
    const text = mutateArrays(pick(bases), rnd, pick, tokens);
    if (Buffer.byteLength(text) > PAGES * PAGE) continue;
    let program: Program | undefined;
    let want: string | null = null;
    try {
      program = parseDense(text);
      want = formatProgram(program);
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
    }
    const got = read(text);
    if (want === null) {
      assert.equal(
        got.err,
        true,
        `mutant ${m}: the reader flags what the reference rejects\n${text}`,
      );
      rejected += 1;
    } else if (got.err) {
      assert.ok(
        outsideTheReaderB34(text, program as Program),
        `mutant ${m}: the reader refuses a text of the forms it reads\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.text, want, `mutant ${m}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(
    `${rejected} mutants rejected, ${equal} read to the reference text, ${refused} refused`,
  );
  assert.ok(rejected > 100, 'many mutants are rejected');
  assert.ok(equal > 30, 'some mutants are accepted');
});

const TEXT_CURATED: Curated[] = [
  ['a text literal', 'fn f -> u32x3\n"abc"\n'],
  ['text before a literal', 'fn f -> u32x3\ntext "abc"\n'],
  ['text before text', 'fn f -> u32x3\ntext text "abc"\n'],
  ['a literal as an operand', 'fn f u32 -> u32\nget "abc" A\n'],
  ['a literal named', 'fn f u32 -> u32\nx "hello world"\nget x A\n'],
  ['a literal named with =', 'fn f u32 -> u32\nx = "abc"\nget x A\n'],
  ['a literal named with the escape', 'fn f u32 -> u32\n$text "abc"\nget $text A\n'],
  ['a newline escape', 'fn f -> u32x3\n"a\\nb"\n'],
  ['a tab escape', 'fn f -> u32x3\n"a\\tb"\n'],
  ['a raw tab', 'fn f -> u32x3\n"a\tb"\n'],
  ['a quote escape', 'fn f -> u32x3\n"a\\"b"\n'],
  ['a backslash escape', 'fn f -> u32x3\n"a\\\\b"\n'],
  ['an escape that does not exist', 'fn f -> u32x3\n"a\\qb"\n'],
  ['an escape at the end', 'fn f -> u32x3\n"ab\\"\n'],
  ['an empty literal', 'fn f -> u32x3\n""\n'],
  ['a literal not closed', 'fn f -> u32x3\n"abc\n'],
  ['two literals', 'fn f -> u32x3\n"abc" "def"\n'],
  ['text and nothing', 'fn f -> u32x3\ntext\n'],
  ['text and a number', 'fn f -> u32x3\ntext 5\n'],
  ['text and two literals', 'fn f -> u32x3\ntext "abc" "def"\n'],
  ['the marks of the lexer inside a literal', 'fn f -> u32x8\n"# (;{}[]"\n'],
  ['a comment after a literal', 'fn f -> u32x3\n"abc" # "def"\n'],
  ['a literal in an array', 'fn f -> u32x2x3\n["abc" "def"]\n'],
  ['a literal of two lengths in an array', 'fn f -> u32x2\n["abc" "de"]\n'],
  ['a literal as an argument', 'fn g u32x3 -> u32\nget A 0\n\nfn f -> u32\ng "xyz"\n'],
  ['a literal of other bytes', 'fn f -> u32x6\n"é€"\n'],
  ['a literal as the result, not written', 'fn f\n"abc"\n', true],
  ['a literal read through get, not written', 'fn f\nget "abc" 1\n'],
  ['a word before a literal', 'fn f -> u32x2\na"b"\n'],
  ['a word after a literal', 'fn f -> u32x2\n"b"a\n'],
  ['a literal after an operation', 'fn f u32 -> u32\nadd A"b"\n'],
  ['a literal in the header line', 'fn f -> u32x3 "abc"\n'],
  ['a literal as a function name', 'fn "f" A\n'],
  ['a literal in a type list', 'fn f "u32" -> u32\nA\n'],
  ['a literal in an inline body', 'fn f fold {a "abc"; get a 1} 3 0\n'],
  ['a use line', 'use "x.a0"\nfn f A\n'],
  ['a use line with a backslash', 'use "x\\\\y.a0"\nfn f A\n'],
  ['a use line with nothing', 'use ""\nfn f A\n'],
  ['a use line with two paths', 'use "x.a0" "y.a0"\nfn f A\n'],
  ['a use line with a comment', 'use "x.a0" # c\nfn f A\n'],
  ['a use line with two spaces', 'use  "x.a0"\nfn f A\n'],
  ['a use line with no space', 'use"x.a0"\nfn f A\n'],
  ['a use line after a function', 'fn g A\n\nuse "x.a0"\nfn f g 1\n'],
  ['a use line with an escape', 'use "x\\"y.a0"\nfn f A\n'],
  ['a long literal', `fn f -> u32x3000\n"${'abc'.repeat(1000)}"\n`],
];

test('the B3.4 reader: text literals and use lines read as the reference reads them', (t) => {
  const read = loadReader();
  let equal = 0;
  let rejected = 0;
  let refused = 0;
  for (const [label, text, refuse] of TEXT_CURATED) {
    const want = reference(text);
    const got = read(text);
    if (want === null) {
      assert.equal(got.err, true, `${label}: the reader flags what the reference rejects\n${text}`);
      rejected += 1;
    } else if (refuse === true) {
      assert.equal(
        got.err,
        true,
        `${label}: a form outside the reader sets the error flag\n${text}`,
      );
      refused += 1;
    } else {
      assert.equal(got.err, false, `${label}: the error flag is clear\n${text}`);
      assert.equal(got.text, want, `${label}: canonical text\n${text}`);
      equal += 1;
    }
  }
  t.diagnostic(`${equal} read to the reference text, ${rejected} rejected, ${refused} refused`);
  assert.ok(equal > 20 && rejected > 12, 'both kinds are covered');
});
