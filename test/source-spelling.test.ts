import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseAndValidate, run, validate } from '../src/core.js';
import { parseDense } from '../src/dense.js';
import { compareSourceSpelling } from '../tools/dense-loader.js';

const sourceReader =
  (files: Record<string, string>) =>
  async (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) throw new Error(`unexpected source read: ${path}`);
    return text;
  };

test('source spelling audit preserves imported arities, contracts, profiles and comments', async () => {
  const entry = resolve('source-spelling-fixture/main.a0');
  const dependency = resolve('source-spelling-fixture/inc.a0');
  const read = sourceReader({
    [entry]:
      '# head\nprofile strict # mode\nuse "inc.a0" # import\nfn main u32 -> u32\nex 0 -> 1\nv call inc p0\nret v # result\nend # done\n',
    [dependency]: 'fn inc u32 -> u32\na add p0 1\nret a\nend\n',
  });
  assert.deepEqual(await compareSourceSpelling(entry, read), { status: 'exact' });
});

test('source spelling audit distinguishes a refused Dense spelling from a refused Canonical baseline', async () => {
  const entry = resolve('source-spelling-fixture/collision.a0');
  const text = 'fn f u32 -> u32\nio mov p0\nret io\nend\n';
  const fn = parseAndValidate(text).byName.get('f');
  assert.ok(fn);
  assert.equal(run(fn, [7]), 7);
  const collision = await compareSourceSpelling(entry, sourceReader({ [entry]: text }));
  assert.equal(collision.status, 'dense-refused');
  assert.ok(collision.reason);
  const baseline = await compareSourceSpelling(entry, sourceReader({ [entry]: 'fn id A\n' }));
  assert.equal(baseline.status, 'canonical-refused');
});

test('source spelling audit catches accepted ambiguous source with different strict runtime behavior', async () => {
  const entry = resolve('source-spelling-fixture/ambiguous.a0');
  const text =
    'profile strict\nfn foo u32 -> u32\nbad div 1 p0\nret bad\nend\nfn f u32 -> u32\nfoo mov p0\nret p0\nend\n';
  const canonical = parseAndValidate(text).byName.get('f');
  const dense = validate(parseDense(text)).byName.get('f');
  assert.ok(canonical && dense);
  assert.equal(run(canonical, [0]), 0);
  assert.throws(() => run(dense, [0]));
  assert.deepEqual(await compareSourceSpelling(entry, sourceReader({ [entry]: text })), {
    status: 'different',
  });
});
