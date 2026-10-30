/** Offline source-only token counts for the fixed execution benchmark corpus. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import { formatProgram, parseAndValidate, run, validate } from '../src/core.js';
import { formatSource, parseSource } from '../src/source.js';
import { a0TokenText, KERNELS } from './exec-bench-kernels.js';
import { writeReport } from './scrub-results.js';
import { prepareSourceFrontend } from './source-native-load.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export async function sourceTokenBenchmark(nativeArtifact?: string) {
  const encodings = ['o200k_base', 'cl100k_base'] as const;
  const tokenizers = encodings.map((name) => [name, getEncoding(name)] as const);
  const frontend = nativeArtifact ? await prepareSourceFrontend(nativeArtifact) : undefined;
  const engine = frontend?.instantiate();
  const rows: {
    name: string;
    irSHA256: string;
    languages: Record<
      string,
      { source: string; sha256: string; bytes: number; tokens: Record<string, number> }
    >;
  }[] = [];
  try {
    for (const kernel of KERNELS) {
      const reference = parseAndValidate(a0TokenText(kernel));
      const source = formatSource(reference);
      const candidate = validate(parseSource(source));
      assert.equal(formatProgram(candidate), formatProgram(reference), `${kernel.name}: IR parity`);
      assert.equal(formatSource(candidate), source, `${kernel.name}: formatter fixed point`);
      if (engine) {
        const parsed = engine.parse(source);
        assert.ok(parsed.ok, `${kernel.name}: native parser refusal`);
        assert.equal(
          formatProgram(parsed.program),
          formatProgram(reference),
          `${kernel.name}: native IR parity`,
        );
      }
      const fn = candidate.byName.get(kernel.name);
      assert.ok(fn);
      // Existing trusted benchmark JavaScript, executed with the same u32 boundary inputs.
      const js = new Function(
        `${kernel.js.replace(/\bexport\s+/g, '')};return ${kernel.name}`,
      )() as (...args: number[]) => number;
      for (const value of [0, 1, 0x7fffffff, 0xffffffff]) {
        const args = Array.from({ length: kernel.arity }, (_, i) => (value + i * 2654435761) >>> 0);
        assert.equal(run(fn, args), js(...args), `${kernel.name}: JavaScript boundary control`);
      }
      const texts = { A0: source, C: kernel.c, JavaScript: kernel.js, Rust: kernel.rust };
      const languages = Object.fromEntries(
        Object.entries(texts).map(([language, text]) => [
          language,
          {
            source: text,
            sha256: hash(text),
            bytes: Buffer.byteLength(text),
            tokens: Object.fromEntries(
              tokenizers.map(([name, enc]) => [name, enc.encode(text).length]),
            ),
          },
        ]),
      );
      rows.push({ name: kernel.name, irSHA256: hash(formatProgram(candidate)), languages });
    }
  } finally {
    engine?.close();
  }
  const totals = Object.fromEntries(
    ['A0', 'C', 'JavaScript', 'Rust'].map((language) => [
      language,
      Object.fromEntries(
        encodings.map((encoding) => [
          encoding,
          rows.reduce((sum, row) => sum + (row.languages[language]?.tokens[encoding] ?? 0), 0),
        ]),
      ),
    ]),
  );
  const packageJson = JSON.parse(
    await readFile('node_modules/js-tiktoken/package.json', 'utf8'),
  ) as { version: string };
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    scope:
      'Source text only, all 29 existing execution-benchmark programs. One A0 spelling from the implemented src/source.ts formatter; no historical-form scores are combined.',
    tokenizer: { library: 'js-tiktoken', version: packageJson.version, encodings },
    methodology: [
      'Fixed complete KERNELS corpus; existing a0TokenText token-axis override is retained for the noop program, whose timed fixture intentionally contains redundant operations.',
      'A0 formatter fixed point and exact reference IR equality are required for every counted program.',
      'Four deterministic u32 boundary cases per program compare the A0 interpreter against the unchanged hand-written JavaScript benchmark.',
      'Totals sum separately tokenized programs. Counts include complete shown source fragments, helpers and literal data; common driver/tool wrappers are excluded for every language.',
      'These public tokenizer encodings are not asserted to be the tokenizer of any current model. Counts exclude prompts, language briefings, tools, reasoning, retries and repairs; they are not AI editing cost or accuracy.',
      'Implementation measurements do not announce a public compiler default change or universal language superiority.',
    ],
    nativeValidation: frontend
      ? {
          programs: rows.length,
          artifactSHA256: frontend.artifactSha256,
          sourceSHA256: frontend.build.sourceSHA256,
        }
      : null,
    controls: {
      programs: rows.length,
      formatterFixedPoints: rows.length,
      exactReferenceIR: rows.length,
      javascriptBoundaryCases: rows.length * 4,
    },
    totals,
    rows,
  };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const artifact = process.argv
    .find((arg) => arg.startsWith('--native-artifact='))
    ?.slice('--native-artifact='.length);
  const report = await sourceTokenBenchmark(artifact);
  await writeReport('results/source-tokens.json', report);
  console.log(
    JSON.stringify(
      {
        controls: report.controls,
        nativeValidation: report.nativeValidation,
        totals: report.totals,
      },
      null,
      2,
    ),
  );
}
