/** Real borrowed C-derived frontend controls for graph/storage seams; no public default switch. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { cliCheckDiagnostic, loadCliProgram } from '../src/cli-source.js';
import { A0Error, run } from '../src/core.js';
import { compileSealed, linkSealed } from '../src/protection/build.js';
import { createIdentity, type Identity, unlockIdentity, utf8 } from '../src/protection/crypto.js';
import { DiskVaultStore, inventory, resumeMigration } from '../src/protection/disk.js';
import { MemoryVaultStore } from '../src/protection/store.js';
import { SealedProject } from '../src/protection/vault.js';
import { sourceDiagnostic } from '../src/source-graph.js';
import { nativeSource } from '../src/source-native.js';
import {
  NativeSourceError,
  nativeSourceDependencies,
  nativeSourceGraphLoader,
} from '../src/source-native-link.js';
import { prepareSourceDiagnostic, prepareSourceFrontend } from '../tools/source-native-load.js';

const frontendPath = process.env.A0_GRAPH_FRONTEND;
const diagnosticPath = process.env.A0_GRAPH_DIAGNOSTIC;
assert.ok(frontendPath && diagnosticPath, 'A0_GRAPH_FRONTEND/DIAGNOSTIC required');
const prepared = await prepareSourceFrontend(frontendPath);
assert.equal(prepared.build.diagnosticPorts, 'arena-v1');
const module = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const diagnostic = await prepareSourceDiagnostic(diagnosticPath);
const scratch = resolve('.a0-tmp/native-graph-controls');
await mkdir(scratch, { recursive: true });
let owner: Identity;
test.before(async () => {
  const password = utf8.encode('owned graph storage fixture identity');
  const file = await createIdentity(password);
  owner = await unlockIdentity(file, password);
  password.fill(0);
});
const SOURCE = 'fn main\nr add A 1\nret r\nend\n';
const engine = () => nativeSource(module, diagnostic);
async function sealed(files: Record<string, string | Uint8Array>) {
  const store = new MemoryVaultStore();
  const project = await SealedProject.create(store, owner);
  for (const [path, source] of Object.entries(files))
    await project.write(path, typeof source === 'string' ? utf8.encode(source) : source);
  return { store, project };
}
async function directory(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(scratch, 'fixture-'));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function counted(host = engine()) {
  let parses = 0;
  let checks = 0;
  const borrowed: ReturnType<typeof nativeSource> = {
    ...host,
    parseUnit(source, budget) {
      parses++;
      return host.parseUnit(source, budget);
    },
    checkUnits(units, profile, budget) {
      checks++;
      return host.checkUnits(units, profile, budget);
    },
  };
  return {
    host: borrowed,
    load: nativeSourceGraphLoader(borrowed),
    counts: () => ({ parses, checks }),
  };
}
const diagnosticId = (id: string) => (error: unknown) =>
  error instanceof A0Error && error.id === id;

test('plain CLI and sealed storage use the same borrowed graph loader for a diamond and profile override', async () => {
  await directory(async (root) => {
    const files = {
      'lib.a0': 'fn helper\nr add A 1\nret r\nend\n',
      'left.a0': 'use "lib.a0"\nfn left\nr helper A\nret r\nend\n',
      'right.a0': 'use "lib.a0"\nfn right\nr helper A\nret r\nend\n',
      'main.a0': 'use "left.a0"\nuse "right.a0"\nfn main\na left A\nr right a\nret r\nend\n',
    };
    for (const [path, source] of Object.entries(files)) await writeFile(join(root, path), source);
    const borrowed = counted();
    const plain = await loadCliProgram(join(root, 'main.a0'), borrowed.load, {
      root,
      profile: 'strict',
    });
    assert.deepEqual(borrowed.counts(), { parses: 4, checks: 1 });
    const { project, store } = await sealed(files);
    try {
      const linked = await linkSealed(project, 'main.a0', 'strict', borrowed.load);
      assert.deepEqual(borrowed.counts(), { parses: 8, checks: 2 });
      for (const target of ['c', 'js', 'wasm'] as const)
        assert.equal(compile(linked.program, target).text, compile(plain, target).text);
      const main = linked.program.byName.get('main');
      assert.ok(main);
      assert.equal(run(main, [5]), 7);
      const output = await compileSealed(project, 'main.a0', 'js', {
        graphLoader: borrowed.load,
        profile: 'strict',
        cache: false,
      });
      assert.equal(new TextDecoder().decode(output), compile(plain, 'js').text);
      assert.equal(JSON.stringify([...store.objects.values()]).includes('fn helper'), false);
      assert.ok(borrowed.host.parse(SOURCE).ok, 'borrowed frontend remains open');
    } finally {
      project.lock();
      borrowed.host.close();
    }
  });
});

test('native graph entry extension is checked before a storage read', async () => {
  const host = engine();
  let reads = 0;
  try {
    for (const path of ['entry.a0d', 'entry', 'entry.A0'])
      await assert.rejects(
        nativeSourceGraphLoader(host)(path, async () => {
          reads++;
          return SOURCE;
        }),
        diagnosticId('A0802'),
      );
    assert.equal(reads, 0);
  } finally {
    host.close();
  }
});

test('native graph rejects traversal, absolute and symlink imports before outside reads', async () => {
  const host = engine();
  const load = nativeSourceGraphLoader(host);
  try {
    for (const use of ['../escape.a0', '/escape.a0']) {
      const { project } = await sealed({ 'main.a0': `use "${use}"\n${SOURCE}` });
      try {
        await assert.rejects(
          linkSealed(project, 'main.a0', undefined, load),
          diagnosticId('A0622'),
        );
      } finally {
        project.lock();
      }
    }
    await directory(async (root) => {
      await mkdir(join(root, 'inside'));
      await writeFile(join(root, 'outside.a0'), SOURCE);
      await symlink(join(root, 'outside.a0'), join(root, 'inside', 'escape.a0'));
      await writeFile(join(root, 'inside', 'main.a0'), 'use "escape.a0"\n');
      await assert.rejects(
        loadCliProgram(join(root, 'inside', 'main.a0'), load, { root: join(root, 'inside') }),
        diagnosticId('A0622'),
      );
    });
  } finally {
    host.close();
  }
});

test('profile override preserves mixed-declaration rejection', async () => {
  const host = engine();
  const { project } = await sealed({
    'main.a0': 'profile strict\nuse "lib.a0"\n',
    'lib.a0': SOURCE,
  });
  try {
    await assert.rejects(
      linkSealed(project, 'main.a0', 'canonical', nativeSourceGraphLoader(host)),
      diagnosticId('A0624'),
    );
  } finally {
    project.lock();
    host.close();
  }
});

test('plain native loading guards sealed policy before injected storage access', async () => {
  await directory(async (root) => {
    await mkdir(join(root, '.a0-seal'));
    await writeFile(
      join(root, '.a0-seal', 'head.json'),
      JSON.stringify({ format: 'a0-vault-1', phase: 'on' }),
    );
    let reads = 0;
    const host = engine();
    try {
      await assert.rejects(
        loadCliProgram(join(root, 'main.a0'), nativeSourceGraphLoader(host), { root }, async () => {
          reads++;
          return SOURCE;
        }),
        /SEALED_USE_UNLOCK_SESSION/,
      );
      assert.equal(reads, 0);
    } finally {
      host.close();
    }
  });
});

test('fatal plain and sealed UTF8 decoding refuse before native parsing', async () => {
  const borrowed = counted();
  try {
    await directory(async (root) => {
      await writeFile(join(root, 'main.a0'), Uint8Array.of(255));
      await assert.rejects(
        loadCliProgram(join(root, 'main.a0'), borrowed.load, { root }),
        TypeError,
      );
    });
    const { project } = await sealed({ 'main.a0': Uint8Array.of(255) });
    try {
      await assert.rejects(linkSealed(project, 'main.a0', undefined, borrowed.load), TypeError);
    } finally {
      project.lock();
    }
    assert.deepEqual(borrowed.counts(), { parses: 0, checks: 0 });
  } finally {
    borrowed.host.close();
  }
});

test('sealed authentication, migration phase and requested target protection fail before native parsing', async () => {
  const borrowed = counted();
  const { project, store } = await sealed({ 'main.a0': SOURCE });
  try {
    await assert.rejects(
      compileSealed(project, 'main.a0', 'c', { graphLoader: borrowed.load, protect: true }),
      /TARGET_PROTECTION_PENDING/,
    );
    const entry = project.entries()['main.a0'];
    assert.ok(entry);
    const object = entry.object;
    store.objects.set(object, 'invalid');
    await assert.rejects(
      linkSealed(project, 'main.a0', undefined, borrowed.load),
      /INTEGRITY_OR_KEY_FAILURE/,
    );
    const migrating = await SealedProject.create(new MemoryVaultStore(), owner, {
      direction: 'on',
      stage: 'copy',
      items: [],
    });
    try {
      await assert.rejects(
        linkSealed(migrating, 'main.a0', undefined, borrowed.load),
        /MIGRATION_IN_PROGRESS/,
      );
    } finally {
      migrating.lock();
    }
    assert.deepEqual(borrowed.counts(), { parses: 0, checks: 0 });
  } finally {
    project.lock();
    borrowed.host.close();
  }
});

test('native inventory discovers excluded dependencies and retains its reader across migration re-inventory', async () => {
  await directory(async (root) => {
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'main.a0'), 'use "node_modules/lib.a0"\n');
    await writeFile(join(root, 'node_modules', 'lib.a0'), SOURCE);
    const borrowed = counted();
    const dependencies = nativeSourceDependencies(borrowed.host);
    const plan = await inventory(root, [], dependencies);
    assert.deepEqual(
      plan.items.map((x) => x.path),
      ['main.a0', 'node_modules/lib.a0'],
    );
    assert.deepEqual(plan.incompleteGraphs, []);
    assert.deepEqual(borrowed.counts(), { parses: 2, checks: 0 });
    const store = new DiskVaultStore(root);
    await store.initialize();
    const project = await SealedProject.create(store, owner, {
      direction: 'on',
      stage: 'copy',
      items: plan.items,
    });
    try {
      await resumeMigration(project, root, undefined, dependencies);
      assert.deepEqual(borrowed.counts(), { parses: 4, checks: 0 });
      assert.equal(project.status.phase, 'on');
      assert.equal(
        await project.sourceAccess('local-terminal').read('node_modules/lib.a0'),
        SOURCE,
      );
    } finally {
      project.lock();
      borrowed.host.close();
    }
  });
});

test('native inventory records syntax errors while refusing invalid UTF8 and unsupported source extensions', async () => {
  const host = engine();
  const dependencies = nativeSourceDependencies(host);
  try {
    await directory(async (root) => {
      await writeFile(join(root, 'broken.a0'), 'not_a_program\n');
      const result = await inventory(root, [], dependencies);
      assert.deepEqual(result.incompleteGraphs, ['broken.a0']);
      await writeFile(join(root, 'broken.a0'), Uint8Array.of(255));
      await assert.rejects(inventory(root, [], dependencies), TypeError);
      await writeFile(join(root, 'broken.a0'), SOURCE);
      await writeFile(join(root, 'legacy.a0d'), SOURCE);
      await assert.rejects(inventory(root, [], dependencies), /UNSUPPORTED_SOURCE_DEPENDENCY/);
    });
  } finally {
    host.close();
  }
});

test('native allocation refusals abort inventory instead of becoming an incomplete graph', async () => {
  const host = engine();
  const bounded: ReturnType<typeof nativeSource> = {
    ...host,
    parseUnit: (source) => host.parseUnit(source, 1),
  };
  const dependencies = nativeSourceDependencies(bounded);
  try {
    const result = bounded.parseUnit(SOURCE);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected real budget refusal');
    assert.equal(dependencies.isSourceError(new NativeSourceError(result)), false);
    await directory(async (root) => {
      await writeFile(join(root, 'main.a0'), SOURCE);
      await assert.rejects(inventory(root, [], dependencies), NativeSourceError);
    });
  } finally {
    host.close();
  }
});

test('native error boundary preserves rendered diagnostic JSON without another source/check call', async () => {
  const borrowed = counted();
  const { project } = await sealed({ 'main.a0': 'fn main\nr add missing 1\nret r\nend\n' });
  try {
    let failure: unknown;
    try {
      await linkSealed(project, 'main.a0', undefined, borrowed.load);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof NativeSourceError);
    assert.ok(failure.rendered?.ok);
    const counts = borrowed.counts();
    const diagnostic = await sourceDiagnostic(failure);
    assert.ok(diagnostic?.native);
    assert.deepEqual(diagnostic.error.toJSON(), failure.rendered.error.toJSON());
    let reads = 0;
    const json = await cliCheckDiagnostic('main.a0', diagnostic, async () => {
      reads++;
      throw new Error('must not reload native diagnostic source');
    });
    assert.deepEqual(json, { ...failure.rendered.error.toJSON(), line: 2 });
    assert.equal(reads, 0);
    assert.deepEqual(borrowed.counts(), counts);
    assert.equal(await sourceDiagnostic(new Error('transport refusal')), undefined);
  } finally {
    project.lock();
    borrowed.host.close();
  }
});

test('unlocked native session emits code-only failures and blocks external AI graph loading', () => {
  const fixture = resolve('test/fixtures/native-graph-seam/protocol.mjs');
  for (const consumer of ['local-terminal', 'external-ai']) {
    const output = spawnSync(process.execPath, [fixture, consumer], {
      input: '{"op":"check","path":"main.a0"}\n{"op":"lock"}\n',
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(output.status, 0, output.stderr);
    const rows = output.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const failed = rows.find((row) => row.ok === false);
    assert.ok(failed);
    assert.deepEqual(Object.keys(failed).sort(), ['code', 'ok']);
    assert.equal(
      consumer === 'external-ai'
        ? failed.code === 'SCOPED_AI_OPERATION_PENDING'
        : /^A\d{4}$/.test(failed.code),
      true,
    );
    assert.equal(output.stdout.includes('sensitive_graph_marker'), false);
    assert.equal(output.stdout.includes('main.a0'), false);
    assert.equal(output.stdout.includes('LOADER_WAS_CALLED'), false);
  }
});
