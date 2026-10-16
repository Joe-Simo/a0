import assert from 'node:assert/strict';
import { makeIo, parseAndValidate } from '../../../dist/src/core.js';
import { Arena, encodeIR, floatWords, fromFloatWords, inputValue, valueOut } from './model.mjs';
import { nativeRuntime } from './native.mjs';

const exe = process.argv[2];
const group = process.argv[3];
assert.ok(exe && group);
const native = nativeRuntime(exe);
const routes = ['table', 'source'];
let checks = 0;
function ok(
  source,
  fn,
  args,
  expected,
  options = { fuel: 100000000 },
  route = 'table',
  quantum = 7,
) {
  const got = native.execute(source, fn, args, options, route, quantum);
  assert.equal(got.status, 0, `${route} ${fn}: status${got.status}/A${got.id}`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(got.value, (key, v) => (key === 'ioHandle' ? 0 : v))),
    expected,
  );
  checks++;
  return got;
}
function bad(source, fn, args, id, options, route = 'table', trap) {
  const got = native.execute(source, fn, args, options, route);
  assert.equal(got.status, 9);
  assert.equal(got.id, id);
  if (trap) assert.deepEqual(got.trap, trap);
  checks++;
  return got;
}
function fresh(source = 'fn f -> u32\nret 0\nend') {
  const a = new Arena();
  const ir = encodeIR(a, parseAndValidate(source));
  return { a, ir };
}
const sum =
  'fn sum u32 u32 -> u32\na add p0 p1\nret a\nend\nfn root -> u32\nr fold sum 9 0\nret r\nend';

