/**
 * Host side of the dense reader in A0 (compiler/dense.a0): what the host passes to the reader besides the
 * dense text of a program.
 *
 * Stubs. A call needs the parameter count of its callee. When the callee is defined in a file the program
 * `use`s, or in an earlier chunk of the same program, the reader cannot see it; the host writes its canonical
 * header as a stub line in front of the text,
 *
 *     use fn NAME TYPES -> RESULT
 *
 * and the reader reads the header (the parameter types, the result) and writes nothing for it. A stub
 * line comes after the `use "file"` lines or before them, never after a function.
 *
 * Chunks. The reader's capacities are per input, so a program larger than one input is cut at function
 * boundaries into chunks (`planChunks`); the chunk of functions F gets, as stubs, the headers of the
 * functions it calls that earlier chunks (or used files) define. The canonical text of the program is the
 * outputs of the chunks joined with one newline: the reader ends each function with a blank line, so the
 * chunk outputs are the functions in order.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type Func,
  formatFunction,
  formatType,
  type Program,
  parse,
  type Type,
} from '../src/core.js';
import { formatDense } from '../src/dense.js';

/** A function's signature, as its canonical header writes it. */
export interface Signature {
  readonly params: readonly Type[];
  readonly result: Type;
}

/** The stub line of a function: its canonical header after `use `. */
export function stubLine(name: string, sig: Signature): string {
  const types = sig.params.length > 0 ? ` ${sig.params.map(formatType).join(' ')}` : '';
  return `use fn ${name}${types} -> ${formatType(sig.result)}`;
}

/** The names a function calls, folds or loops over. */
export function callees(f: Func): string[] {
  const out: string[] = [];
  for (const n of f.nodes) {
    if (n.callee !== undefined) out.push(n.callee);
    if (n.pred !== undefined) out.push(n.pred);
  }
  return out;
}

/** The signatures of every function the file `abs` uses, transitively (a file's own functions excluded). */
export function usedSignatures(abs: string): Map<string, Signature> {
  const sigs = new Map<string, Signature>();
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const program = parse(readFileSync(path, 'utf8'));
    for (const u of program.uses ?? []) visit(resolve(dirname(path), u));
    for (const f of program.functions) sigs.set(f.name, { params: f.params, result: f.result });
  };
  const program = parse(readFileSync(abs, 'utf8'));
  for (const u of program.uses ?? []) visit(resolve(dirname(abs), u));
  return sigs;
}

/** The parameter counts of a map of signatures (the `known` option of the reference). */
export function arities(sigs: ReadonlyMap<string, Signature>): Map<string, number> {
  return new Map([...sigs].map(([k, v]) => [k, v.params.length] as const));
}

/** Stub lines for the functions of `program` that are called and not defined in it, in a stable order. */
export function stubsOf(program: Program, sigs: ReadonlyMap<string, Signature>): string[] {
  const own = new Set(program.functions.map((f) => f.name));
  const need = new Set<string>();
  for (const f of program.functions) for (const c of callees(f)) if (!own.has(c)) need.add(c);
  const out: string[] = [];
  for (const name of [...need].sort()) {
    const sig = sigs.get(name);
    if (sig !== undefined) out.push(stubLine(name, sig));
  }
  return out;
}

/**
 * The dense text of a program written with the functions of its used files as known arities (`text`), and the
 * text the reader gets (`dense`): the same with the stub lines in front.
 */
export function denseWithStubs(
  program: Program,
  sigs: ReadonlyMap<string, Signature>,
): { dense: string; text: string } {
  const dense = formatDense(program, { known: arities(sigs) });
  const stubs = stubsOf(program, sigs);
  return { dense: stubs.length > 0 ? `${stubs.join('\n')}\n${dense}` : dense, text: dense };
}

