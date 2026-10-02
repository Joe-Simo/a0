import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { compile, TARGETS } from '../src/backends.js';
import { emissionKey } from '../src/cache.js';
import {
  A0Error,
  formatFunction,
  formatProgram,
  formatSource,
  makeIo,
  parse,
  parseAndValidate,
  run,
  type TypedFunc,
  validate,
} from '../src/core.js';
import { formatDense, parseDense } from '../src/dense.js';
import {
  EditSession,
  formatRejection,
  programRevision,
  revision,
  semanticRevision,
} from '../src/edit.js';
import { verifyExample } from '../src/explain.js';
import { link } from '../src/link.js';
import {
  formatExample,
  formatLit,
  parseExample,
  SPEC_FUEL,
  specLines,
  withoutSpec,
} from '../src/spec.js';
import { irWords, refParse } from '../tools/ref-parse.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** The A0Error a thunk raises (the test fails when it does not raise). */
function raised(thunk: () => unknown): A0Error {
  try {
    thunk();
  } catch (e) {
    if (e instanceof A0Error) return e;
    throw e;
  }
  throw new Error('expected an A0Error');
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const fnOf = (source: string, name: string): TypedFunc =>
  parseAndValidate(source).byName.get(name) as TypedFunc;

const FULL = [
  'fn f u32 u32 -> u32',
  'ex 1 2 -> 3',
  'ex 5 5 -> 10',
  'pre lt p0 100',
  'post eq r r',
  's add p0 p1',
  'ret s',
  'end',
  '',
].join('\n');

const PLAIN = 'fn f u32 u32 -> u32\ns add p0 p1\nret s\nend\n';

// ---------------------------------------------------------------------------
// Surface: parse, print, round trip
// ---------------------------------------------------------------------------

test('spec lines: canonical parse and print, in the order ex, pre, post, whatever order is read', () => {
  const p = parse(FULL);
  assert.equal(formatProgram(p), FULL);
  const f = p.functions[0];
  assert.equal(f?.spec?.examples.length, 2);
  assert.equal(f?.spec?.pre?.id, 'pre');
  assert.equal(f?.spec?.post?.id, 'post');
  const shuffled = FULL.replace(
    'ex 1 2 -> 3\nex 5 5 -> 10\npre lt p0 100\npost eq r r',
    'post eq r r\npre lt p0 100\nex 1 2 -> 3\nex 5 5 -> 10',
  );
  assert.equal(formatProgram(parse(shuffled)), FULL);
  assert.ok(specLines(f?.spec).length === 4);
  validate(p);
});

test('spec lines are not nodes and not comments: no ids, no handles, and a function view shows them', () => {
  const typed = parseAndValidate(FULL);
  const fn = typed.byName.get('f') as TypedFunc;
  assert.deepEqual(
    fn.nodes.map((n) => n.id),
    ['s'],
  );
  const s = new EditSession(typed);
  const view = s.open('f').text;
  assert.ok(view.includes('ex 1 2 -> 3') && view.includes('pre lt p0 100'), view);
  assert.equal(s.open('f', { specs: 'hide' }).text.includes('ex 1 2'), false);
});

test('spec lines: literals of every type, tolerant spellings, one canonical print', () => {
  for (const [text, canon] of [
    ['5', '5'],
    ['true', 'true'],
    ['[1;2;3]', '[1;2;3]'],
    ['[1 2 3]', '[1;2;3]'],
    ['[1, 2, 3]', '[1;2;3]'],
    ['(1;true)', '(1;true)'],
    ['(1 true)', '(1;true)'],
    ['(7;)', '(7;)'],
    ['[[1;2];[3;4]]', '[[1;2];[3;4]]'],
    ['[(1;false);(2;true)]', '[(1;false);(2;true)]'],
  ] as const) {
    const ex = parseExample(`${text} -> ${text}`, 'f');
    assert.equal(formatExample(ex), `ex ${canon} -> ${canon}`);
    assert.equal(formatLit(ex.result), canon);
  }
  assert.equal(formatExample(parseExample('->7', 'f')), 'ex -> 7');
  for (const bad of [
    '(7)',
    '[',
    '[1;2',
    '4294967296 -> 1',
    '01 -> 1',
    'x -> 1',
    '1 ->',
    '1 2',
    '[] -> 1',
  ])
    assert.equal(raised(() => parseExample(bad, 'f')).id, 'A0714', bad);
});

test('spec lines: dense and canonical round trip, with comments, in both directions', () => {
  const source = [
    'fn g u32 u32 -> u32 # header',
    '# first example',
    'ex 1 2 -> 3 # trailing',
    'pre lt p0 100',
    'post eq r r',
    'a add p0 p1',
    'ret a',
    'end',
    '',
  ].join('\n');
  const p = parse(source);
  assert.equal(formatSource(p), source);
  assert.equal(formatSource(parse(formatSource(p))), source);
  for (const comments of [false, true]) {
    const dense = formatDense(p, { comments });
    assert.ok(dense.includes('pre lt A 100'), dense);
    assert.ok(dense.includes('post eq r r'), dense);
    const back = parseDense(dense);
    assert.equal(formatProgram(back), formatProgram(p));
    if (comments) assert.equal(formatSource(back), source);
  }
  const dense = formatDense(p);
  // a function with spec lines is never joined onto its header line
  assert.ok(dense.startsWith('fn g\nex 1 2 -> 3\npre lt A 100\npost eq r r\n'), dense);
  assert.equal(formatProgram(parseDense(formatDense(parse(FULL)))), FULL);
});

test('spec lines: dense keeps a first statement named pre or post out of the spec zone', () => {
  const p = parse(
    'fn f u32 -> u32\nex 1 -> 2\nx add p0 1\npre add x 0\nret pre\nend\nfn g u32 -> u32\nx call f p0\nret x\nend\n',
  );
  const dense = formatDense(p);
  assert.equal(formatProgram(parseDense(dense)), formatProgram(p));
  // a program whose first node is named pre prints `$pre` and reads back (canonical text cannot
  // carry such a node: a first `pre OP ARGS` line is a spec line)
  const first = {
    functions: [
      {
        name: 'h',
        params: ['u32' as const],
        result: 'u32' as const,
        nodes: [
          {
            id: 'pre',
            op: 'add' as const,
            args: [
              { kind: 'param' as const, index: 0 },
              { kind: 'u32' as const, value: 1 },
            ],
          },
        ],
        ret: { kind: 'node' as const, id: 'pre' },
      },
    ],
  };
  const text = formatDense(first);
  assert.ok(text.includes('$pre'), text);
  assert.equal(formatProgram(parseDense(text)), formatProgram(first));
});

test('spec lines: a node called ex, pre or post after the first node, or an ex node without an arrow, is an ordinary id', () => {
  const src = 'fn f u32 -> u32\nex add p0 1\npre add ex 1\npost add pre 1\nret post\nend\n';
  const p = parse(src);
  assert.equal(p.functions[0]?.spec, undefined);
  assert.equal(formatProgram(p), src);
  assert.equal(formatProgram(parseDense(formatDense(p))), src);
});

test('spec lines: only before the first node, at most one pre and one post, at most three examples', () => {
  assert.equal(
    raised(() => parse('fn f u32 -> u32\na add p0 1\nex 1 -> 2\nret a\nend\n')).id,
    'A0714',
  );
  assert.equal(
    raised(() => parse(`fn f u32 -> u32\n${'ex 1 -> 2\n'.repeat(4)}a add p0 1\nret a\nend\n`)).id,
    'A0714',
  );
  assert.equal(
    raised(() => parse('fn f u32 -> u32\npre lt p0 1\npre lt p0 2\na add p0 1\nret a\nend\n')).id,
    'A0714',
  );
  assert.equal(raised(() => parse('fn f u32 -> u32\npost\na add p0 1\nret a\nend\n')).id, 'A0714');
  assert.equal(
    parse(`fn f u32 -> u32\n${'ex 1 -> 2\n'.repeat(3)}a add p0 1\nret a\nend\n`).functions[0]?.spec
      ?.examples.length,
    3,
  );
});

// ---------------------------------------------------------------------------
// Verification: every operation and type
// ---------------------------------------------------------------------------

const CASES: readonly { label: string; src: string; wrong: [string, string] }[] = [
  {
    label: 'arithmetic and bitwise',
    src: 'fn f u32 u32 -> u32\nex 12 10 -> 12\nex 4294967295 1 -> 8\npre ne p0 p1\npost eq r r\na and p0 p1\nb or a 4\nc xor b p1\nd shl c 2\ne shr d 1\nret e\nend\n',
    wrong: ['-> 12\n', '-> 13\n'],
  },
  {
    label: 'wrapping add, sub, mul',
    src: 'fn f u32 u32 -> u32\nex 4294967295 2 -> 3\nex 0 1 -> 1\nex 65536 65536 -> 0\na add p0 p1\nb sub p1 p0\nc mul a b\nret c\nend\n',
    wrong: ['-> 3\n', '-> 4\n'],
  },
  {
    label: 'comparisons give bool',
    src: 'fn f u32 u32 -> bool\nex 1 2 -> true\nex 2 1 -> false\npre ne p0 p1\npost eq r r\na lt p0 p1\nret a\nend\n',
    wrong: ['ex 1 2 -> true', 'ex 1 2 -> false'],
  },
  {
    label: 'select over bool',
    src: 'fn f bool u32 u32 -> u32\nex true 3 4 -> 3\nex false 3 4 -> 4\nr select p0 p1 p2\nret r\nend\n',
    wrong: ['ex false 3 4 -> 4', 'ex false 3 4 -> 3'],
  },
  {
    label: 'div and rem, zero divisor included',
    src: 'fn f u32 u32 -> u32\nex 7 2 -> 1\nex 7 0 -> 7\nex 0 5 -> 0\na rem p0 p1\nret a\nend\n',
    wrong: ['ex 7 0 -> 7', 'ex 7 0 -> 0'],
  },
  {
    label: 'arrays: arr, get, set',
    src: 'fn f u32x3 u32 -> u32x3\nex [1;2;3] 9 -> [1;9;3]\nex [4;5;6] 0 -> [4;0;6]\na get p0 1\nb add a 7\nc set p0 1 p1\nret c\nend\n',
    wrong: ['-> [1;9;3]', '-> [1;9;4]'],
  },
  {
    label: 'arrays built in the body, the length is not a parameter',
    src: 'fn f -> u32x2\nex -> [104;105]\na text "hi"\nret a\nend\n',
    wrong: ['-> [104;105]', '-> [104;106]'],
  },
  {
    label: 'records: rec, at, put',
    src: 'fn f u32 bool -> (u32,bool)\nex 5 true -> (5;true)\nex 6 false -> (6;false)\na rec p0 p1\nret a\nend\nfn g (u32,bool) -> u32\nex (4;false) -> 4\na at p0 0\nret a\nend\nfn h (u32,bool) u32 -> (u32,bool)\nex (1;true) 9 -> (9;true)\na put p0 0 p1\nret a\nend\n',
    wrong: ['-> (5;true)', '-> (5;false)'],
  },
  {
    label: 'nested aggregates',
    src: 'fn f u32x2x2 -> u32\nex [[1;2];[3;4]] -> 4\na get p0 1\nb get a 1\nret b\nend\n',
    wrong: ['-> 4\n', '-> 3\n'],
  },
  {
    label: 'call, with a helper as pre and post',
    src: 'fn below u32 u32 -> bool\na lt p0 p1\nret a\nend\nfn inc u32 -> u32\na add p0 1\nret a\nend\nfn f u32 -> u32\nex 1 -> 3\npre below p0 100\npost call below p0 r\na call inc p0\nb call inc a\nret b\nend\n',
    wrong: ['ex 1 -> 3', 'ex 1 -> 4'],
  },
  {
    label: 'fold',
    src: 'fn step u32 u32 -> u32\na add p0 p1\nret a\nend\nfn f u32 -> u32\nex 5 -> 10\nex 0 -> 0\na fold step p0 0\nret a\nend\n',
    wrong: ['ex 5 -> 10', 'ex 5 -> 11'],
  },
  {
    label: 'loop',
    src: 'fn small u32 u32 -> bool\na lt p0 5\nret a\nend\nfn bump u32 u32 -> u32\na add p0 2\nret a\nend\nfn f u32 -> u32\nex 100 -> 6\nex 1 -> 2\na loop small bump p0 0\nret a\nend\n',
    wrong: ['ex 100 -> 6', 'ex 100 -> 5'],
  },
  {
    label: 'checked operations give (value, ok)',
    src: 'fn f u32 u32 -> (u32,bool)\nex 4294967295 2 -> (1;false)\nex 3 4 -> (7;true)\na cadd p0 p1\nret a\nend\n',
    wrong: ['-> (1;false)', '-> (1;true)'],
  },
];

test('spec lines: every operation and type, passing and failing', () => {
  for (const { label, src, wrong } of CASES) {
    validate(parse(src));
    const bad = src.replace(wrong[0], wrong[1]);
    assert.notEqual(bad, src, label);
    const e = raised(() => validate(parse(bad)));
    assert.equal(e.id, 'A0715', `${label}: ${e.message}`);
  }
});

test('spec lines: the failure names the function, the example, the input, the expected and the actual', () => {
  const e = raised(() => parseAndValidate(FULL.replace('ex 5 5 -> 10', 'ex 5 5 -> 11')));
  assert.equal(e.id, 'A0715');
  assert.equal(e.message, 'f: ex 2 failed: input 5 5, expected 11, got 10');
  assert.equal(e.expected, '11');
  assert.equal(e.actual, '10');
  assert.match(e.fix ?? '', /ex 5 5 -> 10/);
  assert.equal(e.code, 'structure');
});

test('spec lines: pre and post are evaluated on each example', () => {
  const pre = raised(() =>
    parseAndValidate(
      FULL.replace('ex 5 5 -> 10', 'ex 99 5 -> 104').replace('lt p0 100', 'lt p0 50'),
    ),
  );
  assert.equal(pre.id, 'A0716');
  assert.match(pre.message, /^f: ex 2 breaks pre: the input 99 5 does not satisfy pre$/);
  const post = raised(() => parseAndValidate(FULL.replace('eq r r', 'lt r p0')));
  assert.equal(post.id, 'A0716');
  assert.match(
    post.message,
    /^f: ex 1 breaks post: the input 1 2 gives 3, which does not satisfy post$/,
  );
  // r is for post only, and nodes of the function are invisible to both
  assert.equal(raised(() => parseAndValidate(FULL.replace('lt p0 100', 'lt r 100'))).id, 'A0714');
  assert.equal(raised(() => parseAndValidate(FULL.replace('eq r r', 'eq s r'))).id, 'A0714');
  // a contract is bool
  assert.equal(raised(() => parseAndValidate(FULL.replace('lt p0 100', 'add p0 100'))).id, 'A0714');
  // the contracts alone, without an example, are typed but have nothing to run
  parseAndValidate(FULL.replace('ex 1 2 -> 3\nex 5 5 -> 10\n', ''));
});

test('spec lines: type and shape errors are A0714', () => {
  const at = (line: string, params = 'u32 u32'): string =>
    `fn f ${params} -> u32\n${line}\ns add p0 p1\nret s\nend\n`;
  for (const line of [
    'ex 1 -> 2',
    'ex 1 2 3 -> 4',
    'ex 1 true -> 2',
    'ex 1 2 -> true',
    'ex [1;2] 2 -> 3',
    'pre lt p0 p9',
    'pre foo p0',
  ])
    assert.equal(raised(() => parseAndValidate(at(line))).id, 'A0714', line);
  assert.equal(
    raised(() => parseAndValidate('fn f u32x3 -> u32\nex [1;2] -> 3\ns get p0 0\nret s\nend\n')).id,
    'A0714',
  );
  // io functions carry no spec
  assert.equal(
    raised(() => parseAndValidate('fn f io -> io\nex 1 -> 2\nret p0\nend\n')).id,
    'A0714',
  );
});

test('spec lines: an example runs under a small fuel; a strict trap is a failed example', () => {
  const heavy =
    'fn inc u32 u32 -> u32\na add p0 1\nret a\nend\nfn f u32 -> u32\nex 1 -> 20001\nr fold inc 20000 p0\nret r\nend\n';
  assert.equal(raised(() => parseAndValidate(heavy)).id, 'A0719');
  assert.ok(SPEC_FUEL === 10_000);
  const strict = 'profile strict\nfn f u32 -> u32\nex 5 -> 0\na arr 1 2\nb get a p0\nret b\nend\n';
  const e = raised(() => parseAndValidate(strict));
  assert.equal(e.id, 'A0715');
  assert.match(e.message, /trap bounds/);
  // canonical wraps the index, so the same example is a plain result
  parseAndValidate(strict.replace('profile strict\n', '').replace('-> 0', '-> 2'));
});

test('spec lines: the explain examples of the new rows hold', () => {
  for (const id of ['A0714', 'A0715', 'A0716', 'A0719', 'A0720'] as const)
    assert.deepEqual(verifyExample(id), [], id);
});

// ---------------------------------------------------------------------------
// Opt-in: no change for a function without spec lines
// ---------------------------------------------------------------------------

test('spec lines: revision includes them, semanticRevision and emission do not', () => {
  const plain = parseAndValidate(PLAIN);
  const spec = parseAndValidate(FULL);
  const p = plain.byName.get('f') as TypedFunc;
  const s = spec.byName.get('f') as TypedFunc;
  assert.notEqual(revision(p), revision(s));
  assert.notEqual(programRevision(plain), programRevision(spec));
  assert.equal(semanticRevision(p), semanticRevision(s));
  assert.equal(revision(withoutSpec(s)), revision(p));
  assert.equal(formatFunction(withoutSpec(s)), formatFunction(p));
  assert.equal(emissionKey('js', p, { optimize: true }), emissionKey('js', s, { optimize: true }));
  for (const target of TARGETS)
    for (const optimize of [true, false])
      assert.equal(
        compile(spec, target, { optimize, x86Platform: 'darwin' }).text,
        compile(plain, target, { optimize, x86Platform: 'darwin' }).text,
        `${target} ${optimize}`,
      );
  // a callee's spec does not change a caller's key either
  const calls = (head: string): TypedFunc =>
    fnOf(`${head}fn g u32 u32 -> u32\na call f p0 p1\nret a\nend\n`, 'g');
  assert.equal(semanticRevision(calls(PLAIN)), semanticRevision(calls(FULL)));
  // and the interpreter runs the function the same
  assert.equal(run(p, [3, 4]), run(s, [3, 4]));
});

const GOLDEN = resolve(ROOT, 'test', 'golden', 'spec-free-digests.json');
const SCANNED = ['compiler', 'corpus', 'examples', 'editors', 'site'];

function a0Files(dir: string, out: string[] = [], depth = 0): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'gen' && depth < 4) a0Files(path, out, depth + 1);
    } else if (name.endsWith('.a0')) out.push(path);
  }
  return out;
}

