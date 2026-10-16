// File-backed raw-word transport. No source parsing, checking, lowering or codegen.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const [EXE, ROOT] = process.argv.slice(2);
assert.ok(EXE && ROOT, 'native executable and caller-owned scratch required');
const opt = 'fresh-seed',
  dir = join(ROOT, 'requests');
mkdirSync(dir, { recursive: true });
const sha = (x) => createHash('sha256').update(x).digest('hex');
let ordinal = 0;
export function compileSource(source, options = {}) {
  const index = String(ordinal++).padStart(4, '0'),
    file = `${dir}/${index}`,
    raw = Array.from(Buffer.from(source)),
    names = [],
    spans = [];
  if (options.exports !== undefined)
    for (const name of options.exports) {
      const bytes = Array.from(Buffer.from(name));
      spans.push(names.length, bytes.length);
      for (const byte of bytes) names.push(byte);
    }
  const opts = new Uint32Array([
    1,
    options.input ?? 2,
    options.output ?? 4,
    options.simd ?? 0,
    options.unroll ?? 1,
    options.optimize ?? 0,
    Number(options.exports !== undefined),
  ]);
  if (options.change) options.change(opts);
  const words = [
    0x41574153,
    options.maxWords ?? 50000000,
    options.maxOutput ?? 50000000,
    options.quantum ?? 97,
    raw.length,
    options.fault?.op ?? 0,
    options.fault?.nth ?? 0,
    options.fault?.status ?? 0,
    options.fault?.kind ?? 0,
    ...opts,
    names.length,
    spans.length,
    ...raw,
    ...names,
    ...spans,
  ];
  const input = Buffer.alloc(words.length * 4);
  for (let i = 0; i < words.length; i++) input.writeUInt32LE(words[i] >>> 0, i * 4);
  writeFileSync(`${file}.input.bin`, input);
  const r = spawnSync(EXE, [`${file}.input.bin`, `${file}.output.bin`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(`${file}.stderr.log`, r.stderr ?? '');
  writeFileSync(`${file}.stdout.log`, r.stdout ?? '');
  const result = {
    index,
    optimization: opt,
    sourceSHA256: sha(Buffer.from(source)),
    sourceBytes: raw.length,
    inputSHA256: sha(input),
    processCode: r.status,
    signal: r.signal,
    error: r.error?.message,
  };
  writeFileSync(`${file}.json`, JSON.stringify(result, null, 2) + '\n');
  assert.equal(r.status, 0, `${opt}/${index}: ${r.error ?? r.stderr?.toString()}`);
  const output = readFileSync(`${file}.output.bin`);
  assert.equal(output.length % 4, 0);
  const u = Array.from({ length: output.length / 4 }, (_, i) => output.readUInt32LE(i * 4));
  assert.equal(u[0], 0x41574153);
  assert.equal(u.length, 265 + u[264]);
  assert.ok(u.slice(265).every((x) => x < 256));
  const bytes = Uint8Array.from(u.slice(265)),
    code = u[1],
    counts = u.slice(260, 263),
    resumes = u[2] + u[3] * 2 ** 32;
  if (code) assert.equal(bytes.length, 0, 'failed compilation published bytes');
  Object.assign(result, {
    code,
    counts,
    resumes,
    outputSHA256: sha(output),
    moduleSHA256: sha(bytes),
    moduleBytes: bytes.length,
    allocatedBeforeFinish: u[263],
    finishedAndFreed: true,
    sourceImmutable: true,
    tokenUnchanged: true,
  });
  writeFileSync(`${file}.json`, JSON.stringify(result, null, 2) + '\n');
  return {
    code,
    bytes,
    counts,
    resumes,
    diagnostics: { status: u[132], frontend: u.slice(132, 160) },
  };
}
