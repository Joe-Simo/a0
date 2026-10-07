import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  type CheckLatencyReport,
  compare,
  type EditRow,
  judge,
  median,
  renderTable,
  type Stats,
  stats,
  tieBand,
  validateReport,
} from '../tools/check-latency.js';

const flat = (v: number, n = 15): Stats => stats(Array.from({ length: n }, () => v));
const spread = (lo: number, hi: number, n = 15): Stats =>
  stats(Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1)));

test('check-latency: median and stats', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const s = stats([5, 1, 3]);
  assert.deepEqual([s.n, s.median, s.min, s.max], [3, 3, 1, 5]);
  assert.throws(() => median([]));
});

test('check-latency: tie band is the loss-ledger band (8 %, or the spread, at most 25 %)', () => {
  assert.equal(Math.round(tieBand(flat(10), flat(10)) * 1000) / 1000, 0.08);
  assert.equal(Math.round(tieBand(spread(10, 12), flat(10)) * 1000) / 1000, 0.2);
  assert.equal(Math.round(tieBand(spread(10, 100), flat(10)) * 1000) / 1000, 0.25);
});

test('check-latency: verdict arithmetic', () => {
  // A0 10 ms against 100 ms: 10x faster, a win.
  const w = judge(flat(10), flat(100));
  assert.equal(w.verdict, 'win');
  assert.equal(w.ratio, 10);
  assert.equal(w.gap, -0.9);
  // 5 % apart on flat samples: inside the 8 % band, a tie either way.
  assert.equal(judge(flat(10), flat(10.5)).verdict, 'tie');
  assert.equal(judge(flat(10.5), flat(10)).verdict, 'tie');
  // 10 % behind on flat samples: a loss.
  assert.equal(judge(flat(11), flat(10)).verdict, 'loss');
  // The same 10 % gap is a tie when the samples spread 20 %.
  assert.equal(judge(spread(10.5, 12.6), flat(10)).verdict, 'tie');
  // A wide spread is capped at 25 %: 30 % behind is a loss however noisy.
  assert.equal(judge(spread(13, 130), flat(10)).verdict, 'loss');
});

const edits: EditRow[] = [
  { task: 'a', editLines: 3, editBytes: 30, viewLines: 20, apply: flat(10) },
  { task: 'b', editLines: 4, editBytes: 40, viewLines: 30, apply: flat(300) },
];

test('check-latency: comparisons carry one verdict per edit and competitor', () => {
  const cs = compare(edits, flat(20), flat(400), { tsc: flat(2000), tsgo: flat(250) });
  const get = (subject: string, c: string, task?: string) =>
    cs.find((x) => x.subject.startsWith(subject) && x.competitor === c && x.task === task);
  assert.equal(get('a0 edit', 'tsc', 'a')?.verdict, 'win');
  assert.equal(get('a0 edit', 'tsgo', 'a')?.verdict, 'win');
  assert.equal(get('a0 edit', 'tsgo', 'b')?.verdict, 'loss');
  assert.equal(get('a0 whole front end, in process', 'tsgo')?.verdict, 'win');
  assert.equal(get('a0 whole front end, fresh process', 'tsgo')?.verdict, 'loss');
  // 2 edits + 2 whole-project rows, for each of 2 competitors
  assert.equal(cs.length, 8);
});

function fixture(): CheckLatencyReport {
  const wholeProject = { tsc: flat(2000), tsgo: flat(250) };
  const coldIn = flat(20);
  const coldProc = flat(400);
  return {
    version: 1,
    platform: 'win32',
    arch: 'x64',
    node: 'v24.0.0',
    bun: '1.4.2',
    cpus: 8,
    load: { source: 'cpu-utilisation', limit: 10, max: 4, start: 3, end: 4, rounds: 15, waits: 0 },
    method: { runs: 15, warmups: 3, interleaved: true, tieBand: 'band', notes: [] },
    tools: {
      tsc: { available: true, version: 'TypeScript 5.9.3', command: 'node tsc.js --noEmit' },
      'tsc-rs': { available: false, reason: 'linux x64 and macOS arm64 only' },
    },
    size: {
      a0: {
        sourceFiles: ['compiler/lex.a0'],
        sourceLines: 10,
        sourceBytes: 100,
        formattedLines: 12,
        formattedBytes: 120,
        functions: 3,
      },
      ts: { file: 'front.ts', lines: 20, bytes: 200 },
    },
    a0: {
      edits,
      editMedianMs: 155,
      editSlowestMs: 300,
      coldOpenInProcess: coldIn,
      coldOpenProcess: coldProc,
    },
    wholeProject,
    comparisons: compare(edits, coldIn, coldProc, wholeProject),
  };
}

test('check-latency: a well-formed report validates and renders', () => {
  const r = fixture();
  assert.deepEqual(validateReport(r), []);
  const t = renderTable(r);
  assert.match(t, /whole project/);
  assert.match(t, /not run: tsc-rs/);
});

test('check-latency: the schema rejects a bad report', () => {
  const r = fixture();
  const loaded = { ...r, load: { ...r.load, max: 11 } };
  assert.ok(validateReport(loaded).some((p) => /load 11 above 10/.test(p)));
  const few = { ...r, method: { ...r.method, runs: 5 } };
  assert.ok(validateReport(few).some((p) => /fewer than 15 runs/.test(p)));
  const noReason = { ...r, tools: { ...r.tools, 'tsc-rs': { available: false } } };
  assert.ok(validateReport(noReason).some((p) => /reason required/.test(p)));
  const wrong = {
    ...r,
    comparisons: r.comparisons.map((c, i) => (i === 0 ? { ...c, verdict: 'loss' as const } : c)),
  };
  assert.ok(validateReport(wrong).some((p) => /verdict loss/.test(p)));
  const badStats = { ...r, wholeProject: { tsc: { ...flat(5), median: 99 } } };
  assert.ok(validateReport(badStats).some((p) => /wholeProject tsc: bad stats/.test(p)));
});

test('check-latency: every committed report is valid', () => {
  if (!existsSync('results')) return;
  for (const f of readdirSync('results').filter((n) => /^check-latency-.*\.json$/.test(n))) {
    const r = JSON.parse(readFileSync(`results/${f}`, 'utf8')) as CheckLatencyReport;
    assert.deepEqual(validateReport(r), [], f);
  }
});
