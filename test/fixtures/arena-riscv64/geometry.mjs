import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { RV64 } from './rv64-model.mjs';
import { CLANG, emitProgram, emitSource, ROOT } from './transport.mjs';

const R = ROOT,
  reports = [];
async function target(name, source, mode) {
  const r = mode === 'table' ? emitProgram(parseAndValidate(source)) : emitSource(source);
  assert.equal(r.code, 0, JSON.stringify({ ...r, text: undefined }));
  const d = `${R}/tests/geometry/${mode}-${name}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/source.a0`, source);
  await writeFile(`${d}/module.s`, r.text);
  await writeFile(`${d}/host.s`, '\t.text\n\t.globl A0_trap\n\t.p2align 2\nA0_trap:\n\tebreak\n');
  const args = [
      '-target',
      'riscv64-unknown-linux-gnu',
      '-march=rv64im',
      '-mabi=lp64',
      '-nostdlib',
      '-static',
      '-fuse-ld=lld',
      '-Wl,-Ttext,0x10000',
      '-Wl,-e,A0_trap',
      `${d}/module.s`,
      `${d}/host.s`,
      '-o',
      `${d}/program.elf`,
    ],
    c = spawnSync(CLANG, args, { encoding: 'utf8', timeout: 60000 });
  assert.equal(c.status, 0, c.stderr);
  return { cpu: new RV64(await readFile(`${d}/program.elf`)), text: r.text };
}
const depth = 96;
let ty = 'u32';
for (let i = 0; i < depth; i++) ty = `(${ty},bool)`;
const source =
  'fn deep u32 -> u32\n' +
  Array.from(
    { length: depth },
    (_, i) => `r${i} rec ${i ? `r${i - 1}` : 'p0'} ${i % 2 ? 'true' : 'false'}\n`,
  ).join('') +
  Array.from({ length: depth }, (_, i) => `v${i} at ${i ? `v${i - 1}` : `r${depth - 1}`} 0\n`).join(
    '',
  ) +
  `ret v${depth - 1}\nend\nfn deep_identity ${ty} -> ${ty}\nret p0\nend\nfn stack_pack u32 u32 u32 u32 u32 u32 u32 bool u32x3 -> (u32x3,u32,bool)\na set p8 p0 p6\nr rec a p1 p7\nret r\nend\n`;
let prev;
for (const mode of ['source', 'table']) {
  const { cpu, text } = await target('deep96-stack', source, mode);
  if (prev !== undefined) assert.equal(text, prev);
  prev = text;
  let cases = 0;
  for (const value of [0, 1, 2147483648, 4294967295]) {
    assert.equal(cpu.call('a0_deep', [value]), value);
    cases++;
    const flat = [value, ...Array.from({ length: depth }, (_, i) => i % 2)];
    for (const alias of [false, true]) {
      const input = 0x2000000,
        out = alias ? input : 0x2100000;
      flat.forEach((v, i) => {
        cpu.store(input + 4 * i, 4, BigInt(v));
      });
      cpu.call('a0_deep_identity', [BigInt(input)], { sret: out });
      assert.deepEqual(
        Array.from({ length: depth + 1 }, (_, i) => Number(cpu.load(out + 4 * i, 4))),
        flat,
      );
      if (!alias)
        assert.deepEqual(
          Array.from({ length: depth + 1 }, (_, i) => Number(cpu.load(input + 4 * i, 4))),
          flat,
        );
      cases++;
    }
  }
  for (const flag of [false, true])
    for (const index of [0, 1, 2, 3, 4294967295])
      for (const alias of [false, true]) {
        const input = 0x2200000,
          out = alias ? input : 0x2300000,
          a = [11, 12, 13];
        a[index % 3] = 77;
        [11, 12, 13, 0, 0].forEach((v, i) => {
          cpu.store(input + 4 * i, 4, BigInt(v));
        });
        cpu.call('a0_stack_pack', [index, 17, 19, 23, 29, 31, 77, flag, BigInt(input)], {
          sret: out,
        });
        assert.deepEqual(
          Array.from({ length: 5 }, (_, i) => Number(cpu.load(out + 4 * i, 4))),
          [...a, 17, Number(flag)],
        );
        if (!alias)
          assert.deepEqual(
            Array.from({ length: 3 }, (_, i) => Number(cpu.load(input + 4 * i, 4))),
            [11, 12, 13],
          );
        cases++;
      }
  reports.push({
    mode,
    depth,
    cases,
    instructions: cpu.instructions,
    assemblyBytes: text.length,
  });
  console.log(mode, '96-deep records and stack aggregate/bool hidden-sret shifts passed', cases);
}
await writeFile(
  `${R}/tests/geometry-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual A0 full-word source/table emission under actual native A0 compiler; static RV64IM ELF decoded instructions for deep snapshots, hidden-a0 ABI stack shift, bool/u32/aggregate slots and sret aliases',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);

await import('./pointer.mjs');
await import('./far-strict.mjs');
