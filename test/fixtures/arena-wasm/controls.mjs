import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { COMPILER_VERSION } from '../../../dist/src/targets.js';
import { wasmTrap } from '../../../dist/tools/verify.js';
import { CONTROLS, INPUTS } from './alias-models.mjs';
import { compileSource, ROOT } from './transport.mjs';

const dir = ROOT,
  report = {
    status: 'running',
    scope:
      'Actual verified-seed native A0 raw-source compiler; actual WebAssembly runtime; independent BigInt/immutable-value/strict-ABI oracles.',
    rows: [],
  };
await mkdir(dir, { recursive: true });
const U = (x) => Number(BigInt.asUintN(32, BigInt(x)));
const small = 'fn probe u32 -> u32\nx add p0 1\nret x\nend\n';
async function build(source, options = {}) {
  const r = compileSource(source, options);
  assert.equal(r.code, 0);
  assert.ok(WebAssembly.validate(r.bytes));
  const module = await WebAssembly.compile(r.bytes);
  assert.deepEqual(
    WebAssembly.Module.customSections(module, 'a0').map((x) => Buffer.from(x).toString()),
    [COMPILER_VERSION],
  );
  return { ...r, module, instance: await WebAssembly.instantiate(module, {}) };
}
try {
  for (const [label, options, code] of [
    ['simd', { simd: 1 }, 8],
    ['unroll2', { unroll: 2 }, 8],
    ['unroll4', { unroll: 4 }, 8],
    ['optimize', { optimize: 1 }, 8],
    ['schema', { change: (o) => (o[0] = 2) }, 6],
    ['badunroll', { unroll: 3 }, 6],
    ['iooverflow', { input: 0xffffffff, output: 1 }, 7],
    ['allocation', { maxWords: Buffer.byteLength(small) }, 4],
    ['outputbudget', { maxOutput: 0 }, 4],
    ['loadframe', { fault: { op: 2, nth: 1, kind: 2 } }, 1],
    ['loadstatus', { fault: { op: 2, nth: 1, status: 5, kind: 1 } }, 5],
    ['allocstatus', { fault: { op: 1, nth: 1, status: 4, kind: 1 } }, 4],
    ['missingroot', { exports: ['absent'] }, 6],
    ['case-sensitive-root', { exports: ['Probe'] }, 6],
  ]) {
    const r = compileSource(small, options);
    assert.equal(r.code, code, label);
    assert.equal(r.bytes.length, 0);
    report.rows.push({ label, code, status: 'passed' });
  }
  const exportSource =
    'fn unused u32 -> u32\nx mul p0 p0\nret x\nend\nfn leaf u32 -> u32\nx add p0 1\nret x\nend\nfn probe u32 -> u32\nx call leaf p0\nret x\nend\n';
  for (const roots of [undefined, [], ['probe'], ['probe', 'probe']]) {
    const r = await build(exportSource, { exports: roots });
    const wanted = roots === undefined ? ['unused', 'leaf', 'probe'] : [...new Set(roots)];
    assert.deepEqual(
      Object.keys(r.instance.exports).sort(),
      ['memory', '__heap_base', ...wanted.map((x) => 'a0_' + x)].sort(),
    );
    for (const n of wanted)
      assert.equal(r.instance.exports['a0_' + n](7) >>> 0, n === 'unused' ? 49 : 8);
    report.rows.push({ label: 'roots ' + JSON.stringify(roots), status: 'passed' });
  }
  const empty = await build('');
  assert.deepEqual(Object.keys(empty.instance.exports).sort(), ['__heap_base', 'memory']);
  report.rows.push({ label: 'empty', status: 'passed' });
  for (const control of CONTROLS) {
    const r = await build(control.source);
    for (const args of INPUTS) {
      const expected = control.expected(args);
      if (Array.isArray(expected)) {
        const e = r.instance.exports,
          p = Number(e.__heap_base.value) >>> 0;
        assert.equal(e.a0_probe(p, ...args), undefined);
        assert.deepEqual(
          Array.from(new Uint32Array(e.memory.buffer, p, expected.length)),
          expected,
          control.name,
        );
      } else assert.equal(r.instance.exports.a0_probe(...args) >>> 0, expected, control.name);
    }
    report.rows.push({
      label: 'immutable alias ' + control.name,
      cases: INPUTS.length,
      status: 'passed',
    });
  }
  const aggregate = await build(
    await readFile(new URL('./sources/aggregates.a0', import.meta.url), 'utf8'),
  );
  for (const args of INPUTS) {
    const [a, b] = args.map(BigInt);
    assert.equal(aggregate.instance.exports.a0_nested(...args) >>> 0, U(a * 31n + b));
    let v = [a, b],
      sum = 0n;
    for (let i = 0; i < 3; i++) {
      const index = i % 2,
        old = v[index];
      v = [...v];
      v[index] = BigInt(U(old + b));
      sum = BigInt(U(sum + old));
    }
    assert.equal(aggregate.instance.exports.a0_probe(...args) >>> 0, U(a * 31n + v[0] + sum));
  }
  const { memory, __heap_base: heap } = aggregate.instance.exports,
    ptr = Number(heap.value) >>> 0,
    words = new Uint32Array(memory.buffer);
  words.set([7, 13], ptr / 4);
  aggregate.instance.exports.a0_copy(ptr + 8, ptr);
  assert.deepEqual(Array.from(words.subarray(ptr / 4, ptr / 4 + 4)), [7, 13, 7, 13]);
  aggregate.instance.exports.a0_copy(ptr, ptr);
  assert.deepEqual(Array.from(words.subarray(ptr / 4, ptr / 4 + 2)), [7, 13]);
  report.rows.push({
    label: 'nested/call/loop/sret/persistence/overlapping-sret',
    cases: 12,
    status: 'passed',
  });
  const arithmetic = [
    ['add', (a, b) => U(a + b)],
    ['sub', (a, b) => U(a - b)],
    ['mul', (a, b) => U(a * b)],
    ['and', (a, b) => U(a & b)],
    ['or', (a, b) => U(a | b)],
    ['xor', (a, b) => U(a ^ b)],
    ['shl', (a, b) => U(a << (b & 31n))],
    ['shr', (a, b) => U(a >> (b & 31n))],
    ['div', (a, b) => (b ? U(a / b) : 0xffffffff)],
    ['rem', (a, b) => (b ? U(a % b) : U(a))],
    ['eq', (a, b) => Number(a === b)],
    ['ne', (a, b) => Number(a !== b)],
    ['lt', (a, b) => Number(a < b)],
    ['le', (a, b) => Number(a <= b)],
    ['gt', (a, b) => Number(a > b)],
    ['ge', (a, b) => Number(a >= b)],
  ];
  const scalarSource = arithmetic
    .map(
      ([name], i) =>
        `fn f${i} u32 u32 -> ${i < 10 ? 'u32' : 'bool'}\nv ${name} p0 p1\nret v\nend\n`,
    )
    .join('');
  const scalar = await build(scalarSource),
    pairs = [
      ...INPUTS,
      [0, 0xffffffff],
      [0xffffffff, 0],
      [0x80000000, 31],
      [0x80000000, 32],
      [0x80000000, 33],
    ];
  let count = 0;
  for (const [i, [name, model]] of arithmetic.entries())
    for (const args of pairs) {
      assert.equal(
        scalar.instance.exports['a0_f' + i](...args) >>> 0,
        model(...args.map(BigInt)),
        name,
      );
      count++;
    }
  report.rows.push({
    label: 'scalar arithmetic unsigned/totaldiv/masked-shifts',
    cases: count,
    status: 'passed',
  });
  const bounds = await build(
    'profile strict\nfn probe u32 u32 -> u32\na arr p0 1\nv get a p1\nret v\nend\n',
  );
  for (const index of [2, 0xffffffff]) {
    const e = (await WebAssembly.instantiate(bounds.module, {})).exports;
    assert.throws(() => e.a0_probe(7, index), WebAssembly.RuntimeError);
    assert.deepEqual(wasmTrap(e), {
      kind: 'bounds',
      fn: 'probe',
      at: null,
      trip: null,
      chain: ['probe'],
    });
  }
  report.rows.push({ label: 'strict bounds u32max', cases: 2, status: 'passed' });
  const ioSource =
    'profile strict\nfn leaf io u32 -> io\nr read p0\nx at r 0\nt at r 1\nw write t x\nret w\nend\nfn probe io -> u32\nturns fold leaf 3 p0\nret 0\nend\n';
  const io = await build(ioSource);
  for (const input of [[], [7], [7, 13]]) {
    const e = (await WebAssembly.instantiate(io.module, {})).exports,
      p = Number(e.__heap_base.value) >>> 0,
      w = new Uint32Array(e.memory.buffer),
      base = p / 4;
    w.fill(0, base, base + 9);
    w.set(input, base);
    w[base + 2] = input.length;
    assert.throws(() => e.a0_probe(p), WebAssembly.RuntimeError);
    assert.deepEqual(wasmTrap(e), {
      kind: 'input',
      fn: 'leaf',
      at: 'probe.turns',
      trip: input.length,
      chain: ['probe', 'leaf'],
    });
    assert.equal(w[base + 3], input.length);
    assert.equal(w[base + 8], input.length);
    assert.deepEqual(Array.from(w.subarray(base + 4, base + 4 + input.length)), input);
  }
  report.rows.push({
    label: 'strict IO/trap trip preserves earlier effects exactly once',
    cases: 3,
    status: 'passed',
  });
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = { message: e.message, stack: e.stack };
}
await writeFile(`${dir}/control-results.json`, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({ status: report.status, rows: report.rows.length, error: report.error }, null, 2),
);
process.exitCode = report.status === 'passed' ? 0 : 1;
