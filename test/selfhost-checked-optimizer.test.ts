import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  A0Error,
  assertTargetSupports,
  formatProgram,
  makeIo,
  parseAndValidate,
  run,
  type TypedProgram,
} from '../src/core.js';
import { optimizeFunction } from '../src/optimize.js';
import { findClang, spawnWithInput } from '../src/toolchain.js';
import {
  a0OptimizeProgram,
  buildWasmTool,
  optimizedProgram,
  typescriptBodies,
} from '../tools/selfhost-wasm.js';

// Exact IR is checked before the interpreter harness rebinds calls. The production call
// below has no reference/fallback arguments. Keep isolated build roots and optional tool reuse.
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
          buildRoot = await mkdtemp(resolve('.a0-cache', 'selfhost-checked-optimizer-'));
          return (await buildWasmTool(findClang(), undefined, buildRoot)).exe;
        })();
  return tool;
}
async function sameIr(program: TypedProgram, image = false): Promise<TypedProgram> {
  const result = a0OptimizeProgram(await executable(), program, undefined, undefined, image);
  assert.deepEqual(result.bodies, typescriptBodies(program), `exact A0/TS IR, image=${image}`);
  return parseAndValidate(formatProgram(optimizedProgram(program, result.bodies)));
}
function fn(program: TypedProgram, name: string) {
  const f = program.byName.get(name);
  if (f === undefined) throw new Error(`missing ${name}`);
  return f;
}

const CHECKED = ['cadd', 'csub', 'cmul', 'cdiv', 'crem', 'cget'] as const;
type Checked = (typeof CHECKED)[number];
type Arithmetic = Exclude<Checked, 'cget'>;
const U32 = 0xffff_ffffn;
function arithmetic(op: Arithmetic, a: number, b: number): [number, boolean] {
  const x = BigInt(a);
  const y = BigInt(b);
  switch (op) {
    case 'cadd':
      return [Number((x + y) & U32), x + y <= U32];
    case 'csub':
      return [Number((x - y) & U32), x >= y];
    case 'cmul':
      return [Number((x * y) & U32), x * y <= U32];
    case 'cdiv':
      return y === 0n ? [0, false] : [Number(x / y), true];
    case 'crem':
      return y === 0n ? [0, false] : [Number(x % y), true];
  }
}
function checkedGet(a: readonly number[], i: number): [number, boolean] {
  const v = a[i];
  return v === undefined ? [0, false] : [v, true];
}
const PAIRS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [0xffff_ffff, 1],
  [1, 0xffff_ffff],
  [65535, 65537],
  [65536, 65536],
  [0xffff_ffff, 0xffff_ffff],
];

function directSource(op: Checked): string {
  if (op === 'cget')
    return `fn f u32x4 u32 -> (u32,bool)
q cget p0 p1
ret q
end
fn literal -> (u32,bool)
a arr 1 7 4294967295 11
q cget a 4
ret q
end
`;
  return `fn f u32 u32 -> (u32,bool)
q ${op} p0 p1
ret q
end
fn literal -> (u32,bool)
q ${op} 4294967295 0
ret q
end
`;
}

for (const op of CHECKED) {
  test(`checked optimizer retains direct ${op} records, including constant operands`, {
    skip: SKIP,
  }, async () => {
    const p = parseAndValidate(directSource(op));
    const a = await sameIr(p);
    await sameIr(p, true);
    assert.ok(fn(a, 'f').nodes.some((n) => n.op === op));
    assert.ok(
      fn(a, 'literal').nodes.some((n) => n.op === op),
      'record has no scalar literal form',
    );
    if (op === 'cget') {
      const input = [1, 7, 0xffff_ffff, 11];
      for (const i of [0, 3, 4, 0xffff_ffff])
        assert.deepEqual(run(fn(a, 'f'), [input, i]), checkedGet(input, i));
      assert.deepEqual(run(fn(a, 'literal'), []), [0, false]);
    } else {
      for (const [x, y] of PAIRS) assert.deepEqual(run(fn(a, 'f'), [x, y]), arithmetic(op, x, y));
      assert.deepEqual(run(fn(a, 'literal'), []), arithmetic(op, 0xffff_ffff, 0));
    }
  });
}

