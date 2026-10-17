import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { findDotnet } from './helpers/native-dotnet.js';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const dotnet = findDotnet();
const fixtures = resolve('test/fixtures/arena-csharp');
let scratch: string | undefined;
let prepared: Promise<{ dir: string; exe: string }> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare() {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-csharp-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    assert.ok(seed.clang.path);
    const linked = await link('compiler/csharp_service_arena.a0', (path) => readFile(path, 'utf8'));
    const emitted = emitChunked(formatProgram(linked.program), (chunk, bounds) =>
      runStageChunk(seed.exe, chunk, bounds),
    );
    assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const result = (name: string): string => {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      return type;
    };
    const context = /a0_acs_emit\([^,]*p0, (a0t\d+) p1/.exec(emitted.text)?.[1];
    assert.ok(context);
    await writeFile(
      join(dir, 'api.h'),
      [
        `#define CS_STATE ${result('arena_csharp_source_begin')}`,
        `#define CS_STATUSIO ${result('arena_csharp_source_publish')}`,
        `#define CS_WRITER ${result('acs_emit')}`,
        `#define CS_CTX ${context}`,
        '',
      ].join('\n'),
    );
    const exe = join(dir, process.platform === 'win32' ? 'csharp-source.exe' : 'csharp-source');
    const runtime = resolve('tools/native');
    const built = runTool(
      seed.clang.path,
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Wno-unused-parameter',
        '-Werror',
        '-fsanitize=undefined',
        '-fno-sanitize-recover=all',
        '-pthread',
        '-I',
        dir,
        '-I',
        runtime,
        join(fixtures, 'driver.c'),
        join(runtime, 'arena_runtime.c'),
        '-o',
        exe,
      ],
      { cwd: dir, timeoutMs: 180_000 },
    );
    assert.ok(built.ok, built.stderr);
    // Always generate both target programs with Clang, independently of SDK availability.
    const generated = runTool(
      process.execPath,
      [join(fixtures, 'oracle.mjs'), exe, 'prepare', dir],
      {
        timeoutMs: 180_000,
      },
    );
    assert.ok(generated.ok, `${generated.stdout}\n${generated.stderr}`);
    return { dir, exe };
  })();
  return prepared;
}

async function compare(group: string) {
  const { dir, exe } = await prepare();
  const ran = runTool(process.execPath, [join(fixtures, 'oracle.mjs'), exe, group, dir], {
    timeoutMs: 180_000,
  });
  assert.ok(ran.ok, `${ran.stdout}\n${ran.stderr}`);
}

test(
  'seed-built arena C# service preserves source/spec ordering, checked/strict generation and atomic failures',
  { skip },
  async () => compare('core'),
);
test(
  'seed-built arena C# service preserves full-width source, functions, nodes, arguments and type names',
  { skip },
  async () => compare('boundaries'),
);
test('seed-built arena C# canonical and strict programs pass independent .NET runtime and ABI cases', {
  skip: skip || (dotnet.path === undefined ? '.NET SDK is unavailable' : false),
}, async () => {
  const { dir } = await prepare();
  assert.ok(dotnet.path && dotnet.version);
  const major = Number.parseInt(dotnet.version, 10);
  assert.ok(major >= 6, 'C# record structs require .NET SDK6+');
  for (const profile of ['canonical', 'strict']) {
    const work = join(dir, 'target', profile);
    const feed = join(work, 'empty-feed');
    await mkdir(feed, { recursive: true });
    await writeFile(
      join(work, 'Driver.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net${major}.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <CheckForOverflowUnderflow>true</CheckForOverflowUnderflow>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
`,
    );
    const restored = runTool(dotnet.path, ['restore', 'Driver.csproj', '--source', feed], {
      cwd: work,
    });
    assert.ok(restored.ok, restored.stderr);
    const built = runTool(
      dotnet.path,
      ['build', 'Driver.csproj', '--no-restore', '-c', 'Release'],
      { cwd: work },
    );
    assert.ok(built.ok, `${built.stdout}\n${built.stderr}`);
    const ran = runTool(
      dotnet.path,
      [join(work, 'bin', 'Release', `net${major}.0`, 'Driver.dll')],
      { cwd: work },
    );
    assert.ok(ran.ok, ran.stderr);
    assert.equal(
      Number(ran.stdout.trim()),
      Number(await readFile(join(work, 'expected.txt'), 'utf8')),
    );
  }
});
