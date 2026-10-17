import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { Arm64Model, machoObject } from './arm64-model.mjs';
import { emitLink, ROOT } from './transport.mjs';

const F = `${ROOT}/project`,
  reports = [];
const physical = `${ROOT}/physical`,
  alias = `${ROOT}/alias`;
await mkdir(physical, { recursive: true });
await writeFile(`${physical}/main.a0`, 'use "missing.a0"\nfn f -> u32\nret 0\nend\n');
await symlink(physical, alias, 'dir');
const missingThroughAlias = emitLink(`${alias}/main.a0`, alias);
assert.equal(
  missingThroughAlias.status,
  8,
  'an aliased project root must preserve a missing-import error',
);
assert.equal(missingThroughAlias.text, '');
reports.push({ name: 'aliased-root-missing-import', code: missingThroughAlias.status });
await mkdir(`${physical}/sub`, { recursive: true });
await writeFile(`${physical}/dep.a0`, 'fn dep -> u32\nret 17\nend\n');
await writeFile(`${physical}/sub/dep.a0`, 'fn dep -> u32\nret 23\nend\n');
await writeFile(
  `${physical}/sub/main.a0`,
  'use "dep.a0"\nfn entry -> u32\nr call dep\nret r\nend\n',
);
await symlink(`${physical}/sub/main.a0`, `${physical}/entry-link.a0`, 'file');
const fileAlias = emitLink(`${alias}/entry-link.a0`, alias);
assert.equal(fileAlias.status, 0, fileAlias.stderr);
const aliasModel = await model('aliased-entry', fileAlias.text);
assert.equal(aliasModel.call('entry', [], []), 17);
await writeFile(`${ROOT}/outside.a0`, 'fn outside -> u32\nret 23\nend\n');
await writeFile(
  `${physical}/sub/main.a0`,
  'use "../../outside.a0"\nfn entry -> u32\nr call outside\nret r\nend\n',
);
const escapedImport = emitLink(`${alias}/entry-link.a0`, alias);
assert.equal(
  escapedImport.status,
  6,
  'canonicalizing missing paths must retain project-root confinement',
);
assert.equal(escapedImport.text, '');
reports.push({ name: 'aliased-entry-lexical-parent-and-confinement', code: fileAlias.status });
await mkdir(`${ROOT}/outside-directory`);
await symlink(`${ROOT}/outside-directory`, `${physical}/escape`, 'dir');
await writeFile(`${physical}/main.a0`, 'use "escape/new/missing.a0"\nfn f -> u32\nret 0\nend\n');
const missingEscape = emitLink(`${physical}/main.a0`, physical);
assert.equal(
  missingEscape.status,
  6,
  'missing descendants of outside symlinks must remain outside the root',
);
assert.equal(missingEscape.text, '');
await mkdir(F, { recursive: true });
await writeFile(`${F}/dep.a0`, 'fn plus u32 -> u32\nex 0 -> 13\nr add p0 13\nret r\nend\n');
await writeFile(
  `${F}/main.a0`,
  'use "dep.a0"\nfn entry u32 -> u32\nex 1 -> 14\npost eq r 14\nr call plus p0\nret r\nend\n',
);
async function model(name, text) {
  const d = `${ROOT}/${name}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/module.s`, text);
  const c = spawnSync(
    'clang',
    ['-target', 'arm64-apple-darwin', '-c', `${d}/module.s`, '-o', `${d}/module.o`],
    { encoding: 'utf8' },
  );
  assert.equal(c.status, 0, c.stderr);
  return new Arm64Model(machoObject(await readFile(`${d}/module.o`)));
}
const good = emitLink(`${F}/main.a0`, F, { quantum: 7 });
assert.equal(good.status, 0, good.stderr);
assert.equal(good.meta.service[18], 1);
assert.equal(good.meta.service[1], 1);
assert.equal(good.meta.verifier[1], 11);
assert.equal(good.meta.descriptor[3], 1);
assert.equal(good.meta.descriptor[15], 2);
assert.equal(good.meta.link[121], 1);
assert.equal(good.meta.link[122], 1);
const gm = await model('linked', good.text);
for (const v of [0, 1, 13, 2147483648, 4294967295])
  assert.equal(gm.call('entry', [v], ['u32']), Number(BigInt.asUintN(32, BigInt(v) + 13n)));
