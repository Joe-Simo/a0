import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  A0Error,
  CHECKED_OP_NAMES,
  formatType,
  makeIo,
  parse,
  parseAndValidate,
  run,
  type Type,
  type TypedFunc,
  typeEquals,
} from '../src/core.js';
import { link } from '../src/link.js';
import { planChunks } from '../tools/bootstrap.js';
import { NONE, refCheckWords } from '../tools/ref-check.js';
import { IR_OPS, irWords, refLex, refParse, refSuggest } from '../tools/ref-parse.js';

/**
 * The self-hosted front end (compiler/parse.a0, check.a0, suggest.a0) against the TypeScript front
 * end (src/core.ts) on the strict-profile surface: the `profile strict` first line, and the six
 * checked operations cadd csub cmul cdiv crem cget, whose result is the tuple (u32,bool). Both
 * profiles, every operation, tuple results as records, and the programs each must reject. The
 * emitters of the compiler give structure code 2 (A0713) for a strict program and for a checked
 * operation, and are untouched for a canonical program.
 */

const FN_COUNT = 'fn f u32 -> u32\nret p0\nend\n';

/** Programs both front ends accept. */
const ACCEPTED: [string, string][] = [
  ['canonical', FN_COUNT],
  ['strict', `profile strict\n${FN_COUNT}`],
  [
    'strict with comments and blank lines',
    `\n# first\n\n  profile strict  # opt in\n\n${FN_COUNT}`,
  ],
  ['strict, no function', 'profile strict\n'],
  ['strict then use', `profile strict\nuse "x.a0"\n${FN_COUNT}`],
  [
    'a node and a function named profile and strict',
    'fn profile u32 -> u32\nstrict add p0 p0\nprofile mul strict 3\nret profile\nend\n',
  ],
  [
    'a node named profile in a strict program',
    'profile strict\nfn g u32 -> u32\nprofile add p0 p0\nret profile\nend\n',
  ],
  ...CHECKED_OP_NAMES.flatMap((op): [string, string][] => {
    const params = op === 'cget' ? 'u32x8 u32' : 'u32 u32';
    const body = `fn f ${params} -> (u32,bool)\nr ${op} p0 p1\nret r\nend\n`;
    const sugar = `fn f ${params} -> (u32,bool)\nret ${op} p0 p1\nend\n`;
    return [
      [`${op} canonical`, body],
      [`${op} strict`, `profile strict\n\n${body}`],
      [`${op} as ret sugar`, sugar],
      [`${op} strict as ret sugar`, `profile strict\n${sugar}`],
    ];
  }),
  [
    'tuple results as records, fields, calls, put, select and a literal index',
    [
      'fn lookup u32x8 u32 -> (u32,bool)',
      'r cget p0 p1',
      'ret r',
      'end',
      'fn divide u32 u32 -> u32',
      'r cdiv p0 p1',
      'v at r 0',
      'ok at r 1',
      'z select ok v 0',
      'ret z',
      'end',
      'fn both u32 u32 -> ((u32,bool),(u32,bool))',
      'a cadd p0 p1',
      'b csub p0 p1',
      'c rec a b',
      'ret c',
      'end',
      'fn mix u32 u32 -> (u32,bool)',
      'a cmul p0 p1',
      'b crem p0 p1',
      'bk at b 1',
      's select bk a b',
      'ret s',
      'end',
      'fn chain u32x8 u32 -> (u32,bool)',
      'a call lookup p0 p1',
      'x at a 0',
      'b call mix x p1',
      'c put b 0 7',
      'ret c',
      'end',
      'fn fill u32x4 -> u32x4',
      'ret p0',
      'end',
      'fn sum u32x4 u32 -> u32',
      'a cget p0 p1',
      'v at a 0',
      'ret v',
      'end',
      '',
    ].join('\n'),
  ],
  [
    'checked ops in a strict program with a fold over a tuple state',
    [
      'profile strict',
      'fn step (u32,bool) u32 -> (u32,bool)',
      's at p0 0',
      'k at p0 1',
      'n cadd s p1',
      'v at n 0',
      'o at n 1',
      'ok and k o',
      'r rec v ok',
      'ret r',
      'end',
      'fn top u32 -> (u32,bool)',
      'z rec 0 true',
      'r fold step 8 z',
      'ret r',
      'end',
      '',
    ].join('\n'),
  ],
];

