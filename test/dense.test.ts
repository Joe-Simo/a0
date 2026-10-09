import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  A0Error,
  formatProgram,
  formatSource,
  makeIo,
  parse,
  parseAndValidate,
  run,
  type TypedProgram,
  validate,
  valueEquals,
} from '../src/core.js';
import {
  type DenseStyle,
  formatDense,
  formatDenseSignature,
  glueDigits,
  normalizeProgram,
  parseDense,
} from '../src/dense.js';
import { EditSession, revision } from '../src/edit.js';
import { link, parseFile } from '../src/link.js';
import { generateCases, generateCorpus } from '../tools/corpus.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import { posix } from './vpath.js';

// The repository root: two levels up from the compiled dist/test, one level up when a runner reads
// test/*.ts directly (`bun test`), where two levels up is the folder holding every worktree.
const ROOT = ((here: string): string =>
  existsSync(join(here, '..', 'package.json')) ? resolve(here, '..') : resolve(here, '..', '..'))(
  import.meta.dirname,
);

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    // Dot directories (.git, .claude/worktrees: other checkouts of the repository) are not part of this tree.
    if (f === 'node_modules' || f === 'dist' || f === 'results' || f.startsWith('.')) continue;
    const p = join(dir, f);
    // corpus/reject holds files the checker must reject; they have no dense form to round-trip
    if (p.endsWith(join('corpus', 'reject'))) continue;
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.a0')) out.push(p);
  }
  return out;
}

const read = async (p: string): Promise<string> => readFileSync(p, 'utf8');

/** canonical -> dense -> canonical must be the identity, and dense -> canonical -> dense a fixed point. */
function roundTrip(
  source: string,
  known: ReadonlyMap<string, number> = new Map(),
  comments = false,
): string {
  const program = parse(source);
  const dense = formatDense(program, { known, comments });
  const back = parseDense(dense, { known });
  assert.equal(
    formatProgram(back),
    formatProgram(program),
    `canonical form differs for:\n${dense}`,
  );
  assert.equal(
    formatDense(back, { known, comments }),
    dense,
    `dense text is not a fixed point for:\n${dense}`,
  );
  if (comments)
    assert.equal(formatSource(back), formatSource(program), `comments differ for:\n${dense}`);
  return dense;
}

test('dense: the kernels print as short as designed and convert back exactly', () => {
  assert.equal(
    roundTrip('fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend'),
    'fn affine add mul A B C\n',
  );
  assert.equal(roundTrip('fn ident u32 -> u32\nret p0\nend'), 'fn ident A\n');
  assert.equal(
    roundTrip(
      'fn clamp u32 u32 u32 -> u32\nc lt p2 p0\nr select c p2 p0\nd lt r p1\ns select d p1 r\nret s\nend',
    ),
    'fn clamp\nc lt C A\nr select c C A\nd lt r B\ns select d B r\n',
  );
});

test('dense: natural nested sources compile to the same behavior as the canonical kernels', () => {
  const natural: Record<string, string> = {
    affine: 'fn affine add mul A B C',
    rotl: 'fn rotl or << A B >> A sub 32 B',
    clamp: 'fn clamp\nb select lt C A C A\nselect lt b B B b',
    mix: 'fn mix\na xor A B\nf add mul or << a 13 >> a 19 2654435761 A\nxor f >> f 16',
    ident: 'fn ident A',
    noop: 'fn noop xor mul add A 0 1 0',
    chain3: 'fn inc1 add A 1\n\nfn dbl add A A\n\nfn chain3 add inc1 dbl inc1 A B',
    branchy: 'fn branchy\nf select eq A B 0 select lt A B sub B A sub A B\nselect eq and f 1 1 f A',
    arrfill:
      'fn put8 u32x8 u32 u32 -> u32x8 set A B add B C\n\nfn arrfill\nb fold put8 8 [0;8] A\nadd get b B get b 3',
    loop64:
      'fn mixstep\nb mul xor A C 2654435761\nadd xor b >> b 15 B\n\nfn loop64 fold mixstep 64 A B',
  };
  for (const k of KERNELS) {
    const dense = natural[k.name];
    if (dense === undefined) continue;
    const a = parseAndValidate(k.a0);
    const b = validate(parseDense(dense));
    const f = a.byName.get(k.name);
    const g = b.byName.get(k.name);
    assert.ok(f !== undefined && g !== undefined, k.name);
    let s = 0x9e3779b9;
    for (let i = 0; i < 40; i += 1) {
      const args = f.params.map(() => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s;
      });
      assert.ok(valueEquals(run(f, args), run(g, args)), `${k.name}${JSON.stringify(args)}`);
    }
  }
});

