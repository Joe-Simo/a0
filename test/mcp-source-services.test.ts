/** MCP language dependency controls; these exercise wiring, not native session acceptance. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { formatProgram, formatSource, parseAndValidate } from '../src/core.js';
import { EditSession, revision } from '../src/edit.js';
import { link } from '../src/link.js';
import { createServer, type McpLanguageServices, type McpSurface } from '../src/mcp.js';
import { SYMLINKS } from './vpath.js';

const SOURCE =
  'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn f u32 -> u32\nb call sq p0\nret b\nend\n';
const scratch = resolve('.a0-tmp/mcp-source-services-tests');
const mark = '# supplied source serializer\n';

async function directory(work: (root: string) => Promise<void>) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'fixture-'));
  try {
    await writeFile(join(root, 'm.a0'), SOURCE);
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function protocol(launch: string, language: McpLanguageServices, surface?: McpSurface) {
  const server = await createServer(launch, {
    language,
    ...(surface === undefined ? {} : { surface }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'source-services-test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content[0]?.text ?? '', error: result.isError === true };
}

function services() {
  const counts = { loads: 0, sessions: 0, source: 0, program: 0, revisions: 0 };
  const views: Parameters<EditSession['open']>[1][] = [];
  const programViews: Parameters<EditSession['openProgram']>[0][] = [];
  class Session extends EditSession {
    override open(name: string, options: Parameters<EditSession['open']>[1] = {}) {
      views.push(options);
      return super.open(name, options);
    }
    override openProgram(options: Parameters<EditSession['openProgram']>[0] = {}) {
      programViews.push(options);
      return super.openProgram(options);
    }
  }
  const language: McpLanguageServices = {
    acceptsPath: (path) => path.endsWith('.a0'),
    async load(entry, read, options) {
      counts.loads++;
      return link(entry, read, options);
    },
    createSession(program) {
      counts.sessions++;
      return new Session(program);
    },
    formatProgram(program) {
      counts.program++;
      return `${mark}${formatProgram(program)}`;
    },
    formatSource(program) {
      counts.source++;
      return `${mark}${formatSource(program)}`;
    },
    revision(fn) {
      counts.revisions++;
      return revision(fn);
    },
  };
  return { language, counts, views, programViews };
}

test('MCP supplied services own graph loading, session views, revisions and both save routes', async () => {
  await directory(async (root) => {
    const supplied = services();
    const client = await protocol(join(root, 'm.a0'), supplied.language);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ['a0_open', 'a0_program']) {
        const tool = tools.find((tool) => tool.name === name);
        assert.ok(tool);
        assert.ok(!('dense' in (tool.inputSchema.properties ?? {})));
      }
      const checked = await call(client, 'a0_check');
      assert.equal(checked.error, false, checked.text);
      assert.match(checked.text, /f \(u32\) -> u32: 1 nodes, rev [a-f0-9]{12}/);
      assert.equal(supplied.counts.revisions, 2);
      assert.deepEqual([supplied.counts.loads, supplied.counts.sessions], [1, 1]);
      const opened = await call(client, 'a0_open', { function: 'f', lean: true });
      assert.equal(opened.error, false, opened.text);
      assert.match(opened.text, /^fn f u32 -> u32\n/);
      assert.ok(!opened.text.startsWith('e0\n'));
      assert.deepEqual(supplied.views, [{ scope: 'deps' }]);
      const edit = await call(client, 'a0_apply', { edit: 'b add p0 1' });
      assert.equal(edit.error, false, edit.text);
      assert.equal((await call(client, 'a0_run', { function: 'f', args: [4] })).text, '5');
      assert.equal((await call(client, 'a0_save')).text, 'm.a0');
      assert.equal(supplied.counts.source, 1);
      const written = await readFile(join(root, 'm.a0'), 'utf8');
      assert.ok(written.startsWith(mark));
      assert.equal(parseAndValidate(written).byName.get('f')?.nodes[0]?.op, 'add');

      const program = await call(client, 'a0_program');
      assert.equal(program.error, false, program.text);
      assert.deepEqual(supplied.programViews, [{}]);
      const changed = await call(client, 'a0_apply', {
        edit: `${program.text.split('\n')[0]}\nfn f u32 -> u32\nb add p0 2\nret b\nend`,
      });
      assert.equal(changed.error, false, changed.text);
      assert.equal((await call(client, 'a0_save', { path: 'copy.a0' })).text, 'copy.a0');
      assert.equal(supplied.counts.source, 2);
      assert.ok((await readFile(join(root, 'copy.a0'), 'utf8')).startsWith(mark));
      assert.deepEqual([supplied.counts.loads, supplied.counts.sessions], [1, 1]);
    } finally {
      await client.close();
    }
  });
});

test('MCP supplied services keep program fallback printing and compact tool layout in one syntax', async () => {
  await directory(async (root) => {
    const supplied = services();
    const client = await protocol(join(root, 'm.a0'), supplied.language, 'compact');
    try {
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ['a0_apply', 'a0_open', 'a0_save']);
      assert.ok(tools.every((tool) => !tool.description?.includes('dense')));
      const opened = await call(client, 'a0_open', { function: 'f' });
      assert.equal(opened.error, false, opened.text);
      assert.match(opened.text, /^fn f u32 -> u32\n/);
      assert.deepEqual(supplied.views, [{ scope: 'bodies' }]);
      const removed = await call(client, 'a0_apply', { edit: '-fn f' });
      assert.equal(removed.error, false, removed.text);
      assert.ok(removed.text.startsWith(mark));
      assert.equal(supplied.counts.program, 1);
      assert.equal((await call(client, 'a0_save')).text, 'm.a0');
      assert.equal(supplied.counts.source, 1);
      assert.deepEqual(
        parseAndValidate(await readFile(join(root, 'm.a0'), 'utf8')).functions.map((fn) => fn.name),
        ['sq'],
      );
    } finally {
      await client.close();
    }
  });
});

test('MCP supplied graph reads refuse malformed UTF-8 and source-policy failures without fallback', async () => {
  await directory(async (root) => {
    await writeFile(join(root, 'bad.a0'), Uint8Array.from([0x23, 0x20, 0xff, 0x0a]));
    await writeFile(join(root, 'legacy.a0d'), 'fn f add A 1\n');
    const supplied = services();
    let readCalls = 0;
    const client = await protocol(root, {
      ...supplied.language,
      async load(entry, read) {
        readCalls++;
        await read(entry);
        throw new Error(`${root}: should never reach after malformed input`);
      },
    });
    try {
      const bad = await call(client, 'a0_check', { file: 'bad.a0' });
      assert.equal(bad.error, true);
      assert.equal(JSON.parse(bad.text).id, 'A0808');
      assert.ok(!bad.text.includes(root));
      assert.equal(readCalls, 1);
      assert.equal(supplied.counts.sessions, 0);
      for (const file of ['legacy.a0d', '../outside.a0']) {
        const rejected = await call(client, 'a0_check', { file });
        assert.equal(rejected.error, true, file);
        assert.ok(!rejected.text.includes(root));
      }
      assert.equal(readCalls, 1);
    } finally {
      await client.close();
    }
  });
});

test('MCP supplied dependency reads share confinement and fatal decoding with entry reads', async () => {
  await directory(async (root) => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'outside.a0'), SOURCE);
    await writeFile(
      join(root, 'nested', 'escape.a0'),
      'use "../outside.a0"\nfn g u32 -> u32\nret p0\nend\n',
    );
    await writeFile(join(root, 'nested', 'bytes.a0'), Uint8Array.from([0xff]));
    await writeFile(
      join(root, 'nested', 'entry.a0'),
      'use "bytes.a0"\nfn g u32 -> u32\nret p0\nend\n',
    );
    const supplied = services();
    const client = await protocol(join(root, 'nested'), supplied.language);
    try {
      const outside = await call(client, 'a0_check', { file: 'escape.a0' });
      assert.equal(outside.error, true);
      assert.equal(JSON.parse(outside.text).id, 'A0801');
      const bytes = await call(client, 'a0_check', { file: 'entry.a0' });
      assert.equal(bytes.error, true);
      assert.equal(JSON.parse(bytes.text).id, 'A0808');
      assert.equal(supplied.counts.sessions, 0);
      for (const result of [outside, bytes]) assert.ok(!result.text.includes(root), result.text);
    } finally {
      await client.close();
    }
  });
});

test('MCP supplied session and serializer refusals never publish or fall back to legacy services', async () => {
  await directory(async (root) => {
    const supplied = services();
    let refuseSession = true;
    let refuseSave = true;
    const client = await protocol(join(root, 'm.a0'), {
      ...supplied.language,
      createSession(program) {
        if (refuseSession) throw new Error(`${root}: unavailable session capability`);
        return supplied.language.createSession(program);
      },
      formatSource(program, path) {
        if (refuseSave) throw new Error(`${root}: native allocation refused`);
        return supplied.language.formatSource(program, path);
      },
    });
    try {
      const refused = await call(client, 'a0_open', { function: 'f' });
      assert.equal(refused.error, true);
      assert.equal(JSON.parse(refused.text).id, 'A0809');
      assert.ok(!refused.text.includes(root));
      assert.equal(supplied.counts.sessions, 0);
      refuseSession = false;
      const opened = await call(client, 'a0_open', { function: 'f' });
      assert.equal(opened.error, false, opened.text);
      assert.deepEqual([supplied.counts.loads, supplied.counts.sessions], [2, 1]);
      const edited = await call(client, 'a0_apply', { edit: 'b add p0 1' });
      assert.equal(edited.error, false, edited.text);
      const save = await call(client, 'a0_save');
      assert.equal(save.error, true);
      assert.equal(JSON.parse(save.text).id, 'A0809');
      assert.equal(await readFile(join(root, 'm.a0'), 'utf8'), SOURCE);
      assert.equal(supplied.counts.source, 0);
      refuseSave = false;
      const saved = await call(client, 'a0_save');
      assert.equal(saved.error, false, saved.text);
      assert.equal(supplied.counts.source, 1);
      assert.ok((await readFile(join(root, 'm.a0'), 'utf8')).startsWith(mark));
    } finally {
      await client.close();
    }
  });
});

test('MCP supplied services enforce real source paths before reads and writes', {
  skip: SYMLINKS,
}, async () => {
  await directory(async (root) => {
    await writeFile(join(root, 'private.txt'), SOURCE);
    await symlink(join(root, 'private.txt'), join(root, 'alias.a0'));
    const supplied = services();
    const client = await protocol(root, supplied.language);
    try {
      const alias = await call(client, 'a0_check', { file: 'alias.a0' });
      assert.equal(alias.error, true);
      assert.equal(JSON.parse(alias.text).id, 'A0802');
      assert.equal(supplied.counts.loads, 0);
      await call(client, 'a0_open', { file: 'm.a0', function: 'f' });
      const edit = await call(client, 'a0_apply', { file: 'm.a0', edit: 'b add p0 1' });
      assert.equal(edit.error, false, edit.text);
      for (const path of ['output.a0d', 'alias.a0', '../escape.a0']) {
        const saved = await call(client, 'a0_save', { file: 'm.a0', path });
        assert.equal(saved.error, true, path);
      }
      assert.equal(supplied.counts.source, 0);
      assert.equal(await readFile(join(root, 'private.txt'), 'utf8'), SOURCE);
      assert.equal((await call(client, 'a0_save', { file: 'm.a0', path: 'safe.a0' })).error, false);
      assert.equal(supplied.counts.source, 1);
    } finally {
      await client.close();
    }
  });
});