/** Programs the self-hosted parser rejects: code 1 or 2, as the TypeScript parser or validate does. */
const REJECTED: [string, string][] = [
  ['profile alone', `profile\n${FN_COUNT}`],
  ['profile canonical', `profile canonical\n${FN_COUNT}`],
  ['profile Strict', `profile Strict\n${FN_COUNT}`],
  ['profile strict extra', `profile strict now\n${FN_COUNT}`],
  ['profile strict twice', `profile strict\nprofile strict\n${FN_COUNT}`],
  ['profile after a use', `use "x.a0"\nprofile strict\n${FN_COUNT}`],
  ['profile after a function', `${FN_COUNT}profile strict\n`],
  ['profile strict in the middle', `${FN_COUNT}\nprofile strict\nfn g u32 -> u32\nret p0\nend\n`],
  ['profile with an operand', 'profile add p0 p1\nfn f u32 -> u32\nret p0\nend\n'],
  ['profile strict at the end of the input', 'profile strict x'],
];

/** Programs the self-hosted checker rejects with the structure code 2 (the arity of a checked op, a field). */
const STRUCTURE = [
  ['checked op with one operand', 'fn f u32 -> (u32,bool)\nr cdiv p0\nret r\nend\n'],
  ['checked op with three operands', 'fn f u32 -> (u32,bool)\nr cadd p0 p0 p0\nret r\nend\n'],
  ['cget without operands', 'fn f u32x4 -> (u32,bool)\nr cget\nret r\nend\n'],
  ['field 2 of a checked result', 'fn f u32 u32 -> u32\nr cadd p0 p1\nv at r 2\nret v\nend\n'],
] as const;

/** Programs the self-hosted checker rejects (type 3): the TypeScript validate rejects them too. */
const ILL_TYPED = [
  ['cadd with a bool', 'fn f u32 bool -> (u32,bool)\nr cadd p0 p1\nret r\nend\n'],
  ['csub of two bools', 'fn f bool bool -> (u32,bool)\nr csub p0 p1\nret r\nend\n'],
  ['cmul of a tuple', 'fn f (u32,bool) u32 -> (u32,bool)\nr cmul p0 p1\nret r\nend\n'],
  ['cdiv result as u32', 'fn f u32 u32 -> u32\nr cdiv p0 p1\nret r\nend\n'],
  ['crem result as the wrong tuple', 'fn f u32 u32 -> (bool,u32)\nr crem p0 p1\nret r\nend\n'],
  ['cget of a scalar', 'fn f u32 u32 -> (u32,bool)\nr cget p0 p1\nret r\nend\n'],
  ['cget of an array of arrays', 'fn f u32x4x2 u32 -> (u32,bool)\nr cget p0 p1\nret r\nend\n'],
  ['cget of an array of bool', 'fn f boolx4 u32 -> (u32,bool)\nr cget p0 p1\nret r\nend\n'],
  ['cget with a bool index', 'fn f u32x4 bool -> (u32,bool)\nr cget p0 p1\nret r\nend\n'],
  ['checked result used as a number', 'fn f u32 u32 -> u32\nr cadd p0 p1\nv add r 1\nret v\nend\n'],
] as const;

const WORDS = (src: string): number[] => [Buffer.byteLength(src), ...Buffer.from(src)];

test('self-hosted parser: the profile directive and the checked ops, against the reference and parse()', async () => {
  const parser = (await link('compiler/parse.a0', (p) => readFile(p, 'utf8'))).program;
  const parseio = parser.byName.get('parseio') as TypedFunc;
  const a0 = (src: string): number[] => {
    const io = makeIo(WORDS(src));
    run(parseio, [io], { fuel: 1e12 });
    return io.output;
  };
  for (const [label, src] of ACCEPTED) {
    const want = irWords(refParse(src));
    assert.deepEqual(a0(src), want, `${label}: A0 parser and reference agree word for word`);
    const program = parse(src);
    assert.equal(want[0], 0, `${label}: accepted`);
    // the second word is the profile when there is no diagnostic
    assert.equal(want[1], program.profile === 'strict' ? 1 : 0, `${label}: profile`);
    const ir = refParse(src);
    assert.equal(ir.fns.length / 7, program.functions.length, label);
    let node = 0;
    for (const fn of program.functions)
      for (const n of fn.nodes) {
        const op = ir.nodes[node * 6 + 1] as number;
        assert.equal(
          IR_OPS[op - 1],
          n.text === undefined ? n.op : 'text',
          `${label} ${fn.name}.${n.id}`,
        );
        node += 1;
      }
  }
  for (const [label, src] of REJECTED) {
    const out = a0(src);
    const ref = refParse(src);
    assert.deepEqual(out, irWords(ref), `${label}: A0 parser and reference agree`);
    assert.ok(out[0] === 1 || out[0] === 2, `${label}: a diagnostic (${out[0]})`);
    assert.throws(() => parseAndValidate(src), A0Error, `${label}: parse() rejects too`);
  }
  // a malformed directive is the parse error of the token that is not as expected
  const at = (src: string): number => a0(src)[1] as number;
  assert.equal(at('profile\nfn f u32 -> u32\nret p0\nend\n'), 1);
  assert.equal(at('\n\nprofile strict x\n'), 4);
  assert.equal(at(`${FN_COUNT}profile strict\n`), 11);
  assert.equal(at('profile strict x'), 2);
  // a directive is blank to the later passes: tokens, and so every later diagnostic, keep their index
  const bad = 'profile strict\nfn f u32 -> u32\na add p0 q\nret a\nend\n';
  assert.deepEqual([a0(bad)[0], a0(bad)[1]], [2, 12]);
  assert.deepEqual(refLex(bad).slice(0, 6), [1, 0, 7, 1, 8, 6]);
});

