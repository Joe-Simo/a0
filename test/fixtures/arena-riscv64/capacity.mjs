import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { RV64 } from './rv64-model.mjs';
import { CLANG, emitProgram, emitSource, ROOT } from './transport.mjs';

const R = ROOT,
  reports = [],
  fixtures = [
    [
      'functions1000',
      Array.from(
        { length: 1000 },
        (_, i) => `fn f${i} u32 -> u32\nr add p0 ${i}\nret r\nend\n`,
      ).join(''),
      [
        ['f0', [7], 7],
        ['f999', [4294967295], 998],
      ],
    ],
    [
      'nodes3000',
      'fn chain u32 -> u32\n' +
        Array.from({ length: 3000 }, (_, i) => `v${i} add ${i ? `v${i - 1}` : 'p0'} 1\n`).join('') +
        'ret v2999\nend\n',
      [['chain', [4294967295], 2999]],
    ],
    [
      'operands65536',
      'fn wide u32 u32 -> u32\na arr ' +
        Array(65536).fill('p0').join(' ') +
        '\nx get a p1\nret x\nend\n',
      [['wide', [3735928559, 4294967295], 3735928559]],
    ],
    [
      'record70017',
      'fn recordwide -> bool\na rec ' +
        Array(70017).fill('true').join(' ') +
        '\nr at a 70016\nret r\nend\n',
      [['recordwide', [], 1]],
    ],
  ];
for (const [name, source, cases] of fixtures) {
  const p = parseAndValidate(source);
  let prev;
  for (const mode of ['table', 'source']) {
    const r = mode === 'table' ? emitProgram(p) : emitSource(source);
    assert.equal(r.code, 0, JSON.stringify({ ...r, text: undefined }));
    if (prev !== undefined) assert.equal(r.text, prev);
    prev = r.text;
    const d = `${R}/tests/capacity/${mode}-${name}`;
    await mkdir(d, { recursive: true });
    await writeFile(`${d}/source.a0`, source);
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
        `-Wl,-e,a0_${cases[0][0]}`,
        `${d}/module.s`,
        '-o',
        `${d}/program.elf`,
      ],
      c = spawnSync(CLANG, args, { encoding: 'utf8', timeout: 60000 });
    assert.equal(c.status, 0, c.stderr);
    const cpu = new RV64(await readFile(`${d}/program.elf`));
    for (const [fn, a, want] of cases)
      assert.equal(cpu.call(`a0_${fn}`, a), want, `${mode} ${name}`);
    reports.push({
      name,
      mode,
      sourceBytes: source.length,
      assemblyBytes: r.text.length,
      instructions: cpu.instructions,
      cases: cases.length,
    });
    console.log(mode, name, 'actual static ELF model passed');
  }
}
const invalid = `fn bad -> u32\na arr ${Array(70017).fill('0').join(' ')}\nr get a 0\nret r\nend\n`,
  bad = emitSource(invalid);
assert.equal(bad.code, 8);
assert.equal(bad.checked[1], 206);
assert.equal(bad.text, '');
reports.push({
  name: 'invalid-aggregate70017u32',
  code: 8,
  verifier: bad.verifier,
  zeroOutput: true,
});
await writeFile(
  `${R}/tests/capacity-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual A0 full-word source/table RV64 emission under actual native A0 compiler; linked static ELF and independent actual-instruction model across legacy capacities',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
