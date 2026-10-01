import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('skill primer matches MODEL_GUIDE.min.txt', () => {
  assert.equal(read('plugin/skills/a0/references/primer.txt'), read('MODEL_GUIDE.min.txt'));
});

test('skill frontmatter follows the Agent Skills spec', () => {
  const front = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n/.exec(
    read('plugin/skills/a0/SKILL.md'),
  );
  assert.ok(front);
  assert.equal(front[1], 'a0');
  assert.ok((front[2] ?? '').length <= 1024);
});

test('plugin and extension manifests agree on version and server command', () => {
  const versions = [
    'plugin/.claude-plugin/plugin.json',
    'plugin/.codex-plugin/plugin.json',
    'gemini-extension.json',
  ].map((p) => (JSON.parse(read(p)) as { version: string }).version);
  assert.equal(new Set(versions).size, 1);
  const mcp = JSON.parse(read('integrations/mcp.json')) as {
    mcpServers: { a0: { command: string; args: string[] } };
  };
  assert.deepEqual(mcp.mcpServers.a0, { command: 'a0', args: ['mcp', '.'] });
});
