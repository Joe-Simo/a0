import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { A0Error, parseAndValidate, type TypedProgram, type Value } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import {
  a0OptimizeProgram,
  a0WasmFromSource,
  a0WasmFromTables,
  buildWasmTool,
  typescriptWasm,
} from '../tools/selfhost-wasm.js';
import { CHECKED_SOURCE, checkedCases } from './fixtures/checked-ops-fixtures.js';

const CLANG = findClang();
const SKIP =
  process.env.A0W_TOOL !== undefined
    ? false
    : CLANG.path === undefined
      ? 'clang is unavailable'
      : false;
const LAYOUT = { ioInputCapacity: 2, ioOutputCapacity: 4 };
const MODES = ['tables', 'source'] as const;
type Mode = (typeof MODES)[number];
let buildRoot: string | undefined;
let tool: Promise<string> | undefined;

after(async () => {
  if (buildRoot !== undefined) await rm(buildRoot, { recursive: true, force: true });
});

function executable(): Promise<string> {
  tool ??=
    process.env.A0W_TOOL !== undefined
      ? Promise.resolve(process.env.A0W_TOOL)
      : (async () => {
          await mkdir('.a0-cache', { recursive: true });
          buildRoot = await mkdtemp(resolve('.a0-cache', 'selfhost-checked-wasm-'));
          return (await buildWasmTool(CLANG, undefined, buildRoot)).exe;
        })();
  return tool;
}

function emit(exe: string, mode: Mode, program: TypedProgram, optimize = false): Uint8Array {
  if (mode === 'tables') return a0WasmFromTables(exe, program, LAYOUT, optimize).bytes;
  const result = a0WasmFromSource(exe, program, LAYOUT, optimize);
  assert.equal(result.code, 0, 'the A0 source frontend accepts the checked program');
  assert.ok(result.bytes !== undefined);
  return result.bytes;
}

function scalar(value: Value): number {
  assert.ok(typeof value === 'number' || typeof value === 'boolean');
  return Number(value);
}

function entry(instance: WebAssembly.Instance, name: string): (...args: number[]) => number {
  const fn = instance.exports[`a0_${name}`];
  assert.equal(typeof fn, 'function', name);
  return fn as (...args: number[]) => number;
}

for (const [mode, optimize] of MODES.flatMap((mode) =>
  [false, true].map((optimize) => [mode, optimize] as const),
)) {
  test(`A0 Wasm checked ${mode} optimize=${optimize} equal the independent integer oracle`, {
    skip: SKIP,
  }, async () => {
    const program = parseAndValidate(CHECKED_SOURCE);
    const cases = checkedCases();
    assert.equal(cases.length, 2356);
    const bytes = emit(await executable(), mode, program, optimize);
    // Keep the existing canonical byte comparison separate from semantic oracle checks.
    assert.deepEqual(
      bytes,
      typescriptWasm(program, LAYOUT, optimize),
      `${mode}: checked byte parity optimize=${optimize}`,
    );
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    for (const c of cases) {
      const got = entry(instance, c.functionName)(...c.args.map(scalar));
      assert.equal(
        got >>> 0,
        scalar(c.expected) >>> 0,
        `${mode}: ${c.functionName}(${c.args.map(scalar).join(',')})`,
      );
    }
  });
}

// Two read nodes are the operand producers. Repeated operand pushes in checked lowering
// must reload their values rather than issuing additional reads, including at exhaustion.
const EFFECT = parseAndValidate(`fn effect io -> u32
a read p0
x at a 0
t1 at a 1
b read t1
y at b 0
t2 at b 1
r cmul x y
v at r 0
ok at r 1
flag select ok 1 0
w0 write t2 v
w1 write w0 flag
ret v
end
`);
const EFFECT_INPUTS = [[], [0xffffffff], [0xffffffff, 0xffffffff], [65536, 65536], [7, 13]];

