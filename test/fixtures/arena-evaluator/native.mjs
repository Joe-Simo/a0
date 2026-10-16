// Native test transport. TS parse/validation below only encodes independent
// checked-table fixtures and names for assertions; it never executes a fallback.
import assert from 'node:assert/strict';
import { parseAndValidate } from '../../../dist/src/core.js';
import { spawnWithInput } from '../../../dist/src/toolchain.js';
import { Arena, encodeIR, floatWords, fromFloatWords, inputValue, valueOut } from './model.mjs';

export function nativeRuntime(exe) {
  let requests = 0;
  function invoke(words) {
    const input = Buffer.alloc(words.length * 4);
    for (const [i, word] of words.entries()) input.writeUInt32LE(word >>> 0, i * 4);
    const ran = spawnWithInput(exe, input, { timeout: 120_000, maxBuffer: 1 << 28 });
    requests++;
    assert.equal(ran.error, undefined);
    assert.equal(ran.signal, null, ran.stderr.toString());
    assert.equal(ran.status, 0, ran.stderr.toString());
    assert.equal(ran.stderr.length, 0, ran.stderr.toString());
    assert.equal(ran.stdout.length % 4, 0);
    return Array.from({ length: ran.stdout.length / 4 }, (_, i) => ran.stdout.readUInt32LE(i * 4));
  }
  function packet(
    arena,
    ir,
    mode = 0,
    source = 0,
    len = 0,
    fn = 0,
    args = [0, 0, 0],
    options = { fuel: 10000 },
    quantum = 7,
    extra = [],
  ) {
    const words = [0x41454556, mode, arena.max, quantum, arena.heap.length - 1];
    for (const block of arena.heap.slice(1)) {
      words.push(block.length);
      for (const value of block) words.push(value);
    }
    words.push(
      ...ir,
      source,
      len,
      fn,
      ...args,
      ...floatWords(options.fuel),
      options.maxTrips !== undefined ? 1 : 0,
      ...floatWords(options.maxTrips ?? 0),
      ...extra,
    );
    return words;
  }
  function decode(words) {
    let i = 0;
    const word = () => {
      assert.ok(i < words.length, 'truncated native output');
      return words[i++];
    };
    assert.equal(word(), 0x41454556);
    const resumes = word() + word() * 2 ** 32;
    const m = Uint32Array.from(Array.from({ length: 128 }, word));
    const ir = Uint32Array.from(Array.from({ length: 128 }, word));
    const count = word();
    const arena = {
      heap: [null],
      get(v) {
        return Array.from(this.heap[v[0]]?.slice(0, v[1]) ?? []);
      },
    };
    for (let j = 0; j < count; j++)
      arena.heap.push(Uint32Array.from(Array.from({ length: word() }, word)));
    assert.equal(i, words.length, 'complete native output');
    return { m, ir, arena, resumes };
  }
  function execute(
    source,
    fn,
    args = [],
    options = { fuel: 100000000 },
    route = 'table',
    quantum = 7,
  ) {
    const p = parseAndValidate(source);
    const a = new Arena();
    const ir = encodeIR(a, p);
    const ioMap = new Map();
    const av = a.put(args.flatMap((v) => inputValue(a, v, ioMap)));
    const mode = route === 'source' ? 1 : 0;
    const sv = mode ? a.put(Array.from(Buffer.from(source, 'utf8'))) : [0, 0, 0];
    const original = [41, 44, 47, 50, 68, 71, 97, 100].map((off) => [
      ir.state[off],
      a.heap[ir.state[off]] && Array.from(a.heap[ir.state[off]]),
    ]);
    const got = decode(
      invoke(packet(a, ir.state, mode, sv[0], sv[1], ir.functions.get(fn), av, options, quantum)),
    );
    for (const [handle, words] of original)
      if (handle)
        assert.deepEqual(Array.from(got.arena.heap[handle]), words, 'original IR is immutable');
    const m = got.m;
    const frames = got.arena.get(Array.from(m.slice(32, 35)));
    const trap = { chain: [], at: null, trip: null, fn: '-' };
    for (let i = 0; i < frames.length; i += 24) {
      trap.chain.push(ir.names[frames[i]]);
      trap.fn = ir.names[frames[i]];
      if (frames[i + 7] !== 0xffffffff) {
        trap.at = `${ir.names[frames[i]]}.${ir.nodeNames[frames[i + 7]]}`;
        trap.trip = frames[i + 8];
      }
    }
    return {
      ...got,
      status: m[0],
      id: m[1],
      value: m[0] === 0 ? valueOut(got.arena, m[9], m[10]) : undefined,
      fuel: fromFloatWords(m.slice(4, 6)),
      maxTrips: fromFloatWords(m.slice(7, 9)),
      trap,
    };
  }
  return { invoke, packet, decode, execute, requests: () => requests };
}
