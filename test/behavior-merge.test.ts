import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MergeReport, mergeReports } from '../tools/behavior-merge.js';
import { regressions } from '../tools/behavior-regress-check.js';

type S = 'passed' | 'failed' | 'blocked' | 'skipped';
function rep(platform: string, sha: string, st: Record<string, S>): MergeReport {
  const targets = Object.entries(st).map(([id, status]) => ({
    id,
    status,
    cases: status === 'passed' ? 7 : 0,
    detail: `${id} on ${platform}`,
    programs: { p: status === 'passed' ? 'passed' : status },
    ...(status === 'blocked' ? {} : { ranOn: platform }),
  }));
  return {
    platform,
    table: { sha256: sha },
    skipLedger: [],
    summary: { passed: 0, failed: 0, blocked: 0, skipped: 0 },
    targets,
    coverage: {},
  };
}

test('merge: passed beats blocked and records ranOn; blocked everywhere stays blocked', () => {
  const m = mergeReports([
    rep('win32-x64', 'a', { js: 'passed', arm64: 'blocked', metal: 'blocked' }),
    rep('darwin-arm64', 'a', { js: 'passed', arm64: 'passed', metal: 'blocked' }),
  ]);
  const by = Object.fromEntries(m.targets.map((t) => [t.id, t]));
  assert.equal(by.js?.ranOn, 'win32-x64');
  assert.equal(by.arm64?.status, 'passed');
  assert.equal(by.arm64?.ranOn, 'darwin-arm64');
  assert.equal(by.arm64?.detail, 'arm64 on darwin-arm64');
  assert.equal(by.metal?.status, 'blocked');
  assert.equal(by.metal?.ranOn, undefined);
  assert.deepEqual(m.summary, { passed: 2, failed: 0, blocked: 1, skipped: 0 });
  assert.equal(m.coverage.arm64?.p, 'passed');
});

test('merge: a failure in any report wins over a pass', () => {
  const m = mergeReports([
    rep('win32-x64', 'a', { js: 'passed' }),
    rep('darwin-arm64', 'a', { js: 'failed' }),
  ]);
  assert.equal(m.targets[0]?.status, 'failed');
  assert.equal(m.targets[0]?.ranOn, 'darwin-arm64');
  assert.equal(m.summary.failed, 1);
});

test('merge: differing table sha256 is refused', () => {
  assert.throws(
    () => mergeReports([rep('a', 'x', { js: 'passed' }), rep('b', 'y', { js: 'passed' })]),
    /sha256 differs/,
  );
});

test('regress check: a passed target that becomes blocked is reported', () => {
  const committed = rep('m', 'a', { js: 'passed', arm64: 'passed', metal: 'blocked' });
  const merged = rep('w', 'a', { js: 'passed', arm64: 'blocked', metal: 'blocked' });
  assert.deepEqual(regressions(committed, merged), [
    'arm64: passed in the committed report, blocked in the merge',
  ]);
  assert.deepEqual(regressions(committed, committed), []);
});
