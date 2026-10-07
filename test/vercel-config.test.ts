import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ROOT_VERCEL, VERCEL } from '../tools/site-build.js';

test('the root vercel.json is the generated one: no build on Vercel, the committed deploy/ served with the site headers', async () => {
  const committed = JSON.parse(await readFile('vercel.json', 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(ROOT_VERCEL)));
  assert.equal(committed.outputDirectory, 'deploy');
  assert.equal(committed.buildCommand, null);
  assert.equal(committed.installCommand, null);
  assert.deepEqual(committed.headers, JSON.parse(JSON.stringify(VERCEL.headers)));
  assert.ok(existsSync('deploy/index.html'), 'run bun run site:publish and commit deploy/');
});
