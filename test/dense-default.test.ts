import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getEncoding } from 'js-tiktoken';
import { createServer } from '../src/mcp.js';

// The dense surface is the default of the MCP tools since docs/history/2026-10-07-dense-leniency-preregistration.md.

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the skill carries the 189-token dense primer D1 beside the canonical one, in the plugin copy too', () => {
  const d1 = read('experiments/primers/dense/D1.txt');
  assert.equal(read('skills/a0/references/primer.dense.txt'), d1);
  assert.equal(read('plugin/skills/a0/references/primer.dense.txt'), d1);
  assert.equal(getEncoding('o200k_base').encode(d1).length, 189);
  assert.match(read('skills/a0/SKILL.md'), /dense: false/);
});

test('mcp: a canonical file opens dense by default, dense false is the opt-out, and a .a0 file saves canonical', async () => {
  const base = await mkdtemp(join(tmpdir(), 'a0-dense-default-'));
  try {
    await writeFile(
      join(base, 'm.a0'),
      'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn f u32 -> u32\nb call sq p0\nc add b 1\nret c\nend\n',
    );
    const server = await createServer(join(base, 'm.a0'));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      assert.ok(!r.isError, r.content[0]?.text);
      return r.content[0]?.text ?? '';
    };
    const dense = await call('a0_open', { file: 'm.a0', function: 'f' });
    assert.match(dense, /^e[0-9]+\nfn f\nb sq A\nc add b 1\n# sq u32 -> u32$/);
    const canonical = await call('a0_open', { file: 'm.a0', function: 'f', dense: false });
    assert.match(canonical, /^e[0-9]+\nfn f u32 -> u32\nb call sq p0\nc add b 1\nret c\nend/);
    const handle = dense.split('\n')[0] ?? '';
    await call('a0_apply', { file: 'm.a0', edit: `${handle}\nfn f add sq A 5` });
    assert.equal(await call('a0_run', { file: 'm.a0', function: 'f', args: [2] }), '9');
    await call('a0_save', { file: 'm.a0' });
    assert.match(await readFile(join(base, 'm.a0'), 'utf8'), /^fn sq u32 -> u32\n/);
    await client.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
