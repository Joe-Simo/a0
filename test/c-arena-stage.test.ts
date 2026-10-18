import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { findClang, runTool } from '../src/toolchain.js';
import { bootstrapCStage, C_STAGE_RESOURCES, runCStage } from '../tools/c-arena-stage.js';

const clang = findClang();
const skip =
  clang.path === undefined
    ? 'clang unavailable'
    : process.platform === 'win32'
      ? 'POSIX stage'
      : false;
let scratch: string | undefined;
let prepared: Promise<{ exe: string; dir: string }> | undefined;
after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
function prepare(): Promise<{ exe: string; dir: string }> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-c-arena-stage-'));
    scratch = dir;
    const built = await bootstrapCStage(dir, clang);
    return { exe: built.exe, dir };
  })();
  return prepared;
}

test('C arena stage preserves source/spec/strict/IO semantics and atomic refusal', {
  skip,
  timeout: 900_000,
}, async () => {
  const { exe, dir } = await prepare();
  let ordinal = 0;
  const compile = async (source: string, code = 0, resources = {}) => {
    const base = join(dir, `case${ordinal++}`),
      input = `${base}.a0`,
      output = `${base}.c`;
    await writeFile(input, source);
    await writeFile(output, 'keep prior artifact\n');
    const ran = runCStage(exe, input, output, { ...C_STAGE_RESOURCES, ...resources });
    assert.equal(ran.status, code, `${source}\n${ran.stderr}`);
    assert.equal(await readFile(input, 'utf8'), source, 'immutable original bytes');
    const bytes = await readFile(output, 'utf8');
    if (code)
      assert.equal(bytes, 'keep prior artifact\n', 'failed stage leaves destination unchanged');
    return { input, output, bytes };
  };
  const target = async (module: string, body: string, prefix = '') => {
    assert.ok(clang.path);
    const base = join(dir, `target${ordinal++}`);
    await mkdir(base);
    await writeFile(join(base, 'module.c'), module);
    await writeFile(
      join(base, 'main.c'),
      `#include <assert.h>\n#include <stdint.h>\n#include <stdbool.h>\n${prefix}\n#include "module.c"\n${body}\n`,
    );
    for (const level of ['-O0', '-O2']) {
      const output = join(base, level.slice(1));
      const built = runTool(clang.path, [
        '-std=c11',
        level,
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-unused-parameter',
        '-fsanitize=undefined',
        '-fno-sanitize-recover=all',
        join(base, 'main.c'),
        '-o',
        output,
      ]);
      assert.ok(built.ok, built.stderr);
      const ran = runTool(output, []);
      assert.ok(ran.ok, ran.stderr);
    }
  };
  const small = 'fn probe u32 -> u32\nex 7 ->8\nx add p0 1\nret x\nend\n';
  const fast = await compile(small),
    slow = await compile(small, 0, { quantum: 1 });
  assert.equal(fast.bytes, slow.bytes, 'ordered pump quantum preserves emitted bytes');
  await target(
    fast.bytes,
    'int main(void) { assert(a0_probe(7u)==8u); assert(a0_probe(UINT32_MAX)==0u); }',
  );
  const flat = await compile(
    'fn twice\nret << A 1\nend\nfn probe\nx twice A\ny [x*3]\nz get y B\nret add z 4294967295\nend\n',
  );
  await target(
    flat.bytes,
    'int main(void) { assert(a0_probe(7u,2u)==13u); assert(a0_probe(UINT32_MAX,0u)==UINT32_MAX-2u); }',
  );
  const strict = await compile('profile strict\nfn half u32 -> u32\nret div p0 2\nend\n');
  await target(
    strict.bytes,
    'int main(void) { assert(a0_half(7u)==3u); assert(a0_half(UINT32_MAX)==2147483647u); }',
  );
  const io = await compile(
    await readFile(resolve('test/fixtures/arena-wasm/sources/io.a0'), 'utf8'),
  );
  await target(
    io.bytes,
    `int main(void) { struct a0_io t={0}; expected=&t; assert(a0_effect(&t)==UINT32_MAX-1u); const uint32_t want[]={UINT32_MAX-1u,0u,3u,65u,0u,255u}; assert(t.reads==2 && t.writes==6); for(unsigned i=0;i<6;i++) assert(t.output[i]==want[i]); }`,
    `struct a0_io { uint32_t reads,writes,output[6]; };\nstatic struct a0_io *expected;\nstatic bool input(struct a0_io *t,uint32_t *out) { assert(t==expected); *out=t->reads++ ? 2u : UINT32_MAX; return true; }\nstatic void output(struct a0_io *t,uint32_t value) { assert(t==expected && t->writes<6); t->output[t->writes++]=value; }\n#define A0_IO_READ(t,out) input((t),(out))\n#define A0_IO_WRITE(t,value) output((t),(value))`,
  );
  for (const [source, code, resources] of [
    [small, 4, { resumes: 0 }],
    [small, 4, { quantum: 0, resumes: 2 }],
    [small, 4, { arenaWords: Buffer.byteLength(small) }],
    [small, 4, { outputWords: 0 }],
    [small, 4, { outputWords: 128 }],
    [small, 12, { flags: 1 }],
    ['use "dependency.a0"\n', 7, {}],
    ['profile strict\nfn probe io -> (u32,io)\nr read p0\nret r\nend\n', 9, {}],
    ['fn bad -> u32\nx add\nret x\nend\n', 6, { flags: 1 }],
    ['fn bad u32 -> u32\nx add true p0\nret x\nend\n', 8, { flags: 1 }],
    ['fn bad u32 -> u32\nex 7 ->8\nret p0\nend\n', 8, { flags: 1 }],
    ['fn bad u32 -> u32\nex 7 ->8\nret p0\nend\nfn malformed\nx add\nret x\nend\n', 6, {}],
  ] as const)
    await compile(source, code, resources);
});

test('C arena stage refuses transport corruption and incomplete FINISH before publication', {
  skip,
  timeout: 900_000,
}, async () => {
  const { dir } = await prepare();
  assert.ok(clang.path);
  const runtime = resolve('tools/native'),
    exe = join(dir, 'fault-stage');
  const built = runTool(
    clang.path,
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-parameter',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      '-pthread',
      '-I',
      dir,
      '-I',
      runtime,
      join(runtime, 'c_arena_stage.c'),
      resolve('test/fixtures/c-arena-stage/fault_runtime.c'),
      '-o',
      exe,
    ],
    { timeoutMs: 240_000 },
  );
  assert.ok(built.ok, built.stderr);
  const source = join(dir, 'fault.a0'),
    output = join(dir, 'fault.c');
  await writeFile(source, 'fn probe\nret add A 1\nend\n');
  for (const [fault, code] of [
    ['load', 5],
    ['alloc', 4],
    ['finish', 65],
    ['nonbyte', 69],
  ] as const) {
    await writeFile(output, 'prior artifact\n');
    const ran = runTool(exe, [source, output, ...Object.values(C_STAGE_RESOURCES).map(String)], {
      env: { ...process.env, A0_STAGE_FAULT: fault },
      timeoutMs: 180_000,
    });
    assert.equal(ran.status, code, `${fault}: ${ran.stderr}`);
    assert.equal(await readFile(output, 'utf8'), 'prior artifact\n');
  }
});