test('spec lines: a program without them has the canonical text, hashes, dense text and diagnostics it had before', () => {
  const files = SCANNED.flatMap((d) => a0Files(join(ROOT, d))).sort();
  const now: Record<string, Record<string, string>> = {};
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const row: Record<string, string> = {};
    try {
      const p = parse(src);
      row.canonical = sha(formatProgram(p));
      row.source = sha(formatSource(p));
      row.revision = programRevision(p);
      try {
        row.dense = sha(formatDense(p));
      } catch (e) {
        row.dense = `error: ${(e as Error).message}`.slice(0, 120);
      }
      try {
        const typed = validate(p);
        row.semantic = sha(typed.functions.map((f) => semanticRevision(f)).join(','));
      } catch (e) {
        row.semantic = `error: ${(e as A0Error).id ?? ''} ${(e as Error).message}`.slice(0, 120);
      }
      for (const f of p.functions) assert.equal(f.spec, undefined, `${file} ${f.name}`);
    } catch (e) {
      row.error = `${(e as A0Error).id ?? ''} ${(e as Error).message}`.slice(0, 160);
    }
    now[relative(ROOT, file)] = row;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof now;
  assert.deepEqual(Object.keys(now), Object.keys(golden));
  const changed = Object.keys(golden).filter(
    (k) => JSON.stringify(golden[k]) !== JSON.stringify(now[k]),
  );
  assert.deepEqual(changed, [], 'a file without spec lines changed its text, hashes or diagnostic');
});

