import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type Arm64Module, assembleArm64Text } from '../src/arm64enc.js';
import { compile } from '../src/backends.js';
import { formatProgram, makeIo, parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { link } from '../src/link.js';
import { runtime } from '../tools/arm64-runtime.js';
import { closure, generateCorpus, ioFreeSubset } from '../tools/corpus.js';

// compiler/asm_arm64.a0, the AArch64 encoder written in A0, against its reference
// src/arm64enc.ts: the same words, labels, relocations and bss symbols for every arm64 text
// the repository produces for the corpus and the examples, and the same error line where the
// reference refuses a text. The per-word line numbers of the reference are not compared (the
// A0 encoder does not write them; see the head of the file).

/** Mnemonics of the reference the A0 encoder does not accept yet, with the reason. None today. */
const SKIPS: Readonly<Record<string, string>> = {};

/** Every mnemonic of the reference (src/arm64enc.ts `encode`), `b.<cond>` aside. */
const MNEMONICS = (
  'ldr str ldrb strb ldp stp movz movk movn mov add sub adds subs cmp cmn neg negs and orr ' +
  'eor ands tst lsl lsr asr ror mul madd msub umaddl smaddl udiv sdiv csel csinc csinv csneg ' +
  'cset csetm b bl cbz cbnz adrp ret br blr movi nop'
).split(' ');

type A0Result =
  | { readonly ok: true; readonly module: Omit<Arm64Module, 'lines'> }
  | { readonly ok: false; readonly code: number; readonly line: number };

const KINDS = ['branch26', 'page21', 'pageoff12'] as const;

/** Decode the output words of `asmio` (see compiler/asm_arm64.a0). */
function decode(code: number, o: readonly number[]): A0Result {
  let i = 0;
  const next = (): number => o[i++] as number;
  const name = (): string => {
    const n = next();
    const s = Buffer.from(o.slice(i, i + n)).toString('latin1');
    i += n;
    return s;
  };
  if (next() !== 0) return { ok: false, code, line: o[1] as number };
  assert.equal(code, 0);
  const k = next();
  const words = o.slice(i, i + k);
  i += k;
  const labels = new Map<string, number>();
  for (let n = next(); n > 0; n--) {
    const offset = next();
    labels.set(name(), offset);
  }
  const relocations = [];
  for (let n = next(); n > 0; n--) {
    const offset = next();
    const kind = KINDS[next()] as (typeof KINDS)[number];
    relocations.push({ offset, kind, symbol: name() });
  }
  const bss = [];
  for (let n = next(); n > 0; n--) {
    const offset = next();
    const size = next();
    bss.push({ name: name(), offset, size });
  }
  const bssSize = next();
  const bssAlign = next();
  assert.equal(i, o.length, 'trailing output words');
  return { ok: true, module: { words, labels, bss, bssSize, bssAlign, relocations } };
}

const input = (text: string): number[] => {
  const bytes = Buffer.from(text, 'utf8');
  return [bytes.length, ...bytes];
};

type Asm = (text: string) => A0Result;

let cached: Promise<{ asm: Asm; entry: TypedFunc }> | undefined;
/** The A0 encoder through the JavaScript backend (the reference interpreter is checked against it once). */
function encoder(): Promise<{ asm: Asm; entry: TypedFunc }> {
  cached ??= (async () => {
    const program = (await link('compiler/asm_arm64.a0', (p) => readFile(p, 'utf8'))).program;
    const js = compile(program, 'js').text;
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )) as {
      asmio: (io: { input: number[]; position: number; output: number[] }) => number;
    };
    const asm: Asm = (text) => {
      const io = { input: input(text), position: 0, output: [] as number[] };
      const code = mod.asmio(io);
      return decode(code, io.output);
    };
    return { asm, entry: program.byName.get('asmio') as TypedFunc };
  })();
  return cached;
}

