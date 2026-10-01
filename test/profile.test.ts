import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { compile, TARGETS } from '../src/backends.js';
import { emissionKey } from '../src/cache.js';
import {
  A0Error,
  evalOp,
  formatDiagnostic,
  formatProgram,
  formatSource,
  makeIo,
  type Op,
  parse,
  parseAndValidate,
  run,
  type StrictTrap,
  type TypedFunc,
  type Value,
} from '../src/core.js';
import { formatDense, parseDense } from '../src/dense.js';
import { EditSession, programRevision, revision, semanticRevision } from '../src/edit.js';
import { verifyExample } from '../src/explain.js';
import { link } from '../src/link.js';
import { generateCorpus, oracleRun, oracleToValue, valueToOracle } from '../tools/corpus.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const STRICT = 'profile strict\n';

const fnOf = (source: string, name: string): TypedFunc =>
  parseAndValidate(source).byName.get(name) as TypedFunc;

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

const PICK = (head: string): string =>
  `${head}fn pick u32 -> u32\na arr 10 20 30\nb get a p0\nret b\nend\n`;
const PUT = (head: string): string =>
  `${head}fn upd u32 -> u32x3\na arr 10 20 30\nb set a p0 99\nret b\nend\n`;
const DIV = (head: string, op: 'div' | 'rem'): string =>
  `${head}fn q u32 u32 -> u32\na ${op} p0 p1\nret a\nend\n`;

// ---------------------------------------------------------------------------
// Strict semantics in the interpreter: the four traps
// ---------------------------------------------------------------------------

test('strict get/set: the last index is fine, the length and beyond trap bounds; canonical wraps', () => {
  const strict = fnOf(PICK(STRICT), 'pick');
  const canon = fnOf(PICK(''), 'pick');
  assert.deepEqual(
    [0, 1, 2].map((i) => run(strict, [i])),
    [10, 20, 30],
  );
  for (const i of [3, 4, 0xffff_ffff]) {
    const e = raised(() => run(strict, [i]));
    assert.equal(e.id, 'A0710');
    assert.equal(e.code, 'runtime');
    assert.deepEqual(e.trap, { kind: 'bounds', fn: 'pick', at: null, trip: null, chain: ['pick'] });
    assert.equal(run(canon, [i]), [10, 20, 30][i % 3]);
  }
  const set = fnOf(PUT(STRICT), 'upd');
  assert.deepEqual(run(set, [2]), [10, 20, 99]);
  assert.equal(raised(() => run(set, [3])).id, 'A0710');
  assert.deepEqual(run(fnOf(PUT(''), 'upd'), [4]), [10, 99, 30]);
});

test('strict div/rem by zero trap divzero; canonical keeps all-ones and the dividend', () => {
  for (const op of ['div', 'rem'] as const) {
    const strict = fnOf(DIV(STRICT, op), 'q');
    const canon = fnOf(DIV('', op), 'q');
    assert.equal(run(strict, [7, 2]), op === 'div' ? 3 : 1);
    assert.equal(run(strict, [0, 1]), 0);
    const e = raised(() => run(strict, [7, 0]));
    assert.equal(e.id, 'A0711');
    assert.equal(e.trap?.kind, 'divzero');
    assert.equal(run(canon, [7, 0]), op === 'div' ? 0xffff_ffff : 7);
  }
});

test('strict read of exhausted input traps input; canonical yields 0 and keeps the position', () => {
  const body = 'fn rd io -> (u32,io)\nr read p0\nret r\nend\n';
  const strict = fnOf(`${STRICT}${body}`, 'rd');
  const canon = fnOf(body, 'rd');
  assert.equal((run(strict, [makeIo([7])]) as Value[])[0], 7);
  const e = raised(() => run(strict, [makeIo([])]));
  assert.equal(e.id, 'A0712');
  assert.equal(e.trap?.kind, 'input');
  assert.equal((run(canon, [makeIo([])]) as Value[])[0], 0);
});

