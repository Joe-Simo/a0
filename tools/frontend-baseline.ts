/**
 * Compare two built checkouts on identical source snapshots. No model calls, synthetic AI scores,
 * or renamed "unified" cell: a syntax earns that name only after its migration gates pass.
 * bun run build && node dist/tools/frontend-baseline.js --baseline=/path/to/built/checkout
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import { formatProgram, parse } from '../src/core.js';
import { formatSource as printCandidate } from '../src/source.js';
import { planned, READER_CAPS, refusedUpFront, usedSignatures } from './dense-chunk.js';
import { denseForms, isReject, listSources } from './dense-loader.js';
import { committedTree } from './measurement-checkout.js';
import { reportJson, writeReport } from './scrub-results.js';
import { loadSource } from './system-load.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const read = (path: string): Promise<string> => readFile(path, 'utf8');
async function main(): Promise<void> {
  const includeCandidate = args.includes('--include-candidate-source');
  const baseline = option('baseline');
  if (baseline === undefined) throw new Error('--baseline=<built checkout> is required');
  const baselineIdentity = committedTree(resolve(baseline));
  const candidateIdentity = committedTree(root);
  const encodings = ['o200k_base', 'cl100k_base'] as const;
  const tokenizers = encodings.map((name) => [name, getEncoding(name)] as const);
  const rows: Record<string, unknown>[] = [];
  const implementations = new Map<string, string>();
  for (const name of ['examples/life.a0', 'compiler/boot.a0', 'site/page.a0']) {
    const entry = await realpath(join(root, name));
    const failures = new Map<string, string>();
    const forms = await denseForms([entry], read, failures);
    if (failures.size) throw new Error(JSON.stringify([...failures]));
    const snapshots = await Promise.all(
      [...forms.keys()].map(async (path) => [path, await read(path)] as [string, string]),
    );
    const canonical = snapshots.map(([, text]) => {
      const program = parse(text);
      const uses = (program.uses ?? []).map((use) => `use ${JSON.stringify(use)}\n`).join('');
      const head = program.profile === 'strict' ? 'profile strict\n\n' : '';
      return `${head}${uses}${formatProgram(program).slice(head.length)}`;
    });
    const candidateSource = canonical.map((text) => printCandidate(parse(text)));
    const candidateInputs = snapshots.map(([path], index) => [path, candidateSource[index]]);
    const canonicalInputs = snapshots.map(([path], index) => [path, canonical[index]]);
    const tokens = Object.fromEntries(
      tokenizers.map(([encoding, tokenizer]) => [
        encoding,
        {
          canonical: canonical.reduce((sum, text) => sum + tokenizer.encode(text).length, 0),
          dense: [...forms.values()].reduce((sum, text) => sum + tokenizer.encode(text).length, 0),
          ...(includeCandidate
            ? {
                candidateSource: candidateSource.reduce(
                  (sum, text) => sum + tokenizer.encode(text).length,
                  0,
                ),
              }
            : {}),
        },
      ]),
    );
    const measurements: Record<string, unknown>[] = [];
    // Rotate implementation order between surfaces to reduce fixed ordering bias.
    for (const surface of [
      'canonical',
      'dense',
      ...(includeCandidate ? ['candidate-source'] : []),
    ]) {
      const subjects =
        surface === 'candidate-source'
          ? ['candidate']
          : surface === 'canonical'
            ? ['baseline', 'candidate']
            : ['candidate', 'baseline'];
      for (const subject of subjects) {
        const child = spawnSync(
          process.execPath,
          [
            join(root, 'dist/tools/frontend-baseline-worker.js'),
            `--implementation=${subject === 'baseline' ? resolve(baseline) : root}`,
            `--entry=${entry}`,
            `--surface=${surface}`,
          ],
          {
            encoding: 'utf8',
            input: JSON.stringify({
              root,
              entry,
              canonical: canonicalInputs,
              dense: [...forms],
              ...(includeCandidate ? { candidateSource: candidateInputs } : {}),
            }),
            maxBuffer: 8 * 1024 * 1024,
            timeout: 180_000,
          },
        );
        if (child.status !== 0) throw new Error(child.stderr || String(child.error));
        const measurement = JSON.parse(child.stdout);
        const identity = JSON.stringify(measurement.implementationHashes);
        const previous = implementations.get(subject);
        if (previous !== undefined && previous !== identity)
          throw new Error('implementation changed during measurement; rebuild and rerun');
        implementations.set(subject, identity);
        measurements.push({ subject, surface, ...measurement });
      }
    }
    const first = measurements[0] as Record<string, unknown>;
    const equivalent =
      measurements.every(
        (m) =>
          m.programSha256 === first.programSha256 &&
          JSON.stringify(m.artifacts) === JSON.stringify(first.artifacts),
      ) &&
      ['canonical', 'dense'].every((surface) => {
        const cells = measurements.filter((m) => m.surface === surface);
        return cells.length === 2 && cells[0]?.inputSha256 === cells[1]?.inputSha256;
      });
    if (!equivalent) throw new Error(`${name}: program or generated artifact differs`);
    rows.push({ entry: name, files: forms.size, tokens, equivalent, measurements });
    process.stderr.write(`${name}: equivalent\n`);
  }
  const capacityRows: Record<string, unknown>[] = [];
  for (const path of listSources(root)) {
    if (isReject(path, root)) continue;
    const text = await read(path);
    const file = path
      .slice(root.length + 1)
      .split('\\')
      .join('/');
    try {
      const refused = refusedUpFront(planned(parse(text), usedSignatures(path)));
      capacityRows.push({
        path: file,
        sourceSha256: hash(text),
        status: refused.size === 0 ? 'within-planner-capacities' : 'blocked',
        refused: Object.fromEntries(refused),
      });
    } catch (error) {
      capacityRows.push({
        path: file,
        status: 'not-assessed',
        reason: String(error).replaceAll(root, '<repo>'),
      });
    }
  }
  const report = {
    schema: 1,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      availableParallelism: availableParallelism(),
    },
    baselineCommit: baselineIdentity.commit,
    baselineTree: baselineIdentity.tree,
    candidateCommit: candidateIdentity.commit,
    candidateTree: candidateIdentity.tree,
    loadSource: loadSource(),
    method:
      'Isolated workers; six warmups, fifteen warm in-memory links per cell. Source inputs are printer-normalized and comment-free. Output hashes use optimized JS, C and direct wasm. Worker RSS includes input snapshots and frontend warmups, sampled before importing backends or emitting. Token counts exclude comments and include imports, summed per file. Cells run sequentially; timings are exploratory, not a paired interleaved performance claim.',
    ai: {
      status: 'not-run',
      reason: 'No fresh model acceptance or tokens-per-accepted-edit measurement.',
    },
    unified: {
      status: includeCandidate ? 'candidate-only' : 'not-measured',
      reason:
        'Canonical and Dense remain public; candidate frontend and migration are internal. Native and tool cutover are incomplete.',
    },
    selfhostCapacity: {
      method:
        'Existing dense-chunk planner capacities only; within-capacity is not an execution pass of the self-hosted reader.',
      caps: READER_CAPS,
      rows: capacityRows,
    },
    rows,
  };
  if (
    JSON.stringify(committedTree(resolve(baseline))) !== JSON.stringify(baselineIdentity) ||
    JSON.stringify(committedTree(root)) !== JSON.stringify(candidateIdentity)
  )
    throw new Error(
      'implementation changed during measurement; rerun on clean committed checkouts',
    );
  await writeReport(option('out') ?? join(root, 'results/frontend-baseline.json'), report);
  process.stdout.write(reportJson({ programs: rows.length, equivalent: true }));
}

await main();
