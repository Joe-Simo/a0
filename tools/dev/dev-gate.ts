/**
 * dev-gate: runs the gate steps selected by gate-scope one at a time, each with a timeout and its
 * own log file, in a run folder of its own (never shared with another agent or run). The last line
 * is `GATE RESULT: pass|fail` with every step's return code. It refuses to push when any required
 * step is missing, skipped, timed out or failed.
 *
 *   node dist/tools/dev/dev-gate.js [--repo=/abs/path] [--base=<ref>] [--light] [--steps=a,b]
 *       [--add-steps=a,b] [--keep-going] [--dry-run] [--json] [--mode=baseline|assisted]
 *       [--push=<remote>] [--scratch=/abs/dir] [--no-note]
 *
 * The repo is given by absolute path (default: the repo this tool was built in) and every step runs
 * with that path as its working directory. Logs go to <scratch>/a0-gate-<random>/NN-<step>.log
 * where scratch defaults to $A0_GATE_SCRATCH or the OS temp dir. On a pass of a clean commit a gate
 * note bound to the commit's tree is written (see gate-note.ts); every step also lands in
 * .a0-cache/gate-history.json, and with --mode in results/dev-loop.json. Steps run riskiest first
 * (cheap lint and typecheck, then the build, then by failure likelihood per cost) and stop at the
 * first failure unless --keep-going. `--json` prints the final report as one JSON object.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirtyTracked, writeNote } from './gate-note.js';
import {
  addSteps,
  computeScope,
  parseSteps,
  renderScope,
  type Scope,
  type StepId,
} from './gate-scope.js';
import { appendHistory, type HistoryRow, signature } from './history.js';
import { record } from './loop-log.js';
import { orderRuns } from './order.js';
import { changedFiles, defaultBase, defaultRepo, vcs } from './repo.js';

export interface StepRun {
  readonly id: string;
  readonly cmd: string;
  readonly timeoutMs: number;
}

const MIN = 60_000;
const BIN = 'dist/tools';
const node = (f: string): string => `node ${BIN}/${f}.js`;

/** Commands per step. `build` runs once before any step that reads dist/. */
export const BUILD: StepRun = { id: 'build', cmd: 'bun run build', timeoutMs: 10 * MIN };
export const COMMANDS: Readonly<Record<StepId, StepRun>> = {
  lint: { id: 'lint', cmd: 'bun run lint', timeoutMs: 10 * MIN },
  typecheck: { id: 'typecheck', cmd: 'bun run typecheck', timeoutMs: 10 * MIN },
  test: { id: 'test', cmd: 'node --test dist/test/*.test.js', timeoutMs: 30 * MIN },
  verify: { id: 'verify', cmd: node('verify'), timeoutMs: 90 * MIN },
  equiv: { id: 'equiv', cmd: node('equiv-verify'), timeoutMs: 45 * MIN },
  hw: { id: 'hw', cmd: node('hw-verify'), timeoutMs: 45 * MIN },
  app: { id: 'app', cmd: node('app'), timeoutMs: 45 * MIN },
  dotnet: { id: 'dotnet', cmd: node('dotnet-verify'), timeoutMs: 30 * MIN },
  gpu: { id: 'gpu', cmd: node('gpu-verify'), timeoutMs: 30 * MIN },
  selfhost: { id: 'selfhost', cmd: node('selfhost-verify'), timeoutMs: 45 * MIN },
  'selfhost-c': { id: 'selfhost-c', cmd: node('selfhost-c'), timeoutMs: 45 * MIN },
  bootstrap: {
    id: 'bootstrap',
    cmd: `${node('bootstrap')} && ${node('bootstrap-arm64')} && ${node('bootstrap-macho')}`,
    timeoutMs: 90 * MIN,
  },
  site: { id: 'site', cmd: node('site-build'), timeoutMs: 30 * MIN },
};

export type Outcome = 'pass' | 'fail' | 'timeout' | 'skipped' | 'not-run';
export interface StepResult {
  readonly id: string;
  readonly outcome: Outcome;
  readonly rc: number | null;
  readonly ms: number;
  readonly log: string | null;
}

/** Steps that read dist/ and so need the build first. */
const NEEDS_BUILD = (id: string): boolean => id !== 'lint' && id !== 'typecheck';

