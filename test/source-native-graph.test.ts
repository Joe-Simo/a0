import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compile } from '../src/backends.js';
import { formatProgram, formatSource, type TypedProgram, validate } from '../src/core.js';
import { link } from '../src/link.js';
import { parseSource } from '../src/source.js';
import { linkSource } from '../src/source-link.js';
import { type NativeUnitResult, nativeSource } from '../src/source-native.js';
import { linkNativeSource, NativeSourceError } from '../src/source-native-link.js';
import { TARGETS } from '../src/targets.js';
import { nativeSourceArtifact } from '../tools/source-native-artifact.js';

async function linkedReference(sources: readonly string[]) {
  const files = new Map(
    sources.map((source, index) => [
      `/native-case/${index === sources.length - 1 ? 'entry' : `unit${index}`}.a0`,
      source,
    ]),
  );
  return linkSource(
    '/native-case/entry.a0',
    async (path) => {
      const source = files.get(path);
      assert.notEqual(source, undefined, path);
      return source as string;
    },
    { root: '/native-case', canonicalPath: async (path) => path },
  );
}
function backends(
  actual: TypedProgram,
  expected: TypedProgram,
  targets: readonly (typeof TARGETS)[number][] = ['c', 'js', 'wasm', 'x86_64'],
): void {
  assert.equal(formatProgram(actual), formatProgram(expected));
  for (const target of targets)
    assert.equal(compile(actual, target).text, compile(expected, target).text, target);
  for (const fn of actual.functions)
    for (const [name, callee] of fn.calls)
      assert.equal(callee, actual.byName.get(name), 'callee object identity');
}

test('native source artifact matches its complete source and native transport inputs', async () => {
  await nativeSourceArtifact();
});
test('native source graph composes imports, comments, literals, types and specs without another source parse', async () => {
  const frontend = nativeSource(await nativeSourceArtifact());
  try {
    const graphs = [
      [
        '# helper\nfn helper\nex 1 -> 2\na add A 1 # add\nret a\nend\n# between\n',
        'use "unit0.a0" # wrapper\n# empty wrapper tail\n',
        'use "unit1.a0" # import\n# top\nfn top\nex 1 -> 2\npre lt A 10\npost eq r 2\nx helper A\nret x\nend\n# final\n',
      ],
      [
        'fn helper (_,bool) -> (_,bool)\na at A 0\nb at A 1\nc (a b)\nret c\nend\n',
        'use "unit0.a0"\nfn top (_,bool) -> (_,bool)\nx helper A\nret x\nend\n',
      ],
      [
        'profile strict\nfn helper _x3 -> _x3\nex [7*3] -> [7 7 7]\nret A\nend\n',
        'profile strict\nuse "unit0.a0"\nfn top -> _x3\nex -> [7*3]\na [7*3]\nb helper a\nret b\nend\n',
      ],
    ];
    for (const sources of graphs) {
      const expected = await linkedReference(sources);
      const units = sources.map((source) => frontend.parseUnit(source));
      assert.ok(units.every((unit) => unit.ok));
      const result = frontend.checkUnits(units, expected.program.profile ?? 'canonical');
      assert.ok(result.ok, `status ${result.status}`);
      assert.equal(formatSource(result.program), formatSource(expected.program));
      assert.deepEqual(
        result.origins.map(({ firstLine, lineCount }) => ({ firstLine, lineCount })),
        expected.sources.map(({ startLine, lineCount }) => ({ firstLine: startLine, lineCount })),
      );
      backends(result.typed, expected.program);
      const failed = frontend.checkUnits(units, expected.program.profile ?? 'canonical', 0);
      assert.equal(failed.ok, false);
      assert.equal(failed.status, 4);
      assert.ok(
        frontend.checkUnits(units, expected.program.profile ?? 'canonical').ok,
        'snapshots survive later sessions',
      );
    }
  } finally {
    frontend.close();
  }
});
test('native source graph preserves one-unit specification outcomes and ordered failure facts', async () => {
  const frontend = nativeSource(await nativeSourceArtifact());
  try {
    const cases = JSON.parse(
      await readFile('experiments/unification/frontend-a0/spec-cases.json', 'utf8'),
    ) as string[];
    for (const source of cases) {
      let expected: TypedProgram | undefined;
      try {
        expected = validate(parseSource(source));
      } catch {
        /* Independent negative controls. */
      }
      const parsed = frontend.parseUnit(source);
      assert.ok(parsed.ok, `grammar rejected a spec control: ${parsed.status}`);
      const graph = frontend.checkUnits([parsed], 'canonical');
      const whole = frontend.parse(source);
      assert.equal(graph.ok, expected !== undefined);
      assert.equal(graph.status, whole.status);
      if (graph.ok) {
        assert.ok(expected);
        assert.equal(formatSource(graph.program), formatSource(expected));
        backends(graph.typed, expected);
      } else assert.deepEqual(graph.state.slice(0, 6), whole.state.slice(0, 6));
    }
    const sources = [
      'fn helper\nex 1 -> 9\na add A 1\nret a\nend\n',
      'fn top -> bool\nret 1\nend\n',
    ];
    const graph = frontend.checkUnits(
      sources.map((source) => frontend.parseUnit(source)),
      'canonical',
    );
    const whole = frontend.parse(sources.join('\n'));
    assert.equal(graph.ok, false);
    assert.equal(graph.status, whole.status);
    assert.deepEqual(
      graph.state.slice(0, 6),
      whole.state.slice(0, 6),
      'earlier dependency spec precedes later type failure',
    );
  } finally {
    frontend.close();
  }
});
test('native source units retain private IR across caller mutations and enforce ownership and closure', async () => {
  const module = await nativeSourceArtifact();
  const frontend = nativeSource(module),
    foreign = nativeSource(module);
  try {
    const source = '# original\nfn helper\na add A 1\nret a\nend\n';
    const unit = frontend.parseUnit(source);
    assert.ok(unit.ok);
    Reflect.set(unit.program.functions[0] as object, 'name', 'changed');
    Reflect.set(unit.program.functions[0] as object, 'comments', { leading: ['# changed'] });
    Reflect.set(unit.state, '0', 99);
    const result = frontend.checkUnits([unit], 'canonical');
    assert.ok(result.ok);
    assert.equal(formatSource(result.program), formatSource(parseSource(source)));
    assert.throws(() => foreign.checkUnits([unit], 'canonical'), /owned/);
    const failed = frontend.parseUnit('fn broken\nend\n');
    assert.equal(failed.ok, false);
    assert.throws(() => frontend.checkUnits([failed], 'canonical'), /owned/);
    assert.throws(
      () => frontend.checkUnits([{ ...unit } as NativeUnitResult], 'canonical'),
      /owned/,
    );
    frontend.close();
    assert.throws(() => frontend.checkUnits([unit], 'canonical'), /closed/);
  } finally {
    frontend.close();
    foreign.close();
  }
});
test('native source graph keeps every backend output for an independent call graph', async () => {
  const frontend = nativeSource(await nativeSourceArtifact());
  try {
    const sources = [
      'fn helper\na add A 1\nret a\nend\n',
      'use "unit0.a0"\nfn top\nx helper A\nret x\nend\n',
    ];
    const expected = await linkedReference(sources);
    const result = frontend.checkUnits(
      sources.map((source) => frontend.parseUnit(source)),
      'canonical',
    );
    assert.ok(result.ok);
    backends(result.typed, expected.program, TARGETS);
    const wrongOrder = frontend.checkUnits(
      [...sources].reverse().map((source) => frontend.parseUnit(source)),
      'canonical',
    );
    assert.equal(wrongOrder.ok, false, 'IR composition must not silently reorder functions');
  } finally {
    frontend.close();
  }
});
test('native source graph reconstructs and checks its actual compiler module graph', async () => {
  const frontend = nativeSource(await nativeSourceArtifact());
  try {
    const expected = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
    const sources = await Promise.all(
      expected.sources.map((source) => readFile(source.path, 'utf8')),
    );
    const result = frontend.checkUnits(
      sources.map((source) => frontend.parseUnit(source)),
      'canonical',
    );
    assert.ok(result.ok, `status ${result.status}`);
    assert.equal(formatSource(result.program), formatSource(expected.program));
    backends(result.typed, expected.program);
  } finally {
    frontend.close();
  }
});

