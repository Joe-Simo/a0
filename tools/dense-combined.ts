/**
 * The combined compact dense rules (docs/history/2026-10-09-dense-combined-rules-preregistration.md):
 * on the 10 kernels and the 54 held-out programs of tools/dense-six-rules.ts, from the start style
 * (the kept six rules with `tab` off), each rule alone, each rule left out of the combination, and
 * the combination; the headline is the kernel sum of the combination without `tab` and without a
 * rotate shorthand, which are side columns only. Every kept rule must save on the held-out set
 * alone, and every program must read back to the identical canonical text with all of them on.
 *
 * Usage: bun tools/dense-combined.ts [--out=results/dense-combined.json]
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatProgram, type Program } from '../src/core.js';
import {
  type Arities,
  type DenseStyle,
  formatDense,
  normalizeProgram,
  parseDense,
} from '../src/dense.js';
import { loadSets } from './dense-six-rules.js';
import { tokens } from './dense-tokens.js';
import { reportJson } from './scrub-results.js';

interface Unit {
  readonly name: string;
  readonly program: Program;
  readonly known: Arities;
}

/** The kept six-rule style with `tab` off (results/dense-six-rules.json). */
export const START: DenseStyle = { minmax: true, hex: true, trailingParams: true, oneLine: true };

export const RULES: readonly {
  readonly n: number;
  readonly name: string;
  readonly style: DenseStyle;
}[] = [
  { n: 1, name: 'array fill of a named value', style: { fill: true } },
  { n: 2, name: 'bit/nbit select words', style: { bit: true } },
  { n: 3, name: 'record access X.K', style: { dot: true } },
  { n: 4, name: 'result type from the body', style: { inferResult: true } },
  { n: 5, name: 'negative literal wrap', style: { negative: true } },
  { n: 6, name: 'foldN count fusion', style: { foldN: true } },
  { n: 8, name: 'operator symbols, glued', style: { ops: true } },
  { n: 9, name: 'parameter-digit glue B0', style: { paramDigit: true } },
  { n: 10, name: 'comma before a digit -,5', style: { commaDigit: true } },
];

/** Rules 9 and 10 (docs/history/2026-10-09-param-digit-glue-preregistration.md), over rules 1-8. */
const DIGIT_RULES = [9, 10];

/** Rule 7 (default names with `i` first) was dropped in the pre-registration, before implementation. */
const DROPPED_BEFORE = [
  {
    rule: 7,
    name: 'default names with i first',
    why: 'the letter was chosen by searching all 26 against the held-out total: a constant fitted to the data the gate measures',
  },
];

const text = (u: Unit, style: DenseStyle): string =>
  formatDense(normalizeProgram(u.program), { known: u.known, style }).trimEnd();

const total = (units: readonly Unit[], style: DenseStyle, f: (s: string) => string = (s) => s) =>
  units.reduce((n, u) => n + tokens(f(text(u, style))), 0);

