import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';

// Loop code of the direct x86-64 backend (src/x86_64.ts), assembled by clang, linked with a C
// driver and run against the interpreter on every input, optimized and not.

const X86_64_HOST =
  process.arch === 'x64' && (process.platform === 'linux' || process.platform === 'darwin');
const SKIP = X86_64_HOST ? false : 'needs an x86-64 Linux or macOS host';
const zeros = (n: number): string => Array.from({ length: n }, () => '0').join(' ');
const counting = (n: number): string =>
  Array.from({ length: n }, (_, i) => String(i + 1)).join(' ');
const sym = (name: string): string =>
  process.platform === 'darwin' ? `_a0_${name}` : `a0_${name}`;

const INPUTS: [number, number][] = [
  [0, 0],
  [1, 2],
  [7, 13],
  [0xffffffff, 5],
  [123456, 0xfffffff0],
  [0x9e3779b9, 0x7f4a7c15],
  [0xdeadbeef, 0xffffffff],
];

/** Assemble `src` for x86-64, run `names` on every input, and compare with the interpreter. */
async function checkAgainstInterpreter(src: string, names: readonly string[]): Promise<string> {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required as the assembler/linker driver');
  const p = parseAndValidate(src);
  const expected = INPUTS.flatMap(([a, b]) =>
    names.map((n) => String(run(p.byName.get(n) as TypedFunc, [a, b]))),
  );
  const protos = names.map((n) => `extern uint32_t a0_${n}(uint32_t, uint32_t);`).join('\n');
  const calls = INPUTS.flatMap(([a, b]) =>
    names.map((n) => `  printf("%u\\n", a0_${n}(${a}u, ${b}u));`),
  ).join('\n');
  const driver = `#include <stdint.h>\n#include <stdio.h>\n${protos}\nint main(void) {\n${calls}\n  return 0;\n}\n`;
  for (const optimize of [true, false]) {
    const text = compile(p, 'x86_64', { optimize }).text;
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'module.s'), text, 'utf8');
      await writeFile(join(dir, 'driver.c'), driver, 'utf8');
      const as = runTool(clang, ['-c', '-x', 'assembler', '-o', 'module.o', 'module.s'], {
        cwd: dir,
      });
      assert.ok(as.ok, as.stderr);
      const ld = runTool(clang, ['-O1', '-o', 'driver', 'driver.c', 'module.o'], { cwd: dir });
      assert.ok(ld.ok, ld.stderr);
      const exec = runTool(join(dir, 'driver'), [], { cwd: dir });
      assert.ok(exec.ok, exec.stderr);
      const got = exec.stdout.trim().split('\n');
      const bad = expected.findIndex((w, i) => w !== got[i]);
      assert.equal(
        bad,
        -1,
        `${names[bad % names.length]}${JSON.stringify(INPUTS[Math.floor(bad / names.length)])} (optimize ${optimize}): got ${got[bad]}, want ${expected[bad]}`,
      );
    });
  }
  return compile(p, 'x86_64').text;
}

/** The body of the first loop of `name` in `asm`: from its first label to the branch back. */
function firstLoop(asm: string, name: string): string {
  const fn = new RegExp(`${sym(name)}:[\\s\\S]*?\\n\\tret\\n`).exec(asm)?.[0] ?? '';
  const label = /\n(\.?La0_\w+):\n/.exec(fn)?.[1];
  if (label === undefined) return '';
  return fn.slice(fn.indexOf(`${label}:`), fn.indexOf(`jb ${label}`));
}

/**
 * A top function folding `step` over an array of `n` (initially `init`) `count` times (a literal,
 * or a node definition such as `and p0 31`), reading three elements.
 */
const top = (
  name: string,
  step: string,
  n: number,
  count: number | string,
  init: string,
  extras = 'p0 p1',
): string =>
  `fn ${name} u32 u32 -> u32\nz arr ${init}\n${typeof count === 'number' ? '' : `cnt ${count}\n`}a fold ${step} ${typeof count === 'number' ? count : 'cnt'} z ${extras}\nq and p1 ${n - 1}\nr get a q\nw get a ${n - 1}\nx get a 0\ns add r w\nt xor s x\nret t\nend`;

