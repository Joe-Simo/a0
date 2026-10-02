/**
 * Summary of the spec-line experiment (set g): reads the scored per-cell reports
 * `results/ai-edit-experiment.g.<model>-<variant>.<view>.json` (the retry reports: first reply plus
 * one repair round) and writes `results/spec-lines.json`.
 *
 * Cells: variant A (no spec lines, the current primer), X (the spec-line primer, no spec lines: the
 * control that separates what the primer costs from what the lines do), B (one `ex`), C (three
 * `ex`), D (one `post`), E (one wrong `ex`: true of the starting program, false of the intended
 * edit); views canon (canonical text) and dense.
 *
 * Per model and cell: n, acceptance one shot and after one repair with Wilson 95% intervals, tokens,
 * calls, the cache-adjusted cost per task and per accepted edit, the failure taxonomy of the first
 * attempt, and for spec-line rejections whether the same reply would have passed the acceptance
 * tests without the spec lines (a false rejection) or not (a catch). Then wins, ties and losses
 * against the matching A cell per axis. A rate is called a win or a loss only when the 95% Wilson
 * intervals do not overlap; otherwise it is a tie ("not distinguishable at this n"). A cost is a
 * win or a loss outside a 1% band, as in the other summaries. Also the mechanical catch analysis:
 * how many of the authors' plausible wrong edits each variant's spec lines refuse, which is
 * independent of any subject.
 *
 *   node dist/tools/spec-lines-summary.js [--dir=results]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAndValidate } from '../src/core.js';
import {
  SPEC_VARIANTS,
  type SpecVariant,
  specLinesOf,
  specVariantOf,
} from './ai-edit-spec-variants.js';
import { TASKS_G, type TaskG } from './ai-edit-tasks-g.js';
import { writeReport } from './scrub-results.js';

interface Attempt {
  readonly status: string;
  readonly failures?: readonly string[];
  readonly specFault?: string;
  readonly shadowAccepted?: boolean | null;
}
interface TrialRow {
  readonly task: string;
  readonly setupTokensLocal: Record<string, number>;
  readonly viewTokensLocal: Record<string, number>;
  readonly tokenBucketsLocal: {
    languagePrimer: number;
    workflowPrimer: number;
    toolContext: number;
    output: number;
  } | null;
  readonly modelCalls: number;
  readonly acceptedOneShot: boolean | null;
  readonly accepted: boolean | null;
  readonly attempts: readonly Attempt[];
}
interface Report {
  readonly trials: readonly TrialRow[];
  readonly harnessSelfCheck: { readonly ok: boolean };
  readonly languagePrimer: string;
}

interface CellSum {
  readonly oneShot: { readonly ci95: number[] };
  readonly accepted: { readonly ci95: number[] };
  readonly callsPerTask: number;
  readonly tokensPerAcceptedEdit: Record<string, number> | null;
}

const dir = process.argv.find((a) => a.startsWith('--dir='))?.slice(6) ?? 'results';
const MODELS = ['haiku', 'sonnet'] as const;
const VIEWS = ['canon', 'dense'] as const;
const LETTER: Record<string, SpecVariant> = {
  A: 'none',
  X: 'none',
  B: 'ex1',
  C: 'ex3',
  D: 'post',
  E: 'stale',
};
const CELL_NAMES = Object.keys(LETTER);
const BAND = 0.01;

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const r1 = (x: number): number => Math.round(x * 10) / 10;
const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

interface Row {
  readonly system: number;
  readonly view: number;
  readonly calls: number;
  readonly context: number;
  readonly output: number;
  readonly oneShot: boolean;
  readonly accepted: boolean;
  readonly first: string;
  readonly specFaults: number;
  /** spec rejections by the example the view showed, with the same reply judged without spec lines */
  readonly providedRefusals: number;
  /** ... of which the acceptance tests alone would have accepted the reply (preserved examples: a deviation the hidden tests miss) */
  readonly providedRefusalsBeyondTests: number;
  /** ... of which the tests would have refused it too */
  readonly providedRefusalsAlsoTests: number;
  /** stale example (cell E): refused a reply the tests accept (a false rejection) */
  readonly falseRejections: number;
  /** spec rejections by an example the subject wrote itself */
  readonly selfWrittenRefusals: number;
  readonly specUnreadable: number;
  readonly specRejectedAndRecovered: number;
}

