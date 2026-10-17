/** Node/Bun host adapter. Only ciphertext is written to this store, including its temporary files. */
import { constants } from 'node:fs';
import {
  link as linkFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { A0Error } from '../core.js';
import { sourceUses } from '../link.js';
import { digest, opaqueId, ProtectionError, utf8 } from './crypto.js';
import {
  type Head,
  type Migration,
  type Role,
  type SealedProject,
  safePath,
  type VaultStore,
} from './vault.js';

export const STORE_NAME = '.a0-seal';
function missing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT';
}
export async function optionalRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}
export async function syncDir(path: string): Promise<void> {
  assertDurableHost();
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export function assertDurableHost(): void {
  if (process.platform === 'win32') throw new ProtectionError('FILESYSTEM_DURABILITY_PENDING');
}
async function plainDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ProtectionError('SYMLINK_OR_NON_DIRECTORY');
}
/** Atomic replace, private permissions, no cross-device temporary plaintext. */
export async function atomicWrite(path: string, bytes: string | Uint8Array): Promise<void> {
  assertDurableHost();
  const parent = dirname(path);
  await plainDirectory(parent);
  const temporary = join(parent, `.a0-write-${opaqueId()}`);
  const fd = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temporary, path);
    await syncDir(parent);
  } finally {
    await unlink(temporary).catch((e) => {
      if (!missing(e)) throw e;
    });
  }
}
export async function writeNew(path: string, bytes: string | Uint8Array): Promise<void> {
  assertDurableHost();
  await plainDirectory(dirname(path));
  const fd = await open(path, 'wx', 0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await syncDir(dirname(path));
}

export class DiskVaultStore implements VaultStore {
  readonly dir: string;
  constructor(readonly projectRoot: string) {
    this.dir = join(resolve(projectRoot), STORE_NAME);
  }
  async initialize(): Promise<void> {
    assertDurableHost();
    await mkdir(this.dir, { mode: 0o700 }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
    await plainDirectory(this.dir);
    await mkdir(join(this.dir, 'objects'), { mode: 0o700 }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
    await plainDirectory(join(this.dir, 'objects'));
    await syncDir(this.projectRoot);
  }
  async head(): Promise<Head | undefined> {
    const raw = await optionalRead(join(this.dir, 'head.json'));
    if (raw === undefined) return undefined;
    try {
      const h = JSON.parse(raw) as Head;
      if (
        h.format !== 'a0-vault-1' ||
        !/^[0-9a-f]{48}$/.test(h.revision) ||
        !/^[0-9a-f]{64}$/.test(h.project) ||
        !/^[0-9a-f]{48}$/.test(h.epoch) ||
        !/^[0-9a-f]{48}$/.test(h.manifest) ||
        !['sealing', 'on', 'unsealing', 'off'].includes(h.phase)
      )
        throw new Error();
      return h;
    } catch {
      throw new ProtectionError('INVALID_HEAD');
    }
  }
  #path(id: string): string {
    if (!/^[0-9a-f]{48}$/.test(id)) throw new ProtectionError('INVALID_OBJECT_ID');
    return join(this.dir, 'objects', id);
  }
  async get(id: string): Promise<string> {
    const path = this.#path(id);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ProtectionError('INVALID_OBJECT');
    return readFile(path, 'utf8');
  }
  async put(id: string, value: string): Promise<void> {
    assertDurableHost();
    const target = this.#path(id),
      temp = join(this.dir, 'objects', `.pending-${opaqueId()}`);
    await writeNew(temp, value);
    try {
      await linkFile(temp, target).catch(async (e) => {
        if (e.code !== 'EEXIST') throw e;
        if ((await this.get(id)) !== value) throw new ProtectionError('OBJECT_COLLISION');
      });
      await syncDir(join(this.dir, 'objects'));
    } finally {
      await unlink(temp);
    }
  }
  async commit(expected: string | undefined, head: Head): Promise<void> {
    assertDurableHost();
    const path = join(this.dir, 'commit.lock');
    const temporary = join(this.dir, `.lock-${opaqueId()}`);
    await writeNew(temporary, JSON.stringify({ pid: process.pid, nonce: opaqueId() }));
    try {
      await linkFile(temporary, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ProtectionError('COMMIT_LOCKED');
      throw e;
    } finally {
      await unlink(temporary);
    }
    try {
      await syncDir(this.dir);
      if ((await this.head())?.revision !== expected)
        throw new ProtectionError('CONCURRENT_CHANGE');
      await atomicWrite(join(this.dir, 'head.json'), JSON.stringify(head));
    } finally {
      await unlink(path);
      await syncDir(this.dir);
    }
  }
  /** Owner-authenticated caller must inspect the hash; a live PID is never overridden. */
  async recoverCommitLock(expectedHash: string): Promise<void> {
    const path = join(this.dir, 'commit.lock');
    const bytes = await readFile(path);
    if ((await digest(bytes)) !== expectedHash) throw new ProtectionError('LOCK_CHANGED');
    const { pid } = JSON.parse(bytes.toString()) as { pid: number };
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new ProtectionError('INVALID_LOCK');
    try {
      process.kill(pid, 0);
      throw new ProtectionError('LOCK_OWNER_ALIVE');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
    await unlink(path);
    await syncDir(this.dir);
  }
}

const MANAGED: Readonly<Record<string, Role>> = {
  '.a0-cache': 'cache',
  '.a0-index': 'index',
  '.a0-history': 'history',
  '.a0-logs': 'log',
  '.a0-tmp': 'temporary',
};
const EXCLUDED = new Set([
  '.git',
  'node_modules',
  STORE_NAME,
  '.a0-seal-archive',
  'dist',
  'build',
  'release',
]);
/** OFF becomes visible to ordinary tools only after completed restoration and an atomic archive rename. */
export async function archiveDisabledStore(store: DiskVaultStore): Promise<void> {
  if ((await store.head())?.phase !== 'off') throw new ProtectionError('RESTORATION_NOT_COMPLETE');
  const archive = join(store.projectRoot, '.a0-seal-archive');
  await mkdir(archive, { mode: 0o700 }).catch((e) => {
    if (e.code !== 'EEXIST') throw e;
  });
  await plainDirectory(archive);
  await rename(store.dir, join(archive, opaqueId()));
  await syncDir(archive);
  await syncDir(store.projectRoot);
}
export interface Inventory {
  readonly items: Migration['items'];
  readonly digest: string;
  readonly unmanaged: readonly string[];
  readonly incompleteGraphs: readonly string[];
}
/** Explicit A0-managed files only. Existing VCS, backups, build outputs and tool caches are outside this inventory. */
export async function inventory(root: string, include: readonly string[] = []): Promise<Inventory> {
  const items: { path: string; role: Role; hash: string }[] = [];
  const unmanaged: string[] = [];
  const incompleteGraphs: string[] = [];
  const visit = async (dir: string, prefix: string, role?: Role): Promise<void> => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = prefix + e.name;
      if (e.isSymbolicLink()) throw new ProtectionError('MIGRATION_SYMLINK');
      if (e.isDirectory()) {
        if (EXCLUDED.has(e.name)) {
          if (e.name !== STORE_NAME) unmanaged.push(path);
          continue;
        }
        await visit(join(dir, e.name), `${path}/`, role ?? MANAGED[e.name]);
      } else if (
        e.isFile() &&
        (role || /\.a0d?$/.test(e.name) || /^\.a0-write-[0-9a-f]{48}$/.test(e.name))
      ) {
        safePath(path);
        const bytes = await readFile(join(root, path));
        items.push({
          path,
          role: role ?? (e.name.startsWith('.a0-write-') ? 'temporary' : 'source'),
          hash: await digest(bytes),
        });
        bytes.fill(0);
      } else unmanaged.push(path);
    }
  };
  await visit(root, '');
  const known = new Set(items.map((i) => i.path));
  const add = async (path: string, role: Role): Promise<void> => {
    safePath(path);
    if (known.has(path)) return;
    if (
      path === '.a0-protection.json' ||
      path.split('/').some((p) => p === '.git' || p === STORE_NAME || p === '.a0-seal-archive')
    )
      throw new ProtectionError('RESERVED_SOURCE_LOCATION');
    const file = await confinedFile(root, path, false),
      bytes = await readFile(file);
    try {
      items.push({ path, role, hash: await digest(bytes) });
      known.add(path);
    } finally {
      bytes.fill(0);
    }
  };
  for (const path of include) await add(path, /\.a0d?$/.test(path) ? 'source' : 'metadata');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.role !== 'source') continue;
    const file = join(root, item.path);
    let uses: readonly string[];
    try {
      uses = sourceUses(await readFile(file, 'utf8'), item.path);
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
      incompleteGraphs.push(item.path);
      continue;
    }
    for (const use of uses) {
      const path = relative(resolve(root), resolve(dirname(file), use))
        .split(sep)
        .join('/');
      if (!/\.a0d?$/.test(path)) throw new ProtectionError('UNSUPPORTED_SOURCE_DEPENDENCY');
      await add(path, 'source');
    }
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return {
    items,
    digest: await digest(utf8.encode(JSON.stringify(items))),
    unmanaged: unmanaged.filter((p) => !known.has(p)),
    incompleteGraphs,
  };
}
/** Resolve existing ancestors without following a symlink out of the project. */
export async function confinedFile(
  root: string,
  path: string,
  createParents = true,
): Promise<string> {
  safePath(path);
  const absoluteRoot = await realpath(root);
  let current = absoluteRoot;
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    current = join(current, parts[i] as string);
    if (createParents)
      await mkdir(current, { mode: 0o700 }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
    await plainDirectory(current);
  }
  const out = join(current, parts[parts.length - 1] as string);
  const rel = relative(absoluteRoot, out);
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ProtectionError('UNSAFE_PATH');
  const stat = await lstat(out).catch((e) => {
    if (missing(e)) return undefined;
    throw e;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1))
    throw new ProtectionError('UNSAFE_FILE');
  return out;
}

/** Resumable journal lives inside the authenticated encrypted manifest. Each step is idempotent. */
export async function resumeMigration(
  project: SealedProject,
  root: string,
  checkpoint: (step: string) => Promise<void> = async () => {},
): Promise<void> {
  const migration = project.migration;
  if (!migration) throw new ProtectionError('NO_MIGRATION');
  if (migration.direction === 'on') {
    if (migration.stage === 'copy') {
      for (const item of migration.items) {
        const path = await confinedFile(root, item.path);
        const bytes = await readFile(path);
        try {
          if ((await digest(bytes)) !== item.hash) throw new ProtectionError('SOURCE_CHANGED');
          await project.write(item.path, bytes, item.role);
        } finally {
          bytes.fill(0);
        }
        await checkpoint('copy');
      }
      // Re-inventory detects files added while a migration was copying. Never silently leave new managed plaintext.
      const now = await inventory(
        root,
        migration.items.map((i) => i.path),
      );
      if (JSON.stringify(now.items) !== JSON.stringify(migration.items))
        throw new ProtectionError('INVENTORY_CHANGED');
      await project.setMigration('sealing', { ...migration, stage: 'delete' });
      await checkpoint('delete-ready');
    }
    for (const item of migration.items) {
      const sealed = await project.read(item.path);
      try {
        if ((await digest(sealed)) !== item.hash)
          throw new ProtectionError('INTEGRITY_OR_KEY_FAILURE');
      } finally {
        sealed.fill(0);
      }
      const path = await confinedFile(root, item.path);
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (e) {
        if (missing(e)) continue;
        throw e;
      }
      try {
        if ((await digest(bytes)) !== item.hash) throw new ProtectionError('SOURCE_CHANGED');
      } finally {
        bytes.fill(0);
      }
      await unlink(path);
      await syncDir(dirname(path));
      await checkpoint('delete');
    }
    if ((await inventory(root)).items.length !== 0) throw new ProtectionError('PLAINTEXT_REMAINS');
    // Empty directory names are metadata too. Remove only directories that are now empty.
    const parents = [
      ...new Set(
        migration.items.flatMap((i) => {
          const out: string[] = [];
          for (let p = dirname(i.path); p !== '.'; p = dirname(p)) out.push(p);
          return out;
        }),
      ),
    ].sort((a, b) => b.length - a.length);
    for (const parent of parents)
      await rmdir(join(root, parent)).catch((e) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e;
      });
    await project.setMigration('on', null);
  } else {
    for (const item of migration.items) {
      const bytes = await project.read(item.path);
      try {
        const path = await confinedFile(root, item.path);
        const existing = await readFile(path).catch((e) => {
          if (missing(e)) return undefined;
          throw e;
        });
        if (existing) {
          const matches = (await digest(existing)) === item.hash;
          existing.fill(0);
          if (!matches) throw new ProtectionError('PLAINTEXT_CONFLICT');
        } else await atomicWrite(path, bytes);
      } finally {
        bytes.fill(0);
      }
      await checkpoint('restore');
    }
    // A crash during an explicitly approved plaintext restoration can leave a partial temporary.
    // The reserved namespace is cleaned before OFF becomes visible; no such temporary is used for sealed editing.
    const parents = new Set(migration.items.map((i) => dirname(i.path)));
    for (const parent of parents) {
      const dir = join(root, parent);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!/^\.a0-write-[0-9a-f]{48}$/.test(entry.name)) continue;
        const path = join(dir, entry.name);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new ProtectionError('UNSAFE_TEMPORARY');
        await unlink(path);
      }
      await syncDir(dir);
    }
    await project.setMigration('off', null);
  }
}
