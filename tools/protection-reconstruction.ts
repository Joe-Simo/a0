/** Owned-application REA/WABT behavior-copy control. No AI inference or resistance claim. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { link } from '../src/link.js';
import { wasmModuleBytes } from '../src/wasm.js';
import { writeReport } from './scrub-results.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=');
    return [a.slice(2, i), a.slice(i + 1)];
  }),
);
const artifacts = resolve(args.get('artifacts') ?? '.a0-tmp/protection-artifacts');
const scratch = resolve(args.get('scratch') ?? '.a0-tmp/protection-reconstruction');
const rea = args.get('rea'),
  wabt = args.get('wabt');
if (!rea || !wabt)
  throw new Error('Supply --rea=<pinned REA executable> --wabt=<WABT 1.0.42 bin directory>');
const timeBudgetMs = 60000,
  aiTokenBudget = 0;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
await mkdir(scratch, { recursive: true });
function command(exe: string, argv: readonly string[], budget = timeBudgetMs): string {
  const p = spawnSync(exe, [...argv], {
    encoding: 'utf8',
    timeout: Math.floor(budget),
    maxBuffer: 32 << 20,
    env: { ...process.env, REA_WABT_BIN_DIRECTORY: resolve(wabt as string) },
  });
  if (p.status !== 0)
    throw new Error(
      `Analysis failed (not a protection success): ${p.error?.name ?? p.signal ?? p.status} ${p.stderr.slice(0, 1000)}`,
    );
  return p.stdout;
}
function portable(value: unknown): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const [path, label] of [
      [artifacts, '<fixture>'],
      [scratch, '<analysis>'],
      [resolve(rea as string), '<rea>'],
      [resolve(wabt as string), '<wabt>'],
      [process.cwd(), '<repo>'],
    ])
      result = result.replaceAll(path as string, label as string);
    return result;
  }
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portable(v)]));
  return value;
}
function runner(bytes: Uint8Array, page: boolean): (input: readonly number[]) => string {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), {});
  const memory = instance.exports.memory as WebAssembly.Memory,
    ptr = Number((instance.exports.__heap_base as WebAssembly.Global).value);
  const output = page ? 262144 : 1024,
    words = 256 + output + 3;
  if (ptr + words * 4 > memory.buffer.byteLength)
    memory.grow(Math.ceil((ptr + words * 4 - memory.buffer.byteLength) / 65536));
  const io = new Uint32Array(memory.buffer, ptr, words),
    entry = instance.exports[page ? 'a0_session' : 'a0_life'] as (ptr: number) => number;
  return (input) => {
    io.set(input);
    io[256] = input.length;
    io[257] = 0;
    io[258 + output] = 0;
    const result = entry(ptr) >>> 0,
      count = io[258 + output] as number;
    assert.ok(count <= output);
    return hash(
      JSON.stringify({
        result,
        consumed: io[257],
        output: Array.from(io.subarray(258, 258 + count)),
      }),
    );
  };
}
const rows = [];
for (const fixture of ['life', 'page']) {
  const page = fixture === 'page',
    reference = await readFile(join(artifacts, `${fixture}-old-off.wasm`));
  const oracle = runner(reference, page),
    reconstructions = [];
  // Decode/reassembly has no access to the correctness cases, which are generated only afterwards.
  for (const arm of ['old-off', 'combined']) {
    const path = join(artifacts, `${fixture}-${arm}.wasm`),
      before = await readFile(path),
      started = performance.now();
    const evidence = JSON.parse(
      command(resolve(rea), ['inspect-wasm-artifact', path, '--format', 'json']),
    ) as { normalized_result: { validation: string; wat: { text: string; sha256: string } } };
    assert.equal(evidence.normalized_result.validation, 'valid');
    const wat = evidence.normalized_result.wat.text;
    assert.equal(hash(wat), evidence.normalized_result.wat.sha256);
    const watPath = join(scratch, `${fixture}-${arm}.wat`),
      out = join(scratch, `${fixture}-${arm}-reconstructed.wasm`);
    await writeFile(watPath, wat);
    command(
      join(resolve(wabt), 'wat2wasm'),
      [watPath, '-o', out],
      Math.max(1, timeBudgetMs - (performance.now() - started)),
    );
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs <= timeBudgetMs);
    assert.equal(hash(await readFile(path)), hash(before), 'analysis input changed');
    await writeReport(join(scratch, `${fixture}-${arm}-rea.json`), portable(evidence));
    reconstructions.push({
      arm,
      artifactSha256: hash(before),
      watSha256: hash(wat),
      reconstructedSha256: hash(await readFile(out)),
      elapsedMs,
      run: runner(await readFile(out), page),
    });
  }
  const cases: number[][] = [];
  if (page) {
    cases.push([0], [1], [0xffffffff]);
    for (let i = 0; i < 64; i++) cases.push([randomBytes(4).readUInt32LE()]);
  } else {
    for (let i = 0; i < 64; i++) {
      const entropy = randomBytes(35 * 4),
        input = Array.from({ length: 35 }, (_, k) => entropy.readUInt32LE(k * 4));
      input[32] = i % 3;
      input[33] = (input[33] as number) & 31;
      input[34] = (input[34] as number) & 31;
      cases.push(input);
    }
    cases.push([...Array(32).fill(0), 0, 0, 0], [...Array(32).fill(0xffffffff), 1, 0, 0]);
  }
  const source = (
    await link(page ? 'site/page.a0' : 'examples/life.a0', (path) => readFile(path, 'utf8'))
  ).text;
  const wrong = source.replace(page ? 'ret event' : 'ret pop', 'ret 0');
  assert.notEqual(wrong, source);
  const wrongBytes = wasmModuleBytes(
    compile(parseAndValidate(wrong), 'wasm', {
      ioInputCapacity: 256,
      ioOutputCapacity: page ? 262144 : 1024,
    }).text,
  );
  const negative = runner(wrongBytes, page);
  let rejected = 0;
  for (const input of cases) if (negative(input) !== oracle(input)) rejected++;
  assert.ok(
    rejected > 0,
    'hidden cases must reject a valid, behaviorally wrong reconstruction without a tool crash',
  );
  for (const reconstructed of reconstructions) {
    let accepted = 0;
    for (const input of cases) if (reconstructed.run(input) === oracle(input)) accepted++;
    rows.push({
      fixture,
      arm: reconstructed.arm,
      artifactSha256: reconstructed.artifactSha256,
      watSha256: reconstructed.watSha256,
      reconstructedSha256: reconstructed.reconstructedSha256,
      analysisMs: reconstructed.elapsedMs,
      timeBudgetMs,
      aiTokenBudget,
      hiddenCases: cases.length,
      accepted,
      negativeControlRejected: rejected,
    });
    assert.equal(accepted, cases.length);
  }
  await writeReport(join(scratch, `${fixture}-correctness-cases.json`), {
    generatedAfterReconstruction: true,
    cases,
  });
}
await writeReport(args.get('out') ?? 'results/protection-reconstruction.json', {
  schema: 'a0-protection-behavior-copy-control-1',
  rea: 'rea-agents 6.5.0',
  reaSource: 'https://github.com/morluto/rea',
  reaCommit: '0d224742808e32106e2ee93340c6755ee5e0a0db',
  wabt: '1.0.42',
  platform: process.platform,
  arch: process.arch,
  study:
    'Mechanical REA WAT extraction and reassembly; owned applications; hidden correctness cases frozen after decoding; valid wrong-program negative control.',
  limitations: [
    'This is a behavior-copy control, not independent algorithm understanding or an AI reconstruction study.',
    'No AI inference; zero model tokens.',
    'Identical artifact bytes in baseline/combined provide no evidence of increased resistance.',
    'Tool failures invalidate analysis and never count as a defense success.',
    'Fixed per-artifact decoding/reassembly budget; correctness execution is scored separately.',
    'Native/mobile/GPU/hardware reconstruction studies pending.',
  ],
  rows,
});
process.stdout.write('REA behavior-copy controls completed\n');
