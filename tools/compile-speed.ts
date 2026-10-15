/**
 * Compile speed, peak memory and output size, head to head: the shipped `a0` executable compiling a
 * realistic program to wasm, C and JS, against the toolchains of this machine on equivalent input.
 *
 * Programs:
 *   compiler  compiler/boot.a0 with everything it `use`s: the self-hosted compiler's own linked sources.
 *   gen100    tools/corpus.ts generateCorpus(CORPUS_SEED, 100): a 100-function generated program.
 *
 * Subjects (each a fresh process; wall time, peak RSS from the child's rusage, output bytes):
 *   a0 emit wasm   the shipped executable (tools/release.sh flags, check-latency BINARY_FLAGS), direct wasm
 *                  against clang -O2 wasm32 + wasm-ld (src/toolchain.ts WASM_FLAGS) on the equivalent C.
 *   a0 emit js     against tsc (node_modules TypeScript) transpiling the equivalent JS (--allowJs, emit),
 *                  and esbuild where it is installed (absent otherwise, with the reason).
 *   a0 emit c      no competitor does this translation; recorded alone.
 *   a0 x86_64 object  on an x86-64 host: the direct x86-64 backend (`a0 emit x86_64`, assembly text) and the
 *                  system assembler (`clang -c -x assembler`) as one pipeline, `sh -c` running both (wall
 *                  time of the pair; peak RSS the larger of the two, which os.wait4 of the shell reports),
 *                  against clang -O2 compiling the equivalent C to a native object. `a0 emit x86_64` alone
 *                  is recorded beside it (assembly bytes, not judged).
 * The equivalent C and JS are A0's own C and JS output for the program, written once before the clock
 * starts: the same functions, the same types, the same bodies. A hand-written C or TS program would be
 * shorter; this is the only equivalent input that exists for both programs, and the report says so.
 *
 * Method: 1 warmup round, then N >= 7 measured rounds (clang on the compiler program takes tens of
 * seconds per sample); each round samples every subject once in a rotating order (interleaved), after the
 * load gate (tools/quiet.ts, limit 10); medians with min and max. Verdicts use check-latency's judge:
 * the loss ledger's tie band (8 %, or the larger observed max/min spread, never above 25 %); output bytes
 * are deterministic and judged with a 2 % band (tools/loss-ledger.ts wasm-bytes).
 *
 * Needs python3 for the per-child rusage (os.wait4) and bun to build the shipped executable:
 *   bun run compile-speed [-- --out results/compile-speed-<platform>.json] [--runs 7]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform as osPlatform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CACHE_DIR } from '../src/cache.js';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, findWasmClang, WASM_FLAGS } from '../src/toolchain.js';
import { BINARY_FLAGS, judge, LOAD_LIMIT, type Stats, stats } from './check-latency.js';
import { CORPUS_SEED, generateCorpus } from './corpus.js';
import { loadGate, waitQuiet } from './quiet.js';
import { writeReport } from './scrub-results.js';
import { loadSource, systemLoad } from './system-load.js';

export const MIN_RUNS = 7;
export const WARMUPS = 1;
/** Output bytes are deterministic: tools/loss-ledger.ts judges wasm-bytes with this band. */
export const BYTES_BAND = 0.02;

/**
 * Runs one command and reports its own wall time and peak RSS: os.wait4 returns the rusage of exactly
 * that child (ru_maxrss: bytes on macOS, KiB on Linux). The clock runs from fork to reap inside the
 * wrapper, so the wrapper's own start is not timed. getrusage(RUSAGE_CHILDREN), what a long-lived parent sees, is the
 * maximum over every child reaped so far, not this child's peak.
 */
const WAIT4 = [
  'import os,sys,time',
  'c=sys.argv[1:]',
  't=time.perf_counter()',
  'p=os.fork()',
  'if p==0:',
  ' f=os.open(os.devnull,os.O_WRONLY);os.dup2(f,1)',
  ' os.execvp(c[0],c)',
  '_,st,ru=os.wait4(p,0)',
  'ms=(time.perf_counter()-t)*1000',
  'rss=ru.ru_maxrss*(1 if sys.platform=="darwin" else 1024)',
  'sys.stdout.write("%d %.3f %d"%(os.waitstatus_to_exitcode(st),ms,rss))',
].join('\n');

