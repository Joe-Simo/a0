/** Shared dependency resolution, direct IR composition, and validation for source readers. */
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  A0Error,
  type Func,
  LIMITS,
  lineComment,
  type Profile,
  type Program,
  profileOf,
  stripComment,
  type Type,
  type TypedProgram,
  utf8Length,
  validate,
} from './core.js';
import { diag } from './diagnostics.js';
import { existsSync, realpath } from './node-fs.js';
import { specLineOf } from './spec.js';

type Arities = ReadonlyMap<string, number>;
const USE_PATH = /^use\s+"([^"\\]+)"$/;
export interface SourceReader {
  acceptsPath(path: string): boolean;
  prepare(
    text: string,
    path: string,
  ): {
    readonly uses: readonly string[];
    complete(
      known: Arities,
      signatures: ReadonlyMap<string, { readonly params: readonly Type[]; readonly result: Type }>,
    ): Promise<{
      readonly program: Program;
      readonly text: string;
      readonly locate?: (fn: string, node?: string) => number | undefined;
    }>;
  };
}
export interface LinkedSource {
  readonly path: string;
  /** 1-based first line of this file inside the combined text. */
  readonly startLine: number;
  readonly lineCount: number;
}

export interface Linked {
  readonly program: TypedProgram;
  /** Flattened source artifact in dependency order; compilation uses the composed program. */
  readonly text: string;
  readonly sources: readonly LinkedSource[];
  /** Original parsed source units and import arities, retained only for migration. */
  readonly units?: readonly LinkedUnit[];
}

export interface LinkedUnit {
  readonly path: string;
  readonly program: Program;
  readonly known: Arities;
}

export type ReadSource = (path: string) => Promise<string>;

export interface ProjectLinkOptions {
  /** Retain source units for deterministic migration. */
  readonly includeUnits?: boolean;
  /** Host source adapter: virtual sources need no filesystem or mount. Default follows real symlinks. */
  readonly canonicalPath?: (path: string) => Promise<string>;
  /**
   * Directory every `use` target must resolve inside (after symlinks are followed).
   * Defaults to the nearest ancestor of the entry's directory containing package.json,
   * else the entry's directory.
   */
  readonly root?: string;
  /**
   * The profile of the whole linked program, overriding what the files declare (`--profile`).
   * The files must still agree with each other (A0624).
   */
  readonly profile?: Profile;
}

function projectRoot(entry: string): string {
  const start = dirname(resolve(entry));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/** Resolve existing ancestors of missing paths, preserving lexical entry identities. */
export async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      const absolute = resolve(path);
      const parent = dirname(absolute);
      if (parent === absolute) return absolute;
      return join(await physicalPath(parent), basename(absolute));
    }
    throw e;
  }
}

/** Compose already parsed modules while preserving comments between source units. */
function composePrograms(programs: readonly Program[], profile: Profile): Program {
  const functions: Func[] = [];
  let pending: string[] = [];
  for (const program of programs) {
    pending.push(...(program.profileComments?.leading ?? []));
    if (program.profileComments?.trailing !== undefined)
      pending.push(program.profileComments.trailing);
    for (const comments of program.useComments ?? []) {
      pending.push(...(comments?.leading ?? []));
      if (comments?.trailing !== undefined) pending.push(comments.trailing);
    }
    for (const fn of program.functions) {
      let body = fn;
      if (fn.afterComments !== undefined) {
        const { afterComments: _after, ...withoutTail } = fn;
        body = withoutTail;
      }
      functions.push(
        pending.length === 0
          ? body
          : {
              ...body,
              comments: {
                ...body.comments,
                leading: [...pending, ...(body.comments?.leading ?? [])],
              },
            },
      );
      pending = [...(fn.afterComments ?? [])];
    }
    pending.push(...(program.tailComments ?? []));
  }
  const last = functions.at(-1);
  if (last !== undefined && pending.length > 0)
    functions[functions.length - 1] = { ...last, afterComments: pending };
  return {
    functions,
    ...(profile === 'strict' ? { profile } : {}),
    ...(last === undefined && pending.length > 0 ? { tailComments: pending } : {}),
  };
}

/** Remove resolved directives from a parsed file's header, preserving physical LF lines. */
function flattenedSource(text: string): string {
  const parts: string[] = [];
  let kept = 0;
  for (let lo = 0; lo < text.length; ) {
    const newline = text.indexOf('\n', lo);
    const hi = newline < 0 ? text.length : newline;
    const raw = text.slice(lo, hi);
    const code = stripComment(raw).trim();
    // A parsed module has no directives after its first function. Keep its body verbatim,
    // including Unicode line separators inside quoted text, without rescanning it.
    if (/^fn(?:\s|$)/.test(code)) break;
    if (USE_PATH.test(code) || /^profile\s+strict$/.test(code)) {
      parts.push(text.slice(kept, lo), lineComment(raw) ?? '', raw.endsWith('\r') ? '\r' : '');
      kept = hi;
    }
    lo = hi + 1;
  }
  return parts.length === 0 ? text : parts.join('') + text.slice(kept);
}

