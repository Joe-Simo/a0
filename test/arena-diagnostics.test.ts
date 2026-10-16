import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parse, validate } from '../src/core.js';
import { A0Error } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { buildStage, closure, emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { readBootstrapSeed } from '../tools/seed.js';

// This bounded subset compares complete public core JSON, including fixes and edits.
// Unsupported IDs remain explicit refusals; no host repair follows an A0 refusal.
const f = (body: string, result = 'u32', params = 'u32') =>
  `fn f ${params} -> ${result}\n${body}\nend\n`;
const nested = `${'('.repeat(200)}u32${')'.repeat(200)}`;
const cases = [
  f('a add true p0\nret a'),
  f('a and p0 true\nret a'),
  f('a eq true p0\nret a', 'bool'),
  f('a ne true p0\nret a', 'bool'),
  f('a select p0 1 2\nret a'),
  f('a select true 1 false\nret a'),
  f('a arr 1 false\nret 0'),
  f('a arr p0\nret 0', 'u32', 'io'),
  f('a arr p0 p0\nret 0', 'u32', 'u32x65536'),
  f('a puts p0 1\nret a', 'io', 'io'),
  f('a get p0 1\nret a'),
  f('a get p0 1\nret a', 'u32', '(u32,bool)'),
  f('a cget p0 1\nret a', 'u32', 'u32'),
  f('a cget p0 1\nret a', 'u32', 'u32x4x2'),
  f('a set p0 1 2\nret a'),
  f('a set p0 1 2\nret a', 'u32', '(u32,bool)'),
  f('a at p0 1\nret a'),
  f('a at p0 1\nret a', 'u32', 'u32x4'),
  f('a put p0 1 2\nret 0', 'u32', 'u32x4'),
  f('a rec p0 true\nb at a p0\nret p0'),
  f('a mov p0\na mov 0\nret a'),
  f('ret 0', 'u32', 'io io'),
  f('ret p0', 'bool', nested),
  f('a read p0\nb at a 0\nc at a 1\nd write c true\nret d', 'io', 'io'),
  'fn f -> u32\na text ""\nret 0\nend\n',
  'fn f -> u32\nret 0\n',
  'fn f -> u32\n  ret   0 # comment\nfn later -> u32\nret 1\nend\n',
  'fn f -> u32\nret 0\nwhoops\n',
  `fn f ${Array(65).fill('u32').join(' ')} -> u32\nret 0\nend\n`,
  'fn f u32 -> u32\n' +
    Array.from({ length: 4096 }, (_, i) => `n${i} add p0 ${i}\n`).join('') +
    'ret add n4095 1\nend\n',
];
cases.push(
  f('ret at p0 0', 'u32', 'u32x4'),
  f('ret false'),
  'fn bare -> u32\nret true\nend\n',
  'fn f u32 -> u32\n  ret\u2003p0 #🙂\n',
);
cases.push(`# emoji🙂 and whitespace\n${f('a add true p0\nret a')}`);
// A0101 suggestions/later definitions and A0222 record-field diagnostics.
cases.push(
  f('ret unknown'),
  f('a mov p0\nb mov aa\nret b'),
  f('value mov p0\nb add valu 1\nret b'),
  f('value mov p0\nret valu'),
  f('value mov p0\nret add valu 1'),
  f('retval mov p0\nvalue mov p0\nret add valu 1'),
  f('value add value 1\nret value'),
  f('x mov value\nvalue mov p0\nret x'),
  f('valux mov p0\nx mov value\nvalue mov p0\nret x'),
  f('value mov p0\nvaluf mov p0\nx mov valug\nret x'),
  f('valuf mov p0\nvalue mov p0\nx mov valug\nret x'),
  f('abcde mov p0\nabcdf mov p0\nx mov abcd\nret x'),
  f('abcde mov p0\nx mov axcdx\nret x'),
  f('ab mov p0\nx mov ac\nret x'),
  f('a_b_c mov p0\nx mov a_bc\nret x'),
  f('val123 mov p0\nx mov val124\nret x'),
  f(`${'a'.repeat(64)} mov p0\nx mov ${'a'.repeat(63)}\nret x`),
  f(`${'a'.repeat(64)} mov p0\nx mov ${`${'a'.repeat(63)}b`}\nret x`),
  `fn before u32 -> u32\nvalue mov p0\nret value\nend\n${f('ret valu')}`,
  `# supplementary🙂\n${f('value mov p0\nb mov valu\nret b').replaceAll('\n', '\r\n')}`,
  f('x at p0 2\nret x', 'u32', '(u32,bool)'),
  f('x put p0 4294967295 1\nret 0', 'u32', '(u32,bool)'),
  f('ret at p0 8', 'u32', '(u32,(bool,u32x4))'),
  f('a mov missing\nret a'),
);
const unsupported = [
  f('x call missing p0\nret x'),
  f('ret 0', 'u32', 'bol'),
  'fn f -> u32\nex -> 1\nret 1\nend\n',
];

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-diagnostics');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-diagnostics-'));
    scratch = dir;
    const seed = await readBootstrapSeed();
    const [compiler] = await buildStage(clang, 'compiler', seed.c, 'emitchunkio', dir);
    const linked = await link('compiler/diagnostics_arena.a0', (path) => readFile(path, 'utf8'));
    const source = closure(linked.program.functions, 'arena_parse_diagnostic');
    // TS links and plans chunks; the verified native A0 seed parses, checks and emits C.
    const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(compiler, chunk, bounds));
    assert.equal(
      emitted.code,
      0,
      `native A0 diagnostic compilation: ${emitted.failed?.own.join(',')}`,
    );
    const result = /^(a0t\d+) a0_arena_parse_diagnostic\(/m.exec(emitted.text)?.[1];
    assert.ok(result);
    await writeFile(join(dir, 'module.c'), emitted.text);
    await writeFile(join(dir, 'api.h'), `#define DIAG_RESULT ${result}\n`);
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
          join(dir, `driver-O${level}`),
        ],
        { cwd: dir, timeoutMs: 120_000 },
      );
      assert.ok(built.ok, `native A0 diagnostics O${level}: ${built.stderr}`);
    }
    return dir;
  })();
  return prepared;
}