// More nested bodies than the inline-frame limit must remain ordinary calls.
// The runtime bound belongs to the outer loop and must survive failed probes
// of a deeper body or predicate. The mixing step prevents a constant sum from
// replacing the loop and gives a separate integer oracle for every iteration.
const NESTED = parseAndValidate(
  `fn step0 u32 u32 -> u32
a mul p0 1664525
b add a p1
r xor b 1013904223
ret r
end
${Array.from(
  { length: 5 },
  (_, i) => `fn step${i + 1} u32 u32 -> u32
r fold step${i} 2 p0
ret r
end
`,
).join('')}
fn keep u32 u32 -> bool
ret lt p1 3
end
${Array.from(
  { length: 6 },
  (_, depth) => `fn probe${depth} u32 u32 -> u32
s add p1 2
r fold step${depth} p0 s
ret r
end
`,
).join('')}
fn limited u32 u32 -> u32
s add p1 2
r loop keep step3 p0 s
ret r
end
${[
  ['foldio', 'probe5'],
  ['loopio', 'limited'],
]
  .map(
    ([name, callee]) => `fn ${name} io -> u32
a read p0
count at a 0
i1 at a 1
b read i1
seed at b 0
i2 at b 1
r call ${callee} count seed
w write i2 r
ret r
end
`,
  )
  .join('')}`,
);

function nestedStep(depth: number, value: number, trip: number): number {
  if (depth === 0)
    return Number(((BigInt(value) * 1664525n + BigInt(trip)) & 0xffffffffn) ^ 1013904223n);
  let out = value;
  for (let i = 0; i < 2; i++) out = nestedStep(depth - 1, out, i);
  return out;
}

function nestedExpected(depth: number, count: number, seed: number, limit = count): number {
  let out = (seed + 2) >>> 0;
  for (let i = 0; i < Math.min(count, limit); i++) out = nestedStep(depth, out, i);
  return out;
}

for (const [mode, optimize] of MODES.flatMap((mode) =>
  [false, true].map((optimize) => [mode, optimize] as const),
)) {
  test(`A0 Wasm nested loops ${mode} optimize=${optimize} preserve bounds and IO`, {
    skip: SKIP,
  }, async () => {
    const bytes = emit(await executable(), mode, NESTED, optimize);
    assert.deepEqual(bytes, typescriptWasm(NESTED, LAYOUT, optimize));
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    const memory = instance.exports.memory;
    const base = instance.exports.__heap_base;
    assert.ok(memory instanceof WebAssembly.Memory && base instanceof WebAssembly.Global);
    const pointer = Number(base.value) >>> 0;
    const words = LAYOUT.ioInputCapacity + LAYOUT.ioOutputCapacity + 3;
    const end = pointer + words * 4;
    if (end > memory.buffer.byteLength)
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    for (const count of [0, 1, 2, 5]) {
      for (const seed of [0, 0xffffffff]) {
        for (let depth = 0; depth <= 5; depth++)
          assert.equal(
            entry(instance, `probe${depth}`)(count, seed) >>> 0,
            nestedExpected(depth, count, seed),
          );
        assert.equal(
          entry(instance, 'limited')(count, seed) >>> 0,
          nestedExpected(3, count, seed, 3),
        );
        for (const [name, depth, limit] of [
          ['foldio', 5, count],
          ['loopio', 3, 3],
        ] as const) {
          const io = new Uint32Array(memory.buffer, pointer, words);
          io.fill(0);
          io.set([count, seed]);
          io[2] = 2;
          const expected = nestedExpected(depth, count, seed, limit);
          assert.equal(entry(instance, name)(pointer) >>> 0, expected);
          const result: Uint32Array = new Uint32Array(memory.buffer, pointer, words);
          assert.deepEqual([...result.slice(0, 4)], [count, seed, 2, 2]);
          assert.equal(result[4], expected);
          assert.equal(result[8], 1);
        }
      }
    }
  });
}

