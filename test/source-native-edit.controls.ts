/** Actual A0 whole-function transactions on C-derived, direct-Wasm and generated-JS frontends. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatProgram, run, type TypedProgram, validate } from '../src/core.js';
import { parseSource } from '../src/source.js';
import type { nativeSource } from '../src/source-native.js';
import { editNativeProgram } from '../src/source-native-edit.js';
import { NativeSourceError } from '../src/source-native-link.js';
import { TARGETS } from '../src/targets.js';
import { prepareJsSource } from '../tools/source-js-load.js';
import {
  prepareSourceDiagnostic,
  prepareSourceFormat,
  prepareSourceFrontend,
} from '../tools/source-native-load.js';

const cPath = process.env.A0_EDIT_FRONTEND;
const directPath = process.env.A0_EDIT_DIRECT;
const jsPath = process.env.A0_EDIT_JS;
const formatPath = process.env.A0_EDIT_FORMAT;
const diagnosticPath = process.env.A0_EDIT_DIAGNOSTIC;
assert.ok(
  cPath && directPath && jsPath && formatPath && diagnosticPath,
  'A0_EDIT_FRONTEND/DIRECT/JS/FORMAT/DIAGNOSTIC required',
);
const formatting = await prepareSourceFormat(formatPath);
const diagnostics = await prepareSourceDiagnostic(diagnosticPath);
const c = await prepareSourceFrontend(cPath, diagnostics, formatting);
assert.equal(c.build.diagnosticPorts, 'arena-v1');
const cPlain = await prepareSourceFrontend(cPath);
const direct = await prepareSourceFrontend(directPath, diagnostics, formatting);
assert.equal(direct.build.backend, 'direct-wasm');
const directPlain = await prepareSourceFrontend(directPath);
const js = await prepareJsSource(jsPath);
type Frontend = ReturnType<typeof nativeSource>;
const factories = [
  ['C-derived', () => c.instantiate(), () => cPlain.instantiate()],
  ['direct', () => direct.instantiate(), () => directPlain.instantiate()],
  ['JS', () => js.instantiate(diagnostics, formatting), () => js.instantiate()],
] as const;

const BASE =
  '# increment Ω\nfn inc\nex 0 -> 1 # retained example\na add A 1 # retained node\nret a # return\nend # end\n\n# caller 😀\nfn top\nex 3 -> 4\nx inc A\nret x\nend\n\nfn spare _ -> _\nret A\nend\n';

function initial(frontend: Frontend, source = BASE): TypedProgram {
  const result = frontend.parse(source);
  assert.ok(result.ok, `initial native source refused: ${result.status}`);
  return result.typed;
}

/** The separate historical/candidate host implementation is an oracle, never an acceptance fallback. */
function equivalent(actual: TypedProgram, expectedSource: string): void {
  const expected = validate(parseSource(expectedSource));
  assert.equal(formatProgram(actual), formatProgram(expected));
  for (const target of TARGETS)
    assert.deepEqual(compile(actual, target), compile(expected, target), target);
}

function unchanged(before: TypedProgram, saved: TypedProgram): void {
  assert.deepEqual(before, saved);
}

