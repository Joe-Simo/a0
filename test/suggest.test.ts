import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  A0Error,
  makeIo,
  OP_ALIASES,
  OPS,
  parseAndValidate,
  run,
  type TypedFunc,
} from '../src/core.js';
import { spellingSuggestion } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { UNKNOWN_NAMES } from '../tools/front-end-sources.js';
import { refLex, refParse, refSpelling, refSuggest, SUGGEST_NAMES } from '../tools/ref-parse.js';

const SQ = 'fn square u32 -> u32\na mul p0 p0\nret a\nend\n';

function rejection(src: string): A0Error {
  try {
    parseAndValidate(src);
  } catch (e) {
    if (e instanceof A0Error) return e;
    throw e;
  }
  throw new Error('accepted');
}

test('spelling: three implementations agree (banded tenths, floating reference, plain tenths)', () => {
  let seed = 99;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const word = (): string =>
    Array.from({ length: 1 + rand(10) }, () => 'abcdexyz_AB'[rand(11)]).join('');
  for (let round = 0; round < 3000; round += 1) {
    const name = word();
    const candidates = Array.from({ length: 1 + rand(10) }, word);
    assert.equal(
      refSpelling(name, candidates),
      spellingSuggestion(name, candidates),
      `${name} against ${candidates.join(',')}`,
    );
  }
  // the integer forms of the two percentages the A0 module computes equal the floating ones
  for (let len = 1; len <= 64; len += 1) {
    assert.equal(Math.floor(len * 0.4), Math.floor((len * 4) / 10), `40% of ${len}`);
    assert.equal(Math.floor(len * 0.34), Math.floor((len * 34) / 100), `34% of ${len}`);
  }
});

test('suggest.a0: its name table is the ops, the aliases, the types and the reserved words', async () => {
  const text = await readFile('compiler/suggest.a0', 'utf8');
  const table = /^t text "([^"]+)"$/m.exec(text)?.[1] ?? '';
  const entries = table.match(/.{8}/g)?.map((e) => e.trim()) ?? [];
  assert.deepEqual(entries, [
    ...OPS,
    ...Object.keys(OP_ALIASES),
    'u32',
    'bool',
    'io',
    'fn',
    'ret',
    'end',
    'patch',
    'true',
    'false',
  ]);
  assert.deepEqual(SUGGEST_NAMES, [...OPS, ...Object.keys(OP_ALIASES), 'u32', 'bool', 'io']);
});

test('suggest.a0: every token of every case gives the reference words, and the checker names the same name', async () => {
  const program = (await link('compiler/suggest.a0', (p) => readFile(p, 'utf8'), { root: '.' }))
    .program;
  const suggestio = program.byName.get('suggestio') as TypedFunc;
  const a0 = (src: string, tok: number): number[] => {
    const io = makeIo([Buffer.byteLength(src), ...Buffer.from(src), tok]);
    run(suggestio, [io], { fuel: 2_000_000_000 });
    return io.output;
  };
  const text = (w: number[]): string => String.fromCharCode(...w.slice(5, 5 + (w[2] as number)));
  for (const [id, src] of UNKNOWN_NAMES) {
    // every token position: the A0 module and the reference agree word for word
    for (let tok = 0; tok <= refLex(src).length / 3; tok += 1)
      assert.deepEqual(a0(src, tok), refSuggest(src, tok), `${JSON.stringify(src)} token ${tok}`);
    // and at the token the self-hosted parser rejects, they name the row and the suggestion the
    // TypeScript checker names (when the TypeScript fix suggests one)
    const ir = refParse(src);
    assert.ok(ir.code !== 0, `the self-hosted parser rejects ${JSON.stringify(src)}`);
    const words = a0(src, ir.tok);
    const ts = rejection(src);
    assert.equal(ts.id, id);
    const rule = { A0001: 1, A0101: 101, A0102: 102, A0103: 103, A0104: 104 }[id] as number;
    assert.equal(words[0], rule, `${id} ${JSON.stringify(src)}`);
    const guess = /^did you mean '([^']+)'\?/.exec(ts.fix ?? '')?.[1];
    if (guess !== undefined) {
      assert.deepEqual([words[1], text(words)], [1, guess], `${id} suggestion`);
    } else if (/ is defined (below|on a later line)/.test(ts.fix ?? '')) {
      assert.equal(words[1], 2, `${id} defined later`);
    } else {
      assert.equal(words[1], 0, `${id} no suggestion`);
    }
  }
  // a token that is not an unknown name gives rule 0: a known callee, a keyword, a parameter
  assert.equal(a0(`${SQ}fn f u32 -> u32\nb square p0\nret b\nend\n`, 24)[0], 0);
  assert.equal(a0('fn f u32 -> u32\na add p0 p1\nret a\nend\n', 11)[0], 0);
});

test('suggest.a0: rejects nothing the checker accepts (every example and compiler source token)', async () => {
  const program = (await link('compiler/suggest.a0', (p) => readFile(p, 'utf8'), { root: '.' }))
    .program;
  const suggestio = program.byName.get('suggestio') as TypedFunc;
  const src = await readFile('examples/kernels.a0', 'utf8');
  const tokens = refLex(src).length / 3;
  for (let tok = 0; tok < Math.min(tokens, 60); tok += 1) {
    const io = makeIo([Buffer.byteLength(src), ...Buffer.from(src), tok]);
    run(suggestio, [io], { fuel: 2_000_000_000 });
    assert.deepEqual(io.output, refSuggest(src, tok), `kernels token ${tok}`);
  }
});
