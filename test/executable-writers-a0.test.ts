import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { buildPe } from '../src/pe.js';
import { findClang, runTool } from '../src/toolchain.js';
import { buildStage, emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { readBootstrapSeed } from '../tools/seed.js';

// The TS frontend serializes/links this component's bootstrap source only. Executable bytes
// are chosen by native A0; the PE reference callback below is an independent test oracle.
const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/executable-writers');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
let serial = 0;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-executable-writers-'));
    scratch = dir;
    const seed = await readBootstrapSeed();
    const [exe] = await buildStage(clang, 'compiler', seed.c, 'emitchunkio', dir);
    const program = (await link(join(fixtures, 'probe.a0'), (p) => readFile(p, 'utf8'))).program;
    const emitted = emitChunked(formatProgram(program), (c, b) => runStageChunk(exe, c, b));
    assert.equal(emitted.code, 0, `native A0 emission of ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const type = (name: string): string => {
      const found = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(found, name);
      return found;
    };
    const result = type('elf_build');
    const decl = emitted.text.split('\n').find((line) => line.endsWith(` ${result};`));
    const vector = decl === undefined ? undefined : / (a0t\d+) f1;/.exec(decl)?.[1];
    assert.ok(vector);
    const names = [
      'elf_build',
      'elf_build64',
      'pe_prepare',
      'pe_find_iat',
      'pe_build',
      'ew_emit',
      'arena_hello',
      'arena_finish',
    ];
    await writeFile(
      join(dir, 'api.h'),
      `${[
        ...names.map((name) => `#define ${name.toUpperCase()}_RESULT ${type(name)}`),
        `#define BYTE_RESULT ${result}`,
        `#define VECTOR_TYPE ${vector}`,
        `#define LOAD_RESULT ${type('av_load')}`,
        `#define WORD_PAGE ${type('arena_zero')}`,
        `#define SIMPLE_RESULT ${type('arena_finish')}`,
      ].join('\n')}\n`,
    );
    for (const level of [0, 2]) {
      for (const name of ['elf-driver', 'elf-api', 'pe-driver', 'pe-api']) {
        const built = runTool(
          clang.path,
          [
            '-std=c11',
            `-O${level}`,
            '-Wall',
            '-Wextra',
            '-Wno-unused-parameter',
            '-Werror',
            '-fsanitize=undefined',
            '-fno-sanitize-recover=all',
            '-I',
            dir,
            '-I',
            runtime,
            join(fixtures, `${name}.c`),
            join(runtime, 'arena_runtime.c'),
            '-o',
            join(dir, `${name}-${level}`),
          ],
          { cwd: dir, timeoutMs: 120_000 },
        );
        assert.ok(built.ok, `${name} O${level}: ${built.stderr}`);
      }
    }
    return dir;
  })();
  return prepared;
}

interface Status {
  status: number;
  complete: boolean;
  published: boolean;
  resultHandle: number;
  resultLength: number;
  outputCount: number;
  allocatedWords: number;
  ioUnchanged: boolean;
  iat?: number;
}
async function invoke(dir: string, name: string, level: number, args: string[]): Promise<Status> {
  const result = runTool(join(dir, `${name}-${level}`), args, { timeoutMs: 120_000 });
  assert.ok(result.status === 0 || result.status === 20, result.stderr);
  const status = JSON.parse(result.stderr) as Status;
  assert.ok(status.complete && status.ioUnchanged, result.stderr);
  assert.equal(status.allocatedWords, 0);
  assert.equal(result.status === 0, status.status === 0, result.stderr);
  return status;
}
async function output(path: string, status: Status): Promise<Buffer | undefined> {
  if (status.status === 0) {
    assert.ok(status.published);
    const bytes = await readFile(path);
    assert.equal(bytes.length, status.resultLength);
    return bytes;
  }
  assert.equal(status.published, false);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  return undefined;
}
async function elf(
  dir: string,
  level: number,
  code: Uint8Array,
  machine = 62,
  entry = 0,
  bss = 0n,
  budget = 10_000_000,
  maxout = 5_000_000,
) {
  const id = serial++;
  const input = join(dir, `elf-${id}.code`),
    file = join(dir, `elf-${id}.exe`);
  await writeFile(input, code);
  const status = await invoke(dir, 'elf-driver', level, [
    input,
    file,
    String(machine),
    String(entry),
    String(Number(bss & 0xffffffffn)),
    String(budget),
    String(maxout),
    String(Number(bss >> 32n)),
  ]);
  return { status, bytes: await output(file, status), file };
}

// Independent ELF constructor and parser: no import from src/elf.ts or A0 writer helpers.
function elfOracle(code: Uint8Array, machine: number, entry: number, bss: bigint): Buffer {
  const size = 256 + code.length;
  const b = Buffer.alloc(size);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  b.writeUInt16LE(2, 16);
  b.writeUInt16LE(machine, 18);
  b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(0x400100n + BigInt(entry), 24);
  b.writeBigUInt64LE(64n, 32);
  b.writeUInt16LE(64, 52);
  b.writeUInt16LE(56, 54);
  b.writeUInt16LE(bss === 0n ? 1 : 2, 56);
  const segment = (
    at: number,
    flags: number,
    offset: bigint,
    address: bigint,
    filesz: bigint,
    memsz: bigint,
  ): void => {
    b.writeUInt32LE(1, at);
    b.writeUInt32LE(flags, at + 4);
    for (const [i, n] of [offset, address, address, filesz, memsz, 4096n].entries())
      b.writeBigUInt64LE(n, at + 8 + i * 8);
  };
  segment(64, 5, 0n, 0x400000n, BigInt(size), BigInt(size));
  if (bss > 0n) {
    const address = 0x400000n + BigInt(Math.ceil(size / 4096) * 4096 + 4096 + (size % 4096));
    segment(120, 6, BigInt(size), address, 0n, bss);
  }
  b.set(code, 256);
  return b;
}
function checkElf(bytes: Buffer, code: Uint8Array, entry: number, bss: bigint): void {
  assert.equal(bytes.length, 256 + code.length);
  assert.deepEqual(bytes.subarray(256), Buffer.from(code));
  assert.equal(bytes.readBigUInt64LE(24), 0x400100n + BigInt(entry));
  let entryMapped = false;
  const phnum = bytes.readUInt16LE(56);
  assert.equal(phnum, bss === 0n ? 1 : 2);
  for (let i = 0; i < phnum; i++) {
    const at = 64 + i * 56,
      flags = bytes.readUInt32LE(at + 4);
    const offset = bytes.readBigUInt64LE(at + 8),
      address = bytes.readBigUInt64LE(at + 16);
    const file = bytes.readBigUInt64LE(at + 32),
      memory = bytes.readBigUInt64LE(at + 40),
      align = bytes.readBigUInt64LE(at + 48);
    assert.equal(bytes.readUInt32LE(at), 1);
    assert.equal(flags, i === 0 ? 5 : 6);
    assert.equal(bytes.readBigUInt64LE(at + 24), address);
    assert.ok(file <= memory && offset + file <= BigInt(bytes.length));
    assert.equal((address - offset) % align, 0n);
    const start = bytes.readBigUInt64LE(24);
    if ((flags & 1) !== 0 && start >= address && start < address + file) entryMapped = true;
    if (i === 1) assert.equal(memory, bss);
  }
  if (code.length > 0) assert.ok(entryMapped);
}

test('native A0 ELF bytes, mappings, ranges and resource failures obey independent oracles', {
  skip,
  timeout: 120_000,
}, async () => {
  const dir = await prepare();
  for (const level of [0, 2]) {
    for (const machine of [62, 183]) {
      for (const n of [0, 1, 127, 128, 129, 4095, 4096, 4097, 262145]) {
        const code = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 13) & 255);
        for (const bss of [0n, 1n, 4096n, 0xffffffffn, 0x100000000n, 0x1fffffffffffffn]) {
          const entry = Math.max(0, n - 1),
            result = await elf(dir, level, code, machine, entry, bss);
          assert.equal(result.status.status, 0);
          assert.deepEqual(result.bytes, elfOracle(code, machine, entry, bss));
          checkElf(result.bytes as Buffer, code, entry, bss);
        }
      }
    }
    for (const [code, machine, entry, budget, maxout, expected] of [
      [Uint8Array.of(1), 0, 0, 1000, 1000, 6],
      [Uint8Array.of(1), 62, 1, 1000, 1000, 6],
      [new Uint8Array(), 62, 1, 1000, 1000, 6],
      [Uint8Array.of(1), 62, 0, 256, 1000, 4],
      [Uint8Array.of(1), 62, 0, 1000, 100, 4],
    ] as const) {
      const result = await elf(dir, level, code, machine, entry, 0n, budget, maxout);
      assert.equal(result.status.status, expected);
      assert.equal(result.bytes, undefined);
      if (expected === 6) assert.equal(result.status.resultHandle, 0);
    }
  }
});

test('native A0 ELF starts at its entry and provides zero-filled writable BSS on Linux x86-64', {
  timeout: 120_000,
  skip:
    skip ||
    (process.platform !== 'linux' || process.arch !== 'x64'
      ? 'requires a Linux x86-64 kernel'
      : false),
}, async () => {
  const dir = await prepare();
  const exit7 = Buffer.from('b83c000000bf070000000f05', 'hex');
  for (const level of [0, 2]) {
    for (const bss of [0n, 4096n]) {
      const result = await elf(dir, level, exit7, 62, 0, bss);
      assert.equal(result.status.status, 0);
      await chmod(result.file, 0o700);
      const ran = runTool(result.file, [], { timeoutMs: 10_000 });
      assert.equal(ran.status, 7, ran.stderr);
    }
    // movabs rsi,BSS; load zero byte; add7; store to BSS; exit with the loaded+7 value.
    const code = Buffer.from('48be00000000000000000fb63e83c70740883eb83c0000000f05', 'hex');
    const size = 256 + code.length;
    const address = 0x400000n + BigInt(Math.ceil(size / 4096) * 4096 + 4096 + (size % 4096));
    code.writeBigUInt64LE(address, 2);
    const result = await elf(dir, level, code, 62, 0, 4096n);
    assert.equal(result.status.status, 0);
    await chmod(result.file, 0o700);
    assert.equal(runTool(result.file, [], { timeoutMs: 10_000 }).status, 7);
  }
});

async function pe(
  dir: string,
  level: number,
  text: Uint8Array,
  names: string[],
  query = '',
  declared = text.length,
  entry = 0,
  budget = 20_000_000,
  maxout = 10_000_000,
  override?: number[],
) {
  const id = serial++,
    data = Buffer.concat(names.map((name) => Buffer.from(name, 'latin1')));
  let off = 0;
  const spans =
    override ??
    names.flatMap((name) => {
      const span = [off, name.length];
      off += name.length;
      return span;
    });
  const sb = Buffer.alloc(spans.length * 4);
  spans.forEach((value, i) => {
    sb.writeUInt32LE(value >>> 0, i * 4);
  });
  const input = join(dir, `pe-${id}.text`),
    nameFile = join(dir, `pe-${id}.names`);
  const spanFile = join(dir, `pe-${id}.spans`),
    queryFile = join(dir, `pe-${id}.query`),
    file = join(dir, `pe-${id}.exe`);
  await Promise.all([
    writeFile(input, text),
    writeFile(nameFile, data),
    writeFile(spanFile, sb),
    writeFile(queryFile, Buffer.from(query, 'latin1')),
  ]);
  const status = await invoke(dir, 'pe-driver', level, [
    input,
    nameFile,
    spanFile,
    queryFile,
    file,
    String(declared),
    String(entry),
    String(budget),
    String(maxout),
  ]);
  return { status, bytes: await output(file, status) };
}

// Parse the emitted PE independently of src/pe.ts and the A0 implementation.
function checkPe(b: Buffer, text: Uint8Array, names: string[], entry: number): void {
  assert.equal(b.readUInt16LE(0), 0x5a4d);
  const pe = b.readUInt32LE(60);
  assert.equal(b.readUInt32LE(pe), 0x4550);
  assert.equal(b.readUInt16LE(pe + 4), 0x8664);
  assert.equal(b.readUInt16LE(pe + 6), 2);
  assert.equal(b.readUInt16LE(pe + 22), 0x22);
  const op = pe + 24;
  assert.equal(b.readUInt16LE(op), 0x20b);
  assert.equal(b.readBigUInt64LE(op + 24), 0x140000000n);
  assert.equal(b.readUInt32LE(op + 16), 4096 + entry);
  assert.equal(b.readUInt32LE(op + 32), 4096);
  assert.equal(b.readUInt32LE(op + 36), 512);
  assert.equal(b.readUInt16LE(op + 68), 3);
  const st = op + b.readUInt16LE(pe + 20);
  const sections: { name: string; vsize: number; rva: number; size: number; ptr: number }[] = [];
  for (let i = 0; i < 2; i++) {
    const s = st + i * 40,
      name = b
        .subarray(s, s + 8)
        .toString('latin1')
        .replace(/\0+$/, '');
    const vsize = b.readUInt32LE(s + 8),
      rva = b.readUInt32LE(s + 12),
      size = b.readUInt32LE(s + 16),
      ptr = b.readUInt32LE(s + 20);
    assert.equal(size % 512, 0);
    assert.equal(ptr % 512, 0);
    assert.equal(rva % 4096, 0);
    assert.ok(ptr + size <= b.length);
    assert.equal(b.readUInt32LE(s + 36), i === 0 ? 0x60000020 : 0xc0000040);
    sections.push({ name, vsize, rva, size, ptr });
  }
  assert.deepEqual(
    sections.map((s) => s.name),
    ['.text', '.idata'],
  );
  const code = sections[0],
    data = sections[1];
  assert.ok(code && data);
  assert.equal(code.vsize, text.length);
  assert.deepEqual(b.subarray(code.ptr, code.ptr + text.length), Buffer.from(text));
  const fileOffset = (rva: number): number => {
    assert.ok(rva >= data.rva && rva < data.rva + data.vsize);
    return data.ptr + rva - data.rva;
  };
  assert.equal(b.readUInt32LE(op + 120), data.rva);
  assert.equal(b.readUInt32LE(op + 124), data.vsize);
  const ilt = b.readUInt32LE(data.ptr),
    iat = b.readUInt32LE(data.ptr + 16),
    dll = b.readUInt32LE(data.ptr + 12);
  assert.equal(
    b.subarray(fileOffset(dll), fileOffset(dll) + 13).toString('latin1'),
    'KERNEL32.dll\0',
  );
  assert.deepEqual(b.subarray(data.ptr + 20, data.ptr + 40), Buffer.alloc(20));
  const stringAt = (at: number): string => {
    const end = b.indexOf(0, at);
    assert.ok(end >= at);
    return b.subarray(at, end).toString('latin1');
  };
  for (let i = 0; i < names.length; i++) {
    const target = b.readBigUInt64LE(fileOffset(ilt) + 8 * i);
    assert.equal(b.readBigUInt64LE(fileOffset(iat) + 8 * i), target);
    const hint = fileOffset(Number(target));
    assert.equal(b.readUInt16LE(hint), 0);
    assert.equal(stringAt(hint + 2), names[i]);
  }
  assert.equal(b.readBigUInt64LE(fileOffset(ilt) + 8 * names.length), 0n);
  assert.equal(b.readBigUInt64LE(fileOffset(iat) + 8 * names.length), 0n);
  assert.equal(b.readUInt32LE(op + 56), data.rva + Math.ceil(data.vsize / 4096) * 4096);
}

test('native A0 PE bytes, imports, duplicate lookup and phase failures preserve the reference', {
  skip,
  timeout: 120_000,
}, async () => {
  const dir = await prepare();
  for (const level of [0, 2]) {
    for (const n of [0, 1, 511, 512, 513, 4095, 4096, 4097, 262145]) {
      const text = Uint8Array.from({ length: n }, (_, i) => (i * 17 + 29) & 255);
      for (const names of [
        [],
        ['ExitProcess'],
        ['GetStdHandle', 'WriteFile', 'ExitProcess'],
        ['Dup', 'Dup'],
        ['A', 'AA', 'A'],
        ['\xffname', 'plain'],
      ]) {
        const query = names[0] ?? '',
          entry = Math.max(0, n - 1),
          result = await pe(dir, level, text, names, query, n, entry);
        assert.equal(result.status.status, 0);
        assert.ok(result.bytes);
        assert.deepEqual(
          result.bytes,
          Buffer.from(buildPe({ imports: names, entry, text: () => text })),
        );
        checkPe(result.bytes, text, names, entry);
        if (query !== '') {
          const idataRva = 4096 + Math.ceil(n / 4096) * 4096,
            iatRva = idataRva + 40 + 8 * (names.length + 1);
          assert.equal(result.status.iat, iatRva + 8 * names.lastIndexOf(query));
        }
      }
    }
    for (const names of [
      Array.from({ length: 257 }, (_, i) => `Fn${i}`),
      ['A'.repeat(131073)],
      ['A', 'A'.repeat(129), 'A'],
    ]) {
      const text = Uint8Array.of(0xc3),
        result = await pe(dir, level, text, names, names[names.length - 1]);
      assert.equal(result.status.status, 0);
      assert.ok(result.bytes);
      assert.deepEqual(
        result.bytes,
        Buffer.from(buildPe({ imports: names, entry: 0, text: () => text })),
      );
      checkPe(result.bytes, text, names, 0);
    }
    for (const [text, names, query, declared, entry, budget, maxout, spans, expected] of [
      [Uint8Array.of(0xc3), ['ExitProcess'], 'Missing', 1, 0, 10000, 10000, undefined, 6],
      [Uint8Array.of(0xc3), [], '', 2, 0, 10000, 10000, undefined, 6],
      [Uint8Array.of(0xc3), [], '', 1, 1, 10000, 10000, undefined, 6],
      [new Uint8Array(), [], '', 0, 1, 10000, 10000, undefined, 6],
      [Uint8Array.of(0xc3), ['A'], '', 1, 0, 10000, 10000, [0], 6],
      [Uint8Array.of(0xc3), ['A'], '', 1, 0, 10000, 10000, [1, 1], 6],
      [Uint8Array.of(0xc3), [], '', 4294959105, 0, 10000, 10000, undefined, 7],
      [Uint8Array.of(0xc3), [], '', 1, 0, 10, 10000, undefined, 4],
      [Uint8Array.of(0xc3), [], '', 1, 0, 10000, 100, undefined, 4],
    ] as const) {
      const result = await pe(
        dir,
        level,
        text,
        [...names],
        query,
        declared,
        entry,
        budget,
        maxout,
        spans === undefined ? undefined : [...spans],
      );
      assert.equal(result.status.status, expected);
      assert.equal(result.bytes, undefined);
    }
  }
});

test('native A0 executable API rejects malformed views and preserves u64 carries and phase fields', {
  skip,
  timeout: 120_000,
}, async () => {
  const dir = await prepare();
  for (const level of [0, 2]) {
    for (const name of ['elf-api', 'pe-api']) {
      const ran = runTool(join(dir, `${name}-${level}`), [], { timeoutMs: 120_000 });
      assert.ok(ran.ok, `${name} O${level}: ${ran.stderr}`);
      assert.match(ran.stdout, /passed/);
    }
  }
});
