import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
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
import { DIAGNOSTICS, formatTrap, type Trap } from '../src/diagnostics.js';
import { emitCSharp } from '../src/dotnet.js';
import { emitMetal } from '../src/metal.js';
import { mayTrapFn, optimize, optimizeFunction } from '../src/optimize.js';
import { parallelC } from '../src/parallel.js';
import {
  findArmGcc,
  findAvrGcc,
  findClang,
  findClangPlusPlus,
  findGcc,
  findQemuRiscv64,
  findQemuSystemArm,
  findRiscv64Gcc,
  type ToolInfo,
} from '../src/toolchain.js';
import { nativeTrapHostC } from '../src/trap-host.js';
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
  checkArm32,
  checkArm64,
  checkAvr,
  checkInterpreter,
  checkJvm,
  checkNative,
  checkRiscv64,
  checkWasm,
  checkWasmDirect,
  checkX86_64,
  ioCaps,
  runArm32,
  runRiscv64,
  x86Host,
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
// The direct native backends: riscv64 (qemu-system-riscv64), arm32 (qemu-system-arm), avr (simavr)
// ---------------------------------------------------------------------------

test("riscv64: every op at the boundaries equals the interpreter in both profiles, and every trap line is the interpreter's (optimized and not)", async () => {
  const sources = [...programs(), { name: 'chain', program: parseAndValidate(CHAIN_SRC) }];
  for (const { name, program } of sources) {
    const cases = name === 'chain' ? chainCases(program) : opsCases(program);
    const r = await checkRiscv64(program, cases, findRiscv64Gcc(), findQemuRiscv64());
    if (r.status === 'blocked') continue;
    assert.equal(r.status, 'passed', `${name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`);
    assert.ok(r.cases > 0);
  }
});

test("avr: every op at the boundaries equals the interpreter in both profiles, and every trap record decodes to the interpreter's line (optimized and not)", async () => {
  const sources = [...programs(), { name: 'chain', program: parseAndValidate(CHAIN_SRC) }];
  for (const { name, program } of sources) {
    const cases = name === 'chain' ? chainCases(program) : opsCases(program);
    const r = await checkAvr(program, cases, findAvrGcc(), findClang());
    if (r.status === 'blocked') continue;
    assert.equal(r.status, 'passed', `${name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`);
    assert.ok(r.cases > 0);
  }
});

test("arm32: every op at the boundaries equals the interpreter in both profiles, and every trap line is the interpreter's (optimized and not)", async () => {
  const sources = [...programs(), { name: 'chain', program: parseAndValidate(CHAIN_SRC) }];
  for (const { name, program } of sources) {
    const cases = name === 'chain' ? chainCases(program) : opsCases(program);
    const r = await checkArm32(program, cases, findArmGcc(), findQemuSystemArm());
    if (r.status === 'blocked') continue;
    assert.equal(r.status, 'passed', `${name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`);
    assert.ok(r.cases > 0);
  }
});

test('riscv64, arm32 and avr: the strict corpus equals the interpreter, value or trap line, on every case (optimized and not)', async () => {
  const strict = validate({ profile: 'strict', functions: generateCorpus().functions });
  const cases: Case[] = [];
  for (const c of generateCases(strict))
    if (c.input === undefined) cases.push(caseFor(fnOf(strict, c.functionName), [...c.args]));
  const traps = cases.filter((c) => c.expectedTrap !== undefined).length;
  assert.ok(traps > 100 && traps < cases.length, `${traps} of ${cases.length} cases trap`);
  const reports = [
    ['riscv64', await checkRiscv64(strict, cases, findRiscv64Gcc(), findQemuRiscv64())],
    ['arm32', await checkArm32(strict, cases, findArmGcc(), findQemuSystemArm())],
    ['avr', await checkAvr(strict, cases, findAvrGcc(), findClang())],
  ] as const;
  for (const [name, r] of reports) {
    if (r.status === 'blocked') continue;
    assert.equal(r.status, 'passed', `${name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`);
    assert.ok(r.cases > 1000, name);
  }
});