function rowsOf(rep: Report, variant: SpecVariant): Row[] {
  const tasks = new Map((TASKS_G as readonly TaskG[]).map((t) => [t.id, t]));
  return rep.trials.flatMap((t) => {
    if (t.tokenBucketsLocal === null) return [];
    const spec = t.attempts.filter((a) => a.status === 'spec');
    const task = tasks.get(t.task);
    const shown =
      task === undefined || variant === 'none' || variant === 'post'
        ? []
        : specLinesOf(task, variant);
    // The example a rejection names, as `ex INPUT -> EXPECTED`, against the lines the view showed.
    const provided = (a: Attempt): boolean => {
      const m = /ex \d+ failed: input ([^,]*(?:, [^,]*)*?), expected (.*?), got /.exec(
        a.failures?.[0] ?? '',
      );
      if (m === null) return false;
      const input = (m[1] ?? '').replaceAll(',', '');
      return shown.includes(`ex ${input} -> ${m[2] ?? ''}`);
    };
    const own = spec.filter(provided);
    const stale = variant === 'stale';
    return [
      {
        system: t.setupTokensLocal.o200k_base ?? 0,
        view: t.viewTokensLocal.o200k_base ?? 0,
        calls: Math.max(1, t.modelCalls),
        context: t.tokenBucketsLocal.toolContext,
        output: t.tokenBucketsLocal.output,
        oneShot: t.acceptedOneShot === true,
        accepted: t.accepted === true,
        first: t.attempts[0]?.status ?? 'no-reply',
        specFaults: spec.length,
        providedRefusals: stale ? 0 : own.length,
        providedRefusalsBeyondTests: stale
          ? 0
          : own.filter((a) => a.shadowAccepted === true).length,
        providedRefusalsAlsoTests: stale ? 0 : own.filter((a) => a.shadowAccepted === false).length,
        falseRejections: stale ? own.filter((a) => a.shadowAccepted === true).length : 0,
        selfWrittenRefusals: spec.length - own.length,
        specUnreadable: spec.filter((a) => a.shadowAccepted === null).length,
        specRejectedAndRecovered: spec.length > 0 && t.accepted === true ? 1 : 0,
      },
    ];
  });
}

function summarize(rows: readonly Row[], statuses: readonly string[]): Record<string, unknown> {
  const n = rows.length;
  const one = rows.filter((r) => r.oneShot).length;
  const acc = rows.filter((r) => r.accepted).length;
  // system text 1.25x on the first call of a 1-task session, 0.05x on later calls and in an
  // unbounded session; the 10-task session writes it once for ten tasks (0.17x on the first call)
  const cost = (first: number, later: number): number[] =>
    rows.map((r) => r.system * (first + later * (r.calls - 1)) + r.context + r.output);
  const task1 = cost(1.25, 0.05);
  const session10 = cost(0.17, 0.05);
  const unbounded = rows.map((r) => r.system * 0.05 * r.calls + r.context + r.output);
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const [o1, o2] = wilson(one, n);
  const [a1, a2] = wilson(acc, n);
  return {
    n,
    oneShot: { k: one, rate: r3(one / n), ci95: [r3(o1), r3(o2)] },
    accepted: { k: acc, rate: r3(acc / n), ci95: [r3(a1), r3(a2)] },
    system: r1(mean(rows.map((r) => r.system))),
    view: r1(mean(rows.map((r) => r.view))),
    callsPerTask: r3(mean(rows.map((r) => r.calls))),
    toolContext: r1(mean(rows.map((r) => r.context))),
    output: r1(mean(rows.map((r) => r.output))),
    costPerTask: {
      task1: r1(mean(task1)),
      session10: r1(mean(session10)),
      unbounded: r1(mean(unbounded)),
    },
    tokensPerAcceptedEdit:
      acc === 0
        ? null
        : {
            task1: r1(sum(task1) / acc),
            session10: r1(sum(session10) / acc),
            unbounded: r1(sum(unbounded) / acc),
          },
    firstAttempt: Object.fromEntries(
      statuses.map((s) => [s, rows.filter((r) => r.first === s).length]),
    ),
    specRejections: {
      trialsWithOne: rows.filter((r) => r.specFaults > 0).length,
      providedExampleRefusals: sum(rows.map((r) => r.providedRefusals)),
      providedRefusalsTheTestsMissed: sum(rows.map((r) => r.providedRefusalsBeyondTests)),
      providedRefusalsTheTestsAlsoRefuse: sum(rows.map((r) => r.providedRefusalsAlsoTests)),
      staleExampleFalseRejections: sum(rows.map((r) => r.falseRejections)),
      refusalsByAnExampleTheSubjectWrote: sum(rows.map((r) => r.selfWrittenRefusals)),
      replyInvalidEvenWithoutSpecLines: sum(rows.map((r) => r.specUnreadable)),
      recoveredAfterOne: sum(rows.map((r) => r.specRejectedAndRecovered)),
    },
  };
}

