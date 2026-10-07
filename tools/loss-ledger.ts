/**
 * The loss ledger: a baseline of A0's recorded losses that can only shrink. For every kernel and
 * axis, the ledger lists each competitor that beat A0 beyond the tie band, with the gap and the
 * noise it was recorded with. `check` re-derives the same observations from the results files and
 * fails on a new loss or a loss that worsened by more than the recorded noise; `update` rewrites the
 * ledger, and a rewrite that adds or worsens anything needs `--reason` (kept in `history`).
 *
 * Sources (all under results/):
 *   exec-benchmark.json   ns per call, A0 emitted C against hand-written C, Rust, and every language
 *                         that ran; emitted JS against hand-written JS; binary size against C.
 *   wasm-benchmark.json   ns per trip, module bytes and load time, A0 direct wasm against clang.
 *   lang-axes.json        tokens per kernel and per program for canonical A0 and, as a separate
 *                         subject `a0-dense`, for the dense view (src/dense.ts); validation time.
 *   ai-edit-experiment.{haiku,sonnet}-min.json and .{a..f,c400,c4000}.{haiku,sonnet}-min.json
 *                         (the shipped primer): accepted rate and tokens per trial, A0 against TS
 *                         and Rust, per protocol.
 *   spec-lines.json       the spec-line experiment (set g): each spec-line cell against the cell with no
 *                         spec lines in the same view, per model: accepted rate one shot and after one
 *                         repair, and unbounded-session tokens per accepted edit.
 *   primer-ablation.json  the primer ablation (sets d, e, f): each shortened primer variant against the
 *                         current primer of the same form (dense.D0, canon.K0), per model and scope:
 *                         accepted rate one shot and after one repair, and tokens per accepted edit for
 *                         one cold task.
 *   shipped.json          the shipped-text experiment (sets d, e, f): each trimmed guide, tool list or both
 *                         against the shipped one, same axes as the primer ablation.
 *
 * Timing observations carry the load they were recorded at. One recorded above LOAD_LIMIT (or with
 * no load recorded) is flagged `unverified`: it is kept in the ledger and reported, but a change in
 * it is a warning, never a pass or a failure on its own. Counts and token totals are deterministic
 * and are not load-dependent.
 *
 * Usage: bun run loss-ledger [-- --update [--reason "why"] | --json]
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scrubText } from './scrub-results.js';

/** AGENTS.md: no timing claim from a run recorded above load average 10. */
export const LOAD_LIMIT = 10;
/** The ledger keeps six significant figures; a gap within this of its recorded value is the same gap. */
const EPS = 1e-5;
export const LEDGER_PATH = join('results', 'loss-ledger.json');

export type Axis =
  | 'ns-per-call'
  | 'ns-per-call-js'
  | 'binary-bytes'
  | 'ns-per-trip'
  | 'wasm-bytes'
  | 'wasm-load-ms'
  | 'tokens-kernel'
  | 'tokens-program'
  | 'check-ms'
  | 'check-run-ms'
  | 'ai-accepted-conventional'
  | 'ai-accepted-structured'
  | 'ai-tokens-conventional'
  | 'ai-tokens-structured'
  | 'spec-accepted-one-shot'
  | 'spec-accepted-repaired'
  | 'spec-tokens-per-accepted'
  | 'primer-accepted-one-shot'
  | 'primer-accepted-repaired'
  | 'primer-tokens-per-accepted'
  | 'app-edit-accepted'
  | 'app-edit-tokens-per-accepted'
  | 'check-latency-ms';

export interface Observation {
  readonly id: string;
  readonly source: string;
  readonly kernel: string;
  readonly axis: Axis;
  readonly competitor: string;
  /** The A0 form measured when it is not the default canonical one (`a0-dense`). */
  readonly subject?: 'a0-dense';
  /** A0's value and the competitor's, in the axis unit (ns, bytes, tokens, ms, or a rate). */
  readonly a0: number;
  readonly other: number;
  /**
   * How far behind A0 is, as a fraction: a0/other - 1 for a lower-is-better axis, other - a0 for
   * a rate. Positive means the competitor is ahead.
   */
  readonly gap: number;
  /** The tie band in the same unit as `gap`: a gap inside it is a tie, not a loss. */
  readonly noise: number;
  /** One-minute load average the timing was recorded at; null for a deterministic axis. */
  readonly load: number | null;
  /** Set when the observation was recorded under load or without a load: not trusted. */
  readonly unverified?: string;
}

