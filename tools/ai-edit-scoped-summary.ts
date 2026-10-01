/**
 * Summary of the equal-context comparison (STATUS "Equal context: A0 against seven languages,
 * all with dependency-scoped views"): reads the scored reports
 * `results/ai-edit-experiment.<set>.<model>-scoped-<arm>.json` (arm: `a0` canonical, `dense`
 * lean view with callee bodies, `langs` the seven languages with tools/scoped-view.ts views) and
 * writes `results/ai-edit-scoped.json`: per set and pooled over the four sets, per cell the
 * acceptance, the whole-task token buckets and the cache-adjusted cost for 1 task, 10 tasks and
 * an unbounded session, then each A0 form's rank and its wins, ties and losses against each
 * language, with every loss listed.
 *
 * Cost per task (o200k tokens): the system text S is charged 1.25x on the first call of a
 * 1-task session, 0.17x on the first call of a task in a 10-task session (one write, nine
 * reads), 0.05x on every later call (a repair) and in an unbounded session; the task text, view,
 * repair messages (tool context) and replies (output) 1x. Same method as results/ai-edit-langs8.json.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SETS = ['b', 'c', 'c400', 'c4000'] as const;
const MODELS = ['haiku', 'sonnet'] as const;
const LANGS = ['ts', 'rust', 'python', 'go', 'java', 'c', 'ruby'] as const;
const FORMS = ['a0', 'dense'] as const;
/** Cost counts as equal when the two differ by at most this share (same band as the b48 table). */
const BAND = 0.01;

interface TrialRow {
  readonly task: string;
  readonly representation: string;
  readonly setupTokensLocal: Record<string, number>;
  readonly tokenBucketsLocal: {
    readonly languagePrimer: number;
    readonly workflowPrimer: number;
    readonly toolContext: number;
    readonly output: number;
  } | null;
  readonly modelCalls: number;
  readonly acceptedOneShot: boolean | null;
  readonly accepted: boolean | null;
}

interface Report {
  readonly trials: readonly TrialRow[];
  readonly harnessSelfCheck: { readonly ok: boolean };
}

interface Row {
  readonly cell: string;
  readonly set: string;
  readonly model: string;
  readonly system: number;
  readonly calls: number;
  readonly context: number;
  readonly output: number;
  readonly languagePrimer: number;
  readonly workflowPrimer: number;
  readonly oneShot: boolean;
  readonly accepted: boolean;
}

export interface CellSummary {
  readonly n: number;
  readonly oneShot: number;
  readonly accepted: number;
  readonly system: number;
  readonly callsPerTask: number;
  /** Mean whole-task buckets per task: primers (per call), tool context, output. */
  readonly buckets: {
    readonly languagePrimer: number;
    readonly workflowPrimer: number;
    readonly toolContext: number;
    readonly output: number;
  };
  readonly task1: number;
  readonly session10: number;
  readonly unbounded: number;
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

function summarize(rows: readonly Row[]): CellSummary {
  const cost = (first: number, later: number): number =>
    mean(rows.map((r) => r.system * (first + later * (r.calls - 1)) + r.context + r.output));
  return {
    n: rows.length,
    oneShot: rows.filter((r) => r.oneShot).length,
    accepted: rows.filter((r) => r.accepted).length,
    system: mean(rows.map((r) => r.system)),
    callsPerTask: mean(rows.map((r) => r.calls)),
    buckets: {
      languagePrimer: mean(rows.map((r) => r.languagePrimer)),
      workflowPrimer: mean(rows.map((r) => r.workflowPrimer)),
      toolContext: mean(rows.map((r) => r.context)),
      output: mean(rows.map((r) => r.output)),
    },
    task1: cost(1.25, 0.05),
    session10: cost(0.17, 0.05),
    // Every call, the first included, reads the cached system text.
    unbounded: mean(rows.map((r) => r.system * 0.05 * r.calls + r.context + r.output)),
  };
}

async function load(path: string): Promise<Report | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Report;
  } catch {
    return undefined;
  }
}

type Metric = 'task1' | 'session10' | 'unbounded';
const METRICS: readonly Metric[] = ['task1', 'session10', 'unbounded'];

function verdict(a: number, b: number): 'win' | 'tie' | 'loss' {
  if (Math.abs(a - b) <= BAND * Math.min(a, b)) return 'tie';
  return a < b ? 'win' : 'loss';
}

