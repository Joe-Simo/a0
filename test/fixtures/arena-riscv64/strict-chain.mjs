import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { RV64 } from './rv64-model.mjs';
import { CLANG, emitSource, ROOT } from './transport.mjs';

const names = Array.from(
  { length: 20 },
  (_, i) => `f${String(i).padStart(2, '0')}${'x'.repeat(61)}`,
);
const source =
  'profile strict\n' +
  names
    .map(
      (name, i) =>
        `fn ${name} u32 u32 -> u32\nr ${i ? `call ${names[i - 1]} p0 p1` : 'div p0 p1'}\nret r\nend\n`,
    )
    .join('');
const emitted = emitSource(source);
assert.equal(emitted.code, 0, emitted.stderr);
const dir = `${ROOT}/tests/strict-chain`;
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/source.a0`, source);
await writeFile(`${dir}/module.s`, emitted.text);
await writeFile(`${dir}/host.s`, '.text\n.globl A0_trap\nA0_trap:\nebreak\n');
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
  `${dir}/module.s`,
  `${dir}/host.s`,
  '-o',
  `${dir}/program.elf`,
];
const linked = spawnSync(CLANG, args, { encoding: 'utf8', timeout: 60000 });
assert.equal(linked.status, 0, linked.stderr);
const cpu = new RV64(await readFile(`${dir}/program.elf`));
assert.equal(cpu.call(`a0_${names.at(-1)}`, [25, 5]), 5);
const trap = cpu.call(`a0_${names.at(-1)}`, [25, 0], { captureHostTrap: true });
assert.equal(trap.kind, 'divzero');
assert.equal(trap.fpReset, true);
assert.deepEqual(
  trap.frames,
  names.toReversed().map((fn) => ({ fn, node: null, trip: 0 })),
);
const chainBytes = names.toReversed().join('>').length;
assert.equal(chainBytes, 1299);
await writeFile(
  `${ROOT}/strict-chain-results.json`,
  `${JSON.stringify(
    {
      nativeCompilerProof: true,
      hardwareExecution: false,
      hostReporterExecuted: false,
      frames: trap.frames.length,
      legalNameBytes: 64,
      chainBytes,
      record: trap,
      note: 'Actual instructions and external host ABI record are checked. Reference C host reporter has a separate unbounded append into a1024byte buffer and is deliberately not executed here.',
    },
    null,
    2,
  )}\n`,
);
console.log(
  '20 maximum64byte strict names retain full original external ABI records; host reporter not executed',
);