const HOST_SRC = `${STRICT}fn step u32 u32 -> u32
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

test("riscv64 and arm32: the reference host prints the interpreter's trap line and a trapped call never returns (A0_TRAP_EXIT is exit(3) by default)", async () => {
  const program = parseAndValidate(HOST_SRC);
  const want = interpOutcome(fnOf(program, 'top'), [5]);
  assert.match(want, /^trap runtime: trap bounds fn=step at=top\.r trip=3 chain=top>step /);
  const line = want.slice('trap '.length);
  const driver = `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
extern uint32_t a0_top(uint32_t);
#define A0_TRAP_EMIT(line) printf("%s\\n", (line))
${nativeTrapHostC()}
int main(void) { printf("%u\\n", (unsigned)a0_top(5)); return 0; }
`;
  const rv = findRiscv64Gcc();
  const qrv = findQemuRiscv64();
  if (rv.path !== undefined && qrv.path !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'a0-host-'));
    try {
      writeFileSync(join(dir, 'module.s'), compile(program, 'riscv64').text);
      writeFileSync(join(dir, 'driver.c'), driver);
      writeFileSync(join(dir, 'input.txt'), '');
      const run = await runRiscv64(rv.path, qrv.path, dir);
      assert.equal(run.stage, 'run', run.result.stderr);
      assert.equal(run.result.stdout.replace(/\r/g, '').trim(), line);
      assert.equal(run.result.status, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const arm = findArmGcc();
  const qarm = findQemuSystemArm();
  if (arm.path !== undefined && qarm.path !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'a0-host-'));
    try {
      writeFileSync(join(dir, 'module.s'), compile(program, 'arm32').text);
      writeFileSync(join(dir, 'driver.c'), driver);
      const run = await runArm32(arm.path, qarm.path, dir);
      assert.equal(run.stage, 'run', run.result.stderr);
      assert.equal(run.result.stdout.replace(/\r/g, '').trim(), line);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

test('targets: js, c, java, dotnet, wasm, arm64, x86_64, riscv64, arm32 and avr implement strict and the checked ops; every other target refuses what needs a trap or a record with A0713', () => {
  assert.deepEqual([...STRICT_TARGETS].sort(), [
    'arm32',
    'arm64',
    'avr',
    'c',
    'dotnet',
    'java',
    'js',
    'riscv64',
    'wasm',
    'x86_64',
  ]);
  const safe = parseAndValidate(`${STRICT}fn f u32 -> u32\na add p0 1\nret a\nend\n`);
  const trapping = parseAndValidate(
    `${STRICT}fn f u32 -> u32\na arr 1 2 3\nb get a p0\nret b\nend\n`,
  );
  const checked = parseAndValidate('fn t u32 u32 -> (u32,bool)\na cadd p0 p1\nret a\nend\n');
  const strictChecked = parseAndValidate(
    `${STRICT}fn t u32 u32 -> (u32,bool)\na cadd p0 p1\nret a\nend\n`,
  );
  for (const target of TARGETS) {
    if (STRICT_TARGETS.has(target)) {
      for (const p of [safe, trapping, strictChecked])
        assert.ok(compile(p, target, { optimize: false }).text.length > 0, target);
      assert.ok(compile(checked, target, { optimize: false }).text.length > 0, target);
      continue;
    }
    for (const prog of [trapping, checked, strictChecked]) {
      try {
        compile(prog, target, { optimize: false });
        assert.fail(`${target} must refuse`);
      } catch (e) {
        assert.ok(e instanceof A0Error && e.id === 'A0713', `${target}: ${String(e)}`);
      }
    }
  }
});

/** A strict program in which every site is proved safe: an index under an `and` mask or a literal, a divisor that is a nonzero literal or has a bit set. */
const PROVED = `fn step u32 u32 -> u32
a arr 1 2 3 4
m and p1 3
b get a m
d div p0 4
e rem p0 7
x or p1 1
y div p0 x
c add p0 b
f add c d
g add f e
h add g y
s set a m h
k get s 0
l add h k
ret l
end
fn top u32 -> u32
r fold step p0 0
ret r
end
`;

test('sv, arm64, x86_64 and metal: a strict program whose every site is proved safe compiles as the canonical program (the same text); one with a site that can trap is refused, naming the site', () => {
  const canonical = parseAndValidate(PROVED);
  const strict = parseAndValidate(`${STRICT}${PROVED}`);
  for (const f of strict.functions) assert.equal(mayTrapFn(f), false, f.name);
  for (const target of TARGETS) {
    if (STRICT_TARGETS.has(target)) continue;
    for (const optimizeIt of [true, false])
      assert.equal(
        compile(strict, target, { optimize: optimizeIt }).text,
        compile(canonical, target, { optimize: optimizeIt }).text,
        `${target} optimize=${optimizeIt}`,
      );
  }
  assert.equal(emitMetal(strict), emitMetal(canonical));
  // One unproved index, a divisor that may be zero, and a call of such a function: each is refused
  // with the site, on every target outside STRICT_TARGETS (Metal and SystemVerilog among them).
  const sites: [string, RegExp][] = [
    [
      'fn f u32 -> u32\na arr 1 2 3\nb get a p0\nret b\nend\n',
      /can trap \(f\.b: get index not proved below the length\)/,
    ],
    [
      'fn f u32 u32 -> u32\nq div p0 p1\nret q\nend\n',
      /can trap \(f\.q: div divisor not proved nonzero\)/,
    ],
    [
      'fn g u32 u32 -> u32\nq rem p0 p1\nret q\nend\nfn f u32 -> u32\nr call g p0 3\nret r\nend\n',
      /can trap \(g\.q: rem divisor not proved nonzero\)/,
    ],
  ];
  for (const [src, message] of sites) {
    const p = parseAndValidate(`${STRICT}${src}`);
    for (const target of TARGETS) {
      if (STRICT_TARGETS.has(target)) continue;
      assert.throws(() => compile(p, target), message, target);
    }
    assert.throws(() => emitMetal(p), message);
  }
  // The same sites under the canonical profile are fine: there they wrap.
  for (const [src] of sites) assert.ok(compile(parseAndValidate(src), 'sv').text.length > 0);
  // The message says what compiles: the diagnostic table and the one-line fix name the proof.
  assert.match(DIAGNOSTICS.A0713?.fix ?? '', /provably safe/);
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
    for (const target of ['js', 'c', 'java', 'arm64', 'x86_64'] as const)
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
  assert.ok((sizes['strict arm64'] as number) > (sizes['canonical arm64'] as number));
  assert.ok((sizes['strict x86_64'] as number) > (sizes['canonical x86_64'] as number));
  process.stdout.write(`# size (bytes): ${JSON.stringify(sizes)}\n`);
});

