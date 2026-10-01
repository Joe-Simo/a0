/**
 * Dependency-scoped views of a source file, for any language with a tree-sitter grammar.
 *
 * What an agent gets when an editing tool can parse the file: the target function (its source
 * lines, verbatim) plus what it directly calls, either as signatures (arm `signatures`) or as
 * whole bodies (arm `bodies`). This is the counterpart of A0's `deps` and `bodies` function
 * views (src/edit.ts `scopedView`), so a comparison of A0 with another language can give both the
 * same context selection and the same kind of edit operations (the numbered line edits of
 * PROTOCOL_LINE_EDIT, applied to the view's lines and mapped back to the file).
 *
 * The view is derived from the parse tree (web-tree-sitter with the grammars of
 * @vscode/tree-sitter-wasm), never from knowledge of the generated program:
 *
 *  - Functions: every function or method definition node (TypeScript `function_declaration`,
 *    Rust `function_item`, Python `function_definition`, Go `function_declaration`, Java
 *    `method_declaration`, C `function_definition`, Ruby `method`), by name.
 *  - Direct callees: call nodes inside the target whose callee is a bare name that is another
 *    function of the same file (`f(x)`; not `obj.f(x)`, not a function name used as a value),
 *    in order of first call.
 *  - Signature: the source text from the start of the definition to the start of its body, on
 *    one line, closed in the language's own bodyless form (`;`, ` ...`, `; end`).
 *
 * Limits (the tool is as far as a parse tree goes, nothing the generated filler relies on):
 *  - No type checking or name resolution: shadowing, overloads, methods of the same name in
 *    different classes, dynamic calls, macros and calls through values are not followed.
 *  - Only the target's own file; no imports, no type declarations, no comments or attributes
 *    above a definition (the view starts at the definition node), no callers.
 *  - C is parsed with the C++ grammar (@vscode/tree-sitter-wasm has no C grammar); the
 *    C subset used here parses identically.
 *  - Ruby calls without parentheses and without arguments are not seen as calls.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Node, Parser, Language as TsLanguage } from 'web-tree-sitter';
import { type AppliedEdit, applyTs, extractBlock, numbered } from './ai-edit-apply.js';

export const SCOPED_LANGS = ['ts', 'rust', 'python', 'go', 'java', 'c', 'ruby'] as const;
export type ScopedLang = (typeof SCOPED_LANGS)[number];

/** `signatures`: callees as signature lines; `bodies`: callees as whole bodies. */
export type ScopedArm = 'signatures' | 'bodies';

interface LangRules {
  readonly wasm: string;
  /** Node types that define a function. */
  readonly defs: readonly string[];
  /** Name of the function a definition node declares. */
  readonly name: (def: Node) => string | undefined;
  /** Node at whose start the signature ends (the body, or the parameters for `def`). */
  readonly sigEnd: (def: Node) => number;
  /** Name called by a call node when it is a plain `name(...)` call. */
  readonly callee: (call: Node) => string | undefined;
  readonly calls: readonly string[];
  /** Closing of a bodyless signature. */
  readonly sigSuffix: string;
  /** Node to start the definition at (a TypeScript `export` wraps its declaration). */
  readonly unit?: (def: Node) => Node;
}

const field = (n: Node, name: string): Node | null => n.childForFieldName(name);
const text = (n: Node | null): string | undefined => n?.text;

const callByFunction = (call: Node): string | undefined => {
  const f = field(call, 'function');
  return f?.type === 'identifier' ? f.text : undefined;
};

