/** Explicit live-renderer regression: artifacts are required, never silently skipped. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, validate } from '../src/core.js';
import { parseSource } from '../src/source.js';
import { prepareSourceDiagnostic, prepareSourceFrontend } from '../tools/source-native-load.js';

const frontend = process.env.A0_LIMIT_FRONTEND;
const renderer = process.env.A0_LIMIT_RENDERER;
assert.ok(frontend && renderer, 'A0_LIMIT_FRONTEND and A0_LIMIT_RENDERER are required');
const diagnostic = await prepareSourceDiagnostic(renderer);
const prepared = await prepareSourceFrontend(frontend, { load: diagnostic.load });
assert.equal(prepared.build.diagnosticPorts, 'arena-v1');

test('live native length diagnostics match full reference JSON for width, IO and nested dimensions', () => {
  const engine = prepared.instantiate();
  try {
    for (const type of [
      'boolx2097153',
      '(bool,bool)x1048577',
      '(bool,bool,bool)x699051',
      'boolx2x1048577',
      '_x65537',
      '(io,bool)x65537',
    ]) {
      for (const prefix of ['', '# Unicode Ω😀\n\n']) {
        for (const signature of [`${type} -> _`, `-> ${type}`]) {
          const source = `${prefix}fn f ${signature}\nret 0\nend\n`;
          let expected: A0Error | undefined;
          try {
            validate(parseSource(source));
          } catch (error) {
            assert.ok(error instanceof A0Error);
            expected = error;
          }
          assert.ok(expected);
          const actual = engine.parse(source);
          assert.ok(!actual.ok && actual.diagnostic?.rendered.ok, signature);
          assert.deepEqual(actual.diagnostic.rendered.error.toJSON(), expected.toJSON(), signature);
        }
      }
    }
  } finally {
    engine.close();
  }
});
