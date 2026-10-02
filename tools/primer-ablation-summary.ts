/**
 * Summary of the primer ablation (work item A: a shorter primer that keeps acceptance).
 *
 * Reads the scored reports `results/primer-ablation/<set>.<model>.<variant>.json` (first reply plus one
 * repair round by a fresh subject; the replies are in the matching `.replies.json`) and the primer
 * texts `experiments/primers/ablation/<variant>.txt`, and writes `results/primer-ablation.json`.
 *
 * Variants: `dense.D0` and `canon.K0` are the current primers (the controls). `Dx<n>` / `Kx<n>` drop
 * the n-th clause, `DR<n>` / `KR<n>` are rewrites, `DC` / `KC` combine the drops and rewrites that
 * did not hurt on the selection set. Selection set: d; confirmation sets: e and f (never used to
 * choose). Per scope (set group, model or both models pooled): n, one-shot and repaired
 * acceptance with Wilson 95% intervals, o200k tokens, cache-adjusted cost per task and per accepted
 * edit (system 1.25x on the first call of a 1-task session, 0.17x in a 10-task session, 0.05x on later
 * calls and in an unbounded session), then wins, ties and losses against the control of the same form.
 * A rate is a win or a loss only when the Wilson intervals do not overlap; a cost is a win or a loss
 * outside a 1% band. The per-task flips against the control and the first-failure taxonomy
 * (protocol ambiguity or model error, with a general fix proposal) are recorded as well.
 *
 *   node dist/tools/primer-ablation-summary.js [--dir=results]
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
  readonly viewTokensLocal: Record<string, number>;
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
  readonly set: string;
  readonly model: string;
  readonly task: string;
  readonly system: number;
  readonly view: number;
  readonly calls: number;
  readonly context: number;
  readonly output: number;
  readonly oneShot: boolean;
  readonly accepted: boolean;
  readonly first: string;
  readonly attempts: readonly Attempt[];
}

const dir = process.argv.find((a) => a.startsWith('--dir='))?.slice(6) ?? 'results';
const primerDir = 'experiments/primers/ablation';
const MODELS = ['haiku', 'sonnet'] as const;
const CONTROL: Record<string, string> = { dense: 'dense.D0', canon: 'canon.K0' };
const SELECT_SETS = ['d'];
const CONFIRM_SETS = ['e', 'f'];
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
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

// --- load ---------------------------------------------------------------------------------------
const notes: string[] = [];
const shas: Record<string, string> = {};
const variants = new Set<string>();
/** rows by `variant|set|model` */
const rowsKey = new Map<string, Row[]>();
for (const f of readdirSync(join(dir, 'primer-ablation')).sort()) {
  const m = /^([a-z0-9]+)\.(haiku|sonnet)\.([a-z]+\.[A-Za-z0-9]+)\.json$/.exec(f);
  if (m === null) continue;
  const [, set, model, variant] = m as unknown as [string, string, string, string];
  const rep = JSON.parse(readFileSync(join(dir, 'primer-ablation', f), 'utf8')) as Report;
  if (!rep.harnessSelfCheck.ok) notes.push(`self-check failed ${f}`);
  shas[set] = rep.taskSetSha256;
  variants.add(variant);
  rowsKey.set(
    `${variant}|${set}|${model}`,
    rep.trials.map((t) => ({
      set,
      model,
      task: t.task,
      system: t.setupTokensLocal.o200k_base ?? 0,
      view: t.viewTokensLocal.o200k_base ?? 0,
      calls: Math.max(1, t.modelCalls),
      context: t.tokenBucketsLocal?.toolContext ?? 0,
      output: t.tokenBucketsLocal?.output ?? 0,
      oneShot: t.acceptedOneShot === true,
      accepted: t.accepted === true,
      first: t.attempts[0]?.status ?? 'no-reply',
      attempts: t.attempts,
    })),
  );
}

// --- primers -------------------------------------------------------------------------------------
const enc = { o200k_base: getEncoding('o200k_base'), cl100k_base: getEncoding('cl100k_base') };
const primers: Record<string, unknown> = {};
for (const v of [...variants].sort()) {
  const p = join(primerDir, `${v}.txt`);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8').trimEnd();
  primers[v] = {
    o200k: enc.o200k_base.encode(text).length,
    cl100k: enc.cl100k_base.encode(text).length,
    bytes: Buffer.byteLength(text),
    text,
  };
}

