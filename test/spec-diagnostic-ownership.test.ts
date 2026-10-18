import assert from 'node:assert/strict';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseAndValidate, validate } from '../src/core.js';
import { A0Error, diag } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { linkProject } from '../src/linker.js';
import { parseSource } from '../src/source.js';
import { linkSource } from '../src/source-link.js';

const root = resolve('test/spec-owner-virtual');
const entry = join(root, 'main.a0');
const options = { root, canonicalPath: async (path: string) => path };
const unrelated = 'fn spec -> u32\nret 0\nend\n';
const read =
  (main: string, library = unrelated) =>
  async (path: string): Promise<string> => {
    assert.ok(path === entry || path === join(root, 'lib.a0'), path);
    return basename(path) === 'main.a0' ? main : library;
  };
const raised = (thunk: () => unknown): A0Error => {
  try {
    thunk();
  } catch (e) {
    assert.ok(e instanceof A0Error);
    return e;
  }
  throw new Error('expected a diagnostic');
};

test('linked spec errors use their function owner even when another file defines spec', async () => {
  const cases = [
    ['io', 'fn f io -> io\nex -> 0\nret p0\nend\n', 'A0714', 3],
    ['contract typing', 'fn f u32 -> u32\npre eq p9 0\nret p0\nend\n', 'A0714', 3],
    ['contract result', 'fn f u32 -> u32\npre add p0 1\nret p0\nend\n', 'A0714', 3],
    ['argument shape', 'fn f u32 -> u32\nex true -> 0\nret p0\nend\n', 'A0714', 3],
    ['result shape', 'fn f u32 -> u32\nex 0 -> true\nret p0\nend\n', 'A0714', 3],
    ['arity', 'fn f u32 -> u32\nex 0 1 -> 2\nret p0\nend\n', 'A0714', 3],
    ['example', 'fn f u32 -> u32\n# example\n\nex 1 -> 2\nret p0\nend\n', 'A0715', 6],
    ['pre', 'fn f u32 -> u32\nex 1 -> 1\npre lt p0 0\nret p0\nend\n', 'A0716', 5],
    ['post', 'fn f u32 -> u32\nex 1 -> 1\npost lt r 0\nret p0\nend\n', 'A0716', 5],
    [
      'fuel',
      'fn step u32 u32 -> u32\nret p0\nend\nfn f u32 -> u32\nex 1 -> 1\na fold step 10001 p0\nret a\nend\n',
      'A0719',
      7,
    ],
  ] as const;
  for (const [name, body, id, line] of cases) {
    const main = `use "lib.a0"\n# owner\n${body}`;
    for (const [reader, check] of [
      [linkSource, () => validate(parseSource(body))],
      [link, () => parseAndValidate(body)],
    ] as const) {
      const original = raised(check);
      for (const library of [unrelated, unrelated.replace('fn spec', 'fn helper')]) {
        await assert.rejects(reader(entry, read(main, library), options), (e: unknown) => {
          assert.ok(e instanceof A0Error, name);
          assert.equal(e.id, id, name);
          assert.deepEqual(e.toJSON(), {
            ...original.toJSON(),
            message: `${entry}:${line}: ${original.message}`,
          });
          assert.equal(Object.hasOwn(e.toJSON(), 'specOwner'), false);
          return true;
        });
      }
    }
  }
});

test('semantic spec ownership is available without adding public spec fields', () => {
  for (const source of [
    'fn f u32 -> u32\npre add p0 1\nret p0\nend\n',
    'fn f u32 -> u32\nex true -> 0\nret p0\nend\n',
  ]) {
    const error = raised(() => validate(parseSource(source)));
    assert.equal(error.specOwner, 'f');
    assert.equal(error.spec, undefined);
    for (const value of [
      error,
      error.rewrite('another message'),
      error.reworded('another syntax', undefined, undefined),
      error.withEdits([], 'maybe'),
      new A0Error('copied', undefined, error.detailOf()),
    ]) {
      assert.equal(value.specOwner, 'f');
      assert.equal(Object.hasOwn(value.toJSON(), 'spec'), false);
      assert.equal(Object.hasOwn(value.toJSON(), 'specOwner'), false);
    }
  }
});

test('structured spec ownership ignores message wording and does not guess missing owners', async () => {
  const main = 'use "lib.a0"\n\nfn f -> u32\nret 0\nend\n';
  const injected = (error: A0Error) =>
    linkProject(
      entry,
      read(main),
      {
        acceptsPath: (path) => path.endsWith('.a0'),
        prepare(text) {
          const program = parseSource(text);
          return {
            uses: program.uses ?? [],
            async complete() {
              return { program, text };
            },
          };
        },
        check() {
          throw error;
        },
      },
      options,
    );
  for (const metadata of [{ spec: { function: 'f', ex: null } }, { specOwner: 'f' }]) {
    const error = new A0Error('spec is unrelated wording', undefined, { id: 'A0714', ...metadata });
    await assert.rejects(injected(error), (e: unknown) => {
      assert.ok(e instanceof A0Error);
      assert.equal(e.message, `${entry}:3: ${error.message}`);
      return true;
    });
  }
  for (const metadata of [{ spec: { function: 'missing', ex: null } }, { specOwner: 'missing' }]) {
    const error = new A0Error('spec of missing: bad', undefined, { id: 'A0714', ...metadata });
    await assert.rejects(injected(error), (e: unknown) => e === error);
  }
  for (const id of ['A0714', 'A0715', 'A0716', 'A0719']) {
    const error = new A0Error('spec of missing: bad', undefined, { id });
    await assert.rejects(injected(error), (e: unknown) => e === error);
  }
  const precedence = diag('A0714', ['missing', 'bad'], {
    spec: { function: 'missing', ex: null },
    specOwner: 'spec',
  });
  await assert.rejects(injected(precedence), (e: unknown) => e === precedence);
  const parsed = diag('A0714', ['f', 'bad'], {
    line: 2,
    spec: { function: 'f', ex: null },
  });
  await assert.rejects(injected(parsed), (e: unknown) => {
    assert.ok(e instanceof A0Error);
    assert.equal(e.message, `${join(root, 'lib.a0')}:2: ${parsed.detail}`);
    assert.equal(e.line, undefined);
    return true;
  });
  const ordinary = diag('A0105', ['f.ret', 9]);
  await assert.rejects(injected(ordinary), (e: unknown) => {
    assert.ok(e instanceof A0Error);
    assert.equal(e.message, `${entry}:4: ${ordinary.message}`);
    return true;
  });
});
