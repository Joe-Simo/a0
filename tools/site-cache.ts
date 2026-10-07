/**
 * A content-addressed cache for the site build (tools/site-build.ts). Each cached artifact is a
 * pure function of the inputs its key hashes, so a hit gives the bytes a rebuild would write:
 *
 * - `generator`: the generator binary (tools/site-gen.ts). Keyed by the linked generator sources
 *   (site/gen/sitegen.a0), COMPILER_VERSION, the code that writes and builds its C (the TypeScript
 *   import closure of tools/site-gen.ts), the clang version and the host.
 * - `source`: a page's generated A0 source. Keyed by the generator binary's bytes and the generator
 *   input (the template and every file it names), so a changed template or data file misses.
 * - `wasmtool`: the A0 wasm tool (tools/selfhost-wasm.ts). Keyed by the linked compiler/boot.a0
 *   sources, COMPILER_VERSION, the code that builds it (its import closure), clang and the host.
 * - `program` and `live`: a page's or live program's wasm and prerendered HTML. Keyed by the wasm
 *   tool's bytes, the linked program sources (the generated page and what it `use`s), its io
 *   layout, and the code of the site build (the import closure of tools/site-build.ts).
 *
 * An entry is the directory `<dir>/<kind>/<key>/`: its artifact files and a manifest with the
 * SHA-256 of each. A file that is missing or does not match its digest is a miss, and the entry
 * is rebuilt. An entry is written whole (a temporary directory, then a rename), and only the
 * newest KEEP entries of a kind are kept. The default directory is .a0-cache/site (git-ignored);
 * A0_SITE_CACHE moves it, and `--no-cache` turns it off for a run.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

/** The cache directory, relative to the repository root (the build's working directory). */
export const CACHE_DIR = join('.a0-cache', 'site');
/** Entries kept per kind: the newest by last use. Older ones are deleted when a new one is stored. */
export const KEEP = 4;
const MANIFEST = 'manifest.json';
/** A temporary entry older than this was left by a run that stopped: it is deleted. */
const STALE_TMP_MS = 3_600_000;

export interface SiteCache {
  /** The cache directory, or undefined when the cache is off for this run. */
  readonly dir: string | undefined;
}

/** The cache for a run: off when `enabled` is false, else `dir`, A0_SITE_CACHE, or CACHE_DIR. */
export function openCache(
  options: { readonly enabled?: boolean; readonly dir?: string } = {},
): SiteCache {
  if (options.enabled === false) return { dir: undefined };
  return { dir: options.dir ?? (process.env.A0_SITE_CACHE || CACHE_DIR) };
}

/** The platform and CPU a binary is built for: its code depends on both. */
export const HOST = `${process.platform}-${process.arch}`;

/** The suffix a built tool has on this platform (clang writes `name.exe` for `-o name` on Windows). */
export const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 over the parts, each prefixed with its length, so no two part lists give the same key. */
export function keyOf(...parts: readonly (string | Uint8Array)[]): string {
  const h = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    h.update(length).update(bytes);
  }
  return h.digest('hex');
}

/** The file a built tool path names: the path, or the path with the platform suffix. */
export function toolFile(path: string): string {
  return existsSync(path) ? path : `${path}${EXE_SUFFIX}`;
}

/** SHA-256 of a built tool's bytes (the file `toolFile` names). */
export async function toolDigest(path: string): Promise<string> {
  return sha256(await readFile(toolFile(path)));
}

