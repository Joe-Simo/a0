/**
 * Per-edit apply time before and after incremental validation, on the real front end.
 *
 * The program is the application-scale front end of docs/history/2026-10-06-app-edit-preregistration.md
 * (compiler/parse.a0 linked with compiler/lex.a0, 4103 lines), the edits are the reference solutions of the 14 sealed
 * tasks of tools/app-edit-tasks.ts. Each sample builds a warm session (views open) and times one
 * `EditSession.apply`. Two modes, same code path:
 *
 *   before   `withoutReuse(() => session.apply(reply))`: validate types every function again, as `validate` did before it
 *            reused typed functions by identity (src/core.ts `withoutReuse`)
 *   after    `session.apply(reply)`: the edited functions and their transitive callers are typed again, the rest reused
 *
 * Every sample asserts that the two modes give the same program (canonical text equal); the differential tests
 * (test/incremental-validate.test.ts) prove the equality for thousands of edits. Method: 3 warmup rounds, then N >= 15
 * rounds; each round samples every (edit, mode) once in a rotating order after the load gate (tools/quiet.ts,
 * tools/system-load.ts, limit 10); medians with min and max.
 *
 *   bun run edit-incremental [-- --out results/edit-incremental.json] [--runs 15]
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { cpus, platform as osPlatform } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { formatProgram, parseAndValidate, type TypedProgram, withoutReuse } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { extractBlock } from './ai-edit-apply.js';
import { checkStart, startPrograms } from './app-edit-bench.js';
import { APP_TASKS, type AppTask } from './app-edit-tasks.js';
import { median, type Stats, stats } from './check-latency.js';
import { loadGate, waitQuiet } from './quiet.js';
import { writeReport } from './scrub-results.js';
import { loadSource, systemLoad } from './system-load.js';

/** AGENTS.md: no timing claim from a run recorded above load average 10. */
export const LOAD_LIMIT = 10;
export const MIN_RUNS = 15;
export const WARMUPS = 3;

export interface EditRow {
  readonly task: string;
  /** Functions typed again by the incremental apply (the edited ones and their transitive callers). */
  readonly retyped: number;
  /** Functions of the program after the edit. */
  readonly functions: number;
  readonly before: Stats;
  readonly after: Stats;
  /** before.median / after.median. */
  readonly speedup: number;
}

export interface EditIncrementalReport {
  readonly version: 1;
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly bun: string;
  readonly cpus: number;
  readonly load: {
    readonly source: string;
    readonly limit: number;
    readonly max: number;
    readonly start: number;
    readonly end: number;
    readonly rounds: number;
    readonly waits: number;
  };
  readonly method: { readonly runs: number; readonly warmups: number; readonly interleaved: boolean; readonly notes: readonly string[] };
  readonly program: { readonly functions: number; readonly formattedLines: number; readonly formattedBytes: number };
  readonly edits: readonly EditRow[];
  readonly summary: {
    /** Median over the edits of each edit's median apply time. */
    readonly beforeMedianMs: number;
    readonly afterMedianMs: number;
    readonly beforeSlowestMs: number;
    readonly afterSlowestMs: number;
    /** beforeMedianMs / afterMedianMs. */
    readonly speedupMedian: number;
    /** The smallest and the median of the per-edit speedups. */
    readonly speedupMin: number;
    readonly speedupMedianOfEdits: number;
    /** Median over the edits of the number of functions typed again. */
    readonly retypedMedian: number;
  };
}

const round = (x: number): number => Math.round(x * 1e6) / 1e6;
const nonEmpty = (s: unknown): boolean => typeof s === 'string' && s.length > 0;
const isStats = (s: Stats | undefined): s is Stats =>
  s !== undefined &&
  Number.isFinite(s.median) &&
  s.n === s.samples.length &&
  s.n > 0 &&
  s.min <= s.median &&
  s.median <= s.max &&
  s.samples.every((x) => Number.isFinite(x) && x >= 0);

