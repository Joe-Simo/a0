import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { Arm64Model, machoObject } from './arm64-model.mjs';
import { emitProgram, emitSource, ROOT } from './transport.mjs';

const reports = [];
async function model(name, source, mode) {
  const r = mode === 'source' ? emitSource(source) : emitProgram(parseAndValidate(source));
  assert.equal(r.status, 0, r.stderr);
  const d = `${ROOT}/${name}-${mode}`;
  await mkdir(d, { recursive: true });
  await writeFile(`${d}/source.a0`, source);
  await writeFile(`${d}/module.s`, r.text);
  const c = spawnSync(
    'clang',
    ['-target', 'arm64-apple-darwin', '-c', `${d}/module.s`, '-o', `${d}/module.o`],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(c.status, 0, c.stderr);
  const obj = machoObject(await readFile(`${d}/module.o`));
  return { m: new Arm64Model(obj), object: obj, asm: r.text };
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
  `ret v${depth - 1}\nend\nfn deep_identity ${ty} -> ${ty}\nret p0\nend\n`;
const p = parseAndValidate(source);
let prev;
for (const mode of ['source', 'table']) {
  const r = await model('deep96', source, mode);
  if (prev !== undefined) assert.equal(r.asm, prev);
  prev = r.asm;
  let count = 0;
  for (const value of [0, 1, 2147483648, 4294967295]) {
    assert.equal(r.m.call('deep', [value], ['u32']), value);
    let input = value;
    for (let i = 0; i < depth; i++) input = [input, i % 2 === 1];
    const f = p.byName.get('deep_identity');
    for (const alias of [undefined, 0]) {
      const got = r.m.call('deep_identity', [input], f.params, {
        resultType: f.result,
        sretAliasParam: alias,
        inspect: true,
      });
      assert.deepEqual(
        got.value,
        JSON.parse(JSON.stringify(input), (_, v) => (typeof v === 'boolean' ? Number(v) : v)),
      );
      count++;
    }
    count++;
  }
  reports.push({
    name: 'deep96',
    mode,
    depth,
    cases: count,
    assemblyBytes: r.asm.length,
    instructions: r.m.instructions,
  });
  console.log(mode, '96-level record constructor/get and aggregate identity/sret alias passed');
}
const far =
    'profile strict\nfn far u32 -> u32\na arr 13 17\nfirst get a p0\nbig arr ' +
    Array(65536).fill('0').join(' ') +
    '\nunused get big 0\nret first\nend\n',
  r = await model('strict-far', far, 'source');
assert.ok(
  r.object.bytes.length > 1048576,
  'actual early strict trap branch exceeds Bcond 1MiB reach',
);
const trap = r.m.call('far', [2], ['u32']);
assert.deepEqual(trap, {
  exit: 3,
  stderr:
    'runtime: trap bounds fn=far at=- trip=- chain=far fix: keep the index below the length (check it, or use cget for a total read)\n',
});
assert.equal(r.m.call('far', [0], ['u32'], { maxSteps: 5000000 }), 13);
reports.push({
  name: 'strict-far',
  mode: 'source',
  actualTextBytes: r.object.bytes.length,
  assemblyBytes: r.asm.length,
  trap,
  instructions: r.m.instructions,
});
console.log('strict trap beyond actual 1MiB code branch reach and safe large frame passed');
await writeFile(
  `${ROOT}/geometry-results.json`,
  `${JSON.stringify(
    {
      kind: 'Actual native A0 source/table deep records, x8 alias and full-u32 frame geometry; actual MachO crossassembly and decoded target instructions; local-inverse plus wide unconditional strict branch',
      reports,
      nativeCompilerProof: true,
      hardwareExecution: false,
    },
    null,
    2,
  )}\n`,
);