// Measured 11 s (bun test) on the full tree; the 5 s default is too short.
test('dense: every kernel, example, compiler and site program round-trips exactly', {
  timeout: 60_000,
}, async () => {
  const all = files(ROOT);
  assert.ok(all.length >= 30, `found ${all.length} files`);
  for (const path of all) {
    const { program, known } = await parseFile(path, read);
    const dense = formatDense(program, { known });
    const back = parseDense(dense, { known });
    assert.equal(formatProgram(back), formatProgram(program), `${path}: canonical form differs`);
    assert.equal(formatDense(back, { known }), dense, `${path}: not a fixed point`);
    // With comments: the formatter output is the same file.
    const withComments = formatDense(program, { known, comments: true });
    const again = parseDense(withComments, { known });
    assert.equal(formatSource(again), formatSource(program), `${path}: comments differ`);
    // Revisions of every function are unchanged by the round trip.
    for (const [i, f] of program.functions.entries())
      assert.equal(revision(back.functions[i] ?? f), revision(f), `${path}: ${f.name} revision`);
  }
});

test('dense: the generated corpus round-trips, and its normal form behaves identically', () => {
  for (const options of [{}, { scalar: true }]) {
    const program = generateCorpus(0xa0beef, 48, options);
    const dense = formatDense(program);
    assert.equal(formatProgram(parseDense(dense)), formatProgram(program));
    const normal = validate(normalizeProgram(program));
    const lifted = new Set(
      program.functions.map((f) => f.name).filter((n) => !normal.byName.has(n)),
    );
    assert.ok(lifted.size < program.functions.length / 2);
    const again = formatDense(normal);
    assert.equal(formatProgram(parseDense(again)), formatProgram(normal));
    assert.ok(again.length <= dense.length, 'normalizing never lengthens the dense text');
    for (const c of generateCases(program, 0x12345678, 8)) {
      const g = normal.byName.get(c.functionName);
      // a helper only one fold calls is renamed `CALLER_1` by the normal form (and written inline)
      if (g === undefined) {
        assert.ok(lifted.has(c.functionName), c.functionName);
        continue;
      }
      if (c.input === undefined) {
        assert.ok(valueEquals(run(g, [...c.args]), c.expected), c.functionName);
      } else {
        const state = makeIo([...c.input]);
        const got = run(g, [...c.args, state]);
        assert.ok(valueEquals(got, c.expected), c.functionName);
        assert.deepEqual([...state.output], [...(c.expectedOutput ?? [])]);
      }
    }
  }
});

test('dense: ids, escapes and odd shapes survive', () => {
  // explicit ids that look like keywords, types or functions; a dead node; a late result
  roundTrip(`fn f u32 u32 -> u32
or add p0 p1
at mul or 2
u32x4 sub at p1
dead add p0 1
r select true or at
ret r
end

fn g u32 -> u32
a f p0 p0
f2 call f a a
ret f2
end`);
  // ret naming an earlier node, a literal and a parameter
  roundTrip('fn a u32 u32 -> u32\nx add p0 p1\ny mul x x\nret x\nend');
  roundTrip('fn a u32 -> u32\nret 7\nend');
  roundTrip('fn a u32 u32 u32 -> u32\nret p0\nend');
  // records, text, bool signatures, empty parameter list
  roundTrip(`fn t -> u32
r rec 1 2 3
s text "hi\\n\\"x\\""
a at r 1
b get s 0
c add a b
ret c
end`);
  roundTrip('fn p u32 bool -> (u32,bool)\nr rec p0 p1\nret r\nend');
  roundTrip('fn big -> u32\nz arr 0 0 0 0 0 0\nx get z 3\nret x\nend');
  // retval (the `ret OP` sugar) and numbered-looking ids
  roundTrip('fn s u32 u32 -> u32\nret add p0 p1\nend');
  roundTrip('fn s u32 u32 -> u32\nn1 add p0 p1\nn2 mul n1 n1\nn3 sub n2 n1\nret n3\nend');
});

test('dense: comments are kept by the formatter and ignored by the view', () => {
  const src = `# header comment
use "x.a0" # why

# about f
fn f u32 -> u32 # f trailing
# about a
a add p0 1 # a trailing
b mul a a
ret b # ret trailing
end # end trailing

fn g u32 -> u32
a f p0
ret a
end
# the very end
`;
  const known = new Map([['x', 1]]);
  const program = parse(src.replace('fn g', 'fn g'));
  const text = formatDense(program, { known, comments: true });
  assert.equal(formatSource(parseDense(text, { known })), formatSource(program));
  // without comments the view is the comment-free dense text
  assert.ok(!formatDense(program, { known }).includes('#'));
});

