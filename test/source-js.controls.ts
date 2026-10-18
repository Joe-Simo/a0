/** Explicit experiment controls. Required artifacts never skip; this file takes no timing samples. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { formatProgram, formatSource, type Program, validate } from '../src/core.js';
import { A0Error } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { parseSource } from '../src/source.js';
import { linkSource } from '../src/source-link.js';
import { type NativeSourceResult, nativeSource } from '../src/source-native.js';
import { linkNativeSource, NativeSourceError } from '../src/source-native-link.js';
import { verifySpec } from '../src/spec.js';
import { writeReport } from '../tools/scrub-results.js';
import { prepareJsSource } from '../tools/source-js-load.js';
import { prepareSourceDiagnostic, prepareSourceFrontend } from '../tools/source-native-load.js';

const jsPath = process.env.A0_JS_SOURCE_ARTIFACT;
const directPath = process.env.A0_JS_SOURCE_DIRECT_ARTIFACT;
const diagnosticPath = process.env.A0_JS_SOURCE_RENDERER;
assert.ok(
  jsPath && directPath && diagnosticPath,
  'A0_JS_SOURCE_ARTIFACT/DIRECT_ARTIFACT/RENDERER required',
);
const js = await prepareJsSource(jsPath);
const direct = await prepareSourceFrontend(directPath);
const diagnostic = await prepareSourceDiagnostic(diagnosticPath);
assert.equal(direct.build.backend, 'direct-wasm');
const cBytes = await readFile('seed/source-frontend/frontend.wasm');
const cBuild = JSON.parse(await readFile('seed/source-frontend/build.json', 'utf8'));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
assert.equal(hash(cBytes), cBuild.wasmSHA256);
const closure = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const sourceHash = hash(formatProgram(closure.program));
assert.equal(
  cBuild.sourceSHA256,
  sourceHash,
  'C control must have the same authoritative A0 source',
);
assert.equal(direct.build.sourceSHA256, sourceHash);
assert.equal(js.build.sourceSHA256, sourceHash);
for (const module of cBuild.modules as { path: string; sha256: string }[])
  assert.equal(hash(await readFile(module.path)), module.sha256);
const cModule = new WebAssembly.Module(cBytes);
const packetFixtures = JSON.parse(
  await readFile('test/fixtures/native-diagnostics/packets.json', 'utf8'),
) as {
  cases: { name: string; source: string; status: number; jsonText: string }[];
};
const factories = [
  ['JS', () => js.instantiate()],
  ['direct', () => direct.instantiate()],
  ['C-derived', () => nativeSource(cModule)],
] as const;
const simple = 'fn identity\nret A\nend\n';
function sameState(
  actual: Pick<NativeSourceResult, 'ok' | 'status' | 'state' | 'specState'>,
  expected: Pick<NativeSourceResult, 'ok' | 'status' | 'state' | 'specState'>,
): void {
  assert.equal(actual.ok, expected.ok);
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.state, expected.state);
  assert.deepEqual(actual.specState, expected.specState);
}
function sameProgram(actual: NativeSourceResult, expected: NativeSourceResult): void {
  sameState(actual, expected);
  assert.ok(actual.ok && expected.ok);
  assert.equal(formatSource(actual.program), formatSource(expected.program));
  assert.equal(compile(actual.typed, 'c').text, compile(expected.typed, 'c').text);
  for (const fn of actual.typed.functions)
    for (const [name, callee] of fn.calls) assert.equal(callee, actual.typed.byName.get(name));
}

test('generated JS preserves complete parser/checker/spec failures, resources and recovery across compiled engines', () => {
  const engines = factories.map(([name, create]) => [name, create()] as const);
  const reference = nativeSource(cModule);
  const cases = [
    '',
    simple,
    `# Unicode π 😀\n${simple}`,
    'fn f\nend\n',
    'fn f\nret missing\nend\n',
    'fn f -> bool\nret 1\nend\n',
    'fn f\nx add A\nret x\nend\n',
    'fn f\nex 1 -> 9\nx add A 1\nret x\nend\n',
    'profile strict\nfn f\npre lt A 3\nex 4 -> 4\nret A\nend\n',
    'fn f\nex 1 -> 2\nx add A 1\nret x\nend\n',
    'profile strict\nfn f u32x3 -> u32\nex [7 8 9] -> 8\nx get p0 1\nret x\nend\n',
    'fn f io u32 -> (u32,io)\nr read p0\na at r 0\nt at r 1\nb add a p1\nw write t b\no rec b w\nret o\nend\n',
  ];
  try {
    for (const source of cases) {
      const expected = reference.parse(source);
      for (const [name, engine] of engines) {
        const actual = engine.parse(source);
        sameState(actual, expected);
        if (expected.ok) {
          sameProgram(actual, expected);
          const typed = validate(parseSource(source));
          for (const fn of typed.functions) verifySpec(fn, typed.byName);
          assert.equal(compile(typed, 'c').text, compile(expected.typed, 'c').text, name);
        }
        sameProgram(engine.parse(simple), reference.parse(simple));
      }
    }
    for (const budget of [0, 1, 2, 32, 128, 512, 4096, 16_000_000]) {
      const expected = reference.parse(simple, budget);
      for (const [, engine] of engines) {
        sameState(engine.parse(simple, budget), expected);
        sameState(engine.parseUnit(simple, budget), reference.parseUnit(simple, budget));
        sameProgram(engine.parse(simple), reference.parse(simple));
      }
    }
    for (const [, engine] of engines) {
      for (const budget of [-1, 0.5, 0x1_0000_0000, NaN, Infinity])
        assert.throws(() => engine.parse(simple, budget), /allocation budget/);
      const failure = engine.parse('fn f\nret missing\nend\n');
      assert.equal(failure.ok, false);
      const frozen = JSON.stringify(failure);
      sameProgram(engine.parse(simple), reference.parse(simple));
      assert.equal(JSON.stringify(failure), frozen);
      engine.close();
      engine.close();
      assert.throws(() => engine.parse(simple), /closed/);
    }
  } finally {
    for (const [, engine] of engines) engine.close();
    reference.close();
  }
});

test('generated JS keeps graph/program IR ownership, repeated pages and retained snapshots independent', () => {
  const engine = js.instantiate(),
    foreign = js.instantiate(),
    reference = nativeSource(cModule);
  const graphs = [
    [
      '# Unicode π 😀\nfn helper (_,bool) -> (_,bool)\na at A 0\nb at A 1\nc (a b)\nret c\nend\n',
      'use "helper.a0"\nfn top -> (_,bool)\na (5 true)\nb helper a\nret b\nend\n',
    ],
    [
      'profile strict\nfn helper _x3 -> _x3\nex [7*3] -> [7 7 7]\nret A\nend\n',
      'profile strict\nuse "helper.a0"\nfn top -> _x3\nex -> [7*3]\na [7*3]\nb helper a\nret b\nend\n',
    ],
  ];
  try {
    for (const sources of graphs) {
      const units = sources.map((source) => engine.parseUnit(source));
      const originals = sources.map((source) => reference.parseUnit(source));
      assert.ok(units.every((unit) => unit.ok) && originals.every((unit) => unit.ok));
      const profile = sources[0]?.startsWith('profile strict') ? 'strict' : 'canonical';
      const expected = reference.checkUnits(originals, profile);
      assert.ok(expected.ok);
      sameProgram(engine.checkUnits(units, profile), expected);
      const retained = JSON.stringify(units);
      const wide =
        'fn wider -> u32\n' +
        Array.from({ length: 512 }, (_, i) => `n${i} add ${i ? `n${i - 1}` : '0'} 1\n`).join('') +
        'ret n511\nend\n';
      sameProgram(engine.parse(wide), reference.parse(wide));
      assert.equal(JSON.stringify(units), retained);
      const first = units[0];
      assert.ok(first?.ok);
      Reflect.set(first.state, '0', 99);
      Reflect.set(first.program.functions[0] as object, 'name', 'caller_mutation');
      sameProgram(engine.checkUnits(units, profile), expected);
      assert.throws(() => foreign.checkUnits(units, profile), /owned/);
      assert.throws(() => engine.checkUnits([{ ...first }], profile), /owned/);
      sameState(engine.checkUnits(units, profile, 0), reference.checkUnits(originals, profile, 0));
      sameProgram(engine.checkUnits(units, profile), expected);
      const program: Program = structuredClone(expected.program);
      const saved = JSON.stringify(program);
      sameProgram(engine.checkProgram(program), reference.checkProgram(program));
      assert.equal(JSON.stringify(program), saved);
    }
  } finally {
    engine.close();
    foreign.close();
    reference.close();
  }
});

test('generated JS uses the existing lazy A0 renderer and retains real catalog packets before reset', () => {
  let loads = 0;
  const engine = js.instantiate({
    load: () => {
      loads++;
      return diagnostic.load();
    },
  });
  try {
    assert.ok(engine.parse(simple).ok);
    assert.equal(loads, 0);
    for (const fixture of packetFixtures.cases.filter((row) => row.status === 0)) {
      const result = engine.parse(fixture.source);
      assert.ok(
        !result.ok &&
          result.diagnostic &&
          'packet' in result.diagnostic &&
          result.diagnostic.rendered.ok,
        fixture.name,
      );
      assert.deepEqual(
        result.diagnostic.rendered.error.toJSON(),
        JSON.parse(fixture.jsonText),
        fixture.name,
      );
      const saved = JSON.stringify(result),
        bytes = hash(result.diagnostic.packet.json);
      assert.ok(engine.parse(simple).ok);
      assert.equal(JSON.stringify(result), saved);
      assert.equal(hash(result.diagnostic.packet.json), bytes);
    }
    assert.equal(loads, 1);
  } finally {
    engine.close();
  }
});

test('generated JS linked failures preserve exact catalog JSON, fixes and byte/UTF16 origins', async () => {
  const engine = js.instantiate({ load: diagnostic.load });
  const root = '/source-js-controls';
  const options = { root, canonicalPath: async (path: string) => path };
  const controls = [
    new Map([[`${root}/entry.a0`, '# λ😀\nfn f\nx add missing 1\nret x\nend\n']]),
    new Map([
      [`${root}/dep.a0`, '# λ😀\nfn helper\nret A\nend\n'],
      [`${root}/entry.a0`, 'use "dep.a0"\n# λ😀\nfn f -> bool\nret 1\nend\n'],
    ]),
  ];
  try {
    for (const files of controls) {
      const read = async (path: string) => {
        const source = files.get(path);
        assert.ok(source !== undefined);
        return source;
      };
      let expected: A0Error | undefined;
      try {
        await linkSource(`${root}/entry.a0`, read, options);
      } catch (error) {
        assert.ok(error instanceof A0Error);
        expected = error;
      }
      assert.ok(expected, 'independent linked failure');
      await assert.rejects(
        linkNativeSource(`${root}/entry.a0`, read, engine, options),
        (error: unknown) => {
          assert.ok(error instanceof NativeSourceError && error.a0Error && error.rendered?.ok);
          assert.deepEqual(error.a0Error.toJSON(), expected.toJSON());
          const location = error.rendered.location;
          assert.ok(location.path);
          const owner = files.get(location.path);
          assert.ok(owner !== undefined);
          const combined = 'origins' in error.result ? [...files.values()].join('\n') : owner;
          const beforeOwner = combined.indexOf(owner);
          assert.ok(beforeOwner >= 0);
          const absoluteUtf16 = new TextDecoder('utf-8', { fatal: true }).decode(
            new TextEncoder().encode(combined).subarray(0, location.byteStart),
          ).length;
          assert.equal(location.utf16Start, absoluteUtf16);
          assert.equal(location.localUtf16Start, absoluteUtf16 - beforeOwner);
          assert.equal(
            location.localByteStart,
            location.byteStart - new TextEncoder().encode(combined.slice(0, beforeOwner)).length,
          );
          assert.equal(location.path, error.path);
          return true;
        },
      );
    }
  } finally {
    engine.close();
  }
});

test('generated JS frontend checks its own unchanged flattened A0 source', () => {
  const engine = js.instantiate();
  try {
    const result = engine.parse(formatProgram(closure.program));
    assert.ok(result.ok);
    assert.equal(compile(result.typed, 'c').text, compile(closure.program, 'c').text);
  } finally {
    engine.close();
  }
});

test('all six frozen applications agree across JS/C/direct A0 and independent TS frontends', async () => {
  const root = 'experiments/unification/frontend-a0/inputs';
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as {
    unit: string;
    input: string;
    inputSHA256: string;
  }[];
  const engines = factories.map(([name, create]) => [name, create()] as const);
  const rows: { unit: string; inputSHA256: string; outputSHA256: string; engines: string[] }[] = [];
  try {
    for (const row of index) {
      const bytes = await readFile(join(root, row.input));
      assert.equal(hash(bytes), row.inputSHA256);
      const source = (JSON.parse(bytes.toString('utf8')) as { unified: string }).unified;
      const typed = validate(parseSource(source));
      const c = compile(typed, 'c').text;
      for (const [name, engine] of engines) {
        const result = engine.parse(source);
        assert.ok(result.ok, `${name}: ${row.unit}`);
        assert.equal(compile(result.typed, 'c').text, c, `${name}: ${row.unit}`);
        assert.equal(formatSource(result.program), formatSource(typed));
      }
      rows.push({
        unit: row.unit,
        inputSHA256: row.inputSHA256,
        outputSHA256: hash(c),
        engines: ['TS', ...engines.map(([name]) => name)],
      });
    }
  } finally {
    for (const [, engine] of engines) engine.close();
  }
  await writeReport('.a0-tmp/source-js-applications.json', {
    scope: 'Correctness only; no latency, memory or superiority measurement.',
    jsArtifactSHA256: js.build.frontendSHA256,
    cArtifactSHA256: hash(cBytes),
    directArtifact: direct.artifactSha256,
    sourceSHA256: sourceHash,
    rows,
  });
});

test('JS artifact loading refuses stale bytes, missing provenance and mismatched typed ABI', async () => {
  interface MutableManifest {
    inputs: { path: string; sha256: string }[];
    frontendOptions: { jsIo: string };
    frontendABI: number;
    frontendCallABI: string;
    sourceSHA256: string;
    compilerOutputs: { path: string; sha256: string }[];
    totalArtifactBytes: number;
    totalWasmBytes: number;
    arenaOrigin: { inputs: unknown[] };
    functions: Record<string, { result: { fields: unknown[] } }>;
  }
  await mkdir('.a0-tmp', { recursive: true });
  const directory = await mkdtemp('.a0-tmp/source-js-corruption-');
  const manifestText = await readFile(join(jsPath, 'build.json'), 'utf8');
  const frontendBytes = await readFile(join(jsPath, 'frontend.mjs'));
  const arenaBytes = await readFile(join(jsPath, 'arena.wasm'));
  try {
    const mutations = [
      (record: MutableManifest) => {
        record.inputs.pop();
      },
      (record: MutableManifest) => {
        const first = record.inputs[0];
        assert.ok(first);
        record.inputs.push(first);
      },
      (record: MutableManifest) => {
        record.frontendOptions.jsIo = 'buffered';
      },
      (record: MutableManifest) => {
        record.frontendABI = 4;
      },
      (record: MutableManifest) => {
        record.frontendCallABI = 'wasm-flat-words';
      },
      (record: MutableManifest) => {
        record.sourceSHA256 = '0'.repeat(64);
      },
      (record: MutableManifest) => {
        const first = record.compilerOutputs[0];
        assert.ok(first);
        first.sha256 = '0'.repeat(64);
      },
      (record: MutableManifest) => {
        record.totalArtifactBytes = 0;
      },
      (record: MutableManifest) => {
        record.totalWasmBytes = 0;
      },
      (record: MutableManifest) => {
        record.arenaOrigin.inputs = [];
      },
      (record: MutableManifest) => {
        const resume = record.functions.arena_verify_resume;
        assert.ok(resume);
        resume.result.fields[6] = 'u32';
      },
    ];
    for (const mutate of mutations) {
      const record = JSON.parse(manifestText) as MutableManifest;
      mutate(record);
      await writeReport(join(directory, 'build.json'), record);
      await copyFile(join(jsPath, 'frontend.mjs'), join(directory, 'frontend.mjs'));
      await copyFile(join(jsPath, 'arena.wasm'), join(directory, 'arena.wasm'));
      await assert.rejects(async () => {
        const altered = await prepareJsSource(directory);
        altered.instantiate().close();
      });
    }
    await writeFile(join(directory, 'build.json'), manifestText);
    await writeFile(
      join(directory, 'frontend.mjs'),
      Buffer.concat([frontendBytes, Buffer.from('\n')]),
    );
    await writeFile(join(directory, 'arena.wasm'), arenaBytes);
    await assert.rejects(prepareJsSource(directory));
    await writeFile(join(directory, 'frontend.mjs'), frontendBytes);
    const damaged = Uint8Array.from(arenaBytes);
    damaged[0] = 1;
    await writeFile(join(directory, 'arena.wasm'), damaged);
    await assert.rejects(prepareJsSource(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prepared JS provenance rejects ignored stale compiler code before executing it', async () => {
  const path = 'dist/src/backends.js';
  const original = await readFile(path);
  try {
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from("throw new Error('stale compiler must never execute');\n"),
        original,
      ]),
    );
    await assert.rejects(prepareJsSource(jsPath), /prepared JS compiler output changed/);
  } finally {
    await writeFile(path, original);
  }
  const verified = await prepareJsSource(jsPath);
  const engine = verified.instantiate();
  try {
    assert.ok(engine.parse(simple).ok);
  } finally {
    engine.close();
  }
});
