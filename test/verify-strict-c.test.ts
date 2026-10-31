import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatDiagnostic, parseAndValidate, run } from '../src/core.js';
import { findClang, findClangPlusPlus, findGcc } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { checkNative } from '../tools/verify.js';

const tools = () => [
  { tool: findClang(), cpp: false },
  { tool: findGcc(), cpp: false },
  { tool: findClangPlusPlus(), cpp: true },
];

const safe = `profile strict
fn plus u32 u32 -> u32
r add p0 p1
ret r
end`;

test('C verifier executes strict modules without a trap runtime', async (t) => {
  const p = parseAndValidate(safe);
  const cases: Case[] = [
    { functionName: 'plus', args: [0, 0], expected: 0 },
    { functionName: 'plus', args: [0xffffffff, 2], expected: 1 },
    { functionName: 'plus', args: [0x80000000, 0x80000000], expected: 0 },
  ];
  for (const optimize of [false, true]) {
    const source = compile(p, 'c', { optimize }).text;
    assert.ok(!source.includes('a0_trapbuf'));
    for (const { tool, cpp } of tools()) {
      if (tool.path === undefined) {
        t.diagnostic(`${tool.name}: unavailable`);
        continue;
      }
      const result = await checkNative(p, cases, tool, cpp, 'strict trap-free module', source);
      assert.equal(result.status, 'passed', JSON.stringify(result));
      assert.equal(result.cases, cases.length);
    }
  }
});

const trapping = `${safe}
fn quotient u32 u32 -> u32
r div p0 p1
ret r
end
fn outer u32 u32 -> u32
r call quotient p0 p1
ret r
end
fn item u32 -> u32
a arr 11 17 23
r get a p0
ret r
end`;

test('C verifier captures trap hooks and resets after successive failures', async (t) => {
  const p = parseAndValidate(trapping);
  const cases: Case[] = [];
  for (const [name, args] of [
    ['outer', [9, 0]],
    ['outer', [9, 3]],
    ['item', [3]],
    ['item', [2]],
    ['outer', [1, 0]],
    ['plus', [0xffffffff, 2]],
    ['item', [0xffffffff]],
  ] as const) {
    const fn = p.byName.get(name);
    assert.ok(fn);
    try {
      cases.push({ functionName: name, args: [...args], expected: run(fn, [...args]) });
    } catch (error) {
      assert.ok(error instanceof A0Error);
      cases.push({
        functionName: name,
        args: [...args],
        expected: 0,
        expectedTrap: formatDiagnostic(error),
      });
    }
  }
  assert.equal(cases.filter((c) => c.expectedTrap !== undefined).length, 4);
  for (const optimize of [false, true]) {
    // Runtime storage is private. The driver must only depend on the documented trap hook.
    const source = compile(p, 'c', { optimize }).text.replaceAll(
      'a0_trapbuf',
      'A0_private_message',
    );
    for (const { tool, cpp } of tools()) {
      if (tool.path === undefined) {
        t.diagnostic(`${tool.name}: unavailable`);
        continue;
      }
      const result = await checkNative(p, cases, tool, cpp, 'strict trap hook recovery', source);
      assert.equal(result.status, 'passed', JSON.stringify(result));
      assert.equal(result.cases, cases.length);
    }
  }
});
