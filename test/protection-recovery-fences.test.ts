import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DiskCache } from '../src/cache.js';
import { assertNoPlaintextWriters, PLAINTEXT_WRITERS } from '../src/plaintext-write.js';
import { digest } from '../src/protection/crypto.js';
import { DiskVaultStore } from '../src/protection/disk.js';
import { processLockRecord } from '../src/protection/process-lock.js';

const linux = process.platform !== 'linux' ? 'Requires Linux process-scope evidence' : false;
const leaseName = '2147483647-00000000-0000-4000-8000-000000000000';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'a0-fence-'));
  const store = new DiskVaultStore(root);
  await store.initialize();
  return { root, store };
}
async function ready(child: ReturnType<typeof spawn>) {
  assert.ok(child.stdout);
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => {
      throw new Error('child exited before readiness');
    }),
  ]);
}

test('interrupted writer recovery leaves a verifiable mutex; mutex recovery preserves the pending lease', {
  skip: linux,
}, async () => {
  const { root, store } = await fixture();
  const writer = join(PLAINTEXT_WRITERS, leaseName);
  await mkdir(join(root, PLAINTEXT_WRITERS));
  const value = JSON.stringify({
    format: 'a0-plaintext-writer-1',
    owner: { ...(await processLockRecord()), pid: 2147483647 },
  });
  await writeFile(join(root, writer), value);
  const hash = await digest(new TextEncoder().encode(value));
  const module = new URL('../src/protection/disk.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {DiskVaultStore} from ${JSON.stringify(module)};const original=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=async(...args)=>{console.log('locked');setInterval(()=>{},1000);await new Promise(()=>{});return original(...args);};await new DiskVaultStore(${JSON.stringify(root)}).recoverPlaintextWriter(${JSON.stringify(writer)},${JSON.stringify(hash)});`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ended = once(child, 'close');
  try {
    await ready(child);
    const mutex = await readFile(join(store.dir, 'recover.lock'));
    const mutexHash = await digest(mutex);
    await assert.rejects(store.recoverRecoveryLock(mutexHash), /LOCK_OWNER_ALIVE/);
    child.kill('SIGKILL');
    assert.equal((await ended)[1], 'SIGKILL');
    await assert.rejects(store.recoverRecoveryLock('0'.repeat(64)), /LOCK_CHANGED/);
    await store.recoverRecoveryLock(mutexHash);
    await assert.rejects(readFile(join(store.dir, 'recover.lock')), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, writer), 'utf8'), value);
    await assert.rejects(assertNoPlaintextWriters(root), /PLAINTEXT_WRITERS_ACTIVE/);
    await store.recoverPlaintextWriter(writer, hash);
    await assertNoPlaintextWriters(root);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended;
    await rm(root, { recursive: true, force: true });
  }
});

