/**
 * Paired comparison of A0 wasm emission variants against clang, in one process. For every
 * exec-bench kernel it compiles the wb_run driver of tools/wasm-bench.ts with each A0 unroll
 * setting (`WasmEmitOptions.unroll`: copies of a small inlined fold body per loop back edge) and
 * once with clang -O3 --target=wasm32, then times all of them round robin (each sample rotates
 * the order), so a drifting machine moves every variant together. Medians of ns per trip, the
 * ratio against clang per variant, and the geometric mean of that ratio over the kernels.
 *
 * `--save-modules=DIR` saves each A0 module as KERNEL.unrollN.wasm. A later run can load those
 * with `--baseline=DIR` to compare compiler revisions in the same interleaved sample groups.
 *
 * Usage: bun run wasm-ab [-- --samples=N --unroll=1,2,4 --kernels=a,b --out=PATH
 *                         --save-modules=DIR --baseline=DIR --baseline-label=LABEL]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { COMPILER_VERSION, compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { findWasmClang, runTool, WASM_CLANG_REF_FLAGS, withTempDir } from '../src/toolchain.js';
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
const SAMPLES = Number(ARGS.get('samples') ?? 21);
const UNROLLS = (ARGS.get('unroll') ?? '1,2,4').split(',').map(Number) as (1 | 2 | 4)[];
const ONLY = ARGS.has('kernels') ? new Set((ARGS.get('kernels') ?? '').split(',')) : null;
const OUT = ARGS.get('out') ?? 'results/wasm-unroll.json';
const BASELINE = ARGS.get('baseline');
const SAVE_MODULES = ARGS.get('save-modules');
const TRIPS = 5_000_000;
const MULS = ['2654435761', '2246822519', '3266489917'] as const;

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
typedef unsigned char uint8_t;
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
interface Subject {
  readonly label: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly entry: string;
  run?: Run;
  readonly ns: number[];
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

async function main(): Promise<void> {
  if (
    BASELINE !== undefined &&
    SAVE_MODULES !== undefined &&
    resolve(BASELINE) === resolve(SAVE_MODULES)
  )
    throw new Error('--baseline and --save-modules must use different directories');
  const tool = findWasmClang();
  if (tool.path === undefined || tool.wasmLd === undefined)
    throw new Error('wasm-ab needs a clang with the wasm32 target and wasm-ld');
  const clang = tool.path;
  const rows: {
    kernel: string;
    trips: number;
    checksum: number;
    nsPerTrip: Record<string, number>;
    samplesNsPerTrip: Record<string, readonly number[]>;
    ratioToClang: Record<string, number>;
    bytes: Record<string, number>;
    moduleSha256: Record<string, string>;
  }[] = [];
  if (SAVE_MODULES !== undefined) await mkdir(SAVE_MODULES, { recursive: true });
  await withTempDir(async (dir) => {
    for (const k of KERNELS) {
      if (ONLY !== null && !ONLY.has(k.name)) continue;
      waitQuiet();
      const cPath = join(dir, `${k.name}.c`);
      const wPath = join(dir, `${k.name}.wasm`);
      await writeFile(cPath, cDriver(k));
      const r = runTool(clang, [...WASM_CLANG_REF_FLAGS, '-o', wPath, cPath]);
      if (r.status !== 0) throw new Error(`clang ${k.name}: ${r.stderr}`);
      const subjects: Subject[] = [
        { label: 'clang', bytes: new Uint8Array(await readFile(wPath)), entry: 'wb_run', ns: [] },
      ];
      for (const u of UNROLLS) {
        const filename = `${k.name}.unroll${u}.wasm`;
        if (BASELINE !== undefined)
          subjects.push({
            label: `baseline-unroll${u}`,
            bytes: new Uint8Array(await readFile(join(BASELINE, filename))),
            entry: 'a0_wb_run',
            ns: [],
          });
        const program = parseAndValidate(a0Driver(k));
        const text = compile(program, 'wasm', { wasmExports: ['wb_run'], wasmUnroll: u }).text;
        const module = new Uint8Array(wasmModuleBytes(text));
        if (SAVE_MODULES !== undefined) await writeFile(join(SAVE_MODULES, filename), module);
        subjects.push({
          label: `a0-unroll${u}`,
          bytes: module,
          entry: 'a0_wb_run',
          ns: [],
        });
      }
      for (const s of subjects) {
        const instance = await WebAssembly.instantiate(await WebAssembly.compile(s.bytes), {});
        s.run = instance.exports[s.entry] as Run;
      }
      const trips = Math.max(1, Math.floor(TRIPS / (k.iterScale ?? 1)));
      const seed = 0x9e3779b9;
      const want = ((subjects[0] as Subject).run as Run)(trips, seed) >>> 0;
      for (const s of subjects)
        if ((s.run as Run)(trips, seed) >>> 0 !== want)
          throw new Error(`${k.name}: ${s.label} checksum mismatch`);
      for (let w = 0; w < 3; w += 1) for (const s of subjects) (s.run as Run)(trips, seed + w);
      for (let i = 0; i < SAMPLES; i += 1) {
        waitQuiet();
        for (let j = 0; j < subjects.length; j += 1) {
          const s = subjects[(j + i) % subjects.length] as Subject;
          const t0 = performance.now();
          const got = (s.run as Run)(trips, seed) >>> 0;
          const ns = ((performance.now() - t0) * 1e6) / trips;
          if (got !== want) throw new Error(`${k.name}: ${s.label} result changed`);
          s.ns.push(ns);
        }
      }
      const nsPerTrip: Record<string, number> = {};
      const ratioToClang: Record<string, number> = {};
      const bytes: Record<string, number> = {};
      const samplesNsPerTrip: Record<string, readonly number[]> = {};
      const moduleSha256: Record<string, string> = {};
      const clangNs = median((subjects[0] as Subject).ns);
      for (const s of subjects) {
        nsPerTrip[s.label] = median(s.ns);
        ratioToClang[s.label] = clangNs / median(s.ns);
        bytes[s.label] = s.bytes.length;
        samplesNsPerTrip[s.label] = s.ns;
        moduleSha256[s.label] = createHash('sha256').update(s.bytes).digest('hex');
      }
      rows.push({
        kernel: k.name,
        trips,
        checksum: want,
        nsPerTrip,
        samplesNsPerTrip,
        ratioToClang,
        bytes,
        moduleSha256,
      });
      console.log(
        `${k.name.padEnd(10)} ${subjects.map((s) => `${s.label} ${nsPerTrip[s.label]?.toFixed(3)} (${ratioToClang[s.label]?.toFixed(2)}x)`).join('  ')}`,
      );
    }
  });
  const geomean: Record<string, number> = {};
  for (const label of Object.keys(rows[0]?.ratioToClang ?? {}))
    geomean[label] = Math.exp(
      rows.reduce((n, r) => n + Math.log(r.ratioToClang[label] as number), 0) / rows.length,
    );
  console.log(
    `geomean of clang/variant (above 1: faster than clang): ${Object.entries(geomean)
      .map(([k, v]) => `${k} ${v.toFixed(3)}`)
      .join('  ')}`,
  );
  const report = {
    compiler: COMPILER_VERSION,
    ...(BASELINE === undefined
      ? {}
      : { baselineLabel: ARGS.get('baseline-label') ?? 'saved A0 modules' }),
    engine: `node ${process.version} (V8 ${process.versions.v8})`,
    clang: `${tool.version ?? 'unknown'}, -O3 --target=wasm32 -nostdlib -mbulk-memory, wasm-ld --no-entry`,
    platform: `${process.platform}-${process.arch}`,
    loadAverage: systemLoadTriple(),
    loadSource: loadSource(),
    loadGate: loadGate(),
    samples: SAMPLES,
    method:
      'The wb_run driver of tools/wasm-bench.ts compiled by A0 with each unroll setting and by clang, plus any saved baseline modules; all subjects timed round robin in one process (every sample rotates the order) after a warm-up, medians of ns per trip; ratioToClang is clang ns over variant ns. Every timed call checks its checksum. Raw samples and module SHA-256 identify each subject.',
    geomeanRatioToClang: geomean,
    rows,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeReport(OUT, report);
  console.log(`wrote ${OUT}`);
}

await main();
