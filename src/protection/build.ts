/** Shared optimized compiler plus explicit artifact adapters. No second frontend or interpreter. */
import { relative, resolve, sep } from 'node:path';
import { type CompileOptions, compile, type Target } from '../backends.js';
import { type ArtifactCache, compileCached } from '../cache.js';
import type { Profile } from '../core.js';
import { link } from '../link.js';
import type { LspFrontend } from '../lsp-frontend.js';
import { protectionPolicy, requireProtectedTarget } from '../protection-policy.js';
import { wasmModuleBytes } from '../wasm.js';
import { protectWasm } from './artifact.js';
import { digest, ProtectionError, utf8 } from './crypto.js';
import { type SealedProject, safePath } from './vault.js';

export { protectWasm } from './artifact.js';

function assertSession(project: SealedProject): void {
  if (project.status.locked) throw new ProtectionError('LOCKED');
  if (project.status.phase !== 'on') throw new ProtectionError('MIGRATION_IN_PROGRESS');
}

export async function linkSealed(
  project: SealedProject,
  entry: string,
  profile?: Profile,
  frontend?: Pick<LspFrontend, 'link'>,
): ReturnType<typeof link> {
  if (project.status.phase !== 'on') throw new ProtectionError('MIGRATION_IN_PROGRESS');
  safePath(entry);
  const sourceVersion = () =>
    JSON.stringify(
      Object.entries(project.entries())
        .filter(([, entry]) => entry.role === 'source')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, entry]) => [path, entry.object, entry.hash]),
    );
  const revision = sourceVersion();
  const source = project.sourceAccess('compiler');
  // Virtual paths use the linker's normal grammar/validator, with a portable source adapter.
  const root = resolve('a0-sealed-virtual-root');
  const read = async (path: string) => source.read(relative(root, path).split(sep).join('/'));
  const options = {
    root,
    canonicalPath: async (path: string) => resolve(path),
    ...(profile === undefined ? {} : { profile }),
  };
  const linked =
    frontend === undefined
      ? await link(resolve(root, entry), read, options)
      : await frontend.link(resolve(root, entry), read, options);
  assertSession(project);
  if (sourceVersion() !== revision) throw new ProtectionError('CONCURRENT_CHANGE');
  return linked;
}
export async function compileSealed(
  project: SealedProject,
  entry: string,
  target: Target,
  options: {
    readonly protect?: boolean;
    readonly cache?: boolean;
    readonly projectRoot?: string;
    readonly compilerOptions?: CompileOptions;
    readonly profile?: Profile;
    readonly frontend?: Pick<LspFrontend, 'link'>;
  } = {},
): Promise<Uint8Array> {
  const protect =
    options.protect === true ||
    (options.projectRoot !== undefined && protectionPolicy(options.projectRoot, true).protect);
  if (protect) requireProtectedTarget(target);
  const linked = await linkSealed(project, entry, options.profile, options.frontend);
  const sourceHash = await digest(utf8.encode(linked.text));
  assertSession(project);
  const cache = new SealedCache(project);
  let result: { text: string };
  try {
    result =
      options.cache === false
        ? compile(linked.program, target, options.compilerOptions)
        : await compileCached(linked.program, target, cache, options.compilerOptions);
    if (options.cache !== false) await cache.flush();
  } finally {
    cache.clear();
  }
  const raw = target === 'wasm' ? wasmModuleBytes(result.text) : utf8.encode(result.text);
  const protectedResult = protect ? protectWasm(raw) : undefined;
  const bytes = protectedResult?.bytes ?? raw;
  if (protectedResult && protectedResult.privateDebug.length > 0) {
    const data = utf8.encode(
      JSON.stringify(
        protectedResult.privateDebug.map((s) => ({ name: s.name, section: Array.from(s.section) })),
      ),
    );
    try {
      await project.write(`managed-debug/${sourceHash}`, data, 'private-debug');
    } finally {
      data.fill(0);
    }
  }
  try {
    assertSession(project);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

/** Same per-function cache keys and compiler path as OFF; only the storage adapter changes. */
export class SealedCache implements ArtifactCache {
  hits = 0;
  misses = 0;
  #pending = new Map<string, Buffer>();
  constructor(readonly project: SealedProject) {}
  async get(key: string): Promise<Buffer | undefined> {
    const path = `managed-cache/${key}`;
    if (!this.project.has(path)) {
      this.misses++;
      return undefined;
    }
    const bytes = await this.project.read(path);
    try {
      this.hits++;
      return Buffer.from(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  async put(key: string, data: Buffer | string): Promise<void> {
    this.#pending.set(key, Buffer.from(data));
  }
  async flush(): Promise<void> {
    await this.project.writeBatch(
      [...this.#pending].map(([key, bytes]) => ({
        path: `managed-cache/${key}`,
        bytes,
        role: 'cache' as const,
      })),
    );
  }
  clear(): void {
    for (const data of this.#pending.values()) data.fill(0);
    this.#pending.clear();
  }
}
