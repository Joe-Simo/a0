/**
 * Persistent artifact cache (content-addressed, on disk).
 *
 * Keys are SHA-256 of a descriptor naming everything the artifact depends on: compiler
 * version, target, optimization level, and the function's *semantic* revision (its own
 * text plus every transitive callee); for native artifacts, the toolchain identity and
 * flags plus the hash of the exact module text. A dependency change therefore cannot hide
 * behind a stale hit. Entries are immutable files; absence or corruption is a miss.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assemble,
  type CompileOptions,
  emitFunction,
  functionEmissionKey,
  prepareCompilation,
  type Target,
} from './backends.js';
import type { TypedFunc, TypedProgram } from './core.js';
import { withPlaintextWrite, withPlaintextWrites } from './plaintext-write.js';
import { protectionPolicy } from './protection-policy.js';

export const DEFAULT_CACHE_DIR = '.a0-cache';

export function cacheKey(descriptor: string): string {
  return createHash('sha256').update(descriptor, 'utf8').digest('hex');
}

export class DiskCache {
  readonly dir: string;
  hits = 0;
  misses = 0;

  constructor(
    dir = process.env.A0_CACHE_DIR ?? DEFAULT_CACHE_DIR,
    readonly sourcePath = process.cwd(),
  ) {
    this.dir = resolve(dir);
    this.sourcePath = resolve(sourcePath);
  }

  #path(key: string): string {
    return join(this.dir, key.slice(0, 2), key);
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      const data = await readFile(this.#path(key));
      this.hits += 1;
      return data;
    } catch {
      this.misses += 1;
      return undefined;
    }
  }

  async #put(key: string, data: Buffer | string): Promise<void> {
    const parent = join(this.dir, key.slice(0, 2));
    await mkdir(parent, { recursive: true });
    const tmp = join(parent, `.a0-cache-${process.pid}-${randomUUID()}`);
    try {
      await writeFile(tmp, data, { flag: 'wx' });
      await rename(tmp, this.#path(key));
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    await this.withWrites((put) => put(key, data));
  }

  /** One lease covers every asynchronous write of an emitted module. */
  async withWrites<T>(action: (put: CacheWriter) => Promise<T>): Promise<T> {
    protectionPolicy(this.sourcePath);
    protectionPolicy(this.dir);
    return withPlaintextWrites([this.sourcePath, this.dir], async () => {
      // The outer leases guard the source and existing destination ancestor. Register
      // the created directory itself before payload writes so sealing that root sees it.
      await mkdir(this.dir, { recursive: true });
      return withPlaintextWrite(this.dir, async () => {
        let open = true;
        const pending: Promise<void>[] = [];
        try {
          return await action((key, data) => {
            if (!open) return Promise.reject(new Error('cache write batch is closed'));
            const write = this.#put(key, data);
            pending.push(write);
            return write;
          });
        } finally {
          open = false;
          // Promise.all can reject while sibling writes are still in flight. Keep the lease
          // until every started write settles, including cleanup of its temporary file.
          await Promise.allSettled(pending);
        }
      });
    });
  }
}

/** Descriptor for one function's emitted text on one target. */
export function emissionKey(target: Target, fn: TypedFunc, options: CompileOptions = {}): string {
  return cacheKey(`emit|${functionEmissionKey(target, fn, options)}`);
}

export interface CachedCompile {
  readonly text: string;
  readonly hits: number;
  readonly misses: number;
}
export type CacheWriter = (key: string, data: Buffer | string) => Promise<void>;

export interface ArtifactCache {
  readonly hits: number;
  readonly misses: number;
  get(key: string): Promise<Buffer | undefined>;
  put(key: string, data: Buffer | string): Promise<void>;
  withWrites?<T>(action: (put: CacheWriter) => Promise<T>): Promise<T>;
}

/**
 * Compile with per-function emission served from the disk cache: validation and module
 * assembly still run, only missing function bodies are emitted. The text equals `compile`'s.
 */
export async function compileCached(
  program: TypedProgram,
  target: Target,
  cache: ArtifactCache,
  options: CompileOptions = {},
): Promise<CachedCompile> {
  const prepared = prepareCompilation(program, target);
  const before = { hits: cache.hits, misses: cache.misses };
  // All lookups are issued at once: the warm path is dominated by per-file read latency
  // (measured ~90 % of a 14-function compile when awaited in series), not by bytes.
  const keys = prepared.functions.map((fn) => emissionKey(target, fn, options));
  const hits = await Promise.all(keys.map((key) => cache.get(key)));
  const emitBodies = (put: CacheWriter) =>
    Promise.all(
      prepared.functions.map(async (fn, i) => {
        const hit = hits[i];
        if (hit !== undefined) return hit.toString('utf8');
        const body = emitFunction(target, fn, options);
        await put(keys[i] as string, body);
        return body;
      }),
    );
  const bodies =
    cache.withWrites !== undefined && hits.some((hit) => hit === undefined)
      ? await cache.withWrites(emitBodies)
      : await emitBodies(cache.put.bind(cache));

  return {
    text: assemble(target, bodies, prepared, options),
    hits: cache.hits - before.hits,
    misses: cache.misses - before.misses,
  };
}

/** Descriptor for a native/wasm artifact built from exact module text with a given toolchain. */
export function artifactKey(
  kind: string,
  toolchain: string,
  flags: readonly string[],
  moduleText: string,
): string {
  const text = createHash('sha256').update(moduleText, 'utf8').digest('hex');
  return cacheKey(`${kind}|${toolchain}|${flags.join(' ')}|${text}`);
}
