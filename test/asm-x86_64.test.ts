import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { makeIo, parseAndValidate, run, type TypedFunc, validate } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { assembleX86_64Text, MNEMONICS, type X86Module } from '../src/x86_64enc.js';
import { generateCorpus, ioFreeSubset } from '../tools/corpus.js';

// The x86-64 encoder: src/x86_64enc.ts (the reference) against clang's assembler, instruction by
// instruction and, for the Linux texts, module by module; and compiler/asm_x86_64.a0 (the encoder
// written in A0) against the reference on every form and on every x86-64 text the repository
// produces for the corpus and the examples (src/x86_64.ts, both platforms, optimized and not,
// canonical and strict). clang is only the oracle here, never part of the product.

/** Mnemonics of the reference the A0 encoder does not accept, with the reason. None today. */
const SKIPS: Readonly<Record<string, string>> = {};

/**
 * Texts the clang oracle does not check, with the reason. The A0-against-reference comparison
 * still covers every one of them.
 */
const ORACLE_SKIPS: Readonly<Record<string, string>> = {
  'darwin texts':
    'Mach-O directives (.zerofill, .subsections_via_symbols) need a Mach-O object reader in the test; their instructions are the Linux ones with other symbol names, and each form is checked per instruction',
  'directive forms (.bss, .zero, .zerofill, .section, .type, .size, .globl)':
    'they produce no text bytes, or Mach-O data an ELF assembler refuses; the A0 encoder is compared with the reference on them',
};

const MNEMONIC_NAMES = MNEMONICS.map(([n]) => n);

// --- the A0 encoder -------------------------------------------------------------------------

type A0Result =
  | { readonly ok: true; readonly module: Omit<X86Module, 'lines'> }
  | { readonly ok: false; readonly code: number; readonly line: number };

const KINDS = ['branch32', 'pcrel32'] as const;

/** Decode the output words of `xasmio` (see compiler/asm_x86_64.a0). */
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
  const bytes = o.slice(i, i + k);
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
    bss.push({ name: name(), offset });
  }
  const bssSize = next();
  const bssAlign = next();
  assert.equal(i, o.length, 'trailing output words');
  return { ok: true, module: { bytes, labels, bss, bssSize, bssAlign, relocations } };
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
    const program = (await link('compiler/asm_x86_64.a0', (p) => readFile(p, 'utf8'))).program;
    const js = compile(program, 'js').text;
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )) as {
      xasmio: (io: { input: number[]; position: number; output: number[] }) => number;
    };
    const asm: Asm = (text) => {
      const io = { input: input(text), position: 0, output: [] as number[] };
      const code = mod.xasmio(io);
      return decode(code, io.output);
    };
    return { asm, entry: program.byName.get('xasmio') as TypedFunc };
  })();
  return cached;
}

/** The reference's result in the same shape (an error: its line). */
function reference(text: string): A0Result {
  try {
    const { lines: _lines, ...module } = assembleX86_64Text(text);
    return { ok: true, module };
  } catch (e) {
    const m = /^x86_64 encoder: line (\d+):/.exec((e as Error).message);
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
  const bad = want.module.bytes.findIndex((b, i) => got.module.bytes[i] !== b);
  if (bad >= 0) {
    const line = (assembleX86_64Text(text).lines[bad] ?? 0) - 1;
    assert.fail(
      `${label}: byte ${bad} (${lines[line]?.trim()}): want ${want.module.bytes[bad]?.toString(16)}, got ${got.module.bytes[bad]?.toString(16)}`,
    );
  }
  assert.equal(got.module.bytes.length, want.module.bytes.length, `${label}: byte count`);
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
    const body = raw.replace(/^(\s*[A-Za-z0-9_.$]+:)+/, '').trim();
    const mn = body.split(/\s+/)[0] ?? '';
    if (mn !== '' && !mn.startsWith('.') && !mn.startsWith('#')) out.add(mn);
  }
  return out;
}

// --- the repository's texts -----------------------------------------------------------------

/**
 * Every x86-64 text the repository produces for the corpus and the examples: src/x86_64.ts on
 * what it accepts (the scalar corpus, the io-free subsets of the corpus and of examples/life.a0,
 * examples/kernels.a0, and the io-free corpus under the strict profile, which adds the trap
 * runtime of src/native-trap.ts), for Linux and macOS, optimized and not.
 */