// ---------------------------------------------------------------------------
// The direct native backends: AArch64 (src/arm64.ts) and x86-64 (src/x86_64.ts)
// ---------------------------------------------------------------------------

/** Run `cases` on both direct backends (each in its optimized and unoptimized emission). */
async function nativeBackends(
  program: TypedProgram,
  cases: readonly Case[],
  label: string,
): Promise<void> {
  const clang = findClang();
  for (const [name, check] of [
    ['arm64', checkArm64],
    ['x86_64', checkX86_64],
  ] as const) {
    const r = await check(program, cases, clang);
    if (r.status === 'blocked') continue;
    assert.equal(
      r.status,
      'passed',
      `${label} ${name}: ${r.failures?.slice(0, 3).join(' | ')} ${r.detail}`,
    );
  }
}

test('native: every op at the boundaries equals the interpreter on arm64 and x86_64 in both profiles', async () => {
  for (const { name, program } of programs()) {
    const cases = opsCases(program);
    assert.equal(
      cases.some((c) => c.expectedTrap !== undefined),
      name === 'strict',
    );
    await nativeBackends(program, cases, name);
  }
});

test('native: the strict corpus equals the interpreter (value, or the exact trap line) on arm64 and x86_64', async () => {
  const strict = validate({ profile: 'strict', functions: generateCorpus().functions });
  const cases: Case[] = [];
  for (const c of generateCases(strict)) {
    if (c.input !== undefined) continue;
    cases.push(caseFor(fnOf(strict, c.functionName), [...c.args]));
  }
  const traps = cases.filter((c) => c.expectedTrap !== undefined).length;
  assert.ok(traps > 0 && traps < cases.length, `${traps} of ${cases.length} cases trap`);
  await nativeBackends(strict, cases, 'corpus');
});