test('native source dependency loader parses each file once and checks its IR once', async () => {
  const frontend = nativeSource(await nativeSourceArtifact());
  let parses = 0,
    checks = 0;
  const counted: ReturnType<typeof nativeSource> = {
    ...frontend,
    parse() {
      throw new Error('whole-source reparse is forbidden');
    },
    parseUnit(source, budget) {
      parses++;
      return frontend.parseUnit(source, budget);
    },
    checkUnits(units, profile, budget) {
      checks++;
      return frontend.checkUnits(units, profile, budget);
    },
  };
  const files = new Map([
    ['/native-case/unit0.a0', 'fn helper\na add A 1\nret a\nend\n'],
    ['/native-case/unit1.a0', 'use "unit0.a0"\nfn left\na helper A\nret a\nend\n'],
    ['/native-case/unit2.a0', 'use "unit0.a0"\nfn right\na helper A\nret a\nend\n'],
    [
      '/native-case/entry.a0',
      'use "unit1.a0"\nuse "unit2.a0"\nfn top\na left A\nb right a\nret b\nend\n',
    ],
  ]);
  const reads: string[] = [];
  const options = { root: '/native-case', canonicalPath: async (path: string) => path };
  const read = async (path: string): Promise<string> => {
    const source = files.get(path);
    assert.ok(source !== undefined, path);
    return source;
  };
  try {
    const result = await linkNativeSource(
      '/native-case/entry.a0',
      async (path) => {
        reads.push(path);
        return read(path);
      },
      counted,
      options,
    );
    const expected = await linkSource('/native-case/entry.a0', read, options);
    backends(result.program, expected.program);
    assert.equal(formatSource(result.program), formatSource(expected.program));
    assert.equal(parses, files.size);
    assert.equal(checks, 1);
    assert.equal(reads.length, files.size);
    assert.equal(new Set(reads).size, files.size);
    files.set('/native-case/entry.a0', 'use "unit0.a0"\n\n# origin\nfn top -> bool\nret 1\nend\n');
    await assert.rejects(
      linkNativeSource('/native-case/entry.a0', read, frontend, options),
      (error: unknown) => {
        assert.ok(error instanceof NativeSourceError);
        assert.equal(error.path, '/native-case/entry.a0');
        assert.equal(error.line, 5);
        assert.equal(error.diagnostic, 201);
        return true;
      },
    );
    files.set('/native-case/entry.a0', 'use "entry.a0"\nfn top\nret 0\nend\n');
    await assert.rejects(
      linkNativeSource('/native-case/entry.a0', read, frontend, options),
      /cycle/,
    );
    files.set('/native-case/entry.a0', 'use "../outside.a0"\nfn top\nret 0\nend\n');
    await assert.rejects(
      linkNativeSource('/native-case/entry.a0', read, frontend, options),
      /inside/,
    );
    files.set('/native-case/entry.a0', 'profile strict\nuse "unit0.a0"\nfn top\nret 0\nend\n');
    await assert.rejects(
      linkNativeSource('/native-case/entry.a0', read, frontend, options),
      /profile/,
    );
  } finally {
    frontend.close();
  }
});
