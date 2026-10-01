/**
 * Deterministic loop checks. Each is a pure function over measured inputs with a plain-language
 * reason, and a CLI that prints JSON with --json, so any wrapper can drive it.
 *
 *   stuck           from output age, log age, load and process facts: progressing | slow-from-load |
 *                   stuck | finished-waiting
 *   bench-validity  from load samples, interleaving and sample count: publishable | loaded-discard |
 *                   needs-rerun (the repo rule: no timing claim from a run above load 10)
 *   launch-gate     is it safe to start another heavy agent at the current load
 *   rank            open tasks by expected gain per effort
 *   verify-report   each claim in an agent report: supported-by-evidence | inference | from-memory |
 *                   contradicted
 *
 *   node dist/tools/dev/loop-checks.js stuck --out-age=<s> --log-age=<s> [--load=<n>] [--cpus=<n>]
 *       [--finished] [--alive] [--json]
 *   node dist/tools/dev/loop-checks.js bench-validity --loads=3,4,5 --samples=7 [--interleaved] [--cpus=8]
 *   node dist/tools/dev/loop-checks.js launch-gate [--load=<n>] [--cpus=<n>] [--heavy=<running>]
 *   node dist/tools/dev/loop-checks.js rank <tasks.json>      ([{"name","gain","effort"}])
 *   node dist/tools/dev/loop-checks.js verify-report <report.txt>
 */

import { existsSync, readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultRepo, vcs } from './repo.js';

export const LOAD_LIMIT = 10;

export type StuckState = 'progressing' | 'slow-from-load' | 'stuck' | 'finished-waiting';
export interface StuckInput {
  /** Seconds since the agent last produced output. */
  readonly outAgeSec: number;
  /** Seconds since any watched log file changed. */
  readonly logAgeSec: number;
  readonly load1: number;
  readonly cpus: number;
  /** The agent printed a completion marker (a final report or GATE RESULT line). */
  readonly finishedMarker: boolean;
  /** A child process of the agent is still running. */
  readonly processAlive: boolean;
}

export function detectStuck(i: StuckInput): { state: StuckState; reason: string } {
  const quietSec = Math.min(i.outAgeSec, i.logAgeSec);
  if (i.finishedMarker && !i.processAlive) {
    return {
      state: 'finished-waiting',
      reason: 'completion marker seen and nothing is running; it is waiting to be read',
    };
  }
  if (quietSec < 120)
    return { state: 'progressing', reason: `output or log changed ${Math.round(quietSec)}s ago` };
  const loaded = i.load1 > LOAD_LIMIT || i.load1 > i.cpus * 1.5;
  if (loaded && quietSec < 20 * 60 && i.processAlive) {
    return {
      state: 'slow-from-load',
      reason: `quiet ${Math.round(quietSec / 60)} min while load is ${i.load1} on ${i.cpus} cores and a process is running`,
    };
  }
  if (quietSec >= 10 * 60) {
    return {
      state: 'stuck',
      reason: `no output or log change for ${Math.round(quietSec / 60)} min${loaded ? ' even allowing for load' : ' at normal load'}`,
    };
  }
  return {
    state: 'progressing',
    reason: `quiet ${Math.round(quietSec)}s, under the 10 minute limit and not loaded`,
  };
}

export type BenchState = 'publishable' | 'loaded-discard' | 'needs-rerun';
export function benchValidity(i: {
  readonly loads: readonly number[];
  readonly samples: number;
  readonly interleaved: boolean;
  readonly cpus: number;
}): { state: BenchState; reason: string } {
  if (i.loads.length === 0)
    return {
      state: 'needs-rerun',
      reason: 'no load samples were recorded; the run cannot be shown to be quiet',
    };
  const worst = Math.max(...i.loads);
  if (worst > LOAD_LIMIT)
    return {
      state: 'loaded-discard',
      reason: `load reached ${worst}, above ${LOAD_LIMIT}: no timing claim from this run`,
    };
  if (i.samples < 5)
    return {
      state: 'needs-rerun',
      reason: `${i.samples} samples is under the 5 needed for a median`,
    };
  if (!i.interleaved && worst > i.cpus / 2) {
    return {
      state: 'needs-rerun',
      reason: `load ${worst} is above half of ${i.cpus} cores and the sides were not interleaved`,
    };
  }
  return {
    state: 'publishable',
    reason: `load at most ${worst}, ${i.samples} samples${i.interleaved ? ', interleaved' : ', quiet machine'}`,
  };
}

export function launchGate(i: {
  readonly load1: number;
  readonly cpus: number;
  readonly heavyRunning: number;
}): {
  safe: boolean;
  reason: string;
} {
  if (i.load1 > LOAD_LIMIT)
    return { safe: false, reason: `load ${i.load1} is above ${LOAD_LIMIT}` };
  const headroom = i.cpus * 0.6 - i.load1;
  if (headroom < 2 + i.heavyRunning) {
    return {
      safe: false,
      reason: `headroom ${headroom.toFixed(1)} cores is under what ${i.heavyRunning + 1} heavy agents need`,
    };
  }
  return {
    safe: true,
    reason: `load ${i.load1} on ${i.cpus} cores leaves ${headroom.toFixed(1)} cores`,
  };
}

