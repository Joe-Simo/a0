import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { RV64 } from './rv64-model.mjs';
import { CLANG, emitProgram, emitSource, ROOT } from './transport.mjs';

const R = ROOT,
  source =
    'fn token_identity io -> io\nret p0\nend\nfn token_call io -> io\nr call token_identity p0\nret r\nend\nfn token_copy io -> io\na rec 11 p0\nb mov a\nt at b 1\nr call token_call t\nret r\nend\nfn token_pack u32 io -> (u32,io)\nr rec p0 p1\nret r\nend\n',
  reports = [];
let previous;
for (const mode of ['source', 'table']) {
  const r = mode === 'source' ? emitSource(source) : emitProgram(parseAndValidate(source));
  assert.equal(r.code, 0);
  if (previous !== undefined) assert.equal(r.text, previous);
  previous = r.text;
  const d = `${R}/tests/pointers/${mode}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/source.a0`, source);
  await writeFile(`${d}/module.s`, r.text);
  const c = spawnSync(
    CLANG,
    [
      '-target',
      'riscv64-unknown-linux-gnu',
      '-march=rv64im',
      '-mabi=lp64',
      '-nostdlib',
      '-static',
      '-fuse-ld=lld',
      '-Wl,-Ttext,0x10000',
      '-Wl,-e,a0_token_copy',
      `${d}/module.s`,
      '-o',
      `${d}/program.elf`,
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(c.status, 0, c.stderr);
  const cpu = new RV64(await readFile(`${d}/program.elf`));
  let count = 0;
  for (const ptr of [0n, 1n, 0x123456789abcdef0n, 0x89abcdef01234567n, 0xffffffffffffffffn]) {
    for (const fn of ['token_identity', 'token_call', 'token_copy']) {
      assert.equal(cpu.call(`a0_${fn}`, [ptr], { returnPointer: true }), ptr);
      count++;
    }
    const out = 0x2000000;
    cpu.call('a0_token_pack', [4294967295, ptr], { sret: out });
    assert.equal(cpu.load(out, 4), 4294967295n);
    const packed = cpu.load(out + 4, 4) | (cpu.load(out + 8, 4) << 32n);
    assert.equal(packed, ptr, 'unaligned packed token retains all64 bits');
    count++;
  }
  reports.push({ mode, cases: count, instructions: cpu.instructions });
  console.log(mode, count, 'full64-bit opaque IO token/call/packed snapshot ABI cases passed');
}
await writeFile(
  `${R}/tests/pointer-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual A0 original-source/table canonical IO extension under actual native A0 compiler; decoded static RV64 ELF passes opaque64-bit tokens through calls, fresh snapshots and four-byte-offset packed pointer fields WITHOUT dereferencing opaque pointers. Misaligned XLEN transfers are rejected by model.',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
