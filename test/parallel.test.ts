import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import {
  analyzeBody,
  chooseStrategy,
  elementFunction,
  gpuKernel,
  parallelC,
  planProgram,
} from '../src/parallel.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';

const body = (src: string) => {
  const p = parseAndValidate(src);
  const fn = p.functions[p.functions.length - 1];
  assert.ok(fn);
  return fn;
};

test('parallel: reductions are recognized only when the state is combined once by an associative, commutative op', () => {
  const plan = (text: string) => analyzeBody(body(text));
  for (const op of ['add', 'mul', 'and', 'or', 'xor'] as const) {
    const p = plan(`fn b u32 u32 u32 -> u32\na mul p1 p2\ns ${op} a p0\nret s\nend`);
    assert.equal(p?.kind === 'reduce' ? p.op : null, op);
  }
  const minmax: [string, string][] = [
    ['c lt p0 g\ns select c p0 g', 'min'],
    ['c lt p0 g\ns select c g p0', 'max'],
    ['c gt p0 g\ns select c g p0', 'min'],
    ['c le g p0\ns select c g p0', 'min'],
    ['c ge g p0\ns select c g p0', 'max'],
  ];
  for (const [lines, want] of minmax) {
    const p = plan(`fn b u32 u32 u32 -> u32\ng xor p1 p2\n${lines}\nret s\nend`);
    assert.equal(p?.kind === 'reduce' ? p.op : null, want, lines);
  }
  // Not reductions: subtraction, state used twice, state feeding g, non-commuting select.
  for (const text of [
    'fn b u32 u32 u32 -> u32\ns sub p0 p1\nret s\nend',
    'fn b u32 u32 u32 -> u32\na mul p0 p0\ns add a p1\nret s\nend',
    'fn b u32 u32 u32 -> u32\na xor p0 p1\ns add p0 a\nret s\nend',
    'fn b u32 u32 u32 -> u32\nc lt p0 p1\ns select c p1 p2\nret s\nend',
    'fn b u32 u32 u32 -> u32\nc lt p0 p2\ns select c p0 p1\nret s\nend',
  ])
    assert.equal(plan(text), null, text);
});

test('parallel: element-wise maps need set state index h(index) and a trip count within the array', () => {
  const map = 'fn f u32x8 u32 u32 -> u32x8\nh mul p1 p2\nv set p0 p1 h\nret v\nend';
  const fn = body(map);
  assert.equal(analyzeBody(fn)?.kind, 'map');
  assert.equal(analyzeBody(fn, { kind: 'u32', value: 9 }), null);
  assert.equal(
    analyzeBody(body('fn f u32x8 u32 u32 -> u32x8\na get p0 3\nv set p0 p1 a\nret v\nend')),
    null,
  );
  assert.equal(analyzeBody(body('fn f u32x8 u32 u32 -> u32x8\nv set p0 p2 p1\nret v\nend')), null);
});

test('parallel: the cost model keeps small folds serial and picks the GPU only in gpu mode', () => {
  const p = parseAndValidate(
    'fn b u32 u32 u32 -> u32\na mul p1 p2\ns add p0 a\nret s\nend\nfn k u32 -> u32\nr fold b 16777216 0 p0\nret r\nend\nfn t u32 -> u32\nr fold b 1000 0 p0\nret r\nend',
  );
  const plan = analyzeBody(p.byName.get('b') ?? assert.fail());
  assert.ok(plan);
  assert.equal(chooseStrategy(plan, 1000, 'auto'), 'serial');
  assert.equal(chooseStrategy(plan, 1 << 24, 'auto'), 'threads');
  assert.equal(chooseStrategy(plan, 1 << 24, 'gpu'), 'gpu');
  assert.equal(chooseStrategy(plan, 1 << 24, 'off'), 'serial');
  assert.deepEqual(
    planProgram(p, 'auto').map((r) => r.strategy),
    ['threads', 'serial'],
  );
  // Off emits exactly the sequential C; auto leaves the small fold's loop untouched.
  assert.equal(compile(p, 'c').text.includes('a0par_run'), false);
  const auto = compile(p, 'c', { cParallel: parallelC({ mode: 'auto' }) ?? assert.fail() }).text;
  assert.ok(auto.includes('a0p_k_r('));
  assert.equal(auto.includes('a0p_t_r('), false);
});