/** The reader's capacities for one input (compiler/dense.a0, the header comment). */
export interface Caps {
  /** Dense bytes (the input, stubs included). */
  readonly bytes: number;
  readonly tokens: number;
  readonly lines: number;
  /** Nodes of all the functions of the input, the lifted bodies included. */
  readonly nodes: number;
  /** Nodes of the lifted bodies of inline folds and loops, and their count. */
  readonly inlineNodes: number;
  readonly inlineBodies: number;
  /** Functions of the table, stubs and lifted bodies included. */
  readonly functions: number;
  readonly params: number;
  /** Operands of the calls, folds and loops of the call-argument pool. */
  readonly callArgs: number;
  /** Elements of the array literals (the largest region, the first level of arrays). */
  readonly arrayElems: number;
  /** Bytes of the canonical text the reader writes. */
  readonly outBytes: number;
}

export const READER_CAPS: Caps = {
  bytes: 16384,
  tokens: 4096,
  lines: 2048,
  nodes: 2048,
  inlineNodes: 1024,
  inlineBodies: 512,
  functions: 512,
  params: 2048,
  callArgs: 3072,
  arrayElems: 2112,
  outBytes: 16384,
};

/** What one block of dense text costs the reader (and, for a stub, what its line costs). */
export interface Cost {
  bytes: number;
  tokens: number;
  lines: number;
  nodes: number;
  inlineNodes: number;
  inlineBodies: number;
  functions: number;
  params: number;
  callArgs: number;
  arrayElems: number;
  outBytes: number;
}

const ZERO: Cost = {
  bytes: 0,
  tokens: 0,
  lines: 0,
  nodes: 0,
  inlineNodes: 0,
  inlineBodies: 0,
  functions: 0,
  params: 0,
  callArgs: 0,
  arrayElems: 0,
  outBytes: 0,
};

function add(a: Cost, b: Cost): Cost {
  return {
    bytes: a.bytes + b.bytes,
    tokens: a.tokens + b.tokens,
    lines: a.lines + b.lines,
    nodes: a.nodes + b.nodes,
    inlineNodes: a.inlineNodes + b.inlineNodes,
    inlineBodies: a.inlineBodies + b.inlineBodies,
    functions: a.functions + b.functions,
    params: a.params + b.params,
    callArgs: a.callArgs + b.callArgs,
    arrayElems: a.arrayElems + b.arrayElems,
    outBytes: a.outBytes + b.outBytes,
  };
}

/** Whether every count of `c` is within `caps`. */
export function fits(c: Cost, caps: Caps): boolean {
  return (
    c.bytes <= caps.bytes &&
    c.tokens <= caps.tokens &&
    c.lines <= caps.lines &&
    c.nodes <= caps.nodes &&
    c.inlineNodes <= caps.inlineNodes &&
    c.inlineBodies <= caps.inlineBodies &&
    c.functions <= caps.functions &&
    c.params <= caps.params &&
    c.callArgs <= caps.callArgs &&
    c.arrayElems <= caps.arrayElems &&
    c.outBytes <= caps.outBytes
  );
}

/** The first capacity of `caps` that `c` exceeds, as a reason; undefined when all hold. */
export function over(c: Cost, caps: Caps): string | undefined {
  for (const k of Object.keys(caps) as (keyof Caps)[])
    if (c[k] > caps[k]) return `over the capacity of one input: ${k} ${c[k]} > ${caps[k]}`;
  return undefined;
}

/** The reader's tokens, counted from above: a string, a run of word bytes, any other byte. */
function countTokens(text: string): number {
  return (text.match(/"(?:[^"\\]|\\.)*"|[^\s()[\],;{}]+|[()[\],;{}]/g) ?? []).length;
}

/** A line of text, the line break included: bytes, tokens, one line. */
function textCost(text: string): Cost {
  return {
    ...ZERO,
    bytes: Buffer.byteLength(text) + 1,
    tokens: countTokens(text),
    lines: text.split('\n').length,
  };
}

/** A function of the dense text: its lines and the functions it stands for (its lifted bodies, then itself). */
export interface Block {
  readonly name: string;
  readonly text: string;
  readonly cost: Cost;
  /** The names of the text that are functions of the program or of its used files, other than the block's own. */
  readonly calls: readonly string[];
  /** Why the reader cannot read this function, whatever the chunk: it is refused without being read. */
  readonly limit?: string;
}