interface Sample {
  readonly code: number;
  readonly ms: number;
  readonly rssBytes: number;
  readonly stderr: string;
}

function sample(cmd: readonly string[], cwd: string): Sample {
  // The cache lives in cwd (deleted before every run); an inherited A0_CACHE_DIR or A0_NO_CACHE
  // would move or disable it, so neither reaches the child.
  const { A0_CACHE_DIR: _d, A0_NO_CACHE: _n, ...env } = process.env;
  const r = spawnSync('python3', ['-c', WAIT4, ...cmd], { cwd, env, encoding: 'utf8' });
  const [code, ms, rss] = (r.stdout ?? '').trim().split(' ').map(Number);
  if (r.status !== 0 || code === undefined || ms === undefined || rss === undefined)
    throw new Error(`python3 wait4 wrapper failed: ${r.stderr ?? r.error?.message ?? ''}`);
  return { code, ms, rssBytes: rss, stderr: r.stderr ?? '' };
}

export interface Measured {
  readonly ms: Stats;
  /** Peak resident set of the process, bytes. */
  readonly rssBytes: Stats;
  /** Bytes of the file the subject wrote (deterministic; the last sample's). */
  readonly outputBytes: number;
}

export type Metric = 'compile-ms' | 'compile-rss-bytes' | 'compile-output-bytes';

export interface CompileComparison {
  readonly program: string;
  readonly target: 'wasm' | 'js' | 'native';
  readonly competitor: string;
  readonly metric: Metric;
  readonly a0: number;
  readonly other: number;
  readonly gap: number;
  readonly band: number;
  readonly ratio: number;
  readonly verdict: 'win' | 'tie' | 'loss';
}

export interface CompileSpeedReport {
  readonly version: 1;
  readonly platform: string;
  readonly arch: string;
  readonly bun: string;
  readonly cpus: number;
  readonly load: {
    readonly source: string;
    readonly limit: number;
    readonly max: number;
    readonly start: number;
    readonly end: number;
    readonly waits: number;
  };
  readonly method: {
    readonly runs: number;
    readonly warmups: number;
    readonly interleaved: true;
    readonly notes: readonly string[];
  };
  readonly tools: Record<string, { available: boolean; version?: string; reason?: string }>;
  readonly programs: Record<
    string,
    {
      readonly source: string;
      readonly lines: number;
      readonly bytes: number;
      readonly functions: number;
      readonly cBytes: number;
      readonly jsBytes: number;
      readonly subjects: Record<string, Measured>;
    }
  >;
  readonly comparisons: readonly CompileComparison[];
}

interface Subject {
  readonly program: string;
  readonly name: string;
  readonly cwd: string;
  readonly cmd: string[];
  readonly out: string;
}

const lineCount = (t: string): number => t.split('\n').length - (t.endsWith('\n') ? 1 : 0);

function version(cmd: string[]): string {
  const s = spawnSync(cmd[0] as string, cmd.slice(1), { encoding: 'utf8' });
  return `${s.stdout ?? ''}${s.stderr ?? ''}`.trim().split('\n')[0] ?? '';
}

export function compareRow(
  program: string,
  target: 'wasm' | 'js' | 'native',
  competitor: string,
  metric: Metric,
  a0: Stats | number,
  other: Stats | number,
): CompileComparison {
  if (typeof a0 === 'number' || typeof other === 'number') {
    const a = typeof a0 === 'number' ? a0 : a0.median;
    const b = typeof other === 'number' ? other : other.median;
    const gap = a / b - 1;
    return {
      program,
      target,
      competitor,
      metric,
      a0: a,
      other: b,
      gap: Math.round(gap * 1e6) / 1e6,
      band: BYTES_BAND,
      ratio: Math.round((b / a) * 1e6) / 1e6,
      verdict: gap < -BYTES_BAND ? 'win' : gap > BYTES_BAND ? 'loss' : 'tie',
    };
  }
  const j = judge(a0, other);
  return { program, target, competitor, metric, a0: a0.median, other: other.median, ...j };
}

