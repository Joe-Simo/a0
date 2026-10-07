/**
 * Summary of phase C of docs/history/2026-10-07-primer-v3-dense-ledger-preregistration.md: set a rerun with the shipped
 * primer V3 (A0 cells, conventional and structured, fresh Haiku and Sonnet subagents, one shot plus one repair) against the
 * recorded cells of the headline files results/ai-edit-experiment.<model>-min.json (the TypeScript and Rust cells were not
 * rerun). Writes results/primer-ledger-rescore.json: mean whole-task tokens (the ledger's `ai-tokens` measure) and accepted
 * counts per cell, the recorded values beside them, and whether any ledger comparison flips.
 */

import { readFileSync } from 'node:fs';
import { writeReport } from './scrub-results.js';

interface Trial {
  representation: string;
  protocol: string;
  accepted: boolean | null;
  tokenBucketsLocal?: { total: number };
}
interface Report {
  taskSetSha256: string;
  harnessSelfCheck: { ok: boolean };
  trials: Trial[];
}

const cell = (r: Report, key: string): { n: number; accepted: number; meanTokens: number } => {
  const t = r.trials.filter((x) => `${x.representation}/${x.protocol}` === key);
  const total = t.reduce((a, x) => a + (x.tokenBucketsLocal?.total ?? 0), 0);
  return {
    n: t.length,
    accepted: t.filter((x) => x.accepted === true).length,
    meanTokens: Math.round((total / Math.max(1, t.length)) * 10) / 10,
  };
};

const out: Record<string, unknown> = {};
for (const m of ['haiku', 'sonnet']) {
  const fresh = JSON.parse(
    readFileSync(`results/primer-ledger-rescore/report.a.${m}.V3.json`, 'utf8'),
  ) as Report;
  const old = JSON.parse(
    readFileSync(`results/ai-edit-experiment.${m}-min.json`, 'utf8'),
  ) as Report;
  if (!fresh.harnessSelfCheck.ok) throw new Error(`self-check failed ${m}`);
  if (fresh.taskSetSha256 !== old.taskSetSha256) throw new Error('task set differs');
  const rows: Record<string, unknown> = {};
  for (const protocol of ['conventional', 'structured']) {
    const a0New = cell(fresh, `a0/${protocol}`);
    const a0Old = cell(old, `a0/${protocol}`);
    const ts = cell(old, `ts/${protocol}`);
    const rust = cell(old, `rust/${protocol}`);
    rows[protocol] = {
      a0WithV3: a0New,
      a0Recorded: a0Old,
      tsRecorded: ts,
      rustRecorded: rust,
      savedPerTask: Math.round((a0Old.meanTokens - a0New.meanTokens) * 10) / 10,
      gapToTs: Math.round((a0New.meanTokens - ts.meanTokens) * 10) / 10,
      gapToRust: Math.round((a0New.meanTokens - rust.meanTokens) * 10) / 10,
      entryClosesAgainstTs: a0New.meanTokens < ts.meanTokens * 0.97,
      entryClosesAgainstRust: a0New.meanTokens < rust.meanTokens * 0.97,
    };
  }
  out[m] = rows;
}
await writeReport('results/primer-ledger-rescore.json', {
  generatedAt: new Date().toISOString(),
  tool: 'tools/primer-ledger-rescore-summary.ts',
  preRegistration: 'docs/history/2026-10-07-primer-v3-dense-ledger-preregistration.md',
  meaning:
    'Set a rerun of the A0 cells with the shipped 244-token primer V3 (fresh Haiku and Sonnet subagents, one shot plus one repair) against the recorded cells of results/ai-edit-experiment.<model>-min.json (TypeScript and Rust not rerun); mean whole-task tokens per task at the cold task, the ledger measure; an entry closes only when A0 is below the rival by more than the ledger band (3 per cent).',
  cells: out,
});
console.log(JSON.stringify(out, null, 1));
