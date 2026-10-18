import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { wasmStackBound } from '../tools/wasm-stack-bound.js';

const leb = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const signed = (value: number): number[] => {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 127;
    value >>= 7;
    const done = (value === 0 && !(byte & 64)) || (value === -1 && Boolean(byte & 64));
    bytes.push(byte | (done ? 0 : 128));
    if (done) return bytes;
  }
};
const section = (id: number, contents: number[]): number[] => [
  id,
  ...leb(contents.length),
  ...contents,
];
const text = (value: string): number[] => [...leb(value.length), ...Buffer.from(value)];
const get = (local: number): number[] => [0x20, ...leb(local)];
const constant = (value: number): number[] => [0x41, ...signed(value)];
const call = (index: number): number[] => [...get(0), 0x10, ...leb(index), 0x1a];
const framed = (frame: number, middle: number[] = [], restore = frame): number[] => [
  0x23,
  0,
  ...constant(frame),
  0x6b,
  0x22,
  1,
  0x24,
  0,
  ...middle,
  ...get(1),
  ...constant(restore),
  0x6a,
  0x24,
  0,
  ...get(0),
  0x0b,
];
interface FixtureOptions {
  imports?: boolean;
  table?: boolean;
  extraGlobal?: boolean;
  data?: boolean;
}
/** Every function takes and returns i32, with one i32 local available for its frame. */
const moduleBytes = (functions: number[][], options: FixtureOptions = {}): Uint8Array => {
  const imported = options.imports ? 1 : 0;
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...(options.imports ? section(2, [1, ...text('host'), ...text('call'), 0, 0]) : []),
    ...section(3, [...leb(functions.length), ...functions.map(() => 0)]),
    ...(options.table ? section(4, [1, 0x70, 0, 1]) : []),
    ...section(5, [1, 0, 1]),
    ...section(6, [
      options.extraGlobal ? 2 : 1,
      0x7f,
      1,
      ...constant(4096),
      0x0b,
      ...(options.extraGlobal ? [0x7f, 1, ...constant(4096), 0x0b] : []),
    ]),
    ...section(7, [1, ...text('run'), 0, ...leb(imported)]),
    ...section(10, [
      ...leb(functions.length),
      ...functions.flatMap((body) => {
        const complete = [1, 1, 0x7f, ...body];
        return [...leb(complete.length), ...complete];
      }),
    ]),
    ...(options.data ? section(11, [1, 0, ...constant(0), 0x0b, 1, 0]) : []),
  ]);
};
const rejected = (bytes: Uint8Array, diagnostic: RegExp): void => {
  assert.ok(WebAssembly.validate(new Uint8Array(bytes)), 'negative fixture must be valid Wasm');
  assert.throws(() => wasmStackBound(bytes), diagnostic);
};

