import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { checkedCases } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import { RV64, verifyModel } from './rv64-model.mjs';
import { ROOT } from './transport.mjs';

const R = ROOT,
  elf = await readFile(`${R}/tests/io/table/program.elf`),
  cases = checkedCases(),
  base = new RV64(elf),
  reports = [];
assert.throws(() => base.load(1, 8), /misaligned/);
assert.throws(() => base.store(3, 8, 0n), /misaligned/);
const dynamic = Buffer.from(elf);
dynamic.writeUInt16LE(3, 16);
assert.throws(() => new RV64(dynamic), /statically relocated/);
for (const t of cases) assert.equal(base.call(`a0_${t.functionName}`, t.args), Number(t.expected));
for (const [name, from, to] of [
  ['checked-carry-inversion', 0x001f4f13, 0x001f7f13],
  ['copy-store-zero', 0x01e32023, 0x00032023],
]) {
  const bad = Buffer.from(elf);
  let count = 0;
  const ph = Number(bad.readBigUInt64LE(32)),
    pn = bad.readUInt16LE(56),
    ps = bad.readUInt16LE(54);
  for (let i = 0; i < pn; i++) {
    const p = ph + i * ps;
    if (bad.readUInt32LE(p) !== 1 || !(bad.readUInt32LE(p + 4) & 1)) continue;
    const off = Number(bad.readBigUInt64LE(p + 8)),
      size = Number(bad.readBigUInt64LE(p + 32));
    for (let j = off; j < off + size; j += 4)
      if (bad.readUInt32LE(j) === from) {
        bad.writeUInt32LE(to, j);
        count++;
      }
  }
  assert.ok(count, name);
  const cpu = new RV64(bad);
  let mismatches = 0;
  for (const t of cases)
    if (cpu.call(`a0_${t.functionName}`, t.args) !== Number(t.expected)) mismatches++;
  assert.ok(mismatches > 0, name);
  reports.push({
    name,
    actualInstructionMutations: count,
    independentOracleMismatches: mismatches,
  });
}
await writeFile(
  `${R}/tests/fault-results.json`,
  `${JSON.stringify(
    {
      kind: 'Independent fixed RV64IM encoding/model vectors plus actual ELF checked-carry and aggregate-copy instruction fault controls; unmodified oracle controls pass',
      baseCases: cases.length,
      fixedModel: {
        ...verifyModel(),
        explicitMisalignedLoadStoreRefusal: true,
        dynamicElfRefusal: true,
      },
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
console.log(reports);
