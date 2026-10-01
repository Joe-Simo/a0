/**
 * Independent TypeScript references for the self-hosted front end: the token grammar of
 * compiler/lex.a0 (refLex) and the word IR of compiler/parse.a0 (refParse), both written
 * directly from the grammar and DESIGN.md 7a, with no use of src/core.ts. tools/app.ts runs
 * the A0 programs against them on every target; test/core.test.ts checks the IR against the
 * TypeScript parser.
 */

// --- Self-hosted lexer reference ---------------------------------------------------

/**
 * Source bytes the self-hosted front end reads (lexio, parseio, checkio clamp to it: the source
 * is held packed four bytes a word, compiler/lex.a0 `readsrc`).
 */
export const FRONT_END_SOURCE_LIMIT = 131072;

/**
 * The capacities of the self-hosted front end's tables (compiler/parse.a0 `fecap`): a source
 * over one of them is its limit diagnostic 4. The checker adds at most one type per node, so
 * the parser's types plus the nodes must fit the type table.
 */
export const FRONT_END_CAPACITY = {
  bytes: FRONT_END_SOURCE_LIMIT,
  tokens: 16384,
  tokenBytes: 32767,
  symbols: 8192,
  poolBytes: 51200,
  uses: 4096,
  functions: 820,
  nodes: 2730,
  operands: 32768,
  types: 8320,
  tlist: 8320,
} as const;

/** Whether a source is within every capacity of the self-hosted front end. */
export function frontEndFits(src: string): boolean {
  const c = FRONT_END_CAPACITY;
  if (Buffer.byteLength(src) > c.bytes) return false;
  const t = refLex(src);
  if (t.length / 3 > c.tokens) return false;
  for (let i = 2; i < t.length; i += 3) if ((t[i] as number) > c.tokenBytes) return false;
  const ir = refParse(src);
  return (
    ir.sym.length / 2 <= c.symbols &&
    ir.pool.length <= c.poolBytes &&
    ir.uses.length <= c.uses &&
    ir.fns.length / 7 <= c.functions &&
    ir.nodes.length / 6 <= c.nodes &&
    ir.args.length / 2 <= c.operands &&
    ir.types.length / 3 + ir.nodes.length / 6 <= c.types &&
    ir.tlist.length <= c.tlist
  );
}

/** The token grammar of compiler/lex.a0, written directly: (kind start length) triples. */
export function refLex(src: string): number[] {
  const out: number[] = [];
  const b = Buffer.from(src);
  let i = 0;
  const word = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
  while (i < b.length) {
    const c = b[i] as number;
    if (c === 32 || c === 9 || c === 13) i += 1;
    else if (c === 10) {
      out.push(5, i, 1);
      i += 1;
    } else if (c === 35) {
      while (i < b.length && b[i] !== 10) i += 1;
    } else if (word(c)) {
      const s = i;
      while (i < b.length && word(b[i] as number)) i += 1;
      out.push(c >= 48 && c <= 57 ? 2 : 1, s, i - s);
    } else if (c === 34) {
      const s = i + 1;
      i += 1;
      while (i < b.length && b[i] !== 34) i += b[i] === 92 ? 2 : 1;
      if (i < b.length) out.push(3, s, i - s);
      i += 1;
    } else if (c === 45 && b[i + 1] === 62) {
      out.push(4, i, 2);
      i += 2;
    } else {
      out.push(c === 45 ? 6 : c === 64 ? 7 : 9, i, 1);
      i += 1;
    }
  }
  return out;
}

// --- Self-hosted parser reference ------------------------------------------------

/** The word IR of DESIGN.md 7a as produced by compiler/parse.a0. */
export interface WordIr {
  readonly code: number;
  readonly tok: number;
  readonly pool: number[];
  readonly sym: number[];
  readonly types: number[];
  readonly tlist: number[];
  readonly fns: number[];
  readonly nodes: number[];
  readonly args: number[];
  readonly uses: number[];
}