function scalarOracle(op, a, b) {
  const x = BigInt(a),
    y = BigInt(b),
    mask = 0xffffffffn;
  const wrap = (v) => Number(v & mask);
  switch (op) {
    case 'mov':
      return a;
    case 'add':
      return wrap(x + y);
    case 'sub':
      return wrap(x - y);
    case 'mul':
      return wrap(x * y);
    case 'and':
      return wrap(x & y);
    case 'or':
      return wrap(x | y);
    case 'xor':
      return wrap(x ^ y);
    case 'shl':
      return wrap(x << (y & 31n));
    case 'shr':
      return Number(x >> (y & 31n));
    case 'div':
      return b === 0 ? 0xffffffff : Number(x / y);
    case 'rem':
      return b === 0 ? a : Number(x % y);
    case 'eq':
      return x === y;
    case 'ne':
      return x !== y;
    case 'lt':
      return x < y;
    case 'le':
      return x <= y;
    case 'gt':
      return x > y;
    case 'ge':
      return x >= y;
    default:
      throw new Error(op);
  }
}
function core() {
  for (const route of routes) {
    for (const op of ['cadd', 'csub', 'cmul', 'cdiv', 'crem']) {
      const source = `fn f u32 u32 -> (u32,bool)\nr ${op} p0 p1\nret r\nend`;
      for (const a of [0, 1, 65536, 0xffffffff])
        for (const b of [0, 1, 65536, 0xffffffff]) {
          const x = BigInt(a),
            y = BigInt(b),
            mask = 0xffffffffn;
          const expected =
            op === 'cadd'
              ? [Number((x + y) & mask), x + y <= mask]
              : op === 'csub'
                ? [Number((x - y) & mask), x >= y]
                : op === 'cmul'
                  ? [Number((x * y) & mask), x * y <= mask]
                  : op === 'cdiv'
                    ? [b === 0 ? 0 : Number(x / y), b !== 0]
                    : [b === 0 ? 0 : Number(x % y), b !== 0];
          assert.equal(ok(source, 'f', [a, b], expected, { fuel: 2 }, route).fuel, 0);
        }
    }
    for (const i of [0, 1, 2, 3, 0xffffffff])
      ok(
        'fn f u32x3 u32 -> (u32,bool)\nr cget p0 p1\nret r\nend',
        'f',
        [[9, 8, 7], i],
        [i < 3 ? [9, 8, 7][i] : 0, i < 3],
        { fuel: 2 },
        route,
      );
    for (const op of [
      'mov',
      'add',
      'sub',
      'mul',
      'and',
      'or',
      'xor',
      'shl',
      'shr',
      'div',
      'rem',
      'eq',
      'ne',
      'lt',
      'le',
      'gt',
      'ge',
    ]) {
      const bool = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(op);
      const one = op === 'mov';
      const source = `fn f u32${one ? '' : ' u32'} -> ${bool ? 'bool' : 'u32'}\nr ${op} p0${one ? '' : ' p1'}\nret r\nend`;
      for (const [a, b] of [
        [0, 0],
        [0xffffffff, 1],
        [0x80000000, 32],
      ])
        ok(source, 'f', one ? [a] : [a, b], scalarOracle(op, a, b), { fuel: 2 }, route);
    }
    for (const op of ['and', 'or', 'xor', 'eq', 'ne'])
      for (const a of [false, true])
        for (const b of [false, true]) {
          const expected =
            op === 'and' ? a && b : op === 'or' ? a || b : op === 'eq' ? a === b : a !== b;
          ok(
            `fn f bool bool -> bool\nr ${op} p0 p1\nret r\nend`,
            'f',
            [a, b],
            expected,
            { fuel: 2 },
            route,
          );
        }
    const alias =
      'fn f (u32x3,u32x3) -> ((u32x3,u32x3),(u32x3,u32x3))\na at p0 0\nb set a 4 99\nc put p0 0 b\nr rec p0 c\nret r\nend';
    ok(
      alias,
      'f',
      [
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
      ],
      [
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
        [
          [1, 99, 3],
          [4, 5, 6],
        ],
      ],
      undefined,
      route,
    );
    for (const condition of [true, false])
      ok(
        'fn f bool u32x2 u32x2 -> u32x2\nr select p0 p1 p2\nret r\nend',
        'f',
        [condition, [1, 2], [3, 4]],
        condition ? [1, 2] : [3, 4],
        { fuel: 2 },
        route,
      );
    const exact = ok(sum, 'root', [], 36, { fuel: 29, maxTrips: 9 }, route);
    assert.equal(exact.fuel, 0);
    assert.equal(exact.maxTrips, 0);
    bad(sum, 'root', [], 701, { fuel: 28, maxTrips: 9 }, route, {
      fn: 'sum',
      at: 'root.r',
      trip: 8,
      chain: ['root', 'sum'],
    });
    const pair = 'fn f u32 -> (u32,u32)\nr rec p0 p0\nret r\nend';
    assert.equal(ok(pair, 'f', [9], [9, 9], { fuel: 4 }, route).fuel, 0);
    assert.equal(bad(pair, 'f', [9], 701, { fuel: 3 }, route).fuel, -1);
    bad('fn f (u32,boolx2) -> u32\nret 0\nend', 'f', [[1, [false, 0]]], 704, { fuel: 0 }, route);
    bad('fn f u32x3 -> u32\nret 0\nend', 'f', [[1, 2]], 705, { fuel: 0 }, route);
    bad('fn f (u32,bool) -> u32\nret 0\nend', 'f', [[1]], 706, { fuel: 0 }, route);
    bad('fn f u32 -> u32\nret p0\nend', 'f', [], 703, { fuel: 0 }, route);
  }
}
function ieee() {
  const buf = new ArrayBuffer(8),
    view = new DataView(buf);
  const number = (a) => {
    view.setUint32(0, a[0], true);
    view.setUint32(4, a[1], true);
    return view.getFloat64(0, true);
  };
  const cases = [];
  for (const x of [
    0,
    -0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    0.5,
    -0.5,
    1,
    1.5,
    -1,
    2 ** -20,
    2 ** 32,
    2 ** 53,
    2 ** 54,
    2 ** 55,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Infinity,
    -Infinity,
    NaN,
  ])
    for (const u of [0, 1, 2, 3, 65536, 0xffffffff]) cases.push([floatWords(x), u]);
  let seed = 123456789;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let i = 0; i < 512; i++) cases.push([[next(), next()], next()]);
  const actual = native.invoke([
    0x41454556,
    2,
    cases.length,
    ...cases.flatMap(([a, u]) => [...a, u]),
  ]);
  assert.equal(actual[0], cases.length);
  for (const [i, [a, u]] of cases.entries()) {
    const got = number(actual.slice(1 + i * 2, 3 + i * 2)),
      want = number(a) - u;
    assert.ok(Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want)));
    checks++;
  }
}
function ioCase(source, input, position, output, fuel, id = 0, trip = null, fn = 'root') {
  for (const route of routes) {
    const got = native.execute(
      source,
      'root',
      [makeIo(input)],
      { fuel: 100, maxTrips: 10 },
      route,
      1,
    );
    assert.equal(got.status, id ? 9 : 0);
    assert.equal(got.id, id);
    assert.equal(got.fuel, fuel);
    const args = got.arena.heap[got.m[30]],
      handle = args[1],
      obj = got.arena.heap[handle];
    assert.equal(obj[3], position);
    assert.deepEqual(got.arena.get(Array.from(obj.slice(4, 7))), output);
    if (id)
      assert.deepEqual(got.trap, {
        chain: fn === 'root' ? ['root'] : ['root', fn],
        fn,
        at: trip === null ? null : 'root.r',
        trip,
      });
    else assert.equal(got.value.ioHandle, handle);
    checks++;
  }
}
function budgetsIo() {
  ieee();
  for (const route of routes) {
    const zero = 'fn f -> u32\nret 7\nend';
    for (const f of [0, 0.5, -1, -Infinity]) bad(zero, 'f', [], 701, { fuel: f }, route);
    for (const f of [1, 1.5, 2 ** 53, 2 ** 54, Infinity, NaN]) {
      const got = ok(zero, 'f', [], 7, { fuel: f }, route);
      assert.ok(Object.is(got.fuel, f - 1) || (Number.isNaN(got.fuel) && Number.isNaN(f - 1)));
    }
    for (const op of ['div', 'rem'])
      bad(
        `profile strict\nfn f u32 -> u32\nr ${op} p0 0\nret r\nend`,
        'f',
        [9],
        711,
        { fuel: 2 },
        route,
      );
    bad(
      'profile strict\nfn f u32x3 u32 -> u32\nr get p0 p1\nret r\nend',
      'f',
      [[1, 2, 3], 0xffffffff],
      710,
      { fuel: 2 },
      route,
    );
    const loop =
      'fn pred u32 u32 -> bool\nr lt p1 3\nret r\nend\nfn body u32 u32 -> u32\nr add p0 2\nret r\nend\nfn root -> u32\nr loop pred body 100 0\nret r\nend';
    assert.equal(ok(loop, 'root', [], 6, { fuel: 100, maxTrips: 4 }, route).maxTrips, 0);
    bad(loop, 'root', [], 709, { fuel: 100, maxTrips: 3 }, route, {
      fn: 'root',
      at: 'root.r',
      trip: 3,
      chain: ['root'],
    });
    const one =
      'fn b u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f -> u32\nr fold b 1 0\nret r\nend';
    assert.equal(ok(one, 'f', [], 1, { fuel: 100, maxTrips: 0.5 }, route).maxTrips, -0.5);
    bad(sum, 'root', [], 709, { fuel: 100, maxTrips: 0.5 }, route, {
      fn: 'root',
      at: 'root.r',
      trip: 1,
      chain: ['root'],
    });
  }
  const fold =
    'fn body io u32 -> io\na read p0\nv at a 0\nt at a 1\nx add v p1\nw write t x\nret w\nend\nfn root io -> io\nr fold body 3 p0\nret r\nend';
  ioCase(fold, [10, 20, 30], 3, [10, 21, 32], 77);
  ioCase(fold, [10, 20], 2, [10, 21, 2], 77);
  ioCase(`profile strict\n${fold}`, [10, 20], 2, [10, 21], 81, 712, 2, 'body');
  const loop =
    'fn pred io u32 -> bool\na read p0\nv at a 0\nb eq v 1\nret b\nend\nfn body io u32 -> io\nw write p0 p1\nret w\nend\nfn root io -> io\nr loop pred body 4 p0\nret r\nend';
  ioCase(loop, [1, 1, 0, 99], 3, [0, 1], 79);
  ioCase(`profile strict\n${loop}`, [1], 1, [0], 88, 712, 1, 'pred');
  ioCase(
    'fn leaf io -> (u32,io)\na read p0\nret a\nend\nfn root io -> io\na call leaf p0\nv at a 0\nt at a 1\nw write t v\nret w\nend',
    [8],
    1,
    [8],
    93,
  );
  ioCase(
    'fn root io -> io\na read p0\nt at a 1\nb put a 1 t\nv at b 0\nu at b 1\nw write u v\nret w\nend',
    [6],
    1,
    [6],
    91,
  );
  for (const route of routes) {
    const io = makeIo([]);
    io.output.length = 1048574;
    io.output.fill(19);
    const got = native.execute(
      'fn f io u32x3 -> io\nr puts p0 p1\nret r\nend',
      'f',
      [io, [7, 8, 9]],
      { fuel: 2 },
      route,
    );
    assert.equal(got.id, 702);
    assert.equal(got.fuel, 0);
    const args = got.arena.heap[got.m[30]],
      obj = got.arena.heap[args[1]],
      out = got.arena.heap[obj[4]];
    assert.equal(obj[5], 1048576);
    assert.deepEqual(Array.from(out.slice(obj[5] - 2, obj[5])), [3, 7]);
    checks++;
  }
}
function capacity() {
  let deep = 'fn f0 -> u32\nret 17\nend\n';
  for (let i = 1; i <= 1040; i++) deep += `fn f${i} -> u32\nr call f${i - 1}\nret r\nend\n`;
  const values = Array.from({ length: 65536 }, (_, i) => i);
  const wide =
    'fn f u32x65536 -> (u32,u32)\na set p0 65535 9\nx get p0 65535\ny get a 65535\nr rec x y\nret r\nend';
  for (const route of routes) {
    assert.equal(ok(deep, 'f1040', [], 17, { fuel: 2081 }, route, 64).fuel, 0);
    const stopped = bad(deep, 'f1040', [], 701, { fuel: 2080 }, route);
    assert.equal(stopped.fuel, -1);
    assert.deepEqual(stopped.trap, {
      fn: 'f0',
      at: null,
      trip: null,
      chain: Array.from({ length: 1041 }, (_, i) => `f${1040 - i}`),
    });
    assert.equal(ok(wide, 'f', [values], [65535, 9], { fuel: 65543 }, route, 128).fuel, 0);
  }
}
function boundaries() {
  // Raw-source packets use no TS parser/checker/IR encoder; invalid unused IR
  // ensures the A0 source path cannot silently select a prevalidated table.
  for (const [source, status, id, value] of [
    ['fn f -> u32\nret 4294967296\nend', 6, 4],
    ['fn f -> u32\nr add true 1\nret r\nend', 8, 201],
    ['fn f bool -> bool\nex true -> false\nret p0\nend', 7, 0],
    ['fn f -> u32\nret 7\nend', 0, 0, 7],
    ['profile strict\nfn f -> u32\nr div 9 0\nret r\nend', 9, 711],
  ]) {
    const a = new Arena(),
      sv = a.put(Array.from(Buffer.from(source)));
    const got = native.decode(
      native.invoke(
        native.packet(
          a,
          new Uint32Array(128).fill(0xffffffff),
          1,
          sv[0],
          sv[1],
          0,
          [0, 0, 0],
          { fuel: 2 },
          1,
        ),
      ),
    );
    assert.equal(got.m[0], status);
    assert.equal(got.m[1], id);
    assert.equal(got.m[12], 0);
    if (status === 0) assert.equal(got.m[10], value);
    checks++;
  }
  for (const op of [0, 38, 0xffffffff]) {
    const { a, ir } = fresh('fn f u32 -> u32\nr mov p0\nret r\nend');
    a.heap[ir.state[44]][1] = op;
    const got = native.decode(
      native.invoke(native.packet(a, ir.state, 0, 0, 0, 0, a.put([0, 9]), { fuel: 10000 }, 1)),
    );
    assert.equal(got.m[0], 9);
    assert.equal(got.m[1], 790);
    checks++;
  }
  {
    const { a, ir } = fresh('fn f u32x3 -> u32x3\nr set p0 0 4\nret r\nend');
    const args = a.put(inputValue(a, [1, 2, 3]));
    a.max = a.words + 8;
    const got = native.decode(
      native.invoke(native.packet(a, ir.state, 0, 0, 0, 0, args, { fuel: 10000 }, 8)),
    );
    assert.equal(got.m[0], 4);
    assert.notEqual(got.m[1], 701);
    checks++;
  }
  {
    const { a, ir } = fresh(
      'fn b u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f u32 -> u32\nr fold b p0 0\nret r\nend',
    );
    const got = native.decode(
      native.invoke(
        native.packet(a, ir.state, 6, 0, 0, 1, a.put([0, 0xffffffff]), { fuel: Infinity }, 10, [3]),
      ),
    );
    assert.equal(got.m[0], 0);
    assert.equal(got.m[2], 0);
    assert.equal(got.m[12], 2);
    assert.equal(got.resumes, 3);
    assert.equal(fromFloatWords(got.m.slice(4, 6)), Infinity);
    checks++;
  }
  {
    const { a, ir } = fresh();
    const literals = a.put([
      1, 7, 0, 0, 0, 1, 2, 1, 0, 0, 0, 4, 3, 0, 0, 2, 0, 7, 4, 0, 2, 2, 0, 12,
    ]);
    const children = a.put([0, 1, 2, 0]);
    const got = native.decode(
      native.invoke(
        native.packet(a, ir.state, 3, 0, 0, 0, [0, 0, 0], { fuel: 10000 }, 1, [
          ...literals,
          ...children,
        ]),
      ),
    );
    assert.equal(got.m[0], 0);
    const map = got.arena.get(Array.from(got.m.slice(56, 59)));
    assert.deepEqual(valueOut(got.arena, map[6], map[7]), [[7, true], 7]);
    checks++;
  }
  {
    const { a, ir } = fresh(),
      literals = a.put([3, 0, 0, 1, 0, 1]),
      children = a.put([0]);
    const got = native.decode(
      native.invoke(
        native.packet(a, ir.state, 3, 0, 0, 0, [0, 0, 0], { fuel: 10000 }, 1, [
          ...literals,
          ...children,
        ]),
      ),
    );
    assert.equal(got.m[0], 9);
    assert.equal(got.m[1], 790);
    checks++;
  }
  for (const [av, bv, want] of [
    [[[7, true], 9], [[7, true], 9], 1],
    [[[7, true], 9], [[7, false], 9], 0],
    [[1, 2], [1], 0],
    [true, 1, 0],
  ]) {
    const { a, ir } = fresh();
    const got = native.decode(
      native.invoke(
        native.packet(a, ir.state, 4, 0, 0, 0, [0, 0, 0], { fuel: 10000 }, 1, [
          ...inputValue(a, av),
          ...inputValue(a, bv),
        ]),
      ),
    );
    assert.equal(got.m[0], 0);
    assert.equal(got.m[21], want);
    checks++;
  }
  for (const [args, want] of [
    [[9, 9], true],
    [[9, 10], false],
  ]) {
    const { a, ir } = fresh(
      'fn compare u32 u32 -> bool\nr eq p0 p1\nret r\nend\nfn body u32 -> u32\nr add p0 1\nret r\nend\nfn later u32 -> u32\nr call body p0\nret r\nend',
    );
    // Current body is checked; the later function remains unpublished/untyped.
    ir.state[98] = 2;
    ir.state[101] = 4;
    const node = [700, 19, 0, 2, 123, 0xffffffff, 99, 20, 4, 24, 7, 0, 0, 0];
    const operands = a.put([1, 0, 0, 0, 0, 1, 1, 0, 0, 0]),
      params = a.put([0, 0]),
      av = a.put(args.flatMap((v) => [0, v]));
    const original = a.heap.map((block) => block && Array.from(block));
    const got = native.decode(
      native.invoke(
        native.packet(a, ir.state, 5, 0, 0, 0, av, { fuel: 10000 }, 1, [
          1,
          ...node,
          ...operands,
          ...params,
          0,
          0xffffffff,
        ]),
      ),
    );
    assert.equal(got.m[0], 0);
    assert.equal(got.m[10] !== 0, want);
    assert.equal(fromFloatWords(got.m.slice(4, 6)), 9996);
    for (let i = 1; i < original.length; i++)
      assert.deepEqual(Array.from(got.arena.heap[i]), original[i]);
    checks++;
  }
  // Valid semantic mutations demonstrate oracle sensitivity without pretending
  // they are compiler-code mutations or changing the compiled module.
  for (const route of routes) {
    const changed = sum.replace('fold sum 9', 'fold sum 8');
    const got = native.execute(changed, 'root', [], { fuel: 10000 }, route);
    assert.equal(got.value, 28);
    assert.throws(() => assert.equal(got.value, 36));
    checks++;
  }
}
const groups = { core, 'budgets-io': budgetsIo, capacity, boundaries };
assert.ok(Object.hasOwn(groups, group), group);
groups[group]();
assert.ok(checks > 0 && native.requests() > 0);
console.log(JSON.stringify({ group, checks, nativeRequests: native.requests() }));