export interface LedgerEntry extends Observation {}

export interface LedgerHistory {
  readonly at: string;
  readonly reason: string;
  readonly added: number;
  readonly worsened: number;
  readonly removed: number;
}

export interface Ledger {
  readonly version: 1;
  readonly meaning: string;
  readonly loadLimit: number;
  readonly history: readonly LedgerHistory[];
  readonly entries: readonly LedgerEntry[];
}

const MEANING =
  'Recorded losses of A0 against its competitor set, per kernel and axis (tools/loss-ledger.ts). A loss is a competitor ahead of A0 by more than the tie band (`noise`). The ledger can only shrink: `bun run loss-ledger` fails on a new loss or a loss worse than `gap + noise`; `--update --reason` is the one way to grow it. Token rows exist for canonical A0 and, with `subject: a0-dense`, for the opt-in dense view (the canonical losses are never replaced by it). `unverified` entries were recorded above load 10 (or with no load recorded) and are not trusted either way.';

// --- reading the results --------------------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function readJson(root: string, file: string): Json | undefined {
  try {
    return obj(JSON.parse(readFileSync(join(root, 'results', file), 'utf8')));
  } catch {
    return undefined;
  }
}

function unverifiedReason(load: number | null): string | undefined {
  if (load === null) return 'no load average was recorded with this timing';
  if (load > LOAD_LIMIT) return `recorded at load ${load.toFixed(1)}, above ${LOAD_LIMIT}`;
  return undefined;
}

/** A lower-is-better observation; `noise` is the tie band as a fraction. */
function lower(
  source: string,
  kernel: string,
  axis: Axis,
  competitor: string,
  a0: number,
  other: number,
  noise: number,
  load: number | null,
  timing: boolean,
): Observation | undefined {
  if (!(a0 > 0) || !(other > 0)) return undefined;
  const unverified = timing ? unverifiedReason(load) : undefined;
  return {
    id: `${source}|${kernel}|${axis}|${competitor}`,
    source,
    kernel,
    axis,
    competitor,
    a0,
    other,
    gap: a0 / other - 1,
    noise,
    load: timing ? load : null,
    ...(unverified === undefined ? {} : { unverified }),
  };
}

/** Tie band of exec-bench's `verdict()`: 8 % or the observed spread, never above 25 %. */
function spreadBand(a: Json, b: Json): number {
  const sp = (s: Json): number => {
    const lo = num(s.minNsPerCall) ?? num(s.min);
    const hi = num(s.maxNsPerCall) ?? num(s.max);
    return lo !== undefined && hi !== undefined && lo > 0 ? hi / lo : 1;
  };
  return Math.min(Math.max(1.08, sp(a), sp(b)), 1.25) - 1;
}

