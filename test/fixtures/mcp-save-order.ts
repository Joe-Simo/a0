/** Isolated real-filesystem scheduling control; run with one libuv filesystem worker. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { formatProgram, formatSource } from '../../src/core.js';
import { EditSession, revision } from '../../src/edit.js';
import { link } from '../../src/link.js';
import { createServer, type McpLanguageServices } from '../../src/mcp.js';
import type { nativeSource } from '../../src/source-native.js';
import { nativeMcpLanguageServices } from '../../src/source-native-mcp.js';
import { loadNativeSourcePackage } from '../../src/source-native-package.js';

assert.equal(process.env.UV_THREADPOOL_SIZE, '1');
const [backend, surface] = process.argv.slice(2);
assert.ok(backend === 'legacy' || backend === 'native');
assert.ok(surface === 'full' || surface === 'compact');
let frontend: ReturnType<typeof nativeSource> | undefined;
let services: McpLanguageServices;
if (backend === 'native') {
  const directory = process.env.A0_SOURCE_PACKAGE;
  const expected = process.env.A0_SOURCE_PACKAGE_SHA256;
  assert.ok(directory && expected);
  const packaged = await loadNativeSourcePackage(
    await readFile(join(directory, 'manifest.json')),
    expected,
    (file) => readFile(join(directory, file)),
  );
  frontend = packaged.instantiate();
  services = nativeMcpLanguageServices(frontend);
} else {
  services = {
    load: link,
    acceptsPath: (path) => path.endsWith('.a0'),
    createSession: (program) => new EditSession(program),
    formatProgram,
    formatSource,
    revision,
  };
}

const scratch = resolve('.a0-tmp/mcp-save-order');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'fixture-'));
let client: Client | undefined;
let reader: ReturnType<typeof open> | undefined;
let releaseWorker: (() => void) | undefined;
const pending: Promise<unknown>[] = [];
try {
  const file = join(root, 'm.a0');
  const parameter = backend === 'native' ? 'A' : 'p0';
  await writeFile(file, `fn f u32 -> u32\nx add ${parameter} 1\nret x\nend\n`);
  let signal: (() => void) | undefined;
  const serialized = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const server = await createServer(file, {
    surface,
    language: {
      ...services,
      formatSource(program, path) {
        const output = services.formatSource(program, path);
        signal?.();
        return output;
      },
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'save-order-control', version: '0.0.0' });
  await client.connect(clientSide);
  const connected = client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await connected.callTool({ name, arguments: args });
    const content = response.content as { type: string; text: string }[];
    return { text: content[0]?.text ?? '', error: response.isError === true };
  };
  assert.equal((await call('a0_open', { function: 'f' })).error, false);
  assert.equal((await call('a0_apply', { edit: `x add ${parameter} 2` })).error, false);

  // Only the test's FIFO open occupies the worker. The MCP save targets an ordinary file.
  const fifo = join(root, 'worker-block');
  execFileSync('mkfifo', [fifo]);
  reader = open(fifo, 'r');
  releaseWorker = () => {
    const writer = openSync(fifo, 'w');
    closeSync(writer);
  };
  const saved = call('a0_save');
  pending.push(saved);
  await serialized;
  let lateFinished = false;
  const late = call('a0_apply', { edit: `x add ${parameter} 3` }).then((result) => {
    lateFinished = true;
    return result;
  });
  pending.push(late);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateFinished, false, 'an edit must wait for the preceding filesystem save');
  releaseWorker();
  releaseWorker = undefined;
  await (await reader).close();
  reader = undefined;
  assert.equal((await saved).error, false);
  assert.equal((await late).error, false);
  assert.match(await readFile(file, 'utf8'), new RegExp(`add ${parameter} 2`));
  const second = await call('a0_save');
  assert.equal(second.error, false, 'the edit after the first save must remain dirty');
  assert.match(await readFile(file, 'utf8'), new RegExp(`add ${parameter} 3`));
  assert.equal(JSON.parse((await call('a0_save')).text).id, 'A0806');
  process.stdout.write(JSON.stringify({ backend, surface, ordered: true, secondSave: 'saved' }));
} finally {
  releaseWorker?.();
  if (reader !== undefined) await (await reader).close();
  await Promise.allSettled(pending);
  await client?.close();
  frontend?.close();
  await rm(root, { recursive: true, force: true });
}
