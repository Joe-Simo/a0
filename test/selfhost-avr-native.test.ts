import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { findClang, runTool } from '../src/toolchain.js';
import { NATIVE_PORT_PURE_SOURCE, nativePortPureCases } from './fixtures/native-ports/semantic.js';
import {
  buildNativeSourceCompiler,
  type NativeSourceCompiler,
} from './helpers/native-source-compiler.js';
import { assertSourcePacketBoundaries } from './helpers/source-packet-boundaries.js';

interface AvrModel {
  readonly mem: Buffer;
  readonly r: Uint8Array;
  readonly instructions: number;
  readonly relocations: readonly { type: number }[];
  call(
    name: string,
    args: readonly (number | boolean)[],
    types?: readonly number[],
    options?: { sret: number },
  ): number;
}
interface ModelModule {
  readonly AVR: new (object: Buffer) => AvrModel;
  verifyModel(): unknown;
}
async function model(): Promise<ModelModule> {
  return import(pathToFileURL(resolve('test/fixtures/native-ports/avr-model.mjs')).href);
}
const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
let scratch: string | undefined;
let prepared: Promise<NativeSourceCompiler> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});
function prepare(): Promise<NativeSourceCompiler> {
  prepared ??= (async () => {
    scratch = await mkdtemp(join(tmpdir(), 'a0-avr-source-'));
    return buildNativeSourceCompiler({
      module: 'compiler/emit_avr.a0',
      entry: 'emitavrio',
      dir: scratch,
      clang,
    });
  })();
  return prepared;
}
const AVR_ABI_SOURCE = `fn avr_mix u32 bool u32 bool u32 bool u32 bool u32 -> u32
v0 mul p0 1
v1 select p1 2 0
v2 mul p2 3
v3 select p3 4 0
v4 mul p4 5
v5 select p5 6 0
v6 mul p6 7
v7 select p7 8 0
v8 mul p8 9
s0 add v0 v1
s1 add s0 v2
s2 add s1 v3
s3 add s2 v4
s4 add s3 v5
s5 add s4 v6
s6 add s5 v7
s7 add s6 v8
ret s7
end
fn avr_pack u32x3 u32 bool u32 u32 u32 u32 u32 -> (u32x3,u32,bool)
a set p0 p1 p7
s0 add p3 p4
s1 add p5 p6
s2 add s0 s1
s3 add s2 p1
out rec a s3 p2
ret out
end
fn avr_bool bool bool u32 -> (bool,u32,bool)
a rec p0 p2 p1
b put a 1 4294967295
ret b
end
fn avr_text u32 -> u32
a text "Aé😀"
x get a p0
ret x
end
`;

test('avr independent decoder matches fixed instruction and carry vectors', async () => {
  (await model()).verifyModel();
});

test('seed-built A0 avr source packets enforce framing, device limits and explicit refusals', {
  skip,
}, async () => {
  const compiler = await prepare();
  assertSourcePacketBoundaries(compiler);
  for (const source of [
    'profile strict\nfn f -> u32\nret 0\nend\n',
    'fn f io -> u32\nw write p0 3\nret 0\nend\n',
    'fn f (u32,io) -> u32\nx at p0 0\nret x\nend\n',
  ]) {
    const got = compiler.runSource(source);
    assert.equal(got.code, 2);
    assert.equal(got.text, '');
  }
  for (const [n, code] of [
    [255, 0],
    [256, 4],
  ] as const) {
    const got = compiler.runSource(`fn f boolx${n} -> u32\nret 0\nend\n`);
    assert.equal(got.code, code);
    if (code === 4) assert.equal(got.text, '');
  }
  for (const [n, code] of [
    [252, 0],
    [253, 4],
  ] as const) {
    const source =
      'fn f u32 -> u32\n' +
      Array.from({ length: n }, (_, i) => `v${i} add ${i === 0 ? 'p0' : `v${i - 1}`} 1\n`).join(
        '',
      ) +
      `ret v${n - 1}\nend\n`;
    const got = compiler.runSource(source);
    assert.equal(got.code, code);
    if (code === 4) assert.equal(got.text, '');
  }
});

test('seed-built A0 avr object bytes preserve independent scalar, checked, aggregate and avr-gcc ABI semantics', {
  skip,
}, async (t) => {
  const compiler = await prepare();
  assert.ok(scratch);
  assert.ok(clang.path);
  const assembly = join(scratch, 'module.s'),
    object = join(scratch, 'program.o');
  // Probe a fixed program, so missing AVR assembly support is distinct from an emitter failure.
  await writeFile(assembly, '.text\n.global probe\nprobe:\nldi r24,7\nret\n');
  const args = ['--target=avr', '-mmcu=atmega328p', '-c', assembly, '-o', object];
  const probe = runTool(clang.path, args, { timeoutMs: 60_000 });
  if (!probe.ok) {
    t.skip(`clang AVR assembler unavailable: ${probe.stderr.split('\n')[0]}`);
    return;
  }
  const emitted = compiler.runSource(NATIVE_PORT_PURE_SOURCE + AVR_ABI_SOURCE);
  assert.equal(emitted.code, 0, emitted.stderr);
  await writeFile(assembly, emitted.text);
  const built = runTool(clang.path, args, { timeoutMs: 60_000 });
  assert.ok(built.ok, built.stderr);
  const cpu = new (await model()).AVR(await readFile(object));
  const cases = nativePortPureCases();
  assert.ok(cases.length > 3000);
  for (const item of cases) {
    const actual = cpu.call(
      `a0_${item.functionName}`,
      item.args.map((value) => {
        assert.ok(typeof value === 'number' || typeof value === 'boolean');
        return value;
      }),
      item.args.map((value) => (typeof value === 'boolean' ? 2 : 1)),
    );
    assert.equal(
      typeof item.expected === 'boolean' ? cpu.r[24] : actual,
      Number(item.expected),
      item.functionName,
    );
  }
  assert.equal(
    cpu.call(
      'a0_avr_mix',
      [0xffffffff, true, 3, false, 5, true, 7, true, 9],
      [1, 2, 1, 2, 1, 2, 1, 2, 1],
    ),
    179,
  );
  const ptr = 0x180;
  [11, 12, 13].forEach((value, i) => {
    cpu.mem.writeUInt32LE(value, ptr + i * 4);
  });
  cpu.call('a0_avr_pack', [ptr, 4, true, 17, 19, 23, 29, 77], [4, 1, 2, 1, 1, 1, 1, 1], {
    sret: ptr,
  });
  assert.deepEqual(
    [
      cpu.mem.readUInt32LE(ptr),
      cpu.mem.readUInt32LE(ptr + 4),
      cpu.mem.readUInt32LE(ptr + 8),
      cpu.mem.readUInt32LE(ptr + 12),
      cpu.mem[ptr + 16],
    ],
    [11, 77, 13, 92, 1],
  );
  cpu.call('a0_avr_bool', [true, false, 17], [2, 2, 1], { sret: ptr });
  assert.equal(cpu.mem[ptr], 1);
  assert.equal(cpu.mem.readUInt32LE(ptr + 1), 0xffffffff);
  assert.equal(cpu.mem[ptr + 5], 0);
  [65, 195, 169, 240, 159, 152, 128].forEach((value, i) => {
    assert.equal(cpu.call('a0_avr_text', [i]), value);
  });
  assert.ok(cpu.relocations.length > 0);
  assert.ok(cpu.instructions > 1000);
  // Every helper runs through the decoder. This is model execution, not AVR hardware or QEMU.
});
