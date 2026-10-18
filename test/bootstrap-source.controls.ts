/** Actual native frontend/formatter → checked IR → existing C backend → C stages.
 * Explicit current artifacts are required; no skipped backend or substitute parser. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { nativeSource } from '../src/source-native.js';
import { runTool } from '../src/toolchain.js';
import { loadNativeBootstrapProgram } from '../tools/bootstrap-source.js';
import {
  bootstrapCStage,
  bootstrapNativeCStage,
  cStageCompilerFlags,
  findCStageCompiler,
  reproduceCStage,
  runCStage,
} from '../tools/c-arena-stage.js';
import { prepareSourceFormat, prepareSourceFrontend } from '../tools/source-native-load.js';

const frontendPath = process.env.A0_BOOTSTRAP_FRONTEND;
const formatPath = process.env.A0_BOOTSTRAP_FORMAT;
assert.ok(frontendPath && formatPath, 'A0_BOOTSTRAP_FRONTEND/FORMAT required');
const prepared = await prepareSourceFrontend(frontendPath);
assert.equal(prepared.build.diagnosticPorts, 'arena-v1');
const artifact = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const companion = await prepareSourceFormat(formatPath);
const compiler = findCStageCompiler();
assert.ok(compiler.path, 'C compiler required');
const scratch = resolve('.a0-tmp/bootstrap-source-controls');
await mkdir(scratch, { recursive: true });

test('native bootstrap graph preserves spec-only closure and uses one native graph check without source reparse', async () => {
  const host = nativeSource(artifact, undefined, companion);
  const counts = { units: 0, checks: 0, activations: 0, formats: 0 };
  const frontend: ReturnType<typeof nativeSource> = {
    ...host,
    parse() {
      throw new Error('whole-source parse must not be used');
    },
    checkProgram() {
      throw new Error('host IR must not be checked again');
    },
    parseUnit(source, budget) {
      counts.units++;
      return host.parseUnit(source, budget);
    },
    checkUnits(units, profile, budget) {
      counts.checks++;
      return host.checkUnits(units, profile, budget);
    },
    activateProgramForFormat(program, budget) {
      counts.activations++;
      return host.activateProgramForFormat(program, budget);
    },
    format(result, request) {
      counts.formats++;
      return host.format(result, request);
    },
  };
  const files = new Map([
    [
      '/bootstrap/dep.a0',
      'profile strict\nfn valid _ -> bool\nret gt A 0\nend\nfn twice\nret mul A 2\nend\nfn unused\nret add A 99\nend\n',
    ],
    [
      '/bootstrap/main.a0',
      'profile strict\nuse "dep.a0"\nfn main\nex 7 -> 14\npre valid A\npost valid r\nret twice A\nend\n',
    ],
  ]);
  try {
    const actual = await loadNativeBootstrapProgram(
      '/bootstrap/main.a0',
      ['main'],
      async (path) => {
        const source = files.get(path);
        assert.ok(source, path);
        return source;
      },
      frontend,
      { root: '/bootstrap', canonicalPath: async (path) => path },
    );
    assert.deepEqual(counts, { units: 2, checks: 1, activations: 1, formats: 1 });
    assert.deepEqual(
      actual.program.functions.map((fn) => fn.name),
      ['valid', 'twice', 'main'],
    );
    assert.equal(actual.program.profile, 'strict');
    assert.ok(actual.source.includes('profile strict\n'));
    assert.ok(actual.source.includes('pre valid A\n'));
    assert.ok(!actual.source.includes('unused'));
    const output = host.parse(actual.source);
    assert.ok(output.ok, 'actual A0 parser/checker accepts frozen flat source and its contracts');
    assert.ok(host.parse('fn after\nret A\nend\n').ok, 'borrowed frontend remains open');
  } finally {
    host.close();
  }
});

test('native bootstrap refuses an unavailable formatter without writing compiler artifacts', async () => {
  const host = nativeSource(artifact);
  try {
    await assert.rejects(
      loadNativeBootstrapProgram(
        '/bootstrap/main.a0',
        ['main'],
        async () => 'fn main\nret A\nend\n',
        host,
        { root: '/bootstrap', canonicalPath: async (path) => path },
      ),
      /formatting activation refused/,
    );
    assert.ok(host.parse('fn after\nret A\nend\n').ok);
  } finally {
    host.close();
  }
});

test('native checked-IR C stage preserves flat source, contracts and atomic refusal and reaches stages 2–4 fixed point', {
  timeout: 900_000,
}, async () => {
  const host = nativeSource(artifact, undefined, companion);
  try {
    const initial = await bootstrapNativeCStage(join(scratch, 'native-stage1'), host, compiler);
    const input = join(scratch, 'independent.a0'),
      output = join(scratch, 'independent.c');
    const source = 'fn step\nret add A B\nend\nfn probe\nex 7 -> 13\nx fold step 4 A\nret x\nend\n';
    await writeFile(input, source);
    const ran = runCStage(initial.exe, input, output);
    assert.ok(ran.ok, ran.stderr);
    assert.equal(await readFile(input, 'utf8'), source);
    const target = join(scratch, 'target.c');
    await writeFile(
      target,
      '#include <assert.h>\n#include "independent.c"\nint main(void) { assert(a0_probe(7u)==13u); assert(a0_probe(0xffffffffu)==5u); }\n',
    );
    for (const level of ['-O0', '-O2']) {
      const exe = join(scratch, level.slice(1));
      const built = runTool(compiler.path as string, [
        ...cStageCompilerFlags({}, compiler).filter((flag) => !['-O2', '-municode'].includes(flag)),
        level,
        target,
        '-o',
        exe,
      ]);
      assert.ok(built.ok, built.stderr);
      const result = runTool(exe, []);
      assert.ok(result.ok, result.stderr);
    }
    await writeFile(output, 'prior artifact\n');
    await writeFile(input, source.replace('ex 7 -> 13', 'ex 7 -> 14'));
    const rejected = runCStage(initial.exe, input, output);
    assert.equal(rejected.status, 8, rejected.stderr);
    assert.equal(await readFile(output, 'utf8'), 'prior artifact\n');
    await reproduceCStage(join(scratch, 'fixed-point'), initial);
    const legacy = await bootstrapCStage(join(scratch, 'verified-seed-stage1'), compiler);
    const control = join(scratch, 'verified-seed-stage2.c');
    const compared = runCStage(legacy.exe, initial.sourcePath, control);
    assert.ok(compared.ok, compared.stderr);
    assert.deepEqual(
      await readFile(control),
      await readFile(join(scratch, 'fixed-point/stage2/module.c')),
      'verified-seed stage and native-IR setup emit identical C from the same frozen flat compiler source',
    );
  } finally {
    host.close();
  }
});