/** The reference's result in the same shape (an error: its line). */
function reference(text: string): A0Result {
  try {
    const { lines: _lines, ...module } = assembleArm64Text(text);
    return { ok: true, module };
  } catch (e) {
    const m = /^arm64 encoder: line (\d+):/.exec((e as Error).message);
    assert.ok(m !== null, (e as Error).message);
    return { ok: false, code: 1, line: Number(m[1]) };
  }
}

/** Assert the A0 encoder agrees with the reference on `text`; true when both accept it. */
function agree(asm: Asm, label: string, text: string): boolean {
  const want = reference(text);
  const got = asm(text);
  if (!want.ok) {
    assert.ok(!got.ok, `${label}: the reference refuses line ${want.line}, the A0 encoder accepts`);
    assert.deepEqual([got.code, got.line], [1, want.line], `${label}: error line`);
    return false;
  }
  assert.ok(
    got.ok,
    `${label}: the A0 encoder refuses line ${got.ok ? 0 : got.line} (code ${got.ok ? 0 : got.code}): ${got.ok ? '' : text.split('\n')[got.line - 1]}`,
  );
  const lines = text.split('\n');
  const bad = want.module.words.findIndex((w, i) => got.module.words[i] !== w);
  if (bad >= 0) {
    const line = (assembleArm64Text(text).lines[bad] ?? 0) - 1;
    assert.fail(
      `${label}: word ${bad} (${lines[line]?.trim()}): want ${want.module.words[bad]?.toString(16)}, got ${got.module.words[bad]?.toString(16)}`,
    );
  }
  assert.equal(got.module.words.length, want.module.words.length, `${label}: word count`);
  assert.deepEqual([...got.module.labels], [...want.module.labels], `${label}: labels`);
  assert.deepEqual(got.module.relocations, want.module.relocations, `${label}: relocations`);
  assert.deepEqual(got.module.bss, want.module.bss, `${label}: bss`);
  assert.equal(got.module.bssSize, want.module.bssSize, `${label}: bss size`);
  assert.equal(got.module.bssAlign, want.module.bssAlign, `${label}: bss alignment`);
  return true;
}

/** The mnemonics of a text (labels and comments removed; directives left out). */
function mnemonics(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const body = raw
      .replace(/\/\/.*|;.*/, '')
      .replace(/^(\s*[A-Za-z0-9_.$]+:)+/, '')
      .trim();
    const mn = body.split(/\s+/)[0] ?? '';
    if (mn !== '' && !mn.startsWith('.')) out.add(mn.startsWith('b.') ? 'b.<cond>' : mn);
  }
  return out;
}

/**
 * Every arm64 text the repository produces for the corpus and the examples: the TypeScript
 * emitter (src/arm64.ts, optimized and not) on what it accepts (the scalar corpus, the io-free
 * subsets of the corpus and of examples/life.a0, examples/kernels.a0), the runtime of the arm64
 * stages, and the self-hosted emitter (compiler/boot.a0 `emitachunkio`, the dialect the
 * encoder is written for) on the whole corpus and both examples.
 */
