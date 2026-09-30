/**
 * MCP server: AI agents edit A0 through tools instead of text files.
 *
 *   a0 mcp <file-or-dir>
 *
 * Tools: a0_open, a0_program, a0_apply, a0_check, a0_run, a0_emit, a0_save. Every path is
 * resolved inside the root given at launch (a directory, or the file's directory); symlinks
 * that resolve outside it are rejected, `use` dependencies included. No shell is run; the
 * reference interpreter is bounded by fuel and every tool result by MAX_OUTPUT.
 */

import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { compile, TARGETS } from './backends.js';
import {
  A0Error,
  checkArgument,
  formatProgram,
  formatType,
  LIMITS,
  run,
  type TypedProgram,
  type Value,
} from './core.js';
import { EditSession, revision } from './edit.js';
import { link } from './link.js';

/** Largest text any tool returns, in characters. */
export const MAX_OUTPUT = 1 << 20;
/** Fuel ceiling for a0_run (the reference interpreter's default budget). */
export const MAX_FUEL = LIMITS.defaultFuel;

interface Opened {
  readonly session: EditSession;
  readonly sources: readonly string[];
  /** True once an edit has been applied and not yet saved. */
  dirty: boolean;
}

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

const denied = (path: string): A0Error =>
  new A0Error(`path '${path}' is outside the server root`, undefined, {
    code: 'limit',
    fix: 'use a path inside the directory the server was launched with',
  });

/** Resolve `path` inside `root`; the real path (symlinks followed) must stay inside too. */
async function confine(root: string, path: string, mustExist: boolean): Promise<string> {
  const abs = resolve(root, path);
  if (!within(root, abs) || !abs.endsWith('.a0'))
    throw within(root, abs)
      ? new A0Error(`'${path}' is not an .a0 file`, undefined, { code: 'limit' })
      : denied(path);
  try {
    const real = await realpath(abs);
    if (!within(root, real)) throw denied(path);
    return real;
  } catch (e) {
    if (e instanceof A0Error) throw e;
    if (mustExist) throw new A0Error(`no such file '${path}'`, undefined, { code: 'handle' });
    // A dangling symlink would let a write follow it anywhere: only plain new files.
    if (
      await lstat(abs).then(
        () => true,
        () => false,
      )
    )
      throw denied(path);
    const parent = await realpath(dirname(abs)).catch(() => {
      throw denied(path);
    });
    if (!within(root, parent)) throw denied(path);
    return resolve(parent, relative(dirname(abs), abs));
  }
}

const text = (body: string): CallToolResult => {
  if (body.length > MAX_OUTPUT)
    return failure(
      new A0Error(`output exceeds ${MAX_OUTPUT} characters`, undefined, { code: 'limit' }),
    );
  return { content: [{ type: 'text', text: body }] };
};

const failure = (e: unknown): CallToolResult => {
  const err =
    e instanceof A0Error
      ? e
      : new A0Error(e instanceof Error ? e.message : String(e), undefined, { code: 'structure' });
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }] };
};

const tool =
  <A>(fn: (args: A) => Promise<string>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return text(await fn(args));
    } catch (e) {
      return failure(e);
    }
  };

const jsonValue: z.ZodType<Value> = z.lazy(() =>
  z.union([z.number().int().nonnegative(), z.boolean(), z.array(jsonValue)]),
);

