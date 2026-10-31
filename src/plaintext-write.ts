/** Local coordination for managed plaintext writes; contains no source or key material. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { ProtectionError } from './protection/errors.js';
import { processLockRecord } from './protection/process-lock.js';
import { protectionPolicy } from './protection-policy.js';

export const PLAINTEXT_WRITERS = '.a0-plaintext-writers';

/** Existing physical ancestor for both existing source and not-yet-created output paths. */
async function owner(path: string): Promise<{ logical: string; physical: string; root: string }> {
  const logical = resolve(path);
  let cursor = logical;
  for (;;) {
    try {
      const physical = await realpath(cursor);
      const directory = (await lstat(physical)).isDirectory();
      return {
        logical,
        physical: join(physical, relative(cursor, logical)),
        root: directory ? physical : dirname(physical),
      };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

/** Register every source/destination owner before rechecking any seal fence. */
export async function withPlaintextWrites<T>(
  paths: readonly string[],
  action: () => Promise<T>,
): Promise<T> {
  if (paths.length === 0) throw new ProtectionError('WRITER_OWNER_REQUIRED');
  const owners = await Promise.all(paths.map(owner));
  const leases: string[] = [];
  try {
    for (const root of new Set(owners.map((value) => value.root))) {
      const directory = join(root, PLAINTEXT_WRITERS);
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ProtectionError('UNSAFE_WRITER_DIRECTORY');
      const lease = join(directory, `${process.pid}-${randomUUID()}`);
      await writeFile(
        lease,
        JSON.stringify({ format: 'a0-plaintext-writer-1', owner: await processLockRecord() }),
        { flag: 'wx', mode: 0o600 },
      );
      leases.push(lease);
    }
    for (const value of owners) {
      protectionPolicy(value.logical);
      if (value.logical !== value.physical) protectionPolicy(value.physical);
    }
    return await action();
  } finally {
    await Promise.all(leases.map((path) => unlink(path)));
  }
}

export function withPlaintextWrite<T>(source: string, action: () => Promise<T>): Promise<T> {
  return withPlaintextWrites([source], action);
}

/** Standard managed output path, including its source owners and destination project. */
export function writeManagedFile(
  sources: readonly string[],
  destination: string,
  data: string | Uint8Array,
): Promise<void> {
  return withPlaintextWrites([...sources, destination], () => writeFile(destination, data));
}

/** Call only after the seal directory exists: new writers then fail their policy recheck. */
export async function assertNoPlaintextWriters(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === PLAINTEXT_WRITERS) {
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new ProtectionError('UNSAFE_WRITER_DIRECTORY');
        if ((await readdir(join(directory, entry.name))).length !== 0)
          throw new ProtectionError('PLAINTEXT_WRITERS_ACTIVE');
      } else if (
        entry.isDirectory() &&
        !['.git', '.a0-seal', '.a0-seal-archive'].includes(entry.name)
      ) {
        await visit(join(directory, entry.name));
      }
    }
  };
  await visit(root);
}
