import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile, TARGETS } from '../src/backends.js';
import {
  A0Error,
  formatDiagnostic,
  makeIo,
  parseAndValidate,
  run,
  STRICT_TARGETS,
  type TypedFunc,
  type TypedProgram,
  type Value,
  validate,
} from '../src/core.js';
import { formatTrap, type Trap } from '../src/diagnostics.js';
import { emitCSharp } from '../src/dotnet.js';
import { mayTrapFn, optimize, optimizeFunction } from '../src/optimize.js';
import { parallelC } from '../src/parallel.js';
import { findClang, findClangPlusPlus, findGcc, type ToolInfo } from '../src/toolchain.js';
import { wasmModuleBytes } from '../src/wasm.js';
import {
  type Case,
  generateCases,
  generateCorpus,
  oracleRun,
  oracleToValue,
} from '../tools/corpus.js';
import { checkDotnet } from '../tools/dotnet-verify.js';
import {
  checkInterpreter,
  checkJvm,
  checkNative,
  checkWasm,
  checkWasmDirect,
  ioCaps,
} from '../tools/verify.js';

const STRICT = 'profile strict\n';
const EDGES = [0, 1, 2, 3, 7, 0x7fff_ffff, 0x8000_0000, 0xffff_fffe, 0xffff_ffff];

const fnOf = (p: TypedProgram, name: string): TypedFunc => p.byName.get(name) as TypedFunc;

const norm = (v: Value): Value => (Array.isArray(v) ? (v.map(norm) as Value) : v);
const show = (v: unknown): string =>
  JSON.stringify(v instanceof Uint32Array || v instanceof Uint8Array ? Array.from(v) : v);

function interpOutcome(fn: TypedFunc, args: readonly Value[]): string {
  try {
    return `value ${show(norm(run(fn, args)))}`;
  } catch (e) {
    if (e instanceof A0Error && e.trap !== undefined) return `trap ${formatTrap(e.trap)}`;
    throw e;
  }
}

/** A case whose expectation is the interpreter's own outcome (a value, or the trap line). */
function caseFor(fn: TypedFunc, args: Value[], input?: number[]): Case {
  const base = { functionName: fn.name, args };
  try {
    if (input === undefined) return { ...base, expected: run(fn, args) };
    const io = makeIo(input);
    const expected = run(fn, [...args, io]);
    return { ...base, expected, input, expectedOutput: [...io.output] };
  } catch (e) {
    if (e instanceof A0Error && e.trap !== undefined)
      return {
        ...base,
        expected: 0,
        expectedTrap: formatTrap(e.trap),
        ...(input === undefined ? {} : { input, expectedOutput: [] }),
      };
    throw e;
  }
}

const OPS_U32 = ['add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr', 'div', 'rem'] as const;
const OPS_BOOL = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const;
const CHECKED = ['cadd', 'csub', 'cmul', 'cdiv', 'crem'] as const;

/** Every operation as a small function, scalar signatures only (the C driver calls them). */
const opsSource = (head: string): string =>
  `${head}${OPS_U32.map((op) => `fn t_${op} u32 u32 -> u32\nr ${op} p0 p1\nret r\nend\n`).join('')}${OPS_BOOL.map(
    (op) => `fn t_${op} u32 u32 -> bool\nr ${op} p0 p1\nret r\nend\n`,
  ).join('')}${CHECKED.map(
    (op) =>
      `fn t_${op}_v u32 u32 -> u32\nr ${op} p0 p1\nv at r 0\nret v\nend\nfn t_${op}_ok u32 u32 -> bool\nr ${op} p0 p1\nv at r 1\nret v\nend\n`,
  ).join('')}fn t_get u32 -> u32
a arr 10 20 30
r get a p0
ret r
end
fn t_set u32 -> u32
a arr 10 20 30
b set a p0 99
x get b 0
y get b 1
z get b 2
t add x y
u add t z
ret u
end
fn t_cget_v u32 -> u32
a arr 5 6 7
r cget a p0
v at r 0
ret v
end
fn t_cget_ok u32 -> bool
a arr 5 6 7
r cget a p0
v at r 1
ret v
end
fn t_rd io -> u32
a read p0
v at a 0
ret v
end
fn t_rd2 io -> u32
a read p0
v at a 0
t at a 1
b read t
w at b 0
s add v w
ret s
end
`;

