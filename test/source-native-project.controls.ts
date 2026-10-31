/** Actual C-derived frontend project retention, activation and lifecycle; no skipped controls. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatProgram, type Program, type TypedProgram } from '../src/core.js';
import { semanticRevision } from '../src/edit.js';
import { programRevision, revision } from '../src/revision.js';
import { formatSource, parseSourceUnit } from '../src/source.js';
import { linkSource } from '../src/source-link.js';
import {
  type NativeApi,
  type NativeUnitResult,
  nativeSource,
  nativeSourceApi,
} from '../src/source-native.js';
import {
  linkNativeSource,
  type NativeProjectFile,
  NativeSourceError,
  openNativeSourceProject,
} from '../src/source-native-link.js';
import { readWasmWords } from '../src/wasm-words.js';
import {
  prepareSourceDiagnostic,
  prepareSourceFormat,
  prepareSourceFrontend,
} from '../tools/source-native-load.js';

const frontendPath = process.env.A0_PROJECT_FRONTEND;
const formatPath = process.env.A0_PROJECT_FORMAT;
const diagnosticPath = process.env.A0_PROJECT_DIAGNOSTIC;
assert.ok(
  frontendPath && formatPath && diagnosticPath,
  'A0_PROJECT_FRONTEND/FORMAT/DIAGNOSTIC required',
);
const prepared = await prepareSourceFrontend(frontendPath);
assert.equal(prepared.build.diagnosticPorts, 'arena-v1');
const frontend = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const formatting = await prepareSourceFormat(formatPath);
const diagnostics = await prepareSourceDiagnostic(diagnosticPath);
const engine = () => nativeSource(frontend, diagnostics, formatting);
const root = resolve('.a0-tmp/project-fixture');
const options = { root, canonicalPath: async (path: string) => path };

function graph(strict = false): Map<string, string> {
  const profile = strict ? '# profile Ω\nprofile strict # declaration\n' : '';
  return new Map([
    [
      join(root, 'lib/λ.a0'),
      `${profile}# imported helper 😀\nfn addone\nex 0 -> 1 # example\npre lt A 100\npost gt r A\na add A 1 # arithmetic\nret a # returned\nend # helper end\n# helper tail\n`,
    ],
    [
      join(root, 'wrapper.a0'),
      `${profile}# empty wrapper\nuse "lib/λ.a0" # wrapper import\n# empty wrapper tail Ω\n`,
    ],
    [
      join(root, 'other.a0'),
      `${profile}use "lib/λ.a0" # diamond import\n# twice\nfn twice\nex 3 -> 5\npre lt A 90\npost gt r A\na addone A\nb addone a\nret b\nend\n# other tail\n`,
    ],
    [
      join(root, 'entry.a0'),
      `${profile}# entry Ω\nuse "wrapper.a0" # empty dependency\nuse "other.a0" # shared helper\nfn top\nex 3 -> 5\nr twice A\nret r\nend\n# entry tail 😀\n`,
    ],
  ]);
}
const entry = join(root, 'entry.a0');
const readFrom =
  (files: ReadonlyMap<string, string>) =>
  async (path: string): Promise<string> => {
    const source = files.get(path);
    assert.notEqual(source, undefined, path);
    return source as string;
  };
function checkedOutput(actual: TypedProgram, expected: TypedProgram): void {
  assert.equal(formatProgram(actual), formatProgram(expected));
  for (const target of ['c', 'js', 'wasm'] as const)
    assert.equal(compile(actual, target).text, compile(expected, target).text, target);
}

test('one-shot linking shares native checking and returns detached Linked data without retained project authority', async () => {
  const host = engine();
  let parses = 0,
    checks = 0;
  const wrapped: ReturnType<typeof nativeSource> = {
    ...host,
    parseUnit(source, budget) {
      parses++;
      return host.parseUnit(source, budget);
    },
    checkUnits(units, profile, budget) {
      checks++;
      return host.checkUnits(units, profile, budget);
    },
  };
  try {
    for (const strict of [false, true]) {
      const files = graph(strict);
      const reference = await linkSource(entry, readFrom(files), options);
      const linked = await linkNativeSource(entry, readFrom(files), wrapped, {
        ...options,
        includeUnits: true,
      });
      assert.equal('native' in linked, false);
      assert.equal('checkGraph' in linked, false);
      assert.equal('files' in linked, false);
      checkedOutput(linked.program, reference.program);
      assert.deepEqual(linked.sources, reference.sources);
      assert.equal(linked.units?.length, reference.units?.length ?? 4);
      const serialized = formatSource(linked.program);
      host.parse('fn unrelated\nret A\nend\n');
      assert.equal(
        formatSource(linked.program),
        serialized,
        'one-shot output survives later native resets',
      );
    }
    assert.equal(parses, 8);
    assert.equal(checks, 2);
    const retained = await openNativeSourceProject(entry, readFrom(graph()), host, options);
    assert.ok('native' in retained);
    const file = retained.native.files[0];
    assert.ok(file);
    assert.ok(retained.native.activateFileForFormat(file).ok);
    retained.native.close();
  } finally {
    host.close();
  }
});

for (const strict of [false, true])
  test(`project retains ${strict ? 'strict' : 'canonical'} file ownership and rechecks the full graph after explicit activations`, async () => {
    const host = engine();
    let parses = 0,
      checks = 0,
      reads = 0,
      loaded = false;
    const wrapped: ReturnType<typeof nativeSource> = {
      ...host,
      parseUnit(source, budget) {
        assert.equal(loaded, false, 'project operation reparsed a file');
        parses++;
        return host.parseUnit(source, budget);
      },
      checkUnits(units, profile, budget) {
        checks++;
        return host.checkUnits(units, profile, budget);
      },
    };
    try {
      const files = graph(strict);
      const read = readFrom(files);
      const reference = await linkSource(entry, read, options);
      const linked = await openNativeSourceProject(
        entry,
        async (path) => {
          assert.equal(loaded, false, 'project operation reread a file');
          reads++;
          return read(path);
        },
        wrapped,
        { ...options, includeUnits: true },
      );
      loaded = true;
      const project = linked.native;
      assert.equal(parses, 4);
      assert.equal(reads, 4);
      assert.equal(checks, 1);
      assert.equal(project.profile, strict ? 'strict' : 'canonical');
      assert.deepEqual(
        project.files.map((file) => file.path),
        reference.sources.map((source) => source.path),
      );
      checkedOutput(linked.program, reference.program);
      const initial = host.format(project.graph, { mapping: true });
      assert.ok(initial.ok);
      assert.equal(initial.text, formatSource(reference.program));
      const expectedGraph = initial.bytes.slice(),
        expectedEvents = initial.events.slice();
      const originalFiles = [...project.files];
      let previous: Parameters<typeof host.format>[0] = project.graph;
      for (let round = 0; round < 2; round++) {
        for (const file of originalFiles) {
          const local = parseSourceUnit(files.get(file.path) as string).program;
          const activated = project.activateFileForFormat(file);
          assert.ok(activated.ok);
          assert.equal('typed' in activated.input, false);
          assert.equal('ok' in activated.input, false);
          assert.throws(() => host.format(previous), /current result owned/);
          const output = host.format(activated.input, { mapping: true });
          assert.ok(output.ok);
          assert.equal(output.text, formatSource(local));
          const hash = host.revision(activated.input);
          assert.ok(hash.ok);
          assert.equal(hash.revision, programRevision(local));
          for (const [index, fn] of local.functions.entries()) {
            const own = host.revision(activated.input, { kind: 'function', functionIndex: index });
            assert.ok(own.ok);
            assert.equal(own.revision, revision(fn));
            const semantic = host.revision(activated.input, {
              kind: 'semantic',
              functionIndex: index,
            });
            assert.ok(
              !semantic.ok && 'status' in semantic,
              'local formatting creates no checked acceptance',
            );
          }
          assert.throws(
            () =>
              host.checkUnits([activated.input as unknown as NativeUnitResult], project.profile),
            /parsed unit owned/,
          );
          previous = activated.input;
        }
        const current = project.checkGraph();
        assert.ok(current.ok);
        assert.throws(() => host.format(previous), /current result owned/);
        checkedOutput(current.typed, reference.program);
        const output = host.format(current, { mapping: true });
        assert.ok(output.ok);
        assert.deepEqual(output.bytes, expectedGraph);
        assert.deepEqual(output.events, expectedEvents);
        const content = host.revision(current);
        assert.ok(content.ok);
        assert.equal(content.revision, programRevision(reference.program));
        const last = reference.program.functions.length - 1;
        const semantic = host.revision(current, { kind: 'semantic', functionIndex: last });
        assert.ok(semantic.ok);
        assert.equal(
          semantic.revision,
          semanticRevision(
            reference.program.functions[last] as NonNullable<
              (typeof reference.program.functions)[number]
            >,
          ),
        );
        previous = current;
      }
      assert.equal(parses, 4);
      assert.equal(reads, 4);
      assert.equal(checks, 3);
      // Attack nested objects before replacing outer fields: no retained metadata may alias them.
      for (const fn of linked.program.functions) {
        const metadata = fn.comments as { leading?: string[]; trailing?: string } | undefined;
        if (metadata?.leading?.length) metadata.leading[0] = '# forged graph comment';
        if (metadata) metadata.trailing = '# forged trailing comment';
        if (fn.afterComments?.length) (fn.afterComments as string[])[0] = '# forged graph tail';
      }
      for (const unit of linked.units ?? []) {
        for (const fn of unit.program.functions) {
          const metadata = fn.comments as { leading?: string[]; trailing?: string } | undefined;
          if (metadata?.leading?.length) metadata.leading[0] = '# forged local comment';
          if (metadata) metadata.trailing = '# forged local trailing';
          if (fn.afterComments?.length) (fn.afterComments as string[])[0] = '# forged local tail';
        }
        if (unit.program.profileComments?.leading?.length)
          (unit.program.profileComments.leading as string[])[0] = '# forged profile';
        for (const comments of unit.program.useComments ?? [])
          if (comments?.leading?.length) (comments.leading as string[])[0] = '# forged use';
      }
      const nestedRestored = project.checkGraph();
      assert.equal(formatSource(nestedRestored.typed), formatSource(reference.program));
      for (const file of originalFiles) {
        const activated = project.activateFileForFormat(file);
        assert.ok(activated.ok);
        const output = host.format(activated.input);
        assert.ok(output.ok);
        assert.equal(
          output.text,
          formatSource(parseSourceUnit(files.get(file.path) as string).program),
        );
      }
      // Replacing the public containers also cannot alter retained inputs.
      Object.assign(linked.program, { functions: [], byName: new Map(), profile: undefined });
      (project.graph.state as number[]).fill(0xffff_ffff);
      (project.graph.specState as number[]).fill(0xffff_ffff);
      Object.assign(project.graph.typed, { functions: [] });
      for (const unit of linked.units ?? [])
        Object.assign(unit.program, { functions: [], uses: ['outside.a0'], profile: undefined });
      assert.equal(Reflect.set(project, 'profile', 'forged'), false);
      assert.equal(Reflect.set(originalFiles[0] as NativeProjectFile, 'path', 'outside.a0'), false);
      assert.equal(Reflect.set(project.files, '0', {}), false);
      const restored = project.checkGraph();
      checkedOutput(restored.typed, reference.program);
      const final = host.format(restored, { mapping: true });
      assert.ok(final.ok);
      assert.deepEqual(final.bytes, expectedGraph);
      project.close();
      assert.throws(() => project.checkGraph(), /project is closed/);
      assert.throws(
        () => project.activateFileForFormat(originalFiles[0] as NativeProjectFile),
        /project is closed/,
      );
      assert.ok(
        host.format(restored).ok,
        'project closes retention, leaving the borrowed frontend current',
      );
      host.close();
      assert.deepEqual(final.bytes, expectedGraph);
      assert.deepEqual(initial.bytes, expectedGraph);
    } finally {
      host.close();
    }
  });

test('engine graph snapshots detach nested metadata from every public unit and previous graph', async () => {
  for (const strict of [false, true]) {
    const host = engine();
    try {
      const files = graph(strict);
      const reference = await linkSource(entry, readFrom(files), options);
      const units = reference.sources.map((file) => host.parseUnit(files.get(file.path) as string));
      assert.ok(units.every((unit) => unit.ok));
      const profile = strict ? 'strict' : 'canonical';
      const first = host.checkUnits(units, profile);
      assert.ok(first.ok);
      const original = host.format(first, { mapping: true });
      assert.ok(original.ok);
      const seen = new WeakSet<object>();
      const corrupt = (value: object): void => {
        if (seen.has(value)) return;
        seen.add(value);
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === 'string') Reflect.set(value, key, '# forged');
          else if (typeof item === 'number') Reflect.set(value, key, 0);
          else if (item !== null && typeof item === 'object') corrupt(item);
        }
      };
      for (const unit of units) {
        assert.ok(unit.ok);
        corrupt(unit.program);
      }
      corrupt(first.program);
      corrupt(first.typed);
      for (let round = 0; round < 2; round++) {
        const current = host.checkUnits(units, profile);
        assert.ok(current.ok);
        assert.equal(formatSource(current.program), formatSource(reference.program));
        assert.equal(formatSource(current.typed), formatSource(reference.program));
        checkedOutput(current.typed, reference.program);
        const formatted = host.format(current, { mapping: true });
        assert.ok(formatted.ok);
        assert.deepEqual(formatted.bytes, original.bytes);
        assert.deepEqual(formatted.events, original.events);
        const hash = host.revision(current);
        assert.ok(hash.ok);
        assert.equal(hash.revision, programRevision(reference.program));
        corrupt(current.program);
        corrupt(current.typed);
      }
    } finally {
      host.close();
    }
  }
});

test('project file capabilities reject foreign/copy handles and preserve reset/budget/close rules', async () => {
  const host = engine(),
    peer = engine();
  try {
    const files = graph();
    const first = (await openNativeSourceProject(entry, readFrom(files), host, options)).native;
    const second = (await openNativeSourceProject(entry, readFrom(files), host, options)).native;
    const foreign = (await openNativeSourceProject(entry, readFrom(files), peer, options)).native;
    const file = first.files[0] as NativeProjectFile;
    const current = first.checkGraph();
    for (const invalid of [{ ...file }, second.files[0], foreign.files[0], {}])
      assert.throws(
        () => first.activateFileForFormat(invalid as NativeProjectFile),
        /file owned by this native source project/,
      );
    for (const budget of [-1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
      assert.throws(() => first.checkGraph(budget), /allocation budget/);
      assert.throws(() => first.activateFileForFormat(file, budget), /allocation budget/);
    }
    assert.ok(host.format(current).ok, 'preflight failures do not reset the current graph');
    assert.deepEqual(first.activateFileForFormat(file, 0), { ok: false, status: 4 });
    assert.throws(() => host.format(current), /current result owned/);
    assert.throws(
      () => first.checkGraph(0),
      (e) => e instanceof NativeSourceError && e.status === 4,
    );
    const recovered = first.checkGraph();
    assert.ok(host.format(recovered).ok);
    const active = first.activateFileForFormat(file);
    assert.ok(active.ok);
    const output = host.format(active.input);
    assert.ok(output.ok);
    const bytes = output.bytes.slice();
    assert.throws(() => peer.format(active.input), /current result owned/);
    host.parse('fn unrelated\nret A\nend\n');
    assert.throws(() => host.format(active.input), /current result owned/);
    assert.ok(first.checkGraph().ok);
    first.close();
    first.close();
    assert.throws(() => first.checkGraph(), /project is closed/);
    assert.ok(
      second.checkGraph().ok,
      'closing another project leaves its borrowed frontend usable',
    );
    host.close();
    assert.throws(() => second.checkGraph(), /frontend is closed/);
    assert.throws(
      () => second.activateFileForFormat(second.files[0] as NativeProjectFile),
      /frontend is closed/,
    );
    assert.deepEqual(output.bytes, bytes, 'detached output survives both kinds of close');
  } finally {
    host.close();
    peer.close();
  }
});

test('declared file profiles survive checked graph overrides in both directions', async () => {
  for (const declaredStrict of [false, true]) {
    const host = engine();
    try {
      const files = graph(declaredStrict);
      const profile = declaredStrict ? 'canonical' : 'strict';
      const reference = await linkSource(entry, readFrom(files), { ...options, profile });
      const linked = await openNativeSourceProject(entry, readFrom(files), host, {
        ...options,
        profile,
      });
      assert.equal(linked.native.profile, profile);
      assert.equal(linked.native.graph.typed.profile ?? 'canonical', profile);
      checkedOutput(linked.program, reference.program);
      for (const file of linked.native.files) {
        const active = linked.native.activateFileForFormat(file);
        assert.ok(active.ok);
        const formatted = host.format(active.input);
        assert.ok(formatted.ok);
        assert.equal(
          formatted.text,
          formatSource(parseSourceUnit(files.get(file.path) as string).program),
        );
        assert.equal(formatted.text.includes('profile strict'), declaredStrict);
      }
      const graphResult = linked.native.checkGraph();
      assert.equal(graphResult.typed.profile ?? 'canonical', profile);
      checkedOutput(graphResult.typed, reference.program);
      linked.native.close();
    } finally {
      host.close();
    }
  }
});

test('unconfigured formatting refuses activation without resetting the current checked arena', async () => {
  const api = new WebAssembly.Instance(frontend).exports as unknown as NativeApi;
  let initializations = 0;
  const host = nativeSourceApi({
    ...api,
    frontend_ir_init(pointer, length, budget, strict) {
      initializations++;
      return api.frontend_ir_init(pointer, length, budget, strict);
    },
  });
  try {
    const files = graph();
    const linked = await openNativeSourceProject(entry, readFrom(files), host, options);
    const count = initializations;
    const state = readWasmWords(api.memory.buffer, api.frontend_state(), 128).slice();
    assert.deepEqual(
      linked.native.activateFileForFormat(linked.native.files[0] as NativeProjectFile),
      {
        ok: false,
        reason: 'unavailable',
      },
    );
    assert.equal(initializations, count);
    assert.deepEqual(readWasmWords(api.memory.buffer, api.frontend_state(), 128), state);
    checkedOutput(linked.native.checkGraph().typed, linked.program);
    assert.equal(initializations, count + 1);
    linked.native.close();
  } finally {
    host.close();
  }
});

test('native project loader keeps shared confinement, cycles, profile and duplicate diagnostics', async () => {
  const host = engine();
  try {
    const cases = [
      new Map([[entry, 'use "../outside.a0"\nfn top\nret A\nend\n']]),
      new Map([
        [entry, 'use "cycle.a0"\n'],
        [join(root, 'cycle.a0'), 'use "entry.a0"\n'],
      ]),
      new Map([
        [entry, 'profile strict\nuse "plain.a0"\nfn top\nret A\nend\n'],
        [join(root, 'plain.a0'), 'fn plain\nret A\nend\n'],
      ]),
      new Map([
        [entry, 'use "dep.a0"\nfn same\nret A\nend\n'],
        [join(root, 'dep.a0'), 'fn same\nret A\nend\n'],
      ]),
    ];
    for (const files of cases) {
      let expected: A0Error | undefined;
      try {
        await linkSource(entry, readFrom(files), options);
      } catch (e) {
        assert.ok(e instanceof A0Error);
        expected = e;
      }
      assert.ok(expected);
      await assert.rejects(openNativeSourceProject(entry, readFrom(files), host, options), (e) => {
        assert.ok(e instanceof A0Error);
        assert.deepEqual(e.toJSON(), expected?.toJSON());
        return true;
      });
    }
    const escaped = new Map([[entry, 'use "alias.a0"\n']]);
    const read = readFrom(escaped);
    await assert.rejects(
      openNativeSourceProject(entry, read, host, {
        ...options,
        canonicalPath: async (path) =>
          path.endsWith('alias.a0') ? resolve(root, '../outside.a0') : path,
      }),
      (e) => e instanceof A0Error && e.id === 'A0622',
    );
  } finally {
    host.close();
  }
});

test('native project errors retain owning file/local line and do not publish a partial project', async () => {
  const host = engine();
  try {
    const files = new Map([
      [join(root, 'bad.a0'), '# helper Ω\nfn bad -> bool\nret 1\nend\n'],
      [entry, '# entry\nuse "bad.a0"\nfn top\nret A\nend\n'],
    ]);
    await assert.rejects(openNativeSourceProject(entry, readFrom(files), host, options), (e) => {
      assert.ok(e instanceof NativeSourceError);
      assert.equal(e.path, join(root, 'bad.a0'));
      assert.equal(e.line, 3);
      assert.equal(e.a0Error?.id, 'A0201');
      return true;
    });
    files.set(join(root, 'bad.a0'), '# malformed Ω\nfn bad\nend\n');
    await assert.rejects(openNativeSourceProject(entry, readFrom(files), host, options), (e) => {
      assert.ok(e instanceof NativeSourceError);
      assert.equal(e.path, join(root, 'bad.a0'));
      assert.equal(e.line, 3);
      return true;
    });
  } finally {
    host.close();
  }
});

test('real compiler project retains authentic original modules across file and graph formatting', async () => {
  const host = engine();
  let reads = 0;
  try {
    const path = resolve('compiler/source_frontend.a0');
    const reference = await linkSource(path, (file) => readFile(file, 'utf8'), {
      root: process.cwd(),
    });
    const linked = await openNativeSourceProject(
      path,
      async (file) => {
        reads++;
        return readFile(file, 'utf8');
      },
      host,
      { root: process.cwd() },
    );
    assert.equal(reads, reference.sources.length);
    const before = reads;
    assert.equal(formatProgram(linked.program), formatProgram(reference.program));
    for (const file of [linked.native.files[0], linked.native.files.at(-1)]) {
      assert.ok(file);
      const expected: Program = parseSourceUnit(await readFile(file.path, 'utf8')).program;
      const active = linked.native.activateFileForFormat(file);
      assert.ok(active.ok);
      const formatted = host.format(active.input);
      assert.ok(formatted.ok);
      assert.equal(formatted.text, formatSource(expected));
    }
    const checked = linked.native.checkGraph();
    const output = host.format(checked);
    assert.ok(output.ok);
    assert.equal(output.text, formatSource(reference.program));
    const hash = host.revision(checked);
    assert.ok(hash.ok);
    assert.equal(hash.revision, programRevision(reference.program));
    assert.equal(reads, before);
    linked.native.close();
  } finally {
    host.close();
  }
});
