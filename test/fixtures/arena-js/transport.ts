import assert from 'node:assert/strict';
import { spawnWithInput } from '../../../src/toolchain.js';

export interface Options {
  readonly maxWords?: number;
  readonly maxOutput?: number;
  readonly quantum?: number;
  readonly observation?: number;
}

/** Raw byte/word transport only. A0 owns all compiler decisions. */
export function compileSource(exe: string, source: string, options: Options = {}) {
  const bytes = Buffer.from(source);
  const packet = Buffer.alloc((6 + bytes.length) * 4);
  const header = [
    0x414a5350,
    options.maxWords ?? 50000000,
    options.maxOutput ?? 50000000,
    options.quantum ?? 97,
    bytes.length,
    options.observation ?? 0,
  ];
  for (const [i, value] of header.entries()) packet.writeUInt32LE(value, i * 4);
  for (const [i, value] of bytes.entries()) packet.writeUInt32LE(value, (6 + i) * 4);
  const child = spawnWithInput(exe, packet, {
    maxBuffer: 200000000,
    timeout: 180000,
  });
  assert.equal(
    child.status,
    0,
    child.stderr?.toString() || child.error?.stack || 'native process failure',
  );
  assert.equal(child.signal, null);
  const out = child.stdout;
  assert.ok(out.length >= 267 * 4);
  const word = (i: number): number => out.readUInt32LE(i * 4);
  assert.equal(word(0), 0x414a5350);
  const code = word(1),
    n = word(266);
  assert.equal(out.length, (267 + n) * 4);
  const result = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const value = word(267 + i);
    assert.ok(value <= 255);
    result[i] = value;
  }
  return {
    code,
    text: result.toString('utf8'),
    steps: word(2) + word(3) * 2 ** 32,
    e: Array.from({ length: 128 }, (_, i) => word(4 + i)),
    v: Array.from({ length: 128 }, (_, i) => word(132 + i)),
    m: Array.from({ length: 6 }, (_, i) => word(260 + i)),
  };
}
