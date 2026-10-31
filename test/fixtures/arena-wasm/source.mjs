import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { CHECKED_SOURCE, checkedCases } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import { wasmTrap } from '../../../dist/tools/verify.js';
import { cases as specs } from '../arena-spec-verifier/cases.mjs';
import { compileSource, ROOT } from './transport.mjs';

const root = ROOT;
const report = {
  status: 'running',
  scope:
    'Fresh verified-seed native A0 raw-source Wasm service; actual WebAssembly runtime, independent oracles and explicit failures.',
  rows: [],
};
try {
  for (const fixture of specs.filter((f) => !f.heavy)) {
    const r = compileSource(fixture.nativeSource ?? fixture.source);
    assert.equal(r.code, fixture.status, fixture.name);
    if (!r.code) assert.equal(WebAssembly.validate(r.bytes), true, fixture.name);
    report.rows.push({
      name: fixture.name,
      code: r.code,
      resumes: r.resumes,
      counts: r.counts,
      status: 'passed',
    });
  }
  for (const strict of [false, true]) {
    const source = (strict ? 'profile strict\n' : '') + CHECKED_SOURCE,
      r = compileSource(source);
    assert.equal(r.code, 0);
    assert.equal(WebAssembly.validate(r.bytes), true);
    await writeFile(`${root}/source-checked-${strict}.wasm`, r.bytes);
    const instance = (await WebAssembly.instantiate(r.bytes, {})).instance,
      cases = checkedCases();
    for (const row of cases)
      assert.equal(
        instance.exports[`a0_${row.functionName}`](...row.args.map(Number)) >>> 0,
        Number(row.expected) >>> 0,
      );
    report.rows.push({
      name: 'raw checked ' + strict,
      code: 0,
      cases: cases.length,
      counts: r.counts,
      status: 'passed',
    });
  }
  const ioSource = await readFile(new URL('./sources/io.a0', import.meta.url), 'utf8');
  for (const strict of [false, true]) {
    const r = compileSource((strict ? 'profile strict\n' : '') + ioSource);
    assert.equal(r.code, 0);
    for (const input of [[], [0xffffffff], [0xffffffff, 0xffffffff], [65536, 65536], [7, 13]]) {
      const instance = (await WebAssembly.instantiate(r.bytes, {})).instance,
        { memory, __heap_base: heap } = instance.exports;
      const pointer = Number(heap.value) >>> 0;
      if (pointer + 36 > memory.buffer.byteLength)
        memory.grow(Math.ceil((pointer + 36 - memory.buffer.byteLength) / 65536));
      const words = new Uint32Array(memory.buffer),
        base = pointer / 4;
      words.fill(0, base, base + 9);
      words.set(input, base);
      words[base + 2] = input.length;
      if (strict && input.length < 2) {
        assert.throws(() => instance.exports.a0_effect(pointer), WebAssembly.RuntimeError);
        assert.deepEqual(wasmTrap(instance.exports), {
          kind: 'input',
          fn: 'effect',
          at: null,
          trip: null,
          chain: ['effect'],
        });
        assert.equal(words[base + 8], 0);
      } else {
        const product = BigInt(input[0] ?? 0) * BigInt(input[1] ?? 0),
          value = Number(BigInt.asUintN(32, product));
        assert.equal(instance.exports.a0_effect(pointer) >>> 0, value);
        assert.deepEqual(Array.from(words.subarray(base + 4, base + 8)), [
          value,
          Number(product <= 0xffffffffn),
          3,
          65,
        ]);
        assert.equal(words[base + 8], 4);
      }
      assert.equal(words[base + 3], input.length);
    }
    report.rows.push({
      name: 'raw IO exact-once/cap/exhaustion ' + strict,
      code: 0,
      cases: 5,
      status: 'passed',
    });
  }
  const source = `profile strict
fn leaf u32 u32 -> u32
x div p0 p1
ret x
end
fn probe u32 u32 -> u32
x call leaf p0 p1
ret x
end
`;
  const trap = compileSource(source, { exports: ['probe'] });
  assert.equal(trap.code, 0);
  const instance = (await WebAssembly.instantiate(trap.bytes, {})).instance;
  assert.throws(() => instance.exports.a0_probe(7, 0), WebAssembly.RuntimeError);
  assert.deepEqual(wasmTrap(instance.exports), {
    kind: 'divzero',
    fn: 'leaf',
    at: null,
    trip: null,
    chain: ['probe', 'leaf'],
  });
  report.rows.push({ name: 'raw strict source original-D trap chain', code: 0, status: 'passed' });
  const importOnly = compileSource('use "dependency.a0"\n');
  assert.equal(importOnly.code, 7);
  assert.equal(importOnly.bytes.length, 0);
  report.rows.push({ name: 'unit import explicit terminal7', code: 7, status: 'passed' });
  const unsupported = compileSource('fn probe -> u32\nret 7\nend\n', { change: (o) => (o[3] = 1) });
  assert.equal(unsupported.code, 8);
  assert.equal(unsupported.bytes.length, 0);
  report.rows.push({ name: 'unsupported SIMD explicit8', code: 8, status: 'passed' });
  const small = 'fn probe u32 -> u32\nx add p0 1\nret x\nend\n';
  const quantum1 = compileSource(small, { quantum: 1 }),
    quantum97 = compileSource(small, { quantum: 97 });
  assert.equal(quantum1.code, 0);
  assert.deepEqual(quantum1.bytes, quantum97.bytes);
  report.rows.push({
    name: 'opaque continuation quantum independent bytes',
    code: 0,
    resumes: [quantum1.resumes, quantum97.resumes],
    status: 'passed',
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
}
await writeFile(`${root}/source-results.json`, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({ status: report.status, rows: report.rows.length, error: report.error }, null, 2),
);
process.exitCode = report.status === 'passed' ? 0 : 1;
