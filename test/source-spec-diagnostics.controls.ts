/** Actual optional renderer controls. Missing artifacts are errors, never skips. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { A0Error, validate } from '../src/core.js';
import { parseSource } from '../src/source.js';
import { linkSource } from '../src/source-link.js';
import { type NativeApi, nativeSourceApi } from '../src/source-native.js';
import { linkNativeSource, NativeSourceError } from '../src/source-native-link.js';
import { nativeDiagnosticRenderer } from '../src/source-native-render.js';
import { prepareSourceDiagnostic, prepareSourceFrontend } from '../tools/source-native-load.js';

const frontendPath = process.env.A0_SPEC_FRONTEND;
const rendererPath = process.env.A0_SPEC_RENDERER;
assert.ok(frontendPath && rendererPath, 'A0_SPEC_FRONTEND/A0_SPEC_RENDERER required');
const renderer = await prepareSourceDiagnostic(rendererPath);
const frontend = await prepareSourceFrontend(frontendPath, { load: renderer.load });

const cases = [
  'fn f\nex 1 -> 2\nx add A 2\nret x\nend\n',
  'fn f\nex 1 -> 2\nex 1 -> 2\nex 1 -> 2\nx add A 2\nret x\nend\n',
  ...[1, 2].map((n) => `fn f\n${'ex 1 -> 2\n'.repeat(4)}x add A ${n}\nret x\nend\n`),
  'fn f -> bool\nex -> false\nret true\nend\n',
  'fn f\nex 1 2 -> 4\nx add A B\nret x\nend\n',
  'fn f\nex 1 -> 2\nex 3 -> 7\nx add A 1\nret x\nend\n',
  'fn f\nex 1 -> 2\nex 3 -> 4\nex 5 -> 7\nx add A 1\nret x\nend\n',
  'fn f\nex 4294967295 -> 1\nx add A 1\nret x\nend\n',
  'fn f bool -> bool\nex false -> true\nret A\nend\n',
  'fn helper\nret A\nend\nfn next\nex 4 -> 2\nx helper A\nret x\nend\n',
  'fn f -> _x2\nex -> [1 2]\na [2 3]\nret a\nend\n',
  'fn f _x2 -> _\nex [1 2] -> 9\nx get A 0\nret x\nend\n',
  'fn f _x2 -> _x2\nex [1 2] -> [2 1]\nret A\nend\n',
  'fn f (_,bool) -> (_,bool)\nex (7 false) -> (8 true)\nret A\nend\n',
  'fn f -> (_,bool)\nex -> (1 true)\na (2 false)\nret a\nend\n',
  'fn f _x2x2 -> _\nex [[1 2] [3 4]] -> 9\nx get A 1\ny get x 1\nret y\nend\n',
  'fn f -> _x2x2\nex -> [[1 2] [3 4]]\na [5 6]\nb [7 8]\nc [a b]\nret c\nend\n',
  'fn f (_,bool)x2 -> (_,bool)x2\nex [(1 false) (2 true)] -> [(2 true) (1 false)]\nret A\nend\n',
  'fn f (u32) -> (u32)\nex (7,) -> (8,)\nret A\nend\n',
  'fn f boolx2 -> boolx2\nex [true false] -> [false true]\nret A\nend\n',
];

// Fixed boundary corpus: page-crossing values and nested aggregate shapes.
for (const width of [1, 3, 63, 64, 65, 127, 128, 129]) {
  const input = Array.from({ length: width }, (_, i) => i).join(' ');
  const expected = Array.from({ length: width }, (_, i) => i + 1).join(' ');
  cases.push(`fn f _x${width} -> _x${width}\nex [${input}] -> [${expected}]\nret A\nend\n`);
}

test('native spec rendering preserves exact JSON, locations and detached snapshots', () => {
  const engine = frontend.instantiate();
  try {
    for (const source of cases.flatMap((source) => [source, `# Ω😀\n\n${source}`])) {
      let expected: A0Error | undefined;
      try {
        validate(parseSource(source));
      } catch (error) {
        assert.ok(error instanceof A0Error);
        expected = error;
      }
      assert.ok(expected);
      const result = engine.parse(source);
      assert.ok(!result.ok && result.diagnostic?.rendered.ok, source);
      assert.deepEqual(result.diagnostic.rendered.error.toJSON(), expected.toJSON());
      const saved = JSON.stringify(result);
      assert.ok(engine.parse('fn identity\nret A\nend\n').ok);
      assert.equal(JSON.stringify(result), saved);
    }
  } finally {
    engine.close();
  }
});

test('native spec renderer retains explicit refusal for runtime trap cases', () => {
  const engine = frontend.instantiate();
  try {
    for (const source of ['profile strict\nfn f\nex 0 -> 1\nx div 1 A\nret x\nend\n']) {
      const result = engine.parse(source);
      assert.ok(!result.ok);
      assert.equal(result.diagnostic?.rendered.ok, false);
    }
  } finally {
    engine.close();
  }
});

test('linked spec failures preserve reference errors in the owning dependency', async () => {
  const engine = frontend.instantiate();
  try {
    for (const source of [cases[0], cases[2], ...cases.slice(11)]) {
      assert.ok(source);
      const files = new Map([
        ['/spec/child.a0', source],
        ['/spec/main.a0', 'use "child.a0"\nfn main\nret 0\nend\n'],
      ]);
      const read = async (path: string) => {
        const result = files.get(path);
        assert.notEqual(result, undefined);
        return result as string;
      };
      const options = { root: '/spec', canonicalPath: async (path: string) => path };
      let expected: A0Error | undefined;
      try {
        await linkSource('/spec/main.a0', read, options);
      } catch (error) {
        assert.ok(error instanceof A0Error);
        expected = error;
      }
      assert.ok(expected);
      await assert.rejects(linkNativeSource('/spec/main.a0', read, engine, options), (error) => {
        assert.ok(error instanceof NativeSourceError && error.a0Error, source);
        assert.deepEqual(error.a0Error.toJSON(), expected.toJSON());
        return true;
      });
    }
  } finally {
    engine.close();
  }
});

test('aggregate diagnostic rendering refuses malformed live arena values', async () => {
  const module = new WebAssembly.Module(
    await readFile(join(frontendPath as string, 'frontend.wasm')),
  );
  const source = 'fn f boolx2 -> boolx2\nex [true false] -> [false true]\nret A\nend\n';
  const changes: ((
    context: Uint32Array,
    view: (handle: number) => Uint32Array,
    state: readonly number[],
  ) => void)[] = [
    (c) => {
      c[19] = 0xffffffff;
    },
    (c) => {
      c[17] = 2;
    },
    (c) => {
      c[17] = 0xffffffff;
    },
    (c, view) => {
      view(c[18] as number)[0] = 3;
    },
    (c, view) => {
      view(c[18] as number)[2] = 2;
    },
    (c, view) => {
      view(c[18] as number)[1] = 3;
    },
    (c) => {
      c[18] = 0xffffffff;
    },
  ];
  for (const change of changes) {
    const api = new WebAssembly.Instance(module).exports as unknown as NativeApi;
    const engine = nativeSourceApi(api);
    try {
      const result = engine.parse(source);
      assert.ok(!result.ok && result.state[127]);
      const view = (handle: number) =>
        new Uint32Array(
          api.memory.buffer,
          api.frontend_view(handle),
          api.frontend_view_length(handle),
        );
      const context = view(result.state[127] as number);
      change(context, view, result.state);
      const rendered = nativeDiagnosticRenderer(api, { load: renderer.load }).snapshot(
        result.state,
      );
      assert.equal(rendered.rendered.ok, false);
      assert.ok('packet' in rendered);
      assert.notEqual(rendered.packet.status, 0);
      assert.equal(rendered.packet.json.length, 0);
      assert.ok(engine.parse('fn identity\nret A\nend\n').ok);
    } finally {
      engine.close();
    }
  }
});
