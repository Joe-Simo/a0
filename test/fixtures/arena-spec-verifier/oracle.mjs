// Source bytes go straight to native A0. The TS compiler is an independent oracle.
// This file contains only binary framing, storage inspection and assertions.
import assert from 'node:assert/strict';
import { A0Error, LIMITS, parseAndValidate } from '../../../dist/src/core.js';
import { spawnWithInput } from '../../../dist/src/toolchain.js';
import { cases, simple } from './cases.mjs';

const [exe, group] = process.argv.slice(2);
assert.ok(exe);
let requests = 0;
function invoke(source, quantum = 7, observation = 0, max = 16_000_000) {
  const bytes = Array.from(Buffer.from(source, 'utf8'));
  const words = [0x41535646, max, quantum, bytes.length, observation, ...bytes];
  const input = Buffer.alloc(words.length * 4);
  for (const [i, word] of words.entries()) input.writeUInt32LE(word, i * 4);
  const ran = spawnWithInput(exe, input, { timeout: 120_000, maxBuffer: 1 << 28 });
  requests++;
  assert.equal(ran.error, undefined);
  assert.equal(ran.signal, null, ran.stderr.toString());
  assert.equal(ran.status, 0, ran.stderr.toString());
  assert.equal(ran.stderr.length, 0, ran.stderr.toString());
  assert.equal(ran.stdout.length % 4, 0);
  let cursor = 0;
  const word = () => {
    assert.ok(cursor < ran.stdout.length, 'complete native packet');
    const result = ran.stdout.readUInt32LE(cursor);
    cursor += 4;
    return result;
  };
  assert.equal(word(), 0x41535646);
  const resumes = word() + word() * 2 ** 32;
  const status = word();
  const states = Array.from({ length: 6 }, () => Array.from({ length: 128 }, word));
  const count = word();
  const heap = [null];
  for (let i = 0; i < count; i++) heap.push(Array.from({ length: word() }, word));
  assert.equal(cursor, ran.stdout.length, 'no trailing native output');
  return {
    status,
    resumes,
    v: states[0],
    m: states[1],
    p: states[2],
    b: states[3],
    e: states[4],
    ir: states[5],
    heap,
    used: heap.slice(1).reduce((n, a) => n + a.length, 0),
  };
}
function check(item, got) {
  const { v, m, b } = got;
  assert.equal(got.status, item.status, item.name);
  assert.equal(v[0], item.status, item.name);
  assert.equal(v[1], 11, 'terminal state');
  assert.equal(m[1], item.id ?? 0, item.name);
  if (item.kind) assert.equal(v[14], item.kind, item.name);
  if (item.line) assert.equal(v[21], item.line, item.name);
  if (item.reason) assert.equal(b[2], item.reason, item.name);
  if (item.underlying !== undefined) assert.equal(v[13], item.underlying, item.name);
  if (item.input !== undefined) assert.equal(v[23], item.input, item.name);
  if (item.evalphase) assert.equal(v[12], item.evalphase, item.name);
  if (item.ex) assert.equal(v[3] + 1, item.ex, item.name);
  if (item.cache) assert.equal(v[33] / 2, item.cache, item.name);
  const visited = item.status === 6 ? 0 : v[2] + (v[0] ? 1 : 0);
  if (item.visited !== undefined) assert.equal(visited, item.visited, item.name);
  if (item.status !== 6) {
    const scope = got.heap[m[118]];
    const functions = got.heap[m[41]];
    for (let i = 0; i < v[2]; i++)
      assert.equal(scope[functions[i * 14]], i + 1, 'previous verified function is published');
    if (item.status !== 0 && functions?.length > v[2] * 14)
      assert.equal(scope[functions[v[2] * 14]], 0, 'failing function remains unpublished');
  }
}
if (group === 'core' || group === 'fuel') {
  for (const item of cases.filter((c) => Boolean(c.heavy) === (group === 'fuel'))) {
    let reference;
    try {
      parseAndValidate(item.source);
    } catch (e) {
      assert.ok(e instanceof A0Error);
      reference = e;
    }
    assert.equal(
      reference?.id,
      item.id ? `A${String(item.id).padStart(4, '0')}` : undefined,
      item.name,
    );
    let first;
    for (const quantum of [1, 7]) {
      const got = invoke(item.source, quantum);
      check(item, got);
      if (reference?.spec && [715, 716, 719].includes(item.id)) {
        assert.equal(reference.spec.ex, got.v[3] + 1);
        assert.equal(reference.spec.line, ['', 'ex', 'pre', 'post'][got.v[21]]);
        assert.equal('input' in reference.spec, got.v[23] !== 0);
        assert.equal(got.m[2], 0, 'semantic diagnostic line is absent');
      }
      const summary = [
        got.status,
        got.m[1],
        got.b[2],
        got.v[2],
        got.v[3],
        got.v[14],
        got.v[21],
        got.v[12],
        got.v[13],
        got.v[23],
      ];
      if (first) assert.deepEqual(summary, first, 'scheduling quantum does not change semantics');
      else first = summary;
    }
  }
} else if (group === 'capacity') {
  const count = LIMITS.maxArrayLength;
  const array = `[${Array(count).fill('0').join(';')}]`;
  const item = {
    name: 'full-width-literal-import-and-equality',
    source: simple(`ex ${array} ->${array}`, 'ret p0', `u32x${count}`, `u32x${count}`),
    status: 0,
    cache: 2 * (count + 1),
  };
  parseAndValidate(item.source);
  const got = invoke(item.source, 17);
  check(item, got);
  assert.ok(got.v[6] > 65535, 'expected literal ID crosses the old 16-bit region');
} else if (group === 'boundaries') {
  const source = cases.find((c) => c.name === 'matching-pre-post').source;
  const pending = invoke(source, 0, 1);
  assert.equal(pending.status, 7);
  assert.equal(pending.v[1], 0);
  assert.equal(pending.v[2], 0);
  for (const phase of [3, 5, 6]) {
    const prefix = invoke(source, 1, phase);
    assert.equal(prefix.status, 7);
    assert.equal(prefix.v[1], phase);
    const bounded = invoke(source, 1, 0, prefix.used + 1);
    assert.equal(bounded.status, 4, 'arena budget stays a resource error');
    assert.equal(bounded.v[0], 4);
    assert.equal(bounded.v[1], 11);
    assert.equal(bounded.m[1], 0, 'resource failure does not invent a spec diagnostic');
    assert.equal(bounded.v[20], 0);
  }
} else assert.fail(`unknown group ${group}`);
assert.ok(requests > 0);
console.log(JSON.stringify({ group, requests, status: 'passed' }));
