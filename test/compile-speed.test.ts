import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type Stats, stats } from '../tools/check-latency.js';
import { BYTES_BAND, type CompileSpeedReport, compareRow } from '../tools/compile-speed.js';

const flat = (v: number, n = 7): Stats => stats(Array.from({ length: n }, () => v));

test('compile-speed: times use the check-latency tie band, bytes a fixed 2 % band', () => {
  assert.equal(compareRow('p', 'wasm', 'clang', 'compile-ms', flat(100), flat(105)).verdict, 'tie');
  assert.equal(compareRow('p', 'wasm', 'clang', 'compile-ms', flat(100), flat(200)).verdict, 'win');
  assert.equal(
    compareRow('p', 'wasm', 'clang', 'compile-ms', flat(200), flat(100)).verdict,
    'loss',
  );
  const b = compareRow('p', 'wasm', 'clang', 'compile-output-bytes', 1030, 1000);
  assert.equal(b.band, BYTES_BAND);
  assert.equal(b.verdict, 'loss');
  assert.equal(compareRow('p', 'wasm', 'clang', 'compile-output-bytes', 1010, 1000).verdict, 'tie');
});

test('compile-speed: recorded reports are under the load limit and judged consistently', () => {
  if (!existsSync('results')) return;
  for (const f of readdirSync('results').filter((n) => /^compile-speed-.*\.json$/.test(n))) {
    const r = JSON.parse(readFileSync(`results/${f}`, 'utf8')) as CompileSpeedReport;
    assert.ok(r.load.max <= r.load.limit, `${f}: recorded above the load limit`);
    assert.ok(r.method.runs >= 7 && r.method.interleaved, `${f}: method`);
    for (const c of r.comparisons) {
      const v = c.gap < -c.band ? 'win' : c.gap > c.band ? 'loss' : 'tie';
      assert.equal(c.verdict, v, `${f}: ${c.program}/${c.target} ${c.metric} ${c.competitor}`);
    }
  }
});
