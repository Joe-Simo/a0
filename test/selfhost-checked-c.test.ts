import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, type TypedProgram, type Value } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { type Chunk, emitChunked, type StageRun } from '../tools/bootstrap.js';
import { type Case, closure } from '../tools/corpus.js';
import { selfHostedC } from '../tools/selfhost-c.js';
import { cDriver } from '../tools/verify.js';
import { CHECKED_SOURCE, checkedCases } from './fixtures/checked-ops-fixtures.js';
import {
  CHECKED_C_EXTRA_REQUIREMENTS,
  CHECKED_C_EXTRA_SOURCE,
  CHECKED_C_LARGE_DRIVER,
  CHECKED_C_LARGE_SOURCE,
  checkedCExtraCases,
} from './fixtures/selfhost-checked-c-extra.js';

type Io = { input: number[]; position: number; output: number[] };
type Result = StageRun & { readonly words: number };
type Step = (chunk: Chunk, bounds: readonly number[]) => Result;

let linkedEmitter: Promise<TypedProgram> | undefined;
let sourceEmitter: Promise<Step> | undefined;

function emitter(): Promise<TypedProgram> {
  linkedEmitter ??= link('compiler/emit_c.a0', (path) => readFile(path, 'utf8')).then(
    (linked) => linked.program,
  );
  return linkedEmitter;
}

/** Run the actual A0 source frontend and C emitter; JS supplies the execution runtime only. */
function sourceStep(): Promise<Step> {
  sourceEmitter ??= (async () => {
    const linked = (await link('compiler/boot.a0', (path) => readFile(path, 'utf8'))).program;
    const source = parseAndValidate(closure(linked.functions, 'emitchunkio'));
    const text = compile(source, 'js').text;
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    )) as { emitchunkio: (io: Io) => number };
    return (chunk: Chunk, bounds: readonly number[]): Result => {
      const bytes = [...Buffer.from(chunk.source, 'utf8')];
      const io: Io = {
        input: [
          bytes.length,
          ...bytes,
          chunk.head ? 1 : 0,
          chunk.strict ? 1 : 0,
          bounds.length,
          ...bounds,
        ],
        position: 0,
        output: [],
      };
      const code = mod.emitchunkio(io);
      if (code !== 0) return { code, text: '', bounds: [], words: io.output.length };
      const count = io.output[io.output.length - 1];
      assert.ok(count !== undefined && count + 1 <= io.output.length);
      const end = io.output.length - count - 1;
      return {
        code,
        text: Buffer.from(io.output.slice(0, end)).toString('latin1'),
        bounds: io.output.slice(end, end + count),
        words: io.output.length,
      };
    };
  })();
  return sourceEmitter;
}

async function rawSource(source: string): Promise<Result> {
  return (await sourceStep())({ source, head: true, strict: false, before: [], own: [] }, []);
}

function scalar(value: Value): string {
  assert.ok(typeof value === 'number' || typeof value === 'boolean');
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}

/** Compile each A0-emitted C module at both host optimization levels, with UB checks. */
async function checkC(
  clang: string,
  program: TypedProgram,
  text: string,
  cases: readonly Case[],
  label: string,
): Promise<void> {
  const functions = new Map(program.functions.map((fn, index) => [fn.name, index] as const));
  const input = `${cases
    .map((c) => {
      const index = functions.get(c.functionName);
      assert.ok(index !== undefined, c.functionName);
      return [index, ...c.args.map(scalar)].join(' ');
    })
    .join('\n')}\n`;
  const expected = cases.map((c) => scalar(c.expected));
  for (const level of ['-O0', '-O2'])
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'module.c'), text);
      await writeFile(join(dir, 'driver.c'), cDriver(program));
      const built = runTool(
        clang,
        [
          '-std=c11',
          level,
          '-Wall',
          '-Wextra',
          '-Wno-unused-parameter',
          '-Werror',
          '-fsanitize=undefined',
          '-fno-sanitize-recover=all',
          'driver.c',
          '-o',
          'driver',
        ],
        { cwd: dir },
      );
      assert.ok(built.ok, `${label} ${level}: ${built.stderr}`);
      const actual = runTool(join(dir, 'driver'), [], { cwd: dir, input });
      assert.ok(actual.ok, `${label} ${level}: ${actual.stderr}`);
      const lines = actual.stdout.trim().split('\n');
      assert.equal(lines.length, cases.length, `${label} ${level}: output count`);
      for (const [index, c] of cases.entries())
        assert.equal(
          lines[index],
          expected[index],
          `${label} ${level}: ${c.functionName}(${c.args.map(scalar).join(',')})`,
        );
    });
}

test('A0 C checked operations from typed tables equal the independent integer oracle', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) return t.skip('clang is unavailable');
  const program = parseAndValidate(CHECKED_SOURCE);
  const output = selfHostedC(await emitter(), program);
  const cases = checkedCases();
  assert.equal(cases.length, 2356);
  await checkC(clang.path, program, output.text, cases, 'A0 C tables');
});

test('A0 C checked operations through the raw source frontend equal the independent oracle', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) return t.skip('clang is unavailable');
  const output = await rawSource(CHECKED_SOURCE);
  assert.equal(output.code, 0);
  const cases = checkedCases();
  assert.equal(cases.length, 2356);
  await checkC(clang.path, parseAndValidate(CHECKED_SOURCE), output.text, cases, 'A0 C raw source');
});