// ---------------------------------------------------------------------------
// The edit protocol
// ---------------------------------------------------------------------------

const BASE = 'fn f u32 -> u32\nex 1 -> 2\nex 5 -> 6\na add p0 1\nret a\nend\n';

test('edits: a wrong edit is rejected atomically with the example it breaks; removing the example is allowed', () => {
  const s = new EditSession(parseAndValidate(BASE));
  s.open('f');
  const before = programRevision(s.program);
  const wrong = 'a add p0 2';
  const e = raised(() => s.apply(`e0\n${wrong}`));
  assert.equal(e.id, 'A0715');
  assert.match(e.message, /^f: ex 1 failed: input 1, expected 2, got 3$/);
  assert.equal(programRevision(s.program), before);
  const rejection = s.diagnose(`e0\n${wrong}`);
  assert.ok(rejection !== undefined);
  assert.match(String(rejection?.error.id), /A0715/);
  // removing the examples (a patch that removes an `ex` line is always allowed) lets the edit in
  s.apply('e0\n-ex 1 -> 2\n-ex 5 -> 6');
  assert.equal(parseAndValidate(formatProgram(s.program)).byName.get('f')?.spec, undefined);
  s.apply(`e0\n${wrong}`);
  assert.equal(run(s.program.byName.get('f') as TypedFunc, [1]), 3);
});

