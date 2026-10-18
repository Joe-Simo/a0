import assert from 'node:assert/strict';
import { formatProgram, parse } from '../../../src/core.js';
import { formatSource, parseSource } from '../../../src/source.js';
import { withoutSpec } from '../../../src/spec.js';
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
    if (row.roundTrip && expected.status === 0) {
      const before = parse(row.source);
      const selected = expected.skip ? before.functions.map(withoutSpec) : before.functions;
      let functions = selected;
      if (expected.mode === 0) {
        const fn = selected[expected.id];
        assert.ok(fn);
        functions = [fn];
      }
      const scoped = {
        functions,
        ...(expected.mode !== 0 && before.profile === 'strict'
          ? { profile: 'strict' as const }
          : {}),
      };
      const after = parseSource(got.text);
      assert.equal(formatProgram(after), formatProgram(scoped), `${row.name}: full IR`);
      if (expected.mode === 2)
        assert.deepEqual(after.uses ?? [], before.uses ?? [], `${row.name}: imports`);
      const fixed = formatSource(after);
      assert.equal(
        expected.mode === 0 ? fixed.slice(0, -1) : fixed,
        got.text,
        `${row.name}: flat fixed point`,
      );
    }
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
      operands = 0,
      literals = 0;
    const lastStart = new Map<number, number>();
    for (let j = 0; j < got.events.length; j += 6) {
      const kind = got.events[j],
        subject = got.events[j + 1],
        start = got.events[j + 3];
      const length = got.events[j + 4],
        parent = got.events[j + 5];
      assert.ok(start !== undefined && length !== undefined && parent !== undefined);
      assert.ok(start <= got.bytes.length && length <= got.bytes.length - start);
      assert.ok(start >= (lastStart.get(parent) ?? 0), `${row.name}: sibling order`);
      lastStart.set(parent, start);
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
      if (kind === 13) literals++;
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
    if (expected.literalMapCount !== undefined)
      assert.equal(literals, expected.literalMapCount, `${row.name}: complete literal origins`);
  }
}
