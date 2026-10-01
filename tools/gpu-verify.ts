/**
 * GPU execution evidence (Gate 8): the io-free corpus compiled to Metal Shading Language
 * and executed on the local GPU through a generated Swift host (Metal framework), one
 * thread per oracle case. Results are compared with the BigInt oracle exactly like the
 * other targets. Writes results/gpu.json. Requires macOS with Metal and swiftc.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { TypedProgram, Value } from '../src/core.js';
import { emitMetal, isKernelCallable, kernelName } from '../src/metal.js';
import { runTool, withTempDir } from '../src/toolchain.js';
import { type Case, generateCases, generateCorpus, ioFreeSubset } from './corpus.js';
import type { TargetReport } from './verify.js';

const fmt = (v: Value): string => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

/**
 * Swift host: reads `cases.txt` lines "fnIndex a0 a1 ..." grouped by function, dispatches
 * one kernel per function over all its cases, and prints "fnIndex caseIndex result".
 */
function swiftHost(program: TypedProgram): string {
  const table = program.functions
    .map((fn, i) =>
      isKernelCallable(fn) ? `  ${i}: ("${kernelName(fn)}", ${fn.params.length}),` : '',
    )
    .filter((l) => l.length > 0)
    .join('\n');
  return `import Foundation
import Metal

let kernels: [Int: (String, Int)] = [
${table}
]
guard let device = MTLCreateSystemDefaultDevice() else { print("no metal device"); exit(2) }
let source = try! String(contentsOfFile: "module.metal", encoding: .utf8)
let library: MTLLibrary
do { library = try device.makeLibrary(source: source, options: nil) } catch { print("metal compile failed: \\(error)"); exit(3) }
let queue = device.makeCommandQueue()!
let text = try! String(contentsOfFile: "cases.txt", encoding: .utf8)
var inputs: [Int: [UInt32]] = [:]
var order: [Int] = []
var counts: [Int: Int] = [:]
for line in text.split(separator: "\\n") {
  let tok = line.split(separator: " ").map { String($0) }
  if tok.isEmpty { continue }
  let idx = Int(tok[0])!
  if counts[idx] == nil { counts[idx] = 0; order.append(idx) }
  counts[idx]! += 1
  let words = tok.dropFirst().map { UInt32($0)! }
  inputs[idx, default: []].append(contentsOf: words)
}
var out = ""
for idx in order {
  guard let (name, arity) = kernels[idx] else { continue }
  let n = counts[idx]!
  let fn = library.makeFunction(name: name)!
  let pso = try! device.makeComputePipelineState(function: fn)
  var words = inputs[idx]!
  if words.isEmpty { words = [0] }
  let inBuf = device.makeBuffer(bytes: words, length: words.count * 4, options: .storageModeShared)!
  let outBuf = device.makeBuffer(length: n * 4, options: .storageModeShared)!
  let cmd = queue.makeCommandBuffer()!
  let enc = cmd.makeComputeCommandEncoder()!
  enc.setComputePipelineState(pso)
  enc.setBuffer(inBuf, offset: 0, index: 0)
  enc.setBuffer(outBuf, offset: 0, index: 1)
  let tg = min(pso.maxTotalThreadsPerThreadgroup, n)
  enc.dispatchThreads(MTLSize(width: n, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: tg, height: 1, depth: 1))
  enc.endEncoding()
  cmd.commit()
  cmd.waitUntilCompleted()
  let results = outBuf.contents().bindMemory(to: UInt32.self, capacity: n)
  for k in 0..<n { out += "\\(idx) \\(k) \\(results[k])\\n" }
  _ = arity
}
print(out, terminator: "")
print("A0GPU device=\\(device.name)")
`;
}

