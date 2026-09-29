/**
 * Tokenizer probe on small fixtures using real tokenizer implementations
 * (js-tiktoken encodings). This is a representation probe, not the Gate A
 * AI-task experiment: it counts tokens of payload text only, excludes language
 * instructions, tool envelopes, reasoning, and retries, and uses OpenAI's public
 * encodings, which are NOT the tokenizer of Claude or any other vendor's model.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getEncoding, type TiktokenEncoding } from 'js-tiktoken';
import { compile } from '../src/backends.js';
import { formatProgram, parseAndValidate, type TypedFunc } from '../src/core.js';
import { EditSession, formatPatch } from '../src/edit.js';
import { generateCorpus } from './corpus.js';

const ENCODINGS: readonly TiktokenEncoding[] = ['o200k_base', 'cl100k_base'];

// --- Fixture: the affine function in A0 and in hand-written baselines -------

const A0_AFFINE = 'fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend\n';

// Hand-written baselines with the same exact semantics (u32 wrap), written the way a
// competent engineer would, not artificially verbose.
const TS_AFFINE = `export function affine(x: number, scale: number, offset: number): number {
  return (Math.imul(x, scale) + offset) >>> 0;
}
`;
const C_AFFINE = `uint32_t affine(uint32_t x, uint32_t scale, uint32_t offset) {
  return x * scale + offset;
}
`;
const PY_AFFINE = `def affine(x: int, scale: int, offset: int) -> int:
    return (x * scale + offset) & 0xFFFFFFFF
`;

// Edits: change `+ offset` to `- offset`.
const A0_SESSION_EDIT = 'e0\nb sub a p2\n';
const TS_UNIFIED_DIFF = `--- a/affine.ts
+++ b/affine.ts
@@ -1,3 +1,3 @@
 export function affine(x: number, scale: number, offset: number): number {
-  return (Math.imul(x, scale) + offset) >>> 0;
+  return (Math.imul(x, scale) - offset) >>> 0;
 }
`;
// Equivalent structured edit for TypeScript: a session handle plus a whole-line replacement
// (the fair "existing language + structured editing" cell of the 2x2).
const TS_SESSION_EDIT = 'e0\n2 return (Math.imul(x, scale) - offset) >>> 0;\n';
// Search/replace block, the common agent edit format.
const TS_SEARCH_REPLACE = `<<<<<<< SEARCH
  return (Math.imul(x, scale) + offset) >>> 0;
=======
  return (Math.imul(x, scale) - offset) >>> 0;
>>>>>>> REPLACE
`;
const C_UNIFIED_DIFF = `--- a/affine.c
+++ b/affine.c
@@ -1,3 +1,3 @@
 uint32_t affine(uint32_t x, uint32_t scale, uint32_t offset) {
-  return x * scale + offset;
+  return x * scale - offset;
 }
`;

function count(enc: ReturnType<typeof getEncoding>, text: string): number {
  return enc.encode(text).length;
}

async function main(): Promise<void> {
  const program = parseAndValidate(A0_AFFINE);
  const affine = program.byName.get('affine') as TypedFunc;
  const patch = `${formatPatch(affine, [
    {
      id: 'b',
      op: 'sub',
      args: [
        { kind: 'node', id: 'a' },
        { kind: 'param', index: 2 },
      ],
    },
  ])}\n`;
  const view = new EditSession(program).open('affine').text;

  const corpus = generateCorpus();
  const corpusA0 = formatProgram(corpus);
  const corpusJs = compile(corpus, 'js', { optimize: false }).text;
  const corpusC = compile(corpus, 'c', { optimize: false }).text;
  const corpusJava = compile(corpus, 'java', { optimize: false }).text;

  const fixtures: Record<string, string> = {
    'affine.a0': A0_AFFINE,
    'affine.ts (hand-written)': TS_AFFINE,
    'affine.c (hand-written)': C_AFFINE,
    'affine.py (hand-written)': PY_AFFINE,
    'a0 view (handle + function)': view,
    'a0 session edit': A0_SESSION_EDIT,
    'a0 self-contained patch': patch,
    'ts unified diff': TS_UNIFIED_DIFF,
    'ts search/replace block': TS_SEARCH_REPLACE,
    'ts session edit (line replace)': TS_SESSION_EDIT,
    'c unified diff': C_UNIFIED_DIFF,
  };
  const corpora: Record<string, string> = {
    'corpus.a0 (48 generated functions)': corpusA0,
    'corpus emitted JS, unoptimized (machine-generated baseline, not hand-written)': corpusJs,
    'corpus emitted C, unoptimized (machine-generated baseline, not hand-written)': corpusC,
    'corpus emitted Java, unoptimized (machine-generated baseline, not hand-written)': corpusJava,
  };

  const results: Record<
    string,
    Record<string, { bytes: number; tokens: Record<string, number> }>
  > = { fixtures: {}, corpora: {} };
  const encoders = ENCODINGS.map((name) => [name, getEncoding(name)] as const);
  for (const [group, set] of [
    ['fixtures', fixtures],
    ['corpora', corpora],
  ] as const) {
    for (const [name, text] of Object.entries(set)) {
      const tokens: Record<string, number> = {};
      for (const [encName, enc] of encoders) tokens[encName] = count(enc, text);
      (results[group] as Record<string, { bytes: number; tokens: Record<string, number> }>)[name] =
        { bytes: Buffer.byteLength(text, 'utf8'), tokens };
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    tokenizer: 'js-tiktoken (pure JS port of OpenAI tiktoken BPE ranks)',
    encodings: ENCODINGS,
    caveats: [
      'o200k_base and cl100k_base are OpenAI public encodings. They are not the tokenizer of Claude or of any non-OpenAI model, and may not match a current OpenAI model either. Vendor-specific counts require that vendor’s count-tokens API.',
      'Payload tokens only. Excludes language instructions/setup, tool schemas and envelopes, view retrieval calls, reasoning, failures, and repairs. Not Gate A.',
      'Hand-written baselines are minimal idiomatic implementations; the emitted-corpus baselines are machine-generated and therefore pessimistic for the existing languages.',
      'Ties and losses are reported as measured; no averaging across fixtures.',
    ],
    ...results,
  };
  await mkdir('results', { recursive: true });
  await writeFile(join('results', 'tokens.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const group of ['fixtures', 'corpora'] as const) {
    process.stdout.write(`\n${group}\n`);
    for (const [name, r] of Object.entries(results[group] ?? {})) {
      process.stdout.write(
        `  ${name.padEnd(78)} ${String(r.bytes).padStart(7)} B  ${ENCODINGS.map((e) => `${e}=${r.tokens[e]}`).join('  ')}\n`,
      );
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
