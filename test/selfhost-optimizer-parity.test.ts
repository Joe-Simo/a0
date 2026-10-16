import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  A0Error,
  formatProgram,
  parseAndValidate,
  run,
  type TypedProgram,
  type Value,
} from '../src/core.js';
import { optimizeFunction } from '../src/optimize.js';
import { findClang, spawnWithInput } from '../src/toolchain.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import {
  a0OptimizeProgram,
  buildWasmTool,
  optimizedProgram,
  typescriptBodies,
} from '../tools/selfhost-wasm.js';

// The production path has no reference/fallback argument. A0W_TOOL lets a gate reuse its
// already-built tool; otherwise the test builds one once through the verified bootstrap seed.
const SKIP =
  process.env.A0W_TOOL !== undefined
    ? false
    : findClang().path === undefined
      ? 'clang not found'
      : false;
let buildRoot: string | undefined;
let tool: Promise<string> | undefined;
after(async () => {
  if (buildRoot !== undefined) await rm(buildRoot, { recursive: true, force: true });
});
function executable(): Promise<string> {
  tool ??=
    process.env.A0W_TOOL !== undefined
      ? Promise.resolve(process.env.A0W_TOOL)
      : (async () => {
          await mkdir('.a0-cache', { recursive: true });
          buildRoot = await mkdtemp(resolve('.a0-cache', 'selfhost-optimizer-'));
          return (await buildWasmTool(findClang(), undefined, buildRoot)).exe;
        })();
  return tool;
}

async function sameIr(program: TypedProgram, image = false): Promise<TypedProgram> {
  const result = a0OptimizeProgram(await executable(), program, undefined, undefined, image);
  assert.deepEqual(result.bodies, typescriptBodies(program), `exact A0/TS IR, image=${image}`);
  // The emitter's IR adapter leaves calls unresolved. Bind them only in this interpreter
  // harness; production A0 emission must not acquire a TypeScript validation dependency.
  return parseAndValidate(formatProgram(optimizedProgram(program, result.bodies)));
}

function fn(program: TypedProgram, name: string) {
  const result = program.byName.get(name);
  if (result === undefined) throw new Error(`missing ${name}`);
  return result;
}

// Stable nonlinear scalar chains retain every node. Calls target a 17-node leaf, so they
// remain calls when the wrapper body is optimized. Variable folds/loops also remain nodes.
function chain(first: string, count: number, extra: string): { lines: string[]; ret: string } {
  const lines: string[] = [];
  let ret = first;
  for (let i = 0; i < count; i += 1) {
    const id = `n${i}`;
    lines.push(`${id} ${i % 2 === 0 ? 'mul' : 'xor'} ${ret} ${extra}`);
    ret = id;
  }
  return { lines, ret };
}

function weightedSource(
  kind: 'call' | 'fold' | 'loop',
  scalarNodes: number,
  trips?: number,
): string {
  const leaf = chain('p0', 17, 'p1');
  const body = chain('head', scalarNodes, trips === undefined ? 'p0' : 'p2');
  const setup = [
    'fn leaf u32 u32 -> u32',
    ...leaf.lines,
    `ret ${leaf.ret}`,
    'end',
    'fn step u32 u32 u32 -> u32',
    'v add p0 p2',
    'ret v',
    'end',
    'fn pred u32 u32 u32 -> bool',
    'v lt p1 p2',
    'ret v',
    'end',
  ];
  const signature = trips === undefined ? 'u32 u32' : 'u32 u32 u32';
  const head =
    kind === 'call'
      ? `head call leaf p0 ${trips === undefined ? 'p1' : 'p2'}`
      : kind === 'fold'
        ? 'head fold step p1 p0 p0'
        : 'head loop pred step p1 p0 p0';
  const wrapper = [`fn wrapper ${signature} -> u32`, head, ...body.lines, `ret ${body.ret}`, 'end'];
  const top =
    trips === undefined
      ? ['fn top u32 u32 -> u32', 'r call wrapper p0 p1', 'ret r', 'end']
      : ['fn top u32 u32 -> u32', `r fold wrapper ${trips} p0 p1`, 'ret r', 'end'];
  return [...setup, ...wrapper, ...top, ''].join('\n');
}