function execObservations(root: string): Observation[] {
  const doc = readJson(root, 'exec-benchmark.json');
  const kernels = obj(doc?.kernels);
  if (doc === undefined || kernels === undefined) return [];
  const load = num((doc.loadAverage as unknown[] | undefined)?.[0]) ?? null;
  const out: Observation[] = [];
  const push = (o: Observation | undefined): void => {
    if (o !== undefined) out.push(o);
  };
  for (const [kernel, row] of Object.entries(kernels)) {
    const k = obj(row);
    const c = obj(k?.c);
    const emitted = obj(c?.emitted);
    const a0 = num(emitted?.medianNsPerCall);
    if (k === undefined || c === undefined || emitted === undefined || a0 === undefined) continue;
    const vs = (name: string, s: Json | undefined): void => {
      const v = num(s?.medianNsPerCall);
      if (s !== undefined && v !== undefined)
        push(
          lower(
            'exec-benchmark',
            kernel,
            'ns-per-call',
            name,
            a0,
            v,
            spreadBand(emitted, s),
            load,
            true,
          ),
        );
    };
    vs('c-handwritten', obj(c.handwritten));
    vs('rust', obj(c.rust));
    for (const [lang, value] of Object.entries(k)) {
      const l = obj(value);
      if (l?.status === 'ran') vs(lang, l);
    }
    const bytes = obj(c.binaryBytes);
    push(
      lower(
        'exec-benchmark',
        kernel,
        'binary-bytes',
        'c-handwritten',
        num(bytes?.emitted) ?? 0,
        num(bytes?.handwritten) ?? 0,
        0.02,
        null,
        false,
      ),
    );
    const js = obj(k.js);
    const jsA = obj(js?.emitted);
    const jsB = obj(js?.handwritten);
    if (jsA !== undefined && jsB !== undefined)
      push(
        lower(
          'exec-benchmark',
          kernel,
          'ns-per-call-js',
          'js-handwritten',
          num(jsA.medianNsPerCall) ?? 0,
          num(jsB.medianNsPerCall) ?? 0,
          spreadBand(jsA, jsB),
          load,
          true,
        ),
      );
  }
  return out;
}

function wasmObservations(root: string): Observation[] {
  const doc = readJson(root, 'wasm-benchmark.json');
  const rows = doc?.rows;
  if (doc === undefined || !Array.isArray(rows)) return [];
  // The file records no load average: its timings are flagged unverified until it does.
  const load = num((doc.loadAverage as unknown[] | undefined)?.[0]) ?? null;
  const out: Observation[] = [];
  for (const raw of rows) {
    const r = obj(raw);
    if (r === undefined || typeof r.kernel !== 'string') continue;
    const per = (
      axis: Axis,
      a: number | undefined,
      b: number | undefined,
      timing: boolean,
    ): void => {
      const o = lower(
        'wasm-benchmark',
        r.kernel as string,
        axis,
        'clang',
        a ?? 0,
        b ?? 0,
        timing ? 0.05 : 0.02,
        load,
        timing,
      );
      if (o !== undefined) out.push(o);
    };
    per('ns-per-trip', num(obj(r.nsPerTrip)?.a0), num(obj(r.nsPerTrip)?.clang), true);
    per('wasm-bytes', num(obj(r.bytes)?.a0), num(obj(r.bytes)?.clang), false);
    per('wasm-load-ms', num(obj(r.loadMs)?.a0), num(obj(r.loadMs)?.clang), true);
  }
  return out;
}

function langAxesObservations(root: string): Observation[] {
  const doc = readJson(root, 'lang-axes.json');
  if (doc === undefined) return [];
  const rounds = obj(doc.load)?.perRound;
  const loads = Array.isArray(rounds)
    ? rounds
        .map((r) => num((obj(r)?.loadavg as unknown[] | undefined)?.[0]))
        .filter((x): x is number => x !== undefined)
    : [];
  const load = loads.length === 0 ? null : Math.max(...loads);
  const out: Observation[] = [];
  const tokens = obj(doc.tokens);
  const a0t = obj(tokens?.a0);
  // Two A0 subjects on the tokens axes: canonical A0 (the default form, as recorded before the
  // dense view existed) and A0 dense (src/dense.ts, opt-in; the same programs). The dense rows
  // are separate ledger entries (`subject: 'a0-dense'`), so the canonical losses stay recorded.
  const a0dense = obj(obj(a0t?.dense)?.kernels);
  for (const [lang, value] of Object.entries(tokens ?? {})) {
    if (lang === 'a0') continue;
    const k = obj(obj(value)?.kernels);
    for (const [kernel, a0row] of Object.entries(obj(a0t?.kernels) ?? {})) {
      for (const [subject, mine] of [
        [undefined, obj(a0row)],
        ['a0-dense', obj(a0dense?.[kernel])],
      ] as const) {
        if (mine === undefined) continue;
        const theirs = obj(k?.[kernel]);
        for (const [field, axis] of [
          ['kernel', 'tokens-kernel'],
          ['program', 'tokens-program'],
        ] as const) {
          const o = lower(
            subject === undefined ? 'lang-axes' : 'lang-axes-dense',
            kernel,
            axis,
            lang,
            num(mine[field]) ?? 0,
            num(theirs?.[field]) ?? 0,
            0,
            null,
            false,
          );
          if (o !== undefined) out.push(subject === undefined ? o : { ...o, subject });
        }
      }
    }
  }
  const validation = obj(doc.validation);
  const a0v = obj(obj(validation?.a0)?.kernels);
  for (const [lang, value] of Object.entries(validation ?? {})) {
    if (lang === 'a0') continue;
    const kernels = obj(obj(value)?.kernels);
    for (const [kernel, mineRaw] of Object.entries(a0v ?? {})) {
      const mine = obj(mineRaw);
      const theirs = obj(kernels?.[kernel]);
      for (const [median, samples, axis] of [
        ['checkMedianMs', 'checkMs', 'check-ms'],
        ['checkRunMedianMs', 'checkRunMs', 'check-run-ms'],
      ] as const) {
        const a = num(mine?.[median]);
        const b = num(theirs?.[median]);
        const spread = (s: unknown): number => {
          const xs = Array.isArray(s)
            ? s.filter((x): x is number => typeof x === 'number' && x > 0)
            : [];
          return xs.length < 2 ? 1 : Math.max(...xs) / Math.min(...xs);
        };
        const band =
          Math.min(Math.max(1.08, spread(mine?.[samples]), spread(theirs?.[samples])), 1.25) - 1;
        const o = lower('lang-axes', kernel, axis, lang, a ?? 0, b ?? 0, band, load, true);
        if (o !== undefined) out.push(o);
      }
    }
  }
  return out;
}