/** Schema and arithmetic problems of a report (empty: valid). Used by test/edit-incremental.test.ts. */
export function validateReport(r: unknown): string[] {
  const bad: string[] = [];
  if (typeof r !== 'object' || r === null) return ['not an object'];
  const rep = r as EditIncrementalReport;
  if (rep.version !== 1) bad.push('version must be 1');
  for (const k of ['platform', 'arch', 'node', 'bun'] as const) if (!nonEmpty(rep[k])) bad.push(`${k} missing`);
  if (typeof rep.load?.max !== 'number' || rep.load.limit !== LOAD_LIMIT) bad.push('load missing');
  else if (rep.load.max > LOAD_LIMIT) bad.push(`load ${rep.load.max} above ${LOAD_LIMIT}`);
  if (!(rep.method?.runs >= MIN_RUNS)) bad.push(`fewer than ${MIN_RUNS} runs`);
  if (!(rep.method?.warmups >= WARMUPS)) bad.push(`fewer than ${WARMUPS} warmups`);
  if (!(rep.program?.functions > 0 && rep.program?.formattedLines > 0)) bad.push('program size missing');
  if (!Array.isArray(rep.edits) || rep.edits.length === 0) bad.push('no edits');
  for (const e of rep.edits ?? []) {
    if (!isStats(e.before) || !isStats(e.after)) {
      bad.push(`edit ${e.task}: bad stats`);
      continue;
    }
    if (e.before.n < MIN_RUNS || e.after.n < MIN_RUNS) bad.push(`edit ${e.task}: fewer than ${MIN_RUNS} samples`);
    const s = e.before.median / e.after.median;
    if (Math.abs(s - e.speedup) > 1e-4 + Math.abs(s) * 1e-4) bad.push(`edit ${e.task}: speedup ${e.speedup} is not ${s}`);
    if (!(e.retyped >= 1 && e.retyped <= e.functions)) bad.push(`edit ${e.task}: retyped ${e.retyped} outside 1..${e.functions}`);
  }
  const edits = rep.edits ?? [];
  if (edits.length > 0 && rep.summary !== undefined) {
    const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4 + Math.abs(b) * 1e-4;
    const bm = median(edits.map((e) => e.before.median));
    const am = median(edits.map((e) => e.after.median));
    if (!close(rep.summary.beforeMedianMs, bm)) bad.push(`summary.beforeMedianMs is not ${bm}`);
    if (!close(rep.summary.afterMedianMs, am)) bad.push(`summary.afterMedianMs is not ${am}`);
    if (!close(rep.summary.speedupMedian, bm / am)) bad.push(`summary.speedupMedian is not ${bm / am}`);
    if (!close(rep.summary.speedupMin, Math.min(...edits.map((e) => e.speedup)))) bad.push('summary.speedupMin is wrong');
    if (!close(rep.summary.speedupMedianOfEdits, median(edits.map((e) => e.speedup)))) bad.push('summary.speedupMedianOfEdits is wrong');
    if (!close(rep.summary.beforeSlowestMs, Math.max(...edits.map((e) => e.before.median)))) bad.push('summary.beforeSlowestMs is wrong');
    if (!close(rep.summary.afterSlowestMs, Math.max(...edits.map((e) => e.after.median)))) bad.push('summary.afterSlowestMs is wrong');
  } else bad.push('summary missing');
  return bad;
}

const ms = (x: number): string => (x < 10 ? x.toFixed(3) : x < 100 ? x.toFixed(1) : x.toFixed(0));

export function renderTable(r: EditIncrementalReport): string {
  const lines = [
    `apply per edit, before (all functions typed again) and after (edited functions and their callers); ms, medians of ${r.method.runs} rounds; load max ${r.load.max} (${r.load.source}), ${r.platform}-${r.arch}`,
    'task'.padEnd(34) + 'before'.padStart(9) + 'after'.padStart(9) + 'speedup'.padStart(9) + 'retyped'.padStart(9),
  ];
  for (const e of r.edits)
    lines.push(
      e.task.padEnd(34) + ms(e.before.median).padStart(9) + ms(e.after.median).padStart(9) + `${e.speedup.toFixed(2)}x`.padStart(9) + `${e.retyped}/${e.functions}`.padStart(9),
    );
  lines.push(
    'median over edits'.padEnd(34) + ms(r.summary.beforeMedianMs).padStart(9) + ms(r.summary.afterMedianMs).padStart(9) + `${r.summary.speedupMedian.toFixed(2)}x`.padStart(9),
  );
  return lines.join('\n');
}

function makeSession(program: TypedProgram, task: AppTask): EditSession {
  const session = new EditSession(program);
  for (const f of task.a0Targets) session.open(f, { scope: 'deps' });
  session.openProgram({ scope: 'all', target: task.a0Targets[0] as string });
  return session;
}

function toolVersion(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
}

