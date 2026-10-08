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
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import {
  A0Error,
  formatProgram,
  type Program,
  parse,
  parseAndValidate,
  run,
  type Type,
  type TypedFunc,
  type Value,
} from '../src/core.js';
import { formatDense, parseDense } from '../src/dense.js';
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
function stageType(t: Type): boolean {
  if (t === 'u32' || t === 'bool') return true;
  return typeof t !== 'string' && t.kind === 'rec' && t.fields.every(stageType);
}

/** Whether a canonical program is in the Stage A forms (the dense text is checked separately). */
function isStageA(p: Program): boolean {
  if (p.profile !== undefined) return false;
  return p.functions.every(
    (f) =>
      f.spec === undefined &&
      f.params.every(stageType) &&
      stageType(f.result) &&
      f.nodes.every((n) => STAGE_A_OPS.has(n.op)),
  );
}

/** A type with no record in it (the type of an inline body's state and extra operands). */
function scalarType(t: Type): boolean {
  return t === 'u32' || t === 'bool';
}

/**
 * Stage B2: the Stage A forms plus calls, folds and loops of functions defined earlier in the same
 * program. A program with a fold or loop has scalar types only (a record state is outside the
 * reader: the lifted body's signature would have to write it).
 */
function isStageB2(p: Program): boolean {
  if (p.profile !== undefined) return false;
  const defined = new Set<string>();
  const folds = p.functions.some((f) => f.nodes.some((n) => n.op === 'fold' || n.op === 'loop'));
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
          (n.op === 'call' && earlier(n.callee)) ||
          (n.op === 'fold' && earlier(n.callee)) ||
          (n.op === 'loop' && earlier(n.callee) && earlier(n.pred)),
      );
    if (!ok) return false;
    defined.add(f.name);
  }
  return true;
}

/** The dense text of a Stage A program has none of the spellings outside the Stage A forms. */
function stageDenseText(dense: string): boolean {
  const body = dense
    .split('\n')
    .filter((l) => !l.startsWith('use '))
    .join('\n');
  return !/[#$[\]="]|\btext\b/.test(body);
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

test('the Stage A, B1 and B2 reader: accepted programs in the Stage A forms plus calls, folds and loops read to their canonical text', (t) => {
  const read = loadReader();
  const members: string[] = [];
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
    if (!isStageB2(program)) continue;
    const dense = formatDense(program);
    if (!stageDenseText(dense)) continue;
    if (Buffer.byteLength(dense, 'utf8') > PAGES * PAGE) {
      tooBig += 1;
      continue;
    }
    const name = relative(ROOT, abs).split(sep).join('/');
    members.push(name);
    const got = read(dense);
    assert.equal(got.err, false, `${name}: the error flag is clear`);
    assert.equal(got.text, formatProgram(program), `${name}: canonical text`);
    checked += 1;
    if (isStageA(program)) stageA += 1;
    else if (program.functions.some((f) => f.nodes.some((n) => n.op === 'fold' || n.op === 'loop')))
      withFolds += 1;
    else withCalls += 1;
  }
  t.diagnostic(
    `${checked} of ${sources} accepted programs read (${stageA} in the Stage A forms, ${withCalls} with calls, ${withFolds} with folds or loops); ${tooBig} over ${PAGES * PAGE} bytes`,
  );
  assert.ok(withCalls > 0, 'some accepted programs use calls');
  assert.ok(withFolds > 0, 'some accepted programs use fold or loop');
  assert.equal(
    tooBig,
    0,
    'no program of the Stage A forms plus calls, folds and loops is over the input capacity',
  );
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
  ['an array type', 'fn f u32x4 -> u32 A\n', true],
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
