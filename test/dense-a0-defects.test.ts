/**
 * Defect probes for the Stage A dense reader in A0 (compiler/dense.a0, entry `canonfn`).
 *
 * Each probe is a dense text. The expectation comes from the TypeScript reference (src/dense.ts
 * parseDense, then formatProgram), and each probe is one of two kinds:
 *   match    the reference accepts the text, and the A0 reader must return the same canonical
 *            text with its error flag clear (an in-scope Stage A form at a boundary of a capacity).
 *   refuse   the A0 reader must set its error flag: the text is rejected by the reference, or it is
 *            a valid text outside the Stage A forms or over a capacity (a correct refusal).
 * A probe that the reference answers differently from its kind fails the test, so the kinds are
 * checked against the reference and not taken on trust. Silent wrong output is a failure of either
 * kind: a refused text must not read clean, and a matched text must read to the reference text.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatProgram, parseAndValidate, run, type TypedFunc, type Value } from '../src/core.js';
import { parseDense } from '../src/dense.js';
import { ROOT } from '../tools/dense-loader.js';

/** The reader's input and output capacity: 128 pages of 128 bytes (compiler/dense.a0). */
const PAGES = 128;
const PAGE = 128;

/** The reader over the A0 source: the dense text in, the canonical text and the error flag out. */
function loadReader(): (text: string) => { text: string; err: boolean } {
  const source = readFileSync(join(ROOT, 'compiler', 'dense.a0'), 'utf8');
  const fn = parseAndValidate(source).functions.find((f: TypedFunc) => f.name === 'canonfn');
  assert.ok(fn, 'compiler/dense.a0 defines canonfn');
  return (text) => {
    // The reader takes the length as an input too: a text over the page capacity is passed with
    // its true length and only the first pages, so the reader's own capacity check sees it.
    const bytes = Buffer.from(text, 'utf8');
    const pages: Value[] = [];
    for (let p = 0; p < PAGES; p += 1) {
      const page: Value[] = [];
      for (let k = 0; k < PAGE; k += 1) page.push(bytes[p * PAGE + k] ?? 0);
      pages.push(page);
    }
    // The probes read up to about 20000 nodes of work: a larger budget than the default run.
    const options = { fuel: 2_000_000_000 };
    const [[out, pos], err] = run(fn, [pages, bytes.length], options) as [
      [Value[], number],
      boolean,
    ];
    // An output past the page capacity is flagged by the reader; its text is the pages it has.
    const outBytes: number[] = [];
    for (let i = 0; i < Math.min(pos, PAGES * PAGE); i += 1) {
      const page = out[i >> 7] as Value[];
      outBytes.push(page[i & 127] as number);
    }
    return { text: Buffer.from(outBytes).toString('utf8'), err };
  };
}

