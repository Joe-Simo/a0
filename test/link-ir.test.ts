import assert from 'node:assert/strict';
import { basename, resolve } from 'node:path';
import { test } from 'node:test';
import {
  A0Error,
  formatProgram,
  formatSource,
  parse,
  profileOf,
  run,
  validate,
} from '../src/core.js';
import { formatDense, parseDense } from '../src/dense.js';
import { link, type ReadSource } from '../src/link.js';

const root = resolve('test/virtual-linked');
const identity = 'fn identity u32 -> u32\nret p0\nend\n';

function reader(files: Readonly<Record<string, string>>): ReadSource {
  return async (path) => {
    const text = files[basename(path)];
    assert.ok(text !== undefined, `unexpected source: ${path}`);
    return text;
  };
}

test('link composes strict modules and retains comments from removed directives and empty modules', async () => {
  const files = {
    'dependency.a0': `# dependency profile\nprofile strict # dependency strict\n# identity\n${identity}# dependency tail\n`,
    'empty.a0': '# empty profile\nprofile strict # empty strict\n# empty tail\n',
    'main.a0':
      '# main profile\nprofile strict # main strict\n# dependency import\nuse "dependency.a0" # import identity\n# empty import\nuse "empty.a0" # import empty\n# entry\nfn main -> u32\nx call identity 17\nret x\nend\n# main tail\n',
  };
  for (const mode of ['canonical', 'dense', 'reader', 'ir-reader'] as const) {
    const sources =
      mode === 'canonical'
        ? files
        : Object.fromEntries(
            Object.entries(files).map(([name, text]) => [
              name,
              formatDense(parse(text), { comments: true, known: new Map([['identity', 1]]) }),
            ]),
          );
    let reads = 0;
    const linked = await link(resolve(root, 'main.a0'), reader(sources), {
      root,
      ...(mode === 'canonical' ? {} : { dense: true }),
      ...(mode !== 'reader' && mode !== 'ir-reader'
        ? {}
        : {
            denseReader: (text, used) => {
              reads += 1;
              const parsed = parseDense(text, {
                known: new Map([...used].map(([name, fn]) => [name, fn.params.length])),
              });
              return mode === 'ir-reader' ? parsed : formatSource(parsed);
            },
          }),
    });
    const reparsed = validate({ ...parse(linked.text), profile: 'strict' });
    assert.equal(formatProgram(linked.program), formatProgram(reparsed), mode);
    assert.equal(formatSource(linked.program), formatSource(reparsed), mode);
    assert.equal(profileOf(linked.program), 'strict');
    const main = linked.program.byName.get('main');
    assert.ok(main);
    assert.equal(run(main, []), 17);
    for (const comment of [
      '# dependency profile',
      '# dependency strict',
      '# identity',
      '# dependency tail',
      '# empty profile',
      '# empty strict',
      '# empty tail',
      '# main profile',
      '# main strict',
      '# dependency import',
      '# import identity',
      '# empty import',
      '# import empty',
      '# entry',
      '# main tail',
    ])
      assert.equal(formatSource(linked.program).split(comment).length, 2, `${mode}: ${comment}`);
    assert.equal(reads, mode === 'reader' || mode === 'ir-reader' ? 3 : 0);
  }
});

test('link keeps physical LF lines and Unicode separators inside quoted text', async () => {
  const dependency = `${identity}\n`;
  const main =
    '\r\n\r\nuse "dependency.a0" # import\r\n\r\nfn main -> u32x22\r\nt text "a\u2028profile strict\u2029z"\r\nret t\r\nend\r\n';
  const linked = await link(
    resolve(root, 'main.a0'),
    reader({
      'dependency.a0': dependency,
      'main.a0': main,
    }),
    { root },
  );
  assert.deepEqual(linked.sources, [
    {
      path: resolve(root, 'dependency.a0'),
      startLine: 1,
      lineCount: dependency.split('\n').length,
    },
    {
      path: resolve(root, 'main.a0'),
      startLine: dependency.split('\n').length + 1,
      lineCount: main.split('\n').length,
    },
  ]);
  assert.ok(linked.text.includes('a\u2028profile strict\u2029z'));
  assert.ok(linked.text.includes('\r\n\r\n# import\r\n\r\n'));
  assert.equal(formatSource(linked.program), formatSource(parse(linked.text)));
});

test('link preserves all comments when the complete dependency graph has no functions', async () => {
  const linked = await link(
    resolve(root, 'main.a0'),
    reader({
      'main.a0': '# main\nuse "empty.a0" # import\n# tail\n',
      'empty.a0': '# empty\n',
    }),
    { root },
  );
  assert.equal(linked.program.functions.length, 0);
  assert.equal(formatSource(linked.program), formatSource(parse(linked.text)));
  assert.equal(formatSource(linked.program), '# empty\n# main\n# import\n# tail\n');
});

test('link retains source diagnostics after direct IR composition', async () => {
  for (const [source, code, line] of [
    ['\nuse "dependency.a0"\n\nfn main -> u32\nx call absent 1\nret x\nend\n', 'A0102', 5],
    ['use "dependency.a0"\nfn main -> u32\nex -> 2\nx call identity 1\nret x\nend\n', 'A0715', 3],
  ] as const) {
    await assert.rejects(
      link(
        resolve(root, 'main.a0'),
        reader({
          'dependency.a0': identity,
          'main.a0': source,
        }),
        { root },
      ),
      (error: unknown) => {
        assert.ok(error instanceof A0Error);
        assert.equal(error.id, code);
        assert.ok(error.message.startsWith(`${resolve(root, 'main.a0')}:${line}:`), error.message);
        return true;
      },
    );
  }
  await assert.rejects(
    link(
      resolve(root, 'main.a0'),
      reader({
        'main.a0': 'use "dependency.a0" junk # not a directive\n',
      }),
      { root },
    ),
    (error: unknown) => error instanceof A0Error && error.id === 'A0017',
  );
});

// Dense can infer a bool aggregate above the legacy signature parser's per-dimension cap.
// The shared validator accepts it within the aggregate bit budget. A migration reader must
// preserve that valid IR instead of routing it through a more restrictive source grammar.
test('IR readers preserve valid inferred legacy aggregates without reparsing signatures', async () => {
  const length = 65537;
  const text = `fn large\n[${Array<string>(length).fill('true').join(' ')}]\n`;
  const parsed = parseDense(text);
  assert.throws(() => parse(formatSource(parsed)), /array length exceeds 65536/);
  const linked = await link(resolve(root, 'large.a0d'), reader({ 'large.a0d': text }), {
    root,
    denseReader: () => parsed,
  });
  const large = linked.program.byName.get('large');
  assert.ok(large);
  assert.deepEqual(large.result, { kind: 'arr', length, elem: 'bool' });
  assert.deepEqual(run(large, []), Array<boolean>(length).fill(true));
});

test('IR readers still pass through shared graph typing and source diagnostics', async () => {
  const text = 'fn invalid -> bool\nx add 1 2\nret x\nend\n';
  await assert.rejects(
    link(resolve(root, 'invalid.a0d'), reader({ 'invalid.a0d': text }), {
      root,
      denseReader: () => parse(text),
    }),
    (error: unknown) => {
      assert.ok(error instanceof A0Error);
      assert.match(error.message, /invalid/);
      assert.match(error.message, /bool/);
      assert.ok(error.message.startsWith(`${resolve(root, 'invalid.a0d')}:`), error.message);
      return true;
    },
  );
});