test('x86_64 carried reads: the element a trip stored is the next trip read, kept in a register', {
  skip: SKIP,
}, async () => {
  const fns: string[] = [];
  const names: string[] = [];
  const add = (name: string, text: string): void => {
    fns.push(text);
    names.push(name);
  };
  // Prefix scans guarded at trip 0 by a literal or a loop-invariant parameter seed.
  for (const [label, seed, op, e, n] of [
    ['sa', '0', 'add', 'a mul p1 p3\ne add a 5', 64],
    ['sb', 'p2', 'add', 'a mul p1 p3\ne add a 5', 64],
    ['sc', 'p3', 'xor', 'e shr p1 1', 64],
    ['sd', '7', 'add', 'a mul p1 p1\nx xor a p3\ne shr x 3', 20],
    ['se', 'p2', 'add', 'e mul p1 p3', 13],
  ] as const) {
    add(
      label,
      `fn st${label} u32x${n} u32 u32 u32 -> u32x${n}\nc eq p1 0\nj sub p1 1\nt get p0 j\nu select c ${seed} t\n${e}\nv ${op} u e\nn set p0 p1 v\nret n\nend\n${top(label, `st${label}`, n, n, zeros(n))}`,
    );
  }
  // An xorshift recurrence (a chain the carried register shortens), length not a power of two.
  add(
    'xs',
    `fn xsstep u32x37 u32 u32 -> u32x37\nc eq p1 0\nj sub p1 1\nt get p0 j\ns select c p2 t\na shl s 13\nb xor s a\nc2 shr b 17\nd xor b c2\ne shl d 5\nf xor d e\nn set p0 p1 f\nret n\nend\nfn xs u32 u32 -> u32\nz arr ${zeros(37)}\na fold xsstep 37 z p0\nq and p1 31\nr get a q\nw get a 36\ns add r w\nret s\nend`,
  );
  // No guard: trip 0 reads the initial state's last element (index 2^32 - 1 mod the length).
  for (const n of [16, 13]) {
    add(
      `ng${n}`,
      `fn ngst${n} u32x${n} u32 u32 -> u32x${n}\nj sub p1 1\nt get p0 j\nv add t p2\nn set p0 p1 v\nret n\nend\n${top(`ng${n}`, `ngst${n}`, n, `and p0 ${n === 16 ? 31 : 15}`, counting(n), 'p1')}`,
    );
  }
  // The read and the store indices go through an extra parameter: downwards (p2 - p1, stored at
  // one below) and upwards (p1 - p2, stored at one above), with and without a power-of-two length.
  for (const n of [16, 12]) {
    add(
      `dn${n}`,
      `fn dnst${n} u32x${n} u32 u32 -> u32x${n}\nj sub p2 p1\nt get p0 j\ni1 sub j 1\nv mul t 3\nw add v p1\nn set p0 i1 w\nret n\nend\n${top(`dn${n}`, `dnst${n}`, n, `and p1 ${n === 16 ? 15 : 7}`, counting(n), 'p0')}`,
    );
    add(
      `up${n}`,
      `fn upst${n} u32x${n} u32 u32 -> u32x${n}\nj sub p1 p2\nt get p0 j\ni1 add j 1\nv xor t p1\nw add v 9\nn set p0 i1 w\nret n\nend\n${top(`up${n}`, `upst${n}`, n, `and p1 ${n === 16 ? 15 : 7}`, counting(n), 'p0')}`,
    );
  }
  // The carried value is read again after the stored value is computed (no shared register: the
  // later read feeds another store), and read once at the very node that computes it (shared).
  add(
    'late',
    `fn latest u32x16 u32 u32 -> u32x16\nc eq p1 0\nj sub p1 1\nt get p0 j\nu select c 3 t\nv add u p2\nw mul u 5\nm set p0 0 w\nn set m p1 v\nret n\nend\n${top('late', 'latest', 16, 'and p0 15', zeros(16), 'p1')}`,
  );
  add(
    'same',
    `fn samest u32x16 u32 u32 -> u32x16\nc eq p1 0\nj sub p1 1\nt get p0 j\nu select c p2 t\nv xor u p1\nn set p0 p1 v\nret n\nend\n${top('same', 'samest', 16, 'and p1 15', zeros(16), 'p0')}`,
  );
  // Bool elements.
  add(
    'bools',
    `fn bst boolx8 u32 u32 -> boolx8\nc eq p1 0\nj sub p1 1\nt get p0 j\nu select c true t\nb and p1 p2\nk eq b 0\nv and u k\nn set p0 p1 v\nret n\nend\nfn bools u32 u32 -> u32\nz arr false false false false false false false false\na fold bst 8 z p0\nf0 get a 7\nf1 get a 3\ng0 select f0 1 0\ng1 select f1 2 0\nr add g0 g1\nret r\nend`,
  );
  // An insertion sort sinking each element by adjacent swaps: a `loop` with a predicate whose
  // body carries the element being sunk.
  add(
    'isort',
    `fn ifill u32x32 u32 u32 u32 -> u32x32\nv mul p1 p2\nw add v p3\nx shr w 15\ny xor w x\nm mul y 2654435761\nn set p0 p1 m\nret n\nend\nfn swp u32x32 u32 u32 -> u32x32\nj sub p2 p1\ni1 sub j 1\nu get p0 i1\nv get p0 j\nb set p0 j u\nc set b i1 v\nret c\nend\nfn swpok u32x32 u32 u32 -> bool\nj sub p2 p1\ni1 sub j 1\nu get p0 i1\nv get p0 j\ng gt u v\nret g\nend\nfn ins u32x32 u32 -> u32x32\nr loop swpok swp p1 p0 p1\nret r\nend\nfn isort u32 u32 -> u32\nz arr ${zeros(32)}\na fold ifill 32 z p0 p1\ns fold ins 32 a\nq and p1 31\nr get s q\nw and p0 31\nt get s w\nm mul t 3\no add r m\nret o\nend`,
  );
  const asm = await checkAgainstInterpreter(fns.join('\n\n'), names);
  // A guarded scan neither loads the previous element nor selects the seed in its loop.
  for (const name of ['sa', 'sb', 'xs', 'same']) {
    const loop = firstLoop(asm, name);
    assert.ok(loop.length > 0, `${name} has a loop`);
    assert.doesNotMatch(loop, /cmov|\(%rsp,%r\w+,4\), %/, `${name} loop:\n${loop}`);
  }
});

