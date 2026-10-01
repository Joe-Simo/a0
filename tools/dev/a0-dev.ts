/**
 * a0-dev: one entry point for the development loop. Every subcommand is a standalone deterministic
 * tool that also works on its own and prints machine-readable output with --json, so any wrapper
 * can drive it.
 *
 *   node dist/tools/dev/a0-dev.js <command> [flags]
 *
 *   scope       which gate steps a diff needs               (gate-scope)
 *   plan        batch and order branches for merging         (merge-plan)
 *   gate        run the selected steps, write the gate note  (dev-gate)
 *   drive       merge branches that carry passing notes      (drive)
 *   claims      numeric and comparative claims need results  (claim-check)
 *   decide      real regression, flake, pre-existing, unexplained (regress)
 *   classify    why a model reply failed                     (reply-classify)
 *   queue       failure groups ranked, --brief for the top   (queue)
 *   prereview   hunks that look like patches over symptoms   (prereview)
 *   tests       tests a diff can affect, --run to run them   (tests-run)
 *   order       riskiest-first step order and sentinels      (order)
 *   note        show the gate note on a commit               (gate-note)
 *   check       stuck | bench-validity | launch-gate | rank | verify-report  (loop-checks)
 *   loop        per-step wall-clock summary from results/dev-loop.json
 *   pre-merge   scope, plan (--plan=a,b), gate, claims in order; the first failing stage sets the exit code
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLog, summarize } from './loop-log.js';
import { defaultBase, defaultRepo } from './repo.js';

const here = dirname(fileURLToPath(import.meta.url));

const TOOLS: Readonly<Record<string, string>> = {
  scope: 'gate-scope',
  plan: 'merge-plan',
  gate: 'dev-gate',
  drive: 'drive',
  claims: 'claim-check',
  decide: 'regress',
  classify: 'reply-classify',
  queue: 'queue',
  prereview: 'prereview',
  tests: 'tests-run',
  order: 'order',
  note: 'gate-note',
  check: 'loop-checks',
};

function run(script: string, args: readonly string[]): number {
  const r = spawnSync(process.execPath, [join(here, `${script}.js`), ...args], {
    stdio: 'inherit',
  });
  return r.status ?? 1;
}

const [cmd = 'help', ...rest] = process.argv.slice(2);
const stage = (title: string): void => {
  process.stdout.write(`\n== ${title} ==\n`);
};

const tool = TOOLS[cmd];
if (tool) {
  process.exit(run(tool, rest));
} else if (cmd === 'loop') {
  const rows = summarize(readLog(defaultRepo()));
  process.stdout.write(
    rest.includes('--json')
      ? `${JSON.stringify(rows, null, 2)}\n`
      : rows.length === 0
        ? 'loop: no entries in results/dev-loop.json yet\n'
        : `${rows.map((r) => `${r.step.padEnd(11)} baseline ${r.baselineMs ?? '-'} ms (n=${r.baselineN})  assisted ${r.assistedMs ?? '-'} ms (n=${r.assistedN})  speedup ${r.speedup ?? 'needs 3 quiet runs per mode'}${r.excludedLoaded ? `  (${r.excludedLoaded} runs above load 10 excluded)` : ''}`).join('\n')}\n`,
  );
} else if (cmd === 'pre-merge') {
  const repo = defaultRepo();
  const base = defaultBase(repo);
  const common = rest.filter((a) => a === '--light' || a.startsWith('--add-steps='));
  const planned =
    rest
      .find((a) => a.startsWith('--plan='))
      ?.slice(7)
      .split(',')
      .filter(Boolean) ?? [];
  stage('gate-scope');
  let rc = run('gate-scope', common);
  if (planned.length > 1 && rc === 0) {
    stage('merge-plan');
    rc = run('merge-plan', planned);
  }
  if (rc === 0 && !rest.includes('--no-gate')) {
    stage('dev-gate');
    rc = run('dev-gate', common);
  }
  if (rc === 0) {
    stage('claim-check');
    rc = run('claim-check', [`--since=${base}`]);
  }
  process.exit(rc);
} else {
  process.stdout.write(
    'a0-dev <command>; see the header of tools/dev/a0-dev.ts for the commands\n',
  );
  process.exit(cmd === 'help' ? 0 : 2);
}