test('dense: parse accepts canonical-style statements and tolerates ret and end', () => {
  const canonical = parseDense('fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend');
  assert.equal(
    formatProgram(canonical),
    formatProgram(parse('fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend')),
  );
  const spaced = parseDense('fn affine\na mul A B\nb add a C\nret b\nend');
  assert.equal(formatProgram(spaced), formatProgram(canonical));
  assert.equal(formatProgram(parseDense('fn affine add mul A B C')), formatProgram(canonical));
  // symbols, commas, the `=` form and `$`
  assert.equal(
    formatProgram(parseDense('fn f\nx = + * A B C\n$x')),
    formatProgram(parseDense('fn f\nx add mul A B C\nx')),
  );
  assert.equal(formatProgram(parseDense('fn r (A, B)')), formatProgram(parseDense('fn r (A B)')));
  // arr and rec taking the rest of the line
  assert.equal(
    formatProgram(parseDense('fn z\nx arr 1 2 3\nget x 1')),
    formatProgram(parseDense('fn z\nx [1 2 3]\nget x 1')),
  );
});

test('dense: diagnostics name the line and the fix', () => {
  const bad = (text: string, re: RegExp): void => {
    assert.throws(
      () => parseDense(text),
      (e) => e instanceof A0Error && re.test(`${e.message} ${e.fix ?? ''}`),
      text,
    );
  };
  bad('fn f add A', /`add` needs 2 operands but the line ended after 1/);
  bad('fn f u32 u32 u32', /needs '-> RESULT'/);
  bad(
    'fn two add A B\n\nfn f fold two 3',
    /`fold two` needs 2 operands \(two has 2 parameters\) but the line ended after 1/,
  );
  bad('fn f mul n A', /parameters are written A, B, C by position/);
  bad('fn f add A B C', /unexpected 'C' after a complete expression/);
  bad('fn f frob A', /neither an operation nor a function/);
  bad('fn f g A', /neither an operation nor a function/);
  bad('fn f\nx add A 1\nx add A 2\nx', /duplicate id 'x'/);
  bad('fn f\nA\nadd A 1', /only allowed as the last statement/);
  bad('fn f', /has no result/);
  bad('add A B', /expected 'fn'/);
  bad('fn f add A 99999999999', /exceeds u32/);
  bad('fn f $q', /not defined above/);
  bad('fn f [1;0]', /repeat count/);
  bad('fn f\nx add A 1\nadd x A y', /unexpected 'y'/);
});

test('dense: function calls need their callee above and use its parameter count', () => {
  const p = parseDense('fn inc add A 1\n\nfn two inc inc A\n\nfn s select lt A 5 inc A 7');
  const text = formatProgram(p);
  assert.ok(text.includes('call inc'));
  validate(p);
  assert.throws(() => parseDense('fn two inc inc A\n\nfn inc add A 1'), /unknown function 'inc'/);
  // a function named like an op is called with `call`
  const q = parseDense('fn mov2 add A A\n\nfn h call mov2 A');
  validate(q);
});

test('dense: link reads .a0d files, mixed with canonical files through use', async () => {
  const sources: Record<string, string> = {
    '/p/main.a0d': 'use "lib.a0"\nuse "mid.a0d"\n\nfn top inc2 twice A B',
    '/p/lib.a0': 'fn inc2 u32 u32 -> u32\na add p0 p1\nret a\nend',
    '/p/mid.a0d': 'use "lib.a0"\n\nfn twice inc2 A A',
  };
  const linked = await link('/p/main.a0d', async (p) => sources[posix(p)] ?? '', { root: '/p' });
  assert.deepEqual(
    linked.program.functions.map((f) => f.name),
    ['inc2', 'twice', 'top'],
  );
  assert.equal(run(linked.program.byName.get('top') as never, [3, 4]), 10);
  // a type error in a dense file is reported against that file
  const bad: Record<string, string> = { '/p/b.a0d': 'fn f bool lt A 1' };
  await assert.rejects(
    link('/p/b.a0d', async (p) => bad[posix(p)] ?? '', { root: '/p' }),
    /[\\/]p[\\/]b\.a0d/,
  );
  // and a dense parse error carries the line
  const worse: Record<string, string> = { '/p/c.a0d': 'fn f add A 1\n\nfn g frob' };
  await assert.rejects(
    link('/p/c.a0d', async (p) => worse[posix(p)] ?? '', { root: '/p' }),
    /[\\/]p[\\/]c\.a0d:3/,
  );
});

