import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile, FunctionCache, functionEmissionKey } from '../src/backends.js';
import { parse, validate } from '../src/core.js';
import { emitMetal } from '../src/metal.js';
import { findClang, runTool } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { checkMetal } from '../tools/gpu-verify.js';

const program = validate(
  parse(`fn add_step u32 u32 -> u32
r add p0 p1
ret r
end
fn sum_from u32 u32 -> u32
r fold add_step p0 p1
ret r
end
fn flip bool u32 -> bool
r xor p0 true
ret r
end
fn toggles u32 -> bool
r fold flip p0 false
ret r
end
fn below u32 u32 u32 -> bool
r lt p0 p2
ret r
end
fn advance u32 u32 u32 -> u32
r add p0 3
ret r
end
fn capped u32 u32 -> u32
r loop below advance p0 0 p1
ret r
end
`),
);

test('Metal scalar fold and predicate-loop state remains volatile without altering ordinary C', () => {
  const plain = compile(program, 'c', { optimize: false }).text;
  const guarded = compile(program, 'c', { optimize: false, cLoopState: 'volatile' }).text;
  assert.equal(guarded.replaceAll('volatile ', ''), plain);
  assert.match(guarded, /volatile uint32_t n_r/);
  assert.match(guarded, /volatile bool n_r/);
  assert.doesNotMatch(plain, /volatile/);
  const metal = emitMetal(program);
  assert.match(metal, /volatile uint n_r/);
  assert.match(metal, /volatile bool n_r/);
  assert.match(metal, /if \(!a0_below/);
});

test('scalar loop storage participates in C cache keys and does not affect other targets', () => {
  const fn = program.byName.get('sum_from');
  assert.ok(fn);
  assert.notEqual(
    functionEmissionKey('c', fn),
    functionEmissionKey('c', fn, { cLoopState: 'volatile' }),
  );
  assert.equal(
    functionEmissionKey('js', fn),
    functionEmissionKey('js', fn, { cLoopState: 'volatile' }),
  );
  const cache = new FunctionCache(100);
  const plain = compile(program, 'c', {}, cache);
  const guarded = compile(program, 'c', { cLoopState: 'volatile' }, cache);
  assert.equal(guarded.cacheHits, 0);
  assert.equal(guarded.cacheMisses, program.functions.length);
  const again = compile(program, 'c', { cLoopState: 'volatile' }, cache);
  assert.equal(again.cacheHits, program.functions.length);
  assert.equal(again.text, guarded.text);
  assert.equal(compile(program, 'c', {}, cache).text, plain.text);
});

test('volatile loop storage preserves zero trips, wrapping, booleans and early stopping in native C', async (t) => {
  const clang = findClang();
  if (!clang.path) return t.skip('native Clang unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'a0-metal-loop-state-'));
  try {
    const counts = [0, 1, 2, 7, 10, 31, 100, 65535];
    const initial = [0, 1, 0xffffffff];
    const calls: string[] = [];
    const expected: number[] = [];
    for (const count of counts) {
      for (const start of initial) {
        calls.push(`printf("%u\\n", a0_sum_from(${count}u, ${start}u));`);
        expected.push(
          Number((BigInt(start) + (BigInt(count) * BigInt(count - 1)) / 2n) & 0xffffffffn),
        );
      }
      calls.push(`printf("%u\\n", (unsigned)a0_toggles(${count}u));`);
      expected.push(count % 2);
      for (const limit of [0, 1, 17, 99]) {
        calls.push(`printf("%u\\n", a0_capped(${count}u, ${limit}u));`);
        expected.push(Math.min(count, Math.ceil(limit / 3)) * 3);
      }
    }
    for (const level of ['-O0', '-O3']) {
      const source = join(directory, 'module.c');
      const binary = join(directory, process.platform === 'win32' ? 'probe.exe' : 'probe');
      await writeFile(
        source,
        compile(program, 'c', { cLoopState: 'volatile' }).text +
          `\n#include <stdio.h>\nint main(void) { ${calls.join('\n')} return 0; }\n`,
      );
      const built = runTool(clang.path, [
        '-std=c11',
        level,
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-unused-parameter',
        '-fsanitize=undefined',
        '-fno-sanitize-recover=all',
        source,
        '-o',
        binary,
      ]);
      assert.ok(built.ok, built.stderr);
      const ran = runTool(binary, []);
      assert.ok(ran.ok, ran.stderr);
      assert.deepEqual(ran.stdout.trim().split(/\r?\n/).map(Number), expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Metal executes scalar loop state with zero trips, wrapping and predicates', async (t) => {
  if (process.platform !== 'darwin') return t.skip('actual Metal runtime requires macOS');
  const cases: Case[] = [];
  for (const count of [0, 1, 2, 7, 10, 31, 100, 65535]) {
    for (const start of [0, 1, 0xffffffff]) {
      cases.push({
        functionName: 'sum_from',
        args: [count, start],
        expected: Number((BigInt(start) + (BigInt(count) * BigInt(count - 1)) / 2n) & 0xffffffffn),
      });
    }
    cases.push({ functionName: 'toggles', args: [count], expected: count % 2 !== 0 });
    for (const limit of [0, 1, 17, 99]) {
      cases.push({
        functionName: 'capped',
        args: [count, limit],
        expected: Math.min(count, Math.ceil(limit / 3)) * 3,
      });
    }
  }
  const result = await checkMetal(program, cases);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.cases, cases.length);
});
