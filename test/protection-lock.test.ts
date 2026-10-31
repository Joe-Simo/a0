import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest } from '../src/protection/crypto.js';
import { DiskVaultStore } from '../src/protection/disk.js';
import { assertDeadLocalProcess, processLockRecord } from '../src/protection/process-lock.js';

const linux = process.platform === 'linux' ? false : 'Linux process-scope evidence is unavailable';
async function fixture(): Promise<{ root: string; store: DiskVaultStore }> {
  const root = await mkdtemp(join(tmpdir(), 'a0-lock-'));
  const store = new DiskVaultStore(root);
  await store.initialize();
  return { root, store };
}
async function lock(store: DiskVaultStore, record: unknown): Promise<string> {
  const bytes = JSON.stringify(record);
  await writeFile(join(store.dir, 'commit.lock'), bytes);
  return digest(new TextEncoder().encode(bytes));
}

test('legacy and foreign-scope locks cannot be recovered using a local absent PID', {
  skip: process.platform === 'win32' ? 'Filesystem durability pending on Windows' : false,
}, async () => {
  const { root, store } = await fixture();
  try {
    for (const record of [
      { pid: 2147483647, nonce: 'legacy' },
      { ...(await processLockRecord()), pid: 2147483647, scope: null },
      {
        ...(await processLockRecord()),
        pid: 2147483647,
        scope: { boot: 'foreign', namespace: 'pid:[0]' },
      },
    ]) {
      const hash = await lock(store, record);
      await assert.rejects(store.recoverCommitLock(hash), /LOCK_OWNER_UNVERIFIABLE/);
      assert.equal(await readFile(join(store.dir, 'commit.lock'), 'utf8'), JSON.stringify(record));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('live local process locks and unknown records fail closed', { skip: linux }, async () => {
  await assert.rejects(assertDeadLocalProcess(await processLockRecord()), /LOCK_OWNER_ALIVE/);
  for (const value of [null, {}, { format: 'a0-process-lock-1', pid: -1 }])
    await assert.rejects(assertDeadLocalProcess(value), /LOCK_OWNER_UNVERIFIABLE/);
});

test('explicit recovery of a crashed same-scope process keeps the store usable', {
  skip: linux,
}, async () => {
  const { root, store } = await fixture();
  const module = new URL('../src/protection/process-lock.js', import.meta.url).href;
  const path = join(store.dir, 'commit.lock');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {writeFile} from 'node:fs/promises';import {processLockRecord} from ${JSON.stringify(module)};await writeFile(${JSON.stringify(path)},JSON.stringify(await processLockRecord()));process.stdout.write('ready');setInterval(()=>{},1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('child exited before readiness')));
      child.stdout.once('data', () => resolve());
    });
    const bytes = await readFile(path),
      hash = await digest(bytes);
    await assert.rejects(store.recoverCommitLock(hash), /LOCK_OWNER_ALIVE/);
    child.kill('SIGKILL');
    await ended;
    await assert.rejects(store.recoverCommitLock('0'.repeat(64)), /LOCK_CHANGED/);
    await store.recoverCommitLock(hash);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await assert.rejects(readFile(join(store.dir, 'recover.lock')), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended;
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery mutex and symlink lock never cause another file to be removed', {
  skip: linux,
}, async () => {
  const { root, store } = await fixture();
  try {
    const hash = await lock(store, await processLockRecord());
    await writeFile(join(store.dir, 'recover.lock'), 'unverified recovery owner');
    await assert.rejects(store.recoverCommitLock(hash), /RECOVERY_LOCKED/);
    await rm(join(store.dir, 'recover.lock'));
    await rm(join(store.dir, 'commit.lock'));
    const target = join(root, 'other');
    await writeFile(target, 'must remain');
    await symlink(target, join(store.dir, 'commit.lock'));
    await assert.rejects(
      store.recoverCommitLock(await digest(new TextEncoder().encode('must remain'))),
    );
    assert.equal(await readFile(target, 'utf8'), 'must remain');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
