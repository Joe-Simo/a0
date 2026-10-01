/**
 * drive: the merge pipeline's last stage. Given branches that each passed a (light) gate and carry a
 * gate note bound to their tree, it
 *   1. refuses any branch without a passing note for its current tree that covers its light scope,
 *   2. plans batches (merge-plan: independent branches together, coupled ones riskiest first),
 *   3. with --merge: merges each batch with --no-ff, runs ONE combined gate for the batch (the union
 *      of its branches' full scopes), and on a loss reverts only the branch whose change caused it,
 *   4. writes a gate note on the new head after a pass.
 * Without --merge it only prints the plan and the note checks. It never pushes.
 *
 *   node dist/tools/dev/drive.js [--base=<ref>] [--merge] [--json] <branch> <branch> ...
 *
 * Run it in a clean checkout of the base branch.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD, COMMANDS, plan, runGate, type StepRun } from './dev-gate.js';
import { dirtyTracked, noteCovers } from './gate-note.js';
import { computeScope, STEPS, type StepId } from './gate-scope.js';
import {
  type Batch,
  type BranchInfo,
  buildPair,
  loadBranch,
  type Pair,
  planBatches,
  renderPlan,
} from './merge-plan.js';
import { orderRuns } from './order.js';
import { defaultBase, defaultRepo, ensureMergeDriver, refExists, vcs } from './repo.js';

export interface DriveOptions {
  readonly repo: string;
  readonly base: string;
  readonly branches: readonly string[];
  readonly merge: boolean;
  readonly scratch: string;
  /** Use the content-addressed step cache and commit regenerated results (the CLI turns both on). */
  readonly fast?: boolean;
  /** Step commands (tests inject fakes). */
  readonly commands?: Readonly<Record<string, StepRun>>;
  readonly log?: (line: string) => void;
}

export interface DriveResult {
  readonly refused: readonly { readonly branch: string; readonly why: string }[];
  readonly batches: readonly Batch[];
  readonly merged: readonly string[];
  readonly reverted: readonly { readonly branch: string; readonly step: string }[];
  readonly gate: readonly string[];
  readonly ok: boolean;
}

/** A branch must have passed at least the light-gate steps of its own scope. */
export function requiredForNote(b: BranchInfo): StepId[] {
  return b.scope.steps
    .map((s) => s.step)
    .filter((s) => STEPS.find((x) => x.id === s)?.light === true);
}