test('strict at/put past the field count trap bounds in the evaluator (the checker already forbids them in source)', () => {
  const strict: StrictTrap = (kind) => {
    throw new Error(kind);
  };
  assert.throws(() => evalOp('at', [[1, 2], 2], strict), /bounds/);
  assert.throws(() => evalOp('put', [[1, 2], 2, 9], strict), /bounds/);
  assert.deepEqual(evalOp('put', [[1, 2], 1, 9], strict), [1, 9]);
  assert.equal(evalOp('at', [[1, 2], 1], strict), 2);
});

test('strict add, sub, mul and the shifts still wrap', () => {
  const src = `${STRICT}fn w u32 u32 -> u32
a add p0 p1
b sub p0 p1
c mul p0 p1
d shl p0 p1
e shr p0 p1
f xor a b
g xor f c
h xor g d
i xor h e
ret i
end
`;
  const strict = fnOf(src, 'w');
  const canon = fnOf(src.replace(STRICT, ''), 'w');
  for (const [x, y] of [
    [0xffff_ffff, 1],
    [0, 1],
    [0x8000_0000, 33],
    [0xffff_ffff, 0xffff_ffff],
  ] as const)
    assert.equal(run(strict, [x, y]), run(canon, [x, y]));
});

test('the trap names the fold node and the trip, as the budget traps do', () => {
  const src = `${STRICT}fn step u32 u32 -> u32
a arr 1 2 3
b get a p1
c add p0 b
ret c
end
fn top u32 -> u32
r fold step p0 0
ret r
end
`;
  const top = fnOf(src, 'top');
  assert.equal(run(top, [3]), 6);
  const e = raised(() => run(top, [5]));
  assert.deepEqual(e.trap, {
    kind: 'bounds',
    fn: 'step',
    at: 'top.r',
    trip: 3,
    chain: ['top', 'step'],
  });
  assert.equal(
    formatDiagnostic(e),
    'runtime: trap bounds fn=step at=top.r trip=3 chain=top>step fix: keep the index below the length (check it, or use cget for a total read)',
  );
});

// ---------------------------------------------------------------------------
// Checked ops: total in both profiles, equal to the BigInt oracle
// ---------------------------------------------------------------------------

const EDGES = [0, 1, 2, 3, 0x7fff_ffff, 0x8000_0000, 0xffff_fffe, 0xffff_ffff];
const CHECKED: readonly Op[] = ['cadd', 'csub', 'cmul', 'cdiv', 'crem'];

test('cadd/csub/cmul/cdiv/crem agree with the oracle at the boundaries in both profiles', () => {
  for (const op of CHECKED) {
    const body = `fn t u32 u32 -> (u32,bool)\na ${op} p0 p1\nret a\nend\n`;
    const canon = fnOf(body, 't');
    const strict = fnOf(`${STRICT}${body}`, 't');
    for (const x of EDGES)
      for (const y of EDGES) {
        const want = oracleToValue(oracleRun(canon, [x, y]));
        assert.deepEqual(run(canon, [x, y]), want, `${op} ${x} ${y}`);
        assert.deepEqual(run(strict, [x, y]), want, `strict ${op} ${x} ${y}`);
      }
  }
});

test('checked ops: the documented values', () => {
  const ev = (op: Op, a: number, b: number): Value => evalOp(op, [a, b]);
  assert.deepEqual(ev('cadd', 0xffff_ffff, 1), [0, false]);
  assert.deepEqual(ev('cadd', 0xffff_fffe, 1), [0xffff_ffff, true]);
  assert.deepEqual(ev('csub', 0, 1), [0xffff_ffff, false]);
  assert.deepEqual(ev('csub', 5, 5), [0, true]);
  assert.deepEqual(ev('cmul', 0x1_0000, 0x1_0000), [0, false]);
  assert.deepEqual(ev('cmul', 0xffff, 0x1_0001), [0xffff_ffff, true]);
  assert.deepEqual(ev('cdiv', 7, 0), [0, false]);
  assert.deepEqual(ev('cdiv', 7, 2), [3, true]);
  assert.deepEqual(ev('crem', 7, 0), [0, false]);
  assert.deepEqual(ev('crem', 7, 4), [3, true]);
});