test('edits: +ex adds, +pre and +post set, -pre and -post remove; a bad one is rejected whole', () => {
  const s = new EditSession(parseAndValidate(BASE));
  s.open('f');
  s.apply('e0\n+ex 9 -> 10\n+pre lt p0 100\n+post lt p0 r');
  const f = (): TypedFunc => s.program.byName.get('f') as TypedFunc;
  assert.deepEqual(specLines(f().spec), [
    'ex 1 -> 2',
    'ex 5 -> 6',
    'ex 9 -> 10',
    'pre lt p0 100',
    'post lt p0 r',
  ]);
  // +ex of an existing example is a no-op, +pre replaces
  s.apply('e0\n+ex 9 -> 10\n+pre lt p0 50');
  assert.deepEqual(specLines(f().spec), [
    'ex 1 -> 2',
    'ex 5 -> 6',
    'ex 9 -> 10',
    'pre lt p0 50',
    'post lt p0 r',
  ]);
  s.apply('e0\n-ex 9 -> 10');
  const before = programRevision(s.program);
  assert.equal(raised(() => s.apply('e0\n+ex 3 -> 99')).id, 'A0715');
  assert.equal(raised(() => s.apply('e0\n-ex 5 -> 6\n+ex 3 -> 4\n+ex 7 -> 99')).id, 'A0715');
  assert.equal(raised(() => s.apply('e0\n+ex 3 -> 4\n+ex 7 -> 8')).id, 'A0714', 'a fourth example');
  assert.equal(programRevision(s.program), before, 'nothing of a rejected reply stays');
  assert.equal(raised(() => s.apply('e0\n+ex 1 2 -> 3')).id, 'A0714');
  s.apply('e0\n-pre\n-post');
  assert.deepEqual(specLines(f().spec), ['ex 1 -> 2', 'ex 5 -> 6']);
  assert.equal(raised(() => s.apply('e0\n-ex 9 -> 10')).id, 'A0720');
  assert.equal(
    raised(() => s.apply('e0\n-pre')).id,
    'A0506',
    'no spec line and no node: a node deletion error',
  );
  // an ex written with another spelling of the same literals is the same example
  s.apply('e0\n-ex 1 -> 2');
  assert.deepEqual(specLines(f().spec), ['ex 5 -> 6']);
});

