import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compile } from '../src/backends.js';
import { run, type TypedFunc, type TypedProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { wasmModuleBytes } from '../src/wasm.js';

/** site/lib/fx.a0 (signed Q16.16 math) against an exact BigInt oracle, on the interpreter and on wasm. */

const SCALAR = [
  'fx_isneg',
  'fx_neg',
  'fx_abs',
  'fx_lt',
  'fx_min',
  'fx_max',
  'fx_clamp',
  'fx_sar',
  'fx_mul',
  'fx_div',
  'fx_lerp',
  'fx_isqrt',
  'fx_sqrt',
  'fx_hyp',
  'fx_dot',
  'fx_cross',
  'fx_sin',
  'fx_cos',
  'fx_atan2',
  'fx_rng',
  'fx_hash',
];

const s32 = (x: number): number => x | 0;
const u32 = (x: number): number => x >>> 0;
const big = (x: number): bigint => BigInt(s32(x));
const wrap = (x: bigint): number => u32(Number(BigInt.asUintN(32, x)));
const fl = (q: number): number => s32(q) / 65536;

/** Deterministic pseudo-random sequence for the test inputs (not the library's own generator). */
function* inputs(seed: number): Generator<number> {
  let s = seed >>> 0 || 1;
  for (;;) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    yield s;
  }
}

async function load(): Promise<{
  program: TypedProgram;
  call: (name: string, ...args: number[]) => number;
}> {
  const program = (await link('site/lib/fx.a0', (f) => readFile(f, 'utf8'), { root: '.' })).program;
  return {
    program,
    call: (name, ...args) => {
      const r = run(program.byName.get(name) as TypedFunc, args);
      return typeof r === 'boolean' ? (r ? 1 : 0) : (r as number);
    },
  };
}

async function wasmCalls(
  program: TypedProgram,
  optimize: boolean,
): Promise<(name: string, ...args: number[]) => number> {
  const text = compile(program, 'wasm', { optimize, exports: SCALAR } as never).text;
  const { instance } = await WebAssembly.instantiate(wasmModuleBytes(text) as BufferSource, {});
  const e = instance.exports as Record<string, (...a: number[]) => number>;
  return (name, ...args) => u32((e[`a0_${name}`] as (...a: number[]) => number)(...args.map(s32)));
}

/** Operands: edge values first, then random values of mixed magnitude. */
function operands(count: number, seed: number): number[] {
  const edge = [
    0, 1, 65535, 65536, 65537, 131072, 0x7fffffff, 0x80000000, 0xffffffff, 0xffff0000, 12345678,
  ];
  const g = inputs(seed);
  const out = [...edge];
  while (out.length < count) {
    const r = g.next().value as number;
    const shift = (g.next().value as number) % 24;
    out.push(u32(s32(r) >> shift));
  }
  return out;
}

test('fx: arithmetic matches the BigInt oracle (interpreter and wasm, optimized and not)', async () => {
  const { program, call } = await load();
  const impls = [call, await wasmCalls(program, true), await wasmCalls(program, false)];
  const xs = operands(60, 7);
  const ys = operands(60, 11);
  for (const f of impls) {
    for (const a of xs.slice(0, 40)) {
      assert.equal(f('fx_neg', a), wrap(-big(a)));
      assert.equal(f('fx_abs', a), wrap(big(a) < 0n ? -big(a) : big(a)));
      assert.equal(f('fx_isneg', a), s32(a) < 0 ? 1 : 0);
      for (const n of [0, 1, 7, 16, 31]) assert.equal(f('fx_sar', a, n), wrap(big(a) >> BigInt(n)));
      for (const b of ys.slice(0, 40)) {
        assert.equal(f('fx_lt', a, b), s32(a) < s32(b) ? 1 : 0, `lt ${a} ${b}`);
        assert.equal(f('fx_min', a, b), u32(Math.min(s32(a), s32(b))));
        assert.equal(f('fx_max', a, b), u32(Math.max(s32(a), s32(b))));
        // multiply: when the true product fits, it is the product truncated toward zero
        const p = (big(a) * big(b)) / 65536n;
        if (p >= -(1n << 31n) && p < 1n << 31n)
          assert.equal(f('fx_mul', a, b), wrap(p), `mul ${a} ${b}`);
        // divide: truncated toward zero, 16 fractional bits, b = 0 saturates
        if (s32(b) !== 0 && s32(b) !== -0x80000000 && s32(a) !== -0x80000000) {
          const q = (big(a) << 16n) / big(b);
          if (q >= -(1n << 31n) && q < 1n << 31n)
            assert.equal(f('fx_div', a, b), wrap(q), `div ${a} ${b}`);
        }
        const d = big(b) - big(a);
        if (d >= -(1n << 31n) && d < 1n << 31n)
          assert.equal(
            f('fx_lerp', a, b, 32768),
            wrap(big(a) + (d * 32768n) / 65536n),
            `lerp ${a} ${b}`,
          );
      }
      assert.equal(f('fx_div', a, 0), 0x7fffffff);
    }
    assert.equal(f('fx_clamp', u32(-5 * 65536), 0, 65536), 0);
    assert.equal(f('fx_clamp', 3 * 65536, 0, 65536), 65536);
    assert.equal(f('fx_clamp', 30000, 0, 65536), 30000);
  }
});