test('cget is total in both profiles: (value, true) in range, (0, false) out of it', () => {
  const body = 'fn g u32x3 u32 -> (u32,bool)\na cget p0 p1\nret a\nend\n';
  for (const head of ['', STRICT]) {
    const g = fnOf(`${head}${body}`, 'g');
    assert.deepEqual(run(g, [[5, 6, 7], 2]), [7, true]);
    for (const i of [3, 4, 0xffff_ffff]) assert.deepEqual(run(g, [[5, 6, 7], i]), [0, false]);
  }
  const g = fnOf(body, 'g');
  assert.deepEqual(oracleToValue(oracleRun(g, [[5, 6, 7], 3])), [0, false]);
  assert.deepEqual(
    oracleToValue(oracleRun(g, [[5, 6, 7], 1])),
    oracleToValue(valueToOracle([6, true])),
  );
  // cget reads u32 arrays only.
  assert.equal(
    raised(() => parseAndValidate('fn g bool -> (u32,bool)\na cget p0 0\nret a\nend\n')).code,
    'type',
  );
});

test('select still evaluates both arms: a strict trap in the untaken arm is a trap', () => {
  const src = `${STRICT}fn s u32 -> u32
a arr 1 2
b get a p0
c select true 7 b
ret c
end
`;
  assert.equal(raised(() => run(fnOf(src, 's'), [9])).id, 'A0710');
});

// ---------------------------------------------------------------------------
// The directive: parse, print, round trips
// ---------------------------------------------------------------------------

const BODY = 'fn f u32 -> u32\na add p0 1\nret a\nend\n';

test('the directive parses only as the first line, before use and fn', () => {
  assert.equal(parse(`${STRICT}${BODY}`).profile, 'strict');
  assert.equal(parse(BODY).profile, undefined);
  assert.equal(parse(`# a note\n${STRICT}${BODY}`).profile, 'strict');
  for (const bad of [
    `profile lax\n${BODY}`,
    `profile\n${BODY}`,
    `profile strict extra\n${BODY}`,
    `${BODY}${STRICT}`,
    `use "x.a0"\n${STRICT}${BODY}`,
    `${STRICT}${STRICT}${BODY}`,
  ])
    assert.equal(raised(() => parse(bad)).id, 'A0031', bad);
  assert.equal(verifyExample('A0031').length, 0);
});

test('canonical form round trips and the directive is part of the revision', () => {
  const src = `# why\n${STRICT}\n${BODY}`;
  const p = parse(src);
  assert.equal(formatSource(p), src);
  assert.equal(formatSource(parse(formatSource(p))), formatSource(p));
  assert.equal(formatProgram(parse(`${STRICT}${BODY}`)), `${STRICT}\n${BODY}`);
  // A canonical program prints exactly as before.
  assert.equal(formatProgram(parse(BODY)), BODY);
  assert.notEqual(
    programRevision(parseAndValidate(`${STRICT}${BODY}`)),
    programRevision(parseAndValidate(BODY)),
  );
});

test('dense form round trips the directive, with comments and use lines', () => {
  const src = `# hello\n${STRICT}use "lib.a0"\n\n${BODY}`;
  const p = parse(src.replace('use "lib.a0"\n', ''));
  const dense = formatDense(p, { comments: true });
  assert.ok(dense.startsWith('# hello\nprofile strict\n'), dense);
  const back = parseDense(dense);
  assert.equal(back.profile, 'strict');
  assert.equal(formatSource(back), formatSource(p));
  assert.equal(formatDense(parse(BODY)), formatDense(parseDense(formatDense(parse(BODY)))));
  assert.ok(!formatDense(parse(BODY)).includes('profile'));
  assert.equal(raised(() => parseDense(`profile lax\n${BODY}`)).code, 'parse');
  assert.equal(raised(() => parseDense(`fn f A -> u32\nA\nprofile strict\n`)).code, 'parse');
});

