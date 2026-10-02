import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAndValidate, run, type TypedFunc, type Value } from '../src/core.js';
import { type ContractResult, PROVE_ARRAY_CAP, proveContracts } from '../src/prove.js';

const cli = join(import.meta.dirname, '..', 'src', 'cli.js');

const proveOne = async (
  source: string,
  name: string,
  timeoutMs?: number,
): Promise<ContractResult> => {
  const results = await proveContracts(
    parseAndValidate(source),
    timeoutMs === undefined ? { only: [name] } : { only: [name], timeoutMs },
  );
  assert.equal(results.length, 1);
  return results[0] as ContractResult;
};

test('a contract that holds for every input is proved', async () => {
  const r = await proveOne(
    'fn inc u32 -> u32\nex 1 -> 2\npre lt p0 100\npost gt r p0\na add p0 1\nret a\nend\n',
    'inc',
  );
  assert.equal(r.status, 'proved');
  assert.deepEqual(r.lines, ['pre', 'post']);
  assert.equal(r.diagnostic, undefined);
});

test('arrays, a get under an index mask and a literal fold are inside the scope', async () => {
  const src = [
    'fn step u32 u32 -> u32',
    'a add p0 p1',
    'ret a',
    'end',
    'fn masked u32x4 u32 -> u32',
    'post lt r 4294967295',
    'm and p1 3',
    'g get p0 m',
    'h and g 255',
    'ret h',
    'end',
    'fn sum u32 -> u32',
    'pre lt p0 1000',
    'post ge r p0',
    'a fold step 4 p0',
    'ret a',
    'end',
    '',
  ].join('\n');
  assert.equal((await proveOne(src, 'masked')).status, 'proved');
  assert.equal((await proveOne(src, 'sum')).status, 'proved');
});

test('a disproved contract names an input that the interpreter confirms', async () => {
  const src = 'fn wrap u32 -> u32\npost gt r p0\na add p0 1\nret a\nend\n';
  const r = await proveOne(src, 'wrap');
  assert.equal(r.status, 'disproved');
  assert.equal(r.diagnostic?.id, 'A0717');
  assert.equal(r.inputs, 'p0=4294967295');
  const fn = parseAndValidate(src).byName.get('wrap') as TypedFunc;
  const result = run(fn, [4294967295]);
  assert.equal(result, 0);
  assert.equal(result > 4294967295, false);
  assert.match(r.error?.message ?? '', /contract of wrap disproved: p0=4294967295/);
});

test('the counterexample of an array parameter is a concrete array', async () => {
  const src = ['fn g u32x3 -> u32', 'post lt r 7', 'a get p0 1', 'ret a', 'end', ''].join('\n');
  const g = await proveOne(src, 'g');
  assert.equal(g.status, 'disproved');
  const program = parseAndValidate(src);
  const shown = /p0=\[(\d+);(\d+);(\d+)\]/.exec(g.inputs ?? '');
  assert.notEqual(shown, null);
  const args: Value[] = [[Number(shown?.[1]), Number(shown?.[2]), Number(shown?.[3])]];
  assert.ok((run(program.byName.get('g') as TypedFunc, args) as number) >= 7);
});

test('outside the scope is a note with the reason, never a failure', async () => {
  const src = [
    'fn step u32 u32 -> u32',
    'a add p0 p1',
    'ret a',
    'end',
    `fn big u32x${PROVE_ARRAY_CAP + 1} -> u32`,
    'post ge r 0',
    'a get p0 0',
    'ret a',
    'end',
    'fn varcount u32 -> u32',
    'post ge r 0',
    'a fold step p0 0',
    'ret a',
    'end',
    'fn longfold u32 -> u32',
    'post ge r 0',
    'a fold step 65 p0',
    'ret a',
    'end',
    '',
  ].join('\n');
  for (const [name, reason] of [
    ['big', /array of 17 elements, over the bound of 16/],
    ['varcount', /variable-count fold/],
    ['longfold', /count 65 exceeds unroll cap/],
  ] as const) {
    const r = await proveOne(src, name);
    assert.equal(r.status, 'unknown', name);
    assert.equal(r.diagnostic?.id, 'A0718');
    assert.match(r.reason ?? '', reason);
  }
});

