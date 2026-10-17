import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { buildStage, emitChunked, planChunks, runStageChunk } from '../tools/bootstrap.js';
import { readBootstrapSeed } from '../tools/seed.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
let compiler: string | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-'));
    scratch = dir;
    const seed = await readBootstrapSeed();
    const [exe] = await buildStage(clang, 'compiler', seed.c, 'emitchunkio', dir);
    compiler = exe;
    const program = (await link(join(fixtures, 'probe.a0'), (p) => readFile(p, 'utf8'))).program;
    const emitted = emitChunked(formatProgram(program), (c, b) => runStageChunk(exe, c, b));
    assert.equal(emitted.code, 0, `native A0 compilation of ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const result = (name: string): string => {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      return type;
    };
    const created = result('si_new');
    const header = emitted.text.split('\n').find((line) => line.endsWith(` ${created};`));
    assert.ok(header);
    const symbolHeader = / (a0t\d+) f1;/.exec(header)?.[1];
    assert.ok(symbolHeader);
    await writeFile(
      join(dir, 'api.h'),
      `#define LEX_RESULT ${result('arena_lex')}\n#define NEW_RESULT ${created}\n#define INTERN_RESULT ${result('si_intern')}\n#define HEADER ${symbolHeader}\n`,
    );
    return dir;
  })();
  return prepared;
}

async function driver(name: string, level: number, dir: string): Promise<string> {
  assert.ok(clang.path);
  const source = join(fixtures, `${name}.c`);
  const exe = join(dir, `${name}-${level}`);
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
      source,
      join(runtime, 'arena_runtime.c'),
      '-o',
      exe,
    ],
    { cwd: dir, timeoutMs: 120_000 },
  );
  assert.ok(built.ok, `${name} -O${level}: ${built.stderr}`);
  return exe;
}

function execute(exe: string, args: string[] = []): void {
  const ran = runTool(exe, args, { timeoutMs: 120_000 });
  assert.ok(ran.ok, `${exe}: ${ran.stderr}`);
}

test('arena host framing, atomic errors, budgets and completion obey the independent model', {
  skip,
}, async () => {
  const dir = await prepare();
  for (const level of [0, 2]) execute(await driver('host-test', level, dir));
});

test('native A0 arena storage and checked IO preserve default and hooked transport', {
  skip,
}, async () => {
  const dir = await prepare();
  for (const level of [0, 2])
    for (const name of ['hook-driver', 'buffer-driver']) execute(await driver(name, level, dir));
});

test('native source chunks intern body-only read tuples with scalar public results', {
  skip,
}, async () => {
  await prepare();
  assert.ok(compiler);
  const body = (name: string): string => `fn ${name} io -> u32
r read p0
v at r 0
t at r 1
w write t v
${Array.from({ length: 1399 }, (_, i) => `n${i} add ${i === 0 ? 'v' : `n${i - 1}`} 1`).join('\n')}
ret n1398
end
`;
  const source = body('read_a') + body('read_b');
  assert.ok(!source.includes('(u32,io)'));
  const chunks = planChunks(source);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) assert.ok(chunk.source.includes('(u32,io)'));
  const emitted = emitChunked(source, (c, b) => runStageChunk(compiler as string, c, b));
  assert.equal(emitted.code, 0);
  // The identical packet without the builtin type was the original code5 refusal.
  const missing = {
    ...(chunks[0] as (typeof chunks)[number]),
    source: chunks[0]?.source.replace(' (u32,io)', '') as string,
  };
  assert.equal(
    runStageChunk(
      compiler,
      missing,
      missing.before.map(() => 0),
    ).code,
    5,
  );
});

// Independent direct byte scanner. Only LF is a line break; inline Unicode spaces
// use their exact UTF-8 bytes. Quoted/comment bytes bypass whitespace recognition.
const spaces = [
  9,
  11,
  12,
  13,
  32,
  160,
  5760,
  ...Array.from({ length: 11 }, (_, i) => 8192 + i),
  8232,
  8233,
  8239,
  8287,
  12288,
  65279,
];
const spaceBytes = spaces.map((n) => Buffer.from(String.fromCodePoint(n)));
function tokenOracle(source: Uint8Array): Uint32Array {
  const tokens = new Uint32Array(source.length * 3);
  let count = 0;
  const put = (kind: number, start: number, length: number): void => {
    tokens[count++] = kind;
    tokens[count++] = start;
    tokens[count++] = length;
  };
  const word = (b: number): boolean => (b >= 97 && b <= 122) || (b >= 48 && b <= 57) || b === 95;
  for (let at = 0; at < source.length; ) {
    const b = source[at] as number;
    if (b === 10) {
      put(5, at++, 1);
      continue;
    }
    const whitespace = spaceBytes.find((bytes) => bytes.every((v, i) => source[at + i] === v));
    if (whitespace !== undefined) {
      at += whitespace.length;
      continue;
    }
    if (b === 35) {
      while (at < source.length && source[at] !== 10) at++;
      continue;
    }
    if (word(b)) {
      const start = at++;
      while (at < source.length && word(source[at] as number)) at++;
      put(b >= 48 && b <= 57 ? 2 : 1, start, at - start);
      continue;
    }
    if (b === 34) {
      const start = ++at;
      while (at < source.length && source[at] !== 34) at += source[at] === 92 ? 2 : 1;
      if (at < source.length) {
        put(3, start, at - start);
        at++;
      }
      continue;
    }
    if (b === 45 && source[at + 1] === 62) {
      put(4, at, 2);
      at += 2;
      continue;
    }
    put(b === 45 ? 6 : b === 64 ? 7 : 9, at++, 1);
  }
  return tokens.subarray(0, count);
}

