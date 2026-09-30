/**
 * The native `a0 check`: the self-hosted front end (compiler/check.a0 linked with parse.a0 and
 * lex.a0, io front `checkio`) compiled by A0's own toolchain (the C backend, as in bootstrap
 * stage 1, then clang -O2 for the host) into `dist/native/a0`, an executable that needs no Node
 * at run time. `dist/native/a0 check FILE` reads the file, runs the A0 lexer, parser and
 * checker, prints `ok` or the diagnostic, and exits with the diagnostic code (0 ok, 1 parse,
 * 2 structure, 3 type, 4 limit; 64 usage or unreadable file, 65 over the source limit).
 * The self-hosted front end checks one file: `use` lines are parsed, not linked.
 *
 * Verification: every source of the front-end set (tools/front-end-sources.ts: small and error
 * programs, the most functions one source holds, the examples, lex.a0, site/ui.a0), the
 * ill-typed programs of tools/ref-check.ts, the generated corpus (tools/corpus.ts: each
 * function with the functions it reaches, as one file; the whole corpus in one file is over the
 * source limit) and the exec-bench kernels goes through the executable as a file, and its
 * (code, function, node) must equal the TypeScript reference checker's (refCheckWords).
 * Writes results/native-check.json.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compile } from '../src/backends.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { CORPUS_FUNCTIONS, CORPUS_SEED, closures, generateCorpus } from './corpus.js';
import { KERNELS } from './exec-bench-kernels.js';
import { frontEndSources } from './front-end-sources.js';
import { ILL_TYPED, NONE, refCheckWords } from './ref-check.js';
import { FRONT_END_SOURCE_LIMIT } from './ref-parse.js';

export const NATIVE_DIR = join('dist', 'native');
export const NATIVE_A0 = join(NATIVE_DIR, 'a0');

/** checkio writes 4 header words first; the tables after them are not read by the driver. */
const OUTPUT_WORDS = 4;

const MAIN = `#include <stdio.h>
#include <string.h>
#include "checker.c"
static a0_io io;
int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "check") != 0) {
    fputs("usage: a0 check <file.a0>\\n", stderr);
    return 64;
  }
  FILE *f = fopen(argv[2], "rb");
  if (f == NULL) {
    fprintf(stderr, "a0: cannot read %s\\n", argv[2]);
    return 64;
  }
  static unsigned char src[${FRONT_END_SOURCE_LIMIT + 1}];
  size_t n = fread(src, 1, sizeof src, f);
  int bad = ferror(f);
  fclose(f);
  if (bad) {
    fprintf(stderr, "a0: cannot read %s\\n", argv[2]);
    return 64;
  }
  if (n > ${FRONT_END_SOURCE_LIMIT}u) {
    fprintf(stderr, "a0: %s is over the ${FRONT_END_SOURCE_LIMIT}-byte source limit\\n", argv[2]);
    return 65;
  }
  io.input[0] = (uint32_t)n;
  for (size_t k = 0; k < n; k++) io.input[k + 1] = src[k];
  io.ninput = (uint32_t)n + 1u;
  uint32_t code = a0_checkio(&io);
  static const char *const kinds[] = {"ok", "parse", "structure", "type", "limit"};
  if (code == 0) {
    puts("ok");
    return 0;
  }
  const char *kind = code < 5u ? kinds[code] : "unknown";
  if (io.output[2] == 0xffffffffu)
    fprintf(stderr, "%s: %s error %u at token %u\\n", argv[2], kind, code, io.output[3]);
  else
    fprintf(stderr, "%s: %s error %u in function %u at node %u\\n", argv[2], kind, code,
            io.output[2], io.output[3]);
  return (int)code;
}
`;

/** Compile the self-hosted checker to dist/native/a0; returns the build time in ms. */
export async function buildNativeCheck(): Promise<{ ms: number; cBytes: number; fns: number }> {
  const clang = findClang().path;
  if (clang === undefined) throw new Error('clang not found');
  const t0 = performance.now();
  const program = (await link('compiler/check.a0', (p) => readFile(p, 'utf8'))).program;
  const c = compile(program, 'c', {
    ioInputCapacity: FRONT_END_SOURCE_LIMIT + 2,
    ioOutputCapacity: OUTPUT_WORDS,
  }).text;
  await mkdir(NATIVE_DIR, { recursive: true });
  await writeFile(join(NATIVE_DIR, 'checker.c'), c, 'utf8');
  await writeFile(join(NATIVE_DIR, 'main.c'), MAIN, 'utf8');
  const r = runTool(clang, ['-std=c11', '-O2', '-o', 'a0', 'main.c'], {
    cwd: NATIVE_DIR,
    timeoutMs: 600_000,
  });
  if (!r.ok) throw new Error(`native a0 build failed:\n${r.stderr.slice(0, 4000)}`);
  return {
    ms: Math.round(performance.now() - t0),
    cBytes: Buffer.byteLength(c),
    fns: program.functions.length,
  };
}