const AI_HEADLINE = /^ai-edit-experiment\.(?:(?:[a-f]|c400|c4000)\.)?(haiku|sonnet)-min\.json$/;

function aiObservations(root: string): Observation[] {
  const out: Observation[] = [];
  let files: string[];
  try {
    files = readdirSync(join(root, 'results'))
      .filter((f) => AI_HEADLINE.test(f))
      .sort();
  } catch {
    return out;
  }
  for (const file of files) {
    const doc = readJson(root, file);
    const trials = doc?.trials;
    if (doc === undefined || !Array.isArray(trials)) continue;
    const model = AI_HEADLINE.exec(file)?.[1] ?? '?';
    const kernel = `${String(doc.taskSet)}/${model}`;
    const source = `ai-edit:${file.replace(/^ai-edit-experiment\./, '').replace(/\.json$/, '')}`;
    const cells = new Map<string, { n: number; accepted: number; tokens: number }>();
    for (const raw of trials) {
      const t = obj(raw);
      const total = num(obj(t?.tokenBucketsLocal)?.total);
      if (
        t === undefined ||
        typeof t.representation !== 'string' ||
        typeof t.protocol !== 'string' ||
        total === undefined
      )
        continue;
      const key = `${t.representation}/${t.protocol}`;
      const c = cells.get(key) ?? { n: 0, accepted: 0, tokens: 0 };
      c.n += 1;
      c.accepted += t.accepted === true ? 1 : 0;
      c.tokens += total;
      cells.set(key, c);
    }
    for (const protocol of ['conventional', 'structured'] as const) {
      const a = cells.get(`a0/${protocol}`);
      if (a === undefined || a.n === 0) continue;
      for (const rival of ['ts', 'rust']) {
        const b = cells.get(`${rival}/${protocol}`);
        if (b === undefined || b.n === 0) continue;
        const tok = lower(
          source,
          kernel,
          `ai-tokens-${protocol}`,
          rival,
          a.tokens / a.n,
          b.tokens / b.n,
          0.03,
          null,
          false,
        );
        if (tok !== undefined) out.push(tok);
        const rateA = a.accepted / a.n;
        const rateB = b.accepted / b.n;
        out.push({
          id: `${source}|${kernel}|ai-accepted-${protocol}|${rival}`,
          source,
          kernel,
          axis: `ai-accepted-${protocol}`,
          competitor: rival,
          a0: rateA,
          other: rateB,
          gap: rateB - rateA,
          // One trial of difference is a tie.
          noise: 1 / Math.min(a.n, b.n),
          load: null,
        });
      }
    }
  }
  return out;
}