test('edit protocol: `profile strict` and `-profile` change the profile, views show it', () => {
  const s = new EditSession(parseAndValidate(BODY));
  const g0 = s.openProgram();
  assert.ok(!g0.text.includes('profile'));
  s.apply('g0\nprofile strict');
  assert.equal(s.program.profile, 'strict');
  assert.equal(s.program.byName.get('f')?.profile, 'strict');
  const g1 = s.openProgram();
  assert.ok(g1.text.includes('\nprofile strict\n'), g1.text);
  // Echoing the view back is a no-op, and the directive is idempotent.
  s.apply(`${g1.handle}\nprofile strict`);
  assert.equal(s.program.profile, 'strict');
  // A function edit keeps the profile; a block next to the directive is accepted too.
  const e = s.open('f');
  s.apply(`${e.handle}\na add p0 2`);
  assert.equal(s.program.profile, 'strict');
  const g2 = s.openProgram();
  s.apply(`${g2.handle}\nfn h u32 -> u32\nb mul p0 3\nret b\nend`);
  assert.equal(s.program.profile, 'strict');
  const g3 = s.openProgram();
  s.apply(`${g3.handle}\n-profile`);
  assert.equal(s.program.profile, undefined);
  assert.equal(s.program.byName.get('f')?.profile, undefined);
  assert.ok(!s.openProgram().text.includes('profile'));
  // Under a function handle the directive is program-level, as `-fn` is.
  const e2 = s.open('h');
  s.apply(`${e2.handle}\nprofile strict`);
  assert.equal(s.program.profile, 'strict');
});

test('edit protocol: dense replies carry the directive too', () => {
  const s = new EditSession(parseAndValidate(BODY));
  const g = s.openProgram({ dense: true });
  s.apply(`${g.handle}\nprofile strict`);
  assert.equal(s.program.profile, 'strict');
  const g2 = s.openProgram({ dense: true });
  assert.ok(g2.text.includes('\nprofile strict\n'), g2.text);
  s.apply(`${g2.handle}\n-profile`);
  assert.equal(s.program.profile, undefined);
});

// ---------------------------------------------------------------------------
// Linking: one profile per program
// ---------------------------------------------------------------------------

const files = (map: Record<string, string>) => async (p: string) => {
  const text = map[p];
  if (text === undefined) throw new Error(`no file ${p}`);
  return text;
};

test('link: files that use each other must agree on the profile (A0624)', async () => {
  const lib = 'fn dbl u32 -> u32\na add p0 p0\nret a\nend\n';
  const root = (head: string) =>
    `${head}use "/p/lib.a0"\n\nfn main u32 -> u32\nr call dbl p0\nret r\nend\n`;
  const opts = { root: '/p' };
  const same = await link(
    '/p/main.a0',
    files({ '/p/main.a0': root(STRICT), '/p/lib.a0': `${STRICT}${lib}` }),
    opts,
  ).catch((e) => e);
  assert.equal(same.program?.profile, 'strict');
  assert.equal(same.program?.byName.get('dbl')?.profile, 'strict');
  const none = await link('/p/main.a0', files({ '/p/main.a0': root(''), '/p/lib.a0': lib }), opts);
  assert.equal(none.program.profile, undefined);
  for (const [m, l] of [
    [root(STRICT), lib],
    [root(''), `${STRICT}${lib}`],
  ] as const) {
    const e = await link('/p/main.a0', files({ '/p/main.a0': m, '/p/lib.a0': l }), opts).catch(
      (x) => x,
    );
    assert.ok(e instanceof A0Error);
    assert.equal(e.id, 'A0624');
    assert.equal(e.code, 'structure');
    assert.match(e.message, /profile mismatch/);
  }
  // The override picks the profile of the whole program, not the agreement between files.
  const over = await link('/p/main.a0', files({ '/p/main.a0': root(''), '/p/lib.a0': lib }), {
    ...opts,
    profile: 'strict',
  });
  assert.equal(over.program.profile, 'strict');
  const off = await link(
    '/p/main.a0',
    files({ '/p/main.a0': root(STRICT), '/p/lib.a0': `${STRICT}${lib}` }),
    { ...opts, profile: 'canonical' },
  );
  assert.equal(off.program.profile, undefined);
  assert.equal(off.program.functions[1]?.profile, undefined);
});