const STATUSES = [
  'ok',
  'protocol',
  'compile',
  'missing',
  'runtime',
  'wrong-output',
  'spec',
  'no-reply',
];
const notes: string[] = [];
interface Category {
  readonly category: string;
  readonly cls: 'protocol-ambiguity' | 'model-error';
  readonly re: RegExp;
  readonly proposal: string;
}
/** Deterministic rules over the checker's first failure line of a non-accepted attempt. */
const CATEGORIES: readonly Category[] = [
  {
    category: 'spec line after the body',
    cls: 'protocol-ambiguity',
    re: /unknown operation '\d+'|unexpected '->'|expected 'end' after ret/,
    proposal:
      'a reply that writes ex, pre or post lines after the nodes reads them as nodes or as a parse error; the arrow makes an ex line unambiguous, so accept ex, pre and post anywhere in a reply fn block and hoist them under the header (or state "before the first node" in the teaching text)',
  },
  {
    category: 'more than the allowed spec lines',
    cls: 'protocol-ambiguity',
    re: /at most \d+ ex lines|a second post line/,
    proposal:
      'the teaching text does not give the limits (three ex, one post); state them, or accept the extra lines and keep the first three with a note instead of refusing the whole edit',
  },
  {
    category: 'ex line refused by the examples',
    cls: 'model-error',
    re: /ex \d+ failed/,
    proposal: 'none: the example or the function was wrong; the rejection already names both fixes',
  },
  {
    category: 'nested operand or a value used twice (dense)',
    cls: 'protocol-ambiguity',
    re: /one statement per line|nested operand|after a complete expression/,
    proposal:
      'the dense primer teaches prefix nesting but a value used twice needs a name on its own line; say so in the primer or let the dense parser name a repeated pure sub-expression itself',
  },
  {
    category: 'a name where a parameter letter belongs (dense)',
    cls: 'model-error',
    re: /is not an operation, a function, or a named value|parameters are written/,
    proposal: 'none: the primer says A, B, C; the rejection repeats it',
  },
  {
    category: 'duplicate definition of an id',
    cls: 'model-error',
    re: /duplicate definition|duplicate edit/,
    proposal:
      'a reply that defines an id twice could replace the earlier definition instead of failing',
  },
  {
    category: 'wrong result',
    cls: 'model-error',
    re: /= .*, expected /,
    proposal: 'none: the edit was well formed and wrong',
  },
];
const taxonomy: Record<string, Record<string, number>> = {};
const rowsBy: Record<string, Row[]> = {};
const primers: Record<string, string> = {};
for (const model of MODELS)
  for (const view of VIEWS)
    for (const cell of CELL_NAMES) {
      const path = join(dir, `ai-edit-experiment.g.${model}-${cell}.${view}.json`);
      if (!existsSync(path)) continue;
      const rep = JSON.parse(readFileSync(path, 'utf8')) as Report;
      if (!rep.harnessSelfCheck.ok) notes.push(`self-check failed ${path}`);
      rowsBy[`${model}/${cell}.${view}`] = rowsOf(rep, LETTER[cell] as SpecVariant);
      for (const t of rep.trials)
        for (const a of t.attempts) {
          if (a.status === 'ok') continue;
          const msg = a.failures?.[0] ?? '';
          const cat = CATEGORIES.find((c) => c.re.test(msg));
          const key =
            cat === undefined ? 'other (a type or structure error of the edit)' : cat.category;
          const cellKey = `${model}/${cell}.${view}`;
          taxonomy[cellKey] ??= {};
          const bucket = taxonomy[cellKey] as Record<string, number>;
          bucket[key] = (bucket[key] ?? 0) + 1;
        }
      primers[`${cell}.${view}`] = rep.languagePrimer;
    }

const cells: Record<string, unknown> = {};
const sums: Record<string, Record<string, unknown>> = {};
for (const view of VIEWS)
  for (const cell of CELL_NAMES) {
    for (const scope of [...MODELS, 'pooled'] as const) {
      const rows =
        scope === 'pooled'
          ? MODELS.flatMap((m) => rowsBy[`${m}/${cell}.${view}`] ?? [])
          : (rowsBy[`${scope}/${cell}.${view}`] ?? []);
      if (rows.length === 0) continue;
      const s = summarize(rows, STATUSES);
      cells[`${scope}/${cell}.${view}`] = s;
      sums[`${scope}/${view}`] ??= {};
      (sums[`${scope}/${view}`] as Record<string, unknown>)[cell] = s;
    }
  }

// Wins, ties and losses against the A cell of the same model and view, per axis.
type Verdict = 'win' | 'tie' | 'loss';
const rateVerdict = (a: number[], b: number[]): Verdict =>
  a[1] === undefined || b[1] === undefined || a[0] === undefined || b[0] === undefined
    ? 'tie'
    : a[0] > b[1]
      ? 'win'
      : a[1] < b[0]
        ? 'loss'
        : 'tie';
