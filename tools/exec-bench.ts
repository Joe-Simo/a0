/**
 * Gate B (execution quality) micro-benchmark: A0-emitted code versus hand-written
 * baselines with identical observable semantics, on the same machine, same
 * compiler, same flags. Steady-state only (per-call ns after warm-up); startup,
 * memory, energy, and real applications are NOT measured here. Sanitizers are off
 * (production-style flags), unlike the correctness runs in verify.
 *
 * Baselines: hand-written C (clang -O2, and -O3 -march=native as the best-flag row, same
 * driver, inlined) and Rust (rustc -C opt-level=3 -C target-cpu=native), the
 * A0 direct AArch64 backend, hand-written JavaScript (Node, in process, warm), and every
 * language in the table (tools/exec-bench-languages.ts and exec-bench-languages-more.ts,
 * 45 entries: TypeScript, C++, Objective-C, Java, Kotlin, Scala, Clojure, Groovy, C#, F#,
 * Visual Basic, Go, Swift, Zig, Dart, Nim, Crystal, D, Pascal, Fortran, Haskell, OCaml,
 * Julia, R, Python, Ruby, PHP, Lua, Perl, Tcl, Elixir, Erlang, Gleam, Racket, Guile,
 * CHICKEN, Common Lisp, Prolog, Smalltalk, Forth, Haxe, V, Odin, Vala, COBOL) whose
 * toolchain is installed; a missing toolchain is a skipped row. Each baseline kernel is
 * verified against the A0 checksum for the same iteration count before it is timed; a
 * mismatch is recorded as skipped-checksum-mismatch, never as a number. Runs are
 * interleaved across languages sample by sample and the median is reported, with the
 * process-launch latency (one iteration) measured the same way. The report's `geomeans`
 * block gives one number per baseline: the geometric mean over kernels of
 * baseline ns / A0 emitted-C ns.
 *
 * Usage: bun run exec-bench [-- options]
 *   --langs=a,b     only these table languages (C, Rust, arm64, JS always run)
 *   --kernels=a,b   only these kernels
 *   --samples=N     samples per side (default 7)
 *   --scale=N       divide every iteration count by N (quick, noisy check)
 *   --out=PATH      report path (default results/exec-benchmark.json)
 *   --help          this text and the language ids
 * Toolchain overrides: A0_CLANG, A0_CLANGXX, A0_JAVA, A0_JAVAC, A0_KOTLINC, A0_GO,
 * A0_SWIFTC, A0_ZIG, A0_DOTNET, A0_PYTHON, A0_RUBY, ... (one A0_<TOOL> per finder in the
 * table; see `single(...)` calls).
 *
 * Expected outcome for scalar straight-line kernels is a tie against C and Rust: both
 * sides reach the same optimizer. Ties and losses are recorded as such.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { cDriver, KERNELS, type Kernel, rustDriver } from './exec-bench-kernels.js';
import {
  LANGUAGES as CORE_LANGUAGES,
  ITER,
  KERNEL_NAMES,
  type Language,
  TIER,
  type Toolchain,
} from './exec-bench-languages.js';
import { MORE_LANGUAGES } from './exec-bench-languages-more.js';

const LANGUAGES: readonly Language[] = [...CORE_LANGUAGES, ...MORE_LANGUAGES];

const CLI = parseCli(process.argv.slice(2));
const SAMPLES = CLI.samples;
const SCALE = CLI.scale;
const scaled = (n: number): number => Math.max(1, Math.floor(n / SCALE));

interface Cli {
  readonly langs: ReadonlySet<string> | null;
  readonly kernels: ReadonlySet<string> | null;
  readonly samples: number;
  readonly scale: number;
  readonly out: string;
}

function parseCli(argv: readonly string[]): Cli {
  let langs: Set<string> | null = null;
  let kernels: Set<string> | null = null;
  let samples = 7;
  let scale = 1;
  let out = join('results', 'exec-benchmark.json');
  for (const a of argv) {
    const [key, value = ''] = a.split('=', 2) as [string, string?];
    if (key === '--help' || key === '-h') {
      process.stdout.write(
        `usage: bun run exec-bench [-- --langs=a,b] [--kernels=a,b] [--samples=N] [--scale=N] [--out=PATH]\n` +
          `languages in the table: ${LANGUAGES.map((l) => l.id).join(', ')}\n` +
          `kernels: ${KERNEL_NAMES.join(', ')}\n`,
      );
      process.exit(0);
    } else if (key === '--langs') langs = new Set(value.split(',').filter((v) => v.length > 0));
    else if (key === '--kernels') kernels = new Set(value.split(',').filter((v) => v.length > 0));
    else if (key === '--samples') samples = Math.max(1, Number(value) || 7);
    else if (key === '--scale') scale = Math.max(1, Number(value) || 1);
    else if (key === '--out') out = value;
    else throw new Error(`unknown option ${a} (see --help)`);
  }
  return { langs, kernels, samples, scale, out };
}

/** Native iterations per sample for a kernel (JS runs a quarter, Python 1/200 of this). */
const iterations = (kernel: Kernel): number => Math.floor(ITER / (kernel.iterScale ?? 1));

