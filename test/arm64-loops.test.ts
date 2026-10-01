import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';

const ARM64_HOST = process.platform === 'darwin' && process.arch === 'arm64';
const zeros = (n: number): string => Array.from({ length: n }, () => '0').join(' ');

const INPUTS: [number, number][] = [
  [0, 0],
  [1, 2],
  [7, 13],
  [0xffffffff, 5],
  [123456, 0xfffffff0],
  [0x9e3779b9, 0x7f4a7c15],
  [0xdeadbeef, 0xffffffff],
];

/** Assemble `src` for arm64, run `names` on every input, and compare with the interpreter. */
async function checkAgainstInterpreter(
  src: string,
  names: readonly string[],
  clangPath: string,
): Promise<string> {
  const p = parseAndValidate(src);
  const expected = INPUTS.flatMap(([a, b]) =>
    names.map((n) => String(run(p.byName.get(n) as TypedFunc, [a, b]))),
  ).join('\n');
  const protos = names.map((n) => `extern uint32_t a0_${n}(uint32_t, uint32_t);`).join('\n');
  const calls = INPUTS.flatMap(([a, b]) =>
    names.map((n) => `  printf("%u\\n", a0_${n}(${a}u, ${b}u));`),
  ).join('\n');
  const driver = `#include <stdint.h>\n#include <stdio.h>\n${protos}\nint main(void) {\n${calls}\n  return 0;\n}\n`;
  const asm = compile(p, 'arm64').text;
  for (const optimize of [true, false]) {
    const text = compile(p, 'arm64', { optimize }).text;
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'module.s'), text, 'utf8');
      await writeFile(join(dir, 'driver.c'), driver, 'utf8');
      const as = runTool(clangPath, ['-c', '-x', 'assembler', '-o', 'module.o', 'module.s'], {
        cwd: dir,
      });
      assert.ok(as.ok, as.stderr);
      const ld = runTool(clangPath, ['-O1', '-o', 'driver', 'driver.c', 'module.o'], { cwd: dir });
      assert.ok(ld.ok, ld.stderr);
      const exec = runTool(join(dir, 'driver'), [], { cwd: dir });
      assert.ok(exec.ok, exec.stderr);
      const got = exec.stdout.trim().split('\n');
      const want = expected.split('\n');
      const bad = want.findIndex((w, i) => w !== got[i]);
      assert.equal(
        bad,
        -1,
        `${names[bad % names.length]}${JSON.stringify(INPUTS[Math.floor(bad / names.length)])} (optimize ${optimize}): got ${got[bad]}, want ${want[bad]}`,
      );
    });
  }
  return asm;
}

const tail = (name: string, state: number, many = false): string =>
  `fn ${name} u32 u32 -> u32\nz arr ${zeros(state)}\na fold step${name.replace(/m$/, '')} ${state} z p0 p1\nq and p1 ${state - 1}\nr get a q\nw get a ${state - 1}\ns add r w\n${many ? 'x get a 0\ny get a 1\nt add s x\ns2 add t y\nret s2' : 'ret s'}\nend`;

