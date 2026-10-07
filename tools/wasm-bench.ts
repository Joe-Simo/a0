/**
 * A0's direct wasm32 backend (src/wasm.ts) against clang -O3 --target=wasm32 on the exec-bench
 * kernels, both executed by Node's V8 in one process.
 *
 * Each side is one module holding the kernel and the same driver `wb_run(n, h)`: n dependent
 * trips of `h = h*5 + K(a0, a1, a2)` with a0 = h ^ i*2654435761 and each later argument a
 * xorshift-multiply of the previous one (nonlinear, so no kernel reduces to a closed form), so no
 * trip can be hoisted or folded away and the whole loop runs inside wasm (no JS boundary per
 * call). The A0 side writes the driver in A0 (`fold` over a body that calls the kernel) and is
 * compiled by `compile(program, 'wasm')`; the clang side is the kernel's hand-written C from
 * tools/exec-bench-kernels.ts with the driver as a C loop, built -O3 freestanding with wasm-ld.
 * Both results must be equal for the timed trip count before anything is reported.
 *
 * Reported per kernel: module bytes, load time (WebAssembly.compile + instantiate of the bytes,
 * median over samples, alternating sides), and run time in ns per trip (median over samples;
 * every sample runs A0 then clang, or clang then A0 on odd samples, after a warm-up long
 * enough for V8's TurboFan tier). Wins and losses are recorded as they come out.
 *
 * Usage: bun run wasm-bench [-- --samples=N --scale=N --kernels=a,b --unroll=1|2|4 --out=PATH]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { COMPILER_VERSION, compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { findWasmClang, runTool, withTempDir } from '../src/toolchain.js';
import { wasmModuleBytes } from '../src/wasm.js';
import { KERNELS, type Kernel } from './exec-bench-kernels.js';
import { loadGate, waitQuiet } from './quiet.js';
import { writeReport } from './scrub-results.js';
import { loadSource, systemLoadTriple } from './system-load.js';

const ARGS = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k ?? '', v ?? ''] as const;
    }),
);
const SAMPLES = Number(ARGS.get('samples') ?? 15);
const SCALE = Number(ARGS.get('scale') ?? 1);
const ONLY = ARGS.has('kernels') ? new Set((ARGS.get('kernels') ?? '').split(',')) : null;
const UNROLL = Number(ARGS.get('unroll') ?? 1) as 1 | 2 | 4;
const OUT = ARGS.get('out') ?? 'results/wasm-benchmark.json';
/** Trips per timed call before a kernel's iterScale. */
const TRIPS = 5_000_000;

const MULS = ['2654435761', '2246822519', '3266489917'] as const;

/** A0 driver: `wb_step` derives the kernel arguments from (h, i); `wb_run` folds it n times. */
function a0Driver(k: Kernel): string {
  const lines = ['fn wb_step u32 u32 -> u32', `x mul p1 ${MULS[0]}`, 'a0 xor p0 x'];
  for (let j = 1; j < k.arity; j += 1)
    lines.push(`s${j} shr a${j - 1} 15`, `t${j} xor a${j - 1} s${j}`, `a${j} mul t${j} ${MULS[j]}`);
  const args = Array.from({ length: k.arity }, (_, j) => `a${j}`).join(' ');
  lines.push(`r call ${k.name} ${args}`, 'm mul p0 5', 'h add m r', 'ret h', 'end');
  return `${k.a0}\n${lines.join('\n')}\nfn wb_run u32 u32 -> u32\nr fold wb_step p0 p1\nret r\nend\n`;
}

function cDriver(k: Kernel): string {
  const args = Array.from({ length: k.arity }, (_, j) => `a${j}`).join(', ');
  const derive = Array.from({ length: k.arity - 1 }, (_, j) => {
    const n = j + 1;
    return `uint32_t a${n} = (a${n - 1} ^ (a${n - 1} >> 15)) * ${MULS[n]}u;`;
  }).join(' ');
  return `typedef unsigned int uint32_t;
${k.c}
__attribute__((export_name("wb_run"))) uint32_t wb_run(uint32_t n, uint32_t h) {
  for (uint32_t i = 0; i < n; i++) {
    uint32_t a0 = h ^ (i * ${MULS[0]}u); ${derive}
    h = h * 5u + hw_${k.name}(${args});
  }
  return h;
}
`;
}

type Run = (n: number, h: number) => number;

