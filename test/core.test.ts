import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, FunctionCache } from '../src/backends.js';
import { compileCached, DiskCache } from '../src/cache.js';
import {
  A0Error,
  formatDiagnostic,
  formatFunction,
  formatType,
  makeIo,
  parse,
  parseAndValidate,
  parseType,
  run,
  type Type,
  type TypedFunc,
} from '../src/core.js';
import { applyPatch, EditSession, formatPatch, parsePatch, revision } from '../src/edit.js';
import { optimize, optimizeFunction } from '../src/optimize.js';

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

test('site page program: A0 UI protocol with stylesheet, grid, timer, and 35-word state', async () => {
  // The site is page.a0 plus what it uses (examples/life.a0), through the linker.
  const { link } = await import('../src/link.js');
  const { readFile } = await import('node:fs/promises');
  const p = (await link('site/page.a0', (f) => readFile(f, 'utf8'))).program;
  const session = p.byName.get('session') as TypedFunc;
  interface Decoded {
    texts: string[];
    css: string;
    state: number[];
    events: number[];
    grid: number[] | undefined;
    timer: number[] | undefined;
  }
  const decode = (words: readonly number[]): Decoded => {
    const d: Decoded = {
      texts: [],
      css: '',
      state: [],
      events: [],
      grid: undefined,
      timer: undefined,
    };
    const str = (i: number, n: number): string =>
      Buffer.from(words.slice(i, i + n)).toString('utf8');
    for (let i = 0; i < words.length; ) {
      const c = words[i++];
      if (c === 1) i += 1;
      else if (c === 5 || c === 8) d.events.push(words[i++] as number);
      else if (c === 2 || c === 4 || c === 9) {
        if (c === 4) i += 1;
        const n = words[i++] as number;
        if (c === 9) d.css += str(i, n);
        else d.texts.push(str(i, n));
        i += n;
      } else if (c === 6) {
        const n = words[i++] as number;
        d.state = words.slice(i, i + n) as number[];
        i += n;
      } else if (c === 10) {
        const n = words[i + 1] as number;
        d.grid = words.slice(i + 2, i + 2 + n) as number[];
        i += 2 + n;
      } else if (c === 11) {
        d.timer = [words[i] as number, words[i + 1] as number];
        i += 2;
      } else if (c === 12)
        i += 2; // SIZE prop percent (chart bars computed by the program)
      else if (c !== 3) throw new Error(`bad command ${c} at ${i - 1}`);
    }
    return d;
  };
  // Initial render: event 0, no text, no state (reads past the input yield 0).
  const first = makeIo([0, 0, 0, 0, 0]);
  assert.equal(run(session, [first]), 0);
  const d0 = decode(first.output);
  assert.equal(d0.state.length, 35);
  assert.ok(d0.css.includes('body{') && d0.css.length > 3000);
  assert.deepEqual(
    [...new Set(d0.events)].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6], // GRID carries cell-click event 7 with (x, y)
  );
  assert.equal(d0.grid?.length, 32);
  assert.equal(d0.timer, undefined);
  assert.ok(d0.texts.includes('Clicked ') && d0.texts.includes('Run'));
  // Glider, then one step: generation 1, population 5, timer only while running.
  const glider = makeIo([6, 0, 0, 0, 35, ...d0.state]);
  run(session, [glider]);
  const d1 = decode(glider.output);
  assert.deepEqual(d1.state.slice(4, 7), [4, 8, 14]);
  const step = makeIo([3, 0, 0, 0, 35, ...d1.state]);
  run(session, [step]);
  const d2 = decode(step.output);
  assert.equal(d2.state[1], 1);
  assert.deepEqual(d2.state.slice(3, 8), [0, 0, 10, 12, 4]);
  const running = makeIo([4, 0, 0, 0, 35, ...d2.state]);
  run(session, [running]);
  const d3 = decode(running.output);
  assert.equal(d3.state[2], 1);
  assert.deepEqual(d3.timer, [120, 8]);
  assert.ok(d3.texts.includes('Pause') && !d3.texts.includes('Run'));
  // Counter click renders its decimal value; the echo input travels as bytes.
  const click = makeIo([1, 0, 0, 2, 104, 105, 35, ...d3.state]);
  assert.equal(run(session, [click]), 1);
  const d4 = decode(click.output);
  assert.equal(d4.state[0], 1);
  assert.ok(d4.texts.includes('1') && d4.texts.includes('hi'));
  // Emitted JS produces the identical stream.
  const js = compile(p, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as {
    session: (t: unknown) => number;
    a0_make_io: (i: number[]) => { output: number[] };
  };
  const st = mod.a0_make_io([1, 0, 0, 2, 104, 105, 35, ...d3.state]);
  assert.equal(mod.session(st), 1);
  assert.deepEqual(st.output, [...click.output]);
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
  const { link } = await import('../src/link.js');
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

test('edit tolerance: trailing end, whole-function block under its handle, echoed signatures, callee order', () => {
  const src =
    'fn sq u32 -> u32\na mul p0 p0\nret a\nend\nfn main u32 -> u32\nb call sq p0\nret b\nend';
  // Trailing `end` after edit lines is accepted.
  let s = new EditSession(parseAndValidate(src));
  let h = s.open('sq').handle;
  let p = s.apply(`${h}\na add p0 p0\nret a\nend`);
  assert.equal(run(p.byName.get('sq') as TypedFunc, [3]), 6);
  // The whole function sent back under its own handle replaces it; another function is refused.
  s = new EditSession(parseAndValidate(src));
  h = s.open('sq').handle;
  p = s.apply(`${h}\nfn sq u32 -> u32\na sub p0 1\nret a\nend`);
  assert.equal(run(p.byName.get('sq') as TypedFunc, [3]), 2);
  s = new EditSession(parseAndValidate(src));
  h = s.open('sq').handle;
  assert.throws(() => s.apply(`${h}\nfn other u32 -> u32\nret p0\nend`), /edit lines/);
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
    // a 4 KiB array: word-copy loops and a probed (___chkstk_darwin) frame
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
