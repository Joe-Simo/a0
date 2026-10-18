/** Explicit frozen-checkout proof that opting into host IO leaves default code generation intact. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as backend from '../src/backends.js';
import * as core from '../src/core.js';
import { link } from '../src/link.js';
import { parseSource } from '../src/source.js';
import { COMPILER_VERSION } from '../src/targets.js';
import { committedTree } from '../tools/measurement-checkout.js';
import { writeReport } from '../tools/scrub-results.js';

const controlDirectory = process.env.A0_JS_DEFAULT_CONTROL;
assert.ok(
  controlDirectory,
  'A0_JS_DEFAULT_CONTROL must name the separately built pre-host checkout',
);
const controlRoot = resolve(controlDirectory);
const control = committedTree(controlRoot);
assert.equal(control.commit, '2f1c1740eb8e3cb63731bd2810c7e98d7da13483');
assert.equal(COMPILER_VERSION, 'a0c-0.1.68');
const oldBackend = (await import(
  pathToFileURL(join(controlRoot, 'dist/src/backends.js')).href
)) as typeof backend;
const oldCore = (await import(
  pathToFileURL(join(controlRoot, 'dist/src/core.js')).href
)) as typeof core;
const oldSource = (await import(
  pathToFileURL(join(controlRoot, 'dist/src/source.js')).href
)) as typeof import('../src/source.js');
const oldTargets = (await import(
  pathToFileURL(join(controlRoot, 'dist/src/targets.js')).href
)) as typeof import('../src/targets.js');
assert.equal(oldTargets.COMPILER_VERSION, COMPILER_VERSION);
const compilerFiles = execFileSync('git', ['ls-files', 'src/*.ts'], {
  cwd: controlRoot,
  encoding: 'utf8',
})
  .trim()
  .split('\n');
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('frozen compiler-68 default JS/C assembly, function bodies and cache keys remain byte-identical', async () => {
  const inputs = [
    {
      name: 'ordered-io',
      source:
        'fn step io u32 -> io\nr read p0\nv at r 0\nt at r 1\nw write t v\nret w\nend\nfn f io u32 -> io\nx fold step p1 p0\nret x\nend\n',
    },
    {
      name: 'strict-io',
      source:
        'profile strict\nfn f io -> io\nr read p0\nv at r 0\nt at r 1\nw write t v\nret w\nend\n',
    },
    {
      name: 'strict-aggregate',
      source: 'profile strict\nfn f u32x4 -> (u32x4,u32x4)\na set p0 1 9\nb rec a p0\nret b\nend\n',
    },
  ];
  const root = 'experiments/unification/frontend-a0/inputs';
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as {
    unit: string;
    input: string;
    inputSHA256: string;
  }[];
  for (const row of index) {
    const bytes = await readFile(join(root, row.input));
    assert.equal(hash(bytes), row.inputSHA256);
    inputs.push({
      name: row.unit,
      source: (JSON.parse(bytes.toString('utf8')) as { unified: string }).unified,
    });
  }
  const frontend = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
  inputs.push({ name: 'complete-source-frontend', source: core.formatProgram(frontend.program) });
  const rows: {
    name: string;
    sourceSHA256: string;
    optimize: boolean;
    functions: number;
    jsSHA256: string;
    cSHA256: string;
  }[] = [];
  for (const input of inputs) {
    const current = core.validate(parseSource(input.source));
    const previous = oldCore.validate(oldSource.parseSource(input.source));
    for (const optimize of [false, true]) {
      const options = { optimize };
      const js = backend.compile(current, 'js', options).text;
      const c = backend.compile(current, 'c', options).text;
      assert.equal(
        js,
        oldBackend.compile(previous, 'js', options).text,
        `${input.name}: default JS optimize=${optimize}`,
      );
      assert.equal(
        c,
        oldBackend.compile(previous, 'c', options).text,
        `${input.name}: C optimize=${optimize}`,
      );
      for (let i = 0; i < current.functions.length; i++) {
        const fn = current.functions[i],
          oldFn = previous.functions[i];
        assert.ok(fn && oldFn);
        assert.equal(
          backend.emitFunction('js', fn, options),
          oldBackend.emitFunction('js', oldFn, options),
          `${input.name}/${fn.name}: function body`,
        );
        assert.equal(
          backend.functionEmissionKey('js', fn, options),
          oldBackend.functionEmissionKey('js', oldFn, options),
          `${input.name}/${fn.name}: cache key`,
        );
      }
      rows.push({
        name: input.name,
        sourceSHA256: hash(input.source),
        optimize,
        functions: current.functions.length,
        jsSHA256: hash(js),
        cSHA256: hash(c),
      });
    }
  }
  await writeReport('.a0-tmp/source-js-default.json', {
    scope: 'Byte equality and cache compatibility only. No timing or performance claim.',
    current: committedTree(process.cwd()),
    control,
    compilerVersion: COMPILER_VERSION,
    controlCompilerOutputs: await Promise.all(
      compilerFiles.map(async (path) => ({
        path: `dist/${path.slice(0, -3)}.js`,
        sha256: hash(await readFile(join(controlRoot, `dist/${path.slice(0, -3)}.js`))),
      })),
    ),
    rows,
  });
});
