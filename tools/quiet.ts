/**
 * Load gate for timing runs (lang-axes, exec-bench): before every sample group, wait until the
 * 1-minute load average is at or below the limit (default 10, the repo's rule for performance
 * claims; override with A0_MAX_LOAD). Synchronous so it can sit inside the existing sample loops.
 * `loadGate()` reports what the gate saw, for the results file: how many checks, how many waits,
 * the seconds waited and the highest 1-minute load seen at a sample start.
 */

import { loadavg } from 'node:os';

const MAX_LOAD = Number(process.env.A0_MAX_LOAD ?? '10');
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let checks = 0;
let waits = 0;
let waitedMs = 0;
let maxSeen = 0;

/** Block (polling every 3 s) while the 1-minute load average is above the limit. */
export function waitQuiet(): void {
  checks += 1;
  for (;;) {
    const load = loadavg()[0] ?? 0;
    if (load <= MAX_LOAD) {
      maxSeen = Math.max(maxSeen, load);
      return;
    }
    if (waits === 0 || waitedMs % 60_000 < 3_000)
      process.stderr.write(`load ${load.toFixed(1)} > ${MAX_LOAD}: waiting\n`);
    waits += 1;
    Atomics.wait(sleeper, 0, 0, 3_000);
    waitedMs += 3_000;
  }
}

export function loadGate(): {
  readonly maxLoad: number;
  readonly checks: number;
  readonly waits: number;
  readonly waitedSeconds: number;
  readonly highestLoadAtSampleStart: number;
} {
  return {
    maxLoad: MAX_LOAD,
    checks,
    waits,
    waitedSeconds: waitedMs / 1000,
    highestLoadAtSampleStart: Math.round(maxSeen * 100) / 100,
  };
}
