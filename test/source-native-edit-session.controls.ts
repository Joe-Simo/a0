/** Explicit actual frontend controls; no default route switch and no skipped backend. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, run, type TypedFunc, type TypedProgram } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import type { nativeSource } from '../src/source-native.js';
import { createNativeEditSession } from '../src/source-native-edit-session.js';
import { NativeEditDiagnostic } from '../src/source-native-edit-source.js';
import { NativeSourceError } from '../src/source-native-link.js';
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
  'all actual A0_EDIT artifacts required',
);
const format = await prepareSourceFormat(formatPath),
  diagnostics = await prepareSourceDiagnostic(diagnosticPath),
  c = await prepareSourceFrontend(cPath, diagnostics, format),
  direct = await prepareSourceFrontend(directPath, diagnostics, format),
  cRaw = await prepareSourceFrontend(cPath, undefined, format),
  directRaw = await prepareSourceFrontend(directPath, undefined, format),
  js = await prepareJsSource(jsPath);
type Frontend = ReturnType<typeof nativeSource>;
const factories = [
  ['C', () => c.instantiate(), () => cRaw.instantiate()],
  ['direct', () => direct.instantiate(), () => directRaw.instantiate()],
  ['JS', () => js.instantiate(diagnostics, format), () => js.instantiate(undefined, format)],
] as const;
const BASE =
  '# header\nfn f u32 u32 -> u32 # declaration\nex 2 3 -> 5 # old example\npre lt A 10 # old pre\npost gt r 0 # old post\nx add A B # old node\nret x # old return\nend # old end\n';
function initial(frontend: Frontend, source = BASE): TypedProgram {
  const result = frontend.parse(source);
  assert.ok(result.ok);
  return result.typed;
}
const call = (program: TypedProgram, a = 2, b = 3) =>
  run(program.byName.get('f') as TypedFunc, [a, b]);
const rejected = (session: EditSession, reply: string): unknown => {
  try {
    session.apply(reply);
  } catch (error) {
    return error;
  }
  throw new Error('unexpected acceptance');
};

for (const [backend, factory, rawFactory] of factories) {
  test(`${backend}: same EditSession uses native full declarations and one canonical source for every scope`, () => {
    const frontend = factory();
    try {
      const program = initial(frontend);
      const authority: Frontend = {
        ...frontend,
        parse() {
          throw new Error('session must use native unit and program APIs');
        },
      };
      const session = createNativeEditSession(program, authority);
      assert.ok(session instanceof EditSession);
      assert.match(session.open('f', { numbered: true }).text, /fn f _ _ -> _\n1 ex 2 3 -> 5/);
      assert.match(session.openProgram().text, /fn f _ _ -> _ end/);
      for (const options of [{ dense: true }, { compact: true }])
        assert.throws(() => session.open('f', options), /only the shared/);
      assert.equal(session.openHandles, 2);
      session.apply('e0\nx add A 2\n-ex 2 3 -> 5\n+ex 2 3 -> 4');
      assert.equal(call(session.program), 4);
      assert.equal(
        session.program.byName.get('f')?.params.length,
        2,
        'last parameter use removal preserves its declaration',
      );
      assert.match(session.view('e0'), /fn f _ _ -> _/);
      const active = frontend.activateProgramForFormat(session.program);
      assert.ok(active.ok);
      const revision = frontend.revision(active.input, { kind: 'function' });
      assert.ok(revision.ok);
      assert.equal(session.open('f').revision, revision.revision);
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: fenced Unicode CRLF replies preserve comments, signed specs and physical repair ownership`, () => {
    const frontend = factory();
    try {
      const session = createNativeEditSession(initial(frontend), frontend);
      session.open('f');
      const source = [
        '# Ω😀',
        '```a0',
        'e0',
        '# node lead',
        'x add A 2 # changed',
        '-ex 2 3 -> 5',
        '+ex 2 3 -> 4 # new example',
        '```',
        '',
      ].join('\r\n');
      session.apply(source);
      const fn = session.program.byName.get('f');
      assert.ok(fn);
      assert.equal(fn.nodes[0]?.comments?.trailing, '# changed');
      assert.deepEqual(fn.nodes[0]?.comments?.leading, ['# node lead']);
      assert.equal(fn.spec?.examples[0]?.comments?.trailing, '# new example');
      assert.equal(fn.spec?.pre?.comments?.trailing, '# old pre');
      assert.equal(fn.retComments?.trailing, '# old return');
      assert.equal(call(session.program), 4);
      const bad = ['# Ω😀', '```a0', 'e0', 'x add A # incomplete', '```'].join('\r\n');
      const error = rejected(session, bad);
      assert.ok(error instanceof NativeEditDiagnostic);
      assert.equal(error.line, 4);
      const owner = error.native.sourceLines.find((row) => row.origin?.line === 4)?.origin;
      assert.ok(owner);
      assert.equal(owner.utf16Start, bad.indexOf('x add'));
      assert.equal(owner.byteStart, Buffer.byteLength(bad.slice(0, bad.indexOf('x add'))));
      for (const edit of error.edits) assert.ok(edit.op === 'lines' && edit.line === 4);
      assert.equal(call(session.program), 4);
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: one numbered map addresses specs, nodes and return while untouched metadata survives`, () => {
    const frontend = factory();
    try {
      const session = createNativeEditSession(initial(frontend), frontend);
      session.open('f', { numbered: true });
      session.apply(
        '4 x add A 2 # changed numbered\n1 ex 2 3 -> 4 # changed example\n+ex 2 3 -> 4',
      );
      const fn = session.program.byName.get('f');
      assert.ok(fn);
      assert.equal(call(session.program), 4);
      assert.equal(fn.params.length, 2);
      assert.equal(fn.spec?.examples.length, 1, 'full example equality deduplicates');
      assert.equal(fn.spec?.examples[0]?.comments?.trailing, '# changed example');
      assert.equal(fn.nodes[0]?.comments?.trailing, '# changed numbered');
      assert.equal(fn.comments?.trailing, '# declaration');
      assert.equal(fn.spec?.pre?.comments?.trailing, '# old pre');
      assert.equal(fn.retComments?.trailing, '# old return');
      assert.equal(fn.endComments?.trailing, '# old end');
      assert.match(session.view('e0'), /4 x add A 2\n5 ret x/);
      const previous = session.program;
      assert.ok(rejected(session, '4 x add A 1\n4 x add A 2') instanceof A0Error);
      assert.equal(session.program, previous);
      assert.equal((rejected(session, '-ex 2 3 -> 99') as A0Error).id, 'A0720');
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: raw native errors, real resource failures and publication refusals leave the session atomic`, () => {
    const frontend = factory();
    try {
      const program = initial(frontend);
      let failParse = false,
        failCheck = false,
        failActivation = true;
      const constrained: Frontend = {
        ...frontend,
        parseUnit: (source, budget) => frontend.parseUnit(source, failParse ? 0 : budget),
        checkProgram: (value, budget) => frontend.checkProgram(value, failCheck ? 0 : budget),
        activateProgramForFormat: (value, budget) =>
          frontend.activateProgramForFormat(value, failActivation ? 0 : budget),
      };
      const session = createNativeEditSession(program, constrained, { maxOpenHandles: 1 });
      assert.throws(() => session.open('f'));
      assert.equal(session.openHandles, 0);
      failActivation = false;
      assert.equal(session.open('f').handle, 'e0');
      const view = session.view('e0');
      for (const failure of ['parse', 'check'] as const) {
        failParse = failure === 'parse';
        failCheck = failure === 'check';
        const error = rejected(session, 'x add A 2');
        assert.ok(error instanceof NativeSourceError && error.status === 4);
        assert.equal(session.program, program);
        assert.equal(session.view('e0'), view);
      }
      failParse = false;
      failCheck = false;
      assert.match(String(rejected(session, 'x text "\ud800"')), /unpaired UTF-16 surrogate/);
      assert.equal(session.program, program);
      const refused = new Error('output size');
      assert.throws(
        () =>
          session.applyAndPublish('x add A B', () => {
            throw refused;
          }),
        (error) => error === refused,
      );
      assert.equal(session.program, program);
      assert.equal(session.view('e0'), view);
      frontend.close();
      assert.throws(() => session.view('e0'), /closed/);
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: actual native exact fixes replay through fenced implied and multi-handle transactions`, () => {
    const frontend = factory();
    try {
      const session = createNativeEditSession(
        initial(frontend, 'fn f u32 u32 -> u32\nx add A B\nret x\nend\n'),
        frontend,
      );
      session.open('f');
      const reply = ['# Ω😀', '```a0', 'x add A 1 2', '```'].join('\r\n');
      const error = rejected(session, reply);
      assert.ok(error instanceof NativeEditDiagnostic);
      assert.equal(error.applicability, 'exact');
      session.diagnose('x add A 3');
      session.apply('fix all');
      assert.equal(call(session.program), 5);
      session.openProgram();
      const before = session.program;
      assert.ok(rejected(session, 'e0\nx add A 9\ng0\nfn bad\nret\nend') instanceof A0Error);
      assert.equal(session.program, before);
      const duplicate = rejected(session, 'e0\nx add A 1\nx sub x 1\nbad add A');
      assert.ok(
        duplicate instanceof A0Error && duplicate.id === 'A0503',
        'protocol duplicate precedes later source grammar',
      );
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: whole-function end comments survive with and without a final newline`, () => {
    const frontend = factory();
    try {
      for (const suffix of ['', '\n']) {
        const session = createNativeEditSession(initial(frontend), frontend);
        session.open('f');
        session.apply(`e0\nfn f u32 u32 -> u32\nx add A B\nret x\nend # authored end${suffix}`);
        assert.equal(session.program.functions[0]?.endComments?.trailing, '# authored end');
        assert.equal(call(session.program), 5);
      }
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: final native rename fixes target only their owning reply row and keep comments and anchors`, () => {
    const frontend = factory();
    try {
      const base = initial(
        frontend,
        'fn f u32 u32 -> u32\nx add A B\nret x\nend\nfn g u32 u32 -> u32\nx add A B\nret x\nend\n',
      );
      const session = createNativeEditSession(base, frontend);
      session.open('f');
      session.open('g');
      const error = rejected(session, 'e0\nx add A B\ne1\nx mod A B # once');
      assert.ok(error instanceof NativeEditDiagnostic && error.id === 'A0102');
      assert.equal(error.native.status, 8);
      assert.equal(error.native.diagnostic, 102);
      assert.equal(error.applicability, 'exact');
      assert.deepEqual(
        error.edits.map((edit) => (edit.op === 'lines' ? edit.line : null)),
        [4],
      );
      session.apply('fix all');
      assert.equal(run(session.program.byName.get('f') as TypedFunc, [2, 3]), 5);
      assert.equal(run(session.program.byName.get('g') as TypedFunc, [2, 3]), 2);
      assert.equal(session.program.byName.get('g')?.nodes[0]?.comments?.trailing, '# once');
      const numbered = createNativeEditSession(base, frontend);
      numbered.open('f', { numbered: true });
      assert.equal(
        (rejected(numbered, '1 x mod A B # numbered once') as A0Error).applicability,
        'exact',
      );
      numbered.apply('fix all');
      assert.equal(call(numbered.program), 2);
      assert.equal(
        numbered.program.byName.get('f')?.nodes[0]?.comments?.trailing,
        '# numbered once',
      );
      const anchored = createNativeEditSession(
        initial(frontend, 'fn f u32 u32 -> u32\nmod add A 1\nx add mod B\nret x\nend\n'),
        frontend,
      );
      anchored.open('f');
      const anchorError = rejected(anchored, 'x mod A 5 @ mod # anchor once');
      assert.ok(
        anchorError instanceof NativeEditDiagnostic && anchorError.applicability === 'exact',
      );
      assert.ok(
        anchorError.edits.some(
          (edit) => edit.op === 'lines' && edit.to.includes('@ mod') && !edit.to.includes('@ rem'),
        ),
      );
      anchored.apply('fix all');
      assert.equal(call(anchored.program), 2);
      assert.equal(anchored.program.byName.get('f')?.nodes[1]?.comments?.trailing, '# anchor once');
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: native multiline fixes retain numbered insertion, replacement and copied-row framing`, () => {
    const frontend = factory();
    try {
      for (const reply of [
        '1 x add A 1 2 # replacement',
        '1+ y add A 1 2 # insertion\n2 ret y',
        'fn f u32 u32 -> u32\n1 x add A 1 2 # copied\n2 ret x\nend',
      ]) {
        const session = createNativeEditSession(
          initial(frontend, 'fn f u32 u32 -> u32\nx add A B\nret x\nend\n'),
          frontend,
        );
        session.open('f', { numbered: true });
        const error = rejected(session, reply);
        assert.ok(error instanceof NativeEditDiagnostic);
        assert.equal(error.applicability, 'exact', reply);
        session.apply('fix all');
        assert.equal(call(session.program), 5, reply);
        assert.equal(session.program.byName.get('f')?.params.length, 2);
      }
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: a later reply cannot execute a rename against source owned by a previous reply`, () => {
    const frontend = factory();
    try {
      const session = createNativeEditSession(
        initial(
          frontend,
          'fn mod u32 u32 -> u32\nret A\nend\nfn f u32 u32 -> u32\nx mod A B\nret x\nend\n',
        ),
        frontend,
      );
      session.open('f');
      session.openProgram();
      session.apply('e0\nx mod A B # prior reply');
      const previous = session.program;
      const error = rejected(session, 'g0\n-fn mod');
      assert.ok(error instanceof NativeEditDiagnostic);
      assert.equal(error.edits.length, 0);
      assert.notEqual(error.applicability, 'exact');
      assert.equal(session.program, previous);
      const scoped = createNativeEditSession(
        initial(
          frontend,
          'fn not bool -> bool\nret A\nend\nfn f bool -> bool\ny not A\nret y\nend\n',
        ),
        frontend,
      );
      scoped.openProgram();
      const scopedPrevious = scoped.program;
      const scopedError = rejected(scoped, '-fn not\nfn g bool -> bool\ny not A\nret y\nend');
      assert.ok(scopedError instanceof NativeEditDiagnostic && scopedError.id === 'A0102');
      assert.equal(
        scopedError.edits.length,
        0,
        'an old failing function cannot borrow equal text from another function',
      );
      assert.notEqual(scopedError.applicability, 'exact');
      assert.equal(scoped.program, scopedPrevious);
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: optional diagnostic renderer never changes valid spec or numbered edit acceptance`, () => {
    const left = factory(),
      right = rawFactory();
    try {
      const one = createNativeEditSession(initial(left), left),
        two = createNativeEditSession(initial(right), right);
      one.open('f', { numbered: true });
      two.open('f', { numbered: true });
      for (const session of [one, two]) session.apply('4 x add A 2\n1 ex 2 3 -> 4\n+pre lt A 12');
      assert.deepEqual(one.program, two.program);
      assert.equal(call(one.program), 4);
    } finally {
      left.close();
      right.close();
    }
  });
}