test('edits: a spec edit and a node edit in one reply apply together or not at all', () => {
  const s = new EditSession(parseAndValidate(BASE));
  s.open('f');
  s.apply('e0\n-ex 1 -> 2\n-ex 5 -> 6\n+ex 1 -> 3\na add p0 2');
  const f = s.program.byName.get('f') as TypedFunc;
  assert.deepEqual(specLines(f.spec), ['ex 1 -> 3']);
  assert.equal(run(f, [1]), 3);
});

test('edits: a program handle edits a function by name, `f:+ex ...`', () => {
  const s = new EditSession(parseAndValidate(BASE));
  s.openProgram();
  s.apply('g0\nf:+ex 7 -> 8\nf:-ex 1 -> 2');
  assert.deepEqual(specLines((s.program.byName.get('f') as TypedFunc).spec), [
    'ex 5 -> 6',
    'ex 7 -> 8',
  ]);
  assert.equal(raised(() => s.apply('g0\n+ex 7 -> 8')).id, 'A0510');
});

test('edits: a whole-function replacement carries its own spec lines; without them it drops them', () => {
  const s = new EditSession(parseAndValidate(BASE));
  s.open('f');
  s.apply('e0\nfn f u32 -> u32\nex 3 -> 4\na add p0 1\nret a\nend');
  assert.deepEqual(specLines((s.program.byName.get('f') as TypedFunc).spec), ['ex 3 -> 4']);
  s.apply('e0\nfn f u32 -> u32\na add p0 1\nret a\nend');
  assert.equal((s.program.byName.get('f') as TypedFunc).spec, undefined);
});