const LOOPS = `${STRICT}fn tstep u32 u32 -> u32
a arr 1 2 3 4 5 6 7 8
b get a p1
c add p0 b
ret c
end
fn tfold u32 -> u32
r fold tstep p0 0
ret r
end
fn tsmall u32 -> u32
r fold tstep 8 p0
ret r
end
fn tover u32 -> u32
r fold tstep 16 p0
ret r
end
fn fill u32x8 u32 -> u32x8
a mul p1 p1
b set p0 p1 a
ret b
end
fn fillrun u32 -> u32
z arr 0 0 0 0 0 0 0 0
f fold fill p0 z
g get f 7
ret g
end
fn fillk u32x64 u32 u32 -> u32x64
a mul p1 p2
b set p0 p1 a
ret b
end
fn fillfix u32 -> u32x64
z arr 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
f fold fillk 64 z p0
ret f
end
fn below u32 u32 -> bool
c lt p0 100
ret c
end
fn lstep u32 u32 -> u32
a arr 3 5 7 11
b get a p1
c add p0 b
ret c
end
fn tloop u32 -> u32
r loop below lstep p0 0
ret r
end
fn pbad u32 u32 -> bool
a arr 1 2 3
b get a p1
d add p0 b
e lt d 1000
ret e
end
fn sstep u32 u32 -> u32
a add p0 3
ret a
end
fn tpred u32 -> u32
r loop pbad sstep p0 0
ret r
end
fn stepc u32 u32 -> u32
a arr 7 8 9
r cget a p1
v at r 0
k at r 1
s add p0 v
t select k s p0
ret t
end
fn csum u32 -> u32
r fold stepc p0 0
ret r
end
fn safe u32 -> u32
a arr 1 2 3 4
m and p0 3
b get a m
c add b 1
ret c
end
`;

test('native: folds, loops and a set whose bodies can trap give the interpreter result or its trap line at every trip count', async () => {
  const p = parseAndValidate(LOOPS);
  const cases: Case[] = [];
  for (const name of ['tfold', 'fillrun', 'tloop', 'tpred', 'csum', 'safe'])
    for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 100])
      cases.push(caseFor(fnOf(p, name), [n]));
  for (const name of ['tfold', 'fillrun', 'safe'])
    cases.push(caseFor(fnOf(p, name), [0xffff_ffff]));
  for (const name of ['tsmall', 'tover'])
    for (const n of [0, 5]) cases.push(caseFor(fnOf(p, name), [n]));
  const trapped = cases.filter((c) => c.expectedTrap !== undefined);
  assert.ok(trapped.length > 10);
  assert.ok(
    trapped.some((c) =>
      /fn=tstep at=tover\.r trip=8 chain=tover>tstep /.test(c.expectedTrap ?? ''),
    ),
  );
  assert.ok(
    trapped.some((c) =>
      /fn=fill at=fillrun\.f trip=8 chain=fillrun>fill /.test(c.expectedTrap ?? ''),
    ),
  );
  // A predicate that traps names the loop and its trip too.
  assert.ok(
    trapped.some((c) => /fn=pbad at=tpred\.r trip=3 chain=tpred>pbad /.test(c.expectedTrap ?? '')),
  );
  await nativeBackends(p, cases, 'loops');
});

