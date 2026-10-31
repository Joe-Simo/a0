import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, emitFunction, FunctionCache } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';

type Module = Record<string, (...args: unknown[]) => unknown>;
function exported(mod: Module, name: string) {
  const fn = mod[name];
  assert.ok(fn);
  return fn;
}

async function load(text: string): Promise<Module> {
  return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
}

const leaf = 'fn leaf u32 -> u32\nr add p0 7\nret r\nend\n';

test('JS keeps public entries while pruning unreachable private duplicates', async () => {
  const program = parseAndValidate(leaf);
  const text = compile(program, 'js').text;
  assert.doesNotMatch(text, /^function a0i_leaf\(/m);
  const first = program.functions[0];
  assert.ok(first);
  const raw = emitFunction('js', first);
  const publicBody = raw.slice(raw.indexOf('export function leaf'));
  assert.ok(text.includes(publicBody));
  const mod = await load(text);
  for (const x of [0, 1, 0x80000000, 0xffffffff])
    assert.equal(exported(mod, 'leaf')(x), (x + 7) >>> 0);
});

test('JS private reachability is recomputed after cached callers are added and removed', async () => {
  const cache = new FunctionCache();
  const only = parseAndValidate(leaf);
  const a = compile(only, 'js', {}, cache);
  assert.doesNotMatch(a.text, /^function a0i_leaf\(/m);
  const called = parseAndValidate(
    `${leaf}fn middle u32 -> u32\nx call leaf p0\nr mul x 3\nret r\nend\nfn top u32 -> u32\nr call middle p0\nret r\nend`,
  );
  const b = compile(called, 'js', { optimize: false }, cache);
  // Warm the same unoptimized descriptors, then check module assembly with hits.
  const c = compile(called, 'js', { optimize: false }, cache);
  assert.ok(c.cacheHits >= 3);
  assert.equal(c.text, b.text);
  assert.match(c.text, /^function a0i_leaf\(/m);
  assert.match(c.text, /^function a0i_middle\(/m);
  assert.doesNotMatch(c.text, /^function a0i_top\(/m);
  const mod = await load(c.text);
  for (const x of [0, 17, 0xffffffff])
    assert.equal(exported(mod, 'top')(x), Math.imul((x + 7) >>> 0, 3) >>> 0);
  const d = compile(only, 'js', {}, cache);
  assert.ok(d.cacheHits >= 1);
  assert.equal(d.text, a.text);
});

const arrays = `fn step u32x3 u32 u32 -> u32x3
v get p0 p1
w add v p2
r set p0 p1 w
ret r
end
fn unused u32x3 u32 -> u32x3
r set p0 p1 9
ret r
end
fn go u32 u32 -> u32x3
a arr p0 p1 3
r fold step 7 a p1
ret r
end`;

test('JS retains needed owned variants and public aggregate snapshot semantics', async () => {
  for (const optimize of [false, true]) {
    const program = parseAndValidate(arrays);
    const text = compile(program, 'js', { optimize }).text;
    if (!optimize) assert.match(text, /^function a0o_step\(/m);
    assert.match(text, /^function a0i_step\(/m);
    assert.doesNotMatch(text, /^function a0o_unused\(/m);
    const mod = await load(text);
    const go = program.byName.get('go');
    assert.ok(go);
    for (const args of [
      [0, 1],
      [0xffffffff, 17],
      [3, 7],
    ])
      assert.deepEqual(Array.from(exported(mod, 'go')(...args) as Iterable<number>), run(go, args));
    const input = [1, 2, 3];
    assert.deepEqual(Array.from(exported(mod, 'unused')(input, 1) as Iterable<number>), [1, 9, 3]);
    assert.deepEqual(input, [1, 2, 3]);
  }
});

test('JS strict roots and ordinary callees preserve original trap behavior', async () => {
  const program = parseAndValidate(
    'profile strict\nfn divide u32 u32 -> u32\nr div p0 p1\nret r\nend\nfn go u32 u32 -> u32\nr call divide p0 p1\nret r\nend',
  );
  const text = compile(program, 'js', { optimize: false }).text;
  assert.match(text, /^function a0i_divide\(/m);
  const mod = await load(text);
  assert.equal(exported(mod, 'go')(17, 3), 5);
  assert.throws(() => exported(mod, 'go')(17, 0), /div|zero/i);
});
