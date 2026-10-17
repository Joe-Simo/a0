import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseAndValidate, withoutProfile } from '../../../dist/src/core.js';
import { runTool } from '../../../dist/src/toolchain.js';
import { directedFixtures } from '../../../dist/test/fixtures/sv-emitter/cases.js';
import {
  generateCases,
  generateCorpus,
  isDriverCallable,
  oracleRun,
  oracleToValue,
} from '../../../dist/tools/corpus.js';
import { cDriver } from '../../../dist/tools/verify.js';
import { nativeEmit } from './transport.mjs';

let level = 0;
const emit = (
  p,
  incap = 256,
  outcap = 1024,
  flags = 0,
  budget = 50000000,
  maxout = 50000000,
  metal = false,
) => nativeEmit(p, level, incap, outcap, flags, budget, maxout, metal);
function bounded(p) {
  return p.functions
    .filter(isDriverCallable)
    .filter((f) => !f.params.includes('io'))
    .flatMap((f) =>
      [0, 1, 7, 31].map((x) => {
        const args = f.params.map((t) => (t === 'bool' ? !!(x & 1) : x));
        return { functionName: f.name, args, expected: oracleToValue(oracleRun(f, args)) };
      }),
    );
}
const root = process.argv[2];
const clang = { path: process.argv[3] };
assert.ok(root && clang.path);
const work = `${root}/build/semantic-c`;
mkdirSync(work, { recursive: true });
const results = [];
function check(name, p) {
  const plain = withoutProfile(p),
    cases = name.startsWith('corpus-') ? generateCases(plain, 42, 12) : bounded(plain);
  const incap = Math.max(256, ...cases.map((c) => c.input?.length ?? 0)),
    outcap = Math.max(1024, ...cases.map((c) => c.expectedOutput?.length ?? 0));
  const r = emit(p, incap, outcap);
  if (r.code) {
    results.push({ level, name, status: r.code });
    assert.ok(p.profile === 'strict' && r.code === 9, name);
    return;
  }
  writeFileSync(`${work}/module.c`, r.text);
  writeFileSync(`${work}/target.c`, cDriver(plain));
  const built = runTool(
    clang.path,
    [
      '-std=c11',
      `-O${level}`,
      '-Wall',
      '-Wextra',
      '-Wno-unused-parameter',
      '-Werror',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      `${work}/target.c`,
      '-o',
      `${work}/target`,
    ],
    { timeoutMs: 120000 },
  );
  assert.ok(built.ok, `${name} ${built.stderr}`);
  const fmt = (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  const input =
    cases
      .map((c) =>
        [
          plain.functions.findIndex((f) => f.name === c.functionName),
          ...c.args.map(fmt),
          ...(c.input ? [c.input.length, ...c.input] : []),
        ].join(' '),
      )
      .join(`
`) +
    `
`;
  const run = runTool(`${work}/target`, [], { input, timeoutMs: 120000 });
  assert.ok(run.ok, name + run.stderr);
  const actual = run.stdout.trim().split(`
`);
  if (cases.length) {
    assert.equal(actual.length, cases.length, name);
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      assert.equal(
        actual[i],
        [fmt(c.expected), ...(c.expectedOutput ?? [])].join(' '),
        `${name} ${c.functionName}`,
      );
    }
  }
  results.push({ level, name, status: 0, sourceBytes: r.text.length, cases: cases.length });
}
for (level of [0, 2]) {
  for (const [name, source, _code] of directedFixtures()) check(name, parseAndValidate(source));
  for (const seed of [1, 42, 305419896, 4294967295]) check(`corpus-${seed}`, generateCorpus(seed));
}
writeFileSync(
  `${root}/native-check.json`,
  JSON.stringify({ results }, null, 2) +
    `
`,
);
console.log({ passed: results.length, cases: results.reduce((n, r) => n + (r.cases ?? 0), 0) });
