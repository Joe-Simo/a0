/**
 * Language Server Protocol server for .a0 files, over stdio.
 *
 *   a0 lsp [root]
 *
 * Diagnostics come from the linker and checker (src/link.ts, src/core.ts) on open and change,
 * with the A0 diagnostic code and its fix; hover shows function signatures and op docs;
 * go-to-definition follows `use` files; document symbols, completion of ops and in-scope
 * functions, and formatting through the canonical printer. Every file read, `use` targets
 * included, is confined to the root exactly as in the MCP server (src/mcp.ts); documents
 * outside it get a single `limit` diagnostic and no other service.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CodeAction,
  CodeActionKind,
  type CompletionItem,
  CompletionItemKind,
  type Connection,
  createConnection,
  type Diagnostic,
  DiagnosticSeverity,
  type DocumentSymbol,
  type Location,
  type Position,
  type Range,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  type TextEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  A0Error,
  type FixEdit,
  formatSource,
  OP_ALIASES,
  OPS,
  type Op,
  parse,
  stripComment,
} from './core.js';
import { applyEdit } from './fix.js';
import { link } from './link.js';
import { confine } from './mcp.js';

/** One-line reference for every op, shown on hover and in completion. */
export const OP_DOCS: Readonly<Record<Op, string>> = {
  mov: 'mov x: copy x',
  add: 'add a b: a + b (u32, wraps mod 2^32)',
  sub: 'sub a b: a - b (u32, wraps mod 2^32)',
  mul: 'mul a b: a * b (u32, wraps mod 2^32)',
  and: 'and a b: bitwise and (u32) or logical and (bool)',
  or: 'or a b: bitwise or (u32) or logical or (bool)',
  xor: 'xor a b: bitwise xor (u32) or logical xor (bool)',
  shl: 'shl a n: a << (n & 31)',
  shr: 'shr a n: a >> (n & 31), logical',
  eq: 'eq a b -> bool: a == b',
  ne: 'ne a b -> bool: a != b',
  lt: 'lt a b -> bool: a < b (unsigned)',
  le: 'le a b -> bool: a <= b (unsigned)',
  gt: 'gt a b -> bool: a > b (unsigned)',
  ge: 'ge a b -> bool: a >= b (unsigned)',
  select: 'select c x y: x when c is true, else y',
  call: 'call F a...: F(a...) for a function F defined earlier (short form: `id F a...`)',
  fold: 'fold F n s a...: state = s; for i < n: state = F(state, i, a...)',
  loop: 'loop P F n s a...: like fold, stopping early when P(state, i, a...) is false',
  arr: 'arr e...: array of the elements (all one type); `text "s"` builds UTF-8 bytes',
  rec: 'rec e...: record of the fields',
  get: 'get a i: element i mod N of array a',
  set: 'set a i v: array a with element i mod N replaced by v',
  at: 'at r k: field k of record r (k a literal)',
  put: 'put r k v: record r with field k replaced by v',
  read: 'read t -> (u32, io): the next input word and the new io token',
  write: 'write t v -> io: output the word v',
  div: 'div a b: a / b (unsigned); b = 0 gives 4294967295',
  rem: 'rem a b: a mod b (unsigned); b = 0 gives a',
  puts: 'puts t a -> io: output the array a as bytes',
};

const FN_LINE = /^\s*fn\s+([a-z][a-z0-9_]*)\b/;
const USE_LINE = /^\s*use\s+"([^"\\]+)"\s*$/;
const END_LINE = /^\s*end\s*$/;
const LINKED_AT = /^(\/[^\n]*?\.a0)(?::(\d+))?: /;

interface FnDef {
  readonly name: string;
  /** The header line as written, comment stripped. */
  readonly signature: string;
  readonly path: string;
  readonly line: number;
  readonly endLine: number;
  readonly endChar: number;
}

/** Function headers of one file, found line by line so broken files still have symbols. */
function definitions(path: string, text: string): FnDef[] {
  const lines = text.split(/\r?\n/);
  const out: FnDef[] = [];
  for (const [i, raw] of lines.entries()) {
    const m = FN_LINE.exec(raw);
    if (m === null) continue;
    let end = lines.findIndex((l, j) => j > i && (END_LINE.test(l) || FN_LINE.test(l)));
    if (end < 0) end = lines.length - 1;
    else if (!END_LINE.test(lines[end] ?? '')) end = Math.max(i, end - 1);
    out.push({
      name: m[1] as string,
      signature: stripComment(raw).trim(),
      path,
      line: i,
      endLine: end,
      endChar: (lines[end] ?? '').length,
    });
  }
  return out;
}

/** The smallest whole-line replacement that turns `before` into `after`. */
function changedLines(before: string, after: string): TextEdit {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const end = a.length - tail;
  const insert = b.slice(head, b.length - tail).join('\n');
  return {
    range: {
      start: { line: head, character: 0 },
      end:
        end < a.length
          ? { line: end, character: 0 }
          : { line: a.length - 1, character: (a[a.length - 1] ?? '').length },
    },
    newText: end < a.length && insert !== '' ? `${insert}\n` : insert,
  };
}