export const IR_OPS = [
  'mov',
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'div',
  'rem',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'select',
  'call',
  'fold',
  'loop',
  'arr',
  'rec',
  'text',
  'get',
  'set',
  'at',
  'put',
  'read',
  'write',
  'puts',
] as const;

/** Accepted op spellings: udiv is div, urem is rem. */
const IR_ALIASES: Readonly<Record<string, string>> = { udiv: 'div', urem: 'rem' };

/** Op code of DESIGN.md 7a (1-based), aliases included; 0 when the word is not an op. */
export function irOp(name: string): number {
  return (IR_OPS as readonly string[]).indexOf(IR_ALIASES[name] ?? name) + 1;
}

/** Exact packing of a word of at most six [a-z0-9_] bytes: sum of code(c_j)*37^j, code 1..37. */
export function wordKey(bytes: readonly number[]): number {
  if (bytes.length > 6) return 0;
  let key = 0;
  let pow = 1;
  for (const c of bytes) {
    const code = c >= 97 ? c - 96 : c === 95 ? 37 : c - 48 + 27;
    key = (key + code * pow) % 2 ** 32;
    pow *= 37;
  }
  return key;
}

const SENTINEL = 0xffff_ffff;
const keyOf = (word: string): number => wordKey([...Buffer.from(word)]);
const KW = {
  fn: keyOf('fn'),
  ret: keyOf('ret'),
  end: keyOf('end'),
  use: keyOf('use'),
  true: keyOf('true'),
  false: keyOf('false'),
  patch: keyOf('patch'),
  u32: keyOf('u32'),
  bool: keyOf('bool'),
  io: keyOf('io'),
};
const RESERVED_KEYS = [KW.fn, KW.ret, KW.end, KW.true, KW.false, KW.patch];

/**
 * Token-driven parser producing the word IR, written directly from the grammar and
 * independent of src/core.ts: the same four passes as compiler/parse.a0 (intern, uses,
 * headers, bodies), each stopping at the first error. Errors are (code, token index):
 * 1 parse, 2 structure; the token index is the token count at end of input.
 */