/** A program as the host cuts it: the blocks of its dense text, and the signature of every function. */
export interface Planned {
  readonly blocks: readonly Block[];
  readonly sigs: ReadonlyMap<string, Signature>;
}

/**
 * The blocks of the dense text of a program (the functions are separated by blank lines; a `use` line is not
 * a block: the stubs say what the used files define) and the signatures of the functions it can call.
 */
export function planned(program: Program, used: ReadonlyMap<string, Signature>): Planned {
  const dense = formatDense({ ...program, uses: [] }, { known: arities(used) });
  const sigs = new Map<string, Signature>(used);
  for (const f of program.functions) sigs.set(f.name, { params: f.params, result: f.result });
  const texts = dense.split(/\n\n+/).filter((b) => b.trim() !== '');
  const blocks: Block[] = [];
  let next = 0;
  // a call is to a function of a used file or of an earlier block
  const earlier = new Set<string>();
  for (const text of texts) {
    const trimmed = text.replace(/\n+$/, '');
    const name = /^fn\s+(\S+)/.exec(trimmed)?.[1];
    if (name === undefined) throw new Error('a block of the dense text does not start with fn');
    // the functions this block stands for: the lifted bodies come before the function itself
    // the blank line that follows the block is one more line and one more byte
    const own = textCost(trimmed);
    let cost = { ...own, bytes: own.bytes + 1, lines: own.lines + 1 };
    let limit: string | undefined;
    for (;;) {
      const f = program.functions[next];
      if (f === undefined) throw new Error(`no function for the block ${name}`);
      next += 1;
      const lifted = f.name !== name;
      for (const n of f.nodes)
        if (n.op === 'rec' && n.args.length > 4)
          limit = 'a record of more than 4 fields (a frame of the reader holds 4)';
      const elems = f.nodes
        .filter((n) => n.op === 'arr' && n.text === undefined)
        .reduce((s, n) => s + n.args.length, 0);
      const args = f.nodes
        .filter((n) => n.op === 'call' || n.op === 'fold' || n.op === 'loop')
        .reduce((s, n) => s + n.args.length, 0);
      cost = add(cost, {
        ...ZERO,
        nodes: f.nodes.length,
        inlineNodes: lifted ? f.nodes.length : 0,
        inlineBodies: lifted ? 1 : 0,
        functions: 1,
        params: f.params.length,
        callArgs: args,
        arrayElems: elems,
        // the canonical text of the function and the blank line after it
        outBytes: Buffer.byteLength(formatFunction(f)) + 2,
      });
      if (!lifted) break;
    }
    const calls = new Set<string>();
    for (const w of trimmed.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
      if (w !== name && (used.has(w) || earlier.has(w))) calls.add(w);
    earlier.add(name);
    blocks.push({
      name,
      text: trimmed,
      cost,
      calls: [...calls].sort(),
      ...(limit ? { limit } : {}),
    });
  }
  return { blocks, sigs };
}

/** One chunk: blocks that go to the reader together, and the stub lines in front of them. */
export interface Chunk {
  readonly blocks: readonly Block[];
  readonly stubs: readonly string[];
  readonly cost: Cost;
}

/** The chunk of `blocks`: the stubs of the functions they call that none of them defines, then the blocks. */
export function chunkOf(blocks: readonly Block[], sigs: ReadonlyMap<string, Signature>): Chunk {
  const defined = new Set(blocks.map((b) => b.name));
  const need = new Set<string>();
  for (const b of blocks) for (const c of b.calls) if (!defined.has(c)) need.add(c);
  const stubs: string[] = [];
  let cost = ZERO;
  for (const name of [...need].sort()) {
    const sig = sigs.get(name) as Signature;
    const line = stubLine(name, sig);
    stubs.push(line);
    cost = add(cost, {
      ...textCost(line),
      functions: 1,
      params: sig.params.length,
    });
  }
  for (const b of blocks) cost = add(cost, b.cost);
  return { blocks, stubs, cost };
}

/** The text the reader gets for a chunk. */
export function chunkText(c: Chunk): string {
  const head = c.stubs.length > 0 ? `${c.stubs.join('\n')}\n` : '';
  return `${head}${c.blocks.map((b) => b.text).join('\n\n')}\n`;
}

/**
 * Cuts the blocks into chunks, in order, at block boundaries: a chunk takes the next block while every
 * capacity (bytes, tokens, lines, nodes, ...) still holds with the stubs the chunk then needs; the first
 * capacity to bind ends the chunk. A block that does not fit alone is a chunk of its own (the reader flags it).
 */
export function planChunks(p: Planned, caps: Caps = READER_CAPS): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Block[] = [];
  for (const b of p.blocks) {
    if (b.limit !== undefined) {
      if (cur.length > 0) chunks.push(chunkOf(cur, p.sigs));
      chunks.push(chunkOf([b], p.sigs));
      cur = [];
      continue;
    }
    const grown = chunkOf([...cur, b], p.sigs);
    if (cur.length === 0 || fits(grown.cost, caps)) cur.push(b);
    else {
      chunks.push(chunkOf(cur, p.sigs));
      cur = [b];
    }
  }
  if (cur.length > 0) chunks.push(chunkOf(cur, p.sigs));
  return chunks;
}

