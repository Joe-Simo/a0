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
import { readUtf8Source } from './cli-source.js';
import {
  A0Error,
  checkArgument,
  formatProgram,
  formatSource,
  formatType,
  LIMITS,
  run,
  type TypedFunc,
  type TypedProgram,
  type Value,
} from './core.js';
import { formatDense } from './dense.js';
import { diag } from './diagnostics.js';
import { EditSession, revision, typedTargetView } from './edit.js';
import { DENSE_EXTENSION, isDensePath, link } from './link.js';
import { protectionPolicy, requireProtectedTarget } from './protection-policy.js';
import { type SourceGraphLoader, sourceDiagnostic } from './source-graph.js';
import { A0_VERSION } from './version.js';

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

/** A source file: canonical `.a0` or dense `.a0d`. */
const isA0Path = (path: string): boolean => path.endsWith('.a0') || path.endsWith(DENSE_EXTENSION);

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

const denied = (root: string, path: string): A0Error => {
  const shown = relative(root, resolve(root, path));
  return diag('A0801', [isAbsolute(shown) ? '<outside>' : shown]);
};

/** Resolve `path` inside `root`; the real path (symlinks followed) must stay inside too. */
async function confineSource(
  root: string,
  path: string,
  mustExist: boolean,
  acceptsPath: (path: string) => boolean,
): Promise<string> {
  const abs = resolve(root, path);
  protectionPolicy(abs);
  if (!within(root, abs) || !acceptsPath(abs))
    throw within(root, abs) ? diag('A0802', [path]) : denied(root, path);
  try {
    const real = await realpath(abs);
    protectionPolicy(real);
    if (!within(root, real)) throw denied(root, path);
    // The name alone is not enough: `x.a0 -> .env` would expose (and a save overwrite) it.
    if (!acceptsPath(real)) throw diag('A0802', [path]);
    return real;
  } catch (e) {
    if (e instanceof A0Error) throw e;
    if (mustExist) throw diag('A0803', [path]);
    // A dangling symlink would let a write follow it anywhere: only plain new files.
    if (
      await lstat(abs).then(
        () => true,
        () => false,
      )
    )
      throw denied(root, path);
    const parent = await realpath(dirname(abs)).catch(() => {
      throw denied(root, path);
    });
    if (!within(root, parent)) throw denied(root, path);
    return resolve(parent, relative(dirname(abs), abs));
  }
}

/** Historical callers retain their source policy; injected services use the same confinement. */
export function confine(root: string, path: string, mustExist: boolean): Promise<string> {
  return confineSource(root, path, mustExist, isA0Path);
}

/**
 * A tool result as a JSON diagnostic. Host paths never reach the client: the root prefix is
 * removed (diagnostics name files relative to it), and a non-A0 error (file system, runtime)
 * is reported by its code only, since its message may carry absolute paths.
 */
const failure = (root: string, e: unknown): CallToolResult => {
  const code = (e as { code?: unknown } | undefined)?.code;
  const err =
    e instanceof A0Error ? e : typeof code === 'string' ? diag('A0808', [code]) : diag('A0809');
  const body = JSON.stringify(err.toJSON()).split(JSON.stringify(`${root}${sep}`).slice(1, -1));
  return { isError: true, content: [{ type: 'text', text: body.join('') }] };
};

const text = (root: string, body: string): CallToolResult => {
  if (body.length > MAX_OUTPUT) return failure(root, diag('A0804', [MAX_OUTPUT]));
  return { content: [{ type: 'text', text: body }] };
};

const jsonValue: z.ZodType<Value> = z.lazy(() =>
  z.union([z.number().int().nonnegative(), z.boolean(), z.array(jsonValue)]),
);

/**
 * Tool surface. 'full' (the default): the seven tools above. 'compact' (experimental, off by
 * default until the edit-protocol run decides, docs/history/2026-10-10-edit-protocol-preregistration.md):
 * three tools with one-line descriptions, a0_open (dense, callee bodies, no handle line, the
 * target's full typed signature), a0_apply and a0_save.
 */
export type McpSurface = 'full' | 'compact';

/** One internally supplied language service set; no per-operation legacy fallback. */
export interface McpLanguageServices {
  readonly load: SourceGraphLoader;
  acceptsPath(path: string): boolean;
  createSession(program: TypedProgram): EditSession;
  formatProgram(program: TypedProgram): string;
  formatSource(program: TypedProgram, path: string): string;
  revision(fn: TypedFunc): string;
}

