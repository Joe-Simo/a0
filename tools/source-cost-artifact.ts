/** Provenance checks shared by source-cost preparation and its independent regressions. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type * as Backends from '../src/backends.js';
import type * as Core from '../src/core.js';
import type * as Link from '../src/link.js';
import {
  type SourceCostBuild,
  sourceCostCFrontendOptions,
  sourceCostComponents,
  sourceCostFrontendOptions,
  sourceCostFunctionSignatures,
  sourceCostInputs,
  sourceCostModules,
} from './source-cost-control.js';

const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Compare physical files while retaining every recorded closure member, including duplicates. */
async function physicalPaths(paths: readonly string[]): Promise<string[]> {
  return Promise.all(paths.map((path) => realpath(path)));
}

/** Reuse the subject's existing builder to reproduce its complete native artifact and build proof. */
export async function rebuildCSourceCostBuild(
  checkout: string,
  record: SourceCostBuild,
  toolchain: { readonly sysroot: string; readonly builtins: string },
) {
  assert.equal(record.symbols, 'strip', 'strict native comparisons require symbols=strip');
  assert.ok(
    ['O2', 'O3', 'Os', 'Oz'].includes(record.optimization as string),
    'unsupported native optimization',
  );
  assert.ok(Array.isArray(record.requiredWasmFeatures), 'missing native feature record');
  const features = record.requiredWasmFeatures;
  assert.ok(
    features.length === 0 || (features.length === 1 && features[0] === 'bulk-memory'),
    'unsupported native features',
  );
  const scratch = join(checkout, '.a0-tmp');
  await mkdir(scratch, { recursive: true });
  const out = await mkdtemp(join(scratch, 'source-cost-rebuild-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(checkout, 'dist/tools/source-native-build.js'),
        `--out=${out}`,
        `--sysroot=${toolchain.sysroot}`,
        `--builtins=${toolchain.builtins}`,
        `--opt-level=${record.optimization}`,
        '--symbols=strip',
        `--wasm-features=${features.length === 0 ? 'mvp' : 'bulk-memory'}`,
        ...(record.diagnosticPorts === undefined
          ? []
          : [`--diagnostic-ports=${record.diagnosticPorts}`]),
      ],
      { cwd: checkout, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(
      result.status,
      0,
      `native rebuild failed: ${result.error ?? ''}\n${result.stderr}`,
    );
    const actual = await sourceCostArtifact(out);
    assert.deepEqual(actual.build, record, 'fresh native build record differs');
    assert.equal(
      hash(await readFile(join(out, 'module.c'))),
      record.cSHA256,
      'fresh native C differs',
    );
    return { cSHA256: record.cSHA256, ...actual.preload };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** Re-emit C with the subject's own freshly built compiler; strict codegen mode binds its inputs. */
export async function verifyCSourceCostBuild(
  checkout: string,
  record: SourceCostBuild,
  compiler: {
    readonly link: typeof Link.link;
    readonly formatProgram: typeof Core.formatProgram;
    readonly compile: typeof Backends.compile;
    readonly version: string;
  },
  compilerCodegen = false,
): Promise<void> {
  assert.equal(record.backend, undefined, 'unsupported frontend backend');
  const options = compilerCodegen ? sourceCostCFrontendOptions(record) : ({ cIo: 'host' } as const);
  if (compilerCodegen) {
    const { sourceCompilerInputs } = await import('./source-compiler-inputs.js');
    const actual = await sourceCompilerInputs(checkout);
    assert.equal(actual.checkout.dirty, false, 'compiler checkout is not clean');
    assert.deepEqual(record.compilerInputs, actual.inputs, 'compiler input inventory differs');
    assert.deepEqual(
      record.compilerConfiguration,
      actual.configuration,
      'compiler configuration differs',
    );
    assert.deepEqual(record.compilerBuild, actual.build, 'compiler build versions differ');
    assert.deepEqual(
      record.compilerCheckout,
      actual.checkout,
      'compiler checkout identity differs',
    );
    assert.equal(record.compilerVersion, compiler.version, 'compiler version differs');
  }
  const { verifyNativeInputs } = await import('./source-native-artifact.js');
  await verifyNativeInputs(checkout, record.nativeInputs as { path: string; sha256: string }[]);
  assert.equal(record.entry, 'compiler/source_frontend.a0');
  const linked = await compiler.link(join(checkout, record.entry), (path) =>
    readFile(path, 'utf8'),
  );
  if (Object.hasOwn(record, 'frontendFunctions')) {
    const { sourceFunctionSignatures } = await import('./source-compiler-inputs.js');
    const signatures = sourceCostFunctionSignatures(record);
    assert.deepEqual(
      record.frontendFunctions,
      sourceFunctionSignatures(
        linked.program,
        signatures.map((fn) => fn.name),
      ),
      'consumed A0 API signatures differ',
    );
  }
  assert.equal(
    linked.program.functions.length,
    record.functions,
    'artifact function count differs',
  );
  assert.equal(
    hash(compiler.formatProgram(linked.program)),
    record.sourceSHA256,
    'artifact source differs',
  );
  assert.equal(
    hash(compiler.compile(linked.program, 'c', options).text),
    record.cSHA256,
    'artifact C differs',
  );
  assert.deepEqual(
    (
      await physicalPaths(
        (record.modules as { path: string }[]).map((module) => resolve(checkout, module.path)),
      )
    ).sort(),
    (await physicalPaths(linked.sources.map((source) => source.path))).sort(),
    'artifact dependency closure differs',
  );
  assert.equal(
    hash(await readFile(join(checkout, 'tools/native/source_frontend.c'))),
    record.driverSHA256,
  );
  for (const module of record.modules as { path: string; sha256: string }[])
    assert.equal(
      hash(await readFile(join(checkout, module.path))),
      module.sha256,
      `stale module ${module.path}`,
    );
}

/** Hash every component; the ordered concatenation is the direct loader's artifact identity. */
export async function sourceCostArtifact(directory: string) {
  const buildText = await readFile(join(directory, 'build.json'), 'utf8');
  const build = JSON.parse(buildText) as SourceCostBuild;
  const components = sourceCostComponents(build);
  const bytes = await Promise.all(
    components.map(async (component) => {
      const bytes = await readFile(join(directory, component.file));
      assert.equal(hash(bytes), component.sha256, `${component.file} artifact differs`);
      assert.equal(bytes.length, component.bytes, `${component.file} size differs`);
      return bytes;
    }),
  );
  return {
    build,
    buildText,
    preload: {
      backend: build.backend ?? 'clang-wasm',
      components,
      componentCount: components.length,
      totalWasmBytes: bytes.reduce((sum, component) => sum + component.length, 0),
      artifactSha256: hash(Buffer.concat(bytes)),
    },
  };
}

/** Recompute the generic transport proof from the exact final binary, including every function. */
export function verifySourceCostStackProof(
  record: SourceCostBuild,
  arena: Uint8Array,
  analyze: (bytes: Uint8Array) => unknown,
): void {
  assert.equal(hash(arena), record.arenaSHA256, 'stack proof arena hash differs');
  assert.equal(arena.length, record.arenaBytes, 'stack proof arena size differs');
  const result = analyze(arena);
  assert.ok(result && typeof result === 'object', 'stack proof missing');
  const proof = result as Readonly<Record<string, unknown>>;
  assert.equal(proof.artifactSHA256, record.arenaSHA256, 'stack proof artifact differs');
  assert.equal(proof.artifactBytes, record.arenaBytes, 'stack proof artifact size differs');
  for (const field of ['imports', 'indirectCalls', 'unknownOpcodes'])
    assert.equal(proof[field], 0, `stack proof has ${field}`);
  assert.equal(proof.acyclic, true, 'stack proof is not acyclic');
  assert.ok(
    Array.isArray(proof.functions) && proof.functions.length > 0,
    'stack proof lacks function proofs',
  );
  assert.ok(
    typeof proof.maxLinearStackBytes === 'number' &&
      Number.isSafeInteger(proof.maxLinearStackBytes) &&
      proof.maxLinearStackBytes >= 0,
    'invalid stack proof bound',
  );
  assert.ok(
    typeof record.transportStackBytes === 'number' &&
      Number.isSafeInteger(record.transportStackBytes) &&
      record.transportStackBytes > 0,
    'missing transportStackBytes',
  );
  assert.ok(
    proof.maxLinearStackBytes <= record.transportStackBytes,
    'transport stack is below its proven bound',
  );
  assert.deepEqual(record.transportStackProof, proof, 'transport stack proof differs');
}

/** Verify the full direct compiler input inventory and reproduce the actual frontend Wasm. */
export async function verifyDirectSourceCostBuild(
  checkout: string,
  record: SourceCostBuild,
  compiler: {
    readonly link: typeof Link.link;
    readonly formatProgram: typeof Core.formatProgram;
    readonly compile: typeof Backends.compile;
  },
): Promise<void> {
  assert.equal(record.backend, 'direct-wasm');
  assert.equal(record.entry, 'compiler/source_frontend.a0');
  const options = sourceCostFrontendOptions(record);
  const linked = await compiler.link(join(checkout, record.entry), (path) =>
    readFile(path, 'utf8'),
  );
  assert.equal(
    linked.program.functions.length,
    record.functionCount,
    'artifact function count differs',
  );
  assert.equal(
    hash(compiler.formatProgram(linked.program)),
    record.sourceSHA256,
    'artifact source differs',
  );
  const modules = sourceCostModules(record);
  const sourcePaths = await physicalPaths(linked.sources.map((source) => source.path));
  assert.deepEqual(
    (await physicalPaths(modules.map((module) => resolve(checkout, module.path)))).sort(),
    [...sourcePaths].sort(),
    'artifact dependency closure differs',
  );
  const tracked = execFileSync('git', ['ls-files', 'src/*.ts'], {
    cwd: checkout,
    encoding: 'utf8',
  }).trim();
  const physicalCheckout = await realpath(checkout);
  const expected = [
    ...new Set([
      ...sourcePaths.map((path) => relative(physicalCheckout, path)),
      ...(tracked ? tracked.split('\n') : []),
      'tools/native/arena_runtime.c',
      'tools/native/arena_runtime.h',
      'tools/native/arena_memory.c',
      'tools/source-direct-build.ts',
      'tools/wasm-stack-bound.ts',
    ]),
  ].sort();
  const inputs = sourceCostInputs(record.inputs, 'direct input');
  assert.deepEqual(
    inputs.map((input) => input.path).sort(),
    expected,
    'direct input inventory differs',
  );
  for (const input of inputs)
    assert.equal(
      hash(await readFile(join(checkout, input.path))),
      input.sha256,
      `stale direct input ${input.path}`,
    );

  // Derive signatures from typed source rather than trusting the adapter's supplied metadata.
  const words = (type: Core.Type): number =>
    typeof type === 'string'
      ? 1
      : type.kind === 'arr'
        ? type.length * words(type.elem)
        : type.fields.reduce((sum, field) => sum + words(field), 0);
  const value = (type: Core.Type) => ({ words: words(type), scalar: typeof type === 'string' });
  const signatures = Object.fromEntries(
    options.wasmExports.map((name) => {
      const fn = linked.program.byName.get(name);
      assert.ok(fn, `missing recorded frontend export ${name}`);
      return [name, { params: fn.params.map(value), result: value(fn.result) }];
    }),
  );
  assert.deepEqual(record.functions, signatures, 'artifact direct ABI differs');
  const frontend = Buffer.from(compiler.compile(linked.program, 'wasm', options).text, 'base64');
  assert.ok(WebAssembly.validate(frontend), 're-emitted frontend is invalid Wasm');
  assert.equal(hash(frontend), record.frontendSHA256, 'artifact direct Wasm differs');
  assert.equal(frontend.length, record.frontendBytes, 'artifact direct Wasm size differs');
}
