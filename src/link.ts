/**
 * Linker: resolves `use "path"` lines into one flat program.
 *
 * A0 has one namespace per program and no forward references, so linking is a
 * dependency-ordered concatenation: every used file is loaded once (by resolved path),
 * its own uses come first, cycles are rejected, and the result is validated as a whole.
 * Function names must be unique across all files; a clash is reported with both files.
 * Diagnostics raised on the combined text are mapped back to `file:line`.
 */

import { dirname, resolve } from 'node:path';
import {
  A0Error,
  type DiagnosticDetail,
  LIMITS,
  parse,
  type TypedProgram,
  validate,
} from './core.js';

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

/** Load `entry` and everything it uses; `read` is injected so tests need no filesystem. */
export async function link(entry: string, read: ReadSource): Promise<Linked> {
  const order: { path: string; text: string }[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = async (path: string, from: string | undefined): Promise<void> => {
    const abs = resolve(path);
    if (done.has(abs)) return;
    if (visiting.has(abs)) {
      throw new A0Error(
        `use cycle: ${abs} is already being linked${from === undefined ? '' : ` (from ${from})`}`,
        undefined,
        {
          code: 'structure',
          fix: 'remove one direction of the use between these files',
        },
      );
    }
    visiting.add(abs);
    const text = await read(abs);
    if (Buffer.byteLength(text, 'utf8') > LIMITS.maxSourceBytes)
      throw new A0Error(`${abs}: source exceeds ${LIMITS.maxSourceBytes} bytes`, undefined, {
        code: 'limit',
      });
    const parsed = parse(text);
    for (const use of parsed.uses ?? []) await visit(resolve(dirname(abs), use), abs);
    visiting.delete(abs);
    done.add(abs);
    order.push({ path: abs, text });
  };
  await visit(entry, undefined);

  // Duplicate function names across files: report both definitions.
  const owner = new Map<string, string>();
  for (const { path, text } of order) {
    for (const fn of parse(text).functions) {
      const prev = owner.get(fn.name);
      if (prev !== undefined && prev !== path) {
        throw new A0Error(
          `function '${fn.name}' is defined in both ${prev} and ${path}`,
          undefined,
          {
            code: 'structure',
            fix: `rename one of the two '${fn.name}' definitions; a linked program has one namespace`,
          },
        );
      }
      owner.set(fn.name, path);
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
  if (Buffer.byteLength(combined, 'utf8') > LIMITS.maxSourceBytes)
    throw new A0Error(`linked program exceeds ${LIMITS.maxSourceBytes} bytes`, undefined, {
      code: 'limit',
    });
  try {
    return { program: validate(parse(combined)), text: combined, sources };
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    const detail: DiagnosticDetail = {
      code: e.code,
      ...(e.fix === undefined ? {} : { fix: e.fix }),
      ...(e.expected === undefined ? {} : { expected: e.expected }),
      ...(e.actual === undefined ? {} : { actual: e.actual }),
    };
    // Parse errors carry a line in the combined text; validator errors name `fn.node` or
    // `fn`. Both are mapped to the owning file, and the node to its line in that file.
    if (e.line !== undefined) {
      const src = sources.find(
        (s) => e.line !== undefined && e.line >= s.startLine && e.line < s.startLine + s.lineCount,
      );
      if (src !== undefined) {
        const local = e.line - src.startLine + 1;
        throw new A0Error(
          `${src.path}:${local}: ${e.message.replace(/^line \d+: /, '')}`,
          undefined,
          detail,
        );
      }
      throw e;
    }
    const m = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?[:.]/.exec(e.message);
    const path = m === null ? undefined : owner.get(m[1] as string);
    if (path === undefined) throw e;
    const text = order.find((o) => o.path === path)?.text ?? '';
    const fileLines = text.split(/\r?\n/);
    let line = fileLines.findIndex((l) => new RegExp(`^\\s*fn\\s+${m?.[1]}\\b`).test(l));
    if (line >= 0 && m?.[2] !== undefined) {
      const node = fileLines.findIndex((l, i) => i > line && new RegExp(`^\\s*${m[2]}\\s`).test(l));
      if (node >= 0) line = node;
    }
    throw new A0Error(`${path}${line >= 0 ? `:${line + 1}` : ''}: ${e.message}`, undefined, detail);
  }
}
