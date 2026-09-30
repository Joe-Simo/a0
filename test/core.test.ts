import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { compile, FunctionCache } from '../src/backends.js';
import { compileCached, DiskCache } from '../src/cache.js';
import {
  A0Error,
  type Func,
  formatDiagnostic,
  formatFunction,
  formatType,
  makeIo,
  type Operand,
  parse,
  parseAndValidate,
  parseType,
  run,
  type Type,
  type TypedFunc,
  typeEquals,
  validate,
} from '../src/core.js';
import {
  applyPatch,
  EditSession,
  formatPatch,
  parsePatch,
  programView,
  revision,
} from '../src/edit.js';
import { link } from '../src/link.js';
import { optimize, optimizeFunction } from '../src/optimize.js';
import { generateFiller } from '../tools/ai-edit-tasks-c.js';
import { ILL_TYPED, type IrTables, NONE, refCheck, refCheckWords } from '../tools/ref-check.js';
import { FRONT_END_SOURCE_LIMIT, IR_OPS, irOp, refParse, type WordIr } from '../tools/ref-parse.js';

const AFFINE = `fn affine u32 u32 u32 -> u32
a mul p0 p1
b add a p2
ret b
end`;

function fn(source: string, name = source.split(/\s+/)[1] ?? ''): TypedFunc {
  const f = parseAndValidate(source).byName.get(name);
  if (f === undefined) throw new Error(`missing ${name}`);
  return f;
}

test('affine computes (p0*p1+p2) mod 2^32 and formats canonically', () => {
  const f = fn(AFFINE);
  assert.equal(run(f, [10, 3, 7]), 37);
  assert.equal(run(f, [0xffff_ffff, 2, 3]), 1); // wraps
  assert.equal(formatFunction(f), AFFINE);
});

test('exact semantics: shifts mask to five bits, shr is logical, lt is unsigned', () => {
  const p = parseAndValidate(`fn s u32 u32 -> u32
a shl p0 p1
ret a
end
fn r u32 u32 -> u32
a shr p0 p1
ret a
end
fn l u32 u32 -> bool
a lt p0 p1
ret a
end`);
  const s = p.byName.get('s') as TypedFunc;
  const r = p.byName.get('r') as TypedFunc;
  const l = p.byName.get('l') as TypedFunc;
  assert.equal(run(s, [1, 33]), 2);
  assert.equal(run(s, [1, 31]), 0x8000_0000);
  assert.equal(run(r, [0x8000_0000, 31]), 1);
  assert.equal(run(r, [0x8000_0000, 32]), 0x8000_0000);
  assert.equal(run(l, [1, 0x8000_0000]), true);
  assert.equal(run(l, [0x8000_0000, 1]), false);
});

test('validation rejects forward references, type errors, reserved names, and bad literals', () => {
  const bad = [
    'fn f u32 -> u32\na add b p0\nb mov p0\nret a\nend', // forward reference
    'fn f u32 -> u32\na eq p0 p0\nb add a p0\nret b\nend', // bool into add
    'fn f bool u32 -> u32\na select p0 p1 true\nret a\nend', // select branch mismatch
    'fn f u32 -> u32\np1 mov p0\nret p1\nend', // reserved param-shaped id
    'fn f u32 -> u32\nret p1\nend', // param out of range
    'fn f u32 -> u32\na add p0 4294967296\nret a\nend', // literal too large
    'fn f u32 -> u32\na mov p0\na mov p0\nret a\nend', // duplicate id
    'fn f u32 -> u32\na add p0\nret a\nend', // arity
    'fn f u32 -> bool\nret p0\nend', // result type mismatch
    'fn f u32 -> u32\na mov p0\nret a', // unterminated
    'fn f u32 -> u32\na mov p0\nret a\nend\nfn f u32 -> u32\nret p0\nend', // duplicate function
    'fn f u32 -> u32\na add p0 p0 # comment\nb call a\nret b\nend', // unknown op
  ];
  for (const src of bad) assert.throws(() => parseAndValidate(src), A0Error, src);
});

test('comments are discarded and reserved words rejected as node ids', () => {
  const p = parse('# header\nfn g u32 -> u32 # sig\n a mov p0 # id\nret a\nend\n');
  assert.equal(p.functions[0]?.nodes.length, 1);
  assert.throws(() => parseAndValidate('fn g u32 -> u32\nend mov p0\nret end\nend'), A0Error);
});

test('optimizer folds constants, applies identities, eliminates duplicates and dead nodes', () => {
  const f = fn(`fn o u32 u32 -> u32
z mul p0 0
a add p0 z
b add p0 0
c mul a 1
d xor p1 p1
e add c d
dup add p0 0
unused mul dup 7
k add 3 4
r add e k
ret r
end`);
  const { fn: g, stats } = optimizeFunction(f);
  assert.equal(stats.before, 10);
  assert.equal(stats.after, 1);
  assert.equal(formatFunction(g), 'fn o u32 u32 -> u32\nr add p0 7\nret r\nend');
  for (const args of [
    [0, 0],
    [5, 9],
    [0xffff_ffff, 0xffff_fff0],
  ] as const) {
    assert.equal(run(g, args), run(f, args));
  }
  const whole = optimize(parseAndValidate(AFFINE));
  assert.equal(whole.stats.after, 2);
});

test('self-contained patch requires the exact current revision; edits are validated as a whole', () => {
  const program = parseAndValidate(AFFINE);
  const affine = program.byName.get('affine') as TypedFunc;
  const patchText = formatPatch(affine, [
    {
      id: 'b',
      op: 'sub',
      args: [
        { kind: 'node', id: 'a' },
        { kind: 'param', index: 2 },
      ],
    },
  ]);
  const next = applyPatch(program, parsePatch(patchText));
  assert.equal(run(next.byName.get('affine') as TypedFunc, [10, 3, 7]), 23);
  // Source program is untouched.
  assert.equal(run(affine, [10, 3, 7]), 37);
  // Stale revision is rejected.
  assert.throws(() => applyPatch(next, parsePatch(patchText)), /revision mismatch/);
  // An unknown node is inserted before ret (and may then be returned by a ret line).
  const insert = `patch affine ${revision(affine)}\nq add a a\nret q\nend`;
  assert.equal(
    run(applyPatch(program, parsePatch(insert)).byName.get('affine') as TypedFunc, [10, 3, 7]),
    60,
  );
  // Replacement introducing a forward reference is rejected as a whole.
  const forward = `patch affine ${revision(affine)}\na add b p0\nend`;
  assert.throws(() => applyPatch(program, parsePatch(forward)), /undefined or later/);
});

test('session edits: stable handles, atomic commit, rebinding after success, unknown handles rejected', () => {
  const session = new EditSession(parseAndValidate(AFFINE), { maxOpenHandles: 2 });
  const view = session.open('affine');
  assert.equal(view.handle, 'e0');
  assert.equal(view.text, `e0\n${AFFINE}`);
  const edit = 'e0\nb sub a p2\n'; // 14 bytes including the terminating newline
  assert.equal(Buffer.byteLength(edit, 'utf8'), 14);
  const other = session.open('affine'); // e1, follows the program like e0
  const next = session.apply(edit);
  assert.equal(run(next.byName.get('affine') as TypedFunc, [10, 3, 7]), 23);
  assert.equal(session.openHandles, 2);
  // The same handle keeps working after its own edit (rebound to the new revision).
  const again = session.apply('e0\nb add a p2');
  assert.equal(run(again.byName.get('affine') as TypedFunc, [10, 3, 7]), 37);
  assert.equal(
    session.view('e0'),
    `e0\n${formatFunction(again.byName.get('affine') as TypedFunc)}`,
  );
  const viaOther = session.apply(`${other.handle}\nb xor a p2`);
  assert.equal(run(viaOther.byName.get('affine') as TypedFunc, [10, 3, 7]), 30 ^ 7);
  assert.throws(() => session.apply('e9\nb add a p2'), /unknown handle/);
  assert.throws(() => session.apply('zz\nb add a p2'), /invalid handle/);
  // A failed edit leaves the program and handles untouched.
  assert.throws(() => session.apply('e0\nb add a p9'), /out of range/);
  assert.equal(session.openHandles, 2);
  assert.throws(() => session.open('affine'), /handle limit/);
  assert.ok(session.close('e1'));
  assert.equal(session.openHandles, 1);
});