const RULES: Record<ScopedLang, LangRules> = {
  ts: {
    wasm: 'tree-sitter-typescript.wasm',
    defs: ['function_declaration'],
    name: (d) => text(field(d, 'name')),
    sigEnd: (d) => field(d, 'body')?.startIndex ?? d.endIndex,
    calls: ['call_expression'],
    callee: callByFunction,
    sigSuffix: ';',
    unit: (d) => (d.parent?.type === 'export_statement' ? d.parent : d),
  },
  rust: {
    wasm: 'tree-sitter-rust.wasm',
    defs: ['function_item'],
    name: (d) => text(field(d, 'name')),
    sigEnd: (d) => field(d, 'body')?.startIndex ?? d.endIndex,
    calls: ['call_expression'],
    callee: callByFunction,
    sigSuffix: ';',
  },
  python: {
    wasm: 'tree-sitter-python.wasm',
    defs: ['function_definition'],
    name: (d) => text(field(d, 'name')),
    sigEnd: (d) => field(d, 'body')?.startIndex ?? d.endIndex,
    calls: ['call'],
    callee: callByFunction,
    sigSuffix: ' ...',
  },
  go: {
    wasm: 'tree-sitter-go.wasm',
    defs: ['function_declaration'],
    name: (d) => text(field(d, 'name')),
    sigEnd: (d) => field(d, 'body')?.startIndex ?? d.endIndex,
    calls: ['call_expression'],
    callee: callByFunction,
    sigSuffix: '',
  },
  java: {
    wasm: 'tree-sitter-java.wasm',
    defs: ['method_declaration'],
    name: (d) => text(field(d, 'name')),
    sigEnd: (d) => field(d, 'body')?.startIndex ?? d.endIndex,
    calls: ['method_invocation'],
    callee: (c) => (field(c, 'object') === null ? text(field(c, 'name')) : undefined),
    sigSuffix: ';',
  },
  c: {
    wasm: 'tree-sitter-cpp.wasm',
    defs: ['function_definition'],
    name: (d) => {
      let decl = field(d, 'declarator');
      while (decl !== null && decl.type !== 'function_declarator') decl = field(decl, 'declarator');
      return text(decl === null ? null : field(decl, 'declarator'));
    },
    sigEnd: (d) => field(d, 'body')?.startIndex ?? d.endIndex,
    calls: ['call_expression'],
    callee: callByFunction,
    sigSuffix: ';',
  },
  ruby: {
    wasm: 'tree-sitter-ruby.wasm',
    defs: ['method'],
    name: (d) => text(field(d, 'name')),
    sigEnd: (d) => (field(d, 'parameters') ?? field(d, 'name'))?.endIndex ?? d.endIndex,
    calls: ['call'],
    callee: (c) => (field(c, 'receiver') === null ? text(field(c, 'method')) : undefined),
    sigSuffix: '; end',
  },
};

let ready: Promise<void> | undefined;
const grammars = new Map<ScopedLang, Promise<TsLanguage>>();

function wasmDir(): string {
  return dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm'));
}

async function parserFor(lang: ScopedLang): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  let g = grammars.get(lang);
  if (g === undefined) {
    g = TsLanguage.load(join(wasmDir(), RULES[lang].wasm));
    grammars.set(lang, g);
  }
  const parser = new Parser();
  parser.setLanguage(await g);
  return parser;
}

/** A function of the file: its lines (1-based, inclusive), signature and direct callees. */
export interface FunctionInfo {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Signature in bodyless form, with the definition line's indentation. */
  readonly signature: string;
  /** Names of other functions of the file called directly, in order of first call. */
  readonly callees: readonly string[];
}

/** Indexes the functions of `source`, in source order. */
export async function indexFunctions(
  lang: ScopedLang,
  source: string,
): Promise<readonly FunctionInfo[]> {
  const rules = RULES[lang];
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  if (tree === null) throw new Error(`${lang}: parse failed`);
  const defs: { node: Node; name: string }[] = [];
  const visit = (n: Node): void => {
    if (rules.defs.includes(n.type)) {
      const name = rules.name(n);
      if (name !== undefined) defs.push({ node: n, name });
    }
    for (const c of n.children) if (c !== null) visit(c);
  };
  visit(tree.rootNode);
  const names = new Set(defs.map((d) => d.name));
  const out = defs.map(({ node, name }): FunctionInfo => {
    const unit = rules.unit?.(node) ?? node;
    const calls: string[] = [];
    const walk = (n: Node): void => {
      if (rules.calls.includes(n.type)) {
        const callee = rules.callee(n);
        if (callee !== undefined && callee !== name && names.has(callee) && !calls.includes(callee))
          calls.push(callee);
      }
      for (const c of n.children) if (c !== null) walk(c);
    };
    walk(node);
    const lineStart = source.lastIndexOf('\n', unit.startIndex - 1) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart, unit.startIndex))?.[0] ?? '';
    const head = source.slice(unit.startIndex, rules.sigEnd(node)).replace(/\s+/g, ' ').trim();
    return {
      name,
      startLine: unit.startPosition.row + 1,
      endLine: unit.endPosition.row + 1,
      signature: `${indent}${head}${rules.sigSuffix}`,
      callees: calls,
    };
  });
  tree.delete();
  parser.delete();
  return out;
}