async function repositoryTexts(): Promise<[string, string][]> {
  const kernels = parseAndValidate(await readFile('examples/kernels.a0', 'utf8'));
  const life = ioFreeSubset(parseAndValidate(await readFile('examples/life.a0', 'utf8')));
  const scalar = generateCorpus(undefined, undefined, { scalar: true });
  const corpus = ioFreeSubset(generateCorpus());
  const strict = validate({ profile: 'strict', functions: corpus.functions });
  const programs: [string, ReturnType<typeof parseAndValidate>][] = [
    ['examples/kernels.a0', kernels],
    ['examples/life.a0, io-free subset', life],
    ['scalar corpus', scalar],
    ['corpus, io-free subset', corpus],
    ['corpus, io-free subset, strict', strict],
  ];
  const texts: [string, string][] = [];
  for (const [name, p] of programs)
    for (const platform of ['linux', 'darwin'] as const)
      for (const optimize of [true, false])
        texts.push([
          `${name} (${platform}${optimize ? '' : ', unoptimized'})`,
          compile(p, 'x86_64', { optimize, x86Platform: platform }).text,
        ]);
  return texts;
}

// --- forms ----------------------------------------------------------------------------------

type RegLists = { readonly [k in 8 | 32 | 64 | 128]: readonly string[] } & {
  readonly [k: number]: readonly string[] | undefined;
};
const REGS: RegLists = {
  8: ['%al', '%cl', '%spl', '%sil', '%dil', '%r8b', '%r15b'],
  32: ['%eax', '%ecx', '%esp', '%ebp', '%r8d', '%r13d', '%r15d'],
  64: ['%rax', '%rcx', '%rsp', '%rbp', '%r8', '%r12', '%r15'],
  128: ['%xmm0', '%xmm3', '%xmm8', '%xmm15'],
};
/** A few registers of each class, enough for every REX bit. */
const FEW: RegLists = {
  8: ['%al', '%sil', '%r9b'],
  32: ['%eax', '%edi', '%r9d'],
  64: ['%rax', '%rdi', '%r9'],
  128: ['%xmm1', '%xmm9'],
};
const MEMS = [
  '(%rax)',
  '(%rsp)',
  '(%rbp)',
  '(%r12)',
  '(%r13)',
  '(%r15)',
  '8(%rax)',
  '-8(%rsp)',
  '127(%rbp)',
  '128(%rbp)',
  '-128(%r13)',
  '-129(%r12)',
  '0(%rsp)',
  '0(%rbp)',
  '2147483647(%rax)',
  '-2147483648(%rdi)',
  '0x10(%rdi)',
  '-0x10(%r11)',
  '(%rax,%rbx)',
  '(%rsp,%r10,4)',
  '0(%rsp,%r10,4)',
  '72(%rsp,%r10,4)',
  '(%rbp,%rax,8)',
  '(%r13,%r12,2)',
  '-8(%r10,%r11)',
  '(%rax,%r15,1)',
  '256(%rsp,%rdi,8)',
  '(%r12,%rbp)',
  'sym(%rip)',
  'La0_f_1(%rip)',
  '8(%rip)',
  '(%rip)',
  '-4(%rip)',
];
const FEW_MEMS = [
  '(%rsp)',
  '(%r13)',
  '-8(%rbp)',
  '200(%r12)',
  '72(%rsp,%r10,4)',
  '-8(%r10,%r11)',
  'sym(%rip)',
];
const BAD_MEMS = [
  '(%eax)',
  '(%rax,%rsp)',
  '(%rax,%rbx,3)',
  '(%rax,%rbx,4,1)',
  'sym(%rax)',
  '(%rip,%rax)',
  '2147483648(%rax)',
  '-2147483649(%rax)',
  '(,%rax,4)',
  '((%rax))',
  '8(%rax)x',
  '(%xmm0)',
  '(%rax',
  '()',
  '(%rax,)',
  '(%rax,%rbx,)',
  '1(%rip,%rax,2)',
  '12(%rax)(%rbx)',
  'x-1(%rip)',
  '123(%rip',
  '(%rax,%rip)',
  '(%rax,%ebx)',
  '(rax)',
  '1f(%rip)',
  '99(%rip)',
  '0x(%rax)',
  '(%rax,%rbx,04)',
];
const IMMS = [
  '$0',
  '$1',
  '$-1',
  '$2',
  '$127',
  '$128',
  '$-128',
  '$-129',
  '$255',
  '$256',
  '$2147483647',
  '$2147483648',
  '$-2147483648',
  '$-2147483649',
  '$4294967295',
  '$4294967296',
  '$4294967168',
  '$0x7f',
  '$-0x80',
  '$0x2000004',
  '$-0',
];
const FEW_IMMS = [
  '$1',
  '$-1',
  '$127',
  '$128',
  '$-129',
  '$255',
  '$4294967295',
  '$2147483648',
  '$-2147483649',
];
const BAD_IMMS = ['$', '$x', '$0x', '$1f', '$--1', '$18446744073709551616', '$ 1'];