/** The reference answer: the canonical text, or the reason it rejects the text. */
function reference(text: string): { accept: true; text: string } | { accept: false; msg: string } {
  try {
    return { accept: true, text: formatProgram(parseDense(text)) };
  } catch (e) {
    return { accept: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

/** The number of tokens the lexer of compiler/dense.a0 counts: words and the punctuation marks. */
function countTokens(text: string): number {
  return (text.match(/[(),[\]]|[^\s(),[\]"]+/g) ?? []).length;
}

/** Names the probes skip: the probe function's name `f`, keywords and type words that cannot be ids. */
const SKIP = new Set([
  'f',
  'fn',
  'ret',
  'end',
  'use',
  'patch',
  'true',
  'false',
  'text',
  'call',
  'fold',
  'loop',
  'arr',
  'get',
  'set',
  'at',
  'put',
  'read',
  'write',
  'puts',
  'rec',
  'select',
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
  'div',
  'rem',
  'io',
  'bool',
  'mod',
  'retval',
  'pre',
  'post',
  'cadd',
  'csub',
  'cmul',
  'cdiv',
  'crem',
  'cget',
  'udiv',
  'urem',
]);

/** The k-th letter-only name a, b, ..., z, aa, ..., skipping the words above. */
function letterName(k: number): string {
  let n = k + 1;
  let s = '';
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/** The first `count` names of the default sequence that are not skipped words. */
function candidates(count: number): string[] {
  const out: string[] = [];
  for (let k = 0; out.length < count; k += 1) {
    const s = letterName(k);
    if (!SKIP.has(s)) out.push(s);
  }
  return out;
}

/** A function with `stmts` default-named nodes: each statement adds one default and one explicit node. */
function defaults(stmts: number): string {
  const lines = ['fn f -> u32'];
  for (let k = 0; k < stmts; k += 1) lines.push(`q${k} add mul A ${k % 9} B`);
  lines.push('ret add mul A 1 B', 'end');
  return `${lines.join('\n')}\n`;
}

/** A nesting of `depth` binary operations before the leaf, read as a result (frames = depth). */
function chain(depth: number, op = 'add'): string {
  return `fn f -> u32\nret ${`${op} `.repeat(depth)}A${' 1'.repeat(depth)}\nend\n`;
}

/**
 * A function of exactly `target` tokens: `fn f -> u32` (4 tokens), statements `NAME mov A` (3 tokens)
 * or one `NAME add A 1` (4) when the count needs it, `ret NAME` (2), `end` (1). The names are the
 * shortest first, so the printed output stays under the 16384-byte output capacity.
 */
function tokenFiller(target: number): string {
  const names = candidates(1400);
  let left = target - 7;
  const lines = ['fn f -> u32'];
  let k = 0;
  if (left % 3 === 1) {
    lines.push(`${names[k] as string} add A 1`);
    left -= 4;
    k += 1;
  }
  while (left >= 3) {
    lines.push(`${names[k] as string} mov A`);
    left -= 3;
    k += 1;
  }
  lines.push(`ret ${names[k - 1] as string}`, 'end');
  return `${lines.join('\n')}\n`;
}

/** `count` explicit nodes, each `NAME mov A`, with the last one as the result (no default names). */
function explicitNames(count: number): string {
  const names = candidates(count);
  const lines = ['fn f -> u32'];
  for (const n of names) lines.push(`${n} mov A`);
  lines.push(`ret ${names[names.length - 1] as string}`, 'end');
  return `${lines.join('\n')}\n`;
}

/** Long source bytes: a function with `count` statements whose output is over the reader capacity. */
function longOutput(): string {
  for (let stmts = 100; stmts < 1000; stmts += 10) {
    const text = defaults(stmts);
    const out = reference(text);
    if (out.accept && out.text.length > 16384 && Buffer.byteLength(text) <= 16384) return text;
  }
  throw new Error('no output-capacity probe');
}

/** The lines (split on newline) of a program with the given number of lines. */
function withLines(lines: number): string {
  const head = ['fn f -> u32', 'ret A', 'end'];
  const out = [...head];
  while (out.length < lines) out.push('');
  return out.join('\n');
}

/** Functions named g0, g1, ... each `fn gK -> u32 / ret A / end`. */
function functions(count: number): string {
  const out: string[] = [];
  for (let k = 0; k < count; k += 1) out.push(`fn g${k} -> u32\nret A\nend`);
  return `${out.join('\n')}\n`;
}

/** Functions with 64 `u32` parameters each, then one with a single parameter (`extra` total 2049). */
function params(total: number): string {
  const out: string[] = [];
  let left = total;
  let k = 0;
  while (left > 0) {
    const n = Math.min(64, left);
    out.push(`fn p${k} ${Array(n).fill('u32').join(' ')} -> u32\nret A\nend`);
    left -= n;
    k += 1;
  }
  return `${out.join('\n')}\n`;
}

/** A text of `bytes` bytes: a function, then a comment that fills the rest. */
function bytesText(bytes: number): string {
  const head = 'fn f -> u32\nret A\nend\n#';
  return `${head}${'x'.repeat(bytes - head.length)}`;
}

interface Probe {
  readonly name: string;
  readonly defect: string;
  readonly kind: 'match' | 'refuse';
  readonly text: string;
}

/** The reader, loaded once when the first probe runs. */
let reader: ((text: string) => { text: string; err: boolean }) | undefined;

/** The probe set. A `match` probe must be accepted by the reference and read to its text. */
const PROBES: readonly Probe[] = [
  // 1. Node-name tables (the default names and the id tables are 256 entries).
  { name: 'defaults 254 (255 default names)', defect: '1', kind: 'match', text: defaults(254) },
  { name: 'defaults 255 (256 default names)', defect: '1', kind: 'match', text: defaults(255) },
  { name: 'defaults 256 (257 default names)', defect: '1', kind: 'match', text: defaults(256) },
  { name: 'defaults 299 (300 default names)', defect: '1', kind: 'match', text: defaults(299) },
  {
    name: '200 explicit candidate names and 100 default names',
    defect: '1',
    kind: 'match',
    text: (() => {
      const cand = candidates(200);
      const lines = ['fn f -> u32'];
      for (const n of cand) lines.push(`${n} mov A`);
      for (let k = 0; k < 99; k += 1) lines.push(`q${k} add mul A ${k % 9} B`);
      lines.push('ret add mul A 1 B', 'end');
      return `${lines.join('\n')}\n`;
    })(),
  },
  { name: '257 explicit names', defect: '1', kind: 'match', text: explicitNames(257) },
  { name: '1000 explicit names', defect: '1', kind: 'match', text: explicitNames(1000) },
  // 2. Identifiers and words: the reference rule ^[a-z][a-z0-9_]{0,63}$ and the numbers.
  {
    name: 'a+b names a value',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\na+b add A 1\nret a+b\nend\n',
  },
  {
    name: 'Ab is not an identifier',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\nAb add A 1\nret Ab\nend\n',
  },
  {
    name: 'a-b is not an identifier',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\na-b add A 1\nret a-b\nend\n',
  },
  {
    name: 'a.b is not an identifier',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\na.b add A 1\nret a.b\nend\n',
  },
  {
    name: '_a is not an identifier',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\n_a add A 1\nret _a\nend\n',
  },
  {
    name: '1a is not an identifier',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\n1a add A 1\nret 1a\nend\n',
  },
  {
    name: 'a64 (64 characters) is a name',
    defect: '2',
    kind: 'match',
    text: `fn f -> u32\n${'a'.repeat(64)} add A 1\nret ${'a'.repeat(64)}\nend\n`,
  },
  {
    name: 'a65 (65 characters) is not a name',
    defect: '2',
    kind: 'refuse',
    text: `fn f -> u32\n${'a'.repeat(65)} add A 1\nret ${'a'.repeat(65)}\nend\n`,
  },
  {
    name: 'a0a leading zero',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\nret add A 007\nend\n',
  },
  {
    name: 'u32 maximum literal',
    defect: '2',
    kind: 'match',
    text: 'fn f -> u32\nret add A 4294967295\nend\n',
  },
  {
    name: 'u32 maximum plus one',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\nret add A 4294967296\nend\n',
  },
  {
    name: 'hex literal is not Stage A',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\nret add A 0x5\nend\n',
  },
  {
    name: '$ab is a name (read from Stage B3.2 on)',
    defect: '2',
    kind: 'match',
    text: 'fn f -> u32\n$ab add A 1\nret ab\nend\n',
  },
  {
    name: 'a statement with = is read from Stage B3.2 on',
    defect: '2',
    kind: 'match',
    text: 'fn f -> u32\nx = add A 1\nret x\nend\n',
  },
  {
    name: 'patch is a reserved word',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\npatch add A 1\nret patch\nend\n',
  },
  {
    name: 'bool is a type word, not a name',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\nbool add A 1\nret bool\nend\n',
  },
  {
    name: 'io is a type word, not a name',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\nio add A 1\nret io\nend\n',
  },
  {
    name: 'a text literal is read from Stage B3.4 on',
    defect: '2',
    kind: 'match',
    text: 'fn f -> u32\nret "x"\nend\n',
  },
  {
    name: 'a backslash in a name',
    defect: '2',
    kind: 'refuse',
    text: 'fn f -> u32\na\\b add A 1\nret a\nend\n',
  },
  {
    name: 'a comment after a statement is ignored',
    defect: '2',
    kind: 'match',
    text: 'fn f -> u32\nret add A 1 # note\nend\n',
  },
  {
    name: 'CRLF line ends are ignored',
    defect: '2',
    kind: 'match',
    text: 'fn f -> u32\r\nret add A 1\r\nend\r\n',
  },
  // 3. use lines: the form is use "path", before the first function.
  {
    name: 'use "path" is accepted',
    defect: '3',
    kind: 'match',
    text: 'use "lex.a0"\nfn f -> u32\nret A\nend\n',
  },
  {
    name: 'use with a space in the path',
    defect: '3',
    kind: 'match',
    text: 'use "a b.a0"\nfn f -> u32\nret A\nend\n',
  },
  {
    name: 'two use lines',
    defect: '3',
    kind: 'match',
    text: 'use "a.a0"\nuse "b/c.a0"\nfn f -> u32\nret A\nend\n',
  },
  {
    name: 'use with a tab before the path',
    defect: '3',
    kind: 'match',
    text: 'use\t"a.a0"\nfn f -> u32\nret A\nend\n',
  },
  {
    name: 'use without quotes',
    defect: '3',
    kind: 'refuse',
    text: 'use lex.a0\nfn f -> u32\nret A\nend\n',
  },
  {
    name: 'use with an empty path',
    defect: '3',
    kind: 'refuse',
    text: 'use ""\nfn f -> u32\nret A\nend\n',
  },
  {
    name: 'use with a backslash in the path',
    defect: '3',
    kind: 'refuse',
    text: 'use "a\\b.a0"\nfn f -> u32\nret A\nend\n',
  },
  {
    name: 'use with text after the path',
    defect: '3',
    kind: 'refuse',
    text: 'use "a.a0" x\nfn f -> u32\nret A\nend\n',
  },
  {
    name: 'use after a function',
    defect: '3',
    kind: 'refuse',
    text: 'fn f -> u32\nret A\nend\nuse "x.a0"\n',
  },
  {
    name: 'use with no space before the quote',
    defect: '3',
    kind: 'refuse',
    text: 'use"a.a0"\nfn f -> u32\nret A\nend\n',
  },
  { name: 'use alone', defect: '3', kind: 'refuse', text: 'use\nfn f -> u32\nret A\nend\n' },
  {
    name: 'use with an unclosed path',
    defect: '3',
    kind: 'refuse',
    text: 'use "a.a0\nfn f -> u32\nret A\nend\n',
  },
  // 4. Frame depth: 8 nested frames are the most the reader holds.
  { name: 'nesting 8 (the most frames)', defect: '4', kind: 'match', text: chain(8) },
  { name: 'nesting 9', defect: '4', kind: 'refuse', text: chain(9) },
  { name: 'nesting 12', defect: '4', kind: 'refuse', text: chain(12) },
  {
    name: 'nesting 9 through mov',
    defect: '4',
    kind: 'refuse',
    text: `fn f -> u32\nret ${'mov '.repeat(9)}A\nend\n`,
  },
  {
    name: 'nesting 9 in a parenthesized group',
    defect: '4',
    kind: 'refuse',
    text: `fn f -> u32\nret ${'('.repeat(9)}A 1${')'.repeat(9)}\nend\n`,
  },
  {
    name: 'nesting 8 on the header line',
    defect: '4',
    kind: 'match',
    text: `fn f -> u32 ${'add '.repeat(8)}A${' 1'.repeat(8)}\nend\n`,
  },
  {
    name: 'nesting 9 on the header line',
    defect: '4',
    kind: 'refuse',
    text: `fn f -> u32 ${'add '.repeat(9)}A${' 1'.repeat(9)}\nend\n`,
  },
  // 5. Capacities: tokens 4096, lines 2048, functions 512, parameters 2048, input 16384, output 16384.
  { name: '4096 tokens', defect: '5', kind: 'match', text: tokenFiller(4096) },
  { name: '4097 tokens', defect: '5', kind: 'refuse', text: tokenFiller(4097) },
  { name: '2048 lines', defect: '5', kind: 'match', text: withLines(2048) },
  { name: '2049 lines', defect: '5', kind: 'refuse', text: withLines(2049) },
  { name: '512 functions', defect: '5', kind: 'match', text: functions(512) },
  { name: '513 functions', defect: '5', kind: 'refuse', text: functions(513) },
  { name: '2048 parameters', defect: '5', kind: 'match', text: params(2048) },
  { name: '2049 parameters', defect: '5', kind: 'refuse', text: params(2049) },
  { name: 'input of 16384 bytes', defect: '5', kind: 'match', text: bytesText(16384) },
  { name: 'input of 16385 bytes', defect: '5', kind: 'refuse', text: bytesText(16385) },
  { name: 'output over 16384 bytes', defect: '5', kind: 'refuse', text: longOutput() },
];

for (const p of PROBES) {
  test(`dense defect ${p.defect}: ${p.name}`, () => {
    const ref = reference(p.text);
    if (p.kind === 'match')
      assert.ok(ref.accept, `the reference accepts: ${!ref.accept ? ref.msg : ''}`);
    if (p.name.startsWith('4096') || p.name.startsWith('4097')) {
      const want = p.name.startsWith('4096') ? 4096 : 4097;
      assert.equal(countTokens(p.text), want, 'the probe has the token count it names');
    }
    if (p.name === 'output over 16384 bytes') {
      assert.ok(ref.accept && ref.text.length > 16384, 'the reference output is over 16384 bytes');
      assert.ok(Buffer.byteLength(p.text) <= 16384, 'the input is within the reader capacity');
    }
    reader ??= loadReader();
    const got = reader(p.text);
    const refText = ref.accept ? ref.text : `(rejected: ${ref.msg})`;
    if (p.kind === 'match') {
      assert.equal(got.err, false, `the error flag is clear; reference: ${refText}`);
      assert.equal(got.text, ref.accept ? ref.text : '', 'the canonical text equals the reference');
    } else {
      assert.equal(got.err, true, `the error flag is set; reference: ${refText}`);
    }
  });
}
