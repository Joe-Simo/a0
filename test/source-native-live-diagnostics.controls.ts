/** Explicit integration controls; three artifact paths are required and no control skips. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { type Func, formatSource, isPrimitive, LIMITS, type Type } from '../src/core.js';
import { A0Error, diag } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { type DirectFunction, directSource } from '../src/source-direct.js';
import { linkSource } from '../src/source-link.js';
import { nativeSource } from '../src/source-native.js';
import { linkNativeSource, NativeSourceError } from '../src/source-native-link.js';
import type { NativeDiagnosticOptions } from '../src/source-native-render.js';
import { prepareSourceDiagnostic, prepareSourceFrontend } from '../tools/source-native-load.js';

const frontendPath = process.env.A0_LIVE_DIAGNOSTIC_FRONTEND,
  rendererPath = process.env.A0_LIVE_DIAGNOSTIC_RENDERER,
  arenaPath = process.env.A0_LIVE_DIAGNOSTIC_ARENA;
assert.ok(
  frontendPath && rendererPath && arenaPath,
  'A0_LIVE_DIAGNOSTIC_FRONTEND/RENDERER/ARENA required',
);
const renderer = await prepareSourceDiagnostic(rendererPath);
const native = await prepareSourceFrontend(frontendPath);
assert.equal(native.build.diagnosticPorts, 'arena-v1');
const frontendModule = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const baselineModule = new WebAssembly.Module(await readFile('seed/source-frontend/frontend.wasm'));
const arenaModule = new WebAssembly.Module(await readFile(arenaPath));
const linked = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const names = [
  'arena_parse_verify_begin',
  'arena_source_unit',
  'arena_verify_resume',
  'arena_verify_status',
  'arena_verify_begin',
  'source_ir_init',
  'source_ir_symbol',
  'source_ir_type',
];
const words = (type: Type): number =>
  isPrimitive(type)
    ? 1
    : type.kind === 'arr'
      ? type.length * words(type.elem)
      : type.fields.reduce((sum, field) => sum + words(field), 0);
const value = (type: Type) => ({ words: words(type), scalar: isPrimitive(type) });
const functions: Record<string, DirectFunction> = {};
for (const name of names) {
  const fn = linked.program.byName.get(name);
  assert.ok(fn, name);
  functions[name] = { params: fn.params.map(value), result: value(fn.result) };
}
const directModule = new WebAssembly.Module(
  Buffer.from(
    compile(linked.program, 'wasm', {
      wasmExports: names,
      wasmSimd: true,
      optimize: true,
      wasmIo: { module: 'a0_arena', read: 'a0_runtime_read', write: 'a0_runtime_write' },
    }).text,
    'base64',
  ),
);
const factories = [
  ['C-derived', (options?: NativeDiagnosticOptions) => nativeSource(frontendModule, options)],
  [
    'direct',
    (options?: NativeDiagnosticOptions) =>
      directSource({ frontend: directModule, arena: arenaModule, functions }, options),
  ],
] as const;
const fixtures = JSON.parse(
  await readFile('test/fixtures/native-diagnostics/packets.json', 'utf8'),
) as {
  cases: { name: string; source: string; status: number; jsonText: string }[];
};
const simple = 'fn identity\nret A\nend\n';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

for (const [backend, factory] of factories) {
  test(`${backend}: actual live A0 renderer preserves catalog errors, fixes and immutable failure snapshots`, () => {
    let loads = 0;
    const engine = factory({
      load: () => {
        loads++;
        return renderer.load();
      },
    });
    const raw = factory();
    try {
      assert.ok(engine.parse(simple).ok);
      const unit = engine.parseUnit(simple);
      assert.ok(unit.ok);
      assert.ok(engine.checkProgram(unit.program).ok);
      assert.ok(engine.checkUnits([unit], 'canonical').ok);
      assert.ok(raw.parse(simple).ok);
      const rawUnit = raw.parseUnit(simple);
      assert.ok(rawUnit.ok);
      assert.ok(raw.checkProgram(rawUnit.program).ok);
      assert.ok(raw.checkUnits([rawUnit], 'canonical').ok);
      assert.equal(loads, 0, 'success must not compile or instantiate the renderer');
      assert.equal(engine.memoryBytes, raw.memoryBytes, 'success retains no renderer memory');
      for (const fixture of fixtures.cases.filter((row) => row.status === 0)) {
        const expected = raw.parse(fixture.source),
          actual = engine.parse(fixture.source);
        assert.ok(!actual.ok && !expected.ok, fixture.name);
        assert.deepEqual(actual.state, expected.state, `${fixture.name}: parsed state unchanged`);
        assert.deepEqual(
          actual.specState,
          expected.specState,
          `${fixture.name}: spec state unchanged`,
        );
        const snapshot = actual.diagnostic;
        assert.ok(snapshot && 'packet' in snapshot && snapshot.rendered.ok, fixture.name);
        assert.deepEqual(
          snapshot.rendered.error.toJSON(),
          JSON.parse(fixture.jsonText),
          fixture.name,
        );
        const retained = JSON.stringify(actual);
        const jsonHash = hash(snapshot.packet.json);
        const good = engine.parse(simple);
        assert.ok(good.ok);
        assert.equal(
          formatSource(good.program),
          formatSource(
            (raw.parse(simple) as Extract<ReturnType<typeof raw.parse>, { ok: true }>).program,
          ),
        );
        assert.equal(
          JSON.stringify(actual),
          retained,
          'next parse must not mutate a prior failure',
        );
        assert.equal(hash(snapshot.packet.json), jsonHash, 'JSON is detached from arena storage');
      }
      assert.equal(loads, 1, 'renderer instance is reused');
      const failed = engine.parse(fixtures.cases.find((row) => row.status === 0)?.source ?? '');
      const retained = JSON.stringify(failed);
      engine.close();
      assert.equal(JSON.stringify(failed), retained, 'close must not mutate a prior diagnostic');
    } finally {
      engine.close();
      raw.close();
    }
  });

  test(`${backend}: explicit refusals preserve resource/spec facts and renderer options`, () => {
    let loads = 0;
    const engine = factory({
      load: () => {
        loads++;
        return renderer.load();
      },
    });
    const raw = factory();
    try {
      const resource = engine.parse(simple, 0),
        expectedResource = raw.parse(simple, 0);
      assert.ok(!resource.ok && !expectedResource.ok);
      assert.deepEqual(resource.state, expectedResource.state);
      assert.deepEqual(resource.specState, expectedResource.specState);
      assert.ok(resource.diagnostic && !resource.diagnostic.rendered.ok);
      assert.equal(loads, 1, 'a live exhausted arena may explicitly refuse rendering');
      const source = 'fn wrong\nex 1 -> 9\nx add A 1\nret x\nend\n';
      const spec = engine.parse(source),
        expected = raw.parse(source);
      assert.ok(!spec.ok && !expected.ok);
      assert.deepEqual(spec.state, expected.state);
      assert.deepEqual(spec.specState, expected.specState);
      assert.ok(
        spec.diagnostic && !spec.diagnostic.rendered.ok,
        'spec catalog remains unsupported explicitly',
      );
      assert.ok(engine.parse(simple).ok, 'render refusal must not prevent next session');
    } finally {
      engine.close();
      raw.close();
    }
    const unknownOptions = factory({ load: renderer.load, options: 2 });
    try {
      const result = unknownOptions.parse('fn f\nret missing\nend\n');
      assert.ok(!result.ok && result.diagnostic && 'packet' in result.diagnostic);
      assert.equal(result.diagnostic.packet.status, 7);
      assert.equal(result.diagnostic.packet.json.length, 0);
      assert.ok(!result.diagnostic.rendered.ok);
    } finally {
      unknownOptions.close();
    }
    const repairsOff = factory({ load: renderer.load, options: 0 });
    try {
      const chain = fixtures.cases.find((row) => row.name === 'associative-chain');
      assert.ok(chain);
      const result = repairsOff.parse(chain.source);
      assert.ok(!result.ok && result.diagnostic?.rendered.ok);
      assert.deepEqual(
        result.diagnostic.rendered.error.edits,
        [],
        'A0 option 0 suppresses new exact repairs',
      );
    } finally {
      repairsOff.close();
    }
  });

  test(`${backend}: linked unit and graph failures retain authoritative errors, edits and byte/UTF16 owners`, async () => {
    const engine = factory({ load: renderer.load });
    const root = '/native-live';
    const options = { root, canonicalPath: async (path: string) => path };
    const controls = [
      new Map([[`${root}/entry.a0`, '# λ😀\nfn f\nx add missing 1\nret x\nend\n']]),
      new Map([
        [`${root}/dep.a0`, '# λ😀\nfn helper\nret A\nend\n'],
        [`${root}/entry.a0`, 'use "dep.a0"\n# λ😀\nfn f -> bool\nret 1\nend\n'],
      ]),
      new Map([[`${root}/entry.a0`, '# λ😀\nfn f\nx add 1 2 3\nret x\nend\n']]),
      new Map([
        [`${root}/dep.a0`, '# λ😀\nfn helper\nx add 1 2 3\nret x\nend\n'],
        [`${root}/entry.a0`, 'use "dep.a0"\n# entry λ😀\nfn f\nret A\nend\n'],
      ]),
    ];
    try {
      for (const files of controls) {
        const read = async (path: string) => {
          const text = files.get(path);
          assert.notEqual(text, undefined);
          return text as string;
        };
        let reference: A0Error | undefined;
        try {
          await linkSource(`${root}/entry.a0`, read, options);
        } catch (error) {
          assert.ok(error instanceof A0Error);
          reference = error;
        }
        assert.ok(reference, 'independent graph failure');
        await assert.rejects(
          linkNativeSource(`${root}/entry.a0`, read, engine, options),
          (error: unknown) => {
            assert.ok(error instanceof NativeSourceError);
            assert.ok(error.a0Error && error.rendered?.ok, 'supported catalog error required');
            assert.deepEqual(error.a0Error.toJSON(), reference.toJSON());
            assert.equal(error.message, reference.message);
            const location = error.rendered.location;
            assert.ok(location.path);
            const owner = files.get(location.path);
            assert.ok(owner !== undefined);
            const combined = 'origins' in error.result ? [...files.values()].join('\n') : owner;
            const beforeOwner = combined.indexOf(owner);
            assert.ok(beforeOwner >= 0);
            const bytes = new TextEncoder().encode(combined);
            const absoluteUtf16 = new TextDecoder('utf-8', { fatal: true }).decode(
              bytes.subarray(0, location.byteStart),
            ).length;
            assert.equal(location.utf16Start, absoluteUtf16, 'exact absolute UTF16 offset');
            assert.equal(
              location.localUtf16Start,
              absoluteUtf16 - beforeOwner,
              'exact owner UTF16 offset',
            );
            assert.equal(
              location.localByteStart,
              location.byteStart - new TextEncoder().encode(combined.slice(0, beforeOwner)).length,
            );
            assert.equal(
              location.localLine,
              owner.slice(0, location.localUtf16Start).split('\n').length,
            );
            assert.equal(location.path, error.path);
            return true;
          },
        );
      }
      const duplicates = new Map([
        [`${root}/dep.a0`, 'fn same\nret A\nend\n'],
        [`${root}/entry.a0`, 'use "dep.a0"\nfn same\nret A\nend\n'],
      ]);
      const readDuplicates = async (path: string) => {
        const text = duplicates.get(path);
        assert.ok(text !== undefined);
        return text;
      };
      let ownershipError: A0Error | undefined;
      try {
        await linkSource(`${root}/entry.a0`, readDuplicates, options);
      } catch (error) {
        assert.ok(error instanceof A0Error);
        ownershipError = error;
      }
      assert.ok(ownershipError);
      await assert.rejects(
        linkNativeSource(`${root}/entry.a0`, readDuplicates, engine, options),
        (error: unknown) => {
          assert.ok(
            error instanceof A0Error,
            'duplicate ownership remains the shared graph diagnostic',
          );
          assert.deepEqual(error.toJSON(), ownershipError.toJSON());
          return true;
        },
      );
    } finally {
      engine.close();
    }
  });

  test(`${backend}: global native failures retain unowned facts and complete catalog errors`, () => {
    const engine = factory({ load: renderer.load });
    const fn: Func = {
      name: 'f',
      params: [],
      result: 'u32',
      nodes: [],
      ret: { kind: 'u32', value: 0 },
    };
    try {
      // Global count must win even over the repeated function names that follow it.
      const result = engine.checkProgram(
        { functions: Array<Func>(LIMITS.maxFunctions + 1).fill(fn) },
        0xffff_ffff,
      );
      assert.ok(
        !result.ok &&
          result.diagnostic &&
          'packet' in result.diagnostic &&
          result.diagnostic.rendered.ok,
      );
      assert.equal(result.state[109], 0xffff_ffff);
      assert.equal(result.state[1], 29);
      assert.equal(result.diagnostic.packet.facts[7], 0xffff_ffff);
      const expected = diag('A0029').toJSON();
      assert.equal(result.diagnostic.packet.status, 0);
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(result.diagnostic.packet.json)),
        expected,
      );
      assert.deepEqual(result.diagnostic.rendered.error.toJSON(), expected);
      const error = new NativeSourceError(result, '/native-live/archive.a0', 1, [
        {
          path: '/native-live/archive.a0',
          firstLine: 1,
          lineCount: 1,
          byteStart: 0,
          byteLength: result.diagnostic.packet.facts[11] as number,
          utf16Start: 0,
        },
      ]);
      assert.deepEqual(
        error.a0Error?.toJSON(),
        expected,
        'global diagnostics have no guessed owner',
      );
      assert.deepEqual(error.rendered, result.diagnostic.rendered);
    } finally {
      engine.close();
    }
  });
}
test('ABI3 legacy artifacts remain usable and explicitly refuse unavailable diagnostic ports', () => {
  let loads = 0;
  const engine = nativeSource(baselineModule, {
    load: () => {
      loads++;
      return renderer.load();
    },
  });
  try {
    assert.ok(engine.parse(simple).ok);
    const failed = engine.parse('fn f\nret missing\nend\n');
    assert.ok(!failed.ok && failed.diagnostic && !failed.diagnostic.rendered.ok);
    assert.equal(failed.diagnostic.rendered.reason, 'unavailable');
    assert.equal(loads, 0);
  } finally {
    engine.close();
  }
});