test('backends emit every target and the JS module executes with input guards', async () => {
  const program = parseAndValidate(AFFINE);
  for (const target of ['js', 'c', 'java', 'sv'] as const) {
    const { text } = compile(program, target);
    assert.ok(text.includes('affine'), target);
  }
  const js = compile(program, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as {
    affine: (a: number, b: number, c: number) => number;
  };
  assert.equal(mod.affine(10, 3, 7), 37);
  assert.equal(mod.affine(0xffff_ffff, 2, 3), 1);
  assert.throws(() => mod.affine(-1, 2, 3), RangeError);
  assert.throws(() => mod.affine(1.5, 2, 3), RangeError);
});

test('emission cache reuses unchanged functions and rebuilds only the edited one', () => {
  const src = Array.from(
    { length: 48 },
    (_, i) => `fn f${i} u32 u32 -> u32\na mul p0 ${i + 1}\nb add a p1\nret b\nend`,
  ).join('\n');
  const cache = new FunctionCache(1024);
  const program = parseAndValidate(src);
  const first = compile(program, 'c', {}, cache);
  assert.equal(first.cacheMisses, 48);
  const again = compile(program, 'c', {}, cache);
  assert.equal(again.cacheHits, 48);
  assert.equal(again.text, first.text);
  const session = new EditSession(program);
  const v = session.open('f7');
  const edited = session.apply(`${v.handle}\nb sub a p1`);
  const third = compile(edited, 'c', {}, cache);
  assert.equal(third.cacheHits, 47);
  assert.equal(third.cacheMisses, 1);
  // Different target or optimization level is a different key.
  assert.equal(compile(edited, 'c', { optimize: false }, cache).cacheHits, 0);
  // Bounded capacity evicts the least recently used entry.
  const tiny = new FunctionCache(2);
  compile(program, 'js', {}, tiny);
  assert.equal(tiny.size, 2);
});

test('call: earlier-defined callee, exact evaluation, recursion and forward calls rejected', () => {
  const src = `fn sq u32 -> u32
a mul p0 p0
ret a
end

fn hyp u32 u32 -> u32
x call sq p0
y call sq p1
s add x y
ret s
end`;
  const p = parseAndValidate(src);
  const hyp = p.byName.get('hyp') as TypedFunc;
  assert.equal(run(hyp, [3, 4]), 25);
  assert.equal(run(hyp, [0x1_0000, 1]), 1); // 2^32 wraps to 0 inside sq
  assert.equal(formatFunction(hyp).split('\n')[1], 'x call sq p0');
  // Self-call, forward call, arity and type mismatches are rejected.
  assert.throws(
    () => parseAndValidate('fn r u32 -> u32\na call r p0\nret a\nend'),
    /unknown callee/,
  );
  assert.throws(
    () =>
      parseAndValidate(
        `fn f u32 -> u32\na call g p0\nret a\nend\n${src.split('\n\n')[0]}`.replace('sq', 'g'),
      ),
    /unknown callee/,
  );
  assert.throws(
    () => parseAndValidate(`${src.split('\n\n')[0]}\nfn f u32 -> u32\na call sq p0 p0\nret a\nend`),
    /expects 1 arguments/,
  );
  assert.throws(
    () => parseAndValidate(`${src.split('\n\n')[0]}\nfn f bool -> u32\na call sq p0\nret a\nend`),
    /expected u32, got bool/,
  );
  // Constant calls fold exactly; non-constant calls are kept and deduplicated.
  const folded = optimizeFunction(
    fn(
      `${src.split('\n\n')[0]}\nfn k u32 -> u32\na call sq 7\nb call sq p0\nc call sq p0\nd add b c\ne add d a\nret e\nend`,
      'k',
    ),
  );
  assert.equal(
    formatFunction(folded.fn),
    'fn k u32 -> u32\nb call sq p0\nd add b b\ne add d 49\nret e\nend',
  );
  // Every backend emits the call; JS executes it.
  for (const target of ['js', 'c', 'java', 'sv'] as const)
    assert.ok(compile(p, target).text.includes(target === 'sv' ? 'a0_sq u_x' : 'sq('), target);
});

test('emission cache key follows callee changes (semantic revision)', async () => {
  const src =
    'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn twice u32 -> u32\nx call sq p0\ny add x x\nret y\nend';
  const cache = new FunctionCache();
  const session = new EditSession(parseAndValidate(src));
  compile(session.program, 'js', {}, cache);
  const v = session.open('sq');
  const next = session.apply(`${v.handle}\na add p0 p0`);
  const r = compile(next, 'js', {}, cache);
  // Callee text changed; caller text is identical but depends on the callee, so both rebuild.
  assert.equal(r.cacheMisses, 2);
  assert.equal(r.cacheHits, 0);
  assert.equal(
    revision(next.byName.get('twice') as TypedFunc),
    revision(session.program.byName.get('twice') as TypedFunc),
  );
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(r.text).toString('base64')}`
  )) as { twice: (a: number) => number };
  assert.equal(mod.twice(5), 20);
});

test('SystemVerilog: shift by a literal distance is masked, never bit-selected', () => {
  const p = parseAndValidate('fn s u32 -> u32\na shr p0 33\nb shl a p0\nret b\nend');
  const sv = compile(p, 'sv').text;
  assert.ok(sv.includes("p0 >> 5'd1"), sv);
  assert.ok(sv.includes('<< p0[4:0]'), sv);
  assert.ok(!/'d[0-9]+\[4:0\]/.test(sv));
});

test('fold: bounded iteration with exact semantics, typing, zero-trip identity, backends', async () => {
  const src = `fn step u32 u32 u32 -> u32
m mul p0 p2
a add m p1
ret a
end

fn horner u32 u32 -> u32
r fold step p1 0 p0
ret r
end`;
  const p = parseAndValidate(src);
  const horner = p.byName.get('horner') as TypedFunc;
  // state = state*x + i for i in 0..n-1
  assert.equal(run(horner, [10, 0]), 0);
  assert.equal(run(horner, [10, 4]), 123); // ((0*10+0)*10+1)*10+2)*10+3
  assert.equal(run(horner, [0xffff_ffff, 3]), (((0 + 0) * -1 + 1) * -1 + 2) >>> 0);
  // Typing: trip count must be u32, init must match state type, body shape is checked.
  assert.throws(
    () => parseAndValidate(`${src}\nfn bad bool -> u32\nr fold step p0 0 1\nret r\nend`),
    /trip count/,
  );
  assert.throws(
    () => parseAndValidate(`${src}\nfn bad u32 -> u32\nr fold step p0 true 1\nret r\nend`),
    /initial state/,
  );
  assert.throws(
    () => parseAndValidate(`${src}\nfn bad u32 -> u32\nr fold step p0 0\nret r\nend`),
    /extra arguments/,
  );
  assert.throws(
    () =>
      parseAndValidate(
        'fn one u32 -> u32\nret p0\nend\nfn bad u32 -> u32\nr fold one p0 0\nret r\nend',
      ),
    /needs \(state, index/,
  );
  assert.throws(
    () => parseAndValidate(`fn bad u32 -> u32\nr fold bad p0 0\nret r\nend`),
    /unknown fold body/,
  );
  // Optimizer: zero trips is the init; constant folds evaluate exactly; large counts stay loops.
  const opt = optimizeFunction(fn(`${src}\nfn z u32 -> u32\nr fold step 0 p0 7\nret r\nend`, 'z'));
  assert.equal(formatFunction(opt.fn), 'fn z u32 -> u32\nret p0\nend');
  const konst = optimizeFunction(fn(`${src}\nfn k -> u32\nr fold step 4 0 10\nret r\nend`, 'k'));
  assert.equal(formatFunction(konst.fn), 'fn k -> u32\nret 123\nend');
  const big = optimizeFunction(fn(`${src}\nfn b -> u32\nr fold step 100000 0 10\nret r\nend`, 'b'));
  assert.ok(formatFunction(big.fn).includes('fold step 100000'));
  // Backends: JS executes; C/Java contain loops; SV unrolls literals and rejects variable counts.
  const js = compile(p, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as { horner: (x: number, n: number) => number };
  assert.equal(mod.horner(10, 4), 123);
  assert.ok(compile(p, 'c').text.includes('for (uint32_t i = 0; i < p1; i++)'));
  assert.ok(compile(p, 'java').text.includes('Integer.compareUnsigned(i, p1) < 0'));
  // A variable trip count becomes a clocked module with a start/done handshake.
  assert.ok(compile(p, 'sv').text.includes('module a0_horner (\n  input logic clk'));
  assert.ok(compile(p, 'sv').text.includes('output logic done'));
  const lit = parseAndValidate(
    `${src.split('\n\n')[0]}\nfn h3 u32 -> u32\nr fold step 3 0 p0\nret r\nend`,
  );
  const sv = compile(lit, 'sv').text;
  assert.equal((sv.match(/a0_step u_r_/g) ?? []).length, 3);
});

test('loop: early exit under an iteration cap, exact across interpreter, optimizer, and backends', async () => {
  const src = `fn step u32 u32 u32 -> u32
a add p0 p2
ret a
end

fn below u32 u32 u32 -> bool
c lt p0 p2
ret c
end

fn accum u32 u32 -> u32
r loop below step p1 0 p0
ret r
end`;
  const p = parseAndValidate(src);
  const accum = p.byName.get('accum') as TypedFunc;
  // state += x while state < x, capped at n: stops after one iteration when x > 0.
  assert.equal(run(accum, [5, 100]), 5);
  assert.equal(run(accum, [0, 100]), 0); // predicate false immediately
  assert.equal(run(accum, [5, 0]), 0); // cap zero
  // Typing: predicate must return bool and share the body's parameter list.
  assert.throws(
    () => parseAndValidate(`${src}\nfn bad u32 -> u32\nr loop step step 3 0 p0\nret r\nend`),
    /predicate result/,
  );
  assert.throws(
    () =>
      parseAndValidate(
        'fn f u32 u32 -> u32\nret p0\nend\nfn q u32 -> bool\nc eq p0 0\nret c\nend\nfn bad u32 -> u32\nr loop q f 3 0\nret r\nend',
      ),
    /same parameters/,
  );
  assert.throws(
    () => parseAndValidate(`${src}\nfn bad u32 -> u32\nr loop nope step 3 0 p0\nret r\nend`),
    /unknown loop predicate/,
  );
  // Optimizer: constant loops evaluate exactly; zero cap is the init.
  const k = optimizeFunction(fn(`${src}\nfn k -> u32\nr loop below step 10 0 7\nret r\nend`, 'k'));
  assert.equal(formatFunction(k.fn), 'fn k -> u32\nret 7\nend');
  const z = optimizeFunction(
    fn(`${src}\nfn z u32 -> u32\nr loop below step 0 p0 7\nret r\nend`, 'z'),
  );
  assert.equal(formatFunction(z.fn), 'fn z u32 -> u32\nret p0\nend');
  // Backends.
  const js = compile(p, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as { accum: (x: number, n: number) => number };
  assert.equal(mod.accum(5, 100), 5);
  assert.ok(compile(p, 'c').text.includes('if (!a0_below('));
  assert.ok(compile(p, 'java').text.includes('if (!below('));
  assert.ok(compile(p, 'sv').text.includes('module a0_accum (\n  input logic clk'));
  const lit = parseAndValidate(
    `${src.split('\n\n').slice(0, 2).join('\n\n')}\nfn a3 u32 -> u32\nr loop below step 3 0 p0\nret r\nend`,
  );
  const sv = compile(lit, 'sv').text;
  assert.equal((sv.match(/a0_below u_r_p/g) ?? []).length, 3);
  assert.ok(sv.includes("assign n_r_d1 = 1'b0 | ~n_r_c0;"));
});

test('aggregates: arrays and records are values; get/set index modulo length; at/put literal fields', async () => {
  const src = `fn swap u32x2 -> u32x2
a get p0 0
b get p0 1
c set p0 0 b
d set c 1 a
ret d
end

fn pair u32 bool -> (u32,bool)
r rec p0 p1
ret r
end

fn sum3 u32 u32 u32 -> u32
v arr p0 p1 p2
x get v 0
y get v 1
z get v 5
s add x y
t add s z
v2 arr p0 p1
w call swap v2
q get w 0
u add t q
ret u
end

fn flag u32 -> bool
r call pair p0 true
f at r 1
g put r 0 7
h at g 0
e eq h 7
b select f e false
ret b
end`;
  const p = parseAndValidate(src);
  assert.equal(formatType(p.byName.get('pair')?.result as Type), '(u32,bool)');
  assert.deepEqual(run(p.byName.get('swap') as TypedFunc, [[1, 2]]), [2, 1]);
  // z = v[5 mod 3] = v[2]; q = swap(v)[0] = v[1]
  assert.equal(run(p.byName.get('sum3') as TypedFunc, [1, 2, 3]), 8);
  assert.equal(run(p.byName.get('flag') as TypedFunc, [3]), true);
  // Value semantics: set never mutates its input.
  const swap = p.byName.get('swap') as TypedFunc;
  const input: number[] = [5, 6];
  run(swap, [input]);
  assert.deepEqual(input, [5, 6]);
  // Typing.
  assert.throws(
    () => parseAndValidate('fn f u32 bool -> u32x2\na arr p0 p1\nret a\nend'),
    /element 1/,
  );
  assert.throws(
    () => parseAndValidate('fn f u32x2 u32 -> u32\na at p0 0\nret a\nend'),
    /expects a record/,
  );
  assert.throws(
    () => parseAndValidate('fn f (u32,bool) u32 -> u32\na at p0 p1\nret a\nend'),
    /u32 literal/,
  );
  assert.throws(
    () => parseAndValidate('fn f (u32,bool) -> u32\na at p0 2\nret a\nend'),
    /out of range/,
  );
  assert.throws(
    () => parseAndValidate('fn f u32x2 -> u32x2\na set p0 0 true\nret a\nend'),
    /element/,
  );
  assert.throws(() => parseType('u32x0'), /expected array length/);
  assert.throws(() => parseType('u32x99999'), /exceeds/);
  assert.equal(formatType(parseType('(u32,bool)x2x3')), '(u32,bool)x2x3');
  // Optimizer: get of a built array with a literal index is the element.
  const o = optimizeFunction(fn('fn f u32 u32 -> u32\nv arr p0 p1\nx get v 3\nret x\nend'));
  assert.equal(formatFunction(o.fn), 'fn f u32 u32 -> u32\nret p1\nend');
  // Backends: JS executes with guards; C/Java/SV emit.
  const js = compile(p, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as {
    swap: (a: number[]) => number[];
    sum3: (a: number, b: number, c: number) => number;
  };
  assert.deepEqual(Array.from(mod.swap([1, 2])), [2, 1]);
  assert.equal(mod.sum3(1, 2, 3), 8);
  assert.throws(() => mod.swap([1]), RangeError);
  const c = compile(p, 'c').text;
  assert.ok(c.includes('typedef struct { uint32_t e[2]; } a0t_a2_u;'));
  assert.ok(c.includes('a0t_r2_u_b a0_pair('));
  const java = compile(p, 'java').text;
  assert.ok(java.includes('record R_r2_u_b(int f0, boolean f1)'));
  assert.ok(java.includes('a.clone()'));
  const sv = compile(p, 'sv').text;
  assert.ok(sv.includes('input logic [63:0] p0'));
  assert.ok(sv.includes('always_comb begin n_c = p0; n_c[0 +: 32] = n_b; end'));
  // Dynamic-index part-select survives only without the optimizer (it folds literal gets).
  assert.ok(compile(p, 'sv', { optimize: false }).text.includes('assign n_z = n_v[64 +: 32];'));
});

test('io: linear tokens order effects; read/write across interpreter, optimizer, and backends', async () => {
  const src = `fn echo2 io -> u32
r read p0
v at r 0
t at r 1
w write t v
r2 read w
v2 at r2 0
t2 at r2 1
w2 write t2 v2
s add v v2
ret s
end

fn tap u32 io -> (u32,io)
w write p1 p0
r rec p0 w
ret r
end

fn twice u32 io -> u32
a call tap p0 p1
t at a 1
b call tap p0 t
v at b 0
ret v
end`;
  const p = parseAndValidate(src);
  const io = makeIo([5, 7, 9]);
  assert.equal(run(p.byName.get('echo2') as TypedFunc, [io]), 12);
  assert.deepEqual(io.output, [5, 7]);
  assert.equal(io.position, 2);
  const io2 = makeIo([]);
  assert.equal(run(p.byName.get('echo2') as TypedFunc, [io2]), 0); // exhausted input reads 0
  const io3 = makeIo([]);
  assert.equal(run(p.byName.get('twice') as TypedFunc, [3, io3]), 3);
  assert.deepEqual(io3.output, [3, 3]);
  // Linearity and shape rules.
  assert.throws(
    () => parseAndValidate('fn f io -> io\na write p0 1\nb write p0 2\nret b\nend'),
    /already consumed/,
  );
  assert.throws(
    () => parseAndValidate('fn f io -> io\na write p0 1\nret p0\nend'),
    /already consumed/,
  );
  assert.throws(() => parseAndValidate('fn f io io -> io\nret p0\nend'), /at most one parameter/);
  assert.throws(
    () => parseAndValidate('fn f bool io io -> io\nret p1\nend'),
    /at most one parameter/,
  );
  assert.throws(() => parseType('iox2'), /arrays cannot hold io/);
  assert.throws(
    () => parseAndValidate('fn f bool io -> io\na write p1 1\ns select p0 a p1\nret s\nend'),
    /already consumed|select cannot/,
  );
  assert.throws(() => parseAndValidate('fn f u32 -> u32\nr read p0\nret p0\nend'), /expected io/);
  // Optimizer keeps every effect, in order, even when results are unused; pure extraction is dropped.
  const o = optimizeFunction(
    fn('fn f io -> u32\nr read p0\nv at r 0\nt at r 1\nw write t 9\nq add v 0\nret v\nend'),
  );
  assert.equal(
    formatFunction(o.fn),
    'fn f io -> u32\nr read p0\nv at r 0\nt at r 1\nw write t 9\nret v\nend',
  );
  // Backends: JS executes the stream; C/Java emit runtimes; SV rejects with a precise diagnostic.
  const js = compile(p, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as {
    echo2: (t: unknown) => number;
    a0_make_io: (i: number[]) => { output: number[] };
  };
  const state = mod.a0_make_io([5, 7]);
  assert.equal(mod.echo2(state), 12);
  assert.deepEqual(state.output, [5, 7]);
  assert.throws(() => mod.echo2({}), TypeError);
  assert.ok(compile(p, 'c').text.includes('static inline a0t_r2_u_io a0_read(a0_io *t)'));
  assert.ok(compile(p, 'java').text.includes('static R_r2_u_io read(A0Io t)'));
  // io functions become clocked modules with word handshakes; a sequential loop predicate is rejected.
  const sv = compile(p, 'sv').text;
  assert.ok(sv.includes('module a0_echo2 (\n  input logic clk'));
  assert.ok(sv.includes('input logic [31:0] in_data') && sv.includes('output logic out_valid'));
  assert.ok(sv.includes('a0_tap u_a (.clk(clk), .rst(rst), .start(st_a)'));
  const badPred = parseAndValidate(
    'fn body u32 u32 io -> u32\nret p0\nend\nfn pr u32 u32 io -> bool\nc lt p0 5\nret c\nend\nfn f u32 io -> u32\nr loop pr body 4 p0 p1\nret r\nend',
  );
  assert.throws(() => compile(badPred, 'sv'), /clocked loop predicate must not carry an io token/);
});

test('resource bounds: fuel stops runaway evaluation, literal iteration is capped, fuzzed input fails cleanly', () => {
  const src =
    'fn step u32 u32 -> u32\na add p0 1\nret a\nend\nfn spin u32 -> u32\nr fold step p0 0\nret r\nend';
  const spin = parseAndValidate(src).byName.get('spin') as TypedFunc;
  assert.equal(run(spin, [1000], { fuel: 10_000 }), 1000);
  assert.throws(() => run(spin, [0xffff_ffff], { fuel: 100_000 }), /fuel exhausted/);
  // Nested literal counts multiply; the validator rejects products beyond the compute bound.
  const nested = `${src}\nfn inner u32 u32 -> u32\nr fold step 4096 p0\nret r\nend\nfn outer u32 -> u32\nr fold inner 8192 p0\nret r\nend`;
  assert.throws(() => parseAndValidate(nested), /compute bound/);
  assert.equal(parseAndValidate(src).byName.get('spin')?.staticIterations, 2 ** 32);
  // Fuzz: random mutations of a valid program must only ever raise A0Error, never crash or hang.
  const rng = (() => {
    let s = 0xc0ffee;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
  })();
  const alphabet =
    'abcdefghijklmnopqrstuvwxyz0123456789 \n()x,->#pfnretendcallfoldloopsetgetatputrecarrreadwrite';
  let rejected = 0;
  for (let k = 0; k < 3000; k += 1) {
    const chars = src.split('');
    const edits = 1 + (rng() % 6);
    for (let e = 0; e < edits; e += 1) {
      const pos = rng() % chars.length;
      const ch = alphabet[rng() % alphabet.length] as string;
      if (rng() % 3 === 0) chars.splice(pos, 1);
      else if (rng() % 2 === 0) chars.splice(pos, 0, ch);
      else chars[pos] = ch;
    }
    try {
      const p = parseAndValidate(chars.join(''));
      for (const f of p.functions)
        if (f.params.every((t) => t === 'u32'))
          run(
            f,
            f.params.map(() => 3),
            { fuel: 100_000 },
          );
    } catch (err) {
      assert.ok(err instanceof A0Error, `non-A0Error thrown: ${String(err)}`);
      rejected += 1;
    }
  }
  assert.ok(rejected > 2000, `expected most mutations rejected, got ${rejected}`);
});

test('text literal desugars to a u32 byte array, round-trips, and survives comments and edits', () => {
  const src = 'fn hello -> u32x7\ns text "hi # \\"x"\nret s\nend';
  const p = parseAndValidate(src);
  const hello = p.byName.get('hello') as TypedFunc;
  assert.equal(formatType(hello.result), 'u32x7');
  assert.deepEqual(run(hello, []), [104, 105, 32, 35, 32, 34, 120]);
  assert.equal(formatFunction(hello), src);
  // UTF-8 multibyte and escapes.
  const u = parseAndValidate('fn u -> u32x4\ns text "\u00e9\\n\\t"\nret s\nend').byName.get(
    'u',
  ) as TypedFunc;
  assert.deepEqual(run(u, []), [0xc3, 0xa9, 10, 9]);
  assert.throws(
    () => parseAndValidate('fn e -> u32x1\ns text ""\nret s\nend'),
    /must not be empty/,
  );
  assert.throws(
    () => parseAndValidate('fn e -> u32x1\ns text "\\q"\nret s\nend'),
    /unknown escape/,
  );
  // Session edit with a text literal containing '#'.
  const session = new EditSession(
    parseAndValidate('fn hello -> u32x5\ns text "hello"\nret s\nend'),
  );
  const v = session.open('hello');
  const next = session.apply(`${v.handle}\ns text "ab#cd"`);
  assert.deepEqual(run(next.byName.get('hello') as TypedFunc, []), [97, 98, 35, 99, 100]);
  // Backends see an ordinary array.
  assert.ok(compile(p, 'c').text.includes('a0mk_a7_u(104u, 105u, 32u, 35u, 32u, 34u, 120u)'));
});

test('div/rem are total unsigned (zero divisor: all ones / dividend); puts streams length then elements', async () => {
  const p = parseAndValidate(
    'fn d u32 u32 -> u32\nq div p0 p1\nret q\nend\nfn r u32 u32 -> u32\nq rem p0 p1\nret q\nend\nfn emit io -> u32\nt text "AB"\nw puts p0 t\nret 7\nend',
  );
  const d = p.byName.get('d') as TypedFunc;
  const r = p.byName.get('r') as TypedFunc;
  assert.equal(run(d, [100, 7]), 14);
  assert.equal(run(d, [0xffff_ffff, 2]), 0x7fff_ffff);
  assert.equal(run(d, [5, 0]), 0xffff_ffff);
  assert.equal(run(r, [100, 7]), 2);
  assert.equal(run(r, [5, 0]), 5);
  const io = makeIo([]);
  assert.equal(run(p.byName.get('emit') as TypedFunc, [io]), 7);
  assert.deepEqual(io.output, [2, 65, 66]);
  assert.throws(
    () => parseAndValidate('fn e io bool -> io\na arr p1 p1\nw puts p0 a\nret w\nend'),
    /expects a u32 array/,
  );
  // Optimizer identities and backends.
  assert.equal(
    formatFunction(
      optimizeFunction(fn('fn f u32 -> u32\nq div p0 1\nm rem q 1\ns add q m\nret s\nend')).fn,
    ),
    'fn f u32 -> u32\nret p0\nend',
  );
  const js = compile(p, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as {
    d: (a: number, b: number) => number;
    emit: (t: unknown) => number;
    a0_make_io: (i: number[]) => { output: number[] };
  };
  assert.equal(mod.d(5, 0), 0xffff_ffff);
  const st = mod.a0_make_io([]);
  mod.emit(st);
  assert.deepEqual(st.output, [2, 65, 66]);
  assert.ok(compile(p, 'c').text.includes('a0_puts(p0, n_t.e, 2u)'));
  assert.ok(compile(p, 'java').text.includes('Integer.divideUnsigned'));
  assert.ok(compile(p, 'sv').text.includes("32'hffffffff"));
});

test('site page program: A0 UI protocol, stylesheet, and sized bars', async () => {
  // The site is page.a0 plus what it uses, through the linker.
  const { readFile } = await import('node:fs/promises');
  const p = (await link('site/page.a0', (f) => readFile(f, 'utf8'))).program;
  const session = p.byName.get('session') as TypedFunc;
  const decode = (
    words: readonly number[],
  ): {
    texts: string[];
    css: string;
    shader: string;
    state: number[];
    sized: number;
    events: number[];
  } => {
    const d = {
      texts: [] as string[],
      css: '',
      shader: '',
      state: [] as number[],
      sized: 0,
      events: [] as number[],
    };
    const str = (i: number, n: number): string =>
      Buffer.from(words.slice(i, i + n)).toString('utf8');
    for (let i = 0; i < words.length; ) {
      const c = words[i++];
      if (c === 1) i += 1;
      else if (c === 5 || c === 8) d.events.push(words[i++] as number);
      else if (c === 2 || c === 4 || c === 9 || c === 13) {
        if (c === 4) i += 1;
        const n = words[i++] as number;
        if (c === 9) d.css += str(i, n);
        else if (c === 13) d.shader += str(i, n);
        else d.texts.push(str(i, n));
        i += n;
      } else if (c === 6) {
        const n = words[i++] as number;
        d.state = words.slice(i, i + n) as number[];
        i += n;
      } else if (c === 10) i += 2 + (words[i + 1] as number);
      else if (c === 11) i += 2;
      else if (c === 12) {
        d.sized += 1;
        i += 2;
      } else if (c !== 3) throw new Error(`bad command ${c} at ${i - 1}`);
    }
    return d;
  };
  const first = makeIo([0, 0, 0, 0, 0]);
  assert.equal(run(session, [first]), 0);
  const d0 = decode(first.output);
  assert.equal(d0.state.length, 0); // the home page keeps no state
  assert.ok(d0.css.includes('body{') && d0.css.length > 3000);
  assert.ok(d0.sized > 50); // chart bars and scatter points are sized by the program
  const all = d0.texts.join(' ');
  for (const needle of ['Docs', 'Benchmarks', 'GitHub', 'Made by', 'faster than Python'])
    assert.ok(all.includes(needle), `missing ${needle}`);
  assert.ok(!all.includes('Clicked'), 'demo removed');
  // Emitted JS produces the identical stream.
  const js = compile(p, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as { session: (t: unknown) => number; a0_make_io: (i: number[]) => { output: number[] } };
  const st = mod.a0_make_io([0, 0, 0, 0, 0]);
  assert.equal(mod.session(st), 0);
  assert.deepEqual(st.output, [...first.output]);
});

test('site docs program: A0 UI protocol, stylesheet, and reference sections', async () => {
  const { readFile } = await import('node:fs/promises');
  const p = (await link('site/docs.a0', (f) => readFile(f, 'utf8'))).program;
  const session = p.byName.get('session') as TypedFunc;
  const io = makeIo([0, 0, 0, 0, 0]);
  assert.equal(run(session, [io]), 0);
  const words = io.output;
  const str = (i: number, n: number): string => Buffer.from(words.slice(i, i + n)).toString('utf8');
  let css = '';
  const texts: string[] = [];
  for (let i = 0; i < words.length; ) {
    const c = words[i++];
    if (c === 1) i += 1;
    else if (c === 5 || c === 8 || c === 11) i += c === 11 ? 2 : 1;
    else if (c === 2 || c === 4 || c === 9 || c === 13) {
      if (c === 4) i += 1;
      const n = words[i++] as number;
      if (c === 9 || c === 13) css += str(i, n);
      else texts.push(str(i, n));
      i += n;
    } else if (c === 6) i += 1 + (words[i] as number);
    else if (c === 10) i += 2 + (words[i + 1] as number);
    else if (c === 12) i += 2;
    else if (c !== 3) throw new Error(`bad command ${c} at ${i - 1}`);
  }
  assert.ok(css.includes('body{'));
  const all = texts.join(' ');
  for (const needle of ['Operations', 'GitHub'])
    assert.ok(all.includes(needle), `missing ${needle}`);
});

test('site play program: the A0 lexer, parser and checker render tokens, typed IR, and the diagnostic of a submitted source', async () => {
  const { readFile } = await import('node:fs/promises');
  const p = (await link('site/play.a0', (f) => readFile(f, 'utf8'))).program;
  const session = p.byName.get('session') as TypedFunc;
  const lex = p.byName.get('lex') as TypedFunc;
  const decode = (words: readonly number[]): { text: string; state: number[]; css: string } => {
    const str = (i: number, n: number): string =>
      Buffer.from(words.slice(i, i + n)).toString('utf8');
    const d = { text: '', state: [] as number[], css: '' };
    for (let i = 0; i < words.length; ) {
      const c = words[i++];
      if (c === 1 || c === 5 || c === 8) i += 1;
      else if (c === 2 || c === 4 || c === 9 || c === 13) {
        if (c === 4) i += 1;
        const n = words[i++] as number;
        if (c === 9) d.css += str(i, n);
        else if (c === 2) d.text += str(i, n);
        i += n;
      } else if (c === 6) {
        const n = words[i++] as number;
        d.state = words.slice(i, i + n) as number[];
        i += n;
      } else if (c === 10) i += 2 + (words[i + 1] as number);
      else if (c === 11 || c === 12) i += 2;
      else if (c !== 3) throw new Error(`bad command ${c} at ${i - 1}`);
    }
    return d;
  };
  // Event 1 (Run) with a submitted source: the token count, every node as `id op args`, the ret.
  const src = 'fn f u32 u32 -> u32\na add p0 p1\nb mul a 2\nret b\nend\n';
  const bytes = [...Buffer.from(src)];
  const io = makeIo([1, 0, 0, bytes.length, ...bytes, 0]);
  assert.equal(run(session, [io]), 0);
  const d = decode(io.output);
  const arr = new Array(512).fill(0);
  bytes.forEach((v, i) => {
    arr[i] = v;
  });
  const ntok = (run(lex, [arr, bytes.length]) as [number[], number])[1] / 3;
  assert.ok(d.css.includes('textarea.src{'));
  assert.ok(d.text.includes(`${ntok} tokens`), d.text);
  assert.ok(d.text.includes('1 functions'), d.text);
  assert.ok(d.text.includes('params 2 · result u32 · nodes 2'), d.text);
  // Every node line carries the checker's type of the node.
  assert.ok(d.text.includes('a add p0 p1  u32\nb mul a 2  u32\nret b'), d.text);
  assert.ok(d.text.includes('valid: parsed and type-checked'), d.text);
  // The state is the source, so the text survives a re-render (event 0 with that state).
  assert.deepEqual(d.state, [bytes.length, ...bytes]);
  const again = makeIo([0, 0, 0, 0, d.state.length, ...d.state]);
  assert.equal(run(session, [again]), 0);
  assert.ok(decode(again.output).text.includes('a add p0 p1'));
  // The default (no text, no state) is the clamp function; an invalid source names the token.
  const first = makeIo([0, 0, 0, 0, 0]);
  assert.equal(run(session, [first]), 0);
  assert.ok(decode(first.output).text.includes('fn clamp u32 u32 u32 -> u32'));
  const badSrc = [...Buffer.from('fn f u32 -> u32\na call g p0\nret a\nend\n')];
  const bad = makeIo([1, 0, 0, badSrc.length, ...badSrc, 0]);
  assert.equal(run(session, [bad]), 0);
  assert.ok(decode(bad.output).text.includes('structure error at token 8: g'));
  // An ill-typed program parses, so the checker's diagnostic names the code, function and node
  // id; the nodes before it are typed, the ones after are not.
  const illSrc = [
    ...Buffer.from('fn g u32 bool -> u32\na lt p0 1\nb add a p1\nc mul p0 2\nret c\nend\n'),
  ];
  const ill = makeIo([1, 0, 0, illSrc.length, ...illSrc, 0]);
  assert.equal(run(session, [ill]), 0);
  const illText = decode(ill.output).text;
  assert.ok(illText.includes('type error in fn g at node b: an operand has a type'), illText);
  assert.ok(illText.includes('a lt p0 1  bool\nb add a p1\nc mul p0 2\nret c'), illText);
  assert.ok(!illText.includes('valid:'), illText);
  // A consumed io token returned twice is a structure error at the ret operand.
  const retSrc = [...Buffer.from('fn h io -> io\na write p0 1\nret p0\nend\n')];
  const rt = makeIo([1, 0, 0, retSrc.length, ...retSrc, 0]);
  assert.equal(run(session, [rt]), 0);
  assert.ok(decode(rt.output).text.includes('structure error in fn h at ret: the operand count'));
  // Types built by bodies (arrays, records, the (u32,io) of read) render like the source.
  const tySrc = [
    ...Buffer.from(
      'fn k io u32x4 -> (u32,io)\nr read p0\nt at r 1\nv arr 1 2\nx rec v p1\ns at x 0\nret r\nend\n',
    ),
  ];
  const ty = makeIo([1, 0, 0, tySrc.length, ...tySrc, 0]);
  assert.equal(run(session, [ty]), 0);
  const tyText = decode(ty.output).text;
  assert.ok(tyText.includes('params 2 · result (u32,io)'), tyText);
  assert.ok(
    tyText.includes(
      'r read p0  (u32,io)\nt at r 1  io\nv arr 1 2  u32x2\nx rec v p1  (u32x2,u32x4)\ns at x 0  u32x2\nret r',
    ),
    tyText,
  );
  assert.ok(tyText.includes('valid: parsed and type-checked'), tyText);
});

test('structured edits: insert (at end or after a node), delete, and change the result, atomically', () => {
  const src = 'fn f u32 u32 -> u32\na add p0 p1\nb mul a 2\nret b\nend';
  const session = new EditSession(parseAndValidate(src));
  const v1 = session.open('f');
  // Insert a node and return it.
  const n1 = session.apply(`${v1.handle}\nc xor b p0\nret c`);
  assert.equal(
    formatFunction(n1.byName.get('f') as TypedFunc),
    'fn f u32 u32 -> u32\na add p0 p1\nb mul a 2\nc xor b p0\nret c\nend',
  );
  // Insert after a specific node and delete another; validation is whole-function.
  const v2 = session.open('f');
  const n2 = session.apply(`${v2.handle}\nd sub a 1 @ a\nb mul d 2`);
  assert.equal(
    formatFunction(n2.byName.get('f') as TypedFunc),
    'fn f u32 u32 -> u32\na add p0 p1\nd sub a 1\nb mul d 2\nc xor b p0\nret c\nend',
  );
  const v3 = session.open('f');
  const n3 = session.apply(`${v3.handle}\n-c\nret b`);
  assert.equal(
    formatFunction(n3.byName.get('f') as TypedFunc),
    'fn f u32 u32 -> u32\na add p0 p1\nd sub a 1\nb mul d 2\nret b\nend',
  );
  assert.equal(run(n3.byName.get('f') as TypedFunc, [3, 4]), 12);
  // Deleting a node that is still used fails and leaves the program untouched.
  const v4 = session.open('f');
  assert.throws(() => session.apply(`${v4.handle}\n-a`), /undefined or later node 'a'/);
  assert.equal(
    formatFunction(session.program.byName.get('f') as TypedFunc),
    formatFunction(n3.byName.get('f') as TypedFunc),
  );
  assert.throws(() => session.apply(`${v4.handle}\nz add p0 1 @ nope`), /unknown node 'nope'/);
  assert.throws(() => session.apply(`${v4.handle}\n-b\n-b`), /duplicate edit/);
  // Self-contained patches accept the same edit lines.
  const f = n3.byName.get('f') as TypedFunc;
  const patched = applyPatch(n3, parsePatch(`patch f ${revision(f)}\ne add b 1\nret e\nend`));
  assert.equal(run(patched.byName.get('f') as TypedFunc, [3, 4]), 13);
});

test('set C scaled filler: A0 and TypeScript translations agree, callees precede callers', () => {
  const filler = generateFiller(960);
  const program = parseAndValidate(filler.map((f) => f.a0).join(''));
  assert.equal(program.functions.length, 960);
  const js = filler.map((f) => f.ts.replace(/^export /, '').replace(/: number/g, '')).join('');
  const names = filler.map((f) => f.name);
  const table = new Function(`${js}\nreturn { ${names.join(', ')} };`)() as Record<
    string,
    (...a: number[]) => number
  >;
  const inputs = [0, 1, 7, 65535, 99999, 100000, 2147483648, 4294967295];
  for (const f of filler) {
    const fn = program.byName.get(f.name) as TypedFunc;
    for (const x of inputs) {
      const args = f.arity === 1 ? [x] : [x, (x * 2654435761) >>> 0];
      assert.equal(run(fn, args), table[f.name]?.(...args), `${f.name}(${args.join(', ')})`);
    }
  }
  assert.deepEqual(
    generateFiller(40).map((f) => f.a0),
    filler.slice(0, 40).map((f) => f.a0),
  );
});

test('dependency-scoped program handle: target, transitive callees, direct callers', () => {
  const src = [
    'fn a u32 -> u32\nx add p0 1\nret x\nend',
    'fn b u32 -> u32\nx call a p0\nret x\nend',
    'fn other u32 -> u32\nx mul p0 2\nret x\nend',
    'fn step u32 u32 -> u32\nx call b p0\nret x\nend',
    'fn t u32 -> u32\nx fold step 3 p0\nret x\nend',
    'fn caller u32 -> u32\nx call t p0\nret x\nend',
    'fn grand u32 -> u32\nx call caller p0\nret x\nend',
  ].join('\n');
  const session = new EditSession(parseAndValidate(src));
  const g = session.openProgram({ scope: 'deps', target: 't' });
  assert.equal(
    g.text,
    'g0\n# 7 functions; shown: t, its callees, its callers\nfn a u32 -> u32 end\nfn b u32 -> u32 end\nfn step u32 u32 -> u32 end\nfn t u32 -> u32 end\nfn caller u32 -> u32 end',
  );
  // The full handle is unchanged and still available alongside.
  assert.equal(session.openProgram().text.split('\n').length, 8);
  assert.throws(() => session.openProgram({ scope: 'deps', target: 'nope' }), /unknown function/);
  assert.throws(() => session.openProgram({ scope: 'deps' }), /unknown function/);
  // The scoped handle edits the whole program, including functions it does not list.
  const next = session.apply(`${g.handle}\nfn other u32 -> u32\nx mul p0 5\nret x\nend`);
  assert.equal(run(next.byName.get('other') as TypedFunc, [2]), 10);
  // After an edit the view follows the program; a new caller of the target appears.
  session.apply(`${g.handle}\nfn c2 u32 -> u32\nx call t p0\nret x\nend`);
  assert.match(session.view(g.handle), /# 8 functions;[\s\S]*fn c2 u32 -> u32 end$/);
  assert.doesNotMatch(session.view(g.handle), /fn other|fn grand/);
  // Removing the target makes the view fall back to the full listing.
  session.apply(`${g.handle}\n-fn grand\n-fn caller\n-fn c2\n-fn t`);
  assert.equal(session.view(g.handle), `g0\n${programView(session.program)}`);
});

test('program-level edits: add, replace, and remove whole functions through a program handle', () => {
  const session = new EditSession(
    parseAndValidate(
      'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn twice u32 -> u32\nx call sq p0\ny add x x\nret y\nend',
    ),
  );
  const v = session.openProgram();
  assert.equal(v.handle, 'g0');
  assert.equal(v.text, 'g0\nfn sq u32 -> u32 end\nfn twice u32 -> u32 end');
  const next = session.apply(
    `${v.handle}\nfn cube u32 -> u32\ns call sq p0\nc mul s p0\nret c\nend`,
  );
  assert.equal(run(next.byName.get('cube') as TypedFunc, [3]), 27);
  assert.deepEqual(
    next.functions.map((f) => f.name),
    ['sq', 'twice', 'cube'],
  );
  // Replace in place keeps order; removing a function still in use fails atomically.
  const v2 = session.openProgram();
  const n2 = session.apply(`${v2.handle}\nfn sq u32 -> u32\na add p0 p0\nret a\nend`);
  assert.equal(run(n2.byName.get('cube') as TypedFunc, [3]), 18);
  assert.deepEqual(
    n2.functions.map((f) => f.name),
    ['sq', 'twice', 'cube'],
  );
  const v3 = session.openProgram();
  assert.throws(() => session.apply(`${v3.handle}\n-fn sq`), /unknown callee 'sq'/);
  assert.equal(session.program.functions.length, 3);
  const n4 = session.apply(`${v3.handle}\n-fn twice\n-fn cube`);
  assert.deepEqual(
    n4.functions.map((f) => f.name),
    ['sq'],
  );
  // The program handle stays usable after its own edit; removing the last function fails.
  assert.throws(() => session.apply(`${v3.handle}\n-fn sq`), /no functions/);
  // A program handle follows a function-level edit made through another handle.
  const g = session.openProgram();
  const f = session.open('sq');
  session.apply(`${f.handle}\na mul p0 3`);
  const n5 = session.apply(`${g.handle}\nfn z -> u32\nret 1\nend`);
  assert.deepEqual(
    n5.functions.map((x) => x.name),
    ['sq', 'z'],
  );
  // A handle to a removed function is closed.
  const hz = session.open('z');
  session.apply(`${g.handle}\n-fn z`);
  assert.throws(() => session.apply(`${hz.handle}\nret 2`), /removed|unknown handle/);
});

test('persistent cache: per-function emission keyed by semantic revision; wasm artifact by module text', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/a0cache-`);
  try {
    const cache = new DiskCache(dir);
    const src =
      'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn twice u32 -> u32\nx call sq p0\ny add x x\nret y\nend';
    const p = parseAndValidate(src);
    const first = await compileCached(p, 'c', cache);
    assert.equal(first.misses, 2);
    assert.equal(first.text, compile(p, 'c').text);
    const again = await compileCached(p, 'c', new DiskCache(dir));
    assert.equal(again.hits, 2);
    assert.equal(again.text, first.text);
    // Editing the callee invalidates the caller's entry too (semantic revision).
    const session = new EditSession(p);
    const v = session.open('sq');
    const edited = session.apply(`${v.handle}\na add p0 p0`);
    const third = await compileCached(edited, 'c', new DiskCache(dir));
    assert.equal(third.misses, 2);
    assert.equal(third.text, compile(edited, 'c').text);
    // Other target and optimization level are distinct keys.
    assert.equal((await compileCached(p, 'js', new DiskCache(dir))).misses, 2);
    assert.equal((await compileCached(p, 'c', new DiskCache(dir), { optimize: false })).misses, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('power-of-two div/rem strength-reduce to shifts and masks; io output is bounded', () => {
  const o = optimizeFunction(fn('fn f u32 -> u32\nq div p0 8\nr rem p0 16\ns add q r\nret s\nend'));
  assert.equal(
    formatFunction(o.fn),
    'fn f u32 -> u32\nq shr p0 3\nr and p0 15\ns add q r\nret s\nend',
  );
  assert.equal(run(o.fn, [1000]), Math.floor(1000 / 8) + (1000 % 16));
  const spam = parseAndValidate(
    'fn s io u32 -> io\nw write p0 p1\nret w\nend\nfn go u32 io -> u32\nt fold s p0 p1\nret 0\nend',
  );
  assert.throws(
    () => run(spam.byName.get('go') as TypedFunc, [0xffff_ffff, makeIo([])], { fuel: 10_000_000 }),
    /io output exceeds/,
  );
});

test('diagnostics carry a stable code, expected/actual, and a fix the editor can act on', () => {
  const typeErr = (() => {
    try {
      parseAndValidate('fn f u32 bool -> u32\na add p0 p1\nret a\nend\n');
    } catch (e) {
      return e;
    }
    return undefined;
  })();
  assert.ok(typeErr instanceof A0Error);
  assert.equal(typeErr.code, 'type');
  assert.equal(typeErr.expected, 'u32');
  assert.equal(typeErr.actual, 'bool');
  assert.match(typeErr.fix ?? '', /u32/);
  assert.deepEqual(Object.keys(typeErr.toJSON()).sort(), [
    'actual',
    'code',
    'expected',
    'fix',
    'line',
    'message',
  ]);

  const session = new EditSession(parseAndValidate('fn f u32 -> u32\na add p0 1\nret a\nend\n'));
  session.open('f');
  const unknown = (() => {
    try {
      session.apply('e7\na add p0 3\nret a');
    } catch (e) {
      return e;
    }
    return undefined;
  })();
  assert.ok(unknown instanceof A0Error);
  assert.equal(unknown.code, 'handle');
  assert.match(unknown.fix ?? '', /exactly as shown/);
  assert.match(formatDiagnostic(unknown), /^handle: .* fix: /);
});

test('linker: use lines resolve relative paths once, reject cycles and duplicate names, map lines', async () => {
  const files: Record<string, string> = {
    '/p/lib.a0': 'fn twice u32 -> u32\na add p0 p0\nret a\nend\n',
    '/p/mid.a0': 'use "lib.a0"\nfn quad u32 -> u32\na call twice p0\nb call twice a\nret b\nend\n',
    '/p/main.a0': 'use "lib.a0"\nuse "mid.a0"\nfn main u32 -> u32\nq call quad p0\nret q\nend\n',
    '/p/cyc1.a0': 'use "cyc2.a0"\nfn c1 -> u32\nret 1\nend\n',
    '/p/cyc2.a0': 'use "cyc1.a0"\nfn c2 -> u32\nret 2\nend\n',
    '/p/dup.a0': 'use "lib.a0"\nfn twice u32 -> u32\nret p0\nend\n',
    '/p/bad.a0': 'use "lib.a0"\nfn f u32 -> u32\na add p0 true\nret a\nend\n',
  };
  const read = async (path: string): Promise<string> => {
    const t = files[path];
    if (t === undefined) throw new Error(`missing ${path}`);
    return t;
  };
  const linked = await link('/p/main.a0', read);
  assert.deepEqual(
    linked.sources.map((s) => s.path),
    ['/p/lib.a0', '/p/mid.a0', '/p/main.a0'],
  );
  assert.equal(run(linked.program.byName.get('main') as TypedFunc, [5]), 20);
  await assert.rejects(
    link('/p/cyc1.a0', read),
    (e: unknown) => e instanceof A0Error && /cycle/.test(e.message),
  );
  await assert.rejects(
    link('/p/dup.a0', read),
    (e: unknown) => e instanceof A0Error && /both/.test(e.message),
  );
  await assert.rejects(
    link('/p/bad.a0', read),
    (e: unknown) =>
      e instanceof A0Error && e.code === 'type' && /^\/p\/bad\.a0:3: /.test(e.message),
  );
});

test('JS emission: zero arrays allocate, power-of-two indices mask, owned sets are inline', async () => {
  const src =
    'fn put8 u32x8 u32 u32 -> u32x8\nv add p1 p2\nn set p0 p1 v\nret n\nend\nfn arrfill u32 u32 -> u32\nz arr 0 0 0 0 0 0 0 0\na fold put8 8 z p0\nx get a p1\ny get a 3\ns add x y\nret s\nend';
  const p = parseAndValidate(src);
  const js = compile(p, 'js').text;
  assert.ok(js.includes('new Uint32Array(8)'));
  assert.ok(js.includes('[(p1 & 7)]'));
  assert.ok(/a0o_put8[\s\S]*\(p0\[\(p1 & 7\)\] = n_v, p0\)/.test(js));
  assert.ok(!js.includes('a0_setmut'));
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as { arrfill: (x: number, y: number) => number };
  const f = p.byName.get('arrfill') as TypedFunc;
  for (const [x, y] of [
    [0, 0],
    [5, 11],
    [0xffffffff, 3],
    [123456789, 4294967295],
  ] as const)
    assert.equal(mod.arrfill(x, y), run(f, [x, y]));
  // A length that is not a power of two still uses the remainder.
  const js3 = compile(
    parseAndValidate('fn g u32x3 u32 -> u32\nx get p0 p1\nret x\nend'),
    'js',
  ).text;
  assert.ok(js3.includes('[p1 % 3]'));
});

test('C emission: owned iteration bodies update the loop state in place; large arrays are native-only', async () => {
  const { emitMetal } = await import('../src/metal.js');
  const { LIMITS } = await import('../src/core.js');
  const src =
    'fn put8 u32x8 u32 u32 -> u32x8\nv add p1 p2\nn set p0 p1 v\nret n\nend\nfn below u32x8 u32 u32 -> bool\na get p0 0\nc lt a p2\nret c\nend\nfn keepold u32x8 u32 u32 -> u32x8\nn set p0 p1 p2\na get p0 p1\nm set n 0 a\nret m\nend\nfn arrfill u32 u32 -> u32\nz arr 0 0 0 0 0 0 0 0\na fold put8 8 z p0\nl loop below keepold 8 a p1\nx get l p1\ny get a 3\ns add x y\nret s\nend';
  const p = parseAndValidate(src);
  const c = compile(p, 'c').text;
  // The owned variant writes through the state pointer and returns nothing; the value ABI
  // updates its private by-value copy in place and returns it.
  assert.ok(
    /static inline void a0o_put8\(a0t_a8_u \*p0, uint32_t p1, uint32_t p2\) \{\n[^}]*\(\*p0\)\.e\[p1 % 8u\] = n_v;\n\}/.test(
      c,
    ),
  );
  assert.ok(
    /a0t_a8_u a0_put8\(a0t_a8_u p0, uint32_t p1, uint32_t p2\) \{\n[^}]*p0\.e\[p1 % 8u\] = n_v;\n {2}return p0;\n\}/.test(
      c,
    ),
  );
  // A value still read later is copied (a0set_), and the copy is then updated in place.
  assert.ok(
    /a0o_keepold[^}]*a0t_a8_u n_n = a0set_a8_u\(\(\*p0\), p1, p2\);[^}]*n_n\.e\[0u % 8u\] = n_a;\n {2}\*p0 = n_n;/.test(
      c,
    ),
  );
  // Predicates read the state through a const pointer; folds and loops call the variants.
  assert.ok(c.includes('static inline bool a0r_below(const a0t_a8_u *p0,'));
  assert.ok(c.includes('a0o_put8(&n_z, i, p0); }'));
  assert.ok(!c.includes('n_a = n_z'));
  assert.ok(c.includes('if (!a0r_below(&n_l, i, p1)) break; a0o_keepold(&n_l, i, p1); }'));
  assert.ok(c.includes('a0zero_a8_u()'));
  assert.ok(emitMetal(p).includes('thread a0t_a8_u *p0'));
  assert.ok(compile(p, 'java').text.includes('new int[8]'));
  // Native paths accept 65536-element arrays; hardware and GPU refuse them with a limit code.
  assert.equal(LIMITS.maxArrayLength, 65536);
  const big = parseAndValidate(
    'fn poke u32x65536 u32 u32 -> u32x65536\nn set p0 p2 p1\nret n\nend',
  );
  assert.ok(compile(big, 'c').text.includes('uint32_t e[65536];'));
  assert.ok(compile(big, 'java').text.includes('int[] poke(int[] p0'));
  for (const emit of [() => compile(big, 'sv'), () => emitMetal(big)])
    assert.throws(
      emit,
      (e: unknown) =>
        e instanceof A0Error && e.code === 'limit' && /array length 65536 exceeds/.test(e.message),
    );
  assert.throws(() => parseType('u32x65537'), /array length exceeds 65536/);
  assert.throws(() => parseType('u32x65536x2'), /exceeds 2097152 bits/);
});

