/**
 * Independent TypeScript reference for the self-hosted checker (compiler/check.a0): the typing
 * and validation rules of DESIGN.md 4 applied to the word IR of tools/ref-parse.ts, written
 * directly from the rules with no use of src/core.ts. tools/app.ts runs `checkio` against
 * `refCheckWords` on every target; test/core.test.ts checks the A0 checker against `validate`.
 *
 * Diagnostics are (code, function index, node index): 3 type, 2 structure, 4 limit. The node
 * index is the node's position in its function, the node count for the ret operand, and
 * 0xffffffff for a header error (parameter limit, node limit, more than one io parameter).
 */

import { irOp, refParse, type WordIr } from './ref-parse.js';

export const NONE = 0xffff_ffff;
const MAX_PARAMS = 64;
const MAX_NODES = 4096;
const MAX_FUNCTIONS = 65536;
const MAX_ITERATIONS = 1 << 24;
const MAX_BITS = 1 << 21;

const OP = {
  mov: irOp('mov'),
  select: irOp('select'),
  call: irOp('call'),
  fold: irOp('fold'),
  loop: irOp('loop'),
  arr: irOp('arr'),
  rec: irOp('rec'),
  text: irOp('text'),
  get: irOp('get'),
  set: irOp('set'),
  at: irOp('at'),
  put: irOp('put'),
  read: irOp('read'),
  write: irOp('write'),
  puts: irOp('puts'),
};
const ARITH = ['add', 'sub', 'mul', 'shl', 'shr', 'div', 'rem'].map(irOp);
const LOGIC = ['and', 'or', 'xor'].map(irOp);
const EQUAL = ['eq', 'ne'].map(irOp);
const COMPARE = ['lt', 'le', 'gt', 'ge'].map(irOp);
const VARIADIC = [OP.call, OP.fold, OP.loop, OP.arr, OP.rec, OP.text];

/** Operand count of a fixed-arity operation; undefined for the variadic ones. */
function arity(op: number): number | undefined {
  if (VARIADIC.includes(op)) return undefined;
  if (op === OP.mov || op === OP.read) return 1;
  if (op === OP.select || op === OP.set || op === OP.put) return 3;
  return 2;
}