test('the solver time is bounded and a timeout is a note', async () => {
  // no factorisation of a 31-bit prime into two 16-bit factors above 1: true, and out of reach of
  // the bit-blaster in 100 ms
  const src = [
    'fn dom u32 u32 -> bool',
    'a gt p0 1',
    'b gt p1 1',
    'c lt p0 65536',
    'd lt p1 65536',
    'e and a b',
    'f and c d',
    'g and e f',
    'ret g',
    'end',
    'fn fac u32 u32 -> u32',
    'pre call dom p0 p1',
    'post ne r 2147483647',
    'a mul p0 p1',
    'ret a',
    'end',
    '',
  ].join('\n');
  const start = performance.now();
  const r = await proveOne(src, 'fac', 100);
  assert.ok(performance.now() - start < 30_000);
  assert.equal(r.status, 'unknown');
  assert.equal(r.diagnostic?.id, 'A0718');
  assert.match(r.reason ?? '', /solver gave up \(timeout\).*limit 100 ms/);
});

test('strict profile: a trap is a failure, a proved-safe site is not', async () => {
  const src = [
    'profile strict',
    'fn unsafe u32x4 u32 -> u32',
    'post ge r 0',
    'g get p0 p1',
    'ret g',
    'end',
    'fn safe u32x4 u32 -> u32',
    'post ge r 0',
    'm and p1 3',
    'g get p0 m',
    'ret g',
    'end',
    'fn recip u32 -> u32',
    'post ge r 0',
    'd div 10 p0',
    'ret d',
    'end',
    'fn probe u32 -> bool',
    'd div 10 p0',
    'c lt d 5',
    'ret c',
    'end',
    'fn guarded u32 -> u32',
    'pre call probe p0',
    'a add p0 1',
    'ret a',
    'end',
    '',
  ].join('\n');
  const unsafe = await proveOne(src, 'unsafe');
  assert.equal(unsafe.status, 'disproved');
  assert.match(unsafe.error?.message ?? '', /unsafe traps: .*trap bounds/);
  assert.equal((await proveOne(src, 'safe')).status, 'proved');
  const recip = await proveOne(src, 'recip');
  assert.equal(recip.status, 'disproved');
  assert.match(recip.inputs ?? '', /^p0=0$/);
  assert.match(recip.error?.message ?? '', /trap divzero/);
  const guarded = await proveOne(src, 'guarded');
  assert.equal(guarded.status, 'disproved');
  assert.match(guarded.error?.message ?? '', /pre traps/);
});

test('the default profile has no traps: the same get is proved', async () => {
  const src = 'fn f u32x4 u32 -> u32\npost ge r 0\ng get p0 p1\nret g\nend\n';
  assert.equal((await proveOne(src, 'f')).status, 'proved');
});

test('a program without pre or post is not touched', async () => {
  const src =
    'fn f u32 -> u32\nex 1 -> 2\na add p0 1\nret a\nend\nfn g u32 -> u32\na add p0 1\nret a\nend\n';
  assert.deepEqual(await proveContracts(parseAndValidate(src)), []);
});

test('a0 check --prove: statuses, the warning and --deny-disproved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-prove-'));
  const file = join(dir, 'p.a0');
  writeFileSync(
    file,
    'fn inc u32 -> u32\npre lt p0 100\npost gt r p0\na add p0 1\nret a\nend\nfn wrap u32 -> u32\npost gt r p0\na add p0 1\nret a\nend\n',
  );
  const plain = spawnSync('node', [cli, 'check', file], { encoding: 'utf8' });
  assert.equal(plain.status, 0);
  assert.doesNotMatch(plain.stdout, /contract/);
  const proved = spawnSync('node', [cli, 'check', file, '--prove'], { encoding: 'utf8' });
  assert.equal(proved.status, 0);
  assert.match(proved.stdout, /inc: contract proved \(pre post,/);
  assert.match(proved.stdout, /warning: structure: contract of wrap disproved: p0=4294967295/);
  const denied = spawnSync('node', [cli, 'check', file, '--prove', '--deny-disproved'], {
    encoding: 'utf8',
  });
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /error: structure: contract of wrap disproved/);
  const json = spawnSync('node', [cli, 'check', file, '--prove', '--json'], { encoding: 'utf8' });
  const out = JSON.parse(json.stdout) as {
    contracts: { fn: string; status: string; diagnostic?: { id: string } }[];
  };
  assert.deepEqual(
    out.contracts.map((c) => [c.fn, c.status, c.diagnostic?.id]),
    [
      ['inc', 'proved', undefined],
      ['wrap', 'disproved', 'A0717'],
    ],
  );
  const misuse = spawnSync('node', [cli, 'check', file, '--deny-disproved'], { encoding: 'utf8' });
  assert.notEqual(misuse.status, 0);
});
