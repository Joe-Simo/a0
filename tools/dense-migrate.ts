/**
 * Dense migration and its token measure (pre-registered in
 * docs/history/2026-10-09-dense-migration-tokens-preregistration.md).
 *
 *   node dist/tools/dense-migrate.js [--write] [--out=results/dense-migration-tokens.json]
 *
 * Writes the dense form of every in-tree program the reference accepts to `dense/<path>` (and the ten
 * token kernels to `dense/kernels/<name>.a0`), reads each migrated file back through the A0 reader
 * (compiler/dense.a0 `canonfn`, chunked by tools/dense-chunk.ts), and counts o200k tokens of the migrated
 * kernel files against every other language of results/lang-axes.json with the ledger's rule. The canonical
 * files are not changed; the loss ledger is not updated.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { formatProgram, type Program, parse } from '../src/core.js';
import { formatDense, parseDense } from '../src/dense.js';
import { readOnce } from '../src/dense-a0.js';
import {
  arities,
  type DenseReader,
  planned,
  readChunked,
  refusedUpFront,
  usedSignatures,
} from './dense-chunk.js';
import { isReject, listSources, ROOT } from './dense-loader.js';
import { TOKEN_KERNELS } from './dense-tokens.js';
import { KERNELS } from './exec-bench-kernels.js';
import { reportJson } from './scrub-results.js';

const enc = getEncoding('o200k_base');
const tok = (s: string): number => enc.encode(s).length;

interface Row {
  readonly path: string;
  readonly outcome: 'migrated' | 'not-migrated';
  readonly reason?: string;
  readonly canonicalBytes?: number;
  readonly denseBytes?: number;
  readonly chunks?: number;
}

/** Writes the dense file, then checks it from the file: fixed point and the A0 reader's read-back. */
function migrate(
  read: DenseReader,
  rel: string,
  program: Program,
  sigs: Parameters<typeof planned>[1],
  write: boolean,
): Row {
  const known = arities(sigs);
  const dense = `${formatDense(program, { known })}\n`;
  const target = join(ROOT, 'dense', rel);
  if (write) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, dense, 'utf8');
  }
  const row = check(read, rel, program, sigs, known, write ? readFileSync(target, 'utf8') : dense);
  // only a file that reads back stays migrated
  if (write && row.outcome !== 'migrated') rmSync(target);
  return row;
}

function check(
  read: DenseReader,
  rel: string,
  program: Program,
  sigs: Parameters<typeof planned>[1],
  known: ReturnType<typeof arities>,
  fileText: string,
): Row {
  const want = formatProgram(program);
  const base = {
    path: rel,
    canonicalBytes: Buffer.byteLength(want),
    denseBytes: Buffer.byteLength(fileText),
  };
  let back: Program;
  try {
    back = parseDense(fileText, { known });
  } catch (e) {
    return { ...base, outcome: 'not-migrated', reason: `dense file does not parse: ${String(e)}` };
  }
  if (`${formatDense(back, { known })}\n` !== fileText)
    return { ...base, outcome: 'not-migrated', reason: 'dense file is not a fixed point' };
  if (formatProgram(back) !== want)
    return { ...base, outcome: 'not-migrated', reason: 'dense file is a different program' };
  const p = planned(back, sigs);
  const up = refusedUpFront(p);
  if (up.size > 0)
    return {
      ...base,
      outcome: 'not-migrated',
      reason: `A0 reader: refused up front (${[...up].map(([f, w]) => `${f}: ${w}`).join('; ')})`,
    };
  const got = readChunked(read, p);
  if (got.err)
    return {
      ...base,
      outcome: 'not-migrated',
      reason: `A0 reader: flagged ${got.refused.join(', ')} (form outside the reader)`,
    };
  if (got.text !== want)
    return { ...base, outcome: 'not-migrated', reason: 'A0 reader: different canonical text' };
  return { ...base, outcome: 'migrated', chunks: got.chunks };
}

