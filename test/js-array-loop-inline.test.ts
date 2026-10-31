import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';

async function moduleOf(source: string, optimize: boolean) {
  const program = parseAndValidate(source);
  const text = compile(program, 'js', { optimize }).text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
  return { program, text, mod };
}

const SORT = `fn swap u32x13 u32 u32 -> u32x13
j sub p2 p1
k sub j 1
u get p0 k
v get p0 j
a set p0 j u
b set a k v
ret b
end
fn more u32x13 u32 u32 -> bool
j sub p2 p1
k sub j 1
u get p0 k
v get p0 j
b gt u v
ret b
end
fn insert u32x13 u32 -> u32x13
r loop more swap p1 p0 p1
ret r
end
fn sort u32x13 -> u32x13
r fold insert 13 p0
ret r
end`;

test('JS inline array loops preserve full sorting results and input snapshots', async () => {
  const cases = [
    Array(13).fill(0),
    Array.from({ length: 13 }, (_, i) => i),
    Array.from({ length: 13 }, (_, i) => 13 - i),
    [0xffffffff, 0x80000000, 1, 0, 7, 7, 7, 0xdeadbeef, 13, 2, 0xffffffff, 0, 3],
  ];
  let s = 0x12345678;
  for (let n = 0; n < 20; n++)
    cases.push(
      Array.from({ length: 13 }, () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return s >>> 0;
      }),
    );
  for (const optimize of [false, true]) {
    const { program, text, mod } = await moduleOf(SORT, optimize);
    const reference = program.byName.get('sort');
    assert.ok(reference);
    assert.match(text, /\$r_pred_/);
    assert.doesNotMatch(text, /if \(!a0i_more/);
    for (const input of cases) {
      const original = [...input];
      const expected = [...input].sort((a, b) => a - b);
      assert.deepEqual(Array.from(mod.sort(input)), expected);
      assert.deepEqual(input, original);
      assert.deepEqual(run(reference, [input], { fuel: 1e6 }), expected);
    }
  }
});

const ALIAS = `fn more u32x3 u32 u32x3 -> bool
v get p0 p1
b lt p1 4
ret b
end
fn update u32x3 u32 u32x3 -> u32x3
v get p0 p1
w get p2 p1
x add v w
a set p0 p1 x
old get p0 p1
y add old 1
b set a p1 y
ret b
end
fn fromextra u32x3 u32 u32x3 -> u32x3
ret p2
end
fn alias u32 u32 -> (u32x3,u32x3,u32x3)
a arr p0 p1 4294967295
n and p1 7
cnt add n 4
b loop more update cnt a a
c loop more fromextra cnt b a
d loop more update cnt c b
r rec a b d
ret r
end
fn zero u32x3 -> u32x3
r loop more update 0 p0 p0
ret r
end`;

test('JS inline array loops preserve aliases, old reads, returned extras, and zero trips', async () => {
  for (const optimize of [false, true]) {
    const { program, mod } = await moduleOf(ALIAS, optimize);
    const reference = program.byName.get('alias');
    assert.ok(reference);
    for (const args of [
      [0, 0],
      [0xffffffff, 1],
      [0x80000000, 17],
      [3, 13],
    ]) {
      const actual = mod.alias(...args).map((a: Iterable<number>) => Array.from(a));
      assert.deepEqual(actual, run(reference, args));
    }
    const input = [7, 13, 17];
    assert.deepEqual(Array.from(mod.zero(input)), input);
    assert.deepEqual(input, [7, 13, 17]);
  }
});

test('JS inline array loops retain strict and effectful fallbacks', async () => {
  const strict = await moduleOf(`profile strict\n${SORT}`, false);
  assert.doesNotMatch(strict.text, /\$r_pred_/);
  assert.match(strict.text, /if \(!a0i_more/);
  const called = await moduleOf(
    'fn greater u32 u32 -> bool\nb gt p0 p1\nret b\nend\n' +
      SORT.replace('b gt u v', 'b call greater u v'),
    false,
  );
  assert.doesNotMatch(called.text, /\$r_pred_/);
  assert.match(called.text, /if \(!a0i_more/);
  const constant = await moduleOf(SORT.replace('more swap p1', 'more swap 13'), false);
  assert.doesNotMatch(constant.text, /\$r_pred_/);
  assert.match(constant.text, /if \(!a0i_more/);
});

test('JS inline array loops preserve boolean lanes and runtime zero bounds', async () => {
  const source = `fn more boolx5 u32 bool -> bool
b lt p1 7
ret b
end
fn flip boolx5 u32 bool -> boolx5
v get p0 p1
w xor v p2
r set p0 p1 w
ret r
end
fn go bool u32 -> boolx5
a arr true false true false true
r loop more flip p1 a p0
ret r
end`;
  for (const optimize of [false, true]) {
    const { program, mod, text } = await moduleOf(source, optimize);
    const reference = program.byName.get('go');
    assert.ok(reference);
    assert.match(text, /\$r_pred_/);
    for (const flag of [false, true])
      for (const count of [0, 1, 4, 5, 17, 0xffffffff])
        assert.deepEqual(Array.from(mod.go(flag, count), Boolean), run(reference, [flag, count]));
  }
});