interface SpecCell {
  readonly n: number;
  readonly oneShot: { readonly rate: number };
  readonly accepted: { readonly rate: number };
  readonly tokensPerAcceptedEdit: { readonly unbounded: number } | null;
}

/**
 * The spec-line experiment: a spec-line cell (X, B, C, D, E) is the A0 side, the cell without spec
 * lines (A) in the same view and scope is the competitor. A rate is a tie within one trial; tokens
 * per accepted edit within 3 %.
 */
function specObservations(root: string): Observation[] {
  const doc = readJson(root, 'spec-lines.json');
  const cells = obj(doc?.cells);
  if (cells === undefined) return [];
  const out: Observation[] = [];
  const source = 'spec-lines';
  for (const [key, raw] of Object.entries(cells)) {
    const m = /^(haiku|sonnet|pooled)\/([XBCDE])\.(canon|dense)$/.exec(key);
    const a = obj(raw) as unknown as SpecCell | undefined;
    const base = obj(cells[`${m?.[1]}/A.${m?.[3]}`]) as unknown as SpecCell | undefined;
    if (m === null || a === undefined || base === undefined) continue;
    // only Haiku ran the dense view: its pooled row is the same data
    if (m[1] === 'pooled' && m[3] === 'dense') continue;
    const kernel = key;
    const competitor = `A.${m[3]}`;
    for (const [axis, mine, theirs] of [
      ['spec-accepted-one-shot', a.oneShot.rate, base.oneShot.rate],
      ['spec-accepted-repaired', a.accepted.rate, base.accepted.rate],
    ] as const)
      out.push({
        id: `${source}|${kernel}|${axis}|${competitor}`,
        source,
        kernel,
        axis,
        competitor,
        a0: mine,
        other: theirs,
        gap: theirs - mine,
        noise: 1 / a.n,
        load: null,
      });
    const tok = lower(
      source,
      kernel,
      'spec-tokens-per-accepted',
      competitor,
      a.tokensPerAcceptedEdit?.unbounded ?? 0,
      base.tokensPerAcceptedEdit?.unbounded ?? 0,
      0.03,
      null,
      false,
    );
    if (tok !== undefined) out.push(tok);
  }
  return out;
}

interface AppEditCell {
  readonly n: number;
  readonly accepted?: { readonly k: number };
  readonly acceptedAfterRepair?: { readonly k: number };
  readonly tokensPerAcceptedEdit: { readonly session10: number | null } | null;
}

/**
 * The application-scale edit benchmark (results/app-edit.json, one shot plus one repair) and its tool-loop
 * arm (results/app-edit-loop.json): per model, A0 is the A0 side and TypeScript is the competitor.
 * Accepted edits are a rate (a tie within one task of the 14); tokens per accepted edit at the 10-task
 * horizon within 3 %.
 */
function appEditObservations(root: string): Observation[] {
  const out: Observation[] = [];
  for (const [file, source, a0Key] of [
    ['app-edit.json', 'app-edit', 'a0'],
    ['app-edit-loop.json', 'app-edit-loop', 'a0'],
    ['app-edit-deps.json', 'app-edit-deps', 'a0-deps'],
    ['app-edit-keys.json', 'app-edit-keys', 'a0-keys'],
  ] as const) {
    const cells = obj(readJson(root, file)?.cells);
    if (cells === undefined) continue;
    for (const model of ['haiku', 'sonnet']) {
      const a = obj(cells[`${model}/${a0Key}`]) as unknown as AppEditCell | undefined;
      const t = obj(cells[`${model}/ts`]) as unknown as AppEditCell | undefined;
      if (a === undefined || t === undefined) continue;
      const kernel = `${model}/a0-front-end`;
      const competitor = 'typescript';
      out.push({
        id: `${source}|${kernel}|app-edit-accepted|${competitor}`,
        source,
        kernel,
        axis: 'app-edit-accepted',
        competitor,
        a0: ((a.acceptedAfterRepair ?? a.accepted)?.k ?? 0) / a.n,
        other: ((t.acceptedAfterRepair ?? t.accepted)?.k ?? 0) / t.n,
        gap:
          ((t.acceptedAfterRepair ?? t.accepted)?.k ?? 0) / t.n -
          ((a.acceptedAfterRepair ?? a.accepted)?.k ?? 0) / a.n,
        noise: 1 / a.n,
        load: null,
      });
      const tok = lower(
        source,
        kernel,
        'app-edit-tokens-per-accepted',
        competitor,
        a.tokensPerAcceptedEdit?.session10 ?? 0,
        t.tokensPerAcceptedEdit?.session10 ?? 0,
        0.03,
        null,
        false,
      );
      if (tok !== undefined) out.push(tok);
    }
  }
  return out;
}