for (const kind of ['call', 'fold', 'loop'] as const) {
  for (const scalarNodes of [11, 12]) {
    test(`A0 weighted inline threshold: ${kind} plus ${scalarNodes} ordinary nodes`, {
      skip: SKIP,
    }, async () => {
      const p = parseAndValidate(weightedSource(kind, scalarNodes));
      const wrapper = optimizeFunction(fn(p, 'wrapper')).fn;
      const cost = wrapper.nodes.reduce(
        (s, n) => s + (['call', 'fold', 'loop'].includes(n.op) ? 5 : 1),
        0,
      );
      assert.equal(cost, 5 + scalarNodes, 'fixture retains exactly its intended weighted cost');
      const expectedCall = scalarNodes === 12;
      assert.equal(
        optimizeFunction(fn(p, 'top')).fn.nodes.some((n) => n.callee === 'wrapper'),
        expectedCall,
      );
      const a = await sameIr(p);
      for (const args of [
        [0, 0],
        [7, 3],
        [0xffff_ffff, 9],
      ])
        assert.deepEqual(run(fn(a, 'top'), args), run(fn(p, 'top'), args));
    });
  }
}

for (const scalarNodes of [251, 252]) {
  test(`A0 weighted unroll threshold: one call plus ${scalarNodes} ordinary nodes`, {
    skip: SKIP,
  }, async () => {
    const p = parseAndValidate(weightedSource('call', scalarNodes, 8));
    const wrapper = optimizeFunction(fn(p, 'wrapper')).fn;
    const cost = wrapper.nodes.reduce(
      (s, n) => s + (['call', 'fold', 'loop'].includes(n.op) ? 5 : 1),
      0,
    );
    assert.equal(cost, 5 + scalarNodes, 'fixture crosses 256 at the intended boundary');
    assert.equal(
      optimizeFunction(fn(p, 'top')).fn.nodes.some((n) => n.op === 'fold'),
      scalarNodes === 252,
    );
    const a = await sameIr(p);
    for (const args of [
      [7, 3],
      [0xffff_ffff, 9],
    ])
      assert.deepEqual(run(fn(a, 'top'), args), run(fn(p, 'top'), args));
  });
}

function matrixSource(n: number, side: 'right' | 'left', trips: number, indirect = false): string {
  const lines = [`fn matrix_step u32x${n * n} u32 u32x${n * n} -> u32x${n * n}`];
  for (let i = 0; i < n * n; i += 1) lines.push(`s${i} get p0 ${i}`, `m${i} get p2 ${i}`);
  const result: string[] = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      let sum = '';
      for (let k = 0; k < n; k += 1) {
        const id = `v${r}_${c}_${k}`;
        lines.push(
          side === 'right'
            ? `${id} mul s${r * n + k} m${k * n + c}`
            : `${id} mul m${r * n + k} s${k * n + c}`,
        );
        if (k === 0) sum = id;
        else {
          lines.push(`a${r}_${c}_${k} add ${sum} ${id}`);
          sum = `a${r}_${c}_${k}`;
        }
      }
      result.push(sum);
    }
  }
  lines.push(`r arr ${result.join(' ')}`, 'ret r', 'end');
  if (indirect) lines.push('fn count u32 -> u32', 'ret p0', 'end');
  lines.push(`fn top u32x${n * n} u32x${n * n} -> u32x${n * n}`);
  if (indirect) lines.push(`n call count ${trips}`);
  lines.push(`r fold matrix_step ${indirect ? 'n' : trips} p0 p1`, 'ret r', 'end', '');
  return lines.join('\n');
}

const mask = 0xffff_ffffn;
function product(x: readonly bigint[], y: readonly bigint[], n: number): bigint[] {
  return Array.from({ length: n * n }, (_, i) => {
    let v = 0n;
    for (let k = 0; k < n; k += 1) {
      const a = x[Math.floor(i / n) * n + k];
      const b = y[k * n + (i % n)];
      assert.ok(a !== undefined && b !== undefined);
      v = (v + a * b) & mask;
    }
    return v;
  });
}
function powerOracle(
  state: readonly number[],
  matrix: readonly number[],
  n: number,
  trips: number,
  side: 'right' | 'left',
): number[] {
  let acc = state.map(BigInt);
  let pow = matrix.map(BigInt);
  for (let left = BigInt(trips); left > 0n; left >>= 1n) {
    if ((left & 1n) !== 0n) acc = side === 'right' ? product(acc, pow, n) : product(pow, acc, n);
    if (left > 1n) pow = product(pow, pow, n);
  }
  return acc.map(Number);
}

