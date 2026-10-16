import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { ABI_SOURCE, abiCases } from '../../../dist/test/fixtures/native-ports/abi.js';
import {
  NATIVE_PORT_SOURCE,
  nativePortCases,
} from '../../../dist/test/fixtures/native-ports/semantic.js';
import { ioSource } from './io-fixture.mjs';
import { RV64 } from './rv64-model.mjs';
import { CLANG, emitProgram, emitSource, ROOT } from './transport.mjs';

const R = ROOT,
  reports = [];
async function target(name, r, entry = 'a0_cadd_v') {
  assert.equal(r.code, 0, JSON.stringify({ ...r, text: undefined }));
  const d = `${R}/tests/io/${name}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/module.s`, r.text);
  const args = [
      '-target',
      'riscv64-unknown-linux-gnu',
      '-march=rv64im',
      '-mabi=lp64',
      '-nostdlib',
      '-static',
      '-fuse-ld=lld',
      '-Wl,-Ttext,0x10000',
      `-Wl,-e,${entry}`,
      `${d}/module.s`,
      '-o',
      `${d}/program.elf`,
    ],
    c = spawnSync(CLANG, args, { encoding: 'utf8', timeout: 60000 });
  assert.equal(c.status, 0, c.stderr);
  return new RV64(await readFile(`${d}/program.elf`));
}
const source = NATIVE_PORT_SOURCE + ABI_SOURCE,
  p = parseAndValidate(source),
  cases = [...nativePortCases(), ...abiCases()];
let prev;
for (const mode of ['table', 'source']) {
  const r = mode === 'table' ? emitProgram(p) : emitSource(source);
  if (prev !== undefined) assert.equal(r.text, prev);
  prev = r.text;
  const cpu = await target(mode, r),
    io = 0x2000000;
  for (const t of cases) {
    cpu.mem.fill(0, io, io + 4 * (256 + 1024 + 3));
    (t.input ?? []).forEach((v, j) => {
      cpu.store(io + 4 * j, 4, BigInt(v));
    });
    cpu.store(io + 256 * 4, 4, BigInt((t.input ?? []).length));
    const f = p.byName.get(t.functionName),
      args = [...t.args];
    if (f.params.includes('io')) args.splice(f.params.indexOf('io'), 0, BigInt(io));
    assert.equal(
      cpu.call(`a0_${t.functionName}`, args),
      Number(t.expected),
      `${mode} ${t.functionName} ${t.args}`,
    );
    if (t.expectedOutput) {
      const n = Number(cpu.load(io + (256 + 2 + 1024) * 4, 4));
      assert.deepEqual(
        Array.from({ length: n }, (_, j) => Number(cpu.load(io + (256 + 2 + j) * 4, 4))),
        t.expectedOutput,
        t.functionName,
      );
    }
  }
  let aliases = 0;
  for (const flag of [false, true])
    for (const index of [0, 1, 2, 3, 4294967295])
      for (const alias of [false, true]) {
        const input = 0x2000000,
          out = alias ? input : 0x2100000,
          initial = [11, 12, 13, 0xabcdef, 0x123456];
        for (let i = 0; i < 5; i++) cpu.store(input + 4 * i, 4, BigInt(initial[i]));
        const a = [11, 12, 13];
        a[index % 3] = 77;
        const want = [...a, Number(BigInt.asUintN(32, 88n + BigInt(index))), Number(flag)];
        cpu.call('a0_abi_pack', [BigInt(input), index, flag, 17, 19, 23, 29, 77], { sret: out });
        assert.deepEqual(
          Array.from({ length: 5 }, (_, i) => Number(cpu.load(out + 4 * i, 4))),
          want,
        );
        if (!alias)
          assert.deepEqual(
            Array.from({ length: 5 }, (_, i) => Number(cpu.load(input + 4 * i, 4))),
            initial,
          );
        aliases++;
      }
  reports.push({
    name: 'all37',
    mode,
    aliases,
    cases: cases.length,
    instructions: cpu.instructions,
    assemblyBytes: r.text.length,
  });
  console.log(
    mode,
    cases.length,
    'all37 independent pure/IO cases and',
    aliases,
    'sret aliases passed',
  );
}
for (const [input, output] of [
  [0, 0],
  [1, 1],
  [2, 5],
  [256, 1024],
]) {
  const r = emitSource(ioSource, { input, output }),
    cpu = await target(`profile-${input}-${output}`, r, 'a0_iotest'),
    io = 0x2000000,
    data = [987, 654, 321].slice(0, input);
  cpu.mem.fill(0, io, io + 4 * (input + output + 3));
  data.forEach((v, j) => {
    cpu.store(io + 4 * j, 4, BigInt(v));
  });
  cpu.store(io + input * 4, 4, BigInt(data.length));
  const got = cpu.call('a0_iotest', [BigInt(io)]),
    values = [...data, 0, 0, 0].slice(0, 3),
    expected = [...values, 3, 100, 200, 300].slice(0, output);
  assert.equal(
    got,
    values.reduce((a, b) => a ^ b, 0),
  );
  const n = Number(cpu.load(io + (input + 2 + output) * 4, 4));
  assert.deepEqual(
    Array.from({ length: n }, (_, j) => Number(cpu.load(io + (input + 2 + j) * 4, 4))),
    expected,
  );
  reports.push({
    name: 'configured-bounded-IO',
    input,
    output,
    got,
    expected,
    instructions: cpu.instructions,
  });
}
await writeFile(
  `${R}/tests/io-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual A0 all37 canonical source/table emission, private bounded IO extension, real linked RV64IM ELF bytes and independent BigInt/IO/alias instruction model. Misaligned token transfers must trap in model.',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);

await import('./faults.mjs');