export async function measure(opts: { runs: number }): Promise<CompileSpeedReport> {
  const runs = Math.max(opts.runs, MIN_RUNS);
  const plat = osPlatform();
  const arch = process.arch;
  const startLoad = systemLoad();
  const dir = await mkdtemp(join(tmpdir(), 'a0-compile-speed-'));
  const tools: CompileSpeedReport['tools'] = {};

  // The shipped executable, built as tools/release.sh builds it for the host target.
  const a0Js = fileURLToPath(new URL('../src/a0.js', import.meta.url));
  const a0Bin = join(dir, plat === 'win32' ? 'a0.exe' : 'a0');
  const built = spawnSync('bun', ['build', ...BINARY_FLAGS, a0Js, '--outfile', a0Bin], {
    encoding: 'utf8',
  });
  if (built.status !== 0 || !existsSync(a0Bin))
    throw new Error(`bun build --compile failed: ${built.stderr ?? built.error?.message}`);
  const bunVersion = version(['bun', '--version']);
  const a0Version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
    .version;
  tools.a0 = {
    available: true,
    version: `A0 ${a0Version} (bun ${bunVersion}, ${BINARY_FLAGS.join(' ')}, ${plat}-${arch})`,
  };

  const clang = findWasmClang();
  const haveClang = clang.path !== undefined && clang.wasmLd !== undefined;
  tools.clang = haveClang
    ? { available: true, version: version([clang.path as string, '--version']) }
    : { available: false, reason: 'no clang with the wasm32 target and a wasm-ld' };
  // The native pipeline needs an x86-64 host (the backend's output runs there) and a clang to assemble.
  const nativeClang = findClang().path;
  const native =
    arch === 'x64' && (plat === 'linux' || plat === 'darwin') && nativeClang !== undefined;
  tools.native = native
    ? { available: true, version: version([nativeClang as string, '--version']) }
    : {
        available: false,
        reason: `the a0 x86_64 object row needs an x86-64 Linux or macOS host with clang; found ${plat}-${arch}`,
      };
  const req = createRequire(import.meta.url);
  const tscJs = req.resolve('typescript/lib/tsc.js');
  tools.tsc = {
    available: true,
    version: `TypeScript ${version(['node', tscJs, '--version']).replace(/^Version /, '')}`,
  };
  let esbuild: string | undefined;
  try {
    const pkg = req.resolve('esbuild/package.json');
    const bin = join(pkg, '..', 'bin', 'esbuild');
    if (existsSync(bin)) esbuild = bin;
  } catch {}
  tools.esbuild =
    esbuild === undefined
      ? {
          available: false,
          reason: 'esbuild is not installed (not a dependency of this repository)',
        }
      : { available: true, version: version([esbuild, '--version']) };

  // The programs, and their equivalent C and JS (A0's own output, written before any clock starts).
  const compilerSrc = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
  const gen = generateCorpus(CORPUS_SEED, 100);
  const programs: [string, string, string, number][] = [
    ['compiler', 'compiler/boot.a0 (linked)', formatProgram(compilerSrc), compilerSrc.byName.size],
    [
      'gen100',
      'tools/corpus.ts generateCorpus(CORPUS_SEED, 100)',
      formatProgram(gen),
      gen.byName.size,
    ],
  ];
  const subjects: Subject[] = [];
  const info: Record<
    string,
    {
      source: string;
      lines: number;
      bytes: number;
      functions: number;
      cBytes: number;
      jsBytes: number;
    }
  > = {};
  for (const [name, source, text, functions] of programs) {
    const pd = join(dir, name);
    await mkdir(join(pd, 'out'), { recursive: true });
    await writeFile(join(pd, 'p.a0'), text, 'utf8');
    for (const t of ['c', 'js']) {
      const r = sample([a0Bin, 'emit', t, 'p.a0', `eq.${t}`], pd);
      if (r.code !== 0) throw new Error(`a0 emit ${t} ${name}: ${r.stderr}`);
    }
    info[name] = {
      source,
      lines: lineCount(text),
      bytes: Buffer.byteLength(text),
      functions,
      cBytes: statSync(join(pd, 'eq.c')).size,
      jsBytes: statSync(join(pd, 'eq.js')).size,
    };
    const add = (sub: string, cmd: string[], out: string): void => {
      subjects.push({ program: name, name: sub, cwd: pd, cmd, out: join(pd, out) });
    };
    add('a0 emit wasm', [a0Bin, 'emit', 'wasm', 'p.a0', 'out/a0.wasm'], 'out/a0.wasm');
    add('a0 emit js', [a0Bin, 'emit', 'js', 'p.a0', 'out/a0.js'], 'out/a0.js');
    add('a0 emit c', [a0Bin, 'emit', 'c', 'p.a0', 'out/a0.c'], 'out/a0.c');
    if (native) {
      add('a0 emit x86_64', [a0Bin, 'emit', 'x86_64', 'p.a0', 'out/a0.s'], 'out/a0.s');
      add(
        'a0 x86_64 object',
        [
          'sh',
          '-c',
          '"$0" emit x86_64 p.a0 out/a0x.s && "$1" -c -x assembler out/a0x.s -o out/a0.o',
          a0Bin,
          nativeClang as string,
        ],
        'out/a0.o',
      );
    }
    if (native || haveClang)
      add(
        'clang native object',
        [(native ? nativeClang : clang.path) as string, '-O2', '-c', 'eq.c', '-o', 'out/clang.o'],
        'out/clang.o',
      );
    if (haveClang) {
      add(
        'clang wasm32',
        [
          clang.path as string,
          ...WASM_FLAGS,
          `-B${join(clang.wasmLd as string, '..')}`,
          'eq.c',
          '-o',
          'out/clang.wasm',
        ],
        'out/clang.wasm',
      );
    }
    add(
      'tsc',
      ['node', tscJs, '--allowJs', '--target', 'es2022', '--outDir', 'out/tsc', 'eq.js'],
      'out/tsc/eq.js',
    );
    if (esbuild !== undefined)
      add(
        'esbuild',
        [esbuild, 'eq.js', '--outfile=out/esbuild.js', '--target=es2022'],
        'out/esbuild.js',
      );
  }

  const samples = new Map<Subject, { ms: number[]; rss: number[]; bytes: number }>();
  for (const s of subjects) samples.set(s, { ms: [], rss: [], bytes: 0 });
  let maxLoad = startLoad;
  for (let round = 0; round < WARMUPS + runs; round += 1) {
    const order = subjects.map((_, i) => subjects[(i + round) % subjects.length] as Subject);
    for (const s of order) {
      waitQuiet();
      maxLoad = Math.max(maxLoad, systemLoad());
      await rm(s.out, { force: true });
      if (s.name === 'a0 x86_64 object') await rm(join(s.cwd, 'out', 'a0x.s'), { force: true });
      // Every run is cold: the CLI's per-function emission cache (src/cache.ts, .a0-cache in the
      // working directory) starts empty, as for a user compiling once. Reusing it across the warmup
      // and timed rounds measured a warm cache, not a compile.
      await rm(join(s.cwd, DEFAULT_CACHE_DIR), { recursive: true, force: true });
      const r = sample(s.cmd, s.cwd);
      if (r.code !== 0) throw new Error(`${s.program} ${s.name} failed: ${r.stderr.slice(0, 500)}`);
      if (round < WARMUPS) continue;
      const rec = samples.get(s) as { ms: number[]; rss: number[]; bytes: number };
      rec.ms.push(r.ms);
      rec.rss.push(r.rssBytes);
      rec.bytes = statSync(s.out).size;
    }
    process.stderr.write(`round ${round + 1}/${WARMUPS + runs}\n`);
  }

  const out: CompileSpeedReport['programs'] = {};
  for (const [name] of programs) {
    const subs: Record<string, Measured> = {};
    for (const s of subjects.filter((x) => x.program === name)) {
      const rec = samples.get(s) as { ms: number[]; rss: number[]; bytes: number };
      subs[s.name] = { ms: stats(rec.ms), rssBytes: stats(rec.rss), outputBytes: rec.bytes };
    }
    out[name] = { ...(info[name] as (typeof info)[string]), subjects: subs };
  }
  const comparisons: CompileComparison[] = [];
  for (const [name, p] of Object.entries(out)) {
    const pairs: ['wasm' | 'js' | 'native', string, string, boolean][] = [
      ['wasm', 'a0 emit wasm', 'clang wasm32', true],
      ['native', 'a0 x86_64 object', 'clang native object', true],
      ['js', 'a0 emit js', 'tsc', false],
      ['js', 'a0 emit js', 'esbuild', false],
    ];
    for (const [target, mine, theirs, bytes] of pairs) {
      const a = p.subjects[mine];
      const b = p.subjects[theirs];
      if (a === undefined || b === undefined) continue;
      comparisons.push(compareRow(name, target, theirs, 'compile-ms', a.ms, b.ms));
      comparisons.push(
        compareRow(name, target, theirs, 'compile-rss-bytes', a.rssBytes, b.rssBytes),
      );
      if (bytes)
        comparisons.push(
          compareRow(name, target, theirs, 'compile-output-bytes', a.outputBytes, b.outputBytes),
        );
    }
  }
  const gate = loadGate();
  await rm(dir, { recursive: true, force: true });
  return {
    version: 1,
    platform: plat,
    arch,
    bun: bunVersion,
    cpus: cpus().length,
    load: {
      source: loadSource(),
      limit: LOAD_LIMIT,
      max: Math.round(Math.max(maxLoad, gate.highestLoadAtSampleStart) * 100) / 100,
      start: Math.round(startLoad * 100) / 100,
      end: Math.round(systemLoad() * 100) / 100,
      waits: gate.waits,
    },
    method: {
      runs,
      warmups: WARMUPS,
      interleaved: true,
      notes: [
        'Every a0 run is cold: the per-function emission cache (.a0-cache) is deleted before each run, warmup and timed alike, so the CLI emits and writes every function as a user compiling once does.',
        'Every subject is a fresh process; wall time from spawn to exit, peak RSS from os.wait4 of exactly that child (a python3 wrapper; RUSAGE_CHILDREN of a long-lived parent is a running maximum, not the child peak).',
        'The equivalent C and JS are the A0 compiler output for the same program, written before the clock starts; clang and tsc compile exactly what A0 would hand them.',
        'clang wasm32 uses src/toolchain.ts WASM_FLAGS (-O2, freestanding, wasm-ld, --export-all); a0 emit wasm is the direct wasm backend. Both export every function.',
        'tsc transpiles the JS with --allowJs --target es2022 (it also parses and binds it); it is the only JS compiler installed here.',
        'a0 emit c has no competitor and is not judged.',
        'a0 x86_64 object is a0 emit x86_64 (the direct backend) then clang -c -x assembler, run by one sh -c: the time is the pair, the RSS the larger peak. It is judged against clang -O2 -c of the equivalent C (clang native object): both end at a native object file. a0 emit x86_64 alone (assembly text) is recorded and not judged.',
        'Output bytes are deterministic and judged with a 2 % band; times and RSS with the tie band of tools/check-latency.ts judge.',
      ],
    },
    tools,
    programs: out,
    comparisons,
  };
}

