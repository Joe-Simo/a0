import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assembleArm64Text, logicalImmediate } from '../src/arm64enc.js';
import { IMPORTS, linkMachO, machOLayout, TEXT_OFFSET } from '../src/macho.js';

const one = (line: string): number => assembleArm64Text(`\t${line}\n`).words[0] as number;

test('arm64enc encodes the emitters instruction forms (words from clang -c)', () => {
  const cases: [string, number][] = [
    ['ret', 0xd65f03c0],
    ['stp x29, x30, [sp, #-16]!', 0xa9bf7bfd],
    ['ldp x29, x30, [sp], #16', 0xa8c17bfd],
    ['mov x29, sp', 0x910003fd],
    ['mov x0, x13', 0xaa0d03e0],
    ['ldr x9, [x21, #8]', 0xf94006a9],
    ['str w11, [x13]', 0xb90001ab],
    ['ldr w13, [x12, w14, uxtw #2]', 0xb86e598d],
    ['movz w10, #65535', 0x529fffea],
    ['movk x13, #1, lsl #16', 0xf2a0002d],
    ['sub sp, sp, x16', 0xcb3063ff],
    ['add x13, x12, x13', 0x8b0d018d],
    ['cmp w9, #0', 0x7100013f],
    ['csel x12, x10, x11, ne', 0x9a8b114c],
    ['cset w12, eq', 0x1a9f17ec],
    ['udiv w13, w10, w11', 0x1acb094d],
    ['msub w10, w13, w11, w10', 0x1b0ba9aa],
    ['umaddl x13, w10, w11, x9', 0x9bab254d],
    ['and w10, w1, #255', 0x12001c2a],
    ['lsr w2, w1, #8', 0x53087c22],
    ['movi v16.2d, #0', 0x6f00e410],
  ];
  for (const [line, word] of cases) assert.equal(one(line), word, line);
});

test('arm64enc resolves labels and leaves external references as relocations', () => {
  const m = assembleArm64Text(
    '_f:\n1:\tb 2f\n\tb.hs 1b\n2:\tbl _g\n\tadrp x9, _v@PAGE\n\t.zerofill __DATA,__bss,_v,16,4\n',
  );
  assert.deepEqual(m.words, [0x14000002, 0x54ffffe2, 0x94000000, 0x90000009]);
  assert.deepEqual(
    m.relocations.map((r) => [r.offset, r.kind, r.symbol]),
    [
      [8, 'branch26', '_g'],
      [12, 'page21', '_v'],
    ],
  );
  assert.equal(m.bssSize, 16);
  assert.throws(() => assembleArm64Text('\tfrob x0\n'), /line 1: unknown instruction/);
  assert.equal(logicalImmediate(0x80000000n, 32), 0x040);
  assert.equal(logicalImmediate(0n, 32), undefined);
});

test('macho writes a signed executable whose page hashes cover the file', () => {
  const m = assembleArm64Text('_main:\n\tbl _write\n\tret\n\t.zerofill __DATA,__bss,_b,8,4\n');
  const exe = linkMachO(m, '_main');
  const L = machOLayout(8, 8);
  assert.equal(exe.length, L.fileSize);
  assert.equal(exe.readUInt32LE(0), 0xfeedfacf);
  // bl to the _write stub
  const stub = L.stubsOffset + 12 * IMPORTS.indexOf('_write');
  assert.equal(exe.readUInt32LE(TEXT_OFFSET), (0x94000000 | ((stub - TEXT_OFFSET) / 4)) >>> 0);
  const cd = L.signatureOffset + 20;
  assert.equal(exe.readUInt32BE(cd), 0xfade0c02);
  assert.equal(exe.readUInt32BE(cd + 28), L.pages);
  const hashAt = cd + exe.readUInt32BE(cd + 16);
  for (let p = 0; p < L.pages; p += 1) {
    const page = exe.subarray(p * 4096, Math.min((p + 1) * 4096, L.signatureOffset));
    assert.deepEqual(
      exe.subarray(hashAt + 32 * p, hashAt + 32 * p + 32),
      createHash('sha256').update(page).digest(),
    );
  }
});