for (const [backend, factory, plainFactory] of factories) {
  test(`${backend}: native whole-function add/replace/remove keeps one complete transaction and declared interfaces`, () => {
    const frontend = factory();
    try {
      const before = initial(frontend);
      const saved = structuredClone(before);
      let unitCalls = 0,
        checks = 0;
      const authority: Frontend = {
        ...frontend,
        parse() {
          throw new Error('whole-source parsing is not the program-edit route');
        },
        parseUnit(text, budget) {
          unitCalls++;
          return frontend.parseUnit(text, budget);
        },
        checkProgram(program, budget) {
          checks++;
          return frontend.checkProgram(program, budget);
        },
      };
      const reply =
        '# replacement Ω\nfn top\nex 3 -> 5 # new example\nx twice A # new node\nret x\nend\n# new callee\nfn twice\nx inc A\ny inc x\nret y\nend\n-fn spare\n';
      const next = editNativeProgram(before, reply, authority);
      assert.equal(unitCalls, 1);
      assert.equal(checks, 1);
      assert.deepEqual(
        next.functions.map((fn) => fn.name),
        ['inc', 'twice', 'top'],
      );
      assert.equal(
        run(next.byName.get('top') as NonNullable<(typeof next.functions)[number]>, [3]),
        5,
      );
      equivalent(
        next,
        '# increment Ω\nfn inc\nex 0 -> 1 # retained example\na add A 1 # retained node\nret a # return\nend # end\nfn twice\nx inc A\ny inc x\nret y\nend\nfn top\nex 3 -> 5\nx twice A\nret x\nend\n',
      );
      assert.deepEqual(next.byName.get('inc')?.comments, before.byName.get('inc')?.comments);
      assert.deepEqual(
        next.byName.get('inc')?.nodes[0]?.comments,
        before.byName.get('inc')?.nodes[0]?.comments,
      );
      assert.deepEqual(next.byName.get('top')?.comments, { leading: ['# replacement Ω'] });
      assert.equal(next.byName.get('top')?.nodes[0]?.comments?.trailing, '# new node');
      assert.equal(next.byName.get('top')?.spec?.examples[0]?.comments?.trailing, '# new example');
      unchanged(before, saved);
      const replaced = editNativeProgram(next, '-fn top\nfn top\nret add A 10\nend\n', authority);
      assert.equal(
        run(replaced.byName.get('top') as NonNullable<(typeof replaced.functions)[number]>, [3]),
        13,
      );
      assert.equal(replaced.byName.get('top')?.spec, undefined);
      unchanged(before, saved);
      assert.ok(frontend.parse('fn alive\nret 1\nend\n').ok, 'the borrowed frontend remains open');
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: native full signatures, profiles, hidden specs and raw comments retain existing program policy`, () => {
    const frontend = factory();
    try {
      const before = initial(frontend);
      const saved = structuredClone(before);
      let signatureCalls = 0;
      const authority: Frontend = {
        ...frontend,
        format(input, request) {
          if (request?.scope === 'signature') signatureCalls++;
          return frontend.format(input, request);
        },
      };
      const unchangedSpec = editNativeProgram(
        before,
        'fn inc\n# body Ω\na add A 1 # trailing\nret a\nend\n',
        authority,
        true,
      );
      assert.deepEqual(unchangedSpec.byName.get('inc')?.spec, before.byName.get('inc')?.spec);
      assert.equal(unchangedSpec.byName.get('inc')?.nodes[0]?.comments?.trailing, '# trailing');
      assert.throws(
        () => editNativeProgram(before, 'fn inc\nret add A 2\nend\n', authority, true),
        (error) => error instanceof A0Error && error.id === 'A0715',
      );
      const strict = editNativeProgram(before, 'profile strict\n', authority);
      assert.equal(strict.profile, 'strict');
      assert.ok(strict.functions.every((fn) => fn.profile === 'strict'));
      const ordinary = editNativeProgram(strict, '-profile\n', authority);
      assert.equal(ordinary.profile, undefined);
      equivalent(ordinary, BASE);
      const removed = editNativeProgram(before, '-fn spare _ -> _\n', authority);
      assert.equal(removed.byName.has('spare'), false);
      assert.equal(signatureCalls, 1);
      assert.throws(
        () => editNativeProgram(before, '-fn spare bool -> _\n', authority),
        (error) => {
          assert.ok(error instanceof A0Error);
          assert.equal(error.id, 'A0516');
          assert.equal(error.applicability, 'exact');
          assert.deepEqual(error.edits[0], {
            op: 'lines',
            rule: 'signature',
            text: '-fn spare bool -> _',
            to: '-fn spare',
          });
          assert.ok(error.message.includes('fn spare _ -> _'));
          return true;
        },
      );
      assert.equal(signatureCalls, 2, 'a rejected annotated removal renders its signature once');
      // An echoed legacy protocol signature is metadata; a bare native header is a function block.
      const echo = editNativeProgram(before, 'fn spare _ -> _ end\n', authority);
      equivalent(echo, BASE);
      unchanged(before, saved);
    } finally {
      frontend.close();
    }
  });

  test(`${backend}: authoritative complete checks hoist existing callees and reject cycles without mutating the input`, () => {
    const frontend = factory();
    const plain = plainFactory();
    try {
      const source = 'fn a\nret add A 1\nend\nfn b\nret mul A 2\nend\nfn c\nret A\nend\n';
      const before = initial(frontend, source),
        saved = structuredClone(before);
      let checks = 0;
      const authority: Frontend = {
        ...frontend,
        checkProgram(program, budget) {
          checks++;
          return frontend.checkProgram(program, budget);
        },
      };
      const next = editNativeProgram(before, 'fn a\nx b A\nret x\nend\n', authority);
      assert.equal(checks, 2, 'one rejected order and one checked structural hoist');
      equivalent(next, 'fn b\nret mul A 2\nend\nfn a\nx b A\nret x\nend\nfn c\nret A\nend\n');
      assert.equal(
        run(next.byName.get('a') as NonNullable<(typeof next.functions)[number]>, [3]),
        6,
      );
      let rawChecks = 0;
      const rawAuthority: Frontend = {
        ...plain,
        checkProgram(program, budget) {
          rawChecks++;
          return plain.checkProgram(program, budget);
        },
      };
      const rawNext = editNativeProgram(before, 'fn a\nx b A\nret x\nend\n', rawAuthority);
      assert.equal(rawChecks, 2);
      assert.equal(
        formatProgram(rawNext),
        formatProgram(next),
        'the optional renderer does not change accepted program edits',
      );
      equivalent(rawNext, 'fn b\nret mul A 2\nend\nfn a\nx b A\nret x\nend\nfn c\nret A\nend\n');
      const rawFailures: Extract<ReturnType<Frontend['checkProgram']>, { readonly ok: false }>[] =
        [];
      const retainRaw: Frontend = {
        ...plain,
        checkProgram(program, budget) {
          const result = plain.checkProgram(program, budget);
          if (!result.ok) rawFailures.push(result);
          return result;
        },
      };
      assert.throws(
        () =>
          editNativeProgram(before, 'fn a\nx b A\nret x\nend\nfn b\nret true\nend\n', retainRaw),
        (error) => {
          assert.ok(error instanceof NativeSourceError);
          assert.equal(rawFailures.length, 2);
          assert.equal(
            error.result,
            rawFailures[0],
            'a second raw semantic failure preserves the first native error/facts',
          );
          assert.equal(error.diagnostic, 102);
          return true;
        },
      );
      unchanged(before, saved);
      for (const duplicate of [
        'fn fresh\nret 1\nend\nfn fresh\nret 2\nend\n',
        'fn a\nret A\nend\nfn a\nret add A 1\nend\n',
      ]) {
        const beforeChecks: number = checks;
        assert.throws(
          () => editNativeProgram(before, duplicate, authority),
          (error) => error instanceof A0Error && error.id === 'A0020',
        );
        assert.equal(
          checks,
          beforeChecks,
          'the native parser rejects duplicate declarations before merge/check',
        );
        unchanged(before, saved);
      }
      for (const reply of [
        'fn a\nx b A\nret x\nend\nfn b\nx a A\nret x\nend\n',
        'fn a\nx missing A\nret x\nend\n',
        'fn a\nx b A\nret x\nend\nfn b\nret true\nend\n',
        '-fn a\n-fn b\n-fn c\n',
        '-fn absent\n',
        'fn malformed\nret\nend\n',
      ]) {
        assert.throws(
          () => editNativeProgram(before, reply, authority),
          (error) => error instanceof A0Error,
        );
        unchanged(before, saved);
      }
      assert.ok(frontend.parse(source).ok, 'the same engine recovers after rejected edits');
    } finally {
      frontend.close();
      plain.close();
    }
  });

  test(`${backend}: absent capabilities, raw diagnostics, allocation and encoding refusals never use host acceptance`, () => {
    const frontend = factory();
    const plain = plainFactory();
    try {
      const before = initial(frontend),
        saved = structuredClone(before);
      const bounded: Frontend = {
        ...frontend,
        checkProgram(program) {
          return frontend.checkProgram(program, 0);
        },
      };
      assert.throws(
        () => editNativeProgram(before, 'fn top\nret A\nend\n', bounded),
        (error) => error instanceof NativeSourceError && error.status === 4,
      );
      for (const authority of [frontend, plain]) {
        let checks = 0;
        const retryBounded: Frontend = {
          ...authority,
          checkProgram(program, budget) {
            checks++;
            return authority.checkProgram(program, checks === 2 ? 0 : budget);
          },
        };
        assert.throws(
          () => editNativeProgram(before, 'fn top\nx spare A\nret x\nend\n', retryBounded),
          (error) => error instanceof NativeSourceError && error.status === 4,
        );
        assert.equal(
          checks,
          2,
          'a raw allocation refusal on retry propagates with or without a renderer',
        );
      }
      const parseBounded: Frontend = {
        ...frontend,
        parseUnit(source) {
          return frontend.parseUnit(source, 0);
        },
      };
      assert.throws(
        () => editNativeProgram(before, 'fn top\nret A\nend\n', parseBounded),
        (error) => error instanceof NativeSourceError && error.status === 4,
      );
      assert.throws(
        () => editNativeProgram(before, 'fn malformed\nret\nend\n', plain),
        (error) => error instanceof NativeSourceError && error.a0Error === undefined,
      );
      assert.throws(
        () => editNativeProgram(before, '-fn spare _ -> _\n', plain),
        /signature activation refused: unavailable/,
      );
      assert.throws(
        () => editNativeProgram(before, 'fn top\n# \ud800\nret A\nend\n', frontend),
        /unpaired UTF-16 surrogate/,
      );
      unchanged(before, saved);
      assert.ok(frontend.parse(BASE).ok);
      frontend.close();
      assert.throws(
        () => editNativeProgram(before, 'fn top\nret A\nend\n', frontend),
        /frontend is closed/,
      );
      unchanged(before, saved);
    } finally {
      frontend.close();
      plain.close();
    }
  });
}