test('parallel: forced threads match the interpreter (all ops, variable counts, maps, nesting)', async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required');
  const src = `fn g u32 u32 -> u32
a mul p0 2654435761
b xor a p1
c shr b 13
d xor b c
ret d
end
fn radd u32 u32 u32 -> u32
h call g p1 p2
s add p0 h
ret s
end
fn rmul u32 u32 u32 -> u32
h call g p1 p2
o or h 1
s mul o p0
ret s
end
fn rand u32 u32 u32 -> u32
h call g p1 p2
o or h 65536
s and p0 o
ret s
end
fn rxor u32 u32 u32 -> u32
h call g p1 p2
s xor p0 h
ret s
end
fn rmin u32 u32 u32 -> u32
h call g p1 p2
c gt p0 h
s select c h p0
ret s
end
fn rmax u32 u32 u32 -> u32
h call g p1 p2
c lt h p0
s select c p0 h
ret s
end
fn fill u32x300 u32 u32 -> u32x300
h call g p1 p2
v set p0 p1 h
ret v
end
fn inner u32 u32 u32 -> u32
r fold radd 50 p0 p1
s add r p2
ret s
end
fn nest u32 u32 u32 -> u32
r fold inner 5 p0 p1
s xor p0 r
ret s
end
fn rsum u32 u32 u32x300 -> u32
a get p2 p1
s add p0 a
ret s
end
fn inner2 u32 u32 -> u32
r fold radd 20 p0 p1
ret r
end
fn rnest u32 u32 u32 -> u32
h call inner2 p1 p2
s add p0 h
ret s
end
fn rfirst u32 u32 u32x300 -> u32
a get p2 7
b add a p1
s xor p0 b
ret s
end
fn top u32 u32 -> u32
n and p1 4095
a fold radd n p0 p0
b fold rmul n 3 p0
c fold rand n 4294967295 p0
d fold rxor n p1 p0
e fold rmin n 4294967295 p0
f fold rmax n 0 p0
z arr ${Array.from({ length: 300 }, () => '0').join(' ')}
m and p1 511
x fold fill m z p0
q get x 299
w fold nest 37 a p0
s1 add a b
s2 add s1 c
s3 add s2 d
s4 add s3 e
s5 add s4 f
s6 add s5 q
s7 add s6 w
w2 fold rnest n 0 p0
s8 add s7 w2
v fold rsum m 0 x
s9 add s8 v
y fold rfirst m 0 x
s10 xor s9 y
ret s10
end
`;
  const p = parseAndValidate(src);
  const top = p.byName.get('top') ?? assert.fail();
  const inputs: [number, number][] = [
    [0, 0],
    [1, 4095],
    [0x9e3779b9, 1000],
    [0xffffffff, 299],
    [7, 300],
    [12345, 511],
  ];
  const want = inputs.map(([a, b]) => String(run(top, [a, b], { fuel: 1e9 })));
  // The driver calls top on every input 8 times, so the pool serves many regions per process
  // (and must join at exit: a hang fails runTool's timeout).
  const driver = `#include <stdint.h>\n#include <stdio.h>\nuint32_t a0_top(uint32_t, uint32_t);\nint main(void) { const uint32_t v[][2] = { ${inputs.map(([a, b]) => `{ ${a}u, ${b}u }`).join(', ')} }; for (unsigned i = 0; i < ${inputs.length}u; i++) { uint32_t r = a0_top(v[i][0], v[i][1]); for (unsigned k = 0; k < 7u; k++) if (a0_top(v[i][0], v[i][1]) != r) return 3; printf("%u\\n", r); } return 0; }\n`;
  const legs: { mode: 'auto' | 'gpu'; objc: boolean }[] = [{ mode: 'auto', objc: false }];
  if (process.platform === 'darwin') legs.push({ mode: 'gpu', objc: true });
  for (const { mode, objc } of legs) {
    const cParallel = parallelC({ mode, force: true }) ?? assert.fail();
    const text = compile(p, 'c', { cParallel }).text;
    assert.ok(text.includes('a0p_top_x('), 'map fold parallelized');
    if (mode === 'gpu') {
      // Map and array-input reduction have GPU kernels; a read at another index does not.
      assert.ok(text.includes('a0gpu_run') && text.includes('kernel void a0gk'));
      const helper = (name: string): string => {
        const start = text.indexOf(`static uint32_t a0p_${name}(`);
        return text.slice(start, text.indexOf('\n}\n', start));
      };
      assert.ok(helper('top_v').includes('a0gpu_run'), 'array-input reduction on the GPU');
      assert.equal(helper('top_y').includes('a0gpu_run'), false, 'read at index 7: threads');
    }
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'm.c'), text, 'utf8');
      await writeFile(join(dir, 'd.c'), driver, 'utf8');
      const b = objc
        ? runTool(clang, ['-x', 'objective-c', '-fobjc-arc', '-O2', '-c', '-o', 'm.o', 'm.c'], {
            cwd: dir,
          })
        : runTool(clang, ['-std=c11', '-O2', '-c', '-o', 'm.o', 'm.c'], { cwd: dir });
      assert.ok(b.ok, b.stderr);
      const l = runTool(
        clang,
        [
          '-O2',
          '-o',
          'x',
          'd.c',
          'm.o',
          ...(objc ? ['-framework', 'Metal', '-framework', 'Foundation'] : []),
        ],
        { cwd: dir },
      );
      assert.ok(l.ok, l.stderr);
      for (const threads of ['1', '3', '8']) {
        const r = runTool(join(dir, 'x'), [], {
          env: { ...process.env, A0_THREADS: threads, A0_GPU_LOG: '1' },
          timeoutMs: 120_000,
        });
        assert.ok(r.ok, r.stderr);
        assert.deepEqual(r.stdout.trim().split('\n'), want, `${mode} A0_THREADS=${threads}`);
        if (objc) {
          assert.ok(r.stderr.includes('a0gpu ran'), 'GPU dispatches ran');
          assert.equal(r.stderr.includes('a0gpu fallback'), false, r.stderr.slice(0, 400));
        }
      }
    });
  }
});