export interface Task {
  readonly name: string;
  readonly gain: number;
  readonly effort: number;
}
export function rankTasks(tasks: readonly Task[]): (Task & { readonly score: number })[] {
  return tasks
    .map((t) => ({ ...t, score: Number((t.gain / Math.max(t.effort, 0.01)).toFixed(3)) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export type ClaimClass = 'supported-by-evidence' | 'inference' | 'from-memory' | 'contradicted';
export interface ReportClaim {
  readonly line: number;
  readonly text: string;
  readonly cls: ClaimClass;
  readonly reason: string;
}

const HEDGE =
  /\b(should|probably|likely|presumably|appears?|seems?|i expect|i think|might|may|could|suggests?|would)\b/i;
const CLAIMY =
  /\d|\b(pass(?:es|ed)?|fail(?:s|ed)?|fix(?:es|ed)?|faster|slower|fewer|all |no longer|works?|verified|confirmed)\b/i;

function classifyLine(root: string, l: string): [ClaimClass, string] {
  const results = [...l.matchAll(/results\/[\w.-]+\.json/g)].map((m) => m[0]);
  for (const r of results) {
    if (!existsSync(join(root, r))) return ['contradicted', `cites ${r}, which does not exist`];
    const nums = [...l.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)]
      .map((m) => m[0])
      .filter((n) => n.length >= 2);
    const body = readFileSync(join(root, r), 'utf8');
    const missing = nums.filter((n) => !body.includes(n));
    if (nums.length > 0 && missing.length === nums.length) {
      return ['contradicted', `none of ${nums.slice(0, 3).join(', ')} appears in ${r}`];
    }
    return [
      'supported-by-evidence',
      `cites ${r}${nums.length ? ' and its numbers appear there' : ''}`,
    ];
  }
  const sha = /\b[0-9a-f]{7,40}\b/.exec(l)?.[0];
  if (sha && vcs(root, ['cat-file', '-e', `${sha}^{commit}`]).ok) {
    return ['supported-by-evidence', `names commit ${sha}`];
  }
  const file = /\b((?:src|tools|test|compiler|site|examples)\/[\w./-]+)/.exec(l)?.[1];
  if (file && existsSync(join(root, file)) && /GATE RESULT|rc=|exit/.test(l)) {
    return ['supported-by-evidence', `names ${file} with a result`];
  }
  if (/GATE RESULT: (?:pass|fail)/.test(l)) {
    return ['supported-by-evidence', 'quotes a gate result line'];
  }
  if (HEDGE.test(l)) return ['inference', 'hedged wording with no cited evidence'];
  return [
    'from-memory',
    'a factual claim with no file, results entry, commit or gate line to check it against',
  ];
}

/** Each claim-like line of a report, with what (if anything) backs it. */
export function verifyReport(root: string, text: string): ReportClaim[] {
  const out: ReportClaim[] = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim();
    if (l.length < 12 || !CLAIMY.test(l)) return;
    const [cls, reason] = classifyLine(root, l);
    out.push({ line: i + 1, text: l.slice(0, 200), cls, reason });
  });
  return out;
}

function arg(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const num = (v: string | undefined, d: number): number => (v === undefined ? d : Number(v));

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  const json = args.includes('--json');
  const out = (v: unknown, line: string): void => {
    process.stdout.write(json ? `${JSON.stringify(v, null, 2)}\n` : `${line}\n`);
  };
  const load1 = num(arg(args, 'load'), loadavg()[0] ?? 0);
  const ncpu = num(arg(args, 'cpus'), cpus().length);
  if (cmd === 'stuck') {
    const r = detectStuck({
      outAgeSec: num(arg(args, 'out-age'), 0),
      logAgeSec: num(arg(args, 'log-age'), 0),
      load1,
      cpus: ncpu,
      finishedMarker: args.includes('--finished'),
      processAlive: args.includes('--alive'),
    });
    out(r, `${r.state}: ${r.reason}`);
  } else if (cmd === 'bench-validity') {
    const r = benchValidity({
      loads: (arg(args, 'loads') ?? '').split(',').filter(Boolean).map(Number),
      samples: num(arg(args, 'samples'), 0),
      interleaved: args.includes('--interleaved'),
      cpus: ncpu,
    });
    out(r, `${r.state}: ${r.reason}`);
  } else if (cmd === 'launch-gate') {
    const r = launchGate({ load1, cpus: ncpu, heavyRunning: num(arg(args, 'heavy'), 0) });
    out(r, `${r.safe ? 'safe to launch' : 'do not launch'}: ${r.reason}`);
    process.exit(r.safe ? 0 : 1);
  } else if (cmd === 'rank') {
    const file = args.find((a) => !a.startsWith('--'));
    const r = rankTasks(JSON.parse(readFileSync(file ?? '/dev/stdin', 'utf8')) as Task[]);
    out(
      r,
      r
        .map((t, i) => `${i + 1}. ${t.name} (gain ${t.gain} / effort ${t.effort} = ${t.score})`)
        .join('\n'),
    );
  } else if (cmd === 'verify-report') {
    const file = args.find((a) => !a.startsWith('--'));
    const r = verifyReport(defaultRepo(), readFileSync(file ?? '/dev/stdin', 'utf8'));
    const bad = r.filter((c) => c.cls !== 'supported-by-evidence');
    out(
      r,
      `${r.length} claims, ${bad.length} not backed by evidence\n${bad.map((c) => `  line ${c.line} ${c.cls}: ${c.reason}\n    ${c.text}`).join('\n')}`,
    );
  } else {
    process.stdout.write(
      'usage: loop-checks stuck|bench-validity|launch-gate|rank|verify-report ...\n',
    );
    process.exit(2);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
