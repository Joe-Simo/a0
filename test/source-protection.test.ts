import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from '../src/backends.js';
import { DiskCache } from '../src/cache.js';
import { run } from '../src/core.js';
import { programRevision } from '../src/edit.js';
import { migrateSourceProject } from '../src/migrate.js';
import { compileSealed, linkSealed } from '../src/protection/build.js';
import { createIdentity, unlockIdentity, utf8 } from '../src/protection/crypto.js';
import {
  archiveDisabledStore,
  DiskVaultStore,
  inventory,
  resumeMigration,
} from '../src/protection/disk.js';
import { importSealedProject, MemoryVaultStore } from '../src/protection/store.js';
import { SealedProject } from '../src/protection/vault.js';
import { protectionPolicy } from '../src/protection-policy.js';
import { parseSource } from '../src/source.js';
import { sourceMcpFrontend } from '../src/source-edit.js';
import { wasmModuleBytes } from '../src/wasm.js';

const password = utf8.encode('synthetic source-boundary test identity only');
const identityFile = createIdentity(password);
const owner = identityFile.then((file) => unlockIdentity(file, password));
const helper = '# SYNTHETIC_SEALED_SOURCE_8142\nfn inc\nret add A 1\nend\n';
const main = 'use "lib.a0"\nfn main\nx inc A\nret x\nend\n';
const uses = (source: string) => parseSource(source).uses ?? [];
const mod = (path: string) => pathToFileURL(resolve(path)).href;

async function memory() {
  const store = new MemoryVaultStore(),
    project = await SealedProject.create(store, await owner);
  await project.write('lib.a0', utf8.encode(helper));
  await project.write('main.a0', utf8.encode(main));
  return { store, project };
}

test('candidate sealed linking/building preserves outputs with encrypted caches and export', async () => {
  const { store, project } = await memory();
  try {
    const linked = await linkSealed(project, 'main.a0', undefined, sourceMcpFrontend);
    const entry = linked.program.byName.get('main');
    assert.ok(entry);
    assert.equal(run(entry, [7]), 8);
    for (const target of ['c', 'js', 'wasm'] as const) {
      const expected = compile(linked.program, target).text;
      const bytes = await compileSealed(project, 'main.a0', target, {
        frontend: sourceMcpFrontend,
      });
      assert.deepEqual(
        bytes,
        target === 'wasm' ? wasmModuleBytes(expected) : utf8.encode(expected),
      );
    }
    assert.ok(Object.values(project.entries()).some((e) => e.role === 'cache'));
    await project.write('trap.a0', utf8.encode('fn trap\nx div A 0\nret x\nend'));
    const strict = await linkSealed(project, 'trap.a0', 'strict', sourceMcpFrontend);
    const trap = strict.program.byName.get('trap');
    assert.ok(trap);
    assert.throws(() => run(trap, [1]), /zero/i);
    const sealed = await project.sealedExport();
    for (const forbidden of [
      'SYNTHETIC_SEALED_SOURCE_8142',
      'main.a0',
      'lib.a0',
      'managed-cache',
    ]) {
      assert.equal(sealed.includes(forbidden), false);
      assert.equal(
        [...store.objects.values()].some((value) => value.includes(forbidden)),
        false,
      );
    }
    const restored = await importSealedProject(new MemoryVaultStore(), sealed, await owner);
    assert.equal(
      programRevision(
        (await linkSealed(restored, 'main.a0', undefined, sourceMcpFrontend)).program,
      ),
      programRevision(linked.program),
    );
    restored.lock();
  } finally {
    project.lock();
  }
});

test('sealed linking rejects same-session source changes during asynchronous linking', async () => {
  const { project } = await memory();
  let changed = false;
  try {
    await assert.rejects(
      linkSealed(project, 'main.a0', undefined, {
        async link(entry, read, options) {
          return sourceMcpFrontend.link(
            entry,
            async (path) => {
              const source = await read(path);
              if (!changed) {
                changed = true;
                await project.write('lib.a0', utf8.encode(helper.replace('1', '2')));
              }
              return source;
            },
            options,
          );
        },
      }),
      /CONCURRENT_CHANGE/,
    );
  } finally {
    project.lock();
  }
});