const lineRange = (text: string, line: number): Range => {
  const l = text.split(/\r?\n/)[line] ?? '';
  const start = l.length - l.trimStart().length;
  return { start: { line, character: start }, end: { line, character: l.length } };
};

function wordAt(text: string, pos: Position): string | undefined {
  const l = text.split(/\r?\n/)[pos.line] ?? '';
  let a = pos.character;
  let b = pos.character;
  while (a > 0 && /[A-Za-z0-9_]/.test(l[a - 1] ?? '')) a -= 1;
  while (b < l.length && /[A-Za-z0-9_]/.test(l[b] ?? '')) b += 1;
  return a < b ? l.slice(a, b) : undefined;
}

/** Wire the A0 language services onto `connection` for files inside `launch`. */
export async function startServer(connection: Connection, launch: string): Promise<void> {
  const launched = await realpath(resolve(launch));
  const root = (await stat(launched)).isDirectory() ? launched : dirname(launched);
  const documents = new TextDocuments(TextDocument);
  /** Real (confined) path of each open document, by URI. */
  const paths = new Map<string, string>();

  const scrub = (s: string): string => s.split(`${root}${sep}`).join('');

  /** Confined real path of a document URI, or undefined when it is not a file inside the root. */
  const pathOf = async (uri: string): Promise<string | undefined> => {
    if (!uri.startsWith('file:')) return undefined;
    try {
      return await confine(root, fileURLToPath(uri), true);
    } catch {
      return undefined;
    }
  };

  /** Source of a confined path: the open buffer when there is one, else the file. */
  const read = async (p: string): Promise<string> => {
    const real = await confine(root, p, true);
    for (const [uri, path] of paths)
      if (path === real) {
        const doc = documents.get(uri);
        if (doc !== undefined) return doc.getText();
      }
    return readFile(real, 'utf8');
  };

  /** The file and every file it transitively `use`s (each once), skipping unreadable ones. */
  const closure = async (entry: string): Promise<{ path: string; text: string }[]> => {
    const out: { path: string; text: string }[] = [];
    const seen = new Set<string>();
    const visit = async (path: string): Promise<void> => {
      if (seen.has(path)) return;
      seen.add(path);
      const text = await read(path).catch(() => undefined);
      if (text === undefined) return;
      out.push({ path, text });
      for (const l of text.split(/\r?\n/)) {
        const m = USE_LINE.exec(stripComment(l));
        if (m === null) continue;
        const target = await confine(root, resolve(dirname(path), m[1] as string), true).catch(
          () => undefined,
        );
        if (target !== undefined) await visit(target);
      }
    };
    await visit(entry);
    return out;
  };

  const inScope = async (uri: string): Promise<FnDef[]> => {
    const path = paths.get(uri);
    if (path === undefined) return [];
    return (await closure(path)).flatMap((f) => definitions(f.path, f.text));
  };

  const diagnose = async (doc: TextDocument): Promise<Diagnostic[]> => {
    const path = paths.get(doc.uri);
    const text = doc.getText();
    if (path === undefined)
      return [
        {
          range: lineRange(text, 0),
          severity: DiagnosticSeverity.Error,
          code: 'limit',
          source: 'a0',
          message: 'file is outside the language server root; no checks run',
        },
      ];
    try {
      await link(path, read, { root });
      return [];
    } catch (e) {
      const err = e instanceof A0Error ? e : new A0Error('internal error', undefined);
      const at = LINKED_AT.exec(err.message);
      const body = at === null ? err.message : err.message.slice(at[0].length);
      let line = 0;
      let where = '';
      if (at !== null && at[1] === path && at[2] !== undefined) line = Number(at[2]) - 1;
      else if (at !== null && at[1] !== path) {
        where = `${scrub(at[1] as string)}${at[2] === undefined ? '' : `:${at[2]}`}: `;
        const lines = text.split(/\r?\n/);
        line = Math.max(
          0,
          lines.findIndex((l) => USE_LINE.test(l)),
        );
      }
      const detail = scrub(`${where}${body}`);
      return [
        {
          range: lineRange(text, line),
          severity: DiagnosticSeverity.Error,
          // The coarse class stays the LSP code; the table code, the fix and its applicability
          // travel as data (and drive the quick fix below).
          code: err.code,
          source: 'a0',
          message: err.fix === undefined ? detail : `${err.fix}\n${detail}`,
          data: {
            id: err.id ?? null,
            code: err.code,
            fix: err.fix === undefined ? null : scrub(err.fix),
            applicability: err.applicability ?? null,
            edits: err.edits,
          },
        },
      ];
    }
  };

  const publish = async (doc: TextDocument): Promise<void> => {
    await connection.sendDiagnostics({ uri: doc.uri, diagnostics: await diagnose(doc) });
  };

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      completionProvider: {},
      documentFormattingProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    },
    serverInfo: { name: 'a0', version: '0.1.0' },
  }));

  documents.onDidOpen(async ({ document }) => {
    const path = await pathOf(document.uri);
    if (path !== undefined) paths.set(document.uri, path);
  });
  documents.onDidClose(({ document }) => {
    paths.delete(document.uri);
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  });
  // An edit can break or fix any open file that uses this one: recheck them all.
  documents.onDidChangeContent(async ({ document }) => {
    if (!paths.has(document.uri)) {
      const path = await pathOf(document.uri);
      if (path !== undefined) paths.set(document.uri, path);
    }
    await publish(document);
    for (const other of documents.all()) if (other.uri !== document.uri) await publish(other);
  });

  connection.onHover(async ({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined || !paths.has(doc.uri)) return null;
    const word = wordAt(doc.getText(), position);
    if (word === undefined) return null;
    const def = (await inScope(doc.uri)).find((d) => d.name === word);
    if (def !== undefined) return { contents: { kind: 'markdown', value: `\`${def.signature}\`` } };
    const op = (OPS as readonly string[]).includes(word) ? (word as Op) : OP_ALIASES[word];
    if (op === undefined) return null;
    const alias = op === word ? '' : `\`${word}\` is an alias of \`${op}\`\n\n`;
    return { contents: { kind: 'markdown', value: `${alias}${OP_DOCS[op]}` } };
  });

  connection.onDefinition(async ({ textDocument, position }): Promise<Location | null> => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return null;
    const word = wordAt(doc.getText(), position);
    const def = (await inScope(doc.uri)).find((d) => d.name === word);
    if (def === undefined) return null;
    const range = lineRange(await read(def.path), def.line);
    return { uri: pathToFileURL(def.path).href, range };
  });

  connection.onDocumentSymbol(({ textDocument }): DocumentSymbol[] => {
    const doc = documents.get(textDocument.uri);
    const path = paths.get(textDocument.uri);
    if (doc === undefined || path === undefined) return [];
    const text = doc.getText();
    return definitions(path, text).map((d) => ({
      name: d.name,
      detail: d.signature,
      kind: SymbolKind.Function,
      range: {
        start: { line: d.line, character: 0 },
        end: { line: d.endLine, character: d.endChar },
      },
      selectionRange: lineRange(text, d.line),
    }));
  });

  connection.onCompletion(async ({ textDocument }): Promise<CompletionItem[]> => {
    if (!paths.has(textDocument.uri)) return [];
    const ops: CompletionItem[] = [...OPS, ...Object.keys(OP_ALIASES)].map((name) => ({
      label: name,
      kind: CompletionItemKind.Operator,
      detail:
        OP_DOCS[
          (OPS as readonly string[]).includes(name) ? (name as Op) : (OP_ALIASES[name] as Op)
        ],
    }));
    const fns: CompletionItem[] = (await inScope(textDocument.uri)).map((d) => ({
      label: d.name,
      kind: CompletionItemKind.Function,
      detail: d.signature,
    }));
    return [...ops, ...fns];
  });

  connection.onDocumentFormatting(({ textDocument }): TextEdit[] | null => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined || !paths.has(doc.uri)) return null;
    const text = doc.getText();
    let formatted: string;
    try {
      formatted = formatSource(parse(text));
    } catch {
      return null;
    }
    if (formatted === text) return [];
    const end = doc.positionAt(text.length);
    return [{ range: { start: { line: 0, character: 0 }, end }, newText: formatted }];
  });

  // A diagnostic that carries edits is a quick fix; an exact one is the preferred fix.
  connection.onCodeAction(({ textDocument, context }): CodeAction[] => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined || !paths.has(doc.uri)) return [];
    const text = doc.getText();
    const actions: CodeAction[] = [];
    for (const d of context.diagnostics) {
      const data = d.data as
        | { edits?: FixEdit[]; fix?: string | null; applicability?: string }
        | undefined;
      const edit = data?.edits?.[0];
      if (edit === undefined) continue;
      const next = applyEdit(text, edit);
      if (next === undefined || next === text) continue;
      actions.push({
        title: `${data?.applicability === 'exact' ? 'Apply exact fix' : 'Quick fix'}: ${data?.fix ?? 'rewrite the line'}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        isPreferred: data?.applicability === 'exact',
        edit: { changes: { [doc.uri]: [changedLines(text, next)] } },
      });
    }
    return actions;
  });

  documents.listen(connection);
  connection.listen();
}

/** `a0 lsp [root]`: serve over stdio until the client exits. */
export async function serveLsp(launch: string): Promise<void> {
  await startServer(createConnection(process.stdin, process.stdout), launch);
}
