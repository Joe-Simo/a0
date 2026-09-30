import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readBytes, safeHref } from '../site/wire.js';
import { compile } from '../src/backends.js';
import { A0Error, parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { link } from '../src/link.js';
import { parallelC } from '../src/parallel.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { wasmModuleBytes } from '../src/wasm.js';
import { fillShell, renderWords, SITE_CSP } from '../tools/site-render.js';
import { cDriver } from '../tools/verify.js';

const fuelError = (e: unknown): boolean =>
  e instanceof A0Error && e.code === 'limit' && /fuel exhausted/.test(e.message);

test('fuel: a zero-node fold body is charged per iteration and per call', () => {
  const p = parseAndValidate(
    'fn b u32 u32 -> u32\nret p0\nend\nfn f u32 -> u32\nr fold b p0 0\nret r\nend',
  );
  const f = p.byName.get('f') as TypedFunc;
  const start = performance.now();
  assert.throws(() => run(f, [30_000_000], { fuel: 1000 }), fuelError);
  assert.ok(performance.now() - start < 1000, 'fuel exhaustion is immediate');
  const l = parseAndValidate(
    'fn b u32 u32 -> u32\nret p0\nend\nfn t u32 u32 -> bool\nret true\nend\nfn f u32 -> u32\nr loop t b p0 0\nret r\nend',
  );
  assert.throws(() => run(l.byName.get('f') as TypedFunc, [30_000_000], { fuel: 1000 }), fuelError);
  assert.equal(run(f, [10], { fuel: 1000 }), 0);
});

test('fuel: aggregate updates cost their length', () => {
  const zeros = Array.from({ length: 65536 }, () => '0').join(' ');
  const p = parseAndValidate(
    `fn s u32x65536 u32 -> u32x65536\nv set p0 p1 p1\nret v\nend\nfn f u32 -> u32\nz arr ${zeros}\nr fold s p0 z\nx get r 3\nret x\nend`,
  );
  const f = p.byName.get('f') as TypedFunc;
  assert.throws(() => run(f, [100], { fuel: 1_000_000 }), fuelError);
  assert.equal(run(f, [4], { fuel: 1_000_000 }), 3);
});

const THREE_READS =
  'fn f io -> u32\na read p0\nx at a 0\nt at a 1\nb read t\ny at b 0\nt2 at b 1\nc read t2\nz at c 0\ns add x y\nr add s z\nret r\nend';

test('C a0_read: a host ninput above the capacity reads 0 past the capacity', async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required');
  const text = compile(parseAndValidate(THREE_READS), 'c', { ioInputCapacity: 2 }).text;
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, 'd.c'),
      `#include <stdio.h>\n#include "m.c"\nint main(void) { static a0_io io; io.input[0] = 5u; io.input[1] = 7u; io.ninput = 3u; printf("%u\\n", (unsigned)a0_f(&io)); return 0; }\n`,
    );
    await writeFile(join(dir, 'm.c'), text);
    const b = runTool(clang, ['-std=c11', '-O1', '-o', 'x', 'd.c'], { cwd: dir });
    assert.ok(b.ok, b.stderr);
    const r = runTool(join(dir, 'x'), []);
    assert.ok(r.ok, r.stderr);
    // Without the capacity bound the third read returns the word after input[1] (ninput = 3).
    assert.equal(r.stdout.trim(), '12');
  });
});

test('direct wasm a0_read: a host ninput above the capacity reads 0 past the capacity', async () => {
  const bytes = wasmModuleBytes(
    compile(parseAndValidate(THREE_READS), 'wasm', { ioInputCapacity: 2 }).text,
  );
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
  const e = instance.exports as {
    memory: WebAssembly.Memory;
    __heap_base: WebAssembly.Global;
    a0_f: (t: number) => number;
  };
  const base = e.__heap_base.value as number;
  if (e.memory.buffer.byteLength < base + 4096) e.memory.grow(1);
  const words = new Uint32Array(e.memory.buffer, base, 1024);
  words.set([5, 7, 3, 0]);
  assert.equal(e.a0_f(base) >>> 0, 12);
});

test('linker: use targets must be .a0 files inside the root, after symlinks', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'proj');
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(dir, 'x.a0'), 'fn x -> u32\nret 1\nend\n');
    await writeFile(join(root, 'lib', 'ok.a0'), 'fn ok -> u32\nret 2\nend\n');
    await symlink(join(dir, 'x.a0'), join(root, 'lib', 'evil.a0'));
    const main = (use: string) => `use "${use}"\nfn main -> u32\nret 0\nend\n`;
    const read = (p: string) => readFile(p, 'utf8');
    await writeFile(join(root, 'lib', 'good.a0'), main('ok.a0'));
    assert.ok((await link(join(root, 'lib', 'good.a0'), read)).program.byName.has('ok'));
    const refused = (e: unknown) => e instanceof A0Error && e.code === 'structure';
    for (const [name, use] of [
      ['abs.a0', '/etc/passwd'],
      ['up.a0', '../../x.a0'],
      ['sym.a0', 'evil.a0'],
      ['ext.a0', '../package.json'],
    ] as const) {
      await writeFile(join(root, 'lib', name), main(use));
      await assert.rejects(link(join(root, 'lib', name), read), refused, use);
    }
    // An explicit root narrower than the project also bounds the uses.
    await writeFile(join(root, 'up1.a0'), 'fn up -> u32\nret 3\nend\n');
    await writeFile(join(root, 'lib', 'up1.a0'), main('../up1.a0'));
    await assert.rejects(
      link(join(root, 'lib', 'up1.a0'), read, { root: join(root, 'lib') }),
      refused,
    );
  });
});