/**
 * The edit-check latency reports (results/check-latency-<platform>.json, tools/check-latency.ts): per
 * platform, each A0 subject (one edit, the whole front end in process or in a fresh process, `a0 check`
 * as a node process or as the shipped binary) against each type checker, median wall time in ms. The
 * tie band is the report's own (8 %, or the observed spread, never above 25 %); the load is the report's
 * highest recorded load.
 */
function checkLatencyObservations(root: string): Observation[] {
  const out: Observation[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(join(root, 'results')).filter((f) => /^check-latency-.*\.json$/.test(f));
  } catch {
    return out;
  }
  for (const file of files.sort()) {
    const rep = readJson(root, file);
    const comps = rep?.comparisons;
    if (!Array.isArray(comps)) continue;
    const load = num(obj(rep?.load)?.max) ?? null;
    const source = file.replace(/\.json$/, '');
    for (const c of comps) {
      const r = obj(c);
      if (r === undefined) continue;
      const task = typeof r.task === 'string' ? `/${r.task}` : '';
      const o = lower(
        source,
        `${String(r.subject)}${task}`,
        'check-latency-ms',
        String(r.competitor),
        num(r.a0Ms) ?? 0,
        num(r.otherMs) ?? 0,
        num(r.band) ?? 0.08,
        load,
        true,
      );
      if (o !== undefined) out.push(o);
    }
  }
  return out;
}

interface PrimerCell {
  readonly n: number;
  readonly oneShot: { readonly rate: number };
  readonly accepted: { readonly rate: number };
  readonly tokensPerAcceptedEdit: { readonly task1: number | null } | null;
}

/**
 * The primer ablation: a shortened primer variant is the A0 side, the current primer of the same form
 * (`dense.D0` or `canon.K0`) in the same scope and model is the competitor. A rate is a tie within one
 * trial; tokens per accepted edit (one cold task) within 3 %.
 */
function primerObservations(root: string): Observation[] {
  return [
    ...primerLike(root, 'primer-ablation.json', 'primer-ablation', {
      dense: 'dense.D0',
      canon: 'canon.K0',
    }),
    // The shipped-text experiment: variant G1 (guide), T2 (tool list), B1 (both) against G0, T0, B0.
    ...primerLike(root, 'shipped.json', 'shipped-text', { G: 'G0', T: 'T0', B: 'B0' }),
  ];
}

function primerLike(
  root: string,
  file: string,
  source: string,
  control: Record<string, string>,
): Observation[] {
  const doc = readJson(root, file);
  const cells = obj(doc?.cells);
  if (cells === undefined) return [];
  const out: Observation[] = [];
  for (const [scope, raw] of Object.entries(cells)) {
    const table = obj(raw);
    if (table === undefined) continue;
    for (const [variant, cellRaw] of Object.entries(table)) {
      const form = source === 'shipped-text' ? (variant[0] ?? '') : (variant.split('.')[0] ?? '');
      const baseName = control[form];
      if (baseName === undefined || variant === baseName) continue;
      const a = obj(cellRaw) as unknown as PrimerCell | undefined;
      const base = obj(table[baseName]) as unknown as PrimerCell | undefined;
      if (a === undefined || base === undefined) continue;
      const kernel = `${scope}/${variant}`;
      for (const [axis, mine, theirs] of [
        ['primer-accepted-one-shot', a.oneShot.rate, base.oneShot.rate],
        ['primer-accepted-repaired', a.accepted.rate, base.accepted.rate],
      ] as const)
        out.push({
          id: `${source}|${kernel}|${axis}|${baseName}`,
          source,
          kernel,
          axis,
          competitor: baseName,
          a0: mine,
          other: theirs,
          gap: theirs - mine,
          noise: 1 / a.n,
          load: null,
        });
      const tok = lower(
        source,
        kernel,
        'primer-tokens-per-accepted',
        baseName,
        a.tokensPerAcceptedEdit?.task1 ?? 0,
        base.tokensPerAcceptedEdit?.task1 ?? 0,
        0.03,
        null,
        false,
      );
      if (tok !== undefined) out.push(tok);
    }
  }
  return out;
}