export async function measure(opts: { runs: number }): Promise<EditIncrementalReport> {
  const runs = Math.max(opts.runs, MIN_RUNS);
  const programs = await startPrograms();
  checkStart(programs);
  const startLoad = systemLoad();
  const start = parseAndValidate(programs.a0);

  interface Sample {
    readonly sink: number[];
    readonly run: () => number;
  }
  const rows = APP_TASKS.map((task) => {
    const reply = extractBlock(task.reference.a0);
    const expected = formatProgram(withoutReuse(() => makeSession(start, task).apply(reply)));
    const before: number[] = [];
    const after: number[] = [];
    const timed = (full: boolean): number => {
      const session = makeSession(start, task);
      const t0 = performance.now();
      const result = full ? withoutReuse(() => session.apply(reply)) : session.apply(reply);
      const dt = performance.now() - t0;
      if (formatProgram(result) !== expected) throw new Error(`${task.id}: before and after differ`);
      return dt;
    };
    const result = makeSession(start, task).apply(reply);
    const retyped = result.functions.filter((f) => start.byName.get(f.name) !== f).length;
    return { task, before, after, timed, retyped, functions: result.functions.length };
  });
  const subjects: Sample[] = rows.flatMap((r) => [
    { sink: r.before, run: () => r.timed(true) },
    { sink: r.after, run: () => r.timed(false) },
  ]);

  const loads: number[] = [];
  for (let w = 0; w < WARMUPS; w += 1) {
    waitQuiet();
    for (const s of subjects) s.run();
  }
  for (let r = 0; r < runs; r += 1) {
    waitQuiet();
    loads.push(systemLoad());
    for (let k = 0; k < subjects.length; k += 1) {
      const s = subjects[(k + r) % subjects.length] as Sample;
      s.sink.push(s.run());
    }
  }
  const endLoad = systemLoad();
  const gate = loadGate();

  const edits: EditRow[] = rows.map((r) => {
    const before = stats(r.before);
    const after = stats(r.after);
    return { task: r.task.id, retyped: r.retyped, functions: r.functions, before, after, speedup: round(before.median / after.median) };
  });
  const bm = median(edits.map((e) => e.before.median));
  const am = median(edits.map((e) => e.after.median));
  const formatted = programs.a0;
  return {
    version: 1,
    platform: osPlatform(),
    arch: process.arch,
    node: process.version,
    bun: toolVersion('bun', ['--version']),
    cpus: cpus().length,
    load: {
      source: loadSource(),
      limit: LOAD_LIMIT,
      max: Math.round(Math.max(startLoad, endLoad, ...loads, gate.highestLoadAtSampleStart) * 100) / 100,
      start: Math.round(startLoad * 100) / 100,
      end: Math.round(endLoad * 100) / 100,
      rounds: runs,
      waits: gate.waits,
    },
    method: {
      runs,
      warmups: WARMUPS,
      interleaved: true,
      notes: [
        'EditSession.apply in process on a warm session (session and views built before the clock); one sample per edit and mode per round, the order rotated each round',
        'before = withoutReuse(apply): every function typed again (what validate did before it reused typed functions by identity); after = apply: the edited functions and their transitive callers typed again',
        'the same code path runs in both modes; only the reuse of unchanged typed functions differs, so the speedup is the saving of validation alone (parse, format and hashing are in both)',
        'every sample asserts the two modes give the same program; the differential test (test/incremental-validate.test.ts) proves the equality for the 14 edits and thousands of random edits',
        'retyped counts functions of the result that are not the very objects of the start program: the edited functions and their transitive callers',
      ],
    },
    program: {
      functions: start.functions.length,
      formattedLines: formatted.length === 0 ? 0 : formatted.split('\n').length - (formatted.endsWith('\n') ? 1 : 0),
      formattedBytes: Buffer.byteLength(formatted),
    },
    edits,
    summary: {
      beforeMedianMs: round(bm),
      afterMedianMs: round(am),
      beforeSlowestMs: Math.max(...edits.map((e) => e.before.median)),
      afterSlowestMs: Math.max(...edits.map((e) => e.after.median)),
      speedupMedian: round(bm / am),
      speedupMin: Math.min(...edits.map((e) => e.speedup)),
      speedupMedianOfEdits: round(median(edits.map((e) => e.speedup))),
      retypedMedian: median(edits.map((e) => e.retyped)),
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'table') {
    const f = args[1] ?? 'results/edit-incremental.json';
    const r = JSON.parse(await readFile(f, 'utf8')) as EditIncrementalReport;
    process.stdout.write(`${renderTable(r)}\n`);
    const bad = validateReport(r);
    if (bad.length > 0) {
      process.stdout.write(`INVALID ${f}:\n  ${bad.join('\n  ')}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const report = await measure({ runs: Number(opt('--runs') ?? MIN_RUNS) });
  const out = opt('--out') ?? 'results/edit-incremental.json';
  await mkdir(dirname(out), { recursive: true });
  await writeReport(out, report);
  const bad = validateReport(report);
  process.stdout.write(`${renderTable(report)}\nwrote ${out}\n`);
  if (bad.length > 0) {
    process.stderr.write(`report problems:\n  ${bad.join('\n  ')}\n`);
    process.exitCode = 1;
  }
}

if (/edit-incremental\.[jt]s$/.test(process.argv[1] ?? '')) await main();