export function refParse(src: string): WordIr {
  const b = [...Buffer.from(src)];
  const t = refLex(src);
  const ntok = t.length / 3;
  const kind = (i: number): number => (i >= 0 && i < ntok ? (t[i * 3] as number) : 5);
  const start = (i: number): number => t[i * 3 + 1] as number;
  const len = (i: number): number => t[i * 3 + 2] as number;
  const bytes = (i: number): number[] => b.slice(start(i), start(i) + len(i));
  const key = (i: number): number => (kind(i) === 1 ? wordKey(bytes(i)) : 0);
  const opOf = (i: number): number => {
    const w = bytes(i);
    return kind(i) === 1 && w.length <= 6 ? irOp(String.fromCharCode(...w)) : 0;
  };
  /** all-digit run b[s..s+n) -> value mod 2^32, or undefined when empty or not digits */
  const digits = (s: number, n: number): number | undefined => {
    if (n === 0) return undefined;
    let v = 0;
    for (let k = 0; k < n; k += 1) {
      const c = b[s + k] as number;
      if (c < 48 || c > 57) return undefined;
      v = (v * 10 + (c - 48)) % 2 ** 32;
    }
    return v;
  };
  const paramOf = (i: number): number | undefined =>
    kind(i) === 1 && b[start(i)] === 112 ? digits(start(i) + 1, len(i) - 1) : undefined;
  let err: [number, number] | undefined;
  const fail = (code: number, i: number): void => {
    if (err === undefined) err = [code, i];
  };

  // pass 1: intern identifiers and strings
  const pool = [...Buffer.from('retval')];
  const sym = [0, 6];
  const tsym: number[] = new Array(ntok).fill(0);
  const symOf = new Map<string, number>([['retval', 0]]);
  for (let i = 0; i < ntok; i += 1) {
    if (kind(i) !== 1 && kind(i) !== 3) continue;
    const w = bytes(i);
    const text = String.fromCharCode(...w);
    const found = symOf.get(text) ?? sym.length / 2;
    if (found === sym.length / 2) {
      symOf.set(text, found);
      sym.push(pool.length, w.length);
      pool.push(...w);
    }
    tsym[i] = found;
  }
  const symAt = (i: number): number => tsym[i] as number;

  // pass 2: use lines
  const uses: number[] = [];
  {
    let seenFn = false;
    let mode = 0;
    for (let i = 0; i < ntok && err === undefined; i += 1) {
      const k = kind(i);
      const atLine = kind(i - 1) === 5;
      if (mode === 1) {
        if (k === 3) {
          uses.push(symAt(i));
          mode = 2;
        } else fail(1, i);
      } else if (mode === 2) {
        if (k === 5) mode = 0;
        else fail(1, i);
      } else if (atLine && key(i) === KW.use) {
        if (seenFn) fail(1, i);
        mode = 1;
      } else if (atLine && key(i) === KW.fn) seenFn = true;
    }
    if (err === undefined && mode !== 0) fail(1, ntok);
  }

  // pass 3: headers and types
  const types = [1, 0, 0, 2, 0, 0, 3, 0, 0];
  const tlist: number[] = [];
  const fns: number[] = [];
  /** The first function named s among the first n, or n. */
  const fnOf = new Map<number, number>();
  const findFn = (s: number, n: number): number => {
    const j = fnOf.get(s);
    return j !== undefined && j < n ? j : n;
  };
  {
    const stk: number[] = [];
    let mode = 0; // 0 outside, 1 parameters, 2 result, 3 expecting the name
    let depth = 0;
    let name = 0;
    let res = 0;
    let haveRes = false;
    let first = 0;
    let nparams = 0;
    const arrayType = (n: number, elem: number): number => {
      for (let j = 0; j < types.length / 3; j += 1)
        if (types[j * 3] === 4 && types[j * 3 + 1] === n && types[j * 3 + 2] === elem) return j;
      types.push(4, n, elem);
      return types.length / 3 - 1;
    };
    /**
     * The digit groups AxB... after the first `skip` bytes of word i over the element type
     * `elem` (u32xAxB... is the array of B of (the array of A of u32)); undefined for a bad
     * length.
     */
    const arrayWord = (i: number, skip: number, elem: number): number | undefined => {
      let t = elem;
      let s = start(i) + skip;
      const end = start(i) + len(i);
      for (let k = s; k <= end; k += 1) {
        if (k < end && b[k] !== 120) continue;
        const n = digits(s, k - s);
        if (n === undefined || n === 0) return undefined;
        t = arrayType(n, t);
        s = k + 1;
      }
      return t;
    };
    const recordType = (fields: number[]): number => {
      for (let j = 0; j < types.length / 3; j += 1) {
        if (types[j * 3] !== 5 || types[j * 3 + 2] !== fields.length) continue;
        const a = types[j * 3 + 1] as number;
        if (fields.every((f, k) => tlist[a + k] === f)) return j;
      }
      types.push(5, tlist.length, fields.length);
      tlist.push(...fields);
      return types.length / 3 - 1;
    };
    /** A record type contains io: a field that is io or such a record (arrays cannot). */
    const containsIo = (ty: number): boolean =>
      ty === 2 ||
      (types[ty * 3] === 5 &&
        tlist
          .slice(
            types[ty * 3 + 1] as number,
            (types[ty * 3 + 1] as number) + (types[ty * 3 + 2] as number),
          )
          .some(containsIo));
    /** The last record type closed by ')': the byte after it and where it went. */
    let closed: { end: number; toResult: boolean } | undefined;
    const produce = (ty: number, i: number): boolean => {
      if (mode === 2 && depth === 0) {
        if (haveRes) fail(1, i);
        res = ty;
        haveRes = true;
        return true;
      }
      stk.push(ty);
      return false;
    };
    for (let i = 0; i < ntok && err === undefined; i += 1) {
      const k = kind(i);
      const byte = b[start(i)] as number;
      const after = closed;
      closed = undefined;
      if (mode === 0) {
        if (kind(i - 1) === 5 && key(i) === KW.fn) mode = 3;
      } else if (mode === 3) {
        const nfns = fns.length / 7;
        if (k !== 1 || RESERVED_KEYS.includes(key(i)) || findFn(symAt(i), nfns) < nfns) fail(1, i);
        else {
          name = symAt(i);
          mode = 1;
          stk.length = 0;
          stk.push(SENTINEL);
          depth = 0;
          haveRes = false;
        }
      } else if (k === 1) {
        const kk = key(i);
        const w = bytes(i);
        if (kk === KW.u32) produce(0, i);
        else if (kk === KW.bool) produce(1, i);
        else if (kk === KW.io) produce(2, i);
        else if (w[0] === 117 && w[1] === 51 && w[2] === 50 && w[3] === 120) {
          const t = arrayWord(i, 4, 0);
          if (t === undefined) fail(1, i);
          else produce(t, i);
        } else if (w.length >= 5 && String.fromCharCode(...w.slice(0, 5)) === 'boolx') {
          const t = arrayWord(i, 5, 1);
          if (t === undefined) fail(1, i);
          else produce(t, i);
        } else if (w[0] === 120 && w.length >= 2 && after?.end === start(i)) {
          // (T,...)xA...: the array suffix of the record type its ')' just produced
          const rec = after.toResult ? res : (stk[stk.length - 1] as number);
          const t = containsIo(rec) ? undefined : arrayWord(i, 1, rec);
          if (t === undefined) fail(1, i);
          else if (after.toResult) res = t;
          else stk[stk.length - 1] = t;
        } else fail(1, i);
      } else if (k === 9 && byte === 40) {
        stk.push(SENTINEL);
        depth += 1;
      } else if (k === 9 && byte === 44) {
        if (depth === 0) fail(1, i);
      } else if (k === 9 && byte === 41) {
        if (depth === 0) fail(1, i);
        else {
          const pos = stk.lastIndexOf(SENTINEL);
          const fields = stk.splice(pos + 1);
          stk.pop();
          depth -= 1;
          closed = { end: start(i) + 1, toResult: produce(recordType(fields), i) };
        }
      } else if (k === 4) {
        if (mode !== 1 || depth !== 0) fail(1, i);
        else {
          const params = stk.slice(1);
          first = tlist.length;
          nparams = params.length;
          tlist.push(...params);
          stk.length = 0;
          mode = 2;
        }
      } else if (k === 5) {
        if (mode === 2 && haveRes && depth === 0) {
          if (!fnOf.has(name)) fnOf.set(name, fns.length / 7);
          fns.push(name, nparams, first, res, 0, 0, 0);
          mode = 0;
        } else fail(1, i);
      } else fail(1, i);
    }
    if (err === undefined && mode !== 0) fail(1, ntok);
  }

  // pass 4: bodies
  const nodes: number[] = [];
  const args: number[] = [];
  {
    let mode = 0;
    let fi = 0; // functions seen so far
    let firstNode = 0;
    let inRet = false;
    let pendId = 0;
    const cur = (): number => nodes.length / 6 - 1;
    const nin = (): number => nodes.length / 6 - firstNode;
    /** The first node of the current function with each id. */
    let nodeOf = new Map<number, number>();
    const emit = (id: number, op: number): void => {
      if (!nodeOf.has(id)) nodeOf.set(id, nodes.length / 6 - firstNode);
      nodes.push(id, op, 0, args.length / 2, 0, 0);
      mode = op === 19 || op === 20 ? 41 : op === 21 ? 42 : 4;
    };
    /** `id F ARGS`: a call node of the function named by token i, defined before this one. */
    const directCall = (id: number, i: number): boolean => {
      const f = findFn(symAt(i), fi - 1);
      if (f >= fi - 1) {
        fail(2, i);
        return false;
      }
      emit(id, 19);
      nodes[cur() * 6 + 4] = f;
      mode = 4;
      return true;
    };
    const findNode = (s: number, n: number): number => {
      const j = nodeOf.get(s);
      return j !== undefined && j < n ? j : n;
    };
    const pushArg = (k: number, v: number): void => {
      args.push(k, v);
      nodes[cur() * 6 + 2] = (nodes[cur() * 6 + 2] as number) + 1;
    };
    const setRet = (k: number, v: number): void => {
      fns[(fi - 1) * 7 + 6] = k * 2 ** 28 + v;
    };
    /** operand of an identifier or number token: [kind, value], undefined for an unknown id, 'bad' for a number with a non-digit byte */
    const operand = (i: number, n: number): [number, number] | undefined | 'bad' => {
      const kk = key(i);
      const p = paramOf(i);
      if (kind(i) === 2) {
        const v = digits(start(i), len(i));
        return v === undefined ? 'bad' : [3, v];
      }
      if (kk === KW.true || kk === KW.false) return [4, kk === KW.true ? 1 : 0];
      if (p !== undefined) return [2, p];
      const j = findNode(symAt(i), n);
      return j < n ? [1, j] : undefined;
    };
    for (let i = 0; i < ntok && err === undefined; i += 1) {
      const k = kind(i);
      const kk = key(i);
      if (mode === 0) {
        if (k === 5) continue;
        if (kk === KW.fn) {
          firstNode = nodes.length / 6;
          nodeOf = new Map();
          fns[fi * 7 + 4] = firstNode;
          fi += 1;
          mode = 1;
        } else if (kk === KW.use) mode = 10;
        else fail(1, i);
      } else if (mode === 1 || mode === 10) {
        if (k === 5) mode = mode === 1 ? 2 : 0;
      } else if (mode === 2) {
        if (k === 5) continue;
        if (k !== 1) fail(1, i);
        else if (kk === KW.ret) {
          mode = 5;
          inRet = true;
        } else if (RESERVED_KEYS.includes(kk) || paramOf(i) !== undefined) fail(1, i);
        else if (findNode(symAt(i), nin()) < nin()) fail(2, i);
        else {
          pendId = symAt(i);
          inRet = false;
          mode = 3;
        }
      } else if (mode === 3) {
        const op = opOf(i);
        if (op !== 0) emit(pendId, op);
        else if (k === 1 && !RESERVED_KEYS.includes(kk)) directCall(pendId, i);
        else fail(1, i);
      } else if (mode === 41 || mode === 42) {
        if (k !== 1) fail(1, i);
        else {
          const f = findFn(symAt(i), fi - 1);
          if (f >= fi - 1) fail(2, i);
          else {
            nodes[cur() * 6 + (mode === 41 ? 4 : 5)] = f;
            mode = mode === 41 ? 4 : 41;
          }
        }
      } else if (mode === 4) {
        if (k === 5) mode = inRet ? 8 : 2;
        else if (k === 3) {
          if (nodes[cur() * 6 + 1] !== 24) fail(1, i);
          else {
            const w = bytes(i);
            for (let j = 0; j < w.length; j += 1) {
              const c = w[j] as number;
              if (c === 92) {
                j += 1;
                const e = w[j] as number;
                pushArg(3, e === 110 ? 10 : e === 116 ? 9 : e);
              } else pushArg(3, c);
            }
          }
        } else if (k === 1 || k === 2) {
          const o = operand(i, nin() - 1);
          if (o === 'bad') fail(1, i);
          else if (o === undefined) fail(2, i);
          else pushArg(o[0], o[1]);
        } else fail(1, i);
      } else if (mode === 5) {
        if (opOf(i) !== 0 && kind(i + 1) !== 5) {
          emit(0, opOf(i));
          setRet(1, cur() - firstNode);
        } else if (k === 1 && !RESERVED_KEYS.includes(kk) && kind(i + 1) !== 5) {
          if (directCall(0, i)) setRet(1, cur() - firstNode);
        } else if (k === 1 || k === 2) {
          const o = operand(i, nin());
          if (o === 'bad') fail(1, i);
          else if (o === undefined) fail(2, i);
          else {
            setRet(o[0], o[1]);
            mode = 7;
          }
        } else fail(1, i);
      } else if (mode === 7) {
        if (k === 5) mode = 8;
        else fail(1, i);
      } else if (mode === 8) {
        if (k === 5) continue;
        if (kk === KW.end) {
          fns[(fi - 1) * 7 + 5] = nin();
          mode = 9;
        } else fail(1, i);
      } else if (mode === 9) {
        if (k === 5) mode = 0;
        else fail(1, i);
      }
    }
    if (err === undefined && mode !== 0 && mode !== 9) fail(1, ntok);
  }

  const [code, tok] = err ?? [0, 0];
  return { code, tok, pool, sym, types, tlist, fns, nodes, args, uses };
}

