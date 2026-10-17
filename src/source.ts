/** Candidate flat source frontend. Grammar recovered from the measured A0 frontend experiment. */
import { aggregate, formatAggregate } from './aggregate.js';
import {
  type Func,
  formatTextLiteral,
  formatType,
  isDirectCallee,
  isValidIdentifier,
  LIMITS,
  type Node,
  type Operand,
  type Program,
  parseNodeOf,
  parseOperand,
  parseProgram,
  parseType,
  type Type,
  textNode,
  withComments,
} from './core.js';
import { A0Error, diag } from './diagnostics.js';
import { type Lit, SpecBuilder } from './spec.js';

export interface ParsedSource {
  readonly program: Program;
  readonly locate: (fn: string, node?: string) => number | undefined;
}

export function parseSource(source: string): Program {
  return parseSourceUnit(source).program;
}

/** Shared source scanner and instruction parser; no conversion or full-program reparse. */
export function parseSourceUnit(source: string): ParsedSource {
  const origins = new Map<string, Map<string | undefined, number>>();
  let inferred = false;
  let used = 0;
  const operand = (text: string, line?: number, lineText?: string): Operand => {
    const code = text.charCodeAt(0);
    const value: Operand =
      text.length === 1 && code >= 65 && code <= 90
        ? { kind: 'param', index: code - 65 }
        : parseOperand(text, line, lineText);
    if (value.kind === 'param') used = Math.max(used, value.index + 1);
    return value;
  };
  const node = (text: string, line?: number, words?: readonly string[]): Node => {
    const quoted = /^(\S+)\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(text);
    if (quoted !== null) return textNode(quoted[1] as string, quoted[2] as string, line);
    const parts = words ?? text.trim().split(/\s+/);
    const id = parts[0] ?? '';
    const word = parts[1] ?? '';
    if (word.startsWith('[') || word.startsWith('(')) {
      if (!isValidIdentifier(id)) throw diag('A0005', [id], line === undefined ? {} : { line });
      const cursor = { text: parts.slice(1).join(' '), pos: 0 };
      const fail = (message: string): never => {
        throw new A0Error(message, line, { code: 'parse' });
      };
      const value = aggregate(cursor, {
        maxElements: LIMITS.maxAggregateBits,
        fail,
        atom: () => {
          const token = /^[^\s,[\]()*;]+/.exec(cursor.text.slice(cursor.pos))?.[0];
          if (token === undefined) return fail('an aggregate element must be an operand');
          cursor.pos += token.length;
          return operand(token, line, text);
        },
      });
      if (cursor.pos !== cursor.text.length) fail('unexpected text after aggregate literal');
      return { id, op: value.kind, args: value.items };
    }
    // Operator tokens normalize directly in the existing node parser, preserving original text.
    const tokens =
      word === '<<' || word === '>>'
        ? [id, word === '<<' ? 'shl' : 'shr', ...parts.slice(2)]
        : parts;
    return parseNodeOf(text, line, text.includes('"') ? undefined : tokens, operand);
  };
  const program = parseProgram(source, {
    header(words, line, text) {
      used = 0;
      const arrow = words.indexOf('->');
      inferred = arrow < 0 && words.length === 2;
      if (!inferred && (arrow < 2 || arrow !== words.length - 2)) throw diag('A0023', [], { line });
      const type = (word: string): Type => parseType(word.replaceAll('_', 'u32'), line, text, true);
      const params = inferred ? [] : words.slice(2, arrow).map(type);
      if (params.length > LIMITS.maxParams) throw diag('A0024', [], { line });
      return { params, result: inferred ? 'u32' : type(words[arrow + 1] ?? '') };
    },
    node,
    operand,
    specs: (name) => new SpecBuilder(name, { node, compact: true }),
    finish(fn) {
      if (!inferred) return fn;
      if (used > LIMITS.maxParams) throw diag('A0024');
      return { ...fn, params: new Array<Type>(used).fill('u32') };
    },
    origin(fn, id, line) {
      let map = origins.get(fn);
      if (map === undefined) {
        map = new Map();
        origins.set(fn, map);
      }
      map.set(id, line);
    },
  });
  return {
    program,
    locate: (fn, id) => origins.get(fn)?.get(id) ?? origins.get(fn)?.get(undefined),
  };
}

function header(fn: Func): string {
  let count = 0;
  const see = (value: Operand): void => {
    if (value.kind === 'param') count = Math.max(count, value.index + 1);
  };
  if (fn.result === 'u32' && fn.params.every((type) => type === 'u32')) {
    for (const node of fn.nodes) for (const value of node.args) see(value);
    see(fn.ret);
    for (const node of [fn.spec?.pre, fn.spec?.post])
      if (node !== undefined) for (const value of node.args) see(value);
    if (count === fn.params.length) return `fn ${fn.name}`;
  }
  const type = (value: Type): string => formatType(value).replaceAll('u32', '_');
  return `fn ${[fn.name, ...fn.params.map(type)].join(' ')} -> ${type(fn.result)}`;
}

function printOperand(value: Operand): string {
  switch (value.kind) {
    case 'node':
      return value.id;
    case 'param':
      return value.index < 26 ? String.fromCharCode(65 + value.index) : `p${value.index}`;
    case 'u32':
      return String(value.value);
    case 'bool':
      return String(value.value);
  }
}

function printNode(node: Node): string {
  if (node.op === 'arr' && node.text !== undefined)
    return `${node.id} ${formatTextLiteral(node.text)}`;
  if (node.op === 'arr' || node.op === 'rec')
    return `${node.id} ${formatAggregate(node.op, node.args, printOperand)}`;
  const op = node.op === 'shl' ? '<<' : node.op === 'shr' ? '>>' : node.op;
  const direct = node.op === 'call' && node.callee !== undefined && isDirectCallee(node.callee);
  return [
    node.id,
    ...(direct
      ? [node.callee as string]
      : [
          op,
          ...(node.pred === undefined ? [] : [node.pred]),
          ...(node.callee === undefined ? [] : [node.callee]),
        ]),
    ...node.args.map(printOperand),
  ].join(' ');
}

function literal(value: Lit): string {
  return value.kind === 'u32' || value.kind === 'bool'
    ? String(value.value)
    : formatAggregate(value.kind, value.items, literal);
}

/** One default formatter. Keeps complete source metadata and does not rename or reorder nodes. */
export function formatSource(program: Program): string {
  const lines: string[] = [];
  if (program.profile === 'strict')
    lines.push(withComments('profile strict', program.profileComments));
  for (const [index, use] of (program.uses ?? []).entries())
    lines.push(withComments(`use "${use}"`, program.useComments?.[index]));
  if (lines.length && (program.functions.length || program.tailComments?.length)) lines.push('');
  for (const [index, fn] of program.functions.entries()) {
    if (index) lines.push('');
    lines.push(withComments(header(fn), fn.comments));
    for (const example of fn.spec?.examples ?? [])
      lines.push(
        withComments(
          `ex ${[...example.args.map(literal), '->', literal(example.result)].join(' ')}`,
          example.comments,
        ),
      );
    for (const node of [fn.spec?.pre, fn.spec?.post])
      if (node !== undefined) lines.push(withComments(printNode(node), node.comments));
    for (const node of fn.nodes) lines.push(withComments(printNode(node), node.comments));
    lines.push(
      withComments(`ret ${printOperand(fn.ret)}`, fn.retComments),
      withComments('end', fn.endComments),
    );
    if (fn.afterComments !== undefined) lines.push('', ...fn.afterComments);
  }
  lines.push(...(program.tailComments ?? []));
  return lines.length ? `${lines.join('\n')}\n` : '';
}
