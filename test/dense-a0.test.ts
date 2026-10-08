/**
 * The Stage A dense reader, written in A0 (compiler/dense.a0, entry `canonfn`): the node check.
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
 * A call is not a Stage A form: the reader must flag it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import {
  formatProgram,
  type Program,
  parse,
  parseAndValidate,
  run,
  type Type,
  type TypedFunc,
  type Value,
} from '../src/core.js';
import { formatDense } from '../src/dense.js';
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
  const fn = (fname: string): string => {
    const np = rnd(4);
    const params = Array.from({ length: np }, () =>
      pick(['u32', 'u32', 'bool', '(u32,bool)', 'u32']),
    );
    const result = pick(['u32', 'u32', 'bool', '(u32,bool)']);
    const lines: string[] = [];
    const ids: string[] = [];
    const taken = new Set([fname]);
    let dk = 0;
    const nodes = 1 + rnd(8);
    let pending: string | null = null;
    const operand = (): string => {
      if (pending !== null && rnd(8) !== 0) {
        const p = pending;
        pending = null;
        return p;
      }
      const r = rnd(10);
      if (r < 6 && np > 0) return `p${rnd(np)}`;
      if (r < 7) return pick(['true', 'false']);
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
      if (kind < 5) rhs = `${pick(binary.concat(compare))} ${operand()} ${operand()}`;
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
  return { rnd, program };
}

test('the Stage A reader: accepted programs in the Stage A forms read to their canonical text', (t) => {
  const read = loadReader();
  const members: string[] = [];
  let checked = 0;
  for (const abs of listSources(ROOT)) {
    if (isReject(abs, ROOT)) continue;
    const program = parse(readFileSync(abs, 'utf8'));
    if (!isStageA(program)) continue;
    const dense = formatDense(program);
    if (!stageDenseText(dense)) continue;
    members.push(relative(ROOT, abs).split(sep).join('/'));
    const got = read(dense);
    assert.equal(got.err, false, `${members[members.length - 1]}: the error flag is clear`);
    assert.equal(
      got.text,
      formatProgram(program),
      `${members[members.length - 1]}: canonical text`,
    );
    checked += 1;
  }
  t.diagnostic(`${checked} accepted programs are in the Stage A forms`);
  assert.ok(checked > 0, 'some accepted programs are in the Stage A forms');
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

test('the Stage A reader flags a call, which is outside the Stage A forms', () => {
  const read = loadReader();
  const program = parse(
    'fn g u32 -> u32\na add p0 1\nret a\nend\n\nfn f u32 -> u32\nb call g p0\nret b\nend\n',
  );
  assert.equal(read(formatDense(program)).err, true);
});