test('edits: a view that hides the spec lines keeps them through a whole-function replacement', () => {
  const s = new EditSession(parseAndValidate(BASE));
  s.open('f', { specs: 'hide' });
  s.apply('e0\nfn f u32 -> u32\na add p0 1\nret a\nend');
  assert.deepEqual(specLines((s.program.byName.get('f') as TypedFunc).spec), [
    'ex 1 -> 2',
    'ex 5 -> 6',
  ]);
  // and still rejects a replacement that breaks them
  assert.equal(raised(() => s.apply('e0\nfn f u32 -> u32\na add p0 2\nret a\nend')).id, 'A0715');
});

test('edits: numbered views number the spec lines, and a line edit can replace or delete one', () => {
  const s = new EditSession(parseAndValidate(BASE));
  const view = s.open('f', { numbered: true }).text;
  assert.ok(
    view.includes('1 ex 1 -> 2') && view.includes('2 ex 5 -> 6') && view.includes('3 a add p0 1'),
    view,
  );
  s.apply('e0\n1- \n2 ex 5 -> 6');
  assert.deepEqual(specLines((s.program.byName.get('f') as TypedFunc).spec), ['ex 5 -> 6']);
});

test('edits: a rejection of a spec failure says so', () => {
  const s = new EditSession(parseAndValidate(BASE));
  s.open('f');
  const r = s.diagnose('e0\na add p0 2');
  assert.ok(r !== undefined);
  const text = formatRejection(r);
  assert.match(text, /spec line/);
  assert.match(text, /fix: if f is right|fix: make f return/);
});