for (const op of CHECKED) {
  test(`checked optimizer CSE is exact and ordered for ${op}`, { skip: SKIP }, async () => {
    const source =
      op === 'cget'
        ? `fn f u32x4 u32 -> ((u32,bool),(u32,bool))
a cget p0 p1
b cget p0 p1
r rec a b
ret r
end
`
        : `fn f u32 u32 -> ((u32,bool),(u32,bool),(u32,bool))
a ${op} p0 p1
b ${op} p0 p1
c ${op} p1 p0
r rec a b c
ret r
end
`;
    const p = parseAndValidate(source);
    const a = await sameIr(p);
    const nodes = fn(a, 'f').nodes.filter((n) => n.op === op);
    assert.equal(
      nodes.length,
      op === 'cget' ? 1 : 2,
      'identical operands merge; reversed arithmetic operands keep the reference IR',
    );
    if (op === 'cget') {
      const input = [5, 7, 11, 13];
      for (const i of [0, 3, 4, 0xffff_ffff]) {
        const pair = checkedGet(input, i);
        assert.deepEqual(run(fn(a, 'f'), [input, i]), [pair, pair]);
      }
    } else {
      for (const [x, y] of PAIRS) {
        const pair = arithmetic(op, x, y);
        assert.deepEqual(run(fn(a, 'f'), [x, y]), [pair, pair, arithmetic(op, y, x)]);
      }
    }
  });
}

function chain(x: number, y: number): number {
  let v = x;
  for (let i = 0; i < 17; i += 1) v = i % 2 === 0 ? Math.imul(v, y) >>> 0 : (v ^ y) >>> 0;
  return v;
}
function leafSource(op: Checked): string {
  const lines = ['fn leaf u32 u32 -> u32'];
  let last = 'p0';
  for (let i = 0; i < 17; i += 1) {
    lines.push(`n${i} ${i % 2 === 0 ? 'mul' : 'xor'} ${last} p1`);
    last = `n${i}`;
  }
  if (op === 'cget') lines.push(`a arr ${last} p0 p1 999`, 'q cget a p1');
  else lines.push(`q ${op} ${last} p1`);
  lines.push('v at q 0', 'ok at q 1', 'tag select ok 0 2779096485', 'r xor v tag', 'ret r', 'end');
  for (const [i, [x, y]] of PAIRS.entries())
    lines.push(`fn case${i} -> u32`, `r call leaf ${x} ${y}`, 'ret r', 'end');
  return `${lines.join('\n')}\n`;
}
for (const op of CHECKED) {
  test(`checked ${op} executes inside a long scalar callee folded on literal arguments`, {
    skip: SKIP,
  }, async () => {
    const p = parseAndValidate(leafSource(op));
    const leaf = optimizeFunction(fn(p, 'leaf')).fn;
    assert.ok(leaf.nodes.length > 16, 'callee exceeds the ordinary inlining threshold');
    assert.ok(leaf.nodes.some((n) => n.op === op));
    for (const image of [false, true]) {
      const a = await sameIr(p, image);
      for (const [i, [x, y]] of PAIRS.entries()) {
        const v = chain(x, y);
        const pair = op === 'cget' ? checkedGet([v, x, y, 999], y) : arithmetic(op, v, y);
        const want = (pair[0] ^ (pair[1] ? 0 : 0xa5a5_a5a5)) >>> 0;
        const f = fn(a, `case${i}`);
        assert.equal(f.nodes.length, 0, 'a literal scalar result proves evaluator folding ran');
        assert.deepEqual(f.ret, { kind: 'u32', value: want });
        assert.equal(run(f, []), want);
        assert.equal(run(fn(p, `case${i}`), []), want);
      }
    }
  });
}

const ITERATIONS = `fn step u32 u32 u32 u32 -> u32
q cadd p0 p2
v at q 0
ok at q 1
tag select ok 0 p3
r xor v tag
ret r
end
fn pred u32 u32 u32 u32 -> bool
q csub p3 p0
ok at q 1
ret ok
end
fn folded u32 u32 u32 u32 -> u32
r fold step p0 p1 p2 p3
ret r
end
fn looped u32 u32 u32 u32 -> u32
r loop pred step p0 p1 p2 p3
ret r
end
`;
function iterationOracle(args: readonly number[], loop: boolean): number {
  const [count = 0, initial = 0, delta = 0, limit = 0] = args;
  let state = initial;
  for (let i = 0; i < count; i += 1) {
    if (loop && state > limit) break;
    const [v, ok] = arithmetic('cadd', state, delta);
    state = (v ^ (ok ? 0 : limit)) >>> 0;
  }
  return state;
}
test('variable folds and loops retain checked body/predicate semantics', {
  skip: SKIP,
}, async () => {
  const p = parseAndValidate(ITERATIONS);
  const a = await sameIr(p);
  assert.ok(fn(a, 'folded').nodes.some((n) => n.op === 'fold'));
  assert.ok(fn(a, 'looped').nodes.some((n) => n.op === 'loop'));
  assert.ok(fn(a, 'step').nodes.some((n) => n.op === 'cadd'));
  assert.ok(fn(a, 'pred').nodes.some((n) => n.op === 'csub'));
  for (const args of [
    [0, 1, 2, 9],
    [1, 1, 2, 9],
    [6, 1, 2, 9],
    [8, 10, 1, 9],
    [5, 0xffff_ffff, 1, 0xffff_ffff],
  ]) {
    for (const name of ['folded', 'looped'] as const) {
      const want = iterationOracle(args, name === 'looped');
      assert.equal(run(fn(a, name), args), want);
      assert.equal(run(fn(p, name), args), want);
    }
  }
});