test('arm64 prefix scans, indexed updates, induction variables and unrolled reductions equal the interpreter', {
  skip: ARM64_HOST ? false : 'needs macOS on Apple silicon',
}, async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  const funcs: string[] = [];
  const names: string[] = [];
  const add = (name: string, body: string): void => {
    funcs.push(body);
    names.push(name);
  };
  // Inclusive prefix sums and xors: the previous element guarded at trip 0 by a seed that is a
  // literal or a loop-invariant parameter, over an affine or a hashed lane expression.
  for (const [label, seed, op, e, n] of [
    ['sa', '0', 'add', 'a mul p1 p3\ne add a 5', 64],
    ['sb', 'p2', 'add', 'a mul p1 p3\ne add a 5', 64],
    ['sc', 'p3', 'xor', 'e shr p1 1', 64],
    ['sd', '7', 'add', 'a mul p1 p1\nx xor a p3\ne shr x 3', 20],
    ['se', 'p2', 'add', 'e mul p1 p3', 8],
  ] as const) {
    // `label` reads two elements (answered as queries); `label`m reads four (the scan is stored).
    add(
      label,
      `fn step${label} u32x${n} u32 u32 u32 -> u32x${n}\nc eq p1 0\nj sub p1 1\nt get p0 j\nu select c ${seed} t\n${e}\nv ${op} u e\nn set p0 p1 v\nret n\nend\n${tail(label, n)}`,
    );
    add(`${label}m`, tail(`${label}m`, n, true));
  }
  // Histograms: an index bounded by a shift, one that needs the mask, a weighted update, and a
  // length that is not a power of two (so it stays scalar).
  const hist = (label: string, len: number, count: number, k: string, upd: string): void => {
    const top = (name: string, many: boolean): string =>
      `fn ${name} u32 u32 -> u32\nz arr ${zeros(count)}\na fold hfill${label} ${count} z p0 p1\nhz arr ${zeros(len)}\nh fold hstep${label} ${count} hz a\nq and p1 ${len - 1}\nr get h q\nw and p0 ${len - 1}\nr2 get h w\ns mul r 65599\nt add s r2\n${many ? 'g0 get h 0\ng1 get h 1\nt2 add t g0\nt3 xor t2 g1\nret t3' : 'ret t'}\nend`;
    add(
      label,
      `fn hfill${label} u32x${count} u32 u32 u32 -> u32x${count}\nw mul p1 p2\nx add w p3\ny xor x 2654435761\nn set p0 p1 y\nret n\nend\nfn hstep${label} u32x${len} u32 u32x${count} -> u32x${len}\nv get p2 p1\n${k}\nh get p0 k\n${upd}\nn set p0 k h1\nret n\nend\n${top(label, false)}`,
    );
    // four reads: the histogram is stored
    add(`${label}m`, top(`${label}m`, true));
  };
  hist('ha', 16, 64, 'k shr v 28', 'h1 add h 1');
  hist('hb', 16, 64, 'k mul v 1', 'h1 add h 1');
  hist('hc', 32, 128, 'k shr v 27', 'w shr v 3\nh1 add h w');
  hist('hd', 12, 48, 'k mul v 1', 'h1 add h 1');
  hist('he', 16, 64, 'k shr v 28', 'h1 xor h v');
  // Dot products and sums over several trip counts (unroll by 4, 2, and none), min/max, and a
  // multiply-accumulate against an induction variable.
  for (const n of [12, 20, 24, 64, 128]) {
    add(
      `dot${n}`,
      `fn dfa${n} u32x${n} u32 u32 u32 -> u32x${n}\nv mul p1 p2\nw add v p3\nn set p0 p1 w\nret n\nend\nfn dfb${n} u32x${n} u32 u32 u32 -> u32x${n}\nv xor p1 p3\nw mul v p2\nn set p0 p1 w\nret n\nend\nfn dst${n} u32 u32 u32x${n} u32x${n} -> u32\ne get p2 p1\nf get p3 p1\ng mul e f\nh add p0 g\nret h\nend\nfn dot${n} u32 u32 -> u32\nz arr ${zeros(n)}\na fold dfa${n} ${n} z p0 p1\nz2 arr ${zeros(n)}\nb fold dfb${n} ${n} z2 p0 p1\nd fold dst${n} ${n} p1 a b\nret d\nend`,
    );
    add(
      `mm${n}`,
      `fn mfa${n} u32x${n} u32 u32 u32 -> u32x${n}\nw mul p1 p2\nx add w p3\nx2 shr x 15\ny xor x x2\nz mul y 2654435761\nn set p0 p1 z\nret n\nend\nfn mmst${n} (u32,u32) u32 u32x${n} -> (u32,u32)\nv get p2 p1\nlo at p0 0\nhi at p0 1\nc lt v lo\nnlo select c v lo\nd gt v hi\nnhi select d v hi\nr put p0 0 nlo\nr2 put r 1 nhi\nret r2\nend\nfn mm${n} u32 u32 -> u32\nz arr ${zeros(n)}\na fold mfa${n} ${n} z p0 p1\ni rec 4294967295 0\nm fold mmst${n} ${n} i a\nlo at m 0\nhi at m 1\ns sub hi lo\nret s\nend`,
    );
  }
  // Sums whose terms carry a constant factor (moved out of the loop), with a seed.
  for (const n of [16, 24, 64]) {
    add(
      `sc${n}`,
      `fn scf${n} u32x${n} u32 u32 u32 -> u32x${n}\nv xor p1 p3\nw mul v p2\nn set p0 p1 w\nret n\nend\nfn scs${n} u32 u32 u32x${n} u32 -> u32\ne get p2 p1\nf mul e p3\nh add p0 f\nret h\nend\nfn scd${n} u32 u32 u32x${n} u32x${n} u32 u32 -> u32\ne get p2 p1\nf get p3 p1\ng mul e p4\nh mul f p5\nk mul g h\nm add p0 k\nret m\nend\nfn sc${n} u32 u32 -> u32\nz arr ${zeros(n)}\na fold scf${n} ${n} z p0 p1\nz2 arr ${zeros(n)}\nb fold scf${n} ${n} z2 p1 p0\nd fold scs${n} ${n} p1 a p0\ne fold scd${n} ${n} p0 a b p1 p0\nr add d e\nret r\nend`,
    );
  }
  // Both operands of a product are the same scaled expression: the factor leaves the loop once
  // per operand, and the shared register must survive the first removal.
  add(
    'sq16',
    `fn sqf u32x16 u32 u32 u32 -> u32x16\nt0 mul p1 31153\nt1 shr t0 4\nt2 mul t1 31153\nn set p0 p1 t2\nret n\nend\nfn sqd u32 u32 u32x16 u32x16 -> u32\ne get p2 p1\nf get p3 p1\ng mul e f\nr add p0 g\nret r\nend\nfn sq16 u32 u32 -> u32\nz arr ${zeros(16)}\na fold sqf 16 z p0 p1\nz2 arr ${zeros(16)}\nb fold sqf 16 z2 p1 p0\nr fold sqd 16 p1 a b\nret r\nend`,
  );
  const src = funcs.join('\n\n');
  const asm = await checkAgainstInterpreter(src, names, clang);
  // The scan is a NEON scan with a running carry, the histogram an indexed update per lane, the
  // dot product a multiply-accumulate on an induction variable.
  assert.match(asm, /_a0_sam:[\s\S]*?ext v\d+\.16b, v\d+\.16b, v\d+\.16b, #12/);
  assert.match(asm, /_a0_ham:[\s\S]*?umov w9, v\d+\.s\[3\][\s\S]*?str w10, \[x\d+, w9, uxtw #2\]/);
  // Two reads of a prefix scan or a histogram are answered by counting matches in the loop.
  assert.match(asm, /_a0_sa:[\s\S]*?cmhs v\d+\.4s/);
  assert.match(asm, /_a0_ha:[\s\S]*?cmeq v\d+\.4s/);
  assert.doesNotMatch(/_a0_ha:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '', /uxtw #2/);
  assert.match(asm, /_a0_sc64:[\s\S]*?umov w10, v\d+\.s\[0\]\n\tmul w9, w9, w10/);
  assert.match(asm, /_a0_dot64:[\s\S]*?mla v\d+\.4s/);
});

test('arm64 carried recurrences start at the guard value instead of selecting it', {
  skip: ARM64_HOST ? false : 'needs macOS on Apple silicon',
}, async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  // A recurrence the vector paths do not take (a multiply and a shift in the chain): scalar
  // loop with the previous element in a register, trip 0 reading the guard value.
  const src = [
    'fn xsstep u32x37 u32 u32 -> u32x37\nc eq p1 0\nj sub p1 1\nt get p0 j\ns select c p2 t\na shl s 13\nb xor s a\nc2 shr b 17\nd xor b c2\ne shl d 5\nf xor d e\nn set p0 p1 f\nret n\nend',
    `fn xs u32 u32 -> u32\nz arr ${zeros(37)}\na fold xsstep 37 z p0\nq and p1 31\nr get a q\nw get a 36\ns add r w\nret s\nend`,
    'fn mstep u32x13 u32 u32 -> u32x13\nc eq p1 0\nj sub p1 1\nt get p0 j\ns select c 5 t\na mul s p2\nb add a p1\nn set p0 p1 b\nret n\nend',
    `fn ms u32 u32 -> u32\nz arr ${zeros(13)}\na fold mstep 13 z p1\nq and p1 7\nr get a q\nw get a 12\ns add r w\nret s\nend`,
  ].join('\n\n');
  const asm = await checkAgainstInterpreter(src, ['xs', 'ms'], clang);
  const body = /_a0_xs:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '';
  assert.doesNotMatch(body, /csel/);
});

test('arm64 4x4 products of scalar grids run in NEON registers and equal the interpreter', {
  skip: ARM64_HOST ? false : 'needs macOS on Apple silicon',
}, async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  // S x M (right) or M x S (left) as straight-line code, folded `count` times over two arrays
  // built from the inputs; the optimizer turns the fold into products of scalar grids.
  const step = (name: string, side: 'right' | 'left'): string => {
    const lines = [`fn ${name} u32x16 u32 u32x16 -> u32x16`];
    for (let k = 0; k < 16; k += 1) lines.push(`a${k} get p0 ${k}`, `b${k} get p2 ${k}`);
    const cs: string[] = [];
    for (let r = 0; r < 4; r += 1)
      for (let c = 0; c < 4; c += 1) {
        const terms: string[] = [];
        for (let k = 0; k < 4; k += 1) {
          const [x, y] = side === 'right' ? [r * 4 + k, k * 4 + c] : [k * 4 + c, r * 4 + k];
          lines.push(
            side === 'right' ? `m${r}${c}${k} mul a${x} b${y}` : `m${r}${c}${k} mul b${y} a${x}`,
          );
          terms.push(`m${r}${c}${k}`);
        }
        lines.push(
          `s${r}${c}a add ${terms[0]} ${terms[1]}`,
          `s${r}${c}b add s${r}${c}a ${terms[2]}`,
          `c${r}${c} add s${r}${c}b ${terms[3]}`,
        );
        cs.push(`c${r}${c}`);
      }
    lines.push(`n arr ${cs.join(' ')}`, 'ret n', 'end');
    return lines.join('\n');
  };
  const grid = (id: string, mulBy: (k: number) => string, shiftBy: string): string[] => {
    const out: string[] = [];
    for (let k = 0; k < 16; k += 1)
      out.push(
        `${id}e${k} mul ${mulBy(k)} ${k + 1}`,
        `${id}f${k} shr ${shiftBy} ${k & 7}`,
        `${id}${k} xor ${id}e${k} ${id}f${k}`,
      );
    return out;
  };
  const tops = (name: string, count: number, side: string, reads: string): string =>
    [
      `fn ${name} u32 u32 -> u32`,
      ...grid('ga', () => 'p0', 'p1'),
      ...grid('gb', () => 'p1', 'p0'),
      `a arr ${Array.from({ length: 16 }, (_, k) => `ga${k}`).join(' ')}`,
      `b arr ${Array.from({ length: 16 }, (_, k) => `gb${k}`).join(' ')}`,
      `r fold ms_${side} ${count} a b`,
      reads,
      'end',
    ].join('\n');
  const reads = 'q and p0 15\nx get r q\nt0 get r 0\nt5 get r 5\ns add x t0\nt add s t5\nret t';
  const src = [
    step('ms_right', 'right'),
    step('ms_left', 'left'),
    tops('mr1', 1, 'right', reads),
    tops('mr2', 2, 'right', reads),
    tops('mr3', 3, 'right', reads),
    tops('mr5', 5, 'right', reads),
    tops('mr8', 8, 'right', reads),
    tops('ml3', 3, 'left', reads),
    tops('ml8', 8, 'left', reads),
    // one element only, and the whole array summed: rows are emitted when their inputs exist
    tops('mr4', 4, 'right', 't get r 10\nret t'),
    tops(
      'mr6',
      6,
      'right',
      `${Array.from({ length: 16 }, (_, k) => `e${k} get r ${k}`).join('\n')}\n${Array.from({ length: 15 }, (_, k) => `f${k} add ${k === 0 ? 'e0' : `f${k - 1}`} e${k + 1}`).join('\n')}\nret f14`,
    ),
  ].join('\n\n');
  const names = ['mr1', 'mr2', 'mr3', 'mr5', 'mr8', 'ml3', 'ml8', 'mr4', 'mr6'];
  const asm = await checkAgainstInterpreter(src, names, clang);
  const body = /_a0_mr8:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '';
  assert.match(body, /mla v\d+\.4s, v\d+\.4s, v\d+\.s\[\d\]/);
  // the 32 + 16 scalar products of the straight-line form are gone
  assert.ok((body.match(/\n\tmul w/g)?.length ?? 0) < 60);
});

test('arm64 absolute differences and bit tests use subs/cneg and tst, and equal the interpreter', {
  skip: ARM64_HOST ? false : 'needs macOS on Apple silicon',
}, async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  const fns: string[] = [];
  const names: string[] = [];
  const add = (name: string, body: string): void => {
    fns.push(`fn ${name} u32 u32 -> u32\n${body}\nend`);
    names.push(name);
  };
  // select (x ? y) (y - x) (x - y) in every orientation of the comparison and the picked arm
  for (const [op, x, y] of [
    ['lt', 'p0', 'p1'],
    ['le', 'p0', 'p1'],
    ['gt', 'p0', 'p1'],
    ['ge', 'p1', 'p0'],
    ['lt', 'p0', '100'],
    ['gt', '100', 'p0'],
  ] as const) {
    const base = `ad_${op}_${x}_${y}`;
    add(`${base}_a`, `c ${op} ${x} ${y}\ne sub ${y} ${x}\nd sub ${x} ${y}\nm select c e d\nret m`);
    add(`${base}_b`, `c ${op} ${x} ${y}\ne sub ${y} ${x}\nd sub ${x} ${y}\nm select c d e\nret m`);
  }
  // a subtraction with another use keeps its own instruction
  add('ad_shared', 'c lt p0 p1\ne sub p1 p0\nd sub p0 p1\nm select c e d\nr add m d\nret r');
  // (x & m) == 0, == m for a single bit, != , a mask that is not a bit, a literal on the left
  add('tb_1', 'b and p0 1\nc eq b 1\nr select c p1 p0\nret r');
  add('tb_2', 'b and p0 4\nc eq b 0\nr select c p1 p0\nret r');
  add('tb_3', 'b and p0 240\nc ne b 0\nr select c p1 p0\nret r');
  add('tb_4', 'b and p0 16\nc ne b 16\nr select c p1 p0\nret r');
  add('tb_5', 'b and p0 3\nc eq b 3\nr select c p1 p0\nret r');
  add('tb_6', 'b and p0 3\nc eq b 2\nr select c p1 p0\nret r');
  add('tb_7', 'b and 8 p0\nc eq 0 b\nr select c p1 p0\nret r');
  add('tb_8', 'b and p0 1\nc eq b 1\nr select c p1 p0\nq add b r\nret q');
  const asm = await checkAgainstInterpreter(fns.join('\n\n'), names, clang);
  const abs = /_a0_ad_lt_p0_p1_a:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '';
  assert.match(abs, /subs w\d+, w\d+, w\d+\n\tcneg w\d+, w\d+, lo/);
  assert.doesNotMatch(abs, /csel/);
  const bit = /_a0_tb_1:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '';
  assert.match(bit, /tst w\d+, #1\n\tcsel/);
});

test('arm64 fold state records of scalars live in registers and equal the interpreter', {
  skip: ARM64_HOST ? false : 'needs macOS on Apple silicon',
}, async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  const src = [
    // new field 1 is the old field 0 (read before the put that overwrites field 0: a swap)
    'fn rsa (u32,u32) u32 u32 -> (u32,u32)\na at p0 0\nb at p0 1\nc add a p2\nd xor b c\ne put p0 0 d\nf put e 1 a\nret f\nend',
    // a bool field and a field the body never writes
    'fn rsb (u32,bool,u32) u32 -> (u32,bool,u32)\na at p0 0\nf at p0 1\nk at p0 2\ng lt a p1\nh select f a k\nm add h p1\nn put p0 0 m\no put n 1 g\nret o\nend',
    // every field rewritten from the others, in the opposite order of the reads
    'fn rsc (u32,u32,u32) u32 -> (u32,u32,u32)\na at p0 0\nb at p0 1\nc at p0 2\nx add a b\ny xor b c\nz mul c 3\nn1 put p0 2 x\nn2 put n1 0 y\nn3 put n2 1 z\nret n3\nend',
    'fn rs1 u32 u32 -> u32\nst rec p0 p1\nr fold rsa 33 st p1\nx at r 0\ny at r 1\ns add x y\nret s\nend',
    'fn rs2 u32 u32 -> u32\nst rec p0 true p1\ncnt and p0 63\nr fold rsb cnt st\nx at r 0\ny at r 2\ns add x y\nret s\nend',
    'fn rs3 u32 u32 -> u32\nst rec p0 p1 7\ncnt and p1 31\nr fold rsc cnt st\nx at r 0\ny at r 1\nz at r 2\ns add x y\nt xor s z\nret t\nend',
  ].join('\n\n');
  const asm = await checkAgainstInterpreter(src, ['rs1', 'rs2', 'rs3'], clang);
  const body = /_a0_rs1:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '';
  // the loop holds the fields in registers: no loads or stores between its label and branch
  const loop = /La0_rs1_\d+:([\s\S]*?)b\.lo/.exec(body)?.[1] ?? '';
  assert.ok(loop.length > 0);
  assert.doesNotMatch(loop, /\[sp/);
});

test('arm64 element-wise pipelines read by a few gets are evaluated at the indices read', {
  skip: ARM64_HOST ? false : 'needs macOS on Apple silicon',
}, async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  const stage = (n: number): string =>
    `fn pf${n} u32x${n} u32 u32 u32 -> u32x${n}\nv mul p1 p2\nw xor v p3\nn set p0 p1 w\nret n\nend\nfn ps${n} u32x${n} u32 u32x${n} -> u32x${n}\nj add p1 1\nu get p2 p1\nv get p2 j\nw add u v\ns shr w 1\nn set p0 p1 s\nret n\nend\nfn pg${n} u32x${n} u32 u32x${n} u32 -> u32x${n}\nu get p2 p1\nv mul u p3\nc lt u p3\nw select c p3 u\nx add v w\nn set p0 p1 x\nret n\nend\nfn rd${n} u32 u32 u32x${n} -> u32\ne get p2 p1\nh add p0 e\nret h\nend`;
  const chain = (name: string, n: number, tailOps: string): string =>
    `fn ${name} u32 u32 -> u32\nz arr ${zeros(n)}\na fold pf${n} ${n} z p0 p1\nz2 arr ${zeros(n)}\nb fold ps${n} ${n} z2 a\nz3 arr ${zeros(n)}\nc fold pg${n} ${n} z3 b p1\nq and p1 ${n - 1}\nr get c q\nw get c ${n - 1}\nx get c 0\ns add r w\nt xor s x\n${tailOps}\nend`;
  const src = [
    stage(16),
    stage(12),
    chain('pipe16', 16, 'ret t'),
    // the middle array is read directly as well as by the next stage
    chain('pipe12', 12, 'y get b p0\nu add t y\nret u'),
    // the first array is summed by a fold, so it is stored; the stages after it are not
    chain('pipe16s', 16, 'y fold rd16 16 t a\nret y'),
    // the last array is summed too: nothing is lazy beyond it
    chain('pipe16t', 16, 'y fold rd16 16 t c\nret y'),
  ].join('\n\n');
  const asm = await checkAgainstInterpreter(src, ['pipe16', 'pipe12', 'pipe16s', 'pipe16t'], clang);
  const lazy = /_a0_pipe16:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '';
  assert.doesNotMatch(lazy, /La0_pipe16_\d+:/);
  assert.doesNotMatch(lazy, /sub sp/);
});