interface Sample {
  readonly medianNsPerCall: number;
  readonly minNsPerCall: number;
  readonly maxNsPerCall: number;
  readonly checksum: string;
  readonly samples: number;
}

function summarize(values: number[], checksum: string): Sample {
  const s = [...values].sort((a, b) => a - b);
  return {
    medianNsPerCall: s[s.length >> 1] ?? 0,
    minNsPerCall: s[0] ?? 0,
    maxNsPerCall: s[s.length - 1] ?? 0,
    checksum,
    samples: values.length,
  };
}

async function benchC(
  kernel: Kernel,
  clang: string,
  rustc: string,
): Promise<{
  startupMs: { emitted: number; handwritten: number };
  rust: Sample | null;
  buildMs: { a0ToNative: number; rustc: number | null };
  emitted: Sample;
  handwritten: Sample;
  /** The same hand-written C at the best flags (-O3 -march=native). */
  handwrittenBest: Sample;
  /** Direct AArch64 backend (src/arm64.ts) as an out-of-line call from the same driver; null off Apple silicon. */
  arm64: Sample | null;
  binaryBytes: { emitted: number; handwritten: number };
}> {
  const tEmit = performance.now();
  const program = parseAndValidate(kernel.a0);
  const emittedSrc = compile(program, 'c').text;
  const emitMs = performance.now() - tEmit;
  let startupMs = { emitted: 0, handwritten: 0 };
  return withTempDir(async (dir) => {
    const build = async (
      name: string,
      header: string,
      call: string,
      flags: readonly string[] = ['-O2'],
    ): Promise<{ exe: string; bytes: number }> => {
      const src = join(dir, `${name}.c`);
      const exe = join(dir, name);
      await writeFile(src, `${header}\n${cDriver(() => call, kernel.arity)}`, 'utf8');
      const r = runTool(clang, ['-std=c11', ...flags, '-o', exe, src]);
      if (!r.ok) throw new Error(`${name}: ${r.stderr}`);
      const { stat } = await import('node:fs/promises');
      return { exe, bytes: (await stat(exe)).size };
    };
    const tA0 = performance.now();
    const e = await build('emitted', emittedSrc, `a0_${kernel.name}(ARGS)`);
    const a0BuildMs = performance.now() - tA0 + emitMs;
    // arm64: the A0 kernel as assembly from src/arm64.ts (no C for the program), assembled by
    // `clang -x assembler`, linked with the same driver. The call is out of line (no inlining
    // across the object boundary), unlike the C paths where the kernel inlines into the loop.
    let arm64Exe: string | null = null;
    if (process.platform === 'darwin' && process.arch === 'arm64' && kernel.noArm64 === undefined) {
      await writeFile(join(dir, 'kernel.s'), compile(program, 'arm64').text, 'utf8');
      const as = runTool(clang, [
        '-c',
        '-x',
        'assembler',
        '-o',
        join(dir, 'kernel.o'),
        join(dir, 'kernel.s'),
      ]);
      if (!as.ok) throw new Error(`arm64 assemble: ${as.stderr}`);
      const proto = `#include <stdint.h>\nextern uint32_t a0_${kernel.name}(${Array.from({ length: kernel.arity }, () => 'uint32_t').join(', ')});`;
      const src = join(dir, 'arm64.c');
      arm64Exe = join(dir, 'arm64');
      await writeFile(
        src,
        `${proto}\n${cDriver(() => `a0_${kernel.name}(ARGS)`, kernel.arity)}`,
        'utf8',
      );
      const r = runTool(clang, ['-std=c11', '-O2', '-o', arm64Exe, src, join(dir, 'kernel.o')]);
      if (!r.ok) throw new Error(`arm64 link: ${r.stderr}`);
    }
    const h = await build(
      'handwritten',
      `#include <stdint.h>\n${kernel.c}`,
      `hw_${kernel.name}(ARGS)`,
    );
    const hb = await build(
      'handwritten-best',
      `#include <stdint.h>\n${kernel.c}`,
      `hw_${kernel.name}(ARGS)`,
      C_BEST_FLAGS,
    );
    // Rust baseline: same driver loop, rustc -O (LLVM), measured in the same interleaved loop.
    const rustSrc = join(dir, 'rust.rs');
    const rustExe = join(dir, 'rustbin');
    await writeFile(rustSrc, rustDriver(kernel), 'utf8');
    const tRust = performance.now();
    const rb = runTool(rustc, [...RUST_FLAGS, '-o', rustExe, rustSrc], {
      timeoutMs: 300_000,
    });
    const rustBuildMs = performance.now() - tRust;
    const rustOk = rb.ok;
    if (!rustOk)
      process.stderr.write(`rustc failed for ${kernel.name}: ${rb.stderr.slice(0, 400)}\n`);
    const rs: number[] = [];
    let rc = '';
    const runOne = (exe: string): { ns: number; checksum: string } => {
      const r = runTool(exe, [String(scaled(iterations(kernel)))], { timeoutMs: 600_000 });
      if (!r.ok) throw new Error(r.stderr);
      const [ns, sum] = r.stdout.trim().split(' ');
      return { ns: Number(ns), checksum: sum ?? '' };
    };
    const es: number[] = [];
    const hs: number[] = [];
    const hbs: number[] = [];
    let hbc = '';
    const as64: number[] = [];
    let ac = '';
    let ec = '';
    let hc = '';
    // Startup: wall time of a process that runs a single iteration (spawn + exit dominated).
    const startup = (exe: string): number => {
      const t = performance.now();
      runTool(exe, ['1']);
      return performance.now() - t;
    };
    const su: number[] = [];
    const sh: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      su.push(startup(e.exe));
      sh.push(startup(h.exe));
    }
    startupMs = {
      emitted: [...su].sort((p, q) => p - q)[su.length >> 1] ?? 0,
      handwritten: [...sh].sort((p, q) => p - q)[sh.length >> 1] ?? 0,
    };
    for (let i = 0; i < SAMPLES; i += 1) {
      // Interleave to share thermal/scheduling conditions.
      const a = runOne(e.exe);
      const b = runOne(h.exe);
      es.push(a.ns);
      hs.push(b.ns);
      ec = a.checksum;
      hc = b.checksum;
      const best = runOne(hb.exe);
      hbs.push(best.ns);
      hbc = best.checksum;
      if (arm64Exe !== null) {
        const r = runOne(arm64Exe);
        as64.push(r.ns);
        ac = r.checksum;
      }
      if (rustOk) {
        const r = runOne(rustExe);
        rs.push(r.ns);
        rc = r.checksum;
      }
    }
    if (ec !== hc)
      throw new Error(`${kernel.name}: checksum mismatch emitted=${ec} handwritten=${hc}`);
    if (hbc !== ec)
      throw new Error(`${kernel.name}: checksum mismatch emitted=${ec} best-flags C=${hbc}`);
    if (arm64Exe !== null && ac !== ec)
      throw new Error(`${kernel.name}: arm64 checksum mismatch ${ac} vs ${ec}`);
    if (rustOk && rc !== ec)
      throw new Error(`${kernel.name}: rust checksum mismatch ${rc} vs ${ec}`);
    return {
      emitted: summarize(es, ec),
      handwritten: summarize(hs, hc),
      handwrittenBest: summarize(hbs, hbc),
      arm64: arm64Exe === null ? null : summarize(as64, ac),
      binaryBytes: { emitted: e.bytes, handwritten: h.bytes },
      startupMs,
      rust: rustOk ? summarize(rs, rc) : null,
      buildMs: { a0ToNative: a0BuildMs, rustc: rustOk ? rustBuildMs : null },
    };
  });
}

