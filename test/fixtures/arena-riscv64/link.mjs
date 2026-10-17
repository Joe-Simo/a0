import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { RV64 } from './rv64-model.mjs';
import { CLANG, emitLink, ROOT } from './transport.mjs';

const R = ROOT,
  F = `${R}/tests/ordered-link`,
  reports = [];
await mkdir(F, { recursive: true });
function emit(entry, root, flags = {}) {
  const r = emitLink(entry, root, { quantum: 7, maxPumps: 100000, ...flags });
  return { ...r, service: r.meta.service, link: r.meta.link };
}
await writeFile(`${F}/dep.a0`, 'fn plus u32 -> u32\nex 0 -> 13\nr add p0 13\nret r\nend\n');
await writeFile(
  `${F}/main.a0`,
  'use "dep.a0"\nfn entry u32 -> u32\nex 1 -> 14\nr call plus p0\nret r\nend\n',
);
const good = emit(`${F}/main.a0`, F);
assert.equal(good.code, 0);
assert.equal(good.phase, 11);
assert.equal(good.service[18], 1);
assert.equal(good.descriptor[3], 1);
assert.equal(good.link[121], 1);
assert.equal(good.link[122], 1);
reports.push({ name: 'valid-imported-spec-call', ...good, text: undefined });
async function target(name, text) {
  const d = `${F}/${name}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/module.s`, text);
  await writeFile(`${d}/host.s`, '\t.text\n\t.globl A0_trap\nA0_trap:\n\tebreak\n');
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
      '-Wl,-e,A0_trap',
      `${d}/module.s`,
      `${d}/host.s`,
      '-o',
      `${d}/program.elf`,
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(c.status, 0, c.stderr);
  return new RV64(await readFile(`${d}/program.elf`));
}
const gm = await target('valid', good.text);
for (const v of [0, 1, 13, 2147483648, 4294967295])
  assert.equal(gm.call('a0_entry', [v]), Number(BigInt.asUintN(32, BigInt(v) + 13n)));
await writeFile(`${F}/strict.a0`, 'fn divide u32 u32 -> u32\nr div p0 p1\nret r\nend\n');
const strict = emit(`${F}/strict.a0`, F, { override: 2 });
assert.equal(strict.code, 0);
assert.equal(strict.service[18], 1);
const sm = await target('strict-override', strict.text),
  trap = sm.call('a0_divide', [9, 0], { captureHostTrap: true });
assert.deepEqual(trap, {
  kind: 'divzero',
  frames: [{ fn: 'divide', node: null, trip: 0 }],
  fpReset: true,
});
reports.push({ name: 'verified-strict-override', code: 0, trap });
for (const [name, files, want, stage, id] of [
  [
    'wrong-example',
    {
      'main.a0': 'use "../dep.a0"\nfn f u32 -> u32\nex 1 -> 0\nr call plus p0\nret r\nend\n',
    },
    8,
    4,
    715,
  ],
  ['missing', { 'main.a0': 'use "gone.a0"\nfn f -> u32\nret 0\nend\n' }, 8, 1, 0],
  [
    'cycle',
    {
      'main.a0': 'use "dep.a0"\nfn f -> u32\nret 0\nend\n',
      'dep.a0': 'use "main.a0"\nfn g -> u32\nret 0\nend\n',
    },
    6,
    1,
    620,
  ],
  [
    'grammar-before-use',
    { 'main.a0': 'use "gone.a0"\nfn f -> u32\nex -> 0\nret 0\nend\nbad\n' },
    6,
    1,
    0,
  ],
  [
    'earlier-imported-example',
    {
      'main.a0': 'use "dep.a0"\nfn f -> u32\nr add true 1\nret r\nend\n',
      'dep.a0': 'fn g -> u32\nex -> 9\nret 0\nend\n',
    },
    8,
    4,
    715,
  ],
]) {
  const d = `${F}/${name}`;
  await mkdir(d, { recursive: true });
  for (const [p, s] of Object.entries(files)) await writeFile(`${d}/${p}`, s);
  const r = emit(`${d}/main.a0`, F);
  assert.equal(r.code, want, `${name} ${JSON.stringify(r)}`);
  assert.equal(r.pending, false);
  assert.equal(r.service[1], 1);
  assert.equal(r.service[18], 0);
  assert.equal(r.service[4], stage);
  if (id) assert.equal(r.service[5], id);
  assert.equal(r.text, '');
  if (stage === 4) {
    assert.ok(r.service[16] > 0);
    assert.ok(r.service[20] > 0);
  }
  reports.push({ name, ...r });
}
const terminal = emit(`${F}/main.a0`, F, { dense: true });
assert.equal(terminal.code, 7);
assert.equal(terminal.pending, false);
assert.equal(terminal.service[1], 1);
assert.equal(terminal.text, '');
reports.push({ name: 'dense-terminal7', ...terminal });
const pending = emit(`${F}/main.a0`, F, { quantum: 0, maxPumps: 1 });
assert.equal(pending.pending, true);
assert.equal(pending.service[1], 0);
assert.equal(pending.text, '');
reports.push({ name: 'zero-quantum-pending7', ...pending });
await writeFile(
  `${R}/tests/link-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual A0 ordered linked verification→linked full-word context→RV64 under actual native A0 compiler; actual static ELF independent model/strict ABI record; failures preserve original source projections',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
console.log(
  reports.length,
  'ordered linked RV64 source/origin/strict/terminal-pending controls passed',
);