/** Write a built tool's bytes where `path` names it, executable, and return `path`. */
export async function writeTool(bytes: Uint8Array, path: string): Promise<string> {
  const file = `${path}${EXE_SUFFIX}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  if (process.platform !== 'win32') await chmod(file, 0o755);
  return path;
}

// The import closure: the TypeScript files a module reaches through relative imports. Bare
// package names are not followed (their versions are pinned by bun.lock and not part of a build's
// code paths here). A specifier that names no file is skipped.
const IMPORT =
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;

/** The relative import specifiers of a TypeScript source, in order. */
export function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec?.startsWith('.')) out.push(spec);
  }
  return out;
}

/** The file a relative import names from `from` (a root-relative posix path), or undefined. */
function resolveImport(root: string, from: string, spec: string): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const candidates = base.endsWith('.js')
    ? [`${base.slice(0, -3)}.ts`, base]
    : [`${base}.ts`, base];
  return candidates.find((c) => existsSync(join(root, c)) && statSync(join(root, c)).isFile());
}

/**
 * The root-relative posix paths of `entries` and every file they reach through relative
 * imports, sorted. Paths are read under `root` (the repository root by default).
 */
export function importClosure(entries: readonly string[], root = process.cwd()): string[] {
  const seen = new Set<string>();
  const queue = entries.map((e) => posix.normalize(e));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(readFileSync(join(root, file), 'utf8'))) {
      const next = resolveImport(root, file, spec);
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

/** SHA-256 over the path and bytes of every file in the import closure of `entries`. */
export function codeDigest(entries: readonly string[], root = process.cwd()): string {
  const h = createHash('sha256');
  for (const file of importClosure(entries, root))
    h.update(`${file}\0${sha256(readFileSync(join(root, file)))}\n`);
  return h.digest('hex');
}

interface Manifest {
  readonly format: 1;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * The files of entry `kind/key`, or undefined on a miss (no entry, a missing file, or a file whose
 * digest differs). A hit marks the entry as recently used.
 */
export async function readEntry(
  cache: SiteCache,
  kind: string,
  key: string,
): Promise<Map<string, Buffer> | undefined> {
  if (cache.dir === undefined) return undefined;
  const dir = join(cache.dir, kind, key);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
  const out = new Map<string, Buffer>();
  for (const [name, digest] of Object.entries(manifest.files ?? {})) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, name));
    } catch {
      return undefined;
    }
    if (sha256(bytes) !== digest) return undefined;
    out.set(name, bytes);
  }
  const now = new Date();
  await utimes(dir, now, now).catch(() => undefined);
  return out;
}

/** Store the files of entry `kind/key` (replacing an entry of that key), then keep the newest KEEP. */
export async function writeEntry(
  cache: SiteCache,
  kind: string,
  key: string,
  files: Readonly<Record<string, Uint8Array | string>>,
): Promise<void> {
  if (cache.dir === undefined) return;
  const kindDir = join(cache.dir, kind);
  const dir = join(kindDir, key);
  const tmp = `${dir}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await mkdir(tmp, { recursive: true });
  const digests: Record<string, string> = {};
  let placed = false;
  try {
    for (const [name, data] of Object.entries(files)) {
      if (name === MANIFEST || name !== posix.basename(name))
        throw new Error(`bad entry file ${name}`);
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      await writeFile(join(tmp, name), bytes);
      digests[name] = sha256(bytes);
    }
    const manifest: Manifest = { format: 1, files: digests };
    await writeFile(join(tmp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rm(dir, { recursive: true, force: true });
    try {
      await rename(tmp, dir);
      placed = true;
    } catch (err) {
      // Another run stored the same key between the removal and the rename: its files are the
      // same bytes. Any other failure is an error.
      if (!existsSync(join(dir, MANIFEST))) throw err;
    }
  } finally {
    if (!placed) await rm(tmp, { recursive: true, force: true });
  }
  await prune(kindDir);
}

/** Keep the newest KEEP entries of a kind, and delete temporary entries a run left behind. */
async function prune(kindDir: string): Promise<void> {
  const now = Date.now();
  const entries: { name: string; mtime: number }[] = [];
  for (const name of await readdir(kindDir)) {
    const mtime = (await stat(join(kindDir, name))).mtimeMs;
    if (name.includes('.tmp-')) {
      if (now - mtime > STALE_TMP_MS)
        await rm(join(kindDir, name), { recursive: true, force: true });
    } else entries.push({ name, mtime });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const e of entries.slice(KEEP))
    await rm(join(kindDir, e.name), { recursive: true, force: true });
}
