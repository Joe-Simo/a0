/** Local-process evidence for explicit lock recovery. Unknown hosts always fail closed. */
import { readFile, readlink } from 'node:fs/promises';
import { ProtectionError } from './errors.js';

interface Scope {
  readonly boot: string;
  readonly namespace: string;
}
let scopePromise: Promise<Scope | undefined> | undefined;
function localScope(): Promise<Scope | undefined> {
  if (scopePromise === undefined)
    scopePromise = (async () => {
      if (process.platform !== 'linux') return undefined;
      try {
        const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        const namespace = await readlink('/proc/self/ns/pid');
        if (!/^[0-9a-f-]{36}$/.test(boot) || !/^pid:\[\d+\]$/.test(namespace)) return undefined;
        return { boot, namespace };
      } catch {
        return undefined;
      }
    })();
  return scopePromise;
}

export async function processLockRecord(): Promise<object> {
  return { format: 'a0-process-lock-1', pid: process.pid, scope: (await localScope()) ?? null };
}

/** PID absence is meaningful only in the same current boot and PID namespace. */
export async function assertDeadLocalProcess(record: unknown): Promise<void> {
  const lock = record as { format?: unknown; pid?: unknown; scope?: Partial<Scope> } | null;
  const current = await localScope();
  if (
    lock?.format !== 'a0-process-lock-1' ||
    typeof lock.pid !== 'number' ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 0 ||
    lock.pid > 0x7fffffff ||
    !current ||
    lock.scope?.boot !== current.boot ||
    lock.scope?.namespace !== current.namespace
  )
    throw new ProtectionError('LOCK_OWNER_UNVERIFIABLE');
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new ProtectionError('LOCK_OWNER_UNVERIFIABLE');
  }
  throw new ProtectionError('LOCK_OWNER_ALIVE');
}