/** Load `entry` and everything it uses; `read` is injected so tests need no filesystem. */
export async function linkProject(
  entry: string,
  read: ReadSource,
  reader: SourceReader,
  options: ProjectLinkOptions = {},
): Promise<Linked> {
  const canonicalPath = options.canonicalPath ?? physicalPath;
  const root = await canonicalPath(options.root ?? projectRoot(entry));
  const inside = (abs: string): boolean => {
    const rel = relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  /** `text` is the canonical text the program is built from; `shown` the file as written. */
  const order: {
    path: string;
    text: string;
    shown: string;
    fns: string[];
    profile: Profile;
    /** One source parse, retained for direct dependency-ordered IR composition. */
    parsed: Program;
    known?: Arities;
    locate?: (fn: string, node?: string) => number | undefined;
  }[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  /** Parameter counts of every function a file defines or reaches through its uses. */
  const closureOf = new Map<string, Map<string, number>>();
  /** Signatures of the same functions (the stubs of the A0 dense reader). */
  type Sig = { readonly params: readonly Type[]; readonly result: Type };
  const sigsOf = new Map<string, Map<string, Sig>>();
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
    const prepared = reader.prepare(shown, abs);
    const uses = prepared.uses;
    const known = new Map<string, number>();
    const usedSigs = new Map<string, Sig>();
    for (const use of uses) {
      const target = await canonicalPath(resolve(dirname(abs), use));
      if (!reader.acceptsPath(target) || !inside(target))
        throw diag('A0622', [use, abs, target, root]);
      await visit(target, abs);
      for (const [name, n] of closureOf.get(target) ?? []) known.set(name, n);
      for (const [name, g] of sigsOf.get(target) ?? []) usedSigs.set(name, g);
    }
    const unit = await prepared.complete(known, usedSigs);
    const { text, program: parsedFile } = unit;
    const functions = parsedFile.functions;
    const declared = profileOf(parsedFile);
    const own = new Map<string, number>();
    for (const f of functions) own.set(f.name, f.params.length);
    closureOf.set(abs, new Map([...known, ...own]));
    sigsOf.set(abs, new Map([...usedSigs, ...functions.map((f) => [f.name, f] as const)]));
    visiting.delete(abs);
    done.add(abs);
    order.push({
      path: abs,
      text,
      shown,
      fns: functions.map((f) => f.name),
      profile: declared,
      parsed: parsedFile,
      ...(unit.locate === undefined ? {} : { locate: unit.locate }),
      ...(options.includeUnits ? { known } : {}),
    });
  };
  await visit(entry, undefined);

  // One profile per program: every file must declare what the entry file declares.
  const entryFile = order.find((o) => o.path === resolve(entry));
  const rootProfile = entryFile?.profile ?? 'canonical';
  for (const o of order) {
    if (o.profile !== rootProfile)
      throw diag('A0624', [resolve(entry), rootProfile, o.path, o.profile]);
  }
  const profile = options.profile ?? rootProfile;

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
    const body = flattenedSource(text);
    const lineCount = body.split('\n').length;
    sources.push({ path, startLine: line, lineCount });
    parts.push(body);
    line += lineCount;
  }
  const combined = parts.join('\n');
  if (utf8Length(combined) > LIMITS.maxSourceBytes) throw diag('A0623', [LIMITS.maxSourceBytes]);
  // Linking composes already parsed IR in dependency order. Text remains the combined
  // source artifact for callers; source parsing and syntax expansion are never repeated.
  const parsed = composePrograms(
    order.map((o) => o.parsed),
    profile,
  );
  try {
    return {
      // Validation returns typed functions; retain source metadata on an empty graph too.
      program: { ...parsed, ...validate(parsed) },
      text: combined,
      sources,
      ...(options.includeUnits
        ? {
            units: order.map((o) => {
              if (o.known === undefined) throw new Error('source unit arities were not retained');
              return { path: o.path, program: o.parsed, known: o.known };
            }),
          }
        : {}),
    };
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
    const m = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?(?:[:.]|\s)/.exec(e.message);
    const path = m === null ? undefined : owner.get(m[1] as string);
    if (path === undefined) throw e;
    const source = order.find((o) => o.path === path);
    const located = m === null ? undefined : source?.locate?.(m[1] as string, m[2]);
    if (located !== undefined && e.spec === undefined)
      throw e.rewrite(`${path}:${located}: ${e.message}`);
    const text = source?.shown ?? '';
    const fileLines = text.split(/\r?\n/);
    let line = fileLines.findIndex((l) => new RegExp(`^\\s*fn\\s+${m?.[1]}\\b`).test(l));
    if (line >= 0 && m?.[2] !== undefined) {
      const node = fileLines.findIndex((l, i) => i > line && new RegExp(`^\\s*${m[2]}\\s`).test(l));
      if (node >= 0) line = node;
    }
    // A spec failure points at the spec line it is about (the example it broke).
    if (line >= 0 && e.spec !== undefined) line = specLineOf(fileLines, line, e.spec) ?? line;
    throw e.rewrite(`${path}${line >= 0 ? `:${line + 1}` : ''}: ${e.message}`);
  }
}
