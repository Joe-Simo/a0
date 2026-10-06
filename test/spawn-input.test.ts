import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnWithInput } from '../src/toolchain.js';

test('spawnWithInput delivers a large stdin to the child whole, as a file', {
  skip: process.platform === 'win32' && '/bin/cat is POSIX',
}, () => {
  const input = Buffer.alloc(300_000);
  for (let i = 0; i < input.length; i += 1) input[i] = (i * 31 + (i >> 8)) & 255;
  const r = spawnWithInput('/bin/cat', input, { timeout: 30_000, maxBuffer: 1 << 24 });
  assert.equal(r.status, 0);
  assert.ok(Buffer.compare(r.stdout, input) === 0);
});

test('spawnWithInput with an empty input gives the child an empty stdin', {
  skip: process.platform === 'win32' && '/bin/cat is POSIX',
}, () => {
  const r = spawnWithInput('/bin/cat', Buffer.alloc(0), { timeout: 30_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, 0);
});
