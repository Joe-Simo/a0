/** Lightweight guard shared by CLI/native/MCP/LSP. No cryptographic dependency on the OFF path. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ProtectionError } from './protection/errors.js';

export const POLICY_FILE = '.a0-protection.json';
export interface ProtectionPolicy {
  readonly format: 'a0-protection-1';
  readonly protect: boolean;
}
function present(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw e;
  }
}
export function protectionPolicy(path: string, allowSealed = false): { protect: boolean } {
  let protect = false;
  let real: string;
  try {
    real = realpathSync(path);
  } catch (e) {
    if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    real = resolve(path);
  }
  const seen = new Set<string>();
  const inputStat = lstatSync(real, { throwIfNoEntry: false });
  const isDirectory = inputStat?.isDirectory() === true;
  for (const start of [resolve(path), real].map((p) => (isDirectory ? p : dirname(p))))
    for (let dir = start; !seen.has(dir); dir = dirname(dir)) {
      seen.add(dir);
      const policy = join(dir, POLICY_FILE);
      if (present(policy)) {
        if (lstatSync(policy).isSymbolicLink()) throw new Error('A0 protection: UNSAFE_POLICY');
        const parsed = JSON.parse(readFileSync(policy, 'utf8')) as ProtectionPolicy;
        if (parsed.format !== 'a0-protection-1' || typeof parsed.protect !== 'boolean')
          throw new Error('A0 protection: INVALID_POLICY');
        protect ||= parsed.protect;
      }
      const store = join(dir, '.a0-seal');
      if (present(store)) {
        if (!lstatSync(store).isDirectory() || lstatSync(store).isSymbolicLink())
          throw new Error('A0 protection: UNSAFE_STORE');
        const head = JSON.parse(readFileSync(join(store, 'head.json'), 'utf8')) as {
          format: string;
          phase: string;
        };
        if (
          head.format !== 'a0-vault-1' ||
          !['on', 'off', 'sealing', 'unsealing'].includes(head.phase)
        )
          throw new Error('A0 protection: INVALID_HEAD');
        if (!allowSealed) throw new Error('A0 protection: SEALED_USE_UNLOCK_SESSION');
      }
      if (dirname(dir) === dir) break;
    }
  return { protect };
}
export function requireProtectedTarget(target: string): void {
  if (target !== 'wasm') throw new ProtectionError('TARGET_PROTECTION_PENDING');
}
/** Release packagers without a reviewed target adapter must stop before producing output. */
export function requirePackagingPolicy(path: string): void {
  if (protectionPolicy(path).protect) throw new ProtectionError('PACKAGING_PROTECTION_PENDING');
}