/** Every combination of the operand lists, as `mn a, b, c`. */
function cross(mn: string, ...lists: readonly (readonly string[])[]): string[] {
  let out = [''];
  for (const l of lists) out = out.flatMap((s) => l.map((x) => (s === '' ? x : `${s}, ${x}`)));
  return out.map((o) => `\t${mn} ${o}`);
}

/** The forms of one mnemonic of the reference, valid and invalid (`full` tries every operand list). */
function formsOf(mn: string, cls: number, size: number, full: boolean): string[] {
  const all = (s: number): readonly string[] => (full ? REGS : FEW)[s] ?? [];
  const regs = (s: number): readonly string[] => FEW[s] ?? [];
  const mems = full ? MEMS : FEW_MEMS;
  const imms = full ? IMMS : FEW_IMMS;
  const rm = (s: number): string[] => [...regs(s), ...FEW_MEMS.slice(0, 3)];
  const other = size === 32 ? 64 : 32;
  const wrong = [
    `\t${mn}`,
    `\t${mn} ${regs(other)[0]}, ${regs(other)[1]}`,
    `\t${mn} %xmm0, %eax, %ecx, %edx`,
  ];
  switch (cls) {
    case 1: // alu
    case 2: // test
    case 3: // mov
      return [
        ...cross(mn, imms, rm(size)),
        ...cross(mn, all(size), all(size)),
        ...cross(mn, regs(size).slice(0, 2), mems),
        ...cross(mn, mems, regs(size).slice(1, 3)),
        ...cross(mn, FEW_MEMS.slice(0, 2), FEW_MEMS.slice(2, 4)),
        ...cross(mn, regs(size), ['$1']),
        ...(size === 64 ? cross(mn, [...FEW[64], ...FEW[128]], [...FEW[64], ...FEW[128]]) : []),
        ...(size === 64 ? cross(mn, ['$-2147483648', '$2147483647', '$2147483648'], FEW[64]) : []),
        ...cross(mn, BAD_IMMS, regs(size).slice(0, 1)),
        ...cross(
          mn,
          ['%ax', '%ah', '%r16d', '%xmm16', '%rip', '%eip', '%foo'],
          regs(size).slice(0, 1),
        ),
        ...(full ? cross(mn, BAD_MEMS, regs(size).slice(0, 1)) : []),
        ...wrong,
      ];
    case 4: // movabs
      return [
        ...cross(
          mn,
          [
            ...imms,
            '$18446744073709551615',
            '$-9223372036854775808',
            '$-9223372036854775809',
            '$0x123456789abcdef0',
          ],
          REGS[64],
        ),
        ...cross(mn, FEW_MEMS.slice(0, 2), FEW[64]),
        ...cross(mn, ['$1'], [...FEW[32], ...FEW_MEMS.slice(0, 1)]),
        ...wrong,
      ];
    case 5: // movzbl
      return [
        ...cross(mn, rm(8), regs(32)),
        ...cross(mn, regs(32), regs(32)),
        ...cross(mn, ['$1'], regs(32)),
        ...wrong,
      ];
    case 6: // lea
      return [
        ...cross(mn, mems, regs(size)),
        ...cross(mn, regs(size), regs(size)),
        ...cross(mn, ['$1'], regs(size)),
        ...wrong,
      ];
    case 7: // imul
      return [
        ...cross(mn, rm(size), regs(size)),
        ...cross(mn, imms, rm(size), regs(size).slice(0, 2)),
        ...cross(mn, ['$5'], regs(size), mems.slice(0, 1)),
        ...cross(mn, imms.slice(0, 2), regs(size)),
        ...wrong,
      ];
    case 8: // grp3
    case 9: // grp5
      return [
        ...cross(mn, rm(size)),
        ...cross(mn, ['$1']),
        ...cross(mn, regs(size), regs(size).slice(0, 1)),
        ...wrong,
      ];
    case 10: // shift
      return [
        ...cross(mn, imms, rm(size)),
        ...cross(mn, ['$31', '$32', '$63', '$64'], regs(size).slice(0, 1)),
        ...cross(mn, ['%cl'], rm(size)),
        ...cross(mn, ['%al', '%ecx', '%dl'], regs(size).slice(0, 1)),
        ...cross(mn, regs(size).slice(0, 1)),
        ...wrong,
      ];
    case 11: // push pop
      return [
        ...cross(mn, REGS[64]),
        ...cross(mn, ['%eax', '$1', '(%rax)']),
        `\t${mn}`,
        `\t${mn} %rax, %rbx`,
      ];
    case 12: // fixed
      return [`\t${mn}`, `\t${mn} %rax`, `\t${mn} $1`];
    case 13: // jmp call
    case 14: // jcc
      return [
        `L_top:\n\t${mn} L_top`,
        `\t${mn} L_fwd\n\tret\nL_fwd:\n\tret`,
        `\t${mn} ext_sym`,
        `1:\n\t${mn} 1b\n\t${mn} 1f\n1:\tret\n\t${mn} 1b`,
        `\t${mn} 2b`,
        `\t${mn} 3f`,
        `\t${mn} %rax`,
        `\t${mn} $1`,
        `\t${mn} 12`,
        `\t${mn} (%rax)`,
        `\t${mn} a, b`,
        `\t${mn}`,
        `\t${mn} 0x1f`,
        `\t${mn} 4294967296f`,
        `\t${mn} a-b`,
      ];
    case 15: // setcc
      return [...cross(mn, rm(8)), ...cross(mn, ['%eax', '$1']), `\t${mn}`, `\t${mn} %al, %bl`];
    case 16: // cmov
      return [
        ...cross(mn, rm(size), regs(size)),
        ...cross(mn, regs(size), mems.slice(0, 1)),
        ...cross(mn, ['$1'], regs(size)),
        ...wrong,
      ];
    case 17: // sse rm
    case 18: // movups
      return [
        ...cross(mn, [...regs(128), ...mems], regs(128)),
        ...cross(mn, regs(128), mems),
        ...cross(mn, ['%eax', '$1'], regs(128)),
        `\t${mn} %xmm1`,
        `\t${mn} %xmm1, %xmm2, %xmm3`,
      ];
    case 19: // sse shift
      return [
        ...cross(mn, imms, regs(128)),
        ...cross(mn, [...regs(128), ...mems], regs(128)),
        ...cross(mn, ['$1'], [...mems.slice(0, 1), '%eax']),
        `\t${mn} %xmm1`,
      ];
    case 20: // pshufd
      return [
        ...cross(mn, imms, regs(128), regs(128)),
        ...cross(mn, ['$245'], mems, regs(128)),
        ...cross(mn, ['%xmm1'], regs(128)),
        ...cross(mn, ['$1'], regs(128), mems.slice(0, 1)),
      ];
    case 21: // movd
      return [
        ...cross(mn, [...regs(32), ...mems], regs(128)),
        ...cross(mn, regs(128), [...regs(32), ...mems]),
        ...cross(mn, [...regs(64), '$1'], regs(128)),
        ...cross(mn, regs(128), regs(128)),
      ];
  }
  return [];
}