export function plan(
  steps: readonly StepId[],
  commands: Readonly<Record<string, StepRun>>,
): StepRun[] {
  const runs = steps.map((s) => commands[s]).filter((s): s is StepRun => s !== undefined);
  const missing = steps.filter((s) => commands[s] === undefined);
  if (missing.length) throw new Error(`no command for step ${missing.join(', ')}`);
  const out: StepRun[] = [];
  // lint and typecheck first (cheap, no dist), then the build, then the rest in scope order.
  for (const r of runs) if (!NEEDS_BUILD(r.id)) out.push(r);
  if (runs.some((r) => NEEDS_BUILD(r.id))) out.push(commands.build ?? BUILD);
  for (const r of runs) if (NEEDS_BUILD(r.id)) out.push(r);
  return out;
}

/**
 * Can this result be pushed? Every required step must have run and passed. A missing, skipped,
 * timed-out or failed step, a light run, or a hand-picked subset that leaves a required step out,
 * refuses the push.
 */
export function pushDecision(
  required: readonly string[],
  results: readonly StepResult[],
  light: boolean,
): { readonly allowed: boolean; readonly why: string[] } {
  const why: string[] = [];
  if (light) why.push('--light is a partial gate');
  for (const id of required) {
    const r = results.find((x) => x.id === id);
    if (!r) why.push(`step ${id} is missing`);
    else if (r.outcome !== 'pass') why.push(`step ${id} is ${r.outcome}`);
  }
  for (const r of results)
    if (r.outcome !== 'pass' && !required.includes(r.id)) why.push(`step ${r.id} is ${r.outcome}`);
  return { allowed: why.length === 0, why };
}

export function resultLine(results: readonly StepResult[], pass: boolean): string {
  const parts = results.map((r) => `${r.id}=${r.rc === null ? r.outcome : r.rc}`);
  return `GATE RESULT: ${pass ? 'pass' : 'fail'} ${parts.join(' ')}`;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Runs one command in its own process group, output to a log file, killed when the timeout hits. */
export function runStep(repo: string, run: StepRun, logPath: string): Promise<StepResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const fd = openSync(logPath, 'w');
    const child = spawn('sh', ['-c', run.cmd], {
      cwd: repo,
      stdio: ['ignore', fd, fd],
      detached: true,
      env: process.env,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 10_000).unref();
    }, run.timeoutMs);
    const done = (rc: number | null): void => {
      clearTimeout(timer);
      closeSync(fd);
      const ms = Date.now() - started;
      if (timedOut) resolve({ id: run.id, outcome: 'timeout', rc: 124, ms, log: logPath });
      else
        resolve({ id: run.id, outcome: rc === 0 ? 'pass' : 'fail', rc: rc ?? 1, ms, log: logPath });
    };
    child.on('error', () => done(127));
    child.on('close', (code) => done(code));
  });
}

export interface GateOptions {
  readonly repo: string;
  readonly runs: readonly StepRun[];
  readonly required: readonly string[];
  readonly light: boolean;
  readonly keepGoing: boolean;
  readonly scratch: string;
  readonly mode?: 'baseline' | 'assisted';
  /** Write the gate note on pass (default true). */
  readonly note?: boolean;
  readonly log?: (line: string) => void;
}

export interface GateReport {
  readonly dir: string;
  readonly results: StepResult[];
  readonly pass: boolean;
  readonly line: string;
  readonly noted: boolean;
}

