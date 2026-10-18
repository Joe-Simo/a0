/** Independent references and actual-engine controls for formatting-only structured IR upload. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { compile } from '../../../src/backends.js';
import { type Func, formatProgram, type Program, type Type } from '../../../src/core.js';
import { semanticRevision } from '../../../src/edit.js';
import { programRevision, revision } from '../../../src/revision.js';
import { formatSource, parseSource } from '../../../src/source.js';
import { linkSource } from '../../../src/source-link.js';
import type { NativeUnitResult, nativeSource } from '../../../src/source-native.js';
import { linkNativeSource } from '../../../src/source-native-link.js';

type Engine = ReturnType<typeof nativeSource>;
export function authoringProgram(): Program {
  const parsed = parseSource(
    '# profile Ω\nprofile strict # declaration\n# use lead\nuse "depλ.a0" # dependency\n# local\nfn local\nex 1 -> 2 # example\npre lt A 10 # pre\npost gt r A # post\nx external A # node\nret x # returned\nend # end\nfn text -> _x4\nex -> [240 159 152 128] # bytes\na "😀" # text\nret a\nend\n',
  );
  return {
    ...parsed,
    functions: parsed.functions.map((fn, index) => ({
      ...fn,
      afterComments: index === 0 ? ['# intermediate Ω'] : [],
    })),
    tailComments: ['# separate Program tail 😀'],
  };
}

function nativeText(engine: Engine, program: Program): string {
  const active = engine.activateProgramForFormat(program);
  assert.ok(active.ok);
  const formatted = engine.format(active.input);
  assert.ok(formatted.ok);
  assert.equal(formatted.text, formatSource(program));
  return formatted.text;
}

export async function assertProgramFormatting(engine: Engine, peer: Engine): Promise<void> {
  const original = authoringProgram();
  const expected = formatSource(original);
  const active = engine.activateProgramForFormat(original);
  assert.ok(active.ok);
  assert.deepEqual(Object.keys(active.input), [], 'no checked or parsed acceptance is published');
  assert.throws(
    () => engine.checkUnits([active.input as unknown as NativeUnitResult], 'strict'),
    /parsed unit owned/,
  );
  assert.throws(() => engine.format({ ...active.input }), /current result owned/);
  assert.throws(() => peer.format(active.input), /current result owned/);
  const formatted = engine.format(active.input, { mapping: true });
  assert.ok(formatted.ok);
  assert.equal(formatted.text, expected);
  assert.deepEqual(formatted.bytes, new TextEncoder().encode(expected));
  assert.ok(formatted.events.length > 0);
  for (let offset = 0; offset < formatted.events.length; offset += 6) {
    const start = formatted.events[offset + 3] as number;
    const length = formatted.events[offset + 4] as number;
    assert.ok(start <= formatted.bytes.length && length <= formatted.bytes.length - start);
  }
  const hash = engine.revision(active.input);
  assert.ok(hash.ok);
  assert.equal(hash.revision, programRevision(original));
  for (const [index, fn] of original.functions.entries()) {
    const content = engine.revision(active.input, { kind: 'function', functionIndex: index });
    assert.ok(content.ok);
    assert.equal(content.revision, revision(fn));
    assert.deepEqual(engine.revision(active.input, { kind: 'semantic', functionIndex: index }), {
      ok: false,
      status: 7,
    });
  }
  const retained = structuredClone(original);
  const local = original.functions[0] as Func;
  assert.ok(local.comments?.leading);
  (local.comments.leading as string[]).push('# forged nested header');
  Reflect.set(local.nodes[0] as object, 'args', []);
  Reflect.set(local.spec?.post as object, 'args', []);
  Reflect.set(local.spec?.examples[0] as object, 'result', { kind: 'u32', value: 99 });
  (local.afterComments as string[]).push('# forged nested tail');
  Object.assign(original, { functions: [], uses: ['forged.a0'], tailComments: ['# forged'] });
  const repeated = engine.format(active.input, { mapping: true });
  assert.ok(repeated.ok);
  assert.deepEqual(repeated.bytes, formatted.bytes);
  assert.deepEqual(repeated.events, formatted.events);
  assert.deepEqual(engine.revision(active.input), hash);
  const again = engine.activateProgramForFormat(retained);
  assert.ok(again.ok);
  assert.throws(() => engine.format(active.input), /current result owned/);
  assert.ok(engine.format(again.input).ok);

  const savedSource =
    '# saved unit\nuse "saved.a0" # original import\nfn saved\nret A\nend\n# saved tail\n';
  const saved = engine.parseUnit(savedSource);
  assert.ok(saved.ok);
  const rich = engine.activateProgramForFormat(retained);
  assert.ok(rich.ok);
  const restored = engine.activateUnitForFormat(saved);
  assert.ok(restored.ok);
  const unitOutput = engine.format(restored.input);
  assert.ok(unitOutput.ok);
  assert.equal(
    unitOutput.text,
    formatSource(parseSource(savedSource)),
    'unit activation clears prior structured A128 authoring context',
  );
  for (const program of [
    { functions: [] },
    parseSource('profile strict\nuse "depλ.a0"\n# import-only tail\n'),
  ])
    nativeText(engine, program);

  // Mismatching authoring text is lossless formatting metadata, never a semantic rewrite.
  const hinted = parseSource('fn bytes -> _x1\na [65]\nret a\nend\n');
  const bytes = hinted.functions[0]?.nodes[0];
  assert.ok(bytes);
  Reflect.set(bytes, 'text', 'Ω');
  const hint = engine.activateProgramForFormat(hinted);
  assert.ok(hint.ok);
  const hintOutput = engine.format(hint.input, { mapping: true });
  assert.ok(hintOutput.ok);
  assert.equal(hintOutput.text, formatSource(hinted));
  assert.ok(
    Array.from(
      { length: hintOutput.events.length / 6 },
      (_, index) => hintOutput.events[index * 6],
    ).includes(23),
    'whole authoring text mapping',
  );
  assert.equal(bytes.args[0]?.kind, 'u32');
  assert.equal(bytes.args[0]?.kind === 'u32' && bytes.args[0].value, 65);
  const hintHash = engine.revision(hint.input);
  assert.ok(hintHash.ok);
  assert.equal(hintHash.revision, programRevision(hinted));

  // Formatting succeeds for unresolved local calls. The real graph check follows source parsing.
  const root = resolve('.a0-tmp/program-format-graph');
  const input = new Map<string, Program>([
    [resolve(root, 'depλ.a0'), parseSource('profile strict\nfn external\na add A 1\nret a\nend\n')],
    [resolve(root, 'unit.a0'), retained],
    [
      resolve(root, 'wrapper.a0'),
      parseSource('profile strict\nuse "unit.a0" # wrapper\n# empty file tail\n'),
    ],
    [
      resolve(root, 'entry.a0'),
      parseSource(
        'profile strict\nuse "unit.a0"\nuse "wrapper.a0"\nfn top\nex 2 -> 3\na local A\nret a\nend\n',
      ),
    ],
  ]);
  const files = new Map([...input].map(([path, program]) => [path, nativeText(engine, program)]));
  const read = async (path: string): Promise<string> => {
    const text = files.get(path);
    assert.notEqual(text, undefined, path);
    return text as string;
  };
  const options = { root, canonicalPath: async (path: string) => path };
  const entry = resolve(root, 'entry.a0');
  const expectedGraph = await linkSource(entry, read, options);
  const checked = await linkNativeSource(entry, read, engine, options);
  assert.equal(formatProgram(checked.program), formatProgram(expectedGraph.program));
  for (const target of ['c', 'js', 'wasm'] as const)
    assert.equal(
      compile(checked.program, target).text,
      compile(expectedGraph.program, target).text,
    );
  const last = checked.program.functions.length - 1;
  const semantic = engine.revision(checked.native.graph, { kind: 'semantic', functionIndex: last });
  assert.ok(semantic.ok);
  assert.equal(
    semantic.revision,
    semanticRevision(
      expectedGraph.program.functions[last] as NonNullable<
        (typeof expectedGraph.program.functions)[number]
      >,
    ),
  );
  checked.native.close();
  assert.equal(formatted.text, expected, 'detached formatting survives all subsequent resets');
}

export function assertProgramFormattingFailures(engine: Engine, peer: Engine): void {
  const simple = parseSource('fn identity\nret A\nend\n');
  const current = engine.parse('fn old -> bool\nret true\nend\n');
  assert.ok(current.ok);
  for (const budget of [-1, 0.5, NaN, Infinity, 0x1_0000_0000])
    assert.throws(() => engine.activateProgramForFormat(simple, budget), /allocation budget/);
  assert.throws(
    () => engine.activateProgramForFormat({ ...simple, uses: ['\ud800'] }),
    /unpaired UTF-16/,
  );
  assert.ok(engine.format(current).ok, 'early transport/budget failures do not reset');
  const active = engine.activateProgramForFormat(simple);
  assert.ok(active.ok);
  assert.equal(engine.format(active.input).ok, true);
  assert.throws(
    () => engine.checkProgram(active.input as unknown as Program),
    /undefined|iterable/,
  );
  const invalid = engine.activateProgramForFormat(parseSource('fn invalid -> bool\nret 1\nend\n'));
  assert.ok(invalid.ok, 'format-only upload performs no semantic validation');
  assert.ok(engine.format(invalid.input).ok);
  assert.deepEqual(engine.revision(invalid.input, { kind: 'semantic' }), { ok: false, status: 7 });
  assert.throws(() => engine.format(current), /current result owned/);
  assert.deepEqual(engine.activateProgramForFormat(simple, 0), { ok: false, status: 4 });
  assert.throws(() => engine.format(invalid.input), /current result owned/);
  const base = simple.functions[0] as Func;
  const cyclic: Type = { kind: 'arr', elem: 'u32', length: 1 };
  Reflect.set(cyclic, 'elem', cyclic);
  for (const bad of [
    { ...base, ret: { kind: 'u32', value: -1 } },
    { ...base, params: [cyclic] },
    { ...base, nodes: [{ id: 'x', op: 'corrupt', args: [] }] },
    { ...base, params: [{ kind: 'arr', elem: 'u32', length: 0x1_0000_0000 }] },
  ]) {
    const before = engine.activateProgramForFormat(simple);
    assert.ok(before.ok);
    assert.throws(
      () => engine.activateProgramForFormat({ functions: [bad as Func] }),
      /unrepresentable native program IR|unknown|unsupported/,
    );
    assert.throws(() => engine.format(before.input), /current result owned/);
    const recovered = engine.activateProgramForFormat(simple);
    assert.ok(recovered.ok && engine.format(recovered.input).ok);
  }
  const huge = {
    ...base,
    nodes: [
      {
        id: 'huge',
        op: 'arr' as const,
        args: Array.from({ length: 20_000 }, () => ({ kind: 'u32' as const, value: 1 })),
      },
    ],
  };
  assert.deepEqual(engine.activateProgramForFormat({ functions: [huge] }, 4096), {
    ok: false,
    status: 4,
  });
  const refusal = engine.activateProgramForFormat({
    functions: [{ ...base, comments: { leading: ['# \ud800'] } }],
  });
  assert.ok(refusal.ok, 'unrepresentable authoring metadata is explicitly refused by formatting');
  const result = engine.format(refusal.input);
  assert.ok(!result.ok && 'reason' in result && result.reason === 'authoring-metadata');
  const previous = engine.activateProgramForFormat(simple);
  assert.ok(previous.ok);
  const unit = engine.parseUnit('fn next\nret A\nend\n');
  assert.ok(unit.ok);
  assert.throws(() => engine.format(previous.input), /current result owned/);
  const final = engine.activateProgramForFormat(simple);
  assert.ok(final.ok);
  assert.throws(() => peer.revision(final.input), /current result owned/);
  engine.checkProgram(simple);
  assert.throws(() => engine.format(final.input), /current result owned/);
  const last = engine.activateProgramForFormat(simple);
  assert.ok(last.ok);
  engine.checkUnits([unit], 'canonical');
  assert.throws(() => engine.format(last.input), /current result owned/);
  const closed = engine.activateProgramForFormat(simple);
  assert.ok(closed.ok);
  engine.close();
  assert.throws(() => engine.activateProgramForFormat(simple), /closed/);
  assert.throws(() => engine.format(closed.input), /closed/);
}