/** The mnemonics tried with every operand list; the others take a few of each kind. */
const FULL = new Set([
  'addl',
  'cmpq',
  'movl',
  'movq',
  'movb',
  'testl',
  'leaq',
  'imull',
  'shll',
  'movups',
  'pshufd',
  'movd',
  'movabsq',
  'movzbl',
  'pushq',
]);

/** Every instruction form, valid and invalid, one text each (a text may define labels around it). */
function forms(): string[] {
  const out: string[] = [];
  for (const [mn, m] of MNEMONICS) out.push(...formsOf(mn, m.cls, m.size, FULL.has(mn)));
  out.push(
    // nop padding and alignment
    ...Array.from({ length: 34 }, (_, k) => `${'\tret\n'.repeat(k)}\t.p2align 5\n\tret`),
    '\tret\n\t.p2align 0\n\tret\n\t.p2align 1\n\tret',
    '\tret\n\t.balign 16\n\tret\n\t.balign 1',
    '\t.balign 3',
    '\t.balign 0',
    '\t.balign 32768',
    '\t.p2align 15',
    '\t.p2align -0\n\tret',
    '\t.p2align -1',
    '\t.p2align 0x4\n\tret',
    '\t.p2align',
    '\t.p2align 4, 0x90',
    // strings
    '\tret\n\t.asciz "a0_f"\n\tret',
    '\t.asciz "runtime: trap "',
    '\t.asciz ""',
    '\t.asciz "a\\"b\\\\c\\nd\\te"',
    '\t.asciz "# not a comment" # a comment',
    '\t.asciz "x\\q"',
    '\t.asciz "x',
    '\t.asciz x"',
    '\t.asciz "a"b"',
    '\t.asciz "\\"',
    '\t.asciz',
    '\t.asciz "tab\tinside"',
    // labels, comments, layout
    'L_a: L_b: ret\nL_c:',
    'L_a:\nL_a: ret',
    '1: 2: ret\n\tjmp 2b\n\tjmp 1b',
    '01:\n\tjmp 1b',
    '4294967296:\n\tret',
    'l.$_x: ret # comment\n\tjmp l.$_x # another',
    '# only a comment\n\n\tret',
    'ret # trailing',
    '  RET',
    'addl\t%eax,\t%ecx\r',
    'movl 8(%rsp), %eax\r\n\tret\r',
    'movl 8 (%rsp), %eax',
    'movl % eax, %ecx',
    'addl %eax,,%ecx',
    'addl %eax, %ecx,',
    'addl ,%eax',
    'unknown %eax',
    'movlx %eax, %ecx',
    'punpcklqdqq %xmm0, %xmm1',
    'L_x: .text',
    'jmp ext\n\tleaq ext(%rip), %rax\n\tcall ext2\n\tjne ext',
    'leaq L_f(%rip), %rax\nL_f:\n\tret\n\tleaq L_f(%rip), %rcx',
    'movl L_f(%rip), %eax\nL_f: ret',
    'cmpl $1, sym(%rip)',
    'movl $1, L_f(%rip)\nL_f: ret',
    'movl %eax, 1f(%rip)\n1: ret',
    // directives
    '\t.text\n\t.globl _f\n\t.p2align 4\n_f:\n\tret',
    '\t.globl',
    '\t.globl a b',
    '\t.globl 1',
    '\t.type a0_f,@function\n\t.size a0_f, .-a0_f',
    '\t.type',
    '\t.size',
    '\t.section __TEXT,__text,regular,pure_instructions\n\tret',
    '\t.section  __TEXT,__text',
    '\t.section __TEXT,__const',
    '\t.section .note.GNU-stack,"",@progbits',
    '\t.section .note.GNU-stack,"",@progbits\n\tret',
    '\t.section .note.GNU-stack,"",@progbits\nL_x:',
    '\t.section .note.GNU-stack,"",@progbits\n\t.text\n\tret',
    '\t.section .note.GNU-stack,"",@progbits\n\t.p2align 2',
    '\t.section',
    '\t.subsections_via_symbols',
    '\t.subsections_via_symbols 1',
    '\t.text 1',
    '\t.data',
    '\t.bss\n\t.balign 16\na0_ts:\n\t.zero 1264\na0_tb:\n\t.zero 2000\n\t.text\n\tleaq a0_ts(%rip), %r10\n\tleaq a0_tb(%rip), %rdi',
    '\t.bss\n\t.zero 3\n\t.p2align 3\nx:\n\t.zero 1\ny:\n\t.text\n\tret',
    '\t.bss\nx:\n\t.zero 4\nx:',
    '\t.bss\n\tret',
    '\t.bss\n\t.asciz "a"',
    '\t.bss\n1:',
    '\t.bss\n\t.zero 4294967295\n\t.zero 1',
    '\t.bss\n\t.zero -1',
    '\t.bss\n\t.zero',
    '\t.zero 4',
    '\t.bss\nfoo:\n\t.text\nfoo:',
    '\t.p2align 2\n\t.zerofill __DATA,__bss,_a0_ts,1264,4\n\t.zerofill __DATA,__bss,_a0_tb,2000,4\n\tleaq _a0_ts(%rip), %r10',
    '\t.zerofill __DATA,__bss,_a,4,2\n\t.zerofill __DATA,__bss,_b,16,4\n\t.zerofill __DATA, __bss , _c , 1 , 0\n\t.zerofill __DATA,__bss,_d,8,3',
    '\t.zerofill __DATA,__bss,_a,,',
    '\t.zerofill __DATA,__bss,_a,4',
    '\t.zerofill __DATA,__bss,_a,4,2,1',
    '\t.zerofill __DATA,__data,_a,4,2',
    '\t.zerofill __DATA,__bss,_a,4,15',
    '\t.zerofill __DATA,__bss,_a,0x10,0x2',
    '\t.zerofill __DATA,__bss,_a,x,2',
    '\t.zerofill __DATA,__bss,12,4,2',
    '\t.zerofill __DATA,__bss,_a,4,2\n_a: ret',
    '_a: ret\n\t.zerofill __DATA,__bss,_a,4,2',
    '\t.zerofill __DATA,__bss,_a,4294967295,0\n\t.zerofill __DATA,__bss,_b,1,0',
    '\t.unknown 1',
  );
  return out;
}

