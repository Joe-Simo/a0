import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const surface of ['full', 'compact'] as const) {
  test(`MCP ${surface}: filesystem save finishes before a later edit can clear its dirty state`, {
    skip:
      process.platform === 'win32'
        ? 'deterministic filesystem-worker control uses POSIX FIFO'
        : false,
  }, () => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/mcp-save-order.js', import.meta.url)), 'legacy', surface],
      { encoding: 'utf8', env: { ...process.env, UV_THREADPOOL_SIZE: '1' }, timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(JSON.parse(child.stdout), {
      backend: 'legacy',
      surface,
      ordered: true,
      secondSave: 'saved',
    });
  });
}