for (const [mode, optimize] of MODES.flatMap((mode) =>
  [false, true].map((optimize) => [mode, optimize] as const),
)) {
  test(`A0 Wasm checked ${mode} optimize=${optimize} evaluate IO operands once`, {
    skip: SKIP,
  }, async () => {
    const bytes = emit(await executable(), mode, EFFECT, optimize);
    assert.deepEqual(
      bytes,
      typescriptWasm(EFFECT, LAYOUT, optimize),
      `${mode}: checked IO byte parity`,
    );
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    const memory = instance.exports.memory;
    const heapBase = instance.exports.__heap_base;
    assert.ok(memory instanceof WebAssembly.Memory);
    assert.ok(heapBase instanceof WebAssembly.Global);
    const ptr = Number(heapBase.value);
    assert.ok(Number.isSafeInteger(ptr) && ptr >= 0 && ptr % 4 === 0);
    // IO layout: two inputs, count, position, four outputs, output count.
    const words = LAYOUT.ioInputCapacity + LAYOUT.ioOutputCapacity + 3;
    const end = ptr + words * 4;
    if (end > memory.buffer.byteLength)
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    const effect = entry(instance, 'effect');
    for (const input of EFFECT_INPUTS) {
      const io = new Uint32Array(memory.buffer, ptr, words);
      io.fill(0);
      io.set(input);
      io[2] = input.length;
      const product = BigInt(input[0] ?? 0) * BigInt(input[1] ?? 0);
      const value = Number(BigInt.asUintN(32, product));
      const ok = Number(product <= 0xffffffffn);
      assert.equal(effect(ptr) >>> 0, value, `${mode}: product for ${input}`);
      const result: Uint32Array = new Uint32Array(memory.buffer, ptr, words);
      assert.equal(result[3], input.length, `${mode}: input position for ${input}`);
      assert.equal(result[8], 2, `${mode}: output count for ${input}`);
      assert.deepEqual([...result.slice(4, 6)], [value, ok], `${mode}: output for ${input}`);
    }
  });
}

test('A0 Wasm preserves default operation bytes at both optimizer settings', {
  skip: SKIP,
}, async () => {
  const program = parseAndValidate(`fn step u32 u32 u32 -> u32
a add p0 p2
b xor a p1
ret b
end
fn probe u32 u32 -> u32
r fold step 7 p0 p1
ret r
end
`);
  const exe = await executable();
  for (const optimize of [false, true])
    for (const mode of MODES)
      assert.deepEqual(
        emit(exe, mode, program, optimize),
        typescriptWasm(program, LAYOUT, optimize),
        `${mode}: default byte parity optimize=${optimize}`,
      );
});

test('A0 Wasm explicitly refuses strict requests at both optimizer settings before starting a tool', () => {
  const unusable = 'unusable-tool-must-not-run';
  const unsupported = (thunk: () => unknown): void => {
    assert.throws(thunk, (error: unknown) => error instanceof A0Error && error.id === 'A0713');
  };
  for (const source of [
    'profile strict\nfn q u32 -> u32\nret p0\nend\n',
    'profile strict\nfn q u32 u32 -> u32\nr cdiv p0 p1\nv at r 0\nret v\nend\n',
  ]) {
    const strict = parseAndValidate(source);
    for (const mode of MODES)
      for (const optimize of [false, true])
        unsupported(() => emit(unusable, mode, strict, optimize));
    unsupported(() => a0OptimizeProgram(unusable, strict));
  }
});

test('checked get continues to require u32 array elements', () => {
  for (const source of [
    'fn q u32 -> u32\na arr true false\nr cget a p0\nv at r 0\nret v\nend\n',
    'fn q u32 -> u32\na rec 7 true\nb arr a a\nr cget b p0\nv at r 0\nret v\nend\n',
  ])
    assert.throws(
      () => parseAndValidate(source),
      (error: unknown) => error instanceof A0Error && error.id === 'A0209',
    );
});