// --- clang, the oracle ----------------------------------------------------------------------

interface ElfReloc {
  readonly offset: number;
  readonly type: number;
  readonly addend: number;
  readonly symbol: string;
  /** The symbol's section index and value (a section symbol has an empty name). */
  readonly shndx: number;
  readonly value: number;
}
interface ElfSection {
  readonly name: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly relocs: ElfReloc[];
}

/** The sections of an ELF64 little-endian relocatable object (enough for the oracle). */
function readElf(buf: Buffer): {
  sections: ElfSection[];
  symbols: { name: string; shndx: number; value: number }[];
} {
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shnum = buf.readUInt16LE(0x3c);
  const shstrndx = buf.readUInt16LE(0x3e);
  const hdr = Array.from({ length: shnum }, (_, i) => {
    const b = shoff + 64 * i;
    return {
      name: buf.readUInt32LE(b),
      type: buf.readUInt32LE(b + 4),
      offset: Number(buf.readBigUInt64LE(b + 0x18)),
      size: Number(buf.readBigUInt64LE(b + 0x20)),
      link: buf.readUInt32LE(b + 0x28),
      info: buf.readUInt32LE(b + 0x2c),
    };
  });
  const str = (sec: number, at: number): string => {
    const h = hdr[sec];
    if (h === undefined) return '';
    const start = h.offset + at;
    return buf.toString('latin1', start, buf.indexOf(0, start));
  };
  const symtab = hdr.findIndex((h) => h.type === 2);
  const symbols: { name: string; shndx: number; value: number }[] = [];
  if (symtab >= 0) {
    const h = hdr[symtab] as (typeof hdr)[number];
    for (let at = h.offset; at < h.offset + h.size; at += 24)
      symbols.push({
        name: str(h.link, buf.readUInt32LE(at)),
        shndx: buf.readUInt16LE(at + 6),
        value: Number(buf.readBigUInt64LE(at + 8)),
      });
  }
  const sections: ElfSection[] = hdr.map((h) => ({
    name: str(shstrndx, h.name),
    bytes: h.type === 8 ? Buffer.alloc(0) : buf.subarray(h.offset, h.offset + h.size),
    size: h.size,
    relocs: [],
  }));
  for (const h of hdr)
    if (h.type === 4)
      for (let at = h.offset; at < h.offset + h.size; at += 24) {
        const info = buf.readBigUInt64LE(at + 8);
        const sym = symbols[Number(info >> 32n)] ?? { name: '', shndx: 0, value: 0 };
        sections[h.info]?.relocs.push({
          offset: Number(buf.readBigUInt64LE(at)),
          type: Number(info & 0xffffffffn),
          addend: Number(buf.readBigInt64LE(at + 16)),
          symbol: sym.name,
          shndx: sym.shndx,
          value: sym.value,
        });
      }
  return { sections, symbols };
}

