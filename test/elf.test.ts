import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildElf, ELF_BASE, ELF_CODE_OFFSET, helloElf } from '../src/elf.js';
import { runTool } from '../src/toolchain.js';

const u16 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;
const u64 = (b: Uint8Array, at: number): number => u32(b, at) + u32(b, at + 4) * 0x100000000;

/** The structure the Linux kernel checks before it runs a static executable. */
function check(exe: Uint8Array, machine: number): void {
  assert.deepEqual([...exe.slice(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
  assert.equal(exe[4], 2); // 64-bit
  assert.equal(exe[5], 1); // little endian
  assert.equal(u16(exe, 16), 2); // executable
  assert.equal(u16(exe, 18), machine);
  const entry = u64(exe, 24);
  const phoff = u64(exe, 32);
  const phentsize = u16(exe, 54);
  const phnum = u16(exe, 56);
  assert.equal(phentsize, 56);
  let entryMapped = false;
  for (let i = 0; i < phnum; i += 1) {
    const p: number = phoff + i * phentsize;
    assert.equal(u32(exe, p), 1); // PT_LOAD
    const offset = u64(exe, p + 8);
    const vaddr = u64(exe, p + 16);
    const filesz = u64(exe, p + 32);
    const memsz = u64(exe, p + 40);
    const align = u64(exe, p + 48);
    assert.ok(filesz <= memsz);
    assert.ok(offset + filesz <= exe.length);
    assert.equal(
      (vaddr - offset) % align,
      0,
      'offset and address are congruent modulo the alignment',
    );
    if (entry >= vaddr && entry < vaddr + filesz && (u32(exe, p + 4) & 1) === 1) entryMapped = true;
  }
  assert.ok(entryMapped, 'the entry point lies in an executable segment');
}

test('elf: x86-64 and aarch64 programs have the structure the kernel requires', () => {
  check(helloElf('x86_64', 'hi\n'), 62);
  check(helloElf('aarch64', 'hi\n'), 183);
  const withBss = buildElf({
    machine: 'x86_64',
    code: Uint8Array.from([0xc3]),
    entry: 0,
    bss: 4096,
  });
  check(withBss, 62);
  assert.equal(u64(withBss, 24), ELF_BASE + ELF_CODE_OFFSET);
});

test('elf: an entry point outside the code is an error', () => {
  assert.throws(
    () => buildElf({ machine: 'x86_64', code: Uint8Array.from([0xc3]), entry: 1 }),
    /outside the code/,
  );
});

const READELF = ['C:\\msys64\\mingw64\\bin\\readelf.exe', '/usr/bin/readelf'].find((p) =>
  existsSync(p),
);

test('elf: readelf reads the headers of both programs', {
  skip: READELF === undefined ? 'readelf is not installed' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-elf-'));
  try {
    for (const [machine, text] of [
      ['x86_64', 'Advanced Micro Devices X86-64'],
      ['aarch64', 'AArch64'],
    ] as const) {
      const file = join(dir, `hello-${machine}`);
      writeFileSync(file, helloElf(machine, 'hello\n'));
      const r = runTool(READELF as string, ['-h', '-l', file]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(text));
      assert.match(r.stdout, /Type:\s+EXEC/);
      assert.match(r.stdout, /LOAD/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
