import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';

const SOURCE =
  'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn f u32 -> u32\nb call sq p0\nc add b 1\nret c\nend\n';

async function connect(launch: string): Promise<Client> {
  const server = await createServer(launch);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; error: boolean }> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  return { text: content[0]?.text ?? '', error: r.isError === true };
}

async function withRoot(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'a0-mcp-'));
  try {
    await mkdir(join(base, 'root'));
    await writeFile(join(base, 'root', 'm.a0'), SOURCE);
    await writeFile(join(base, 'outside.a0'), SOURCE);
    await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('mcp: every tool over the in-memory transport', () =>
  withRoot(async (base) => {
    const client = await connect(join(base, 'root', 'm.a0'));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'a0_apply',
      'a0_check',
      'a0_emit',
      'a0_open',
      'a0_program',
      'a0_run',
      'a0_save',
    ]);

    const check = await call(client, 'a0_check', {});
    assert.match(check.text, /^sq \(u32\) -> u32: 1 nodes/m);

    assert.equal((await call(client, 'a0_run', { function: 'f', args: [3] })).text, '10');
    const noFuel = await call(client, 'a0_run', { function: 'f', args: [3], fuel: 1 });
    assert.ok(noFuel.error);
    assert.equal(JSON.parse(noFuel.text).code, 'limit');

    assert.match((await call(client, 'a0_emit', { target: 'js' })).text, /function/);

    const early = await call(client, 'a0_save', {});
    assert.ok(early.error);

    const view = await call(client, 'a0_open', { function: 'f' });
    const handle = view.text.split('\n')[0] ?? '';
    assert.match(handle, /^e[0-9]+$/);
    assert.match(view.text, /sq/);

    const bad = await call(client, 'a0_apply', { edit: `${handle}\nc add b zz` });
    assert.ok(bad.error);
    const diag = JSON.parse(bad.text) as Record<string, unknown>;
    for (const k of ['code', 'message', 'expected', 'actual', 'fix']) assert.ok(k in diag);

    const good = await call(client, 'a0_apply', { edit: `${handle}\nc add b 2` });
    assert.ok(!good.error, good.text);
    assert.match(good.text, /c add b 2/);
    assert.equal((await call(client, 'a0_run', { function: 'f', args: [3] })).text, '11');

    const prog = await call(client, 'a0_program', { target: 'sq' });
    const g = prog.text.split('\n')[0] ?? '';
    assert.match(g, /^g[0-9]+$/);
    const added = await call(client, 'a0_apply', {
      edit: `${g}\nfn cube u32 -> u32\na call sq p0\nb mul a p0\nret b\nend`,
    });
    assert.ok(!added.error, added.text);
    assert.equal((await call(client, 'a0_run', { function: 'cube', args: [2] })).text, '8');

    const saved = await call(client, 'a0_save', {});
    assert.equal(saved.text, 'm.a0');
    const written = await readFile(join(base, 'root', 'm.a0'), 'utf8');
    assert.match(written, /c add b 2/);
    assert.match(written, /fn cube/);
    await client.close();
  }));

test('mcp: paths are confined to the root, symlink escapes included', () =>
  withRoot(async (base) => {
    await symlink(join(base, 'outside.a0'), join(base, 'root', 'link.a0'));
    await symlink(join(base, 'gone.a0'), join(base, 'root', 'dangling.a0'));
    await writeFile(
      join(base, 'root', 'uses.a0'),
      'use "../outside.a0"\n\nfn g u32 -> u32\nret p0\nend\n',
    );
    const client = await connect(join(base, 'root'));
    const need = await call(client, 'a0_check', {});
    assert.ok(need.error);
    for (const file of ['../outside.a0', join(base, 'outside.a0'), 'link.a0', 'm.txt', 'uses.a0']) {
      const r = await call(client, 'a0_check', { file });
      assert.ok(r.error, file);
    }
    const view = await call(client, 'a0_open', { file: 'm.a0', function: 'f' });
    const handle = view.text.split('\n')[0] ?? '';
    await call(client, 'a0_apply', { file: 'm.a0', edit: `${handle}\nc add b 5` });
    for (const path of ['../escape.a0', 'dangling.a0', 'link.a0']) {
      const r = await call(client, 'a0_save', { file: 'm.a0', path });
      assert.ok(r.error, path);
    }
    await assert.rejects(readFile(join(base, 'escape.a0')));
    await assert.rejects(readFile(join(base, 'gone.a0')));
    assert.equal(await readFile(join(base, 'outside.a0'), 'utf8'), SOURCE);
    const ok = await call(client, 'a0_save', { file: 'm.a0', path: 'sub.a0' });
    assert.equal(ok.text, 'sub.a0');
    await client.close();
  }));

test('mcp: diagnostics carry no host paths; an .a0 name must also resolve to an .a0 file', () =>
  withRoot(async (base) => {
    const root = join(base, 'root');
    await writeFile(join(root, 'bad.a0'), 'fn r u32 -> u32\na call r p0\nret a\nend\n');
    await writeFile(join(root, 'secret.env'), 'TOKEN=abc\n');
    await symlink(join(root, 'secret.env'), join(root, 'env.a0'));
    await mkdir(join(root, 'dir.a0'));
    const client = await connect(root);
    const bad = await call(client, 'a0_check', { file: 'bad.a0' });
    assert.ok(bad.error);
    assert.match(bad.text, /bad\.a0/);
    const view = await call(client, 'a0_open', { file: 'm.a0', function: 'f' });
    await call(client, 'a0_apply', {
      file: 'm.a0',
      edit: `${view.text.split('\n')[0] ?? ''}\nc add b 5`,
    });
    const dir = await call(client, 'a0_save', { file: 'm.a0', path: 'dir.a0' });
    assert.ok(dir.error);
    for (const r of [bad, dir]) {
      assert.ok(!r.text.includes(base), r.text);
      assert.ok(!r.text.includes('/private/'), r.text);
    }
    for (const r of [
      await call(client, 'a0_check', { file: 'env.a0' }),
      await call(client, 'a0_save', { file: 'm.a0', path: 'env.a0' }),
    ]) {
      assert.ok(r.error);
      assert.ok(!r.text.includes('TOKEN'), r.text);
    }
    assert.equal(await readFile(join(root, 'secret.env'), 'utf8'), 'TOKEN=abc\n');
    await client.close();
  }));
