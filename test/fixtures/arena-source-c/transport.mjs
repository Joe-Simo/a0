// Binary framing only: raw source bytes enter A0; returned C bytes stay verbatim.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const [EXE, ROOT, CLANG] = process.argv.slice(2);
assert.ok(EXE && ROOT && CLANG, 'native compiler, caller-owned scratch and clang required');
const dir = join(ROOT, 'requests');
mkdirSync(dir, { recursive: true });
const sha = (x) => createHash('sha256').update(x).digest('hex');
let ordinal = 0;
export function compileSource(source, options = {}) {
  const index = String(ordinal++).padStart(4, '0'),
    file = join(dir, index),
    raw = Array.from(Buffer.from(source)),
    words = [
      0x43535243,
      options.maxWords ?? 50000000,
      options.maxOutput ?? 50000000,
      options.quantum ?? 97,
      raw.length,
      options.fault?.op ?? 0,
      options.fault?.nth ?? 0,
      options.fault?.status ?? 0,
      options.fault?.kind ?? 0,
      options.input ?? 2,
      options.output ?? 4,
      options.flags ?? 0,
      ...raw,
    ],
    input = Buffer.alloc(words.length * 4);
  for (let i = 0; i < words.length; i++) input.writeUInt32LE(words[i] >>> 0, i * 4);
  writeFileSync(`${file}.input.bin`, input);
  const ran = spawnSync(EXE, [`${file}.input.bin`, `${file}.output.bin`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(`${file}.stderr.log`, ran.stderr ?? '');
  writeFileSync(`${file}.stdout.log`, ran.stdout ?? '');
  const evidence = {
    index,
    sourceSHA256: sha(Buffer.from(source)),
    sourceBytes: raw.length,
    inputSHA256: sha(input),
    processCode: ran.status,
    signal: ran.signal,
    error: ran.error?.message,
  };
  writeFileSync(`${file}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  assert.equal(ran.status, 0, `${index}: ${ran.error ?? ran.stderr?.toString()}`);
  const output = readFileSync(`${file}.output.bin`);
  assert.equal(output.length % 4, 0);
  let cursor = 0;
  const word = () => {
    assert.ok(cursor < output.length, 'complete native packet');
    const value = output.readUInt32LE(cursor);
    cursor += 4;
    return value;
  };
  assert.equal(word(), 0x43535243);
  const code = word(),
    resumes = word() + word() * 2 ** 32,
    pendingChecks = word(),
    e = Array.from({ length: 128 }, word),
    v = Array.from({ length: 128 }, word),
    m = Array.from({ length: 128 }, word),
    binding = Array.from({ length: 128 }, word),
    counts = Array.from({ length: 3 }, word),
    result = Array.from({ length: 3 }, word),
    allocated = word(),
    length = word(),
    values = Array.from({ length }, word);
  assert.equal(cursor, output.length, 'no trailing native packet');
  assert.ok(
    values.every((x) => x < 256),
    'target bytes',
  );
  const bytes = Uint8Array.from(values);
  assert.equal(e[1], 1, 'terminal service state');
  if (e[0]) {
    assert.equal(code, e[0], 'failed compile status survives publish');
    assert.equal(bytes.length, 0, 'failed compile publishes no bytes');
    assert.deepEqual(result, [0, 0, 0], 'failed compile has no usable result vector');
  }
  if (!code) {
    assert.equal(e[0], 0);
    assert.equal(result[1], bytes.length, 'complete vector publication');
    assert.ok(result[1] <= result[2]);
  }
  Object.assign(evidence, {
    code,
    compileStatus: e[0],
    counts,
    resumes,
    pendingChecks,
    outputSHA256: sha(output),
    cSHA256: sha(bytes),
    cBytes: bytes.length,
    allocatedBeforeFinish: allocated,
    finishedAndFreed: true,
    sourceImmutable: true,
    tokenUnchanged: true,
  });
  writeFileSync(`${file}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  return { code, bytes, e, v, m, binding, counts, resumes, pendingChecks, result };
}
