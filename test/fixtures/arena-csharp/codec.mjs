// Generic packet transport and response observations only. No compiler implementation/fallback.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnWithInput } from '../../../dist/src/toolchain.js';

const N = process.argv[4],
  group = process.argv[3],
  sha = (x) => createHash('sha256').update(x).digest('hex');
export const trace = [];
export async function invoke(exe, label, input, settings = {}) {
  assert.match(label, /^[a-z0-9_-]+$/);
  let mode = typeof input === 'string' ? 0 : 1,
    payload = [];
  const bytes = mode ? [] : Array.from(Buffer.from(input));
  if (!mode) payload = bytes;
  else {
    for (const name of ['types', 'tlist', 'fns', 'nodes', 'args', 'pool']) {
      const v = input[name];
      payload.push(v.length);
      for (const w of v) payload.push(w);
    }
    payload.push(
      ...input.counts,
      settings.options ?? 0,
      settings.selector ?? 0,
      settings.type ?? 0,
    );
  }
  const words = [
    0x41435346,
    mode,
    settings.maxWords ?? 50000000,
    settings.maxOutput ?? 50000000,
    settings.quantum ?? 7,
    bytes.length,
    settings.faultOp ?? 0,
    settings.faultNth ?? 0,
    settings.faultStatus ?? 0,
  ].concat(payload);
  const packet = Buffer.alloc(words.length * 4);
  for (const [i, w] of words.entries()) packet.writeUInt32LE(w >>> 0, i * 4);
  const stem = `${N}/packets/${group}/${String(trace.length).padStart(3, '0')}-${label}`;
  await mkdir(`${N}/packets/${group}`, { recursive: true });
  await writeFile(`${stem}.input.bin`, packet);
  const r = spawnWithInput(exe, packet, {
    timeout: 180000,
    maxBuffer: 1 << 28,
  });
  await writeFile(`${stem}.output.bin`, r.stdout ?? Buffer.alloc(0));
  await writeFile(`${stem}.stderr.log`, r.stderr ?? Buffer.alloc(0));
  const row = {
    label,
    mode,
    status: r.status,
    signal: r.signal,
    error: r.error?.message,
    inputBytes: packet.length,
    inputSHA256: sha(packet),
    outputBytes: r.stdout?.length ?? 0,
    outputSHA256: sha(r.stdout ?? Buffer.alloc(0)),
    stderr: r.stderr?.toString(),
    input: `${stem}.input.bin`,
    output: `${stem}.output.bin`,
  };
  trace.push(row);
  await writeFile(`${N}/packet-trace.json`, `${JSON.stringify(trace, null, 2)}\n`);
  assert.equal(r.error, undefined, label);
  assert.equal(r.signal, null, label);
  assert.equal(r.status, 0, `${label}: ${r.stderr}`);
  assert.equal(r.stderr.length, 0, `${label}: UBSan/driver diagnostics`);
  assert.equal(r.stdout.length % 4, 0);
  let at = 0;
  const word = () => {
    assert.ok(at < r.stdout.length, 'complete packet');
    const w = r.stdout.readUInt32LE(at);
    at += 4;
    return w;
  };
  assert.equal(word(), 0x41435346);
  const code = word(),
    resumes = word() + word() * 2 ** 32;
  const vectors = Array.from({ length: 4 }, () => Array.from({ length: 128 }, word));
  const ctx = Array.from({ length: 16 }, word),
    count = word(),
    output = Array.from({ length: count }, word);
  assert.equal(at, r.stdout.length, 'no trailing output');
  const text = Buffer.from(output).toString('utf8');
  if (code) assert.equal(count, 0, 'failed transaction publishes no byte result');
  Object.assign(row, { code, resumes, textBytes: Buffer.byteLength(text) });
  return {
    code,
    resumes,
    E: vectors[0],
    V: vectors[1],
    M: vectors[2],
    D: vectors[3],
    ctx,
    text,
  };
}
