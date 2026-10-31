import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNoPlaintextWriters, PLAINTEXT_WRITERS } from '../src/plaintext-write.js';
import { digest } from '../src/protection/crypto.js';
import { DiskVaultStore } from '../src/protection/disk.js';
import { processLockRecord } from '../src/protection/process-lock.js';

const skip =
  process.platform !== 'linux' ? 'Recovery requires same-boot Linux PID namespace evidence' : false;
const uuid = '00000000-0000-4000-8000-000000000000';
async function fixture(initialize = true) {
  const root = await mkdtemp(join(tmpdir(), 'a0-writer-recover-'));
  const store = new DiskVaultStore(root);
  if (initialize) await store.initialize();
  await mkdir(join(root, PLAINTEXT_WRITERS));
  return { root, store };
}

test('crashed writer leases recover individually; live owners and stale approvals remain fenced', {
  skip,
}, async () => {
  const { root, store } = await fixture(false);
  const nested = join(root, 'nested');
  await mkdir(nested);
  const source = join(root, 'main.a0'),
    output = join(nested, 'out');
  await writeFile(source, 'synthetic source');
  const module = new URL('../src/plaintext-write.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {withPlaintextWrites} from ${JSON.stringify(module)};await withPlaintextWrites(${JSON.stringify([source, output])},async()=>{console.log('ready');setInterval(()=>{},1000);await new Promise(()=>{});});`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ended = once(child, 'close');
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('writer exited before readiness');
      }),
    ]);
    await store.initialize();
    const paths = await Promise.all(
      ['', 'nested'].map(async (parent) => {
        const directory = join(parent, PLAINTEXT_WRITERS);
        const [name] = await readdir(join(root, directory));
        assert.ok(name);
        return join(directory, name);
      }),
    );
    const hashes = await Promise.all(paths.map(async (p) => digest(await readFile(join(root, p)))));
    await assert.rejects(store.recoverPlaintextWriter(paths[0]!, hashes[0]!), /LOCK_OWNER_ALIVE/);
    child.kill('SIGKILL');
    const [code, signal] = await ended;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    await assert.rejects(assertNoPlaintextWriters(root), /PLAINTEXT_WRITERS_ACTIVE/);
    await assert.rejects(store.recoverPlaintextWriter(paths[0]!, '0'.repeat(64)), /LOCK_CHANGED/);
    await store.recoverPlaintextWriter(paths[0]!, hashes[0]!);
    await assert.rejects(assertNoPlaintextWriters(root), /PLAINTEXT_WRITERS_ACTIVE/);
    await store.recoverPlaintextWriter(paths[1]!, hashes[1]!);
    await assertNoPlaintextWriters(root);
    assert.equal(await readFile(source, 'utf8'), 'synthetic source');
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended;
    await rm(root, { recursive: true, force: true });
  }
});

test('writer recovery rejects legacy, unknown scope, mismatched filename and unsafe paths', {
  skip,
}, async () => {
  const { root, store } = await fixture();
  const name = `2147483647-${uuid}`,
    path = join(PLAINTEXT_WRITERS, name);
  try {
    for (const record of [
      { pid: 2147483647 },
      {
        format: 'a0-plaintext-writer-1',
        owner: { ...(await processLockRecord()), pid: 2147483647, scope: null },
      },
      {
        format: 'a0-plaintext-writer-1',
        owner: { ...(await processLockRecord()), pid: process.pid },
      },
    ]) {
      const bytes = JSON.stringify(record);
      await writeFile(join(root, path), bytes);
      await assert.rejects(
        store.recoverPlaintextWriter(path, await digest(new TextEncoder().encode(bytes))),
        /INVALID_WRITER_LEASE|LOCK_OWNER_UNVERIFIABLE/,
      );
      assert.equal(await readFile(join(root, path), 'utf8'), bytes);
    }
    for (const path of [
      '../outside',
      '/outside',
      'main.a0',
      `${PLAINTEXT_WRITERS}/wrong`,
      `other/${name}`,
    ])
      await assert.rejects(
        store.recoverPlaintextWriter(path, '0'.repeat(64)),
        /UNSAFE_PATH|INVALID_WRITER_LEASE/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writer recovery preserves hard links, symlinks, and files guarded by another recovery', {
  skip,
}, async () => {
  const { root, store } = await fixture();
  const name = `2147483647-${uuid}`,
    path = join(PLAINTEXT_WRITERS, name),
    target = join(root, 'other');
  const bytes = JSON.stringify({
    format: 'a0-plaintext-writer-1',
    owner: { ...(await processLockRecord()), pid: 2147483647 },
  });
  const hash = await digest(new TextEncoder().encode(bytes));
  try {
    await writeFile(target, bytes);
    await symlink(target, join(root, path));
    await assert.rejects(store.recoverPlaintextWriter(path, hash));
    await rm(join(root, path));
    await link(target, join(root, path));
    await assert.rejects(store.recoverPlaintextWriter(path, hash), /INVALID_LOCK/);
    await rm(join(root, path));
    await writeFile(join(root, path), bytes);
    await writeFile(join(store.dir, 'recover.lock'), 'another owner');
    await assert.rejects(store.recoverPlaintextWriter(path, hash), /RECOVERY_LOCKED/);
    assert.equal(await readFile(join(root, path), 'utf8'), bytes);
    assert.equal(await readFile(target, 'utf8'), bytes);
    await rm(join(store.dir, 'recover.lock'));
    await rm(join(root, PLAINTEXT_WRITERS), { recursive: true });
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, PLAINTEXT_WRITERS));
    await assert.rejects(store.recoverPlaintextWriter(path, hash), /SYMLINK_OR_NON_DIRECTORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
