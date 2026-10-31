import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileCached, DiskCache } from '../src/cache.js';
import { parseAndValidate } from '../src/core.js';
import {
  assertNoPlaintextWriters,
  withPlaintextWrite,
  withPlaintextWrites,
  writeManagedFile,
} from '../src/plaintext-write.js';

const source = 'fn f u32 -> u32\na add p0 1\nret a\nend\n';
async function fence(root: string): Promise<void> {
  await mkdir(join(root, '.a0-seal'));
  await writeFile(
    join(root, '.a0-seal/head.json'),
    JSON.stringify({ format: 'a0-vault-1', phase: 'sealing' }),
  );
}

test('a delayed compilation cannot write a cache after its source project is fenced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-writer-'));
  try {
    const project = join(root, 'project'),
      cache = join(root, 'external-cache');
    await mkdir(project);
    const file = join(project, 'main.a0');
    await writeFile(file, source);
    let resume!: () => void, ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      ready = resolve;
    });
    class DelayedCache extends DiskCache {
      override async get(): Promise<undefined> {
        ready();
        await gate;
        return undefined;
      }
    }
    const run = compileCached(parseAndValidate(source), 'c', new DelayedCache(cache, file));
    await paused;
    await fence(project);
    resume();
    await assert.rejects(run, /SEALED_USE_UNLOCK_SESSION/);
    await assert.rejects(readdir(cache), { code: 'ENOENT' });
    await assertNoPlaintextWriters(project);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sealing refuses an active writer registered before its fence and permits cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-writer-'));
  try {
    const file = join(root, 'main.a0');
    await writeFile(file, source);
    let resume!: () => void, ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const run = withPlaintextWrite(file, async () => {
      ready();
      await gate;
    });
    await paused;
    await fence(root);
    await assert.rejects(assertNoPlaintextWriters(root), /PLAINTEXT_WRITERS_ACTIVE/);
    resume();
    await run;
    await assertNoPlaintextWriters(root);
    await assert.rejects(
      withPlaintextWrite(file, async () => assert.fail('late writer executed')),
      /SEALED_USE_UNLOCK_SESSION/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed writes release their lease and ordinary cache bytes remain identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-writer-'));
  try {
    const file = join(root, 'main.a0');
    await writeFile(file, source);
    await assert.rejects(
      withPlaintextWrite(file, async () => {
        throw new Error('synthetic write failure');
      }),
      /synthetic write failure/,
    );
    await assertNoPlaintextWriters(root);
    const cache = new DiskCache(join(root, 'cache'), file),
      key = 'a'.repeat(64);
    await cache.put(key, 'exact cached bytes');
    assert.equal((await cache.get(key))?.toString(), 'exact cached bytes');
    await assertNoPlaintextWriters(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a writer in another process is visible until it releases its lease', async () => {
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'a0-writer-process-'));
  const file = join(root, 'main.a0');
  await writeFile(file, source);
  const module = new URL('../src/plaintext-write.js', import.meta.url).href;
  const code = `import {withPlaintextWrite} from ${JSON.stringify(module)}; await withPlaintextWrite(${JSON.stringify(file)},async()=>{process.stdout.write('ready');await new Promise(resolve=>process.stdin.once('data',resolve));});process.stdin.destroy();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<[number | null]>((resolve) => {
    child.once('close', (code) => resolve([code]));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', (data) =>
        data.toString() === 'ready' ? resolve() : reject(new Error('unexpected child output')),
      );
      child.once('error', reject);
      child.once('exit', () => reject(new Error('writer child exited before ready')));
    });
    await fence(root);
    await assert.rejects(assertNoPlaintextWriters(root), /PLAINTEXT_WRITERS_ACTIVE/);
    child.stdin.end('release');
    const [status] = await exited;
    assert.equal(status, 0);
    await assertNoPlaintextWriters(root);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('a cache write capability cannot outlive its guarded batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-writer-batch-'));
  try {
    const file = join(root, 'main.a0');
    await writeFile(file, source);
    const cache = new DiskCache(join(root, 'cache'), file);
    let late: ((key: string, data: string) => Promise<void>) | undefined;
    await cache.withWrites(async (put) => {
      late = put;
      await put('a'.repeat(64), 'first');
    });
    assert.ok(late);
    await assert.rejects(late('b'.repeat(64), 'late'), /batch is closed/);
    assert.equal(await cache.get('b'.repeat(64)), undefined);
    await assertNoPlaintextWriters(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rejected batch drains started writes before releasing its lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-writer-drain-'));
  try {
    const file = join(root, 'main.a0');
    await writeFile(file, source);
    const cache = new DiskCache(join(root, 'cache'), file);
    const key = 'd'.repeat(64),
      data = Buffer.alloc(1 << 20, 37);
    await assert.rejects(
      cache.withWrites(async (put) => {
        void put(key, data);
        throw new Error('synthetic batch failure');
      }),
      /synthetic batch failure/,
    );
    assert.deepEqual(await cache.get(key), data);
    await assertNoPlaintextWriters(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed outputs guard every source and destination project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-output-'));
  try {
    const a = join(root, 'a'),
      b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    const sourceA = join(a, 'main.a0'),
      sourceB = join(b, 'helper.a0');
    await writeFile(sourceA, source);
    await writeFile(sourceB, source);
    const output = join(a, 'new.c');
    await writeManagedFile([sourceA, sourceB], output, 'ordinary output');
    await withPlaintextWrites([sourceA, sourceB, output], async () => {
      await assert.rejects(assertNoPlaintextWriters(a), /PLAINTEXT_WRITERS_ACTIVE/);
      await assert.rejects(assertNoPlaintextWriters(b), /PLAINTEXT_WRITERS_ACTIVE/);
    });
    await fence(b);
    await assert.rejects(
      writeManagedFile([sourceA, sourceB], join(a, 'blocked.c'), 'secret'),
      /SEALED/,
    );
    await assert.rejects(writeManagedFile([sourceA], join(b, 'new.c'), 'secret'), /SEALED/);
    assert.equal((await readdir(a)).includes('blocked.c'), false);
    assert.equal((await readdir(b)).includes('new.c'), false);
    await assertNoPlaintextWriters(a);
    await assertNoPlaintextWriters(b);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('new output under a symlinked protected parent fails closed', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-output-link-'));
  try {
    const a = join(root, 'a'),
      b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    const file = join(a, 'main.a0');
    await writeFile(file, source);
    await symlink(b, join(a, 'linked'));
    await fence(b);
    await assert.rejects(writeManagedFile([file], join(a, 'linked/new.c'), 'secret'), /SEALED/);
    assert.equal((await readdir(b)).includes('new.c'), false);
    await assertNoPlaintextWriters(b);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read-only CLI checks do not create a writer lease directory', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'a0-read-only-'));
  try {
    const file = join(root, 'main.a0');
    await writeFile(file, source);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'check', file],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readdir(root)).includes('.a0-plaintext-writers'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
