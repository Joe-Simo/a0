/** Assemble verified build outputs for checkout-free native language services. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/backends.js';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import {
  loadNativeSourcePackage,
  SOURCE_PACKAGE_FILES,
  type SourcePackageComponent,
  type SourcePackageManifest,
} from '../src/source-native-package.js';
import { COMPILER_VERSION } from '../src/targets.js';
import { committedTree } from './measurement-checkout.js';
import { writeReport } from './scrub-results.js';
import { verifyCSourceCostBuild } from './source-cost-artifact.js';
import type { SourceCostBuild } from './source-cost-control.js';
import { prepareSourceDiagnostic, prepareSourceFormat } from './source-native-load.js';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Build-time freshness checks reuse the existing compiler and companion provenance guards.
 * The compact runtime manifest binds each complete build record without shipping local paths. */
export async function packageNativeSource(options: {
  readonly frontend: string;
  readonly format: string;
  readonly diagnostic: string;
  readonly out: string;
}): Promise<{ readonly manifestSHA256: string; readonly artifactBytes: number }> {
  const source = committedTree(process.cwd());
  const directories = [options.frontend, options.format, options.diagnostic].map((path) =>
    resolve(path),
  );
  const records = await Promise.all(
    directories.map(async (directory) => {
      const bytes = await readFile(join(directory, 'build.json'));
      return { bytes, build: JSON.parse(bytes.toString('utf8')) };
    }),
  );
  const frontend = records[0];
  const formatting = records[1];
  const diagnostic = records[2];
  assert.ok(frontend && formatting && diagnostic);
  assert.equal(frontend.build.frontendABI, 3);
  assert.equal(frontend.build.diagnosticPorts, 'arena-v1');
  await verifyCSourceCostBuild(
    process.cwd(),
    frontend.build as SourceCostBuild,
    { link, formatProgram, compile, version: COMPILER_VERSION },
    true,
  );
  const format = await prepareSourceFormat(options.format);
  const diagnostics = await prepareSourceDiagnostic(options.diagnostic);
  assert.deepEqual(format.build, formatting.build, 'formatter build changed during packaging');
  assert.deepEqual(
    diagnostics.build,
    diagnostic.build,
    'diagnostic build changed during packaging',
  );
  assert.equal(format.build.capability, 'arena-format-v2');
  assert.deepEqual(format.build.formatScopes, ['function', 'program', 'source', 'signature']);
  assert.equal(diagnostics.build.verificationWords, 768);
  const components = {} as Record<(typeof SOURCE_PACKAGE_FILES)[number], SourcePackageComponent>;
  const snapshots = await Promise.all(
    SOURCE_PACKAGE_FILES.map(async (file, index) => {
      const record = records[index];
      const directory = directories[index];
      assert.ok(record && directory);
      const bytes = await readFile(join(directory, file));
      assert.equal(hash(bytes), record.build.wasmSHA256, `${file} changed during packaging`);
      assert.equal(bytes.length, record.build.wasmBytes);
      components[file] = {
        bytes: bytes.length,
        sha256: record.build.wasmSHA256,
        buildSHA256: hash(record.bytes),
        sourceSHA256: record.build.sourceSHA256,
      };
      return bytes;
    }),
  );
  const manifest: SourcePackageManifest = {
    schema: 1,
    compilerVersion: COMPILER_VERSION,
    frontendABI: 3,
    formatCapability: 'arena-format-v2',
    diagnosticCapability: 'arena-v1',
    verificationWords: 768,
    components,
  };
  // No source files are read after this barrier; staging and the runtime smoke use only
  // retained bytes. Check before creating output so our own files do not dirty the checkout.
  assert.deepEqual(committedTree(process.cwd()), source, 'source changed during packaging');
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  const stage = await mkdtemp(join(dirname(out), '.a0-source-package-'));
  try {
    await writeReport(join(stage, 'manifest.json'), manifest);
    const manifestBytes = await readFile(join(stage, 'manifest.json'));
    const manifestSHA256 = hash(manifestBytes);
    const artifact = await loadNativeSourcePackage(manifestBytes, manifestSHA256, async (file) => {
      const bytes = snapshots[SOURCE_PACKAGE_FILES.indexOf(file)];
      assert.ok(bytes);
      return bytes;
    });
    const engine = artifact.instantiate();
    try {
      const parsed = engine.parse('fn identity\nret A\nend\n');
      assert.ok(parsed.ok, 'packaged frontend must parse and check');
      assert.ok(engine.format(parsed).ok, 'packaged formatter must share the live arena');
      const failure = engine.parse('fn invalid\nx missing A\nret x\nend\n');
      assert.ok(!failure.ok && failure.diagnostic?.rendered.ok, 'packaged diagnostic must render');
    } finally {
      engine.close();
    }
    for (const [index, file] of SOURCE_PACKAGE_FILES.entries())
      await writeFile(join(stage, file), snapshots[index] as Uint8Array);
    await rename(stage, out);
    return { manifestSHA256, artifactBytes: artifact.artifactBytes };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const names = ['frontend', 'format', 'diagnostic', 'out'] as const;
  assert.equal(args.length, names.length, '--frontend=DIR --format=DIR --diagnostic=DIR --out=DIR');
  const values = Object.fromEntries(
    names.map((name) => {
      const matches = args.filter((arg) => arg.startsWith(`--${name}=`));
      assert.equal(matches.length, 1, `--${name}=DIR required once`);
      const value = matches[0]?.slice(name.length + 3);
      assert.ok(value, `--${name}=DIR required`);
      return [name, value];
    }),
  ) as Record<(typeof names)[number], string>;
  console.log(JSON.stringify(await packageNativeSource(values)));
}