/** The words written by `parseio`: code, token index, then each table preceded by its length. */
export function irWords(ir: WordIr): number[] {
  const tables = [ir.pool, ir.sym, ir.types, ir.tlist, ir.fns, ir.nodes, ir.args, ir.uses];
  if (ir.code !== 0) return [ir.code, ir.tok, ...tables.map(() => 0)];
  return [0, 0, ...tables.flatMap((t) => [t.length, ...t])];
}

/** Well-formed prefix of an A0 source: at most `limit` bytes, cut after the last `end` line. */
export function wellFormedPrefix(text: string, limit: number): string {
  const head = text.slice(0, limit);
  const m = /\nend\n(?![\s\S]*\nend\n)/.exec(head);
  return m === null ? '' : head.slice(0, m.index + 5);
}

// --- Self-hosted spelling suggestions reference --------------------------------------

/**
 * The names a suggestion can be drawn from, in candidate order: the ops, the accepted spellings
 * `udiv` and `urem`, then the type words. compiler/suggest.a0 holds the same table as a text literal.
 */
export const SUGGEST_NAMES: readonly string[] = [
  ...'mov add sub mul and or xor shl shr eq ne lt le gt ge select call fold loop arr rec get set at put read write div rem puts'.split(
    ' ',
  ),
  'udiv',
  'urem',
  'u32',
  'bool',
  'io',
];
const SUGGEST_OPS = SUGGEST_NAMES.length - 3;
const RESERVED_WORDS = ['fn', 'ret', 'end', 'patch', 'true', 'false'];

