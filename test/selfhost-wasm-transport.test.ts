import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate } from '../src/core.js';
import { a0WasmFromTables, type WasmToolReply } from '../tools/selfhost-wasm.js';

test('A0 Wasm word transport rejects malformed status and output before decoding compiler records', () => {
  const program = parseAndValidate('fn f u32 -> u32\nret add p0 1\nend\n');
  const replies: WasmToolReply[] = [-1, 8, 0.5, Number.NaN].map((code) => ({
    code,
    out: new Uint32Array(),
  }));
  replies.push({ code: 0, out: [] as unknown as Uint32Array });
  for (const reply of replies) {
    let calls = 0;
    assert.throws(
      () =>
        a0WasmFromTables(
          (words) => {
            calls++;
            assert.equal(words[0], 2);
            return reply;
          },
          program,
          { ioInputCapacity: 1, ioOutputCapacity: 1 },
        ),
      /invalid A0 Wasm tool transport result/,
    );
    assert.equal(calls, 1);
  }
});