test('commit interlock refuses competing maintenance; interrupted double-lock state remains fail closed', {
  skip: linux,
}, async () => {
  const { root, store } = await fixture();
  const dead = JSON.stringify({ ...(await processLockRecord()), pid: 2147483647 });
  await writeFile(join(store.dir, 'recover.lock'), dead);
  const hash = await digest(new TextEncoder().encode(dead));
  const module = new URL('../src/protection/disk.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {DiskVaultStore} from ${JSON.stringify(module)};crypto.subtle.digest=async()=>{console.log('locked');setInterval(()=>{},1000);await new Promise(()=>{});};await new DiskVaultStore(${JSON.stringify(root)}).recoverRecoveryLock(${JSON.stringify(hash)});`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ended = once(child, 'close');
  try {
    await ready(child);
    await assert.rejects(store.recoverRecoveryLock(hash), /COMMIT_LOCKED/);
    await assert.rejects(store.commit(undefined, {} as never), /COMMIT_LOCKED/);
    await assert.rejects(store.recoverCommitLock(hash), /RECOVERY_LOCKED/);
    child.kill('SIGKILL');
    await ended;
    await assert.rejects(store.recoverRecoveryLock(hash), /COMMIT_LOCKED/);
    await assert.rejects(store.recoverCommitLock(hash), /RECOVERY_LOCKED/);
    assert.equal(await readFile(join(store.dir, 'recover.lock'), 'utf8'), dead);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended;
    await rm(root, { recursive: true, force: true });
  }
});

test('mutex recovery refuses unknown scope and preserves a live writer lease', {
  skip: linux,
}, async () => {
  const { root, store } = await fixture();
  try {
    await writeFile(join(store.dir, 'recover.lock'), JSON.stringify({ pid: 2147483647 }));
    let bytes = await readFile(join(store.dir, 'recover.lock'));
    await assert.rejects(store.recoverRecoveryLock(await digest(bytes)), /LOCK_OWNER_UNVERIFIABLE/);
    const writer = join(PLAINTEXT_WRITERS, `${process.pid}-00000000-0000-4000-8000-000000000000`);
    await mkdir(join(root, PLAINTEXT_WRITERS));
    await writeFile(
      join(root, writer),
      JSON.stringify({ format: 'a0-plaintext-writer-1', owner: await processLockRecord() }),
    );
    await writeFile(
      join(store.dir, 'recover.lock'),
      JSON.stringify({ ...(await processLockRecord()), pid: 2147483647 }),
    );
    bytes = await readFile(join(store.dir, 'recover.lock'));
    await store.recoverRecoveryLock(await digest(bytes));
    await assert.rejects(
      store.recoverPlaintextWriter(writer, await digest(await readFile(join(root, writer)))),
      /LOCK_OWNER_ALIVE/,
    );
    await assert.rejects(assertNoPlaintextWriters(root), /PLAINTEXT_WRITERS_ACTIVE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external cache cannot write into an already sealed destination project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-cache-fence-'));
  try {
    const source = join(root, 'source'),
      target = join(root, 'target');
    await mkdir(source);
    await mkdir(target);
    const file = join(source, 'main.a0');
    await writeFile(file, 'synthetic source');
    await mkdir(join(target, '.a0-seal'));
    await writeFile(
      join(target, '.a0-seal/head.json'),
      JSON.stringify({ format: 'a0-vault-1', phase: 'on' }),
    );
    const cache = new DiskCache(join(target, 'cache'), file);
    await assert.rejects(
      cache.put('a'.repeat(64), 'must not be written'),
      /SEALED_USE_UNLOCK_SESSION/,
    );
    await assert.rejects(readdir(cache.dir), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external cache destination lease remains visible through an interrupted payload write', {
  skip: linux,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-cache-crash-'));
  const source = join(root, 'source'),
    target = join(root, 'target');
  await mkdir(source);
  await mkdir(target);
  const file = join(source, 'main.a0');
  await writeFile(file, 'synthetic source');
  const cacheModule = new URL('../src/cache.js', import.meta.url).href;
  const cache = join(target, 'cache');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.promises.writeFile;fs.promises.writeFile=async(path,...args)=>{if(String(path).includes('/.a0-cache-')){console.log('writing');setInterval(()=>{},1000);await new Promise(()=>{});}return original(path,...args);};syncBuiltinESMExports();const {DiskCache}=await import(${JSON.stringify(cacheModule)});await new DiskCache(${JSON.stringify(cache)},${JSON.stringify(file)}).put('a'.repeat(64),'synthetic payload');`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ended = once(child, 'close');
  try {
    await ready(child);
    await assert.rejects(assertNoPlaintextWriters(source), /PLAINTEXT_WRITERS_ACTIVE/);
    await assert.rejects(assertNoPlaintextWriters(target), /PLAINTEXT_WRITERS_ACTIVE/);
    const store = new DiskVaultStore(target);
    await store.initialize();
    const directory = join('cache', PLAINTEXT_WRITERS);
    const [name] = await readdir(join(target, directory));
    assert.ok(name);
    const path = join(directory, name);
    const hash = await digest(await readFile(join(target, path)));
    await assert.rejects(store.recoverPlaintextWriter(path, hash), /LOCK_OWNER_ALIVE/);
    child.kill('SIGKILL');
    await ended;
    await store.recoverPlaintextWriter(path, hash);
    // The outer lease protects the destination ancestor while the cache is created.
    // Removing the inner lease must not silently remove that separate capability.
    await assert.rejects(assertNoPlaintextWriters(target), /PLAINTEXT_WRITERS_ACTIVE/);
    for (const name of await readdir(join(target, PLAINTEXT_WRITERS))) {
      const outer = join(PLAINTEXT_WRITERS, name);
      await store.recoverPlaintextWriter(outer, await digest(await readFile(join(target, outer))));
    }
    await assertNoPlaintextWriters(target);
    await assert.rejects(readFile(join(cache, 'aa', 'a'.repeat(64))), { code: 'ENOENT' });
    await assert.rejects(
      new DiskVaultStore(source).recoverPlaintextWriter(`../target/${path}`, hash),
      /UNSAFE_PATH/,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended;
    await rm(root, { recursive: true, force: true });
  }
});

test('cache batch keeps its guarded paths when the caller changes working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-cache-cwd-'));
  try {
    const other = join(root, 'other');
    await mkdir(other);
    await writeFile(join(root, 'main.a0'), 'synthetic source');
    const module = new URL('../src/cache.js', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {DiskCache} from ${JSON.stringify(module)};const c=new DiskCache('cache','main.a0');await c.withWrites(async put=>{process.chdir(${JSON.stringify(other)});await put('a'.repeat(64),'stable bytes');});`,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(await readFile(join(root, 'cache', 'aa', 'a'.repeat(64)), 'utf8'), 'stable bytes');
    await assert.rejects(readdir(join(other, 'cache')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