/** The cases that exercise every function of `opsSource` at the boundaries. */
function opsCases(program: TypedProgram): Case[] {
  const out: Case[] = [];
  for (const fn of program.functions) {
    if (fn.params[fn.params.length - 1] === 'io') {
      for (const input of [[], [5], [5, 6], [0xffff_ffff, 1]]) out.push(caseFor(fn, [], input));
    } else if (fn.params.length === 2)
      for (const a of EDGES) for (const b of EDGES) out.push(caseFor(fn, [a, b]));
    else for (const a of [...EDGES, 100]) out.push(caseFor(fn, [a]));
  }
  return out;
}

const programs = (): { name: string; program: TypedProgram }[] => [
  { name: 'canonical', program: parseAndValidate(opsSource('')) },
  { name: 'strict', program: parseAndValidate(opsSource(STRICT)) },
];

// ---------------------------------------------------------------------------
// The optimizer under the strict profile
// ---------------------------------------------------------------------------

test('optimizer: a dead get still traps under strict, and is removed under canonical', () => {
  const body = 'fn f u32 -> u32\na arr 1 2 3\nb get a p0\nret 7\nend\n';
  const strict = optimizeFunction(fnOf(parseAndValidate(STRICT + body), 'f')).fn;
  assert.equal(strict.profile, 'strict');
  assert.ok(
    strict.nodes.some((n) => n.op === 'get'),
    'the get is anchored',
  );
  assert.equal(interpOutcome(strict, [2]), 'value 7');
  assert.match(interpOutcome(strict, [3]), /^trap runtime: trap bounds fn=f /);
  const canonical = optimizeFunction(fnOf(parseAndValidate(body), 'f')).fn;
  assert.equal(canonical.nodes.length, 0);
  assert.equal(canonical.profile, undefined);
});

test('optimizer: strict never folds a zero divisor or an out-of-range index into a value', () => {
  const cases: [string, string][] = [
    ['fn f -> u32\na div 7 0\nret a\nend\n', 'divzero'],
    ['fn f -> u32\na rem 7 0\nret a\nend\n', 'divzero'],
    ['fn f -> u32\na arr 1 2 3\nb get a 5\nret b\nend\n', 'bounds'],
    ['fn f -> u32\na arr 1 2 3\nb set a 3 9\nc get b 0\nret c\nend\n', 'bounds'],
    ['fn g u32 -> u32\na div 1 p0\nret a\nend\nfn f -> u32\na call g 0\nret a\nend\n', 'divzero'],
  ];
  for (const [body, kind] of cases) {
    const strict = optimizeFunction(fnOf(parseAndValidate(STRICT + body), 'f')).fn;
    assert.match(interpOutcome(strict, []), new RegExp(`^trap runtime: trap ${kind} `), body);
    // Canonical optimization folds the same program to the wrapped value, as before.
    const canonical = optimizeFunction(fnOf(parseAndValidate(body), 'f')).fn;
    assert.match(interpOutcome(canonical, []), /^value /, body);
  }
  // A literal divisor and an in-range literal index still fold under strict.
  const folded = optimizeFunction(
    fnOf(
      parseAndValidate(
        `${STRICT}fn f -> u32\na div 7 2\nb arr 1 2 3\nc get b 2\nd add a c\nret d\nend\n`,
      ),
      'f',
    ),
  ).fn;
  assert.equal(folded.nodes.length, 0);
  assert.equal(interpOutcome(folded, []), 'value 6');
});