/** Build the server for `launch` (a file or directory). The caller connects a transport. */
export async function createServer(launch: string): Promise<McpServer> {
  const launched = await realpath(resolve(launch));
  const isDir = (await stat(launched)).isDirectory();
  const root = isDir ? launched : dirname(launched);
  const defaultFile = isDir ? undefined : launched;
  const opened = new Map<string, Opened>();

  const fileOf = async (file: string | undefined): Promise<string> => {
    if (file !== undefined) return confine(root, file, true);
    if (defaultFile === undefined)
      throw new A0Error('file is required when the server root is a directory', undefined, {
        code: 'handle',
        fix: 'pass file: a path relative to the server root',
      });
    return defaultFile;
  };

  const sessionFor = async (file: string | undefined): Promise<Opened> => {
    const path = await fileOf(file);
    const existing = opened.get(path);
    if (existing !== undefined) return existing;
    const linked = await link(path, async (p) => readFile(await confine(root, p, true), 'utf8'));
    const entry: Opened = {
      session: new EditSession(linked.program),
      sources: linked.sources.map((s) => s.path),
      dirty: false,
    };
    opened.set(path, entry);
    return entry;
  };

  const program = async (file: string | undefined): Promise<TypedProgram> =>
    (await sessionFor(file)).session.program;

  const fileField = z
    .string()
    .optional()
    .describe('.a0 file relative to the server root (default: the launched file)');

  const server = new McpServer({ name: 'a0', version: '0.1.0' });

  server.registerTool(
    'a0_open',
    {
      description:
        'Open one function: returns a handle line followed by the function (with callee signatures under scope "deps"). Reply to a0_apply with the handle line then replacement node lines.',
      inputSchema: {
        file: fileField,
        function: z.string(),
        scope: z.enum(['deps', 'full']).optional(),
      },
    },
    tool(async ({ file, function: name, scope }) => {
      const { session } = await sessionFor(file);
      return session.open(name, scope === 'full' ? {} : { scope: 'deps' }).text;
    }),
  );

  server.registerTool(
    'a0_program',
    {
      description:
        'Open a program handle: every function signature, or with target only those around it. The handle accepts whole fn ... end blocks that add or replace functions.',
      inputSchema: { file: fileField, target: z.string().optional() },
    },
    tool(async ({ file, target }) => {
      const { session } = await sessionFor(file);
      return session.openProgram(target === undefined ? {} : { scope: 'deps', target }).text;
    }),
  );

  server.registerTool(
    'a0_apply',
    {
      description:
        'Apply an edit (first line: an open handle). Returns the new view, or a JSON diagnostic with code/expected/actual/fix; a failed edit changes nothing.',
      inputSchema: { file: fileField, edit: z.string().max(LIMITS.maxSourceBytes) },
    },
    tool(async ({ file, edit }) => {
      const entry = await sessionFor(file);
      entry.session.apply(edit);
      entry.dirty = true;
      const handle = edit
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      try {
        return entry.session.view(handle ?? '');
      } catch {
        return formatProgram(entry.session.program);
      }
    }),
  );

  server.registerTool(
    'a0_check',
    {
      description: 'Validate the current program: one line per function with its revision.',
      inputSchema: { file: fileField },
    },
    tool(async ({ file }) =>
      (await program(file)).functions
        .map(
          (fn) =>
            `${fn.name} (${fn.params.map(formatType).join(', ')}) -> ${formatType(fn.result)}: ${fn.nodes.length} nodes, rev ${revision(fn).slice(0, 12)}`,
        )
        .join('\n'),
    ),
  );

  server.registerTool(
    'a0_run',
    {
      description:
        'Run a function on JSON arguments (u32 numbers, booleans, arrays for arr/struct) with the reference interpreter, bounded by fuel.',
      inputSchema: {
        file: fileField,
        function: z.string(),
        args: z.array(jsonValue),
        fuel: z.number().int().positive().max(MAX_FUEL).optional(),
      },
    },
    tool(async ({ file, function: name, args, fuel }) => {
      const fn = (await program(file)).byName.get(name);
      if (fn === undefined)
        throw new A0Error(`unknown function '${name}'`, undefined, { code: 'handle' });
      for (const [i, t] of fn.params.entries()) checkArgument(t, args[i] as Value, `p${i}`);
      return JSON.stringify(run(fn, args, { fuel: fuel ?? MAX_FUEL }));
    }),
  );

  server.registerTool(
    'a0_emit',
    {
      description: `Compile the current program for a target (${TARGETS.join(', ')}); wasm is base64.`,
      inputSchema: { file: fileField, target: z.enum(TARGETS as [string, ...string[]]) },
    },
    tool(
      async ({ file, target }) =>
        compile(await program(file), target as (typeof TARGETS)[number]).text,
    ),
  );

  server.registerTool(
    'a0_save',
    {
      description:
        'Write the edited program to its file (or path, inside the root). Only after a successful a0_apply.',
      inputSchema: { file: fileField, path: z.string().optional() },
    },
    tool(async ({ file, path }) => {
      const entry = await sessionFor(file);
      if (!entry.dirty)
        throw new A0Error('nothing to save: no edit has been applied', undefined, {
          code: 'edit',
          fix: 'call a0_apply first',
        });
      const out = path === undefined ? await fileOf(file) : await confine(root, path, false);
      if (path === undefined && entry.sources.length > 1)
        throw new A0Error('program spans several files (use); save to a new path', undefined, {
          code: 'edit',
          fix: 'pass path: a new .a0 file inside the root',
        });
      await writeFile(out, formatProgram(entry.session.program), 'utf8');
      entry.dirty = false;
      return relative(root, out);
    }),
  );

  return server;
}

/** `a0 mcp <file-or-dir>`: serve over stdio until the client disconnects. */
export async function serveStdio(launch: string): Promise<void> {
  const server = await createServer(launch);
  await server.connect(new StdioServerTransport());
}