/** Edit distance in tenths: insertion and deletion 10, substitution 20, a case-only substitution 1. */
function tenths(a: string, b: string): number {
  const low = (s: string): string => s.toLowerCase();
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j * 10);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i * 10];
    for (let j = 1; j <= b.length; j += 1) {
      const same = a[i - 1] === b[j - 1];
      const sub =
        (prev[j - 1] as number) + (low(a[i - 1] as string) === low(b[j - 1] as string) ? 1 : 20);
      row.push(
        same
          ? (prev[j - 1] as number)
          : Math.min((prev[j] as number) + 10, (row[j - 1] as number) + 10, sub),
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/**
 * The rule of TypeScript's getSpellingSuggestion with distances in tenths: a candidate counts when
 * its length differs from the name's by at most max(2, 34% of it), it is not the name, it has three
 * bytes unless it differs from the name by case alone, and its distance is below 40% of the name's
 * length plus one; the closest wins, the first of equals.
 */
export function refSpelling(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = (Math.floor((name.length * 4) / 10) + 1) * 10;
  for (const c of candidates) {
    if (Math.abs(c.length - name.length) > Math.max(2, Math.floor((name.length * 34) / 100)))
      continue;
    if (c === name) continue;
    if (c.length < 3 && c.toLowerCase() !== name.toLowerCase()) continue;
    const d = tenths(name, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * The words written by compiler/suggest.a0 `suggestio` for the source and the index of a token the
 * parser rejected: rule (1 type, 101 node, 102 callee or op, 103 fold or loop body, 104 loop
 * predicate, 0 none), mode (1 suggestion, 2 defined later, 0 none), the length of the suggested name, the start and
 * length of the token, and 64 bytes of the suggested name. Written from the rule of TypeScript's getSpellingSuggestion and the line
 * grammar, with no use of src/.
 */
export function refSuggest(src: string, tok: number): number[] {
  const t = refLex(src);
  const ntok = t.length / 3;
  const b = [...Buffer.from(src)];
  const kind = (i: number): number => (i >= 0 && i < ntok ? (t[i * 3] as number) : 0);
  const word = (i: number): string =>
    i >= 0 && i < ntok
      ? String.fromCharCode(
          ...b.slice(t[i * 3 + 1] as number, (t[i * 3 + 1] as number) + (t[i * 3 + 2] as number)),
        )
      : '';
  const at = tok >= 0 && tok < ntok ? [t[tok * 3 + 1] as number, t[tok * 3 + 2] as number] : [0, 0];
  const none = [0, 0, 0, ...at, ...new Array<number>(64).fill(0)];
  // the line the token is on, and the header of its function: from the tokens before it
  let ls = 0;
  let fs = 0;
  for (let i = 0; i < tok; i += 1) {
    if (i === ls && kind(i) === 1 && word(i) === 'fn') fs = i;
    if (kind(i) === 5) ls = i + 1;
  }
  const first = (i: number): boolean => i === 0 || kind(i - 1) === 5;
  const name = word(tok);
  if (kind(tok) !== 1 || name.length === 0 || name.length > 64) return none;
  const pos = tok - ls;
  const w0 = word(ls);
  const w1 = word(ls + 1);
  const has3 = kind(ls + 2) !== 0 && kind(ls + 2) !== 5;
  let rule: number;
  if (w0 === 'fn' && pos >= 2) rule = 1;
  else if (w0 === 'end' || w0 === 'use') rule = 0;
  else if (w0 === 'ret') rule = pos === 1 ? (has3 ? 102 : 101) : 101;
  else if (pos === 1) rule = 102;
  else if (pos === 2) rule = w1 === 'call' ? 102 : w1 === 'fold' ? 103 : w1 === 'loop' ? 104 : 101;
  else if (pos === 3) rule = w1 === 'loop' ? 103 : 101;
  else rule = 101;
  if (RESERVED_WORDS.includes(name) || (rule === 101 && /^p[0-9]+$/.test(name))) rule = 0;
  // typed words are not "unexpected": a type word the parser already starts reading
  if (rule === 1 && SUGGEST_NAMES.slice(SUGGEST_OPS).some((w) => name.startsWith(w))) rule = 0;
  if (rule === 0) return none;
  // candidates, in order
  const candidates: string[] = [];
  const laterOnes: string[] = [];
  if (rule === 1) candidates.push(...SUGGEST_NAMES.slice(SUGGEST_OPS));
  if (rule === 102) candidates.push(...SUGGEST_NAMES.slice(0, SUGGEST_OPS));
  if (rule >= 102) {
    for (let i = 0; i < ntok; i += 1) {
      if (
        !first(i) ||
        kind(i) !== 1 ||
        word(i) !== 'fn' ||
        kind(i + 1) !== 1 ||
        word(i + 1).length > 64
      )
        continue;
      if (i < fs) candidates.push(word(i + 1));
      else if (i > fs) laterOnes.push(word(i + 1));
    }
  }
  if (rule === 101) {
    let stopped = false;
    for (let i = 0; i < ntok; i += 1) {
      if (!first(i) || kind(i) !== 1 || word(i).length > 64) continue;
      const w = word(i);
      const isNode = w !== 'fn' && w !== 'ret' && w !== 'end';
      if (isNode && i > fs && i < ls) candidates.push(w);
      if (isNode && i > ls && !stopped) laterOnes.push(w);
      if (i > ls && (w === 'ret' || w === 'end' || w === 'fn')) stopped = true;
    }
  }
  if (candidates.includes(name)) return none;
  const best = refSpelling(name, candidates) ?? '';
  const later = laterOnes.includes(name);
  const mode = rule === 1 ? (best === '' ? 0 : 1) : later ? 2 : best === '' ? 0 : 1;
  return [
    rule,
    mode,
    best.length,
    ...at,
    ...[...Buffer.from(best)],
    ...new Array<number>(64 - best.length).fill(0),
  ];
}
