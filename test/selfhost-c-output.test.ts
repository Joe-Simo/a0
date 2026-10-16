import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAndValidate } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { cDriver } from '../tools/verify.js';

test('A0 C output survives large chunks with a small JavaScript stack', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) return t.skip('clang is unavailable');
  const source = Array.from(
    { length: 100 },
    (_, f) => `fn wide${f} u32 -> u32
${Array.from({ length: 24 }, (_, n) => `n${n} add ${n === 0 ? 'p0' : `n${n - 1}`} ${f + 1}`).join('\n')}
ret n23
end
`,
  ).join('\n');
  const imports = Object.fromEntries(
    ['src/core', 'src/link', 'tools/selfhost-c'].map((name) => [
      name,
      new URL(`../${name}.js`, import.meta.url).href,
    ]),
  );
  const script = `
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseAndValidate } from ${JSON.stringify(imports['src/core'])};
import { link } from ${JSON.stringify(imports['src/link'])};
import { selfHostedC } from ${JSON.stringify(imports['tools/selfhost-c'])};
const emitter = (await link('compiler/emit_c.a0', p => readFile(p, 'utf8'))).program;
const source = readFileSync(process.argv[2], 'utf8');
process.stdout.write(selfHostedC(emitter, parseAndValidate(source)).text);
`;
  const emitted = await withTempDir(async (dir) => {
    const scriptPath = join(dir, 'emit.mjs');
    const sourcePath = join(dir, 'source.a0');
    await writeFile(scriptPath, script);
    await writeFile(sourcePath, source);
    return spawnSync(process.execPath, ['--stack-size=256', scriptPath, sourcePath], {
      timeout: 120_000,
      maxBuffer: 1 << 24,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
  assert.equal(emitted.status, 0, emitted.stderr.toString());
  assert.ok(emitted.stdout.length > 65536, 'exercise a large generated chunk');
  const program = parseAndValidate(source);
  const cases = [0, 50, 99].flatMap((f) =>
    [0, 7, 0xffffffff].map((n) => ({
      functionName: `wide${f}`,
      args: [n],
      expected: Number(BigInt.asUintN(32, BigInt(n) + 24n * BigInt(f + 1))),
    })),
  );
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.c'), emitted.stdout);
    await writeFile(join(dir, 'driver.c'), cDriver(program));
    const built = runTool(
      clang.path as string,
      [
        '-std=c11',
        '-O1',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fsanitize=undefined',
        '-fno-sanitize-recover=all',
        'driver.c',
        '-o',
        'driver',
      ],
      { cwd: dir },
    );
    assert.ok(built.ok, built.stderr);
    const input = cases
      .map((c) =>
        [program.functions.findIndex((f) => f.name === c.functionName), ...c.args].join(' '),
      )
      .join('\n');
    const actual = runTool(join(dir, 'driver'), [], { cwd: dir, input: `${input}\n` });
    assert.ok(actual.ok, actual.stderr);
    assert.deepEqual(
      actual.stdout.trim().split('\n').map(Number),
      cases.map((c) => c.expected),
    );
  });
});
