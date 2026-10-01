/**
 * Linker: resolves `use "path"` lines into one flat program.
 *
 * A0 has one namespace per program and no forward references, so linking is a
 * dependency-ordered concatenation: every used file is loaded once (by resolved path),
 * its own uses come first, cycles are rejected, and the result is validated as a whole.
 * Function names must be unique across all files; a clash is reported with both files.
 * Diagnostics raised on the combined text are mapped back to `file:line`.
 */

import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  A0Error,
  formatSource,
  LIMITS,
  type Program,
  parse,
  stripComment,
  type TypedProgram,
  utf8Length,
  validate,
} from './core.js';
import { type Arities, parseDense } from './dense.js';
import { diag } from './diagnostics.js';

/** Dense files use this extension; any other file is read as canonical unless `dense` is set. */
export const DENSE_EXTENSION = '.a0d';

/** Whether a path names a dense-form source file. */
export function isDensePath(path: string): boolean {
  return path.endsWith(DENSE_EXTENSION);
}

const USE_PATH = /^use\s+"([^"\\]+)"$/;

/** The `use` targets of a dense file, found before parsing it (its callee arities come from them). */
function denseUses(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = USE_PATH.exec(stripComment(raw).trim());
    if (m !== null) out.push(m[1] as string);
    else if (/^fn(\s|$)/.test(stripComment(raw).trim())) break;
  }
  return out;
}

export interface LinkedSource {
  readonly path: string;
  /** 1-based first line of this file inside the combined text. */
  readonly startLine: number;
  readonly lineCount: number;
}

export interface Linked {
  readonly program: TypedProgram;
  /** Combined source text, dependency order, exactly what was validated. */
  readonly text: string;
  readonly sources: readonly LinkedSource[];
}

export type ReadSource = (path: string) => Promise<string>;

export interface LinkOptions {
  /**
   * Directory every `use` target must resolve inside (after symlinks are followed).
   * Defaults to the nearest ancestor of the entry's directory containing package.json,
   * else the entry's directory.
   */
  readonly root?: string;
  /** Read every file as dense text (a file ending in `.a0d` is always dense). */
  readonly dense?: boolean;
}

