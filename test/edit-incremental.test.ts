import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { stats } from '../tools/check-latency.js';
import {
  type EditIncrementalReport,
  type EditRow,
  renderTable,
  validateReport,
} from '../tools/edit-incremental.js';

const row = (task: string, before: number, after: number, retyped = 3): EditRow => ({
  task,
  retyped,
  functions: 106,
  before: stats(Array.from({ length: 15 }, () => before)),
  after: stats(Array.from({ length: 15 }, () => after)),
  speedup: before / after,
});

function report(): EditIncrementalReport {
  const edits = [row('a', 10, 2), row('b', 12, 4), row('c', 8, 4)];
  return {
    version: 1,
    platform: 'win32',
    arch: 'x64',
    node: 'v24.0.0',
    bun: '1.4.2',
    cpus: 8,
    load: { source: 'cpu-utilisation', limit: 10, max: 3, start: 2, end: 2, rounds: 15, waits: 0 },
    method: { runs: 15, warmups: 3, interleaved: true, notes: ['n'] },
    program: { functions: 106, formattedLines: 4103, formattedBytes: 79164 },
    edits,
    summary: {
      beforeMedianMs: 10,
      afterMedianMs: 4,
      beforeSlowestMs: 12,
      afterSlowestMs: 4,
      speedupMedian: 2.5,
      speedupMin: 2,
      speedupMedianOfEdits: 3,
      retypedMedian: 3,
    },
  };
}

test('edit-incremental: a consistent report is valid and renders', () => {
  const r = report();
  assert.deepEqual(validateReport(r), []);
  assert.match(renderTable(r), /median over edits/);
});

test('edit-incremental: schema and arithmetic problems are reported', () => {
  const r = report();
  assert.ok(validateReport({ ...r, version: 2 }).length > 0);
  assert.ok(validateReport({ ...r, load: { ...r.load, max: 11 } }).some((p) => p.includes('load')));
  assert.ok(validateReport({ ...r, method: { ...r.method, runs: 5 } }).some((p) => p.includes('runs')));
  assert.ok(validateReport({ ...r, method: { ...r.method, warmups: 1 } }).some((p) => p.includes('warmups')));
  const wrongSpeedup = { ...r, edits: [{ ...row('a', 10, 2), speedup: 9 }, ...r.edits.slice(1)] };
  assert.ok(validateReport(wrongSpeedup).some((p) => p.includes('speedup')));
  assert.ok(validateReport({ ...r, summary: { ...r.summary, speedupMedian: 9 } }).some((p) => p.includes('speedupMedian')));
  assert.ok(validateReport({ ...r, edits: [row('a', 10, 2, 0), ...r.edits.slice(1)] }).some((p) => p.includes('retyped')));
  assert.ok(validateReport({ ...r, edits: [] }).includes('no edits'));
});

test('edit-incremental: the committed report, when present, is valid', () => {
  const file = 'results/edit-incremental.json';
  if (!existsSync(file)) return;
  const r = JSON.parse(readFileSync(file, 'utf8')) as EditIncrementalReport;
  assert.deepEqual(validateReport(r), []);
  assert.equal(r.edits.length, 14);
});
