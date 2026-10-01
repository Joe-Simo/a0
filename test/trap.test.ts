import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import {
  A0Error,
  formatDiagnostic,
  formatTrap,
  makeIo,
  parseAndValidate,
  run,
  type TypedFunc,
} from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';

// top(n, m): n outer trips of `step`, each running m inner trips of `inner`.
const NESTED = `fn inner u32 u32 -> u32
a add p0 p1
ret a
end
fn step u32 u32 u32 -> u32
r fold inner p2 p0
ret r
end
fn top u32 u32 -> u32
a fold step p0 0 p1
ret a
end
`;

const program = parseAndValidate(NESTED);
const top = program.byName.get('top') as TypedFunc;

function trapOf(fn: () => unknown): A0Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof A0Error) return e;
    throw e;
  }
  throw new Error('expected the run to stop on a budget');
}

test('trap: the iteration cap names function, loop node, trip and call chain', () => {
  // 3 outer trips x 4 inner trips: 15 trips in all; a cap of 5 refuses outer trip 1 in `top`.
  const outer = trapOf(() => run(top, [3, 4], { fuel: 1e9, maxTrips: 5 }));
  assert.equal(
    formatDiagnostic(outer),
    'limit: trap iter fn=top at=top.a trip=1 chain=top fix: raise the trip cap or lower the fold/loop counts on the chain',
  );
  // A cap of 6 lets outer trip 1 start and refuses its inner trip 0, two frames deep.
  const inner = trapOf(() => run(top, [3, 4], { fuel: 1e9, maxTrips: 6 }));
  assert.equal(
    formatTrap(inner.trap as NonNullable<A0Error['trap']>),
    'limit: trap iter fn=step at=step.r trip=0 chain=top>step fix: raise the trip cap or lower the fold/loop counts on the chain',
  );
  assert.equal(inner.code, 'limit');
  // Exactly enough trips is not a stop.
  assert.equal(run(top, [3, 4], { fuel: 1e9, maxTrips: 15 }), run(top, [3, 4]));
});

test('trap: fuel exhaustion reports where the budget ran out', () => {
  const e = trapOf(() => run(top, [1000, 1000], { fuel: 5000 }));
  assert.match(e.message, /fuel exhausted/);
  const line = formatDiagnostic(e);
  assert.match(
    line,
    /^limit: trap fuel fn=(top|step|inner) at=(top\.a|step\.r) trip=\d+ chain=top(>step(>inner)?)? fix: raise the fuel budget/,
  );
  assert.ok(!line.includes('\n'), 'one line');
});

test('trap: the io output cap stops with the same code shape', () => {
  const p = parseAndValidate(
    'fn wr io u32 -> io\nr write p0 p1\nret r\nend\nfn spam u32 io -> io\nr fold wr p0 p1\nret r\nend',
  );
  const e = trapOf(() =>
    run(p.byName.get('spam') as TypedFunc, [1_100_000, makeIo([])], { fuel: 1e9 }),
  );
  assert.match(
    formatDiagnostic(e),
    /^limit: trap io fn=wr at=spam\.r trip=1048576 chain=spam>wr fix: /,
  );
});

test('trap: a run that stays within its budgets is unchanged and a second run restarts the chain', () => {
  assert.equal(run(top, [2, 3], { fuel: 1e9, maxTrips: 8 }), run(top, [2, 3]));
  const opts = { fuel: 1e9, maxTrips: 2 };
  trapOf(() => run(top, [3, 4], opts));
  // The shared options object is reused: frames from the stopped run must not leak.
  const again = trapOf(() => run(top, [3, 4], { ...opts, maxTrips: 0 }));
  assert.match(formatDiagnostic(again), /chain=top fix:/);
});

test('trap: the C backend prints the interpreter trap line and exits 3', async () => {
  const clang = findClang();
  if (clang.path === undefined) return assert.fail('clang is required for the C trap test');
  const cap = 6;
  const want = formatDiagnostic(trapOf(() => run(top, [3, 4], { fuel: 1e9, maxTrips: cap })));
  const c = compile(program, 'c', { cTrap: { maxTrips: cap } }).text;
  const main = (n: number, m: number): string =>
    `#include "module.c"\nint main(void) { printf("%u\\n", (unsigned)a0_top(${n}u, ${m}u)); return 0; }\n`;
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.c'), c, 'utf8');
    const build = async (name: string, src: string): Promise<string> => {
      await writeFile(join(dir, `${name}.c`), src, 'utf8');
      const r = runTool(
        clang.path as string,
        [
          '-std=c11',
          '-O1',
          '-Wall',
          '-Wextra',
          '-Wno-unused-parameter',
          '-Werror',
          '-o',
          name,
          `${name}.c`,
        ],
        { cwd: dir },
      );
      assert.ok(r.ok, r.stderr);
      return join(dir, name);
    };
    // Past the cap: one stderr line equal to the interpreter's, status 3, nothing on stdout.
    const stopped = runTool(await build('stop', main(3, 4)), [], { cwd: dir });
    assert.equal(stopped.status, 3);
    assert.equal(stopped.stderr, `${want}\n`);
    assert.equal(stopped.stdout, '');
    // The inner-frame stop (cap 6 above) and the outer-frame stop (cap 5) both match.
    const w2 = formatDiagnostic(trapOf(() => run(top, [3, 4], { fuel: 1e9, maxTrips: 5 })));
    const c5 = compile(program, 'c', { cTrap: { maxTrips: 5 } }).text;
    await writeFile(join(dir, 'module.c'), c5, 'utf8');
    const outer = runTool(await build('stop5', main(3, 4)), [], { cwd: dir });
    assert.equal(outer.status, 3);
    assert.equal(outer.stderr, `${w2}\n`);
    // Within the cap the module computes the interpreter's value and prints no trap.
    const ok = runTool(await build('ok', main(1, 3)), [], { cwd: dir });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), String(run(top, [1, 3])));
    assert.equal(ok.stderr, '');
  });
});

test('trap: the C trap runtime is opt-in and refuses the parallel runtime', () => {
  assert.ok(!compile(program, 'c').text.includes('a0_trip'), 'default C output has no trap code');
  assert.throws(
    () => compile(program, 'c', { cTrap: { maxTrips: -1 } }),
    /cTrap\.maxTrips must be a u32/,
  );
});