test('self-hosted checker: the checked ops type as the TypeScript validate does, in both profiles', async () => {
  const checker = (await link('compiler/check.a0', (p) => readFile(p, 'utf8'))).program;
  const checkio = checker.byName.get('checkio') as TypedFunc;
  const a0 = (src: string): number[] => {
    const io = makeIo(WORDS(src));
    run(checkio, [io], { fuel: 1e12 });
    return io.output;
  };
  const decode = (types: readonly number[], tlist: readonly number[], t: number): Type => {
    const [tag, x, y] = [types[t * 3], types[t * 3 + 1], types[t * 3 + 2]] as [
      number,
      number,
      number,
    ];
    if (tag === 1) return 'u32';
    if (tag === 2) return 'bool';
    if (tag === 3) return 'io';
    if (tag === 4) return { kind: 'arr', length: x, elem: decode(types, tlist, y) };
    return { kind: 'rec', fields: tlist.slice(x, x + y).map((f) => decode(types, tlist, f)) };
  };
  for (const [label, src] of ACCEPTED) {
    if (src.includes('use "')) continue;
    const w = a0(src);
    assert.deepEqual(
      w,
      refCheckWords(src),
      `${label}: A0 checker and reference agree word for word`,
    );
    assert.equal(w[0], 1, `${label}: accepted`);
    const typed = parseAndValidate(src);
    const nt = w[4] as number;
    const nl = w[5 + nt] as number;
    const nodeTypes = w.slice(7 + nt + nl);
    let node = 0;
    for (const fn of typed.functions) {
      for (const n of fn.nodes) {
        const got = decode(
          w.slice(5, 5 + nt),
          w.slice(6 + nt, 6 + nt + nl),
          nodeTypes[node] as number,
        );
        assert.ok(
          typeEquals(got, fn.types.get(n.id) as Type),
          `${label} ${fn.name}.${n.id}: ${formatType(got)} vs ${formatType(fn.types.get(n.id) as Type)}`,
        );
        node += 1;
      }
    }
  }
  for (const [label, src] of ILL_TYPED) {
    const w = a0(src);
    assert.deepEqual(w, refCheckWords(src), `${label}: A0 checker and reference agree`);
    assert.equal(w[0], 0, label);
    assert.equal(w[1], 3, `${label}: a type error`);
    assert.notEqual(w[2], NONE, label);
    assert.throws(() => parseAndValidate(src), A0Error, `${label}: validate() rejects too`);
  }
  // the strict directive does not change what type checks: every program in both profiles
  for (const [label, src] of ACCEPTED) {
    if (
      /(^|\n)\s*profile strict/.test(src) ||
      src.includes('use "') ||
      label.includes('no function')
    )
      continue;
    assert.deepEqual(
      a0(`profile strict\n${src}`).slice(0, 4),
      a0(src).slice(0, 4),
      `${label}: strict`,
    );
  }
  for (const [label, src] of STRUCTURE) {
    const w = a0(src);
    assert.deepEqual(w, refCheckWords(src), `${label}: A0 checker and reference agree`);
    assert.deepEqual(w.slice(0, 2), [0, 2], `${label}: a structure error`);
    assert.throws(() => parseAndValidate(src), A0Error, `${label}: validate() rejects too`);
  }
});