function projectRoot(entry: string): string {
  const start = dirname(resolve(entry));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/** Follow symlinks; a path that does not exist yet cannot be a link and stays as resolved. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw e;
  }
}

/** Load `entry` and everything it uses; `read` is injected so tests need no filesystem. */
export async function link(
  entry: string,
  read: ReadSource,
  options: LinkOptions = {},
): Promise<Linked> {
  const root = await canonical(options.root ?? projectRoot(entry));
  const inside = (abs: string): boolean => {
    const rel = relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  /** `text` is the canonical text the program is built from; `shown` the file as written. */
  const order: { path: string; text: string; shown: string; fns: string[] }[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  /** Parameter counts of every function a file defines or reaches through its uses. */
  const closureOf = new Map<string, Map<string, number>>();
  const visit = async (path: string, from: string | undefined): Promise<void> => {
    const abs = resolve(path);
    if (done.has(abs)) return;
    if (visiting.has(abs)) {
      throw diag('A0620', [abs, from === undefined ? '' : ` (from ${from})`]);
    }
    visiting.add(abs);
    const shown = await read(abs);
    if (utf8Length(shown) > LIMITS.maxSourceBytes)
      throw diag('A0621', [abs, LIMITS.maxSourceBytes]);
    const isDense = options.dense === true || isDensePath(abs);
    const uses = isDense ? denseUses(shown) : (parse(shown).uses ?? []);
    const known = new Map<string, number>();
    for (const use of uses) {
      const target = await canonical(resolve(dirname(abs), use));
      if (!(target.endsWith('.a0') || isDensePath(target)) || !inside(target))
        throw diag('A0622', [use, abs, target, root]);
      await visit(target, abs);
      for (const [name, n] of closureOf.get(target) ?? []) known.set(name, n);
    }
    let text = shown;
    let functions: readonly { name: string; params: readonly unknown[] }[];
    if (isDense) {
      let parsed: ReturnType<typeof parseDense>;
      try {
        parsed = parseDense(shown, { known });
      } catch (e) {
        if (!(e instanceof A0Error) || e.line === undefined) throw e;
        throw e.rewrite(`${abs}:${e.line}: ${e.message.replace(/^line \d+: /, '')}`);
      }
      text = formatSource(parsed);
      functions = parsed.functions;
    } else {
      functions = parse(shown).functions;
    }
    const own = new Map<string, number>();
    for (const f of functions) own.set(f.name, f.params.length);
    closureOf.set(abs, new Map([...known, ...own]));
    visiting.delete(abs);
    done.add(abs);
    order.push({ path: abs, text, shown, fns: functions.map((f) => f.name) });
  };
  await visit(entry, undefined);

  // Duplicate function names across files: report both definitions.
  const owner = new Map<string, string>();
  for (const { path, fns } of order) {
    for (const name of fns) {
      const prev = owner.get(name);
      if (prev !== undefined && prev !== path) {
        throw diag('A0022', [name, prev, path]);
      }
      owner.set(name, path);
    }
  }

  const sources: LinkedSource[] = [];
  let line = 1;
  const parts: string[] = [];
  for (const { path, text } of order) {
    // Drop `use` lines (already resolved) but keep line count so diagnostics map back.
    const body = text.replace(/^\s*use\s+"[^"]*"\s*$/gm, '');
    const lineCount = body.split(/\r?\n/).length;
    sources.push({ path, startLine: line, lineCount });
    parts.push(body);
    line += lineCount;
  }
  const combined = parts.join('\n');
  if (utf8Length(combined) > LIMITS.maxSourceBytes) throw diag('A0623', [LIMITS.maxSourceBytes]);
  try {
    return { program: validate(parse(combined)), text: combined, sources };
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    // Parse errors carry a line in the combined text; validator errors name `fn.node` or
    // `fn`. Both are mapped to the owning file, and the node to its line in that file.
    if (e.line !== undefined) {
      const src = sources.find(
        (s) => e.line !== undefined && e.line >= s.startLine && e.line < s.startLine + s.lineCount,
      );
      if (src !== undefined) {
        const local = e.line - src.startLine + 1;
        throw e.rewrite(`${src.path}:${local}: ${e.detail}`);
      }
      throw e;
    }
    const m = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?[:.]/.exec(e.message);
    const path = m === null ? undefined : owner.get(m[1] as string);
    if (path === undefined) throw e;
    const text = order.find((o) => o.path === path)?.shown ?? '';
    const fileLines = text.split(/\r?\n/);
    let line = fileLines.findIndex((l) => new RegExp(`^\\s*fn\\s+${m?.[1]}\\b`).test(l));
    if (line >= 0 && m?.[2] !== undefined) {
      const node = fileLines.findIndex((l, i) => i > line && new RegExp(`^\\s*${m[2]}\\s`).test(l));
      if (node >= 0) line = node;
    }
    throw e.rewrite(`${path}${line >= 0 ? `:${line + 1}` : ''}: ${e.message}`);
  }
}

/**
 * One file parsed on its own, canonical or dense, without validating or linking it, plus the
 * parameter counts of the functions its `use`s bring in (what the dense converter needs).
 */
export async function parseFile(
  entry: string,
  read: ReadSource,
  dense = false,
): Promise<{ program: Program; known: Arities }> {
  const seen = new Map<string, Map<string, number>>();
  const load = async (path: string, asDense: boolean): Promise<Program> => {
    const abs = resolve(path);
    const text = await read(abs);
    const isDense = asDense || isDensePath(abs);
    const uses = isDense ? denseUses(text) : (parse(text).uses ?? []);
    const known = new Map<string, number>();
    for (const use of uses) {
      const target = resolve(dirname(abs), use);
      if (!seen.has(target)) await load(target, false);
      for (const [name, n] of seen.get(target) ?? []) known.set(name, n);
    }
    const program = isDense ? parseDense(text, { known }) : parse(text);
    const own = new Map(program.functions.map((f) => [f.name, f.params.length] as const));
    seen.set(abs, new Map([...known, ...own]));
    return program;
  };
  const program = await load(entry, dense);
  const known = new Map<string, number>();
  for (const use of program.uses ?? [])
    for (const [name, n] of seen.get(resolve(dirname(resolve(entry)), use)) ?? [])
      known.set(name, n);
  return { program, known };
}
