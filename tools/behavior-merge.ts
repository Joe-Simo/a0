/**
 * Merge per-platform behavior reports into results/behavior.json.
 *
 * No single machine can run every target, so each machine writes a partial report
 * (`bun run behavior --out results/behavior-<platform>.json`) and this tool combines them:
 *   - the reports must share one table sha256 (and ledger), otherwise the merge is refused;
 *   - per target, a `failed` in any report stays failed; otherwise passed beats skipped beats blocked;
 *     ties prefer the first listed report; a target blocked everywhere stays blocked;
 *   - each target takes status, cases, detail and programs from the report it was taken from and
 *     records `ranOn`, that report's platform (absent when blocked everywhere);
 *   - summary and coverage are recomputed from the merged targets.
 *
 * Usage: bun tools/behavior-merge.ts --out results/behavior.json report1.json report2.json ...
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { writeReport } from './scrub-results.js';

type Status = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface MergeTarget {
  id: string;
  status: Status;
  ranOn?: string;
  programs: Record<string, string>;
  [key: string]: unknown;
}

export interface MergeReport {
  platform: string;
  generatedAt?: string | undefined;
  table: { sha256: string; [key: string]: unknown };
  skipLedger: unknown[];
  summary: Record<Status, number>;
  targets: MergeTarget[];
  coverage: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

const RANK: Record<Status, number> = { failed: 3, passed: 2, skipped: 1, blocked: 0 };

export function mergeReports(reports: readonly MergeReport[]): MergeReport {
  const first = reports[0];
  if (first === undefined) throw new Error('behavior-merge: no reports given');
  const ids = JSON.stringify(first.targets.map((t) => t.id));
  for (const r of reports) {
    if (r.table.sha256 !== first.table.sha256)
      throw new Error(
        `behavior-merge: table sha256 differs (${first.platform} ${first.table.sha256} vs ${r.platform} ${r.table.sha256}); regenerate every report from the same table`,
      );
    if (JSON.stringify(r.skipLedger) !== JSON.stringify(first.skipLedger))
      throw new Error(
        `behavior-merge: skip ledger of ${r.platform} differs from ${first.platform}`,
      );
    if (JSON.stringify(r.targets.map((t) => t.id)) !== ids)
      throw new Error(
        `behavior-merge: target list of ${r.platform} differs from ${first.platform}`,
      );
  }
  const targets: MergeTarget[] = first.targets.map((_, i) => {
    let best: { t: MergeTarget; platform: string } | undefined;
    for (const r of reports) {
      const t = r.targets[i] as MergeTarget;
      if (best === undefined || RANK[t.status] > RANK[best.t.status])
        best = { t, platform: r.platform };
    }
    const { t, platform } = best as { t: MergeTarget; platform: string };
    const { ranOn, ...rest } = t;
    return t.status === 'blocked' ? { ...rest } : { ...rest, ranOn: ranOn ?? platform };
  });
  const summary: Record<Status, number> = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const t of targets) summary[t.status] += 1;
  return {
    ...first,
    generatedAt: reports
      .map((r) => r.generatedAt ?? '')
      .sort()
      .at(-1),
    platform: reports.map((r) => r.platform).join('+'),
    summary,
    targets,
    coverage: Object.fromEntries(targets.map((t) => [t.id, t.programs] as const)),
  };
}

async function load(path: string): Promise<MergeReport> {
  return JSON.parse(await readFile(path, 'utf8')) as MergeReport;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i < 0 ? undefined : args[i + 1];
  const inputs = args.filter((_, j) => j !== i && j !== i + 1);
  if (out === undefined || inputs.length === 0) {
    process.stderr.write(
      'usage: bun tools/behavior-merge.ts --out <merged.json> <report.json>...\n',
    );
    process.exit(2);
  }
  const merged = mergeReports(await Promise.all(inputs.map(load)));
  await writeReport(out, merged);
  const s = merged.summary;
  process.stdout.write(
    `behavior-merge: ${inputs.length} reports -> ${out}: ${s.passed} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.skipped} skipped\n`,
  );
  for (const t of merged.targets)
    process.stdout.write(
      `  ${t.id.padEnd(16)} ${t.status.padEnd(8)} ${t.ranOn ?? '(blocked everywhere)'}\n`,
    );
  process.exit(s.failed > 0 ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