test('literal nine-trip checked fold preserves root-supplied trip indices', {
  skip: SKIP,
}, async () => {
  // The first function starts with a checked opcode. With no active frame, evstep reads
  // that row speculatively; its checked result must not replace a root frame's index.
  // Nine trips avoid IR short unrolling and force simc's root-fold evaluator entry.
  const p = parseAndValidate(`fn step u32 u32 -> u32
q cadd p0 p1
v at q 0
ret v
end
fn top -> u32
r fold step 9 0
ret r
end
`);
  assert.equal(optimizeFunction(fn(p, 'step')).fn.nodes[0]?.op, 'cadd');
  for (const image of [false, true]) {
    const a = await sameIr(p, image);
    const top = fn(a, 'top');
    assert.equal(top.nodes.length, 0, 'literal scalar caller proves evaluator folding ran');
    assert.deepEqual(top.ret, { kind: 'u32', value: 36 });
    assert.equal(run(top, []), 36);
  }
  assert.equal(run(fn(p, 'top'), []), 36);
});

test('dead checked divzero and cget misses are pure and removed', { skip: SKIP }, async () => {
  const p = parseAndValidate(`fn f u32 u32 -> u32
a cdiv p0 p1
b crem p0 p1
xs arr 1 2 3 4
c cget xs p1
ret p0
end
`);
  const a = await sameIr(p);
  assert.equal(fn(a, 'f').nodes.length, 0);
  for (const args of [
    [7, 0],
    [7, 4],
    [7, 0xffff_ffff],
  ])
    assert.equal(run(fn(a, 'f'), args), 7);
});

test('checked tuples do not absorb or reorder IO anchors', { skip: SKIP }, async () => {
  const p = parseAndValidate(`fn f io u32 u32 -> io
a cadd p1 p2
v at a 0
w write p0 v
b cdiv p1 p2
z at b 0
out write w z
ret out
end
`);
  const a = await sameIr(p);
  const ops = fn(a, 'f').nodes.map((n) => n.op);
  const firstWrite = ops.indexOf('write');
  assert.ok(firstWrite >= 0 && firstWrite < ops.indexOf('cdiv'));
  assert.equal(ops.filter((op) => op === 'write').length, 2);
  for (const [x, y] of PAIRS) {
    const io = makeIo();
    run(fn(a, 'f'), [io, x, y]);
    assert.deepEqual(io.output, [arithmetic('cadd', x, y)[0], arithmetic('cdiv', x, y)[0]]);
  }
});

test('put/select/aggregate-call aliases preserve the original checked tuple', {
  skip: SKIP,
}, async () => {
  const p = parseAndValidate(`fn identity (u32,bool) -> (u32,bool)
ret p0
end
fn f bool u32 u32 -> ((u32,bool),(u32,bool),(u32,bool),(u32,bool))
a cadd p1 p2
saved call identity a
again call identity a
changed put a 0 p1
b cdiv p1 p2
chosen select p0 changed b
r rec saved again chosen a
ret r
end
`);
  const a = await sameIr(p);
  assert.ok(fn(a, 'f').nodes.some((n) => n.op === 'call' && n.callee === 'identity'));
  for (const take of [false, true]) {
    for (const [x, y] of PAIRS) {
      const original = arithmetic('cadd', x, y);
      const chosen = take ? [x, original[1]] : arithmetic('cdiv', x, y);
      const want = [original, original, chosen, original];
      assert.deepEqual(run(fn(a, 'f'), [take, x, y]), want);
      assert.deepEqual(run(fn(p, 'f'), [take, x, y]), want);
    }
  }
});

