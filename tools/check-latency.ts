/**
 * Edit-check latency, head to head: how long until "is this edit right?" is answered, on the same real code.
 *
 * The code is the application-scale front end of docs/history/2026-10-06-app-edit-preregistration.md: the A0 side is
 * compiler/parse.a0 linked with compiler/lex.a0 (tools/app-edit-bench.ts startPrograms), the TypeScript side is
 * tools/ref-parse.ts up to its suggestions section (the same text the sealed tasks show). The edits are the reference
 * solutions of the 14 sealed tasks of tools/app-edit-tasks.ts.
 *
 * What is timed (never the same work, and the report says so):
 *   a0 edit      EditSession.apply of one reference edit on a warm session: the incremental, per-function validation a
 *                model's tool call causes. In process, no process start. The session is built and its views opened
 *                before the clock starts (that is the "warm" part); only apply is timed.
 *   a0 cold open parseAndValidate of the whole linked front end in process: what opening a program costs once per session,
 *                and the apples-to-apples case where A0 checks the whole project like the others.
 *   a0 cold proc the same, in a fresh `node` process that loads the compiler and reads the file: a whole-project check
 *                priced like the competitors, which are all fresh processes.
 *   tsc          `node tsc.js --noEmit --incremental false -p tsconfig.json` on front.ts, TypeScript from node_modules.
 *   tsgo         TypeScript 7 native preview (npm @typescript/native-preview), same flags, installed in a scratch directory.
 *   tsc-rs       npm tsc-rs, same flags, only where it runs (Linux x64, macOS arm64); absent otherwise, with the reason.
 *   bun check    absent when `bun check` is not a command (bun 1.4.2: it is the script runner, not a type checker).
 *
 * Method (hyperfine-style without hyperfine): 3 warmup rounds, then N >= 15 measured rounds; each round samples every
 * subject once in a rotating order (interleaved), after the load gate (tools/quiet.ts, tools/system-load.ts, limit 10);
 * medians with min and max. Verdicts use the loss ledger's tie band (tools/loss-ledger.ts spreadBand): 8 %, or the larger
 * observed max/min spread of the two sides, never above 25 %; a gap inside it is a tie, a bigger one a win or a loss.
 *
 *   bun run check-latency [-- --out results/check-latency-<platform>.json] [--runs 15] [--tools DIR]
 *   bun run check-latency -- table [FILE...]       print the summary table of existing reports
 *
 * DIR (or CHECK_LATENCY_TOOLS) holds `npm i @typescript/native-preview tsc-rs` (not a dependency of this repository).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform as osPlatform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseAndValidate } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { extractBlock } from './ai-edit-apply.js';
import { checkStart, startPrograms, TS_FILE } from './app-edit-bench.js';
import { APP_TASKS, type AppTask } from './app-edit-tasks.js';
import { loadGate, waitQuiet } from './quiet.js';
import { writeReport } from './scrub-results.js';
import { loadSource, systemLoad } from './system-load.js';

/** AGENTS.md: no timing claim from a run recorded above load average 10. */
export const LOAD_LIMIT = 10;
export const MIN_RUNS = 15;
export const WARMUPS = 3;

// --- statistics and verdicts (pure; test/check-latency.test.ts) ------------------------------------