/** Lossless and a fixed point with `style` on, for the program as written and normalized. */
function roundTrips(u: Unit, style: DenseStyle): string | undefined {
  for (const p of [u.program, normalizeProgram(u.program)]) {
    let dense: string;
    let back: Program;
    try {
      dense = formatDense(p, { known: u.known, style });
      back = parseDense(dense, { known: u.known, compact: true });
    } catch (e) {
      return `${u.name}: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (formatProgram(back) !== formatProgram(p)) return `${u.name}: canonical form differs`;
    if (formatDense(back, { known: u.known, style }) !== dense)
      return `${u.name}: not a fixed point`;
  }
  return undefined;
}

const failuresOf = (units: readonly Unit[], style: DenseStyle): string[] =>
  units.map((u) => roundTrips(u, style)).filter((f): f is string => f !== undefined);

/**
 * The rotate side column: `or (shl X K) (shr X (sub 32 K))` written `<<< X K`, applied to the
 * printed text (an estimate: the reader does not read `<<<`, nothing is round-tripped).
 */
const ROTATE = [
  /\bor << (\S+) (\S+) >> \1 sub 32 \2\b/g,
  /\|<<(\S+) (\S+)>>\1-32 \2\b/g,
  /\|<<(\S+) (\S+)>>\1- 32 \2\b/g,
];
const rotate = (s: string): string =>
  ROTATE.reduce((t, re) => t.replace(re, (_, x: string, k: string) => `<<< ${x} ${k}`), s);

async function main(): Promise<void> {
  const out =
    process.argv.find((a) => a.startsWith('--out='))?.slice(6) ??
    join('results', 'dense-combined.json');
  const { kernels, heldOut } = await loadSets();
  const all = [...kernels, ...heldOut];
  const start = { kernels: total(kernels, START), heldOut: total(heldOut, START) };
  const alone = RULES.map((r) => {
    const style = { ...START, ...r.style };
    const failures = failuresOf(all, style);
    const heldOutSaved = start.heldOut - total(heldOut, style);
    return {
      rule: r.n,
      name: r.name,
      kernelsSaved: start.kernels - total(kernels, style),
      heldOutSaved,
      roundTripFailures: failures.slice(0, 10),
      kept: heldOutSaved > 0 && failures.length === 0,
      why:
        failures.length > 0
          ? 'not lossless alone'
          : heldOutSaved > 0
            ? 'saves tokens on the held-out set and round-trips'
            : 'does not save tokens on the held-out set',
    };
  });
  const kept = RULES.filter((r) => alone.find((a) => a.rule === r.n)?.kept);
  const combined: DenseStyle = Object.assign({}, START, ...kept.map((r) => r.style));
  const leaveOneOut = kept.map((r) => {
    const without: DenseStyle = Object.assign(
      {},
      START,
      ...kept.filter((x) => x !== r).map((x) => x.style),
    );
    return {
      rule: r.n,
      kernelsSaved: total(kernels, without) - total(kernels, combined),
      heldOutSaved: total(heldOut, without) - total(heldOut, combined),
    };
  });
  const before: DenseStyle = Object.assign(
    {},
    START,
    ...kept.filter((r) => !DIGIT_RULES.includes(r.n)).map((r) => r.style),
  );
  const over = (style: DenseStyle) => ({
    kernels: total(kernels, style),
    heldOut: total(heldOut, style),
    roundTripFailures: failuresOf(all, style).length,
  });
  const digitRules = {
    preregistration: 'docs/history/2026-10-09-param-digit-glue-preregistration.md',
    rules1to8: over(before),
    plus9: over({ ...before, paramDigit: true }),
    plus10: over({ ...before, commaDigit: true }),
    plus9and10: over({ ...before, paramDigit: true, commaDigit: true }),
  };
  const failures = failuresOf(all, combined);
  const headline = total(kernels, combined);
  const withTab = total(kernels, { ...combined, tab: true });
  const rotateHits = kernels.filter((u) => rotate(text(u, combined)) !== text(u, combined)).length;
  const heldRotateHits = heldOut.filter(
    (u) => rotate(text(u, combined)) !== text(u, combined),
  ).length;
  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/dense-combined.ts',
    tokenizer: 'o200k_base (js-tiktoken)',
    preregistration: 'docs/history/2026-10-09-dense-combined-rules-preregistration.md',
    meaning:
      'Dense text after normalizeProgram, trimmed. kernels: the 10 lang-axes kernels; heldOut: every in-tree .a0 program outside corpus/reject plus the generated corpus. start: the kept six-rule style with tab off. alone: saving of the rule on top of start. leaveOneOut: what the combination loses without the rule. headline: kernel sum of the combination, tab off, no rotate shorthand.',
    heldOutPrograms: heldOut.length,
    start: { style: START, ...start },
    droppedBeforeImplementation: DROPPED_BEFORE,
    digitRules,
    alone,
    combined: {
      style: combined,
      headlineKernelSum: headline,
      heldOut: total(heldOut, combined),
      roundTripFailures: failures,
      leaveOneOut,
    },
    sideColumns: {
      withTab: { kernels: withTab, heldOut: total(heldOut, { ...combined, tab: true }) },
      withRotate: {
        kernels: total(kernels, combined, rotate),
        kernelsMatched: rotateHits,
        heldOutMatched: heldRotateHits,
        note: 'estimate: a text rewrite, not read back by the reader',
      },
      withTabAndRotate: { kernels: total(kernels, { ...combined, tab: true }, rotate) },
    },
    perKernel: Object.fromEntries(
      kernels.map((u) => [
        u.name,
        {
          start: tokens(text(u, START)),
          combined: tokens(text(u, combined)),
          text: text(u, combined),
        },
      ]),
    ),
    lines: {
      bestSingleLanguage: 323,
      twoX: 161,
      headlineOverBestSingleLanguage: Number((headline / 323).toFixed(3)),
      reachesTwoX: headline <= 161,
    },
  };
  writeFileSync(out, reportJson(report), 'utf8');
  process.stderr.write(
    `wrote ${out}: headline ${headline} (tab ${withTab}), held-out ${report.combined.heldOut}, failures ${failures.length}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