test('native: a body that can trap is a real call under a marked frame; it is not inlined, unrolled or vectorized', () => {
  const p = parseAndValidate(LOOPS);
  for (const target of ['arm64', 'x86_64'] as const) {
    const text = compile(p, target, { x86Platform: 'darwin' }).text;
    const block = (name: string): string => {
      const sym = `_a0_${name}:`;
      const from = text.indexOf(sym);
      assert.ok(from >= 0, `${target} ${name}`);
      const end = text.indexOf('\n\n', from);
      return text.slice(from, end < 0 ? text.length : end);
    };
    const call = target === 'arm64' ? /bl _a0_tstep/ : /call _a0_tstep/;
    // tsmall (8 trips) would be unrolled and tfold inlined if the body could not trap.
    assert.match(block('tsmall'), call, target);
    assert.match(block('tfold'), call, target);
    // The fill is a loop over calls, never a vector loop (the body can trap on the index).
    assert.ok(!/\.4s|paddd|pshufd/.test(block('fillrun')), target);
    assert.ok(!/\.4s|paddd|pshufd/.test(block('fillfix')), target);
    // A callee that cannot trap still inlines.
    assert.ok(!/bl _a0_|call _a0_/.test(block('safe')), target);
  }
  // The positive control: the same fill under the canonical profile is vectorized on arm64.
  const canonical = compile(parseAndValidate(LOOPS.replace(STRICT, '')), 'arm64').text;
  assert.match(canonical.slice(canonical.indexOf('_a0_fillfix:')), /\.4s/);
});

test('native: a strict function that cannot trap emits exactly the canonical code', () => {
  const body = `fn f u32 -> u32
a arr 1 2 3 4
m and p0 3
b get a m
q div p0 8
r rem p0 3
c add b q
d add c r
ret d
end
`;
  const strict = parseAndValidate(STRICT + body);
  const canonical = parseAndValidate(body);
  assert.equal(mayTrapFn(fnOf(strict, 'f')), false);
  for (const target of ['arm64', 'x86_64'] as const)
    assert.equal(compile(strict, target).text, compile(canonical, target).text, target);
});

test('native: the trap stubs are shared per function, and a program that cannot trap carries no runtime', () => {
  const p = parseAndValidate(
    `${STRICT}fn g u32 u32 -> u32
a arr 1 2 3
b get a p0
c get a p1
d div b p1
e rem c p0
f add d e
ret f
end
`,
  );
  for (const target of ['arm64', 'x86_64'] as const) {
    const text = compile(p, target, { x86Platform: 'darwin' }).text;
    const trap = target === 'arm64' ? 'b _a0_trap' : 'jmp _a0_trap';
    // One bounds stub and one divzero stub for the four trapping sites.
    assert.equal(text.split(trap).length - 1, 2, `${target} stubs`);
    assert.ok(text.includes('_a0_trap:') && text.includes('_a0_ts'), target);
    const safe = compile(
      parseAndValidate(`${STRICT}fn s u32 -> u32\na add p0 1\nret a\nend\n`),
      target,
      { x86Platform: 'darwin' },
    ).text;
    assert.ok(!safe.includes('_a0_trap'), `${target}: nothing can trap`);
    const canonical = compile(
      parseAndValidate('fn s u32 -> u32\na div p0 p0\nret a\nend\n'),
      target,
      { x86Platform: 'darwin' },
    ).text;
    assert.ok(!canonical.includes('_a0_trap'), `${target}: canonical has no runtime`);
  }
});

const RUNTIME_SRC = `${STRICT}fn step u32 u32 -> u32
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
fn w u32 u32 -> u32
a arr 4 5 6
b set a p0 p1
c get b 2
ret c
end
`;

