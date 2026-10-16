import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runTool } from '../../../dist/src/toolchain.js';
import { cases } from './cases.mjs';
import { compare, fixture, los, mos } from './harness.mjs';

const b = process.argv[2],
  group = process.argv[3],
  report = [];
assert.ok(b);
assert.ok(group === 'sources' || group === 'resources');
function decode(buf) {
  let at = 0;
  const word = () => {
      assert.ok(at + 4 <= buf.length);
      const n = buf.readUInt32LE(at);
      at += 4;
      return n;
    },
    take = (n) => Array.from({ length: n }, word),
    vec = () => take(word()),
    text = () => Buffer.from(vec()).toString('utf8');
  const pumps = word(),
    s = take(128),
    v = take(128),
    m = take(128),
    p = take(128),
    binding = take(128),
    em = take(128),
    ae = take(128),
    l = take(128),
    lt = new Map(los.map((o) => [o, vec()])),
    mt = new Map(mos.map((o) => [o, vec()])),
    files = Array.from({ length: word() }, () => ({ row: take(12), path: text(), source: vec() })),
    symbols = Array.from({ length: word() }, text),
    fragments = vec(),
    path = text(),
    readsLow = word(),
    readsHigh = word();
  assert.equal(at, buf.length);
  return {
    pumps,
    s,
    v,
    m,
    p,
    b: binding,
    em,
    ae,
    l,
    lt,
    mt,
    files,
    symbols,
    fragments,
    path,
    reads: files.map((f) => f.path),
    readCalls: BigInt(readsLow) + (BigInt(readsHigh) << 32n),
  };
}
for (let index = 0; index < cases.length; index++) {
  if (group !== 'sources') continue;
  const item = cases[index],
    f = await fixture(b + '/fixtures/' + index, item);
  for (const quantum of [1, 7]) {
    const out = b + '/output.bin',
      ran = runTool(
        b + '/driver',
        [f.entry, f.root, String(item.override ?? 0), String(quantum), '100000000', out],
        { timeoutMs: 240000 },
      );
    assert.ok(ran.ok, item.name + ': ' + ran.stderr);
    const got = decode(await readFile(out));
    assert.equal(
      got.readCalls,
      BigInt(f.reads.length),
      item.name + ' actual filesystem READFILE count',
    );
    report.push({ ...compare(got, item, f), quantum, pumps: got.pumps });
  }
  console.log('PASS', item.name);
}
const resourceFixture = await fixture(b + '/resource-fixture', cases[0]),
  resources = [];
for (const budget of group === 'resources'
  ? [1000, 2000, 4000, 6000, 8000, 16000, 32000, 64000]
  : []) {
  const out = b + '/resource-output.bin',
    ran = runTool(
      b + '/driver',
      [resourceFixture.entry, resourceFixture.root, '0', '7', String(budget), out],
      { timeoutMs: 240000 },
    );
  assert.ok(ran.ok, ran.stderr);
  const g = decode(await readFile(out));
  assert.ok([0, 4].includes(g.s[0]));
  assert.equal(g.s[18], g.s[0] === 0 ? 1 : 0);
  resources.push({
    budget,
    status: g.s[0],
    verified: g.s[18],
    linkStatus: g.l[0],
    metadataIO: g.s[28],
    originalSelected: g.s[29],
    verifierPhase: g.v[1],
    pumps: g.pumps,
  });
}
if (group === 'resources') {
  assert.ok(resources.some((r) => r.status === 4 && r.linkStatus === 4));
  assert.ok(resources.some((r) => r.status === 4 && r.linkStatus === 0));
  assert.ok(resources.some((r) => r.status === 0));
}
await writeFile(
  b + '/results-' + group + '.json',
  JSON.stringify(
    {
      note: 'One coherent verified-seed A0 native build at O2 ASan+UBSan/Werror. OS-only host filesystem plus generic arena storage; all graph/grammar/verification/origin policy executes in A0. TS link is an independent oracle. C verifies zero-quantum/terminal stability, unchanged IO bytes and completed drained FINISH with zero allocations.',
      report,
      resources,
    },
    null,
    2,
  ) + '\n',
);
console.log('native requests passed', report.length, 'resources', resources.length);
