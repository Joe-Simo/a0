import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { ABI_SOURCE, abiCases } from '../../../dist/test/fixtures/native-ports/abi.js';
import {
  NATIVE_PORT_SOURCE,
  nativePortCases,
} from '../../../dist/test/fixtures/native-ports/semantic.js';
import { cDriver } from '../../../dist/tools/verify.js';
import { caseInput, nativeHeader, scalar } from './runtime-helpers.mjs';
import { emitProgram, emitSource, ROOT } from './transport.mjs';

const source = NATIVE_PORT_SOURCE + ABI_SOURCE,
  p = parseAndValidate(source),
  cases = [...nativePortCases(), ...abiCases()],
  driver = cDriver(p, nativeHeader(p)).replace(
    'int main(void) {',
    'int main(void) { if (sret_alias_probe()) return 91;',
  ),
  input = caseInput(p, cases),
  reports = [];
await writeFile(ROOT + '/target-source.a0', source);
for (const [mode, emitter] of [
  ['source', () => emitSource(source)],
  ['table', () => emitProgram(p)],
]) {
  const e = emitter();
  assert.equal(e.status, 0, e.stderr);
  assert.equal(e.meta.code, 0);
  if (mode === 'source') {
    assert.equal(e.meta.verifier[1], 11);
    assert.equal(e.meta.descriptor[1], 0x41304243);
    assert.equal(e.meta.descriptor[2], 1);
  }
  const d = ROOT + '/' + mode;
  await mkdir(d, { recursive: true });
  await writeFile(d + '/module.s', e.text);
  await writeFile(d + '/driver.c', driver);
  await writeFile(d + '/metadata.json', JSON.stringify(e.meta, null, 2) + '\n');
  const c = spawnSync(
    'clang',
    ['-O2', '-Wall', '-Wextra', '-Werror', d + '/module.s', d + '/driver.c', '-o', d + '/program'],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(c.status, 0, c.stderr);
  const ran = spawnSync(d + '/program', [], { input, encoding: 'utf8', timeout: 60000 });
  assert.equal(ran.status, 0, ran.stderr);
  const lines = ran.stdout.trim().split('\n');
  assert.equal(lines.length, cases.length);
  for (const [i, t] of cases.entries())
    assert.equal(
      lines[i],
      [scalar(t.expected), ...(t.expectedOutput ?? [])].join(' '),
      t.functionName + ' ' + t.args,
    );
  reports.push({
    mode,
    cases: cases.length,
    assemblyBytes: e.text.length,
    originalSourceBytes: source.length,
    actualLinuxX86TargetExecution: true,
    sretAliasProbe: true,
    canonicalOps: 37,
    checkedRecordOps: 6,
  });
  console.log(mode, cases.length, 'independent cases + sret alias passed');
  if (mode === 'source') {
    const faulty = e.text.replaceAll('addl %r11d, %eax', 'subl %r11d, %eax');
    assert.ok(faulty !== e.text, 'instruction fault did not match assembly');
    await writeFile(d + '/fault-add.s', faulty);
    await writeFile(
      d + '/fault-driver.c',
      cDriver(p, nativeHeader(p)).replace(
        'int main(void) {',
        'int main(void) { (void)sret_alias_probe;',
      ),
    );
    const fc = spawnSync(
      'clang',
      [
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        d + '/fault-add.s',
        d + '/fault-driver.c',
        '-o',
        d + '/fault-program',
      ],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(fc.status, 0, fc.stderr);
    const fr = spawnSync(d + '/fault-program', [], { input, encoding: 'utf8', timeout: 60000 });
    const bad = fr.stdout.trim().split('\n');
    let mismatches = 0;
    for (const [i, t] of cases.entries())
      if (bad[i] !== [scalar(t.expected), ...(t.expectedOutput ?? [])].join(' ')) mismatches++;
    assert.ok(fr.status !== 0 || mismatches > 0);
    reports.push({
      control: 'actual emitted ADD→SUB instruction mutation',
      exit: fr.status,
      mismatches,
      baselineCases: cases.length,
    });
  }
}
await writeFile(
  ROOT + '/semantic-results.json',
  JSON.stringify(
    {
      kind: 'Native A0 arena compiler built through verified native A0 seed, actual Linux x86 runtime, independent BigInt/ABI oracles; no TS target emission',
      reports,
    },
    null,
    2,
  ) + '\n',
);