test('native: the real runtime prints the interpreter trap line and exits 3 (arm64 and x86_64)', () => {
  const clang = findClang();
  if (clang.path === undefined) return;
  const p = parseAndValidate(RUNTIME_SRC);
  const main =
    "#include <stdio.h>\n#include <stdlib.h>\n#include <stdint.h>\nextern uint32_t a0_outer(uint32_t), a0_q(uint32_t, uint32_t), a0_w(uint32_t, uint32_t);\nint main(int argc, char **argv) { (void)argc; unsigned a = (unsigned)atoi(argv[2]), b = (unsigned)atoi(argv[3]); printf(\"%u\\n\", argv[1][0] == 'o' ? a0_outer(a) : argv[1][0] == 'q' ? a0_q(a, b) : a0_w(a, b)); return 0; }\n";
  const dir = mkdtempSync(join(tmpdir(), 'a0-native-strict-'));
  try {
    writeFileSync(join(dir, 'main.c'), main);
    const hosts: { target: 'arm64' | 'x86_64'; arch: string[]; runner: string[] }[] = [];
    if (process.platform === 'darwin' && process.arch === 'arm64')
      hosts.push({ target: 'arm64', arch: [], runner: [] });
    const x86 = x86Host(clang.path);
    if (typeof x86 !== 'string')
      hosts.push({ target: 'x86_64', arch: x86.arch, runner: x86.runner });
    for (const h of hosts) {
      const asm = join(dir, `m-${h.target}.s`);
      writeFileSync(asm, compile(p, h.target).text);
      const exe = join(dir, `main-${h.target}`);
      const build: SpawnSyncReturns<string> = spawnSync(
        clang.path,
        [...h.arch, '-o', exe, join(dir, 'main.c'), asm],
        { encoding: 'utf8' },
      );
      assert.equal(build.status, 0, `${h.target}: ${build.stderr}`);
      const run1 = (...args: string[]): { status: number | null; stdout: string; stderr: string } =>
        spawnSync(
          h.runner[0] ?? exe,
          [...h.runner.slice(1), ...(h.runner.length > 0 ? [exe] : []), ...args],
          {
            encoding: 'utf8',
          },
        );
      const ok = run1('o', '3', '0');
      assert.equal(ok.status, 0);
      assert.equal(ok.stdout, '7\n');
      for (const [which, a, b, fn, args] of [
        ['o', '5', '0', 'outer', [5]],
        ['q', '7', '0', 'q', [7, 0]],
        ['w', '3', '9', 'w', [3, 9]],
        ['w', '4294967295', '9', 'w', [0xffff_ffff, 9]],
      ] as const) {
        const got = run1(which, a, b);
        let want = '';
        try {
          run(fnOf(p, fn), [...args]);
        } catch (e) {
          want = formatDiagnostic(e);
        }
        assert.ok(want.length > 0, fn);
        assert.equal(got.status, 3, `${h.target} ${fn}`);
        assert.equal(got.stdout, '', 'nothing is printed to stdout after the trap');
        assert.equal(got.stderr, `${want}\n`, `${h.target} ${fn}`);
      }
      // An in-range set still works.
      const inRange = run1('w', '1', '9');
      assert.equal(inRange.status, 0);
      assert.equal(inRange.stdout, '6\n');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native: the x86_64 Linux (ELF) output assembles with the strict runtime', () => {
  const clang = findClang();
  if (clang.path === undefined) return;
  const dir = mkdtempSync(join(tmpdir(), 'a0-native-elf-'));
  try {
    const asm = join(dir, 'm.s');
    writeFileSync(
      asm,
      compile(parseAndValidate(RUNTIME_SRC), 'x86_64', { x86Platform: 'linux' }).text,
    );
    const r = spawnSync(
      clang.path,
      ['--target=x86_64-unknown-linux-gnu', '-c', '-x', 'assembler', '-o', join(dir, 'm.o'), asm],
      { encoding: 'utf8' },
    );
    if (r.status !== 0 && /unknown target|no available targets|unsupported/i.test(r.stderr)) return;
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