reports.push({ name: 'linked-valid-imported-examples-post', code: 0, cases: 5, meta: good.meta });
await writeFile(
  `${F}/bad.a0`,
  'use "dep.a0"\nfn entry u32 -> u32\nex 1 -> 0\nr call plus p0\nret r\nend\n',
);
const bad = emitLink(`${F}/bad.a0`, F, { quantum: 1 });
assert.equal(bad.status, 8, bad.stderr);
assert.equal(bad.text, '');
assert.equal(bad.meta.service[18], 0);
assert.equal(bad.meta.service[4], 4);
assert.equal(bad.meta.service[5], 715);
assert.ok(bad.meta.service[16] > 0);
assert.ok(bad.meta.service[20] > 0);
reports.push({ name: 'linked-wrong-example-original-projection', code: 8, meta: bad.meta });
await writeFile(`${F}/strict.a0`, 'fn divide u32 u32 -> u32\nr div p0 p1\nret r\nend\n');
const strict = emitLink(`${F}/strict.a0`, F, { override: 2, quantum: 1 });
assert.equal(strict.status, 0, strict.stderr);
assert.equal(strict.meta.service[18], 1);
const sm = await model('strict-override', strict.text),
  trap = sm.call('divide', [9, 0], ['u32', 'u32']);
assert.deepEqual(trap, {
  exit: 3,
  stderr:
    'runtime: trap divzero fn=divide at=- trip=- chain=divide fix: test the divisor first, or use cdiv/crem, which return (0,false) for a zero divisor\n',
});
reports.push({ name: 'linked-verified-strict-override', code: 0, trap });
for (const [name, files, entry, expect] of [
  ['missing', { 'main.a0': 'use "gone.a0"\nfn f -> u32\nret 0\nend\n' }, 'main.a0', 8],
  [
    'cycle',
    {
      'main.a0': 'use "dep.a0"\nfn f -> u32\nret 0\nend\n',
      'dep.a0': 'use "main.a0"\nfn g -> u32\nret 1\nend\n',
    },
    'main.a0',
    6,
  ],
  [
    'grammar-before-use',
    { 'main.a0': 'use "missing.a0"\nfn f -> u32\nex -> 0\nret 0\nend\nbad\n' },
    'main.a0',
    6,
  ],
  [
    'earlier-imported-spec-before-entry-body',
    {
      'main.a0': 'use "dep.a0"\nfn f -> u32\nr add true 1\nret r\nend\n',
      'dep.a0': 'fn g -> u32\nex -> 9\nret 0\nend\n',
    },
    'main.a0',
    8,
  ],
]) {
  const d = `${ROOT}/${name}`;
  await mkdir(d, { recursive: true });
  for (const [f, s] of Object.entries(files)) await writeFile(`${d}/${f}`, s);
  const r = emitLink(`${d}/${entry}`, d);
  assert.equal(r.status, expect, r.stderr);
  assert.equal(r.text, '');
  assert.equal(r.meta.pending, false);
  assert.equal(r.meta.service[1], 1);
  assert.equal(r.meta.service[18], 0);
  if (name === 'earlier-imported-spec-before-entry-body') {
    assert.equal(r.meta.service[4], 4);
    assert.equal(r.meta.service[5], 715);
  }
  reports.push({ name, code: r.status, meta: r.meta });
}
const terminal = emitLink(`${F}/main.a0`, F, { dense: 1 });
assert.equal(terminal.status, 7, terminal.stderr);
assert.equal(terminal.text, '');
assert.equal(terminal.meta.pending, false);
assert.equal(terminal.meta.service[1], 1);
reports.push({ name: 'dense-terminal7', code: 7 });
const pending = emitLink(`${F}/main.a0`, F, { quantum: 0, maxPumps: 1 });
assert.equal(pending.status, 7);
assert.equal(pending.meta.pending, true);
assert.equal(pending.meta.service[1], 0);
assert.equal(pending.text, '');
reports.push({ name: 'zero-quantum-pending7', code: 7 });
await writeFile(
  `${ROOT}/link-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual native A0 filesystem link→complete grammar→ordered verification→linked context→ARM64 emitter, retained original source/diagnostic metadata; actual relocated MachO instruction model',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
console.log(reports.length, 'native linked/source-order/strict/pending controls passed');