export async function drive(o: DriveOptions): Promise<DriveResult> {
  const say = o.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const commands = { ...COMMANDS, build: BUILD, ...(o.commands ?? {}) };
  const refused: { branch: string; why: string }[] = [];
  const infos: BranchInfo[] = [];
  for (const name of o.branches) {
    if (!refExists(o.repo, name)) {
      refused.push({ branch: name, why: 'unknown branch' });
      continue;
    }
    const info = loadBranch(o.repo, o.base, name);
    const need = requiredForNote(info);
    const c = noteCovers(o.repo, name, need);
    say(`  ${name}: ${c.ok ? 'OK' : 'REFUSED'} ${c.why}`);
    if (c.ok) infos.push(info);
    else refused.push({ branch: name, why: c.why });
  }
  const pairs: Pair[] = [];
  for (let i = 0; i < infos.length; i += 1) {
    for (let j = i + 1; j < infos.length; j += 1) {
      pairs.push(buildPair(o.repo, infos[i] as BranchInfo, infos[j] as BranchInfo));
    }
  }
  const batches = planBatches(infos, pairs);
  say(renderPlan(o.base, infos, pairs, batches));
  const merged: string[] = [];
  const reverted: { branch: string; step: string }[] = [];
  const gate: string[] = [];
  if (!o.merge || infos.length === 0) {
    return { refused, batches, merged, reverted, gate, ok: refused.length === 0 };
  }
  if (dirtyTracked(o.repo))
    throw new Error('drive: the checkout has uncommitted changes to tracked files');
  ensureMergeDriver(o.repo);
  const sh = (args: string[]) => vcs(o.repo, args);
  for (const batch of batches) {
    const before = sh(['rev-parse', 'HEAD']).stdout.trim();
    const mergeCommits: { branch: string; commit: string }[] = [];
    for (const name of batch.branches) {
      const r = sh(['merge', '--no-ff', '-m', `Merge ${name}`, name]);
      if (!r.ok) {
        sh(['merge', '--abort']);
        say(`  ${name}: merge conflict, left out`);
        refused.push({ branch: name, why: 'merge conflict at drive time' });
        continue;
      }
      const commit = sh(['rev-parse', 'HEAD']).stdout.trim();
      mergeCommits.push({ branch: name, commit });
      merged.push(name);
    }
    if (mergeCommits.length === 0) continue;
    const union = new Set<StepId>();
    for (const m of mergeCommits) {
      const bi = infos.find((x) => x.name === m.branch) as BranchInfo;
      for (const s of computeScope(o.repo, bi.files).steps) union.add(s.step);
    }
    const stepIds = STEPS.map((s) => s.id).filter((s) => union.has(s));
    const run = async (ids: readonly string[], note: boolean) =>
      runGate({
        repo: o.repo,
        runs: orderRuns(plan(ids as StepId[], commands), o.repo),
        required: ids,
        light: false,
        keepGoing: true,
        scratch: o.scratch,
        note,
        cache: o.fast === true,
        commitResults: o.fast === true && note,
        log: () => undefined,
      });
    say(`combined gate for ${mergeCommits.map((m) => m.branch).join(' + ')}: ${stepIds.join(' ')}`);
    const report = await run(stepIds, true);
    gate.push(report.line);
    say(report.line);
    if (report.pass) continue;
    // A confirmed loss: find the branch whose change caused it and revert only that merge.
    const failing = report.results
      .filter((r) => r.outcome !== 'pass' && r.outcome !== 'not-run' && r.id !== 'build')
      .map((r) => r.id);
    const suspects = [...mergeCommits].reverse().filter((m) => {
      const bi = infos.find((x) => x.name === m.branch) as BranchInfo;
      return bi.scope.steps.some((s) => failing.includes(s.step));
    });
    const pool = suspects.length ? suspects : [...mergeCommits].reverse();
    const revert = (m: { branch: string; commit: string }): boolean => {
      const rv = sh(['revert', '-m', '1', '--no-edit', m.commit]);
      if (!rv.ok) sh(['revert', '--abort']);
      return rv.ok;
    };
    let culprit: string | null = null;
    // Try each suspect alone: the one whose revert makes the failing steps pass caused the loss.
    for (const m of pool) {
      if (!revert(m)) continue;
      say(`  trying ${m.branch} reverted; re-running ${failing.join(' ')} only`);
      const again = await run(failing, false);
      gate.push(again.line);
      if (again.pass) {
        culprit = m.branch;
        reverted.push({ branch: m.branch, step: failing.join('+') });
        break;
      }
      sh(['reset', '--hard', 'HEAD~1']);
    }
    if (!culprit) {
      // No single branch explains it (an interaction): revert every suspect and say so.
      for (const m of pool) {
        if (revert(m))
          reverted.push({ branch: m.branch, step: `${failing.join('+')} (interaction)` });
      }
      say('  no single branch explains the loss; reverted every suspect');
    } else {
      say(`  confirmed loss caused by ${culprit}; only that merge is reverted`);
    }
    if (sh(['rev-parse', 'HEAD']).stdout.trim() === before) say('  batch fully reverted');
  }
  return {
    refused,
    batches,
    merged,
    reverted,
    gate,
    ok: reverted.length === 0 && refused.length === 0,
  };
}

function arg(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repo = arg(args, 'repo') ?? defaultRepo();
  const base = arg(args, 'base') ?? defaultBase(repo);
  const branches = args.filter((a) => !a.startsWith('--'));
  if (branches.length === 0) {
    process.stderr.write('usage: drive [--base=<ref>] [--merge] [--json] <branch> ...\n');
    process.exit(2);
  }
  const scratch = process.env.A0_GATE_SCRATCH ?? join(tmpdir(), 'a0-dev-gate');
  const r = await drive({
    repo,
    base,
    branches,
    merge: args.includes('--merge'),
    scratch,
    fast: true,
  });
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    for (const x of r.refused) process.stdout.write(`REFUSED ${x.branch}: ${x.why}\n`);
    process.stdout.write(
      r.merged.length
        ? `merged: ${r.merged.join(', ')}; reverted: ${r.reverted.map((v) => v.branch).join(', ') || 'none'}\n`
        : 'nothing merged (use --merge after every branch has a passing gate note)\n',
    );
  }
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
