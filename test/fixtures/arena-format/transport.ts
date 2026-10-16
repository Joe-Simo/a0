import assert from 'node:assert/strict';
import { spawnWithInput } from '../../../src/toolchain.js';
import type { SourceCase } from './cases.js';

export interface ComponentResult {
  readonly operation: number;
  readonly code: number;
  readonly text: string;
  readonly bytes: Buffer;
  readonly facts: readonly number[];
  readonly events: readonly number[];
}
export interface NativeResult {
  readonly code: number;
  readonly diagnostic: number;
  readonly functions: number;
  readonly results: readonly ComponentResult[];
}

/** Binary transport only; source grammar, verification, text and hashes execute in A0. */
export function runNative(exe: string, row: SourceCase): NativeResult {
  const source = Buffer.from(row.source);
  const packet = Buffer.alloc((6 + source.length + row.requests.length * 7) * 4);
  const header = [
    0x41464d54,
    100000000,
    100000000,
    row.checked ? 1 : 0,
    source.length,
    row.requests.length,
  ];
  let at = 0;
  for (const value of header) packet.writeUInt32LE(value, at++ * 4);
  for (const value of source) packet.writeUInt32LE(value, at++ * 4);
  for (const request of row.requests) {
    for (const value of [
      request.operation,
      request.mode,
      request.id,
      request.skip ? 1 : 0,
      request.mapping ? 1 : 0,
      request.fault,
      request.budget,
    ])
      packet.writeUInt32LE(value, at++ * 4);
  }
  assert.equal(at * 4, packet.length);
  const child = spawnWithInput(exe, packet, {
    maxBuffer: 256000000,
    timeout: 180000,
  });
  assert.equal(
    child.status,
    0,
    `${row.name}: ${child.stderr?.toString() || child.error?.stack || 'native process failure'}`,
  );
  assert.equal(child.signal, null, row.name);
  const data = child.stdout;
  assert.equal(data.length % 4, 0);
  let cursor = 0;
  const word = (): number => {
    assert.ok((cursor + 1) * 4 <= data.length, 'truncated native reply');
    return data.readUInt32LE(cursor++ * 4);
  };
  assert.equal(word(), 0x41464d54);
  const code = word(),
    diagnostic = word(),
    functions = word(),
    count = word();
  assert.equal(count, row.requests.length);
  const results: ComponentResult[] = [];
  for (let i = 0; i < count; i++) {
    const operation = word(),
      code = word(),
      length = word(),
      eventLength = word();
    const facts = Array.from({ length: 128 }, word),
      bytes = Buffer.alloc(length);
    for (let j = 0; j < length; j++) {
      const value = word();
      assert.ok(value <= 255);
      bytes[j] = value;
    }
    const events = Array.from({ length: eventLength }, word);
    results.push({
      operation,
      code,
      text: bytes.toString('utf8'),
      bytes,
      facts,
      events,
    });
  }
  assert.equal(cursor * 4, data.length, 'native reply tail');
  return { code, diagnostic, functions, results };
}