function words(values: Iterable<number>): Buffer {
  const list = Array.from(values);
  const bytes = Buffer.alloc(list.length * 4);
  list.forEach((value, i) => {
    bytes.writeUInt32LE(value >>> 0, i * 4);
  });
  return bytes;
}

test('native A0 lexer preserves full byte spans, page seams, Unicode spaces and source capacity', {
  skip,
}, async () => {
  const dir = await prepare();
  const small = [
    Buffer.from('fn f u32 -> u32\nx add p0 1 #comment\nret x\nend\n'),
    Buffer.from('"a\\"b" "open'),
    Buffer.from('"line\nbreak"\n'),
    Buffer.from([0xe2, 0x80]),
  ];
  for (const cp of spaces)
    for (const offset of [124, 125, 126, 127])
      small.push(Buffer.from(`${' '.repeat(offset)}a${String.fromCodePoint(cp)}b\n`));
  const large = [32768, 65537, 131073].map((n) => Buffer.from('a'.repeat(n)));
  large.push(
    Buffer.from('x\n'.repeat(20000)),
    Buffer.alloc(2097152, 10),
    Buffer.alloc(2097152, 64),
    Buffer.from(`${' '.repeat(2097151)}a`),
    Buffer.alloc(2097153, 32),
  );
  for (const level of [0, 2]) {
    const exe = await driver('lexer-driver', level, dir);
    for (const source of level === 0 ? small : [...small, ...large]) {
      const status = source.length > 2097152 ? 6 : 0;
      await writeFile(join(dir, 'source.bin'), source);
      await writeFile(
        join(dir, 'tokens.bin'),
        status === 0 ? words(tokenOracle(source)) : Buffer.alloc(0),
      );
      execute(exe, [join(dir, 'source.bin'), join(dir, 'tokens.bin'), String(status)]);
    }
  }
});

test('native A0 symbols retain full fields, resolve full-hash collisions and roll back resource errors', {
  skip,
}, async () => {
  const dir = await prepare();
  const first: Buffer[] = [Buffer.alloc(131073, 32)];
  const second: Buffer[] = [Buffer.alloc(262145, 32)];
  const lengths = [131073, 262145];
  const ids = new Map<string, number>();
  const rows: number[][] = [];
  const keys = [
    Buffer.alloc(0),
    Buffer.from('8a83b10ef70e3431573543bb165c1f0f', 'hex'),
    Buffer.from('1a3c2ca15a482b13767f265cf855e5f2', 'hex'),
    Buffer.from('λ-symbol-😀'),
    Buffer.from([0, 1, 255, 0]),
    Buffer.alloc(131073, 97),
    ...Array.from({ length: 20000 }, (_, i) => Buffer.from(`symbol_${i}`)),
  ];
  const fnv = (key: Buffer): number =>
    key.reduce((h, b) => Math.imul(h ^ b, 16777619) >>> 0, 2166136261);
  assert.equal(fnv(keys[1] as Buffer), 3226779525);
  assert.equal(fnv(keys[2] as Buffer), 3226779525);
  const add = (source: number, key: Buffer): void => {
    const hex = key.toString('hex');
    if (!ids.has(hex)) ids.set(hex, ids.size);
    const start = lengths[source] as number;
    rows.push([source, start, key.length, 0, ids.get(hex) as number, ids.size]);
    (source === 0 ? first : second).push(key, Buffer.from([255]));
    lengths[source] = start + key.length + 1;
  };
  for (const key of keys) add(0, key);
  for (const key of keys.toReversed()) add(1, key);
  rows.push([0, 0xffffffff, 2, 3, 0, ids.size], [2, 0, 1, 2, 0, ids.size]);
  const sources = [Buffer.concat(first), Buffer.concat(second)];
  await writeFile(join(dir, 'symbols0.bin'), sources[0] as Buffer);
  await writeFile(join(dir, 'symbols1.bin'), sources[1] as Buffer);
  await writeFile(join(dir, 'symbols.bin'), words(rows.flat()));
  for (const level of [0, 2]) {
    const exe = await driver('symbol-driver', level, dir);
    execute(exe, [
      join(dir, 'symbols0.bin'),
      join(dir, 'symbols1.bin'),
      join(dir, 'symbols.bin'),
      '20000000',
      '0',
    ]);
    await writeFile(join(dir, 'budget0.bin'), Buffer.from('ab'));
    await writeFile(join(dir, 'budget1.bin'), Buffer.alloc(0));
    await writeFile(
      join(dir, 'budget.bin'),
      words([0, 0, 1, 0, 0, 1, 0, 1, 1, 4, 0, 1, 0, 0, 1, 0, 0, 1]),
    );
    execute(exe, [
      join(dir, 'budget0.bin'),
      join(dir, 'budget1.bin'),
      join(dir, 'budget.bin'),
      '42',
      '0',
    ]);
  }
});
