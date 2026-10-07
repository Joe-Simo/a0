/**
 * Surface v2 study, part 3 (RESEARCH, deterministic): what recorded model failures say about
 * writing the dense surface against the canonical one, and what the edit-session cost model says a
 * smaller surface can and cannot buy. Reads results/*.json only; runs no model.
 *
 *   bun tools/surface-v2-failures.ts [--out=results/surface-v2-failures.json]
 *
 * pooled     every A0 trial in results/ (a0Syntax dense or canonical, the rules-merged primer, task sets
 *            with both forms, every primer variant and model), counted per trial
 * controls   only the control primers: dense.D0 against canon.K0 and canon.KR3
 * unrecovered the trials not accepted after the repair, by the class of their last failure
 * cost      the cells of results/set-h.json and results/dense-experiment.json, and a break-even
 *            calculation: how many extra model calls per task cancel a given per-task token saving
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportJson } from './scrub-results.js';

type Syntax = 'dense' | 'canonical';

interface Counts {
  trials: number;
  oneShot: number;
  accepted: number;
  attempts: number;
  failedAttempts: number;
  byClass: Record<string, number>;
  unrecovered: Record<string, number>;
  examples: Record<string, string>;
}
const fresh = (): Counts => ({
  trials: 0,
  oneShot: 0,
  accepted: 0,
  attempts: 0,
  failedAttempts: 0,
  byClass: {},
  unrecovered: {},
  examples: {},
});

/** The first rule that matches the checker message; the class says what the model got wrong. */
export function classify(msg: string): string {
  const m = msg.replace(/^(parse|type|structure|edit):?\s*/, '');
  if (/^\S+\(.*\) = /.test(msg)) return 'wrong result (well formed)';
  if (
    /^edit:/.test(msg) ||
    /edit line .* names no value|invalid delete target|duplicate edit/.test(msg)
  )
    return 'edit protocol (line edit shape)';
  if (/nested operand/.test(msg)) return 'operand nesting (canonical: one op per line)';
  if (/unexpected '.*' after a complete expression|needs \d+ operands but the line ended/.test(msg))
    return 'operand count or value used twice (dense: prefix without delimiters)';
  if (/expected \d+ arguments, got \d+|parameter p\d+ out of range|: .* p\d+: expected/.test(msg))
    return 'parameter count or position (dense: implicit from the letters used)';
  if (
    /is not an operation, a function, or a named value|neither an operation nor a function|unknown operation/.test(
      m,
    )
  )
    return 'unknown word (operation or name not in the language; dense: parameter written as a name)';
  if (/duplicate id/.test(m)) return 'duplicate or reused id';
  if (/expected a result type|result: expected|result with a value of type|\.ret: expected/.test(m))
    return 'result type not written';
  if (/unknown function|unknown callee|callees must be defined/.test(m))
    return 'callee used before it is defined';
  if (/fix: (a function is|close the function)|expected '.*' after ret|before ret/.test(msg))
    return 'block shape (ret / end)';
  if (/get expects an array|expects an array/.test(m))
    return 'operand order (get/set on the wrong value)';
  return 'other (type errors: select branches, record against array, ...)';
}

function walk(dir: string, visit: (path: string) => void): void {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) walk(p, visit);
    else if (f.name.endsWith('.json') && !f.name.endsWith('.replies.json')) visit(p);
  }
}

