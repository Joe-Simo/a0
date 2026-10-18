import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseAndValidate } from '../../../dist/src/core.js';
import { checkedCases } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import { cases } from '../arena-spec-verifier/cases.mjs';
import { invoke, trace } from './codec.mjs';
import { tables } from './tables.mjs';

const [exe, group, N] = process.argv.slice(2);
assert.ok(exe && group && N);
assert.ok(['prepare', 'core', 'boundaries'].includes(group));
const opt = 'native',
  rows = [],
  sha = (x) => createHash('sha256').update(x).digest('hex');

import { targetFixture } from './runtime.mjs';

if (group === 'core') {
  for (const item of cases) {
    const r = await invoke(exe, item.name, item.nativeSource ?? item.source);
    assert.equal(r.code, item.status, item.name);
    assert.equal(r.M[1], item.id ?? 0, item.name);
    if (r.code === 0) {
      assert.equal(r.E[1], 1);
      assert.ok(r.text.includes('public static class A0Module'));
      assert.equal(r.D[1], 0x41304243);
    } else assert.deepEqual(r.E.slice(3, 6), [0, 0, 0]);
    rows.push({ opt, label: item.name, code: r.code, diag: r.M[1] });
  }
}
if (group === 'prepare') {
  for (const profile of ['canonical', 'strict']) {
    const fixture = targetFixture(profile === 'strict');
    const r = await invoke(exe, `runtime-${profile}`, fixture.source);
    assert.equal(r.code, 0);
    assert.equal(r.text.includes('public sealed class A0Trap'), profile === 'strict');
    assert.ok(r.text.includes('(ulong)a * b <= uint.MaxValue'));
    assert.ok(r.text.includes('a[i], true'));
    const dir = `${N}/target/${profile}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/A0Module.cs`, r.text);
    await writeFile(`${dir}/Driver.cs`, fixture.driver);
    await writeFile(`${dir}/expected.txt`, String(fixture.expected));
    rows.push({
      label: `runtime-${profile}`,
      code: 0,
      bytes: Buffer.byteLength(r.text),
      preparedCheckedCases: checkedCases().length,
      executedCSharpCases: 0,
    });
  }
}
if (group === 'core') {
  const imported = await invoke(exe, 'unit-import', 'use "child.a0"\nfn f -> u32\nret 0\nend\n');
  assert.equal(imported.code, 7);
  rows.push({ opt, label: 'unit-import', code: 7 });
  const simple = 'fn f u32 -> u32\nr add p0 1\nret r\nend\n';
  for (const fault of [
    {
      label: 'first-load-status',
      faultOp: 2,
      faultNth: 1,
      faultStatus: 3,
      code: 3,
    },
    {
      label: 'middle-load-status',
      faultOp: 2,
      faultNth: 25,
      faultStatus: 5,
      code: 5,
    },
    {
      label: 'allocation-budget',
      maxWords: Buffer.byteLength(simple) + 1,
      code: 4,
    },
    { label: 'publication-budget', maxOutput: 8, code: 4 },
  ]) {
    const r = await invoke(exe, fault.label, simple, fault);
    assert.equal(r.code, fault.code, fault.label);
    rows.push({ opt, label: fault.label, code: r.code });
  }
  for (const op of [0, 38]) {
    const p = tables(parseAndValidate(simple));
    p.nodes[8] = op;
    const r = await invoke(exe, `unknown-${op}`, p);
    assert.equal(r.code, 6);
    rows.push({ opt, label: `unknown-${op}`, code: 6 });
  }
  for (const options of [1, 0xffffffff]) {
    const r = await invoke(exe, `options-${options}`, tables(parseAndValidate(simple)), {
      options,
    });
    assert.equal(r.code, 8);
    rows.push({ opt, label: `options-${options}`, code: 8 });
  }
}
if (group === 'boundaries') {
  for (const elem of ['u32', 'bool']) {
    const source = `fn large -> ${elem}x65536\na arr ${Array(65536)
      .fill(elem === 'u32' ? '1' : 'true')
      .join(' ')}\nret a\nend\n`;
    assert.ok(source.length > 131072);
    const r = await invoke(exe, `source-65536-${elem}`, source);
    assert.equal(r.code, 0);
    assert.equal(r.ctx[11], 1);
    assert.equal(r.ctx[13], 2);
    assert.equal(r.D[12], 65539);
    assert.ok(r.text.includes(`new ${elem === 'u32' ? 'uint' : 'bool'}[]{`));
    rows.push({
      opt,
      label: `source-65536-${elem}`,
      inputBytes: source.length,
      code: 0,
      arguments: r.D[12],
      bytes: Buffer.byteLength(r.text),
    });
  }
  const functions = 9000,
    source = Array.from(
      { length: functions },
      (_, i) => `fn f${i} u32x${i + 1} -> u32x${i + 1}\nret p0\nend\n`,
    ).join('');
  {
    const r = await invoke(exe, 'source-9000-functions-types', source);
    assert.equal(r.code, 0);
    assert.equal(r.ctx[11], 9000);
    assert.equal(r.ctx[12], 9003);
    assert.ok(r.text.includes('public static uint[] @f8999(uint[] p0)'));
    rows.push({
      opt,
      label: 'source-9000-functions-types',
      code: 0,
      functions: r.ctx[11],
      types: r.ctx[12],
      inputBytes: source.length,
      bytes: Buffer.byteLength(r.text),
    });
  }
  let pads = '';
  for (let j = 0; j < 17; j++) {
    pads += `fn pad${j} u32 u32 -> u32\n`;
    for (let i = 0; i < 4000; i++) pads += `f${j}_n${i} mov p0\n`;
    pads +=
      j === 16
        ? 'original_failure div p0 0\nret original_failure\nend\n'
        : `ret f${j}_n3999\nend\n`;
  }
  pads +=
    'fn entry u32 -> u32\niteration_after_globalid_boundary fold pad16 1 p0\nret iteration_after_globalid_boundary\nend\n';
  {
    const r = await invoke(exe, 'source-68002-global-nodes', `profile strict\n${pads}`);
    assert.equal(r.code, 0);
    assert.equal(r.ctx[13], 68003);
    assert.ok(r.text.includes('uint n68001 = __a0_sdiv(p0, 0u)'));
    assert.ok(r.text.includes('__a0_nd[__a0_depth - 1] = "iteration_after_globalid_boundary"'));
    assert.ok(r.text.includes('__a0_tr[__a0_depth - 1] = i68002'));
    rows.push({
      opt,
      label: 'source-68002-global-nodes',
      code: 0,
      nodes: r.ctx[13] - 1,
      bytes: Buffer.byteLength(r.text),
    });
  }
  for (const [mode, depth, selector] of [
    ['mangle', 3000, 1],
    ['array-type', 300, 2],
  ]) {
    const p = {
      types: [1, 0, 0, 2, 0, 0, 3, 0, 0],
      tlist: [0],
      fns: [],
      nodes: Array(8).fill(0),
      args: [3, 0, 3, 0, 3, 0],
      pool: [],
      counts: [0, depth + 3, 1],
    };
    for (let i = 0; i < depth; i++) {
      const child = i ? i + 2 : 0;
      if (mode === 'mangle') {
        p.types.push(5, p.tlist.length, 1);
        p.tlist.push(child);
      } else p.types.push(4, 1, child);
    }
    const r = await invoke(exe, mode, p, { selector, type: depth + 2 });
    assert.equal(r.code, 0);
    assert.equal(
      r.text,
      mode === 'mangle' ? `${'r1_'.repeat(depth)}u` : `uint${'[]'.repeat(depth)}`,
    );
    rows.push({
      opt,
      label: mode,
      code: 0,
      depth,
      bytes: Buffer.byteLength(r.text),
    });
  }
}
console.log({
  optimization: opt,
  status: 'native emission controls passed',
  requests: rows.length,
});
for (const row of trace) {
  assert.equal(sha(await readFile(row.input)), row.inputSHA256);
  assert.equal(sha(await readFile(row.output)), row.outputSHA256);
  assert.equal(row.stderr, '');
}
await writeFile(
  `${N}/${group}-results.json`,
  `${JSON.stringify(
    {
      status: 'pass-native-emission-target-runtime-blocked',
      requests: rows.length,
      rows,
      targetRuntime: {
        status: 'blocked',
        executedCases: 0,
        preparedAssertions: { canonical: 2366, strict: 2374 },
        reason: 'No existing .NET SDK. No installation attempted.',
      },
      note: 'Actual reused verified C seed generated changed A0 compiler C; O0/O2 UBSan/Werror executables consume raw source. Table selectors are explicit isolated boundary controls, with no semantic fallback or source reinterpretation.',
    },
    null,
    2,
  )}\n`,
);
