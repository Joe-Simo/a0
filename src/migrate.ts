/** Lossless project migration using the existing source reader and printer, never a new dialect. */
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { formatProgram, formatSource } from './core.js';
import { formatDense, parseDense } from './dense.js';
import { programRevision } from './edit.js';
import { link } from './link.js';

export interface MigrationFile {
  readonly source: string;
  readonly destination: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
}

export interface MigrationManifest {
  readonly version: 1;
  readonly entry: string;
  readonly revision: string;
  readonly files: readonly MigrationFile[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const portable = (path: string): string => path.split(sep).join('/');
const outputPath = (path: string): string =>
  /\.a0d?$/.test(path) ? path.replace(/\.a0d?$/, '.a0d') : `${path}.a0d`;

/**
 * Convert an entry and its complete dependency closure to a new directory. The original project
 * is never modified. Output is staged, linked and compared before an atomic directory rename.
 * An interrupted staging directory is disposable; no partially converted source tree is published.
 * `root` explicitly defines the source boundary, including for imports and symlinks.
 */
export async function migrateProject(
  entry: string,
  destination: string,
  root = dirname(resolve(entry)),
  legacyDense = false,
): Promise<MigrationManifest> {
  const sourceRoot = await realpath(root);
  const sourceEntry = await realpath(entry);
  const output = resolve(destination);
  const snapshots = new Map<string, string>();
  const read = async (path: string): Promise<string> => {
    const key = await realpath(path);
    const old = snapshots.get(key);
    if (old !== undefined) return old;
    const bytes = await readFile(key);
    if (!isUtf8(bytes)) throw new Error('migration source must be valid UTF-8');
    const text = bytes.toString('utf8');
    snapshots.set(key, text);
    return text;
  };
  const before = await link(sourceEntry, read, {
    root: sourceRoot,
    dense: legacyDense,
    includeUnits: true,
  });
  const mapped = new Map<string, string>();
  const destinations = new Set<string>();
  for (const { path } of before.sources) {
    const rel = relative(sourceRoot, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
      throw new Error('migration entry and dependencies must be inside the source root');
    const target = outputPath(rel);
    if (destinations.has(target)) throw new Error(`migration destination collision: ${target}`);
    destinations.add(target);
    mapped.set(path, target);
  }

  const converted = new Map<string, string>();
  if (before.units === undefined) throw new Error('migration requires linked source units');
  for (const { path, program, known } of before.units) {
    // Rebase each import by its resolved identity, including imports through an in-root symlink.
    const uses = await Promise.all(
      (program.uses ?? []).map(async (use) => {
        const target = mapped.get(await realpath(resolve(dirname(path), use)));
        if (target === undefined) throw new Error(`migration dependency missing: ${use}`);
        return portable(relative(dirname(mapped.get(path) as string), target));
      }),
    );
    const rewritten = { ...program, uses };
    const text = formatDense(rewritten, { known, comments: true });
    const back = parseDense(text, { known });
    if (formatSource(back) !== formatSource(rewritten))
      throw new Error(`migration changed source or comments: ${relative(sourceRoot, path)}`);
    if (formatDense(back, { known, comments: true }) !== text)
      throw new Error(`migration is not a formatter fixed point: ${relative(sourceRoot, path)}`);
    converted.set(path, text);
  }

  const migratedEntry = mapped.get(sourceEntry) as string;
  const manifest: MigrationManifest = {
    version: 1,
    entry: portable(migratedEntry),
    revision: programRevision(before.program),
    files: before.sources.map(({ path }) => ({
      source: portable(relative(sourceRoot, path)),
      destination: portable(mapped.get(path) as string),
      beforeSha256: sha256(snapshots.get(path) as string),
      afterSha256: sha256(converted.get(path) as string),
    })),
  };

  await mkdir(dirname(output), { recursive: true });
  // mkdir reserves the destination without overwriting even an existing empty directory.
  await mkdir(output);
  let staging: string | undefined;
  try {
    staging = await mkdtemp(join(dirname(output), '.a0-migrate-'));
    for (const [path, text] of converted) {
      const target = join(staging, mapped.get(path) as string);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, { flag: 'wx' });
    }
    const after = await link(join(staging, migratedEntry), (p) => readFile(p, 'utf8'), {
      root: staging,
    });
    if (
      formatProgram(after.program) !== formatProgram(before.program) ||
      programRevision(after.program) !== manifest.revision
    )
      throw new Error('migration changed the linked program');
    // Detect concurrent source edits rather than publishing a stale snapshot as the migration.
    for (const [path, text] of snapshots)
      if (!Buffer.from(text, 'utf8').equals(await readFile(path)))
        throw new Error(`source changed during migration: ${relative(sourceRoot, path)}`);
    await writeFile(join(staging, 'a0-migration.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    });
    await rename(staging, output);
    staging = undefined;
    return manifest;
  } catch (error) {
    // Never recursively delete the reserved output: another process may have put data in it.
    try {
      await rmdir(output);
    } catch (cleanupError) {
      const code = (cleanupError as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY')
        throw new AggregateError(
          [error, cleanupError],
          `migration failed: ${String(error)}; destination cleanup failed: ${String(cleanupError)}`,
        );
    }
    throw error;
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
  }
}
