import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { runTool } from '../../../dist/src/toolchain.js';

const root = process.argv[2];
assert.ok(root);
const group = process.argv[3];
assert.ok(group === 'core' || group === 'capacity');
const mo = [32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 71, 74, 97, 100, 103, 106];
const ds = [16, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46];
const ops = [
  '',
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
  'select',
  'call',
  'fold',
  'loop',
  'arr',
  'rec',
  'text',
  'get',
  'set',
  'at',
  'put',
  'read',
  'write',
  'puts',
  'cadd',
  'csub',
  'cmul',
  'cdiv',
  'crem',
  'cget',
];
let assertions = 0;
function equal(a, b, msg) {
  assert.deepEqual(a, b, msg);
  assertions++;
}
function decode(b) {
  let at = 0;
  const word = () => {
    assert.ok(at + 4 <= b.length);
    const n = b.readUInt32LE(at);
    at += 4;
    return n;
  };
  const take = (n) => Array.from({ length: n }, word),
    vec = () => take(word());
  const status = word(),
    pumps = word(),
    v = take(128),
    q = take(128),
    m = take(128),
    mt = new Map(mo.map((o) => [o, vec()])),
    symbols = Array.from({ length: word() }, () =>
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(vec())),
    ),
    c = take(16),
    d = take(128),
    dt = new Map(ds.map((o) => [o, vec()])),
    snapshot = word() ? take(128) : undefined,
    linkSnapshot = word() ? take(128) : undefined,
    intact = word(),
    controls = word();
  equal(at, b.length);
  return {
    status,
    pumps,
    v,
    q,
    m,
    mt,
    symbols,
    c,
    d,
    dt,
    snapshot,
    linkSnapshot,
    intact,
    controls,
  };
}
function check(g, source) {
  equal(g.intact, 1);
  equal(g.v[1], 1);
  equal(g.v[2], 1);
  equal(g.d[0], g.status);
  equal(g.d[1], 1093681731);
  equal(g.d[2], 1);
  if (g.status) {
    equal(g.c, Array(16).fill(0));
    equal(g.d.slice(3, 112), Array(109).fill(0));
    for (const a of g.dt.values()) equal(a, []);
    equal(g.snapshot, undefined);
    return;
  }
  const p = parseAndValidate(source),
    M = (o) => g.mt.get(o),
    D = (o) => g.dt.get(o),
    row = (a, n, i) => a.slice(n * i, n * (i + 1));
  equal(g.q[0], 0);
  equal(g.q[1], 11);
  equal(g.m[0], 0);
  equal(g.m[93], 1);
  equal(g.m[96], 1);
  equal(g.snapshot, g.m);
  equal(g.linkSnapshot, undefined);
  equal(g.c.slice(6, 11), [0, 0, 0, 0, 0]);
  equal(g.c.slice(14), [0, 0]);
  equal(
    g.c.slice(0, 6),
    [16, 19, 22, 25, 28, 31].map((o) => g.d[o]),
  );
  equal(g.c.slice(11, 14), [g.d[9], g.d[11], g.d[10]]);
  equal(g.d[9], p.functions.length);
  equal(
    g.d[10],
    p.functions.reduce((n, f) => n + f.nodes.length, 1),
  );
  equal(g.d[11], M(68).length / 5);
  equal(g.d[12], D(28).length / 2);
  equal(g.d[13], D(31).length);
  equal(g.d[8], p.profile === 'strict' ? 1 : 0);
  equal(g.d[6], g.m[6]);
  equal(g.d[7], Buffer.byteLength(source));
  equal(D(25).slice(0, 8), Array(8).fill(0));
  equal(D(28).slice(0, 6), [3, 0, 3, 0, 3, 0]);
  equal(D(40).slice(0, 14), [...Array(5).fill(4294967295), ...Array(9).fill(0)]);
  equal(D(43).slice(0, 12), [4294967295, 0, 0, 0, 4294967295, 0, 0, 0, 4294967295, 0, 0, 0]);
  const pool = D(31);
  const name = (off, len) =>
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      Uint8Array.from(pool.slice(off, off + len)),
    );
  let nameOffset = 0;
  for (let i = 0; i < g.symbols.length; i++) {
    const sp = row(D(34), 2, i);
    equal(sp, [nameOffset, Buffer.byteLength(g.symbols[i])]);
    equal(name(...sp), g.symbols[i]);
    nameOffset += sp[1];
  }
  equal(nameOffset, pool.length);
  const tc = new Map();
  const type = (id) => {
    if (tc.has(id)) return tc.get(id);
    const r = row(D(16), 3, id);
    let t;
    if (r[0] <= 3) {
      t = ['', 'u32', 'bool', 'io'][r[0]];
    } else if (r[0] === 4) t = { kind: 'arr', length: r[1], elem: type(r[2]) };
    else {
      equal(r[0], 5);
      t = {
        kind: 'rec',
        fields: D(19)
          .slice(r[1], r[1] + r[2])
          .map(type),
      };
    }
    tc.set(id, t);
    return t;
  };
  for (let i = 0; i < g.d[11]; i++) {
    const a = row(M(68), 5, i),
      expected = a[0] === 3 ? [4, a[2], a[1]] : a[0] === 4 ? [5, a[1] + 1, a[2]] : [a[0] + 1, 0, 0];
    equal(row(D(16), 3, i), expected);
    equal(row(D(46), 2, i), a.slice(3, 5));
  }
  equal(D(19).slice(0, M(71).length + 1), [0, ...M(71)]);
  let global = 1,
    argFirst = 3,
    paramFirst = 1 + M(71).length;
  for (let fi = 0; fi < p.functions.length; fi++) {
    const f = p.functions[fi],
      fr = row(D(22), 10, fi),
      fm = row(M(41), 14, fi),
      bounds = row(M(103), 3, fi),
      rawFn = row(D(37), 12, fi);
    equal(name(fr[0], fr[1]), f.name);
    equal(fr.slice(2, 7), [f.params.length, paramFirst, fm[3], global, f.nodes.length]);
    equal(
      D(19)
        .slice(paramFirst, paramFirst + f.params.length)
        .map(type),
      f.params,
    );
    equal(D(19)[paramFirst + f.params.length], 0);
    equal(type(fr[4]), f.result);
    equal(fr[9], p.profile === 'strict' ? 1 : 0);
    equal(rawFn, [fi, fm[0], fm[7], fm[8], fm[9], fm[6], ...bounds, fr[9], fm[12], fm[13]]);
    equal(bounds[0], f.literalIterations);
    const ieee = new DataView(new ArrayBuffer(8));
    ieee.setFloat64(0, f.staticIterations, true);
    if (Number.isNaN(f.staticIterations)) {
      assert.ok(
        (bounds[2] & 2146435072) === 2146435072 && ((bounds[2] & 1048575) !== 0 || bounds[1] !== 0),
      );
      assertions++;
    } else equal(bounds.slice(1), [ieee.getUint32(0, true), ieee.getUint32(4, true)]);
    const ids = new Map();
    const operand = (k, v) =>
      k === 1
        ? { kind: 'node', id: g.symbols[row(M(44), 14, v - 1)[0]] }
        : k === 2
          ? { kind: 'param', index: v }
          : k === 3
            ? { kind: 'u32', value: v }
            : { kind: 'bool', value: v !== 0 };
    for (let local = 0; local < f.nodes.length; local++, global++) {
      const n = f.nodes[local],
        r = row(D(25), 8, global),
        mr = row(M(44), 14, global - 1),
        effects = row(M(106), 2, global - 1),
        refs = row(M(100), 2, global - 1),
        meta = row(D(40), 14, global);
      equal(name(r[6], r[7]), n.id);
      equal(ops[r[0]], n.op);
      equal(r[1], n.args.length);
      equal(r[2], argFirst);
      equal(type(r[5]), f.types.get(n.id));
      equal(
        r.slice(3, 5),
        refs.map((x) => (x === 4294967295 ? 0 : x)),
      );
      equal(r[5], M(97)[global - 1]);
      if (n.callee !== undefined) equal(p.functions[r[3]].name, n.callee);
      if (n.pred !== undefined) equal(p.functions[r[4]].name, n.pred);
      equal(meta, [global - 1, fi, local, mr[0], ...mr.slice(6, 14), ...effects]);
      const args = [];
      for (let j = 0; j < Math.max(3, n.args.length); j++) {
        const ar = row(D(28), 2, argFirst + j),
          am = row(D(43), 4, argFirst + j);
        if (j < n.args.length) {
          const original = mr[2] + j,
            ma = row(M(47), 5, original);
          args.push(operand(ar[0], ar[1]));
          equal(am, [original, ...ma.slice(2, 5)]);
          if (ma[0] === 0) equal(ar, [1, ids.get(g.symbols[ma[1]])]);
          else equal(ar, [ma[0] + 1, ma[1]]);
        } else {
          equal(ar, [3, 0]);
          equal(am, [4294967295, 0, 0, 0]);
        }
      }
      equal(args, n.args);
      ids.set(n.id, global);
      argFirst += Math.max(3, n.args.length);
    }
    equal(operand(fr[7], fr[8]), f.ret);
    const mr = row(M(47), 5, fm[6]);
    if (mr[0] === 0) equal(fr.slice(7, 9), [1, ids.get(g.symbols[mr[1]])]);
    else equal(fr.slice(7, 9), [mr[0] + 1, mr[1]]);
    paramFirst += f.params.length + 1;
  }
  equal(global, g.c[13]);
  equal(argFirst, g.d[12]);
  equal(paramFirst, D(19).length);
  equal(D(22).length, g.c[11] * 10);
  equal(D(25).length, g.c[13] * 8);
  equal(D(37).length, g.c[11] * 12);
  equal(D(40).length, g.c[13] * 14);
  equal(D(43).length, g.d[12] * 4);
}
const cases = [
  { name: 'empty', source: '' },
  {
    name: 'scalar-all-literal-kinds',
    source: `fn f u32 bool -> (u32,bool)
x add p0 4294967295
y select p1 false true
r rec x y
ret r
end
`,
    controls: true,
  },
  {
    name: 'arrays-records-calls-fold-loop',
    source: `fn step (u32x4,u32) u32 u32 -> (u32x4,u32)
a at p0 0
b set a p1 p2
n at p0 1
k add n 1
r rec b k
ret r
end
fn more (u32x4,u32) u32 u32 -> bool
ret lt p1 p2
end
fn f u32x4 u32 bool -> (u32x4,u32)
p rec p0 7
a fold step 3 p p1
b loop more step 4 a p1
c call step b 0 p1
r select p2 b c
ret r
end
`,
  },
  {
    name: 'checked-six',
    source: `fn f u32 u32 -> ((u32,bool),(u32,bool),(u32,bool),(u32,bool),(u32,bool),(u32,bool))
a cadd p0 p1
b csub p0 p1
c cmul p0 p1
d cdiv p0 p1
e crem p0 p1
v arr 7 9
g cget v p0
r rec a b c d e g
ret r
end
`,
  },
  {
    name: 'text-hygiene-unicode-origins',
    source: `# λ\uD83D\uDE00
fn f u32 -> u32
retval mov p0
retval2 add retval 1
t text "λ\uD83D\uDE00\\n\\t\\\\\\"#"
g get t p0
ret add retval2 g
end
`,
  },
  {
    name: 'strict-original-traps',
    source: `profile strict
fn risky u32x4 u32 -> u32
g get p0 p1
x div g p1
ret x
end
`,
  },
  {
    name: 'io-linear-projections',
    source: `fn f io -> (u32,io)
r read p0
x at r 0
t at r 1
u write t x
z rec x u
ret z
end
`,
  },
  {
    name: 'ordered-spec-success',
    source: `fn f u32 -> u32
ex 1 -> 2
pre lt p0 10
post gt r p0
x add p0 1
ret x
end
`,
  },
  {
    name: 'ordered-spec-failure',
    source: `fn f u32 -> u32
ex 1 -> 3
x add p0 1
ret x
end
`,
    status: 8,
  },
  {
    name: 'strict-spec-trap',
    source: `profile strict
fn f u32 -> u32
ex 0 -> 0
x div 1 p0
ret x
end
`,
    status: 8,
  },
  {
    name: 'type-failure',
    source: `fn f u32 -> bool
ret p0
end
`,
    status: 8,
  },
  {
    name: 'checked-bool-refusal',
    source: `fn f -> (bool,bool)
v arr true false
g cget v 0
ret g
end
`,
    status: 8,
  },
  {
    name: 'malformed-spec-precedes-body',
    source: `fn f u32 -> u32
ex bad
x add 1
ret 0
end
`,
    status: 6,
  },
  {
    name: 'unit-import-explicit-refusal',
    source: `use "missing.a0"
fn f -> u32
ret 0
end
`,
    status: 7,
  },
  {
    name: 'wide-signatures',
    source: `fn f u32x65536 boolx65536 -> boolx65536
ret p1
end
`,
  },
  {
    name: 'full-pool-and-source-spans',
    source:
      '#' +
      'c'.repeat(131073) +
      `
` +
      Array.from(
        { length: 1100 },
        (_, i) => `fn ${('f' + i).padEnd(64, 'a')} u32 -> u32
ret p0
end
`,
      ).join('') +
      `fn last u32 -> u32
` +
      'n'.repeat(64) +
      ` add p0 1
ret ` +
      'n'.repeat(64) +
      `
end
`,
    capacity: true,
  },
  {
    name: '9000-functions-and-types',
    source: Array.from(
      { length: 9000 },
      (_, i) => `fn f${i} u32x${i + 1} -> u32x${i + 1}
ret p0
end
`,
    ).join(''),
    capacity: true,
  },
  {
    name: '70017-array-operands',
    source: `fn f -> bool
x arr ${Array(70017).fill('false').join(' ')}
y get x 70016
ret y
end
`,
    capacity: true,
  },
  {
    name: '70017-record-children',
    source: `fn f -> bool
x rec ${Array(70017).fill('false').join(' ')}
y at x 70016
ret y
end
`,
    capacity: true,
  },
  {
    name: '69632-global-nodes-and-scope-reuse',
    source: Array.from(
      { length: 17 },
      (_, f) =>
        `fn f${f} u32 -> u32
` +
        Array.from(
          { length: 4096 },
          (_, i) => `n${i} add ${i ? 'n' + (i - 1) : 'p0'} ${i}
`,
        ).join('') +
        `ret n4095
end
`,
    ).join(''),
    capacity: true,
  },
  {
    name: 'exact-2MiB',
    source:
      '#'.padEnd(
        2097152 -
          Buffer.byteLength(`
fn f -> u32
ret 0
end
`),
        'c',
      ) +
      `
fn f -> u32
ret 0
end
`,
    capacity: true,
  },
  { name: 'over-2MiB', source: ' '.repeat(2097153), status: 6, capacity: true },
  ...[256, 512, 768, 896, 1024].map((budget) => ({
    name: 'allocation-' + budget,
    source: `fn f u32 -> u32
x add p0 1
ret x
end
`,
    // The unused token table is gone: 896 words now suffice; smaller controls still fail.
    status: budget >= 896 ? 0 : 4,
    budget,
  })),
];
cases.push({
  name: 'exact-static-ieee-infinity-nan',
  source:
    `fn step u32 u32 -> u32
ret p0
end
` +
    Array.from(
      { length: 34 },
      (_, i) => `fn f${i} u32 u32 u32 -> u32
x fold ${i ? 'f' + (i - 1) : 'step'} p2 p0${i ? ' p2' : ''}
ret x
end
`,
    ).join('') +
    `fn last u32 -> u32
x fold f33 0 p0 0
ret x
end
`,
});
const report = [];
for (const level of [0, 2])
  for (const c of cases) {
    if ((group === 'capacity') !== Boolean(c.capacity)) continue;
    if (level === 0 && c.capacity) continue;
    const sourcefile = root + '/source.bin',
      out = root + '/output.bin';
    await writeFile(sourcefile, c.source);
    const quantum = level === 0 ? 1 : 7;
    const r = runTool(
      root + `/driver-O${level}`,
      [
        sourcefile,
        out,
        String(quantum),
        String(c.budget ?? 1e8),
        c.controls ? '1' : '0',
        '2000000',
      ],
      { timeoutMs: 240000 },
    );
    assert.ok(r.ok, `O${level} ${c.name}: ${r.stderr}`);
    const g = decode(await readFile(out));
    equal(
      g.status,
      c.status ?? 0,
      `O${level} ${c.name}: diag${g.m[1]} reason${g.m[5]} adapter${g.d[112]}/${g.d[113]}`,
    );
    check(g, c.source);
    report.push({
      name: c.name,
      level,
      bytes: Buffer.byteLength(c.source),
      pumps: g.pumps,
      status: g.status,
      functions: g.c[11],
      types: g.c[12],
      nodes: g.c[13],
      controls: g.controls,
    });
    console.log('PASS', level, c.name, g.status, g.c.slice(11, 14).join('/'));
  }
await writeFile(
  root + '/results-' + group + '.json',
  JSON.stringify(
    {
      assertions,
      report,
      note: 'Actual verified seed emission; all grammar/check/spec/lowering decisions are A0. TypeScript is an independent typed-source/metadata oracle only. Native runtime is generic word storage. No production route enabled.',
    },
    null,
    2,
  ) +
    `
`,
);
