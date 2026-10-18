import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { CHECKED_SOURCE, checkedCases } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import { cases as specs } from '../arena-spec-verifier/cases.mjs';
import { INPUTS } from '../arena-wasm/alias-models.mjs';
import { verifyLife } from './life.mjs';
import { scalarMain, target } from './target.mjs';
import { compileSource, ROOT } from './transport.mjs';

const report = {
  status: 'running',
  scope:
    'Verified-seed native A0 raw-source C service; verbatim target C at O0/O2 UBSan; independent integer and immutable-value oracles.',
  rows: [],
};
const U = (x) => Number(BigInt.asUintN(32, BigInt(x)));
function checkSpec(item, r) {
  assert.equal(r.code, item.status, item.name);
  assert.equal(r.v[0], item.status, item.name);
  assert.equal(r.v[1], 11, item.name);
  assert.equal(r.m[1], item.id ?? 0, item.name);
  if (item.kind) assert.equal(r.v[14], item.kind, item.name);
  if (item.reason) assert.equal(r.binding[2], item.reason, item.name);
  if (item.underlying !== undefined) assert.equal(r.v[13], item.underlying, item.name);
  if (item.line) assert.equal(r.v[21], item.line, item.name);
  if (item.input !== undefined) assert.equal(r.v[23], item.input, item.name);
  if (item.ex) assert.equal(r.v[3] + 1, item.ex, item.name);
  const visited = item.status === 6 ? 0 : r.v[2] + (r.v[0] ? 1 : 0);
  if (item.visited !== undefined) assert.equal(visited, item.visited, item.name);
}
try {
  const specResults = new Map();
  for (const item of specs.filter((f) => !f.heavy)) {
    const r = compileSource(item.nativeSource ?? item.source);
    checkSpec(item, r);
    specResults.set(item.name, r);
    report.rows.push({ name: item.name, code: r.code, status: 'passed' });
  }
  const scheduled = specs.find((f) => f.name === 'matching-pre-post'),
    q1 = compileSource(scheduled.source, { quantum: 1 }),
    q97 = specResults.get(scheduled.name);
  checkSpec(scheduled, q1);
  assert.deepEqual(q1.bytes, q97.bytes);
  assert.ok(q1.pendingChecks > 0 && q1.resumes > q97.resumes);
  target(q1, scalarMain([{ functionName: 'f', args: [7], expected: 7 }]));
  for (const name of ['earlier-value-before-later-body', 'whole-parse-before-earlier-value']) {
    const item = specs.find((f) => f.name === name),
      slow = compileSource(item.nativeSource ?? item.source, { quantum: 1 }),
      fast = specResults.get(name);
    checkSpec(item, slow);
    assert.deepEqual(slow.bytes, fast.bytes);
    assert.deepEqual(
      [slow.m[1], slow.binding[2], ...[0, 1, 2, 3, 12, 13, 14, 21, 23].map((i) => slow.v[i])],
      [fast.m[1], fast.binding[2], ...[0, 1, 2, 3, 12, 13, 14, 21, 23].map((i) => fast.v[i])],
      'quantum leaves ordered first failure unchanged',
    );
  }
  report.rows.push({
    name: 'pending results and quantum-independent spec emission/failures',
    status: 'passed',
  });

  const compact = compileSource(`fn twice
ret << A 1
end
fn probe
x twice A
y [x*3]
z get y B
ret add z 4294967295
end
`);
  target(
    compact,
    scalarMain(
      INPUTS.map(([a, b]) => ({
        functionName: 'probe',
        args: [a, b],
        expected: U(BigInt(a) * 2n - 1n),
      })),
    ),
  );
  report.rows.push({
    name: 'compact inferred signatures/direct calls/repeats/inline operations',
    cases: INPUTS.length,
    status: 'passed',
  });

  for (const strict of [false, true]) {
    const r = compileSource((strict ? 'profile strict\n' : '') + CHECKED_SOURCE),
      cases = checkedCases();
    target(r, scalarMain(cases));
    report.rows.push({
      name: `checked operations strict=${strict}`,
      cases: cases.length,
      status: 'passed',
    });
  }

  const operations = [
    ['add', (a, b) => U(a + b)],
    ['sub', (a, b) => U(a - b)],
    ['mul', (a, b) => U(a * b)],
    ['and', (a, b) => U(a & b)],
    ['or', (a, b) => U(a | b)],
    ['xor', (a, b) => U(a ^ b)],
    ['shl', (a, b) => U(a << (b & 31n))],
    ['shr', (a, b) => U(a >> (b & 31n))],
    ['div', (a, b) => (b ? U(a / b) : 0xffffffff)],
    ['rem', (a, b) => (b ? U(a % b) : U(a))],
    ['eq', (a, b) => Number(a === b)],
    ['ne', (a, b) => Number(a !== b)],
    ['lt', (a, b) => Number(a < b)],
    ['le', (a, b) => Number(a <= b)],
    ['gt', (a, b) => Number(a > b)],
    ['ge', (a, b) => Number(a >= b)],
  ];
  const scalar = compileSource(
    operations
      .map(
        ([name], i) =>
          `fn f${i} u32 u32 -> ${i < 10 ? 'u32' : 'bool'}\nv ${name} p0 p1\nret v\nend\n`,
      )
      .join(''),
  );
  const pairs = [
      ...INPUTS,
      [0, 0xffffffff],
      [0xffffffff, 0],
      [0x80000000, 31],
      [0x80000000, 32],
      [0x80000000, 33],
    ],
    arithmetic = operations.flatMap(([, model], i) =>
      pairs.map((args) => ({ functionName: `f${i}`, args, expected: model(...args.map(BigInt)) })),
    );
  target(scalar, scalarMain(arithmetic));
  report.rows.push({
    name: 'unsigned arithmetic/masked shifts/total divzero',
    cases: arithmetic.length,
    status: 'passed',
  });

  const aggregates = compileSource(
      await readFile(new URL('../arena-wasm/sources/aggregates.a0', import.meta.url), 'utf8'),
    ),
    aggregateCases = INPUTS.flatMap((args) => {
      const [a, b] = args.map(BigInt);
      let v = [a, b],
        sum = 0n;
      for (let i = 0; i < 3; i++) {
        const index = i % 2,
          old = v[index];
        v = [...v];
        v[index] = BigInt(U(old + b));
        sum = BigInt(U(sum + old));
      }
      return [
        { functionName: 'nested', args, expected: U(a * 31n + b) },
        { functionName: 'probe', args, expected: U(a * 31n + v[0] + sum) },
      ];
    });
  target(aggregates, scalarMain(aggregateCases));
  report.rows.push({
    name: 'nested aggregate calls/loop/immutable snapshots',
    cases: aggregateCases.length,
    status: 'passed',
  });

  const io = compileSource(
    await readFile(new URL('../arena-wasm/sources/io.a0', import.meta.url), 'utf8'),
    { input: 2, output: 4 },
  );
  target(
    io,
    `int main(void) {
    const uint32_t counts[] = {0u, 1u, 2u, 9u};
    for (uint32_t i = 0; i < 4; i++) {
      a0_io io = {0}; io.input[0] = UINT32_MAX; io.input[1] = 2; io.ninput = counts[i];
      uint32_t value = a0_effect(&io), n = counts[i] < 2 ? counts[i] : 2;
      assert(value == (n == 2 ? UINT32_MAX - 1 : 0));
      const uint32_t expected[] = {value, n == 2 ? 0u : 1u, 3u, 65u};
      assert(io.position == n && io.ninput == counts[i] && io.noutput == 4);
      assert(memcmp(io.output, expected, sizeof expected) == 0);
    }
  }`,
  );
  target(
    io,
    `int main(void) {
    a0_io streams[3] = {0};
    for (uint32_t n = 0; n < 3; n++) {
      a0_io *io = streams + n; expected_token = io;
      io->input[0] = UINT32_MAX; io->input[1] = 2; io->count = n; io->tag = 123456789u;
      uint32_t value = a0_effect(io);
      const uint32_t expected[] = {n == 2 ? UINT32_MAX - 1 : 0u, n == 2 ? 0u : 1u, 3u, 65u, 0u, 255u};
      assert(value == expected[0] && io->reads == 2 && io->position == n && io->writes == 6);
      assert(io->tag == 123456789u && memcmp(io->output, expected, sizeof expected) == 0);
    }
  }`,
    `struct a0_io { uint32_t input[2], count, position, reads, output[8], writes, tag; };
static struct a0_io *expected_token;
static bool host_read(struct a0_io *t, uint32_t *out) {
  assert(t == expected_token && t->tag == 123456789u); t->reads++;
  if (t->position == t->count) { *out = 3735928559u; return false; }
  *out = t->input[t->position++]; return true;
}
static void host_write(struct a0_io *t, uint32_t value) {
  assert(t == expected_token && t->tag == 123456789u && t->writes < 8);
  t->output[t->writes++] = value;
}
#define A0_IO_READ(t, out) host_read((t), (out))
#define A0_IO_WRITE(t, value) host_write((t), (value))`,
  );
  report.rows.push({
    name: 'raw-source host hooks and buffered EOF/capacity/exact-once effects',
    cases: 7,
    status: 'passed',
  });
  report.rows.push(await verifyLife());
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
}
await writeFile(`${ROOT}/results.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({ status: report.status, rows: report.rows.length, error: report.error }, null, 2),
);
process.exitCode = report.status === 'passed' ? 0 : 1;
