/** Legacy source reader adapters retained during deterministic project migration. */
import { dirname, resolve } from 'node:path';
import { A0Error, formatSource, type Program, parse, stripComment, type Type } from './core.js';
import type { Arities } from './dense.js';
import { type Linked, linkProject, type ProjectLinkOptions, type ReadSource } from './linker.js';

export {
  type Linked,
  type LinkedSource,
  type LinkedUnit,
  physicalPath,
  type ReadSource,
} from './linker.js';
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

/** The authoritative dependency readers also serve encrypted-storage inventory. */
export function sourceUses(text: string, path: string): readonly string[] {
  return isDensePath(path) ? denseUses(text) : (parse(text).uses ?? []);
}

export interface LinkOptions extends ProjectLinkOptions {
  /** Read every file as dense text (a file ending in `.a0d` is always dense). */
  readonly dense?: boolean;
  /**
   * Read dense files with this reader instead of the reference (`--dense=a0`): the file's text, the
   * signatures of every function its uses reach, and its path in; parsed IR or canonical text out.
   * Returning IR avoids a source-format conversion and parse before shared validation.
   */
  readonly denseReader?: (
    text: string,
    used: ReadonlyMap<string, { readonly params: readonly Type[]; readonly result: Type }>,
    path: string,
  ) => Program | string;
}

export async function link(
  entry: string,
  read: ReadSource,
  options: LinkOptions = {},
): Promise<Linked> {
  return linkProject(
    entry,
    read,
    {
      acceptsPath: (path) => path.endsWith('.a0') || isDensePath(path),
      prepare(shown, path) {
        const dense = options.dense === true || isDensePath(path);
        const parsed = dense ? undefined : parse(shown);
        return {
          uses: parsed?.uses ?? (dense ? denseUses(shown) : []),
          async complete(known, signatures) {
            if (parsed !== undefined) return { program: parsed, text: shown };
            try {
              const result =
                options.denseReader === undefined
                  ? (await import('./dense.js')).parseDense(shown, { known, imports: signatures })
                  : options.denseReader(shown, signatures, path);
              const program = typeof result === 'string' ? parse(result) : result;
              return { program, text: typeof result === 'string' ? result : formatSource(program) };
            } catch (e) {
              if (!(e instanceof A0Error) || e.line === undefined) throw e;
              throw e.rewrite(`${path}:${e.line}: ${e.message.replace(/^line \d+: /, '')}`);
            }
          },
        };
      },
    },
    options,
  );
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
  const signatures = new Map<string, Map<string, { params: readonly Type[]; result: Type }>>();
  const load = async (path: string, asDense: boolean): Promise<Program> => {
    const abs = resolve(path);
    const text = await read(abs);
    const isDense = asDense || isDensePath(abs);
    const parsedCanonical = isDense ? undefined : parse(text);
    const uses = isDense ? denseUses(text) : (parsedCanonical?.uses ?? []);
    const known = new Map<string, number>();
    const imports = new Map<string, { params: readonly Type[]; result: Type }>();
    for (const use of uses) {
      const target = resolve(dirname(abs), use);
      if (!seen.has(target)) await load(target, false);
      for (const [name, n] of seen.get(target) ?? []) known.set(name, n);
      for (const [name, sig] of signatures.get(target) ?? []) imports.set(name, sig);
    }
    const program =
      parsedCanonical ?? (await import('./dense.js')).parseDense(text, { known, imports });
    const own = new Map(program.functions.map((f) => [f.name, f.params.length] as const));
    seen.set(abs, new Map([...known, ...own]));
    signatures.set(
      abs,
      new Map([...imports, ...program.functions.map((f) => [f.name, f] as const)]),
    );
    return program;
  };
  const program = await load(entry, dense);
  const known = new Map<string, number>();
  for (const use of program.uses ?? [])
    for (const [name, n] of seen.get(resolve(dirname(resolve(entry)), use)) ?? [])
      known.set(name, n);
  return { program, known };
}
