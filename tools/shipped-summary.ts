/**
 * Summary of the shipped-text experiment (the guide and the MCP tool text of the shipped paths).
 *
 * Reads the scored reports `results/shipped/<set>.<model>.<variant>.json` (first reply plus one repair
 * round by a fresh subject; the replies are in the matching `.replies.json`), the texts under
 * `experiments/primers/shipped/` and `results/shipped-accounting.json`, and writes `results/shipped.json`.
 *
 * Variants: `G0` is the shipped guide (MODEL_GUIDE.min.txt), `G1` and `G2` trim its EDIT section toward the
 * wording of the ablation winner; `T0` is the tool list the MCP server serves, `T1` and `T2` shorter wording
 * of the descriptions; `B0` to `B2` are guide and tool list together (a client with the skill and the server).
 * The system text of a cell is the variant text alone, so every token of the tool list is counted.
 * Selection set: d; confirmation sets: e and f (never used to choose). The method and the verdict rules are
 * those of tools/primer-ablation-summary.ts (one shot and one repair round; Wilson 95% intervals; cache-adjusted
 * cost 1.25x on the first call of a one-task session, 0.17x per task of a 10-task session, 0.05x later and unbounded;
 * a rate is a win or a loss only when the intervals do not overlap, a cost outside a 1% band).
 *
 *   node dist/tools/shipped-summary.js
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { writeReport } from './scrub-results.js';

interface Attempt {
  readonly status: string;
  readonly failures?: readonly string[];
}
interface TrialRow {
  readonly task: string;
  readonly setupTokensLocal: Record<string, number>;
  readonly tokenBucketsLocal: { toolContext: number; output: number } | null;
  readonly modelCalls: number;
  readonly acceptedOneShot: boolean | null;
  readonly accepted: boolean | null;
  readonly attempts: readonly Attempt[];
}
interface Report {
  readonly trials: readonly TrialRow[];
  readonly harnessSelfCheck: { readonly ok: boolean };
  readonly taskSetSha256: string;
}
interface Row {
  readonly task: string;
  readonly system: number;
  readonly calls: number;
  readonly context: number;
  readonly output: number;
  readonly oneShot: boolean;
  readonly accepted: boolean;
  readonly attempts: readonly Attempt[];
}

const dir = 'results/shipped';
const textDir = 'experiments/primers/shipped';
const MODELS = ['haiku', 'sonnet'] as const;
const SELECT_SETS = ['d'];
const CONFIRM_SETS = ['e', 'f'];
const BAND = 0.01;
const FILE: Record<string, string> = { G: 'guide', T: 'tools', B: 'both' };
const control = (v: string): string => `${v[0]}0`;

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
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);

const notes: string[] = [];
const shas: Record<string, string> = {};
const variants = new Set<string>();
const rowsKey = new Map<string, Row[]>();
for (const f of readdirSync(dir).sort()) {
  const m = /^([a-z0-9]+)\.(haiku|sonnet)\.([GTB][0-9])\.json$/.exec(f);
  if (m === null) continue;
  const [, set, model, variant] = m as unknown as [string, string, string, string];
  const rep = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Report;
  if (!rep.harnessSelfCheck.ok) notes.push(`self-check failed ${f}`);
  shas[set] = rep.taskSetSha256;
  variants.add(variant);
  rowsKey.set(
    `${variant}|${set}|${model}`,
    rep.trials.map((t) => ({
      task: t.task,
      system: t.setupTokensLocal.o200k_base ?? 0,
      calls: Math.max(1, t.modelCalls),
      context: t.tokenBucketsLocal?.toolContext ?? 0,
      output: t.tokenBucketsLocal?.output ?? 0,
      oneShot: t.acceptedOneShot === true,
      accepted: t.accepted === true,
      attempts: t.attempts,
    })),
  );
}

const enc = getEncoding('o200k_base');
const texts: Record<string, unknown> = {};
for (const v of [...variants].sort()) {
  const p = join(textDir, `${FILE[v[0] as string]}.${v}.txt`);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8').trimEnd();
  texts[v] = { file: p, o200k: enc.encode(text).length, bytes: Buffer.byteLength(text) };
}

const SCOPES: Record<string, readonly string[]> = {
  'select(d)': SELECT_SETS,
  'confirm(e+f)': CONFIRM_SETS,
};
const pick = (variant: string, sets: readonly string[], model: string): Row[] =>
  sets.flatMap((s) =>
    (model === 'pooled' ? [...MODELS] : [model]).flatMap(
      (m) => rowsKey.get(`${variant}|${s}|${m}`) ?? [],
    ),
  );

interface CellSum {
  readonly n: number;
  readonly oneShot: { k: number; ci95: number[] };
  readonly accepted: { k: number; ci95: number[] };
  readonly callsPerTask: number;
  readonly tokensPerAcceptedEdit: Record<string, number | null>;
}
function summarize(rs: readonly Row[]): Record<string, unknown> {
  const n = rs.length;
  const one = rs.filter((r) => r.oneShot).length;
  const acc = rs.filter((r) => r.accepted).length;
  const cost = (first: number, later: number): number[] =>
    rs.map((r) => r.system * (first + later * (r.calls - 1)) + r.context + r.output);
  const task1 = cost(1.25, 0.05);
  const session10 = cost(0.17, 0.05);
  const unbounded = rs.map((r) => r.system * 0.05 * r.calls + r.context + r.output);
  const [o1, o2] = wilson(one, n);
  const [a1, a2] = wilson(acc, n);
  const tpa = (xs: number[]): number | null => (acc === 0 ? null : r1(sum(xs) / acc));
  return {
    n,
    oneShot: { k: one, rate: r3(one / n), ci95: [r3(o1), r3(o2)] },
    accepted: { k: acc, rate: r3(acc / n), ci95: [r3(a1), r3(a2)] },
    system: r1(mean(rs.map((r) => r.system))),
    callsPerTask: r3(mean(rs.map((r) => r.calls))),
    toolContext: r1(mean(rs.map((r) => r.context))),
    output: r1(mean(rs.map((r) => r.output))),
    tokensPerAcceptedEdit: {
      task1: tpa(task1),
      session10: tpa(session10),
      unbounded: tpa(unbounded),
    },
  };
}

const cells: Record<string, Record<string, unknown>> = {};
const sums: Record<string, Record<string, CellSum>> = {};
for (const [scope, sets] of Object.entries(SCOPES))
  for (const model of [...MODELS, 'pooled'] as const)
    for (const v of [...variants].sort()) {
      const rs = pick(v, sets, model);
      if (rs.length === 0) continue;
      const s = summarize(rs);
      const key = `${scope}/${model}`;
      cells[key] ??= {};
      (cells[key] as Record<string, unknown>)[v] = s;
      sums[key] ??= {};
      (sums[key] as Record<string, CellSum>)[v] = s as unknown as CellSum;
    }

// Selection on d, fixed before e and f: eligible when, pooled over both models, the one-shot count and the
// count after one repair are not lower than the control of the same form.
const selection: Record<string, unknown> = {};
{
  const table = sums['select(d)/pooled'] ?? {};
  for (const form of ['G', 'T', 'B']) {
    const ctl = table[`${form}0`];
    if (ctl === undefined) continue;
    const others = Object.entries(table).filter(([v]) => v.startsWith(form) && v !== `${form}0`);
    const tok = (v: string): number =>
      Number((texts[v] as { o200k: number } | undefined)?.o200k ?? 0);
    selection[form] = {
      control: `${form}0`,
      controlOn_d: `${ctl.oneShot.k} one shot, ${ctl.accepted.k} repaired of ${ctl.n}`,
      eligible: others
        .filter(([, c]) => c.oneShot.k >= ctl.oneShot.k && c.accepted.k >= ctl.accepted.k)
        .map(([v]) => `${v} (${tok(v)} o200k)`),
      notEligible: others
        .filter(([, c]) => !(c.oneShot.k >= ctl.oneShot.k && c.accepted.k >= ctl.accepted.k))
        .map(
          ([v, c]) =>
            `${v} (${c.oneShot.k} one shot, ${c.accepted.k} repaired of ${c.n}, against ${ctl.oneShot.k} and ${ctl.accepted.k})`,
        ),
    };
  }
}

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
const verdicts: Record<string, Record<string, unknown>> = {};
for (const [key, table] of Object.entries(sums))
  for (const [v, c] of Object.entries(table)) {
    const ctl = table[control(v)];
    if (ctl === undefined || v === control(v)) continue;
    const axes: Record<string, unknown> = {
      nVariant: c.n,
      nControl: ctl.n,
      oneShot: `${c.oneShot.k}/${c.n} against ${ctl.oneShot.k}/${ctl.n}: ${rateVerdict(c.oneShot.ci95, ctl.oneShot.ci95)}`,
      accepted: `${c.accepted.k}/${c.n} against ${ctl.accepted.k}/${ctl.n}: ${rateVerdict(c.accepted.ci95, ctl.accepted.ci95)}`,
    };
    for (const m of ['task1', 'session10', 'unbounded'] as const) {
      const a = c.tokensPerAcceptedEdit[m];
      const b = ctl.tokensPerAcceptedEdit[m];
      axes[`tokensPerAccepted.${m}`] =
        a == null || b == null ? 'tie' : `${a} against ${b}: ${costVerdict(a, b)}`;
    }
    verdicts[`${key}/${v}`] = axes;
  }

// The shipped texts against each other (G0 guide, T0 tool list, B0 both): what the guide buys over the
// tool list alone, in the scopes where both were run. Same verdict rules; not a candidate comparison.
const crossForm: Record<string, Record<string, unknown>> = {};
for (const [key, table] of Object.entries(sums))
  for (const [a, b] of [
    ['G0', 'T0'],
    ['B0', 'T0'],
    ['B0', 'G0'],
  ] as const) {
    const x = table[a];
    const y = table[b];
    if (x === undefined || y === undefined) continue;
    const axes: Record<string, unknown> = {
      oneShot: `${a} ${x.oneShot.k}/${x.n} against ${b} ${y.oneShot.k}/${y.n}: ${rateVerdict(x.oneShot.ci95, y.oneShot.ci95)}`,
      accepted: `${a} ${x.accepted.k}/${x.n} against ${b} ${y.accepted.k}/${y.n}: ${rateVerdict(x.accepted.ci95, y.accepted.ci95)}`,
    };
    for (const m of ['task1', 'session10', 'unbounded'] as const) {
      const p = x.tokensPerAcceptedEdit[m];
      const q = y.tokensPerAcceptedEdit[m];
      axes[`tokensPerAccepted.${m}`] =
        p == null || q == null ? 'tie' : `${p} against ${q}: ${costVerdict(p, q)}`;
    }
    crossForm[`${key}/${a}-vs-${b}`] = axes;
  }

// Per-task flips against the control, and every non-accepted attempt with the checker's first line.
const flips: Record<string, unknown> = {};
const failures: Record<string, string[]> = {};
for (const v of [...variants].sort()) {
  const ctlName = control(v);
  const tag = (x: Row): string => (x.oneShot ? 'one-shot' : x.accepted ? 'repaired' : 'rejected');
  const rank: Record<string, number> = { 'one-shot': 2, repaired: 1, rejected: 0 };
  const worse: string[] = [];
  const better: string[] = [];
  for (const [key, rs] of rowsKey) {
    const [variant, set, model] = key.split('|') as [string, string, string];
    if (variant !== v) continue;
    for (const r of rs)
      for (const a of r.attempts)
        if (a.status !== 'ok') {
          const list = failures[v] ?? [];
          failures[v] = list;
          list.push(
            `${set}/${model}/${r.task}: ${a.status}: ${(a.failures?.[0] ?? '').slice(0, 160)}`,
          );
        }
    if (v === ctlName) continue;
    const base = new Map((rowsKey.get(`${ctlName}|${set}|${model}`) ?? []).map((x) => [x.task, x]));
    for (const r of rs) {
      const c = base.get(r.task);
      if (c === undefined || tag(r) === tag(c)) continue;
      ((rank[tag(r)] as number) < (rank[tag(c)] as number) ? worse : better).push(
        `${set}/${model}/${r.task}: ${tag(c)} -> ${tag(r)}`,
      );
    }
  }
  if (v !== ctlName) flips[v] = { worse, better };
}

// Failure taxonomy: the rules of tools/primer-ablation-summary.ts, applied to every non-accepted attempt.
interface Category {
  readonly category: string;
  readonly cls: 'protocol-ambiguity' | 'model-error';
  readonly re: RegExp;
  readonly proposal: string;
}
/** Deterministic rules over the checker's first failure line of a non-accepted attempt, first match wins. */
const CATEGORIES: readonly Category[] = [
  {
    category: 'bool result without `-> bool` in the head',
    cls: 'protocol-ambiguity',
    re: /expected u32, got bool/,
    proposal:
      'neither primer says that a result that is not u32 goes in the head (the canonical text lists `ge(->bool)` as an operation result, the dense text shows `-> bool` only inside an example); the checker already knows the type of the last statement, so a whole-function reply without a head result could take it from there (bool, record, array), or the teaching text names it (variants KT and DT measure the text)',
  },
  {
    category: 'record result type not written',
    cls: 'protocol-ambiguity',
    re: /expected a result type after '->'|result: expected u32, got \(u32,u32\)|ret: expected u32, got \(u32,u32\)|expected u32x2, got \(u32,u32\)|needs '-> RESULT'|type 'rec': unexpected/,
    proposal:
      'no primer text writes a record type; models invent `{u32 u32}`, `(u32 u32)`, `u32x2`, `rec`; same fix as the bool head (infer from the body, or teach `(u32,u32)`)',
  },
  {
    category: 'dense operand count, or a value used twice (dense)',
    cls: 'protocol-ambiguity',
    re: /after a complete expression|one statement per line/,
    proposal:
      'the dense primer teaches prefix nesting by one example (`add mul A B C`); a fold seed, a ternary mul and a repeated value are not taught; say so in the primer or let the dense parser name a repeated pure sub-expression (the earlier dense records propose the same)',
  },
  {
    category: 'callee used before it is defined (helper added after its caller)',
    cls: 'protocol-ambiguity',
    re: /unknown (function|callee|fold body) '(twice|addtwice|bitadd|bitcount|countbit|addlow|cnt|addel|minel|sq|dbl|inc|mulel|stepadd|max2)'/,
    proposal:
      'neither primer says that a callee is defined above its caller (the min guide does: "F earlier"); a multi-function reply could be ordered by dependency by the edit session, or the teaching text says so',
  },
  {
    category: 'operation name invented (not in the primer or the language)',
    cls: 'model-error',
    re: /unknown (function|callee|fold body) '|is not an operation, a function, or a named value|parameters are written/,
    proposal:
      'none for the full op list; where a variant dropped the list the loss is the ablation cost',
  },
  {
    category: 'nested operand (canonical)',
    cls: 'model-error',
    re: /nested operand/,
    proposal: 'none: the primer says one op, no nesting; the rejection gives the split',
  },
  {
    category: 'at or get on the wrong aggregate',
    cls: 'model-error',
    re: /at expects a record|get expects an array|get on a record/,
    proposal: 'none: the primer names get for arrays and at for records; the rejection repeats it',
  },
  {
    category: 'replacement block shape (end before ret, unused or duplicate node, operand count)',
    cls: 'model-error',
    re: /unexpected 'end' before ret|is not used by any node|duplicate edit|duplicate definition|rec expects|select expects|expects \d+ (extra )?arguments, got|needs \d+ operands|out of range|expected 'fn name types|expected 0 arguments/,
    proposal: 'none: each rejection names the fix',
  },
  {
    category: 'wrong result',
    cls: 'model-error',
    re: /= .*, expected |wrong-output/,
    proposal: 'none: the edit was well formed and wrong',
  },
  {
    category: 'missing function or no reply',
    cls: 'model-error',
    re: /missing function|no reply|^$/,
    proposal: 'none',
  },
];
const OTHER = 'other (a type or structure error of the edit)';
const taxonomy: Record<string, Record<string, number>> = {};
for (const [key, rs] of rowsKey) {
  const [variant] = key.split('|') as [string];
  taxonomy[variant] ??= {};
  const bucket = taxonomy[variant] as Record<string, number>;
  for (const r of rs)
    for (const a of r.attempts) {
      if (a.status === 'ok') continue;
      const msg = a.failures?.[0] ?? (a.status === 'no-reply' ? 'no reply' : '');
      const hit = CATEGORIES.find((c) =>
        c.re.test(`${a.status === 'wrong-output' ? 'wrong-output ' : ''}${msg}`),
      );
      const name = hit === undefined ? OTHER : hit.category;
      bucket[name] = (bucket[name] ?? 0) + 1;
    }
}

await writeReport('results/shipped.json', {
  generatedAt: new Date().toISOString(),
  design:
    'Shipped-text experiment: the system text of a cell is the whole variant text (guide, MCP tool list, or both). Selection set d (13 tasks); confirmation sets e (11) and f (13), different sealed sets never used to choose. Fresh Haiku and Sonnet subagents, one shot and one repair round.',
  notes,
  taskSetSha256: shas,
  texts,
  selection,
  cells,
  verdictsAgainstControl: verdicts,
  crossFormVerdicts: crossForm,
  flipsAgainstControl: flips,
  failures,
  failureTaxonomy: {
    note: 'every non-accepted attempt (first reply and repair) of a variant over all sets and both models, by the first rule that matches the checker message',
    categories: CATEGORIES.map((c) => ({
      category: c.category,
      class: c.cls,
      proposal: c.proposal,
    })),
    perVariant: taxonomy,
  },
});
process.stdout.write(`${variants.size} variants, ${Object.keys(verdicts).length} verdict rows\n`);
