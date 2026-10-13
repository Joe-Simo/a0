/**
 * Dense input through the dense reader written in A0 (compiler/dense.a0, entry `canonfn`), for
 * `a0 ... --dense=a0`. The reference reader (src/dense.ts) stays the oracle; this path runs the A0
 * reader on the interpreter and gives its canonical text to the normal pipeline.
 *
 * The reader takes one input of at most 16384 bytes and writes at most 16384, so the host cuts the
 * dense text at function boundaries (a segment between blank lines that starts with `fn`) into chunks,
 * as tools/dense-chunk.ts does for the comparison: each chunk is the stub lines of the functions it
 * calls that used files or earlier chunks define (`use fn NAME TYPES -> RESULT`), then its functions.
 * The canonical text is the chunk outputs joined with one newline. A chunk the reader flags is cut in
 * two and read again; a single function it flags is refused with diagnostic A0625, which names the
 * global byte offset of that function in the file.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatType,
  parse,
  parseAndValidate,
  run,
  type Type,
  type TypedFunc,
  type Value,
} from './core.js';
import { diag } from './diagnostics.js';

/** A function's signature, as its canonical header writes it. */
export interface Signature {
  readonly params: readonly Type[];
  readonly result: Type;
}

const PAGES = 128;
const PAGE = 128;
/** Dense bytes per chunk: half the input capacity, as the canonical text is longer than the dense one. */
const CHUNK_BYTES = 8192;

let reader: TypedFunc | undefined;

/** The reader's entry, compiled once per process from compiler/dense.a0 (src/ or dist/src/). */
function canonfn(): TypedFunc {
  if (reader !== undefined) return reader;
  const here = dirname(fileURLToPath(import.meta.url));
  let source: string | undefined;
  for (const dir of [join(here, '..', 'compiler'), join(here, '..', '..', 'compiler')]) {
    try {
      source = readFileSync(join(dir, 'dense.a0'), 'utf8');
      break;
    } catch {}
  }
  if (source === undefined) throw diag('A0809');
  const fn = parseAndValidate(source).functions.find((f) => f.name === 'canonfn');
  if (fn === undefined) throw diag('A0809');
  reader = fn;
  return fn;
}

/** One input through the reader: the canonical text and the error flag. */
export function readOnce(text: string): { text: string; err: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > PAGES * PAGE) return { text: '', err: true };
  const pages: Value[] = [];
  for (let p = 0; p < PAGES; p += 1) {
    const page: Value[] = [];
    for (let k = 0; k < PAGE; k += 1) page.push(bytes[p * PAGE + k] ?? 0);
    pages.push(page);
  }
  const [[out, pos], err] = run(canonfn(), [pages, bytes.length], { fuel: 4_000_000_000 }) as [
    [Value[], number],
    boolean,
  ];
  const outBytes: number[] = [];
  for (let i = 0; i < Math.min(pos, PAGES * PAGE); i += 1)
    outBytes.push((out[i >> 7] as Value[])[i & 127] as number);
  return { text: Buffer.from(outBytes).toString('utf8'), err };
}

/** The stub line of a function: its canonical header after `use `. */
export function stubLine(name: string, sig: Signature): string {
  const types = sig.params.length > 0 ? ` ${sig.params.map(formatType).join(' ')}` : '';
  return `use fn ${name}${types} -> ${formatType(sig.result)}`;
}

interface Block {
  readonly name: string;
  readonly text: string;
  /** Byte offset of the block in the file. */
  readonly offset: number;
}

const USE_LINE = /^\s*use\s+"[^"]*"\s*(#.*)?$/;

/** The functions of a dense file: segments between blank lines; a segment not starting with `fn` joins the one before. */
function blocksOf(source: string): Block[] {
  const blocks: { name: string; lines: string[]; offset: number }[] = [];
  let offset = 0;
  let fresh = true;
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const at = offset;
    offset += Buffer.byteLength(raw, 'utf8') + 1;
    if (line.trim() === '') {
      fresh = true;
      continue;
    }
    const head = /^fn\s+(\S+)/.exec(line);
    if (head !== null && fresh) {
      blocks.push({ name: head[1] as string, lines: [line], offset: at });
    } else if (blocks.length === 0) {
      // the header of the file: use lines are resolved by the linker, anything else is given to the reader
      if (!USE_LINE.test(line) && !/^\s*#/.test(line))
        blocks.push({ name: '', lines: [line], offset: at });
    } else (blocks[blocks.length - 1] as { lines: string[] }).lines.push(line);
    fresh = false;
  }
  return blocks.map((b) => ({ name: b.name, text: b.lines.join('\n'), offset: b.offset }));
}

/**
 * The canonical text of a dense file read by the A0 reader. `used` holds the signatures of every
 * function the file's uses reach. `path` names the file in the diagnostic of a refused function.
 */
export function readDenseA0(
  source: string,
  used: ReadonlyMap<string, Signature>,
  path: string,
): { text: string; chunks: number } {
  const blocks = blocksOf(source);
  const sigs = new Map(used);
  const outs: string[] = [];
  let chunks = 0;
  const textOf = (bs: readonly Block[]): string => {
    const defined = new Set(bs.map((b) => b.name));
    const need = new Set<string>();
    for (const b of bs)
      for (const w of b.text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
        if (!defined.has(w) && sigs.has(w)) need.add(w);
    const stubs = [...need].sort().map((n) => stubLine(n, sigs.get(n) as Signature));
    return `${stubs.map((s) => `${s}\n`).join('')}${bs.map((b) => b.text).join('\n\n')}\n`;
  };
  const go = (bs: readonly Block[]): void => {
    const got = readOnce(textOf(bs));
    if (!got.err) {
      chunks += 1;
      outs.push(got.text);
      for (const f of parse(got.text).functions)
        sigs.set(f.name, { params: f.params, result: f.result });
      return;
    }
    if (bs.length > 1) {
      const mid = bs.length >> 1;
      go(bs.slice(0, mid));
      go(bs.slice(mid));
      return;
    }
    const b = bs[0] as Block;
    throw diag('A0625', [path, b.name === '' ? '(header)' : b.name, b.offset]);
  };
  let cur: Block[] = [];
  let size = 0;
  for (const b of blocks) {
    const n = Buffer.byteLength(b.text, 'utf8') + 2;
    if (cur.length > 0 && size + n > CHUNK_BYTES) {
      go(cur);
      cur = [];
      size = 0;
    }
    cur.push(b);
    size += n;
  }
  if (cur.length > 0) go(cur);
  return { text: outs.join('\n'), chunks };
}
