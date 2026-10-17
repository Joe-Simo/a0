import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CHECKED_SOURCE, checkedCases } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import { RV64 } from './rv64-model.mjs';
import { CLANG, emitSource, ROOT } from './transport.mjs';

const R = ROOT,
  reports = [];
async function target(name, source) {
  const r = emitSource(source);
  assert.equal(r.code, 0, JSON.stringify({ ...r, text: undefined }));
  assert.equal(r.phase, 11);
  const d = `${R}/tests/strict/${name}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/source.a0`, source);
  await writeFile(`${d}/module.s`, r.text);
  await writeFile(
    `${d}/host-boundary.s`,
    '\t.text\n\t.globl A0_trap\n\t.p2align 2\nA0_trap:\n\tebreak\n',
  );
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
      `${d}/host-boundary.s`,
      '-o',
      `${d}/program.elf`,
    ],
    c = spawnSync(CLANG, args, { encoding: 'utf8', timeout: 60000 });
  assert.equal(c.status, 0, c.stderr);
  return new RV64(await readFile(`${d}/program.elf`));
}
for (const name of ['strict', 'strict-extra']) {
  const source = await readFile(new URL(`./sources/${name}.a0`, import.meta.url), 'utf8'),
    cpu = await target(name, source),
    traps =
      name === 'strict'
        ? [
            ['divide', [13, 0], 'divzero', null, 0, 'divide'],
            ['bound', [3], 'bounds', null, 0, 'bound'],
            ['folded', [9], 'divzero', 'iteration', 2, 'folded>stp'],
            ['looped', [1], 'bounds', 'original_loop', 2, 'looped>pred'],
          ]
        : [
            ['remzero', [4294967295, 0], 'divzero', null, 0, 'remzero'],
            ['both', [2, 9], 'bounds', null, 0, 'both'],
            ['both', [0, 9], 'divzero', null, 0, 'both'],
            ['update', [2], 'bounds', null, 0, 'update'],
            ['top', [9], 'divzero', 'iteration', 2, 'top>middle>stp'],
            ['after', [9], 'divzero', null, 0, 'after'],
          ];
  for (const [fn, args, kind, node, trip, chain] of traps) {
    const got = cpu.call(`a0_${fn}`, args, { captureHostTrap: true });
    assert.equal(got.kind, kind, fn);
    assert.equal(got.fpReset, true);
    assert.equal(got.frames.map((f) => f.fn).join('>'), chain);
    const marked = got.frames.filter((f) => f.node !== null).at(-1);
    assert.equal(marked?.node ?? null, node);
    if (node) assert.equal(marked.trip, trip);
    reports.push({ name, fn, args, record: got });
  }
  const safe =
    name === 'strict'
      ? [
          ['divide', [13, 2], 6],
          ['bound', [0], 11],
          ['bound', [2], 33],
        ]
      : [
          ['trap', [], 7],
          ['update', [0], 99],
          ['update', [1], 13],
          ['skip', [4294967295], 4294967295],
        ];
  for (const [fn, args, want] of safe) {
    assert.equal(cpu.call(`a0_${fn}`, args), want);
    reports.push({ name, fn, args, value: want });
  }
}
const checkedSource = `profile strict\n${CHECKED_SOURCE}`,
  cpu = await target('checked', checkedSource);
for (const t of checkedCases())
  assert.equal(
    cpu.call(`a0_${t.functionName}`, t.args),
    Number(t.expected),
    `${t.functionName} ${t.args}`,
  );
reports.push({
  name: 'strict-checked-total',
  cases: checkedCases().length,
  instructions: cpu.instructions,
});
const unsupported = emitSource('profile strict\nfn f io -> io\nret p0\nend\n');
assert.equal(unsupported.code, 6);
assert.equal(unsupported.text, '');
reports.push({ name: 'explicit-strict-IO-extension-refusal', code: 6 });
await writeFile(
  `${R}/tests/strict-results.json`,
  `${JSON.stringify(
    {
      kind: 'Original source through actual A0 ordered frontend/context and strict RV64 emitter under actual native A0 compiler. Actual linked ELF instructions execute module guards/frames/stubs; model captures only the DECLARED EXTERNAL A0_trap host boundary and decodes actual ABI record. No host reporter or hardware execution claim.',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
      modelHostHooks: ['external nonreturning A0_trap ABI boundary only'],
      compilerHelperHooks: [],
    },
    null,
    2,
  )}\n`,
);
console.log(
  '17 strict original-ID/frame/trip/order controls and',
  checkedCases().length,
  'strict total checked cases pass; strict IO explicit refusal',
);

await import('./strict-chain.mjs');
