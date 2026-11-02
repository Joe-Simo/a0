import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite, DiskVaultStore, writeNew } from '../src/protection/disk.js';

for (const mode of ['migrateSourceProject', 'migrateProject'])
  test(`${mode} fixes relative destination and root before asynchronous work`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'a0-migration-cwd-'));
    try {
      const a = join(root, 'a'),
        b = join(root, 'b');
      await mkdir(a);
      await mkdir(b);
      const source = 'fn f -> u32\nr mov 1\nret r\nend\n';
      await writeFile(join(a, 'main.a0'), source);
      const module = new URL('../src/migrate.js', import.meta.url).href;
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {${mode}} from ${JSON.stringify(module)};const pending=${mode}(${JSON.stringify(join(a, 'main.a0'))},'out','.');process.chdir(${JSON.stringify(b)});await pending;`,
        ],
        { cwd: a, encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(child.status, 0, child.stderr);
      const manifest = JSON.parse(await readFile(join(a, 'out', 'a0-migration.json'), 'utf8'));
      assert.equal(manifest.files.length, 1);
      await assert.rejects(readFile(join(b, 'out', 'a0-migration.json')), { code: 'ENOENT' });
      assert.equal(await readFile(join(a, 'main.a0'), 'utf8'), source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('relative vault root stays bound for recovery after caller chdir', {
  skip: process.platform !== 'linux' ? 'Linux process-scope evidence required' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-vault-cwd-'));
  try {
    const a = join(root, 'a'),
      b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    const disk = new URL('../src/protection/disk.js', import.meta.url).href,
      processLock = new URL('../src/protection/process-lock.js', import.meta.url).href,
      crypto = new URL('../src/protection/crypto.js', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {mkdir,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';import {DiskVaultStore} from ${JSON.stringify(disk)};import {processLockRecord} from ${JSON.stringify(processLock)};import {digest,utf8} from ${JSON.stringify(crypto)};const a=${JSON.stringify(a)},b=${JSON.stringify(b)};for(const p of [a,b]){await mkdir(join(p,'project'));await mkdir(join(p,'project','.a0-plaintext-writers'));}const store=new DiskVaultStore('project');await store.initialize();const lease='.a0-plaintext-writers/2147483647-00000000-0000-4000-8000-000000000000';const record=JSON.stringify({format:'a0-plaintext-writer-1',owner:{...(await processLockRecord()),pid:2147483647}});for(const p of [a,b])await writeFile(join(p,'project',lease),record);process.chdir(b);await store.recoverPlaintextWriter(lease,await digest(utf8.encode(record)));console.log(JSON.stringify({root:store.projectRoot,dir:store.dir,other:await readFile(join(b,'project',lease),'utf8')}));`,
      ],
      { cwd: a, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout);
    assert.equal(out.root, join(a, 'project'));
    assert.equal(out.dir, join(a, 'project', '.a0-seal'));
    assert.equal(JSON.parse(out.other).format, 'a0-plaintext-writer-1');
    await assert.rejects(
      readFile(
        join(
          a,
          'project',
          '.a0-plaintext-writers',
          '2147483647-00000000-0000-4000-8000-000000000000',
        ),
      ),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('relative inventory and plaintext restoration keep their original project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-restore-cwd-'));
  try {
    const a = join(root, 'a'),
      b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    const disk = new URL('../src/protection/disk.js', import.meta.url).href,
      crypto = new URL('../src/protection/crypto.js', import.meta.url).href,
      vault = new URL('../src/protection/vault.js', import.meta.url).href,
      store = new URL('../src/protection/store.js', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {mkdir,writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';import {inventory,resumeMigration} from ${JSON.stringify(disk)};import {createIdentity,unlockIdentity,digest,utf8} from ${JSON.stringify(crypto)};import {SealedProject} from ${JSON.stringify(vault)};import {MemoryVaultStore} from ${JSON.stringify(store)};const a=${JSON.stringify(a)},b=${JSON.stringify(b)};const s='fn f -> u32\\nr mov 1\\nret r\\nend\\n';for(const p of [a,b])await mkdir(join(p,'project'));await writeFile(join(a,'project','main.a0'),s);await writeFile(join(b,'project','main.a0'),s.replace('mov 1','mov 2'));const scan=inventory('project');process.chdir(b);const result=await scan;if(result.items[0].hash!==await digest(utf8.encode(s)))throw new Error('inventory rebound');const pass=utf8.encode('synthetic restoration identity only');const owner=await unlockIdentity(await createIdentity(pass),pass);pass.fill(0);const p=await SealedProject.create(new MemoryVaultStore(),owner);await p.write('restored.a0',utf8.encode(s));await p.setMigration('unsealing',{direction:'off',stage:'copy',items:[{path:'restored.a0',role:'source',hash:await digest(utf8.encode(s))}]});process.chdir(a);const restoring=resumeMigration(p,'project');process.chdir(b);if(process.platform==='win32'){await restoring.then(()=>{throw new Error('unexpected durable restoration')},e=>{if(e.code!=='FILESYSTEM_DURABILITY_PENDING')throw e});p.lock();console.log('FILESYSTEM_DURABILITY_PENDING');}else{await restoring;p.lock();console.log(await readFile(join(a,'project','restored.a0'),'utf8'));}`,
      ],
      { cwd: a, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(
      child.stdout,
      process.platform === 'win32' ? /FILESYSTEM_DURABILITY_PENDING/ : /mov 1/,
    );
    if (process.platform === 'win32')
      await assert.rejects(readFile(join(a, 'project', 'restored.a0')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(b, 'project', 'restored.a0')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows durable writes refuse before creating or changing files', {
  skip: process.platform !== 'win32' ? 'Windows durability refusal contract' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-durability-refusal-'));
  try {
    const existing = join(root, 'existing');
    await writeFile(existing, 'preserved');
    for (const operation of [
      () => new DiskVaultStore(root).initialize(),
      () => atomicWrite(existing, 'replacement'),
      () => writeNew(join(root, 'new'), 'plaintext'),
    ])
      await assert.rejects(operation(), { code: 'FILESYSTEM_DURABILITY_PENDING' });
    assert.equal(await readFile(existing, 'utf8'), 'preserved');
    await assert.rejects(readFile(join(root, 'new')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(root), ['existing']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