test('dense: signatures use _ for u32', () => {
  const p = parse('fn a u32 bool u32x4 -> (u32,bool)\nr rec p0 p1\nret r\nend');
  assert.equal(formatDenseSignature(p.functions[0] as never), 'fn a u32 bool u32x4 -> (u32,bool)');
});

function dense(source: string): EditSession {
  return new EditSession(parseAndValidate(source));
}

const BASE = `fn inc u32 -> u32
a add p0 1
ret a
end

fn two u32 u32 -> u32
a inc p0
b mul a p1
c add b a
ret c
end`;

test('dense edits: the view is dense and a whole-function reply replaces the function', () => {
  const session = dense(BASE);
  const view = session.open('two', { dense: true, scope: 'deps' });
  assert.equal(view.text, 'e0\nfn two\na inc A\nadd mul a B a\n# inc u32 -> u32');
  const before = session.program.byName.get('inc');
  session.apply('e0\nfn two\na inc A\nadd mul a B a');
  assert.equal(revision(session.program.byName.get('inc') as never), revision(before as never));
  session.apply('e0\nfn two\na inc A\nsub mul a B a');
  assert.ok(formatProgram(session.program).includes('sub'));
  // the handle follows the program and shows the new dense text
  assert.equal(session.view('e0').split('\n')[1], 'fn two');
});

test('dense edits: id lines, ret and nested expressions become canonical nodes', () => {
  const session = dense(BASE);
  session.open('two', { dense: true });
  session.apply('e0\nb mul a add B 1');
  const two = session.program.byName.get('two');
  assert.ok(two !== undefined);
  assert.equal(run(two, [3, 5]), 4 * 6 + 4);
  session.apply('e0\nret add mul a B 7');
  assert.equal(run(session.program.byName.get('two') as never, [3, 5]), 4 * 5 + 7);
  assert.throws(
    () => session.apply('e0\nadd A 1'),
    (e) => e instanceof A0Error && /names no value/.test(e.message),
  );
});

test('dense edits: a new function block may call one defined later in the reply', () => {
  const session = dense(BASE);
  session.open('two', { dense: true });
  session.apply('e0\nfn two add sq A B\n\nfn sq mul A A');
  const program = session.program;
  assert.deepEqual(
    program.functions.map((f) => f.name),
    ['inc', 'sq', 'two'],
  );
});

test('dense edits: scope bodies shows the direct callees as dense text, so a bug in a helper is visible', () => {
  const session = dense(BASE);
  const deps = session.open('two', { scope: 'deps', dense: true }).text;
  const bodies = session.open('two', { scope: 'bodies', dense: true }).text;
  assert.ok(deps.includes('# inc u32 -> u32'), deps);
  assert.ok(!bodies.includes('# inc'), bodies);
  assert.ok(/\nfn inc /.test(bodies), bodies);
  // the same handle edits a callee body with a whole block
  const handle = bodies.split('\n')[0] as string;
  session.apply(`${handle}\nfn inc add A 2`);
  assert.equal(run(session.program.byName.get('inc') as TypedProgram['functions'][number], [1]), 3);
});

test('dense edits: program handle lists dense signatures and takes dense blocks', () => {
  const session = dense(BASE);
  const view = session.openProgram({ dense: true });
  assert.equal(view.text, 'g0\n# inc u32 -> u32\n# two u32 u32 -> u32');
  session.apply('g0\nfn half shr A 1');
  assert.equal(
    run(session.program.byName.get('half') as TypedProgram['functions'][number], [10]),
    5,
  );
});

