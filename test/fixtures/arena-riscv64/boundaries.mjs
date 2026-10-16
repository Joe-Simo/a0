import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { cases } from '../arena-spec-verifier/cases.mjs';
import { emitProgram, emitSource, invokePacket, ROOT, sourcePacket } from './transport.mjs';

const reports = [],
  source = 'fn f u32 -> u32\nr add p0 1\nret r\nend\n';
function check(r, want, name) {
  assert.equal(r.status, want, r.stderr);
  assert.equal(r.meta?.code, want, name);
  if (want) assert.equal(r.text, '', name);
  reports.push({
    name,
    code: r.status,
    pending: r.meta.pending,
    pumps: r.meta.pumps,
    diagnostic: r.meta.checked?.[1],
  });
}
for (const t of cases.filter((t) => !t.heavy)) {
  const want = t.status,
    r = emitSource(t.source, { quantum: 7 });
  check(r, want, t.name);
  if (t.status !== 0) assert.equal(r.meta.verifier[0], t.status);
}
for (const [name, s, want] of [
  ['unit-import', 'use "dep.a0"\nfn f -> u32\nret 0\nend\n', 7],
  ['grammar-before-import', 'use "dep.a0"\nfn f -> u32\nret 0\nend\nbad\n', 6],
  ['overflow-u32', 'fn f -> u32\nret 4294967296\nend\n', 6],
  ['leading-zero', 'fn f -> u32\nret 01\nend\n', 6],
])
  check(emitSource(s), want, name);
for (const flags of [
  { strict: 1 },
  { options: 1 },
  { platform: 1 },
  { input: 16777217 },
  { output: 16777217 },
])
  for (const mode of ['source', 'table'])
    check(
      mode === 'source' ? emitSource(source, flags) : emitProgram(parseAndValidate(source), flags),
      6,
      `${mode}-unsupported-${JSON.stringify(flags)}`,
    );
for (const flags of [{ budget: 1000 }, { maxOutput: 1 }, { maxOutput: 200 }])
  check(emitSource(source, flags), 4, `resource-${JSON.stringify(flags)}`);
const pending = emitSource(source, { quantum: 0, maxPumps: 1 });
check(pending, 7, 'zero-quantum-pending');
assert.equal(pending.meta.pending, true);
assert.equal(pending.meta.verifier[0], 0);
assert.notEqual(pending.meta.verifier[1], 11);
const completed = emitSource(source, { quantum: 1 });
check(completed, 0, 'quantum1-resumes-through-completion');
assert.equal(completed.meta.pending, false);
assert.equal(completed.meta.verifier[1], 11);
const prefix = 'fn f -> u32\nret 9\nend\n#';
for (const n of [131072, 131073, 2097152, 2097153]) {
  const r = emitSource(prefix + 'x'.repeat(n - prefix.length));
  check(r, n > 2097152 ? 6 : 0, `raw-source-bytes${n}`);
  if (n > 2097152) assert.equal(r.meta.checked[1], 16);
}
const noDescriptor = emitProgram(parseAndValidate(`profile strict\n${source}`));
check(noDescriptor, 6, 'strict-table-requires-original-descriptor');
const strictIo = emitSource('profile strict\nfn f io -> io\nret p0\nend\n');
check(strictIo, 6, 'explicit-strict-IO-refusal');
const frame = sourcePacket(source),
  faults = [
    ['truncated-word', frame.subarray(0, frame.length - 1)],
    ['truncated-tag', frame.subarray(0, frame.length - 4)],
    ['truncated-source', frame.subarray(0, frame.length - 12)],
    ['trailing-word', Buffer.concat([frame, Buffer.alloc(4)])],
  ];
for (const [name, mutate] of [
  ['declared-source-length', (b) => b.writeUInt32LE(source.length + 1, 13 * 4)],
  ['out-of-range-byteword', (b) => b.writeUInt32LE(256, 14 * 4)],
  ['bad-completion-tag', (b) => b.writeUInt32LE(0, b.length - 4)],
  ['payload-word-count', (b) => b.writeUInt32LE(1, 12 * 4)],
]) {
  const b = Buffer.from(frame);
  mutate(b);
  faults.push([name, b]);
}
for (const [name, p] of faults) {
  const r = invokePacket(p);
  assert.equal(r.status, 91, r.stderr);
  assert.equal(r.text, '');
  assert.equal(r.meta, undefined);
  reports.push({ name, code: r.status, bytesPublished: 0 });
}
await writeFile(
  `${ROOT}/control-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual native A0 source service, protocol/resource/grammar/spec/pending/options controls; all failures atomically zero stdout',
      reports,
    },
    null,
    2,
  )}\n`,
);
console.log(reports.length, 'native ordered-source/protocol/resource controls passed');
