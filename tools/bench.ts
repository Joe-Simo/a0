/**
 * Local in-process timings and the byte-only edit fixture. These exclude model
 * work, native compilation, and process startup; they are not comparative
 * runtime evidence against other languages or compilers.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compile, FunctionCache, TARGETS, type Target } from '../src/backends.js';
import { formatProgram, parseAndValidate, type TypedFunc } from '../src/core.js';
import { EditSession, formatPatch } from '../src/edit.js';
import { optimize } from '../src/optimize.js';
import { generateCorpus, ioFreeSubset } from './corpus.js';

interface Sample {
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly runs: number;
}

function measure(runs: number, fn: () => void): Sample {
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const s = performance.now();
    fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: times[times.length >> 1] ?? 0,
    minMs: times[0] ?? 0,
    maxMs: times[times.length - 1] ?? 0,
    runs,
  };
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

async function main(): Promise<void> {
  const corpus = generateCorpus();
  const source = formatProgram(corpus);
  const runs = 30;
  measure(5, () => parseAndValidate(source)); // warm-up

  const parse = measure(runs, () => parseAndValidate(source));
  const opt = measure(runs, () => optimize(corpus));
  const emission: Record<string, { cold: Sample; cached: Sample }> = {};
  const hwCorpus = ioFreeSubset(corpus);
  for (const target of TARGETS as readonly Target[]) {
    const input = target === 'sv' ? hwCorpus : corpus;
    const cold = measure(runs, () => compile(input, target));
    const cache = new FunctionCache();
    compile(input, target, {}, cache);
    const cached = measure(runs, () => compile(input, target, {}, cache));
    emission[target] = { cold, cached };
  }
  const session = new EditSession(corpus);
  const target = corpus.functions[0] as TypedFunc;
  const editValidate = measure(runs, () => {
    const view = session.open(target.name);
    // Replace the first scalar-typed node with a literal of its type (timing only, not semantics).
    const first = target.nodes.find((n) => {
      const t = target.types.get(n.id);
      return t === 'u32' || t === 'bool';
    });
    if (first === undefined) throw new Error('no scalar node');
    const literal = target.types.get(first.id) === 'u32' ? '0' : 'false';
    session.apply(`${view.handle}\n${first.id} mov ${literal}`);
  });

  // Byte-only edit fixture on the affine example.
  const affineSrc = 'fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend';
  const affineProgram = parseAndValidate(affineSrc);
  const affine = affineProgram.byName.get('affine') as TypedFunc;
  const patch = formatPatch(affine, [
    {
      id: 'b',
      op: 'sub',
      args: [
        { kind: 'node', id: 'a' },
        { kind: 'param', index: 2 },
      ],
    },
  ]);
  const s2 = new EditSession(affineProgram);
  const view = s2.open('affine');
  const sessionEdit = 'e0\nb sub a p2\n';
  s2.apply(sessionEdit);
  const fixture = {
    function: affineSrc,
    functionBytes: bytes(affineSrc),
    selfContainedPatch: patch,
    selfContainedPatchBytes: bytes(patch),
    sessionEdit,
    sessionEditBytes: bytes(sessionEdit),
    viewBytes: bytes(view.text),
    meaning:
      'UTF-8 bytes of the model-facing payloads. Not tokens, not total task cost; excludes language instructions and tool envelopes. See results/tokens.json for tokenizer counts.',
  };

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    corpus: { functions: corpus.functions.length, sourceBytes: bytes(source) },
    timings: {
      parseAndValidate: parse,
      optimize: opt,
      emission,
      sessionEditOpenApply: editValidate,
    },
    editFixture: fixture,
    meaning:
      'In-process prototype timings (median of runs) covering parse, optimization, emission, and session edit validation. Excludes model work, native compilation/linking, and process startup. Not superiority evidence.',
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'benchmark.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `parse+validate ${parse.medianMs.toFixed(3)} ms, optimize ${opt.medianMs.toFixed(3)} ms\n`,
  );
  for (const [t, e] of Object.entries(emission)) {
    process.stdout.write(
      `emit ${t.padEnd(5)} cold ${e.cold.medianMs.toFixed(3)} ms, cached ${e.cached.medianMs.toFixed(3)} ms\n`,
    );
  }
  process.stdout.write(`session edit open+apply ${editValidate.medianMs.toFixed(3)} ms\n`);
  process.stdout.write(
    `fixture bytes: function ${fixture.functionBytes}, patch ${fixture.selfContainedPatchBytes}, session edit ${fixture.sessionEditBytes}, view ${fixture.viewBytes}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
