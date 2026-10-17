import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cacheKey, DiskCache } from '../src/cache.js';

test('artifact cache writes do not require the operating-system temporary filesystem', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-cache-volume-'));
  try {
    const unavailable = join(dir, 'not-a-directory');
    await writeFile(unavailable, 'reserved');
    const cacheDir = join(dir, 'cache');
    const module = new URL('../src/cache.js', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        const { DiskCache, cacheKey } = await import(process.argv[1]);
        const cache = new DiskCache(process.argv[2]);
        const key = cacheKey('portable-cache-fixture');
        await cache.put(key, 'complete artifact');
        assert.equal((await cache.get(key)).toString(), 'complete artifact');
      `,
        module,
        cacheDir,
      ],
      {
        env: { ...process.env, TMPDIR: unavailable, TMP: unavailable, TEMP: unavailable },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const key = cacheKey('portable-cache-fixture');
    assert.deepEqual(await readdir(join(cacheDir, key.slice(0, 2))), [key]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed artifact publication removes its temporary file and preserves the destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-cache-failure-'));
  try {
    const key = cacheKey('publication-conflict');
    const parent = join(dir, key.slice(0, 2));
    await mkdir(join(parent, key), { recursive: true });
    await assert.rejects(new DiskCache(dir).put(key, 'artifact'));
    assert.deepEqual(await readdir(parent), [key]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
