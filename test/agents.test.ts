import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hookResponse, init } from '../src/agents.js';
import { link } from '../src/link.js';

const load = async (p: string) => (await link(p, (f) => readFile(f, 'utf8'))).program;

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'a0-agents-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('hook: clean A0 edit and non-A0 edit produce no output', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'ok.a0'), 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n');
    const ev = (f: string) => JSON.stringify({ cwd: dir, tool_input: { file_path: f } });
    assert.equal(await hookResponse(ev('ok.a0'), load), undefined);
    assert.equal(await hookResponse(ev('x.ts'), load), undefined);
  });
});

test('hook: broken A0 edit blocks with the diagnostic and fix', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'bad.a0'), 'fn f u32 -> u32\na add p0 q\nret a\nend\n');
    const out = await hookResponse(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        cwd: dir,
        tool_input: { file_path: 'bad.a0' },
      }),
      load,
    );
    assert.ok(out !== undefined);
    const r = JSON.parse(out) as {
      decision: string;
      reason: string;
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /a0 check bad\.a0 failed: error: /);
    assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
  });
});

test('init: writes agent files once and appends to an existing AGENTS.md', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'AGENTS.md'), '# Project\n');
    const first = await init(dir);
    for (const p of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/a0.mdc'])
      assert.ok(first.written.includes(p), p);
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith('# Project\n'));
    assert.match(agents, /a0_apply/);
    assert.match(agents, new RegExp(first.primer.replace(/[.]/g, '\\.')));
    assert.match(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
    const second = await init(dir);
    assert.ok(second.skipped.includes('AGENTS.md'));
    assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), agents);
  });
});