/** Programs rejected by one rule each of the checker (DESIGN.md 4), for the app rows and the test. */
export const ILL_TYPED: readonly [string, string][] = [
  ['operand-type', 'fn f bool -> u32\na add p0 1\nret a\nend\n'],
  ['mixed-bool-u32', 'fn f u32 bool -> bool\na and p1 p0\nret a\nend\n'],
  ['eq-mixed', 'fn f u32 bool -> bool\na eq p0 p1\nret a\nend\n'],
  ['arity', 'fn f u32 -> u32\na add p0\nret a\nend\n'],
  ['param-range', 'fn f u32 -> u32\na add p0 p3\nret a\nend\n'],
  [
    'fold-state',
    'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn top -> u32\na fold step 4 true\nret a\nend\n',
  ],
  [
    'fold-count',
    'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn top -> u32\na fold step true 0\nret a\nend\n',
  ],
  [
    'loop-predicate',
    'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn pred u32 u32 -> u32\nret p0\nend\nfn top -> u32\na loop pred step 4 0\nret a\nend\n',
  ],
  [
    'iterations',
    'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn mid u32 u32 -> u32\na fold step 65536 p0\nret a\nend\nfn top u32 -> u32\na fold mid 4096 p0\nret a\nend\n',
  ],
  [
    // a variable count between two literal ones does not hide their product
    'iterations-through-variable',
    'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn mid u32 u32 -> u32\na fold step 65536 p0\nret a\nend\nfn spin u32 u32 -> u32\na fold mid p0 p0\nret a\nend\nfn top u32 -> u32\na fold spin 4096 p0\nret a\nend\n',
  ],
  ['call-arity', 'fn g u32 -> u32\nret p0\nend\nfn f u32 -> u32\na call g p0 p0\nret a\nend\n'],
  ['io-twice', 'fn f io -> io\na write p0 1\nb write p0 2\nret b\nend\n'],
  ['io-consumed-ret', 'fn f io -> io\na write p0 1\nret p0\nend\n'],
  // `at` of the io field takes the token: the record may not be passed on, returned, have the
  // field taken again, or have another field put
  [
    'io-taken-call',
    'fn g (io,u32) -> (io,u32)\nret p0\nend\nfn f (io,u32) -> (io,u32)\nt at p0 0\nw write t 1\nr call g p0\nret r\nend\n',
  ],
  ['io-taken-ret', 'fn f (io,u32) -> (io,u32)\nt at p0 0\nw write t 1\nret p0\nend\n'],
  ['io-taken-twice', 'fn f (io,u32) -> io\nt at p0 0\nu at p0 0\nw write t 1\nret u\nend\n'],
  [
    'io-taken-put-other',
    'fn f (io,u32) -> (io,u32)\nt at p0 0\nw write t 1\nr put p0 1 5\nret r\nend\n',
  ],
  ['io-taken-node', 'fn f io -> (io,u32)\nr rec p0 3\nt at r 0\nw write t 1\nret r\nend\n'],
  ['io-two-params', 'fn f io io -> io\nret p0\nend\n'],
  ['io-in-array', 'fn f io -> io\na arr p0\nret p0\nend\n'],
  [
    'select-tokens',
    'fn f io bool -> io\nr read p0\nt at r 1\nu at r 1\ns select p1 t u\nret s\nend\n',
  ],
  ['rec-two-tokens', 'fn f io -> (io,io)\nr read p0\nt at r 1\nu at r 1\ns rec t u\nret s\nend\n'],
  ['ret-type', 'fn f u32 -> bool\nret p0\nend\n'],
  ['unknown-node', 'fn f u32 -> u32\na add b 1\nret a\nend\n'],
  ['array-index', 'fn f u32x4 bool -> u32\na get p0 p1\nret a\nend\n'],
  ['get-scalar', 'fn f u32 -> u32\na get p0 0\nret a\nend\n'],
  ['field-range', 'fn f (u32,bool) -> u32\na at p0 2\nret a\nend\n'],
  ['put-field-type', 'fn f (u32,bool) -> (u32,bool)\na put p0 1 3\nret a\nend\n'],
  ['puts-scalar', 'fn f io u32 -> io\na puts p0 p1\nret a\nend\n'],
  ['aggregate-limit', 'fn f u32x65536 -> u32\na arr p0 p0\nret 1\nend\n'],
];

export type IrTables = Pick<WordIr, 'types' | 'tlist' | 'fns' | 'nodes' | 'args'>;

export interface CheckResult {
  readonly code: number;
  readonly fn: number;
  readonly node: number;
  /** The type table after the bodies' types were interned (triples, see DESIGN.md 7a). */
  readonly types: number[];
  readonly tlist: number[];
  /** Type index per node, in node-table order. */
  readonly nodeTypes: number[];
  /**
   * Saturated literal iteration bound per function: the largest product of literal trip counts
   * along any nesting path, a variable count being a factor of 1 (2^24+1 means "over the limit").
   */
  readonly fstat: number[];
}

class Fail extends Error {
  constructor(
    readonly code: number,
    readonly node: number,
  ) {
    super(`check error ${code} at node ${node}`);
  }
}

const satMul = (a: number, b: number, cap: number): number => Math.min(a * b, cap + 1);
const satAdd = (a: number, b: number, cap: number): number => Math.min(a + b, cap + 1);

/**
 * Check functions [from, to) of the IR given the iteration bounds of the earlier ones. Array
 * types are (4 length elem) with any element type; records (5 first count) over tlist.
 */
