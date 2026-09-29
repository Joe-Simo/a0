/**
 * Persistent artifact cache (content-addressed, on disk).
 *
 * Keys are SHA-256 of a descriptor naming everything the artifact depends on: compiler
 * version, target, optimization level, and the function's *semantic* revision (its own
 * text plus every transitive callee); for native artifacts, the toolchain identity and
 * flags plus the hash of the exact module text. A dependency change therefore cannot hide
 * behind a stale hit. Entries are immutable files; absence or corruption is a miss.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assemble,
  COMPILER_VERSION,
  type CompileOptions,
  emitFunction,
  type Target,
} from './backends.js';
import type { TypedFunc, TypedProgram } from './core.js';
import { semanticRevision } from './edit.js';

export const DEFAULT_CACHE_DIR = '.a0-cache';

export function cacheKey(descriptor: string): string {
  return createHash('sha256').update(descriptor, 'utf8').digest('hex');
}

export class DiskCache {
  readonly dir: string;
  hits = 0;
  misses = 0;

  constructor(dir = process.env.A0_CACHE_DIR ?? DEFAULT_CACHE_DIR) {
    this.dir = dir;
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

  async put(key: string, data: Buffer | string): Promise<void> {
    await mkdir(join(this.dir, key.slice(0, 2)), { recursive: true });
    // Write then rename so a concurrent reader never sees a partial entry.
    const tmp = join(tmpdir(), `a0-cache-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await writeFile(tmp, data);
    await rename(tmp, this.#path(key));
  }
}

/** Descriptor for one function's emitted text on one target. */
export function emissionKey(target: Target, fn: TypedFunc, options: CompileOptions = {}): string {
  const opt = options.optimize === false ? 'O0' : 'O1';
  return cacheKey(`emit|${COMPILER_VERSION}|${target}|${opt}|${semanticRevision(fn)}`);
}

export interface CachedCompile {
  readonly text: string;
  readonly hits: number;
  readonly misses: number;
}

/**
 * Compile with per-function emission served from the disk cache: validation and module
 * assembly still run, only missing function bodies are emitted. The text equals `compile`'s.
 */
export async function compileCached(
  program: TypedProgram,
  target: Target,
  cache: DiskCache,
  options: CompileOptions = {},
): Promise<CachedCompile> {
  const before = { hits: cache.hits, misses: cache.misses };
  // All lookups are issued at once: the warm path is dominated by per-file read latency
  // (measured ~90 % of a 14-function compile when awaited in series), not by bytes.
  const keys = program.functions.map((fn) => emissionKey(target, fn, options));
  const hits = await Promise.all(keys.map((key) => cache.get(key)));
  const bodies = await Promise.all(
    program.functions.map(async (fn, i) => {
      const hit = hits[i];
      if (hit !== undefined) return hit.toString('utf8');
      const body = emitFunction(target, fn, options);
      await cache.put(keys[i] as string, body);
      return body;
    }),
  );
  return {
    text: assemble(target, bodies, program),
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
