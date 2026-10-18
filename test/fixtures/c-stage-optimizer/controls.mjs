// Explicit internal experiment: compare two actual C-stage executables, then
// run verbatim emitted C against existing independent integer/grid models.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findClang, runTool } from '../../../dist/src/toolchain.js';
import { CHECKED_SOURCE, checkedCases } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import { C_STAGE_RESOURCES, runCStage } from '../../../dist/tools/c-arena-stage.js';
import { oracleOp } from '../../../dist/tools/corpus.js';
import { writeReport } from '../../../dist/tools/scrub-results.js';
import { board, model as lifeModel } from '../arena-source-c/life-model.mjs';
import { cases as specs } from '../arena-spec-verifier/cases.mjs';
import { CONTROLS, INPUTS } from '../arena-wasm/alias-models.mjs';

const [baseline, candidate, output] = process.argv.slice(2);
assert.ok(
  baseline && candidate && output,
  'baseline executable, candidate executable, artifact directory',
);
const root = resolve(output),
  clang = findClang();
assert.ok(clang.path);
await mkdir(root, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  status: 'running',
  scope:
    'Exact original-source/status/target-C parity; independent native behavior. The scalar façade exposes status classes, not structured diagnostic fields.',
  baselineSHA256: sha(await readFile(baseline)),
  candidateSHA256: sha(await readFile(candidate)),
  resources: C_STAGE_RESOURCES,
  specCasesOutsideThisRun: specs.filter((item) => item.heavy).map((item) => item.name),
  rows: [],
};
let ordinal = 0,
  targetOrdinal = 0;
const prior = Buffer.from('prior artifact\r\n');
async function compile(name, source, expected = 0, overrides = {}) {
  const stem = join(root, String(ordinal++).padStart(4, '0')),
    input = `${stem}.a0`,
    raw = Buffer.from(source),
    emitted = [];
  await writeFile(input, raw);
  const rows = [];
  for (const [label, exe] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ]) {
    const destination = `${stem}.${label}.c`;
    await writeFile(destination, prior);
    const ran = runCStage(exe, input, destination, { ...C_STAGE_RESOURCES, ...overrides });
    await writeFile(`${stem}.${label}.stderr.log`, ran.stderr);
    assert.equal(ran.status, expected, `${name} ${label}: ${ran.stderr}`);
    const bytes = await readFile(destination);
    if (expected) assert.ok(bytes.equals(prior), `${name}: refusal preserves old artifact`);
    emitted.push(bytes);
    rows.push({ label, status: ran.status, outputBytes: bytes.length, outputSHA256: sha(bytes) });
  }
  assert.ok(emitted[0].equals(emitted[1]), `${name}: verbatim outputs differ`);
  assert.ok(raw.equals(await readFile(input)), `${name}: original source changed`);
  report.rows.push({
    name,
    sourceBytes: raw.length,
    sourceSHA256: sha(raw),
    identical: true,
    rows,
  });
  return emitted[1];
}
async function target(name, module, main, prefix = '') {
  const stem = join(root, `target${targetOrdinal++}`);
  await writeFile(`${stem}.module.c`, module);
  await writeFile(
    `${stem}.c`,
    `#include <assert.h>\n#include <stdbool.h>\n#include <stdint.h>\n#include <string.h>\n${prefix}\n#include "${stem.split('/').at(-1)}.module.c"\n${main}\n`,
  );
  for (const level of ['O0', 'O2']) {
    const exe = `${stem}-${level}`;
    const built = runTool(
      clang.path,
      [
        '-std=c11',
        `-${level}`,
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-unused-parameter',
        '-fsanitize=undefined',
        '-fno-sanitize-recover=all',
        `${stem}.c`,
        '-o',
        exe,
      ],
      { timeoutMs: 180_000 },
    );
    await writeFile(`${stem}-${level}.build.log`, built.stderr);
    assert.ok(built.ok, `${name} ${level}: ${built.stderr}`);
    const ran = runTool(exe, []);
    assert.ok(ran.ok, `${name} ${level}: ${ran.stderr}`);
  }
  report.rows.push({ name, nativeBehavior: 'O0/O2 UBSan/Werror', status: 'passed' });
}
const scalarMain = (cases) =>
  `int main(void) {\n${cases.map(({ functionName, args, expected }) => `assert((uint32_t)a0_${functionName}(${args.map((v) => `${Number(v) >>> 0}u`).join(',')})==${Number(expected) >>> 0}u);`).join('\n')}\n}`;
