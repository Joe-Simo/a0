import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPe, helloPe } from '../src/pe.js';
import { runTool } from '../src/toolchain.js';

const u16 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

test('pe: the headers of the smallest program are well formed', () => {
  const exe = helloPe('hi\n');
  assert.equal(String.fromCharCode(exe[0] as number, exe[1] as number), 'MZ');
  const pe = u32(exe, 0x3c);
  assert.equal(pe, 0x40);
  assert.equal(u32(exe, pe), 0x4550); // PE\0\0
  assert.equal(u16(exe, pe + 4), 0x8664); // x86-64
  assert.equal(u16(exe, pe + 6), 2); // sections
  const opt = pe + 24;
  assert.equal(u16(exe, opt), 0x20b); // PE32+
  const sizeOfImage = u32(exe, opt + 56);
  assert.equal(sizeOfImage % 0x1000, 0);
  assert.equal(u32(exe, opt + 36), 0x200); // file alignment
  // every raw section lies inside the file and the file is a multiple of the file alignment
  assert.equal(exe.length % 0x200, 0);
  const sections = pe + 24 + u16(exe, pe + 20);
  for (let i = 0; i < 2; i += 1) {
    const s = sections + i * 40;
    assert.ok(u32(exe, s + 20) + u32(exe, s + 16) <= exe.length);
  }
  // the entry point lies inside .text
  const entry = u32(exe, opt + 16);
  const textRva = u32(exe, sections + 12);
  assert.ok(entry >= textRva && entry < textRva + u32(exe, sections + 8));
});

test('pe: an import that was not declared is an error, and the text size must not change', () => {
  assert.throws(
    () =>
      buildPe({
        imports: ['ExitProcess'],
        entry: 0,
        text: (l) => Uint8Array.from([l.iat('Missing') & 0xff]),
      }),
    /not imported/,
  );
  let calls = 0;
  assert.throws(
    () =>
      buildPe({
        imports: ['ExitProcess'],
        entry: 0,
        text: () => {
          calls += 1;
          return new Uint8Array(calls === 1 ? 4 : 8);
        },
      }),
    /changed size/,
  );
});

test('pe: the executable runs on Windows and prints its message', {
  skip: process.platform === 'win32' ? false : 'a Windows executable runs only on Windows',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-pe-'));
  try {
    const exe = join(dir, 'hello.exe');
    writeFileSync(exe, helloPe('hello from a0\n'));
    const r = runTool(exe, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'hello from a0\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