/** xorshift32, so the fuzz is the same on every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

test('dense: random canonical programs (odd ids, shared values, dead nodes) round-trip', () => {
  const r = rng(0xd3d5e);
  const pick = <T>(xs: readonly T[]): T => xs[r() % xs.length] as T;
  const idPool = [
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'x',
    'y',
    'z',
    'or',
    'at',
    'eq',
    'rec',
    'arr',
    'text',
    'call',
    'u32',
    'u32x4',
    'bool',
    'io',
    'fn1',
    'lo',
    'hi',
    'n1',
    'n2',
    'aa',
    'ab',
    'retval',
    'tmp_1',
    'inc',
    'dbl',
  ];
  const ops2 = [
    'add',
    'sub',
    'mul',
    'and',
    'or',
    'xor',
    'shl',
    'shr',
    'eq',
    'ne',
    'lt',
    'le',
    'gt',
    'ge',
    'div',
    'rem',
    'get',
    'at',
  ];
  for (let trial = 0; trial < 1500; trial += 1) {
    const lines: string[] = [];
    const callee = new Map<string, number>([
      ['inc', 1],
      ['dbl', 2],
    ]);
    const arity = 1 + (r() % 4);
    lines.push(
      'fn inc u32 -> u32\nz add p0 1\nret z\nend',
      'fn dbl u32 u32 -> u32\nz add p0 p1\nret z\nend',
    );
    const ids: string[] = [];
    const body: string[] = [];
    const nodes = 1 + (r() % 12);
    const operand = (): string => {
      const k = r() % 10;
      if (k < 3 && ids.length > 0) return pick(ids);
      if (k < 4 && ids.length > 0) return ids[ids.length - 1] as string;
      if (k < 7) return `p${r() % arity}`;
      if (k < 8) return r() % 2 === 0 ? 'true' : 'false';
      return String(r() % 3 === 0 ? 4294967295 : r() % 50);
    };
    for (let i = 0; i < nodes; i += 1) {
      let id = r() % 3 === 0 ? pick(idPool) : String.fromCharCode(97 + ids.length);
      while (ids.includes(id) || /^p[0-9]+$/.test(id)) id = `${id}${r() % 90}`;
      const form = r() % 12;
      let rhs: string;
      if (form < 6) rhs = `${pick(ops2)} ${operand()} ${operand()}`;
      else if (form === 6) rhs = `select ${operand()} ${operand()} ${operand()}`;
      else if (form === 7) rhs = `${pick(['inc', 'call inc'])} ${operand()}`;
      else if (form === 8) rhs = `${pick(['dbl', 'call dbl'])} ${operand()} ${operand()}`;
      else if (form === 9) rhs = `arr ${Array.from({ length: 1 + (r() % 5) }, operand).join(' ')}`;
      else if (form === 10) rhs = `rec ${operand()} ${operand()}`;
      else rhs = `text "t${r() % 9}\\n"`;
      body.push(`${id} ${rhs}`);
      ids.push(id);
    }
    const ret = r() % 4 === 0 ? operand() : (ids[ids.length - 1] as string);
    lines.push(
      `fn f${arity} ${Array(arity).fill('u32').join(' ')} -> u32\n${body.join('\n')}\nret ${ret}\nend`,
    );
    void callee;
    roundTrip(lines.join('\n\n'));
  }
});

test('dense: a result written `ret EXPR` is the canonical `ret OP ARGS` node', () => {
  assert.equal(roundTrip('fn s u32 u32 -> u32\nret add p0 p1\nend'), 'fn s ret add A B\n');
  assert.equal(
    roundTrip('fn s u32 u32 -> u32\na mul p0 p1\nret add a p1\nend'),
    'fn s ret add mul A B B\n',
  );
  // a second fresh result id when `retval` is taken
  roundTrip('fn s u32 -> u32\nretval add p0 1\nretval2 mul retval retval\nret retval2\nend');
  const p = parseDense('fn f ret add A B');
  assert.equal(p.functions[0]?.nodes[0]?.id, 'retval');
  // a named single statement does not share the header line
  assert.equal(
    roundTrip('fn pick (u32,bool) -> u32\nv at p0 0\nret v\nend'),
    'fn pick (u32,bool) -> u32\nv at A 0\n',
  );
});

test('dense: every style variant prints text that parses back to the same program', async () => {
  const styles: DenseStyle[] = [
    {},
    { nest: false },
    { implicitIds: false },
    { implicitTypes: false },
    { letters: false },
    { symbols: false },
    { repeat: false },
    { join: false },
    { implicitRet: false },
    {
      nest: false,
      implicitIds: false,
      implicitTypes: false,
      letters: false,
      symbols: false,
      repeat: false,
      join: false,
      implicitRet: false,
    },
  ];
  const sources = [
    ...KERNELS.map((k) => k.a0),
    readFileSync(join(ROOT, 'examples', 'life.a0'), 'utf8'),
    readFileSync(join(ROOT, 'site', 'ui.a0'), 'utf8'),
  ];
  for (const source of sources) {
    const program = parse(source);
    for (const style of styles) {
      for (const p of [program, normalizeProgram(program)]) {
        const text = formatDense(p, { style });
        assert.equal(
          formatProgram(parseDense(text)),
          formatProgram(p),
          `style ${JSON.stringify(style)} for:\n${text.slice(0, 300)}`,
        );
      }
    }
  }
});

test('dense: parentheses group, and a one-field record keeps its comma', () => {
  assert.equal(roundTrip('fn r u32 -> (u32)\na rec p0\nret a\nend'), 'fn r -> (u32) (A,)\n');
  assert.equal(
    formatProgram(parseDense('fn f select (lt A B) (sub B A) (sub A B)')),
    formatProgram(parseDense('fn f select lt A B sub B A sub A B')),
  );
  assert.equal(
    formatProgram(parseDense('fn f (add A 1)')),
    formatProgram(parseDense('fn f add A 1')),
  );
  assert.equal(
    formatProgram(parseDense('fn f -> (u32,u32) (A B)')),
    formatProgram(parseDense('fn f -> (u32,u32) (A, B)')),
  );
});

test('dense edits: diagnostics name the dense text, not canonical auto ids', () => {
  const session = dense(BASE);
  session.open('two', { dense: true });
  assert.throws(
    () => session.apply('e0\nfn two select A B A'),
    (e) =>
      e instanceof A0Error &&
      e.message.includes('two (`select A B A`)') &&
      !/two\.[a-z]/.test(`${e.message} ${e.fix ?? ''}`),
  );
  assert.throws(
    () => session.apply('e0\nfn two -> bool add A B'),
    (e) => e instanceof A0Error && e.message.includes("two's result"),
  );
});

test('dense edits: signature lines are comments, never a header that could be copied', () => {
  const session = dense(BASE);
  const view = session.open('two', { dense: true, scope: 'deps' }).text;
  assert.ok(
    view
      .split('\n')
      .slice(1)
      .every((l) => !l.startsWith('fn ') || l === 'fn two'),
  );
  assert.ok(view.includes('# inc u32 -> u32'));
  // A reply that echoes the signature lines back changes nothing
  session.apply('e0\n# inc u32 -> u32');
  // the shape models wrote after copying a signature (a header, then `fn` again) says what is wrong
  assert.throws(
    () => session.apply('e0\nfn inc u32 -> u32\nfn inc add A 2'),
    (e) =>
      e instanceof A0Error && /has no result/.test(e.message) && /do not repeat/.test(e.fix ?? ''),
  );
});

test('dense: fold and loop bodies are written inline and lifted to CALLER_N functions', () => {
  const src = `fn put8_1 u32x8 u32 u32 -> u32x8
v add p1 p2
n set p0 p1 v
ret n
end

fn arrfill u32 u32 -> u32
z arr 0 0 0 0 0 0 0 0
a fold put8_1 8 z p0
x get a p1
y get a 3
s add x y
ret s
end`;
  // not inlined as written: the helper is not named arrfill_1
  assert.ok(!formatDense(parse(src)).includes('{'));
  const named = src.replaceAll('put8_1', 'arrfill_1');
  const dense = roundTrip(named);
  assert.ok(dense.includes('fold {'), dense);
  assert.ok(!dense.includes('fn arrfill_1'), dense);
  // the normal form lifts helpers itself, and the result runs the same
  const lifted = normalizeProgram(parse(src));
  const text = formatDense(lifted);
  assert.ok(text.includes('fold {set A B add B C} 8 [0;8] A') && text.includes('fn arrfill'), text);
  const a = parseAndValidate(src).byName.get('arrfill');
  const b = validate(parseDense(text)).byName.get('arrfill');
  assert.ok(a !== undefined && b !== undefined);
  for (const args of [
    [1, 2],
    [7, 9],
    [4294967295, 5],
  ])
    assert.ok(valueEquals(run(a, args), run(b, args)));
  // loops: predicate and body, both inline, or one named and one inline
  const loops = `fn lp_1 u32 u32 u32 -> bool
c lt p0 p2
ret c
end

fn lp_2 u32 u32 u32 -> u32
a add p0 1
ret a
end

fn lp u32 -> u32
r loop lp_1 lp_2 10 0 p0
ret r
end`;
  const both = roundTrip(loops);
  assert.ok(
    both.includes('loop {c lt A C} {a add A 1} 10 0 A') ||
      both.includes('loop {c lt A C} {add A 1} 10 0 A'),
    both,
  );
  const mixed = parseDense('fn pr -> bool lt A C\n\nfn lp loop pr {add A 1} 10 0 A');
  assert.deepEqual(
    mixed.functions.map((f) => f.name),
    ['pr', 'lp_1', 'lp'],
  );
  validate(mixed);
  // errors
  assert.throws(() => parseDense('fn f fold {add A {add A 1}} 3 0'), /nest|inline/);
  assert.throws(() => parseDense('fn f fold {add A B} 3'), /needs 2 operands/);
  assert.throws(
    () => parseDense('fn f_1 add A 1\n\nfn f fold {add A B} 3 0'),
    /already a function/,
  );
});

test('dense: `x y` with y a value above names a copy of it', () => {
  const alias = parseDense('fn f -> bool\nc gt A B\nr c\nr');
  validate(alias);
  assert.ok(formatProgram(alias).includes('r mov c'));
  // a bare parameter or an unknown word is still an error that says how to name a value
  assert.throws(() => parseDense('fn f\nx A'), /neither an operation nor a function/);
});

test('dense: a result that is not written is the type of the last statement (bool and aggregate replies need no `->`)', () => {
  const bool = parseDense('fn f lt A 100');
  assert.equal(formatProgram(bool), 'fn f u32 -> bool\na lt p0 100\nret a\nend\n');
  // an aggregate result
  const arr = parseDense('fn g [A B]');
  assert.deepEqual(arr.functions[0]?.result, { kind: 'arr', length: 2, elem: 'u32' });
  assert.equal(formatProgram(arr), 'fn g u32 u32 -> u32x2\na arr p0 p1\nret a\nend\n');
  const noParams = parseDense('fn h eq A B');
  assert.equal(formatProgram(noParams), 'fn h u32 u32 -> bool\na eq p0 p1\nret a\nend\n');
  // a u32 result and a written result are unchanged
  assert.equal(
    formatProgram(parseDense('fn k add A 1')),
    'fn k u32 -> u32\na add p0 1\nret a\nend\n',
  );
  assert.throws(() => validate(parseDense('fn m u32 -> u32 lt A 1')), /expected u32, got bool/);
  // the result of an earlier function is used by a later one without a head
  const two = parseDense('fn lo lt A 10\n\nfn pick select lo A 1 2');
  assert.equal(two.functions[0]?.result, 'bool');
  assert.equal(two.functions[1]?.result, 'u32');
  validate(two);
});

test('dense: a callee signature copied from the view without its `#` is skipped like the comment it is printed as', () => {
  const body = 'fn step u32 u32 u32x4 -> u32\nel get C B\nr add A el\n\n';
  const plain = parseDense(`${body}fn f u32x4 -> u32\nt fold step 4 0 A\nr mov t`);
  const echoed = parseDense(
    `${body}fn f u32x4 -> u32\nstep u32 u32 u32x4 -> u32\nt fold step 4 0 A\nr mov t`,
  );
  validate(echoed);
  assert.equal(formatProgram(echoed), formatProgram(plain));
  // after the statements, and between functions, too
  const after = parseDense(
    `${body}fn f u32x4 -> u32\nt fold step 4 0 A\nr mov t\nstep u32 u32 u32x4 -> u32`,
  );
  assert.equal(formatProgram(after), formatProgram(plain));
  // an ordinary statement is not mistaken for one, and a bare type word is still an error
  assert.throws(() => parseDense('fn g\ns add A 1\nu32 mov s'), /not an operation/);
  assert.equal(
    formatProgram(parseDense('fn h u32 -> u32\nstep add A 1')),
    'fn h u32 -> u32\nstep add p0 1\nret step\nend\n',
  );
});

const COMPACT_ALL: DenseStyle = {
  tab: true,
  minmax: true,
  hex: true,
  trailingParams: true,
  oneLine: true,
};

test('dense compact spellings: the kernels print as measured and convert back exactly', () => {
  const cases: [string, string][] = [
    [
      'fn clamp u32 u32 u32 -> u32\nc lt p2 p0\nb select c p2 p0\nd lt b p1\ne select d p1 b\nret e\nend',
      'clamp b min C A;max b B',
    ],
    [
      'fn put u32x8 u32 u32 -> u32x8\na add p1 p2\nb set p0 p1 a\nret b\nend\nfn arrfill u32 u32 -> u32\na arr 0 0 0 0 0 0 0 0\nb fold put 8 a p0\nc get b p1\nret c\nend',
      'arrfill get tab 8 {add B C} A B',
    ],
    ['fn m u32 -> u32\na and p0 4294967295\nret a\nend', 'm and A 0xffffffff'],
  ];
  for (const [canonical, dense] of cases) {
    const p = normalizeProgram(parse(canonical));
    const text = formatDense(p, { style: COMPACT_ALL }).trimEnd();
    assert.equal(text, dense);
    assert.equal(formatProgram(parseDense(text, { compact: true })), formatProgram(p));
  }
  // A fold whose trailing operands are all the function's parameters leaves them out.
  const step = 'fn st u32 u32 u32 -> u32\na add p0 p2\nret a\nend\n';
  const p = normalizeProgram(parse(`${step}fn f u32 -> u32\na fold st 4 0 p0\nret a\nend`));
  const text = formatDense(p, { style: COMPACT_ALL }).trimEnd();
  assert.equal(text, 'f fold {add A C} 4 0');
  assert.equal(formatProgram(parseDense(text, { compact: true })), formatProgram(p));
});

// Measured 13 s (bun test) on the full tree; the 5 s default is too short.
test('dense compact spellings: every program round-trips exactly with all of them on', {
  timeout: 60_000,
}, async () => {
  for (const path of files(ROOT)) {
    const { program, known } = await parseFile(path, read);
    for (const p of [program, normalizeProgram(program)]) {
      const dense = formatDense(p, { known, style: COMPACT_ALL });
      const back = parseDense(dense, { known, compact: true });
      assert.equal(formatProgram(back), formatProgram(p), `${path}: canonical form differs`);
      assert.equal(formatDense(back, { known, style: COMPACT_ALL }), dense, `${path}: fixed point`);
    }
  }
});

const COMBINED: DenseStyle = {
  ...COMPACT_ALL,
  tab: false,
  fill: true,
  bit: true,
  dot: true,
  inferResult: true,
  negative: true,
  foldN: true,
  ops: true,
};

test('dense combined compact rules: small programs print as designed and convert back exactly', () => {
  const cases: [string, string][] = [
    ['fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend', 'affine +*A B C'],
    ['fn m u32 -> u32\na and p0 4294967295\nret a\nend', 'm &A-1'],
    ['fn b u32 u32 -> u32\na lt p0 p1\nc select a 1 0\nret c\nend', 'b bit<A B'],
    ['fn r u32 -> u32\na sub p0 5\nret a\nend', 'r -A 5'],
    // `-` before a digit is a negative literal: the space stays
    ['fn s u32 -> u32\na sub 5 p0\nret a\nend', 's - 5 A'],
  ];
  for (const [canonical, dense] of cases) {
    const p = normalizeProgram(parse(canonical));
    const text = formatDense(p, { style: COMBINED }).trimEnd();
    assert.equal(text, dense);
    assert.equal(formatProgram(parseDense(text, { compact: true })), formatProgram(p));
  }
});

const DIGITS: DenseStyle = { ...COMBINED, paramDigit: true, commaDigit: true };

test('dense parameter-digit glue: B0 is B then 0, never inside a text literal; hex and -N still read', () => {
  const cases: [string, string][] = [
    ['fn r u32 -> u32\na sub p0 5\nret a\nend', 'r -A5'],
    ['fn s u32 -> u32\na sub 5 p0\nret a\nend', 's -,5 A'],
    ['fn x u32 -> u32\na xor p0 4294967291\nret a\nend', 'x ^A-5'],
    ['fn h u32 -> u32\na and p0 268435455\nret a\nend', 'h &A0xfffffff'],
  ];
  for (const [canonical, dense] of cases) {
    const p = normalizeProgram(parse(canonical));
    const text = formatDense(p, { style: DIGITS }).trimEnd();
    assert.equal(text, dense);
    assert.equal(formatProgram(parseDense(text, { compact: true })), formatProgram(p));
  }
  // A text literal keeps its spaces.
  const style = { ...DIGITS, paramDigit: true, commaDigit: true } as Required<DenseStyle>;
  assert.equal(glueDigits('f "B 0" B 0', style), 'f "B 0" B0');
});

test('dense parameter-digit glue guard: an id spelled letter plus digits is rejected or escaped', () => {
  // Canonical text rejects it as a node id ...
  assert.throws(() => parse('fn h u32 -> u32\nA1 add p0 17\nret A1\nend'), /A1/);
  // ... and compact text reads `A1` as the parameter A and the literal 1, never as an id.
  const back = parseDense('h +A1', { compact: true });
  assert.equal(
    formatProgram(back),
    formatProgram(normalizeProgram(parse('fn h u32 -> u32\na add p0 1\nret a\nend'))),
  );
  // An escaped `$A1` is a name, not a split.
  assert.throws(() => parseDense('h +$A1 2', { compact: true }));
});

// Measured 16 s (bun test) on the full tree.
test('dense combined compact rules: every program round-trips exactly with all of them on', {
  timeout: 60_000,
}, async () => {
  for (const path of files(ROOT)) {
    const { program, known } = await parseFile(path, read);
    for (const p of [program, normalizeProgram(program)]) {
      const dense = formatDense(p, { known, style: DIGITS });
      const back = parseDense(dense, { known, compact: true });
      assert.equal(formatProgram(back), formatProgram(p), `${path}: canonical form differs`);
      assert.equal(formatDense(back, { known, style: DIGITS }), dense, `${path}: fixed point`);
    }
  }
});
