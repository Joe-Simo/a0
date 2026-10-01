/**
 * Step ordering and sentinels. Cheap, certain steps first (lint, typecheck, then the build the rest
 * need); after that the steps most likely to fail per unit of cost run first, so a failing change
 * stops the gate early. The failure likelihood is a static prior blended with the recorded history
 * (.a0-cache/gate-history.json): (fails + 2 * prior) / (runs + 2). `sentinels` are the first three
 * steps after the build in that order.
 *
 *   node dist/tools/dev/order.js [--steps=a,b,c] [--json]
 */

import { pathToFileURL } from 'node:url';
import type { StepRun } from './dev-gate.js';
import { type HistoryRow, loadHistory } from './history.js';
import { defaultRepo } from './repo.js';

/** Planning weights per step: relative cost units for ordering, not measurements. */
export const WEIGHT: Readonly<Record<string, number>> = {
  lint: 1,
  typecheck: 1,
  build: 1,
  test: 3,
  verify: 8,
  equiv: 3,
  hw: 3,
  app: 3,
  dotnet: 2,
  gpu: 2,
  selfhost: 3,
  'selfhost-c': 3,
  bootstrap: 4,
  tokens: 1,
  site: 2,
};

/** Prior chance a step fails on a change that selected it. */
const PRIOR: Readonly<Record<string, number>> = {
  test: 0.25,
  verify: 0.3,
  app: 0.2,
  bootstrap: 0.2,
  selfhost: 0.15,
  'selfhost-c': 0.15,
  equiv: 0.1,
  hw: 0.1,
  dotnet: 0.1,
  gpu: 0.1,
  site: 0.1,
};

export function failureLikelihood(step: string, history: readonly HistoryRow[]): number {
  const rows = history.filter((r) => r.step === step && !r.base);
  const fails = rows.filter((r) => r.rc !== 0).length;
  return (fails + 2 * (PRIOR[step] ?? 0.1)) / (rows.length + 2);
}

export function riskScore(step: string, history: readonly HistoryRow[]): number {
  return failureLikelihood(step, history) / (WEIGHT[step] ?? 3);
}

const FIXED = ['lint', 'typecheck', 'build'];

export function orderIds(ids: readonly string[], history: readonly HistoryRow[]): string[] {
  const fixed = FIXED.filter((f) => ids.includes(f));
  const rest = ids
    .filter((i) => !FIXED.includes(i))
    .sort((a, b) => riskScore(b, history) - riskScore(a, history) || a.localeCompare(b));
  return [...fixed, ...rest];
}

export function sentinels(ids: readonly string[], history: readonly HistoryRow[]): string[] {
  return orderIds(ids, history)
    .filter((i) => !FIXED.includes(i))
    .slice(0, 3);
}

export function orderRuns(runs: readonly StepRun[], repo: string): StepRun[] {
  const order = orderIds(
    runs.map((r) => r.id),
    loadHistory(repo),
  );
  return order.map((id) => runs.find((r) => r.id === id) as StepRun);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const picked = args.find((a) => a.startsWith('--steps='))?.slice(8);
  const ids = picked ? picked.split(',') : Object.keys(WEIGHT);
  const history = loadHistory(defaultRepo());
  const order = orderIds(ids, history);
  const out = {
    order,
    sentinels: sentinels(ids, history),
    scores: Object.fromEntries(order.map((i) => [i, Number(riskScore(i, history).toFixed(3))])),
  };
  process.stdout.write(
    args.includes('--json')
      ? `${JSON.stringify(out, null, 2)}\n`
      : `order: ${order.join(' ')}\nsentinels: ${out.sentinels.join(' ')} (fail-fast: stop at the first failure)\n`,
  );
}