// Each hidden helper has 25 live nodes: more than the ordinary call/frame/body inline
// limits (8/16/24). Its opaque row therefore needs the fusion closure scan to request it.
// The padding functions cross both frontend (2730) and emitter (2816) node capacities.
function opaqueFusionSource(checked: boolean): string {
  const mix = (first: string, count: number): string =>
    Array.from(
      { length: count },
      (_, i) =>
        `m${i} ${i % 2 === 0 ? 'add' : 'xor'} ${i === 0 ? first : `m${i - 1}`} ${i % 2 === 0 ? 'p1' : (0x9e3779b9 + i) >>> 0}`,
    ).join('\n');
  const producer = checked
    ? 'pair cadd p0 p1\nvalue at pair 0\nok at pair 1\nmask select ok 1515870810 2779096485\nseed xor value mask'
    : 'value add p0 p1\nok ge value p0\nmask select ok 1515870810 2779096485\nx xor value mask\nseed mov x';
  const consumer = checked
    ? 'pair cdiv p0 p1\nvalue at pair 0\nok at pair 1\nmask select ok 2863311530 1431655765\nx xor value mask\nseed mov x'
    : 'ok ne p1 0\nd select ok p1 1\nq div p0 d\nvalue select ok q 0\nmask select ok 2863311530 1431655765\nseed xor value mask';
  const predicate = checked ? 'pair csub p1 p0\nok at pair 1' : 'geq ge p1 p0\nok mov geq';
  const nots = Array.from(
    { length: 23 },
    (_, i) => `b${i} xor ${i === 0 ? 'ok' : `b${i - 1}`} true`,
  ).join('\n');
  const pad = (name: string): string => `fn ${name} u32 u32 -> u32
${Array.from({ length: 1404 }, (_, i) => `n${i} add ${i === 0 ? 'p0' : `n${i - 1}`} p1`).join('\n')}
ret n1403
end
`;
  return `fn hidden_producer u32 u32 -> u32
${producer}
${mix('seed', 20)}
ret m19
end
fn hidden_consumer u32 u32 -> u32
${consumer}
${mix('seed', 19)}
ret m18
end
fn hidden_predicate u32 u32 -> bool
${predicate}
${nots}
ret b22
end
${pad('fusion_pad_a')}${pad('fusion_pad_b')}fn fill_checked u32x8 u32 u32 -> u32x8
v call hidden_producer p2 p1
r set p0 p1 v
ret r
end
fn fill_plain u32x8 u32 u32 -> u32x8
v add p2 p1
r set p0 p1 v
ret r
end
fn sum_plain u32 u32 u32x8 -> u32
v get p2 p1
r add p0 v
ret r
end
fn sum_checked u32 u32 u32x8 u32 -> u32
x get p2 p1
v call hidden_consumer x p3
r add p0 v
ret r
end
fn nested_predicate u32 u32 u32 -> bool
r call hidden_predicate p2 p1
ret r
end
fn nested_step u32 u32 u32 -> u32
r add p0 3
ret r
end
fn sum_predicate u32 u32 u32x8 u32 -> u32
v get p2 p1
q loop nested_predicate nested_step 4 v p3
r add p0 q
ret r
end
fn fusion_producer u32 u32 -> u32
z arr 0 0 0 0 0 0 0 0
a fold fill_checked 8 z p0
r fold sum_plain 8 p1 a
ret r
end
fn fusion_consumer u32 u32 -> u32
z arr 0 0 0 0 0 0 0 0
a fold fill_plain 8 z p1
r fold sum_checked 8 p1 a p0
ret r
end
fn fusion_predicate u32 u32 -> u32
limit and p0 7
z arr 0 0 0 0 0 0 0 0
a fold fill_plain 8 z p1
r fold sum_predicate 8 p1 a limit
ret r
end
`;
}

const FUSION_ENTRIES = ['fusion_producer', 'fusion_consumer', 'fusion_predicate'] as const;
const FUSION_INPUTS = [
  [0, 0],
  [0, 0xffffffff],
  [1, 7],
  [7, 13],
  [0xffffffff, 1],
  [0x80000000, 0xffffffff],
  [0xffffffff, 0xffffffff],
  [65536, 65536],
] as const;

