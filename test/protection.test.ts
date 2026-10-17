import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { decodeProtectedHeader } from 'jose';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import { compileSealed, linkSealed, protectWasm } from '../src/protection/build.js';
import {
  createIdentity,
  decrypt,
  digest,
  encrypt,
  type Identity,
  type IdentityFile,
  random,
  text,
  unlockIdentity,
  unwrap,
  utf8,
  wrap,
} from '../src/protection/crypto.js';
import {
  archiveDisabledStore,
  DiskVaultStore,
  inventory,
  resumeMigration,
} from '../src/protection/disk.js';
import { importSealedProject, MemoryVaultStore } from '../src/protection/store.js';
import { type Head, SealedProject } from '../src/protection/vault.js';
import { protectionPolicy } from '../src/protection-policy.js';
import { wasmModuleBytes } from '../src/wasm.js';

const PASSWORD = utf8.encode('owned synthetic test identity only');
const DISK_SKIP =
  process.platform === 'win32'
    ? 'Durable filesystem adapter and native file controls pending on Windows'
    : false;
let file: IdentityFile, owner: Identity, other: Identity, otherFile: IdentityFile;
test.before(async () => {
  file = await createIdentity(PASSWORD);
  owner = await unlockIdentity(file, PASSWORD);
  otherFile = await createIdentity(utf8.encode('another owned synthetic test password'));
  other = await unlockIdentity(otherFile, utf8.encode('another owned synthetic test password'));
});
const SOURCE =
  '# SYNTHETIC_CONFIDENTIAL_MARKER_4638\nfn secret_step u32 -> u32\nx mul p0 1664525\ny add x 1013904223\nret y\nend\n';
