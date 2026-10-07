/**
 * One definition of "how busy is the machine" for every timing gate and recorded load number.
 *
 * POSIX: `os.loadavg()[0]`, the kernel's 1-minute run-queue average (source name 'loadavg').
 * Windows: `os.loadavg()` is always [0, 0, 0], so a gate built on it reads "quiet" on a busy machine. There the load is
 * estimated from CPU utilisation: sample the per-core time counters of `os.cpus()` twice, utilisation = busy / total
 * time between the samples, load = utilisation * cpu count (source name 'cpu-utilisation').
 *
 * Equivalence and limits: full saturation gives a load equal to the CPU count, as a load average of N does on N cores
 * with N runnable tasks, so the repo's limits (10, 6) order "busy" the same way. It is NOT the same quantity: a load
 * average counts runnable tasks and can exceed the CPU count when tasks queue; utilisation is capped at the CPU count
 * and cannot see queue depth. It is also an instantaneous window (about 1 s async, 100 ms for the sync form), not a
 * 1-minute smoothed average, so it is noisier and a short idle gap reads quiet. Read it as "at least this busy".
 */

import { cpus as osCpus, loadavg as osLoadavg } from 'node:os';

export type LoadSource = 'loadavg' | 'cpu-utilisation';
export type CpuTimes = ReturnType<typeof osCpus>;
export interface LoadEnv {
  readonly platform?: string;
  readonly cpus?: () => CpuTimes;
  readonly loadavg?: () => number[];
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Which source `systemLoad()` uses on this platform. */
export function loadSource(env: LoadEnv = {}): LoadSource {
  return (env.platform ?? process.platform) === 'win32' ? 'cpu-utilisation' : 'loadavg';
}

/** Load implied by two `cpus()` snapshots: utilisation * cpu count (0 when no time elapsed). */
export function loadBetween(a: CpuTimes, b: CpuTimes): number {
  const n = Math.min(a.length, b.length);
  let busy = 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (a[i] as CpuTimes[number]).times;
    const y = (b[i] as CpuTimes[number]).times;
    const idle = y.idle - x.idle;
    const all = y.user - x.user + (y.nice - x.nice) + (y.sys - x.sys) + (y.irq - x.irq) + idle;
    total += all;
    busy += all - idle;
  }
  return total <= 0 ? 0 : (busy / total) * n;
}

/** Best-effort synchronous load. On Windows blocks for 100 ms to take a CPU sample. */
export function systemLoad(env: LoadEnv = {}): number {
  if (loadSource(env) === 'loadavg') return (env.loadavg ?? osLoadavg)()[0] ?? 0;
  const cpus = env.cpus ?? osCpus;
  const a = cpus();
  Atomics.wait(sleeper, 0, 0, 100);
  return loadBetween(a, cpus());
}

/** Load sampled over `ms` (default 1 s) on Windows; immediate on POSIX. */
export async function systemLoadSampled(
  ms = 1000,
  env: LoadEnv & { readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  if (loadSource(env) === 'loadavg') return (env.loadavg ?? osLoadavg)()[0] ?? 0;
  const cpus = env.cpus ?? osCpus;
  const a = cpus();
  await (env.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  return loadBetween(a, cpus());
}

/** Drop-in for `os.loadavg()` call sites that record a 3-element array: on Windows all three are the one sample. */
export function systemLoadTriple(env: LoadEnv = {}): number[] {
  if (loadSource(env) === 'loadavg') return (env.loadavg ?? osLoadavg)();
  const s = systemLoad(env);
  return [s, s, s];
}