test('fx: integer and Q16 square roots, hypotenuse', async () => {
  const { program, call } = await load();
  for (const f of [call, await wasmCalls(program, true)]) {
    for (const x of [
      0,
      1,
      2,
      3,
      4,
      15,
      16,
      17,
      65535,
      65536,
      1 << 30,
      0x7fffffff,
      0xffffffff,
      123456789,
    ]) {
      const r = Number(BigInt(Math.floor(Math.sqrt(x))));
      assert.equal(f('fx_isqrt', x), r, `isqrt ${x}`);
    }
    for (const x of operands(80, 3)) {
      const v = f('fx_sqrt', x);
      if (s32(x) < 0) {
        assert.equal(v, 0);
        continue;
      }
      const exact = Math.floor(Math.sqrt(x * 65536));
      const tol = x < 65536 ? 0 : x < 16777216 ? 16 : 256;
      assert.ok(Math.abs(v - exact) <= tol, `sqrt ${x}: ${v} vs ${exact}`);
    }
    for (const [x, y] of [
      [3, 4],
      [-6, 8],
      [0, 0],
      [120, -50],
      [900, 1200],
      [5000, 1],
      [-20000, 20000],
    ] as const) {
      const h = fl(f('fx_hyp', u32(x * 65536), u32(y * 65536)));
      assert.ok(
        Math.abs(h - Math.hypot(x, y)) <= Math.max(0.01, Math.hypot(x, y) * 1e-3),
        `hyp ${x},${y}: ${h}`,
      );
    }
  }
});

test('fx: sine, cosine, arctangent stay within the stated error', async () => {
  const { program, call } = await load();
  for (const f of [call, await wasmCalls(program, true)]) {
    for (let a = 0; a < 65536; a += 97) {
      const t = (a / 65536) * 2 * Math.PI;
      assert.ok(Math.abs(fl(f('fx_sin', a)) - Math.sin(t)) < 1e-4, `sin ${a}`);
      assert.ok(Math.abs(fl(f('fx_cos', a)) - Math.cos(t)) < 1e-4, `cos ${a}`);
    }
    assert.equal(f('fx_sin', 0), 0);
    assert.equal(f('fx_sin', 16384), 65536);
    assert.equal(f('fx_cos', 0), 65536);
    for (const [y, x] of [
      [1, 1],
      [1, 0],
      [0, 1],
      [-1, 1],
      [3, -4],
      [-3, -4],
      [0, -1],
      [1000, 3],
      [-7, 1000],
    ] as const) {
      const want = ((Math.atan2(y, x) / (2 * Math.PI)) * 65536 + 65536) % 65536;
      const got = f('fx_atan2', u32(y * 65536), u32(x * 65536));
      const diff = Math.min(Math.abs(got - want), 65536 - Math.abs(got - want));
      assert.ok(diff < 20, `atan2 ${y},${x}: ${got} vs ${want}`);
    }
    assert.equal(f('fx_atan2', 0, 0), 0);
  }
});

test('fx: unit vectors, dot and cross products, generators', async () => {
  const { program, call } = await load();
  const unit = program.byName.get('fx_unit') as TypedFunc;
  for (const [x, y] of [
    [3, 4],
    [-12, 5],
    [0, -9],
    [200, 200],
  ] as const) {
    const [ux, uy] = run(unit, [u32(x * 65536), u32(y * 65536)]) as number[];
    const n = Math.hypot(x, y);
    assert.ok(Math.abs(fl(ux as number) - x / n) < 2e-3, `unit x ${x},${y}`);
    assert.ok(Math.abs(fl(uy as number) - y / n) < 2e-3, `unit y ${x},${y}`);
  }
  assert.deepEqual(run(unit, [0, 0]), [65536, 0]);
  assert.equal(
    fl(call('fx_dot', u32(2 * 65536), u32(3 * 65536), u32(-4 * 65536), u32(5 * 65536))),
    7,
  );
  assert.equal(
    fl(call('fx_cross', u32(2 * 65536), u32(3 * 65536), u32(-4 * 65536), u32(5 * 65536))),
    22,
  );
  // xorshift32 against the reference recurrence; the hash is deterministic and spreads
  let s = 2463534242;
  for (let i = 0; i < 50; i += 1) {
    const want = (() => {
      let x = s;
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      return x >>> 0;
    })();
    assert.equal(call('fx_rng', s), want);
    s = want;
  }
  const seen = new Set<number>();
  for (let i = 0; i < 200; i += 1) seen.add(call('fx_hash', i, 17));
  assert.equal(seen.size, 200);
  assert.equal(call('fx_hash', 5, 9), call('fx_hash', 5, 9));
});