function main(): void {
  const write = process.argv.includes('--write');
  const readerSourceSha256 = createHash('sha256')
    .update(readFileSync(join(ROOT, 'compiler', 'dense.a0')))
    .digest('hex');
  const out =
    process.argv.find((a) => a.startsWith('--out='))?.slice(6) ??
    join(ROOT, 'results', 'dense-migration-tokens.json');
  const read = readOnce;

  // 1. in-tree programs
  const files: Row[] = [];
  for (const abs of listSources(ROOT)) {
    if (isReject(abs, ROOT)) continue;
    const rel = relative(ROOT, abs).split(sep).join('/');
    let program: Program;
    let sigs: ReturnType<typeof usedSignatures>;
    try {
      program = parse(readFileSync(abs, 'utf8'));
      sigs = usedSignatures(abs);
    } catch (e) {
      files.push({
        path: rel,
        outcome: 'not-migrated',
        reason: `reference does not accept: ${String(e)}`,
      });
      continue;
    }
    files.push(migrate(read, rel, program, sigs, write));
  }

  // 2. the ten token kernels, migrated and read back the same way, then counted from the files
  const lang = JSON.parse(readFileSync(join(ROOT, 'results', 'lang-axes.json'), 'utf8')) as {
    tokens: Record<string, { kernels?: Record<string, { kernel?: number; program?: number }> }>;
  };
  const kernels = KERNELS.filter((k) => TOKEN_KERNELS.includes(k.name));
  const kernelRows: Record<string, unknown>[] = [];
  const counts = new Map<string, { kernel: number; program: number; canonical: number }>();
  for (const k of kernels) {
    const rel = `kernels/${k.name}.a0`;
    const row = migrate(read, rel, parse(k.a0), new Map(), write);
    const text = write
      ? readFileSync(join(ROOT, 'dense', rel), 'utf8')
      : `${formatDense(parse(k.a0))}\n`;
    const body = text.replace(/\n+$/, '');
    const c = { kernel: tok(body), program: tok(`${body}\n`), canonical: tok(k.a0) };
    counts.set(k.name, c);
    let best = Number.POSITIVE_INFINITY;
    let bestLanguage = '';
    for (const [l, v] of Object.entries(lang.tokens)) {
      if (l === 'a0') continue;
      const n = v.kernels?.[k.name]?.kernel;
      if (n !== undefined && n > 0 && n < best) {
        best = n;
        bestLanguage = l;
      }
    }
    kernelRows.push({
      name: k.name,
      readBack: row.outcome,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      canonicalTokens: c.canonical,
      denseTokens: c.kernel,
      denseProgramTokens: c.program,
      bestOther: best,
      bestLanguage,
      denseOverBest: Number((c.kernel / best).toFixed(3)),
      atLeastTwiceFewer: c.kernel * 2 <= best,
    });
  }

  // 3. the ledger rule on both token axes, and the flips of the recorded tokens-kernel losses
  const ledger = JSON.parse(readFileSync(join(ROOT, 'results', 'loss-ledger.json'), 'utf8')) as {
    entries: { id: string; source: string; axis: string; subject?: string }[];
  };
  const recorded = new Set(
    ledger.entries
      .filter((e) => e.source === 'lang-axes' && e.subject === undefined)
      .map((e) => e.id),
  );
  const axes: Record<string, unknown> = {};
  for (const [field, axis] of [
    ['kernel', 'tokens-kernel'],
    ['program', 'tokens-program'],
  ] as const) {
    let win = 0;
    let tie = 0;
    let loss = 0;
    let recordedLosses = 0;
    const flip = { win: 0, tie: 0, loss: 0 };
    const stillLost: string[] = [];
    for (const [l, v] of Object.entries(lang.tokens)) {
      if (l === 'a0') continue;
      for (const name of TOKEN_KERNELS) {
        const other = v.kernels?.[name]?.[field];
        const mine = counts.get(name)?.[field];
        if (other === undefined || !(other > 0) || mine === undefined) continue;
        const gap = mine / other - 1;
        const cls = gap > 1e-9 ? 'loss' : gap < -1e-9 ? 'win' : 'tie';
        if (cls === 'win') win += 1;
        else if (cls === 'tie') tie += 1;
        else loss += 1;
        const id = `lang-axes|${name}|${axis}|${l}`;
        if (recorded.has(id)) {
          recordedLosses += 1;
          flip[cls] += 1;
          if (cls === 'loss') stillLost.push(`${name}|${l}`);
        }
      }
    }
    axes[axis] = {
      comparisons: win + tie + loss,
      win,
      tie,
      loss,
      recordedLosses,
      recordedLossesWould: flip,
      stillLost,
    };
  }

  // sums against the best single language (all ten kernels) and the per-kernel bests
  const sumDense = [...counts.values()].reduce((a, c) => a + c.kernel, 0);
  const sumCanonical = [...counts.values()].reduce((a, c) => a + c.canonical, 0);
  const sums: [string, number][] = [];
  for (const [l, v] of Object.entries(lang.tokens)) {
    if (l === 'a0') continue;
    const ns = TOKEN_KERNELS.map((n) => v.kernels?.[n]?.kernel);
    if (ns.every((n) => n !== undefined && n > 0))
      sums.push([l, ns.reduce<number>((a, n) => a + (n ?? 0), 0)]);
  }
  sums.sort((a, b) => a[1] - b[1]);
  const perKernelBests = kernelRows.reduce((a, r) => a + (r.bestOther as number), 0);
  const [bestLang, bestSum] = sums[0] as [string, number];

  const tally: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const r of files) {
    tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
    if (r.reason !== undefined) {
      const key = r.reason
        .replace(/\d+/g, 'N')
        .replace(/\(.*\)/, '(...)')
        .slice(0, 120);
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  }
  const report = {
    tool: 'tools/dense-migrate.ts',
    readerSourceSha256,
    sourceMode: write ? 'files-on-disk' : 'in-memory-formatDense',
    preregistration: 'docs/history/2026-10-09-dense-migration-tokens-preregistration.md',
    meaning:
      'Dense source (formatDense with the known arities of the used files; kernels without normalizeProgram), generated in memory unless sourceMode is files-on-disk under dense/. Each source is checked: parseDense formats back to the source text, and the A0 reader (compiler/dense.a0 canonfn via readChunked at READER_CAPS) reads it to formatProgram of the original. Tokens: o200k_base (js-tiktoken), kernel = text without trailing newlines, program = text plus one newline (tools/lang-axes.ts rules). Competitors: results/lang-axes.json unchanged. Rule: tools/loss-ledger.ts (noise 0; loss gap > 0, tie gap = 0, win gap < 0). The loss ledger is not updated.',
    tokenizer: 'o200k_base',
    files: { total: files.length, ...tally, reasons, rows: files },
    kernels: kernelRows,
    sums: {
      denseKernelTokens: sumDense,
      canonicalKernelTokens: sumCanonical,
      bestSingleLanguage: bestLang,
      bestSingleLanguageSum: bestSum,
      denseOverBestSingleLanguage: Number((sumDense / bestSum).toFixed(3)),
      sumOfPerKernelBests: perKernelBests,
      denseOverPerKernelBests: Number((sumDense / perKernelBests).toFixed(3)),
      atLeastTwiceFewerThanBestSingleLanguage: sumDense * 2 <= bestSum,
      atLeastTwiceFewerThanPerKernelBests: sumDense * 2 <= perKernelBests,
      kernelsAtLeastTwiceFewer: kernelRows.filter((r) => r.atLeastTwiceFewer).length,
    },
    axes,
  };
  writeFileSync(out, reportJson(report), 'utf8');
  process.stdout.write(
    `${JSON.stringify({ files: report.files.total, tally, reasons, sums: report.sums, axes: Object.fromEntries(Object.entries(axes).map(([k, v]) => [k, { ...(v as object), stillLost: undefined }])) }, null, 1)}\n`,
  );
  for (const r of kernelRows)
    process.stdout.write(
      `${r.name} canon=${r.canonicalTokens} dense=${r.denseTokens} best=${r.bestOther}(${r.bestLanguage}) ratio=${r.denseOverBest} 2x=${r.atLeastTwiceFewer} ${r.readBack}\n`,
    );
}

main();