async function repositoryTexts(): Promise<[string, string][]> {
  const kernels = await readFile('examples/kernels.a0', 'utf8');
  const life = await readFile('examples/life.a0', 'utf8');
  const scalar = generateCorpus(undefined, undefined, { scalar: true });
  const corpus = generateCorpus();
  const texts: [string, string][] = [['runtime of the arm64 stages', runtime()]];
  const ts: [string, ReturnType<typeof parseAndValidate>][] = [
    ['scalar corpus', scalar],
    ['corpus, io-free subset', ioFreeSubset(corpus)],
    ['examples/kernels.a0', parseAndValidate(kernels)],
    ['examples/life.a0, io-free subset', ioFreeSubset(parseAndValidate(life))],
  ];
  for (const [name, p] of ts)
    for (const optimize of [true, false])
      texts.push([
        `${name} (src/arm64.ts${optimize ? '' : ', unoptimized'})`,
        compile(p, 'arm64', { optimize }).text,
      ]);
  const linked = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
  const self = compile(parseAndValidate(closure(linked.functions, 'emitachunkio')), 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(self).toString('base64')}`
  )) as {
    emitachunkio: (io: { input: number[]; position: number; output: number[] }) => number;
  };
  const sources: [string, string][] = [
    ['examples/kernels.a0', kernels],
    ['examples/life.a0', life],
    ['scalar corpus', formatProgram(scalar)],
    ['corpus', formatProgram(corpus)],
  ];
  for (const [name, source] of sources) {
    // one chunk: the source, head 1, strict 0, from 0 (compiler/boot.a0)
    const io = { input: [...input(source), 1, 0, 0], position: 0, output: [] as number[] };
    assert.equal(mod.emitachunkio(io), 0, name);
    const k = io.output[io.output.length - 1] as number;
    const text = Buffer.from(io.output.slice(0, io.output.length - 1 - k)).toString('latin1');
    texts.push([`${name} (compiler/emit_arm64.a0)`, text]);
  }
  return texts;
}

/**
 * Texts of the repository the reference itself refuses, with the line: the A0 encoder must
 * refuse the same line (the unoptimized TypeScript emitter writes an extended-register add with
 * a shift amount, `add x16, x16, w10, uxtw #3`, which neither encoder accepts).
 */
const REFERENCE_REFUSES: Readonly<Record<string, number>> = {
  'corpus, io-free subset (src/arm64.ts, unoptimized)': 805,
};

test('asm_arm64.a0: the same words, labels, relocations and bss as src/arm64enc.ts on every text of the corpus and the examples', async () => {
  const { asm } = await encoder();
  const texts = await repositoryTexts();
  const seen = new Set<string>();
  let matched = 0;
  const refused: string[] = [];
  for (const [label, text] of texts) {
    for (const mn of mnemonics(text))
      assert.ok(
        MNEMONICS.includes(mn) || mn === 'b.<cond>' || SKIPS[mn] !== undefined,
        `${label}: ${mn} is neither supported nor in SKIPS`,
      );
    if ([...mnemonics(text)].some((mn) => SKIPS[mn] !== undefined)) continue;
    if (agree(asm, label, text)) {
      matched += 1;
      for (const mn of mnemonics(text)) seen.add(mn);
    } else refused.push(label);
  }
  assert.deepEqual(
    refused,
    Object.keys(REFERENCE_REFUSES),
    'the texts the reference refuses (the A0 encoder refuses the same line)',
  );
  for (const label of refused)
    assert.equal(reference(texts.find(([l]) => l === label)?.[1] ?? '').ok, false, label);
  assert.equal(matched, texts.length - refused.length);
  // the instructions these texts exercise (the forms test covers every mnemonic)
  assert.ok(seen.size >= 30, [...seen].join(' '));
});

/**
 * Every instruction form of the reference, valid and invalid, one text each (a text may define
 * labels around the instruction).
 */
const FORMS: readonly string[] = [
  // loads and stores
  ...['ldr', 'str'].flatMap((mn) =>
    ['x0', 'w1', 'q2', 'xzr', 'wzr', 'sp', 'v0.2d'].flatMap((rt) =>
      [
        '[x1]',
        '[sp]',
        '[x2, #8]',
        '[x2, #12]',
        '[x2, #16]',
        '[x3, #32760]',
        '[x3, #32768]',
        '[x3, #16380]',
        '[x3, #65520]',
        '[x4, #-8]',
        '[x4, #-256]',
        '[x4, #-257]',
        '[x4, #255]',
        '[x4, #3]',
        '[x5, #16]!',
        '[x5, #-16]!',
        '[x5, #256]!',
        '[x6], #16',
        '[x6], #-256',
        '[x6], #300',
        '[x7, x8]',
        '[x7, w8]',
        '[x7, w8, uxtw]',
        '[x7, w8, uxtw #2]',
        '[x7, w8, uxtw #3]',
        '[x7, x8, lsl #3]',
        '[x7, x8, lsl #2]',
        '[x7, x8, lsl #4]',
        '[x7, x8, lsl #0]',
        '[x7, x8, lsl]',
        '[x7, w8, sxtw #0]',
        '[x7, x8, sxtx]',
        '[x7, x8, uxtx #3]',
        '[x7, x8, lsr #3]',
        '[x7, w8, sxtw #-2]',
        '[xzr]',
        '[w1]',
        '[x1, #0x10]',
        '[x1, #-0x10]',
        '[x1, #0xffffffffffffffff]',
        '[x1, sym@PAGEOFF]',
      ].map((m) => `${mn} ${rt}, ${m}`),
    ),
  ),
  ...['ldrb', 'strb'].flatMap((mn) =>
    ['w0', 'wzr', 'x0', 'q0'].flatMap((rt) =>
      [
        '[x1]',
        '[x1, #4095]',
        '[x1, #4096]',
        '[x1, #-1]',
        '[x1, #1]!',
        '[x1], #-1',
        '[x1, x2]',
        '[x1, w2, uxtw]',
        '[x1, w2, uxtw #0]',
        '[x1, w2, uxtw #1]',
        '[x1, x2, lsl #0]',
      ].map((m) => `${mn} ${rt}, ${m}`),
    ),
  ),
  ...['ldp', 'stp'].flatMap((mn) =>
    [
      'x0, x1',
      'w2, w3',
      'q4, q5',
      'xzr, xzr',
      'wzr, wzr',
      'x0, w1',
      'sp, x1',
      'v0.2d, v1.2d',
      'x29, x30',
    ].flatMap((rr) =>
      [
        '[sp]',
        '[sp, #-16]!',
        '[sp], #16',
        '[x1, #8]',
        '[x1, #504]',
        '[x1, #512]',
        '[x1, #-512]',
        '[x1, #-520]',
        '[x1, #4]',
        '[x1, #1008]',
        '[x1, #252]',
        '[x1, #-256]',
        '[xzr]',
        '[x1, #16]',
      ].map((m) => `${mn} ${rr}, ${m}`),
    ),
  ),
  // moves
  ...['movz', 'movk', 'movn'].flatMap((mn) =>
    ['x0', 'w1', 'sp', 'xzr', 'q0'].flatMap((rd) =>
      [
        '#0',
        '#1',
        '#65535',
        '#65536',
        '#-1',
        '#0x1234',
        '#5, lsl #16',
        '#5, lsl #32',
        '#5, lsl #48',
        '#5, lsl #64',
        '#5, lsl #8',
        '#5, lsr #16',
        '#5, lsl #-16',
        '#5, lsl #0',
        'x1',
      ].map((i) => `${mn} ${rd}, ${i}`),
    ),
  ),
  ...['x0', 'w1', 'sp', 'xzr', 'wzr'].flatMap((rd) =>
    [
      '#0',
      '#1',
      '#-1',
      '#65535',
      '#65536',
      '#0x10000',
      '#0xffff0000',
      '#0xffffffff',
      '#0xfffffffe',
      '#0x100000000',
      '#0xffff00000000',
      '#0xffff000000000000',
      '#0xfffeffffffffffff',
      '#-65536',
      '#-65537',
      '#0x00ff00ff00ff00ff',
      '#0x5555555555555555',
      '#0xaaaaaaaaaaaaaaaa',
      '#0x8000000000000001',
      '#0x7ffffffffffffffe',
      '#0x0f0f0f0f',
      '#0x80000001',
      '#0x3ffc',
      '#0x123456',
      '#0x12345678',
      '#18446744073709551615',
      '#-9223372036854775808',
      'x1',
      'w1',
      'sp',
      'xzr',
    ].map((i) => `mov ${rd}, ${i}`),
  ),
  // add and subtract
  ...['add', 'sub', 'adds', 'subs'].flatMap((mn) =>
    [
      'x0, x1',
      'w0, w1',
      'sp, sp',
      'x0, sp',
      'sp, x1',
      'xzr, x1',
      'wzr, w1',
      'x0, w1',
      'x0, xzr',
    ].flatMap((rr) =>
      [
        '#0',
        '#1',
        '#4095',
        '#4096',
        '#-1',
        '#-4095',
        '#-0',
        '#1, lsl #12',
        '#1, lsl #0',
        '#1, lsl #13',
        '#1, lsr #12',
        'x2',
        'w2',
        'x2, lsl #3',
        'x2, lsr #63',
        'x2, asr #64',
        'w2, lsl #31',
        'w2, lsl #32',
        'x2, uxtw #2',
        'sp',
        'sym@PAGEOFF',
        'sym@PAGE',
        'sym',
      ].map((o) => `${mn} ${rr}, ${o}`),
    ),
  ),
  ...['cmp', 'cmn'].flatMap((mn) =>
    ['x0', 'w0', 'sp', 'xzr', 'q0'].flatMap((r) =>
      ['#0', '#7', '#-7', '#4096', '#1, lsl #12', 'x1', 'w1', 'x1, lsl #2', 'w1, asr #3', 'sp'].map(
        (o) => `${mn} ${r}, ${o}`,
      ),
    ),
  ),
  ...['neg', 'negs'].flatMap((mn) =>
    [
      'x0, x1',
      'w0, w1',
      'x0, w1',
      'x0, x1, lsl #3',
      'w0, w1, lsr #5',
      'x0, #1',
      'x0, sp',
      'sp, x1',
      'x0',
    ].map((o) => `${mn} ${o}`),
  ),
  // logical
  ...['and', 'orr', 'eor', 'ands'].flatMap((mn) =>
    ['x0, x1', 'w0, w1', 'sp, x1', 'x0, w1', 'xzr, x1'].flatMap((rr) =>
      [
        '#1',
        '#0',
        '#-1',
        '#0xff',
        '#0xff00',
        '#0x7fffffff',
        '#0xfffffffe',
        '#0x80000000',
        '#0x55555555',
        '#0x33333333',
        '#0x0f0f0f0f0f0f0f0f',
        '#0x00000000ffffffff',
        '#0xffffffff00000000',
        '#0x8000000000000000',
        '#0x0000ffff0000ffff',
        '#0x1',
        '#3',
        '#5',
        '#-2',
        '#-4294967296',
        'x2',
        'w2',
        'x2, lsl #4',
        'x2, ror #4',
        'w2, asr #31',
        'w2, asr #32',
      ].map((o) => `${mn} ${rr}, ${o}`),
    ),
  ),
  ...['x0', 'w0', 'xzr'].flatMap((r) =>
    ['#1', '#0xff00', '#6', 'x1', 'w1', 'x1, lsl #1'].map((o) => `tst ${r}, ${o}`),
  ),
  // shifts
  ...['lsl', 'lsr', 'asr', 'ror'].flatMap((mn) =>
    ['x0, x1', 'w0, w1', 'x0, w1', 'sp, x1'].flatMap((rr) =>
      ['#0', '#1', '#31', '#32', '#63', '#64', '#-1', 'x2', 'w2'].map((o) => `${mn} ${rr}, ${o}`),
    ),
  ),
  // multiply and divide
  ...['mul', 'udiv', 'sdiv'].flatMap((mn) =>
    ['x0, x1, x2', 'w0, w1, w2', 'x0, w1, w2', 'x0, x1, x2, x3', 'sp, x1, x2', 'xzr, x1, x2'].map(
      (o) => `${mn} ${o}`,
    ),
  ),
  ...['madd', 'msub'].flatMap((mn) =>
    ['x0, x1, x2, x3', 'w0, w1, w2, w3', 'x0, x1, x2, w3', 'x0, x1, x2', 'w0, w1, w2, xzr'].map(
      (o) => `${mn} ${o}`,
    ),
  ),
  ...['umaddl', 'smaddl'].flatMap((mn) =>
    ['x0, w1, w2, x3', 'x0, x1, w2, x3', 'w0, w1, w2, x3', 'x0, w1, w2', 'x0, wzr, w2, xzr'].map(
      (o) => `${mn} ${o}`,
    ),
  ),
  // conditional select
  ...['csel', 'csinc', 'csinv', 'csneg'].flatMap((mn) =>
    ['x0, x1, x2', 'w0, w1, w2', 'x0, w1, x2', 'w0, wzr, wzr'].flatMap((rr) =>
      [
        'eq',
        'ne',
        'hs',
        'cs',
        'lo',
        'cc',
        'mi',
        'pl',
        'vs',
        'vc',
        'hi',
        'ls',
        'ge',
        'lt',
        'gt',
        'le',
        'al',
        'nv',
      ].map((c) => `${mn} ${rr}, ${c}`),
    ),
  ),
  ...['cset', 'csetm'].flatMap((mn) =>
    ['x0', 'w1', 'sp'].flatMap((r) =>
      ['eq', 'ne', 'lo', 'hi', 'le', 'al', 'x1'].map((c) => `${mn} ${r}, ${c}`),
    ),
  ),
  // branches
  ...['b', 'bl'].flatMap((mn) => [
    `top:\n\tnop\n\t${mn} top`,
    `\t${mn} fwd\n\tnop\nfwd:\n\tnop`,
    `\t${mn} _extern`,
    `1:\n\t${mn} 1b\n\t${mn} 1f\n1:\tnop\n\t${mn} 1b`,
    `\t${mn} 2b`,
    `\t${mn} 3f`,
    `\t${mn} x0`,
    `\t${mn} x31`,
    `\t${mn} top, top`,
    `\t${mn} sym@PAGE`,
    `\t${mn} #4`,
  ]),
  ...['cbz', 'cbnz'].flatMap((mn) => [
    `top:\n\t${mn} x0, top`,
    `\t${mn} w3, fwd\n\tnop\nfwd: nop`,
    `\t${mn} x0, _extern`,
    `1: ${mn} w1, 1b\n\t${mn} w1, 1f\n1: nop`,
    `\t${mn} sp, 1f\n1: nop`,
    `\t${mn} q0, 1f\n1: nop`,
    `\t${mn} x0`,
  ]),
  ...[
    'eq',
    'ne',
    'hs',
    'cs',
    'lo',
    'cc',
    'mi',
    'pl',
    'vs',
    'vc',
    'hi',
    'ls',
    'ge',
    'lt',
    'gt',
    'le',
    'al',
    'nv',
    'xx',
    '',
  ].flatMap((c) => [`back:\n\tb.${c} back\n\tb.${c} 1f\n1: nop`, `\tb.${c} _extern`]),
  // pages, returns, vectors, nop
  'adrp x0, sym@PAGE\n\tadd x0, x0, sym@PAGEOFF',
  'adrp w0, sym@PAGE',
  'adrp x0, sym@PAGEOFF',
  'adrp x0, sym',
  'adrp x0, sym@PAGE@PAGEOFF',
  'adrp x0, #4',
  'add x1, x2, _a0_in@PAGEOFF\n\tadrp x1, _a0_in@PAGE\n\tb _f\n\tadrp x2, _b@PAGE',
  ...['ret', 'br', 'blr'].flatMap((mn) =>
    ['', ' x1', ' x30', ' w1', ' sp', ' xzr', ' x1, x2'].map((o) => `${mn}${o}`),
  ),
  ...[
    'v0.2d, #0',
    'v31.2d, #0',
    'v32.2d, #0',
    'v1.2d, #1',
    'v1.2d, #-0',
    'v1.4s, #0',
    'x0, #0',
    'v1.2d, #0x0',
  ].map((o) => `movi ${o}`),
  'nop',
  'nop x0',
  // directives, labels, comments, tokens
  '\t.text\n\t.globl _f\n\t.p2align 2\n_f:\n\tret',
  'nop\n\t.p2align 3\n\tnop\n\t.p2align 4\n\tnop',
  '\t.p2align 1',
  '\t.p2align 15',
  '\t.p2align 0x3\n\tnop',
  '\t.p2align',
  '\t.p2align -2',
  '\t.section __TEXT,__text,regular,pure_instructions\n\tnop',
  '\t.section __TEXT,__const',
  '\t.section  __TEXT,__text',
  '\t.subsections_via_symbols',
  '\t.zerofill __DATA,__bss,_a,4,2\n\t.zerofill __DATA,__bss,_b,16,4\n\t.zerofill __DATA, __bss , _c , 1 , 0\n\t.zerofill __DATA,__bss,_d,8,3',
  '\t.zerofill __DATA,__bss,_a,,',
  '\t.zerofill __DATA,__bss,_a,4',
  '\t.zerofill __DATA,__bss,_a,4,2,1',
  '\t.zerofill __DATA,__data,_a,4,2',
  '\t.zerofill __DATA,__bss,_a,4,15',
  '\t.zerofill __DATA,__bss,_a,0x10,0x2',
  '\t.zerofill __DATA,__bss,_a,x,2',
  '\t.data',
  '\t.globl',
  'a: b: nop\nc:',
  'a:\na: nop',
  '1: 2: nop\n\tb 2b\n\tb 1b',
  'l.$_x: nop ; comment\n\tb l.$_x // another',
  '// only a comment\n; and another\n\n\tnop',
  'nop // trailing ; both',
  'add x0, x1, #1 ; add x0, x0, x0',
  '  NOP',
  'add x0, x1, %',
  'add x0, x1, #',
  'add x0, x1, #x',
  'add x0, x1, @PAGE',
  'add x0, x1, x2 @PAGE',
  'add x0 x1 x2',
  'add x0,,x1,,#2',
  'add [x0], x1, #2',
  'add x0, x1, #2, lsl',
  'add x0, x1, 0x',
  'add x0, x1, -',
  'add x0, x1, 12',
  'mov x0, #99999999999999999999',
  'mov x0, #-0x8000000000000000',
  'movk x9, #0xBEEF, lsl #16',
  'mov x0, #0XFF',
  'mov x07, x08',
  'mov x123, x1',
  'b x31',
  'b.eq 1b',
  'b 0f\n0: nop',
  'unknown x0',
  '\t.unknown 1',
  'add\tx0,\tx1,\tx2\r',
  'ldr x0, [x1, #8]!\r\n\tnop\r',
];

test('asm_arm64.a0: every instruction form of the reference, valid and invalid', async () => {
  const { asm } = await encoder();
  const covered = new Set<string>();
  let accepted = 0;
  for (const [i, text] of FORMS.entries())
    if (agree(asm, `form ${i}: ${JSON.stringify(text)}`, text)) {
      accepted += 1;
      for (const mn of mnemonics(text)) covered.add(mn);
    }
  // every mnemonic of the reference is accepted in some form, and none is skipped
  assert.deepEqual(
    MNEMONICS.filter((mn) => !covered.has(mn)),
    Object.keys(SKIPS),
  );
  assert.ok(covered.has('b.<cond>'));
  assert.ok(accepted > 500 && accepted < FORMS.length, `${accepted} of ${FORMS.length}`);
});

test('asm_arm64.a0: capacities are code 2 with the line', async () => {
  const { asm } = await encoder();
  const labels = Array.from({ length: 1025 }, (_, i) => `l${i}: nop`).join('\n');
  assert.deepEqual(asm(labels), { ok: false, code: 2, line: 1025 });
  assert.deepEqual(asm(`\tnop ${'x'.repeat(300)}`), { ok: false, code: 2, line: 1 });
  // a long comment is not a long line
  assert.equal(asm(`\tnop // ${'x'.repeat(300)}\n\tnop`).ok, true);
});

test('asm_arm64.a0: the reference interpreter gives the JavaScript backend its words', async () => {
  const { asm, entry } = await encoder();
  const text = compile(
    parseAndValidate(await readFile('examples/kernels.a0', 'utf8')),
    'arm64',
  ).text;
  const io = makeIo(input(text));
  const code = run(entry, [io], { fuel: 1e10 }) as number;
  assert.deepEqual(decode(code, io.output), asm(text));
  assert.ok(agree(asm, 'kernels', text));
});
