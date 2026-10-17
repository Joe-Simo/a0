/** In-memory adapter, also usable by browser/managed integrations without a filesystem mount. */

import type { Identity } from './crypto.js';
import { ProtectionError } from './crypto.js';
import { type Head, SealedProject, type VaultStore } from './vault.js';

export class MemoryVaultStore implements VaultStore {
  readonly objects = new Map<string, string>();
  current: Head | undefined;
  async head(): Promise<Head | undefined> {
    return structuredClone(this.current);
  }
  async get(id: string): Promise<string> {
    const value = this.objects.get(id);
    if (value === undefined) throw new ProtectionError('MISSING_OBJECT');
    return value;
  }
  async put(id: string, value: string): Promise<void> {
    if (this.objects.has(id)) {
      if (this.objects.get(id) !== value) throw new ProtectionError('OBJECT_COLLISION');
      return;
    }
    this.objects.set(id, value);
  }
  async commit(expected: string | undefined, head: Head): Promise<void> {
    if (this.current?.revision !== expected) throw new ProtectionError('CONCURRENT_CHANGE');
    this.current = structuredClone(head);
  }
}

/** Authenticate the entire export before installing its head. No plaintext filesystem staging. */
export async function importSealedProject(
  store: VaultStore,
  serialized: string,
  identity: Identity,
  trustedProject?: string,
): Promise<SealedProject> {
  if (await store.head()) throw new ProtectionError('ALREADY_EXISTS');
  const parsed = JSON.parse(serialized) as {
    format: string;
    head: Head;
    objects: Record<string, string>;
  };
  if (parsed.format !== 'a0-sealed-export-1' || !parsed.objects)
    throw new ProtectionError('INVALID_EXPORT');
  const memory = new MemoryVaultStore();
  for (const [id, value] of Object.entries(parsed.objects)) {
    if (!/^[0-9a-f]{48}$/.test(id) || typeof value !== 'string')
      throw new ProtectionError('INVALID_EXPORT');
    await memory.put(id, value);
  }
  await memory.commit(undefined, parsed.head);
  const verify = await SealedProject.unlock(memory, identity, trustedProject);
  try {
    const active = new Set([
      parsed.head.manifest,
      ...Object.values(verify.entries()).map((e) => e.object),
    ]);
    if (
      active.size !== memory.objects.size ||
      [...memory.objects.keys()].some((id) => !active.has(id))
    )
      throw new ProtectionError('UNEXPECTED_EXPORT_OBJECT');
    for (const path of Object.keys(verify.entries())) (await verify.read(path)).fill(0);
  } finally {
    verify.lock();
  }
  for (const [id, value] of memory.objects) await store.put(id, value);
  await store.commit(undefined, parsed.head);
  return SealedProject.unlock(store, identity, trustedProject);
}