const SETS_BOTH = new Set(['a', 'b', 'c', 'c400', 'c4000', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);

interface Trial {
  representation?: string;
  acceptedOneShot?: boolean;
  accepted?: boolean;
  attempts?: { failures?: unknown[] }[];
}

function aggregate(include: (label: string) => boolean): {
  by: Record<Syntax, Counts>;
  files: number;
} {
  const by: Record<Syntax, Counts> = { dense: fresh(), canonical: fresh() };
  let files = 0;
  walk('results', (p) => {
    let j: {
      trials?: unknown[];
      a0Syntax?: string;
      taskSet?: string;
      primerMode?: string;
      languagePrimer?: string;
    };
    try {
      j = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(j.trials) || (j.a0Syntax !== 'dense' && j.a0Syntax !== 'canonical')) return;
    if (j.primerMode !== 'rules-merged' || !SETS_BOTH.has(String(j.taskSet))) return;
    const label =
      /\/((?:dense|canon)\.[A-Za-z0-9]+)\.txt/.exec(String(j.languagePrimer))?.[1] ?? 'unknown';
    if (!include(label)) return;
    files += 1;
    const c = by[j.a0Syntax as Syntax];
    for (const t of j.trials as Trial[]) {
      if (t.representation !== 'a0') continue;
      c.trials += 1;
      if (t.acceptedOneShot) c.oneShot += 1;
      if (t.accepted) c.accepted += 1;
      let last: string | undefined;
      for (const a of t.attempts ?? []) {
        c.attempts += 1;
        const fs = (a.failures ?? []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
        if (fs.length === 0) continue;
        c.failedAttempts += 1;
        const cls = classify(fs[0] as string);
        c.byClass[cls] = (c.byClass[cls] ?? 0) + 1;
        c.examples[cls] ??= (fs[0] as string).slice(0, 140);
        last = cls;
      }
      if (!t.accepted && last !== undefined) c.unrecovered[last] = (c.unrecovered[last] ?? 0) + 1;
    }
  });
  return { by, files };
}

function tableOf(by: Record<Syntax, Counts>): unknown[] {
  const classes = [
    ...new Set([...Object.keys(by.dense.byClass), ...Object.keys(by.canonical.byClass)]),
  ];
  const per100 = (c: Counts, k: string, field: 'byClass' | 'unrecovered'): number =>
    Number((((c[field][k] ?? 0) / Math.max(1, c.trials)) * 100).toFixed(2));
  return classes
    .map((k) => ({
      class: k,
      denseFailedAttempts: by.dense.byClass[k] ?? 0,
      canonicalFailedAttempts: by.canonical.byClass[k] ?? 0,
      densePer100Trials: per100(by.dense, k, 'byClass'),
      canonicalPer100Trials: per100(by.canonical, k, 'byClass'),
      deltaPer100: Number(
        (per100(by.dense, k, 'byClass') - per100(by.canonical, k, 'byClass')).toFixed(2),
      ),
      denseUnrecoveredPer100Trials: per100(by.dense, k, 'unrecovered'),
      canonicalUnrecoveredPer100Trials: per100(by.canonical, k, 'unrecovered'),
      example: by.dense.examples[k] ?? by.canonical.examples[k],
    }))
    .sort((a, b) => b.deltaPer100 - a.deltaPer100);
}

const summary = (c: Counts): Record<string, unknown> => ({
  trials: c.trials,
  oneShotRate: Number((c.oneShot / Math.max(1, c.trials)).toFixed(3)),
  acceptedRate: Number((c.accepted / Math.max(1, c.trials)).toFixed(3)),
  notAcceptedAfterRepair: c.trials - c.accepted,
  failedAttempts: c.failedAttempts,
});

async function main(): Promise<void> {
  const out =
    process.argv.find((a) => a.startsWith('--out='))?.slice(6) ??
    join('results', 'surface-v2-failures.json');
  const pooled = aggregate(() => true);
  const controls = aggregate((l) => l === 'dense.D0' || l === 'canon.K0' || l === 'canon.KR3');

  const setH = JSON.parse(readFileSync('results/set-h.json', 'utf8')) as {
    cells: Record<string, unknown>;
  };
  const dx = JSON.parse(readFileSync('results/dense-experiment.json', 'utf8')) as {
    setsAbdef: {
      rows: {
        model: string;
        form: string;
        systemTokens: number;
        callsPerTask: number;
        meanTaskPromptTokens: number;
        meanReplyTokens: number;
        cost1Task: number;
        cost10TaskSession: number;
        costUnbounded: number;
        oneShot: number;
        afterOneRetry: number;
        trials: number;
      }[];
    };
  };
  const both = (f: string) => dx.setsAbdef.rows.find((r) => r.model === 'both' && r.form === f);
  const d = both('dense');
  const k = both('canonical');
  const perTaskSaving =
    d !== undefined && k !== undefined
      ? k.meanTaskPromptTokens + k.meanReplyTokens - (d.meanTaskPromptTokens + d.meanReplyTokens)
      : 0;
  const callCost = d !== undefined ? d.meanTaskPromptTokens + d.meanReplyTokens : 0;

  // ---- the session cost model, calibrated on the two recorded forms, applied to v2
  type Row = NonNullable<typeof d>;
  const per = (
    r: Row,
    n: number,
    calls = r.callsPerTask,
    system = r.systemTokens,
    v = r.meanTaskPromptTokens,
    rep = r.meanReplyTokens,
    t = 0,
  ): number => (system * (1.25 + 0.05 * (n - 1))) / n + calls * (v + rep) + t;
  let costModel: Record<string, unknown> = {
    note: 'results/surface-v2.json missing: run tools/surface-v2-study.ts first',
  };
  if (d !== undefined && k !== undefined) {
    // residual (tool context per task), fitted on canonical at 10 tasks, checked on dense
    const tK = k.cost10TaskSession - per(k, 10);
    const predictedDense10 = per(
      d,
      10,
      d.callsPerTask,
      d.systemTokens,
      d.meanTaskPromptTokens,
      d.meanReplyTokens,
      tK,
    );
    let study: {
      editTokens?: { total: Record<string, number> };
      primers?: { v2DraftO200k: number };
    } = {};
    try {
      study = JSON.parse(readFileSync('results/surface-v2.json', 'utf8'));
    } catch {
      study = {};
    }
    const tot = study.editTokens?.total;
    const sys = study.primers?.v2DraftO200k;
    if (tot !== undefined && sys !== undefined) {
      const denseFrac = 1 - (tot.denseSource ?? 0) / (tot.canonicalSource ?? 1);
      const v2Frac = 1 - (tot.v2Source ?? 0) / (tot.canonicalSource ?? 1);
      const dView = k.meanTaskPromptTokens - d.meanTaskPromptTokens;
      const v2View = k.meanTaskPromptTokens - dView * (v2Frac / denseFrac);
      const v2Reply = d.meanReplyTokens * ((tot.v2Reference ?? 1) / (tot.denseReference ?? 1));
      const accK = k.afterOneRetry / k.trials;
      const accD = d.afterOneRetry / d.trials;
      const cell = (
        name: string,
        calls: number,
        system: number,
        v: number,
        rep: number,
        acc: number,
      ) => {
        const c10 = per(k, 10, calls, system, v, rep, tK);
        return {
          name,
          callsPerTask: calls,
          systemTokens: system,
          viewTokens: Number(v.toFixed(1)),
          replyTokens: Number(rep.toFixed(1)),
          accepted: Number(acc.toFixed(3)),
          perTask10: Number(c10.toFixed(1)),
          perAccepted10: Number((c10 / acc).toFixed(1)),
        };
      };
      const rows = [
        cell(
          'canonical (recorded cells)',
          k.callsPerTask,
          k.systemTokens,
          k.meanTaskPromptTokens,
          k.meanReplyTokens,
          accK,
        ),
        cell(
          'dense (recorded cells)',
          d.callsPerTask,
          d.systemTokens,
          d.meanTaskPromptTokens,
          d.meanReplyTokens,
          accD,
        ),
        cell('v2, canonical failure behaviour', k.callsPerTask, sys, v2View, v2Reply, accK),
        cell('v2, dense failure behaviour', d.callsPerTask, sys, v2View, v2Reply, accD),
        cell(
          'v2, primer 100 tokens, canonical failure behaviour',
          k.callsPerTask,
          100,
          v2View,
          v2Reply,
          accK,
        ),
      ];
      const best = rows[2] as { perAccepted10: number };
      const canonical = rows[0] as { perAccepted10: number };
      costModel = {
        formula:
          'tokens per task at n tasks = system*(1.25+0.05*(n-1))/n + calls*(view+reply) + toolContext; toolContext fitted on the canonical cell at n=10; per accepted = per task / accepted rate',
        toolContextFitted: Number(tK.toFixed(1)),
        checkDenseMeasured10: d.cost10TaskSession,
        checkDensePredicted10: Number(predictedDense10.toFixed(1)),
        v2ViewScaling: {
          denseSourceSaving: Number(denseFrac.toFixed(3)),
          v2SourceSaving: Number(v2Frac.toFixed(3)),
          denseMeasuredViewSaving: Number(dView.toFixed(1)),
          v2ViewSaving: Number((k.meanTaskPromptTokens - v2View).toFixed(1)),
        },
        rows,
        v2ShareOfCanonicalPerAccepted10: Number(
          (best.perAccepted10 / canonical.perAccepted10).toFixed(3),
        ),
        acceptedRateAtWhichV2TiesCanonical10: Number(
          (
            (accK * (rows[2] as { perTask10: number }).perTask10) /
            (rows[0] as { perTask10: number }).perTask10
          ).toFixed(3),
        ),
      };
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/surface-v2-failures.ts',
    meaning:
      'Recorded A0 trials of the task sets that exist in both forms (a, b, c, c400, c4000, d, e, f, g, h, i, j), rules-merged primer. pooled: every primer variant and model in results/ (the ablation variants include deliberately degraded primers); controls: dense.D0 against canon.K0 and canon.KR3 only. Classes by the first rule that matches the checker message. Rates are descriptive, not significance claims.',
    pooled: {
      files: pooled.files,
      dense: summary(pooled.by.dense),
      canonical: summary(pooled.by.canonical),
      table: tableOf(pooled.by),
    },
    controls: {
      files: controls.files,
      dense: summary(controls.by.dense),
      canonical: summary(controls.by.canonical),
      table: tableOf(controls.by),
    },
    cost: {
      setH: setH.cells,
      setsAbdefBoth: { dense: d, canonical: k },
      perTaskSavingOfDenseTokens: Number(perTaskSaving.toFixed(1)),
      tokensOfOneModelCall: Number(callCost.toFixed(1)),
      breakEvenExtraCallsPerTask:
        callCost > 0 ? Number((perTaskSaving / callCost).toFixed(3)) : null,
      model: costModel,
    },
  };
  writeFileSync(out, reportJson(report), 'utf8');
  process.stderr.write(`wrote ${out}\n`);
}

if (process.argv[1]?.endsWith('surface-v2-failures.ts')) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
