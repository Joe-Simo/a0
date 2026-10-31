/** Reproduce the A0 optimizer's literal-select loss against its TypeScript oracle.
 * Usage: node dist/tools/selfhost-select-bench.js BEFORE_A0W AFTER_A0W [iterations]
 * Both executables must be built from the reported sources; this runs no build or CI.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseAndValidate } from '../src/core.js';
import { writeReport } from './scrub-results.js';
import { a0OptimizeProgram, a0WasmFromTables } from './selfhost-wasm.js';
import { systemLoadTriple } from './system-load.js';

const [before, after, count] = process.argv.slice(2);
if (!before || !after) throw new Error('expected BEFORE_A0W AFTER_A0W [iterations]');
const iterations = count === undefined ? 5_000_000 : Number(count);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const source = 'fn identity u32 -> u32\nc eq p0 0\nr select c 0 p0\nret r\nend';
const layout = { ioInputCapacity: 2, ioOutputCapacity: 4 };
const builds = [];
for (const exe of [before, after]) {
  // Each executable gets a fresh program; older adapters cache by program identity only.
  const program = parseAndValidate(source);
  const ir = a0OptimizeProgram(exe, program);
  const bytes = a0WasmFromTables(exe, program, layout, true).bytes;
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
  const fn = instance.exports.a0_identity as (n: number) => number;
  for (const value of [0, 1, 0x80000000, 0xffffffff]) assert.equal(fn(value) >>> 0, value);
  builds.push({
    executable: exe === before ? 'before' : 'after',
    executableSha256: createHash('sha256').update(readFileSync(exe)).digest('hex'),
    nodes: ir.bodies[0]?.nodes.length,
    bytes: bytes.length,
    moduleSha256: createHash('sha256').update(bytes).digest('hex'),
    fn,
  });
}
function measure(fn: (n: number) => number): { nsPerCall: number; checksum: number } {
  let checksum = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) checksum = (checksum + fn(Math.imul(i, 2654435761))) >>> 0;
  return { nsPerCall: ((performance.now() - start) * 1e6) / iterations, checksum };
}
for (let i = 0; i < 3; i++) for (const build of builds) measure(build.fn);
const samples: {
  round: number;
  side: number;
  nsPerCall: number;
  checksum: number;
  load: number[];
}[] = [];
for (let round = 0; round < 11; round++) {
  for (const side of round % 2 ? [1, 0] : [0, 1]) {
    const load = [...systemLoadTriple()];
    assert.ok((load[0] ?? Infinity) <= 10, 'loaded run: no timing claim');
    const build = builds[side];
    assert.ok(build);
    samples.push({ round, side, ...measure(build.fn), load });
  }
}
assert.equal(new Set(samples.map((s) => s.checksum)).size, 1);
const median = (side: number): number => {
  const values = samples
    .filter((s) => s.side === side)
    .map((s) => s.nsPerCall)
    .sort((a, b) => a - b);
  const result = values[Math.floor(values.length / 2)];
  assert.ok(result !== undefined);
  return result;
};
const report = {
  generatedAt: new Date().toISOString(),
  meaning:
    'One literal-select identity, independently built before and after A0 compilers. Runtime medians are host-specific; no universal superiority or ledger reduction is claimed.',
  source,
  baselineRevision: 'a423b353e8635c647306c53697bd414db562fc5d',
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  iterations,
  warmupRounds: 3,
  measuredRounds: 11,
  builds: builds.map(({ fn: _fn, ...build }, side) => ({
    ...build,
    medianNsPerCall: median(side),
  })),
  samples,
};
await writeReport('results/selfhost-select-recovery.json', report);
console.log(JSON.stringify(report.builds, null, 2));
