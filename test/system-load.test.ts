import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  type CpuTimes,
  loadBetween,
  loadSource,
  systemLoad,
  systemLoadSampled,
  systemLoadTriple,
} from '../tools/system-load.js';

const cpu = (user: number, idle: number): CpuTimes[number] => ({
  model: 'x',
  speed: 1,
  times: { user, nice: 0, sys: 0, idle, irq: 0 },
});
function fake(...snaps: CpuTimes[]): () => CpuTimes {
  let i = 0;
  return () => snaps[Math.min(i++, snaps.length - 1)] as CpuTimes;
}

describe('system load', () => {
  test('POSIX uses loadavg', () => {
    const env = { platform: 'linux', loadavg: () => [3.5, 1, 1] };
    assert.equal(loadSource(env), 'loadavg');
    assert.equal(systemLoad(env), 3.5);
    assert.deepEqual(systemLoadTriple(env), [3.5, 1, 1]);
  });
  test('Windows: saturation equals the cpu count, idle is 0, half is half', () => {
    const zero = [cpu(0, 0), cpu(0, 0), cpu(0, 0), cpu(0, 0)];
    const full = [cpu(100, 0), cpu(100, 0), cpu(100, 0), cpu(100, 0)];
    const half = [cpu(50, 50), cpu(50, 50), cpu(50, 50), cpu(50, 50)];
    const none = [cpu(0, 100), cpu(0, 100), cpu(0, 100), cpu(0, 100)];
    assert.equal(loadSource({ platform: 'win32' }), 'cpu-utilisation');
    assert.equal(loadBetween(zero, full), 4);
    assert.equal(loadBetween(zero, half), 2);
    assert.equal(loadBetween(zero, none), 0);
    assert.equal(systemLoad({ platform: 'win32', cpus: fake(zero, full) }), 4);
    assert.deepEqual(systemLoadTriple({ platform: 'win32', cpus: fake(zero, half) }), [2, 2, 2]);
  });
  test('sampled form waits and treats a zero-elapsed window as 0', async () => {
    let slept = 0;
    const zero = [cpu(0, 0)];
    const env = {
      platform: 'win32',
      cpus: fake(zero, [cpu(10, 0)]),
      sleep: async (n: number) => {
        slept = n;
      },
    };
    assert.equal(await systemLoadSampled(250, env), 1);
    assert.equal(slept, 250);
    assert.equal(
      await systemLoadSampled(1, {
        platform: 'win32',
        cpus: fake(zero, zero),
        sleep: async () => {},
      }),
      0,
    );
  });
});
