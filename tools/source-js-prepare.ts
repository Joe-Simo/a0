/** Fresh compiler preparation followed by a cold child, never a caller's cached compiler. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { committedTree } from './measurement-checkout.js';
import { jsCompilerOutputPaths } from './source-js-inputs.js';

let ready: { key: string; outputs: readonly string[] } | undefined;
export async function prepareJsCompiler(mode: 'emit' | 'verify', directory: string): Promise<void> {
  const root = process.cwd(),
    identity = committedTree(root);
  const key = JSON.stringify(identity);
  const paths = jsCompilerOutputPaths();
  const digest = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const before = await Promise.all(paths.map(digest));
  if (ready?.key !== key) {
    const built = spawnSync(
      process.execPath,
      [
        resolve('node_modules/typescript/lib/tsc.js'),
        '-p',
        'tsconfig.json',
        '--incremental',
        'false',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 << 20 },
    );
    assert.equal(
      built.status,
      0,
      `fresh JS compiler build failed: ${built.stdout}\n${built.stderr}`,
    );
    assert.deepEqual(committedTree(root), identity, 'source changed during JS compiler build');
    assert.deepEqual(
      await Promise.all(paths.map(digest)),
      before,
      'stale on-disk JS compiler/SDK: fresh output differs; restart in a fresh process after building',
    );
    ready = { key, outputs: before };
  } else assert.deepEqual(before, ready.outputs, 'prepared JS compiler output changed');
  const verified = spawnSync(
    process.execPath,
    [resolve('dist/tools/source-js-emit.js'), `--${mode}=${resolve(directory)}`],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 << 20 },
  );
  assert.equal(
    verified.status,
    0,
    `cold JS compiler ${mode} failed: ${verified.stdout}\n${verified.stderr}`,
  );
  assert.deepEqual(committedTree(root), identity, 'source changed during cold JS compilation');
}