export function renderTable(r: CompileSpeedReport): string {
  const lines = [
    `compile speed, ${r.platform}-${r.arch}, ${r.method.runs} runs, load max ${r.load.max}`,
  ];
  for (const [name, p] of Object.entries(r.programs)) {
    lines.push(`${name}: ${p.lines} lines, ${p.functions} functions`);
    for (const [s, m] of Object.entries(p.subjects))
      lines.push(
        `  ${s.padEnd(20)} ${m.ms.median.toFixed(0).padStart(7)} ms  ${(m.rssBytes.median / 1e6).toFixed(0).padStart(5)} MB  ${String(m.outputBytes).padStart(9)} B`,
      );
  }
  for (const c of r.comparisons)
    lines.push(
      `  ${c.program}/${c.target} ${c.metric} vs ${c.competitor}: ${c.verdict} (gap ${(c.gap * 100).toFixed(1)} %, band ${(c.band * 100).toFixed(1)} %)`,
    );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = (f: string): string | undefined => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outPath =
    at('--out') ?? join('results', `compile-speed-${osPlatform()}-${process.arch}.json`);
  const report = await measure({ runs: Number(at('--runs') ?? MIN_RUNS) });
  await writeReport(outPath, report);
  process.stdout.write(`${renderTable(report)}\nwrote ${outPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