test('parallel: GPU element functions exist only for element-wise shapes', () => {
  const plan = (text: string) => {
    const p = analyzeBody(body(text));
    assert.ok(p);
    return p;
  };
  const map = plan('fn f u32x8 u32 u32 -> u32x8\nh mul p1 p2\nv set p0 p1 h\nret v\nend');
  const e = elementFunction(map);
  assert.deepEqual(e?.params, ['u32', 'u32', 'u32']);
  assert.equal(e?.result, 'u32');
  assert.ok(gpuKernel(map)?.includes('kernel void a0gk'));
  const dot = plan(
    'fn d u32 u32 u32x8 u32x8 -> u32\na get p2 p1\nb get p3 p1\nm mul a b\ns add p0 m\nret s\nend',
  );
  assert.deepEqual(elementFunction(dot)?.params, ['u32', 'u32', 'u32', 'u32']);
  // Reads at another index, or a map over bool elements, have no GPU form.
  assert.equal(
    elementFunction(plan('fn d u32 u32 u32x8 -> u32\na get p2 3\ns add p0 a\nret s\nend')),
    null,
  );
  assert.equal(
    elementFunction(plan('fn f boolx8 u32 bool -> boolx8\nv set p0 p1 p2\nret v\nend')),
    null,
  );
  // Cost model: a heavy map goes to the GPU in gpu mode, a light one stays on threads.
  const heavy = parseAndValidate(
    `fn g u32 u32 -> u32\na mul p0 2654435761\nb xor a p1\nret b\nend\nfn m u32 u32 u32 -> u32\nh call g p0 p2\nret h\nend\nfn f u32x65536 u32 u32 -> u32x65536\nr fold m 256 p1 p2\nv set p0 p1 r\nret v\nend`,
  );
  const hp = analyzeBody(heavy.byName.get('f') ?? assert.fail()) ?? assert.fail();
  assert.equal(chooseStrategy(hp, 65536, 'gpu'), 'gpu');
  assert.equal(chooseStrategy(hp, 65536, 'auto'), 'threads');
  assert.equal(chooseStrategy(map, 8, 'gpu'), 'serial');
});
