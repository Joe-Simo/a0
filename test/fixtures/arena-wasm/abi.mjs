// Additional explicit ABI/text/boolean/predicate controls; same native binaries.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { ABI_SOURCE, abiCases } from '../../../dist/test/fixtures/native-ports/abi.js';
import { wasmTrap } from '../../../dist/tools/verify.js';
import { compileSource, ROOT } from './transport.mjs';

const report = {
  status: 'running',
  scope:
    'Additional raw-source ABI/text/boolean/predicate controls on the same verified-seed native binaries; independent fixture integer oracles.',
  rows: [],
};
async function build(source) {
  const r = compileSource(source);
  assert.equal(r.code, 0);
  assert.ok(WebAssembly.validate(r.bytes));
  const module = await WebAssembly.compile(r.bytes);
  return { module, instance: await WebAssembly.instantiate(module, {}) };
}
try {
  const abi = await build(ABI_SOURCE),
    cases = abiCases();
  for (const c of cases)
    assert.equal(
      abi.instance.exports['a0_' + c.functionName](...c.args.map(Number)) >>> 0,
      Number(c.expected) >>> 0,
      c.functionName,
    );
  report.rows.push({
    label: 'mixed9args/aggregatepack/7extras/textUTF8/largevalueABI',
    cases: cases.length,
    status: 'passed',
  });
  const names = ['and', 'or', 'xor', 'eq', 'ne'],
    models = [
      (a, b) => a && b,
      (a, b) => a || b,
      (a, b) => a !== b,
      (a, b) => a === b,
      (a, b) => a !== b,
    ],
    source = names
      .map((op, i) => `fn b${i} bool bool -> bool\nx ${op} p0 p1\nret x\nend\n`)
      .join(''),
    bool = await build(source);
  let count = 0;
  for (let i = 0; i < names.length; i++)
    for (const a of [false, true])
      for (const b of [false, true]) {
        assert.equal(
          bool.instance.exports['a0_b' + i](Number(a), Number(b)),
          Number(models[i](a, b)),
        );
        count++;
      }
  report.rows.push({ label: 'boolean bitwise/comparison ABI', cases: count, status: 'passed' });
  const params = Array.from({ length: 64 }, () => 'u32').join(' '),
    nodes = Array.from(
      { length: 63 },
      (_, i) => `v${i} add ${i ? 'v' + (i - 1) : 'p0'} p${i + 1}\n`,
    ).join(''),
    wide = await build(`fn wide ${params} -> u32\n${nodes}ret v62\nend\n`),
    args = Array.from({ length: 64 }, (_, i) => (i % 2 ? 0xffffffff : i));
  assert.equal(
    wide.instance.exports.a0_wide(...args) >>> 0,
    Number(
      BigInt.asUintN(
        32,
        args.reduce((a, b) => a + BigInt(b), 0n),
      ),
    ),
  );
  report.rows.push({ label: 'language maximum64scalar params', cases: 1, status: 'passed' });
  const pred = await build(
    'profile strict\nfn pred u32 u32 u32 -> bool\nx rem p0 p2\nb eq x 0\nret b\nend\nfn step u32 u32 u32 -> u32\nx add p0 p1\nret x\nend\nfn probe u32 u32 -> u32\nrounds loop pred step 3 p0 p1\nret rounds\nend\n',
  );
  assert.throws(() => pred.instance.exports.a0_probe(7, 0), WebAssembly.RuntimeError);
  assert.deepEqual(wasmTrap(pred.instance.exports), {
    kind: 'divzero',
    fn: 'pred',
    at: 'probe.rounds',
    trip: 0,
    chain: ['probe', 'pred'],
  });
  report.rows.push({
    label: 'strict predicate runs before body at original loop trip0',
    cases: 1,
    status: 'passed',
  });
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = e.stack ?? String(e);
  process.exitCode = 1;
}
await writeFile(`${ROOT}/abi-completion-results.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
