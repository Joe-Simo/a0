import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { COMPILER_VERSION, compile } from '../src/backends.js';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import {
  nativeCompileCommandSHA256,
  nativeCompileInputs,
  sourceCompilerInputs,
  sourceFunctionSignatures,
} from '../tools/source-compiler-inputs.js';
import { rebuildCSourceCostBuild, verifyCSourceCostBuild } from '../tools/source-cost-artifact.js';
import {
  type SourceCostBuild,
  sourceCostAlgorithmDifferences,
  sourceCostCFrontendOptions,
  sourceCostCompilerDifferences,
  sourceCostControlMode,
  verifySourceCostControl,
} from '../tools/source-cost-control.js';

const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const frontendOptions = { cIo: 'host', optimize: true } as const;
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' });
function commit(root: string) {
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
}

async function fixture(root: string) {
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    'bun.lock': '{"lockfileVersion":1}\n',
    'tsconfig.json': '{"extends":"./config/compiler.json","include":["src"]}\n',
    'config/compiler.json': '{"compilerOptions":{"target":"ES2023","strict":true}}\n',
    'src/compiler.ts': 'export const example = 1;\n',
    'src/opcodes.json': '{"read":7}\n',
    'tools/source-native-build.ts': '// independent builder input\n',
    'tools/source-compiler-inputs.ts': '// independent provenance input\n',
    'tools/scrub-results.ts': '// independent report input\n',
    'tools/native/source_frontend.c': '/* independent driver */\n',
    'tools/native/arena_runtime.c': '/* independent runtime */\n',
    'tools/native/arena_runtime.h': '/* independent runtime declarations */\n',
    'compiler/source_frontend.a0':
      'use "helper.a0"\nfn exchange io -> io\nx read p0\nv at x 0\nt at x 1\ny call forward t v\nret y\nend\n',
    'compiler/helper.a0': 'fn forward io u32 -> io\nx write p0 p1\nret x\nend\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  git(root, 'init', '--quiet');
  commit(root);
  return files;
}

async function manifest(checkout: string): Promise<SourceCostBuild> {
  const root = await realpath(checkout);
  const compiler = await sourceCompilerInputs(root);
  const program = await link(join(root, 'compiler/source_frontend.a0'), (path) =>
    readFile(path, 'utf8'),
  );
  const native = JSON.parse(await readFile('seed/source-frontend/build.json', 'utf8'));
  const paths = [
    'tools/native/source_frontend.c',
    'tools/native/arena_runtime.c',
    'tools/native/arena_runtime.h',
    'tools/source-native-build.ts',
  ];
  const cSHA256 = sha(compile(program.program, 'c', frontendOptions).text);
  const driverSHA256 = sha(await readFile(join(root, paths[0] as string)));
  return {
    ...native,
    frontendOptions,
    frontendFunctions: sourceFunctionSignatures(program.program, ['exchange', 'forward']),
    compilerVersion: COMPILER_VERSION,
    compilerInputs: compiler.inputs,
    compilerConfiguration: compiler.configuration,
    compilerBuild: compiler.build,
    compilerCheckout: compiler.checkout,
    compileFlags: ['--target=wasm32-wasi', '-O3', '-flto', '-DNDEBUG', '<artifact>/driver.c'],
    linkerFlags: [
      '<artifact>/frontend.o',
      '--no-entry',
      '-z',
      'stack-size=16777216',
      '--lto-O3',
      '--strip-all',
    ],
    sourceSHA256: sha(formatProgram(program.program)),
    cSHA256,
    functions: program.program.functions.length,
    modules: await Promise.all(
      program.sources.map(async ({ path }) => ({
        path: relative(root, path),
        sha256: sha(await readFile(path)),
      })),
    ),
    nativeInputs: await Promise.all(
      paths.map(async (path) => ({ path, sha256: sha(await readFile(join(root, path))) })),
    ),
    driverSHA256,
    effectiveCompileSHA256: sha('independent common effective cc1 invocation'),
    nativeCompileInputs: [
      { path: '<artifact>/api.h', sha256: sha('independent generated API') },
      { path: '<artifact>/driver.c', sha256: driverSHA256 },
      { path: '<artifact>/module.c', sha256: cSHA256 },
      { path: '<sysroot>/include/stdint.h', sha256: sha('independent common stdint header') },
    ],
  };
}

