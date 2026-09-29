import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, FunctionCache } from '../src/backends.js';
import {
  A0Error,
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

test('self-contained patch requires the exact current revision and replaces existing nodes only', () => {
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
  // Unknown node cannot be inserted.
  const insert = `patch affine ${revision(affine)}\nq add a a\nend`;
  assert.throws(() => applyPatch(program, parsePatch(insert)), /unknown node/);
  // Replacement introducing a forward reference is rejected as a whole.
  const forward = `patch affine ${revision(affine)}\na add b p0\nend`;
  assert.throws(() => applyPatch(program, parsePatch(forward)), /undefined or later/);
});

test('session edits: short handle, atomic commit, one-use, stale and unknown handles rejected', () => {
  const session = new EditSession(parseAndValidate(AFFINE), { maxOpenHandles: 2 });
  const view = session.open('affine');
  assert.equal(view.handle, 'e0');
  assert.equal(view.text, `e0\n${AFFINE}`);
  const edit = 'e0\nb sub a p2\n'; // 14 bytes including the terminating newline
  assert.equal(Buffer.byteLength(edit, 'utf8'), 14);
  const stale = session.open('affine'); // e1, bound to the pre-edit revision
  const next = session.apply(edit);
  assert.equal(run(next.byName.get('affine') as TypedFunc, [10, 3, 7]), 23);
  assert.equal(session.openHandles, 1);
  assert.throws(() => session.apply(edit), /unknown or consumed/);
  assert.throws(() => session.apply(`${stale.handle}\nb add a p2`), /stale/);
  assert.throws(() => session.apply('e9\nb add a p2'), /unknown or consumed/);
  assert.throws(() => session.apply('zz\nb add a p2'), /invalid handle/);
  // A failed edit leaves the program and handle untouched.
  const h = session.open('affine');
  assert.throws(() => session.apply(`${h.handle}\nb add a p9`), /out of range/);
  assert.equal(session.openHandles, 2);
  assert.throws(() => session.open('affine'), /handle limit/);
  assert.equal(session.close(h.handle), true);
  assert.equal(session.close(h.handle), false);
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
  assert.deepEqual(mod.swap([1, 2]), [2, 1]);
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
  assert.throws(() => compile(badPred, 'sv'), /predicate must be combinational/);
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