/** Every observation the results files give, losses and ties and wins alike. */
export function observations(root = '.'): Observation[] {
  return [
    ...execObservations(root),
    ...wasmObservations(root),
    ...langAxesObservations(root),
    ...aiObservations(root),
    ...specObservations(root),
    ...primerObservations(root),
    ...appEditObservations(root),
    ...checkLatencyObservations(root),
  ];
}

/** Is the competitor ahead by more than the tie band (ignoring floating-point dust)? */
export const isLoss = (o: Observation): boolean => o.gap > o.noise + 1e-9;

/** The losses among the observations: a competitor ahead by more than the tie band. */
export function losses(root = '.'): LedgerEntry[] {
  return observations(root).filter(isLoss);
}

// --- check and update ------------------------------------------------------------------------------

export interface CheckResult {
  /** A loss with no ledger entry. */
  readonly added: LedgerEntry[];
  /** A recorded loss that is now worse than its gap plus noise. */
  readonly worsened: { was: LedgerEntry; now: LedgerEntry }[];
  /** Recorded losses no longer a loss (the ledger may shrink). */
  readonly improved: { was: LedgerEntry; now: Observation | undefined }[];
  /** Added or worsened entries whose timing is unverified: reported, not trusted either way. */
  readonly unverifiedChanges: string[];
  /** Ledger entries still in force whose evidence is unverified. */
  readonly unverifiedHeld: number;
  readonly ok: boolean;
}

/** Compare the current losses with a ledger. Pure: both sides are passed in. */
export function compare(
  ledger: readonly LedgerEntry[],
  current: readonly Observation[],
): CheckResult {
  const byId = new Map(current.map((o) => [o.id, o] as const));
  const recorded = new Map(ledger.map((e) => [e.id, e] as const));
  const added: LedgerEntry[] = [];
  const worsened: { was: LedgerEntry; now: LedgerEntry }[] = [];
  const improved: { was: LedgerEntry; now: Observation | undefined }[] = [];
  const unverifiedChanges: string[] = [];
  for (const now of current) {
    if (!isLoss(now)) continue;
    const was = recorded.get(now.id);
    if (was === undefined) {
      if (now.unverified !== undefined)
        unverifiedChanges.push(`new loss ${now.id}: ${now.unverified}`);
      else added.push(now);
    } else if (now.gap > was.gap + Math.max(was.noise, now.noise) + EPS) {
      if (now.unverified !== undefined || was.unverified !== undefined)
        unverifiedChanges.push(
          `worse ${now.id}: gap ${was.gap.toFixed(3)} -> ${now.gap.toFixed(3)} (${now.unverified ?? was.unverified})`,
        );
      else worsened.push({ was, now });
    }
  }
  for (const was of ledger) {
    const now = byId.get(was.id);
    if (now === undefined || !isLoss(now)) improved.push({ was, now });
  }
  return {
    added,
    worsened,
    improved,
    unverifiedChanges,
    unverifiedHeld: ledger.filter((e) => e.unverified !== undefined).length,
    ok: added.length === 0 && worsened.length === 0,
  };
}

export function readLedger(root = '.'): Ledger {
  const doc = JSON.parse(readFileSync(join(root, LEDGER_PATH), 'utf8')) as Ledger;
  if (doc.version !== 1) throw new Error(`${LEDGER_PATH}: unsupported version`);
  return doc;
}

