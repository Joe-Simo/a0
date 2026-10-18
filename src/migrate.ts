/** Lossless project migration using the existing source reader and printer, never a new dialect. */
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { formatProgram, formatSource, type Program } from './core.js';
import { type Arities, formatDense, parseDense } from './dense.js';
import { programRevision } from './edit.js';
import { link, physicalPath } from './link.js';
import { protectionPolicy } from './protection-policy.js';
import { parseSource, formatSource as printSource } from './source.js';
import { linkSource } from './source-link.js';

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
/** Internal migration boundary; historical readers are selected explicitly before conversion. */
export interface MigrationCodec {
  readonly extension: '.a0' | '.a0d';
  print(program: Program, known: Arities): string;
  parse(text: string, known: Arities): Program;
  readonly link: typeof linkSource;
}
const denseCodec: MigrationCodec = {
  extension: '.a0d',
  print: (program, known) => formatDense(program, { known, comments: true }),
  parse: (text, known) => parseDense(text, { known }),
  link,
};
const sourceCodec: MigrationCodec = {
  extension: '.a0',
  print: printSource,
  parse: parseSource,
  link: linkSource,
};

/** Convert either historical spelling to the candidate grammar. */
export function migrateSourceProject(
  entry: string,
  destination: string,
  root = dirname(resolve(entry)),
  legacyDense = false,
): Promise<MigrationManifest> {
  return migrateWithCodec(entry, destination, root, legacyDense, sourceCodec);
}

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
  return migrateWithCodec(entry, destination, root, legacyDense, denseCodec);
}

/** Shared guarded staging, source snapshots and equivalence checks; codecs do not publish files. */
export async function migrateWithCodec(
  entry: string,
  destination: string,
  root: string,
  legacyDense: boolean,
  codec: MigrationCodec,
): Promise<MigrationManifest> {
  protectionPolicy(root);
  protectionPolicy(entry);
  protectionPolicy(destination);
  const sourceRoot = await realpath(root);
  const sourceEntry = await realpath(entry);
  const output = await physicalPath(resolve(destination));
  protectionPolicy(output);
  const snapshots = new Map<string, string>();
  const read = async (path: string): Promise<string> => {
    protectionPolicy(path);
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
    const target = /\.a0d?$/.test(rel)
      ? rel.replace(/\.a0d?$/, codec.extension)
      : `${rel}${codec.extension}`;
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
    const text = codec.print(rewritten, known);
    const back = codec.parse(text, known);
    if (formatSource(back) !== formatSource(rewritten))
      throw new Error(`migration changed source or comments: ${relative(sourceRoot, path)}`);
    if (codec.print(back, known) !== text)
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

  protectionPolicy(output);
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
    const after = await codec.link(join(staging, migratedEntry), (p) => readFile(p, 'utf8'), {
      root: staging,
    });
    if (
      formatProgram(after.program) !== formatProgram(before.program) ||
      programRevision(after.program) !== manifest.revision
    )
      throw new Error('migration changed the linked program');
    // Detect concurrent source edits rather than publishing a stale snapshot as the migration.
    for (const [path, text] of snapshots) {
      protectionPolicy(path);
      if (!Buffer.from(text, 'utf8').equals(await readFile(path)))
        throw new Error(`source changed during migration: ${relative(sourceRoot, path)}`);
    }
    await writeFile(join(staging, 'a0-migration.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    });
    protectionPolicy(output);
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
