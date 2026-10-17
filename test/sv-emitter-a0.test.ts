import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { compile } from '../src/backends.js';
import { formatProgram, parseAndValidate, type TypedProgram, withoutProfile } from '../src/core.js';
import { link } from '../src/link.js';
import { optimizeFunction } from '../src/optimize.js';
import { findClang, runTool } from '../src/toolchain.js';
import { buildStage, emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { generateCorpus } from '../tools/corpus.js';
import { readBootstrapSeed } from '../tools/seed.js';
import { directedFixtures } from './fixtures/sv-emitter/cases.js';
import { tables } from './fixtures/sv-emitter/tables.js';
import { svTokens } from './fixtures/sv-emitter/tokens.js';

// Native execution here runs the SV emitter. Token parity and interface checks do not
// execute RTL. TS supplies structural checked IR, bootstrap linking and reference oracles.
const clang = findClang();
const options = {
  skip: clang.path === undefined ? 'clang is unavailable' : false,
  timeout: 300_000,
};
const fixtures = resolve('test/fixtures/sv-emitter');
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
    const dir = await mkdtemp(join(tmpdir(), 'a0-sv-emitter-'));
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
    const context = /a0_sv_emit\(a0_io \* p0, (a0t\d+) p1\)/.exec(emitted.text)?.[1];
    assert.ok(context);
    await writeFile(
      join(dir, 'api.h'),
      `${[
        ...['sv_emit', 'sv_emit_shaped', 'ew_emit', 'arena_hello', 'arena_finish'].map(
          (name) => `#define ${name.toUpperCase()}_RESULT ${type(name)}`,
        ),
        `#define CTX_TYPE ${context}`,
      ].join('\n')}\n`,
    );
    for (const level of [0, 2]) {
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
          join(fixtures, 'driver.c'),
          join(runtime, 'arena_runtime.c'),
          '-o',
          join(dir, `driver-${level}`),
        ],
        { cwd: dir, timeoutMs: 120_000 },
      );
      assert.ok(built.ok, `SV driver O${level}: ${built.stderr}`);
    }
    return dir;
  })();
  return prepared;
}

type Tables = ReturnType<typeof tables>;
function encode(t: Tables): Buffer {
  const arrays = [t.types, t.tlist, t.fns, t.nodes, t.args, t.pool];
  const b = Buffer.alloc((9 + arrays.reduce((n, a) => n + a.length, 0)) * 4);
  let at = 0;
  for (const n of [...arrays.map((a) => a.length), ...t.counts]) {
    b.writeUInt32LE(n >>> 0, at);
    at += 4;
  }
  for (const a of arrays)
    for (const n of a) {
      b.writeUInt32LE(n >>> 0, at);
      at += 4;
    }
  return b;
}
interface Status {
  status: number;
  complete: boolean;
  published: boolean;
  resultHandle: number;
  resultLength: number;
  outputCount: number;
  inputUnchanged: boolean;
  ioUnchanged: boolean;
  allocatedWords: number;
}
async function run(
  dir: string,
  level: number,
  input: Tables,
  target?: Tables,
  budget = 50_000_000,
  maxout = 50_000_000,
) {
  const id = serial++,
    source = join(dir, `source-${id}.bin`),
    out = join(dir, `output-${id}.sv`);
  await writeFile(source, encode(input));
  const args = [source, out, String(budget), String(maxout)];
  if (target !== undefined) {
    const path = join(dir, `target-${id}.bin`);
    await writeFile(path, encode(target));
    args.push(path);
  }
  const result = runTool(join(dir, `driver-${level}`), args, { timeoutMs: 120_000 });
  assert.ok(result.status === 0 || result.status === 20, result.stderr);
  const status = JSON.parse(result.stderr) as Status;
  assert.ok(status.complete && status.inputUnchanged && status.ioUnchanged, result.stderr);
  assert.equal(status.allocatedWords, 0);
  assert.equal(result.status === 0, status.status === 0, result.stderr);
  if (status.status !== 0) {
    assert.equal(status.published, false);
    await assert.rejects(readFile(out), { code: 'ENOENT' });
    return { status, text: '' };
  }
  assert.ok(status.published);
  const text = await readFile(out, 'utf8');
  assert.equal(Buffer.byteLength(text), status.resultLength);
  assert.equal(status.outputCount, status.resultLength);
  return { status, text };
}
function equalTokens(actual: string, expected: string, label: string) {
  const a = svTokens(actual),
    b = svTokens(expected);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    assert.equal(
      a[i],
      b[i],
      `${label}: token ${i}: ${a.slice(Math.max(0, i - 3), i + 4)} vs ${b.slice(Math.max(0, i - 3), i + 4)}`,
    );
  }
}
function optimized(program: TypedProgram): TypedProgram {
  const canonical = withoutProfile(program);
  return { ...canonical, functions: canonical.functions.map((fn) => optimizeFunction(fn).fn) };
}

test(
  'native A0 SV tokens cover combinational, clocked, IO, aggregate and refusal policies',
  options,
  async () => {
    const dir = await prepare();
    for (const level of [0, 2]) {
      for (const [name, source, code] of directedFixtures()) {
        const program = parseAndValidate(source),
          result = await run(dir, level, tables(program));
        assert.equal(result.status.status, code, name);
        if (code === 0)
          equalTokens(result.text, compile(program, 'sv', { optimize: false }).text, name);
        else {
          assert.throws(() => compile(program, 'sv', { optimize: false }), name);
          assert.equal(result.status.resultHandle, 0, name);
          assert.equal(result.status.resultLength, 0, name);
        }
      }
      for (const seed of [1, 42, 0x12345678, 0xffffffff]) {
        const program = generateCorpus(seed),
          result = await run(dir, level, tables(program));
        assert.equal(result.status.status, 0);
        equalTokens(result.text, compile(program, 'sv', { optimize: false }).text, `corpus${seed}`);
      }
    }
  },
);

test(
  'native A0 SV shaped emission retains original clock interfaces through optimization',
  options,
  async () => {
    const dir = await prepare(),
      regression = await readFile(join(fixtures, 'original-shape.a0'), 'utf8');
    const sources = [
      'fn f -> u32\nr div 44 2\nret r\nend\n',
      'fn b u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f u32 -> u32\nr fold b 257 0\nret r\nend\n',
      'fn d -> u32\nr div 44 2\nret r\nend\nfn f -> u32\nr call d\nret r\nend\n',
      'fn f io -> u32\nret 7\nend\n',
      'profile strict\nfn f u32 -> u32\nx or p0 1\nr div 55 x\nret r\nend\n',
      'profile strict\nfn f u32 -> u32\na arr 1 2 3 4\ni and p0 3\nr get a i\nret r\nend\n',
      regression,
    ];
    const programs = [
      ...sources.map(parseAndValidate),
      ...[1, 42, 0x12345678, 0xffffffff].map((seed) => generateCorpus(seed)),
    ];
    for (const level of [0, 2])
      for (const program of programs) {
        const result = await run(dir, level, tables(program), tables(optimized(program)));
        assert.equal(result.status.status, 0);
        equalTokens(result.text, compile(program, 'sv').text, `shaped-O${level}`);
        if (programs.indexOf(program) === 6) {
          const header = /module a0_pred \(([\s\S]*?)\);/.exec(result.text)?.[1];
          assert.ok(header);
          assert.match(header, /input logic clk/);
          const instance = result.text.split('\n').find((line) => /^\s*a0_pred u_/.test(line));
          assert.ok(instance);
          const connected = new Set([...instance.matchAll(/\.(\w+)\s*\(/g)].map((m) => m[1]));
          for (const name of ['clk', 'rst', 'start', 'done']) assert.ok(connected.has(name), name);
        }
      }
  },
);

test(
  'native A0 SV refuses resource, count, range and unknown-table failures without publication',
  options,
  async () => {
    const dir = await prepare(),
      basic = parseAndValidate('fn f u32 -> u32\nr add p0 7\nret r\nend\n');
    const words = encode(tables(basic)).length / 4 - 9;
    for (const level of [0, 2]) {
      for (const [name, budget, maxout, counts, code] of [
        ['allocation-budget', words + 10, 50_000_000, undefined, 4],
        ['output-budget', 50_000_000, 150, undefined, 4],
        ['node-count-overflow', 50_000_000, 50_000_000, [1, 3, 0xffffffff], 7],
        ['function-count-overflow', 50_000_000, 50_000_000, [0x80000000, 3, 2], 7],
        ['type-count-overflow', 50_000_000, 50_000_000, [1, 0x80000000, 2], 7],
        ['bad-node-range', 50_000_000, 50_000_000, [1, 3, 3], 3],
      ] as const) {
        const t = tables(basic);
        if (counts) t.counts = [...counts];
        const result = await run(dir, level, t, undefined, budget, maxout);
        assert.equal(result.status.status, code, name);
      }
      const text = parseAndValidate('fn f -> u32\na text "OK"\nr get a 0\nret r\nend\n');
      const t = tables(text);
      t.nodes[8] = 24;
      const accepted = await run(dir, level, t);
      assert.equal(accepted.status.status, 0);
      equalTokens(accepted.text, compile(text, 'sv', { optimize: false }).text, 'A0 text opcode24');
      t.nodes[8] = 99;
      const badOp = await run(dir, level, t);
      assert.equal(badOp.status.status, 6);
      assert.equal(badOp.status.resultHandle, 0);
      const badType = tables(text);
      badType.types[0] = 99;
      assert.equal((await run(dir, level, badType)).status.status, 6);
      const target = tables(basic);
      target.counts[0] = 0;
      assert.equal((await run(dir, level, tables(basic), target)).status.status, 6);
    }
  },
);

test(
  'native A0 SV arena tables cross node, function, name, parameter and aggregate boundaries',
  options,
  async () => {
    const dir = await prepare();
    const sources = [
      'fn f u32 -> u32\n' +
        Array.from({ length: 4096 }, (_, i) => `n${i} add ${i ? `n${i - 1}` : 'p0'} 1\n`).join('') +
        'ret n4095\nend\n',
      Array.from(
        { length: 1025 },
        (_, i) => `fn ${`f${i}`.padEnd(64, 'x')} -> u32\nret ${i % 2 ? '4294967295' : '0'}\nend\n`,
      ).join(''),
      'fn f u32x1024x64 -> u32\na get p0 0\nr get a 1023\nret r\nend\n',
      `fn f ${Array(64).fill('u32').join(' ')} -> u32\nr add p0 p63\nret r\nend\n`,
    ];
    for (const source of sources) {
      const program = parseAndValidate(source),
        result = await run(dir, 2, tables(program));
      assert.equal(result.status.status, 0);
      equalTokens(result.text, compile(program, 'sv', { optimize: false }).text, 'capacity');
    }
  },
);
