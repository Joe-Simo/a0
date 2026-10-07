import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, collect, summarize } from '../tools/failure-taxonomy.js';

test('the failure taxonomy classifies a message by its root cause', () => {
  const c = (message: string, status = 'protocol'): string => classify({ status, message }).cls;
  assert.equal(c("parse: line 2: unexpected 'end' before ret fix: x"), 'syntax slip');
  assert.equal(
    c("structure: sq.a: unknown callee 'sel' (callees must be defined earlier)"),
    'syntax slip',
  );
  assert.equal(
    c("structure: total.r: unknown fold body 'addi' (must be defined earlier)"),
    'ordering',
  );
  assert.equal(c("edit: duplicate edit for 'y'"), 'id reuse');
  assert.equal(c('type: isdiv.ret: expected u32, got bool', 'protocol'), 'type/width mismatch');
  assert.equal(c('f(3,5) = 4294967294, expected 2', 'wrong-output'), 'type/width mismatch');
  assert.equal(c('f(3,5) = 7, expected 2', 'wrong-output'), 'misunderstood semantics');
  assert.equal(c("edit: line 1: invalid delete target 'x add p0 1'"), 'protocol misuse');
  assert.equal(c('no reply', 'no-reply'), 'other');
});

test('the failure taxonomy over results/ accounts for every first-attempt failure once', () => {
  const rows = collect();
  assert.ok(rows.length > 1000);
  const table = summarize(rows);
  assert.equal(
    table.reduce((n, r) => n + r.total, 0),
    rows.length,
  );
  for (const r of table) assert.equal(r.repaired + r.stillFailed, r.total);
});