export interface Stats {
  readonly n: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  /** Every measured sample, in round order, milliseconds. */
  readonly samples: readonly number[];
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median of no samples');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

const round = (x: number): number => Math.round(x * 1e6) / 1e6;

export function stats(samples: readonly number[]): Stats {
  return {
    n: samples.length,
    median: round(median(samples)),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    samples: samples.map(round),
  };
}

export type Verdict = 'win' | 'tie' | 'loss';

/** Tie band of tools/loss-ledger.ts: 8 %, or the observed max/min spread of either side, never above 25 %. */
export function tieBand(a: Pick<Stats, 'min' | 'max'>, b: Pick<Stats, 'min' | 'max'>): number {
  const sp = (s: Pick<Stats, 'min' | 'max'>): number => (s.min > 0 ? s.max / s.min : 1);
  return Math.min(Math.max(1.08, sp(a), sp(b)), 1.25) - 1;
}

export interface Judged {
  /** a0 median / other median - 1: negative is A0 faster. */
  readonly gap: number;
  readonly band: number;
  /** Other median over A0 median (how many times faster A0 is; below 1 means slower). */
  readonly ratio: number;
  readonly verdict: Verdict;
}

/** A0 against one competitor, lower is better. A gap beyond the band either way is a win or a loss. */
export function judge(a0: Stats, other: Stats): Judged {
  const gap = a0.median / other.median - 1;
  const band = tieBand(a0, other);
  const verdict: Verdict = gap < -band ? 'win' : gap > band ? 'loss' : 'tie';
  return {
    gap: round(gap),
    band: round(band),
    ratio: round(other.median / a0.median),
    verdict,
  };
}

// --- the report -----------------------------------------------------------------------------------

export interface ToolInfo {
  readonly available: boolean;
  readonly version?: string;
  readonly command?: string;
  /** Why it was not run, when it was not. */
  readonly reason?: string;
}

export interface EditRow {
  readonly task: string;
  /** Lines and bytes of the A0 reference edit text. */
  readonly editLines: number;
  readonly editBytes: number;
  /** Lines of the functions the edit opens (its dependency view): what the validation is about. */
  readonly viewLines: number;
  readonly apply: Stats;
}

export interface Comparison {
  readonly subject: string;
  readonly competitor: string;
  readonly kind: 'edit' | 'whole-project';
  /** The task for an edit row; absent for the whole-project row. */
  readonly task?: string;
  readonly a0Ms: number;
  readonly otherMs: number;
  readonly gap: number;
  readonly band: number;
  readonly ratio: number;
  readonly verdict: Verdict;
}

export interface CheckLatencyReport {
  readonly version: 1;
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly bun: string;
  readonly cpus: number;
  readonly load: {
    readonly source: string;
    readonly limit: number;
    /** Highest load seen at a round start, and at the gate's start and end. */
    readonly max: number;
    readonly start: number;
    readonly end: number;
    readonly rounds: number;
    readonly waits: number;
  };
  readonly method: {
    readonly runs: number;
    readonly warmups: number;
    readonly interleaved: true;
    readonly tieBand: string;
    readonly notes: readonly string[];
  };
  readonly tools: Record<string, ToolInfo>;
  readonly size: {
    readonly a0: {
      readonly sourceFiles: readonly string[];
      readonly sourceLines: number;
      readonly sourceBytes: number;
      readonly formattedLines: number;
      readonly formattedBytes: number;
      readonly functions: number;
    };
    readonly ts: { readonly file: string; readonly lines: number; readonly bytes: number };
  };
  readonly a0: {
    readonly edits: readonly EditRow[];
    /** The median over the 14 tasks of each task's median apply, and the slowest task. */
    readonly editMedianMs: number;
    readonly editSlowestMs: number;
    readonly coldOpenInProcess: Stats;
    readonly coldOpenProcess: Stats;
  };
  readonly wholeProject: Record<string, Stats>;
  readonly comparisons: readonly Comparison[];
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isStats = (v: unknown): v is Stats => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Stats;
  return (
    Number.isInteger(s.n) &&
    s.n >= 1 &&
    Array.isArray(s.samples) &&
    s.samples.length === s.n &&
    s.min <= s.median &&
    s.median <= s.max &&
    s.samples.every((x) => Number.isFinite(x) && x >= 0)
  );
};

/** Schema and arithmetic problems of a report (empty: valid). Used by the test and by `table`. */
export function validateReport(r: unknown): string[] {
  const bad: string[] = [];
  const rep = r as CheckLatencyReport;
  if (typeof r !== 'object' || r === null) return ['not an object'];
  if (rep.version !== 1) bad.push('version must be 1');
  for (const k of ['platform', 'arch', 'node', 'bun'] as const)
    if (!nonEmpty(rep[k])) bad.push(`${k} missing`);
  if (typeof rep.load?.max !== 'number' || rep.load.limit !== LOAD_LIMIT) bad.push('load missing');
  else if (rep.load.max > LOAD_LIMIT) bad.push(`load ${rep.load.max} above ${LOAD_LIMIT}`);
  if (rep.method?.runs < MIN_RUNS) bad.push(`fewer than ${MIN_RUNS} runs`);
  if (rep.method?.warmups < WARMUPS) bad.push(`fewer than ${WARMUPS} warmups`);
  for (const [name, t] of Object.entries(rep.tools ?? {})) {
    if (typeof t.available !== 'boolean') bad.push(`tool ${name}: available missing`);
    else if (t.available && !(nonEmpty(t.version) && nonEmpty(t.command)))
      bad.push(`tool ${name}: version and command are required when it ran`);
    else if (!t.available && !nonEmpty(t.reason)) bad.push(`tool ${name}: reason required`);
  }
  if (!(rep.size?.a0?.formattedLines > 0 && rep.size?.ts?.lines > 0)) bad.push('size missing');
  if (!Array.isArray(rep.a0?.edits) || rep.a0.edits.length === 0) bad.push('no edits');
  for (const e of rep.a0?.edits ?? []) {
    if (!isStats(e.apply)) bad.push(`edit ${e.task}: bad stats`);
    else if (e.apply.n < MIN_RUNS) bad.push(`edit ${e.task}: fewer than ${MIN_RUNS} samples`);
  }
  for (const k of ['coldOpenInProcess', 'coldOpenProcess'] as const)
    if (!isStats(rep.a0?.[k])) bad.push(`${k}: bad stats`);
  for (const [name, s] of Object.entries(rep.wholeProject ?? {}))
    if (!isStats(s) || s.n < MIN_RUNS) bad.push(`wholeProject ${name}: bad stats`);
  for (const c of rep.comparisons ?? []) {
    const id = `${c.subject} vs ${c.competitor}${c.task === undefined ? '' : ` (${c.task})`}`;
    const gap = c.a0Ms / c.otherMs - 1;
    if (Math.abs(gap - c.gap) > 1e-4 + Math.abs(gap) * 1e-4)
      bad.push(`${id}: gap ${c.gap} is not ${gap}`);
    const v: Verdict = c.gap < -c.band ? 'win' : c.gap > c.band ? 'loss' : 'tie';
    if (v !== c.verdict)
      bad.push(`${id}: verdict ${c.verdict} but gap ${c.gap} and band ${c.band} give ${v}`);
    if (c.band < 0.08 - 1e-9 || c.band > 0.25 + 1e-9)
      bad.push(`${id}: band ${c.band} outside 8%..25%`);
  }
  return bad;
}

const ms = (x: number): string => (x < 10 ? x.toFixed(3) : x < 100 ? x.toFixed(1) : x.toFixed(0));

/** The summary table: per-edit and whole-project, A0 against each competitor. */
export function renderTable(r: CheckLatencyReport): string {
  const out: string[] = [];
  out.push(
    `check latency ${r.platform}-${r.arch}: load max ${r.load.max} (limit ${r.load.limit}, ${r.load.source}), ${r.method.runs} runs, ${r.method.warmups} warmups, interleaved`,
  );
  out.push(
    `code: A0 ${r.size.a0.formattedLines} lines / ${r.size.a0.formattedBytes} bytes (${r.size.a0.functions} functions, as formatted); TypeScript ${r.size.ts.lines} lines / ${r.size.ts.bytes} bytes`,
  );
  const unavailable = Object.entries(r.tools).filter(([, t]) => !t.available);
  for (const [n, t] of unavailable) out.push(`  not run: ${n}: ${t.reason}`);
  out.push('');
  const wp = r.comparisons.filter((c) => c.kind === 'whole-project');
  out.push('whole project (ms, median [min..max])');
  for (const [name, s] of Object.entries(r.wholeProject))
    out.push(`  ${name.padEnd(22)} ${ms(s.median).padStart(9)}  [${ms(s.min)}..${ms(s.max)}]`);
  out.push(
    `  ${'a0 cold open (in-proc)'.padEnd(22)} ${ms(r.a0.coldOpenInProcess.median).padStart(9)}  [${ms(r.a0.coldOpenInProcess.min)}..${ms(r.a0.coldOpenInProcess.max)}]`,
  );
  out.push(
    `  ${'a0 cold open (proc)'.padEnd(22)} ${ms(r.a0.coldOpenProcess.median).padStart(9)}  [${ms(r.a0.coldOpenProcess.min)}..${ms(r.a0.coldOpenProcess.max)}]`,
  );
  for (const c of wp)
    out.push(
      `  ${c.subject} vs ${c.competitor}: ${c.verdict} (A0 ${ms(c.a0Ms)} ms, ${ms(c.otherMs)} ms, ${c.ratio.toFixed(2)}x, band ${(c.band * 100).toFixed(0)}%)`,
    );
  out.push('');
  out.push(
    'one edit, A0 EditSession.apply on a warm session (ms), verdict against each competitor on the whole project',
  );
  const comps = [
    ...new Set(r.comparisons.filter((c) => c.kind === 'edit').map((c) => c.competitor)),
  ];
  out.push(`  ${'task'.padEnd(26)} ${'apply ms'.padStart(9)}  ${comps.join('  ')}`);
  for (const e of r.a0.edits) {
    const cells = comps.map((c) => {
      const cmp = r.comparisons.find(
        (x) => x.kind === 'edit' && x.task === e.task && x.competitor === c,
      );
      return cmp === undefined ? '-' : `${cmp.verdict} ${cmp.ratio.toFixed(0)}x`;
    });
    out.push(`  ${e.task.padEnd(26)} ${ms(e.apply.median).padStart(9)}  ${cells.join('  ')}`);
  }
  out.push(`  median over tasks ${ms(r.a0.editMedianMs)} ms, slowest ${ms(r.a0.editSlowestMs)} ms`);
  return out.join('\n');
}

/** Build the comparisons of a report from its measured stats (pure). */
export function compare(
  edits: readonly EditRow[],
  coldOpen: Stats,
  coldProc: Stats,
  whole: Record<string, Stats>,
): Comparison[] {
  const out: Comparison[] = [];
  const row = (
    subject: string,
    kind: Comparison['kind'],
    a: Stats,
    name: string,
    o: Stats,
    task?: string,
  ): void => {
    const j = judge(a, o);
    out.push({
      subject,
      competitor: name,
      kind,
      ...(task === undefined ? {} : { task }),
      a0Ms: a.median,
      otherMs: o.median,
      gap: j.gap,
      band: j.band,
      ratio: j.ratio,
      verdict: j.verdict,
    });
  };
  for (const [name, o] of Object.entries(whole)) {
    for (const e of edits) row('a0 edit apply (warm session)', 'edit', e.apply, name, o, e.task);
    row('a0 whole front end, in process', 'whole-project', coldOpen, name, o);
    row('a0 whole front end, fresh process', 'whole-project', coldProc, name, o);
  }
  return out;
}

// --- measuring ------------------------------------------------------------------------------------

function lineCount(s: string): number {
  return s.length === 0 ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

function makeSession(program: ReturnType<typeof parseAndValidate>, task: AppTask): EditSession {
  const session = new EditSession(program);
  for (const f of task.a0Targets) session.open(f, { scope: 'deps' });
  session.openProgram({ scope: 'all', target: task.a0Targets[0] as string });
  return session;
}

function toolVersion(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
}

interface Subject {
  readonly name: string;
  readonly sample: () => number;
}

function runCheck(cmd: string, args: readonly string[], cwd: string): number {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  const dt = performance.now() - t0;
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stdout ?? '').slice(0, 400)}${(r.stderr ?? '').slice(0, 400)}`,
    );
  return dt;
}

export async function measure(opts: {
  runs: number;
  toolsDir: string | undefined;
}): Promise<CheckLatencyReport> {
  const runs = Math.max(opts.runs, MIN_RUNS);
  const programs = await startPrograms();
  checkStart(programs);
  const startLoad = systemLoad();
  const program = parseAndValidate(programs.a0);
  const srcFiles = ['compiler/lex.a0', 'compiler/parse.a0'];
  const srcTexts = await Promise.all(srcFiles.map((f) => readFile(f, 'utf8')));
  const a0Size = {
    sourceFiles: srcFiles,
    sourceLines: srcTexts.reduce((n, t) => n + lineCount(t), 0),
    sourceBytes: srcTexts.reduce((n, t) => n + Buffer.byteLength(t), 0),
    formattedLines: lineCount(programs.a0),
    formattedBytes: Buffer.byteLength(programs.a0),
    functions: program.byName.size,
  };

  // The TypeScript project: front.ts and its tsconfig, in a scratch directory, with the options the app-edit bench checks with.
  const dir = await mkdtemp(join(tmpdir(), 'a0-check-latency-'));
  const req = createRequire(import.meta.url);
  const typeRoot = dirname(dirname(req.resolve('@types/node/package.json')));
  await writeFile(join(dir, TS_FILE), programs.ts, 'utf8');
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'Bundler',
        lib: ['ES2023'],
        types: ['node'],
        typeRoots: [typeRoot],
        noEmit: true,
        skipLibCheck: true,
      },
      files: [TS_FILE],
    }),
    'utf8',
  );
  const flags = ['--noEmit', '--incremental', 'false', '-p', 'tsconfig.json'];
  const tools: Record<string, ToolInfo> = {};
  const subjects: Subject[] = [];
  const coldFile = join(dir, 'front.a0');
  await writeFile(coldFile, programs.a0, 'utf8');

  // tsc 5.9 from node_modules
  const tscJs = req.resolve('typescript/lib/tsc.js');
  tools.tsc = {
    available: true,
    version: `TypeScript ${toolVersion(process.execPath, [tscJs, '--version']).replace(/^Version /, '')}`,
    command: `node tsc.js ${flags.join(' ')}`,
  };
  subjects.push({ name: 'tsc', sample: () => runCheck(process.execPath, [tscJs, ...flags], dir) });

  const toolsDir = opts.toolsDir ?? process.env.CHECK_LATENCY_TOOLS;
  const plat = osPlatform();
  const arch = process.arch;
  // tsgo: TypeScript 7 native preview
  const exe = plat === 'win32' ? 'tsgo.exe' : 'tsgo';
  let tsgo: string | undefined;
  if (toolsDir !== undefined) {
    const nm = join(toolsDir, 'node_modules', '@typescript');
    if (existsSync(nm)) {
      const pkg = readdirSync(nm).find((n) => n === `native-preview-${plat}-${arch}`);
      if (pkg !== undefined && existsSync(join(nm, pkg, 'lib', exe)))
        tsgo = join(nm, pkg, 'lib', exe);
    }
  }
  if (tsgo === undefined)
    tools.tsgo = {
      available: false,
      reason:
        toolsDir === undefined
          ? 'no tools directory given (--tools or CHECK_LATENCY_TOOLS with npm i @typescript/native-preview)'
          : `@typescript/native-preview not installed in the tools directory for ${plat}-${arch}`,
    };
  else {
    const t = tsgo;
    tools.tsgo = {
      available: true,
      version: `TypeScript native preview ${toolVersion(t, ['--version']).replace(/^Version /, '')}`,
      command: `tsgo ${flags.join(' ')}`,
    };
    subjects.push({ name: 'tsgo', sample: () => runCheck(t, flags, dir) });
  }

  // tsc-rs (Linux x64 and macOS arm64 only)
  const rsOk = (plat === 'linux' && arch === 'x64') || (plat === 'darwin' && arch === 'arm64');
  const rsBin =
    toolsDir === undefined ? undefined : join(toolsDir, 'node_modules', '.bin', 'tsc-rs');
  if (!rsOk)
    tools['tsc-rs'] = {
      available: false,
      reason: `npm tsc-rs ships binaries for Linux x64 and macOS arm64 only; this is ${plat}-${arch}`,
    };
  else if (rsBin === undefined || !existsSync(rsBin))
    tools['tsc-rs'] = {
      available: false,
      reason: 'tsc-rs is not installed in the tools directory',
    };
  else {
    let version = '';
    try {
      version = `tsc-rs ${(JSON.parse(await readFile(join(toolsDir as string, 'node_modules', 'tsc-rs', 'package.json'), 'utf8')) as { version: string }).version}`;
    } catch {
      version = 'tsc-rs (version unreadable)';
    }
    tools['tsc-rs'] = { available: true, version, command: `tsc-rs ${flags.join(' ')}` };
    subjects.push({ name: 'tsc-rs', sample: () => runCheck(rsBin, flags, dir) });
  }

  // bun check
  const bunCheck = spawnSync('bun', ['check', '--help'], { encoding: 'utf8' });
  const bunVersion = toolVersion('bun', ['--version']);
  tools['bun check'] =
    bunCheck.status === 0
      ? {
          available: false,
          reason: `bun ${bunVersion} answers \`bun check --help\`, but no type-checking command is wired into this tool`,
        }
      : {
          available: false,
          reason: `bun ${bunVersion}: \`bun check\` is not a command (bun treats it as a package script name and fails: ${(bunCheck.stderr ?? '').trim().split('\n')[0]})`,
        };

  // A0 cold process: a fresh node process loads the compiler and validates the whole front end.
  const coreUrl = new URL('../src/core.js', import.meta.url).href;
  const coldScript = `import { readFileSync } from 'node:fs'; import { parseAndValidate } from ${JSON.stringify(coreUrl)}; const p = parseAndValidate(readFileSync(${JSON.stringify(coldFile)}, 'utf8')); if (p.byName.size < 1) process.exit(2);`;
  tools.a0 = {
    available: true,
    version: `A0 ${(JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version} (src/core.ts parseAndValidate, src/edit.ts EditSession on node ${process.version})`,
    command:
      'EditSession.apply(reference edit) on a warm session; parseAndValidate(whole linked front end)',
  };

  // Subjects: A0 whole front end in process and fresh process, then each edit.
  const coldIn: number[] = [];
  const coldProc: number[] = [];
  const subjectOrder: { name: string; sample: () => number; sink: number[] }[] = [];
  const wholeSamples: Record<string, number[]> = {};
  for (const s of subjects) {
    wholeSamples[s.name] = [];
    subjectOrder.push({ name: s.name, sample: s.sample, sink: wholeSamples[s.name] as number[] });
  }
  subjectOrder.push({
    name: 'a0 cold open (in process)',
    sample: () => {
      const t0 = performance.now();
      const p = parseAndValidate(programs.a0);
      const dt = performance.now() - t0;
      if (p.byName.size !== program.byName.size) throw new Error('cold open changed the program');
      return dt;
    },
    sink: coldIn,
  });
  subjectOrder.push({
    name: 'a0 cold open (fresh process)',
    sample: () => runCheck(process.execPath, ['--input-type=module', '-e', coldScript], dir),
    sink: coldProc,
  });
  const editSamples = new Map<string, number[]>();
  for (const task of APP_TASKS) {
    const sink: number[] = [];
    editSamples.set(task.id, sink);
    const reply = extractBlock(task.reference.a0);
    subjectOrder.push({
      name: `a0 edit ${task.id}`,
      sample: () => {
        const session = makeSession(program, task);
        const t0 = performance.now();
        session.apply(reply);
        return performance.now() - t0;
      },
      sink,
    });
  }

  // Warmups (not recorded), then interleaved rounds, the order rotated each round, the load gate before each round.
  const loads: number[] = [];
  for (let w = 0; w < WARMUPS; w += 1) {
    waitQuiet();
    for (const s of subjectOrder) s.sample();
  }
  for (let r = 0; r < runs; r += 1) {
    waitQuiet();
    loads.push(systemLoad());
    for (let k = 0; k < subjectOrder.length; k += 1) {
      const s = subjectOrder[(k + r) % subjectOrder.length] as (typeof subjectOrder)[number];
      s.sink.push(s.sample());
    }
  }
  const endLoad = systemLoad();
  await rm(dir, { recursive: true, force: true });

  const whole: Record<string, Stats> = {};
  for (const [name, xs] of Object.entries(wholeSamples)) whole[name] = stats(xs);
  const edits: EditRow[] = APP_TASKS.map((task) => {
    const reply = extractBlock(task.reference.a0);
    const session = makeSession(program, task);
    const view = task.a0Targets.map((_, i) => session.view(`e${i}`)).join('\n');
    return {
      task: task.id,
      editLines: lineCount(reply),
      editBytes: Buffer.byteLength(reply),
      viewLines: lineCount(view),
      apply: stats(editSamples.get(task.id) as number[]),
    };
  });
  const coldInStats = stats(coldIn);
  const coldProcStats = stats(coldProc);
  const gate = loadGate();
  const medians = edits.map((e) => e.apply.median);
  const report: CheckLatencyReport = {
    version: 1,
    platform: plat,
    arch,
    node: process.version,
    bun: bunVersion,
    cpus: cpus().length,
    load: {
      source: loadSource(),
      limit: LOAD_LIMIT,
      max:
        Math.round(Math.max(startLoad, endLoad, ...loads, gate.highestLoadAtSampleStart) * 100) /
        100,
      start: Math.round(startLoad * 100) / 100,
      end: Math.round(endLoad * 100) / 100,
      rounds: runs,
      waits: gate.waits,
    },
    method: {
      runs,
      warmups: WARMUPS,
      interleaved: true,
      tieBand:
        'loss-ledger band: 8 %, or the larger max/min spread of the two sides, never above 25 %; a gap inside it is a tie',
      notes: [
        'A0 edit rows time EditSession.apply in process on a warm session (session and views built before the clock); the competitors are whole-project checks in fresh processes started by spawnSync, wall time',
        'A0 checks one function incrementally (the edited function and what depends on it) and the whole program is held; tsc, tsgo and tsc-rs re-check the whole project every time',
        'the A0 whole-front-end rows validate all of compiler/lex.a0 + compiler/parse.a0 from scratch: in process (no process start) and in a fresh node process (priced like the competitors)',
        'finding: EditSession.apply is not O(function) today: src/edit.ts commit() calls validate() (src/core.ts), which re-validates every function of the program; the saving over a cold open is the parse and the session reuse, not an incremental check',
        'every sample asserts success: apply accepted the edit, the competitors exited 0 with no diagnostics',
        'the TypeScript side is checked on the start program; the check cost does not depend on which function was edited',
      ],
    },
    tools,
    size: {
      a0: a0Size,
      ts: { file: TS_FILE, lines: lineCount(programs.ts), bytes: Buffer.byteLength(programs.ts) },
    },
    a0: {
      edits,
      editMedianMs: round(median(medians)),
      editSlowestMs: Math.max(...medians),
      coldOpenInProcess: coldInStats,
      coldOpenProcess: coldProcStats,
    },
    wholeProject: whole,
    comparisons: compare(edits, coldInStats, coldProcStats, whole),
  };
  return report;
}

