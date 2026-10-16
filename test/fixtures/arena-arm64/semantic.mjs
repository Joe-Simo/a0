import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { checkedCases } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import { abiCases } from '../../../dist/test/fixtures/native-ports/abi.js';
import { nativePortPureCases } from '../../../dist/test/fixtures/native-ports/semantic.js';
import { Arm64Model, machoObject } from './arm64-model.mjs';
import { emitProgram, emitSource, ROOT } from './transport.mjs';

const ORIGINAL = new URL('./sources/', import.meta.url),
  reports = [];
async function object(name, text) {
  const d = `${ROOT}/${name}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/module.s`, text);
  const r = spawnSync(
    'clang',
    ['-target', 'arm64-apple-darwin', '-c', `${d}/module.s`, '-o', `${d}/module.o`],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(r.status, 0, r.stderr);
  return machoObject(await readFile(`${d}/module.o`));
}
const source = await readFile(new URL('pure.a0', ORIGINAL), 'utf8'),
  program = parseAndValidate(source),
  cases = [...nativePortPureCases(), ...abiCases()];
let previous;
for (const mode of ['source', 'table']) {
  const r = mode === 'source' ? emitSource(source) : emitProgram(program);
  assert.equal(r.status, 0, r.stderr);
  if (mode === 'source') {
    assert.equal(r.meta.verifier[1], 11);
    assert.equal(r.meta.descriptor[1], 0x41304243);
  }
  if (previous !== undefined) assert.equal(r.text, previous, 'native source/table exact assembly');
  previous = r.text;
  const o = await object(mode, r.text),
    m = new Arm64Model(o);
  for (const t of cases)
    assert.equal(
      m.call(t.functionName, t.args, program.byName.get(t.functionName).params),
      Number(t.expected),
      `${mode} ${t.functionName} ${t.args}`,
    );
  const f = program.byName.get('abi_pack');
  let aliases = 0;
  for (const flag of [false, true])
    for (const index of [0, 1, 2, 3, 4294967295]) {
      const args = [[11, 12, 13], index, flag, 17, 19, 23, 29, 77],
        a = [11, 12, 13];
      a[index % 3] = 77;
      const want = [a, Number(BigInt.asUintN(32, 88n + BigInt(index))), Number(flag)];
      for (const alias of [undefined, 0]) {
        assert.deepEqual(
          m.call('abi_pack', args, f.params, {
            resultType: f.result,
            sretAliasParam: alias,
            inspect: true,
          }).value,
          want,
        );
        aliases++;
      }
    }
  let arithmeticFaults = 0,
    copyFaults = 0;
  for (const [from, to, kind] of [
    [0x0b0a012b, 0x4b0a012b, 'add'],
    [0xb800454e, 0xb800455f, 'copy'],
  ]) {
    const bad = { ...o, bytes: Buffer.from(o.bytes) };
    let mutations = 0;
    for (let i = 0; i < bad.bytes.length; i += 4)
      if (bad.bytes.readUInt32LE(i) === from) {
        bad.bytes.writeUInt32LE(to, i);
        mutations++;
      }
    assert.ok(mutations);
    const bm = new Arm64Model(bad);
    for (const t of kind === 'add' ? cases : checkedCases()) {
      const f = program.byName.get(t.functionName);
      try {
        if (bm.call(t.functionName, t.args, f.params) !== Number(t.expected)) {
          if (kind === 'add') arithmeticFaults++;
          else copyFaults++;
        }
      } catch {
        if (kind === 'add') arithmeticFaults++;
        else copyFaults++;
      }
    }
  }
  assert.ok(arithmeticFaults > 0);
  assert.ok(copyFaults > 0);
  reports.push({
    mode,
    cases: cases.length,
    aliases,
    arithmeticFaults,
    copyFaults,
    resolvedRelocations: o.resolvedRelocations,
    instructions: m.instructions,
    assemblyBytes: r.text.length,
  });
  console.log(
    mode,
    cases.length,
    'BigInt/aggregate/call/fold/loop/ABI and',
    aliases,
    'sret aliases passed',
  );
}
const strict = emitSource(await readFile(new URL('strict-checked-source.a0', ORIGINAL), 'utf8'));
assert.equal(strict.status, 0, strict.stderr);
const sp = parseAndValidate(await readFile(new URL('strict-checked-source.a0', ORIGINAL), 'utf8')),
  sm = new Arm64Model(await object('strict-checked', strict.text));
for (const t of checkedCases())
  assert.equal(
    sm.call(t.functionName, t.args, sp.byName.get(t.functionName).params),
    Number(t.expected),
    t.functionName,
  );
reports.push({
  mode: 'strict-source',
  checkedTotalCases: checkedCases().length,
  instructions: sm.instructions,
});
await writeFile(
  `${ROOT}/semantic-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual native A0 source/table compilation through original-source ordered A0 frontend and target emitter; Clang Darwin crossassembly, resolved actual MachO instructions and independent BigInt/ABI/alias models',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
      modelHelperHooks: [],
      osHooks: ['Darwin write(stderr)', 'Darwin exit'],
    },
    null,
    2,
  )}\n`,
);