test('parallel: worker threads have a stack large enough for two u32x65536 arrays', async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required');
  const zeros = Array.from({ length: 65536 }, () => '0').join(' ');
  const src = `fn rb u32 u32 u32 -> u32
z arr ${zeros}
a set z p1 p2
k xor p1 p2
b set a k p1
x get a p1
y get b k
w add x y
s add p0 w
ret s
end
fn top u32 u32 -> u32
n and p1 63
r fold rb n 0 p0
ret r
end
`;
  const p = parseAndValidate(src);
  const top = p.byName.get('top') as TypedFunc;
  const inputs: [number, number][] = [
    [1, 63],
    [0x9e3779b9, 40],
  ];
  const want = inputs.map(([a, b]) => String(run(top, [a, b], { fuel: 1e9 })));
  const cParallel = parallelC({ mode: 'auto', force: true }) ?? assert.fail();
  const text = compile(p, 'c', { cParallel }).text;
  assert.ok(text.includes('a0par_run('), 'fold parallelized');
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'm.c'), text);
    await writeFile(
      join(dir, 'd.c'),
      `#include <stdint.h>\n#include <stdio.h>\nuint32_t a0_top(uint32_t, uint32_t);\nint main(void) { const uint32_t v[][2] = { ${inputs.map(([a, b]) => `{ ${a}u, ${b}u }`).join(', ')} }; for (unsigned i = 0; i < ${inputs.length}u; i++) printf("%u\\n", a0_top(v[i][0], v[i][1])); return 0; }\n`,
    );
    const b = runTool(clang, ['-std=c11', '-O0', '-o', 'x', 'd.c', 'm.c'], { cwd: dir });
    assert.ok(b.ok, b.stderr);
    const r = runTool(join(dir, 'x'), [], { env: { ...process.env, A0_THREADS: '4' } });
    assert.ok(r.ok, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), want);
  });
});

test('site wire: byte lengths are clamped to the stream and hrefs are restricted', () => {
  const r = readBytes(Uint32Array.from([0xffff_ffff, 65, 66]), 0);
  assert.deepEqual([...r.bytes], [65, 66]);
  assert.equal(r.next, 3);
  assert.deepEqual([...readBytes([2, 104, 105, 9], 0).bytes], [104, 105]);
  assert.equal(readBytes([], 0).bytes.length, 0);
  for (const ok of ['https://a0lang.com', 'http://x', '/docs', '#top', 'MAILTO:a@b.c'])
    assert.ok(safeHref(ok), ok);
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:x',
    'data:text/html,x',
    ' /x',
    '',
    '//evil.example',
    '/\\evil.example',
  ])
    assert.equal(safeHref(bad), false, bad);
});

test('site prerender: same href rule and length clamp as the runtime; shells get the CSP', () => {
  const str = (s: string): number[] => [s.length, ...[...s].map((c) => c.charCodeAt(0))];
  // OPEN a, ATTR href "//evil.example", ATTR href "javascript:x", ATTR href "/docs", TEXT, CLOSE.
  const words = [1, 9, 4, 3, ...str('//evil.example'), 4, 3, ...str('javascript:x')];
  const r = renderWords([...words, 4, 3, ...str('/docs'), 2, ...str('$&'), 3]);
  assert.equal(r.html, '<a href="/docs">$&amp;</a>');
  // A hostile length word reads only the words present (no 4 GB allocation).
  assert.equal(renderWords([2, 0xffff_ffff, 104, 105]).html, 'hi');
  const shell =
    '<html><head>\n  <meta charset="utf-8" />\n</head><body><main id="app"></main></body></html>';
  const page = fillShell(shell, { html: '<p>$&amp;$1</p>', css: 'p{color:red}', text: '' });
  assert.ok(page.includes(`<meta http-equiv="Content-Security-Policy" content="${SITE_CSP}" />`));
  assert.ok(page.includes('<main id="app"><p>$&amp;$1</p></main>'));
  assert.ok(page.includes('<style>p{color:red}</style>'));
  assert.match(SITE_CSP, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(SITE_CSP, /object-src 'none'.*base-uri 'none'/);
  assert.throws(
    () => fillShell(shell, { html: '', css: 'p{}</STYLE><script>alert(1)</script>', text: '' }),
    /<\/style/,
  );
});

test('verify C driver: ninput is clamped to the capacity and to the tokens present', async () => {
  const clang = findClang().path;
  assert.ok(clang, 'clang is required');
  const p = parseAndValidate(THREE_READS);
  const text = compile(p, 'c', { ioInputCapacity: 2 }).text;
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.c'), text);
    await writeFile(join(dir, 'd.c'), cDriver(p));
    const b = runTool(clang, ['-std=c11', '-O1', '-fsanitize=address', '-o', 'x', 'd.c'], {
      cwd: dir,
    });
    assert.ok(b.ok, b.stderr);
    const r = runTool(join(dir, 'x'), [], { input: '0 1000000 5 7 9\n0 5 1\n0\n' });
    assert.ok(r.ok, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['12', '1', '?']);
  });
});