async function load(
  bytes: Uint8Array<ArrayBuffer>,
  entry: string,
): Promise<{ run: Run; ms: number }> {
  const t0 = performance.now();
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  const ms = performance.now() - t0;
  return { run: instance.exports[entry] as Run, ms };
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

interface Row {
  readonly kernel: string;
  readonly trips: number;
  readonly checksum: number;
  readonly bytes: { readonly a0: number; readonly clang: number };
  readonly loadMs: { readonly a0: number; readonly clang: number };
  readonly nsPerTrip: { readonly a0: number; readonly clang: number };
  /** clang ns / A0 ns: above 1 means A0 is faster. */
  readonly speedup: number;
  readonly verdict: 'win' | 'tie' | 'loss';
}

async function benchKernel(k: Kernel, clang: string, dir: string): Promise<Row> {
  const program = parseAndValidate(a0Driver(k));
  const a0Bytes = new Uint8Array(
    wasmModuleBytes(compile(program, 'wasm', { wasmExports: ['wb_run'], wasmUnroll: UNROLL }).text),
  );
  const cPath = join(dir, `${k.name}.c`);
  const wPath = join(dir, `${k.name}.wasm`);
  await writeFile(cPath, cDriver(k));
  const r = runTool(clang, [
    '--target=wasm32',
    '-O3',
    '-nostdlib',
    '-fuse-ld=lld',
    '-Wl,--no-entry',
    '-o',
    wPath,
    cPath,
  ]);
  if (r.status !== 0) throw new Error(`clang ${k.name}: ${r.stderr}`);
  const clangBytes = new Uint8Array(await readFile(wPath));

  const trips = Math.max(1, Math.floor(TRIPS / (k.iterScale ?? 1) / SCALE));
  const seed = 0x9e3779b9;
  const loads = { a0: [] as number[], clang: [] as number[] };
  let a0 = await load(a0Bytes, 'a0_wb_run');
  let cl = await load(clangBytes, 'wb_run');
  const want = a0.run(trips, seed) >>> 0;
  const got = cl.run(trips, seed) >>> 0;
  if (want !== got) throw new Error(`${k.name}: checksum mismatch a0=${want} clang=${got}`);
  for (let s = 0; s < SAMPLES; s += 1) {
    const order = s % 2 === 0 ? (['a0', 'clang'] as const) : (['clang', 'a0'] as const);
    for (const side of order) {
      const l = await load(
        side === 'a0' ? a0Bytes : clangBytes,
        side === 'a0' ? 'a0_wb_run' : 'wb_run',
      );
      loads[side].push(l.ms);
      if (side === 'a0') a0 = l;
      else cl = l;
    }
  }
  // Warm-up: enough trips for V8 to tier both modules up to TurboFan.
  for (let w = 0; w < 3; w += 1) {
    a0.run(trips, seed + w);
    cl.run(trips, seed + w);
  }
  const ns = { a0: [] as number[], clang: [] as number[] };
  for (let s = 0; s < SAMPLES; s += 1) {
    const order = s % 2 === 0 ? (['a0', 'clang'] as const) : (['clang', 'a0'] as const);
    for (const side of order) {
      const f = side === 'a0' ? a0.run : cl.run;
      const t0 = performance.now();
      const v = f(trips, seed) >>> 0;
      const dt = performance.now() - t0;
      if (v !== want) throw new Error(`${k.name}: ${side} result changed`);
      ns[side].push((dt * 1e6) / trips);
    }
  }
  const nsA0 = median(ns.a0);
  const nsClang = median(ns.clang);
  const speedup = nsClang / nsA0;
  return {
    kernel: k.name,
    trips,
    checksum: want,
    bytes: { a0: a0Bytes.length, clang: clangBytes.length },
    loadMs: { a0: median(loads.a0), clang: median(loads.clang) },
    nsPerTrip: { a0: nsA0, clang: nsClang },
    speedup,
    verdict: speedup > 1.05 ? 'win' : speedup < 1 / 1.05 ? 'loss' : 'tie',
  };
}

async function main(): Promise<void> {
  const tool = findWasmClang();
  if (tool.path === undefined || tool.wasmLd === undefined)
    throw new Error('wasm-bench needs a clang with the wasm32 target and wasm-ld');
  const clang = tool.path;
  const rows: Row[] = [];
  await withTempDir(async (dir) => {
    for (const k of KERNELS) {
      if (ONLY !== null && !ONLY.has(k.name)) continue;
      waitQuiet();
      const row = await benchKernel(k, clang, dir);
      rows.push(row);
      console.log(
        `${row.kernel.padEnd(10)} bytes ${String(row.bytes.a0).padStart(5)} vs ${String(row.bytes.clang).padStart(5)}  load ${row.loadMs.a0.toFixed(3)} vs ${row.loadMs.clang.toFixed(3)} ms  run ${row.nsPerTrip.a0.toFixed(3)} vs ${row.nsPerTrip.clang.toFixed(3)} ns/trip  ${row.speedup.toFixed(2)}x ${row.verdict}`,
      );
    }
  });
  const geomean = Math.exp(rows.reduce((n, r) => n + Math.log(r.speedup), 0) / rows.length);
  console.log(`geomean clang/A0 run time: ${geomean.toFixed(3)} (above 1: A0 faster)`);
  const report = {
    compiler: COMPILER_VERSION,
    engine: `node ${process.version} (V8 ${process.versions.v8})`,
    clang: `${clang} (${tool.version ?? 'unknown'}), -O3 --target=wasm32 -nostdlib, wasm-ld --no-entry`,
    platform: `${process.platform}-${process.arch}`,
    loadAverage: systemLoadTriple(),
    loadSource: loadSource(),
    loadGate: loadGate(),
    samples: SAMPLES,
    method:
      'Same driver on both sides (n dependent trips of h = h*5 + K(args(h, i)), run inside the module). A0: kernel and driver in A0, direct wasm32 backend. clang: hand-written C kernel from tools/exec-bench-kernels.ts, driver as a C loop. Medians over interleaved samples after warm-up; load = WebAssembly.compile + instantiate.',
    geomeanSpeedup: geomean,
    rows,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeReport(OUT, report);
  console.log(`wrote ${OUT}`);
}

await main();