test('A0 optimizer: the full unchanged mat4 kernel, including its literal eight trips', {
  skip: SKIP,
}, async () => {
  const source = KERNELS.find((k) => k.name === 'mat4')?.a0;
  assert.ok(source);
  assert.match(source, /r fold mulstep 8 a b/);
  const p = parseAndValidate(source);
  const a = await sameIr(p);
  await sameIr(p, true); // mode8 computes its own summaries and exercises the table entry too
  for (const args of [
    [0, 0],
    [7, 13],
    [0xffff_ffff, 0x8000_0000],
  ])
    assert.equal(run(fn(a, 'mat4'), args), run(fn(p, 'mat4'), args));
});

for (const n of [2, 3, 4]) {
  for (const side of ['right', 'left'] as const) {
    test(`A0 matrix power n=${n} ${side}: associative u32 result and exact IR`, {
      skip: SKIP,
    }, async () => {
      const trips = n === 3 ? 13 : 8;
      const p = parseAndValidate(matrixSource(n, side, trips));
      const a = await sameIr(p);
      assert.ok(!fn(a, 'top').nodes.some((node) => node.op === 'fold'), 'powering actually ran');
      const state = Array.from({ length: n * n }, (_, i) => (0xffff_ff00 + i * 17) >>> 0);
      const matrix = Array.from({ length: n * n }, (_, i) => (0x8000_0001 + i * 31) >>> 0);
      const want = powerOracle(state, matrix, n, trips, side);
      assert.deepEqual(run(fn(a, 'top'), [state, matrix]), want);
      assert.deepEqual(run(fn(p, 'top'), [state, matrix]), want);
    });
  }
}

test('matrix recognition accepts a larger invariant array and rejects repeated terms or wrapped reads', {
  skip: SKIP,
}, async () => {
  const base = matrixSource(2, 'right', 8);
  const variants = [
    [
      'larger invariant',
      base
        .replace('fn matrix_step u32x4 u32 u32x4', 'fn matrix_step u32x4 u32 u32x8')
        .replace('fn top u32x4 u32x4', 'fn top u32x4 u32x8'),
      [5, 6, 7, 8, 9, 10, 11, 12],
    ],
    ['duplicate term', base.replace('v0_0_1 mul s1 m2', 'v0_0_1 mul s0 m0'), [5, 6, 7, 8]],
    ['wrapped read', base.replace('m3 get p2 3', 'm3 get p2 7'), [5, 6, 7, 8]],
  ] as const;
  for (const [label, source, matrix] of variants) {
    assert.notEqual(source, base, `${label}: mutation applied`);
    const p = parseAndValidate(source);
    const a = await sameIr(p);
    const args: Value[] = [[1, 2, 3, 4], [...matrix]];
    assert.deepEqual(run(fn(a, 'top'), args), run(fn(p, 'top'), args), label);
  }
});

test('matrix power respects the products-times-cubic-dimension budget', {
  skip: SKIP,
}, async () => {
  const p = parseAndValidate(matrixSource(8, 'right', 8));
  const a = await sameIr(p);
  assert.ok(
    fn(a, 'top').nodes.some((node) => node.op === 'fold'),
    'over-budget recurrence stays a fold',
  );
  const args: Value[] = [
    Array.from({ length: 64 }, (_, i) => i + 1),
    Array.from({ length: 64 }, (_, i) => i * 3 + 5),
  ];
  assert.deepEqual(run(fn(a, 'top'), args), run(fn(p, 'top'), args));
});

for (const trips of [0x8000_0000, 0x8000_0001, 0xffff_ffff]) {
  test(`matrix exponent exposed by inlining retains all u32 bits: ${trips}`, {
    skip: SKIP,
  }, async () => {
    const p = parseAndValidate(matrixSource(2, 'right', trips, true));
    // The original accepted program has a variable fold count. Never execute its billions
    // of trips: the independent logarithmic BigInt oracle checks only optimized tiny output.
    const state = [1, 2, 3, 4];
    const matrix = [1, 1, 0, 1];
    const want = powerOracle(state, matrix, 2, trips, 'right');
    const ts = optimizeFunction(fn(p, 'top')).fn;
    assert.ok(!ts.nodes.some((node) => node.op === 'fold'));
    assert.deepEqual(run(ts, [state, matrix]), want);
    const a = await sameIr(p);
    assert.deepEqual(run(fn(a, 'top'), [state, matrix]), want);
  });
}

test('A0 optimization refuses strict input before starting a tool', () => {
  for (const source of ['profile strict\nfn f u32 -> u32\nret p0\nend\n']) {
    const p = parseAndValidate(source);
    assert.throws(
      () => a0OptimizeProgram('unusable-tool-must-not-run', p),
      (e: unknown) => e instanceof A0Error && e.id === 'A0713',
    );
  }
});

