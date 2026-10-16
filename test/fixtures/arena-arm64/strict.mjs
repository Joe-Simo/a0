import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Arm64Model, machoObject } from './arm64-model.mjs';
import { emitSource, ROOT } from './transport.mjs';

const ORIGINAL = new URL('./sources/', import.meta.url),
  fix = {
    bounds: 'keep the index below the length (check it, or use cget for a total read)',
    divzero: 'test the divisor first, or use cdiv/crem, which return (0,false) for a zero divisor',
  },
  reports = [];
for (const name of ['strict', 'strict-extra']) {
  const source = await readFile(new URL(`${name}.a0`, ORIGINAL), 'utf8'),
    r = emitSource(source);
  assert.equal(r.status, 0, r.stderr);
  const d = `${ROOT}/${name}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/module.s`, r.text);
  const c = spawnSync(
    'clang',
    ['-target', 'arm64-apple-darwin', '-c', `${d}/module.s`, '-o', `${d}/module.o`],
    { encoding: 'utf8' },
  );
  assert.equal(c.status, 0, c.stderr);
  const m = new Arm64Model(machoObject(await readFile(`${d}/module.o`))),
    traps =
      name === 'strict'
        ? [
            ['divide', [13, 0], 'divzero', '-', '-', 'divide'],
            ['bound', [3], 'bounds', '-', '-', 'bound'],
            ['folded', [9], 'divzero', 'folded.iteration', 2, 'folded>stp'],
            ['looped', [1], 'bounds', 'looped.original_loop', 2, 'looped>pred'],
          ]
        : [
            ['remzero', [4294967295, 0], 'divzero', '-', '-', 'remzero'],
            ['both', [2, 9], 'bounds', '-', '-', 'both'],
            ['both', [0, 9], 'divzero', '-', '-', 'both'],
            ['update', [2], 'bounds', '-', '-', 'update'],
            ['top', [9], 'divzero', 'middle.iteration', 2, 'top>middle>stp'],
            ['after', [9], 'divzero', '-', '-', 'after'],
          ];
  for (const [fn, args, kind, at, trip, chain] of traps) {
    const got = m.call(
      fn,
      args,
      args.map(() => 'u32'),
    );
    assert.equal(got.exit, 3);
    assert.equal(
      got.stderr,
      `runtime: trap ${kind} fn=${chain.split('>').at(-1)} at=${at} trip=${trip} chain=${chain} fix: ${fix[kind]}\n`,
    );
    reports.push({ name, fn, args, ...got });
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
    assert.equal(
      m.call(
        fn,
        args,
        args.map(() => 'u32'),
      ),
      want,
    );
    reports.push({ name, fn, args, value: want });
  }
}
await writeFile(
  `${ROOT}/strict-results.json`,
  `${JSON.stringify(
    {
      kind: 'Native A0 source strict original names/frame/trip/first-trap/order/reporting; actual decoded MachO instructions and only generic Darwin syscall hooks',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
console.log(reports.length, 'native compiler strict target-model cases passed');