test('fold state passed again as an extra: the loop copies it, so every trip reads the initial value (JS, C)', async () => {
  const { compileWasm, findWasmClang } = await import('../src/toolchain.js');
  // Trip i writes state[i] = extra[(i + 7) % n] + 1; reusing the initial value's storage for the
  // state would make trip i read the value trip i - 1 wrote.
  const program = (n: number): string =>
    `fn step u32x${n} u32 u32x${n} -> u32x${n}\nj add p1 ${n - 1}\nx get p2 j\nv add x 1\ns set p0 p1 v\nret s\nend\nfn chain u32 u32 -> u32\nz arr ${Array.from({ length: n }, (_, k) => (k === n - 1 ? 'p0' : '0')).join(' ')}\na fold step ${n} z z\nr get a p1\nret r\nend`;
  for (const n of [8, 2048]) {
    const p = parseAndValidate(program(n));
    const chain = p.byName.get('chain') as TypedFunc;
    const cases = [
      [5, 0],
      [5, 1],
      [5, 3],
      [0xffffffff, 2],
    ] as const;
    for (const [x, i] of cases) assert.equal(run(chain, [x, i]), i === 0 ? (x + 1) >>> 0 : 1);
    const js = compile(p, 'js').text;
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )) as { chain: (x: number, i: number) => number };
    for (const [x, i] of cases) assert.equal(mod.chain(x, i), run(chain, [x, i]));
    const clang = findWasmClang();
    if (clang.path !== undefined && clang.wasmLd !== undefined) {
      const { instance } = await WebAssembly.instantiate(
        (await compileWasm(compile(p, 'c').text)).bytes as BufferSource,
        {},
      );
      const wchain = instance.exports.a0_chain as (x: number, i: number) => number;
      for (const [x, i] of cases) assert.equal(wchain(x, i) >>> 0, run(chain, [x, i]));
    }
  }
});

