import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, FunctionCache } from '../src/backends.js';
import {
  A0Error,
  formatFunction,
  parse,
  parseAndValidate,
  run,
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