/** The ledger a deliberate update would write, and what it changes against `previous`. */
export function nextLedger(
  previous: Ledger | undefined,
  current: readonly Observation[],
  reason: string | undefined,
  now = new Date(),
): { ledger: Ledger; added: number; worsened: number; removed: number } {
  const entries = current.filter(isLoss);
  const result = compare(previous?.entries ?? [], current);
  const added =
    result.added.length + result.unverifiedChanges.filter((c) => c.startsWith('new')).length;
  const worsened =
    result.worsened.length + result.unverifiedChanges.filter((c) => c.startsWith('worse')).length;
  const removed = result.improved.length;
  if ((added > 0 || worsened > 0) && (reason === undefined || reason.trim().length < 20))
    throw new Error(
      `the ledger would grow (${added} new, ${worsened} worse); pass --reason with a real reason (at least 20 characters)`,
    );
  const history: LedgerHistory[] = [
    ...(previous?.history ?? []),
    ...(previous === undefined || added + worsened + removed > 0
      ? [
          {
            at: now.toISOString(),
            reason: reason?.trim() ?? (previous === undefined ? 'initial ledger' : 'shrink only'),
            added,
            worsened,
            removed,
          },
        ]
      : []),
  ];
  return {
    ledger: { version: 1, meaning: MEANING, loadLimit: LOAD_LIMIT, history, entries },
    added,
    worsened,
    removed,
  };
}

export function renderLedger(ledger: Ledger): string {
  const round = (k: string, v: unknown): unknown =>
    typeof v === 'number' && k !== 'loadLimit' ? Number(v.toPrecision(6)) : v;
  return `${JSON.stringify(ledger, round, 2)}\n`;
}

export function summary(ledger: Ledger): string {
  const by = new Map<string, number>();
  for (const e of ledger.entries) by.set(e.axis, (by.get(e.axis) ?? 0) + 1);
  const unverified = ledger.entries.filter((e) => e.unverified !== undefined).length;
  return `${ledger.entries.length} recorded losses (${unverified} unverified): ${[...by].map(([a, n]) => `${a} ${n}`).join(', ')}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const reasonArg = args.indexOf('--reason');
  const reason = reasonArg >= 0 ? args[reasonArg + 1] : undefined;
  const current = observations();
  if (current.length === 0) throw new Error('no results found: run from the repository root');
  let previous: Ledger | undefined;
  try {
    previous = readLedger();
  } catch {
    previous = undefined;
  }
  if (args.includes('--update')) {
    const { ledger, added, worsened, removed } = nextLedger(previous, current, reason);
    writeFileSync(LEDGER_PATH, scrubText(renderLedger(ledger)), 'utf8');
    process.stdout.write(
      `wrote ${LEDGER_PATH}: ${summary(ledger)}; ${added} added, ${worsened} worsened, ${removed} removed\n`,
    );
    return;
  }
  if (previous === undefined) {
    process.stderr.write(
      `${LEDGER_PATH} is missing: run with --update --reason "initial ledger"\n`,
    );
    process.exit(1);
  }
  const r = compare(previous.entries, current);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    process.stdout.write(`${summary(previous)}\n`);
    for (const e of r.added)
      process.stdout.write(
        `NEW LOSS ${e.id}: A0 ${e.a0} vs ${e.other} (gap ${(e.gap * 100).toFixed(1)}%, tie band ${(e.noise * 100).toFixed(1)}%)\n`,
      );
    for (const { was, now } of r.worsened)
      process.stdout.write(
        `WORSE ${now.id}: gap ${(was.gap * 100).toFixed(1)}% -> ${(now.gap * 100).toFixed(1)}% (noise ${(Math.max(was.noise, now.noise) * 100).toFixed(1)}%)\n`,
      );
    for (const c of r.unverifiedChanges) process.stdout.write(`UNVERIFIED ${c}\n`);
    if (r.improved.length > 0)
      process.stdout.write(
        `${r.improved.length} recorded losses are gone or tied; shrink the ledger with --update (no reason needed)\n`,
      );
  }
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