test('A0 optimizer capabilities admit canonical checked operations and refuse strict before tool startup', () => {
  for (const op of CHECKED) {
    const source = directSource(op);
    assert.doesNotThrow(() => assertTargetSupports('a0w optimizer', parseAndValidate(source)));
    const strict = parseAndValidate(`profile strict\n${source}`);
    assert.throws(
      () => assertTargetSupports('a0w optimizer', strict),
      (e: unknown) => e instanceof A0Error && e.id === 'A0713',
    );
    assert.throws(
      () => a0OptimizeProgram('unusable-tool-must-not-run', strict),
      (e: unknown) => e instanceof A0Error && e.id === 'A0713',
    );
  }
  for (const source of [
    'profile strict\nfn f u32 -> u32\nret p0\nend\n',
    'profile strict\nfn f u32 u32 -> (u32,bool)\nq cdiv p0 p1\nret q\nend\n',
  ]) {
    assert.throws(
      () => a0OptimizeProgram('unusable-tool-must-not-run', parseAndValidate(source)),
      (e: unknown) => e instanceof A0Error && e.id === 'A0713',
    );
  }
});

function rawGuardWords(
  mode: 7 | 8,
  extra: 'opaque' | 'unowned' | 'supplied',
  opcode: number,
): number[] {
  // The retained root is a typed (u32,bool) cadd. Extra words are deliberately independent
  // of its operands/return so the test distinguishes the public supplied-body boundary.
  const types = [1, 0, 0, 2, 0, 0, 3, 0, 0, 5, 0, 2];
  const tlist = [0, 1, 0, 0];
  const own = [3, 2, 2, 3, 0, 1, 0x10000000];
  // A body-present bit of zero dominates cached range metadata. Its packed return is opaque.
  const other = [
    extra === 'supplied' ? 3 : 0,
    2,
    2,
    3,
    1,
    1,
    extra === 'supplied' ? 0x10000000 : 0,
  ];
  const fns = extra === 'unowned' ? own : [...own, ...other];
  const nf = extra === 'unowned' ? 1 : 2;
  const nodes = [0, 32, 2, 0, 0, 0, 0, opcode, 2, 0, 0, 0];
  const args = [2, 0, 2, 1];
  return [
    mode,
    4,
    ...types,
    tlist.length,
    ...tlist,
    nf,
    ...fns,
    2,
    ...nodes,
    3,
    3,
    2,
    ...args,
    ...(mode === 7 ? Array.from({ length: nf }, () => [1, 17]).flat() : []),
    0,
    ...(mode === 7 ? [0] : []),
  ];
}

test('raw optimizer ignores unknown opaque and unowned words but refuses another supplied body', {
  skip: SKIP,
}, async () => {
  const exe = await executable();
  const invoke = (words: readonly number[]) => {
    const input = Buffer.alloc(words.length * 4);
    words.forEach((word, i) => {
      input.writeUInt32LE(word >>> 0, i * 4);
    });
    const result = spawnWithInput(exe, input, { timeout: 60_000, maxBuffer: 1 << 20 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
  for (const mode of [7, 8] as const) {
    for (const extra of ['opaque', 'unowned'] as const) {
      const baseline = invoke(rawGuardWords(mode, extra, 32));
      assert.equal(baseline.status, 0, `mode${mode}/${extra}: known baseline`);
      assert.ok(baseline.stdout.length > 0);
      const unknown = invoke(rawGuardWords(mode, extra, 38));
      assert.equal(unknown.status, 0, `mode${mode}/${extra}: unavailable words are ignored`);
      assert.deepEqual(unknown.stdout, baseline.stdout, 'the exact retained root is unchanged');
    }
    const unknown = invoke(rawGuardWords(mode, 'supplied', 38));
    assert.equal(unknown.status, 5, `mode${mode}: another supplied body is checked`);
    assert.equal(unknown.stdout.length, 0, 'unsupported supplied input writes no partial body');
  }
});

// Fault controls for root after the implementation passes:
// - Old >=29 IO dispatch fails constant-call tests; scalar-only opcode aliases fail direct IR.
// - Swapping checked CSE operands fails node counts/exact IR even for cadd/cmul.
// - Treating checked divzero/cget misses as traps fails dead-node and direct behavior cases.
// - Reusing a checked tuple's storage during put fails the retained original/call aliases.
// - Returning noncanonical bool words or wrapped cget payloads fails the independent oracle.