test('arm64 fills that are only indexed are never stored', {
  skip: ARM64_HOST ? false : 'needs macOS on Apple silicon',
}, async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  const fill = (name: string, n: number): string =>
    `fn ${name} u32x${n} u32 u32 u32 -> u32x${n}\nv mul p1 p2\nw xor v p3\nx shr w 3\nn set p0 p1 x\nret n\nend`;
  const src = [
    fill('lf12', 12),
    fill('lf16', 16),
    // every element written, indexed by a variable, a literal, and out of range
    `fn lazy12 u32 u32 -> u32\nz arr ${zeros(12)}\na fold lf12 12 z p0 p1\nx get a p1\ny get a 11\nw get a 3\nq add p0 p1\nu get a q\ns add x y\nt xor s w\nr add t u\nret r\nend`,
    `fn lazy16 u32 u32 -> u32\nz arr ${zeros(16)}\na fold lf16 16 z p0 p1\nx get a p1\ny get a 15\ns add x y\nret s\nend`,
    // fewer trips than elements: the tail still holds the initial zeros, so the array is stored
    `fn part16 u32 u32 -> u32\nz arr ${zeros(16)}\na fold lf16 8 z p0 p1\nx get a p1\ny get a 15\nw get a 7\ns add x y\nt add s w\nret t\nend`,
  ].join('\n\n');
  const asm = await checkAgainstInterpreter(src, ['lazy12', 'lazy16', 'part16'], clang);
  const lazy = /_a0_lazy16:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '';
  assert.doesNotMatch(lazy, /sub sp/);
  assert.doesNotMatch(lazy, /La0_lazy16_\d+:/);
  const part = /_a0_part16:[\s\S]*?\n\tret\n/.exec(asm)?.[0] ?? '';
  assert.match(part, /sub sp/);
});