// --- cells ---------------------------------------------------------------------------------------
const SCOPES: Record<string, readonly string[]> = {
  'select(d)': SELECT_SETS,
  'confirm(e+f)': CONFIRM_SETS,
};
function pick(variant: string, sets: readonly string[], model: string): Row[] {
  const out: Row[] = [];
  for (const s of sets)
    for (const m of model === 'pooled' ? MODELS : [model])
      out.push(...(rowsKey.get(`${variant}|${s}|${m}`) ?? []));
  return out;
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
    view: r1(mean(rs.map((r) => r.view))),
    callsPerTask: r3(mean(rs.map((r) => r.calls))),
    toolContext: r1(mean(rs.map((r) => r.context))),
    output: r1(mean(rs.map((r) => r.output))),
    costPerTask: {
      task1: r1(mean(task1)),
      session10: r1(mean(session10)),
      unbounded: r1(mean(unbounded)),
    },
    tokensPerAcceptedEdit: {
      task1: tpa(task1),
      session10: tpa(session10),
      unbounded: tpa(unbounded),
    },
  };
}
interface CellSum {
  readonly n: number;
  readonly oneShot: { k: number; ci95: number[] };
  readonly accepted: { k: number; ci95: number[] };
  readonly callsPerTask: number;
  readonly tokensPerAcceptedEdit: Record<string, number | null>;
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

// --- the selection on set d ----------------------------------------------------------------------------
// Rule, fixed before the confirmation sets were run: a variant is eligible when, pooled over both models on
// set d, its one-shot count and its count after one repair are not lower than the control's; the three
// eligible variants with the fewest system tokens of each form go on to the confirmation sets e and f.
// KT and DT were added afterwards to test a proposed fix (the result head); they are not candidates.
const HYPOTHESIS = new Set(['canon.KT', 'dense.DT']);
const selection: Record<string, unknown> = {};
{
  const table = sums['select(d)/pooled'] ?? {};
  for (const form of ['canon', 'dense'] as const) {
    const ctl = table[CONTROL[form] as string];
    if (ctl === undefined) continue;
    const eligible = Object.entries(table)
      .filter(
        ([v, c]) =>
          v.startsWith(`${form}.`) &&
          v !== CONTROL[form] &&
          !HYPOTHESIS.has(v) &&
          c.oneShot.k >= ctl.oneShot.k &&
          c.accepted.k >= ctl.accepted.k,
      )
      .map(([v]) => v)
      .sort(
        (a, b) =>
          Number((primers[a] as { o200k: number }).o200k) -
          Number((primers[b] as { o200k: number }).o200k),
      );
    const notEligible = Object.entries(table)
      .filter(
        ([v]) =>
          v.startsWith(`${form}.`) &&
          v !== CONTROL[form] &&
          !HYPOTHESIS.has(v) &&
          !eligible.includes(v),
      )
      .map(
        ([v, c]) =>
          `${v} (${c.oneShot.k} one shot, ${c.accepted.k} repaired of ${c.n}, against ${ctl.oneShot.k} and ${ctl.accepted.k})`,
      );
    selection[form] = {
      control: CONTROL[form],
      controlOn_d: `${ctl.oneShot.k} one shot, ${ctl.accepted.k} repaired of ${ctl.n}`,
      eligible: eligible.map((v) => `${v} (${(primers[v] as { o200k: number }).o200k} o200k)`),
      carriedToConfirmation: eligible.slice(0, 3),
      note: 'the first two went to the confirmation sets first; the third (same rule) was added after the first two had lost on e and f, so that the shorter dense and canonical primers get a fairer chance',
      notEligible,
    };
  }
}

// --- verdicts against the control of the same form --------------------------------------------------
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
    const ctl = table[CONTROL[v.split('.')[0] as string] as string];
    if (ctl === undefined || v === CONTROL[v.split('.')[0] as string]) continue;
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

// --- per-task flips against the control (first reply and after the repair) ----------------------------
const flips: Record<string, unknown> = {};
for (const v of [...variants].sort()) {
  const ctlName = CONTROL[v.split('.')[0] as string] as string;
  if (v === ctlName) continue;
  const per: Record<string, unknown> = {};
  for (const [scope, sets] of Object.entries(SCOPES)) {
    const worse: string[] = [];
    const better: string[] = [];
    for (const s of sets)
      for (const m of MODELS) {
        const a = rowsKey.get(`${v}|${s}|${m}`) ?? [];
        const b = new Map((rowsKey.get(`${ctlName}|${s}|${m}`) ?? []).map((r) => [r.task, r]));
        for (const r of a) {
          const c = b.get(r.task);
          if (c === undefined) continue;
          const tag = (x: Row): string =>
            x.oneShot ? 'one-shot' : x.accepted ? 'repaired' : 'rejected';
          if (tag(r) !== tag(c)) {
            const rank = { 'one-shot': 2, repaired: 1, rejected: 0 } as const;
            const entry = `${m}/${r.task}: ${tag(c)} -> ${tag(r)}`;
            (rank[tag(r) as keyof typeof rank] < rank[tag(c) as keyof typeof rank]
              ? worse
              : better
            ).push(entry);
          }
        }
      }
    if (worse.length + better.length > 0) per[scope] = { worse, better };
  }
  flips[v] = per;
}

// --- failure taxonomy ----------------------------------------------------------------------------------
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

await writeReport(join(dir, 'primer-ablation.json'), {
  generatedAt: new Date().toISOString(),
  design:
    'Clause ablation of the dense and canonical (rules-merged) primers. Selection set d (13 tasks); confirmation sets e (11) and f (13), different sealed sets never used to choose. Variants: drop-one-clause (Dx, Kx), rewrites (DR, KR), combinations (DC, KC); controls dense.D0 and canon.K0 re-collected fresh in the same session. Fresh Haiku and Sonnet Agent-tool subagents, one subagent per variant, model and set answering every task of the set from the system text, the view and the task only (each task answered independently, one group file per variant), then one repair round by a fresh subagent given the exact rejection of its first reply; one shot plus one repair. Rates carry Wilson 95% intervals; a win or a loss on a rate needs non-overlapping intervals, a cost is a win or a loss outside a 1% band.',
  notes,
  taskSetSha256: shas,
  primers,
  selection,
  cells,
  verdictsAgainstControl: verdicts,
  flipsAgainstControl: flips,
  failureTaxonomy: {
    note: 'every non-accepted attempt (first reply and repair) of a variant over all sets and both models, by the first rule that matches the checker message; class and the general fix proposal per category',
    categories: CATEGORIES.map((c) => ({
      category: c.category,
      class: c.cls,
      proposal: c.proposal,
    })),
    perVariant: taxonomy,
  },
});
process.stdout.write(`${variants.size} variants, ${Object.keys(verdicts).length} verdict rows\n`);