test('stack proof derives frame chains, sibling maxima, depths and artifact identity', () => {
  const bytes = moduleBytes([
    framed(16, [...call(1), ...call(3)]),
    framed(32, call(2)),
    framed(48),
    framed(64),
  ]);
  const proof = wasmStackBound(bytes);
  assert.equal(proof.maxLinearStackBytes, 96); // 16 + 32 + 48, not all siblings combined.
  assert.equal(proof.maxCallDepth, 3);
  assert.equal(proof.artifactSHA256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(proof.artifactBytes, bytes.length);
  assert.deepEqual(
    proof.functions.map((fn) => [fn.frameBytes, fn.cumulativeFrameBytes, fn.maxCallDepth]),
    [
      [16, 96, 3],
      [32, 80, 2],
      [48, 48, 1],
      [64, 64, 1],
    ],
  );
  assert.deepEqual(proof.functions[0]?.calls, [1, 3]);
  assert.deepEqual(proof.exports.run?.frameBoundPath, [0, 1, 2]);
  assert.equal(proof.functions[0]?.globalAccesses.length, 3);
  assert.equal(proof.unknownOpcodes, 0);
});

test('frameless helpers, loops, internal branches and bulk memory do not add C stack', () => {
  const loop = [0x02, 0x40, 0x03, 0x40, ...constant(0), 0x0d, 0, 0x0c, 1, 0x0b, 0x0b];
  const bulk = [
    ...constant(0),
    ...constant(0),
    ...constant(0),
    0xfc,
    10,
    0,
    0,
    ...constant(0),
    ...constant(0),
    ...constant(0),
    0xfc,
    11,
    0,
  ];
  const proof = wasmStackBound(
    moduleBytes([framed(32, [...loop, ...bulk, ...call(1)]), [...get(0), 0x0b]]),
  );
  assert.equal(proof.maxLinearStackBytes, 32);
  assert.equal(proof.maxCallDepth, 2);
  assert.equal(proof.functions[1]?.frameBytes, 0);
  assert.equal(proof.opcodeHistogram['0xfc/10'], 1);
  assert.equal(proof.opcodeHistogram['0xfc/11'], 1);
  assert.equal(wasmStackBound(moduleBytes([[...get(0), 0x0b]])).maxLinearStackBytes, 0);
});

test('stack proofs reject mismatched frames, modified frame locals and hidden global reads', () => {
  rejected(moduleBytes([framed(16, [], 32)]), /unsupported epilogue/);
  rejected(moduleBytes([framed(17)]), /positive aligned frame/);
  const variable = framed(16);
  variable.splice(2, 2, ...get(0));
  rejected(moduleBytes([variable]), /unsupported prologue/);
  rejected(moduleBytes([framed(16, [...constant(0), 0x21, 1])]), /frame local modified/);
  rejected(moduleBytes([framed(16, [0x23, 0, 0x1a])]), /unexpected stack global access/);
  rejected(moduleBytes([framed(16)], { extraGlobal: true }), /exactly one stack global/);
});

test('all normal exits must pass restoration, including conditional and table branches', () => {
  rejected(moduleBytes([framed(16, [...get(0), 0x0f])]), /early return/);
  rejected(moduleBytes([framed(16, [...get(0), 0x0c, 0])]), /branch skips restoration/);
  rejected(
    moduleBytes([framed(16, [...get(0), ...constant(1), 0x0d, 0, 0x1a])]),
    /branch skips restoration/,
  );
  rejected(
    moduleBytes([framed(16, [...get(0), ...constant(0), 0x0e, 0, 0])]),
    /branch skips restoration/,
  );
});

test('recursion, host imports and indirect calls cannot acquire a guessed bound', () => {
  rejected(moduleBytes([framed(16, call(0))]), /recursive call graph/);
  rejected(moduleBytes([framed(16, call(1)), framed(32, call(0))]), /recursive call graph/);
});

test('unsupported module features and instructions fail closed', () => {
  rejected(moduleBytes([framed(16)], { imports: true }), /imports cannot be bounded/);
  rejected(
    moduleBytes([framed(16, [...get(0), ...constant(0), 0x11, 0, 0, 0x1a])], { table: true }),
    /unsupported opcode 0x11/,
  );
  rejected(moduleBytes([framed(16, [0xd0, 0x70, 0x1a])]), /unsupported opcode 0xd0/);
  rejected(
    moduleBytes([framed(16, [0xfd, 0x0c, ...Array<number>(16).fill(0), 0x1a])]),
    /unsupported opcode 0xfd/,
  );
  rejected(
    moduleBytes([framed(16, [0x43, 0, 0, 0, 0, 0xfc, 0, 0x1a])]),
    /unsupported prefixed opcode 0/,
  );
  rejected(moduleBytes([framed(16)], { data: true }), /unsupported section 11/);
  const malformed = moduleBytes([framed(16)]).slice(0, -1);
  assert.throws(() => wasmStackBound(malformed), /invalid module/);
});
