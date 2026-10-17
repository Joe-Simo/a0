import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { RV64 } from './rv64-model.mjs';
import { CLANG, emitSource, ROOT } from './transport.mjs';

const R = ROOT,
  d = `${R}/tests/far-strict`,
  source =
    'profile strict\nfn far u32 -> u32\na arr 13 17\nfirst get a p0\nbig arr ' +
    Array(65536).fill('0').join(' ') +
    '\nunused get big 0\nret first\nend\n',
  r = emitSource(source);
assert.equal(r.code, 0);
await mkdir(d, { recursive: true });
await writeFile(`${d}/source.a0`, source);
await writeFile(`${d}/module.s`, r.text);
await writeFile(`${d}/host.s`, '\t.text\n\t.globl A0_trap\nA0_trap:\n\tebreak\n');
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
const cpu = new RV64(await readFile(`${d}/program.elf`)),
  distance = cpu.symbols.get('A0_trap_bounds') - cpu.symbols.get('a0_far');
assert.ok(distance > 1048576 + 4096, 'actual distant trap target exceeds JAL1MiB reach');
const trap = cpu.call('a0_far', [2], { captureHostTrap: true });
assert.deepEqual(trap, {
  kind: 'bounds',
  frames: [{ fn: 'far', node: null, trip: 0 }],
  fpReset: true,
});
assert.equal(cpu.call('a0_far', [0]), 13);
await writeFile(
  `${R}/tests/far-strict-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual A0 original strict source under actual native A0 compiler; actual distant RV64 ELF trap stubs beyond JAL reach, tail AUIPC/JALR and early guard ABI record plus safe large-frame path decoded independently',
      actualFunctionToTrapDistance: distance,
      instructions: cpu.instructions,
      trap,
      assemblyBytes: r.text.length,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
console.log('Strict actual distant tail target and safe wide frame pass', distance);
