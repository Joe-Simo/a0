/**
 * The /benchmarks tables for WebAssembly, edit-check latency and front-end edits, and the numbers
 * written into their sentences, are copied from results files into site/gen/bench.tpl by hand.
 * This test regenerates them from the results files and fails when the template drifts.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const results = async (f: string): Promise<any> =>
  JSON.parse(await readFile(`results/${f}`, 'utf8'));
const template = (): Promise<string> => readFile('site/gen/bench.tpl', 'utf8');

type Cell = string | { t: string; cls?: string | undefined };
const text = (c: Cell): string => (typeof c === 'string' ? c : c.t);

function table(cap: string, heads: string[], rows: Cell[][], src: string): string {
  let s = `.div tblwrap\n+tabindex 0\n+role group\n+aria-label Table, scrolls sideways\n.table ops rank fit\n=caption ${cap}\n<tr\n`;
  for (const h of heads) s += `=th ${h}\n`;
  s += '>\n';
  for (const r of rows) {
    s += `<tr\n# claim-ok: row of ${src}, checked by test/bench-tables.test.ts\n`;
    r.forEach((c, i) => {
      const cls = typeof c !== 'string' && c.cls ? ` ${c.cls}` : '';
      if (i === 0) s += `=td ${text(c)}\n`;
      else s += `.td mono${cls}\n"${text(c)}\n>\n`;
    });
    s += '>\n';
  }
  return `${s}>\n>\n`;
}

const f2 = (x: number): string => x.toFixed(2);
const ns = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const ms = (x: number): string => (x >= 100 ? x.toFixed(0) : x.toFixed(1));

test('bench.tpl: the WebAssembly tables are the rows of results/wasm-benchmark.json', async () => {
  const tpl = await template();
  const w = await results('wasm-benchmark.json');
  const row = (r: any): Cell[] => [
    r.kernel,
    `${ns(r.nsPerTrip.a0)} / ${ns(r.nsPerTrip.clang)}`,
    {
      t: `${f2(r.speedup)}x ${r.verdict === 'loss' ? 'A0 slower' : r.verdict === 'tie' ? 'tie' : 'A0 faster'}`,
      cls: r.verdict === 'loss' ? 'loss' : undefined,
    } as Cell,
    `${r.bytes.a0} / ${r.bytes.clang}`,
  ];
  const heads = [
    'Test program',
    'Time per trip, ns (A0 / clang)',
    'clang time divided by A0 time',
    'Module bytes (A0 / clang)',
  ];
  const sorted = [...w.rows].sort((a: any, b: any) => a.speedup - b.speedup);
  const losses = sorted.filter((r: any) => r.verdict === 'loss');
  const rest = sorted.filter((r: any) => r.verdict !== 'loss');
  const src = 'results/wasm-benchmark.json';
  assert.ok(
    tpl.includes(
      table(
        `Wasm on Windows x64: the ${losses.length} test programs where A0 is slower than clang, worst first`,
        heads,
        losses.map(row),
        src,
      ),
    ),
    'loss table drifted from the results file',
  );
  assert.ok(
    tpl.includes(
      table(
        `Wasm on Windows x64: the other ${rest.length} test programs, ties and wins`,
        heads,
        rest.map(row),
        src,
      ),
    ),
    'remaining-rows table drifted from the results file',
  );
  const count = (v: string): number => w.rows.filter((r: any) => r.verdict === v).length;
  const take =
    `clang's time divided by A0's has a geometric mean of ${f2(w.geomeanSpeedup)} over ${w.rows.length} test programs: ` +
    `A0 is faster on ${count('win')}, ties on ${count('tie')} and is slower on ${count('loss')}, the worst being ${losses[0].kernel} at ${f2(losses[0].speedup)}.`;
  assert.ok(tpl.includes(take), 'wasm headline sentence drifted from the results file');
  assert.ok(
    tpl.includes(`highest ${w.loadGate.highestLoadAtSampleStart} of ${w.loadGate.maxLoad} allowed`),
  );
  assert.ok(tpl.includes(`Show the other ${rest.length} test programs`));
});

test('bench.tpl: the check-latency table and sentences are the medians of results/check-latency-*.json', async () => {
  const tpl = await template();
  const rows: Cell[][] = [];
  const edit: Record<string, number> = {};
  const fresh: Record<string, number> = {};
  for (const [f, name] of [
    ['darwin-arm64', 'macOS arm64, 3 CPUs'],
    ['linux-x64', 'Linux x64, 4 CPUs'],
    ['win32-x64', 'Windows x64, 8 CPUs'],
  ] as const) {
    const k = await results(`check-latency-${f}.json`);
    edit[f] = k.a0.editMedianMs;
    fresh[f] = k.a0.coldOpenProcess.median;
    const load =
      k.load.source === 'loadavg'
        ? `load average ${k.load.max}${k.load.max >= k.load.limit ? ', at the limit' : ''}`
        : `CPU use ${k.load.max} of ${k.cpus} (contended)`;
    const wp = k.wholeProject;
    const cell = (t: string): string => (wp[t] ? `${ms(wp[t].median)} ms` : 'not run');
    rows.push([
      `${name}, ${load}`,
      'one edit, warm session',
      `${ms(k.a0.editMedianMs)} ms`,
      cell('tsc'),
      cell('tsgo'),
      cell('tsc-rs'),
    ]);
    const v: Record<string, string> = {};
    for (const c of k.comparisons)
      if (c.subject.includes('fresh process')) v[c.competitor] = c.verdict;
    const fc = (t: string): Cell =>
      wp[t]
        ? {
            t: `${ms(wp[t].median)} ms${v[t] === 'loss' ? ' A0 slower' : v[t] === 'tie' ? ' tie' : ''}`,
            cls: v[t] === 'loss' ? 'loss' : undefined,
          }
        : 'not run';
    rows.push([
      'same machine',
      'whole front end, fresh process',
      `${ms(k.a0.coldOpenProcess.median)} ms`,
      fc('tsc'),
      fc('tsgo'),
      fc('tsc-rs'),
    ]);
  }
  const expected = table(
    'A0 against TypeScript checkers, medians of 15 interleaved runs, by machine',
    [
      'Machine and load',
      'What A0 is timed on',
      'A0',
      'tsc 5.9.3',
      'tsgo 7.0.0-dev',
      'tsc-rs 0.1.0',
    ],
    rows,
    'results/check-latency-*.json',
  );
  assert.ok(tpl.includes(expected), 'check-latency table drifted from the results files');
  const mac = await results('check-latency-darwin-arm64.json');
  const lin = await results('check-latency-linux-x64.json');
  const win = await results('check-latency-win32-x64.json');
  const lo = Math.round(Math.min(...Object.values(edit)));
  const hi = Math.round(Math.max(...Object.values(edit)));
  assert.ok(tpl.includes(`validates one edit in ${lo} to ${hi} ms in a warm session`));
  assert.ok(
    tpl.includes(
      `takes ${Math.round(Number(fresh['darwin-arm64']))} ms on macOS and ${Math.round(Number(fresh['linux-x64']))} ms on Linux`,
    ),
  );
  assert.ok(
    tpl.includes(
      `${lo} to ${hi} ms per edit in a warm session, against ${Math.round(mac.wholeProject.tsc.median)} to ${Math.round(win.wholeProject.tsc.median)} ms for a whole-project tsc check`,
    ),
  );
  const v = (k: any, c: string): string =>
    k.comparisons.find((x: any) => x.subject.includes('fresh process') && x.competitor === c)
      .verdict;
  assert.equal(v(mac, 'tsgo'), 'loss');
  assert.equal(v(mac, 'tsc-rs'), 'loss');
  assert.equal(v(lin, 'tsc-rs'), 'loss');
  assert.notEqual(v(lin, 'tsgo'), 'loss');
  const inc = (await results('edit-incremental.json')).summary;
  assert.ok(
    tpl.includes(
      `${inc.beforeMedianMs.toFixed(2)} ms before and ${inc.afterMedianMs.toFixed(2)} ms after`,
    ),
  );
  assert.ok(
    tpl.includes(`${mac.size.a0.formattedLines.toLocaleString('en-US')}-line front end`) ||
      tpl.includes('4,100-line'),
  );
  assert.equal(mac.size.a0.formattedLines, 4103);
  assert.equal(mac.size.ts.lines, 637);
});

test('bench.tpl: the front-end edit table and sentences are the cells of results/app-edit-keys.json', async () => {
  const tpl = await template();
  const a = await results('app-edit-keys.json');
  const rows: Cell[][] = [];
  for (const m of ['sonnet', 'haiku'])
    for (const [c, name] of [
      ['a0-keys', 'A0'],
      ['ts', 'TypeScript'],
    ] as const) {
      const x = a.cells[`${m}/${c}`];
      rows.push([
        `${m[0]?.toUpperCase()}${m.slice(1)}, ${name}`,
        `${x.oneShot.k} of ${x.n}`,
        `${x.acceptedAfterRepair.k} of ${x.n}`,
        x.tokensPerAcceptedEdit.session10.toFixed(0),
      ]);
    }
  const expected = table(
    'Fourteen edits to one front end: edits accepted and tokens per accepted edit (10-edit session)',
    [
      'Model, language',
      'Accepted first try',
      'Accepted after one repair',
      'Tokens per accepted edit',
    ],
    rows,
    'results/app-edit-keys.json',
  );
  assert.ok(tpl.includes(expected), 'front-end edit table drifted from the results file');
  const s = a.cells['sonnet/a0-keys'];
  const t = a.cells['sonnet/ts'];
  const h = a.cells['haiku/a0-keys'];
  const ht = a.cells['haiku/ts'];
  assert.equal(s.acceptedAfterRepair.k, 14);
  assert.equal(t.acceptedAfterRepair.k, 14);
  assert.equal(h.acceptedAfterRepair.k, 10);
  assert.equal(ht.acceptedAfterRepair.k, 13);
  assert.equal((t.cost / s.cost).toFixed(1), '4.9');
  assert.ok(
    tpl.includes(
      `${s.tokensPerAcceptedEdit.session10.toFixed(0)} tokens per accepted edit against ${t.tokensPerAcceptedEdit.session10.toFixed(0)}`,
    ),
  );
});