test('edits: dense replies, +pre in dense spelling, and a dense whole-function replacement', () => {
  const s = new EditSession(parseAndValidate(BASE));
  s.open('f', { dense: true });
  const view = s.view('e0');
  assert.ok(view.includes('ex 1 -> 2'), view);
  s.apply('e0\n+pre < A 100\n+ex 9 -> 10');
  assert.deepEqual(specLines((s.program.byName.get('f') as TypedFunc).spec), [
    'ex 1 -> 2',
    'ex 5 -> 6',
    'ex 9 -> 10',
    'pre lt p0 100',
  ]);
  assert.equal(raised(() => s.apply('e0\n+pre + A 1')).id, 'A0714');
  s.apply('e0\nfn f\nex 3 -> 4\n+ A 1');
  assert.deepEqual(specLines((s.program.byName.get('f') as TypedFunc).spec), ['ex 3 -> 4']);
  assert.equal(raised(() => s.apply('e0\nfn f\nex 3 -> 5\n+ A 1')).id, 'A0715');
});

// ---------------------------------------------------------------------------
// The self-hosted front end refuses them, with a structure diagnostic
// ---------------------------------------------------------------------------

test('self-hosted parser: a spec line is a structure refusal (code 2) at its first token, as the reference says', async () => {
  const parser = (
    await link('compiler/parse.a0', async (p) => readFileSync(p, 'utf8'), { root: ROOT })
  ).program;
  const parseio = parser.byName.get('parseio') as TypedFunc;
  const words = (src: string): number[] => [Buffer.byteLength(src), ...Buffer.from(src)];
  const a0 = (src: string): number[] => {
    const io = makeIo(words(src));
    run(parseio, [io], { fuel: 1e12 });
    return io.output;
  };
  const refused: [string, string, number][] = [
    ['ex', 'fn f u32 -> u32\nex 1 -> 2\na add p0 1\nret a\nend\n', 6],
    ['ex without arguments', 'fn f -> u32\nex -> 2\nret 2\nend\n', 5],
    ['pre', 'fn f u32 -> u32\npre lt p0 5\na add p0 1\nret a\nend\n', 6],
    ['post', 'fn f u32 -> u32\npost eq r r\na add p0 1\nret a\nend\n', 6],
    ['after a spec line', 'fn f u32 -> u32\nex 1 -> 2\npre lt p0 5\na add p0 1\nret a\nend\n', 6],
    [
      'in the second function',
      'fn g u32 -> u32\nret p0\nend\nfn f u32 -> u32\nex 1 -> 2\nret p0\nend\n',
      17,
    ],
    ['an arrow with no spaces', 'fn f u32 -> u32\nex 1->2\nret p0\nend\n', 6],
  ];
  for (const [label, src, token] of refused) {
    const out = a0(src);
    assert.deepEqual(out, irWords(refParse(src)), `${label}: A0 parser and reference agree`);
    assert.equal(out[0], 2, `${label}: structure refusal`);
    assert.equal(out[1], token, `${label}: the first token of the line`);
    // the TypeScript front end accepts the same program (with its spec lines), so this is a refusal
    // of the feature, not a divergence in meaning
    assert.ok(
      parse(src).functions.some((f) => f.spec !== undefined),
      label,
    );
  }
  // not spec lines: nodes called ex, pre and post after the first node, and an `ex` node
  const ordinary = [
    'fn f u32 -> u32\nex add p0 1\npre add ex 1\npost add pre 1\nret post\nend\n',
    'fn f u32 -> u32\na add p0 1\nex add a 1\nret ex\nend\n',
    'fn f u32 -> u32\na add p0 1\npre add a 1\nret pre\nend\n',
  ];
  for (const src of ordinary) {
    const out = a0(src);
    assert.equal(out[0], 0, src);
    assert.deepEqual(out, irWords(refParse(src)), src);
    assert.equal(parse(src).functions[0]?.spec, undefined, src);
  }
  // spec free programs read as before, and the spec text after an earlier error keeps that error
  assert.equal(a0('fn f u32 -> u32\nret p0\nend\n')[0], 0);
  assert.equal(a0('use "x.a0" y\nfn f u32 -> u32\nex 1 -> 2\nret p0\nend\n')[0], 1);
});
