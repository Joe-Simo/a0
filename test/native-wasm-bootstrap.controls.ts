/** Explicit runtime-package control: native source authority feeds the existing
 * A0 table optimizer/emitter, with independent old setup and execution oracles. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { A0Error, parseAndValidate, type TypedProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { nativeSourceGraphLoader } from '../src/source-native-link.js';
import { loadNativeSourcePackage } from '../src/source-native-package.js';
import { findClang } from '../src/toolchain.js';
import type { WasmLayout } from '../src/wasm.js';
import { bootstrapProgramClosure } from '../tools/bootstrap-source.js';
import { writeReport } from '../tools/scrub-results.js';
import {
  a0WasmFromTables,
  buildWasmTool,
  typescriptWasm,
  WASM_TOOL_INPUT,
  WASM_TOOL_OUTPUT,
  type WasmToolTransport,
} from '../tools/selfhost-wasm.js';
import { buildProgram, type Keys, wasmTool } from '../tools/site-build.js';
import { codeDigest, openCache, sha256, toolFile } from '../tools/site-cache.js';
import { prerender } from '../tools/site-render.js';
import { CHECKED_SOURCE, checkedCases } from './fixtures/checked-ops-fixtures.js';

const directory = process.env.A0_WASM_SOURCE_PACKAGE;
const identity = process.env.A0_WASM_SOURCE_PACKAGE_SHA256;
assert.ok(directory && identity, 'A0_WASM_SOURCE_PACKAGE/SHA256 required');
const packageBytes = await readFile(join(directory, 'manifest.json'));
const packageArtifact = await loadNativeSourcePackage(packageBytes, identity, (name) =>
  readFile(join(directory, name)),
);
const clang = findClang();
assert.ok(clang.path, 'C compiler required');
const controlRoot = resolve('.a0-tmp/native-wasm-bootstrap-controls');
await mkdir(controlRoot, { recursive: true });
const scratch = await mkdtemp(join(controlRoot, 'run-'));
await writeFile('.a0-tmp/native-wasm-bootstrap-latest.txt', scratch);
const cache = openCache({ dir: join(scratch, 'cache') });
const nativeDir = join(scratch, 'native');
const legacyDir = join(scratch, 'verified-seed');
let prepared: Promise<{ native: string; legacy: string; compiler: TypedProgram }> | undefined;
const observations: Record<string, unknown> = {};

function tools() {
  prepared ??= (async () => {
    const host = packageArtifact.instantiate();
    let checked: TypedProgram | undefined;
    const counts = { units: 0, checks: 0, formats: 0 };
    const frontend: typeof host = {
      ...host,
      parse() {
        throw new Error('bootstrap must not reparse whole source');
      },
      checkProgram() {
        throw new Error('bootstrap must not recheck host IR');
      },
      parseUnit(source, budget) {
        counts.units++;
        return host.parseUnit(source, budget);
      },
      checkUnits(units, profile, budget) {
        counts.checks++;
        const result = host.checkUnits(units, profile, budget);
        if (result.ok) checked = result.typed;
        return result;
      },
      format(result, request) {
        counts.formats++;
        return host.format(result, request);
      },
    };
    try {
      const misses: boolean[] = [];
      const native = await wasmTool(clang, cache, (hit) => misses.push(hit), {
        frontend,
        manifestSHA256: identity as string,
        buildDir: nativeDir,
      });
      assert.deepEqual(misses, [false]);
      assert.ok(counts.units > 0);
      assert.equal(counts.checks, 1);
      assert.equal(counts.formats, 1);
      assert.ok(checked);
      const compiler = bootstrapProgramClosure(checked, ['emitwasmio']);
      const hits: boolean[] = [];
      const restored = await wasmTool(
        { ...clang, path: 'missing-compiler-on-native-cache-hit' },
        cache,
        (hit) => hits.push(hit),
        {
          frontend,
          manifestSHA256: identity as string,
          buildDir: nativeDir,
        },
      );
      assert.deepEqual(hits, [true]);
      assert.equal(restored.digest, native.digest);
      assert.equal(counts.checks, 2, 'native source checking precedes a cache hit');
      assert.ok(host.parse('fn after\nret A\nend\n').ok, 'borrowed frontend stays open');
      const legacy = await buildWasmTool(clang, undefined, legacyDir);
      observations.setup = {
        nativeChecksOnMissAndHit: counts.checks,
        compilerFunctions: compiler.functions.length,
        nativeSource: await fileFacts(join(nativeDir, 'a0w/compiler-source.a0')),
        nativeC: await fileFacts(join(nativeDir, 'a0w/emitter.c')),
        verifiedSeedC: await fileFacts(join(legacyDir, 'a0w/emitter.c')),
        nativeExecutable: await fileFacts(toolFile(native.exe)),
        legacyExecutable: await fileFacts(toolFile(legacy.exe)),
      };
      return { native: native.exe, legacy: legacy.exe, compiler };
    } finally {
      host.close();
    }
  })();
  return prepared;
}
async function fileFacts(path: string) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}
function nativeProgram(source: string) {
  const host = packageArtifact.instantiate();
  try {
    const result = host.parse(source);
    assert.ok(result.ok, `native status ${result.status}`);
    return result.typed;
  } finally {
    host.close();
  }
}
function fn(instance: WebAssembly.Instance, name: string) {
  const value = instance.exports[`a0_${name}`];
  assert.equal(typeof value, 'function', name);
  return value as (...args: number[]) => number;
}
async function ioModule(bytes: Uint8Array, layout: WasmLayout) {
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
  const memory = instance.exports.memory,
    base = instance.exports.__heap_base;
  assert.ok(memory instanceof WebAssembly.Memory && base instanceof WebAssembly.Global);
  const pointer = Number(base.value) >>> 0,
    words = layout.ioInputCapacity + layout.ioOutputCapacity + 3;
  const end = pointer + words * 4;
  if (end > memory.buffer.byteLength)
    memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
  return (name: string, input: readonly number[]) => {
    assert.ok(input.length <= layout.ioInputCapacity);
    const io = new Uint32Array(memory.buffer, pointer, words);
    io.fill(0);
    io.set(input);
    io[layout.ioInputCapacity] = input.length;
    const code = fn(instance, name)(pointer) >>> 0;
    const result = new Uint32Array(memory.buffer, pointer, words);
    const n = result[words - 1] as number;
    assert.ok(n <= layout.ioOutputCapacity);
    return {
      code,
      position: result[layout.ioInputCapacity + 1],
      out: result.subarray(layout.ioInputCapacity + 2, layout.ioInputCapacity + 2 + n),
    };
  };
}

test('native checked-IR Wasm setup and site tool cache use the pinned runtime package without another source reader', {
  timeout: 900_000,
}, async () => {
  await tools();
});

test('native table backend matches old setup and independent checked arithmetic and Life IO oracles', {
  timeout: 900_000,
}, async () => {
  const executables = await tools();
  const layout = { ioInputCapacity: 35, ioOutputCapacity: 32 };
  const checked = checkedCases();
  const lifeSource = await readFile('examples/life.a0', 'utf8');
  const life = (await import(
    pathToFileURL(resolve('test/fixtures/arena-source-c/life-model.mjs')).href
  )) as {
    board(cells: number[][]): number[];
    model(
      rows: number[],
      command: number,
      x: number,
      y: number,
    ): { rows: number[]; population: number };
  };
  const inputs = [
    [
      life.board([
        [1, 0],
        [2, 1],
        [0, 2],
        [1, 2],
        [2, 2],
      ]),
      0,
      0,
      0,
    ],
    [
      life.board([
        [31, 31],
        [0, 31],
        [1, 31],
      ]),
      0,
      7,
      13,
    ],
    [
      life.board([
        [31, 31],
        [0, 0],
      ]),
      1,
      0xffffffff,
      0xffffffff,
    ],
    [Array(32).fill(0xffffffff) as number[], 2, 0xffffffff, 0xffffffff],
  ] as const;
  const modules = [];
  for (const optimize of [false, true]) {
    for (const [label, source] of [
      ['checked', CHECKED_SOURCE],
      ['life', lifeSource],
    ] as const) {
      const program = nativeProgram(source),
        reference = parseAndValidate(source);
      const actual = a0WasmFromTables(executables.native, program, layout, optimize);
      const baseline = a0WasmFromTables(executables.legacy, reference, layout, optimize);
      assert.deepEqual(
        actual.bytes,
        baseline.bytes,
        `${label}: independent native/old setup parity`,
      );
      assert.deepEqual(
        actual.bytes,
        typescriptWasm(reference, layout, optimize),
        `${label}: TS reference parity`,
      );
      modules.push({
        label,
        optimize,
        bytes: actual.bytes.length,
        sha256: sha256(actual.bytes),
        chunks: actual.chunks,
      });
      await writeFile(join(scratch, `${label}-${optimize}.wasm`), actual.bytes);
      if (label === 'checked') {
        const { instance } = await WebAssembly.instantiate(actual.bytes as BufferSource, {});
        for (const c of checked)
          assert.equal(
            fn(instance, c.functionName)(...c.args.map(Number)) >>> 0,
            Number(c.expected) >>> 0,
          );
      } else {
        const run = await ioModule(actual.bytes, layout);
        for (const [rows, command, x, y] of inputs) {
          const expected = life.model(rows, command, x, y),
            result = run('life', [...rows, command, x, y]);
          assert.equal(result.code, expected.population);
          assert.equal(result.position, 35);
          assert.deepEqual([...result.out], expected.rows);
        }
      }
    }
  }
  const strict = nativeProgram('profile strict\nfn half\nret div A 2\nend\n');
  for (const optimize of [false, true])
    assert.throws(
      () => a0WasmFromTables('tool-must-not-run', strict, layout, optimize),
      (error: unknown) => error instanceof A0Error && error.id === 'A0713',
    );
  observations.programs = {
    modules,
    checkedOracleCasesPerOptimizerSetting: checked.length,
    lifeCasesPerOptimizerSetting: inputs.length,
    strictRefusal: 'A0713 before transport, both optimizer settings',
  };
});

test('actual A0 emitter closure compiles to Wasm and drives the same checked-IR table adapter', {
  timeout: 900_000,
}, async () => {
  const executables = await tools();
  const layout = {
    ioInputCapacity: WASM_TOOL_INPUT,
    ioOutputCapacity: WASM_TOOL_OUTPUT,
    exports: ['emitwasmio'],
  };
  const image = a0WasmFromTables(executables.native, executables.compiler, layout);
  await writeFile(join(scratch, 'selfhost-emitter.wasm'), image.bytes);
  assert.ok(WebAssembly.validate(image.bytes as BufferSource));
  const run = await ioModule(image.bytes, layout);
  const modes: number[] = [];
  const transport: WasmToolTransport = (words) => {
    modes.push(words[0] as number);
    const result = run('emitwasmio', words);
    assert.equal(result.position, words.length);
    return { code: result.code, out: result.out };
  };
  const source = 'fn body\nret add A B\nend\nfn probe\nr fold body 7 A\nret r\nend\n';
  const program = nativeProgram(source),
    small = { ioInputCapacity: 1, ioOutputCapacity: 1 };
  for (const optimize of [false, true]) {
    const expected = a0WasmFromTables(executables.native, program, small, optimize);
    const actual = a0WasmFromTables(transport, program, small, optimize);
    assert.deepEqual(actual.bytes, expected.bytes);
    assert.deepEqual(
      actual.bytes,
      typescriptWasm(
        parseAndValidate(
          'fn body u32 u32 -> u32\nret add p0 p1\nend\nfn probe u32 -> u32\nr fold body 7 p0\nret r\nend\n',
        ),
        small,
        optimize,
      ),
    );
    const { instance } = await WebAssembly.instantiate(actual.bytes as BufferSource, {});
    for (const value of [0, 1, 0xffffffff])
      assert.equal(fn(instance, 'probe')(value) >>> 0, (value + 21) >>> 0);
  }
  assert.ok(
    modes.includes(2) && modes.includes(3) && modes.includes(7),
    'optimizer cache is bound to its transport',
  );
  observations.selfhost = {
    bytes: image.bytes.length,
    sha256: sha256(image.bytes),
    chunks: image.chunks,
    compilerFunctions: executables.compiler.functions.length,
    modes,
    realModuleExecution: true,
  };
});

test('native site program graphs preserve page/cache/prerender and docs modules against independent old setup', {
  timeout: 900_000,
}, async () => {
  const executables = await tools();
  const frontend = packageArtifact.instantiate(),
    load = nativeSourceGraphLoader(frontend);
  try {
    const notes: boolean[] = [],
      code = codeDigest(['tools/site-build.ts']);
    const keys: Keys = {
      cache,
      tool: sha256(await readFile(toolFile(executables.native))),
      code,
      note: (hit) => notes.push(hit),
      load,
    };
    const nativeOutput = join(scratch, 'site-native'),
      oldOutput = join(scratch, 'site-old');
    await mkdir(nativeOutput, { recursive: true });
    await mkdir(oldOutput, { recursive: true });
    const page = await buildProgram(executables.native, 'page.a0', 'page', keys, nativeOutput);
    const hit = await buildProgram(
      'tool-must-not-run-on-page-cache-hit',
      'page.a0',
      'page',
      keys,
      nativeOutput,
    );
    assert.deepEqual(hit, page);
    assert.deepEqual(notes, [false, true]);
    const baseline = await buildProgram(
      executables.legacy,
      'page.a0',
      'page',
      { cache: openCache({ enabled: false }), tool: 'old', code, note: () => undefined },
      oldOutput,
    );
    assert.deepEqual(page, baseline);
    assert.deepEqual(
      await readFile(join(nativeOutput, 'page.wasm')),
      await readFile(join(oldOutput, 'page.wasm')),
    );
    await assert.rejects(
      buildProgram(
        executables.native,
        'page.a0',
        'page',
        {
          ...keys,
          load: (entry, read, options) =>
            load(
              entry,
              async (path) =>
                path.endsWith('/page.a0') ? 'fn broken\nx add\nret x\nend\n' : read(path),
              options,
            ),
        },
        nativeOutput,
      ),
    );
    assert.deepEqual(notes, [false, true], 'bad current source never reaches the cache');
    const docs = await buildProgram(executables.native, 'docs.a0', 'docs', keys, nativeOutput);
    const oldDocs = await link('site/docs.a0', (path) => readFile(path, 'utf8'), { root: '.' });
    assert.deepEqual(
      { html: docs.html, css: docs.css, text: docs.text },
      prerender(oldDocs.program),
    );
    const bytes = await readFile(join(nativeOutput, 'docs.wasm'));
    assert.deepEqual(
      bytes,
      Buffer.from(
        a0WasmFromTables(
          executables.legacy,
          oldDocs.program,
          { ioInputCapacity: 1024, ioOutputCapacity: 131072 },
          true,
        ).bytes,
      ),
    );
    observations.site = {
      page: await fileFacts(join(nativeOutput, 'page.wasm')),
      docs: await fileFacts(join(nativeOutput, 'docs.wasm')),
      pageCacheMissThenHit: true,
      currentSourceCheckedBeforeHit: true,
      prerenderParity: true,
    };
  } finally {
    frontend.close();
  }
});

test.after(async () => {
  await writeReport(join(scratch, 'observations.json'), {
    packageManifestSHA256: identity,
    packageArtifactBytes: packageArtifact.artifactBytes,
    suppliedArtifactEpoch:
      'separately frozen runtime package; no fresh combined-build provenance claim',
    ...observations,
  });
});
