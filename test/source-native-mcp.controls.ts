/** Actual pinned package over the MCP protocol; no checkout freshness wrapper or default switch. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type McpSurface } from '../src/mcp.js';
import { nativeSource } from '../src/source-native.js';
import { nativeMcpLanguageServices } from '../src/source-native-mcp.js';
import { loadNativeSourcePackage } from '../src/source-native-package.js';

const directory = process.env.A0_SOURCE_PACKAGE;
const expected = process.env.A0_SOURCE_PACKAGE_SHA256;
assert.ok(directory && expected, 'A0_SOURCE_PACKAGE and A0_SOURCE_PACKAGE_SHA256 required');
const manifest = await readFile(join(directory, 'manifest.json'));
const packaged = await loadNativeSourcePackage(manifest, expected, (file) =>
  readFile(join(directory, file)),
);
type Frontend = ReturnType<typeof nativeSource>;
const scratch = resolve('.a0-tmp/native-mcp-controls');
const SOURCE =
  '# owned Ω😀\nfn f u32 u32 -> u32 # declaration\nex 2 3 -> 5\nx add A B # original\nret x\nend # end\n';

async function fixture(work: (root: string) => Promise<void>) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'fixture-'));
  try {
    await writeFile(join(root, 'm.a0'), SOURCE);
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function protocol(root: string, frontend: Frontend, surface: McpSurface = 'full') {
  const server = await createServer(root, {
    language: nativeMcpLanguageServices(frontend),
    surface,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'native-mcp-test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content[0]?.text ?? '', error: result.isError === true };
}

for (const surface of ['full', 'compact'] as const) {
  test(`native MCP ${surface}: one native syntax edits specs, repairs and saves source metadata`, async () => {
    await fixture(async (root) => {
      const frontend = packaged.instantiate();
      const client = await protocol(join(root, 'm.a0'), frontend, surface);
      try {
        const tools = (await client.listTools()).tools;
        for (const tool of tools) assert.ok(!('dense' in (tool.inputSchema.properties ?? {})));
        const opened = await call(client, 'a0_open', { function: 'f' });
        assert.equal(opened.error, false, opened.text);
        assert.match(opened.text, /fn f _ _ -> _/);
        const wrong = await call(client, 'a0_apply', { edit: 'x add A 2' });
        assert.equal(wrong.error, true, wrong.text);
        assert.equal(JSON.parse(wrong.text).id, 'A0715');
        assert.equal(JSON.parse((await call(client, 'a0_save')).text).id, 'A0806');
        const changed = await call(client, 'a0_apply', {
          edit: '# Ω😀\r\n```a0\r\ne0\r\nx add A 2 # changed\r\n-ex 2 3 -> 5\r\n+ex 2 3 -> 4\r\n```',
        });
        assert.equal(changed.error, false, changed.text);
        const malformed = await call(client, 'a0_apply', { edit: 'e0\nx ADD A 2' });
        assert.equal(malformed.error, true, malformed.text);
        assert.equal(JSON.parse(malformed.text).id, 'A0011');
        const repaired = await call(client, 'a0_apply', { edit: 'fix all' });
        assert.equal(repaired.error, false, repaired.text);
        if (surface === 'full') {
          assert.equal((await call(client, 'a0_run', { function: 'f', args: [2, 3] })).text, '4');
          const checked = await call(client, 'a0_check');
          assert.equal(checked.error, false, checked.text);
          assert.match(checked.text, /rev [0-9a-f]{12}/);
        }
        assert.equal((await call(client, 'a0_save')).error, false);
        const saved = await readFile(join(root, 'm.a0'), 'utf8');
        assert.match(saved, /# declaration/);
        assert.match(saved, /# changed/);
        assert.match(saved, /end # end/);
        assert.match(saved, /ex 2 3 -> 4/);
        assert.match(saved, /x add A 2/);
        assert.ok(frontend.parse(saved).ok);
      } finally {
        await client.close();
        assert.ok(frontend.parse('fn lifetime\nret A\nend\n').ok);
        frontend.close();
      }
    });
  });

  test(`native MCP ${surface}: native response refusal restores prior repair, handles and dirty state`, async () => {
    await fixture(async (root) => {
      const host = packaged.instantiate();
      let refuse = false;
      let checked = false;
      const frontend: Frontend = {
        ...host,
        checkProgram(program, budget) {
          const result = host.checkProgram(program, budget);
          if (refuse && result.ok) checked = true;
          return result;
        },
        format(result, request) {
          return refuse && checked
            ? { ok: false, reason: 'unavailable' }
            : host.format(result, request);
        },
      };
      const client = await protocol(join(root, 'm.a0'), frontend, surface);
      try {
        assert.equal((await call(client, 'a0_open', { function: 'f' })).error, false);
        const malformed = await call(client, 'a0_apply', { edit: 'x ADD A B' });
        assert.equal(malformed.error, true, malformed.text);
        assert.equal(JSON.parse(malformed.text).id, 'A0011');
        refuse = true;
        const attempted = await call(client, 'a0_apply', { edit: 'x add B A' });
        assert.equal(attempted.error, true, attempted.text);
        assert.equal(JSON.parse(attempted.text).id, 'A0809');
        assert.equal(
          checked,
          true,
          'the native checker accepted before response formatting refused',
        );
        assert.equal(JSON.parse((await call(client, 'a0_save')).text).id, 'A0806');
        assert.equal(await readFile(join(root, 'm.a0'), 'utf8'), SOURCE);
        refuse = false;
        const repaired = await call(client, 'a0_apply', { edit: 'fix all' });
        assert.equal(repaired.error, false, repaired.text);
        assert.match(repaired.text, /x add A B/);
        assert.equal((await call(client, 'a0_save')).error, false);
        assert.match(await readFile(join(root, 'm.a0'), 'utf8'), /x add A B/);
      } finally {
        await client.close();
        host.close();
      }
    });
  });
}

test('native MCP graph diagnostics keep physical owners, encoding and source policy', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'bad.a0'), '# Ω😀\nfn bad\nx absent A\nret x\nend\n');
    await writeFile(join(root, 'entry.a0'), 'use "bad.a0"\nfn entry\nret A\nend\n');
    await writeFile(join(root, 'bytes.a0'), Uint8Array.from([0xff]));
    await writeFile(join(root, 'old.a0d'), 'fn f add A 1\n');
    const frontend = packaged.instantiate();
    const client = await protocol(root, frontend);
    try {
      const bad = await call(client, 'a0_check', { file: 'entry.a0' });
      assert.equal(bad.error, true, bad.text);
      const diagnostic = JSON.parse(bad.text);
      assert.equal(diagnostic.id, 'A0102');
      assert.match(diagnostic.message, /bad\.a0:3:/);
      assert.ok(!bad.text.includes(root));
      const bytes = await call(client, 'a0_check', { file: 'bytes.a0' });
      assert.equal(bytes.error, true);
      assert.equal(JSON.parse(bytes.text).id, 'A0808');
      const legacy = await call(client, 'a0_check', { file: 'old.a0d' });
      assert.equal(legacy.error, true);
      assert.equal(JSON.parse(legacy.text).id, 'A0802');
      assert.equal((await call(client, 'a0_open', { file: 'm.a0', function: 'f' })).error, false);
    } finally {
      await client.close();
      frontend.close();
    }
  });
});

test('native MCP failed source serialization preserves a dirty edit for a later save', async () => {
  await fixture(async (root) => {
    const host = packaged.instantiate();
    let refuse = true;
    const frontend: Frontend = {
      ...host,
      format(result, request) {
        return refuse && request?.scope === 'source'
          ? { ok: false, reason: 'unavailable' }
          : host.format(result, request);
      },
    };
    const client = await protocol(join(root, 'm.a0'), frontend);
    try {
      assert.equal((await call(client, 'a0_open', { function: 'f' })).error, false);
      const changed = await call(client, 'a0_apply', { edit: 'x add B A # swapped' });
      assert.equal(changed.error, false, changed.text);
      const failedSave = await call(client, 'a0_save');
      assert.equal(failedSave.error, true, failedSave.text);
      assert.equal(JSON.parse(failedSave.text).id, 'A0809');
      assert.equal(await readFile(join(root, 'm.a0'), 'utf8'), SOURCE);
      refuse = false;
      assert.equal((await call(client, 'a0_save')).error, false);
      const saved = await readFile(join(root, 'm.a0'), 'utf8');
      assert.match(saved, /x add B A # swapped/);
      assert.ok(host.parse(saved).ok);
      assert.equal(JSON.parse((await call(client, 'a0_save')).text).id, 'A0806');
    } finally {
      await client.close();
      host.close();
    }
  });
});

test('native MCP companion absence and closed borrowed frontends refuse without historical acceptance', async () => {
  await fixture(async (root) => {
    const raw = nativeSource(
      new WebAssembly.Module(await readFile(join(directory, 'frontend.wasm'))),
    );
    const client = await protocol(join(root, 'm.a0'), raw);
    try {
      const opened = await call(client, 'a0_open', { function: 'f' });
      assert.equal(opened.error, true, opened.text);
      assert.equal(JSON.parse(opened.text).id, 'A0809');
      assert.equal(JSON.parse((await call(client, 'a0_save')).text).id, 'A0806');
      assert.ok(raw.parse(SOURCE).ok);
      raw.close();
      const closed = await call(client, 'a0_open', { function: 'f' });
      assert.equal(closed.error, true, closed.text);
      assert.equal(JSON.parse(closed.text).id, 'A0809');
      assert.equal(await readFile(join(root, 'm.a0'), 'utf8'), SOURCE);
    } finally {
      await client.close();
      raw.close();
    }
  });
});
