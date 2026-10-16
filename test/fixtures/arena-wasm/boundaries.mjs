import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { wasmTrap } from '../../../dist/tools/verify.js';
import { compileSource, ROOT } from './transport.mjs';

const root = ROOT;
const report = {
  status: 'running',
  scope:
    'Fresh verified-seed native A0 raw-source Wasm service; actual WebAssembly runtime, independent oracles and explicit failures.',
  rows: [],
};
const record = async () =>
  writeFile(`${root}/boundary-results.json`, JSON.stringify(report, null, 2) + '\n');
async function run(label, source, options, verify) {
  await writeFile(`${root}/boundary-${label}.a0`, source);
  const result = compileSource(source, options);
  if (result.code)
    await writeFile(`${root}/failed-${label}.json`, JSON.stringify(result, null, 2) + '\n');
  assert.equal(result.code, 0, label);
  assert.equal(WebAssembly.validate(result.bytes), true, label);
  await writeFile(`${root}/boundary-${label}.wasm`, result.bytes);
  const instance = (await WebAssembly.instantiate(result.bytes, {})).instance;
  verify(instance, result);
  report.rows.push({
    label,
    status: 'passed',
    sourceBytes: Buffer.byteLength(source),
    sourceSHA256: createHash('sha256').update(source).digest('hex'),
    moduleBytes: result.bytes.length,
    counts: result.counts,
    resumes: result.resumes,
  });
  await record();
}
try {
  for (const bool of [false, true]) {
    const literals = Array.from({ length: 65536 }, (_, i) =>
      bool ? (i === 65535 ? 'true' : 'false') : i === 65535 ? '4294967295' : '0',
    ).join(' ');
    const source = `fn probe u32 -> u32\na arr ${literals}\nv get a p0\n${bool ? 'r select v 1 0\nret r' : 'ret v'}\nend\n`;
    await run(bool ? 'bool65536' : 'u3265536', source, { exports: ['probe'] }, (instance) => {
      for (const index of [0, 1, 65534, 65535, 65536, 0xffffffff])
        assert.equal(
          instance.exports.a0_probe(index) >>> 0,
          index % 65536 === 65535 ? (bool ? 1 : 0xffffffff) : 0,
        );
    });
  }
  const functions = Array.from(
    { length: 9000 },
    (_, i) => `fn f${i} u32x${i + 1} -> u32\nret 0\nend\n`,
  ).join('');
  await run('9000functions-types', functions, { exports: ['f8999'] }, (instance, result) => {
    assert.equal(result.counts[0], 9000);
    assert.equal(result.counts[1], 9003);
    const pointer = Number(instance.exports.__heap_base.value) >>> 0;
    new Uint32Array(instance.exports.memory.buffer).fill(0, pointer / 4, pointer / 4 + 9000);
    assert.equal(instance.exports.a0_f8999(pointer), 0);
    assert.deepEqual(Object.keys(instance.exports).sort(), ['__heap_base', 'a0_f8999', 'memory']);
  });
  const chain = (count, start) =>
    Array.from({ length: count }, (_, i) => `n${i} add ${i ? 'n' + (i - 1) : start} 1\n`).join('');
  // Preserve the language's4096-node/function cap. Global IDs still exceed65535.
  const functionName = (i) => (i === 0 ? 'first' : i === 16 ? 'second' : `f${i}`);
  const functionChain = (strict) =>
    Array.from({ length: 17 }, (_, i) => {
      const count = i === 0 ? 3985 : 4000,
        call = i === 0 ? '' : `v call ${functionName(i - 1)} p0\n`;
      const last = `n${count - 1}`,
        tail = strict && i === 16 ? `late_loop fold fail 1 ${last}\nret late_loop` : `ret ${last}`;
      return `fn ${functionName(i)} u32 -> u32\n${call}${chain(count, i === 0 ? 'p0' : 'v')}${tail}\nend\n`;
    }).join('');
  const canonical = functionChain(false);
  await run('68002global-nodes', canonical, { exports: ['second'] }, (instance, result) => {
    assert.equal(result.counts[2], 68002);
    for (const n of [0, 7, 0xffffffff])
      assert.equal(
        instance.exports.a0_second(n) >>> 0,
        Number(BigInt.asUintN(32, BigInt(n) + 67985n)),
      );
  });
  const strict =
    `profile strict\nfn fail u32 u32 -> u32\nv div p0 0\nret v\nend\n` + functionChain(true);
  await run('68004strict-original-node', strict, { exports: ['second'] }, (instance, result) => {
    assert.equal(result.counts[2], 68004);
    assert.throws(() => instance.exports.a0_second(7), WebAssembly.RuntimeError);
    assert.deepEqual(wasmTrap(instance.exports), {
      kind: 'divzero',
      fn: 'fail',
      at: 'second.late_loop',
      trip: 0,
      chain: ['second', 'fail'],
    });
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
}
await record();
console.log(
  JSON.stringify({ status: report.status, rows: report.rows.length, error: report.error }, null, 2),
);
process.exitCode = report.status === 'passed' ? 0 : 1;