export async function runGate(o: GateOptions): Promise<GateReport> {
  if (!isAbsolute(o.repo)) throw new Error('repo must be an absolute path');
  mkdirSync(o.scratch, { recursive: true });
  const dir = mkdtempSync(join(o.scratch, 'a0-gate-'));
  const say = o.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  say(`run folder ${dir}`);
  const cleanAtStart = !dirtyTracked(o.repo);
  const tree = vcs(o.repo, ['rev-parse', '--verify', '-q', 'HEAD^{tree}']).stdout.trim();
  const rows: HistoryRow[] = [];
  const results: StepResult[] = [];
  let failed = false;
  let n = 0;
  for (const run of o.runs) {
    n += 1;
    if (failed && !o.keepGoing) {
      results.push({ id: run.id, outcome: 'not-run', rc: null, ms: 0, log: null });
      continue;
    }
    const log = join(dir, `${String(n).padStart(2, '0')}-${run.id}.log`);
    say(`step ${run.id}: ${run.cmd}`);
    const r = await runStep(o.repo, run, log);
    say(`step ${run.id}: ${r.outcome} rc=${r.rc} ${(r.ms / 1000).toFixed(1)}s log ${log}`);
    results.push(r);
    if (r.outcome !== 'pass') failed = true;
    if (tree) {
      let sig = '';
      if (r.outcome !== 'pass') {
        try {
          sig = signature(readFileSync(log, 'utf8'));
        } catch {
          sig = 'nolog';
        }
      }
      rows.push({
        tree,
        step: run.id,
        rc: r.rc ?? 1,
        sig,
        run: dir,
        at: new Date().toISOString(),
        base: false,
      });
    }
    if (o.mode) record(o.repo, run.id, o.mode, r.ms);
  }
  if (rows.length) appendHistory(o.repo, rows);
  const requiredPlusBuild = o.runs.some((r) => r.id === 'build')
    ? [...o.required, 'build']
    : o.required;
  const missing = requiredPlusBuild.filter((id) => !results.some((r) => r.id === id));
  const pass = !failed && missing.length === 0 && results.every((r) => r.outcome === 'pass');
  const line = resultLine(results, pass);
  let noted = false;
  if (pass && o.note !== false) {
    if (cleanAtStart) {
      const ids = results.map((r) => r.id).filter((id) => id !== 'build');
      noted = writeNote(o.repo, 'HEAD', { steps: ids, light: o.light, result: 'pass' }) !== null;
      say(
        noted ? 'gate note written for HEAD (bound to its tree)' : 'gate note could not be written',
      );
    } else {
      say('gate note NOT written: tracked files had uncommitted changes when the gate started');
    }
  }
  writeFileSync(
    join(dir, 'summary.json'),
    `${JSON.stringify({ line, loadavg: loadavg(), results, missing, noted }, null, 2)}\n`,
  );
  say(line);
  return { dir, results, pass, line, noted };
}

function arg(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repo = arg(args, 'repo') ?? defaultRepo();
  if (!isAbsolute(repo)) {
    process.stderr.write('dev-gate: --repo must be an absolute path\n');
    process.exit(2);
  }
  const base = arg(args, 'base') ?? defaultBase(repo);
  const light = args.includes('--light');
  const extra = parseSteps(arg(args, 'add-steps'));
  const files = changedFiles(repo, base);
  const scope: Scope = addSteps(computeScope(repo, files, { light }), extra, '--add-steps');
  const fullRequired = addSteps(computeScope(repo, files), extra, '--add-steps').steps.map(
    (s) => s.step,
  );
  if (!args.includes('--json')) process.stdout.write(`base ${base}\n${renderScope(scope)}\n`);
  const picked = arg(args, 'steps');
  const steps = (picked ? picked.split(',') : scope.steps.map((s) => s.step)) as StepId[];
  const runs = orderRuns(plan(steps, { ...COMMANDS, build: BUILD }), repo);
  if (args.includes('--dry-run')) {
    for (const r of runs) process.stdout.write(`would run ${r.id}: ${r.cmd}\n`);
    return;
  }
  const scratch =
    arg(args, 'scratch') ?? process.env.A0_GATE_SCRATCH ?? join(tmpdir(), 'a0-dev-gate');
  const modeArg = arg(args, 'mode');
  const mode = modeArg === 'baseline' || modeArg === 'assisted' ? modeArg : undefined;
  const report = await runGate({
    repo,
    runs,
    required: light ? scope.steps.map((s) => s.step) : fullRequired,
    light,
    keepGoing: args.includes('--keep-going'),
    scratch,
    note: !args.includes('--no-note'),
    ...(mode ? { mode } : {}),
    ...(args.includes('--json') ? { log: () => undefined } : {}),
  });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...report, scope }, null, 2)}\n`);
  }
  const remote = arg(args, 'push');
  if (remote) {
    const d = pushDecision(fullRequired, report.results, light);
    if (!report.pass || !d.allowed) {
      process.stdout.write(
        `PUSH REFUSED: ${[...d.why, ...(report.pass ? [] : ['gate did not pass'])].join('; ')}\n`,
      );
      process.exit(1);
    }
    const r = vcs(repo, ['push', remote, 'HEAD']);
    process.stdout.write(r.ok ? `pushed HEAD to ${remote}\n` : `push failed rc=${r.code}\n`);
    if (!r.ok) process.exit(1);
  }
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.stdout.write('GATE RESULT: fail dev-gate-error\n');
    process.exit(1);
  });
}