test('C emission: aggregates over 4 KiB are borrowed by pointer, returned through out, and held in a static arena', async () => {
  const { compileWasm, findWasmClang } = await import('../src/toolchain.js');
  const zeros = Array.from({ length: 2048 }, () => '0').join(' ');
  const src = [
    'fn fill u32x2048 u32 u32 -> u32x2048\nv mul p1 p2\nn set p0 p1 v\nret n\nend',
    'fn bump u32x2048 u32 -> u32x2048\nn set p0 p1 7\nret n\nend',
    'fn sum u32 u32 u32x2048 -> u32\nx get p2 p1\ns add p0 x\nret s\nend',
    `fn top u32 -> u32\nz arr ${zeros}\na fold fill 2048 z p0\nb call bump a 5\nk lt p0 10\nc select k a b\nm mov c\nr rec m p0\nq at r 0\nw arr a b\ng get w p0\nt fold sum 2048 0 g\ny get q 5\nu get b 5\nh get a 5\nf add t y\nd add f u\ne add d h\nret e\nend`,
  ].join('\n');
  const p = parseAndValidate(src);
  const c = compile(p, 'c').text;
  // Public ABI of large values: const-pointer parameters, caller-owned result storage.
  assert.ok(c.includes('void a0_bump(a0t_a2048_u *out, const a0t_a2048_u *p0, uint32_t p1)'));
  // The first set of a borrowed parameter copies it, directly into `out`; no arena use.
  assert.ok(/a0_bump\([^)]*\) \{\n {2}a0t_a2048_u \*const n_n = out; \*n_n = \(\*p0\);/.test(c));
  assert.ok(/a0_top\(uint32_t p0\) \{\n {2}const uint32_t a0arena_mark = a0arena_top;/.test(c));
  assert.ok(c.includes('a0arena_top = a0arena_mark;\n  return n_e;'));
  assert.ok(/#define A0_ARENA_BYTES \d+u/.test(c));
  // Small functions keep the by-value ABI and no arena.
  const small = compile(
    parseAndValidate('fn f u32x8 u32 -> u32x8\nn set p0 p1 1\nret n\nend'),
    'c',
  );
  assert.ok(small.text.includes('a0t_a8_u a0_f(a0t_a8_u p0, uint32_t p1)'));
  assert.ok(!small.text.includes('a0arena'));
  const top = p.byName.get('top') as TypedFunc;
  const inputs = [0, 3, 9, 10, 2047, 4096 + 7];
  const clang = findWasmClang();
  if (clang.path !== undefined && clang.wasmLd !== undefined) {
    const { instance } = await WebAssembly.instantiate(
      (await compileWasm(c)).bytes as BufferSource,
      {},
    );
    const wtop = instance.exports.a0_top as (x: number) => number;
    for (const x of inputs) assert.equal(wtop(x) >>> 0, run(top, [x]));
  }
});

test('edit tolerance: trailing end, whole-function block under its handle, echoed signatures, callee order', () => {
  const src =
    'fn sq u32 -> u32\na mul p0 p0\nret a\nend\nfn main u32 -> u32\nb call sq p0\nret b\nend';
  // Trailing `end` after edit lines is accepted.
  let s = new EditSession(parseAndValidate(src));
  let h = s.open('sq').handle;
  let p = s.apply(`${h}\na add p0 p0\nret a\nend`);
  assert.equal(run(p.byName.get('sq') as TypedFunc, [3]), 6);
  // A new node nothing reads is rejected with the fix (the usual cause: ret was not updated).
  s = new EditSession(parseAndValidate(src));
  h = s.open('sq').handle;
  assert.throws(() => s.apply(`${h}\nb mul a p0`), /not used by any node or by ret/);
  p = s.apply(`${h}\nb mul a p0\nret b`);
  assert.equal(run(p.byName.get('sq') as TypedFunc, [3]), 27);
  // The whole function sent back under its own handle replaces it; another function is refused.
  s = new EditSession(parseAndValidate(src));
  h = s.open('sq').handle;
  p = s.apply(`${h}\nfn sq u32 -> u32\na sub p0 1\nret a\nend`);
  assert.equal(run(p.byName.get('sq') as TypedFunc, [3]), 2);
  // A whole block for another function under a function handle is a program-level edit
  // (added or replaced), exactly as under a program handle; the handled function is kept.
  s = new EditSession(parseAndValidate(src));
  h = s.open('sq').handle;
  p = s.apply(`${h}\nfn other u32 -> u32\nret p0\nend`);
  assert.equal(run(p.byName.get('other') as TypedFunc, [7]), 7);
  assert.equal(run(p.byName.get('sq') as TypedFunc, [3]), 9);
  // Edit lines for the handled function followed by a whole block replacing its callee:
  // the block lands first, so the new call type-checks against the new callee.
  const src2 =
    'fn mixel u32 u32 u32x4 -> u32\nret p0\nend\nfn checksum u32x4 -> u32\nr fold mixel 4 0 p0\nret r\nend';
  s = new EditSession(parseAndValidate(src2));
  h = s.open('checksum').handle;
  p = s.apply(
    `${h}\nr fold mixel 4 7 p0\nfn mixel u32 u32 u32x4 -> u32\nval get p2 p1\nprod mul p0 31\nres add prod val\nret res\nend`,
  );
  assert.equal(
    run(p.byName.get('checksum') as TypedFunc, [[1, 2, 3, 4]]),
    ((((7 * 31 + 1) * 31 + 2) * 31 + 3) * 31 + 4) >>> 0,
  );
  // `-fn` is a program-level edit under a function handle too; removing the handled
  // function while also editing it is refused.
  s = new EditSession(parseAndValidate(src2));
  h = s.open('checksum').handle;
  assert.throws(
    () => s.apply(`${h}\nr fold mixel 4 7 p0\n-fn checksum`),
    /which this reply removes/,
  );
  // An echo of the rest of the view (program handle line plus signature lines) is ignored.
  s = new EditSession(parseAndValidate(src));
  const e = s.open('sq').handle;
  const g = s.openProgram().handle;
  p = s.apply(`${e}\na xor p0 1\nret a\nend\n${g}\nfn sq u32 -> u32 end\nfn main u32 -> u32 end`);
  assert.equal(run(p.byName.get('sq') as TypedFunc, [3]), 2);
  // Program edit: a new callee written above its replaced caller is placed before it.
  s = new EditSession(parseAndValidate(src));
  const g2 = s.openProgram().handle;
  p = s.apply(
    `${g2}\nfn sq u32 -> u32 end\nfn cube u32 -> u32\nq call sq p0\nc mul q p0\nret c\nend\nfn main u32 -> u32\nb call cube p0\nret b\nend`,
  );
  assert.deepEqual(
    p.functions.map((f) => f.name),
    ['sq', 'cube', 'main'],
  );
  assert.equal(run(p.byName.get('main') as TypedFunc, [3]), 27);
});

test('boolean and/or/xor/eq: typed, exact, optimized, and identical on the JS backend', async () => {
  const src =
    'fn logic u32 u32 -> bool\na lt p0 p1\nb eq p0 p1\nc or a b\nd xor a b\ne and c d\nf eq e false\ng xor f true\nret g\nend';
  const p = parseAndValidate(src);
  const f = p.byName.get('logic') as TypedFunc;
  assert.equal(f.types.get('c'), 'bool');
  assert.equal(f.types.get('g'), 'bool');
  const ref = (x: number, y: number): boolean => {
    const a = x < y;
    const b = x === y;
    const c = a || b;
    const d = a !== b;
    const e = c && d;
    const fv = e === false;
    return fv !== true;
  };
  const opt = optimize(p).program.byName.get('logic') as TypedFunc;
  const js = compile(p, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as { logic: (x: number, y: number) => boolean };
  for (const [x, y] of [
    [1, 2],
    [2, 1],
    [5, 5],
    [0, 0xffffffff],
  ] as const) {
    assert.equal(run(f, [x, y]), ref(x, y));
    assert.equal(run(opt, [x, y]), ref(x, y));
    assert.equal(mod.logic(x, y), ref(x, y));
  }
  // Mixed operand types are rejected; identities respect the bool type.
  assert.throws(
    () => parseAndValidate('fn m u32 bool -> bool\nx and p0 p1\nret x\nend'),
    /expected/,
  );
  const folded = optimize(
    parseAndValidate('fn k bool -> bool\nx xor p0 p0\ny or x p0\nz and y true\nret z\nend'),
  ).program.byName.get('k') as TypedFunc;
  assert.equal(run(folded, [true]), true);
  assert.equal(run(folded, [false]), false);
});

test('edit generality: any dependency order, new callees in any order, multi-section replies, le/gt/ge/ne', async () => {
  // Nodes listed out of order inside an edit are placed in dependency order.
  let s = new EditSession(parseAndValidate('fn f u32 u32 -> u32\na add p0 p1\nret a\nend'));
  let h = s.open('f').handle;
  let p = s.apply(`${h}\nd mul c 2\nc sub a p1\nret d`);
  assert.equal(run(p.byName.get('f') as TypedFunc, [5, 3]), 10);
  // A program edit may define a caller before its new callee.
  s = new EditSession(parseAndValidate('fn f u32 -> u32\nret p0\nend'));
  let g = s.openProgram().handle;
  p = s.apply(
    `${g}\nfn quad u32 -> u32\na call twice p0\nb call twice a\nret b\nend\nfn twice u32 -> u32\na add p0 p0\nret a\nend`,
  );
  assert.deepEqual(
    p.functions.map((x) => x.name),
    ['f', 'twice', 'quad'],
  );
  assert.equal(run(p.byName.get('quad') as TypedFunc, [3]), 12);
  // A reply with a function section and a program section applies atomically.
  s = new EditSession(
    parseAndValidate('fn min2 u32 u32 -> u32\nc lt p1 p0\nr select c p1 p0\nret r\nend'),
  );
  h = s.open('min2').handle;
  g = s.openProgram().handle;
  p = s.apply(
    `${h}\nc le p1 p0\nret r\n${g}\nfn min2 u32 u32 -> u32 end\nfn min3 u32 u32 u32 -> u32\nm call min2 p0 p1\nn call min2 m p2\nret n\nend`,
  );
  assert.equal(run(p.byName.get('min3') as TypedFunc, [7, 2, 5]), 2);
  assert.throws(
    () => s.apply(`${h}\nc gt p1 p0\n${g}\nfn bad u32 -> u32\nx add p0 true\nret x\nend`),
    /expected/,
  );
  assert.equal(s.program.functions.length, 2); // nothing from the failed reply landed
  // New comparisons are exact and unsigned everywhere the JS backend runs.
  const cmp = parseAndValidate(
    'fn c u32 u32 -> u32\na le p0 p1\nb gt p0 p1\nd ge p0 p1\ne ne p0 p1\nx select a 1 0\ny select b 2 0\nz select d 4 0\nw select e 8 0\nxy or x y\nzw or z w\nr or xy zw\nret r\nend',
  );
  const js = compile(cmp, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as {
    c: (a: number, b: number) => number;
  };
  for (const [a, b, want] of [
    [1, 2, 1 | 8],
    [2, 1, 2 | 4 | 8],
    [5, 5, 1 | 4],
    [0xffffffff, 0, 2 | 4 | 8],
  ] as const) {
    assert.equal(run(cmp.byName.get('c') as TypedFunc, [a, b]), want);
    assert.equal(mod.c(a, b), want);
  }
});

test('ret expression sugar: `ret OP ARGS` in source and in edits', () => {
  const p = parseAndValidate(
    'fn sat u32 u32 -> u32\ns add p0 p1\nc lt s p0\nret select c 4294967295 s\nend',
  );
  const f = p.byName.get('sat') as TypedFunc;
  assert.equal(f.nodes.at(-1)?.id, 'retval');
  assert.equal(run(f, [0xfffffff0, 0x20]), 0xffffffff);
  assert.equal(run(f, [1, 2]), 3);
  const s = new EditSession(parseAndValidate('fn f u32 -> u32\nretval add p0 1\nret retval\nend'));
  const h = s.open('f').handle;
  const n = s.apply(`${h}\nret mul retval 2`);
  assert.equal(n.byName.get('f')?.nodes.at(-1)?.id, 'retval2');
  assert.equal(run(n.byName.get('f') as TypedFunc, [4]), 10);
});

const ARM64_HOST = process.platform === 'darwin' && process.arch === 'arm64';

test('fold state passed again as an extra: the A0 backends copy it (arm64, x86_64, riscv64, arm32, avr, wasm)', async () => {
  const verify = await import('../tools/verify.js');
  const tc = await import('../src/toolchain.js');
  // Trip i writes state[i] = extra[(i + n - 1) % n] + 1 with extra = the initial value; reusing
  // the initial value's storage for the state makes trip i read what trip i - 1 wrote.
  const program = (n: number): string =>
    `fn step u32x${n} u32 u32x${n} -> u32x${n}\nj add p1 ${n - 1}\nx get p2 j\nv add x 1\ns set p0 p1 v\nret s\nend\nfn chain u32 u32 -> u32\nz arr ${Array.from({ length: n }, (_, k) => (k === n - 1 ? 'p0' : '0')).join(' ')}\na fold step ${n} z z\nr get a p1\nret r\nend`;
  const inputs = [
    [5, 0],
    [5, 1],
    [5, 3],
    [0xffffffff, 2],
  ] as const;
  const clang = tc.findClang();
  for (const n of [8, 1024]) {
    const p = parseAndValidate(program(n));
    const chain = p.byName.get('chain') as TypedFunc;
    const cases = inputs.map(([x, i]) => ({
      functionName: 'chain',
      args: [x, i],
      expected: run(chain, [x, i]),
    }));
    for (const [x, i] of inputs) assert.equal(run(chain, [x, i]), i === 0 ? (x + 1) >>> 0 : 1);
    const reports: [string, { status: string; failures?: unknown; detail?: unknown }][] = [
      ['wasm', await verify.checkWasmDirect(p, cases)],
    ];
    if (ARM64_HOST) reports.push(['arm64', await verify.checkArm64(p, cases, clang)]);
    if (X86_64_HOST !== undefined)
      reports.push(['x86_64', await verify.checkX86_64(p, cases, clang)]);
    const rvGcc = tc.findRiscv64Gcc();
    const rvQemu = tc.findQemuRiscv64();
    if (rvGcc.path !== undefined && rvQemu.path !== undefined)
      reports.push(['riscv64', await verify.checkRiscv64(p, cases, rvGcc, rvQemu)]);
    const armGcc = tc.findArmGcc();
    const armQemu = tc.findQemuSystemArm();
    if (armGcc.path !== undefined && armQemu.path !== undefined)
      reports.push(['arm32', await verify.checkArm32(p, cases, armGcc, armQemu)]);
    // The ATmega328P's 2 KiB of RAM holds only the small case.
    const avrGcc = tc.findAvrGcc();
    if (n === 8 && avrGcc.path !== undefined && tc.findSimavr().prefix !== undefined)
      reports.push(['avr', await verify.checkAvr(p, cases, avrGcc, clang)]);
    for (const [name, report] of reports)
      assert.equal(
        report.status,
        'passed',
        `${name} n=${n}: ${JSON.stringify(report.failures ?? report.detail)}`,
      );
  }
});

test('arm64 backend refuses io functions with a diagnostic', () => {
  const p = parseAndValidate('fn w io u32 -> io\nt write p0 p1\nret t\nend');
  assert.throws(
    () => compile(p, 'arm64'),
    (e: unknown) => e instanceof A0Error && /io functions are out of scope/.test(e.message),
  );
});

test('arm64 backend: assembled, linked with a C driver, and executed equal to the interpreter', {
  skip: ARM64_HOST ? false : 'needs macOS on Apple silicon',
}, async () => {
  const { findClang, runTool, withTempDir } = await import('../src/toolchain.js');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  const zeros = Array.from({ length: 1024 }, () => '0').join(' ');
  const src = [
    // fold body over an array state (aggregate parameter and sret result)
    'fn step u32x8 u32 u32 -> u32x8\na get p0 p1\nb add a p2\nc mul b 3\nn set p0 p1 c\nret n\nend',
    // twelve parameters: bools and u32s past x7 travel on the stack
    'fn many u32 u32 u32 u32 u32 u32 u32 u32 bool u32 bool u32 -> u32\na add p0 p1\nb sub a p2\nc mul b p3\nd xor c p4\ne shl d p5\nf shr e p6\ng div f p7\nh rem g p9\ni select p8 h p11\nj select p10 i p9\nk add j p11\nret k\nend',
    'fn pair u32 u32 -> (u32,bool)\nc lt p0 p1\nr rec p0 c\nret r\nend',
    'fn keep u32 u32 -> bool\nb lt p0 1000\nret b\nend',
    'fn grow u32 u32 -> u32\nb mul p0 3\nc add b p1\nret c\nend',
    'fn top u32 u32 bool -> u32\nk and p1 15\nz arr p0 p1 1 2 3 4 5 6\nf fold step k z p0\ng get f p1\nr call pair p0 p1\nh at r 0\ns loop keep grow p1 h\nt put r 0 s\nu at t 1\nt0 at t 0\nm call many p0 p1 g t0 p0 p1 g s u p0 p2 t0\nq ge m g\nw select q m g\nx div w p1\ny rem p0 p1\nv add x y\nret v\nend',
    // a 4 KiB array: word-copy loops and a page-probed frame
    'fn poke u32x1024 u32 u32 -> u32x1024\nn set p0 p2 p1\nret n\nend',
    `fn bigtop u32 u32 -> u32\nz arr ${zeros}\nk and p1 7\nf fold poke k z p0\na get f p1\nb get f 3\nc add a b\nret c\nend`,
  ].join('\n\n');
  const p = parseAndValidate(src);
  const inputs: [number, number, boolean][] = [
    [0, 0, false],
    [1, 2, true],
    [7, 13, false],
    [0xffffffff, 5, true],
    [123456, 0xfffffff0, true],
    [999, 3, false],
  ];
  const top = p.byName.get('top') as TypedFunc;
  const bigtop = p.byName.get('bigtop') as TypedFunc;
  const expected = inputs
    .flatMap(([a, b, c]) => [String(run(top, [a, b, c])), String(run(bigtop, [a, b]))])
    .join('\n');
  const calls = inputs
    .map(
      ([a, b, c]) => `  printf("%u\\n%u\\n", a0_top(${a}u, ${b}u, ${c}), a0_bigtop(${a}u, ${b}u));`,
    )
    .join('\n');
  const driver = `#include <stdint.h>\n#include <stdbool.h>\n#include <stdio.h>\nextern uint32_t a0_top(uint32_t, uint32_t, bool);\nextern uint32_t a0_bigtop(uint32_t, uint32_t);\nint main(void) {\n${calls}\n  return 0;\n}\n`;
  for (const optimize of [true, false]) {
    const asm = compile(p, 'arm64', { optimize }).text;
    assert.doesNotMatch(asm, /#include|int main/);
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'module.s'), asm, 'utf8');
      await writeFile(join(dir, 'driver.c'), driver, 'utf8');
      const as = runTool(clang, ['-c', '-x', 'assembler', '-o', 'module.o', 'module.s'], {
        cwd: dir,
      });
      assert.ok(as.ok, as.stderr);
      const ld = runTool(clang, ['-O1', '-o', 'driver', 'driver.c', 'module.o'], { cwd: dir });
      assert.ok(ld.ok, ld.stderr);
      const exec = runTool(join(dir, 'driver'), [], { cwd: dir });
      assert.ok(exec.ok, exec.stderr);
      assert.equal(exec.stdout.trim(), expected);
    });
  }
});

test('x86_64 backend refuses io functions with a diagnostic', () => {
  const p = parseAndValidate('fn w io u32 -> io\nt write p0 p1\nret t\nend');
  assert.throws(
    () => compile(p, 'x86_64'),
    (e: unknown) => e instanceof A0Error && /io functions are out of scope/.test(e.message),
  );
});

test('x86_64 backend: emitted sequences carry the exact semantics', async () => {
  const { emitX86_64Function } = await import('../src/x86_64.js');
  const fn = (src: string, name: string): TypedFunc =>
    parseAndValidate(src).byName.get(name) as TypedFunc;
  // A leaf keeps its parameters in edi/esi and computes its result straight into eax; small
  // multipliers and three-operand adds are lea; an empty frame needs no rsp restore. The
  // platform switch names symbols.
  const affine = fn('fn affine u32 u32 -> u32\na mul p0 3\nb add a p1\nret b\nend', 'affine');
  const darwin = emitX86_64Function(affine, 'darwin');
  assert.match(darwin, /^\t\.globl _a0_affine$/m);
  assert.match(
    darwin,
    /leal \(%rdi,%rdi,2\), %edi\n\tleal \(%rdi,%rsi\), %eax\n\tpopq %rbp\n\tret$/,
  );
  assert.doesNotMatch(darwin, /movq %rbp, %rsp/);
  const linux = emitX86_64Function(affine, 'linux');
  assert.match(linux, /^\t\.globl a0_affine$/m);
  assert.match(linux, /^\t\.type a0_affine,@function$/m);
  assert.doesNotMatch(linux, /_a0_/);
  // Division: DIV would trap on zero, so the zero divisor is branched around; A0 says all ones
  // for the quotient and the dividend for the remainder.
  const div = emitX86_64Function(fn('fn d u32 u32 -> u32\nq div p0 p1\nret q\nend', 'd'));
  assert.match(
    div,
    /testl %esi, %esi\n\tje (La0_d_\d+)\n\txorl %edx, %edx\n\tdivl %esi\n\tjmp La0_d_\d+\n\1:\n\tmovl \$-1, %eax/,
  );
  const rem = emitX86_64Function(fn('fn r u32 u32 -> u32\nq rem p0 p1\nret q\nend', 'r'));
  assert.match(rem, /divl %esi\n\tmovl %edx, %eax\n\tjmp/);
  // Shifts: a literal distance is masked to five bits at compile time, a variable one runs
  // through cl (the hardware masks to five bits as well).
  const shl = emitX86_64Function(
    fn('fn s u32 u32 -> u32\na shl p0 33\nb shl a p1\nret b\nend', 's'),
  );
  assert.match(shl, /shll \$1, %edi/);
  assert.match(shl, /movl %esi, %ecx\n\tmovl %edi, %eax\n\tshll %cl, %eax/);
  // Rotates: both halves of shl/shr by n and 32 - n (variable) or k and 32 - k (literal).
  const rotv = emitX86_64Function(
    fn('fn r u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nh shr p0 n\no or l h\nret o\nend', 'r'),
  );
  assert.match(rotv, /movl %esi, %ecx\n\tmovl %edi, %eax\n\troll %cl, %eax/);
  assert.doesNotMatch(rotv, /shll|shrl/);
  const rotk = emitX86_64Function(
    fn('fn r u32 -> u32\nl shl p0 13\nh shr p0 19\no xor h l\nret o\nend', 'r'),
  );
  assert.match(rotk, /roll \$13, %eax/);
  // A comparison that only feeds selects is flags plus cmov, never a 0/1 value; a single-bit
  // mask compared with 0 is a test.
  const sel = emitX86_64Function(
    fn('fn m u32 u32 -> u32\nc lt p0 p1\nr select c p0 p1\nret r\nend', 'm'),
  );
  assert.match(sel, /cmpl %esi, %edi\n\tmovl %esi, %eax\n\tcmovbl %edi, %eax/);
  assert.doesNotMatch(sel, /set/);
  const bit = emitX86_64Function(
    fn('fn t u32 u32 -> u32\nb and p0 4\nc eq b 0\nr select c p1 p0\nret r\nend', 't'),
  );
  assert.match(bit, /testl \$4, %edi\n\tmovl %edi, %eax\n\tcmovel %esi, %eax/);
  // A materialized comparison zeroes its destination first and writes only the low byte.
  const lt = emitX86_64Function(fn('fn l u32 u32 -> bool\nc lt p0 p1\nret c\nend', 'l'));
  assert.match(lt, /xorl %eax, %eax\n\tcmpl %esi, %edi\n\tsetb %al/);
  // Index modulo the length: a power of two is a mask, another length divides; the element
  // size is the SIB scale.
  const get8 = emitX86_64Function(fn('fn g u32x8 u32 -> u32\nv get p0 p1\nret v\nend', 'g'));
  assert.match(get8, /andl \$7, %r10d\n\tmovl 0\(%rsp,%r10,4\), %eax/);
  // Loops test at the bottom (a variable count gets one zero guard), and a fold counter below
  // the array length indexes it with no mask.
  const loop = emitX86_64Function(
    fn(
      'fn st u32 u32 -> u32\na add p0 p1\nret a\nend\nfn f u32 u32 -> u32\nr fold st p1 p0\nret r\nend',
      'f',
    ),
  );
  assert.match(
    loop,
    /testl %esi, %esi\n\tje (La0_f_\d+)\n(La0_f_\d+):[\s\S]*cmpl %esi, %r8d\n\tjb \2\n\1:/,
  );
  const fill = emitX86_64Function(
    fn(
      'fn put u32x8 u32 u32 -> u32x8\nv add p1 p2\nn set p0 p1 v\nret n\nend\nfn a u32 -> u32\nz arr 0 0 0 0 0 0 0 0\nf fold put 8 z p0\nx get f 3\nret x\nend',
      'a',
    ),
  );
  assert.match(fill, /xorps %xmm0, %xmm0\n\tmovups %xmm0, \(%rsp\)\n\tmovups %xmm0, 16\(%rsp\)/);
  assert.match(fill, /movl %\w+, 0\(%rsp,%r\w+,4\)/);
  assert.doesNotMatch(fill, /andl \$7/);
  const get5 = emitX86_64Function(fn('fn g u32x5 u32 -> u32\nv get p0 p1\nret v\nend', 'g'));
  assert.match(get5, /movl \$5, %r10d\n\tdivl %r10d\n\tmovl %edx, %r10d/);
  // An aggregate result comes back through the sret pointer in rdi, also returned in rax.
  const pair = emitX86_64Function(
    fn('fn p u32 -> (u32,bool)\nc lt p0 1\nr rec p0 c\nret r\nend', 'p'),
  );
  assert.match(
    pair,
    /movq %rdi, (\d+\(%rsp\))[\s\S]*movq \1, %r11[\s\S]*movq \1, %rax\n\tmovq %rbp, %rsp/,
  );
  // Aggregates are copied 16 bytes at a time through xmm0 (a loop above 32 words), so a
  // parameter arriving in rcx stays there in a leaf.
  const big = emitX86_64Function(
    fn('fn b u32x32 u32 u32 u32 -> u32\nv get p0 p3\nw add v p2\nret w\nend', 'b'),
  );
  assert.match(big, /movups 112\(%rdi\), %xmm0\n\tmovups %xmm0, 112\(%rsp\)\n\tmovl %ecx, %r10d/);
  const huge = emitX86_64Function(fn('fn h u32x40 -> u32\nv get p0 39\nret v\nend', 'h'));
  assert.match(
    huge,
    /movups \(%r10,%rax\), %xmm0\n\tmovups %xmm0, \(%r11,%rax\)\n\taddq \$16, %rax\n\tcmpq \$160, %rax/,
  );
  // Frames above a page are probed page by page.
  const zeros = Array.from({ length: 2048 }, () => '0').join(' ');
  const probe = emitX86_64Function(
    fn(`fn z u32 -> u32\na arr ${zeros}\nv get a p0\nret v\nend`, 'z'),
  );
  assert.match(probe, /subq \$4096, %rsp\n\tmovq \$0, \(%rsp\)\n\tdecl %eax\n\tjne/);
});

test('riscv64 backend refuses io functions with a diagnostic', () => {
  const p = parseAndValidate('fn w io u32 -> io\nt write p0 p1\nret t\nend');
  assert.throws(
    () => compile(p, 'riscv64'),
    (e: unknown) =>
      e instanceof A0Error && /riscv64: .*io functions are out of scope/.test(e.message),
  );
});

test('riscv64 backend: emitted sequences carry the exact semantics', async () => {
  const { emitRiscv64Function } = await import('../src/riscv64.js');
  const fn = (src: string, name: string): TypedFunc =>
    parseAndValidate(src).byName.get(name) as TypedFunc;
  // A leaf keeps its parameters in a0/a1; W-form instructions keep u32 canonical (sign-extended).
  const affine = emitRiscv64Function(
    fn('fn affine u32 u32 -> u32\na mul p0 3\nb add a p1\nret b\nend', 'affine'),
  );
  assert.match(affine, /^\t\.globl a0_affine$/m);
  assert.match(affine, /^\t\.type a0_affine, @function$/m);
  // Frameless leaf: no ra/s0 save, no stack adjustment.
  assert.match(affine, /^a0_affine:\n\tli t2, 3\n\tmulw a0, a0, t2\n\taddw a0, a0, a1\n\tret$/m);
  // divuw/remuw already give all ones and the dividend for a zero divisor: no branch.
  const div = emitRiscv64Function(
    fn('fn d u32 u32 -> u32\nq div p0 p1\nr rem p0 p1\ns add q r\nret s\nend', 'd'),
  );
  assert.match(div, /divuw (\w+), a0, a1\n\tremuw a0, a0, a1\n\taddw a0, \1, a0/);
  assert.doesNotMatch(div, /beqz|bnez/);
  // A literal shift distance is masked at compile time; a variable one uses srlw (masks to 5 bits).
  const sh = emitRiscv64Function(
    fn('fn s u32 u32 -> u32\na shl p0 33\nb shr a p1\nret b\nend', 's'),
  );
  assert.match(sh, /slliw a0, a0, 1\n\tsrlw a0, a0, a1/);
  // Unsigned comparison on canonical registers.
  const sel = emitRiscv64Function(
    fn('fn m u32 u32 -> u32\nc lt p0 p1\nr select c p0 p1\nret r\nend', 'm'),
  );
  // The chosen value already in the destination: one branch and one move, no redundant mv.
  assert.match(sel, /sltu (\w+), a0, a1\n\tbnez \1, (\.\w+)\n\tmv a0, a1\n\2:\n\tret/);
  // A power-of-two index is masked.
  const get8 = emitRiscv64Function(fn('fn g u32x8 u32 -> u32\nv get p0 p1\nret v\nend', 'g'));
  assert.match(get8, /andi t1, a1, 7\n\tslli t1, t1, 2/);
  // An aggregate result goes through the pointer in a0; the parameter shifts to a1.
  const pair = emitRiscv64Function(
    fn('fn p u32 -> (u32,bool)\nc lt p0 1\nr rec p0 c\nret r\nend', 'p'),
  );
  assert.match(pair, /sd a0, (\d+)\(sp\)[\s\S]*sltiu a0, a1, 1[\s\S]*ld t3, \1\(sp\)/);
  // Fold: loop-invariant literals hoisted before the loop; the inlined body writes the state
  // register directly (no copy per trip); a leaf keeps no frame.
  const loop = emitRiscv64Function(
    fn(
      'fn step u32 u32 u32 -> u32\na xor p0 p2\nb mul a 2654435761\nc add b p1\nret c\nend\nfn l u32 u32 -> u32\nr fold step 64 p0 p1\nret r\nend',
      'l',
    ),
  );
  assert.match(
    loop,
    /li (\w+), 64\n\tli (\w+), -1640531535\n\.\w+:\n\tbgeu \w+, \1, [\s\S]*mulw (\w+), \3, \2\n\taddw a0, \3, /,
  );
  assert.doesNotMatch(loop, /\bmv\b|sp, sp|\bra\b/);
  // A residual call saves ra only (no frame pointer).
  const big = Array.from({ length: 50 }, (_, k) => `x${k} add p0 ${k + 1}`).join('\n');
  const caller = emitRiscv64Function(
    fn(`fn big u32 -> u32\n${big}\nret x49\nend\nfn c u32 -> u32\nr call big p0\nret r\nend`, 'c'),
  );
  assert.match(caller, /^a0_c:\n\taddi sp, sp, -16\n\tsd ra, 8\(sp\)\n/m);
  assert.match(caller, /ld ra, 8\(sp\)\n\taddi sp, sp, 16\n\tret$/m);
  assert.doesNotMatch(caller, /\bs0\b|\bmv\b/);
  // Swapped register arguments: one parallel move with the cycle broken through t0.
  const swap = emitRiscv64Function(
    fn(
      `fn big u32 u32 -> u32\n${big}\nx50 add x49 p1\nret x50\nend\nfn w u32 u32 -> u32\nr call big p1 p0\nret r\nend`,
      'w',
    ),
  );
  assert.match(swap, /mv t0, (a[01])\n\tmv \1, (a[01])\n\tmv \2, t0\n\tcall a0_big/);
  // Rotates: plain RV64GC by default; roriw/rolw only when Zbb is declared.
  const rot = fn(
    'fn r u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\ns shr p0 n\no or l s\na shl o 13\nb shr o 19\nc or b a\nret c\nend',
    'r',
  );
  assert.doesNotMatch(emitRiscv64Function(rot), /ro[lr]i?w|zbb/);
  const zbb = emitRiscv64Function(rot, { zbb: true });
  assert.match(zbb, /^\t\.option arch, \+zbb$/m);
  assert.match(zbb, /rolw a0, a0, a1\n\troriw a0, a0, 19\n\tret/);
  assert.doesNotMatch(zbb, /sllw|srlw|slliw|srliw|subw/);
});

const X86_64_HOST = (() => {
  if (process.arch === 'x64' && (process.platform === 'darwin' || process.platform === 'linux'))
    return { arch: [] as string[], runner: [] as string[] };
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return undefined;
  if (spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true']).status !== 0) return undefined;
  return { arch: ['-arch', 'x86_64'], runner: ['/usr/bin/arch', '-x86_64'] };
})();

test('x86_64 backend: assembled, linked with a C driver, and executed equal to the interpreter', {
  skip: X86_64_HOST === undefined ? 'needs an x86-64 host or Rosetta 2 on Apple silicon' : false,
}, async () => {
  const { findClang, runTool, withTempDir } = await import('../src/toolchain.js');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const host = X86_64_HOST as { arch: string[]; runner: string[] };
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  const zeros = Array.from({ length: 1024 }, () => '0').join(' ');
  const src = [
    'fn step u32x8 u32 u32 -> u32x8\na get p0 p1\nb add a p2\nc mul b 3\nn set p0 p1 c\nret n\nend',
    // twelve parameters: scalars past r9 travel on the stack, one eightbyte each
    'fn many u32 u32 u32 u32 u32 u32 u32 u32 bool u32 bool u32 -> u32\na add p0 p1\nb sub a p2\nc mul b p3\nd xor c p4\ne shl d p5\nf shr e p6\ng div f p7\nh rem g p9\ni select p8 h p11\nj select p10 i p9\nk add j p11\nret k\nend',
    'fn pair u32 u32 -> (u32,bool)\nc lt p0 p1\nr rec p0 c\nret r\nend',
    'fn keep u32 u32 -> bool\nb lt p0 1000\nret b\nend',
    'fn grow u32 u32 -> u32\nb mul p0 3\nc add b p1\nret c\nend',
    'fn top u32 u32 bool -> u32\nk and p1 15\nz arr p0 p1 1 2 3 4 5 6\nf fold step k z p0\ng get f p1\nr call pair p0 p1\nh at r 0\ns loop keep grow p1 h\nt put r 0 s\nu at t 1\nt0 at t 0\nm call many p0 p1 g t0 p0 p1 g s u p0 p2 t0\nq ge m g\nw select q m g\nx div w p1\ny rem p0 p1\nv add x y\nret v\nend',
    // a 4 KiB array: 16-byte copy and fill loops, an rcx parameter, and a page-probed frame
    'fn poke u32x1024 u32 u32 -> u32x1024\nn set p0 p2 p1\nret n\nend',
    `fn bigtop u32 u32 -> u32\nz arr ${zeros}\nk and p1 7\nf fold poke k z p0\na get f p1\nb get f 3\nc add a b\nret c\nend`,
    // instruction selection: variable rotl/rotr, a literal rotate written with add, bit tests
    // and fused compares feeding selects (literal operands), lea/shift multipliers, sub from a
    // literal, a variable trip count that may be zero, a non-zero fill, edx/ecx leaf homes
    'fn rs u32 u32 u32 -> u32\na mul p0 5\nb add a p1\nc xor b p2\nret c\nend',
    'fn gtb u32 u32 -> bool\nc gt p0 p1\nret c\nend',
    'fn sel u32 u32 u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nh shr p0 n\no or l h\nl2 shr p2 p3\nn2 sub 64 p3\nh2 shl p2 n2\no2 or h2 l2\nk1 shl p1 7\nk2 shr p1 25\no3 add k1 k2\nm and p0 8\nc1 eq m 0\ns1 select c1 o o2\nm2 and p1 1\nc2 ne m2 1\ns2 select c2 s1 o3\nc3 lt p2 p3\ns3 select c3 7 s2\ns4 select c3 s3 9\nd sub 100 s4\ne mul d 9\nf mul e 4\ng mul f 3\nk and p3 3\nq fold rs k g p0\nz arr 5 5 5 5 5 5 5 5 5 5\nzz get z q\nb call gtb q zz\nc4 lt 50 p0\nw select b q zz\nx select c4 w p1\ny mul x 2\nret y\nend',
  ].join('\n\n');
  const p = parseAndValidate(src);
  const inputs: [number, number, boolean][] = [
    [0, 0, false],
    [1, 2, true],
    [7, 13, false],
    [0xffffffff, 5, true],
    [123456, 0xfffffff0, true],
    [999, 3, false],
  ];
  const top = p.byName.get('top') as TypedFunc;
  const bigtop = p.byName.get('bigtop') as TypedFunc;
  const sel = p.byName.get('sel') as TypedFunc;
  const selArgs = (a: number, b: number): number[] => [a, b, (a ^ b) >>> 0, (b + 7) >>> 0];
  const expected = inputs
    .flatMap(([a, b, c]) => [
      String(run(top, [a, b, c])),
      String(run(bigtop, [a, b])),
      String(run(sel, selArgs(a, b))),
    ])
    .join('\n');
  const selCall = (a: number, b: number): string =>
    `a0_sel(${selArgs(a, b)
      .map((v) => `${v}u`)
      .join(', ')})`;
  const calls = inputs
    .map(
      ([a, b, c]) =>
        `  printf("%u\\n%u\\n%u\\n", a0_top(${a}u, ${b}u, ${c}), a0_bigtop(${a}u, ${b}u), ${selCall(a, b)});`,
    )
    .join('\n');
  const driver = `#include <stdint.h>\n#include <stdbool.h>\n#include <stdio.h>\nextern uint32_t a0_top(uint32_t, uint32_t, bool);\nextern uint32_t a0_bigtop(uint32_t, uint32_t);\nextern uint32_t a0_sel(uint32_t, uint32_t, uint32_t, uint32_t);\nint main(void) {\n${calls}\n  return 0;\n}\n`;
  for (const optimize of [true, false]) {
    const asm = compile(p, 'x86_64', { optimize }).text;
    assert.doesNotMatch(asm, /#include|int main/);
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'module.s'), asm, 'utf8');
      await writeFile(join(dir, 'driver.c'), driver, 'utf8');
      const as = runTool(
        clang,
        [...host.arch, '-c', '-x', 'assembler', '-o', 'module.o', 'module.s'],
        { cwd: dir },
      );
      assert.ok(as.ok, as.stderr);
      const ld = runTool(clang, [...host.arch, '-O1', '-o', 'driver', 'driver.c', 'module.o'], {
        cwd: dir,
      });
      assert.ok(ld.ok, ld.stderr);
      const [cmd, ...pre] =
        host.runner.length === 0 ? [join(dir, 'driver')] : [...host.runner, join(dir, 'driver')];
      const exec = runTool(cmd as string, pre, { cwd: dir });
      assert.ok(exec.ok, exec.stderr);
      assert.equal(exec.stdout.trim(), expected);
    });
  }
});