// Mutation controls for these regression cases:
// 1. edcost returning cost+1 must fail weighted threshold IR tests.
// 2. disable `power` in edstep must fail unchanged mat4 IR and powering assertions.
// 3. reverse side selection in mxpowstep must fail left/right BigInt comparisons.
// 4. restore TS signed `left >>=1` must fail all high-bit exponent oracle cases.

function checkedTableWords(mode: 7 | 8, op: number): number[] {
  // Fully typed checked-result function. Parameter0 is u32x4 for cget, u32 otherwise.
  const types = [1, 0, 0, 2, 0, 0, 3, 0, 0, 5, 0, 2, 4, 4, 0];
  const tlist = [0, 1, op === 37 ? 4 : 0, 0];
  const fnt = [3, 2, 2, 3, 0, 1, 0x1000_0000];
  const nd = [0, op, 2, 0, 0, 0];
  const args = [2, 0, 2, 1];
  return [
    mode,
    5,
    ...types,
    tlist.length,
    ...tlist,
    1,
    ...fnt,
    1,
    ...nd,
    3,
    2,
    ...args,
    ...(mode === 7 ? [1, op === 37 ? 16 : 17, 0, 0] : [0]),
  ];
}

test('raw optimizer modes retain every typed checked opcode and reject unknown opcodes', {
  skip: SKIP,
}, async () => {
  const exe = await executable();
  for (const mode of [7, 8] as const) {
    for (const op of [32, 33, 34, 35, 36, 37, 0, 38, 0xffff_ffff]) {
      const words = checkedTableWords(mode, op);
      const input = Buffer.alloc(words.length * 4);
      words.forEach((word, i) => {
        input.writeUInt32LE(word >>> 0, i * 4);
      });
      const r = spawnWithInput(exe, input, { timeout: 60_000, maxBuffer: 1 << 20 });
      const known = op >= 32 && op <= 37;
      assert.equal(r.status, known ? 0 : 5, `mode${mode}, op${op}: admission`);
      if (!known) assert.equal(r.stdout.length, 0, 'unknown ops write no partial body');
      else {
        assert.equal(r.stdout.length % 4, 0);
        const out = Array.from({ length: r.stdout.length / 4 }, (_, i) =>
          r.stdout.readUInt32LE(i * 4),
        );
        const expected =
          mode === 7
            ? [1, op, 2, 0, 0, 3, 2, 0, 2, 1, 1, 0, 1]
            : [0, 1, 1, 0, 1, 2, 0, 0, op, 2, 0, 0, 3, 2, 0, 2, 1];
        assert.deepEqual(out, expected, 'record result remains a typed checked node');
      }
    }
  }
});

test('A0 matrix parameter after a bool-array decoy uses the full host argument position', {
  skip: SKIP,
}, async () => {
  const base = matrixSource(2, 'right', 13);
  const source = base
    .replace('fn matrix_step u32x4 u32 u32x4', 'fn matrix_step u32x4 u32 boolx4 u32x4')
    .replace(/get p2 /g, 'get p3 ')
    .replace('fn top u32x4 u32x4', 'fn top u32x4 boolx4 u32x4')
    .replace('13 p0 p1', '13 p0 p1 p2');
  assert.notEqual(source, base, 'matrix parameter moved to p3');
  const p = parseAndValidate(source);
  const a = await sameIr(p);
  assert.ok(!fn(a, 'top').nodes.some((node) => node.op === 'fold'), 'powering ran');
  const state = [1, 2, 3, 4];
  const matrix = [5, 6, 7, 8];
  const args: Value[] = [state, [true, false, true, false], matrix];
  assert.deepEqual(run(fn(a, 'top'), args), powerOracle(state, matrix, 2, 13, 'right'));
  const shared = [1, 2, 3, 4];
  const before = [...shared];
  assert.deepEqual(
    run(fn(a, 'top'), [shared, [false, false, false, false], shared]),
    powerOracle(shared, shared, 2, 13, 'right'),
  );
  assert.deepEqual(shared, before, 'shared input remains a value');
});