test('candidate legacy import, sealing and interrupted restoration preserve source and the fence', {
  skip: process.platform === 'win32' ? 'durable Windows filesystem adapter remains pending' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-sealed-candidate-'));
  let project: SealedProject | undefined;
  try {
    const legacy = join(root, 'legacy'),
      converted = join(root, 'converted');
    await mkdir(join(legacy, 'node_modules/private-lib'), { recursive: true });
    await writeFile(
      join(legacy, 'main.a0'),
      'use "node_modules/private-lib/lib.a0"\nfn main u32 -> u32\nx call inc p0\nret x\nend',
    );
    await writeFile(
      join(legacy, 'node_modules/private-lib/lib.a0'),
      '# SYNTHETIC_SEALED_SOURCE_8142\nfn inc u32 -> u32\nret add p0 1\nend',
    );
    await migrateSourceProject(join(legacy, 'main.a0'), converted, legacy);
    const expectedMain = await readFile(join(converted, 'main.a0'), 'utf8');
    const expectedHelper = await readFile(
      join(converted, 'node_modules/private-lib/lib.a0'),
      'utf8',
    );
    const plan = await inventory(converted, [], uses);
    assert.deepEqual(plan.incompleteGraphs, []);
    assert.equal(plan.items.length, 2);
    const store = new DiskVaultStore(converted);
    await store.initialize();
    project = await SealedProject.create(store, await owner, {
      direction: 'on',
      stage: 'copy',
      items: plan.items,
    });
    await resumeMigration(project, converted, undefined, uses);
    await assert.rejects(access(join(converted, 'main.a0')));
    assert.throws(() => protectionPolicy(converted), /SEALED/);
    const hook = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', cliScript, JSON.stringify(['hook'])],
      {
        input: JSON.stringify({ cwd: converted, tool_input: { file_path: 'main.a0' } }),
        encoding: 'utf8',
      },
    );
    assert.equal(JSON.parse(hook.stdout).decision, 'block');
    assert.match(hook.stdout, /SEALED/);
    assert.equal(hook.stdout.includes('SYNTHETIC_SEALED_SOURCE_8142'), false);
    const refusedDestination = join(root, 'refused');
    const migration = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        cliScript,
        JSON.stringify(['migrate', join(converted, 'main.a0'), refusedDestination]),
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(migration.status, 0);
    await assert.rejects(access(refusedDestination));

    await assert.rejects(
      new DiskCache(join(root, 'external-cache'), join(converted, 'main.a0')).put(
        'synthetic-key',
        'secret',
      ),
      /SEALED/,
    );
    const linked = await linkSealed(project, 'main.a0', undefined, sourceMcpFrontend);
    const entry = linked.program.byName.get('main');
    assert.ok(entry);
    assert.equal(run(entry, [7]), 8);
    await compileSealed(project, 'main.a0', 'wasm', { frontend: sourceMcpFrontend });
    const keyPath = join(root, 'synthetic-owner.json'),
      passwordPath = join(root, 'synthetic-password');
    await writeFile(keyPath, JSON.stringify(await identityFile), { mode: 0o600 });
    await writeFile(passwordPath, password, { mode: 0o600 });
    const fd = openSync(passwordPath, 'r');
    let unlocked: SpawnSyncReturns<string>;
    try {
      unlocked = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          cliScript,
          JSON.stringify([
            'seal',
            'unlock',
            converted,
            '--consumer=local-terminal',
            `--key=${keyPath}`,
            '--password-fd=3',
          ]),
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe', fd],
          encoding: 'utf8',
          timeout: 30000,
          input: `${JSON.stringify({ op: 'run', path: 'main.a0', function: 'main', args: [7] })}\n${JSON.stringify({ op: 'lock' })}\n`,
        },
      );
    } finally {
      closeSync(fd);
    }
    assert.equal(unlocked.status, 0, unlocked.stderr);
    const replies = unlocked.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(replies[1].value, 8);
    assert.equal(unlocked.stdout.includes('SYNTHETIC_SEALED_SOURCE_8142'), false);

    const items = Object.entries(project.entries())
      .filter(([, e]) => e.role === 'source')
      .map(([path, e]) => ({ path, role: e.role, hash: e.hash }));
    await project.setMigration('unsealing', { direction: 'off', stage: 'copy', items });
    await assert.rejects(
      resumeMigration(
        project,
        converted,
        async (step) => {
          if (step === 'restore') throw new Error('synthetic interruption');
        },
        uses,
      ),
      /synthetic interruption/,
    );
    assert.throws(() => protectionPolicy(converted), /SEALED/);
    project.lock();
    project = await SealedProject.unlock(new DiskVaultStore(converted), await owner);
    await resumeMigration(project, converted, undefined, uses);
    await archiveDisabledStore(new DiskVaultStore(converted));
    assert.equal(await readFile(join(converted, 'main.a0'), 'utf8'), expectedMain);
    assert.equal(
      await readFile(join(converted, 'node_modules/private-lib/lib.a0'), 'utf8'),
      expectedHelper,
    );
    assert.equal((await readdir(root)).includes('external-cache'), false);
    assert.match(await readFile(join(legacy, 'main.a0'), 'utf8'), /u32/);
  } finally {
    project?.lock();
    await rm(root, { recursive: true, force: true });
  }
});