try {
  for (const item of specs.filter((item) => !item.heavy))
    await compile(`spec/${item.name}`, item.nativeSource ?? item.source, item.status);
  for (const item of CONTROLS) {
    const module = await compile(`alias/${item.name}`, item.source),
      inputs = item.inputs ?? INPUTS;
    const calls = inputs.map((args) => {
      const expected = item.expected(args),
        call = `a0_probe(${args.map((v) => `${v}u`).join(',')})`;
      if (!Array.isArray(expected)) return `assert(${call}==${expected}u);`;
      const type = /^(a0t_[A-Za-z0-9_]+) a0_probe\(/m.exec(module.toString())?.[1];
      assert.ok(type, 'actual emitted aggregate return ABI');
      return `{ ${type} r=${call}; ${expected.map((v, i) => `assert(r.e[${i}]==${v}u);`).join(' ')} }`;
    });
    await target(`alias/${item.name}`, module, `int main(void) { ${calls.join('\n')} }`);
  }
  for (const strict of [false, true]) {
    const module = await compile(
      `checked strict=${strict}`,
      `${strict ? 'profile strict\n' : ''}${CHECKED_SOURCE}`,
    );
    await target(`checked strict=${strict}`, module, scalarMain(checkedCases()));
  }
  const ops = [
    'add',
    'sub',
    'mul',
    'and',
    'or',
    'xor',
    'shl',
    'shr',
    'div',
    'rem',
    'eq',
    'ne',
    'lt',
    'le',
    'gt',
    'ge',
  ];
  const arithmetic = await compile(
    'unsigned arithmetic',
    ops
      .map((op, i) => `fn f${i} u32 u32 -> ${i < 10 ? 'u32' : 'bool'}\nret ${op} p0 p1\nend\n`)
      .join(''),
  );
  const pairs = [
    ...INPUTS,
    [0, 0xffffffff],
    [0xffffffff, 0],
    [0x80000000, 31],
    [0x80000000, 32],
    [0x80000000, 33],
  ];
  await target(
    'independent BigInt arithmetic',
    arithmetic,
    scalarMain(
      ops.flatMap((op, i) =>
        pairs.map((args) => ({
          functionName: `f${i}`,
          args,
          expected: oracleOp(op, args.map(BigInt)),
        })),
      ),
    ),
  );
  await compile('whole kernels application', await readFile('examples/kernels.a0', 'utf8'));
  const io = await compile(
    'opaque host IO',
    await readFile('test/fixtures/arena-wasm/sources/io.a0', 'utf8'),
  );
  await target(
    'independent opaque token/EOF/effect order',
    io,
    'int main(void) { for(uint32_t n=0;n<3;n++) { struct a0_io t={0}; expected=&t; t.count=n; t.input[0]=UINT32_MAX; t.input[1]=2u; uint32_t v=a0_effect(&t); const uint32_t want[]={n==2?UINT32_MAX-1u:0u,n==2?0u:1u,3u,65u,0u,255u}; assert(v==want[0] && t.reads==2u && t.position==n && t.writes==6u); assert(memcmp(want,t.words,sizeof want)==0); } }',
    'struct a0_io { uint32_t input[2],count,position,reads,words[6],writes; };\nstatic struct a0_io *expected;\nstatic bool input(struct a0_io *t,uint32_t *out) { assert(t==expected);t->reads++;if(t->position==t->count) { *out=123u;return false; }*out=t->input[t->position++];return true;}\nstatic void output(struct a0_io *t,uint32_t word) { assert(t==expected && t->writes<6u);t->words[t->writes++]=word;}\n#define A0_IO_READ(t,out) input((t),(out))\n#define A0_IO_WRITE(t,word) output((t),(word))',
  );
  const life = await compile(
    'unchanged Life application',
    await readFile('examples/life.a0', 'utf8'),
  );
  const glider = [
    [1, 0],
    [2, 1],
    [0, 2],
    [1, 2],
    [2, 2],
  ];
  const lifeCases = [
    [board(glider), 0, 0, 0],
    [board(glider.map(([x, y]) => [x + 30, y + 30])), 0, 0xffffffff, 0xffffffff],
    [
      board([
        [31, 31],
        [0, 31],
        [1, 31],
      ]),
      0,
      7,
      13,
    ],
    [
      board([
        [31, 31],
        [0, 0],
      ]),
      1,
      0xffffffff,
      0xffffffff,
    ],
    [Array(32).fill(0xffffffff), 2, 0xffffffff, 0xffffffff],
  ];
  await target(
    'independent cell-grid Life behavior',
    life,
    `int main(void) { ${lifeCases
      .map(([rows, command, x, y]) => {
        const expected = lifeModel(rows, command, x, y);
        return `{ const uint32_t values[]={${[...rows, command, x, y].map((v) => `${v}u`).join(',')}}; const uint32_t want[]={${expected.rows.map((v) => `${v}u`).join(',')}}; struct a0_io t={0}; token=&t; memcpy(t.input,values,sizeof values); assert(a0_life(&t)==${expected.population}u); assert(t.reads==35u && t.position==35u && t.writes==32u); assert(memcmp(t.output,want,sizeof want)==0); }`;
      })
      .join('\n')} }`,
    'struct a0_io { uint32_t input[35],position,reads,output[32],writes; };\nstatic struct a0_io *token;\nstatic bool input(struct a0_io *t,uint32_t *out) { assert(t==token && t->position<35u); t->reads++;*out=t->input[t->position++];return true;}\nstatic void output(struct a0_io *t,uint32_t word) { assert(t==token && t->writes<32u);t->output[t->writes++]=word;}\n#define A0_IO_READ(t,out) input((t),(out))\n#define A0_IO_WRITE(t,word) output((t),(word))',
  );
  const small = 'fn probe\nret add A 1\nend\n';
  for (const [name, code, resources] of [
    ['zero resumes', 4, { resumes: 0 }],
    ['zero quantum', 4, { quantum: 0, resumes: 2 }],
    ['arena exhaustion', 4, { arenaWords: Buffer.byteLength(small) }],
    ['output exhaustion', 4, { outputWords: 0 }],
    ['unsupported flags', 12, { flags: 1 }],
  ])
    await compile(name, small, code, resources);
  await compile('imports require linked input', 'use "dependency.a0"\n', 7);
  await compile(
    'strict unsupported input operation',
    'profile strict\nfn probe io -> (u32,io)\nr read p0\nret r\nend\n',
    9,
  );
  const scheduled = specs.find((item) => item.name === 'matching-pre-post');
  assert.ok(scheduled);
  await compile('quantum one ordered specs', scheduled.source, 0, { quantum: 1 });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
}
assert.equal(sha(await readFile(baseline)), report.baselineSHA256, 'baseline executable immutable');
assert.equal(
  sha(await readFile(candidate)),
  report.candidateSHA256,
  'candidate executable immutable',
);
await writeReport(join(root, 'report.json'), report);
console.log(
  JSON.stringify({ status: report.status, rows: report.rows.length, error: report.error }),
);
process.exitCode = report.status === 'passed' ? 0 : 1;
