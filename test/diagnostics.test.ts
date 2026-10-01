import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { A0Error, formatDiagnostic, parseAndValidate } from '../src/core.js';
import {
  DIAGNOSTICS,
  type DiagId,
  diagnosticIds,
  EXACT_FIXES,
  levenshteinTenths,
  spellingSuggestion,
} from '../src/diagnostics.js';
import { EditSession, programRevision } from '../src/edit.js';
import { explain, explainIndex, verifyExamples } from '../src/explain.js';
import { applyEdit, diagnosticLine, fixAll } from '../src/fix.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const cli = join(here, '..', 'src', 'cli.js');

const rejected = (source: string): A0Error => {
  try {
    parseAndValidate(source);
  } catch (e) {
    if (e instanceof A0Error) return e;
    throw e;
  }
  throw new Error('accepted');
};

// --- the spelling rule ---------------------------------------------------------------------

/**
 * TypeScript v5.9.3 getSpellingSuggestion + levenshteinWithMax, ported line for line in floating
 * point as an independent reference: the table implementation works in integer tenths.
 */
function referenceLevenshtein(s1: string, s2: string, max: number): number | undefined {
  let previous: number[] = new Array(s2.length + 1);
  let current: number[] = new Array(s2.length + 1);
  const big = max + 0.01;
  for (let i = 0; i <= s2.length; i++) previous[i] = i;
  for (let i = 1; i <= s1.length; i++) {
    const c1 = s1.charCodeAt(i - 1);
    const minJ = Math.ceil(i > max ? i - max : 1);
    const maxJ = Math.floor(s2.length > max + i ? max + i : s2.length);
    current[0] = i;
    let colMin = i;
    for (let j = 1; j < minJ; j++) current[j] = big;
    for (let j = minJ; j <= maxJ; j++) {
      const substitutionDistance =
        (s1[i - 1] as string).toLowerCase() === (s2[j - 1] as string).toLowerCase()
          ? (previous[j - 1] as number) + 0.1
          : (previous[j - 1] as number) + 2;
      const dist =
        c1 === s2.charCodeAt(j - 1)
          ? (previous[j - 1] as number)
          : Math.min(
              (previous[j] as number) + 1,
              (current[j - 1] as number) + 1,
              substitutionDistance,
            );
      current[j] = dist;
      colMin = Math.min(colMin, dist);
    }
    for (let j = maxJ + 1; j <= s2.length; j++) current[j] = big;
    if (colMin > max) return undefined;
    const temp = previous;
    previous = current;
    current = temp;
  }
  const res = previous[s2.length] as number;
  return res > max ? undefined : res;
}

