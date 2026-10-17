import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatProgram, parseAndValidate, run } from '../src/core.js';
import { formatDense } from '../src/dense.js';
import { readDenseA0 } from '../src/dense-a0.js';
import { link, parseFile } from '../src/link.js';
import { posix } from './vpath.js';

test('link joins source programs while preserving combined-text line positions', async () => {
  const files = new Map([
    ['/p/lib.a0', '# helper\n\nfn inc u32 -> u32\na add p0 1\nret a\nend\n'],
    [
      '/p/main.a0',
      '# entry\nuse "lib.a0" # import comment\n\nfn main u32 -> u32\na call inc p0\nret a\nend\n',
    ],
  ]);
  const read = async (path: string): Promise<string> => {
    const text = files.get(posix(path));
    assert.notEqual(text, undefined, path);
    return text as string;
  };
  const linked = await link('/p/main.a0', read, { root: '/p', includeUnits: true });
  assert.equal(formatProgram(linked.program), formatProgram(parseAndValidate(linked.text)));
  assert.equal(linked.units?.[0]?.program.functions[0]?.nodes, linked.program.functions[0]?.nodes);
  assert.equal(linked.units?.[1]?.known.get('inc'), 1);
  assert.deepEqual(
    linked.sources.map((s) => [s.lineCount, s.startLine]),
    [
      [7, 1],
      [8, 8],
    ],
  );
  assert.equal(linked.text.split('\n')[8], '# import comment');
  assert.equal(linked.text.split('\n')[10], 'fn main u32 -> u32');
});

test('both source readers reach the same linked validator and retain profile overrides', async () => {
  const source = 'profile strict\n\nfn main u32 -> u32\na div 1 p0\nret a\nend\n';
  const dense = formatDense(parseAndValidate(source));
  const a = await link('/p/main.a0', async () => source, { root: '/p', profile: 'canonical' });
  const b = await link('/p/main.a0d', async () => dense, { root: '/p', profile: 'canonical' });
  assert.equal(a.program.profile, undefined);
  assert.equal(b.program.profile, undefined);
  assert.equal(formatProgram(a.program), formatProgram(b.program));
});

test('imported call results have the same inferred types in both readers and standalone tooling', async () => {
  const files = new Map([
    ['/p/lib.a0d', 'fn values\n[A 7]\nfn iszero\neq A 0\n'],
    ['/p/mid.a0d', 'use "lib.a0d"\nfn middle\nvalues A\n'],
    ['/p/main.a0d', 'use "mid.a0d"\nfn main\nmiddle A\nfn testzero\niszero A\n'],
  ]);
  const read = async (path: string): Promise<string> => {
    const source = files.get(posix(path));
    assert.notEqual(source, undefined, path);
    return source as string;
  };
  const reference = await link('/p/main.a0d', read, { root: '/p' });
  const selfhosted = await link('/p/main.a0d', read, {
    root: '/p',
    denseReader: (source, signatures, path) => readDenseA0(source, signatures, path).text,
  });
  assert.equal(formatProgram(reference.program), formatProgram(selfhosted.program));
  assert.deepEqual(run(reference.program.byName.get('main') as never, [5]), [5, 7]);
  assert.equal(run(reference.program.byName.get('testzero') as never, [0]), true);
  const unit = await parseFile('/p/main.a0d', read);
  assert.deepEqual(
    unit.program.functions.map((f) => f.result),
    reference.program.functions.slice(-2).map((f) => f.result),
  );
});