/** Assemble `source` with clang for x86-64 ELF, every branch rel32 (`-mrelax-all`). */
function clangElf(clang: string, source: string): ReturnType<typeof readElf> {
  const dir = mkdtempSync(join(tmpdir(), 'a0-x86enc-'));
  try {
    writeFileSync(join(dir, 'in.s'), source);
    const r = runTool(
      clang,
      ['--target=x86_64-linux-gnu', '-c', '-x', 'assembler', '-mrelax-all', '-o', 'out.o', 'in.s'],
      { cwd: dir },
    );
    assert.ok(r.ok, `clang refused the text: ${r.stderr.slice(0, 2000)}`);
    return readElf(readFileSync(join(dir, 'out.o')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ELF_KIND: Readonly<Record<number, string>> = { 2: 'pcrel32', 4: 'branch32' };

/** Lines of a form that only the reference's own model has (no ELF counterpart). */
const NOT_ELF = /^\s*\.(bss|zero|zerofill|section|type|size|globl|subsections_via_symbols|text)\b/m;

test('x86_64enc.ts: the bytes and relocations of clang, form by form', (t) => {
  const clang = findClang().path;
  if (clang === undefined) {
    t.skip(
      'clang is not installed: the oracle cannot run (the A0 encoder is still compared with the reference)',
    );
    return;
  }
  const all = forms();
  const accepted = all
    .map((text, i) => ({ text, i }))
    .filter(({ text }) => reference(text).ok && !NOT_ELF.test(text));
  const source = accepted
    .map(
      ({ text, i }) =>
        `\t.section .text.f${i},"ax",@progbits\n${text.replace(/\bL_(\w+)/g, `L${i}_$1`)}`,
    )
    .join('\n');
  const elf = clangElf(clang, source);
  const covered = new Set<string>();
  for (const { text, i } of accepted) {
    const want = assembleX86_64Text(text);
    const sec = elf.sections.find((s) => s.name === `.text.f${i}`);
    assert.ok(sec !== undefined, `form ${i}: no section`);
    const got = [...sec.bytes];
    assert.deepEqual(
      got.map((b) => b.toString(16).padStart(2, '0')).join(' '),
      want.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' '),
      `form ${i}: ${JSON.stringify(text)}`,
    );
    const relocs = sec.relocs.map((r) => {
      assert.equal(r.addend, -4, `form ${i}: addend`);
      return { offset: r.offset, kind: ELF_KIND[r.type], symbol: r.symbol };
    });
    assert.deepEqual(relocs, want.relocations, `form ${i}: relocations: ${JSON.stringify(text)}`);
    for (const mn of mnemonics(text)) covered.add(mn);
  }
  // every mnemonic of the reference is checked against clang in some form
  assert.deepEqual(
    MNEMONIC_NAMES.filter((mn) => !covered.has(mn)),
    [],
  );
  assert.ok(accepted.length > 1500, `${accepted.length} forms checked against clang`);
});

test("x86_64enc.ts: every Linux text of the repository is clang's module, byte for byte", async (t) => {
  const clang = findClang().path;
  if (clang === undefined) {
    t.skip('clang is not installed: the oracle cannot run');
    return;
  }
  let checked = 0;
  for (const [label, text] of await repositoryTexts()) {
    if (!label.includes('(linux')) continue;
    const mine = assembleX86_64Text(text);
    const elf = clangElf(clang, text);
    const textSec = elf.sections.findIndex((s) => s.name === '.text');
    const bssSec = elf.sections.findIndex((s) => s.name === '.bss');
    const sec = elf.sections[textSec] as ElfSection;
    const want = [...sec.bytes];
    assert.equal(mine.bytes.length, want.length, `${label}: text size`);
    const relocated = new Map(mine.relocations.map((r) => [r.offset, r]));
    for (const r of sec.relocs) {
      assert.equal(r.addend <= 0 || r.symbol === '', true, `${label}: addend`);
      if (r.shndx === textSec) {
        // clang leaves a branch to a global function to the linker; the encoder resolves it
        const v = (r.value + r.addend - r.offset) | 0;
        const field = Buffer.from(mine.bytes.slice(r.offset, r.offset + 4)).readInt32LE(0);
        assert.equal(field, v, `${label}: resolved field at ${r.offset} (${r.symbol})`);
        assert.equal(relocated.has(r.offset), false, `${label}: ${r.offset} relocated`);
        for (let k = 0; k < 4; k++) want[r.offset + k] = mine.bytes[r.offset + k] as number;
        continue;
      }
      const ours = relocated.get(r.offset);
      assert.ok(ours !== undefined, `${label}: no relocation at ${r.offset}`);
      assert.equal(ours.kind, ELF_KIND[r.type], `${label}: relocation kind at ${r.offset}`);
      relocated.delete(r.offset);
      if (r.shndx === bssSec) {
        const sym = mine.bss.find((s) => s.name === ours.symbol);
        assert.equal(
          (sym?.offset ?? -1) - 4,
          r.value + r.addend,
          `${label}: bss reference ${ours.symbol}`,
        );
      } else assert.equal(ours.symbol, r.symbol, `${label}: relocation symbol`);
    }
    assert.deepEqual([...relocated.keys()], [], `${label}: relocations clang does not have`);
    const bad = want.findIndex((b, i) => mine.bytes[i] !== b);
    assert.equal(
      bad,
      -1,
      `${label}: byte ${bad} (line ${mine.lines[bad]}: ${text.split('\n')[(mine.lines[bad] ?? 1) - 1]})`,
    );
    // labels and bss symbols where clang keeps them
    for (const [name, offset] of mine.labels) {
      const s = elf.symbols.find((x) => x.name === name);
      if (s !== undefined) assert.equal(s.value, offset, `${label}: label ${name}`);
    }
    if (bssSec >= 0) {
      assert.equal(mine.bssSize, (elf.sections[bssSec] as ElfSection).size, `${label}: bss size`);
      for (const b of mine.bss) {
        const s = elf.symbols.find((x) => x.name === b.name);
        assert.equal(s?.value, b.offset, `${label}: bss ${b.name}`);
      }
    } else assert.equal(mine.bssSize, 0);
    checked += 1;
  }
  assert.equal(checked, 10);
});

// --- the A0 encoder against the reference ---------------------------------------------------

test('asm_x86_64.a0: the same bytes, labels, relocations and bss as src/x86_64enc.ts on every text of the corpus and the examples', async () => {
  const { asm } = await encoder();
  const texts = await repositoryTexts();
  const seen = new Set<string>();
  let matched = 0;
  let bytes = 0;
  for (const [label, text] of texts) {
    for (const mn of mnemonics(text))
      assert.ok(MNEMONIC_NAMES.includes(mn), `${label}: ${mn} is not a mnemonic of the reference`);
    assert.ok(agree(asm, label, text), `${label}: the reference refuses it`);
    matched += 1;
    bytes += assembleX86_64Text(text).bytes.length;
    for (const mn of mnemonics(text)) seen.add(mn);
  }
  assert.equal(matched, texts.length);
  assert.equal(texts.length, 20);
  // the instructions these texts exercise (the forms test covers every mnemonic)
  assert.ok(seen.size >= 50, `${seen.size}: ${[...seen].join(' ')}; ${bytes} bytes`);
});

test('asm_x86_64.a0: every instruction form of the reference, valid and invalid', async () => {
  const { asm } = await encoder();
  const covered = new Set<string>();
  const all = forms();
  let accepted = 0;
  for (const [i, text] of all.entries())
    if (agree(asm, `form ${i}: ${JSON.stringify(text)}`, text)) {
      accepted += 1;
      for (const mn of mnemonics(text)) covered.add(mn);
    }
  // every mnemonic of the reference is accepted in some form, and none is skipped
  assert.deepEqual(
    MNEMONIC_NAMES.filter((mn) => !covered.has(mn)),
    Object.keys(SKIPS),
  );
  assert.ok(accepted > 1500 && accepted < all.length, `${accepted} of ${all.length}`);
});

test('asm_x86_64.a0: capacities are code 2 with the line', async () => {
  const { asm } = await encoder();
  const labels = Array.from({ length: 1025 }, (_, i) => `l${i}: ret`).join('\n');
  assert.deepEqual(asm(labels), { ok: false, code: 2, line: 1025 });
  assert.deepEqual(asm(`\tret ${'x'.repeat(300)}`), { ok: false, code: 2, line: 1 });
  // a long comment is not a long line
  assert.equal(asm(`\tret # ${'x'.repeat(300)}\n\tret`).ok, true);
});

test('asm_x86_64.a0: the reference interpreter gives the JavaScript backend its bytes', async () => {
  const { asm, entry } = await encoder();
  const text = compile(parseAndValidate(await readFile('examples/kernels.a0', 'utf8')), 'x86_64', {
    x86Platform: 'linux',
  }).text;
  const io = makeIo(input(text));
  const code = run(entry, [io], { fuel: 1e10 }) as number;
  assert.deepEqual(decode(code, io.output), asm(text));
  assert.ok(agree(asm, 'kernels', text));
});

test('ORACLE_SKIPS and SKIPS state a reason for every entry', () => {
  for (const [k, v] of Object.entries({ ...ORACLE_SKIPS, ...SKIPS }))
    assert.ok(v.length > 20, `${k}: a reason`);
});
