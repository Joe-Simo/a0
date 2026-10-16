import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findClang, runTool } from '../src/toolchain.js';
import { CHECKED_SOURCE } from './fixtures/checked-ops-fixtures.js';
import { CSHARP_ABI_SOURCE, csharpOracleDriver } from './fixtures/selfhost-csharp-fixtures.js';
import { findDotnet } from './helpers/native-dotnet.js';
import {
  buildNativeSourceCompiler,
  buildVerifiedNativeSeed,
  type NativeSourceCompiler,
  SOURCE_COMPLETION_TAG,
  SOURCE_FRONTEND_CAPACITY,
} from './helpers/native-source-compiler.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const dotnet = findDotnet();
let scratch: string | undefined;
let prepared: Promise<{ dir: string; compiler: NativeSourceCompiler }> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});
function prepare() {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-source-csharp-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    const compiler = await buildNativeSourceCompiler({
      module: 'compiler/emit_csharp.a0',
      entry: 'emitcsharpio',
      dir,
      seed,
    });
    return { dir, compiler };
  })();
  return prepared;
}

// This case remains enabled without .NET, so missing target tools do not hide compiler regressions.
test('seed-built A0 C# emitter generates independent checked and public ABI fixtures', {
  skip,
}, async () => {
  const { compiler } = await prepare();
  const emitted = compiler.runSource(CHECKED_SOURCE + CSHARP_ABI_SOURCE);
  assert.equal(emitted.code, 0, emitted.stderr);
  assert.equal(emitted.stderr, '');
  for (const text of [
    'public static class A0Module',
    'public readonly record struct R_r2_u_b',
    'public static uint @class',
    'unchecked {',
    'return r with { f0 = v }',
    '__a0_mod(i, 3u)',
    '__a0_div(p0, 0u)',
    '__a0_rem(p0, 0u)',
  ])
    assert.ok(emitted.text.includes(text), text);
  assert.doesNotMatch(emitted.text, /Integer\.|\bboolean\b|\.clone\(|\.f\d+\(\)/);
  const driver = csharpOracleDriver();
  assert.equal(driver.checked, 2356);
  assert.equal(driver.abi, 10);
  assert.equal((driver.source.match(/ {4}Check\(/g) ?? []).length, 2366);
});

test('seed-built A0 C# source entry rejects bad framing and unsupported modes atomically', {
  skip,
}, async () => {
  const { compiler } = await prepare();
  const source = 'fn f -> u32\nret 7\nend\n';
  const bytes = Array.from(Buffer.from(source));
  const exact = source.padEnd(SOURCE_FRONTEND_CAPACITY, ' ');
  assert.equal(compiler.runSource(exact).code, 0);
  for (const [words, code] of [
    [[SOURCE_FRONTEND_CAPACITY + 1, SOURCE_COMPLETION_TAG], 4],
    [[source.length, ...bytes], 2],
    [[source.length + 1, ...bytes, SOURCE_COMPLETION_TAG], 2],
    [[source.length, ...bytes, 0], 2],
  ] as const) {
    const refused = compiler.runWords(words);
    assert.equal(refused.code, code);
    assert.equal(refused.text, '');
    assert.equal(refused.stderr, '');
  }
  for (const [text, code] of [
    [`${exact} `, 4],
    [`profile strict\n${source}`, 2],
    ['fn f -> u32\nret true\nend\n', 3],
    ...['01', '4294967296', '42949672960', '18446744073709551616'].map(
      (literal) => [`fn f -> u32\nret ${literal}\nend\n`, 1] as const,
    ),
    ...['u32x01', 'u32x4294967297'].map(
      (type) => [`fn f ${type} -> u32\nret 0\nend\n`, 1] as const,
    ),
  ] as const) {
    const refused = compiler.runSource(text);
    assert.equal(refused.code, code);
    assert.equal(refused.text, '');
  }
  assert.equal(compiler.runRaw(Buffer.from([1, 2, 3])).code, 64);
});

test('seed-built A0 C# output passes independent arithmetic and ABI cases on .NET', {
  skip: skip || (dotnet.path === undefined ? '.NET SDK is unavailable' : false),
}, async () => {
  const { compiler, dir } = await prepare();
  assert.ok(dotnet.path && dotnet.version);
  const major = Number.parseInt(dotnet.version, 10);
  assert.ok(major >= 6, 'C# record structs require .NET SDK6+');
  const emitted = compiler.runSource(CHECKED_SOURCE + CSHARP_ABI_SOURCE);
  assert.equal(emitted.code, 0, emitted.stderr);
  const work = join(dir, 'dotnet');
  const localFeed = join(work, 'empty-feed');
  await mkdir(localFeed, { recursive: true });
  await writeFile(join(work, 'A0Module.cs'), emitted.text);
  const driver = csharpOracleDriver();
  await writeFile(join(work, 'Driver.cs'), driver.source);
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
  // Framework reference packs supplied by the existing SDK only. No network feed or install.
  const restore = runTool(dotnet.path, ['restore', 'Driver.csproj', '--source', localFeed], {
    cwd: work,
  });
  assert.ok(restore.ok, restore.stderr);
  const built = runTool(dotnet.path, ['build', 'Driver.csproj', '--no-restore', '-c', 'Release'], {
    cwd: work,
  });
  assert.ok(built.ok, `${built.stdout}\n${built.stderr}`);
  const ran = runTool(dotnet.path, [join(work, 'bin', 'Release', `net${major}.0`, 'Driver.dll')], {
    cwd: work,
  });
  assert.ok(ran.ok, ran.stderr);
  assert.equal(Number(ran.stdout.trim()), driver.checked + driver.abi);
});
