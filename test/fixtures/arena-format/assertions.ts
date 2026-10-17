import assert from 'node:assert/strict';
import type { SourceCase } from './cases.js';
import type { NativeResult } from './transport.js';

/** Exact expected bytes plus independently checkable mapping geometry and atomic failures. */
export function assertCase(row: SourceCase, actual: NativeResult): void {
  assert.equal(actual.code, row.initial, `${row.name}: frontend status`);
  if (row.diagnostic !== undefined) assert.equal(actual.diagnostic, row.diagnostic, row.name);
  assert.equal(actual.results.length, row.requests.length);
  for (const [i, expected] of row.requests.entries()) {
    const got = actual.results[i];
    assert.ok(got);
    assert.equal(got.operation, expected.operation);
    assert.equal(got.code, expected.status, `${row.name}: status`);
    if (expected.status !== 0) {
      assert.equal(got.text, '');
      assert.equal(got.events.length, 0);
    } else {
      assert.ok(expected.expected !== undefined);
      assert.deepEqual(got.bytes, Buffer.from(expected.expected), `${row.name}: bytes`);
    }
    if (expected.operation !== 0) continue;
    const facts = got.facts;
    assert.equal(facts[0], got.code);
    assert.equal(facts[9], got.bytes.length);
    if (got.code !== 0) {
      assert.deepEqual(facts.slice(4, 7), [0, 0, 0]);
      continue;
    }
    assert.equal(facts[1], 0x41304654);
    assert.equal(facts[2], 1);
    assert.equal(facts[8], 0xffffffff);
    assert.equal(facts[3], expected.mapping ? 1 : 0);
    assert.equal(facts[10], expected.mode);
    assert.equal(facts[11], expected.id);
    assert.equal(facts[12], expected.skip ? 1 : 0);
    assert.equal(got.events.length % 6, 0);
    assert.equal(got.events.length, facts[5]);
    if (!expected.mapping) {
      assert.equal(got.events.length, 0);
      assert.deepEqual(facts.slice(4, 7), [0, 0, 0]);
    }
    let maxOperand = 0,
      operands = 0;
    for (let j = 0; j < got.events.length; j += 6) {
      const kind = got.events[j],
        subject = got.events[j + 1],
        start = got.events[j + 3];
      const length = got.events[j + 4],
        parent = got.events[j + 5];
      assert.ok(start !== undefined && length !== undefined && parent !== undefined);
      assert.ok(start <= got.bytes.length && length <= got.bytes.length - start);
      if (parent !== 0xffffffff) {
        assert.ok(parent < j / 6);
        const parentStart = got.events[parent * 6 + 3],
          parentLength = got.events[parent * 6 + 4];
        assert.ok(parentStart !== undefined && parentLength !== undefined);
        assert.ok(start >= parentStart && start + length <= parentStart + parentLength);
      }
      if (kind === 9) {
        assert.ok(subject !== undefined);
        operands++;
        maxOperand = Math.max(maxOperand, subject);
      }
    }
    for (const wanted of expected.expectedEvents ?? []) {
      const spellings: string[] = [];
      for (let j = 0; j < got.events.length; j += 6) {
        if (
          got.events[j] !== wanted.kind ||
          got.events[j + 1] !== wanted.subject ||
          got.events[j + 2] !== wanted.field
        )
          continue;
        const start = got.events[j + 3],
          length = got.events[j + 4];
        assert.ok(start !== undefined && length !== undefined);
        spellings.push(got.bytes.subarray(start, start + length).toString('utf8'));
      }
      assert.deepEqual(spellings, [wanted.spelling], `${row.name}: mapped kind/subject/field`);
    }
    if (expected.largeOperandMap !== undefined) {
      assert.equal(operands, expected.largeOperandMap);
      assert.ok(maxOperand > 65535);
    }
  }
}
