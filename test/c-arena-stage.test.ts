import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { LIMITS } from '../src/core.js';
import { runTool } from '../src/toolchain.js';
import {
  type BootstrappedCStage,
  bootstrapCStage,
  C_STAGE_RESOURCES,
  cStageCompilerFlags,
  findCStageCompiler,
  reproduceCStage,
  runCStage,
} from '../tools/c-arena-stage.js';

const clang = findCStageCompiler();
const skip = clang.path === undefined ? 'C compiler unavailable' : false;
const artifactRoot = process.env.A0_C_STAGE_ARTIFACTS;
let scratch: string | undefined;
let prepared: Promise<BootstrappedCStage & { dir: string }> | undefined;
after(async () => {
  if (scratch && !artifactRoot) await rm(scratch, { recursive: true, force: true });
});
function prepare(): Promise<BootstrappedCStage & { dir: string }> {
  prepared ??= (async () => {
    if (artifactRoot) await mkdir(artifactRoot, { recursive: true });
    const dir = await mkdtemp(join(artifactRoot ?? tmpdir(), 'a0-c-arena-stage-'));
    scratch = dir;
    const built = await bootstrapCStage(dir, clang);
    return { ...built, dir };
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
    assert.equal(ran.status, code, `${input}\n${ran.stderr}`);
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
        ...cStageCompilerFlags({}, clang).filter((flag) => !['-O2', '-municode'].includes(flag)),
        level,
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
  const atLimit = small.padEnd(LIMITS.maxSourceBytes, ' ');
  await compile(atLimit);
  await compile(`${atLimit} `, 6);
});

test('C arena stage reproduces the frozen original input through stages 2, 3 and 4', {
  skip,
  timeout: 900_000,
}, async () => {
  const initial = await prepare();
  await reproduceCStage(join(initial.dir, 'reproduction'), initial);
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
      ...cStageCompilerFlags({}, clang),
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

test('C arena stage host preserves native paths, atomic replacement and worker lifetime', {
  skip,
  timeout: 120_000,
}, async () => {
  assert.ok(clang.path);
  if (artifactRoot) await mkdir(artifactRoot, { recursive: true });
  const dir = await mkdtemp(join(artifactRoot ?? tmpdir(), 'a0-stage-host-'));
  try {
    const fixture = resolve('test/fixtures/c-arena-stage'),
      runtime = resolve('tools/native'),
      exe = join(dir, process.platform === 'win32' ? 'host.exe' : 'host');
    await copyFile(join(fixture, 'host_module.c'), join(dir, 'module.c'));
    const built = runTool(clang.path, [
      ...cStageCompilerFlags({}, clang),
      '-I',
      dir,
      '-I',
      runtime,
      join(fixture, 'host_driver.c'),
      join(runtime, 'arena_runtime.c'),
      '-o',
      exe,
    ]);
    assert.ok(built.ok, built.stderr);
    const source = join(dir, 'source 漢字 😀.a0'),
      output = join(dir, 'result café λ.c'),
      marker = 'existing artifact\r\n';
    const originalSource = Buffer.concat([
      Buffer.from('opaque source bytes'),
      Buffer.from([0, 13, 10, 26, 255]),
    ]);
    await writeFile(source, originalSource);
    const run = (fault = '') =>
      spawnSync(exe, [source, output, ...Object.values(C_STAGE_RESOURCES).map(String)], {
        encoding: 'utf8',
        env: { ...process.env, A0_STAGE_HOST_FAULT: fault },
      });
    for (const existing of [false, true]) {
      if (existing) await writeFile(output, marker);
      const ran = run();
      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(await readFile(output), originalSource);
    }
    for (const [fault, code] of [
      ['create', 66],
      ['join', 66],
      ['temporary', 69],
      ['write', 69],
      ['flush', 69],
      ['commit', 69],
      ['close', 69],
      ['replace', 69],
    ] as const) {
      await writeFile(output, marker);
      const ran = run(fault);
      assert.equal(ran.status, code, `${fault}: ${ran.stderr}`);
      assert.equal(await readFile(output, 'utf8'), marker, `${fault}: preserve prior bytes`);
      assert.deepEqual(
        (await readdir(dir)).filter((name) => name.includes('.tmp.')),
        [],
        fault,
      );
    }
    if (cStageCompilerFlags({}, clang).includes('-municode')) {
      await writeFile(output, marker);
      const locked = run('locked');
      assert.equal(locked.status, 69, locked.stderr);
      assert.equal(
        await readFile(output, 'utf8'),
        marker,
        'Windows locked replacement preserves bytes',
      );
      const collided = run('collision');
      assert.equal(collided.status, 0, collided.stderr);
      assert.deepEqual(await readFile(output), originalSource);
      const collisions = (await readdir(dir)).filter((name) => name.includes('.tmp.'));
      assert.equal(
        collisions.length,
        1,
        "exclusive creation leaves another owner's file untouched",
      );
      assert.equal(await readFile(join(dir, collisions[0] as string), 'utf8'), 'keep');
      await rm(join(dir, collisions[0] as string));
    }
    await rm(output);
    await mkdir(output);
    const refused = run();
    assert.equal(refused.status, 69, refused.stderr);
    assert.deepEqual(
      await readdir(output),
      [],
      'replacement failure preserves destination directory',
    );
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.includes('.tmp.')),
      [],
    );
    assert.deepEqual(await readFile(source), originalSource);
  } finally {
    if (!artifactRoot) await rm(dir, { recursive: true, force: true });
  }
});