test('x86_64 induction variables: p1 * K is stepped by K each trip instead of multiplied', {
  skip: SKIP,
}, async () => {
  const fns: string[] = [];
  const names: string[] = [];
  const add = (name: string, text: string): void => {
    fns.push(text);
    names.push(name);
  };
  // A sieve: strided stores at q + p1 * p, a trip count that may be zero, primes counted after.
  add(
    'sieve',
    `fn mark u32x512 u32 u32 u32 -> u32x512\nm mul p1 p3\nj add p2 m\nn set p0 j 1\nret n\nend\nfn sstep u32x512 u32 u32 -> u32x512\nc get p0 p1\nq mul p1 p1\nprime eq c 0\nbig ge p1 2\nfits lt q p2\nr1 and prime big\nr2 and r1 fits\nd sub p2 q\ne add d p1\nf sub e 1\ng div f p1\ncnt select r2 g 0\nr fold mark cnt p0 q p1\nret r\nend\nfn cstep u32 u32 u32x512 -> u32\nv get p2 p1\nz eq v 0\nbig ge p1 2\nb and z big\none select b 1 0\nk add p0 one\nret k\nend\nfn sieve u32 u32 -> u32\nn0 and p0 255\nn add n0 256\nz arr ${zeros(512)}\ns fold sstep 23 z n\nk fold cstep n 0 s\nm mul k 65599\nq and p1 511\nc get s q\nr add m c\nret r\nend`,
  );
  // Literal steps on either side of the product, a step that is an extra parameter, and a
  // product of the counter with itself (not a step), over a variable trip count.
  add(
    'mix',
    `fn mixstep u32 u32 u32 -> u32\na mul p1 7\nb mul 2654435761 p1\nc mul p1 p2\nd mul p1 p1\ne xor a b\nf add e c\ng xor f d\nh add p0 g\nret h\nend\nfn mix u32 u32 -> u32\ncnt and p1 63\nr fold mixstep cnt p0 p0\nret r\nend`,
  );
  // A loop with a predicate that may stop on any trip: the stepped product stays exact.
  add(
    'walk',
    `fn wok u32 u32 u32 -> bool\nm mul p1 p2\nx xor m p0\nc ne x 0\nl lt p1 40\nr and c l\nret r\nend\nfn wstep u32 u32 u32 -> u32\nm mul p1 p2\nx add p0 m\ny shr x 3\nret y\nend\nfn walk u32 u32 -> u32\nr loop wok wstep 64 p0 p1\nret r\nend`,
  );
  const asm = await checkAgainstInterpreter(fns.join('\n\n'), names);
  // The marking loop of the sieve multiplies nothing; the counter squared still does.
  const mark =
    /\n(\.?La0_sieve_\d+):\n(?:(?!\n\.?La0_)[\s\S])*?movl \$1, \d+\(%rsp,%r10,4\)[\s\S]*?jb \1/.exec(
      asm,
    )?.[0];
  assert.ok(mark !== undefined, 'the marking loop is found');
  assert.doesNotMatch(mark, /imul/);
  assert.match(firstLoop(asm, 'mix'), /imull %(\w+), %\w+[\s\S]*/);
});