function referenceSuggestion(name: string, candidates: readonly string[]): string | undefined {
  const maximumLengthDifference = Math.max(2, Math.floor(name.length * 0.34));
  let bestDistance = Math.floor(name.length * 0.4) + 1;
  let best: string | undefined;
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - name.length) <= maximumLengthDifference) {
      if (candidate === name) continue;
      if (candidate.length < 3 && candidate.toLowerCase() !== name.toLowerCase()) continue;
      const distance = referenceLevenshtein(name, candidate, bestDistance - 0.1);
      if (distance === undefined) continue;
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

test('spelling suggestion: the rule of TypeScript getSpellingSuggestion', () => {
  const ops = ['add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr', 'select', 'fold', 'loop'];
  // One edit on a name of three or more characters is close enough.
  assert.equal(spellingSuggestion('mull', ops), 'mul');
  assert.equal(spellingSuggestion('selct', ops), 'select');
  assert.equal(
    spellingSuggestion('flod', ['fold', 'loop']),
    undefined,
    'a swap costs two substitutions',
  );
  // A candidate shorter than 3 characters counts only when it differs by case alone.
  assert.equal(spellingSuggestion('xr', ['or', 'xor']), undefined);
  assert.equal(spellingSuggestion('OR', ['or']), 'or');
  // The name itself is never its own suggestion; case differences are almost free.
  assert.equal(spellingSuggestion('add', ['add']), undefined);
  assert.equal(spellingSuggestion('ADD', ['add', 'sub']), 'add');
  // The bound is 40% of the length plus one: two edits pass at length 5, not at length 4.
  assert.equal(spellingSuggestion('accum', ['acc']), 'acc');
  assert.equal(spellingSuggestion('abcd', ['ab', 'abcdefgh']), undefined);
  // Nothing close: no suggestion.
  assert.equal(spellingSuggestion('frobnicate', ops), undefined);
  // The first of equally close candidates wins.
  assert.equal(spellingSuggestion('mul', ['mula', 'mulb']), 'mula');
  // A substitution costs two edits, so one wrong letter in a short name is not suggested.
  assert.equal(spellingSuggestion('mulx', ['mula']), undefined);
  assert.equal(levenshteinTenths('mull', 'mul', 19), 10);
  assert.equal(levenshteinTenths('mull', 'sub', 19), undefined);
});

test('spelling suggestion: integer tenths agree with the floating-point reference port', () => {
  let seed = 12345;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const word = (): string => {
    const len = 1 + rand(9);
    return Array.from({ length: len }, () => 'abcdeABC_'[rand(9)]).join('');
  };
  for (let round = 0; round < 4000; round += 1) {
    const name = word();
    const candidates = Array.from({ length: 1 + rand(8) }, word);
    assert.equal(
      spellingSuggestion(name, candidates),
      referenceSuggestion(name, candidates),
      `${name} against ${candidates.join(',')}`,
    );
  }
});

// --- the table -----------------------------------------------------------------------------

test('diagnostics table: stable codes, templates, and 3-6 line explanations', () => {
  const ids = diagnosticIds();
  assert.ok(ids.length >= 90, `${ids.length} rows`);
  for (const id of ids) {
    const spec = DIAGNOSTICS[id as DiagId] as (typeof DIAGNOSTICS)[DiagId] & {
      fix?: string;
      example?: unknown;
      unrunnable?: string;
    };
    assert.match(id, /^A0[0-9]{3}$/);
    assert.ok(spec.message.length > 0, id);
    assert.ok(
      spec.why.length >= 1 && spec.why.length <= 6,
      `${id}: explanation has ${spec.why.length} lines`,
    );
    assert.ok(
      (spec.example === undefined) !== (spec.unrunnable === undefined),
      `${id}: exactly one of an example and the reason there is none`,
    );
    // Placeholders in a fix are bound by the arguments the message uses.
    const slots = (t: string): number[] => [...t.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
    const used = new Set(slots(spec.message));
    for (const k of slots(spec.fix ?? ''))
      assert.ok(used.has(k) || k > Math.max(...used, -1), `${id}: fix slot {${k}}`);
  }
  for (const f of EXACT_FIXES) assert.ok(f.id in DIAGNOSTICS, f.id);
  // Coarse classes are the documented ones.
  const classes = new Set(ids.map((id) => DIAGNOSTICS[id as DiagId].cls));
  for (const c of classes)
    assert.ok(
      [
        'parse',
        'type',
        'structure',
        'limit',
        'edit',
        'patch',
        'revision',
        'handle',
        'runtime',
        'cli',
      ].includes(c),
      c,
    );
});

test('diagnostics table: no front-end source spells a message outside the table', async () => {
  for (const file of ['core', 'edit', 'link', 'mcp', 'cli']) {
    const text = await readFile(join(root, 'src', `${file}.ts`), 'utf8');
    const stray = [...text.matchAll(/new A0Error\(/g)].length;
    // core.ts builds the rewritten nested/ret errors from the table's own error; nothing else.
    assert.ok(
      stray <= (file === 'core' ? 2 : 0),
      `${file}.ts has ${stray} message strings outside the table`,
    );
  }
});

test('explain: every example runs (the failing one raises its code, the fixed one passes)', () => {
  assert.deepEqual(verifyExamples(), []);
  const text = explain('a0011') as string;
  assert.match(text, /^A0011 parse: unknown operation/);
  assert.match(text, /fails:\n {2}fn f u32 -> u32\n {2}a ADD p0 1/);
  assert.match(text, /fixed:\n {2}fn f u32 -> u32\n {2}a add p0 1/);
  assert.match(text, /exact fixes/);
  assert.equal(explain('A9999'), undefined);
  assert.equal(explainIndex().split('\n').filter(Boolean).length, diagnosticIds().length);
  // Explanations stay out of the primer.
  return readFile(join(root, 'MODEL_GUIDE.rules-merged.txt'), 'utf8').then((primer) => {
    assert.ok(!/A0[0-9]{3}|explain/.test(primer));
  });
});

// --- did you mean --------------------------------------------------------------------------

test('did you mean: op, function, node, fold body, loop predicate, type and parameter', () => {
  const sq = 'fn square u32 -> u32\na mul p0 p0\nret a\nend\n';
  const fix = (src: string): string | undefined => rejected(src).fix;
  assert.match(fix('fn f u32 -> u32\na mull p0 2\nret a\nend\n') ?? '', /^did you mean 'mul'\?$/);
  assert.match(
    fix(`${sq}fn f u32 -> u32\nb call squar p0\nret b\nend\n`) ?? '',
    /^did you mean 'square'\?$/,
  );
  assert.match(
    fix(`${sq}fn f u32 -> u32\nb squar p0\nret b\nend\n`) ?? '',
    /^did you mean 'square'\?$/,
  );
  assert.match(
    fix('fn f u32 -> u32\naccum add p0 1\nb add acum 1\nret b\nend\n') ?? '',
    /^did you mean 'accum'\?$/,
  );
  assert.match(
    fix(
      'fn step u32 u32 -> u32\nr add p0 p1\nret r\nend\nfn f -> u32\na fold stepp 4 0\nret a\nend\n',
    ) ?? '',
    /^did you mean 'step'\?$/,
  );
  assert.match(
    fix(
      'fn below u32 u32 -> bool\nb lt p0 5\nret b\nend\nfn step u32 u32 -> u32\nr add p0 1\nret r\nend\nfn f -> u32\na loop belw step 10 0\nret a\nend\n',
    ) ?? '',
    /^did you mean 'below'\?$/,
  );
  assert.match(fix('fn f bol -> bool\na mov p0\nret a\nend\n') ?? '', /^did you mean 'bool'\?/);
  // A parameter has no spelling to guess; the fix says what the function has.
  assert.match(
    fix('fn f u32 -> u32\na add p0 p3\nret a\nend\n') ?? '',
    /f has 1 parameter \(p0\.\.p0\)/,
  );
  // No close candidate: the existing fix text, not a wild guess.
  assert.match(
    fix('fn f u32 -> u32\na frobnicate p0\nret a\nend\n') ?? '',
    /neither an op nor a function/,
  );
  // A callee defined below its caller is named as such.
  assert.match(
    fix('fn f u32 -> u32\na call g p0\nret a\nend\nfn g u32 -> u32\nb add p0 1\nret b\nend\n') ??
      '',
    /'g' is defined below f/,
  );
  // A typo is `maybe`, never `exact`.
  assert.equal(rejected('fn f u32 -> u32\na mull p0 2\nret a\nend\n').applicability, 'maybe');
});

test('structured fields: class, table code, fix, applicability and edits', () => {
  const e = rejected('fn f u32 -> u32\na ADD p0 1\nret a\nend\n');
  assert.equal(e.code, 'parse', 'the coarse class is unchanged');
  assert.equal(e.id, 'A0011');
  assert.equal(e.applicability, 'exact');
  assert.equal(e.edits.length, 1);
  const json = e.toJSON();
  assert.equal(json.id, 'A0011');
  assert.equal(json.applicability, 'exact');
  assert.equal(json.line, 2);
  assert.deepEqual(json.edits, [
    { op: 'lines', rule: 'case', text: 'a ADD p0 1', to: 'a add p0 1', line: 2 },
  ]);
  assert.match(
    formatDiagnostic(e, '`fix all`'),
    /^parse: line 2: unknown operation 'ADD' fix: write 'add'.* Reply `fix all` to apply it\. \[A0011\]$/,
  );
  assert.doesNotMatch(formatDiagnostic(e), /fix all|A0011/);
  // A diagnostic without a fix says so with nulls, not omissions.
  const none = rejected('fn f u32 -> u32\na add p0 1\na add p0 2\nret a\nend\n').toJSON();
  assert.equal(none.applicability, null);
  assert.equal(none.fix, null);
  assert.deepEqual(none.edits, []);
  // Lines of validator diagnostics are found from the function and node they name.
  const src = 'fn f u32 -> u32\na add p0 1\nb add a b\nret b\nend\n';
  assert.equal(diagnosticLine(src, rejected(src)), 3);
});

// --- applying fixes -------------------------------------------------------------------------

test('exact fixes: each one rewrites its line and keeps comments', () => {
  const cases: [string, string][] = [
    ['a ADD p0 1', 'a add p0 1'],
    ['a = add p0 1', 'a add p0 1'],
    ['a: add p0 1', 'a add p0 1'],
    ['a add p0, 1', 'a add p0 1'],
    ['a add p0 0x10', 'a add p0 16'],
    ['a add P0 1', 'a add p0 1'],
    ['a add p0 1 # keep', 'a add p0 1 # keep'],
  ];
  for (const [bad, good] of cases) {
    const src = `fn f u32 -> u32\n${bad}\nret a\nend\n`;
    const out = fixAll(src, (t) => {
      parseAndValidate(t);
    });
    assert.equal(out.error, undefined, bad);
    assert.equal(out.text, `fn f u32 -> u32\n${good}\nret a\nend\n`, bad);
  }
  // A literal beyond u32 has no fix; a negative one is only a suggestion.
  assert.equal(
    fixAll('fn f u32 -> u32\na add p0 0x1ffffffff\nret a\nend\n', (t) => void parseAndValidate(t))
      .error?.applicability,
    undefined,
  );
  assert.equal(rejected('fn f u32 -> u32\na add p0 -1\nret a\nend\n').applicability, 'maybe');
  // Nested operands with two pairs of parentheses are not exact (one rewrite would not finish it).
  assert.equal(
    rejected('fn f u32 -> u32\na add (mul (add p0 1) 2) 1\nret a\nend\n').applicability,
    'maybe',
  );
});

test('rename edits: typo suggestions apply to the node line of the named function', () => {
  const fn = (name: string): string =>
    `fn ${name} u32 -> u32\naccum add p0 1\nb add acum 1\nret b\nend\n`;
  const src = `${fn('g')}${fn('f')}`;
  const e = rejected(src);
  assert.equal(e.edits[0]?.op, 'rename');
  const fixed = applyEdit(src, e.edits[0] as (typeof e.edits)[number]);
  assert.equal(
    fixed,
    `${fn('g').replace('acum', 'accum')}${fn('f')}`,
    'only the named function changes',
  );
});

// --- `fix all` in the edit protocol ----------------------------------------------------------

const BASE =
  'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn twice u32 -> u32\nx call sq p0\ny add x x\nret y\nend\n';
const open = (): EditSession => {
  const s = new EditSession(parseAndValidate(BASE));
  s.open('twice', { scope: 'deps' });
  s.openProgram();
  return s;
};

test('fix all: applies every exact fix of the last rejected reply, atomically', () => {
  const s = open();
  const before = programRevision(s.program);
  assert.throws(
    () => s.apply('y ADD x, 0x2'),
    (e: unknown) => e instanceof A0Error && e.id === 'A0011' && e.applicability === 'exact',
  );
  assert.equal(programRevision(s.program), before, 'a rejected reply changes nothing');
  s.apply('fix all');
  assert.notEqual(programRevision(s.program), before);
  const twice = s.program.byName.get('twice');
  assert.ok(twice !== undefined);
  // Accepted: `fix all` is spent, and a second one has nothing to fix.
  assert.throws(
    () => s.apply('fix all'),
    (e: unknown) => e instanceof A0Error && e.id === 'A0521',
  );
});

test('fix all: a remaining diagnostic without an exact fix commits nothing', () => {
  const s = open();
  const before = programRevision(s.program);
  // First error is exact (ADD), the second (a typo) is only a suggestion.
  assert.throws(() => s.apply('x ADD p0 1\ny mull x 2'));
  assert.throws(
    () => s.apply('fix all'),
    (e: unknown) => e instanceof A0Error && e.id === 'A0102' && e.applicability === 'maybe',
  );
  assert.equal(programRevision(s.program), before, 'atomic: not even the exact fix landed');
  // The partially fixed reply is what the next `fix all` replays, so a corrected reply still works.
  s.apply('y add x x');
});

test('fix all: a handle line may precede it, and an accepted reply clears the memory', () => {
  const s = open();
  assert.throws(() => s.apply('e0\ny ADD x x'));
  s.apply('e0\nfix all');
  assert.throws(() => s.apply('fix all'), /no rejected reply/);
  s.apply('y add x 3');
  assert.throws(
    () => s.apply('fix all'),
    (e: unknown) => e instanceof A0Error && e.id === 'A0521',
  );
});

test('fix all: the signature echo of -fn is exact; nested operands expand', () => {
  const s = open();
  assert.throws(
    () => s.apply('-fn sq u32 u32 -> u32\nfn sq u32 -> u32\na mul p0 3\nret a\nend'),
    /does not match/,
  );
  s.apply('fix all');
  const sq = s.program.byName.get('sq');
  assert.equal(sq?.nodes[0]?.args[1]?.kind, 'u32');
  assert.throws(
    () => s.apply('y add x (add x 1)'),
    (e: unknown) => e instanceof A0Error && e.id === 'A0010',
  );
  s.apply('fix all');
  assert.ok((s.program.byName.get('twice')?.nodes.length ?? 0) >= 3);
});

// --- command line ----------------------------------------------------------------------------

test('a0 check --json, --fix and a0 explain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-diag-'));
  try {
    const file = join(dir, 'bad.a0');
    await writeFile(file, 'fn f u32 -> u32\na ADD p0 1\nret a\nend\n');
    const failed = spawnSync('node', [cli, 'check', file, '--json'], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    const body = JSON.parse(failed.stdout) as {
      ok: boolean;
      diagnostics: { id: string; code: string; applicability: string; fix: string; line: number }[];
    };
    assert.equal(body.ok, false);
    assert.deepEqual(
      [
        body.diagnostics[0]?.id,
        body.diagnostics[0]?.code,
        body.diagnostics[0]?.applicability,
        body.diagnostics[0]?.line,
      ],
      ['A0011', 'parse', 'exact', 2],
    );
    // Without --json the error line names the way to apply the exact fix.
    const plain = spawnSync('node', [cli, 'check', file, '--hints'], { encoding: 'utf8' });
    assert.match(plain.stderr, /Reply `a0 check --fix` to apply it\. \[A0011\]/);
    assert.doesNotMatch(
      spawnSync('node', [cli, 'check', file], { encoding: 'utf8' }).stderr,
      /Reply|A0011/,
    );
    assert.equal(plain.status, 1);
    // --fix writes the fixed file, and only when it is accepted.
    const fixed = spawnSync('node', [cli, 'check', file, '--fix'], { encoding: 'utf8' });
    assert.equal(fixed.status, 0);
    assert.equal(await readFile(file, 'utf8'), 'fn f u32 -> u32\na add p0 1\nret a\nend\n');
    const stuck = join(dir, 'stuck.a0');
    const source = 'fn f u32 -> u32\na ADD p0 1\nb mull a 2\nret b\nend\n';
    await writeFile(stuck, source);
    const still = spawnSync('node', [cli, 'check', stuck, '--fix'], { encoding: 'utf8' });
    assert.equal(still.status, 1);
    assert.equal(
      await readFile(stuck, 'utf8'),
      source,
      'a file with a remaining error is not rewritten',
    );
    assert.match(still.stderr, /did you mean 'mul'\?/);
    // explain
    const text = execFileSync('node', [cli, 'explain', 'A0102'], { encoding: 'utf8' });
    assert.match(text, /^A0102 structure: /);
    assert.match(text, /fails:\n/);
    assert.match(text, /fixed:\n/);
    assert.equal(
      execFileSync('node', [cli, 'explain', '--verify'], { encoding: 'utf8' }),
      'every example holds\n',
    );
    assert.equal(spawnSync('node', [cli, 'explain', 'A9999'], { encoding: 'utf8' }).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