function opaqueFusionOracle(name: (typeof FUSION_ENTRIES)[number], a: number, b: number): number {
  const u32 = (x: bigint): bigint => BigInt.asUintN(32, x);
  const mix = (seed: bigint, extra: bigint, count: number): bigint => {
    let value = seed;
    for (let i = 0; i < count; i += 1)
      value = u32(i % 2 === 0 ? value + extra : value ^ BigInt((0x9e3779b9 + i) >>> 0));
    return value;
  };
  let sum = BigInt(b);
  for (let i = 0; i < 8; i += 1) {
    let value: bigint;
    if (name === 'fusion_producer') {
      const full = BigInt(a) + BigInt(i);
      const seed = u32(full) ^ (full <= 0xffffffffn ? 1515870810n : 2779096485n);
      value = mix(seed, BigInt(i), 20);
    } else {
      value = u32(BigInt(b) + BigInt(i));
      if (name === 'fusion_consumer') {
        const seed = a === 0 ? 1431655765n : (value / BigInt(a)) ^ 2863311530n;
        value = mix(seed, BigInt(a), 19);
      } else {
        // The predicate negates the checked unsigned subtraction flag 23 times:
        // index < limit. Its bounded loop therefore adds three min(4,limit) times.
        value = u32(value + 3n * BigInt(Math.min(4, a & 7)));
      }
    }
    sum = u32(sum + value);
  }
  return Number(sum);
}

for (const mode of MODES) {
  test(`A0 Wasm ${mode} fusion retries opaque checked producer, consumer and predicate closures`, {
    skip: SKIP,
  }, async () => {
    const { encodeChunk } = await import('../tools/selfhost-wasm.js');
    const { planChunks } = await import('../tools/bootstrap.js');
    const { fuseLoops } = await import('../src/optimize.js');
    const exe = await executable();
    for (const checked of [false, true]) {
      const source = opaqueFusionSource(checked);
      const program = parseAndValidate(source);
      const from = program.functions.findIndex((fn) => fn.name === 'fusion_pad_b');
      assert.ok(from > 0);
      assert.ok(encodeChunk(program.functions, 0, from).fits);
      assert.equal(encodeChunk(program.functions, 0, from + 1).fits, false);
      const chunk = encodeChunk(program.functions, from, program.functions.length);
      assert.ok(chunk.fits);
      let offset = 1 + (chunk.words[0] as number) * 3;
      offset += 1 + (chunk.words[offset] as number);
      const rows = offset + 1;
      for (const name of ['hidden_producer', 'hidden_consumer', 'hidden_predicate']) {
        const index = program.functions.findIndex((fn) => fn.name === name);
        const helper = program.functions[index];
        assert.ok(helper !== undefined);
        assert.equal(helper.nodes.length, 25, name);
        assert.ok(chunk.before.includes(index), `${name} starts outside the table chunk`);
        const local = chunk.local.get(index);
        assert.ok(local !== undefined);
        assert.equal(chunk.words[rows + local * 7 + 6], 0, `${name} starts opaque`);
      }
      const planned = planChunks(source);
      assert.equal(planned.length, 2);
      const second = planned[1];
      assert.ok(second !== undefined);
      for (const name of FUSION_ENTRIES) assert.ok(second.own.includes(name));
      for (const name of ['hidden_producer', 'hidden_consumer', 'hidden_predicate'])
        assert.ok(second.before.includes(name), `${name} starts as a source stub`);

      let bytes: Uint8Array;
      if (checked) {
        // Keep the run counts here: bytes alone would not establish missing-body retry.
        const result =
          mode === 'tables'
            ? a0WasmFromTables(exe, program, LAYOUT, false)
            : a0WasmFromSource(exe, program, LAYOUT, false);
        if ('code' in result) assert.equal(result.code, 0);
        assert.ok(result.bytes !== undefined);
        assert.ok(result.chunks >= 2);
        assert.ok(result.runs > result.chunks, `${mode}: opaque closure bodies were requested`);
        bytes = result.bytes;
      } else {
        for (const name of FUSION_ENTRIES) {
          const fn = program.byName.get(name);
          assert.ok(fn !== undefined);
          assert.equal(fn.nodes.filter((node) => node.op === 'fold').length, 2);
          const fused = fuseLoops(fn, { recordState: true });
          assert.ok(fused !== undefined, `${name}: ordinary twin is a fusion candidate`);
          assert.equal(fused.nodes.filter((node) => node.op === 'fold').length, 1);
        }
        bytes = emit(exe, mode, program);
        assert.deepEqual(
          bytes,
          typescriptWasm(program, LAYOUT, false),
          `${mode}: ordinary fusion bytes`,
        );
      }
      const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
      for (const name of FUSION_ENTRIES)
        for (const [a, b] of FUSION_INPUTS)
          assert.equal(
            entry(instance, name)(a, b) >>> 0,
            opaqueFusionOracle(name, a, b),
            `${mode}: ${name}(${a},${b}), checked=${checked}`,
          );
    }
  });
}