export function refCheck(
  ir: IrTables,
  from = 0,
  fstatIn: readonly number[] = [],
  to = ir.fns.length / 7,
): CheckResult {
  const types = [...ir.types];
  const tlist = [...ir.tlist];
  const { fns, nodes, args } = ir;
  const nfns = to;
  const nodeTypes: number[] = new Array(nodes.length / 6).fill(0);
  const fstat = [...fstatIn];
  const tio: number[] = [];
  const tbits: number[] = [];
  const info = (t: number): void => {
    const [tag, a, b] = [types[t * 3], types[t * 3 + 1], types[t * 3 + 2]] as [
      number,
      number,
      number,
    ];
    if (tag === 1) [tio[t], tbits[t]] = [0, 32];
    else if (tag === 2) [tio[t], tbits[t]] = [0, 1];
    else if (tag === 3) [tio[t], tbits[t]] = [1, 0];
    else if (tag === 4)
      [tio[t], tbits[t]] = [tio[b] as number, satMul(a, tbits[b] as number, MAX_BITS)];
    else {
      let io = 0;
      let bits = 0;
      for (let k = 0; k < b; k += 1) {
        const f = tlist[a + k] as number;
        io |= tio[f] as number;
        bits = satAdd(bits, tbits[f] as number, MAX_BITS);
      }
      [tio[t], tbits[t]] = [io, bits];
    }
  };
  for (let t = 0; t < types.length / 3; t += 1) info(t);
  const internArr = (n: number, elem: number): number => {
    for (let t = 0; t < types.length / 3; t += 1)
      if (types[t * 3] === 4 && types[t * 3 + 1] === n && types[t * 3 + 2] === elem) return t;
    types.push(4, n, elem);
    info(types.length / 3 - 1);
    return types.length / 3 - 1;
  };
  const internRec = (fields: readonly number[]): number => {
    for (let t = 0; t < types.length / 3; t += 1) {
      if (types[t * 3] !== 5 || types[t * 3 + 2] !== fields.length) continue;
      const a = types[t * 3 + 1] as number;
      if (fields.every((f, k) => tlist[a + k] === f)) return t;
    }
    types.push(5, tlist.length, fields.length);
    tlist.push(...fields);
    info(types.length / 3 - 1);
    return types.length / 3 - 1;
  };

  if (nfns > MAX_FUNCTIONS)
    return { code: 4, fn: NONE, node: NONE, types, tlist, nodeTypes, fstat };
  for (let f = from; f < nfns; f += 1) {
    const [nparams, firstParam, result, firstNode, count, retWord] = fns.slice(
      f * 7 + 1,
      f * 7 + 7,
    ) as [number, number, number, number, number, number];
    const params = tlist.slice(firstParam, firstParam + nparams);
    const consumed = new Set<string>();
    /** Records whose io field was taken by `at`: the field. */
    const taken = new Map<string, number>();
    let lit = 1;
    const fail = (code: number, node: number): never => {
      throw new Fail(code, node);
    };
    /** Type of an operand (kind, value); a parameter out of range is a type error. */
    const operandType = (kind: number, value: number, node: number): number => {
      if (kind === 3) return 0;
      if (kind === 4) return 1;
      if (kind === 2) {
        const t = params[value];
        return t === undefined ? fail(3, node) : t;
      }
      return nodeTypes[firstNode + value] as number;
    };
    const expect = (actual: number, wanted: number, node: number): void => {
      if (actual !== wanted) fail(3, node);
    };
    try {
      if (nparams > MAX_PARAMS || count > MAX_NODES) fail(4, NONE);
      if (params.filter((t) => tio[t] === 1).length > 1) fail(2, NONE);
      for (let i = 0; i < count; i += 1) {
        const g = firstNode + i;
        const [op, nargs, firstArg, callee, pred] = nodes.slice(g * 6 + 1, g * 6 + 6) as [
          number,
          number,
          number,
          number,
          number,
        ];
        const arg = (k: number): [number, number] => [
          args[(firstArg + k) * 2] as number,
          args[(firstArg + k) * 2 + 1] as number,
        ];
        const fixed = arity(op);
        if (fixed !== undefined && nargs !== fixed) fail(2, i);
        if ((op === OP.arr || op === OP.rec || op === OP.text) && nargs === 0) fail(2, i);
        const at: number[] = [];
        for (let k = 0; k < nargs; k += 1) at.push(operandType(...arg(k), i));
        for (let k = 0; k < nargs; k += 1) {
          const t = at[k] as number;
          if (tio[t] !== 1) continue;
          const [kind, value] = arg(k);
          const key = kind === 2 ? `p${value}` : kind === 1 ? `n${value}` : '';
          const [fk, field] = nargs > 1 ? arg(1) : [0, 0];
          if (op === OP.at && k === 0) {
            const takesIo =
              types[t * 3] === 5 &&
              fk === 3 &&
              field < (types[t * 3 + 2] as number) &&
              tio[tlist[(types[t * 3 + 1] as number) + field] as number] === 1;
            if (!takesIo) continue;
            if (consumed.has(key) || taken.has(key)) fail(2, i);
            taken.set(key, field);
            continue;
          }
          if (consumed.has(key)) fail(2, i);
          const out = taken.get(key);
          if (out !== undefined && !(op === OP.put && k === 0 && fk === 3 && field === out))
            fail(2, i);
          consumed.add(key);
        }
        const [a, b, c] = at as [number, number, number];
        const tag = (t: number): number => types[t * 3] as number;
        let rt: number;
        if (op === OP.at || op === OP.put) {
          if (tag(a) !== 5) fail(2, i);
          const [kind, index] = arg(1);
          if (kind !== 3) fail(2, i);
          const [, first, n] = types.slice(a * 3, a * 3 + 3) as [number, number, number];
          if (index >= n) fail(2, i);
          const field = tlist[first + index] as number;
          if (op === OP.put) expect(c, field, i);
          rt = op === OP.at ? field : a;
        } else if (op === OP.call) {
          const [cn, cfirst, cres] = fns.slice(callee * 7 + 1, callee * 7 + 4) as [
            number,
            number,
            number,
          ];
          if (nargs !== cn) fail(2, i);
          for (let k = 0; k < cn; k += 1) expect(at[k] as number, tlist[cfirst + k] as number, i);
          const cs = fstat[callee] as number;
          lit = Math.max(lit, cs);
          rt = cres;
        } else if (op === OP.fold || op === OP.loop) {
          const [cn, cfirst, cres] = fns.slice(callee * 7 + 1, callee * 7 + 4) as [
            number,
            number,
            number,
          ];
          if (nargs < 2) fail(2, i);
          expect(a, 0, i);
          if (cn < 2) fail(2, i);
          const stateT = tlist[cfirst] as number;
          expect(tlist[cfirst + 1] as number, 0, i);
          expect(b, stateT, i);
          expect(cres, stateT, i);
          if (nargs - 2 !== cn - 2) fail(2, i);
          for (let k = 2; k < nargs; k += 1)
            expect(at[k] as number, tlist[cfirst + k] as number, i);
          if (op === OP.loop) {
            const [pn, pfirst, pres] = fns.slice(pred * 7 + 1, pred * 7 + 4) as [
              number,
              number,
              number,
            ];
            expect(pres, 1, i);
            if (pn !== cn) fail(2, i);
            for (let k = 0; k < cn; k += 1) if (tlist[pfirst + k] !== tlist[cfirst + k]) fail(2, i);
          }
          const [kind, trips] = arg(0);
          const cs = fstat[callee] as number;
          if (kind === 3) {
            const product = satMul(trips, cs, MAX_ITERATIONS);
            lit = Math.max(lit, product);
            if (lit > MAX_ITERATIONS) fail(2, i);
          } else lit = Math.max(lit, cs); // a variable count is bounded by fuel, not statically
          rt = stateT;
        } else if (op === OP.mov) rt = a;
        else if (ARITH.includes(op)) {
          expect(a, 0, i);
          expect(b, 0, i);
          rt = 0;
        } else if (LOGIC.includes(op) || EQUAL.includes(op)) {
          if (a === 1) expect(b, 1, i);
          else {
            expect(a, 0, i);
            expect(b, 0, i);
          }
          rt = a === 1 || EQUAL.includes(op) ? 1 : 0;
        } else if (COMPARE.includes(op)) {
          expect(a, 0, i);
          expect(b, 0, i);
          rt = 1;
        } else if (op === OP.select) {
          expect(a, 1, i);
          if (b !== c || tio[b] === 1) fail(3, i);
          rt = b;
        } else if (op === OP.arr || op === OP.text) {
          for (const t of at) expect(t, a, i);
          if (tio[a] === 1) fail(3, i);
          if (satMul(nargs, tbits[a] as number, MAX_BITS) > MAX_BITS) fail(4, i);
          rt = internArr(nargs, a);
        } else if (op === OP.rec) {
          const io = at.filter((t) => tio[t] === 1).length;
          if (io > 1) fail(3, i);
          const bits = at.reduce((n, t) => satAdd(n, tbits[t] as number, MAX_BITS), 0);
          if (io === 0 && bits > MAX_BITS) fail(4, i);
          rt = internRec(at);
        } else if (op === OP.read) {
          expect(a, 2, i);
          rt = internRec([0, 2]);
        } else if (op === OP.write) {
          expect(a, 2, i);
          expect(b, 0, i);
          rt = 2;
        } else if (op === OP.puts) {
          expect(a, 2, i);
          if (tag(b) !== 4 || types[b * 3 + 2] !== 0) fail(3, i);
          rt = 2;
        } else if (op === OP.get) {
          if (tag(a) !== 4) fail(3, i);
          expect(b, 0, i);
          rt = types[a * 3 + 2] as number;
        } else if (op === OP.set) {
          if (tag(a) !== 4) fail(3, i);
          expect(b, 0, i);
          expect(c, types[a * 3 + 2] as number, i);
          rt = a;
        } else rt = fail(2, i);
        nodeTypes[g] = rt;
      }
      // kind 5: the ret operand is the pair of args at that index (a u32 literal of 2^28 or more)
      const big = Math.floor(retWord / 2 ** 28) === 5;
      const at = (retWord % 2 ** 28) * 2;
      const rk = big ? (args[at] as number) : Math.floor(retWord / 2 ** 28);
      const rv = big ? (args[at + 1] as number) : retWord % 2 ** 28;
      const rt = operandType(rk, rv, count);
      expect(rt, result, count);
      const rkey = rk === 2 ? `p${rv}` : rk === 1 ? `n${rv}` : '';
      if (tio[rt] === 1 && (consumed.has(rkey) || taken.has(rkey))) fail(2, count);
      fstat[f] = lit;
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      return { code: e.code, fn: f, node: e.node, types, tlist, nodeTypes, fstat };
    }
  }
  return { code: 0, fn: 0, node: 0, types, tlist, nodeTypes, fstat };
}

/**
 * The words written by `checkio`: ok, code, fn, node (fn 0xffffffff and the token index for a
 * parse error), then types, tlist and the node types, each preceded by its word count (all
 * zero on an error).
 */
export function refCheckWords(src: string): number[] {
  const ir = refParse(src);
  if (ir.code !== 0) return [0, ir.code, NONE, ir.tok, 0, 0, 0];
  const r = refCheck(ir);
  if (r.code !== 0) return [0, r.code, r.fn, r.node, 0, 0, 0];
  return [
    1,
    0,
    0,
    0,
    r.types.length,
    ...r.types,
    r.tlist.length,
    ...r.tlist,
    r.nodeTypes.length,
    ...r.nodeTypes,
  ];
}
