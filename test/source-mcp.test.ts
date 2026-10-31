import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { validate } from '../src/core.js';
import { programRevision } from '../src/edit.js';
import { createServer, type McpSurface } from '../src/mcp.js';
import { parseSource } from '../src/source.js';
import { sourceMcpFrontend } from '../src/source-edit.js';

for (const surface of ['full', 'compact'] as const satisfies readonly McpSurface[]) {
  test(`candidate MCP ${surface}: bound grammar survives edit, save and reload`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-source-mcp-'));
    const path = join(dir, 'main.a0');
    await writeFile(path, 'fn f\nx << A 1\nret x\nend');
    const server = await createServer(path, { surface, frontend: sourceMcpFrontend });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: args });
      return {
        text: (reply.content as { text: string }[])[0]?.text ?? '',
        error: reply.isError === true,
      };
    };
    try {
      const opened = await call('a0_open', { function: 'f' });
      assert.equal(opened.error, false, opened.text);
      assert.match(opened.text, /fn f _ -> _/);
      assert.match(opened.text, /<< A 1/);
      const edited = await call('a0_apply', { edit: 'x << A 2' });
      assert.equal(edited.error, false, edited.text);
      assert.match(edited.text, /<< A 2/);
      if (surface === 'full') {
        assert.equal((await call('a0_run', { function: 'f', args: [3] })).text, '12');
        assert.equal((await call('a0_open', { function: 'f', dense: false })).error, true);
      }
      const saved = await call('a0_save', {});
      assert.equal(saved.error, false, saved.text);
      const text = await readFile(path, 'utf8');
      assert.match(text, /<< A 2/);
      assert.equal(
        programRevision(validate(parseSource(text))),
        programRevision(validate(parseSource('fn f\nx << A 2\nret x\nend'))),
      );
      const refused = await call(
        'a0_save',
        surface === 'full' ? { path: '../escape.a0' } : { file: '../escape.a0' },
      );
      assert.equal(refused.error, true);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('candidate MCP imported projects require explicit confined save destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-source-mcp-import-'));
  await writeFile(join(dir, 'lib.a0'), 'fn inc\nret add A 1\nend');
  const path = join(dir, 'main.a0');
  await writeFile(path, 'use "lib.a0"\nfn f\nx inc A\nret x\nend');
  const server = await createServer(path, { frontend: sourceMcpFrontend });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    return {
      text: (reply.content as { text: string }[])[0]?.text ?? '',
      error: reply.isError === true,
    };
  };
  try {
    assert.equal((await call('a0_open', { function: 'f' })).error, false);
    assert.equal((await call('a0_apply', { edit: 'x inc 4' })).error, false);
    assert.equal((await call('a0_save', {})).error, true);
    assert.equal((await call('a0_save', { path: 'converted.a0d' })).error, true);
    assert.equal((await call('a0_save', { path: 'combined.a0' })).error, false);
    const combined = validate(parseSource(await readFile(join(dir, 'combined.a0'), 'utf8')));
    assert.equal(combined.functions.length, 2);
    assert.equal(await readFile(path, 'utf8'), 'use "lib.a0"\nfn f\nx inc A\nret x\nend');
    assert.equal(await readFile(join(dir, 'lib.a0'), 'utf8'), 'fn inc\nret add A 1\nend');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