test('A0 Wasm source capacity retries replace a whole plan with real subchunks', {
  skip: SKIP,
}, async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const source = `fn capacity_first u32 -> u32
r add p0 1
ret r
end
fn capacity_second u32 -> u32
r call capacity_first p0
ret r
end
fn capacity_third u32 -> u32
r call capacity_second p0
ret r
end
fn capacity_last u32 -> u32
r add p0 2
ret r
end
`;
  const { planChunks } = await import('../tools/bootstrap.js');
  assert.equal(planChunks(source)[0]?.own.length, 0, 'the initial frontend plan is whole-source');
  const actualTool = resolve(await executable());
  await mkdir('.a0-cache', { recursive: true });
  const dir = await mkdtemp(resolve('.a0-cache', 'selfhost-wasm-capacity-'));
  try {
    const config = resolve(dir, 'config.json');
    const proxy = resolve(dir, 'proxy.cjs');
    const driver = resolve(dir, 'driver.mjs');
    const tracePath = resolve(dir, 'trace.jsonl');
    const resultPath = resolve(dir, 'result.json');
    await writeFile(
      config,
      JSON.stringify({
        source,
        layout: LAYOUT,
        actualTool,
        tracePath,
        resultPath,
        core: new URL('../src/core.js', import.meta.url).href,
        emitter: new URL('../tools/selfhost-wasm.js', import.meta.url).href,
      }),
    );
    // Node is a portable executable proxy. The preload passes through for driver.mjs;
    // tool processes have no script argument and enter the binary-protocol branch.
    // Only the original full-source packet is refused. Every real subchunk and the
    // module link execute the actual A0 compiler and return its unmodified output.
    await writeFile(
      proxy,
      String.raw`const assert = require('node:assert/strict');
const { appendFileSync, fstatSync, readFileSync, readSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.length === 1) {
  try {
    const cfg = JSON.parse(readFileSync(process.env.A0_WASM_CAPACITY_CONFIG, 'utf8'));
    const stat = fstatSync(0);
    assert.ok(stat.isFile(), 'the driver supplies stdin through a regular file');
    const input = Buffer.alloc(stat.size);
    for (let offset = 0; offset < input.length;) {
      const count = readSync(0, input, offset, input.length - offset, offset);
      assert.ok(count > 0);
      offset += count;
    }
    assert.equal(input.length % 4, 0);
    const words = Array.from({ length: input.length / 4 }, (_, i) => input.readUInt32LE(i * 4));
    const mode = words[0];
    let event = { mode };
    let forced = false;
    if (mode === 1) {
      const n = words[1];
      const text = Buffer.from(words.slice(2, n + 2)).toString('utf8');
      const names = [...text.matchAll(/^fn ([a-z0-9_]+) /gm)].map((m) => m[1]);
      const from = words[n + 4];
      event = { mode, before: names.slice(0, from), own: names.slice(from) };
      forced = from === 0 && event.own.length === 4;
      if (forced) assert.deepEqual(event.own, [
        'capacity_first', 'capacity_second', 'capacity_third', 'capacity_last',
      ]);
    }
    if (forced) {
      appendFileSync(cfg.tracePath, JSON.stringify({ ...event, code: 4, forced: true }) + '\n');
      process.exit(4);
    }
    const real = spawnSync(cfg.actualTool, [], {
      stdio: [0, 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1 << 24,
    });
    if (real.status === null) throw new Error(real.error?.message ?? String(real.signal));
    appendFileSync(cfg.tracePath, JSON.stringify({ ...event, code: real.status, forced: false }) + '\n');
    if (real.stderr.length > 0) writeFileSync(2, real.stderr);
    writeFileSync(1, real.stdout);
    process.exit(real.status);
  } catch (error) {
    writeFileSync(2, String(error.stack ?? error));
    process.exit(64);
  }
}
`,
    );
    await writeFile(
      driver,
      `import { readFileSync, writeFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.env.A0_WASM_CAPACITY_CONFIG, 'utf8'));
const { parseAndValidate } = await import(cfg.core);
const { a0WasmFromSource } = await import(cfg.emitter);
try {
const result = a0WasmFromSource(process.execPath, parseAndValidate(cfg.source), cfg.layout);
writeFileSync(cfg.resultPath, JSON.stringify({
  code: result.code, chunks: result.chunks, runs: result.runs,
  bytes: result.bytes === undefined ? undefined : [...result.bytes],
}));
} catch (error) {
  writeFileSync(cfg.resultPath, JSON.stringify({ error: String(error.stack ?? error) }));
  process.exitCode = 1;
}
`,
    );
    const child = spawnSync(process.execPath, [driver], {
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        A0_WASM_CAPACITY_CONFIG: config,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(proxy)}`,
      },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 1 << 20,
    });
    const diagnostic =
      child.stderr ||
      child.stdout ||
      child.error?.message ||
      (await readFile(resultPath, 'utf8').catch(() => 'driver produced no result'));
    assert.equal(child.status, 0, diagnostic);
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
      code: number;
      chunks: number;
      runs: number;
      bytes: number[];
    };
    assert.equal(result.code, 0, await readFile(tracePath, 'utf8'));
    assert.equal(result.chunks, 2);
    const trace = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as {
      mode: number;
      code: number;
      forced: boolean;
      own?: string[];
      before?: string[];
    }[];
    const sources = trace.filter((event) => event.mode === 1);
    assert.equal(sources[0]?.forced, true);
    assert.equal(sources[0]?.code, 4);
    assert.ok(
      sources
        .slice(1)
        .every((event) => !event.forced && event.own !== undefined && event.own.length < 4),
    );
    assert.deepEqual(
      sources.filter((event) => event.code === 0).map((event) => event.own),
      [
        ['capacity_first', 'capacity_second'],
        ['capacity_third', 'capacity_last'],
      ],
    );
    assert.ok(
      sources.some((event) => event.code === 7),
      'real A0 requests an external body',
    );
    assert.equal(result.runs, sources.length);
    assert.deepEqual(
      trace.filter((event) => event.mode === 3).map((event) => event.code),
      [0],
    );
    const bytes = Uint8Array.from(result.bytes);
    assert.deepEqual(bytes, typescriptWasm(parseAndValidate(source), LAYOUT, false));
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    for (const name of ['capacity_first', 'capacity_second', 'capacity_third', 'capacity_last'])
      for (const input of [0, 1, 0x80000000, 0xffffffff])
        assert.equal(
          entry(instance, name)(input) >>> 0,
          Number(BigInt.asUintN(32, BigInt(input) + (name === 'capacity_last' ? 2n : 1n))),
          `${name}(${input})`,
        );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
