/**
 * The text an MCP client puts in front of a model for the a0 server: the tools/list result as the
 * server really serves it (names, descriptions, input schemas), read through the SDK client over
 * the in-memory transport. A variant is a JSON map of description overrides (tool name to
 * `{ description?, params?: { name: text } }`), applied to the served list the way a trimmed
 * `src/mcp.ts` would serve it.
 *
 *   node dist/tools/shipped-tool-text.js [overrides.json]     prints the rendered tool list
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';

export interface ToolOverride {
  readonly description?: string;
  readonly params?: Readonly<Record<string, string>>;
}
export type Overrides = Readonly<Record<string, ToolOverride>>;

export interface ServedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}
export interface Served {
  readonly tools: readonly ServedTool[];
  readonly instructions: string | undefined;
  readonly capabilities: Record<string, unknown>;
}

/** What the server serves on connect: the tool list, the server instructions and capabilities. */
export async function served(): Promise<Served> {
  const root = await mkdtemp(join(tmpdir(), 'a0-tooltext-'));
  try {
    const server = await createServer(root);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'tool-text', version: '0.0.0' });
    await client.connect(clientSide);
    const tools = (await client.listTools()).tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    const out = {
      tools,
      instructions: client.getInstructions(),
      capabilities: (client.getServerCapabilities() ?? {}) as Record<string, unknown>,
    };
    await client.close();
    return out;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The list a client sends the model: JSON, one object per tool, as the Messages API `tools` field. */
export function renderTools(tools: readonly ServedTool[], overrides: Overrides = {}): string {
  return JSON.stringify(
    tools.map((t) => {
      const o = overrides[t.name];
      const props = (t.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const schema = {
        ...t.inputSchema,
        properties: Object.fromEntries(
          Object.entries(props).map(([k, v]) => {
            const text = o?.params?.[k];
            return [k, text === undefined ? v : { ...v, description: text }];
          }),
        ),
      };
      return { name: t.name, description: o?.description ?? t.description, input_schema: schema };
    }),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  const overrides: Overrides =
    file === undefined ? {} : (JSON.parse(await readFile(file, 'utf8')) as Overrides);
  process.stdout.write(`${renderTools((await served()).tools, overrides)}\n`);
}