async function benchJs(
  kernel: Kernel,
): Promise<{ emitted: Sample; handwritten: Sample; checksumAt: (iters: number) => string }> {
  const program = parseAndValidate(kernel.a0);
  const load = async (src: string): Promise<(...a: number[]) => number> => {
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`
    )) as Record<string, (...a: number[]) => number>;
    const f = mod[kernel.name];
    if (f === undefined) throw new Error('missing export');
    return f;
  };
  const emitted = await load(compile(program, 'js').text);
  const handwritten = await load(kernel.js);
  const iters = scaled(iterations(kernel) / 4);
  const run = (
    f: (...a: number[]) => number,
    iterations = iters,
  ): { ns: number; checksum: string } => {
    let s = 0x9e3779b9;
    let acc = 0;
    const a = [0, 0, 0];
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      for (let k = 0; k < kernel.arity; k += 1) {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        a[k] = s;
      }
      const r =
        kernel.arity === 1
          ? f(a[0] as number)
          : kernel.arity === 2
            ? f(a[0] as number, a[1] as number)
            : f(a[0] as number, a[1] as number, a[2] as number);
      acc = (acc ^ r) >>> 0;
    }
    return { ns: ((performance.now() - start) * 1e6) / iterations, checksum: String(acc) };
  };
  run(emitted);
  run(handwritten); // warm-up (JIT)
  const es: number[] = [];
  const hs: number[] = [];
  let ec = '';
  let hc = '';
  for (let i = 0; i < SAMPLES; i += 1) {
    const a = run(emitted);
    const b = run(handwritten);
    es.push(a.ns);
    hs.push(b.ns);
    ec = a.checksum;
    hc = b.checksum;
  }
  if (ec !== hc) throw new Error(`${kernel.name}: js checksum mismatch`);
  return {
    emitted: summarize(es, ec),
    handwritten: summarize(hs, hc),
    checksumAt: (n) => run(handwritten, n).checksum,
  };
}

type LangStatus =
  | 'ran'
  | 'skipped-no-toolchain'
  | 'skipped-build-failed'
  | 'skipped-run-failed'
  | 'skipped-checksum-mismatch'
  | 'skipped-no-source';

interface LangRow {
  readonly status: LangStatus;
  readonly family: Language['family'];
  readonly toolchain: string | null;
  readonly iterations: number;
  readonly medianNsPerCall?: number;
  readonly minNsPerCall?: number;
  readonly maxNsPerCall?: number;
  readonly checksum?: string;
  readonly samples?: number;
  /** Wall time of one process launch running a single iteration (median), ms. */
  readonly startupMs?: number;
  readonly timer?: string;
  readonly detail?: string;
}

const median = (a: readonly number[]): number => [...a].sort((p, q) => p - q)[a.length >> 1] ?? 0;

/** Parse the one-line "ns checksum" protocol every baseline driver prints. */
function readBack(
  lang: Language,
  r: { stdout: string; stderr: string },
): { ns: number; checksum: string } {
  const text = lang.output === 'stderr' ? r.stderr : r.stdout;
  const line = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[0-9.eE+-]+ [0-9]+$/.test(l))
    .pop();
  if (line === undefined)
    throw new Error(`no "ns checksum" line in output: ${(r.stdout + r.stderr).slice(-300)}`);
  const [ns, checksum] = line.split(' ') as [string, string];
  return { ns: Number(ns), checksum };
}

interface Prepared {
  readonly lang: Language;
  readonly tool: Toolchain;
  readonly cmd: readonly [string, readonly string[]];
  readonly one: readonly [string, readonly string[]];
  readonly env: NodeJS.ProcessEnv;
  readonly iterations: number;
  readonly checksum: string;
  readonly ns: number[];
  readonly startup: number[];
}

/**
 * Every table language on one kernel: build once, verify the checksum against the A0 result
 * for the same iteration count, then time all languages interleaved (sample i of every
 * language before sample i+1 of any) and measure process-launch latency the same way.
 */
async function benchLanguages(
  kernel: Kernel,
  langs: readonly { readonly lang: Language; readonly tool: Toolchain | undefined }[],
  expectedAt: (iters: number) => string,
): Promise<Record<string, LangRow>> {
  const rows: Record<string, LangRow> = {};
  const skip = (
    lang: Language,
    tool: Toolchain | undefined,
    status: LangStatus,
    detail: string,
  ): void => {
    rows[lang.id] = {
      status,
      family: lang.family,
      toolchain: tool?.version ?? null,
      iterations: scaled(lang.iterations),
      detail,
    };
    process.stderr.write(
      `  ${lang.id}/${kernel.name}: ${status}: ${detail.split('\n')[0]?.slice(0, 200)}\n`,
    );
  };
  return withTempDir(async (root) => {
    const prepared: Prepared[] = [];
    for (const { lang, tool } of langs) {
      if (tool === undefined) {
        skip(lang, tool, 'skipped-no-toolchain', `${lang.label} toolchain not found`);
        continue;
      }
      const src = lang.kernels[kernel.name];
      if (src === undefined) {
        skip(lang, tool, 'skipped-no-source', `${lang.label}: no ${kernel.name} kernel written`);
        continue;
      }
      const dir = join(root, lang.id);
      await mkdir(dirname(join(dir, lang.file)), { recursive: true });
      await writeFile(join(dir, lang.file), lang.program(kernel, src), 'utf8');
      for (const [name, text] of Object.entries(lang.extraFiles?.(dir, tool) ?? {}))
        await writeFile(join(dir, name), text, 'utf8');
      const env = { ...process.env, ...(lang.env?.(tool) ?? {}) };
      let failed = false;
      for (const [cmd, cmdArgs] of lang.build?.(dir, tool) ?? []) {
        const r = runTool(cmd, cmdArgs, { cwd: dir, env, timeoutMs: 900_000 });
        if (!r.ok) {
          skip(
            lang,
            tool,
            'skipped-build-failed',
            `${cmd} ${cmdArgs.join(' ')}: ${(r.stderr || r.stdout).slice(-1500)}`,
          );
          failed = true;
          break;
        }
      }
      if (failed) continue;
      const n = scaled(lang.iterations);
      const cmd = lang.run(dir, tool, String(n));
      const one = lang.run(dir, tool, '1');
      const first = runTool(cmd[0], cmd[1], { cwd: dir, env, timeoutMs: 900_000 });
      if (!first.ok) {
        skip(lang, tool, 'skipped-run-failed', (first.stderr || first.stdout).slice(-1500));
        continue;
      }
      let got: { ns: number; checksum: string };
      try {
        got = readBack(lang, first);
      } catch (err) {
        skip(lang, tool, 'skipped-run-failed', err instanceof Error ? err.message : String(err));
        continue;
      }
      const want = expectedAt(n);
      if (got.checksum !== want) {
        skip(
          lang,
          tool,
          'skipped-checksum-mismatch',
          `expected ${want} got ${got.checksum} at ${n} iterations`,
        );
        continue;
      }
      prepared.push({
        lang,
        tool,
        cmd,
        one,
        env,
        iterations: n,
        checksum: want,
        ns: [],
        startup: [],
      });
    }
    for (let i = 0; i < SAMPLES; i += 1) {
      for (const p of prepared) {
        const t = performance.now();
        runTool(p.one[0], p.one[1], { env: p.env, timeoutMs: 600_000 });
        p.startup.push(performance.now() - t);
      }
    }
    for (let i = 0; i < SAMPLES; i += 1) {
      for (const p of prepared) {
        const r = runTool(p.cmd[0], p.cmd[1], { env: p.env, timeoutMs: 900_000 });
        if (!r.ok)
          throw new Error(`${p.lang.id}/${kernel.name}: run failed: ${r.stderr.slice(-500)}`);
        const got = readBack(p.lang, r);
        if (got.checksum !== p.checksum)
          throw new Error(
            `${p.lang.id}/${kernel.name}: checksum changed between runs (${got.checksum} vs ${p.checksum})`,
          );
        p.ns.push(got.ns);
      }
    }
    for (const p of prepared) {
      const sm = summarize(p.ns, p.checksum);
      rows[p.lang.id] = {
        status: 'ran',
        family: p.lang.family,
        toolchain: p.tool.version,
        iterations: p.iterations,
        ...sm,
        startupMs: median(p.startup),
        ...(p.lang.timer === undefined ? {} : { timer: p.lang.timer }),
      };
    }
    return rows;
  });
}

const C_BEST_FLAGS = ['-O3', '-march=native'];
const RUST_FLAGS = ['-C', 'opt-level=3', '-C', 'target-cpu=native'];
/** A win against the best-flag baselines is claimed only at this speedup or more. */
const WIN_RATIO = 1.2;

/**
 * A0's direct arm64 path against the fastest of the best-flag baselines (C -O3
 * -march=native, Rust opt-level=3 target-cpu=native, Zig ReleaseFast): win only when the
 * baseline is at least WIN_RATIO slower, loss when A0 is slower beyond the tie band.
 */
function bestFlagVerdict(
  arm64: Sample,
  baselines: Readonly<Record<string, Sample | undefined>>,
): { best: string; bestNsPerCall: number; speedup: number; verdict: 'win' | 'tie' | 'loss' } {
  let best = '';
  let sample: Sample | undefined;
  for (const [id, s] of Object.entries(baselines))
    if (s !== undefined && (sample === undefined || s.medianNsPerCall < sample.medianNsPerCall)) {
      best = id;
      sample = s;
    }
  if (sample === undefined) throw new Error('no best-flag baseline ran');
  const speedup = sample.medianNsPerCall / arm64.medianNsPerCall;
  const v = verdict(arm64, sample);
  return {
    best,
    bestNsPerCall: sample.medianNsPerCall,
    speedup,
    verdict: speedup >= WIN_RATIO ? 'win' : v === 'loss' ? 'loss' : 'tie',
  };
}

function verdict(emitted: Sample, handwritten: Sample): 'win' | 'tie' | 'loss' {
  const ratio = emitted.medianNsPerCall / handwritten.medianNsPerCall;
  const spread = Math.max(
    emitted.maxNsPerCall / emitted.minNsPerCall,
    handwritten.maxNsPerCall / handwritten.minNsPerCall,
  );
  // Tie band: 8 % or the observed sample spread, whichever is larger, but never more than 25 %
  // so a jittery sample set cannot hide a real difference.
  const band = Math.min(Math.max(1.08, spread), 1.25);
  if (ratio < 1 / band) return 'win';
  if (ratio > band) return 'loss';
  return 'tie';
}

async function main(): Promise<void> {
  const clang = findClang();
  const rustc = `${process.env.HOME ?? ''}/.cargo/bin/rustc`;
  const table = LANGUAGES.filter((l) => CLI.langs === null || CLI.langs.has(l.id)).map((lang) => ({
    lang,
    tool: lang.find(),
  }));
  for (const { lang, tool } of table)
    process.stderr.write(
      `${lang.id.padEnd(11)} ${tool === undefined ? 'not found' : tool.version}\n`,
    );
  const results: Record<string, unknown> = {};
  const bestFlag = { win: 0, tie: 0, loss: 0 };
  const perLang: Record<string, LangRow[]> = {};
  const ratios: Record<string, number[]> = {};
  const push = (id: string, ratio: number): void => {
    const list = ratios[id] ?? [];
    list.push(ratio);
    ratios[id] = list;
  };
  for (const k of KERNELS) {
    if (CLI.kernels !== null && !CLI.kernels.has(k.name)) continue;
    const js = await benchJs(k);
    const c = clang.path === undefined ? null : await benchC(k, clang.path, rustc);
    const memo = new Map<number, string>();
    const expectedAt = (n: number): string => {
      if (c !== null && n === scaled(iterations(k))) return c.emitted.checksum;
      let v = memo.get(n);
      if (v === undefined) {
        v = js.checksumAt(n);
        memo.set(n, v);
      }
      return v;
    };
    const rows = await benchLanguages(k, table, expectedAt);
    const startupInterpretersMs: Record<string, number | null> = {};
    const startupCompiledMs: Record<string, number | null> = {};
    for (const { lang } of table) {
      const row = rows[lang.id];
      if (row === undefined) continue;
      const ms = row.startupMs ?? null;
      (lang.startupGroup === 'compiled' ? startupCompiledMs : startupInterpretersMs)[lang.id] = ms;
      if (lang.id === 'typescript') startupInterpretersMs.node = ms;
      const list = perLang[lang.id] ?? [];
      list.push(row);
      perLang[lang.id] = list;
      if (c !== null && row.status === 'ran' && row.medianNsPerCall !== undefined)
        push(lang.id, row.medianNsPerCall / c.emitted.medianNsPerCall);
    }
    if (c !== null) {
      push('c', c.handwritten.medianNsPerCall / c.emitted.medianNsPerCall);
      push('cBest', c.handwrittenBest.medianNsPerCall / c.emitted.medianNsPerCall);
      if (c.rust !== null) push('rust', c.rust.medianNsPerCall / c.emitted.medianNsPerCall);
      if (c.arm64 !== null) push('arm64', c.arm64.medianNsPerCall / c.emitted.medianNsPerCall);
      push('js', js.handwritten.medianNsPerCall / c.emitted.medianNsPerCall);
      push('jsEmitted', js.emitted.medianNsPerCall / c.emitted.medianNsPerCall);
    }
    const python = rows.python;
    const zig = rows.zig;
    const zigSample: Sample | undefined =
      zig?.status === 'ran' && zig.medianNsPerCall !== undefined
        ? {
            medianNsPerCall: zig.medianNsPerCall,
            minNsPerCall: zig.minNsPerCall ?? zig.medianNsPerCall,
            maxNsPerCall: zig.maxNsPerCall ?? zig.medianNsPerCall,
            checksum: zig.checksum ?? '',
            samples: zig.samples ?? 0,
          }
        : undefined;
    const vsBest =
      c === null || c.arm64 === null
        ? null
        : bestFlagVerdict(c.arm64, {
            cO3Native: c.handwrittenBest,
            rustO3Native: c.rust ?? undefined,
            zigReleaseFast: zigSample,
          });
    if (vsBest !== null) bestFlag[vsBest.verdict] += 1;
    results[k.name] = {
      ...(vsBest === null ? {} : { arm64VsBestFlags: vsBest }),
      ...(python === undefined ? {} : { python, pythonIterations: python.iterations }),
      startupInterpretersMs,
      startupCompiledMs,
      c:
        c === null
          ? { status: 'blocked', detail: 'clang not found' }
          : {
              ...c,
              verdict: verdict(c.emitted, c.handwritten),
              verdictVsRust: c.rust === null ? 'blocked' : verdict(c.emitted, c.rust),
              arm64VsEmittedC:
                c.arm64 === null
                  ? (k.noArm64 ?? 'blocked')
                  : {
                      ratio: c.arm64.medianNsPerCall / c.emitted.medianNsPerCall,
                      verdict: verdict(c.arm64, c.emitted),
                    },
            },
      js: {
        emitted: js.emitted,
        handwritten: js.handwritten,
        verdict: verdict(js.emitted, js.handwritten),
      },
      ...rows,
    };
    const cv =
      c === null
        ? 'blocked'
        : `${verdict(c.emitted, c.handwritten)} (${c.emitted.medianNsPerCall.toFixed(3)} vs ${c.handwritten.medianNsPerCall.toFixed(3)} ns)${c.rust === null ? '' : `; vs Rust ${verdict(c.emitted, c.rust)} (${c.rust.medianNsPerCall.toFixed(3)} ns)`}${c.arm64 === null ? '' : `; arm64 ${c.arm64.medianNsPerCall.toFixed(3)} ns (${(c.arm64.medianNsPerCall / c.emitted.medianNsPerCall).toFixed(2)}x C)`}; C-O3-native ${c.handwrittenBest.medianNsPerCall.toFixed(3)} ns${vsBest === null ? '' : `; arm64 vs best-flag ${vsBest.best} ${vsBest.speedup.toFixed(2)}x ${vsBest.verdict}`}`;
    const others = table
      .map(({ lang }) => {
        const row = rows[lang.id];
        return row?.status === 'ran'
          ? `${lang.id} ${row.medianNsPerCall?.toFixed(1)}`
          : `${lang.id} -`;
      })
      .join(' ');
    process.stdout.write(
      `${k.name.padEnd(8)} C: ${cv}   JS: ${verdict(js.emitted, js.handwritten)} (${js.emitted.medianNsPerCall.toFixed(3)} vs ${js.handwritten.medianNsPerCall.toFixed(3)} ns)\n         ns/call: ${others}\n`,
    );
  }
  const geomean = (a: readonly number[] | undefined): number | null =>
    a === undefined || a.length === 0
      ? null
      : Math.exp(a.reduce((s, v) => s + Math.log(v), 0) / a.length);
  const geomeans: Record<string, number | null> = {};
  for (const id of [
    'c',
    'cBest',
    'rust',
    'arm64',
    'js',
    'jsEmitted',
    ...table.map((t) => t.lang.id),
  ])
    geomeans[id] = geomean(ratios[id]);
  const languages: Record<string, unknown> = {};
  const skipped: Record<string, string> = {};
  for (const { lang, tool } of table) {
    const rowsOf = perLang[lang.id] ?? [];
    const bad = rowsOf.find((r) => r.status !== 'ran');
    const ran = rowsOf.filter((r) => r.status === 'ran').length;
    languages[lang.id] = {
      label: lang.label,
      family: lang.family,
      toolchain: tool?.version ?? null,
      status: bad === undefined ? 'ran' : bad.status,
      kernelsRan: ran,
      kernelsTotal: rowsOf.length,
      iterations: scaled(lang.iterations),
      startupGroup: lang.startupGroup,
      ...(lang.timer === undefined ? {} : { timer: lang.timer }),
      ...(bad === undefined ? {} : { detail: bad.detail }),
    };
    if (bad !== undefined) skipped[lang.id] = `${bad.status}: ${bad.detail ?? ''}`.slice(0, 300);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    clang: clang.version ?? null,
    rustc: (() => {
      const r = runTool(rustc, ['--version'], { timeoutMs: 10_000 });
      return r.ok ? r.stdout.trim() : null;
    })(),
    flags: {
      c: '-std=c11 -O2 (no sanitizer); handwrittenBest: -std=c11 -O3 -march=native',
      js: 'Node default JIT, in-process, warm',
      rust: '-C opt-level=3 -C target-cpu=native',
      table:
        'see tools/exec-bench-languages*.ts: clang++ -std=c++17 -O2, javac/java and the other JVM and .NET languages with a warm-up pass then a timed pass in one process, kotlinc -include-runtime, scala-cli assembly, dotnet -c Release, go build, swiftc -O, zig -O ReleaseFast, dart compile exe, nim -d:release, crystal --release, ldc2 -O3, fpc -O2, gfortran -O2, ghc -O2, ocamlopt -O3, csc -O3, cobc -O2, v -prod, odin -o:speed, valac -X -O2; interpreters and VMs at their defaults',
    },
    iterationsPerSample: {
      c: scaled(ITER),
      js: scaled(ITER / 4),
      python: scaled(TIER.interpreted),
      ...Object.fromEntries(table.map(({ lang }) => [lang.id, scaled(lang.iterations)])),
    },
    samplesPerSide: SAMPLES,
    scale: SCALE,
    loadAverage: (await import('node:os')).loadavg(),
    meaning:
      'Steady-state ns per call including the input generator loop, interleaved emitted/hand-written runs, median of samples; verdict is tie when within observed sample spread. Adversarial set: tiny function, no-op computation, call-boundary chain, branching, value-semantics array fill, 64-step loop. startupMs is the wall time of one process launch running a single iteration (spawn-dominated, both sides identical toolchain); startupCompiledMs and startupInterpretersMs hold the same measurement for every baseline language. arm64 is the direct AArch64 backend (no C for the program) called out of line from the same C driver, so it pays a real call per iteration that the inlined C paths do not; its ratio is against the emitted-C path. Every baseline row carries family, toolchain, and status; a row whose checksum did not match the A0 result for the same iteration count is skipped-checksum-mismatch and has no timing. geomeans maps each baseline to the geometric mean over kernels of (baseline median ns / A0 emitted-C median ns), so 1.0 is parity and 50 means A0 native is 50x faster per call. loadAverage is the 1/5/15-minute load when the report was written (a value far above the core count means the timings were taken under load). Not energy or application evidence. A tie is the expected result for kernels reaching the same optimizer; losses are kept.',
    geomeans,
    arm64VsBestFlags: {
      ...bestFlag,
      rule: `A0 arm64 against the fastest of C -O3 -march=native, Rust opt-level=3 target-cpu=native and Zig ReleaseFast; win only at >= ${WIN_RATIO}x, loss when slower beyond the tie band`,
    },
    languages,
    skipped,
    kernels: results,
  };
  await mkdir(join(CLI.out, '..'), { recursive: true });
  await writeFile(CLI.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
