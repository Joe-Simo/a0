import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';

function oracle(initial: readonly number[], bytes: readonly number[]): number[] {
  let [need = 0, cp = 0, hash = 0, count = 0, errors = 0] = initial;
  for (const b of bytes) {
    if (need !== 0 && (b & 0xc0) === 0x80) {
      cp = ((cp << 6) | (b & 0x3f)) >>> 0;
      need = (need - 1) >>> 0;
      if (need === 0) {
        hash = Math.imul(hash ^ cp, 16777619) >>> 0;
        count = (count + 1) >>> 0;
      }
    } else {
      if (need !== 0) errors = (errors + 1) >>> 0;
      need = 0;
      if (b < 0x80) {
        hash = Math.imul(hash ^ b, 16777619) >>> 0;
        count = (count + 1) >>> 0;
      } else if ((b - 0xc2) >>> 0 < 30) {
        cp = b & 0x1f;
        need = 1;
      } else if ((b - 0xe0) >>> 0 < 16) {
        cp = b & 0x0f;
        need = 2;
      } else if ((b - 0xf0) >>> 0 < 5) {
        cp = b & 7;
        need = 3;
      } else errors = (errors + 1) >>> 0;
    }
  }
  return [need, cp, hash, count, errors];
}

const wrapper = `fn fullstate (u32,u32,u32,u32,u32) u32 u32x4096 -> (u32,u32,u32,u32,u32)
r fold u8step p1 p0 p2
ret r
end`;

test('large pure scalar folds preserve every lenient UTF8 state field and caller snapshot', async () => {
  const kernel = KERNELS.find((k) => k.name === 'utf8dec4k');
  assert.ok(kernel);
  const program = parseAndValidate(`${kernel.a0}\n${wrapper}`);
  const reference = program.byName.get('fullstate');
  assert.ok(reference);
  const cases = [
    [],
    [0x41, 0x7f],
    [0xc2, 0xa2],
    [0xe2, 0x82, 0xac],
    [0xf0, 0x9f, 0x98, 0x80],
    [0xc2],
    [0xe2, 0x28, 0xa1],
    [0x80, 0xbf, 0xc0, 0xc1, 0xf5, 0xff],
    [0xf4, 0xbf, 0xbf, 0xbf],
    [0xffffffff, 256, 0x80000000],
  ];
  let seed = 0x12345678;
  cases.push(
    Array.from({ length: 64 }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 24;
    }),
  );
  const states = [
    [0, 0, 2166136261, 0, 0],
    [2, 0x1234, 0xffffffff, 0xffffffff, 0xffffffff],
    [0xffffffff, 0xffffffff, 1, 7, 13],
  ];
  for (const optimize of [false, true]) {
    const text = compile(program, 'js', { optimize }).text;
    assert.match(text, /\$r_state4/);
    const mod = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
    for (const bytes of cases)
      for (const initial of states) {
        const data = new Uint32Array(4096);
        data.set(bytes);
        const saved = [...initial];
        for (const n of new Set([0, Math.max(0, bytes.length - 1), bytes.length])) {
          const expected = oracle(initial, bytes.slice(0, n));
          assert.deepEqual(mod.fullstate(initial, n, data), expected);
          assert.deepEqual(
            run(reference, [initial, n, Array.from(data)], { fuel: 100000 }),
            expected,
          );
          assert.deepEqual(initial, saved);
          assert.deepEqual(Array.from(data.slice(0, bytes.length)), bytes);
        }
      }
  }
});

test('large strict scalar folds retain frame-preserving fallback', async () => {
  const kernel = KERNELS.find((k) => k.name === 'utf8dec4k');
  assert.ok(kernel);
  const program = parseAndValidate(`profile strict\n${kernel.a0}\n${wrapper}`);
  assert.doesNotMatch(compile(program, 'js', { optimize: false }).text, /\$r_state4/);
});

test('affected UTF8 and token benchmarks retain independent full-input results', async () => {
  for (const name of ['utf8dec4k', 'tok4k']) {
    const kernel = KERNELS.find((k) => k.name === name);
    assert.ok(kernel);
    const p = parseAndValidate(kernel.a0),
      fn = p.byName.get(name);
    assert.ok(fn);
    const hand = await import(
      `data:text/javascript;base64,${Buffer.from(kernel.js).toString('base64')}`
    );
    for (const optimize of [false, true]) {
      const text = compile(p, 'js', { optimize }).text;
      const mod = await import(
        `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
      );
      for (const args of [
        [0, 0],
        [0xffffffff, 0xffffffff],
        [0xdeadbeef, 17],
        [0x80000000, 0x12345678],
      ]) {
        const expected = run(fn, args, { fuel: 50000000 });
        assert.equal(mod[name](...args), expected, `${name}; optimize=${optimize}`);
        assert.equal(hand[name](...args), expected, name);
      }
    }
  }
});
