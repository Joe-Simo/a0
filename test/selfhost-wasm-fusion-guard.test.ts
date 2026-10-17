import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { run, type TypedFunc } from '../src/core.js';
import { link } from '../src/link.js';

test('A0 Wasm fusion requires checked-free available candidate call closures', async () => {
  const program = (await link('compiler/shape.a0', (p) => readFile(p, 'utf8'))).program;
  const fn = program.byName.get('shfcsafe') as TypedFunc | undefined;
  assert.ok(fn);
  const zero = (pages: number) => Array.from({ length: pages }, () => Array<number>(128).fill(0));
  const set = (table: number[][], i: number, value: number) => {
    const page = table[i >>> 7];
    assert.ok(page !== undefined);
    page[i & 127] = value;
  };
  const make = () => ({ fns: zero(45), nodes: zero(132) });
  const body = (p: ReturnType<typeof make>, f: number, first: number, count: number) => {
    set(p.fns, f * 7 + 4, first);
    set(p.fns, f * 7 + 5, count);
    set(p.fns, f * 7 + 6, 0x30000000); // packed nonopaque u32 literal return.
  };
  const node = (p: ReturnType<typeof make>, n: number, op: number, callee = 0, pred = 0) => {
    set(p.nodes, n * 6 + 1, op);
    set(p.nodes, n * 6 + 4, callee);
    set(p.nodes, n * 6 + 5, pred);
  };
  let cases = 0;
  const check = (p: ReturnType<typeof make>, expected: [number, number], label: string) => {
    assert.deepEqual(run(fn, [p.fns, p.nodes, 0], { fuel: 1_000_000 }), expected, label);
    cases += 1;
  };
  const NONE = 0xffffffff;
  {
    const p = make();
    body(p, 0, 0, 1);
    node(p, 0, 2);
    check(p, [1, NONE], 'ordinary candidate stays eligible');
  }
  for (const op of [32, 33, 34, 35, 36, 37]) {
    const p = make();
    body(p, 0, 0, 1);
    node(p, 0, op);
    check(p, [0, NONE], `checked op${op} declines fusion`);
  }
  {
    const p = make();
    body(p, 0, 0, 1);
    body(p, 3, 1, 1);
    body(p, 1, 2, 1);
    node(p, 0, 19, 3);
    node(p, 1, 20, 1);
    node(p, 2, 34);
    check(p, [0, NONE], 'forward synthetic function edge reaches checked fold body');
  }
  {
    const p = make();
    body(p, 0, 0, 1);
    node(p, 0, 19, 1);
    check(p, [0, 1], 'opaque reachable callee requests its body');
  }
  {
    const p = make();
    body(p, 0, 0, 1);
    body(p, 1, 1, 1);
    body(p, 2, 2, 1);
    node(p, 0, 21, 1, 2);
    node(p, 1, 2);
    node(p, 2, 37);
    check(p, [0, NONE], 'loop predicate is part of the closure');
  }
  {
    const p = make();
    body(p, 0, 0, 1);
    body(p, 2, 1, 1);
    node(p, 0, 2);
    node(p, 1, 35);
    check(p, [1, NONE], 'unreachable opaque/checked rows do not disable ordinary fusion');
  }
  {
    const p = make();
    body(p, 0, 0, 1);
    node(p, 0, 19, 1);
    check(p, [0, 1], 'initial missing body');
    body(p, 1, 1, 1);
    node(p, 1, 19, 2);
    check(p, [0, 2], 'retry exposes another opaque reachable body');
    body(p, 2, 2, 1);
    node(p, 2, 32);
    check(p, [0, NONE], 'retry supplied checked body declines fusion before cleanup');
  }
  {
    const p = make();
    body(p, 0, 0, 1);
    node(p, 0, 19, 822);
    check(p, [0, NONE], 'invalid function index cannot wrap into another row');
  }
  assert.equal(cases, 15);
});
