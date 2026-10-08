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

/** Stage B1: the Stage A forms plus calls of functions defined earlier in the same program. */
function isStageB1(p: Program): boolean {
  if (p.profile !== undefined) return false;
  const defined = new Set<string>();
  for (const f of p.functions) {
    const ok =
      f.spec === undefined &&
      f.params.every(stageType) &&
      stageType(f.result) &&
      f.nodes.every(
        (n) =>
          STAGE_A_OPS.has(n.op) ||
          (n.op === 'call' && defined.has(n.callee as string) && n.callee !== f.name),
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
  return !/[#$;{}[\]="]|\btext\b/.test(body);
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
    const result = run(fn, [pages, bytes.length]) as [[Value[], number], boolean];
    const [[out, pos], err] = result;
    const outBytes: number[] = [];
    for (let i = 0; i < pos; i += 1) {
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

test('the Stage A and B1 reader: accepted programs in the Stage A forms plus calls read to their canonical text', (t) => {
  const read = loadReader();
  const members: string[] = [];
  let checked = 0;
  let withCalls = 0;
  let stageA = 0;
  let tooBig = 0;
  for (const abs of listSources(ROOT)) {
    if (isReject(abs, ROOT)) continue;
    const program = parse(readFileSync(abs, 'utf8'));
    if (!isStageB1(program)) continue;
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
    else withCalls += 1;
  }
  t.diagnostic(
    `${checked} accepted programs read (${stageA} in the Stage A forms, ${withCalls} with calls); ${tooBig} over ${PAGES * PAGE} bytes`,
  );
  assert.ok(withCalls > 0, 'some accepted programs use calls');
  assert.equal(tooBig, 0, 'no program of the Stage A forms plus calls is over the input capacity');
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