test('self-hosted suggestions: the tokens of the profile line are not unknown names', async () => {
  const program = (await link('compiler/suggest.a0', (p) => readFile(p, 'utf8'), { root: '.' }))
    .program;
  const suggestio = program.byName.get('suggestio') as TypedFunc;
  const a0 = (src: string, tok: number): number[] => {
    const io = makeIo([...WORDS(src), tok]);
    run(suggestio, [io], { fuel: 2_000_000_000 });
    return io.output;
  };
  const sources = [
    'profile strikt\nfn f u32 -> u32\nret p0\nend\n',
    '\n\nprofile strict x\nfn f u32 -> u32\nret p0\nend\n',
    `profile strict\n${FN_COUNT}`,
    'profile strict\nfn f u32 u32 -> (u32,bool)\nr cadd p0 p1\nret r\nend\n',
    'fn f u32 -> u32\nprofile add p0 q\nret profile\nend\n',
    `${FN_COUNT}profile strict\n`,
  ];
  for (const src of sources)
    for (let tok = 0; tok <= refLex(src).length / 3; tok += 1)
      assert.deepEqual(a0(src, tok), refSuggest(src, tok), `${JSON.stringify(src)} token ${tok}`);
  // `strikt` is a malformed directive, not an unknown name with a suggestion
  assert.equal(a0('profile strikt\nfn f u32 -> u32\nret p0\nend\n', 1)[0], 0);
  // a node called profile in a body is an ordinary id: its operands are still checked for names
  assert.equal(a0('fn f u32 -> u32\nprofile add p0 q\nret profile\nend\n', 9)[0], 101);
});

test('self-hosted emitters refuse a strict program and a checked op with the structure code 2 (A0713) and leave canonical programs alone', async () => {
  const compiler = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
  const entry = (name: string): TypedFunc => compiler.byName.get(name) as TypedFunc;
  const compile = (name: string, src: string): [number, number] => {
    // the source, then head, strict and the first function of the chunk
    const io = makeIo([...WORDS(src), 1, 0, 0]);
    const code = run(entry(name), [io], { fuel: 1e13 }) as number;
    return [code, io.output.length];
  };
  const refused = [
    ['a strict program', `profile strict\n${FN_COUNT}`],
    ...CHECKED_OP_NAMES.map((op): [string, string] => [
      `${op}`,
      `fn f ${op === 'cget' ? 'u32x4' : 'u32'} u32 -> (u32,bool)\nr ${op} p0 p1\nret r\nend\n`,
    ]),
    [
      'a checked op in a strict program',
      `profile strict\nfn f u32 u32 -> (u32,bool)\nr cadd p0 p1\nret r\nend\n`,
    ],
  ] as const;
  const accepted = 'fn f u32 u32 -> u32\nr add p0 p1\nret r\nend\n';
  for (const name of ['emitchunkio', 'emitachunkio'] as const) {
    for (const [label, src] of refused) {
      const [code, words] = compile(name, src);
      assert.equal(code, 2, `${name}: ${label}`);
      assert.equal(words, 0, `${name}: ${label} writes nothing`);
    }
    // ill-typed stays a type error: the refusal is only for programs that are otherwise valid
    assert.equal(
      compile(name, 'profile strict\nfn f u32 bool -> (u32,bool)\nr cadd p0 p1\nret r\nend\n')[0],
      3,
      name,
    );
    const [code, words] = compile(name, accepted);
    assert.equal(code, 0, `${name}: canonical program`);
    assert.ok(words > 0, `${name}: canonical program emits`);
  }
  // the wasm entry: mode 1 is a source chunk, then the variant count, the call table (none) and
  // the first checked function (none)
  for (const [label, src] of refused) {
    const io = makeIo([1, ...WORDS(src), 1, 0, 0, 0, 0]);
    assert.equal(run(entry('emitwasmio'), [io], { fuel: 1e13 }), 2, `emitwasmio: ${label}`);
  }
});

test('a strict program cut into chunks stays strict in every chunk', () => {
  // more functions than the front end's table holds: the plan cuts it, and each chunk begins with
  // the directive, so the compiler refuses every chunk instead of compiling one as canonical
  const names = Array.from({ length: 1000 }, (_, i) => `f${i}`);
  const body = names.map((n) => `fn ${n} u32 -> u32\nret p0\nend\n`).join('');
  const chunks = planChunks(`profile strict\n${body}`);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.source.startsWith('profile strict\n'));
    assert.equal(refParse(c.source).tok, 1, 'the chunk is a strict program');
  }
  // a canonical program is cut as before, with no directive
  for (const c of planChunks(body)) assert.ok(!c.source.includes('profile'));
});