const cliScript = `import {main,reportCliError} from ${JSON.stringify(mod('dist/src/cli-main.js'))};import {sourceMcpFrontend} from ${JSON.stringify(mod('dist/src/source-edit.js'))};await main(JSON.parse(process.argv[1]),sourceMcpFrontend).catch(reportCliError);`;

test('candidate hook uses the bound reader; candidate seal plans discover excluded dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-source-hook-'));
  try {
    await mkdir(join(root, 'node_modules/private-lib'), { recursive: true });
    await writeFile(
      join(root, 'main.a0'),
      main.replace('lib.a0', 'node_modules/private-lib/lib.a0'),
    );
    await writeFile(join(root, 'node_modules/private-lib/lib.a0'), helper);
    const hook = (path: string) =>
      spawnSync(
        process.execPath,
        ['--input-type=module', '-e', cliScript, JSON.stringify(['hook'])],
        { input: JSON.stringify({ cwd: root, tool_input: { file_path: path } }), encoding: 'utf8' },
      );
    assert.equal(hook('main.a0').stdout, '');
    const plan = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', cliScript, JSON.stringify(['seal', 'on', root, '--plan'])],
      { encoding: 'utf8' },
    );
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).files, 2);
    await writeFile(join(root, 'main.a0'), 'fn broken\nx add A missing\nret x\nend');
    const bad = hook('main.a0');
    assert.equal(JSON.parse(bad.stdout).decision, 'block');
    assert.match(bad.stdout, /missing/);
    await writeFile(join(root, 'main.a0'), 'fn broken ->\nend');
    const refused = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', cliScript, JSON.stringify(['seal', 'on', root, '--plan'])],
      { encoding: 'utf8' },
    );
    // An invalid graph cannot yield a partial candidate sealing plan.
    assert.notEqual(refused.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate unlocked protocol binds checks/builds and omits plaintext from errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-source-session-'));
  try {
    const script = `import{createIdentity,unlockIdentity,utf8}from${JSON.stringify(mod('dist/src/protection/crypto.js'))};
import{MemoryVaultStore}from${JSON.stringify(mod('dist/src/protection/store.js'))};
import{SealedProject}from${JSON.stringify(mod('dist/src/protection/vault.js'))};
import{serveUnlocked}from${JSON.stringify(mod('dist/src/protection/cli.js'))};
import{sourceMcpFrontend}from${JSON.stringify(mod('dist/src/source-edit.js'))};
const password=utf8.encode('synthetic session identity only');
const identity=await unlockIdentity(await createIdentity(password),password);
const project=await SealedProject.create(new MemoryVaultStore(),identity);
await project.write('lib.a0',utf8.encode(${JSON.stringify(helper)}));
await project.write('main.a0',utf8.encode(${JSON.stringify(main)}));
await serveUnlocked(project,process.argv[1],'local-terminal',undefined,sourceMcpFrontend);`;
    const requests = [
      { op: 'check', path: 'main.a0' },
      { op: 'run', path: 'main.a0', function: 'main', args: [7], reader: 'legacy' },
      { op: 'build', path: 'main.a0', target: 'wasm' },
      { op: 'build', path: 'main.a0', target: 'c' },
      {
        op: 'write',
        path: 'main.a0',
        source: '# SYNTHETIC_ERROR_MARKER\nfn confidential_name\nx add A missing\nret x\nend',
      },
      { op: 'check', path: 'main.a0' },
      { op: 'lock' },
    ];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], {
      input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows[1].ok, true);
    assert.equal(rows[2].value, 8);
    assert.ok(typeof rows[3].artifact === 'string');
    assert.deepEqual(rows[4], { ok: false, code: 'PLAINTEXT_ARTIFACT_CONFIRMATION_REQUIRED' });
    assert.equal(rows[6].ok, false);
    assert.equal(typeof rows[6].code, 'string');
    assert.deepEqual(rows[7], { ok: true, locked: true });
    for (const marker of [
      'SYNTHETIC_ERROR_MARKER',
      'confidential_name',
      'SYNTHETIC_SEALED_SOURCE_8142',
    ])
      assert.equal(result.stdout.includes(marker), false);
    assert.deepEqual(await readdir(root), [], 'no plaintext cache or staging file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sealed linking tolerates encrypted cache metadata changes without mixing source snapshots', async () => {
  const { project } = await memory();
  let changed = false;
  try {
    const linked = await linkSealed(project, 'main.a0', undefined, {
      async link(entry, read, options) {
        return sourceMcpFrontend.link(
          entry,
          async (path) => {
            const source = await read(path);
            if (!changed) {
              changed = true;
              await project.write(
                'managed-cache/unrelated',
                utf8.encode('synthetic cache'),
                'cache',
              );
            }
            return source;
          },
          options,
        );
      },
    });
    const entry = linked.program.byName.get('main');
    assert.ok(entry);
    assert.equal(run(entry, [7]), 8);
  } finally {
    project.lock();
  }
});
