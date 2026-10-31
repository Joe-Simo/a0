import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSealed } from '../src/protection/build.js';
import { createIdentity, type Identity, unlockIdentity, utf8 } from '../src/protection/crypto.js';
import { MemoryVaultStore } from '../src/protection/store.js';
import { SealedProject } from '../src/protection/vault.js';

const source = 'fn f -> u32\nr mov 1\nret r\nend\n';
let owner: Identity;
test.before(async () => {
  const password = utf8.encode('synthetic session race identity only');
  owner = await unlockIdentity(await createIdentity(password), password);
  password.fill(0);
});
async function fixture(store = new MemoryVaultStore()) {
  const p = await SealedProject.create(store, owner);
  await p.write('main.a0', utf8.encode(source));
  return p;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class PausedStore extends MemoryVaultStore {
  pauseAt = 0;
  count = 0;
  entered = deferred();
  resume = deferred();
  override async put(id: string, value: string): Promise<void> {
    if (this.pauseAt !== 0 && ++this.count === this.pauseAt) {
      this.entered.resolve();
      await this.resume.promise;
    }
    return super.put(id, value);
  }
}

test('lock during read integrity check rejects and clears plaintext', async () => {
  const p = await fixture(),
    entered = deferred(),
    resume = deferred();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let captured: Uint8Array | undefined;
  crypto.subtle.digest = async (algorithm, data) => {
    if (Buffer.from(data as ArrayBuffer).toString() === source) {
      captured = data as Uint8Array;
      entered.resolve();
      await resume.promise;
    }
    return original(algorithm, data);
  };
  try {
    const reading = p.read('main.a0');
    await entered.promise;
    p.lock();
    resume.resolve();
    await assert.rejects(reading, /LOCKED/);
    assert.ok(captured);
    assert.ok(captured.every((b) => b === 0));
  } finally {
    crypto.subtle.digest = original;
    resume.resolve();
    p.lock();
  }
});
for (const cancellation of ['revoke', 'expire'] as const)
  test(`queued source write rechecks ${cancellation} before execution`, async () => {
    const store = new PausedStore(),
      p = await fixture(store);
    const expires = Date.now() + 60_000;
    const token = await p.approveDisclosure(
      { project: p.status.project, recipient: 'synthetic', paths: ['main.a0'], expires },
      async () => true,
    );
    store.pauseAt = 1;
    const first = p.write('other.a0', utf8.encode(source));
    await store.entered.promise;
    const writing = p
      .sourceAccess('external-ai', token)
      .write('main.a0', source.replace('mov 1', 'mov 2'));
    const rejected = assert.rejects(writing, /DISCLOSURE_NOT_APPROVED/);
    const now = Date.now;
    try {
      if (cancellation === 'revoke') p.revokeDisclosure(token);
      else Date.now = () => expires + 1;
      store.resume.resolve();
      await first;
      await rejected;
      const bytes = await p.read('main.a0');
      assert.equal(new TextDecoder().decode(bytes), source);
      bytes.fill(0);
    } finally {
      Date.now = now;
      store.resume.resolve();
      p.lock();
    }
  });

test('revocation before manifest commit prevents an in-flight authorized write becoming visible', async () => {
  const store = new PausedStore(),
    p = await fixture(store);
  const token = await p.approveDisclosure(
    {
      project: p.status.project,
      recipient: 'synthetic',
      paths: ['main.a0'],
      expires: Date.now() + 60_000,
    },
    async () => true,
  );
  store.pauseAt = 2;
  const writing = p
    .sourceAccess('external-ai', token)
    .write('main.a0', source.replace('mov 1', 'mov 2'));
  const rejected = assert.rejects(writing, /DISCLOSURE_NOT_APPROVED/);
  await store.entered.promise;
  p.revokeDisclosure(token);
  store.resume.resolve();
  await rejected;
  assert.equal(p.status.locked, true);
  const reopened = await SealedProject.unlock(store, owner);
  try {
    const bytes = await reopened.read('main.a0');
    assert.equal(new TextDecoder().decode(bytes), source);
    bytes.fill(0);
  } finally {
    reopened.lock();
    p.lock();
  }
});
for (const cancellation of ['lock', 'migration'] as const)
  test(`uncached sealed build rechecks ${cancellation} after source hashing`, async () => {
    const p = await fixture(),
      entered = deferred(),
      resume = deferred();
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let matches = 0;
    crypto.subtle.digest = async (algorithm, data) => {
      if (Buffer.from(data as ArrayBuffer).toString() === source && ++matches === 2) {
        entered.resolve();
        await resume.promise;
      }
      return original(algorithm, data);
    };
    try {
      const building = compileSealed(p, 'main.a0', 'wasm', { cache: false });
      const rejected = assert.rejects(
        building,
        cancellation === 'lock' ? /LOCKED/ : /MIGRATION_IN_PROGRESS/,
      );
      await entered.promise;
      if (cancellation === 'lock') p.lock();
      else await p.setMigration('unsealing', { direction: 'off', stage: 'copy', items: [] });
      resume.resolve();
      await rejected;
    } finally {
      crypto.subtle.digest = original;
      resume.resolve();
      p.lock();
    }
  });

test('queued source write refuses an owner transition into migration', async () => {
  const p = await fixture();
  try {
    const token = await p.approveDisclosure(
      {
        project: p.status.project,
        recipient: 'synthetic',
        paths: ['main.a0'],
        expires: Date.now() + 60_000,
      },
      async () => true,
    );
    const transition = p.setMigration('unsealing', { direction: 'off', stage: 'copy', items: [] });
    const writing = p
      .sourceAccess('external-ai', token)
      .write('main.a0', source.replace('mov 1', 'mov 2'));
    const refused = assert.rejects(writing, /MIGRATION_IN_PROGRESS/);
    await transition;
    await refused;
    const bytes = await p.read('main.a0');
    assert.equal(new TextDecoder().decode(bytes), source);
    bytes.fill(0);
  } finally {
    p.lock();
  }
});