test('link: diagnostics keep their file and line when a profile line is present', async () => {
  const bad = `${STRICT}fn main u32 -> u32\nr add p0 true\nret r\nend\n`;
  const e = await link('/p/main.a0', files({ '/p/main.a0': bad }), { root: '/p' }).catch((x) => x);
  assert.ok(e instanceof A0Error);
  assert.match(e.message, /^\/p\/main\.a0:3: /);
});

// ---------------------------------------------------------------------------
// Cache keys and program hashes
// ---------------------------------------------------------------------------

test('the profile is part of every derived key', () => {
  const strict = fnOf(`${STRICT}${BODY}`, 'f');
  const canon = fnOf(BODY, 'f');
  assert.notEqual(semanticRevision(strict), semanticRevision(canon));
  assert.notEqual(emissionKey('c', strict), emissionKey('c', canon));
  // Canonical keys are untouched: the semantic revision of a callee-free canonical function is the
  // hash of its content revision, as before the profile existed.
  assert.equal(
    semanticRevision(canon),
    createHash('sha256').update(revision(canon), 'utf8').digest('hex'),
  );
});

// ---------------------------------------------------------------------------
// Other targets refuse a strict program (and the checked ops), never run it canonical
// ---------------------------------------------------------------------------

test('every target refuses a strict program with A0713 naming the target', () => {
  const strict = parseAndValidate(`${STRICT}${BODY}`);
  const checked = parseAndValidate('fn t u32 u32 -> (u32,bool)\na cadd p0 p1\nret a\nend\n');
  for (const target of TARGETS) {
    const e = raised(() => compile(strict, target));
    assert.equal(e.id, 'A0713', target);
    assert.equal(e.code, 'structure');
    assert.ok(e.message.includes(target), e.message);
    const c = raised(() => compile(checked, target, { optimize: false }));
    assert.equal(c.id, 'A0713', target);
    assert.match(c.message, /cadd/);
  }
  // The interpreter still runs both.
  assert.deepEqual(run(checked.byName.get('t') as TypedFunc, [0xffff_ffff, 2]), [1, false]);
  // `--profile canonical` is the way to compile a strict file canonically.
  assert.ok(compile(parseAndValidate(BODY), 'c').text.length > 0);
});

// ---------------------------------------------------------------------------
// Golden: canonical emission is byte-identical to the one before the profile existed
// ---------------------------------------------------------------------------

async function emissionDigests(): Promise<Record<string, string>> {
  const programs: [string, Awaited<ReturnType<typeof link>>['program']][] = [
    ['corpus', generateCorpus()],
    ['corpus-scalar', generateCorpus(undefined, undefined, { scalar: true })],
  ];
  for (const f of [
    'examples/kernels.a0',
    'examples/life.a0',
    'compiler/lex.a0',
    'compiler/parse.a0',
    'compiler/check.a0',
    'compiler/optimize.a0',
  ])
    programs.push([
      f,
      (await link(f, async (p) => readFileSync(p, 'utf8'), { root: ROOT })).program,
    ]);
  const out: Record<string, string> = {};
  for (const [name, program] of programs)
    for (const target of TARGETS)
      for (const optimize of [true, false]) {
        let v: string;
        try {
          v = createHash('sha256')
            .update(compile(program, target, { optimize }).text)
            .digest('hex');
        } catch (e) {
          v = `refused: ${String((e as Error).message).slice(0, 80)}`;
        }
        out[`${name}|${target}|${optimize ? 'O1' : 'O0'}`] = v;
      }
  return out;
}

test('golden: canonical emission of the corpus, examples and compiler files is unchanged on every target', async () => {
  const path = resolve(ROOT, 'test', 'golden', 'canonical-emission.json');
  const now = await emissionDigests();
  if (process.env.A0_UPDATE_GOLDEN === '1') {
    writeFileSync(path, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  assert.deepEqual(Object.keys(now), Object.keys(golden));
  const changed = Object.keys(golden).filter((k) => golden[k] !== now[k]);
  assert.deepEqual(
    changed,
    [],
    'canonical emission changed; bump COMPILER_VERSION or fix the change',
  );
});
