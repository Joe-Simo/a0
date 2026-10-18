/** Cold preparation child. The build/loader launches this only after fresh TypeScript compilation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { compile } from '../src/backends.js';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { JS_SOURCE_FUNCTION_TYPES } from '../src/source-js.js';
import { COMPILER_VERSION } from '../src/targets.js';
import { committedTree } from './measurement-checkout.js';
import { writeReport } from './scrub-results.js';
import { jsCompilerOutputPaths, jsSourceInputPaths } from './source-js-inputs.js';

assert.equal(process.argv.length, 3);
const match = /^--(emit|verify)=(.+)$/.exec(process.argv[2] as string);
assert.ok(match, '--emit=DIR or --verify=DIR required');
const directory = resolve(match[2] as string),
  identity = committedTree(process.cwd());
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const linked = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const frontendOptions = { jsIo: 'host' as const, optimize: true };
const frontend = compile(linked.program, 'js', frontendOptions).text;
const emission = {
  compilerVersion: COMPILER_VERSION,
  compilerCheckout: identity,
  compilerBuild: {
    node: process.version,
    typescript: JSON.parse(await readFile('node_modules/typescript/package.json', 'utf8')).version,
  },
  compilerConfiguration: JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/typescript/lib/tsc.js'),
        '-p',
        'tsconfig.json',
        '--incremental',
        'false',
        '--showConfig',
      ],
      { encoding: 'utf8', maxBuffer: 16 << 20 },
    ),
  ),
  compilerPreparation:
    'Fresh project TypeScript compilation with stable on-disk SDK output checks, then a separate cold Node emitter/verifier.',
  compilerOutputs: await Promise.all(
    jsCompilerOutputPaths().map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  ),
  entry: 'compiler/source_frontend.a0',
  frontendOptions,
  functions: Object.fromEntries(
    Object.keys(JS_SOURCE_FUNCTION_TYPES).map((name) => {
      const fn = linked.program.byName.get(name);
      assert.ok(fn);
      return [name, { params: fn.params, result: fn.result }];
    }),
  ),
  functionCount: linked.program.functions.length,
  sourceSHA256: hash(formatProgram(linked.program)),
  modules: await Promise.all(
    linked.sources.map(async (source) => ({
      path: relative(process.cwd(), resolve(source.path)),
      sha256: hash(await readFile(source.path)),
    })),
  ),
  frontendSHA256: hash(frontend),
  frontendBytes: Buffer.byteLength(frontend),
  inputs: await Promise.all(
    jsSourceInputPaths(linked.sources.map((source) => source.path)).map(async (path) => ({
      path,
      sha256: hash(await readFile(path)),
    })),
  ),
};
assert.deepEqual(committedTree(process.cwd()), identity);
if (match[1] === 'emit') {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'frontend.mjs'), frontend);
  await writeReport(join(directory, 'emission.json'), emission);
} else {
  const build = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8'));
  for (const [key, value] of Object.entries(emission))
    assert.deepEqual(build[key], value, `cold JS compiler differs: ${key}`);
  assert.equal(hash(await readFile(join(directory, 'frontend.mjs'))), emission.frontendSHA256);
}