test('optimizer: strict keeps trapping nodes in order, and a first trap stays the first trap', () => {
  const src = `${STRICT}fn f u32 u32 -> u32
d div 1 p0
a arr 1 2
g get a p1
r add d g
ret r
end
`;
  const source = fnOf(parseAndValidate(src), 'f');
  const opt = optimizeFunction(source).fn;
  assert.deepEqual(
    opt.nodes.map((n) => n.op),
    source.nodes.map((n) => n.op),
  );
  for (const args of [
    [0, 5],
    [1, 5],
    [0, 0],
    [1, 1],
  ])
    assert.equal(interpOutcome(opt, args), interpOutcome(source, args));
  assert.match(interpOutcome(opt, [0, 5]), /trap divzero/);
});

test('optimizer: a site proved safe is an ordinary pure node again (and a canonical program is untouched)', () => {
  const safe = `${STRICT}fn f u32 -> u32
a arr 10 20 30 40
m and p0 3
b get a m
r rem p0 3
c arr 1 2 3
d get c r
q div p0 8
ret 5
end
`;
  const f = fnOf(parseAndValidate(safe), 'f');
  assert.equal(mayTrapFn(f), false);
  assert.equal(optimizeFunction(f).fn.nodes.length, 0, 'every dead node was safe to drop');
  const unsafe = fnOf(
    parseAndValidate(`${STRICT}fn f u32 -> u32\na arr 1 2 3\nb get a p0\nret 5\nend\n`),
    'f',
  );
  assert.equal(mayTrapFn(unsafe), true);
  assert.equal(
    mayTrapFn(
      fnOf(parseAndValidate('fn f u32 -> u32\na arr 1 2 3\nb get a p0\nret 5\nend\n'), 'f'),
    ),
    false,
  );
});

test('optimizer: a callee that can trap is not inlined or unrolled, so the trap line keeps its chain', () => {
  const src = `${STRICT}fn step u32 u32 -> u32
a arr 1 2 3
b get a p1
c add p0 b
ret c
end
fn top -> u32
r fold step 5 0
ret r
end
fn once u32 -> u32
a call step p0 1
ret a
end
`;
  const p = parseAndValidate(src);
  const opt = optimize(p).program;
  assert.equal(opt.profile, 'strict');
  for (const name of ['top', 'once'] as const) {
    assert.equal(
      interpOutcome(fnOf(opt, name), name === 'top' ? [] : [4]),
      interpOutcome(fnOf(p, name), name === 'top' ? [] : [4]),
    );
  }
  assert.match(interpOutcome(fnOf(opt, 'top'), []), /fn=step at=top\.r trip=3 chain=top>step /);
  // A callee that cannot trap still inlines.
  const safe = parseAndValidate(
    `${STRICT}fn k u32 -> u32\na add p0 1\nret a\nend\nfn f u32 -> u32\na call k p0\nret a\nend\n`,
  );
  assert.equal(
    fnOf(optimize(safe).program, 'f').nodes.some((n) => n.op === 'call'),
    false,
  );
});

test('optimizer: the optimized strict corpus equals the interpreter, value or trap, on every case', () => {
  const corpus = generateCorpus();
  const strict = validate({ profile: 'strict', functions: corpus.functions });
  const opt = optimize(strict).program;
  let traps = 0;
  let total = 0;
  for (const c of generateCases(strict)) {
    const f = fnOf(strict, c.functionName);
    const g = fnOf(opt, c.functionName);
    assert.equal(g.profile, 'strict');
    const run1 = (fn: TypedFunc): string => {
      if (c.input === undefined) return interpOutcome(fn, [...c.args]);
      const io = makeIo(c.input);
      const r = interpOutcome(fn, [...c.args, io]);
      return `${r} out=${io.output.join(',')}`;
    };
    // An aborted run leaves a partly written stream, which nobody observes; compare traps alone.
    const a = run1(f);
    const b = run1(g);
    total += 1;
    if (a.startsWith('trap')) {
      traps += 1;
      assert.equal(
        b.split(' out=')[0],
        a.split(' out=')[0],
        `${c.functionName}(${c.args.join(',')})`,
      );
    } else assert.equal(b, a, `${c.functionName}(${c.args.join(',')})`);
  }
  assert.ok(traps > 0 && traps < total, `${traps} of ${total} cases trap`);
});