const costVerdict = (v: number, base: number): Verdict =>
  Math.abs(v - base) <= BAND * Math.min(v, base) ? 'tie' : v < base ? 'win' : 'loss';
const verdicts: Record<string, unknown> = {};
const losses: string[] = [];
for (const scope of [...MODELS, 'pooled'] as const)
  for (const view of VIEWS) {
    const table = sums[`${scope}/${view}`];
    const base = table?.A as CellSum | undefined;
    if (table === undefined || base === undefined) continue;
    for (const cell of CELL_NAMES.filter((c) => c !== 'A')) {
      const c = table[cell] as CellSum | undefined;
      if (c === undefined) continue;
      const axes: Record<string, unknown> = {
        oneShot: rateVerdict(c.oneShot.ci95, base.oneShot.ci95),
        accepted: rateVerdict(c.accepted.ci95, base.accepted.ci95),
      };
      for (const m of ['task1', 'session10', 'unbounded'] as const) {
        const tpa = c.tokensPerAcceptedEdit?.[m] as number | undefined;
        const bpa = base.tokensPerAcceptedEdit?.[m] as number | undefined;
        axes[`tokensPerAccepted.${m}`] =
          tpa === undefined || bpa === undefined ? 'tie' : costVerdict(tpa, bpa);
      }
      axes.calls = costVerdict(c.callsPerTask, base.callsPerTask);
      verdicts[`${scope}/${cell}.${view} vs A`] = axes;
      for (const [axis, v] of Object.entries(axes))
        if (v === 'loss') losses.push(`${scope}/${cell}.${view} vs A: ${axis}`);
    }
  }

// Mechanical catch analysis, independent of any subject: a wrong edit is caught when the program
// with the variant's spec lines on the target no longer validates.
const catchAnalysis: Record<string, unknown> = {};
for (const variant of SPEC_VARIANTS.filter((v) => v !== 'none')) {
  const per: { task: string; wrongEdits: number; caught: number; reference: 'ok' | 'rejected' }[] =
    [];
  for (const t of TASKS_G as readonly TaskG[]) {
    if (variant === 'stale' && t.specs.stale === null) continue;
    const v = specVariantOf(t, variant);
    const target = v.a0Source
      .split('\n')
      .filter((l) => l.startsWith('ex ') || l.startsWith('post '));
    let caught = 0;
    for (const w of t.wrongEdits) {
      const lines = target;
      const all = w.split('\n');
      const at = all.findIndex((l) => l === `fn ${t.target}` || l.startsWith(`fn ${t.target} `));
      all.splice(at + 1, 0, ...lines);
      try {
        parseAndValidate(all.join('\n'));
      } catch {
        caught += 1;
      }
    }
    let reference: 'ok' | 'rejected' = 'ok';
    try {
      parseAndValidate(v.reference.a0);
    } catch {
      reference = 'rejected';
    }
    per.push({ task: t.id, wrongEdits: t.wrongEdits.length, caught, reference });
  }
  catchAnalysis[variant] = {
    tasks: per.length,
    wrongEdits: per.reduce((a, p) => a + p.wrongEdits, 0),
    caught: per.reduce((a, p) => a + p.caught, 0),
    tasksWithACatch: per.filter((p) => p.caught > 0).length,
    referenceRejected: per.filter((p) => p.reference === 'rejected').length,
    note:
      variant === 'stale'
        ? 'the reference solution keeps no stale example; this row counts the wrong edits the stale example refuses, which is a false rejection of nothing (the example is wrong about the intended edit)'
        : undefined,
    perTask: per,
  };
}

await writeReport(join(dir, 'spec-lines.json'), {
  generatedAt: new Date().toISOString(),
  design:
    'Set g (16 tasks with a plausible wrong edit; tools/ai-edit-tasks-g.ts, sealed in tools/ai-edit-tasks-g.sha256). Cells A (no spec lines, current primer), X (spec-line primer, no spec lines: the control), B (one ex), C (three ex), D (one post), E (one stale ex: true of the starting program, false of the intended edit); canonical and dense views. Fresh Haiku and Sonnet subagents, one per task and cell, one shot plus one repair round by a fresh subagent given the exact rejection. Rates carry Wilson 95% intervals; a win or a loss on a rate needs non-overlapping intervals.',
  notes,
  primerOf: primers,
  cells,
  verdictsAgainstA: verdicts,
  losses,
  catchAnalysis,
  failureTaxonomy: {
    note: 'every non-accepted attempt (first reply and repair) of a cell, by the rule that matches the checker message; class and the general fix proposal per category below',
    categories: CATEGORIES.map((c) => ({
      category: c.category,
      class: c.cls,
      proposal: c.proposal,
    })),
    perCell: taxonomy,
  },
});
process.stdout.write(`${Object.keys(cells).length} cell summaries, ${losses.length} losses\n`);