/** Metal Shading Language on the local GPU: one thread per case, io-free kernel-callable functions only. */
export async function checkMetal(
  program: TypedProgram,
  allCases: readonly Case[],
): Promise<TargetReport & { device?: string; kernels: number }> {
  const cases = allCases.filter((c) => {
    const fn = program.byName.get(c.functionName);
    return fn !== undefined && isKernelCallable(fn);
  });
  const kernels = program.functions.filter(isKernelCallable).length;
  const index = new Map(program.functions.map((f, i) => [f.name, i] as const));
  const metal = emitMetal(program);
  const start = performance.now();
  let report: TargetReport & { device?: string; kernels: number } = {
    status: 'failed',
    cases: 0,
    detail: 'not run',
    kernels,
  };
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.metal'), metal, 'utf8');
    await writeFile(join(dir, 'host.swift'), swiftHost(program), 'utf8');
    // Cases in stable order: grouped by function, arguments as decimal words.
    const grouped = [...cases].sort(
      (a, b) => (index.get(a.functionName) ?? 0) - (index.get(b.functionName) ?? 0),
    );
    await writeFile(
      join(dir, 'cases.txt'),
      `${grouped.map((c) => `${index.get(c.functionName)} ${c.args.map(fmt).join(' ')}`).join('\n')}\n`,
      'utf8',
    );
    const swiftc = '/usr/bin/swiftc';
    const build = runTool(
      swiftc,
      ['-O', '-framework', 'Metal', '-framework', 'Foundation', '-o', 'host', 'host.swift'],
      { cwd: dir, timeoutMs: 300_000 },
    );
    if (!build.ok) {
      report = {
        status: 'failed',
        cases: 0,
        detail: `swiftc failed: ${build.stderr.slice(0, 2000)}`,
        kernels,
      };
      return;
    }
    const run = runTool(join(dir, 'host'), [], { cwd: dir, timeoutMs: 300_000 });
    if (!run.ok) {
      report = {
        status: 'failed',
        cases: 0,
        detail: `host failed (${run.status}): ${run.stdout.slice(0, 1500)} ${run.stderr.slice(0, 1500)}`,
        kernels,
      };
      return;
    }
    const got = new Map<string, string>();
    let device = '';
    for (const line of run.stdout.split('\n')) {
      if (line.startsWith('A0GPU')) device = line.slice(6);
      const m = /^(\d+) (\d+) (\d+)$/.exec(line);
      if (m) got.set(`${m[1]}:${m[2]}`, m[3] as string);
    }
    const counters = new Map<number, number>();
    const failures: string[] = [];
    for (const c of grouped) {
      const fi = index.get(c.functionName) ?? 0;
      const k = counters.get(fi) ?? 0;
      counters.set(fi, k + 1);
      const actual = got.get(`${fi}:${k}`);
      if (actual !== fmt(c.expected)) {
        failures.push(
          `${c.functionName}(${c.args.map(fmt).join(',')}) expected ${fmt(c.expected)} got ${actual ?? '<missing>'}`,
        );
      }
    }
    report = {
      status: failures.length === 0 ? 'passed' : 'failed',
      cases: cases.length,
      detail: `Swift host + Metal runtime compile of generated MSL; ${cases.length} cases dispatched one thread each on ${device}.`,
      device,
      kernels,
      elapsedMs: performance.now() - start,
      failures: failures.slice(0, 20),
    };
  });
  return report;
}

async function main(): Promise<void> {
  const program = ioFreeSubset(generateCorpus());
  const allCases = generateCases(program);
  const r = await checkMetal(program, allCases);
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    functions: program.functions.length,
    kernels: r.kernels,
    inputCases: r.cases,
    scope:
      'io-free corpus mapped to Metal Shading Language, executed on the local GPU one thread per case; exact u32/bool semantics compared with the BigInt oracle. Not a GPU performance claim; no memory-space or scheduling model beyond elementwise dispatch.',
    status: r.status,
    ...(r.device === undefined ? {} : { device: r.device }),
    ...(r.failures === undefined ? {} : { failures: r.failures }),
    ...(r.elapsedMs === undefined ? {} : { elapsedMs: r.elapsedMs }),
    detail: r.detail,
  };
  await mkdir('results', { recursive: true });
  await writeFile(join('results', 'gpu.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({ status: report.status, device: report.device, cases: report.inputCases, kernels: report.kernels, detail: report.detail, failures: (report.failures as string[] | undefined)?.slice(0, 5) }, null, 2)}\n`,
  );
  process.exit(report.status === 'passed' ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