test('the checkers see through strict: interpreter and optimizer agree with the oracle where nothing traps', () => {
  const [, strict] = programs();
  const cases = opsCases((strict as { program: TypedProgram }).program);
  const program = (strict as { program: TypedProgram }).program;
  assert.equal(checkInterpreter(program, cases).status, 'passed');
  const canonical = parseAndValidate(opsSource(''));
  for (const c of cases) {
    if (c.expectedTrap !== undefined || c.input !== undefined) continue;
    const want = oracleToValue(oracleRun(fnOf(canonical, c.functionName), c.args));
    assert.deepEqual(norm(c.expected), norm(want), `${c.functionName}(${c.args.join(',')})`);
  }
});

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

async function jsModule(
  program: TypedProgram,
  optimizeIt: boolean,
): Promise<
  Record<string, (...a: unknown[]) => unknown> & { a0_make_io: (i: number[]) => unknown }
> {
  const text = compile(program, 'js', { optimize: optimizeIt }).text;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
  )) as never;
}

test('js: every op at the boundaries equals the interpreter in both profiles (optimized and not)', async () => {
  for (const { name, program } of programs())
    for (const optimizeIt of [true, false]) {
      const mod = await jsModule(program, optimizeIt);
      let traps = 0;
      for (const c of opsCases(program)) {
        const f = mod[c.functionName] as (...a: unknown[]) => unknown;
        let got: string;
        try {
          if (c.input === undefined) got = `value ${show(norm(f(...c.args) as Value))}`;
          else {
            const io = mod.a0_make_io([...c.input]);
            got = `value ${show(norm(f(...c.args, io) as Value))}`;
          }
        } catch (e) {
          const t = (e as { trap?: Trap }).trap;
          if (t === undefined) throw e;
          got = `trap ${formatTrap(t)}`;
        }
        const want =
          c.expectedTrap !== undefined
            ? `trap ${c.expectedTrap}`
            : `value ${show(norm(c.expected))}`;
        assert.equal(
          got,
          want,
          `${name} opt=${optimizeIt} ${c.functionName}(${c.args.join(',')}) ${c.input ?? ''}`,
        );
        if (got.startsWith('trap')) traps += 1;
      }
      assert.equal(traps > 0, name === 'strict', `${name}: ${traps} traps`);
    }
});

