/** Explicit live controls: the shared A0 parser/checker owns every native source decision. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import {
  A0Error,
  formatProgram,
  makeIo,
  run,
  type TypedFunc,
  type TypedProgram,
  validate,
} from '../src/core.js';
import { fixAll } from '../src/fix.js';
import { parseSource } from '../src/source.js';
import type { nativeSource } from '../src/source-native.js';
import { NativeSourceError } from '../src/source-native-link.js';
import {
  editNativeNodes,
  NativeNodeEditDiagnostic,
  NativeNodeEditRefusal,
  NativeNodeEditSourceError,
} from '../src/source-native-node-edit.js';
import { TARGETS } from '../src/targets.js';
import { prepareJsSource } from '../tools/source-js-load.js';
import {
  prepareSourceDiagnostic,
  prepareSourceFormat,
  prepareSourceFrontend,
} from '../tools/source-native-load.js';

const cPath = process.env.A0_EDIT_FRONTEND,
  directPath = process.env.A0_EDIT_DIRECT,
  jsPath = process.env.A0_EDIT_JS,
  formatPath = process.env.A0_EDIT_FORMAT,
  diagnosticPath = process.env.A0_EDIT_DIAGNOSTIC;
assert.ok(
  cPath && directPath && jsPath && formatPath && diagnosticPath,
  'A0_EDIT_FRONTEND/DIRECT/JS/FORMAT/DIAGNOSTIC required',
);
const formatting = await prepareSourceFormat(formatPath),
  diagnostics = await prepareSourceDiagnostic(diagnosticPath),
  c = await prepareSourceFrontend(cPath, diagnostics, formatting),
  cRaw = await prepareSourceFrontend(cPath, undefined, formatting),
  direct = await prepareSourceFrontend(directPath, diagnostics, formatting),
  directRaw = await prepareSourceFrontend(directPath, undefined, formatting),
  js = await prepareJsSource(jsPath);
type Frontend = ReturnType<typeof nativeSource>;
const factories = [
  ['C-derived', () => c.instantiate(), () => cRaw.instantiate()],
  ['direct', () => direct.instantiate(), () => directRaw.instantiate()],
  [
    'JS',
    () => js.instantiate(diagnostics, formatting),
    () => js.instantiate(undefined, formatting),
  ],
] as const;
const BASE = 'fn f u32 u32 -> u32\nx add A B\nret x\nend\nfn caller -> u32\nx f 2 3\nret x\nend\n';
function initial(frontend: Frontend, source = BASE): TypedProgram {
  const result = frontend.parse(source);
  assert.ok(result.ok, `initial source refused: ${result.status}`);
  return result.typed;
}
function target(program: TypedProgram, name = 'f'): TypedFunc {
  const fn = program.byName.get(name);
  assert.ok(fn);
  return fn;
}
function equivalent(actual: TypedProgram, expectedSource: string): void {
  // Independent source/checking implementation is a test oracle, never an acceptance dependency.
  const expected = validate(parseSource(expectedSource));
  assert.equal(formatProgram(actual), formatProgram(expected));
  for (const backend of TARGETS)
    assert.deepEqual(compile(actual, backend), compile(expected, backend), backend);
}

for (const [backend, factory, rawFactory] of factories) {
  test(`${backend}: contextual source parsing keeps unused parameters, nested/IO interfaces and one final native transaction`, () => {
    const frontend = factory();
    try {
      const before = initial(frontend),
        saved = structuredClone(before),
        fn = target(before);
      let parses = 0,
        checks = 0,
        activations = 0;
      const authority: Frontend = {
        ...frontend,
        parse() {
          throw new Error('whole-source acceptance is not the node-edit route');
        },
        parseUnit(source, budget) {
          parses++;
          assert.ok(
            source.startsWith('fn f _ _ -> _\n'),
            'every payload retains the full original declaration',
          );
          return frontend.parseUnit(source, budget);
        },
        checkProgram(program, budget) {
          checks++;
          return frontend.checkProgram(program, budget);
        },
        activateProgramForFormat(program, budget) {
          activations++;
          return frontend.activateProgramForFormat(program, budget);
        },
      };
      const next = editNativeNodes(before, fn, '-x\nret A # changed return\n', authority);
      assert.equal(parses, 1);
      assert.equal(checks, 1);
      assert.equal(activations, 1);
      assert.deepEqual(target(next).params, ['u32', 'u32']);
      assert.equal(target(next).retComments?.trailing, '# changed return');
      assert.equal(
        run(target(next, 'caller'), []),
        2,
        'the original two-argument caller still checks and executes',
      );
      equivalent(
        next,
        'fn f u32 u32 -> u32\nret A # changed return\nend\nfn caller -> u32\nx f 2 3\nret x\nend\n',
      );
      assert.deepEqual(before, saved);
      const ioBefore = initial(
        frontend,
        'fn f (u32x2,(bool,io)) u32 -> io\nx at A 1\ny at x 1\nret y\nend\n',
      );
      const ioSaved = structuredClone(ioBefore);
      const ioAfter = editNativeNodes(ioBefore, target(ioBefore), 'z mov y\nret z\n', frontend);
      assert.deepEqual(target(ioAfter).params, target(ioBefore).params);
      assert.deepEqual(target(ioAfter).result, 'io');
      const token = makeIo([]);
      assert.equal(
        run(target(ioAfter), [
          [
            [1, 2],
            [true, token],
          ],
          99,
        ]),
        token,
      );
      assert.deepEqual(ioBefore, ioSaved);
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: the existing node merge/dependency/anchor/fresh-return policy remains shared`, () => {
    const frontend = factory(),
      raw = rawFactory();
    try {
      const before = initial(
        frontend,
        'fn f u32 -> u32\nx add A 1\nretval mul x 2\nret retval\nend\n',
      );
      const saved = structuredClone(before),
        fn = target(before);
      const reply = 'z add later 1\nlater add A 2\nret add z retval # fresh result\n';
      const next = editNativeNodes(before, fn, reply, frontend),
        plain = editNativeNodes(before, fn, reply, raw);
      assert.equal(
        formatProgram(next),
        formatProgram(plain),
        'the optional diagnostic renderer does not decide acceptance',
      );
      assert.equal(target(next).ret.kind, 'node');
      assert.ok(target(next).nodes.some((node) => node.id === 'retval2'));
      assert.equal(run(target(next), [3]), 14);
      assert.equal(target(next).retComments?.trailing, '# fresh result');
      equivalent(
        next,
        'fn f u32 -> u32\nx add A 1\nretval mul x 2\nlater add A 2\nz add later 1\nretval2 add z retval\nret retval2 # fresh result\nend\n',
      );
      const moved = editNativeNodes(before, fn, 'y add A 3 @ x # anchored Ω\nret y\n', frontend);
      assert.deepEqual(
        target(moved).nodes.map((node) => node.id),
        ['x', 'y', 'retval'],
      );
      assert.equal(target(moved).nodes[1]?.comments?.trailing, '# anchored Ω');
      for (const reply of [
        '-x\n',
        '-absent\n',
        'a add missing 1\nret a\n',
        'a add b 1\nb add a 1\nret a\n',
        'unused add A 1\n',
      ]) {
        assert.throws(
          () => editNativeNodes(before, fn, reply, frontend),
          (error) => error instanceof A0Error,
        );
        assert.deepEqual(before, saved);
      }
      assert.ok(frontend.parse('fn identity\nret A\nend\n').ok, 'borrowed frontend remains usable');
    } finally {
      frontend.close();
      raw.close();
    }
  });

  test(`${backend}: comments/contracts/examples survive native replacement and structural contract removals`, () => {
    const frontend = factory();
    try {
      const before = initial(
        frontend,
        '# header Ω\nfn f u32 -> u32\nex 0 -> 1 # example\npre lt A 9 # precondition\npost gt r 0 # postcondition\nx add A 1 # original node\nret x # original return\nend # original end\n',
      );
      const saved = structuredClone(before),
        fn = target(before);
      const next = editNativeNodes(
        before,
        fn,
        '# replacement 😀\nx sub A 4294967295 # new node\n',
        frontend,
      );
      assert.deepEqual(target(next).spec, fn.spec);
      assert.deepEqual(target(next).comments, fn.comments);
      assert.deepEqual(target(next).endComments, fn.endComments);
      assert.deepEqual(target(next).retComments, fn.retComments);
      assert.deepEqual(target(next).nodes[0]?.comments, {
        leading: ['# replacement 😀'],
        trailing: '# new node',
      });
      const kept = editNativeNodes(before, fn, 'x add A 1\n', frontend);
      assert.deepEqual(target(kept).nodes[0]?.comments, fn.nodes[0]?.comments);
      const removed = editNativeNodes(before, fn, '-pre\n-post\n', frontend);
      assert.deepEqual(target(removed).spec?.examples, fn.spec?.examples);
      assert.equal(target(removed).spec?.pre, undefined);
      assert.equal(target(removed).spec?.post, undefined);
      const literal = initial(frontend, 'fn f -> u32\nx mov 1\nret x\nend\n');
      const text = editNativeNodes(
        literal,
        target(literal),
        's text "value # @ fake" # literal comment\nret get s 0\n',
        frontend,
      );
      assert.equal(run(target(text), []), 118);
      assert.equal(target(text).nodes.find((node) => node.id === 's')?.text, 'value # @ fake');
      assert.deepEqual(before, saved);
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: protocol refusal priority and reply-only native repairs retain real provenance`, () => {
    const frontend = factory();
    try {
      const before = initial(frontend),
        fn = target(before),
        saved = structuredClone(before);
      assert.throws(
        () => editNativeNodes(before, fn, 'm add A 1\nm sub m 1\nbad add A\n', frontend),
        (error) => error instanceof A0Error && error.id === 'A0503',
      );
      assert.throws(
        () =>
          editNativeNodes(
            before,
            fn,
            '# Ω\nm add A 1\n\n# gap 😀\nm sub m 1\nbad add A\n',
            frontend,
          ),
        (error) => {
          assert.ok(error instanceof A0Error && error.id === 'A0503');
          assert.equal(error.line, 5);
          assert.deepEqual(
            error.edits.map((edit) => (edit.op === 'lines' ? edit.line : undefined)),
            [2, 5],
          );
          return true;
        },
      );
      assert.throws(
        () => editNativeNodes(before, fn, 'm add A 1 @ absent\nbad add A\n', frontend),
        (error) =>
          error instanceof NativeNodeEditDiagnostic && error.id === 'A0014' && error.line === 2,
      );
      assert.throws(
        () => editNativeNodes(before, fn, 'm add A 1 @ absent\n', frontend),
        (error) => error instanceof A0Error && error.id === 'A0507',
      );
      assert.throws(
        () => editNativeNodes(before, fn, 'ret A\nret B\nbad add A\n', frontend),
        (error) => error instanceof A0Error && error.id === 'A0505',
      );
      for (const newline of ['\n', '\r\n']) {
        const invalid = ['', '# Ω😀', 'x add A # invalid', ''].join(newline);
        assert.throws(
          () => editNativeNodes(before, fn, invalid, frontend),
          (error) => {
            assert.ok(error instanceof NativeNodeEditDiagnostic);
            assert.equal(error.id, 'A0014');
            assert.equal(error.line, 3);
            const origin = error.native.origin,
              packet = error.native.result.diagnostic;
            assert.ok(packet && 'packet' in packet && packet.rendered.ok);
            const generated = packet.rendered.location;
            assert.equal(
              generated.byteStart - origin.generatedByteStart + origin.replyByteStart,
              Buffer.byteLength(invalid.slice(0, invalid.indexOf('add'))),
            );
            assert.equal(
              generated.utf16Start - origin.generatedUtf16Start + origin.replyUtf16Start,
              invalid.indexOf('add'),
            );
            for (const edit of error.edits)
              assert.ok(
                edit.op === 'lines' && edit.line === 3,
                'no generated header/return edit escapes',
              );
            return true;
          },
        );
      }
      const repaired = fixAll('x add A 1 2', (reply) => {
        editNativeNodes(before, fn, reply, frontend);
      });
      assert.equal(
        repaired.error,
        undefined,
        'a real native chain repair applies through the ordinary native transaction',
      );
      assert.ok(repaired.text.includes('\n'));
      assert.throws(
        () => editNativeNodes(before, fn, 'ret add A 1 2\n', frontend),
        (error) => {
          assert.ok(error instanceof NativeNodeEditDiagnostic);
          assert.equal(error.edits.length, 0, 'synthetic return IDs never become reply edits');
          assert.notEqual(error.applicability, 'exact');
          return true;
        },
      );
      assert.deepEqual(before, saved);
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: raw allocation/encoding/spec refusals remain atomic and cannot fall back to host parsing`, () => {
    const frontend = factory(),
      plain = rawFactory();
    try {
      const before = initial(frontend),
        fn = target(before),
        saved = structuredClone(before);
      for (const engine of [frontend, plain]) {
        const limited: Frontend = { ...engine, parseUnit: (source) => engine.parseUnit(source, 0) };
        assert.throws(
          () => editNativeNodes(before, fn, 'x add A 1\n', limited),
          (error) => {
            assert.ok(error instanceof NativeNodeEditSourceError);
            assert.equal(error.status, 4);
            assert.equal(error.origin.payload, 'x add A 1');
            return true;
          },
        );
        const limitedCheck: Frontend = {
          ...engine,
          checkProgram: (program) => engine.checkProgram(program, 0),
        };
        assert.throws(
          () => editNativeNodes(before, fn, 'x add A 1\n', limitedCheck),
          (error) => error instanceof NativeSourceError && error.status === 4,
        );
      }
      assert.throws(
        () => editNativeNodes(before, fn, 'x text "\ud800"\n', frontend),
        /unpaired UTF-16 surrogate/,
      );
      for (const reply of ['+pre lt A 8', '-ex 1', 'pre lt A 8'])
        assert.throws(
          () => editNativeNodes(before, fn, reply, frontend),
          (error) => error instanceof NativeNodeEditRefusal,
        );
      assert.deepEqual(before, saved);
      assert.ok(frontend.checkProgram(before).ok);
      assert.ok(plain.checkProgram(before).ok);
    } finally {
      frontend.close();
      plain.close();
    }
  });
}