export async function summarizeScoped(
  dir = 'results',
): Promise<Record<string, unknown> | undefined> {
  const rows: Row[] = [];
  const notes: string[] = [];
  for (const set of SETS)
    for (const model of MODELS)
      for (const arm of ['a0', 'dense', 'langs'] as const) {
        const rep = await load(join(dir, `ai-edit-experiment.${set}.${model}-scoped-${arm}.json`));
        if (rep === undefined) {
          notes.push(`missing ${set}/${model}/${arm}`);
          continue;
        }
        if (!rep.harnessSelfCheck.ok) notes.push(`self-check failed ${set}/${model}/${arm}`);
        for (const t of rep.trials) {
          if (t.tokenBucketsLocal === null) continue;
          rows.push({
            cell: arm === 'langs' ? t.representation : arm,
            set,
            model,
            system: t.setupTokensLocal.o200k_base ?? 0,
            calls: Math.max(1, t.modelCalls),
            context: t.tokenBucketsLocal.toolContext,
            output: t.tokenBucketsLocal.output,
            languagePrimer: t.tokenBucketsLocal.languagePrimer,
            workflowPrimer: t.tokenBucketsLocal.workflowPrimer,
            oneShot: t.acceptedOneShot === true,
            accepted: t.accepted === true,
          });
        }
      }
  const cells = [...FORMS, ...LANGS] as readonly string[];
  const scopes = [...SETS, 'all'] as const;
  const bySet: Record<string, Record<string, CellSummary>> = {};
  for (const scope of scopes) {
    bySet[scope] = {};
    for (const cell of cells) {
      const r = rows.filter((x) => x.cell === cell && (scope === 'all' || x.set === scope));
      if (r.length > 0) (bySet[scope] as Record<string, CellSummary>)[cell] = summarize(r);
    }
  }
  const comparisons: Record<string, unknown> = {};
  const losses: string[] = [];
  for (const scope of scopes) {
    const table = bySet[scope] ?? {};
    for (const form of FORMS) {
      const f = table[form];
      if (f === undefined) continue;
      const ranks: Record<string, number> = {};
      for (const m of METRICS)
        ranks[m] = 1 + cells.filter((c) => (table[c]?.[m] ?? Infinity) < f[m] * (1 - BAND)).length;
      ranks.accepted = 1 + cells.filter((c) => (table[c]?.accepted ?? -1) > f.accepted).length;
      ranks.oneShot = 1 + cells.filter((c) => (table[c]?.oneShot ?? -1) > f.oneShot).length;
      const against: Record<string, unknown> = {};
      for (const lang of LANGS) {
        const l = table[lang];
        if (l === undefined) continue;
        const entry: Record<string, unknown> = {};
        for (const m of METRICS) {
          const v = verdict(f[m], l[m]);
          entry[m] = { form: f[m], lang: l[m], verdict: v, ratio: l[m] / f[m] };
          if (v === 'loss')
            losses.push(
              `${scope} ${form} vs ${lang}: ${m} ${f[m].toFixed(0)} against ${l[m].toFixed(0)}`,
            );
        }
        entry.oneShot = { form: f.oneShot, lang: l.oneShot, n: f.n };
        entry.accepted = { form: f.accepted, lang: l.accepted, n: f.n };
        if (l.accepted > f.accepted)
          losses.push(
            `${scope} ${form} vs ${lang}: accepted ${f.accepted}/${f.n} against ${l.accepted}/${l.n}`,
          );
        if (l.oneShot > f.oneShot)
          losses.push(
            `${scope} ${form} vs ${lang}: one shot ${f.oneShot}/${f.n} against ${l.oneShot}/${l.n}`,
          );
        against[lang] = entry;
      }
      (comparisons[scope] as Record<string, unknown> | undefined) ??= {};
      (comparisons[scope] as Record<string, unknown>)[form] = { ranks, against };
    }
  }
  const out = {
    method:
      'o200k tokens per task; system text 1.25x on the first call of a 1-task session, 0.17x on the first call of a task in a 10-task session, 0.05x on later calls and unbounded; task+view, repair messages and replies 1x. Cost ties within 1%. Cells pool Haiku and Sonnet (12 tasks each) per set: 24 trials; "all" pools the four sets: 96 trials.',
    sets: SETS,
    models: MODELS,
    forms: {
      a0: 'A0 canonical, MODEL_GUIDE.rules-merged.txt, dependency-scoped function view + scoped program handle',
      dense: 'A0 dense, MODEL_GUIDE.dense.txt, lean function view with callee bodies',
    },
    languages: LANGS,
    languageView:
      'tools/scoped-view.ts: target function body + direct callees (tree-sitter parse), numbered line edits (PROTOCOL_LINE_EDIT); all 12 tasks have an empty callee set in every language, so the signatures and bodies arms are the same prompt',
    notes,
    cells: bySet,
    comparisons,
    losses,
  };
  await writeFile(join(dir, 'ai-edit-scoped.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return out;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const out = await summarizeScoped();
  const cellsAll = (out?.cells as Record<string, Record<string, CellSummary>> | undefined) ?? {};
  for (const [scope, table] of Object.entries(cellsAll)) {
    process.stdout.write(`\n== ${scope} ==\n`);
    for (const [cell, c] of Object.entries(table))
      process.stdout.write(
        `${cell.padEnd(8)} n=${c.n} one=${c.oneShot} acc=${c.accepted} S=${c.system.toFixed(0)} calls=${c.callsPerTask.toFixed(2)} ctx=${c.buckets.toolContext.toFixed(0)} out=${c.buckets.output.toFixed(0)} | ${c.task1.toFixed(0)} / ${c.session10.toFixed(0)} / ${c.unbounded.toFixed(0)}\n`,
      );
  }
  process.stdout.write(`\nlosses:\n${((out?.losses as string[] | undefined) ?? []).join('\n')}\n`);
  process.stdout.write(`notes: ${JSON.stringify(out?.notes)}\n`);
}