/** One line of a view: where it came from and whether an edit may touch it. */
export interface ViewLine {
  readonly text: string;
  /** 1-based line of the file; for a signature, the first line of its function. */
  readonly source: number;
  /** Last line of the function this line belongs to (insertions after a signature go there). */
  readonly functionEnd: number;
  readonly editable: boolean;
}

export interface ScopedView {
  readonly arm: ScopedArm;
  readonly target: string;
  readonly callees: readonly string[];
  readonly lines: readonly ViewLine[];
  /** The view as sent to a model: the edit handle, then the numbered lines. */
  readonly text: string;
  /** Line of the file before which `+0` inserts (just above the target). */
  readonly top: number;
}

/** The scoped view of `target` in `source` (throws when the file has no such function). */
export async function scopedView(
  lang: ScopedLang,
  source: string,
  target: string,
  arm: ScopedArm,
  handle = 'e0',
): Promise<ScopedView> {
  const fns = await indexFunctions(lang, source);
  const byName = new Map(fns.map((f) => [f.name, f]));
  const t = byName.get(target);
  if (t === undefined) throw new Error(`${lang}: no function ${target}`);
  const fileLines = source.trimEnd().split('\n');
  const lines: ViewLine[] = [];
  const body = (f: FunctionInfo, editable: boolean): void => {
    for (let n = f.startLine; n <= f.endLine; n += 1)
      lines.push({
        text: fileLines[n - 1] ?? '',
        source: n,
        functionEnd: f.endLine,
        editable,
      });
  };
  body(t, true);
  for (const name of t.callees) {
    const f = byName.get(name);
    if (f === undefined) continue;
    if (arm === 'bodies') body(f, true);
    else
      lines.push({
        text: f.signature,
        source: f.startLine,
        functionEnd: f.endLine,
        editable: false,
      });
  }
  return {
    arm,
    target,
    callees: t.callees,
    lines,
    text: `${handle}\n${numbered(lines.map((l) => l.text).join('\n'))}`,
    top: t.startLine - 1,
  };
}

/**
 * Applies a numbered line-edit reply (PROTOCOL_LINE_EDIT) written against `view` to the file.
 * Line numbers are the view's; an edit is mapped to the file line it was shown from, and an
 * insertion after a signature goes after the end of that function. Signature lines are read-only
 * (the rejection says so). Everything else (insert order, one edit per line, optional handle,
 * past-the-end positions) is `applyTs`'s rule applied to the view.
 */
export function applyScoped(
  source: string,
  view: ScopedView,
  reply: string,
  handle = 'e0',
): AppliedEdit {
  const all = extractBlock(reply).trimEnd().split('\n');
  const first = all[0] ?? '';
  if (/^[a-z]+[0-9]+$/.test(first) && first !== handle)
    return { source, error: `expected handle ${handle}, got '${first}'` };
  const edits = first === handle ? all.slice(1) : all;
  const last = view.lines[view.lines.length - 1];
  const out: string[] = [handle];
  const seen = new Set<number>();
  for (const l of edits) {
    const m = /^([+-]?)(\d+) ?(.*)$/.exec(l);
    if (!m) return { source, error: `bad edit line: ${l}` };
    const n = Number(m[2]);
    const mode = m[1] ?? '';
    const body = m[3] ?? '';
    if (mode === '+') {
      const ref = n === 0 ? undefined : view.lines[Math.min(n, view.lines.length) - 1];
      const anchor =
        ref === undefined
          ? n === 0
            ? view.top
            : (last?.functionEnd ?? 0)
          : ref.editable
            ? ref.source
            : ref.functionEnd;
      out.push(`+${anchor} ${body}`);
      continue;
    }
    if (seen.has(n) || n < 1) return { source, error: `bad or duplicate line number ${n}` };
    seen.add(n);
    const ref = view.lines[n - 1];
    if (ref === undefined) {
      if (mode !== '-') out.push(`+${last?.functionEnd ?? 0} ${body}`);
      continue;
    }
    if (!ref.editable)
      return {
        source,
        error: `line ${n} is a read-only signature of a called function; edit the lines of the function you were asked about, or insert after line ${n} to add a function`,
      };
    out.push(mode === '-' ? `-${ref.source}` : `${ref.source} ${body}`);
  }
  return applyTs('structured', source, out.join('\n'), handle);
}
