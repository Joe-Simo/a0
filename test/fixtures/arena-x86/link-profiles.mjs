import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { ABI_SOURCE } from '../../../dist/test/fixtures/native-ports/abi.js';
import { NATIVE_PORT_SOURCE } from '../../../dist/test/fixtures/native-ports/semantic.js';
import { emitLink, emitSource, ROOT } from './transport.mjs';

const reports = [];
async function target(name, asm, driver) {
  const d = ROOT + '/' + name;
  await mkdir(d, { recursive: true });
  await writeFile(d + '/module.s', asm);
  await writeFile(d + '/driver.c', driver);
  const c = spawnSync(
    'clang',
    ['-O2', '-Wall', '-Wextra', '-Werror', d + '/module.s', d + '/driver.c', '-o', d + '/program'],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(c.status, 0, c.stderr);
  assert.equal(spawnSync(d + '/program', [], { timeout: 60000 }).status, 0, name);
}
const F = ROOT + '/link';
await mkdir(F + '/project', { recursive: true });
await writeFile(F + '/project/dep.a0', 'fn plus u32 -> u32\nr add p0 13\nret r\nend\n');
await writeFile(
  F + '/project/main.a0',
  'use "dep.a0"\nfn entry u32 -> u32\nr call plus p0\nret r\nend\n',
);
const linked = emitLink(F + '/project/main.a0', F + '/project');
assert.equal(linked.status, 0, linked.stderr);
assert.equal(linked.meta.descriptor[3], 1);
assert.equal(linked.meta.descriptor[15], 2);
assert.ok(linked.meta.descriptor[5]);
assert.equal(linked.meta.link[94], 2);
assert.equal(linked.meta.link[120], 1);
assert.ok(linked.meta.link[45] > 0);
assert.ok(linked.meta.link[54] > 0);
assert.ok(linked.meta.fsCalls[0] >= 2);
await target(
  'link/runtime',
  linked.text,
  '#include <stdint.h>\nextern uint32_t a0_entry(uint32_t);\nint main(void){uint32_t values[]={0,1,13,2147483648u,4294967295u};for(unsigned i=0;i<5;i++)if(a0_entry(values[i])!=(uint32_t)((uint64_t)values[i]+13))return 1;return 0;}\n',
);
await writeFile(F + '/metadata.json', JSON.stringify(linked.meta, null, 2) + '\n');
reports.push({
  name: 'native-A0-filesystem-link-verify-lower-emit',
  code: 0,
  actualLinuxX86TargetExecution: true,
  cases: 5,
  linkSchema: 2,
  descriptorSourceKind: 1,
  immutableLinkSnapshotRetained: true,
  originDirectoryAndRefsRetained: true,
});
for (const [name, files, want, diag, entry, root] of [
  [
    'missing-file',
    { 'main.a0': 'use "gone.a0"\nfn entry -> u32\nret 0\nend\n' },
    8,
    0,
    'main.a0',
    '.',
  ],
  [
    'outside-root',
    {
      'project/main.a0': 'use "../outside.a0"\nfn entry -> u32\nret 0\nend\n',
      'outside.a0': 'fn outside -> u32\nret 0\nend\n',
    },
    6,
    622,
    'project/main.a0',
    'project',
  ],
  [
    'cycle',
    {
      'main.a0': 'use "dep.a0"\nfn entry -> u32\nret 0\nend\n',
      'dep.a0': 'use "main.a0"\nfn dep -> u32\nret 0\nend\n',
    },
    6,
    620,
    'main.a0',
    '.',
  ],
  [
    'wrong-linked-example',
    { 'main.a0': 'fn entry u32 -> u32\nex 0 -> 99\nr add p0 1\nret r\nend\n' },
    8,
    0,
    'main.a0',
    '.',
  ],
  [
    'whole-grammar-before-dependency-read',
    { 'main.a0': 'use "gone.a0"\nfn entry -> u32\nret 0\n' },
    6,
    25,
    'main.a0',
    '.',
  ],
  ['malformed-utf8-explicit-refusal', { 'main.a0': Buffer.from([0xc3]) }, 7, 0, 'main.a0', '.'],
  ['dense-explicit-refusal', { 'main.a0d': 'fn entry\n0\n' }, 7, 0, 'main.a0d', '.'],
]) {
  const d = F + '/' + name;
  for (const [p, s] of Object.entries(files)) {
    const path = d + '/' + p;
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(path, s);
  }
  const r = emitLink(d + '/' + entry, d + '/' + root, {
    dense: name === 'dense-explicit-refusal' ? 1 : 0,
  });
  assert.equal(r.status, want, r.stderr);
  assert.equal(r.text, '');
  assert.equal(r.meta.pending, false);
  assert.equal(r.meta.link[0], name === 'wrong-linked-example' ? 0 : want);
  if (name === 'wrong-linked-example') {
    assert.equal(r.meta.verifier[0], 8, 'actual ordered verifier rejects the example');
    assert.equal(r.meta.verifier[1], 11, 'terminal failure');
  }
  if (name === 'whole-grammar-before-dependency-read')
    assert.equal(r.meta.fsCalls[1], 1, 'parse failure precedes reading missing dependency');
  if (diag) assert.equal(r.meta.link[1], diag);
  if (name === 'missing-file') assert.equal(r.meta.link[4], 2);
  reports.push({
    name,
    code: r.status,
    diagnostic: r.meta.link[1],
    errno: r.meta.link[4],
    pending: r.meta.pending,
    bytesPublished: 0,
  });
}
const specdir = F + '/verified-specs';
await mkdir(specdir);
await writeFile(specdir + '/dep.a0', 'fn plus u32 -> u32\nex 0 -> 13\nr add p0 13\nret r\nend\n');
await writeFile(
  specdir + '/main.a0',
  'use "dep.a0"\nfn entry u32 -> u32\nex 0 -> 13\nr call plus p0\nret r\nend\n',
);
const verified = emitLink(specdir + '/main.a0', specdir);
assert.equal(verified.status, 0, verified.stderr);
assert.equal(verified.meta.verifier[0], 0);
assert.equal(verified.meta.verifier[1], 11, 'ordered verification completes before emission');
assert.equal(verified.meta.checked[0], 0);
assert.equal(verified.meta.link[121], 1, 'authenticated complete grammar');
assert.equal(verified.meta.link[122], 1, 'spec grammar initially required verification');
assert.equal(verified.meta.descriptor[3], 1, 'linked original metadata retained');
await target(
  'link/spec-runtime',
  verified.text,
  '#include <stdint.h>\nextern uint32_t a0_entry(uint32_t);\nint main(void){return a0_entry(0)!=13u||a0_entry(4294967295u)!=12u;}\n',
);
reports.push({
  name: 'linked-multifile-examples',
  code: 0,
  actualLinuxX86TargetExecution: true,
  cases: 2,
  verifierPhase: 11,
});
const io =
  'fn f u32 io -> u32\nr read p1\nv at r 0\nt at r 1\na write t p0\nb write a v\nret v\nend\n';
for (const [input, output] of [
  [0, 0],
  [1, 1],
  [2, 5],
  [256, 1024],
]) {
  const r = emitSource(io, { input, output });
  assert.equal(r.status, 0, r.stderr);
  const nout = input + 2 + output,
    base = input + 2,
    want = input ? 987 : 0;
  const driver =
    '#include <stdint.h>\nextern uint32_t a0_f(uint32_t,void*);\nint main(void){uint32_t x[' +
    (input + output + 3) +
    ']={0};' +
    (input ? 'x[0]=987;' : '') +
    (input > 1 ? 'x[1]=654;' : '') +
    'x[' +
    input +
    ']=2; uint32_t v=a0_f(123,x); return v!=' +
    want +
    'u || x[' +
    nout +
    ']!=' +
    Math.min(2, output) +
    'u' +
    (output ? ' || x[' + base + ']!=123u' : '') +
    (output > 1 ? ' || x[' + (base + 1) + ']!=' + want + 'u' : '') +
    ';}\n';
  await target('profiles/' + input + '-' + output, r.text, driver);
  reports.push({ name: 'IO-layout', input, output, actualLinuxX86TargetExecution: true });
}
const darwin = emitSource(NATIVE_PORT_SOURCE + ABI_SOURCE, { platform: 1 });
assert.equal(darwin.status, 0, darwin.stderr);
await writeFile(ROOT + '/darwin.s', darwin.text);
const cross = spawnSync(
  'clang',
  ['-target', 'x86_64-apple-macos14', '-c', ROOT + '/darwin.s', '-o', ROOT + '/darwin.o'],
  { encoding: 'utf8', timeout: 60000 },
);
assert.equal(cross.status, 0, cross.stderr);
reports.push({
  name: 'Darwin-x86_64',
  assemblyBytes: darwin.text.length,
  crossAssemblyOnly: true,
  hardwareExecution: false,
});
await writeFile(
  ROOT + '/link-profile-results.json',
  JSON.stringify(
    {
      kind: 'Native A0 link source/OS boundaries and configurable target IO layout; Darwin crossassembly only',
      reports,
    },
    null,
    2,
  ) + '\n',
);
console.log(reports.length, 'native link/OS/profile probes passed');