test('A0 C retains strict refusal, cget element typing and earlier frontend diagnostics', async () => {
  for (const source of [
    'fn f u32 -> u32\nret p0\nend\n',
    'fn f u32 u32 -> (u32,bool)\nr cadd p0 p1\nret r\nend\n',
  ]) {
    const output = await rawSource(`profile strict\n${source}`);
    assert.deepEqual([output.code, output.words], [2, 0]);
  }
  const badGet = 'fn f u32 -> u32\na arr true false\nr cget a p0\nv at r 0\nret v\nend\n';
  assert.throws(() => parseAndValidate(badGet));
  for (const source of [badGet, `profile strict\n${badGet}`]) {
    const output = await rawSource(source);
    assert.deepEqual([output.code, output.words], [3, 0]);
  }
  const badArithmetic = 'profile strict\nfn f u32 bool -> (u32,bool)\nr cadd p0 p1\nret r\nend\n';
  const arithmetic = await rawSource(badArithmetic);
  assert.deepEqual([arithmetic.code, arithmetic.words], [3, 0]);
  const badParse = await rawSource('profile strict\nfn f u32 -> u32\nret p0\n');
  assert.deepEqual([badParse.code, badParse.words], [1, 0]);
});

test('A0 C chunked checked bodies share the builtin tuple type across scalar signatures', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) return t.skip('clang is unavailable');
  // Two 1401-node bodies exceed the frontend's 2730-node whole-source capacity. Neither
  // signature names (u32,bool): planChunks must add the builtin result type to its prelude.
  const body = (name: string, addend: 'p0' | 'p1'): string => `fn ${name} u32 u32 -> u32
r cadd p0 p1
v at r 0
${Array.from(
  { length: 1399 },
  (_, index) => `n${index} add ${index === 0 ? 'v' : `n${index - 1}`} ${addend}`,
).join('\n')}
ret n1398
end
`;
  const source = body('chunk_a', 'p1') + body('chunk_b', 'p0');
  const output = emitChunked(source, await sourceStep());
  assert.equal(output.code, 0);
  assert.equal(output.chunks, 2);
  const inputs = [
    [0, 0],
    [7, 13],
    [0xffffffff, 1],
    [1, 0xffffffff],
  ] as const;
  const cases: Case[] = ['chunk_a', 'chunk_b'].flatMap((functionName) =>
    inputs.map(([a, b]) => ({
      functionName,
      args: [a, b],
      expected: Number(
        BigInt.asUintN(
          32,
          BigInt(a) + BigInt(b) + 1399n * BigInt(functionName === 'chunk_a' ? b : a),
        ),
      ),
    })),
  );
  await checkC(clang.path, parseAndValidate(source), output.text, cases, 'A0 C chunked checked');
});

test('A0 C checked snapshots and aggregate extras survive every callback variant', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) return t.skip('clang is unavailable');
  const program = parseAndValidate(CHECKED_C_EXTRA_SOURCE);
  const cases = checkedCExtraCases();
  assert.equal(cases.length, CHECKED_C_EXTRA_REQUIREMENTS.cases);
  const tables = selfHostedC(await emitter(), program);
  const source = await rawSource(CHECKED_C_EXTRA_SOURCE);
  assert.equal(source.code, 0);
  for (const [route, text] of [
    ['tables', tables.text],
    ['raw source', source.text],
  ] as const) {
    for (const symbol of CHECKED_C_EXTRA_REQUIREMENTS.variantSymbols)
      assert.ok(text.includes(symbol), `${route}: missing ${symbol}`);
    await checkC(clang.path, program, text, cases, `A0 C extra ${route}`);
  }
});

test('A0 C cget preserves full unsigned bounds and the public large-array C ABI', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) return t.skip('clang is unavailable');
  const clangPath = clang.path;
  const program = parseAndValidate(CHECKED_C_LARGE_SOURCE);
  const tables = selfHostedC(await emitter(), program);
  const source = await rawSource(CHECKED_C_LARGE_SOURCE);
  assert.equal(source.code, 0);
  for (const [route, text] of [
    ['tables', tables.text],
    ['raw source', source.text],
  ] as const)
    for (const level of ['-O0', '-O2'])
      await withTempDir(async (dir) => {
        await writeFile(join(dir, 'module.c'), text);
        await writeFile(join(dir, 'driver.c'), CHECKED_C_LARGE_DRIVER);
        const built = runTool(
          clangPath,
          [
            '-std=c11',
            level,
            '-Wall',
            '-Wextra',
            '-Wno-unused-parameter',
            '-Werror',
            '-fsanitize=undefined',
            '-fno-sanitize-recover=all',
            'driver.c',
            '-o',
            'driver',
          ],
          { cwd: dir },
        );
        assert.ok(built.ok, `A0 C large array ${route} ${level}: ${built.stderr}`);
        const actual = runTool(join(dir, 'driver'), [], { cwd: dir });
        assert.ok(actual.ok, `A0 C large array ${route} ${level}: ${actual.stderr}`);
      });
});