// --- CLI ----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'table') {
    const files =
      args.slice(1).length > 0
        ? args.slice(1)
        : readdirSync('results')
            .filter((f) => /^check-latency-.*\.json$/.test(f))
            .map((f) => join('results', f));
    for (const f of files) {
      const r = JSON.parse(await readFile(f, 'utf8')) as CheckLatencyReport;
      const bad = validateReport(r);
      process.stdout.write(`${renderTable(r)}\n`);
      if (bad.length > 0) {
        process.stdout.write(`INVALID ${f}:\n  ${bad.join('\n  ')}\n`);
        process.exitCode = 1;
      }
      process.stdout.write('\n');
    }
    return;
  }
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const report = await measure({
    runs: Number(opt('--runs') ?? MIN_RUNS),
    toolsDir: opt('--tools'),
  });
  const out =
    opt('--out') ?? join('results', `check-latency-${report.platform}-${report.arch}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeReport(out, report);
  const bad = validateReport(report);
  process.stdout.write(`${renderTable(report)}\nwrote ${out}\n`);
  if (bad.length > 0) {
    process.stderr.write(`report problems:\n  ${bad.join('\n  ')}\n`);
    process.exitCode = 1;
  }
}

if (/check-latency\.[jt]s$/.test(process.argv[1] ?? '')) await main();