test('A0 matrix power preserves a later observation of its original state', {
  skip: SKIP,
}, async () => {
  const base = matrixSource(2, 'right', 13);
  const source = base
    .replace('fn top u32x4 u32x4 -> u32x4', 'fn top u32x4 u32x4 -> (u32x4,u32x4)')
    .replace(
      'r fold matrix_step 13 p0 p1\nret r\nend',
      'r fold matrix_step 13 p0 p1\nold rec r p0\nret old\nend',
    );
  assert.notEqual(source, base, 'original state is observed after the fold');
  const p = parseAndValidate(source);
  const a = await sameIr(p);
  assert.ok(!fn(a, 'top').nodes.some((node) => node.op === 'fold'));
  const shared = [1, 2, 3, 4];
  const before = [...shared];
  assert.deepEqual(run(fn(a, 'top'), [shared, shared]), [
    powerOracle(shared, shared, 2, 13, 'right'),
    before,
  ]);
  assert.deepEqual(shared, before);
});

test('A0 matrix recognition rejects mixed invariant parameters and record state', {
  skip: SKIP,
}, async () => {
  const base = matrixSource(2, 'right', 13);
  const mixed = base
    .replace('fn matrix_step u32x4 u32 u32x4', 'fn matrix_step u32x4 u32 u32x4 u32x4')
    .replace('m1 get p2 1', 'm1 get p3 1')
    .replace('fn top u32x4 u32x4', 'fn top u32x4 u32x4 u32x4')
    .replace('13 p0 p1', '13 p0 p1 p2');
  const record = base
    .replace(
      'fn matrix_step u32x4 u32 u32x4 -> u32x4',
      'fn matrix_step (u32x4,u32) u32 u32x4 -> (u32x4,u32)\nstate at p0 0',
    )
    .replace(/get p0 /g, 'get state ')
    .replace('ret r\nend\nfn top', 'old rec r 17\nret old\nend\nfn top')
    .replace('fn top u32x4 u32x4 -> u32x4', 'fn top (u32x4,u32) u32x4 -> (u32x4,u32)');
  const cases: { label: string; source: string; args: Value[] }[] = [
    {
      label: 'mixed matrices',
      source: mixed,
      args: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [31, 37, 41, 43],
      ],
    },
    {
      label: 'record state',
      source: record,
      args: [
        [[1, 2, 3, 4], 99],
        [5, 6, 7, 8],
      ],
    },
  ];
  for (const { label, source, args } of cases) {
    assert.notEqual(source, base, `${label}: mutation applied`);
    const p = parseAndValidate(source);
    const a = await sameIr(p);
    assert.ok(
      fn(a, 'top').nodes.some((node) => node.op === 'fold'),
      `${label}: fold retained`,
    );
    assert.deepEqual(run(fn(a, 'top'), args), run(fn(p, 'top'), args), label);
  }
});

test('A0 matrix recognition rejects duplicate terms and wrapped indices above the unroll range', {
  skip: SKIP,
}, async () => {
  const base = matrixSource(2, 'right', 13);
  for (const [label, source] of [
    ['duplicate term', base.replace('v0_0_1 mul s1 m2', 'v0_0_1 mul s0 m0')],
    ['wrapped read', base.replace('m3 get p2 3', 'm3 get p2 7')],
  ]) {
    assert.ok(source !== undefined && label !== undefined);
    assert.notEqual(source, base, `${label}: mutation applied`);
    const p = parseAndValidate(source);
    const a = await sameIr(p);
    assert.ok(
      fn(a, 'top').nodes.some((node) => node.op === 'fold'),
      `${label}: fold retained`,
    );
    const args: Value[] = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ];
    assert.deepEqual(run(fn(a, 'top'), args), run(fn(p, 'top'), args), label);
  }
});

test('A0 matrix power retains a fold whose body has an unused IO parameter', {
  skip: SKIP,
}, async () => {
  const { makeIo } = await import('../src/core.js');
  const base = matrixSource(2, 'right', 13);
  const source = base
    .replace('fn matrix_step u32x4 u32 u32x4', 'fn matrix_step u32x4 u32 u32x4 io')
    .replace('fn top u32x4 u32x4', 'fn top u32x4 u32x4 io')
    .replace('13 p0 p1', '13 p0 p1 p2');
  assert.notEqual(source, base, 'IO extra added');
  const p = parseAndValidate(source);
  const a = await sameIr(p);
  assert.ok(
    fn(a, 'top').nodes.some((node) => node.op === 'fold'),
    'IO-containing body is kept',
  );
  const ioA = makeIo();
  const ioB = makeIo();
  assert.deepEqual(
    run(fn(a, 'top'), [[1, 2, 3, 4], [5, 6, 7, 8], ioA]),
    run(fn(p, 'top'), [[1, 2, 3, 4], [5, 6, 7, 8], ioB]),
  );
  assert.deepEqual(ioA.output, []);
  assert.deepEqual(ioB.output, []);
});
