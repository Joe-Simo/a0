import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeSource } from '../src/source-native.js';
import { bootstrapProgramClosure } from '../tools/bootstrap-source.js';
import { nativeSourceArtifact } from '../tools/source-native-artifact.js';

const artifact = nativeSourceArtifact();
const SOURCE = `profile strict
fn positive _ -> bool
ret gt A 0
end
fn twice
ret mul A 2
end
fn unused
ret add A 9
end
fn main
ex 7 -> 14
pre positive A
post positive r
ret twice A
end
`;

test('bootstrap IR closure retains spec dependencies, profile, metrics and native callee identity', async () => {
  const frontend = nativeSource(await artifact);
  try {
    const parsed = frontend.parse(SOURCE);
    assert.ok(parsed.ok);
    const original = parsed.typed;
    const actual = bootstrapProgramClosure(original, ['main', 'main']);
    assert.deepEqual(
      actual.functions.map((fn) => fn.name),
      ['positive', 'twice', 'main'],
    );
    assert.equal(actual.profile, 'strict');
    for (const fn of actual.functions) {
      assert.equal(fn, original.byName.get(fn.name));
      assert.equal(fn.profile, 'strict');
      for (const [name, callee] of fn.calls) assert.equal(callee, actual.byName.get(name));
    }
    assert.ok(frontend.checkProgram(actual).ok, 'selected contract dependency remains valid');
    assert.deepEqual(
      original.functions.map((fn) => fn.name),
      ['positive', 'twice', 'unused', 'main'],
    );
  } finally {
    frontend.close();
  }
});

test('bootstrap IR closure refuses missing entries, forged calls, order and profile mismatches', async () => {
  const frontend = nativeSource(await artifact);
  try {
    const parsed = frontend.parse(SOURCE);
    assert.ok(parsed.ok);
    const original = parsed.typed;
    assert.throws(() => bootstrapProgramClosure(original, []), /at least one entry/);
    assert.throws(() => bootstrapProgramClosure(original, ['missing']), /entry does not exist/);
    const main = original.byName.get('main');
    assert.ok(main);
    const stale = { ...main, calls: new Map() };
    const forged = {
      ...original,
      functions: original.functions.map((fn) => (fn === main ? stale : fn)),
      byName: new Map([...original.byName, ['main', stale]]),
    };
    assert.throws(() => bootstrapProgramClosure(forged, ['main']), /unresolved node callee/);
    assert.throws(
      () =>
        bootstrapProgramClosure({ ...original, functions: [...original.functions].reverse() }, [
          'main',
        ]),
      /unordered callee/,
    );
    assert.throws(
      () =>
        bootstrapProgramClosure({ functions: original.functions, byName: original.byName }, [
          'main',
        ]),
      /inconsistent function identity/,
    );
  } finally {
    frontend.close();
  }
});
