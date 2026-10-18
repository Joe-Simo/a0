import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { makeIo, run, type Value } from '../src/core.js';
import { link } from '../src/link.js';

test('scalar and acknowledgement replies preserve bounded draining and protocol failures', async () => {
  const program = (await link('compiler/arena.a0', (path) => readFile(path, 'utf8'))).program;
  const first = program.byName.get('arena_reply_first'),
    ack = program.byName.get('arena_ack');
  assert.ok(first && ack);
  for (const status of [0, 1, 2, 3, 4, 5, 0xffff_ffff])
    for (const count of [0, 1, 2, 127, 128, 129, 0xffff_ffff]) {
      const n = Math.min(count, 128);
      const payload = Array.from({ length: n }, (_, index) => (0x12345678 + index) >>> 0);
      const input = [status, count, ...payload, 0xcafe_babe];
      const stream = makeIo(input),
        reply = run(first, [stream]) as readonly Value[];
      assert.deepEqual(reply.slice(0, 3), [count > 128 ? 1 : status, count, payload[0] ?? 0]);
      assert.equal(reply[3], stream);
      assert.equal(stream.position, 2 + n, `${status}/${count}: bounded payload is consumed`);
      assert.deepEqual(stream.output, []);
      const ackStream = makeIo(input),
        acknowledgement = run(ack, [ackStream]) as readonly Value[];
      assert.equal(
        acknowledgement[0],
        count === 0 ? status : 1,
        `${status}/${count}: acknowledgement`,
      );
      assert.equal(acknowledgement[1], ackStream);
      assert.equal(ackStream.position, 2 + n);
    }
});

test('allocation scalar replies retain handle-zero refusal and request framing', async () => {
  const program = (await link('compiler/arena.a0', (path) => readFile(path, 'utf8'))).program;
  const alloc = program.byName.get('arena_alloc');
  assert.ok(alloc);
  for (const [input, expected] of [
    [
      [0, 1, 17],
      [0, 17],
    ],
    [
      [0, 1, 0],
      [1, 0],
    ],
    [
      [4, 0],
      [4, 0],
    ],
    [
      [0, 2, 17, 19],
      [1, 0],
    ],
  ] as const) {
    const stream = makeIo(input),
      result = run(alloc, [stream, 64]) as readonly Value[];
    assert.deepEqual(result.slice(0, 2), expected);
    assert.equal(result[2], stream);
    assert.equal(stream.position, input.length);
    assert.deepEqual(stream.output, [1, 1, 64]);
  }
});