test('avr backend refuses io and what the ATmega328P cannot hold, with diagnostics', () => {
  const refused = (src: string, code: string, pattern: RegExp): void => {
    assert.throws(
      () => compile(parseAndValidate(src), 'avr', { optimize: false }),
      (e: unknown) => e instanceof A0Error && e.code === code && pattern.test(e.message),
    );
  };
  refused(
    'fn w io u32 -> io\nt write p0 p1\nret t\nend',
    'structure',
    /io functions are out of scope/,
  );
  refused('fn g u32x64 u32 -> u32\nv get p0 p1\nret v\nend', 'limit', /256-byte aggregate/);
  const zeros = Array.from({ length: 60 }, () => '0').join(' ');
  const nodes = Array.from({ length: 5 }, (_, k) => `a${k} arr ${zeros}`).join('\n');
  refused(`fn f u32 -> u32\n${nodes}\nret p0\nend`, 'limit', /-byte frame; the limit is 1024/);
  // Parameters past the 18 argument registers go on the stack (avr-gcc's convention).
  assert.doesNotThrow(() =>
    compile(parseAndValidate('fn m u32 u32 u32 u32 u32 -> u32\nret p4\nend'), 'avr'),
  );
});

test('avr backend: register allocation and peepholes keep the exact semantics', async () => {
  const { assembleAvr, emitAvrFunction } = await import('../src/avr.js');
  const fn = (src: string, name: string): TypedFunc =>
    parseAndValidate(src).byName.get(name) as TypedFunc;
  const body = (asm: string): string =>
    asm
      .split('\n')
      .filter((l) => !/^\t\.|:$/.test(l))
      .join('\n');
  // avr-gcc convention: p0 arrives in r22-r25, p1 in r18-r21, the result leaves in r22-r25;
  // the sum is computed where p0 arrived: no frame, no saved register, no move.
  const add = emitAvrFunction(fn('fn a u32 u32 -> u32\nb add p0 p1\nret b\nend', 'a'));
  assert.match(add, /^\t\.globl a0_a$/m);
  assert.equal(body(add), '\tadd r22, r18\n\tadc r23, r19\n\tadc r24, r20\n\tadc r25, r21\n\tret');
  // Unsigned compare over the carry chain (gt swaps operands); the bool comes from the carry.
  const gt = emitAvrFunction(fn('fn g u32 u32 -> bool\nc gt p0 p1\nret c\nend', 'g'));
  assert.equal(
    body(gt),
    '\tcp r18, r22\n\tcpc r19, r23\n\tcpc r20, r24\n\tcpc r21, r25\n\tmov r24, r1\n\trol r24\n\tret',
  );
  // A compare feeding a select is fused into its branch; a literal operand uses cpi and r1.
  const clamp = emitAvrFunction(
    fn('fn c u32 -> u32\nk lt p0 1000\nr select k p0 1000\nret r\nend', 'c'),
  );
  assert.match(
    clamp,
    /cpi r22, 232\n\tldi r27, 3\n\tcpc r23, r27\n\tcpc r24, r1\n\tcpc r25, r1\n\tbrlo/,
  );
  assert.doesNotMatch(clamp, /rol|inc/);
  // A literal shift distance is masked to five bits: 33 is one bit; 9 is a byte move and a
  // bit over the three live bytes, and the shifted-in byte is known zero.
  const sh = emitAvrFunction(fn('fn s u32 -> u32\na shl p0 33\nb shr a 9\nret b\nend', 's'));
  assert.match(sh, /lsl r22\n\trol r23\n\trol r24\n\trol r25\n\tmov r22, r23/);
  assert.match(sh, /mov r24, r25\n\tlsr r24\n\tror r23\n\tror r22\n\tmov r25, r1\n\tret/);
  // An `and` with a single bit tested against zero is bst/brtc on that bit.
  const bit = emitAvrFunction(
    fn('fn t u32 u32 -> u32\na and p0 1024\nz eq a 0\nr select z p1 p0\nret r\nend', 't'),
  );
  assert.match(bit, /bst r23, 2\n\tbrts/);
  // mul uses the hardware multiplier; div/rem share one helper; a variable shift is an inline
  // loop; a power-of-two multiplier is a shift. Helpers are emitted once, when referenced.
  const helpers = emitAvrFunction(
    fn(
      'fn h u32 u32 -> u32\na div p0 p1\nb rem a p1\nc mul b p0\nd shl c p1\ne mul d 8\nret e\nend',
      'h',
    ),
  );
  const module = assembleAvr([helpers], 'test');
  for (const h of ['__a0_udivmod32', '__a0_mul32'])
    assert.equal(module.match(new RegExp(`^${h}:$`, 'gm'))?.length, 1, h);
  assert.equal(module.match(/call __a0_mul32/g)?.length, 1);
  assert.match(module, /__a0_mul32:\n\tmul r22, r21/);
  assert.match(helpers, /andi r26, 31\n\tbreq/);
  assert.match(helpers, /dec r26\n\tbrne/);
  assert.match(module, /call __a0_udivmod32\n\tmovw r22, r26\n\tmovw r24, r30/);
  // An aggregate parameter is read in place through its pointer; an aggregate result goes
  // through the hidden pointer in r24:r25, written last.
  const rec = emitAvrFunction(fn('fn q (u32,bool) -> u32\na at p0 0\nret a\nend', 'q'));
  assert.equal(
    body(rec),
    '\tmovw r30, r24\n\tldd r22, Z+0\n\tldd r23, Z+1\n\tldd r24, Z+2\n\tldd r25, Z+3\n\tret',
  );
  const pair = emitAvrFunction(
    fn('fn p u32 -> (u32,bool)\nc lt p0 1\nr rec p0 c\nm mov r\nret m\nend', 'p'),
  );
  assert.match(pair, /cpi r20, 1\n/);
  assert.match(pair, /movw r26, r28\n\tadiw r26, 1\n\tmovw r30, r24\n/);
  // Stack arguments: the caller pushes the last byte first and pops after the call; the callee
  // reads them above its saved registers and return address.
  const stack = assembleAvr(
    [
      emitAvrFunction(
        fn('fn w u32 u32 u32 u32 u32 bool -> u32\na add p4 p0\ns select p5 a p1\nret s\nend', 'w'),
      ),
      emitAvrFunction(
        fn(
          'fn w u32 u32 u32 u32 u32 bool -> u32\na add p4 p0\ns select p5 a p1\nret s\nend\nfn c u32 -> u32\nr call w p0 p0 p0 p0 p0 true\nret r\nend',
          'c',
        ),
        { inline: false },
      ),
    ],
    'test',
  );
  assert.match(stack, /in r28, 0x3d\n\tin r29, 0x3e\n\tldd r2, Y\+10\n/);
  assert.match(stack, /ldi r26, 1\n\tpush r26\n\tpush r25\n\tpush r24\n\tpush r23\n\tpush r22\n/);
  assert.match(stack, /call a0_w\n\tpop r0\n\tpop r0\n\tpop r0\n\tpop r0\n\tpop r0\n/);
  // Out of line, fold state and counter stay in callee-saved registers across the body calls.
  const foldSrc =
    'fn st u32 u32 -> u32\na add p0 p1\nret a\nend\nfn f u32 -> u32\nr fold st p0 0\nret r\nend';
  const fold = emitAvrFunction(fn(foldSrc, 'f'), { inline: false });
  assert.doesNotMatch(fold, /ldd|std/);
  assert.match(fold, /call a0_st\n\tmovw r6, r22\n\tmovw r8, r24\n\tsec\n\tadc r10, r1/);
  // Inlined, the body adds the counter into the state in place (the body result takes the
  // state's registers).
  const foldIn = emitAvrFunction(fn(foldSrc, 'f'));
  assert.doesNotMatch(foldIn, /call/);
  assert.match(foldIn, /:\n\tadd r18, r2\n\tadc r19, r3\n\tadc r20, r4\n\tadc r21, r5\n\tsec\n/);
  // A literal trip count below 256 keeps the counter in one byte, the first test skipped.
  const byteCount = emitAvrFunction(
    fn(
      'fn ps u32 u32 u32 -> u32\ns shr p2 p1\nb and s 1\nr add p0 b\nret r\nend\nfn pc u32 -> u32\nr fold ps 32 0 p0\nret r\nend',
      'pc',
    ),
  );
  assert.doesNotMatch(byteCount, /call|rjmp/);
  assert.match(byteCount, /inc (r\d+)\n\S+:\n\tcpi \1, 32\n\tbrlo/);
  // A small callee is spliced into its caller; a larger one called twice stays a call.
  const calls = emitAvrFunction(
    fn(
      'fn sm u32 u32 -> u32\na xor p0 p1\nret a\nend\nfn big u32 u32 -> u32\na mul p0 p1\nb div a p0\nc rem b p1\nd add c p0\nret d\nend\nfn k u32 -> u32\na call sm p0 7\nb call big a p0\nc call big b a\nret c\nend',
      'k',
    ),
  );
  assert.doesNotMatch(calls, /call a0_sm/);
  assert.equal(calls.match(/call a0_big/g)?.length, 2);
  // Spills past Y+63 are staged through a reload area near Y.
  const many = Array.from({ length: 24 }, (_, k) => `v${k} mul p0 ${k + 3}`).join('\n');
  const sum = Array.from(
    { length: 23 },
    (_, k) => `s${k} add ${k === 0 ? 'v0' : `s${k - 1}`} v${k + 1}`,
  ).join('\n');
  const far = emitAvrFunction(fn(`fn f u32 -> u32\n${many}\n${sum}\nret s22\nend`, 'f'));
  assert.match(
    far,
    /movw r30, r28\n\tsubi r30, \d+\n\tsbci r31, 255\n\tldd r0, Z\+0\n\tstd Y\+\d+, r0/,
  );
});

