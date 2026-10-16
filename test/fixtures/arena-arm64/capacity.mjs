import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { Arm64Model, machoObject } from './arm64-model.mjs';
import { emitProgram, emitSource, ROOT } from './transport.mjs';

const R = ROOT,
  reports = [];
const fixtures = [
  [
    'functions1000',
    Array.from({ length: 1000 }, (_, i) => `fn f${i} u32 -> u32\nr add p0 ${i}\nret r\nend\n`).join(
      '',
    ),
    [
      ['f0', [7], 7],
      ['f999', [4294967295], 998],
    ],
  ],
  [
    'nodes3000',
    'fn chain u32 -> u32\n' +
      Array.from({ length: 3000 }, (_, i) => `v${i} add ${i === 0 ? 'p0' : `v${i - 1}`} 1\n`).join(
        '',
      ) +
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
  let previous;
  for (const mode of ['table', 'source']) {
    const r = mode === 'table' ? emitProgram(p) : emitSource(source);
    assert.equal(r.status, 0, `${name} ${mode} ${JSON.stringify({ ...r, text: undefined })}`);
    assert.equal(r.meta?.pending ?? false, false);
    if (previous !== undefined) assert.equal(r.text, previous, 'source/table exact A0 assembly');
    previous = r.text;
    const d = `${R}/capacities/${mode}-${name}`;
    await mkdir(d, { recursive: true });
    await writeFile(`${d}/source.a0`, source);
    await writeFile(`${d}/module.s`, r.text);
    const c = spawnSync(
      'clang',
      ['-target', 'arm64-apple-darwin', '-c', `${d}/module.s`, '-o', `${d}/module.o`],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(c.status, 0, c.stderr);
    const obj = machoObject(await readFile(`${d}/module.o`)),
      m = new Arm64Model(obj);
    for (const [fn, args, want] of cases)
      assert.equal(
        m.call(fn, args, p.byName.get(fn).params, { maxSteps: 5000000 }),
        want,
        `${mode} ${name}`,
      );
    reports.push({
      name,
      mode,
      code: r.status,
      sourceBytes: source.length,
      assemblyBytes: r.text.length,
      independentCases: cases.length,
      actualDecodedInstructions: m.instructions,
      phase: r.meta?.verifier?.[1],
      nativeCompilerProof: true,
      hardwareExecution: false,
    });
    console.log(mode, name, 'actual target model passed', r.text.length, m.instructions);
  }
}
const invalid = `fn bad -> u32\na arr ${Array(70017).fill('0').join(' ')}\nr get a 0\nret r\nend\n`,
  bad = emitSource(invalid);
assert.equal(bad.status, 8);
assert.equal(bad.text, '');
assert.equal(bad.meta.checked[1], 206);
reports.push({
  name: 'invalid-u32-aggregate70017',
  mode: 'source',
  code: bad.status,
  verifier: bad.meta.verifier,
  zeroOutput: true,
});
await writeFile(
  `${R}/capacity-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual A0 source/table emitter under actual native A0 compiler; full-word function/node/operand/record boundaries; crossassembled actual MachO and independent instruction model',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
