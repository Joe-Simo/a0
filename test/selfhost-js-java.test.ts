import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeIo } from '../src/core.js';
import { findClang, findJava, findJavac, runTool } from '../src/toolchain.js';
import { CHECKED_SOURCE, checkedCases } from './fixtures/checked-ops-fixtures.js';
import {
  buildNativeSourceCompiler,
  buildVerifiedNativeSeed,
  type NativeSourceCompiler,
  SOURCE_COMPLETION_TAG,
  SOURCE_FRONTEND_CAPACITY,
} from './helpers/native-source-compiler.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
let scratch: string | undefined;
let prepared:
  | Promise<{ dir: string; js: NativeSourceCompiler; java: NativeSourceCompiler }>
  | undefined;
let generated = 0;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});
function prepare() {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-source-ports-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    const js = await buildNativeSourceCompiler({
      module: 'compiler/emit_js.a0',
      entry: 'emitjsio',
      dir,
      seed,
    });
    const java = await buildNativeSourceCompiler({
      module: 'compiler/emit_java.a0',
      entry: 'emitjavaio',
      dir,
      seed,
    });
    return { dir, js, java };
  })();
  return prepared;
}
async function moduleFrom(compiler: NativeSourceCompiler, source: string, dir: string) {
  const output = compiler.runSource(source);
  assert.equal(output.code, 0, output.stderr);
  const file = join(dir, `generated-${++generated}.mjs`);
  await writeFile(file, output.text);
  return (await import(pathToFileURL(file).href)) as Record<
    string,
    (...args: unknown[]) => unknown
  >;
}

const ABI_SOURCE = `fn update u32x3 -> (u32x3,u32x3)
fresh set p0 0 9
out rec p0 fresh
ret out
end
fn token io -> (u32,io)
r read p0
v at r 0
t at r 1
w write t v
out rec v w
ret out
end
`;

test('seed-built A0 JavaScript emitter passes independent checked arithmetic and public ABI cases', {
  skip,
}, async () => {
  const { dir, js } = await prepare();
  const checked = await moduleFrom(js, CHECKED_SOURCE, dir);
  for (const row of checkedCases()) {
    const fn = checked[row.functionName];
    assert.ok(fn, row.functionName);
    assert.deepEqual(fn(...structuredClone(row.args)), row.expected, row.functionName);
  }
  const abi = await moduleFrom(js, ABI_SOURCE, dir);
  assert.ok(abi.update && abi.token);
  const input = new Uint32Array([1, 2, 3]);
  const output = abi.update(input) as [Uint32Array, Uint32Array];
  assert.deepEqual(Array.from(input), [1, 2, 3]);
  assert.deepEqual(
    output.map((a) => Array.from(a)),
    [
      [1, 2, 3],
      [9, 2, 3],
    ],
  );
  assert.notEqual(output[0], output[1]);
  const io = makeIo([0xffffffff, 7]);
  const result = abi.token(io) as [number, typeof io];
  assert.equal(result[0], 0xffffffff);
  assert.equal(result[1], io);
  assert.equal(io.position, 1);
  assert.deepEqual(io.output, [0xffffffff]);
  assert.throws(() => abi.update?.([1, 2]), RangeError);
  assert.throws(() => abi.update?.([1, 2, -1]), RangeError);
});

test('seed-built A0 source ports reject malformed framing, strict input and source overflow atomically', {
  skip,
}, async () => {
  const { js, java } = await prepare();
  const source = 'fn f -> u32\nret 7\nend\n';
  const bytes = Array.from(Buffer.from(source));
  for (const compiler of [js, java]) {
    const exact = source.padEnd(SOURCE_FRONTEND_CAPACITY, ' ');
    assert.equal(compiler.runSource(exact).code, 0);
    for (const [words, code] of [
      [[SOURCE_FRONTEND_CAPACITY + 1, SOURCE_COMPLETION_TAG], 4],
      [[source.length, ...bytes], 2],
      [[source.length + 1, ...bytes, SOURCE_COMPLETION_TAG], 2],
      [[source.length, ...bytes, 0], 2],
    ] as const) {
      const refused = compiler.runWords(words);
      assert.equal(refused.code, code);
      assert.equal(refused.text, '');
    }
    const oversized = compiler.runSource(`${exact} `);
    assert.equal(oversized.code, 4);
    assert.equal(oversized.text, '');
    for (const [text, code] of [
      [`profile strict\n${source}`, 2],
      ['fn f -> u32\nret true\nend\n', 3],
      ...['01', '4294967296', '42949672960', '18446744073709551616'].map(
        (literal) => [`fn f -> u32\nret ${literal}\nend\n`, 1] as const,
      ),
      ...['u32x01', 'u32x4294967297'].map(
        (type) => [`fn f ${type} -> u32\nret 0\nend\n`, 1] as const,
      ),
    ] as const) {
      const refused = compiler.runSource(text);
      assert.equal(refused.code, code);
      assert.equal(refused.text, '');
    }
    assert.equal(compiler.runRaw(Buffer.from([1, 2, 3])).code, 64);
  }
});

test('seed-built A0 Java output passes independent arithmetic on the JVM', {
  skip:
    skip ||
    (findJavac().path === undefined || findJava().path === undefined
      ? 'JDK is unavailable'
      : false),
}, async () => {
  const { dir, java: compiler } = await prepare();
  const javac = findJavac();
  const java = findJava();
  assert.ok(javac.path && java.path);
  const emitted = compiler.runSource(CHECKED_SOURCE);
  assert.equal(emitted.code, 0, emitted.stderr);
  const work = join(dir, 'jvm');
  await mkdir(work);
  await writeFile(join(work, 'A0Module.java'), emitted.text);
  const rows = checkedCases();
  const names = [...new Set(rows.map((row) => row.functionName))];
  const dispatch = names
    .map((name, i) => {
      const row = rows.find((r) => r.functionName === name);
      assert.ok(row);
      assert.ok(row.args.every((arg) => typeof arg === 'number'));
      const args = row.args.map((_, j) => `Integer.parseUnsignedInt(t[${j + 1}])`).join(',');
      const call = `A0Module.${name}(${args})`;
      const result =
        typeof row.expected === 'boolean'
          ? `(${call} ? "1" : "0")`
          : `Integer.toUnsignedString(${call})`;
      return `case ${i}: out.append(${result}); break;`;
    })
    .join('\n');
  await writeFile(
    join(work, 'Driver.java'),
    `import java.io.*;
public final class Driver {
  public static void main(String[] args) throws IOException {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    StringBuilder out = new StringBuilder();
    String line;
    while ((line = in.readLine()) != null) {
      String[] t = line.split(" ");
      switch (Integer.parseInt(t[0])) { ${dispatch} default: throw new AssertionError(); }
      out.append('\\n');
    }
    System.out.print(out);
  }
}
`,
  );
  const built = runTool(
    javac.path,
    ['-Xlint:all', '-Werror', '-d', work, 'A0Module.java', 'Driver.java'],
    { cwd: work },
  );
  assert.ok(built.ok, built.stderr);
  const input = `${rows.map((row) => [names.indexOf(row.functionName), ...row.args].join(' ')).join('\n')}\n`;
  const ran = runTool(java.path, ['-cp', work, 'Driver'], { cwd: work, input });
  assert.ok(ran.ok, ran.stderr);
  assert.deepEqual(
    ran.stdout.trim().split('\n'),
    rows.map((row) =>
      typeof row.expected === 'boolean' ? (row.expected ? '1' : '0') : String(row.expected),
    ),
  );
});
