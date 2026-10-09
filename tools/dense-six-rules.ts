/**
 * The six compact dense spellings (docs/history/2026-10-09-dense-six-rules-preregistration.md),
 * measured on two separate sets so a rule cannot be fitted to the benchmark kernels:
 *   (a) the 10 kernels tools/lang-axes.ts counts;
 *   (b) held-out: every in-tree `.a0` program the dense round-trip test reads, plus the generated corpus.
 * For each set: o200k_base tokens of the dense text (after normalizeProgram) with no compact rule,
 * with each rule alone, and with every kept rule; and canonical -> dense -> canonical with every
 * rule on, for every program (lossless and a fixed point). A rule is kept by the pre-registered
 * rule: it saves tokens on (b) alone, or is neutral on (b) and argued general in the note.
 *
 * Usage: bun tools/dense-six-rules.ts [--out=results/dense-six-rules.json]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatProgram, type Program, parse } from '../src/core.js';
import {
  type Arities,
  type DenseStyle,
  formatDense,
  normalizeProgram,
  parseDense,
} from '../src/dense.js';
import { parseFile } from '../src/link.js';
import { generateCorpus } from './corpus.js';
import { TOKEN_KERNELS, tokens } from './dense-tokens.js';
import { a0TokenText, KERNELS } from './exec-bench-kernels.js';
import { reportJson } from './scrub-results.js';

interface Unit {
  readonly name: string;
  readonly program: Program;
  readonly known: Arities;
}

export const RULES: readonly {
  readonly n: number;
  readonly name: string;
  readonly style: DenseStyle;
  /** Neutral on (b) is enough when the pre-registration argues the rule general. */
  readonly generalIfNeutral: boolean;
}[] = [
  { n: 1, name: 'tab', style: { tab: true }, generalIfNeutral: true },
  { n: 2, name: 'min/max', style: { minmax: true }, generalIfNeutral: false },
  { n: 3, name: 'hex', style: { hex: true }, generalIfNeutral: false },
  { n: 4, name: "no 'call'", style: {}, generalIfNeutral: false },
  { n: 5, name: 'trailing parameters', style: { trailingParams: true }, generalIfNeutral: true },
  { n: 6, name: 'one line per function', style: { oneLine: true }, generalIfNeutral: false },
];

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'dist' || f === 'results' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (p.endsWith(join('corpus', 'reject'))) continue;
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.a0')) out.push(p);
  }
  return out;
}

const text = (u: Unit, style: DenseStyle): string =>
  formatDense(normalizeProgram(u.program), { known: u.known, style }).trimEnd();

const total = (units: readonly Unit[], style: DenseStyle): number =>
  units.reduce((n, u) => n + tokens(text(u, style)), 0);

/** Lossless and a fixed point with `style` on, for the program as written and normalized. */
function roundTrips(u: Unit, style: DenseStyle): string | undefined {
  for (const p of [u.program, normalizeProgram(u.program)]) {
    const dense = formatDense(p, { known: u.known, style });
    let back: Program;
    try {
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

export async function loadSets(root = '.'): Promise<{ kernels: Unit[]; heldOut: Unit[] }> {
  const kernels: Unit[] = KERNELS.filter((k) => TOKEN_KERNELS.includes(k.name)).map((k) => ({
    name: k.name,
    program: parse(a0TokenText(k)),
    known: new Map(),
  }));
  const heldOut: Unit[] = [];
  for (const path of files(root).sort()) {
    const { program, known } = await parseFile(path, async (p) => readFileSync(p, 'utf8'));
    heldOut.push({ name: relative(root, path).split(sep).join('/'), program, known });
  }
  heldOut.push({
    name: 'generated corpus',
    program: { functions: generateCorpus().functions },
    known: new Map(),
  });
  return { kernels, heldOut };
}

async function main(): Promise<void> {
  const out =
    process.argv.find((a) => a.startsWith('--out='))?.slice(6) ??
    join('results', 'dense-six-rules.json');
  const { kernels, heldOut } = await loadSets();
  const base = { a: total(kernels, {}), b: total(heldOut, {}) };
  const callWords = (units: readonly Unit[]): number =>
    units.reduce((n, u) => n + (text(u, {}).match(/(^|[ ;{(\[])call /gm)?.length ?? 0), 0);
  const all: DenseStyle = Object.assign({}, ...RULES.map((r) => r.style));
  const failures = [...kernels, ...heldOut]
    .map((u) => roundTrips(u, all))
    .filter((f): f is string => f !== undefined);
  const rules = RULES.map((r) => {
    const a = base.a - total(kernels, r.style);
    const b = base.b - total(heldOut, r.style);
    const kept = failures.length === 0 && r.n !== 4 && (b > 0 || (b === 0 && r.generalIfNeutral));
    return {
      rule: r.n,
      name: r.name,
      kernelsSaved: a,
      heldOutSaved: b,
      kept,
      why:
        r.n === 4
          ? `already the printer's spelling: 'call' remains only before a callee named like an operation or structure word (${callWords(kernels)} in (a), ${callWords(heldOut)} in (b))`
          : b > 0
            ? 'saves tokens on the held-out set'
            : b === 0
              ? r.generalIfNeutral
                ? 'neutral on the held-out set, argued general in the pre-registration'
                : 'neutral on the held-out set and not argued general'
              : 'costs tokens on the held-out set',
    };
  });
  const keptStyle: DenseStyle = Object.assign(
    {},
    ...RULES.filter((r) => rules.find((x) => x.rule === r.n)?.kept).map((r) => r.style),
  );
  const perKernel = Object.fromEntries(
    kernels.map((u) => [
      u.name,
      { before: tokens(text(u, {})), after: tokens(text(u, keptStyle)) },
    ]),
  );
  const kernelSum = total(kernels, keptStyle);
  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/dense-six-rules.ts',
    tokenizer: 'o200k_base (js-tiktoken)',
    preregistration: 'docs/history/2026-10-09-dense-six-rules-preregistration.md',
    meaning:
      'Dense text after normalizeProgram, trimmed. (a) the 10 lang-axes kernels; (b) held-out: every in-tree .a0 program outside corpus/reject plus the generated corpus. Saved = tokens without the rule minus tokens with that rule alone. kept follows the pre-registered rule.',
    heldOutPrograms: heldOut.length,
    roundTripFailures: failures,
    before: { kernels: base.a, heldOut: base.b },
    rules,
    kept: { style: keptStyle, kernels: kernelSum, heldOut: total(heldOut, keptStyle) },
    perKernel,
    lines: {
      bestSingleLanguage: 323,
      perKernelBests: 300,
      twoX: 161,
      kernelsOverBestSingleLanguage: Number((kernelSum / 323).toFixed(3)),
      kernelsOverPerKernelBests: Number((kernelSum / 300).toFixed(3)),
    },
  };
  writeFileSync(out, reportJson(report), 'utf8');
  process.stderr.write(`wrote ${out}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