test('avr backend: assembled, linked with an avr-gcc driver, and run under simavr equal to the interpreter', async (t) => {
  const { checkAvr } = await import('../tools/verify.js');
  const { findAvrGcc, findClang, findSimavr } = await import('../src/toolchain.js');
  const avrGcc = findAvrGcc();
  if (avrGcc.path === undefined || findSimavr().prefix === undefined) {
    t.skip('needs avr-gcc and libsimavr (brew install avr-gcc avr-binutils simavr)');
    return;
  }
  const src = [
    'fn step u32x8 u32 u32 -> u32x8\na get p0 p1\nb add a p2\nc mul b 3\nn set p0 p1 c\nret n\nend',
    // 18 argument bytes: the last reaches r8, so a caller saves r8-r17 around its calls
    'fn many u32 u32 u32 u32 bool -> u32\na add p0 p1\nb sub a p2\nc mul b p3\nd div c p1\ne rem p3 p2\nf select p4 d e\ng shr f p1\nh shl g p2\nret h\nend',
    'fn pair u32 u32 -> (u32,bool)\nc lt p0 p1\nr rec p0 c\nret r\nend',
    'fn keep u32 u32 -> bool\nb lt p0 1000\nret b\nend',
    'fn grow u32 u32 -> u32\nb mul p0 3\nc add b p1\nret c\nend',
    'fn five u32x5 u32 u32 -> u32x5\nv get p0 p1\nw xor v p2\nn set p0 p2 w\nret n\nend',
    `fn top u32 u32 bool -> u32\nk and p1 15\nz arr p0 p1 1 2 3 4 5 6\nf fold step k z p0\ng get f p1\nr call pair p0 p1\nh at r 0\ns loop keep grow p1 h\nt put r 0 s\nu at t 1\nt0 at t 0\nm call many p0 p1 g t0 u\nq ge m g\nw select q m g\nx div w p1\ny rem p0 p1\nv add x y\nb arr ${Array.from({ length: 20 }, () => 'v').join(' ')}\nb2 set b p0 x\nb3 get b2 p1\nfv arr p0 p1 3 4 5\nff fold five 7 fv p1\nf5 get ff p0\nbb arr p2 q p2 q\nbi get bb p0\no select bi b3 f5\nret o\nend`,
    // Stack arguments both ways (C driver to A0, A0 to A0), a bool after the spill.
    'fn wide u32 u32 u32 u32 u32 bool u32 -> u32\na add p0 p4\nb xor a p6\nc select p5 b p1\nd sub c p3\ne mul d p2\nret e\nend',
    'fn wide_call u32 u32 bool -> u32\nx call wide p0 p1 p0 p1 p0 p2 p1\ny call wide x p0 x p1 x p2 x\nz add x y\nret z\nend',
    // An in-place aggregate parameter on the stack, and one passed on at an offset.
    'fn agg_last u32 u32 u32 u32 bool u32x3 -> u32\nv get p5 p1\nw add v p2\ns select p4 w p3\nret s\nend',
    'fn pick3 u32x3 u32 -> u32\nv get p0 p1\nret v\nend',
    'fn nest (u32,u32x3,bool) u32 -> u32\na at p0 1\nv call pick3 a p1\nb at p0 2\nc at p0 0\nd select b v c\nret d\nend',
    'fn agg_call u32 u32 bool -> u32\na arr p0 p1 7\nr call agg_last p0 p1 p0 p1 p2 a\nf lt p0 p1\nq rec p0 a f\nv call nest q p1\ns add r v\nret s\nend',
    // Fold state with stack-argument extras; bit tests; high bytes known zero.
    'fn wstep u32 u32 u32 u32 u32 u32 -> u32\na add p0 p1\nb xor a p2\nc add b p3\nd sub c p4\ne add d p5\nret e\nend',
    'fn bits u32 u32 -> u32\nf fold wstep 9 p0 p1 p0 p1 p0\na and f 128\nz eq a 0\ns select z p1 f\nb and p1 65536\ny ne b 0\nt select y s 77\nu shr t 24\nv shl u 3\nw or v p1\nret w\nend',
    // Inlined bodies: a bit-tested select as the state update, a compare predicate fused into
    // the loop's branch, a variable-count fold with an extra, and inlined call sites.
    'fn crcs u32 u32 -> u32\nb and p0 1\ns shr p0 1\nx xor s 3988292384\nz eq b 0\nr select z s x\nret r\nend',
    'fn dkeep u32 u32 u32 -> bool\nk lt p1 p2\nn ne p0 0\na and k n\nret a\nend',
    'fn dstep u32 u32 u32 -> u32\nd div p0 10\ne add d p1\nret e\nend',
    'fn ps u32 u32 u32 -> u32\ns shr p2 p1\nb and s 1\nr add p0 b\nret r\nend',
    'fn mix u32 u32 u32 -> u32\na add p0 p1\nb xor a p2\nret b\nend',
    'fn dz u32 u32 u32 -> bool\nk ne p0 0\nret k\nend',
    'fn inl u32 u32 -> u32\nx xor p0 p1\nc fold crcs 8 x\nd0 loop dkeep dstep 12 p0 p1\nd loop dz dstep 10 d0 p0\nk and p1 31\ne fold ps k c p0\nm call mix e d c\nn call mix m p0 d\nr add m n\nret r\nend',
  ].join('\n\n');
  const p = parseAndValidate(src);
  const fnOf = (name: string): TypedFunc => p.byName.get(name) as TypedFunc;
  const inputs: [number, number, boolean][] = [
    [0, 0, false],
    [1, 2, true],
    [7, 13, false],
    [0xffffffff, 5, true],
    [123456, 0xfffffff0, true],
    [999, 3, false],
  ];
  const cases = inputs.flatMap(([a, b, c]) =>
    (
      [
        ['top', [a, b, c]],
        ['many', [a, b, (a ^ b) >>> 0, b, c]],
        ['wide', [a, b, 3, (a + 7) >>> 0, (b ^ 5) >>> 0, c, a]],
        ['wide_call', [a, b, c]],
        ['agg_call', [a, b, c]],
        ['bits', [a, b]],
        ['inl', [a, b]],
      ] as [string, (number | boolean)[]][]
    ).map(([name, args]) => ({ functionName: name, args, expected: run(fnOf(name), args) })),
  );
  const report = await checkAvr(p, cases, avrGcc, findClang());
  assert.equal(report.status, 'passed', JSON.stringify(report.failures ?? report.detail));
  assert.equal(report.cases, cases.length);
});

test('arm32 backend refuses io functions with a diagnostic', () => {
  const p = parseAndValidate('fn w io u32 -> io\nt write p0 p1\nret t\nend');
  assert.throws(
    () => compile(p, 'arm32'),
    (e: unknown) => e instanceof A0Error && /io functions are out of scope/.test(e.message),
  );
});

