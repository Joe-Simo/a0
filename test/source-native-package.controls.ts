/** Real source-bound package: no checkout freshness helper runs in the shipped loader. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { run } from '../src/core.js';
import { loadNativeSourcePackage, SOURCE_PACKAGE_FILES } from '../src/source-native-package.js';
import { packageNativeSource } from '../tools/source-native-package.js';

const directory = process.env.A0_SOURCE_PACKAGE;
const expected = process.env.A0_SOURCE_PACKAGE_SHA256;
assert.ok(directory && expected, 'A0_SOURCE_PACKAGE and A0_SOURCE_PACKAGE_SHA256 required');
const manifest = await readFile(join(directory, 'manifest.json'));
const load = () =>
  loadNativeSourcePackage(manifest, expected, (name) => readFile(join(directory, name)));

test('package assembly rejects forged formatter source identity and incomplete dependency inventories', async () => {
  const frontend = process.env.A0_SOURCE_PACKAGE_FRONTEND;
  const format = process.env.A0_SOURCE_PACKAGE_FORMAT;
  const diagnostic = process.env.A0_SOURCE_PACKAGE_DIAGNOSTIC;
  assert.ok(frontend && format && diagnostic, 'fresh package build directories required');
  const scratch = await mkdtemp(join(tmpdir(), 'a0-package-provenance-'));
  try {
    const bad = join(scratch, 'format');
    await mkdir(bad);
    await cp(join(format, 'format.wasm'), join(bad, 'format.wasm'));
    const original = JSON.parse(await readFile(join(format, 'build.json'), 'utf8'));
    for (const [name, mutation, message] of [
      ['source', { sourceSHA256: '0'.repeat(64) }, /formatter source IR differs/],
      ['closure', { inputs: original.inputs.slice(1) }, /formatter input closure differs/],
    ] as const) {
      await writeFile(join(bad, 'build.json'), JSON.stringify({ ...original, ...mutation }));
      await assert.rejects(
        packageNativeSource({ frontend, format: bad, diagnostic, out: join(scratch, name) }),
        message,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('packaged parser, checker, formatter, revision and verified diagnostics share the same arena', async () => {
  const packaged = await load();
  assert.throws(() => (SOURCE_PACKAGE_FILES as unknown as string[]).reverse(), TypeError);
  const engine = packaged.instantiate();
  try {
    const parsed = engine.parse(
      '# owned Ω😀\nfn pair u32 -> (u32,bool)\nx add A 7\ny eq x 12\nz rec x y\nret z\nend\n',
    );
    assert.ok(parsed.ok);
    const pair = parsed.typed.byName.get('pair');
    assert.ok(pair);
    assert.deepEqual(run(pair, [5]), [12, true]);
    const formatted = engine.format(parsed);
    const revision = engine.revision(parsed);
    assert.ok(formatted.ok && revision.ok);
    assert.match(formatted.text, /# owned Ω😀/);
    const reparsed = engine.parse(formatted.text);
    assert.ok(reparsed.ok);
    const nextPair = reparsed.typed.byName.get('pair');
    assert.ok(nextPair);
    assert.deepEqual(run(nextPair, [5]), [12, true]);
    const nextRevision = engine.revision(reparsed);
    assert.ok(nextRevision.ok);
    assert.equal(nextRevision.revision, revision.revision);
    const bad = engine.parse('fn bad\nx absent A\nret x\nend\n');
    assert.ok(!bad.ok && bad.diagnostic?.rendered.ok);
    assert.equal(bad.diagnostic.rendered.error.id, 'A0102');
  } finally {
    engine.close();
  }
});

test('compiled package consumer executes from a directory containing only its assets and binary', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-package-runtime-'));
  try {
    const assets = join(scratch, 'assets');
    await mkdir(assets);
    for (const name of ['manifest.json', ...SOURCE_PACKAGE_FILES])
      await cp(join(directory, name), join(assets, name));
    const entry = join(scratch, 'entry.ts');
    await writeFile(
      entry,
      `import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadNativeSourcePackage} from ${JSON.stringify(resolve('dist/src/source-native-package.js'))};
const [directory,expected]=process.argv.slice(2);
const packageBytes=await readFile(join(directory,'manifest.json'));
const artifact=await loadNativeSourcePackage(packageBytes,expected,name=>readFile(join(directory,name)));
const engine=artifact.instantiate();
try {
 const value=engine.parse('fn standalone\\nret A\\nend\\n');
 if(!value.ok||!engine.format(value).ok||!engine.revision(value).ok)throw new Error('language service unavailable');
 const bad=engine.parse('fn bad\\nx absent A\\nret x\\nend\\n');
 if(bad.ok||!bad.diagnostic?.rendered.ok)throw new Error('diagnostic unavailable');
 console.log(JSON.stringify({functionName:value.program.functions[0].name,id:bad.diagnostic.rendered.error.id}));
}finally{engine.close();}
`,
    );
    const binary = join(scratch, process.platform === 'win32' ? 'a0-package.exe' : 'a0-package');
    const built = spawnSync('bun', ['build', '--compile', entry, '--outfile', binary], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(built.status, 0, built.stderr);
    await rm(entry);
    const child = spawnSync(binary, [assets, expected], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: '',
        A0_NATIVE_CHECK: '0',
        A0_SOURCE_PACKAGE: '',
        A0_SOURCE_PACKAGE_SHA256: '',
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { functionName: 'standalone', id: 'A0102' });
    await rm(join(assets, 'diagnostic.wasm'));
    const missing = spawnSync(binary, [assets, expected], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(missing.status, 0, 'missing required diagnostic asset must fail closed');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the same package loader bundles for browsers and runs without Node globals', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-package-browser-'));
  try {
    const output = join(scratch, 'browser.js');
    const entry = join(scratch, 'entry.js');
    await writeFile(
      entry,
      `import {loadNativeSourcePackage} from ${JSON.stringify(resolve('dist/src/source-native-package.js'))};\nglobalThis.A0SourcePackage={loadNativeSourcePackage};\n`,
    );
    const bundled = spawnSync(
      'bun',
      ['build', entry, '--target=browser', '--format=iife', '--outfile', output],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(bundled.status, 0, bundled.stderr);
    const browser = runInNewContext(
      `${await readFile(output, 'utf8')}\n({api:globalThis.A0SourcePackage,node:[typeof process,typeof Buffer,typeof require]})`,
      { WebAssembly, crypto, TextEncoder, TextDecoder },
      { timeout: 10_000 },
    ) as { api: { loadNativeSourcePackage: typeof loadNativeSourcePackage }; node: string[] };
    assert.equal(browser.node.join(','), 'undefined,undefined,undefined');
    const artifact = await browser.api.loadNativeSourcePackage(manifest, expected, (name) =>
      readFile(join(directory, name)),
    );
    const engine = artifact.instantiate();
    try {
      const parsed = engine.parse('fn browser\nret A\nend\n');
      assert.ok(parsed.ok && engine.format(parsed).ok && engine.revision(parsed).ok);
      const bad = engine.parse('fn bad\nx absent A\nret x\nend\n');
      assert.ok(!bad.ok && bad.diagnostic?.rendered.ok);
      assert.equal(bad.diagnostic.rendered.error.id, 'A0102');
    } finally {
      engine.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
