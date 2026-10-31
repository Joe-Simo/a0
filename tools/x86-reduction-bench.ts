/** Compare native x86 compiler builds on unchanged execution-benchmark kernels.
 * Usage: node dist/tools/x86-reduction-bench.js BEFORE_COMPILER OUTPUT_JSON
 * All variants use the stock C driver and an out-of-line kernel call. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { COMPILER_VERSION, compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { findClang, runTool } from '../src/toolchain.js';
import { cDriver, KERNELS } from './exec-bench-kernels.js';
import { ITER } from './exec-bench-languages.js';
import { writeReport } from './scrub-results.js';
import { systemLoadTriple } from './system-load.js';

interface Variant {
  label: string;
  exe: string;
  sourceSha256: string;
  sourceBytes: number;
  textBytes: number;
  executableBytes: number;
  largestStackAllocation: number | null;
}
interface Measurement {
  round: number;
  variant: string;
  load: number[];
  nsPerCall: number;
  checksum: string | undefined;
  maxRssKiB: number;
  processMs: number;
}

assert.equal(process.platform, 'linux', 'this measurement harness records Linux ru_maxrss in KiB');
assert.equal(process.arch, 'x64');
const [
  beforePath,
  output = 'results/x86-reduction.json',
  kernelNames = 'dot1k,hist256,sieve4k,prefix1k',
  baselineRevision = '8812cee7b64fed630459943c6565eec8ec815e84',
] = process.argv.slice(2);
assert.ok(beforePath, 'expected baseline compiler module');
const before = await import(pathToFileURL(resolve(beforePath)).href);
const clang = findClang();
const clangPath = clang.path;
assert.ok(clangPath);
const directory = resolve('.a0-cache/x86-reduction-bench');
await mkdir(directory, { recursive: true });
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const median = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
const checked = (args: string[]) => {
  const r = runTool(clangPath, args, { timeoutMs: 120000 });
  assert.ok(r.ok, r.stderr);
};

/** Executable section bytes in the ELF64 little-endian object, excluding debug/metadata. */
function textBytes(b: Buffer): number {
  assert.equal(b.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(b[4], 2);
  assert.equal(b[5], 1);
  const start = Number(b.readBigUInt64LE(40));
  const stride = b.readUInt16LE(58);
  let sum = 0;
  for (let i = 0; i < b.readUInt16LE(60); i++) {
    const at = start + i * stride;
    if ((b.readBigUInt64LE(at + 8) & 4n) !== 0n) sum += Number(b.readBigUInt64LE(at + 32));
  }
  return sum;
}

const results = [];
for (const name of kernelNames.split(',')) {
  const kernel = KERNELS.find((k) => k.name === name);
  assert.ok(kernel);
  const program = parseAndValidate(kernel.a0);
  const c = compile(program, 'c').text;
  assert.equal(
    c,
    before.compile(program, 'c').text.replaceAll(before.COMPILER_VERSION, COMPILER_VERSION),
    'C reference changed beyond version banner',
  );
  const assembly = compile(program, 'x86_64').text;
  const texts = [
    { label: 'before', source: before.compile(program, 'x86_64').text as string, c: false },
    { label: 'after', source: assembly, c: false },
    ...(assembly.includes('.La0sse41_cap:')
      ? [
          {
            label: 'forced-sse2',
            source: assembly.replace('.La0sse41_cap:\n\t.byte 0', '.La0sse41_cap:\n\t.byte 1'),
            c: false,
          },
        ]
      : []),
    { label: 'clang-o3-native', source: c, c: true },
  ];
  const prototype = `#include <stdint.h>\nextern uint32_t a0_${name}(${Array.from({ length: kernel.arity }, () => 'uint32_t').join(',')});\n`;
  // Memory reporting occurs after the stock timer stops and checksum is printed.
  const driver =
    prototype +
    cDriver(() => `a0_${name}(ARGS)`, kernel.arity)
      .replace('#include <time.h>', '#include <time.h>\n#include <sys/resource.h>')
      .replace(
        '  return 0;',
        '  struct rusage r; getrusage(RUSAGE_SELF, &r); fprintf(stderr, "%ld\\n", r.ru_maxrss);\n  return 0;',
      );
  const driverPath = resolve(directory, `${name}-driver.c`);
  await writeFile(driverPath, driver);
  const variants: Variant[] = [];
  for (const { label, source, c: isC } of texts) {
    const stem = resolve(directory, `${name}-${label}`);
    const sourcePath = `${stem}.${isC ? 'c' : 's'}`;
    await writeFile(sourcePath, source);
    checked(
      isC
        ? ['-std=c11', '-O3', '-march=native', '-c', sourcePath, '-o', `${stem}.o`]
        : ['-c', '-x', 'assembler', sourcePath, '-o', `${stem}.o`],
    );
    checked(['-std=c11', '-O2', '-D_POSIX_C_SOURCE=199309L', driverPath, `${stem}.o`, '-o', stem]);
    variants.push({
      label,
      exe: stem,
      sourceSha256: hash(source),
      sourceBytes: Buffer.byteLength(source),
      textBytes: textBytes(await readFile(`${stem}.o`)),
      executableBytes: (await stat(stem)).size,
      largestStackAllocation: isC
        ? null
        : Math.max(0, ...[...source.matchAll(/subq \$(\d+), %rsp/g)].map((m) => Number(m[1]))),
    });
  }
  const iterations = Math.floor(ITER / (kernel.iterScale ?? 1));
  const run = (index: number, count: number) => {
    const variant = variants[index];
    assert.ok(variant);
    const start = performance.now();
    const r = runTool(variant.exe, [String(count)], { timeoutMs: 120000 });
    assert.ok(r.ok, r.stderr);
    const [ns, checksum] = r.stdout.trim().split(' ');
    return {
      nsPerCall: Number(ns),
      checksum,
      maxRssKiB: Number(r.stderr.trim()),
      processMs: performance.now() - start,
    };
  };
  for (let round = 0; round < 3; round++)
    for (let i = 0; i < variants.length; i++) run(i, iterations);
  const timings: Measurement[] = [];
  for (let round = 0; round < 15; round++) {
    for (const index of variants.map((_, i) => (round + i) % variants.length)) {
      const load = [...systemLoadTriple()];
      assert.ok((load[0] ?? Infinity) <= 10, 'loaded timing');
      const variant = variants[index];
      assert.ok(variant);
      timings.push({ round, variant: variant.label, load, ...run(index, iterations) });
    }
  }
  assert.equal(new Set(timings.map((t) => t.checksum)).size, 1, `${name} checksum`);
  const startup: Measurement[] = [];
  for (let round = 0; round < 7; round++)
    for (const index of variants
      .map((_, i) => (round + i) % variants.length)
      .filter((i) => variants[i]?.label !== 'clang-o3-native')) {
      const load = [...systemLoadTriple()];
      assert.ok((load[0] ?? Infinity) <= 10, 'loaded startup');
      const variant = variants[index];
      assert.ok(variant);
      startup.push({ round, variant: variant.label, load, ...run(index, 1) });
    }
  const summary = variants.map(({ exe: _exe, ...v }) => ({
    ...v,
    medianNsPerCall: median(timings.filter((t) => t.variant === v.label).map((t) => t.nsPerCall)),
    medianMaxRssKiB: median(timings.filter((t) => t.variant === v.label).map((t) => t.maxRssKiB)),
    medianStartupMs: median(startup.filter((t) => t.variant === v.label).map((t) => t.processMs)),
  }));
  results.push({
    name,
    kernelSha256: hash(kernel.a0),
    driverSha256: hash(driver),
    iterations,
    summary,
    timings,
    startup,
  });
  console.log(name, JSON.stringify(summary));
}
await writeReport(output, {
  generatedAt: new Date().toISOString(),
  baselineRevision,
  compilerVersion: COMPILER_VERSION,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  clang: clang.version,
  samples: 15,
  warmups: 3,
  sourceSha256: hash(await readFile('src/x86_64.ts')),
  memoryMeaning:
    'getrusage(RUSAGE_SELF).ru_maxrss in each fresh native process after the stock timer stops. Zero values are unavailable, not zero memory. Static stack allocation is the largest subq from rsp, excluding pushes and callers.',
  startupMeaning:
    'Fresh process wall time with one stock-driver iteration; includes launch and teardown.',
  results,
});