interface Row {
  readonly label: string;
  readonly bytes: number;
  readonly expected: [number, number, number];
  readonly got: [number, number, number] | null;
  readonly ms: number;
  readonly ok: boolean;
}

async function sources(): Promise<[string, string][]> {
  const corpus = generateCorpus(CORPUS_SEED, CORPUS_FUNCTIONS);
  const out: [string, string][] = [
    ...(await frontEndSources()),
    ...ILL_TYPED.map(([l, s]): [string, string] => [`ill-typed/${l}`, s]),
    ...closures('corpus', corpus).filter(([, s]) => Buffer.byteLength(s) <= FRONT_END_SOURCE_LIMIT),
    ...KERNELS.map((k): [string, string] => [`kernel/${k.name}`, k.a0]),
  ];
  return out;
}

/** The native diagnostic: stdout `ok`, or stderr naming function and node (or token). */
function parseDiagnostic(status: number, stderr: string): [number, number, number] | null {
  if (status === 0) return [0, 0, 0];
  const fnNode = /error (\d+) in function (\d+) at node (\d+)/.exec(stderr);
  if (fnNode !== null) return [Number(fnNode[1]), Number(fnNode[2]), Number(fnNode[3])];
  const tok = /error (\d+) at token (\d+)/.exec(stderr);
  if (tok !== null) return [Number(tok[1]), NONE, Number(tok[2])];
  return null;
}

async function main(): Promise<void> {
  const build = await buildNativeCheck();
  process.stdout.write(
    `built ${NATIVE_A0}: ${build.fns} functions, ${build.cBytes} C bytes, ${build.ms} ms\n`,
  );
  const dir = join(NATIVE_DIR, 'cases');
  await mkdir(dir, { recursive: true });
  const rows: Row[] = [];
  for (const [i, [label, src]] of (await sources()).entries()) {
    const words = refCheckWords(src);
    const expected: [number, number, number] =
      words[1] === 0 ? [0, 0, 0] : [words[1] as number, words[2] as number, words[3] as number];
    const file = join(dir, `${i}.a0`);
    await writeFile(file, src, 'utf8');
    const t0 = performance.now();
    const r = runTool(NATIVE_A0, ['check', file]);
    const ms = performance.now() - t0;
    const got = parseDiagnostic(r.status ?? -1, r.stderr);
    const ok = got?.every((v, k) => v === expected[k]) === true;
    rows.push({
      label,
      bytes: Buffer.byteLength(src),
      expected,
      got,
      ms: Math.round(ms * 10) / 10,
      ok,
    });
    if (!ok)
      process.stdout.write(
        `  FAIL ${label}: expected ${expected.join(' ')}, got ${got?.join(' ') ?? r.stderr}\n`,
      );
  }
  const failed = rows.filter((r) => !r.ok);
  const rejected = rows.filter((r) => r.expected[0] !== 0).length;
  process.stdout.write(
    `${rows.length - failed.length}/${rows.length} sources agree with the reference checker (${rejected} rejected by it)\n`,
  );
  await mkdir('results', { recursive: true });
  await writeFile(
    'results/native-check.json',
    `${JSON.stringify(
      {
        tool: 'bun run native-check (tools/native-check.ts)',
        executable: NATIVE_A0,
        build: {
          method:
            'compiler/check.a0 linked with parse.a0 and lex.a0, entry checkio, compiled by the A0 C backend (src/backends.ts) and clang -std=c11 -O2 for the host (arm64 on Apple silicon); no Node at run time',
          functions: build.fns,
          cBytes: build.cBytes,
          ms: build.ms,
          clang: findClang().version,
        },
        verification: {
          method:
            'each source is written to a file and checked by a separate `dist/native/a0 check FILE` process; its (code, function, node) must equal refCheckWords of tools/ref-check.ts (code 0: accepted)',
          sources: rows.length,
          agree: rows.length - failed.length,
          rejectedByReference: rejected,
          failed: failed.length,
        },
        rows,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith('native-check.js'))
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