async function request(dir: string, level: number, source: string, budget = 50_000_000) {
  const input = join(dir, 'source.bin');
  const output = join(dir, 'output.bin');
  await writeFile(input, source);
  const ran = runTool(join(dir, `driver-O${level}`), [input, output, String(budget)], {
    cwd: dir,
    timeoutMs: 30_000,
  });
  assert.ok(ran.ok, `native request O${level}: ${ran.stderr}`);
  const bytes = await readFile(output);
  assert.ok(bytes.length >= 130 * 4);
  const status = bytes.readUInt32LE(0);
  const facts = Array.from({ length: 128 }, (_, i) => bytes.readUInt32LE((i + 1) * 4));
  const length = bytes.readUInt32LE(129 * 4);
  assert.equal(bytes.length, (130 + length) * 4, 'complete word transport');
  const json = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const byte = bytes.readUInt32LE((130 + i) * 4);
    assert.ok(byte <= 255, 'A0 JSON output is bytes');
    json[i] = byte;
  }
  return { status, facts, json };
}

function reference(source: string) {
  try {
    validate(parse(source));
  } catch (error) {
    assert.ok(error instanceof A0Error);
    return error.toJSON();
  }
  assert.fail('fixture must produce a reference diagnostic');
}

test('seed-built A0 diagnostics preserve supported full JSON, fixes and UTF16 span facts', {
  skip,
}, async () => {
  const dir = await prepare();
  assert.equal(cases.length, 59);
  for (const level of [0, 2]) {
    for (const [index, source] of cases.entries()) {
      const expected = reference(source);
      assert.ok(expected.id);
      const { status, facts, json } = await request(dir, level, source);
      const label = `O${level} case ${index} ${expected.id}`;
      assert.equal(status, 0, label);
      assert.deepEqual(JSON.parse(json.toString('utf8')), expected, label);
      assert.equal(facts[1], Number(expected.id.slice(1)), `${label}: numeric ID`);
      assert.equal(facts[20], 15, `${label}: supported facts`);
      const raw = Buffer.from(source);
      const start = facts[3];
      const length = facts[4];
      assert.ok(start !== undefined && length !== undefined);
      assert.ok(start <= raw.length && length <= raw.length - start, `${label}: UTF8 span`);
      assert.equal(
        facts[12],
        raw.subarray(0, start).toString('utf8').length,
        `${label}: UTF16 start`,
      );
      assert.equal(
        facts[13],
        raw.subarray(start, start + length).toString('utf8').length,
        `${label}: UTF16 length`,
      );
      if (expected.id === 'A0101') {
        const fn = parse(source).functions.find((fn) => expected.message.startsWith(`${fn.name}.`));
        assert.ok(fn);
        const target = raw.subarray(start, start + length).toString('utf8');
        assert.ok(expected.message.includes(`'${target}'`), `${label}: original target span`);
        const later = fn.nodes.some((node) => node.id === target);
        const mode = later ? 2 : expected.edits.length > 0 ? 1 : 0;
        assert.equal(facts[22], mode, `${label}: suggestion/later-definition mode`);
        if (mode === 1) assert.notEqual(facts[21], 0xffffffff, `${label}: suggestion symbol`);
        else assert.equal(facts[21], 0xffffffff, `${label}: no suggestion symbol`);
      }
    }
  }
});

test('seed-built A0 diagnostics preserve unsupported and allocation refusal status', {
  skip,
}, async () => {
  const dir = await prepare();
  const source = f('a add true p0\nret a');
  for (const level of [0, 2]) {
    for (const input of unsupported) {
      const result = await request(dir, level, input);
      assert.equal(result.status, 7, 'unsupported diagnostic/spec is explicit');
      assert.equal(result.json.length, 0, 'no partial JSON after refusal');
    }
    for (const budget of [Buffer.byteLength(source), 256, 1024, 4096]) {
      const result = await request(dir, level, source, budget);
      assert.equal(result.status, budget === 4096 ? 0 : 4, `budget ${budget}`);
      if (result.status === 4) assert.equal(result.json.length, 0, 'no partial JSON on exhaustion');
      else assert.deepEqual(JSON.parse(result.json.toString('utf8')), reference(source));
    }
  }
});