async function fixture(): Promise<{ store: MemoryVaultStore; project: SealedProject }> {
  const store = new MemoryVaultStore();
  const project = await SealedProject.create(store, owner);
  await project.write('private/secret.a0', utf8.encode(SOURCE));
  return { store, project };
}
function clone(store: MemoryVaultStore): MemoryVaultStore {
  const copy = new MemoryVaultStore();
  copy.current = structuredClone(store.current);
  for (const [id, cipher] of store.objects) copy.objects.set(id, cipher);
  return copy;
}
test('recovery uses bounded PBES2 parameters, wrong passwords and public-key substitution fail', async () => {
  assert.equal(decodeProtectedHeader(file.recovery).p2c, 600_000);
  assert.equal((await unlockIdentity(structuredClone(file), PASSWORD)).id, owner.id);
  await assert.rejects(
    unlockIdentity(file, utf8.encode('incorrect password at least sixteen bytes')),
  );
  await assert.rejects(unlockIdentity({ ...file, signingKey: other.signingKey }, PASSWORD));
  await assert.rejects(createIdentity(utf8.encode('too short')));
});
test('source, names, content hashes and managed cache data stay out of stored objects and sealed exports', async () => {
  const { project, store } = await fixture();
  await project.write('managed/history', utf8.encode('sensitive history marker'), 'history');
  await compileSealed(project, 'private/secret.a0', 'wasm');
  const serialized = await project.sealedExport();
  for (const forbidden of [
    'secret_step',
    'private/secret.a0',
    'SYNTHETIC_CONFIDENTIAL',
    'sensitive history marker',
    await digest(utf8.encode(SOURCE)),
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(JSON.stringify(store.current).includes(other.id), false);
  project.lock();
  await assert.rejects(project.read('private/secret.a0'), /LOCKED/);
});
test('independent random encryption preserves reproducible compiled bytes and unchanged edits write nothing', async () => {
  const a = await fixture(),
    b = await fixture();
  assert.notEqual(await a.project.sealedExport(), await b.project.sealedExport());
  const before = a.store.objects.size;
  await a.project.write('private/secret.a0', utf8.encode(SOURCE));
  assert.equal(a.store.objects.size, before);
  const first = await compileSealed(a.project, 'private/secret.a0', 'wasm');
  const second = await compileSealed(b.project, 'private/secret.a0', 'wasm');
  assert.deepEqual(first, second);
  assert.deepEqual(first, wasmModuleBytes(compile(parseAndValidate(SOURCE), 'wasm').text));
});
test('sharing requires owner authority; recipient writes authenticate, revocation rotates all active data', async () => {
  const { project, store } = await fixture();
  await assert.rejects(
    SealedProject.unlock(store, owner, 'incorrect explicit fingerprint'),
    /FINGERPRINT_MISMATCH/,
  );
  await project.share({ id: other.id, publicKey: other.publicKey, signingKey: other.signingKey });
  await assert.rejects(SealedProject.unlock(store, other), /TRUSTED_PROJECT/);
  const recipient = await SealedProject.unlock(store, other, project.status.project);
  await recipient.write('private/secret.a0', utf8.encode(SOURCE.replace('1664525', '1664527')));
  await assert.rejects(recipient.rotate(), /PROJECT_OWNER/);
  const current = await SealedProject.unlock(store, owner);
  const old = clone(store);
  const epoch = store.current?.epoch;
  await current.rotate(other.id);
  assert.notEqual(store.current?.epoch, epoch);
  await assert.rejects(SealedProject.unlock(store, other, current.status.project), /RECIPIENT/);
  const oldRecipient = await SealedProject.unlock(old, other, current.status.project);
  assert.match(
    await oldRecipient.sourceAccess('local-editor').read('private/secret.a0'),
    /1664527/,
  );
  oldRecipient.lock();
  current.lock();
  project.lock();
});
test('tampered ciphertext, context, removed grants and forged public-key grants fail closed', async () => {
  const { project, store } = await fixture();
  const original = clone(store);
  const object = project.entries()['private/secret.a0']?.object as string;
  const cipher = store.objects.get(object) as string;
  store.objects.set(object, `${cipher.slice(0, -8)}AAAAAAAA`);
  await assert.rejects(project.read('private/secret.a0'));
  for (const field of ['phase', 'revision', 'manifest', 'grants'] as const) {
    const copy = clone(original);
    const h = copy.current as Head;
    copy.current = {
      ...h,
      [field]: field === 'phase' ? 'off' : field === 'grants' ? [] : '0'.repeat(48),
    };
    await assert.rejects(SealedProject.unlock(copy, owner), field);
  }
  const foreign = await fixture();
  const copy = clone(original);
  copy.current = { ...(copy.current as Head), grants: foreign.store.current?.grants ?? [] };
  await assert.rejects(SealedProject.unlock(copy, owner));
});
test('sealed export/import authenticates all data before committing and contains no private keys', async () => {
  const { project } = await fixture();
  const data = await project.sealedExport();
  const store = new MemoryVaultStore();
  const imported = await importSealedProject(store, data, owner);
  assert.equal(await imported.sourceAccess('local-terminal').read('private/secret.a0'), SOURCE);
  assert.equal(data.includes(file.recovery), false);
  assert.equal(data.includes('signingPrivateKey'), false);
  const parsed = JSON.parse(data);
  const id = Object.keys(parsed.objects)[1] as string;
  parsed.objects[id] = 'invalid';
  const rejected = new MemoryVaultStore();
  await assert.rejects(importSealedProject(rejected, JSON.stringify(parsed), owner));
  assert.equal(await rejected.head(), undefined);
});
test('external AI disclosure is owner-approved, path-bound, expiring and revoked by lock', async () => {
  const { project } = await fixture();
  await assert.rejects(project.sourceAccess('external-ai').read('private/secret.a0'), /DISCLOSURE/);
  const request = {
    project: project.status.project,
    recipient: 'synthetic-test-consumer',
    paths: ['private/secret.a0'],
    expires: Date.now() + 10000,
  };
  await assert.rejects(
    project.approveDisclosure(request, async () => false),
    /DISCLOSURE/,
  );
  const token = await project.approveDisclosure(request, async () => true);
  const access = project.sourceAccess('external-ai', token);
  assert.equal(await access.read('private/secret.a0'), SOURCE);
  await assert.rejects(access.read('other.a0'), /DISCLOSURE/);
  project.lock();
  await assert.rejects(access.read('private/secret.a0'), /LOCKED/);
});
test('concurrent writers lose CAS without partial state; failed sessions must reopen', async () => {
  const { project, store } = await fixture();
  const stale = await SealedProject.unlock(store, owner);
  await project.write('other.a0', utf8.encode(SOURCE));
  await assert.rejects(stale.write('wrong.a0', utf8.encode(SOURCE)), /CONCURRENT/);
  assert.equal(stale.status.locked, true);
  const durable = await SealedProject.unlock(store, owner);
  assert.equal(durable.entries()['wrong.a0'], undefined);
  assert.ok(durable.entries()['other.a0']);
});
test('a changed edit encrypts only that object plus its manifest; existing objects remain unchanged', async () => {
  const { project, store } = await fixture();
  await project.write('other.a0', utf8.encode(SOURCE));
  const old = project.entries()['other.a0'];
  const before = new Map(store.objects);
  await project.write('private/secret.a0', utf8.encode(SOURCE.replace('1664525', '1664527')));
  assert.deepEqual(project.entries()['other.a0'], old);
  assert.equal(store.objects.size - before.size, 2);
  for (const [id, cipher] of before) assert.equal(store.objects.get(id), cipher);
});
test('sealed virtual imports use the existing frontend and preserve normal-source semantics', async () => {
  const { project } = await fixture();
  await project.write(
    'main.a0',
    utf8.encode('use "private/secret.a0"\nfn main u32 -> u32\nx secret_step p0\nret x\nend\n'),
  );
  const linked = await linkSealed(project, 'main.a0');
  const fn = linked.program.byName.get('main');
  assert.ok(fn);
  assert.equal(run(fn, [7]), (7 * 1664525 + 1013904223) >>> 0);
  for (const target of [
    'c',
    'js',
    'java',
    'sv',
    'arm64',
    'x86_64',
    'riscv64',
    'avr',
    'arm32',
  ] as const)
    await assert.rejects(
      compileSealed(project, 'main.a0', target, { protect: true }),
      /TARGET_PROTECTION_PENDING/,
    );
});
function custom(name: string, value: string): Uint8Array {
  const n = utf8.encode(name),
    v = utf8.encode(value);
  const payload = new Uint8Array([n.length, ...n, ...v]);
  assert.ok(payload.length < 128);
  return new Uint8Array([0, payload.length, ...payload]);
}
test('Wasm adapter removes only debug/source artifacts and preserves APIs, licenses and behavior', async () => {
  const baseline = wasmModuleBytes(compile(parseAndValidate(SOURCE), 'wasm').text);
  const bytes = new Uint8Array([
    ...baseline,
    ...custom('.debug_info', 'private source marker'),
    ...custom('license', 'Apache-2.0'),
    ...custom('reflection', 'secret_step'),
  ]);
  const protectedResult = protectWasm(bytes);
  assert.equal(protectedResult.privateDebug.length, 1);
  assert.ok(protectedResult.bytes.length < bytes.length);
  const original = await WebAssembly.instantiate(bytes),
    release = await WebAssembly.instantiate(protectedResult.bytes as BufferSource);
  assert.deepEqual(Object.keys(original.instance.exports), Object.keys(release.instance.exports));
  const a = original.instance.exports.a0_secret_step as (x: number) => number;
  const b = release.instance.exports.a0_secret_step as (x: number) => number;
  for (const input of [0, 1, 7, 0x80000000, 0xffffffff]) assert.equal(b(input), a(input));
  assert.equal(
    text.decode(WebAssembly.Module.customSections(release.module, 'license')[0] as ArrayBuffer),
    'Apache-2.0',
  );
  assert.equal(
    text.decode(WebAssembly.Module.customSections(release.module, 'reflection')[0] as ArrayBuffer),
    'secret_step',
  );
});
test('disk migration round trip, managed-cache leaks, policy fail-closed and symlink rejection', {
  skip: DISK_SKIP,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-protection-'));
  try {
    await mkdir(join(root, 'private'));
    await mkdir(join(root, '.a0-cache'));
    await writeFile(join(root, 'private/secret.a0'), SOURCE);
    await writeFile(join(root, '.a0-cache/entry'), 'sensitive-cache-marker');
    const plan = await inventory(root);
    const store = new DiskVaultStore(root);
    await store.initialize();
    const project = await SealedProject.create(store, owner, {
      direction: 'on',
      stage: 'copy',
      items: plan.items,
    });
    assert.throws(() => protectionPolicy(root), /SEALED/);
    await resumeMigration(project, root);
    assert.equal((await inventory(root)).items.length, 0);
    assert.equal((await readdir(root)).includes('private'), false);
    for (const id of await readdir(join(root, '.a0-seal/objects'))) {
      const raw = await readFile(join(root, '.a0-seal/objects', id), 'utf8');
      assert.equal(raw.includes('sensitive-cache-marker'), false);
      assert.equal(raw.includes('secret_step'), false);
    }
    await project.setMigration('unsealing', { direction: 'off', stage: 'copy', items: plan.items });
    await resumeMigration(project, root);
    await archiveDisabledStore(store);
    assert.equal(protectionPolicy(root).protect, false);
    assert.equal(await readFile(join(root, 'private/secret.a0'), 'utf8'), SOURCE);
    if (process.platform !== 'win32') {
      await symlink('private/secret.a0', join(root, 'link.a0'));
      await assert.rejects(inventory(root), /SYMLINK/);
    }
    project.lock();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('crashes during every migration checkpoint resume from the authenticated durable journal', {
  timeout: 120000,
  skip:
    process.platform === 'win32'
      ? 'POSIX crash/durable filesystem adapter; Windows conformance pending'
      : false,
}, async () => {
  for (const { direction, stop } of [
    ...Array.from({ length: 5 }, (_, i) => ({ direction: 'on', stop: i + 1 })),
    ...Array.from({ length: 2 }, (_, i) => ({ direction: 'off', stop: i + 1 })),
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'a0-seal-crash-'));
    try {
      await writeFile(join(root, 'a.a0'), SOURCE);
      await writeFile(join(root, 'b.a0'), SOURCE);
      const plan = await inventory(root),
        store = new DiskVaultStore(root);
      await store.initialize();
      const project = await SealedProject.create(store, owner, {
        direction: 'on',
        stage: 'copy',
        items: plan.items,
      });
      if (direction === 'off') {
        await resumeMigration(project, root);
        await project.setMigration('unsealing', {
          direction: 'off',
          stage: 'copy',
          items: plan.items,
        });
      }
      project.lock();
      const script = `import {SealedProject} from ${JSON.stringify(new URL('../src/protection/vault.js', import.meta.url).href)};
import {unlockIdentity,utf8} from ${JSON.stringify(new URL('../src/protection/crypto.js', import.meta.url).href)};
import {DiskVaultStore,resumeMigration} from ${JSON.stringify(new URL('../src/protection/disk.js', import.meta.url).href)};
const id=await unlockIdentity(JSON.parse(process.env.A0_TEST_IDENTITY),utf8.encode('owned synthetic test identity only'));
const p=await SealedProject.unlock(new DiskVaultStore(process.argv[1]),id);let n=0;
await resumeMigration(p,process.argv[1],async()=>{if(++n===Number(process.argv[2]))process.kill(process.pid,'SIGKILL')});`;
      const child = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script, root, String(stop)],
        { env: { ...process.env, A0_TEST_IDENTITY: JSON.stringify(file) }, timeout: 30000 },
      );
      assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
      const recovered = await SealedProject.unlock(store, owner);
      await resumeMigration(recovered, root);
      assert.equal(await recovered.sourceAccess('local-terminal').read('a.a0'), SOURCE);
      if (direction === 'off') {
        assert.throws(() => protectionPolicy(root), /SEALED/);
        await archiveDisabledStore(store);
        assert.equal(await readFile(join(root, 'a.a0'), 'utf8'), SOURCE);
        assert.equal(recovered.status.phase, 'off');
      } else {
        assert.equal((await inventory(root)).items.length, 0);
        assert.equal(recovered.status.phase, 'on');
      }
      recovered.lock();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('inventory follows authoritative use dependencies and seals owner-selected sensitive metadata', {
  skip: DISK_SKIP,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-seal-dependencies-'));
  try {
    await mkdir(join(root, 'node_modules/private-lib'), { recursive: true });
    await writeFile(
      join(root, 'node_modules/private-lib/util.a0'),
      'fn util u32 -> u32\nx add p0 3\nret x\nend\n',
    );
    await writeFile(
      join(root, 'main.a0'),
      'use "node_modules/private-lib/util.a0"\nfn main u32 -> u32\nx util p0\nret x\nend\n',
    );
    const metadata = '{"secret":"SYNTHETIC_METADATA_SECRET_1072"}\n';
    await writeFile(join(root, 'private.json'), metadata);
    const plan = await inventory(root, ['private.json']);
    assert.equal(plan.items.length, 3);
    assert.deepEqual(plan.incompleteGraphs, []);
    const store = new DiskVaultStore(root);
    await store.initialize();
    const project = await SealedProject.create(store, owner, {
      direction: 'on',
      stage: 'copy',
      items: plan.items,
    });
    await resumeMigration(project, root);
    assert.equal(text.decode(await project.read('private.json')), metadata);
    const bytes = await compileSealed(project, 'main.a0', 'wasm');
    assert.equal(Buffer.from(bytes).includes(Buffer.from('SYNTHETIC_METADATA_SECRET')), false);
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource);
    assert.equal((instance.exports.a0_main as (n: number) => number)(7), 10);
    assert.equal((await project.sealedExport()).includes('private.json'), false);
    project.lock();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UTF-8 source views preserve BOM and line endings, and exclude non-source managed records', async () => {
  const { project } = await fixture();
  const source = '\ufeff' + SOURCE.replaceAll('\n', '\r\n');
  await project.write('bom.a0', utf8.encode(source));
  assert.equal(await project.sourceAccess('local-editor').read('bom.a0'), source);
  await project.write('history.a0', utf8.encode('private history'), 'history');
  await assert.rejects(project.sourceAccess('local-editor').read('history.a0'), /NOT_SOURCE/);
  project.lock();
});
test('native control keygen/unlock uses distinct supplied passwords and default controls stay off', {
  skip: DISK_SKIP,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-controls-'));
  try {
    const cli = resolve('dist/src/cli.js');
    const key = join(root, 'owner.json');
    const pass = join(root, 'synthetic-password');
    await writeFile(pass, PASSWORD, { mode: 0o600 });
    const fd = openSync(pass, 'r');
    const r = spawnSync(
      process.execPath,
      [cli, 'seal', 'keygen', `--key=${key}`, '--password-fd=3'],
      { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 30000 },
    );
    closeSync(fd);
    assert.equal(r.status, 0, r.stderr?.toString());
    const created = JSON.parse(await readFile(key, 'utf8')) as IdentityFile;
    assert.equal((await unlockIdentity(created, PASSWORD)).id, created.id);
    await assert.rejects(unlockIdentity(created, utf8.encode('a different synthetic password')));
    const status = spawnSync(process.execPath, [cli, 'protect', 'status', root], {
      encoding: 'utf8',
    });
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).protect, false);
    const seal = spawnSync(process.execPath, [cli, 'seal', 'status', root], { encoding: 'utf8' });
    assert.equal(seal.status, 0);
    assert.equal(JSON.parse(seal.stdout).seal, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public recipient encryption cannot counterfeit an owner-authorized project', async () => {
  const { store, project } = await fixture();
  const h = store.current as Head;
  const originalKey = await unwrap(h.grants[0] as string, owner, { ...h, object: 'grant' });
  const signedBytes = await decrypt(await store.get(h.manifest), originalKey, {
    ...h,
    object: h.manifest,
  });
  const replacementKey = random();
  const changed = {
    ...h,
    grants: [await wrap(replacementKey, owner.publicKey, { ...h, object: 'grant' })],
  };
  store.objects.set(
    h.manifest,
    await encrypt(signedBytes, replacementKey, { ...changed, object: h.manifest }),
  );
  store.current = changed;
  await assert.rejects(SealedProject.unlock(store, owner), /INVALID_AUTHORIZATION/);
  signedBytes.fill(0);
  originalKey.fill(0);
  replacementKey.fill(0);
  project.lock();
});

test('source-only output matches all existing target emitters, including compiler options and encrypted cache failures', async () => {
  const { store, project } = await fixture();
  for (const target of [
    'js',
    'c',
    'java',
    'sv',
    'arm64',
    'x86_64',
    'riscv64',
    'avr',
    'wasm',
    'arm32',
  ] as const) {
    const output = await compileSealed(project, 'private/secret.a0', target);
    const reference = compile(parseAndValidate(SOURCE), target).text;
    assert.deepEqual(
      output,
      target === 'wasm' ? wasmModuleBytes(reference) : utf8.encode(reference),
    );
  }
  const options = { ioOutputCapacity: 2048, wasmSimd: false, wasmUnroll: 2 as const };
  assert.deepEqual(
    await compileSealed(project, 'private/secret.a0', 'wasm', { profile: 'strict' }),
    wasmModuleBytes(compile(parseAndValidate('profile strict\n' + SOURCE), 'wasm').text),
  );
  await project.write(
    'trapping.a0',
    utf8.encode('fn divided u32 u32 -> u32\nx div p0 p1\nret x\nend\n'),
  );
  await assert.rejects(
    compileSealed(project, 'trapping.a0', 'sv', { profile: 'strict' }),
    /strict|support|trap/,
  );
  assert.deepEqual(
    await compileSealed(project, 'private/secret.a0', 'wasm', { compilerOptions: options }),
    wasmModuleBytes(compile(parseAndValidate(SOURCE), 'wasm', options).text),
  );
  const entry = Object.values(project.entries()).find((e) => e.role === 'cache');
  assert.ok(entry);
  store.objects.set(entry.object, 'tampered cache');
  // Select its target's default cache entry; at least that requested cache read must fail, never fall back.
  await assert.rejects(compileSealed(project, 'private/secret.a0', 'js'));
});

test('failed CAS before and after head persistence always reopens an authenticated complete version', async () => {
  for (const after of [false, true]) {
    class InterruptedStore extends MemoryVaultStore {
      interrupt = false;
      override async commit(expected: string | undefined, head: Head): Promise<void> {
        if (this.interrupt && !after) throw new Error('simulated interruption before durable head');
        await super.commit(expected, head);
        if (this.interrupt) throw new Error('simulated interruption after durable head');
      }
    }
    const store = new InterruptedStore(),
      p = await SealedProject.create(store, owner);
    await p.write('main.a0', utf8.encode(SOURCE));
    store.interrupt = true;
    await assert.rejects(p.write('main.a0', utf8.encode(SOURCE.replace('1664525', '1664527'))));
    assert.equal(p.status.locked, true);
    store.interrupt = false;
    const recovered = await SealedProject.unlock(store, owner);
    assert.equal(
      await recovered.sourceAccess('local-terminal').read('main.a0'),
      after ? SOURCE.replace('1664525', '1664527') : SOURCE,
    );
    recovered.lock();
  }
});

test('native encrypted editing/build/export and mode controls require approval and preserve round trips', {
  skip: DISK_SKIP,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'a0-seal-controls-'));
  try {
    const root = join(temp, 'project');
    await mkdir(root);
    const key = join(temp, 'identity.json'),
      password = join(temp, 'synthetic-password');
    await writeFile(key, JSON.stringify(file), { mode: 0o600 });
    await writeFile(password, PASSWORD, { mode: 0o600 });
    await writeFile(join(root, 'main.a0'), SOURCE);
    const call = (arguments_: string[], input = '') => {
      const fd = openSync(password, 'r');
      try {
        return spawnSync(
          process.execPath,
          [resolve('dist/src/cli.js'), ...arguments_, `--key=${key}`, '--password-fd=3'],
          { stdio: ['pipe', 'pipe', 'pipe', fd], input, encoding: 'utf8', timeout: 30000 },
        );
      } finally {
        closeSync(fd);
      }
    };
    const plan = call(['seal', 'on', root, '--plan']);
    assert.equal(plan.status, 0, plan.stderr);
    const { digest: approve } = JSON.parse(plan.stdout);
    const denied = call(['seal', 'on', root]);
    assert.notEqual(denied.status, 0);
    assert.equal(await readFile(join(root, 'main.a0'), 'utf8'), SOURCE);
    const on = call(['seal', 'on', root, `--approve=${approve}`, '--confirm-exposure']);
    assert.equal(on.status, 0, on.stderr);
    const active = await readFile(join(root, '.a0-seal/head.json'), 'utf8');
    await writeFile(
      join(root, '.a0-seal/head.json'),
      active.replace('"phase":"on"', '"phase":"off"'),
    );
    assert.throws(() => protectionPolicy(root), /SEALED/);
    await writeFile(join(root, '.a0-seal/head.json'), active);
    const session = call(
      ['seal', 'unlock', root, '--consumer=local-editor'],
      [
        { op: 'read', path: 'main.a0' },
        { op: 'check', path: 'main.a0' },
        { op: 'run', path: 'main.a0', function: 'secret_step', args: [7] },
        { op: 'build', path: 'main.a0', target: 'wasm' },
        { op: 'lock' },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    assert.equal(session.status, 0, session.stderr);
    const replies = session.stdout
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    assert.equal(replies[1].source, SOURCE);
    assert.equal(replies[2].ok, true);
    assert.equal(replies[3].value, (7 * 1664525 + 1013904223) >>> 0);
    assert.equal(WebAssembly.validate(Buffer.from(replies[4].artifact, 'base64')), true);
    const sealedExport = join(temp, 'export.a0sealed');
    assert.equal(call(['seal', 'export', root, `--out=${sealedExport}`]).status, 0);
    assert.equal((await readFile(sealedExport, 'utf8')).includes('secret_step'), false);
    const offPlan = call(['seal', 'off', root, '--plan']);
    assert.equal(offPlan.status, 0, offPlan.stderr);
    const off = call([
      'seal',
      'off',
      root,
      `--approve=${JSON.parse(offPlan.stdout).digest}`,
      '--confirm-exposure',
    ]);
    assert.equal(off.status, 0, off.stderr);
    assert.equal(await readFile(join(root, 'main.a0'), 'utf8'), SOURCE);
    assert.equal(protectionPolicy(root).protect, false);
    assert.equal((await readdir(join(root, '.a0-seal-archive'))).length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
