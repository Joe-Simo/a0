/**
 * Self-hosting stage 4a check: the AArch64 emitter written in A0 (compiler/emit_arm64.a0) is
 * verified by execution. For every scalar-only function of a generated scalar corpus and of
 * the scalar examples, the function and its transitive callees are formatted as one source,
 * `emitio` is run on it through the reference interpreter (lex, parse, check, emit all in
 * A0), the assembly text is assembled and linked with clang exactly as tools/verify.ts does
 * for the TypeScript backend (`native_arm64`), and the oracle cases are executed and must
 * agree with the independent BigInt oracle. Sources over the front end's limits (512 bytes,
 * 512 token words) are counted as skipped, never as passes. Writes results/selfhost.json.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatProgram,
  makeIo,
  parseAndValidate,
  run,
  type TypedFunc,
  type TypedProgram,
  validate,
} from '../src/core.js';
import { link } from '../src/link.js';
import { findClang } from '../src/toolchain.js';
import { type Case, generateCases, generateCorpus, hasScalarSignature } from './corpus.js';
import { refLex } from './ref-parse.js';
import { checkArm64Assembly, type TargetReport } from './verify.js';

export const SCALAR_CORPUS_SEED = 0xa05ca1a;
export const SCALAR_CORPUS_FUNCTIONS = 48;
/** The front end's table sizes (compiler/lex.a0): source bytes and token words. */
const MAX_SOURCE_BYTES = 512;
const MAX_TOKEN_WORDS = 512;

/** Is every parameter, the result and every node of `fn` u32 or bool (transitively)? */
function isScalarOnly(fn: TypedFunc, seen = new Map<string, boolean>()): boolean {
  const cached = seen.get(fn.name);
  if (cached !== undefined) return cached;
  const own =
    hasScalarSignature(fn) && [...fn.types.values()].every((t) => t === 'u32' || t === 'bool');
  const ok = own && [...fn.calls.values()].every((c) => isScalarOnly(c, seen));
  seen.set(fn.name, ok);
  return ok;
}

/** `fn` with its transitive callees, in program order. */
function closure(program: TypedProgram, fn: TypedFunc): TypedProgram {
  const keep = new Set<string>();
  const visit = (f: TypedFunc): void => {
    if (keep.has(f.name)) return;
    for (const c of f.calls.values()) visit(c);
    keep.add(f.name);
  };
  visit(fn);
  return validate({ functions: program.functions.filter((f) => keep.has(f.name)) });
}

export interface EmitResult {
  readonly ok: boolean;
  readonly code: number;
  readonly fn: number;
  readonly node: number;
  readonly asm: string;
}

/** Run `emitio` on `source` through the reference interpreter. */
export function emitWithA0(emitter: TypedProgram, source: string): EmitResult {
  const bytes = [...Buffer.from(source)];
  const state = makeIo([bytes.length, ...bytes]);
  // The emitter copies its tables per update and aggregates cost their length in fuel, so it
  // runs on the same explicit budget as tools/selfhost-c.ts.
  run(emitter.byName.get('emitio') as TypedFunc, [state], { fuel: 1e12 });
  const [ok, code, fn, node, n] = state.output as [number, number, number, number, number];
  return {
    ok: ok === 1,
    code,
    fn,
    node,
    asm: Buffer.from(state.output.slice(5, 5 + n)).toString('latin1'),
  };
}

/**
 * The A0-written AArch64 emitter run over `program`: each scalar-only function with its callees
 * is emitted by `emitio` in the interpreter, assembled, linked with the C driver, and its cases
 * executed. Functions the front end cannot hold (512 bytes, 512 token words) are returned in
 * `skipped` with the reason, never counted as passes.
 */
export async function checkSelfHostedArm64(
  emitter: TypedProgram,
  program: TypedProgram,
  cases: readonly Case[],
): Promise<TargetReport & { skipped: { fn: string; reason: string }[] }> {
  const clang = findClang();
  const skipped: { fn: string; reason: string }[] = [];
  let ran = 0;
  for (const fn of program.functions) {
    const mine = cases.filter((c) => c.functionName === fn.name);
    if (mine.length === 0) continue;
    if (!isScalarOnly(fn)) {
      skipped.push({ fn: fn.name, reason: 'aggregate or io types: the emitter is scalar-only' });
      continue;
    }
    const subset = closure(program, fn);
    const source = formatProgram(subset);
    const tokenWords = refLex(source).length;
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES || tokenWords > MAX_TOKEN_WORDS) {
      skipped.push({
        fn: fn.name,
        reason: `source over the front end's limit (${Buffer.byteLength(source)} bytes, ${tokenWords} token words)`,
      });
      continue;
    }
    const emitted = emitWithA0(emitter, source);
    if (!emitted.ok)
      return {
        status: 'failed',
        cases: ran,
        detail: `emitio refused ${fn.name}: code ${emitted.code} at fn ${emitted.fn} node ${emitted.node}`,
        skipped,
      };
    const r = await checkArm64Assembly(
      subset,
      emitted.asm,
      mine,
      clang,
      'A0-emitted arm64 assembly (compiler/emit_arm64.a0 through the interpreter)',
    );
    if (r.status !== 'passed') return { ...r, skipped };
    ran += r.cases;
  }
  return {
    status: ran > 0 ? 'passed' : 'blocked',
    cases: ran,
    detail: `A0-emitted arm64 (compiler/emit_arm64.a0 through the interpreter), ${ran} cases; ${skipped.length} functions skipped`,
    skipped,
  };
}