test('js: a trap is an A0Error-shaped error with the interpreter record (fn, at, trip, chain), and the stack resets', async () => {
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
fn outer u32 -> u32
a call top p0
b add a 1
ret b
end
`;
  const p = parseAndValidate(src);
  const mod = await jsModule(p, true);
  let seen: { id: string; code: string; name: string; message: string; trap: Trap } | undefined;
  try {
    (mod.outer as (n: number) => number)(5);
  } catch (e) {
    seen = e as never;
  }
  const want = (() => {
    try {
      run(fnOf(p, 'outer'), [5]);
    } catch (e) {
      return e as A0Error;
    }
    throw new Error('the interpreter did not trap');
  })();
  assert.ok(seen !== undefined);
  assert.equal(seen.id, 'A0710');
  assert.equal(seen.code, 'runtime');
  assert.equal(seen.name, 'A0Error');
  assert.equal(seen.message, want.message);
  assert.deepEqual(JSON.parse(JSON.stringify(seen.trap)), JSON.parse(JSON.stringify(want.trap)));
  assert.equal(formatTrap(seen.trap), formatDiagnostic(want));
  assert.deepEqual(seen.trap.chain, ['outer', 'top', 'step']);
  // After a trap the next call starts a fresh chain.
  assert.equal((mod.outer as (n: number) => number)(3), 7);
  try {
    (mod.top as (n: number) => number)(4);
    assert.fail('top(4) must trap');
  } catch (e) {
    assert.deepEqual((e as { trap: Trap }).trap.chain, ['top', 'step']);
  }
});

test('js: the checked ops and a strict program add runtime only when they are used; canonical output is unchanged', () => {
  const plain = compile(parseAndValidate('fn f u32 -> u32\na add p0 1\nret a\nend\n'), 'js').text;
  assert.ok(!plain.includes('a0_strap') && !plain.includes('a0_cadd'));
  const checked = compile(
    parseAndValidate('fn f u32 u32 -> (u32,bool)\na cadd p0 p1\nret a\nend\n'),
    'js',
  ).text;
  assert.ok(checked.includes('function a0_cadd') && !checked.includes('a0_strap'));
  const strict = compile(
    parseAndValidate(`${STRICT}fn f u32 -> u32\na arr 1 2 3\nb get a p0\nret b\nend\n`),
    'js',
  ).text;
  assert.ok(strict.includes('a0_strap'));
  // A strict program in which nothing can trap carries no trap runtime.
  const safe = compile(
    parseAndValidate(`${STRICT}fn f u32 -> u32\na add p0 1\nret a\nend\n`),
    'js',
  ).text;
  assert.ok(!safe.includes('a0_strap'));
});

// ---------------------------------------------------------------------------
// C (clang, gcc, C++, parallel)
// ---------------------------------------------------------------------------

const tools = (): { name: string; tool: ToolInfo; cpp: boolean }[] => [
  { name: 'clang', tool: findClang(), cpp: false },
  { name: 'gcc', tool: findGcc(), cpp: false },
  { name: 'clang++', tool: findClangPlusPlus(), cpp: true },
];

test('c: every op at the boundaries equals the interpreter in both profiles, on clang, gcc and C++ (optimized and not)', async () => {
  for (const { name, program } of programs()) {
    const cases = opsCases(program);
    for (const optimizeIt of [true, false]) {
      const source = compile(program, 'c', { optimize: optimizeIt, ...ioCaps(cases) }).text;
      for (const t of tools()) {
        const r = await checkNative(program, cases, t.tool, t.cpp, `${name} ${t.name}`, source);
        if (r.status === 'blocked') continue;
        assert.equal(
          r.status,
          'passed',
          `${name} opt=${optimizeIt} ${t.name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`,
        );
        assert.equal(r.cases, cases.length);
      }
    }
  }
});

test('c: automatic parallel folds stay sequential where the body can trap, and every op still agrees', async () => {
  const [, strict] = programs();
  const program = (strict as { program: TypedProgram }).program;
  const cases = opsCases(program);
  const parallel = parallelC({ mode: 'auto', force: true }) as never;
  const source = compile(program, 'c', { cParallel: parallel, ...ioCaps(cases) }).text;
  const clang = findClang();
  if (clang.path !== undefined) {
    const r = await checkNative(program, cases, clang, false, 'strict parallel', source);
    assert.equal(r.status, 'passed', r.failures?.slice(0, 3).join(' | '));
  }
  const top = parseAndValidate(
    `${STRICT}fn step u32 u32 -> u32\na arr 1 2 3\nb get a p1\nc add p0 b\nret c\nend\nfn top u32 -> u32\nr fold step p0 0\nret r\nend\n`,
  );
  const text = compile(top, 'c', { cParallel: parallel }).text;
  assert.ok(text.includes('a0_mark("r")'), 'the fold keeps its marked, sequential loop');
});

test('c: the real runtime prints the interpreter trap line and exits 3 (clang and gcc)', () => {
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
fn outer u32 -> u32
a call top p0
b add a 1
ret b
end
fn q u32 u32 -> u32
r div p0 p1
ret r
end
`;
  const p = parseAndValidate(src);
  const module = compile(p, 'c').text;
  const dir = mkdtempSync(join(tmpdir(), 'a0-strict-'));
  try {
    writeFileSync(join(dir, 'm.c'), module);
    writeFileSync(
      join(dir, 'main.c'),
      '#include <stdio.h>\n#include <stdlib.h>\n#include "m.c"\nint main(int argc, char **argv) { (void)argc; unsigned a = (unsigned)atoi(argv[2]), b = (unsigned)atoi(argv[3]); printf("%u\\n", argv[1][0] == \'o\' ? a0_outer(a) : a0_q(a, b)); return 0; }\n',
    );
    for (const t of tools().filter((x) => !x.cpp)) {
      if (t.tool.path === undefined) continue;
      const exe = join(dir, `main-${t.name}`);
      const build = spawnSync(
        t.tool.path,
        ['-std=c11', '-O1', '-Wall', '-Wextra', '-Werror', '-o', exe, join(dir, 'main.c')],
        { encoding: 'utf8' },
      );
      assert.equal(build.status, 0, `${t.name}: ${build.stderr}`);
      const ok = spawnSync(exe, ['o', '3', '0'], { encoding: 'utf8' });
      assert.equal(ok.status, 0);
      assert.equal(ok.stdout, '7\n');
      for (const [which, a, b, fn, args] of [
        ['o', '5', '0', 'outer', [5]],
        ['q', '7', '0', 'q', [7, 0]],
      ] as const) {
        const got = spawnSync(exe, [which, a, b], { encoding: 'utf8' });
        let want = '';
        try {
          run(fnOf(p, fn), [...args]);
        } catch (e) {
          want = formatDiagnostic(e);
        }
        assert.equal(got.status, 3, `${t.name} ${fn}`);
        assert.equal(got.stdout, '', 'nothing is printed to stdout after the trap');
        assert.equal(got.stderr, `${want}\n`, `${t.name} ${fn}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

test('java: every op at the boundaries equals the interpreter in both profiles (optimized and not)', async () => {
  for (const { name, program } of programs()) {
    const cases = opsCases(program);
    for (const optimizeIt of [true, false]) {
      const r = await checkJvm(program, cases, { optimize: optimizeIt });
      if (r.status === 'blocked') continue;
      assert.equal(
        r.status,
        'passed',
        `${name} opt=${optimizeIt}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`,
      );
      assert.equal(r.cases, cases.length);
    }
  }
});

// ---------------------------------------------------------------------------
// .NET
// ---------------------------------------------------------------------------

test('dotnet: every op at the boundaries equals the interpreter in both profiles (optimized and not)', async () => {
  for (const { name, program } of programs()) {
    const cases = opsCases(program);
    for (const optimizeIt of [true, false]) {
      const r = await checkDotnet(program, cases, { optimize: optimizeIt });
      if (r.status === 'blocked') continue;
      assert.equal(
        r.status,
        'passed',
        `${name} opt=${optimizeIt}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`,
      );
      assert.equal(r.cases, cases.length);
    }
  }
});

// ---------------------------------------------------------------------------
// WebAssembly through C (clang, wasm-ld)
// ---------------------------------------------------------------------------

test('wasm-c: every op at the boundaries equals the interpreter in both profiles; a trap is unreachable plus a decoded record', async () => {
  for (const { name, program } of programs()) {
    const cases = opsCases(program);
    const r = await checkWasm(program, cases);
    if (r.status === 'blocked') continue;
    assert.equal(r.status, 'passed', `${name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`);
    assert.equal(r.cases, cases.length);
  }
});

// ---------------------------------------------------------------------------
// WebAssembly from the direct backend
// ---------------------------------------------------------------------------

test('wasm-direct: every op at the boundaries equals the interpreter in both profiles (optimized and not)', async () => {
  for (const { name, program } of programs()) {
    const cases = opsCases(program);
    const r = await checkWasmDirect(program, cases);
    assert.equal(r.status, 'passed', `${name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`);
    assert.equal(r.cases, cases.length);
  }
});

// ---------------------------------------------------------------------------
// The trap line of the managed and wasm targets: fn, at, trip and chain as the interpreter has them
// ---------------------------------------------------------------------------

const CHAIN_SRC = `${STRICT}fn step u32 u32 -> u32
a arr 1 2 3
b get a p1
c add p0 b
ret c
end
fn top u32 -> u32
r fold step p0 0
ret r
end
fn outer u32 -> u32
a call top p0
b add a 1
ret b
end
fn q u32 u32 -> u32
r div p0 p1
ret r
end
fn fill u32x4 u32 -> u32x4
a mul p1 p1
b set p0 p1 a
ret b
end
fn run u32 -> u32
z arr 0 0 0 0
f fold fill p0 z
r get f 3
ret r
end
fn guard u32 -> u32
a arr 1 2 3
c cget a p0
b get a p0
v at c 0
r add v b
ret r
end
fn rd io -> u32
a read p0
v at a 0
ret v
end
fn rd2 io -> u32
a read p0
v at a 0
t at a 1
b read t
w at b 0
s add v w
ret s
end
`;

function chainCases(program: TypedProgram): Case[] {
  const out: Case[] = [];
  const add = (name: string, args: Value[], input?: number[]): void => {
    out.push(caseFor(fnOf(program, name), args, input));
  };
  for (const n of [0, 1, 3, 4, 5]) add('outer', [n]);
  for (const n of [0, 3, 4]) add('top', [n]);
  for (const [a, b] of [
    [7, 0],
    [7, 2],
  ] as const)
    add('q', [a, b]);
  for (const n of [0, 4, 5]) add('run', [n]);
  for (const n of [0, 2, 3, 9]) add('guard', [n]);
  for (const input of [[], [5], [5, 6]]) {
    add('rd', [], input);
    add('rd2', [], input);
  }
  return out;
}

test('managed and wasm targets: the trap line names fn, at, trip and chain exactly as the interpreter does, and a trap in a set stops before the write', async () => {
  const program = parseAndValidate(CHAIN_SRC);
  const cases = chainCases(program);
  const traps = cases.filter((c) => c.expectedTrap !== undefined);
  assert.ok(traps.length >= 8, `${traps.length} trapping cases`);
  assert.ok(traps.some((c) => c.expectedTrap?.includes('chain=outer>top>step')));
  assert.ok(traps.some((c) => c.expectedTrap?.includes('at=run.f trip=4 chain=run>fill')));
  const reports = [
    ['java', await checkJvm(program, cases)],
    ['dotnet', await checkDotnet(program, cases)],
    ['wasm-c', await checkWasm(program, cases)],
    ['wasm-direct', await checkWasmDirect(program, cases)],
  ] as const;
  for (const [name, r] of reports) {
    if (r.status === 'blocked') continue;
    assert.equal(r.status, 'passed', `${name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`);
    assert.equal(r.cases, cases.length, name);
  }
});

test('managed and wasm targets: the runtime exists only where a program can trap, and canonical output carries none', () => {
  const canonical = parseAndValidate(CHAIN_SRC.slice(STRICT.length));
  const strict = parseAndValidate(CHAIN_SRC);
  const safe = parseAndValidate(`${STRICT}fn f u32 -> u32\na add p0 1\nret a\nend\n`);
  for (const target of ['java', 'dotnet'] as const) {
    const text = (p: TypedProgram): string =>
      target === 'java' ? compile(p, 'java').text : emitCSharp(p);
    assert.ok(!text(canonical).includes('a0_strap'), target);
    assert.ok(!text(safe).includes('a0_strap'), target);
    assert.ok(text(strict).includes('A0Trap'), target);
    // A store checks its index first: the check is the index of the update.
    if (target === 'java')
      assert.match(text(parseAndValidate(CHAIN_SRC)), /set_[a-z0-9_]+\(p0, a0_ck\(/);
  }
  const exportsOf = (p: TypedProgram): string[] =>
    WebAssembly.Module.exports(
      new WebAssembly.Module(wasmModuleBytes(compile(p, 'wasm').text) as BufferSource),
    ).map((e) => e.name);
  const withRecord = [
    'a0_trap_kind',
    'a0_trap_n',
    'a0_trap_at',
    'a0_trap_trip',
    'a0_chain',
    'a0_node',
  ];
  for (const name of withRecord) {
    assert.ok(exportsOf(strict).includes(name), name);
    assert.ok(!exportsOf(canonical).includes(name), name);
    assert.ok(!exportsOf(safe).includes(name), name);
  }
});

// ---------------------------------------------------------------------------
// Mutation safety, targets, size
// ---------------------------------------------------------------------------

test('a set/put checks its index before it writes, in the in-place forms of JS and C', () => {
  const src = `${STRICT}fn fill u32x4 u32 -> u32x4
a mul p1 p1
b set p0 p1 a
ret b
end
fn run u32 -> u32x4
z arr 0 0 0 0
f fold fill p0 z
ret f
end
`;
  const p = parseAndValidate(src);
  const c = compile(p, 'c').text;
  const stores = c
    .split('\n')
    .filter((l) => /\.e\[[^\]]*\]\s*=[^=]/.test(l) && l.includes('a0_ck'));
  assert.ok(stores.length > 0, 'an in-place store exists');
  for (const l of c
    .split('\n')
    .filter((x) => /\.e\[[^\]]*\]\s*=[^=]/.test(x) && !x.includes('static inline')))
    assert.ok(l.includes('a0_ck('), `unchecked store: ${l}`);
  const js = compile(p, 'js').text;
  const jsStores = js
    .split('\n')
    .filter((l) => /\]\s*=\s*[^=]/.test(l) && l.includes('(') && l.includes(', p0)'));
  for (const l of jsStores) assert.ok(l.includes('a0_strap(0)'), `unchecked store: ${l}`);
  // Behaviourally: count 5 on a 4-element state traps at trip 4, in both.
  assert.match(
    interpOutcome(fnOf(p, 'run'), [5]),
    /trap bounds fn=fill at=run\.f trip=4 chain=run>fill /,
  );
});

test('targets: js, c, java, dotnet and wasm implement strict and the checked ops; every other target still refuses with A0713', () => {
  assert.deepEqual([...STRICT_TARGETS].sort(), ['c', 'dotnet', 'java', 'js', 'wasm']);
  const strict = parseAndValidate(`${STRICT}fn f u32 -> u32\na add p0 1\nret a\nend\n`);
  const checked = parseAndValidate('fn t u32 u32 -> (u32,bool)\na cadd p0 p1\nret a\nend\n');
  for (const target of TARGETS) {
    if (STRICT_TARGETS.has(target)) {
      assert.ok(compile(strict, target).text.length > 0);
      assert.ok(compile(checked, target, { optimize: false }).text.length > 0);
      continue;
    }
    for (const prog of [strict, checked]) {
      try {
        compile(prog, target, { optimize: false });
        assert.fail(`${target} must refuse`);
      } catch (e) {
        assert.ok(e instanceof A0Error && e.id === 'A0713', `${target}: ${String(e)}`);
      }
    }
  }
});

test('size: strict output next to canonical output on the same kernel (reported, not asserted)', () => {
  const body = `fn step u32 u32 -> u32
a arr 1 2 3 4
m and p1 3
b get a m
c add p0 b
ret c
end
fn top u32 -> u32
r fold step p0 0
ret r
end
fn tri u32 u32 -> u32
a arr 1 2 3
b get a p1
c div p0 p1
d add b c
ret d
end
`;
  const sizes: Record<string, number> = {};
  for (const [name, head] of [
    ['canonical', ''],
    ['strict', STRICT],
  ] as const)
    for (const target of ['js', 'c', 'java'] as const)
      sizes[`${name} ${target}`] = compile(parseAndValidate(head + body), target).text.length;
  for (const [name, head] of [
    ['canonical', ''],
    ['strict', STRICT],
  ] as const) {
    const p = parseAndValidate(head + body);
    sizes[`${name} dotnet`] = emitCSharp(p).length;
    sizes[`${name} wasm`] = wasmModuleBytes(compile(p, 'wasm').text).length;
  }
  assert.ok((sizes['strict c'] as number) > (sizes['canonical c'] as number));
  assert.ok((sizes['strict js'] as number) > (sizes['canonical js'] as number));
  assert.ok((sizes['strict wasm'] as number) > (sizes['canonical wasm'] as number));
  process.stdout.write(`# size (bytes): ${JSON.stringify(sizes)}\n`);
});
