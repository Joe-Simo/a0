import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatTrap, makeIo, parseAndValidate, run } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { assembleX86_64Text } from '../src/x86_64enc.js';
import type { Case } from '../tools/corpus.js';
import { checkX86_64 } from '../tools/verify.js';

const names = ['dec', 'cpy', 'trap', 'ts', 'tb', 'la0r_trap', 'r_dec'];
const body = names
  .map(
    (name) =>
      `fn ${name} u32 -> u32\na arr 11 22\nv get a p0\nret v\nend\nfn step_${name} u32 u32 -> u32\nv call ${name} p1\nr add p0 v\nret r\nend\nfn fold_${name} u32 -> u32\nr fold step_${name} p0 0\nret r\nend`,
  )
  .join('\n');

test('native runtime symbols preserve public names, nested calls and exact strict traps', async (t) => {
  const clang = findClang();
  for (const strict of [false, true]) {
    const p = parseAndValidate(`${strict ? 'profile strict\n' : ''}${body}`);
    const cases: Case[] = [];
    for (const name of names.flatMap((n) => [n, `fold_${n}`])) {
      const fn = p.byName.get(name);
      assert.ok(fn);
      for (const x of [0, 1, 2, 3, 7]) {
        try {
          cases.push({ functionName: name, args: [x], expected: run(fn, [x]) });
        } catch (e) {
          assert.ok(e instanceof A0Error && e.trap !== undefined);
          cases.push({
            functionName: name,
            args: [x],
            expected: 0,
            expectedTrap: formatTrap(e.trap),
          });
        }
      }
    }
    const r = await checkX86_64(p, cases, clang);
    if (r.status === 'blocked') return t.skip(r.detail);
    assert.equal(r.status, 'passed', JSON.stringify(r));
    assert.equal(r.cases, cases.length);
  }
});

test('native runtime private reporter handles strict input traps beside a public trap function', async (t) => {
  const p = parseAndValidate('profile strict\nfn trap io -> u32\na read p0\nr at a 0\nret r\nend');
  const fn = p.byName.get('trap');
  assert.ok(fn);
  const cases: Case[] = [];
  for (const input of [[], [0], [0xffffffff]]) {
    try {
      cases.push({
        functionName: 'trap',
        args: [],
        input,
        expected: run(fn, [makeIo(input)]),
      });
    } catch (e) {
      assert.ok(e instanceof A0Error && e.trap !== undefined);
      cases.push({
        functionName: 'trap',
        args: [],
        input,
        expected: 0,
        expectedTrap: formatTrap(e.trap),
      });
    }
  }
  const r = await checkX86_64(p, cases, findClang());
  if (r.status === 'blocked') return t.skip(r.detail);
  assert.equal(r.status, 'passed', JSON.stringify(r));
});

test('native trap code and data use local labels on ELF and both Mach-O architectures', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) return t.skip('clang unavailable');
  const p = parseAndValidate(`profile strict\n${body}`);
  await withTempDir(async (dir) => {
    for (const [target, triple, platform] of [
      ['x86_64', 'x86_64-linux-gnu', 'linux'],
      ['x86_64', 'x86_64-apple-macos12', 'darwin'],
      ['arm64', 'arm64-apple-macos12', 'darwin'],
    ] as const) {
      const asm = compile(p, target, { x86Platform: platform }).text;
      const stem = join(dir, triple);
      const prefix = platform === 'linux' ? '.L' : 'L';
      for (const name of ['dec', 'cpy', 'trap', 'ts', 'tb'])
        assert.ok(asm.includes(`${prefix}a0r_${name}`));
      for (const name of names)
        assert.ok(asm.includes(`\t.globl ${platform === 'darwin' ? '_' : ''}a0_${name}\n`));
      if (target === 'x86_64') assert.ok(assembleX86_64Text(asm).bytes.length > 0);
      await writeFile(`${stem}.s`, asm);
      const r = runTool(clang.path as string, [
        `--target=${triple}`,
        '-c',
        `${stem}.s`,
        '-o',
        `${stem}.o`,
      ]);
      assert.ok(r.ok, `${triple}: ${r.stderr}`);
      assert.ok((await readFile(`${stem}.o`)).length > 0);
    }
  });
});