const LEGACY_LANGUAGE: McpLanguageServices = {
  load: link,
  acceptsPath: isA0Path,
  createSession: (program) => new EditSession(program),
  formatProgram,
  formatSource: (program, path) =>
    isDensePath(path) ? formatDense(program, { comments: true }) : formatSource(program),
  revision,
};

/** Build the server for `launch` (a file or directory). The caller connects a transport. */
export async function createServer(
  launch: string,
  options: {
    readonly surface?: McpSurface;
    /** Borrow complete services; their frontend and teardown remain owned by the caller. */
    readonly language?: McpLanguageServices;
  } = {},
): Promise<McpServer> {
  const launched = await realpath(resolve(launch));
  protectionPolicy(launched);
  const isDir = (await stat(launched)).isDirectory();
  const root = isDir ? launched : dirname(launched);
  const defaultFile = isDir ? undefined : launched;
  const language = options.language ?? LEGACY_LANGUAGE;
  const legacy = options.language === undefined;
  const confined = (path: string, mustExist: boolean) =>
    confineSource(root, path, mustExist, (source) => language.acceptsPath(source));
  const opened = new Map<string, Opened>();
  const tool =
    <A>(fn: (args: A) => Promise<string>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return text(root, await fn(args));
      } catch (e) {
        const diagnostic = legacy ? undefined : await sourceDiagnostic(e);
        return failure(root, diagnostic?.error ?? e);
      }
    };

  const fileOf = async (file: string | undefined): Promise<string> => {
    if (file !== undefined) return confined(file, true);
    if (defaultFile === undefined) throw diag('A0805');
    if (!legacy && !language.acceptsPath(defaultFile)) throw diag('A0802', [defaultFile]);
    return defaultFile;
  };

  const sessionFor = async (file: string | undefined): Promise<Opened> => {
    const path = await fileOf(file);
    const existing = opened.get(path);
    if (existing !== undefined) return existing;
    const linked = await language.load(path, async (p) => {
      const source = await confined(p, true);
      return legacy ? readFile(source, 'utf8') : readUtf8Source(source);
    });
    const entry: Opened = {
      session: language.createSession(linked.program),
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
    .describe(
      legacy
        ? '.a0 or .a0d (dense) file relative to the server root (default: the launched file)'
        : '.a0 file relative to the server root (default: the launched file)',
    );
  const denseField = z
    .boolean()
    .optional()
    .describe(
      'dense view (the default): the function (or signatures) in the dense syntax; replies under this handle are dense too. Pass false for the canonical view and canonical replies (the opt-out, see skills/a0/references/primer.txt)',
    );

  const server = new McpServer({ name: 'a0', version: A0_VERSION });

  if (options.surface === 'compact') {
    const file = legacy
      ? z.string().optional().describe('.a0 or .a0d file (default: the launched file)')
      : fileField;
    server.registerTool(
      'a0_open',
      {
        description: legacy
          ? 'Show one function (dense, callee bodies); reply to a0_apply with edit lines.'
          : 'Show one function and callee bodies; reply to a0_apply with edit lines.',
        inputSchema: { file, function: z.string() },
      },
      tool(async ({ file: f, function: name }) => {
        const { session } = await sessionFor(f);
        const shown = session.open(name, {
          scope: 'bodies',
          ...(legacy ? { dense: true } : {}),
        }).text;
        const body = shown.slice(shown.indexOf('\n') + 1);
        return legacy ? typedTargetView(body, session.program, name) : body;
      }),
    );
    server.registerTool(
      'a0_apply',
      {
        description: 'Apply edit lines to the open function; returns the new view or a diagnostic.',
        inputSchema: { file, edit: z.string().max(LIMITS.maxSourceBytes) },
      },
      tool(async ({ file: f, edit }) => {
        const entry = await sessionFor(f);
        entry.session.apply(edit);
        entry.dirty = true;
        const implied = entry.session.impliedHandle;
        return implied !== undefined
          ? entry.session.view(implied)
          : language.formatProgram(entry.session.program);
      }),
    );
    server.registerTool(
      'a0_save',
      {
        description: 'Write the edited program to its file.',
        inputSchema: { file },
      },
      tool(async ({ file: f }) => {
        const entry = await sessionFor(f);
        if (!entry.dirty) throw diag('A0806');
        const out = await fileOf(f);
        if (entry.sources.length > 1) throw diag('A0807');
        await writeFile(out, language.formatSource(entry.session.program, out), 'utf8');
        entry.dirty = false;
        return relative(root, out);
      }),
    );
    return server;
  }

  server.registerTool(
    'a0_open',
    {
      description:
        'Open one function: returns a handle line followed by the function (with callee signatures under scope "deps"). Reply to a0_apply with the handle line then replacement node lines.',
      inputSchema: {
        file: fileField,
        function: z.string(),
        scope: z.enum(['deps', 'full', 'bodies']).optional(),
        ...(legacy ? { dense: denseField } : {}),
        specs: z.enum(['show', 'hide']).optional().describe('hide: omit ex/pre/post lines'),
        lean: z
          .boolean()
          .optional()
          .describe(
            legacy
              ? 'dense only: return the function view without its handle line; a reply with no handle line edits the one open function'
              : 'return the function view without its handle line; a reply with no handle line edits the one open function',
          ),
      },
    },
    tool(async ({ file, function: name, scope, dense, specs, lean }) => {
      const { session } = await sessionFor(file);
      const useDense = legacy && (dense ?? true);
      const text = session.open(name, {
        ...(scope === 'full'
          ? {}
          : { scope: scope === 'bodies' ? ('bodies' as const) : ('deps' as const) }),
        ...(useDense ? { dense: true } : {}),
        ...(specs === undefined ? {} : { specs }),
      }).text;
      return (useDense || !legacy) && lean === true ? text.slice(text.indexOf('\n') + 1) : text;
    }),
  );

  server.registerTool(
    'a0_program',
    {
      description:
        'Open a program handle: every function signature, or with target only those around it. The handle accepts whole fn ... end blocks that add or replace functions.',
      inputSchema: {
        file: fileField,
        target: z.string().optional(),
        ...(legacy ? { dense: denseField } : {}),
      },
    },
    tool(async ({ file, target, dense }) => {
      const { session } = await sessionFor(file);
      const useDense = legacy && (dense ?? true);
      return session.openProgram({
        ...(target === undefined ? {} : { scope: 'deps' as const, target }),
        ...(useDense ? { dense: true } : {}),
      }).text;
    }),
  );

  server.registerTool(
    'a0_apply',
    {
      description:
        'Apply an edit (first line: an open handle). Returns the new view, or a JSON diagnostic with code (class), id (A0nnnn, see a0 explain), message, expected/actual, fix and applicability (exact or maybe); a failed edit changes nothing. The reply `fix all` applies every exact fix of the last rejected edit, atomically. Spec lines: `+ex ARGS -> R`, `+pre OP ARGS`, `+post OP ARGS`, and `-` for removal (program handle: `f:+ex ...`).',
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
        // a reply without a handle line edited the one open handle: show that view, not the program
        const implied = entry.session.impliedHandle;
        if (implied !== undefined) return entry.session.view(implied);
        return language.formatProgram(entry.session.program);
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
            `${fn.name} (${fn.params.map(formatType).join(', ')}) -> ${formatType(fn.result)}: ${fn.nodes.length} nodes, rev ${language.revision(fn).slice(0, 12)}`,
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
      if (fn === undefined) throw diag('A0610', [name]);
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
    tool(async ({ file, target }) => {
      const policy = protectionPolicy(await fileOf(file));
      if (policy.protect) requireProtectedTarget(target);
      const emitted = compile(await program(file), target as (typeof TARGETS)[number]).text;
      if (!policy.protect) return emitted;
      const { wasmModuleBytes } = await import('./wasm.js');
      const { protectWasm } = await import('./protection/artifact.js');
      return Buffer.from(protectWasm(wasmModuleBytes(emitted)).bytes).toString('base64');
    }),
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
      if (!entry.dirty) throw diag('A0806');
      const out = path === undefined ? await fileOf(file) : await confined(path, false);
      if (path === undefined && entry.sources.length > 1) throw diag('A0807');
      await writeFile(out, language.formatSource(entry.session.program, out), 'utf8');
      entry.dirty = false;
      return relative(root, out);
    }),
  );

  return server;
}

/** `a0 mcp <file-or-dir>`: serve over stdio until the client disconnects. */
export async function serveStdio(launch: string): Promise<void> {
  // A0_MCP_SURFACE=compact: the experimental three-tool surface (see McpSurface); off by default.
  const server = await createServer(
    launch,
    process.env.A0_MCP_SURFACE === 'compact' ? { surface: 'compact' } : {},
  );
  await server.connect(new StdioServerTransport());
}