/**
 * The functions the reader refuses whatever the chunk, with the reason, known before reading: a limit of the
 * reader in the function, or a capacity of one input that the function exceeds alone.
 */
export function refusedUpFront(p: Planned): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of p.blocks) {
    const why = b.limit ?? over(chunkOf([b], p.sigs).cost, READER_CAPS);
    if (why !== undefined) out.set(b.name, why);
  }
  return out;
}

/** The reader: dense text in, canonical text and the error flag out. */
export type DenseReader = (text: string) => { text: string; err: boolean };

export interface ChunkedRead {
  /** The canonical text of the program: the chunk outputs joined with one newline. */
  readonly text: string;
  /** Set when a chunk (a single function) is refused. */
  readonly err: boolean;
  /** The chunks read, and how many times a chunk the reader flagged was cut in two to try again. */
  readonly chunks: number;
  readonly retries: number;
  /** The functions refused on their own. */
  readonly refused: readonly string[];
  /** The reason of each function refused for a limit of the reader known beforehand. */
  readonly reasons: ReadonlyMap<string, string>;
  /** The chunks the reader flagged although the planner counted them within the capacities. */
  readonly flagged: readonly string[];
}

/**
 * Reads a program chunk by chunk. A chunk the reader flags although the planner counted it within the
 * capacities (a capacity the planner does not count) is cut in two and both halves are read; a function
 * flagged on its own is refused.
 */
export function readChunked(read: DenseReader, p: Planned, caps: Caps = READER_CAPS): ChunkedRead {
  const outs: string[] = [];
  const refused: string[] = [];
  const reasons = new Map<string, string>();
  const flagged: string[] = [];
  let chunks = 0;
  let retries = 0;
  const go = (c: Chunk): void => {
    // a function that cannot be read in any chunk is refused without being read: a limit of the reader, or
    // a capacity of one input that it exceeds alone (the budget of the planner is only where chunks are cut)
    const only = c.blocks.length === 1 ? (c.blocks[0] as Block) : undefined;
    const why = only === undefined ? undefined : (only.limit ?? over(c.cost, READER_CAPS));
    if (only !== undefined && why !== undefined) {
      chunks += 1;
      refused.push(only.name);
      reasons.set(only.name, why);
      return;
    }
    const text = chunkText(c);
    const got = read(text);
    if (!got.err) {
      chunks += 1;
      outs.push(got.text);
    } else if (c.blocks.length > 1) {
      retries += 1;
      flagged.push(c.blocks.map((b) => b.name).join(' '));
      const mid = c.blocks.length >> 1;
      go(chunkOf(c.blocks.slice(0, mid), p.sigs));
      go(chunkOf(c.blocks.slice(mid), p.sigs));
    } else {
      chunks += 1;
      refused.push((c.blocks[0] as Block).name);
    }
  };
  for (const c of planChunks(p, caps)) go(c);
  return {
    text: outs.join('\n'),
    err: refused.length > 0,
    chunks,
    retries,
    refused,
    reasons,
    flagged,
  };
}