interface ProgramReport {
  readonly label: string;
  readonly functionName: string;
  readonly sourceBytes: number;
  readonly asmBytes: number;
  readonly status: TargetReport['status'] | 'skipped';
  readonly cases: number;
  readonly detail: string;
  readonly failures?: string[] | undefined;
}

async function checkSuite(
  emitter: TypedProgram,
  program: TypedProgram,
  suite: string,
): Promise<ProgramReport[]> {
  const clang = findClang();
  const reports: ProgramReport[] = [];
  for (const fn of program.functions) {
    if (!isScalarOnly(fn)) continue;
    const subset = closure(program, fn);
    const source = formatProgram(subset);
    const label = `${suite}/${fn.name}`;
    const sourceBytes = Buffer.byteLength(source);
    const tokenWords = refLex(source).length;
    const base = { label, functionName: fn.name, sourceBytes };
    if (sourceBytes > MAX_SOURCE_BYTES || tokenWords > MAX_TOKEN_WORDS) {
      reports.push({
        ...base,
        asmBytes: 0,
        status: 'skipped',
        cases: 0,
        detail: `source over the front end's limit (${sourceBytes} bytes, ${tokenWords} token words)`,
      });
      continue;
    }
    const emitted = emitWithA0(emitter, source);
    if (!emitted.ok) {
      reports.push({
        ...base,
        asmBytes: 0,
        status: 'failed',
        cases: 0,
        detail: `emitio refused the program: code ${emitted.code} at fn ${emitted.fn} node ${emitted.node}`,
      });
      continue;
    }
    const cases = generateCases(subset).filter((c) => c.functionName === fn.name);
    const r = await checkArm64Assembly(
      subset,
      emitted.asm,
      cases,
      clang,
      `A0-emitted arm64 assembly (compiler/emit_arm64.a0 through the interpreter) via clang -x assembler, linked with the C test driver`,
    );
    reports.push({
      ...base,
      asmBytes: Buffer.byteLength(emitted.asm),
      status: r.status,
      cases: r.cases,
      detail: r.detail,
      failures: r.failures,
    });
  }
  return reports;
}

function summarize(reports: readonly ProgramReport[]): {
  programs: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: number;
} {
  return {
    programs: reports.length,
    passed: reports.filter((r) => r.status === 'passed').length,
    failed: reports.filter((r) => r.status === 'failed' || r.status === 'blocked').length,
    skipped: reports.filter((r) => r.status === 'skipped').length,
    cases: reports.reduce((n, r) => n + r.cases, 0),
  };
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    process.stderr.write(
      `selfhost: needs macOS on Apple silicon, found ${process.platform}-${process.arch}\n`,
    );
    process.exit(1);
  }
  const emitter = (await link('compiler/emit_arm64.a0', (p) => readFile(p, 'utf8'))).program;
  const corpus = generateCorpus(SCALAR_CORPUS_SEED, SCALAR_CORPUS_FUNCTIONS, { scalar: true });
  const corpusReports = await checkSuite(emitter, corpus, 'corpus');
  const examples = parseAndValidate(await readFile('examples/kernels.a0', 'utf8'));
  const exampleReports = await checkSuite(emitter, examples, 'examples/kernels.a0');
  const all = [...corpusReports, ...exampleReports];
  const summary = summarize(all);
  const report = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    emitter:
      'compiler/emit_arm64.a0 (linked with check.a0, parse.a0, lex.a0), io front emitio, run by the reference interpreter',
    method:
      'per scalar-only function: the function plus its transitive callees as one source; emitio in the interpreter; clang -x assembler; linked with the C test driver of tools/verify.ts; every oracle case executed and compared with the BigInt oracle',
    tool: findClang().version,
    scalarCorpus: {
      seed: `0x${SCALAR_CORPUS_SEED.toString(16)}`,
      functions: SCALAR_CORPUS_FUNCTIONS,
      generator: 'tools/corpus.ts generateCorpus(seed, count, { scalar: true })',
      ...summarize(corpusReports),
    },
    examples: { file: 'examples/kernels.a0', ...summarize(exampleReports) },
    ...summary,
    programs: all,
  };
  await mkdir('results', { recursive: true });
  await writeFile(join('results', 'selfhost.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const r of all) {
    process.stdout.write(
      `${r.label.padEnd(32)} ${r.status.padEnd(8)} ${String(r.cases).padStart(5)} cases  ${String(r.sourceBytes).padStart(4)} src B ${String(r.asmBytes).padStart(5)} asm B  ${r.detail.slice(0, 60)}\n`,
    );
    if (r.failures)
      for (const f of r.failures.slice(0, 5)) process.stdout.write(`    ${f.slice(0, 300)}\n`);
  }
  process.stdout.write(
    `selfhost: ${summary.passed} programs passed, ${summary.failed} failed, ${summary.skipped} skipped (over the 512-byte front end), ${summary.cases} cases\n`,
  );
  process.exit(summary.failed > 0 || summary.passed === 0 ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