test('arm32 backend: emitted sequences carry the exact semantics', async () => {
  const { emitArm32Function, isArmImm } = await import('../src/arm32.js');
  const fn = (src: string, name: string): TypedFunc =>
    parseAndValidate(src).byName.get(name) as TypedFunc;
  // A32 modified immediates: an 8-bit value rotated right by an even amount.
  assert.ok(isArmImm(255) && isArmImm(0xff000000) && isArmImm(0xf000000f) && isArmImm(1020));
  assert.ok(!isArmImm(257) && !isArmImm(0x1fe00001) && !isArmImm(4095));
  // A scalar leaf keeps its first two parameters in r0/r1 (r12, r3, r2 are its scratch) and
  // has no frame at all.
  const affine = fn('fn affine u32 u32 -> u32\na mul p0 3\nb add a p1\nret b\nend', 'affine');
  const s = emitArm32Function(affine);
  assert.match(s, /^\t\.globl a0_affine\n\t\.type a0_affine, %function$/m);
  assert.match(s, /a0_affine:\n\tmov r3, #3\n\tmul r0, r0, r3\n\tadd r0, r0, r1\n\tbx lr\n/);
  // Division: no UDIV on baseline ARMv7-A, so the module's own routine runs; it gives all ones
  // for a zero divisor and the dividend as the remainder. A caller moves its parameters to
  // callee-saved homes (r4-r11, no frame pointer) and pushes lr with them.
  const div = parseAndValidate(
    'fn d u32 u32 -> u32\nq div p0 p1\nr rem p0 p1\nx xor q r\nret x\nend',
  );
  const mod = compile(div, 'arm32').text;
  assert.match(mod, /a0_d:\n\tpush \{r4, r5, r6, lr\}\n\tmov r4, r0\n\tmov r5, r1/);
  assert.match(mod, /mov r0, r\d+\n\tpop \{r4, r5, r6, pc\}$/m);
  assert.doesNotMatch(mod, /\budiv\b|r11/);
  assert.match(mod, /mov r0, r4\n\tmov r1, r5\n\tbl \.La0_udivmod\n\tmov r\d+, r0/);
  assert.match(mod, /bl \.La0_udivmod\n\tmov r\d+, r1/);
  assert.match(mod, /\.La0_udivmod:\n\tcmp r1, #0\n\tmoveq r1, r0\n\tmvneq r0, #0\n\tbxeq lr/);
  assert.match(
    mod,
    /adds r0, r0, r0\n\tadc r2, r2, r2\n\tcmp r2, r1\n\tsubcs r2, r2, r1\n\torrcs r0, r0, #1/,
  );
  assert.match(mod, /\.eabi_attribute Tag_ABI_VFP_args, 1/);
  // The routine is only emitted when something divides.
  assert.doesNotMatch(
    compile(parseAndValidate('fn a u32 -> u32\nb add p0 1\nret b\nend'), 'arm32').text,
    /udivmod/,
  );
  // Shifts: a literal distance is masked at compile time, a variable one to five bits (a
  // register shift would use the whole low byte).
  const shl = emitArm32Function(
    fn('fn s u32 u32 -> u32\na shl p0 33\nb shr a p1\nret b\nend', 's'),
  );
  assert.match(shl, /lsl r0, r0, #1\n\tand r2, r1, #31\n\tlsr r0, r0, r2\n\tbx lr/);
  // Unsigned comparison and a predicated select, no branch; the arm already in the result
  // register needs no move.
  const sel = emitArm32Function(
    fn('fn m u32 u32 -> u32\nc lt p0 p1\nr select c p0 p1\nret r\nend', 'm'),
  );
  assert.match(sel, /cmp r0, r1\n\tmov (r\d+), #0\n\tmovlo \1, #1\n\tcmp \1, #0\n\tmoveq r0, r1\n/);
  // Index modulo the length: a power of two is a bit-field extract, another length divides;
  // the element is addressed with a scaled register offset.
  const get8 = emitArm32Function(fn('fn g u32x8 u32 -> u32\nv get p0 p1\nret v\nend', 'g'));
  assert.match(get8, /ubfx r0, r4, #0, #3\n\tldr r\d+, \[sp, r0, lsl #2\]/);
  const get5 = emitArm32Function(fn('fn g u32x5 u32 -> u32\nv get p0 p1\nret v\nend', 'g'));
  assert.match(get5, /mov r1, #5\n\tbl \.La0_udivmod\n\tmov r0, r1/);
  // ARMv7VE (opt-in): udiv/mls; a zero divisor gives quotient 0 and so remainder = dividend
  // through mls, and the quotient is set to all ones under a comparison made before udiv.
  const veDiv = emitArm32Function(div.byName.get('d') as TypedFunc, { udiv: true });
  assert.match(veDiv, /cmp r1, #0\n\tudiv (r\d+), r0, r1\n\tmvneq \1, #0/);
  assert.match(veDiv, /udiv (r\d+), r0, r1\n\tmls r0, \1, r1, r0/);
  assert.doesNotMatch(veDiv, /udivmod/);
  const veGet5 = emitArm32Function(fn('fn g u32x5 u32 -> u32\nv get p0 p1\nret v\nend', 'g'), {
    udiv: true,
  });
  assert.match(veGet5, /mov r1, #5\n\tudiv r3, r4, r1\n\tmls r0, r3, r1, r4/);
  const { assembleArm32 } = await import('../src/arm32.js');
  assert.match(assembleArm32([veDiv], 'v', { udiv: true }), /\.arch armv7ve\n/);
  assert.match(compile(div, 'arm32').text, /\.arch armv7-a\n/);
  // Rotates: complementary literal shifts, or a distance and `sub 32 distance`, are one ror.
  const rotk = emitArm32Function(
    fn('fn r u32 -> u32\na shl p0 5\nb shr p0 27\no or a b\nret o\nend', 'r'),
  );
  assert.match(rotk, /a0_r:\n\tror r0, r0, #27\n\tbx lr\n/);
  const rotv = emitArm32Function(
    fn('fn r u32 u32 -> u32\na shl p0 p1\nn sub 32 p1\nb shr p0 n\no or b a\nret o\nend', 'r'),
  );
  assert.match(rotv, /a0_r:\n\trsb r1, r1, #32\n\tror r0, r0, r1\n\tbx lr\n/);
  // A loop: rotated (test at the bottom), a movw/movt constant hoisted before it, and the
  // body's result written straight into the state register.
  const hoist = emitArm32Function(
    parseAndValidate(
      'fn st u32 u32 -> u32\na mul p0 305419896\nb add a p1\nret b\nend\nfn h u32 u32 -> u32\nr fold st p1 p0\nret r\nend',
    ).byName.get('h') as TypedFunc,
  );
  assert.match(
    hoist,
    /movw (r\d+), #22136\n\tmovt \1, #4660\n\tb (\.La0_h_\d+)\n(\.La0_h_\d+):\n\tmul (r\d+), r0, \1\n\tadd r0, \4, (r\d+)\n\tadd \5, \5, #1\n\2:\n\tcmp \5, r1\n\tblo \3\n/,
  );
  // Stack parameters of a leaf load straight into their homes, above the pushed registers.
  const six = emitArm32Function(
    fn(
      'fn w u32 u32 u32 u32 u32 u32 -> u32\na add p0 p5\nb xor a p4\nc sub b p3\nd add c p2\ne add d p1\nret e\nend',
      'w',
    ),
  );
  assert.match(
    six,
    /push \{r4, r5, r6, r7, r12, lr\}\n\tmov r4, r2\n\tmov r5, r3\n\tldr r6, \[sp, #24\]\n\tldr r7, \[sp, #28\]\n\tadd r0, r0, r7\n/,
  );
  // An aggregate result comes back through the hidden pointer in r0, kept in a slot.
  const pair = emitArm32Function(
    fn('fn p u32 -> (u32,bool)\nc lt p0 1\nr rec p0 c\nret r\nend', 'p'),
  );
  assert.match(pair, /str r0, \[sp, #(\d+)\]\n\tmov r4, r1[\s\S]*ldr r12, \[sp, #\1\]/);
  // Constants that are not modified immediates use movw/movt, or mvn for their complement.
  const k = emitArm32Function(
    fn('fn k u32 -> u32\na add p0 305419896\nb xor a 4294967040\nret b\nend', 'k'),
  );
  assert.match(k, /movw r3, #22136\n\tmovt r3, #4660/);
  assert.match(k, /mvn r3, #255\n\teor r0, r0, r3/);
  // Frames above a page are probed page by page, without touching the argument registers.
  const zeros = Array.from({ length: 2048 }, () => '0').join(' ');
  const probe = emitArm32Function(
    fn(`fn z u32 -> u32\na arr ${zeros}\nv get a p0\nret v\nend`, 'z'),
  );
  assert.match(probe, /sub sp, sp, #4096\n\tstr r12, \[sp\]\n\tsubs r12, r12, #1\n\tbne/);
});

const ARM32_TOOLS = await (async () => {
  const { findArmGcc, findQemuSystemArm } = await import('../src/toolchain.js');
  const gcc = findArmGcc().path;
  const qemu = findQemuSystemArm().path;
  return gcc === undefined || qemu === undefined ? undefined : { gcc, qemu };
})();

test('arm32 backend: assembled, linked with a C driver, and executed on an emulated Cortex-A7 equal to the interpreter', {
  skip:
    ARM32_TOOLS === undefined
      ? 'needs arm-none-eabi-gcc (Arm GNU Toolchain) and qemu-system-arm'
      : false,
}, async () => {
  const { withTempDir } = await import('../src/toolchain.js');
  const { runArm32 } = await import('../tools/verify.js');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const tools = ARM32_TOOLS as { gcc: string; qemu: string };
  const zeros = Array.from({ length: 1024 }, () => '0').join(' ');
  const src = [
    'fn step u32x8 u32 u32 -> u32x8\na get p0 p1\nb add a p2\nc mul b 3\nn set p0 p1 c\nret n\nend',
    // twelve parameters: scalars past r3 travel on the stack, one word each
    'fn many u32 u32 u32 u32 u32 u32 u32 u32 bool u32 bool u32 -> u32\na add p0 p1\nb sub a p2\nc mul b p3\nd xor c p4\ne shl d p5\nf shr e p6\ng div f p7\nh rem g p9\ni select p8 h p11\nj select p10 i p9\nk add j p11\nret k\nend',
    'fn pair u32 u32 -> (u32,bool)\nc lt p0 p1\nr rec p0 c\nret r\nend',
    'fn keep u32 u32 -> bool\nb lt p0 1000\nret b\nend',
    'fn grow u32 u32 -> u32\nb mul p0 3\nc add b p1\nret c\nend',
    'fn top u32 u32 bool -> u32\nk and p1 15\nz arr p0 p1 1 2 3 4 5 6\nf fold step k z p0\ng get f p1\nr call pair p0 p1\nh at r 0\ns loop keep grow p1 h\nt put r 0 s\nu at t 1\nt0 at t 0\nm call many p0 p1 g t0 p0 p1 g s u p0 p2 t0\nq ge m g\nw select q m g\nx div w p1\ny rem p0 p1\nv add x y\nret v\nend',
    // a 4 KiB array: word-copy loops, a page-probed frame, an index modulo a non-power of two
    'fn poke u32x1024 u32 u32 -> u32x1024\nn set p0 p2 p1\nret n\nend',
    `fn bigtop u32 u32 -> u32\nz arr ${zeros}\nk and p1 7\nf fold poke k z p0\na get f p1\nb get f 3\nc add a b\nx arr a b c\ny get x p0\nret y\nend`,
    // divisors and dividends at and above 2^31
    'fn dv u32 u32 -> u32\nq div p0 p1\nr rem p0 p1\ns mul q 65599\nt xor s r\nret t\nend',
    // rotates, a hoisted loop constant, a scalar leaf with stack parameters
    'fn rotv u32 u32 -> u32\na shl p0 p1\nn sub 32 p1\nb shr p0 n\no or b a\nret o\nend',
    'fn st u32 u32 -> u32\na mul p0 305419896\nb add a p1\nret b\nend',
    'fn six u32 u32 u32 u32 u32 u32 -> u32\na add p0 p5\nb xor a p4\nc sub b p3\nd add c p2\ne add d p1\nret e\nend',
    'fn ext u32 u32 -> u32\nr call rotv p0 p1\nk shl p0 5\nl shr p0 27\nm or k l\nj and p1 31\nf fold st j r\nx rem f p1\ns call six r m f x p0 p1\nret s\nend',
  ].join('\n\n');
  const p = parseAndValidate(src);
  const inputs: [number, number, boolean][] = [
    [0, 0, false],
    [1, 2, true],
    [7, 13, false],
    [0xffffffff, 5, true],
    [123456, 0xfffffff0, true],
    [999, 3, false],
    [0xffffffff, 0x80000001, true],
    [0xfffffffe, 0xffffffff, false],
    [0x80000000, 0x80000000, true],
  ];
  const top = p.byName.get('top') as TypedFunc;
  const bigtop = p.byName.get('bigtop') as TypedFunc;
  const dv = p.byName.get('dv') as TypedFunc;
  const ext = p.byName.get('ext') as TypedFunc;
  const six = p.byName.get('six') as TypedFunc;
  const expected = inputs
    .flatMap(([a, b, c]) =>
      [
        run(top, [a, b, c]),
        run(bigtop, [a, b]),
        run(dv, [a, b]),
        run(ext, [a, b]),
        run(six, [a, b, (a ^ b) >>> 0, 7, b, a]),
      ].map(String),
    )
    .join('\n');
  const calls = inputs
    .map(
      ([a, b, c]) =>
        `  printf("%u\\n%u\\n%u\\n%u\\n%u\\n", (unsigned)a0_top(${a}u, ${b}u, ${c}), (unsigned)a0_bigtop(${a}u, ${b}u), (unsigned)a0_dv(${a}u, ${b}u), (unsigned)a0_ext(${a}u, ${b}u), (unsigned)a0_six(${a}u, ${b}u, ${(a ^ b) >>> 0}u, 7u, ${b}u, ${a}u));`,
    )
    .join('\n');
  const driver = `#include <stdint.h>\n#include <stdbool.h>\n#include <stdio.h>\nextern uint32_t a0_top(uint32_t, uint32_t, bool);\nextern uint32_t a0_bigtop(uint32_t, uint32_t);\nextern uint32_t a0_dv(uint32_t, uint32_t);\nextern uint32_t a0_ext(uint32_t, uint32_t);\nextern uint32_t a0_six(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);\nint main(void) {\n${calls}\n  return 0;\n}\n`;
  const { assembleArm32, emitArm32Function } = await import('../src/arm32.js');
  // The default ARMv7-A emission, and the ARMv7VE (udiv) one: Cortex-A7 implements both.
  const builds = [true, false].flatMap((optimize) => [
    compile(p, 'arm32', { optimize }).text,
    assembleArm32(
      p.functions.map((f) =>
        emitArm32Function(optimize ? optimizeFunction(f).fn : f, { udiv: true }),
      ),
      'test',
      { udiv: true },
    ),
  ]);
  for (const asm of builds) {
    assert.doesNotMatch(asm, /#include|int main/);
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'module.s'), asm, 'utf8');
      await writeFile(join(dir, 'driver.c'), driver, 'utf8');
      const r = await runArm32(tools.gcc, tools.qemu, dir);
      assert.ok(r.result.ok, `${r.stage}: ${r.result.stderr}`);
      assert.equal(r.result.stdout.trim(), expected);
    });
  }
});

test('loop predicates with aggregate state are compared structurally, not by reference', () => {
  const p = parseAndValidate(
    'fn body u32x4 u32 -> u32x4\nv get p0 p1\nw add v 1\nn set p0 p1 w\nret n\nend\nfn pred u32x4 u32 -> bool\nv get p0 p1\nc lt v 10\nret c\nend\nfn go u32x4 -> u32x4\nr loop pred body 4 p0\nret r\nend',
  );
  const out = run(p.byName.get('go') as TypedFunc, [[1, 2, 30, 4]]) as number[];
  assert.deepEqual(Array.from(out), [2, 3, 30, 4]);
});

/** A self-hosted front-end table: `words` in `pages` pages of `size` (zero past the end). */
function pagesOf(words: readonly number[], size: number, pages: number): number[][] {
  return Array.from({ length: pages }, (_, i) =>
    Array.from({ length: size }, (_, k) => words[i * size + k] ?? 0),
  );
}

test('self-hosted lexer (compiler/lex.a0) agrees with a reference tokenizer on A0 sources', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const p = parseAndValidate(await readFile('compiler/lex.a0', 'utf8'));
  const lex = p.byName.get('lexsrc') as TypedFunc;
  // Reference: the same token grammar, written directly.
  const reference = (src: string): number[][] => {
    const out: number[][] = [];
    const b = Buffer.from(src);
    let i = 0;
    const word = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
    while (i < b.length) {
      const c = b[i] as number;
      if (c === 32 || c === 9 || c === 13) i += 1;
      else if (c === 10) {
        out.push([5, i, 1]);
        i += 1;
      } else if (c === 35) {
        while (i < b.length && b[i] !== 10) i += 1;
      } else if (word(c)) {
        const s = i;
        while (i < b.length && word(b[i] as number)) i += 1;
        out.push([c >= 48 && c <= 57 ? 2 : 1, s, i - s]);
      } else if (c === 34) {
        const s = i + 1;
        i += 1;
        while (i < b.length && b[i] !== 34) i += b[i] === 92 ? 2 : 1;
        if (i < b.length) out.push([3, s, i - s]);
        i += 1;
      } else if (c === 45 && b[i + 1] === 62) {
        out.push([4, i, 2]);
        i += 2;
      } else {
        out.push([c === 45 ? 6 : c === 64 ? 7 : 9, i, 1]);
        i += 1;
      }
    }
    return out;
  };
  const sources: string[] = [
    'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
    '# c\nfn f u32x4 -> (u32,bool)\nt text "a\\"b\\\\c"\n-a\nb add p0 1 @ a\ng0\n-fn f\n  x  mov 4294967295\t\r\n?',
    '- > ->-"x\\"y" "open',
  ];
  // whole files: the examples, the site's UI program and the lexer's own source
  for (const f of await readdir('examples'))
    if (f.endsWith('.a0')) sources.push(await readFile(`examples/${f}`, 'utf8'));
  sources.push(await readFile('site/ui.a0', 'utf8'));
  sources.push(await readFile('compiler/lex.a0', 'utf8'));
  for (const src of sources) {
    const bytes = [...Buffer.from(src)];
    assert.ok(bytes.length <= FRONT_END_SOURCE_LIMIT, src.slice(0, 40));
    const r = run(lex, [pagesOf(bytes, 128, 128), bytes.length]) as [number[][], number];
    const words = r[0].flat();
    const got: number[][] = [];
    for (let i = 0; i < r[1]; i += 3) got.push(words.slice(i, i + 3));
    assert.deepEqual(got, reference(src), src.slice(0, 40));
  }
});

test('self-hosted parser (compiler/parse.a0) word IR agrees with parse() on every example function', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const parser = (await link('compiler/parse.a0', (p) => readFile(p, 'utf8'))).program;
  const parseio = parser.byName.get('parseio') as TypedFunc;
  /** The io words of `parseio` back into tables. */
  const decode = (w: readonly number[]): WordIr => {
    let i = 2;
    const table = (): number[] => {
      const n = w[i] as number;
      i += 1 + n;
      return w.slice(i - n, i);
    };
    const [pool, sym, types, tlist, fns, nodes, args, uses] = [0, 1, 2, 3, 4, 5, 6, 7].map(table);
    return {
      code: w[0] as number,
      tok: w[1] as number,
      pool: pool as number[],
      sym: sym as number[],
      types: types as number[],
      tlist: tlist as number[],
      fns: fns as number[],
      nodes: nodes as number[],
      args: args as number[],
      uses: uses as number[],
    };
  };
  const a0Parse = (src: string): WordIr => {
    const io = makeIo([Buffer.byteLength(src), ...Buffer.from(src)]);
    assert.equal(run(parseio, [io]), 0, src.slice(0, 40));
    return decode(io.output);
  };
  /** Compare the word IR with the TypeScript parser's view of the same source. */
  const check = (ir: WordIr, src: string, label: string): void => {
    assert.equal(ir.code, 0, label);
    const program = parse(src);
    const symText = (s: number): string =>
      String.fromCharCode(
        ...ir.pool.slice(ir.sym[s * 2], (ir.sym[s * 2] as number) + (ir.sym[s * 2 + 1] as number)),
      );
    assert.equal(ir.fns.length / 7, program.functions.length, label);
    program.functions.forEach((fn, fi) => {
      const f = ir.fns.slice(fi * 7, fi * 7 + 7) as number[];
      const where = `${label} ${fn.name}`;
      assert.equal(symText(f[0] as number), fn.name, where);
      assert.equal(f[1], fn.params.length, where);
      assert.equal(f[5], fn.nodes.length, where);
      const operand = (o: Operand): [number, number] =>
        o.kind === 'node'
          ? [1, fn.nodes.findIndex((n) => n.id === o.id)]
          : o.kind === 'param'
            ? [2, o.index]
            : o.kind === 'u32'
              ? [3, o.value]
              : [4, o.value ? 1 : 0];
      fn.nodes.forEach((node, ni) => {
        const n = ir.nodes.slice(((f[4] as number) + ni) * 6, ((f[4] as number) + ni) * 6 + 6);
        const w = `${where}.${node.id}`;
        assert.equal(IR_OPS[(n[1] as number) - 1], node.text === undefined ? node.op : 'text', w);
        const got: number[][] = [];
        for (let k = 0; k < (n[2] as number); k += 1)
          got.push(ir.args.slice(((n[3] as number) + k) * 2, ((n[3] as number) + k) * 2 + 2));
        assert.deepEqual(got, node.args.map(operand), w);
        if (node.callee !== undefined)
          assert.equal(symText(ir.fns[(n[4] as number) * 7] as number), node.callee, w);
        if (node.pred !== undefined)
          assert.equal(symText(ir.fns[(n[5] as number) * 7] as number), node.pred, w);
      });
      const [rk, rv] = operand(fn.ret);
      assert.equal(f[6], rk * 2 ** 28 + rv, `${where} ret`);
    });
  };
  // whole files: every example, the site's UI program (text literals) and the lexer's source
  const files = (await readdir('examples'))
    .filter((f) => f.endsWith('.a0'))
    .sort()
    .map((f) => `examples/${f}`);
  files.push('site/ui.a0', 'compiler/lex.a0');
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    assert.ok(Buffer.byteLength(text) <= FRONT_END_SOURCE_LIMIT, f);
    check(refParse(text), text, `ref ${f}`);
    const ir = a0Parse(text);
    assert.deepEqual(ir, refParse(text), `a0 ${f}`);
    check(ir, text, `a0 ${f}`);
  }
  // nested array types: u32x4x2 is the array of 2 of u32x4
  const nested = a0Parse('fn f u32x4x2 u32x4 -> u32x4x2\nret p0\nend\n');
  assert.deepEqual(nested.types.slice(9), [4, 4, 0, 4, 2, 3]);
  // an unknown callee is a structure error at its token
  assert.deepEqual(a0ParseCode('fn f u32 -> u32\na call g p0\nret a\nend\n'), [2, 8]);
  function a0ParseCode(src: string): [number, number] {
    const io = makeIo([Buffer.byteLength(src), ...Buffer.from(src)]);
    const code = run(parseio, [io]) as number;
    return [code, io.output[1] as number];
  }
});

test('self-hosted checker (compiler/check.a0) agrees with validate() on the corpus, the examples, the compiler, and ill-typed programs', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const checker = (await link('compiler/check.a0', (p) => readFile(p, 'utf8'))).program;
  const check = checker.byName.get('checkir') as TypedFunc;
  const checkio = checker.byName.get('checkio') as TypedFunc;
  // the parser's tables: (page size, pages)
  const SHAPES = {
    types: [384, 65],
    tlist: [128, 65],
    fns: [128, 45],
    nodes: [128, 128],
    args: [128, 256],
    fstat: [128, 8],
  } as const;
  const words = (t: keyof typeof SHAPES): number => SHAPES[t][0] * SHAPES[t][1];
  const paged = (w: readonly number[], t: keyof typeof SHAPES): number[][] => {
    assert.ok(w.length <= words(t), `${t}: ${w.length} words`);
    return pagesOf(w, SHAPES[t][0], SHAPES[t][1]);
  };

  /** The word IR of a TypeScript Program: every header, the bodies of functions [from, to) only. */
  const encode = (fns: readonly Func[], from: number, to: number): IrTables => {
    const types = [1, 0, 0, 2, 0, 0, 3, 0, 0];
    const tlist: number[] = [];
    const intern = (t: Type): number => {
      if (t === 'u32') return 0;
      if (t === 'bool') return 1;
      if (t === 'io') return 2;
      if (t.kind === 'arr') {
        const elem = intern(t.elem);
        for (let i = 0; i < types.length / 3; i += 1) {
          if (types[i * 3] === 4 && types[i * 3 + 1] === t.length && types[i * 3 + 2] === elem)
            return i;
        }
        types.push(4, t.length, elem);
        return types.length / 3 - 1;
      }
      const fields = t.fields.map(intern);
      for (let i = 0; i < types.length / 3; i += 1) {
        if (types[i * 3] !== 5 || types[i * 3 + 2] !== fields.length) continue;
        const a = types[i * 3 + 1] as number;
        if (fields.every((f, k) => tlist[a + k] === f)) return i;
      }
      types.push(5, tlist.length, fields.length);
      tlist.push(...fields);
      return types.length / 3 - 1;
    };
    const table: number[] = [];
    const nodes: number[] = [];
    const args: number[] = [];
    fns.forEach((fn, fi) => {
      const params = fn.params.map(intern);
      const first = tlist.length;
      tlist.push(...params);
      const result = intern(fn.result);
      const operand = (o: Operand): [number, number] =>
        o.kind === 'node'
          ? [1, fn.nodes.findIndex((n) => n.id === o.id)]
          : o.kind === 'param'
            ? [2, o.index]
            : o.kind === 'u32'
              ? [3, o.value]
              : [4, o.value ? 1 : 0];
      const inChunk = fi >= from && fi < to;
      const firstNode = nodes.length / 6;
      if (inChunk) {
        for (const n of fn.nodes) {
          const callee = n.callee === undefined ? 0 : fns.findIndex((g) => g.name === n.callee);
          const pred = n.pred === undefined ? 0 : fns.findIndex((g) => g.name === n.pred);
          nodes.push(0, irOp(n.op), n.args.length, args.length / 2, callee, pred);
          for (const a of n.args) args.push(...operand(a));
        }
      }
      const [rk, rv] = operand(fn.ret);
      const count = inChunk ? fn.nodes.length : 0;
      table.push(0, params.length, first, result, firstNode, count, rk * 2 ** 28 + rv);
    });
    return { types, tlist, fns: table, nodes, args };
  };
  /** A type index of the checker's tables as a Type. */
  const decode = (types: readonly number[], tlist: readonly number[], t: number): Type => {
    const [tag, a, b] = [types[t * 3], types[t * 3 + 1], types[t * 3 + 2]] as [
      number,
      number,
      number,
    ];
    if (tag === 1) return 'u32';
    if (tag === 2) return 'bool';
    if (tag === 3) return 'io';
    if (tag === 4) return { kind: 'arr', length: a, elem: decode(types, tlist, b) };
    return { kind: 'rec', fields: tlist.slice(a, a + b).map((f) => decode(types, tlist, f)) };
  };
  /** (types tsig tlist tinfo ntys ncons pcons fstat ntypes ntlist err errfn errnode lit stat) */
  type State = [
    number[][],
    number[][],
    number[][],
    number[][],
    number[][],
    number[][],
    number[],
    number[][],
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  /** Every function of a program, in chunks that fit the tables (one for any program within the
   * front end's source limit), against validate() and refCheck. */
  const checkProgram = async (label: string, fns: readonly Func[]): Promise<number> => {
    const typed = validate({ functions: fns, uses: [] });
    let chunks = 0;
    let fstat: number[] = [];
    let from = 0;
    while (from < fns.length) {
      let to = from;
      let nn = 0;
      let na = 0;
      while (to < fns.length) {
        const fn = fns[to] as Func;
        const a = fn.nodes.reduce((n, x) => n + x.args.length, 0);
        if (to > from && (nn + fn.nodes.length > words('nodes') / 6 || na + a > words('args') / 2))
          break;
        nn += fn.nodes.length;
        na += a;
        to += 1;
      }
      const ir = encode(fns, from, to);
      const where = `${label}: functions ${from}..${to}`;
      chunks += 1;
      const ref = refCheck(ir, from, fstat, to);
      assert.equal(ref.code, 0, `${where} reference verdict`);
      const s = run(check, [
        paged(ir.types, 'types'),
        paged(ir.tlist, 'tlist'),
        paged(ir.fns, 'fns'),
        paged(ir.nodes, 'nodes'),
        paged(ir.args, 'args'),
        paged(fstat, 'fstat'),
        ir.types.length / 3,
        ir.tlist.length,
        to,
        from,
      ]) as State;
      assert.equal(s[10], 0, `${where} A0 verdict (${s[11]}, ${s[12]})`);
      const sfstat = s[7].flat();
      const stypes = s[0].flat();
      const stlist = s[2].flat();
      const sntys = s[4].flat();
      assert.deepEqual(sfstat.slice(0, to), ref.fstat.slice(0, to), `${where} iteration bounds`);
      for (let fi = from; fi < to; fi += 1) {
        const fn = typed.functions[fi] as TypedFunc;
        const firstNode = ir.fns[fi * 7 + 4] as number;
        fn.nodes.forEach((node, ni) => {
          const want = fn.types.get(node.id) as Type;
          const got = decode(stypes, stlist, sntys[firstNode + ni] as number);
          const w = `${label} ${fn.name}.${node.id}`;
          assert.ok(typeEquals(got, want), `${w}: ${formatType(got)} vs ${formatType(want)}`);
          const refGot = decode(ref.types, ref.tlist, ref.nodeTypes[firstNode + ni] as number);
          assert.ok(typeEquals(refGot, want), `${w}: reference ${formatType(refGot)}`);
        });
      }
      fstat = sfstat.slice(0, to);
      from = to;
    }
    return chunks;
  };
  // the corpus, the examples and the lexer each fit the tables whole (one chunk); the linked
  // parser and checker are larger than any source of 16384 bytes and are checked in chunks
  const corpus = parse(await readFile('results/corpus.a0', 'utf8')).functions;
  assert.equal(await checkProgram('corpus', corpus), 1, 'corpus in one chunk');
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort()) {
    const fns = parse(await readFile(`examples/${f}`, 'utf8')).functions;
    assert.equal(await checkProgram(f, fns), 1, `${f} in one chunk`);
  }
  const lexFns = (await link('compiler/lex.a0', (p) => readFile(p, 'utf8'))).program.functions;
  assert.equal(await checkProgram('compiler/lex.a0', lexFns), 1, 'lex.a0 in one chunk');
  for (const f of ['compiler/parse.a0', 'compiler/check.a0'])
    await checkProgram(f, (await link(f, (p) => readFile(p, 'utf8'))).program.functions);

  // Ill-typed programs through the whole A0 front (lex, parse, check): the diagnostic must be
  // validate()'s category at validate()'s function and node (the node count for `ret`, none for
  // a header). Programs the TypeScript parser already rejects (arity, an unknown node) are
  // compared by category only.
  const a0Check = (src: string): [number, number, number] => {
    const io = makeIo([Buffer.byteLength(src), ...Buffer.from(src)]);
    run(checkio, [io]);
    return io.output.slice(1, 4) as [number, number, number];
  };
  const CODES: Record<string, number> = { type: 3, structure: 2, limit: 4 };
  const tsCheck = (src: string): [number, number | undefined, number | undefined] => {
    let program: ReturnType<typeof parse>;
    try {
      program = parse(src);
    } catch (e) {
      assert.ok(e instanceof A0Error);
      return [0, undefined, undefined];
    }
    try {
      validate(program);
    } catch (e) {
      assert.ok(e instanceof A0Error);
      const m = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?[ :]/.exec(e.message);
      assert.ok(m !== null, e.message);
      const fi = program.functions.findIndex((g) => g.name === m[1]);
      const fn = program.functions[fi] as Func;
      const node =
        m[2] === undefined
          ? NONE
          : m[2] === 'ret'
            ? fn.nodes.length
            : fn.nodes.findIndex((n) => n.id === m[2]);
      return [CODES[e.code] as number, fi, node];
    }
    return [0, 0, 0];
  };
  for (const [label, src] of ILL_TYPED) {
    const [code, fi, node] = tsCheck(src);
    const got = a0Check(src);
    if (fi === undefined) {
      // Rejected by the TypeScript parser (category `parse`): the A0 front reports the
      // structure error of validateFunction (arity) or of the A0 parser (an unknown node).
      assert.equal(got[0], 2, `${label}: category`);
      continue;
    }
    assert.notEqual(code, 0, label);
    assert.equal(got[0], code, `${label}: category`);
    if (got[1] !== NONE) assert.deepEqual(got, [code, fi, node], label);
  }
  // Whole files through the front (lex, parse, check): the words refCheckWords computes.
  for (const f of ['examples/life.a0', 'site/ui.a0', 'compiler/lex.a0']) {
    const text = await readFile(f, 'utf8');
    const io = makeIo([Buffer.byteLength(text), ...Buffer.from(text)]);
    assert.equal(run(checkio, [io]), 0, f);
    assert.deepEqual(io.output, refCheckWords(text), f);
  }
  // The most one-line functions a 16384-byte source holds: validate() accepts them (the
  // function cap is 65536), so the A0 checker must too, with no limit diagnostic.
  {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const names = [...letters];
    for (const x of letters)
      for (const y of `${letters}0123456789`) if (x + y !== 'fn') names.push(x + y);
    let many = '';
    let n = 0;
    for (const name of names) {
      const f = `fn ${name} -> u32\nret 0\nend\n`;
      if (Buffer.byteLength(many + f) > FRONT_END_SOURCE_LIMIT) break;
      many += f;
      n += 1;
    }
    assert.equal(n, 713);
    assert.equal(parseAndValidate(many).functions.length, n);
    const io = makeIo([Buffer.byteLength(many), ...Buffer.from(many)]);
    assert.equal(run(checkio, [io]), 0);
    assert.deepEqual(io.output.slice(0, 4), [1, 0, 0, 0]);
    assert.deepEqual(io.output, refCheckWords(many));
  }
  // A well-typed source through the front: every node type agrees with validate().
  const src =
    'fn f u32x4 (u32,bool) io -> (u32,io)\nx mov 4294967295\nr read p2\nv at p1 1\nb arr v v\ng get b x\nret r\nend\n';
  const io = makeIo([Buffer.byteLength(src), ...Buffer.from(src)]);
  assert.equal(run(checkio, [io]), 0);
  const w = io.output;
  assert.deepEqual(w.slice(0, 4), [1, 0, 0, 0]);
  const nt = w[4] as number;
  const nl = w[5 + nt] as number;
  const nodeTypes = w.slice(7 + nt + nl);
  const typed = parseAndValidate(src).functions[0] as TypedFunc;
  assert.equal(nodeTypes.length, typed.nodes.length);
  typed.nodes.forEach((n, i) => {
    const got = decode(w.slice(5, 5 + nt), w.slice(6 + nt, 6 + nt + nl), nodeTypes[i] as number);
    assert.ok(typeEquals(got, typed.types.get(n.id) as Type), `${n.id}: ${formatType(got)}`);
  });
});

/** Run `session` of a direct-wasm module with the site's io layout (site/app.ts). */
async function wasmSession(
  bytes: Uint8Array,
  input: readonly number[],
): Promise<{ result: number; output: number[] }> {
  const IN = 1024;
  const OUT = 65536;
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
  const e = instance.exports as {
    memory: WebAssembly.Memory;
    __heap_base: WebAssembly.Global;
    a0_session: (t: number) => number;
  };
  const base = e.__heap_base.value as number;
  const needed = base + (IN + 2 + OUT + 1) * 4;
  if (e.memory.buffer.byteLength < needed)
    e.memory.grow(Math.ceil((needed - e.memory.buffer.byteLength) / 65536));
  const words = new Uint32Array(e.memory.buffer, base, IN + 2 + OUT + 1);
  words.set(input, 0);
  words[IN] = input.length;
  const result = e.a0_session(base) >>> 0;
  const nout = words[IN + 2 + OUT] as number;
  return { result, output: [...words.subarray(IN + 2, IN + 2 + nout)] };
}

test('direct wasm backend: site page, docs, and play programs write the interpreter words', async () => {
  const { readFile } = await import('node:fs/promises');
  const { wasmModuleBytes } = await import('../src/wasm.js');
  const src = [...Buffer.from('fn f u32 u32 -> u32\na add p0 p1\nb mul a 2\nret b\nend\n')];
  const ill = [...Buffer.from('fn g u32 bool -> u32\na lt p0 1\nb add a p1\nret b\nend\n')];
  const runs: [string, number[][]][] = [
    ['site/page.a0', [[0, 0, 0, 0, 0]]],
    ['site/docs.a0', [[0, 0, 0, 0, 0]]],
    [
      'site/play.a0',
      [
        [0, 0, 0, 0, 0],
        [1, 0, 0, src.length, ...src, 0],
        [1, 0, 0, ill.length, ...ill, 0],
      ],
    ],
  ];
  for (const [file, inputs] of runs) {
    const p = (await link(file, (f) => readFile(f, 'utf8'))).program;
    const session = p.byName.get('session') as TypedFunc;
    for (const optimize of [true, false]) {
      const text = compile(p, 'wasm', { ioInputCapacity: 1024, ioOutputCapacity: 65536, optimize });
      const bytes = wasmModuleBytes(text.text);
      for (const input of inputs) {
        const io = makeIo(input);
        const expected = run(session, [io]);
        const got = await wasmSession(bytes, input);
        assert.equal(got.result, expected, file);
        assert.ok(io.output.length > 100, file);
        assert.deepEqual(got.output, [...io.output], `${file} ${optimize ? 'O1' : 'O0'}`);
      }
    }
  }
});

test('direct wasm backend: in-place updates keep value semantics', async () => {
  const { wasmModuleBytes } = await import('../src/wasm.js');
  // `step` reads the fold's extra argument, which names the fold's own initial value: the
  // state must not be updated in that storage. `bump` writes through a set chain in place.
  const p = parseAndValidate(`fn step u32x4 u32 u32x4 -> u32x4
a get p2 0
b add a p1
c set p0 p1 b
ret c
end
fn go u32 -> u32
a arr p0 0 0 0
b fold step 4 a a
c get b 3
d get b 0
e add c d
ret e
end
fn bump u32 -> u32
a arr 1 2 3 4 5
b set a p0 9
c set b 1 p0
d get c 1
e get a 0
f add d e
ret f
end`);
  for (const optimize of [true, false]) {
    const bytes = wasmModuleBytes(compile(p, 'wasm', { optimize }).text);
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    const e = instance.exports as Record<string, (...a: number[]) => number>;
    for (const x of [0, 1, 7, 0xffff_ffff]) {
      for (const name of ['go', 'bump'])
        assert.equal(
          (e[`a0_${name}`] as (v: number) => number)(x | 0) >>> 0,
          run(p.byName.get(name) as TypedFunc, [x]),
          `${name}(${x})`,
        );
    }
  }
});

test('function cap: 4000-function programs are legal; the cap is LIMITS.maxFunctions', async () => {
  const { LIMITS, parse, validate } = await import('../src/core.js');
  assert.equal(LIMITS.maxFunctions, 65536);
  const src = Array.from({ length: 4000 }, (_, i) =>
    i === 0
      ? 'fn f0 u32 -> u32\nr add p0 1\nret r\nend\n'
      : `fn f${i} u32 -> u32\nr call f${i - 1} p0\nret r\nend\n`,
  ).join('');
  const p = parseAndValidate(src);
  assert.equal(p.functions.length, 4000);
  assert.ok(compile(p, 'js').text.includes('f3999'));
  const one = parse('fn g u32 -> u32\nret p0\nend\n');
  const fn = one.functions[0];
  assert.ok(fn !== undefined);
  const over = {
    ...one,
    functions: Array.from({ length: LIMITS.maxFunctions + 1 }, (_, i) => ({
      ...fn,
      name: `g${i}`,
    })),
  };
  assert.throws(() => validate(over), /too many functions/);
});