test('compiler-codegen is explicit, mutually exclusive, and leaves legacy mode selection unchanged', () => {
  assert.equal(
    sourceCostControlMode(false, 'artifact', 'checkout', true),
    'same-a0-source-compiler-codegen',
  );
  assert.throws(() => sourceCostControlMode(true, 'artifact', 'checkout', true), /conflicts/);
  assert.throws(
    () => sourceCostControlMode(false, undefined, undefined, true),
    /--compiler-codegen requires/,
  );
  assert.throws(
    () => sourceCostControlMode(false, 'artifact', undefined, true),
    /--compiler-codegen requires/,
  );
  assert.equal(
    sourceCostControlMode(false, 'artifact', 'checkout'),
    'same-a0-source-separate-native-transport',
  );
  assert.equal(sourceCostControlMode(false, 'artifact'), 'wasm-build-options');
  assert.equal(
    sourceCostControlMode(true, 'artifact', 'checkout'),
    'same-a0-source-compiled-backends',
  );
  for (const options of [
    undefined,
    {},
    { cIo: 'host' },
    { optimize: true },
    { ...frontendOptions, cTrap: { maxTrips: 1 } },
  ])
    assert.throws(
      () => sourceCostCFrontendOptions({ frontendOptions: options }),
      /frontendOptions/,
    );
  const missing = spawnSync(
    process.execPath,
    [
      'dist/tools/source-cost-bench.js',
      '--compiler-codegen',
      '--control-artifact=unused',
      '--control-checkout=unused',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--compiler-codegen requires --sysroot and --builtins/);
});

test('codegen controls isolate compiler inputs from source, runtime, dependencies and build settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-codegen-controls-'));
  try {
    await fixture(root);
    const a = await manifest(root);
    const inputs = a.compilerInputs as { path: string; sha256: string }[];
    const b = {
      ...a,
      cSHA256: sha('different actual emitter output'),
      wasmSHA256: sha('different actual binary'),
      nativeCompileInputs: (a.nativeCompileInputs as { path: string; sha256: string }[]).map(
        (input) =>
          input.path === '<artifact>/module.c'
            ? { ...input, sha256: sha('different actual emitter output') }
            : input,
      ),
      compilerInputs: inputs.map((input) =>
        input.path === 'src/compiler.ts'
          ? { ...input, sha256: sha('changed implementation') }
          : input,
      ),
    };
    verifySourceCostControl(a, b, 'compiler-codegen');
    assert.deepEqual(sourceCostCompilerDifferences(a, b), [
      {
        path: 'src/compiler.ts',
        candidateSHA256: inputs.find((input) => input.path === 'src/compiler.ts')?.sha256,
        controlSHA256: sha('changed implementation'),
      },
    ]);
    assert.throws(() => verifySourceCostControl(a, b, false), /cSHA256/);
    for (const field of [
      'sourceSHA256',
      'functions',
      'modules',
      'frontendABI',
      'aggregateBytes',
      'stackBytes',
      'driverSHA256',
      'libcSHA256',
      'builtinsSHA256',
      'clang',
      'linker',
      'clangFlags',
      'requiredWasmFeatures',
      'optimization',
      'symbols',
      'symbolFlags',
      'frontendOptions',
      'compileFlags',
      'linkerFlags',
      'compilerConfiguration',
      'compilerBuild',
      'effectiveCompileSHA256',
      'nativeCompileInputs',
    ])
      assert.throws(
        () => verifySourceCostControl(a, { ...b, [field]: null }, 'compiler-codegen'),
        /missing|differs|frontendOptions|configuration|symbols=strip/,
      );
    for (const field of [
      'compilerInputs',
      'compilerConfiguration',
      'compilerBuild',
      'compilerCheckout',
      'compilerVersion',
    ])
      assert.throws(
        () => verifySourceCostControl({ ...a, [field]: undefined }, b, 'compiler-codegen'),
        /missing|compiler/,
      );
    assert.throws(
      () => verifySourceCostControl({ ...a, backend: 'direct-wasm' }, b, 'compiler-codegen'),
      /two C-derived/,
    );
    assert.throws(
      () =>
        verifySourceCostControl(
          { ...a, compilerCheckout: { ...(a.compilerCheckout as object), dirty: true } },
          b,
          'compiler-codegen',
        ),
      /not clean/,
    );
    for (const path of ['package.json', 'bun.lock', 'config/compiler.json'])
      assert.throws(
        () =>
          verifySourceCostControl(
            a,
            {
              ...b,
              compilerInputs: inputs.map((input) =>
                input.path === path ? { ...input, sha256: sha('different configuration') } : input,
              ),
            },
            'compiler-codegen',
          ),
        /compiler configuration/,
      );
    const nativeInputs = a.nativeInputs as { path: string; sha256: string }[];
    for (const path of [
      'tools/native/source_frontend.c',
      'tools/native/arena_runtime.c',
      'tools/native/arena_runtime.h',
    ])
      assert.throws(
        () =>
          verifySourceCostControl(
            a,
            {
              ...b,
              nativeInputs: nativeInputs.map((input) =>
                input.path === path ? { ...input, sha256: sha('changed runtime') } : input,
              ),
            },
            'compiler-codegen',
          ),
        /native runtime/,
      );
    const legacy = { ...a };
    delete legacy.frontendOptions;
    assert.throws(
      () => verifySourceCostControl(legacy, legacy, 'compiler-codegen'),
      /frontendOptions/,
    );
    assert.throws(
      () => verifySourceCostControl({ ...a, symbols: 'keep' }, b, 'compiler-codegen'),
      /symbols=strip/,
    );
    const withoutPorts = Object.fromEntries(
      Object.entries(a).filter(([name]) => name !== 'diagnosticPorts'),
    );
    for (const [candidate, control] of [
      [
        { ...a, diagnosticPorts: 'disabled' },
        { ...b, diagnosticPorts: 'arena-v1' },
      ],
      [withoutPorts, { ...b, diagnosticPorts: 'disabled' }],
    ])
      assert.throws(
        () =>
          verifySourceCostControl(
            candidate as SourceCostBuild,
            control as SourceCostBuild,
            'compiler-codegen',
          ),
        /diagnosticPorts/,
      );
    const headers = b.nativeCompileInputs as { path: string; sha256: string }[];
    assert.throws(
      () =>
        verifySourceCostControl(
          a,
          {
            ...b,
            nativeCompileInputs: headers.map((input) =>
              input.path === '<sysroot>/include/stdint.h'
                ? { ...input, sha256: sha('different system header') }
                : input,
            ),
          },
          'compiler-codegen',
        ),
      /compilation headers/,
    );
    await assert.rejects(
      rebuildCSourceCostBuild(
        root,
        { ...a, symbols: 'keep' },
        { sysroot: 'unused', builtins: 'unused' },
      ),
      /symbols=strip/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native build provenance records actual include bytes and effective invocation without checkout paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-native-compile-inputs-'));
  try {
    const roots = {
      checkout: root,
      artifact: join(root, 'out'),
      sysroot: join(root, 'sdk'),
      resource: join(root, 'clang'),
    };
    for (const [path, text] of [
      ['out/driver.c', 'driver'],
      ['out/module.c', 'module'],
      ['out/api.h', 'api'],
      ['sdk/include/word type.h', 'system header'],
      ['clang/include/bool.h', 'resource header'],
    ] as const) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const trace = `. ${join(roots.artifact, 'module.c')}\n.. ${join(roots.sysroot, 'include/word type.h')}\n... ${join(roots.resource, 'include/bool.h')}\n. ${join(roots.artifact, 'api.h')}\n.. ${join(roots.sysroot, 'include/word type.h')}\n`;
    const inputs = await nativeCompileInputs(trace, roots);
    assert.deepEqual(
      inputs.map((input) => input.path),
      [
        '<artifact>/api.h',
        '<artifact>/driver.c',
        '<artifact>/module.c',
        '<resource>/include/bool.h',
        '<sysroot>/include/word type.h',
      ],
    );
    assert.equal(
      inputs.find((input) => input.path === '<sysroot>/include/word type.h')?.sha256,
      sha('system header'),
    );
    const command = `clang -cc1 -I ${roots.sysroot}/include -resource-dir ${roots.resource} ${roots.artifact}/driver.c -fdebug-compilation-dir ${root}`;
    const other = {
      checkout: '/other',
      artifact: '/other/out',
      sysroot: '/other/sdk',
      resource: '/other/clang',
    };
    assert.equal(
      nativeCompileCommandSHA256(command, roots),
      nativeCompileCommandSHA256(command.replaceAll(root, '/other'), other),
    );
    assert.notEqual(
      nativeCompileCommandSHA256(command, roots),
      nativeCompileCommandSHA256(`${command} -DCHANGED=1`, roots),
    );
    assert.equal(
      nativeCompileCommandSHA256(command, roots),
      nativeCompileCommandSHA256(
        `clang version\n${command}\nclang -cc1 version 19.1.7 based upon LLVM\n${trace}warning: source diagnostic`,
        roots,
      ),
    );
    assert.throws(() => nativeCompileCommandSHA256(trace, roots), /effective cc1/);
    await assert.rejects(nativeCompileInputs('', roots), /no include dependencies/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh C provenance re-emits its own exact source/options and rejects stale or incomplete inventories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-codegen-provenance-'));
  try {
    await fixture(root);
    const record = await manifest(root);
    const compiler = { link, formatProgram, compile, version: COMPILER_VERSION };
    await verifyCSourceCostBuild(root, record, compiler, true);
    for (const [field, value] of [
      ['cSHA256', sha('other C')],
      ['compilerInputs', []],
      ['compilerConfiguration', []],
      ['compilerBuild', {}],
      ['compilerCheckout', {}],
      ['compilerVersion', 'a0c-0.0.1'],
      ['modules', []],
      ['functions', 3],
      ['sourceSHA256', sha('other source')],
    ] as const)
      await assert.rejects(
        verifyCSourceCostBuild(root, { ...record, [field]: value }, compiler, true),
        /differs|C|inventory|configuration|versions|identity|version|closure/,
      );
    await assert.rejects(
      verifyCSourceCostBuild(root, { ...record, frontendOptions: { cIo: 'host' } }, compiler, true),
      /frontendOptions/,
    );
    let called = false;
    await verifyCSourceCostBuild(
      root,
      record,
      {
        ...compiler,
        compile: (program, target, options, cache) => {
          called = true;
          assert.deepEqual(options, frontendOptions);
          return compile(program, target, options, cache);
        },
      },
      true,
    );
    assert.equal(called, true);
    const inventory = await sourceCompilerInputs(root);
    assert.ok(inventory.configuration.includes('config/compiler.json'));
    assert.ok(inventory.inputs.some((input) => input.path === 'src/opcodes.json'));
    await writeFile(join(root, 'bunfig.toml'), '[install]\noptional = false\n');
    await assert.rejects(
      sourceCompilerInputs(root),
      /untracked compiler configuration bunfig.toml/,
    );
    await rm(join(root, 'bunfig.toml'));
    await writeFile(join(root, 'src/new-dependency.ts'), 'export const newInput = 2;\n');
    commit(root);
    await assert.rejects(
      verifyCSourceCostBuild(root, record, compiler, true),
      /compiler input inventory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source-algorithm is explicit and refuses mixed controls, missing toolchain or legacy signatures', () => {
  assert.equal(
    sourceCostControlMode(false, 'artifact', 'checkout', false, true),
    'same-compiler-source-algorithm',
  );
  assert.throws(
    () => sourceCostControlMode(true, 'artifact', 'checkout', false, true),
    /conflicts/,
  );
  assert.throws(
    () => sourceCostControlMode(false, 'artifact', 'checkout', true, true),
    /conflicts/,
  );
  for (const paths of [
    [undefined, undefined],
    ['artifact', undefined],
  ] as const)
    assert.throws(
      () => sourceCostControlMode(false, paths[0], paths[1], false, true),
      /--source-algorithm requires/,
    );
  const missing = spawnSync(
    process.execPath,
    [
      'dist/tools/source-cost-bench.js',
      '--source-algorithm',
      '--control-artifact=unused',
      '--control-checkout=unused',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--source-algorithm requires --sysroot and --builtins/);
});

test('source-algorithm permits only verified A0 closure/count differences with the same consumed API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-source-algorithm-'));
  try {
    await fixture(root);
    const a = await manifest(root);
    const compiler = { link, formatProgram, compile, version: COMPILER_VERSION };
    await verifyCSourceCostBuild(root, a, compiler, true);
    await writeFile(
      join(root, 'compiler/helper.a0'),
      'use "extra.a0"\nfn forward io u32 -> io\nz add p1 0\nx write p0 z\nret x\nend\n',
    );
    await writeFile(join(root, 'compiler/extra.a0'), 'fn extra u32 -> u32\nret p0\nend\n');
    commit(root);
    const b = await manifest(root);
    await verifyCSourceCostBuild(root, b, compiler, true);
    assert.notEqual(a.sourceSHA256, b.sourceSHA256);
    assert.notEqual(a.functions, b.functions);
    verifySourceCostControl(a, b, 'source-algorithm');
    assert.deepEqual(sourceCostCompilerDifferences(a, b), []);
    const changes = sourceCostAlgorithmDifferences(a, b);
    assert.equal(changes.candidateFunctions, a.functions);
    assert.equal(changes.controlFunctions, b.functions);
    assert.deepEqual(
      changes.modules.map((x) => x.path),
      ['compiler/extra.a0', 'compiler/helper.a0'],
    );
    assert.equal(changes.modules[0]?.candidateSHA256, null);
    assert.throws(
      () => verifySourceCostControl(a, b, 'compiler-codegen'),
      /sourceSHA256|functions|modules/,
    );
    for (const key of [
      'sourceSHA256',
      'functions',
      'modules',
      'compilerVersion',
      'compilerInputs',
      'compilerConfiguration',
      'compilerBuild',
      'compilerHost',
      'frontendOptions',
      'frontendFunctions',
      'nativeInputs',
      'driverSHA256',
      'frontendABI',
      'stackBytes',
      'libcSHA256',
      'builtinsSHA256',
      'clang',
      'linker',
      'compileFlags',
      'linkerFlags',
      'effectiveCompileSHA256',
      'nativeCompileInputs',
      'symbols',
    ]) {
      const changed = structuredClone(b) as Record<string, unknown>;
      changed[key] = undefined;
      assert.throws(() => verifySourceCostControl(a, changed, 'source-algorithm'), Error, key);
    }
    const signatures = structuredClone(b.frontendFunctions) as {
      name: string;
      params: string[];
      result: string;
    }[];
    const first = signatures[0];
    assert.ok(first);
    first.params[0] = 'u32'; // Same word count as io; the structural type still differs.
    assert.throws(
      () => verifySourceCostControl(a, { ...b, frontendFunctions: signatures }, 'source-algorithm'),
      /frontendFunctions/,
    );
    await assert.rejects(
      verifyCSourceCostBuild(root, { ...b, frontendFunctions: signatures }, compiler, true),
      /API signatures/,
    );
    await assert.rejects(
      verifyCSourceCostBuild(root, { ...b, functions: a.functions }, compiler, true),
      /function count/,
    );
    await assert.rejects(
      verifyCSourceCostBuild(root, { ...b, sourceSHA256: a.sourceSHA256 }, compiler, true),
      /source differs/,
    );
    const inputs = structuredClone(b.compilerInputs) as { path: string; sha256: string }[];
    const input = inputs.find((x) => x.path === 'src/compiler.ts');
    assert.ok(input);
    input.sha256 = sha('different compiler');
    assert.throws(
      () => verifySourceCostControl(a, { ...b, compilerInputs: inputs }, 'source-algorithm'),
      /compilerInputs/,
    );
    assert.throws(
      () => verifySourceCostControl(a, { ...b, diagnosticPorts: 'arena-v1' }, 'source-algorithm'),
      /diagnosticPorts/,
    );
    assert.throws(
      () => verifySourceCostControl(a, { ...b, symbols: 'keep' }, 'source-algorithm'),
      /symbols=strip/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('strict C provenance resolves symlinked checkout roots and retains compiler and closure checks', async () => {
  const scratch = join(process.cwd(), '.a0-tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'source-cost-c-symlink-'));
  try {
    const root = join(directory, 'checkout'),
      alias = join(directory, 'checkout-alias');
    await mkdir(root);
    await fixture(root);
    const record = await manifest(root);
    const compiler = { link, formatProgram, compile, version: COMPILER_VERSION };
    await symlink(root, alias, 'dir');
    const aliasRecord = await manifest(alias);
    assert.deepEqual(aliasRecord, record);
    verifySourceCostControl(aliasRecord, record, 'source-algorithm');
    await verifyCSourceCostBuild(alias, record, compiler, true);
    const modules = record.modules as { path: string; sha256: string }[];
    for (const change of [
      { modules: modules.slice(1) },
      { modules: [...modules, modules[0]] },
      { functions: 3 },
      { cSHA256: sha('different compiler output') },
      { compilerInputs: [] },
    ])
      await assert.rejects(
        verifyCSourceCostBuild(alias, { ...record, ...change }, compiler, true),
        /closure|function count|artifact C|compiler input inventory/,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
