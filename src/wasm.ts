/**
 * Direct WebAssembly backend: A0 to a wasm32 binary module, with no C, Clang, or wasm-ld in
 * between. The module has exactly the shape the C-derived build has where a host can see it,
 * so site/app.ts and tools/verify.ts drive both the same way: every function is exported as
 * `a0_<name>`, the linear memory as `memory`, and the immutable i32 global `__heap_base` marks
 * the first byte the module never touches on its own; an io token is the address of a struct
 * `{ u32 input[IN]; u32 ninput; u32 position; u32 output[OUT]; u32 noutput; }` that the host
 * places there (IN/OUT are the `ioInputCapacity`/`ioOutputCapacity` options, defaults
 * C_IO_INPUT_CAPACITY/C_IO_OUTPUT_CAPACITY).
 *
 * Scope: every scalar op with A0's exact meaning (wrapping u32 arithmetic, masked shifts,
 * logical right shift, total unsigned div/rem, unsigned comparison, 0/1 booleans), arrays and
 * records with value semantics, `call`, `fold`, and `loop` with literal or variable trip counts,
 * and io (`read`, `write`, `puts`).
 *
 * Representation: every value is a sequence of 32-bit words. Scalars and io tokens are i32
 * locals (a bool is 0 or 1, a token is the struct address). Aggregates live in linear memory on
 * a shadow stack (`__stack_pointer`, growing down), elements and fields back to back; a node
 * that holds an aggregate has an i32 local with its address. Functions with aggregates reserve
 * a frame of static size on entry; the module's stack region is exactly the longest frame chain
 * of the (acyclic) call graph, so no frame can overflow it.
 *
 * Calling convention (internal; hosts call only scalar/io signatures, where it coincides with
 * what Clang emits for the C module): each parameter is one i32, a scalar by value or an
 * aggregate as the address of caller-owned storage the callee never writes. A scalar result is
 * the i32 result; an aggregate result is written through an extra first parameter (the result
 * address), which never aliases an argument. Iteration bodies of the shape (state, index, ...)
 * -> state also get an owned variant `a0o_<name>` that updates the loop state through the p0
 * pointer, so a fold over an array touches one element per trip instead of copying the state.
 *
 * In-place updates follow the other backends' `mutableHere` analysis: a `set`/`put` on a value
 * that is provably unshared (a fresh allocation or the owned state, read only by scalar `get`/`at`
 * before this node, never returned) stores one element and the node aliases the container; a
 * fold or loop whose initial value is unshared runs in that value's storage. An aggregate
 * `get`/`at` result aliases into its container (no copy), which is why such reads count as
 * sharing for the analysis; `mov` aliases; `select` chooses an address at run time.
 *
 * Code shape: fold/loop bodies and predicates of up to INLINE_BODY_NODES nodes, and scalar
 * calls of functions of up to INLINE_CALL_NODES nodes, are emitted in place when they need no
 * frame and no io (literal arguments become constants); counted loops are rotated (one entry
 * guard, a `br_if` back edge); element addresses scale by a shift. Each body then goes through
 * `Code.finish`: adjacent set/get pairs stay on the operand stack or become `local.tee`, dead
 * stores are dropped, and locals with disjoint live ranges share an index.
 *
 * Per-function emission (`emitWasmFunction`) is a JSON record of the function's variants with
 * their code as byte runs plus symbolic call and constant-pool references; `assembleWasm`
 * resolves them into function indices and data addresses, so the per-function cache holds
 * exactly one function's work. Literal arrays of four or more scalars are copied from a
 * deduplicated constant pool (all-zero ones are filled).
 */

import {
  A0Error,
  containsIo,
  evalOp,
  formatType,
  isPrimitive,
  type Node,
  type Op,
  type Operand,
  type Type,
  type TypedFunc,
  type TypedProgram,
} from './core.js';
import { type FillRun, fillRun, lazyArms, overwritesState } from './optimize.js';

const PAGE = 65536;
/** Address of the constant pool (the first page's low KiB stays unused, as in wasm-ld's layout). */
const POOL_BASE = 1024;
const STACK_ALIGN = 16;
const POOL_MIN_ELEMENTS = 4;

/** Size of a value in 32-bit words. */
function words(t: Type): number {
  if (isPrimitive(t)) return 1;
  if (t.kind === 'arr') return t.length * words(t.elem);
  return t.fields.reduce((n, f) => n + words(f), 0);
}

const bytesOf = (t: Type): number => words(t) * 4;
const align = (n: number, a: number): number => Math.ceil(n / a) * a;

// ---------------------------------------------------------------------------
// Binary encoding
// ---------------------------------------------------------------------------

function uleb(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    const b = v & 0x7f;
    v >>>= 7;
    out.push(v !== 0 ? b | 0x80 : b);
  } while (v !== 0);
  return out;
}

/** Signed LEB128 of an int32 (a u32 literal is encoded through its bit pattern). */
function sleb(n: number): number[] {
  const out: number[] = [];
  let v = n | 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const OP = {
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  call: 0x10,
  select: 0x1b,
  localGet: 0x20,
  localSet: 0x21,
  localTee: 0x22,
  globalGet: 0x23,
  globalSet: 0x24,
  load: 0x28,
  store: 0x36,
  const: 0x41,
  eqz: 0x45,
  eq: 0x46,
  ne: 0x47,
  lt_u: 0x49,
  gt_u: 0x4b,
  le_u: 0x4d,
  ge_u: 0x4f,
  add: 0x6a,
  sub: 0x6b,
  mul: 0x6c,
  div_u: 0x6e,
  rem_u: 0x70,
  and: 0x71,
  or: 0x72,
  xor: 0x73,
  shl: 0x74,
  shr_u: 0x76,
} as const;
const VOID = 0x40;
const I32 = 0x7f;
const V128 = 0x7b;
/** simd128 opcodes (after the 0xfd prefix). */
const SIMD = {
  load: 0x00,
  store: 0x0b,
  const: 0x0c,
  splat: 0x11,
  and: 0x4e,
  or: 0x50,
  xor: 0x51,
  shl: 0xab,
  shr_u: 0xad,
  add: 0xae,
  sub: 0xb1,
  mul: 0xb5,
} as const;
/**
 * v128 locals share the symbolic index space above this base until `Code.finish` places them
 * after the i32 locals.
 */
const VBASE = 1 << 20;
const MEMORY_COPY = [0xfc, 0x0a, 0x00, 0x00];
const MEMORY_FILL = [0xfc, 0x0b, 0x00];

/** A run of bytes, a call to a symbol, or the address of a constant-pool entry (an i32.const). */
type Part = string | { readonly call: string } | { readonly pool: number };

interface VariantRecord {
  readonly symbol: string;
  /** Exported name (the value variant only). */
  readonly exportAs?: string;
  readonly params: number;
  readonly result: boolean;
  readonly locals: number;
  /** v128 locals, declared after the i32 ones. */
  readonly vlocals?: number;
  readonly frame: number;
  readonly code: readonly Part[];
}

interface FnRecord {
  readonly name: string;
  /** Constant-pool entries (base64), referenced by index from the code. */
  readonly pool: readonly string[];
  readonly variants: readonly VariantRecord[];
}

const IO_READ = 'io:read';
const IO_WRITE = 'io:write';
const IO_PUTS = 'io:puts';

/** Symbol of the runtime helper or A0 function a call part names; helpers have no frame. */
const symbolFunction = (symbol: string): string | undefined =>
  symbol.startsWith('a0o_')
    ? symbol.slice(4)
    : symbol.startsWith('a0_')
      ? symbol.slice(3)
      : undefined;

/** One instruction (or run of plain bytes) of a body under construction. */
type Ins =
  | { readonly bytes: readonly number[] }
  | { readonly local: 'get' | 'set' | 'tee'; readonly index: number }
  | { readonly call: string }
  | { readonly pool: number }
  | { readonly loop: 'open' | 'close' };

const LOCAL_KIND: Readonly<Record<number, 'get' | 'set' | 'tee'>> = {
  [OP.localGet]: 'get',
  [OP.localSet]: 'set',
  [OP.localTee]: 'tee',
};
const LOCAL_OP = { get: OP.localGet, set: OP.localSet, tee: OP.localTee } as const;
const DROP = 0x1a;

/**
 * A function body as an instruction list. Local accesses stay symbolic until `finish`, which
 * keeps a value on the operand stack instead of a `local.set x; local.get x` pair when x has
 * no other access, turns a set followed by a get of the same local into a `local.tee`, drops
 * dead stores, and renumbers the non-parameter locals so ones with disjoint live ranges share
 * an index (a range that touches a loop covers the whole loop, for the back edge).
 */
class Code {
  readonly ins: Ins[] = [];

  op(...b: readonly number[]): void {
    const last = this.ins[this.ins.length - 1];
    if (last !== undefined && 'bytes' in last) (last.bytes as number[]).push(...b);
    else this.ins.push({ bytes: [...b] });
  }

  i32(v: number): void {
    this.op(OP.const, ...sleb(v));
  }

  local(op: number, index: number): void {
    const kind = LOCAL_KIND[op];
    if (kind === undefined) throw new A0Error('wasm: not a local access');
    this.ins.push({ local: kind, index });
  }

  /** i32.load / i32.store with a 4-aligned static offset. */
  mem(op: number, offset: number): void {
    this.op(op, 2, ...uleb(offset));
  }

  call(symbol: string): void {
    this.ins.push({ call: symbol });
  }

  poolAddress(index: number): void {
    this.ins.push({ pool: index });
  }

  loopOpen(): void {
    this.ins.push({ loop: 'open' });
  }

  loopClose(): void {
    this.ins.push({ loop: 'close' });
  }

  append(other: Code): void {
    this.ins.push(...other.ins);
  }

  simd(op: number): void {
    this.op(0xfd, ...uleb(op));
  }

  /**
   * Resolve locals into parts: adjacent pairs stackified, i32 locals above `params` packed by
   * live range, then the v128 locals (symbolic indices from VBASE) packed after them.
   */
  finish(params?: number): { parts: Part[]; locals: number; vlocals: number } {
    let ins = this.ins;
    let locals = 0;
    let vlocals = 0;
    if (params === undefined) {
      // Hand-numbered helper bodies: indices are final.
      for (const x of ins) if ('local' in x) locals = Math.max(locals, x.index + 1);
    } else {
      ins = stackify(ins, params);
      const i32 = allocateLocals(ins, params, (i) => i < VBASE);
      const v128 = allocateLocals(ins, params + i32.count, (i) => i >= VBASE);
      locals = i32.count;
      vlocals = v128.count;
      ins = ins.map((x) =>
        'local' in x
          ? { local: x.local, index: (x.index < VBASE ? i32 : v128).index.get(x.index) ?? x.index }
          : x,
      );
    }
    const parts: Part[] = [];
    let buf: number[] = [];
    const flush = (): void => {
      if (buf.length > 0) parts.push(Buffer.from(buf).toString('base64'));
      buf = [];
    };
    for (const x of ins) {
      if ('bytes' in x) buf.push(...x.bytes);
      else if ('local' in x) buf.push(LOCAL_OP[x.local], ...uleb(x.index));
      else if ('loop' in x) buf.push(...(x.loop === 'open' ? [OP.loop, VOID] : [OP.end]));
      else {
        flush();
        parts.push(x);
      }
    }
    flush();
    return { parts, locals, vlocals };
  }
}

function localCounts(ins: readonly Ins[]): {
  gets: Map<number, number>;
  sets: Map<number, number>;
} {
  const gets = new Map<number, number>();
  const sets = new Map<number, number>();
  for (const x of ins) {
    if (!('local' in x)) continue;
    const m = x.local === 'get' ? gets : sets;
    m.set(x.index, (m.get(x.index) ?? 0) + 1);
  }
  return { gets, sets };
}

/** Peephole over adjacent local accesses (see `Code`); parameters are left alone. */
function stackify(input: readonly Ins[], params: number): Ins[] {
  const { gets, sets } = localCounts(input);
  const out: Ins[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i] as Ins;
    if (!('local' in x) || x.index < params || x.local === 'get') {
      out.push(x);
      continue;
    }
    const next = input[i + 1];
    const reads = gets.get(x.index) ?? 0;
    const followed =
      next !== undefined && 'local' in next && next.local === 'get' && next.index === x.index;
    if (x.local === 'set' && followed) {
      i += 1;
      if (reads === 1 && sets.get(x.index) === 1) continue;
      out.push({ local: 'tee', index: x.index });
    } else if (reads === 0) {
      if (x.local === 'set') out.push({ bytes: [DROP] });
    } else {
      out.push(x);
    }
  }
  return out;
}

/** Linear-scan reuse of non-parameter local indices over live ranges widened across loops. */
function allocateLocals(
  ins: readonly Ins[],
  params: number,
  mine: (index: number) => boolean,
): { index: Map<number, number>; count: number } {
  const range = new Map<number, [number, number]>();
  const loops: [number, number][] = [];
  const open: number[] = [];
  for (const [p, x] of ins.entries()) {
    if ('loop' in x) {
      if (x.loop === 'open') open.push(p);
      else loops.push([open.pop() as number, p]);
    } else if ('local' in x && x.index >= params && mine(x.index)) {
      const r = range.get(x.index);
      if (r === undefined) range.set(x.index, [p, p]);
      else r[1] = p;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of range.values()) {
      for (const [a, b] of loops) {
        if (r[0] <= b && r[1] >= a && (r[0] > a || r[1] < b)) {
          r[0] = Math.min(r[0], a);
          r[1] = Math.max(r[1], b);
          changed = true;
        }
      }
    }
  }
  const order = [...range.entries()].sort((x, y) => x[1][0] - y[1][0]);
  const slotEnd: number[] = [];
  const index = new Map<number, number>();
  for (const [local, [start, end]] of order) {
    let slot = slotEnd.findIndex((e) => e < start);
    if (slot < 0) slot = slotEnd.length;
    slotEnd[slot] = end;
    index.set(local, params + slot);
  }
  return { index, count: slotEnd.length };
}

// ---------------------------------------------------------------------------
// Sharing analysis
// ---------------------------------------------------------------------------

const FRESH_OPS = new Set<Op>(['arr', 'rec', 'set', 'put']);

function sameOp(x: Operand, y: Operand): boolean {
  return (
    (x.kind === 'node' && y.kind === 'node' && x.id === y.id) ||
    (x.kind === 'param' && y.kind === 'param' && x.index === y.index)
  );
}

/**
 * May the aggregate operand `o` be updated in place by the node at `index`? The same analysis
 * as the JavaScript, C, and arm64 backends, with one refinement: since an aggregate-typed
 * `get`/`at` result aliases into its container here, only a scalar `get`/`at` counts as a
 * non-escaping read.
 */
function mutableHere(
  fn: TypedFunc,
  o: Operand,
  index: number,
  position: number,
  ownedParam: (paramIndex: number) => boolean,
): boolean {
  if (o.kind === 'node') {
    const def = fn.nodes.find((n) => n.id === o.id);
    if (def === undefined || !FRESH_OPS.has(def.op)) return false;
  } else if (!(o.kind === 'param' && ownedParam(o.index))) {
    return false;
  }
  if (sameOp(fn.ret, o)) return false;
  for (const [j, n] of fn.nodes.entries()) {
    for (const [k, arg] of n.args.entries()) {
      if (!sameOp(arg, o)) continue;
      // The updating node itself may name `o` only as its target: an iteration's extra
      // argument naming its own state would see the state change under it.
      if (j === index) {
        if (k !== position) return false;
        continue;
      }
      if (j > index) return false;
      const scalarRead =
        (n.op === 'get' || n.op === 'at') && k === 0 && isPrimitive(fn.types.get(n.id) ?? 'u32');
      if (!scalarRead) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Function emission
// ---------------------------------------------------------------------------

type Variant = 'value' | 'owned';

/** Where an inlined function's parameter comes from: a local of the host, or a literal. */
type ParamSource = { readonly local: number } | { readonly value: number };

interface InlineHost {
  readonly parent: FunctionEmitter;
  readonly params: readonly ParamSource[];
  /** Body nodes computed by the host as induction variables: node id -> host local. */
  readonly induction?: ReadonlyMap<string, number>;
  /** Scalar replacement of the p0 state: host locals holding its words (see `scalarState`). */
  readonly fields?: readonly number[];
  /**
   * The previous element carried in a local: `get` (reading p0 at p1 - 1) is that local, and
   * after the in-place `set` (p0 at p1) the stored value becomes it (see `carriedRead`).
   */
  readonly carry?: { readonly get: string; readonly set: string; readonly local: number };
  /** p1 is the host's trip index, below this literal bound (so p1 needs no masking below it). */
  readonly indexBound?: number;
}

/**
 * A fold body `set p0 p1 v` (its only update) that also reads the element before p1,
 * `get p0 (sub p1 1)`: trip i reads what trip i-1 stored, so a backend may carry that value
 * in a register instead of reloading it (trip 0 reads element (2^32 - 1) mod length).
 */
function carriedRead(body: TypedFunc): { get: string; set: string } | undefined {
  const ret = body.ret;
  if (ret.kind !== 'node') return undefined;
  const set = body.nodes.find((n) => n.id === ret.id);
  const isParam = (o: Operand | undefined, i: number): boolean =>
    o?.kind === 'param' && o.index === i;
  if (set?.op !== 'set' || !isParam(set.args[0], 0) || !isParam(set.args[1], 1)) return undefined;
  if (body.nodes.filter((n) => n.op === 'set' || n.op === 'put').length !== 1) return undefined;
  const defs = new Map(body.nodes.map((n) => [n.id, n]));
  for (const n of body.nodes) {
    const j = n.args[1];
    if (n.op !== 'get' || !isParam(n.args[0], 0) || j?.kind !== 'node') continue;
    const d = defs.get(j.id);
    const one = d?.args[1];
    if (d?.op === 'sub' && isParam(d.args[0], 1) && one?.kind === 'u32' && one.value === 1)
      return { get: n.id, set: set.id };
  }
  return undefined;
}

/** Fold state of at most this many one-word fields or elements is kept in locals. */
const STATE_WORDS = 8;

/**
 * Can a fold body's small aggregate state p0 live in locals for the whole loop? Its words must
 * all be scalars, and p0 may only be read with literal-index `at`/`get` and updated by a chain
 * of literal-index `put`/`set` (or rebuilt by a `rec`/`arr` of scalars) ending in the result.
 * Returns the ids of the chain nodes (they become field lists, never storage).
 */
function scalarState(body: TypedFunc): ReadonlySet<string> | undefined {
  const st = body.params[0];
  if (st === undefined || isPrimitive(st)) return undefined;
  const scalars = st.kind === 'arr' ? [st.elem] : st.fields;
  const n = st.kind === 'arr' ? st.length : st.fields.length;
  if (n > STATE_WORDS || !scalars.every((f) => f === 'u32' || f === 'bool')) return undefined;
  const chain = new Set<string>();
  const isP0 = (o: Operand | undefined): boolean => o?.kind === 'param' && o.index === 0;
  const inChain = (o: Operand | undefined): boolean => o?.kind === 'node' && chain.has(o.id);
  for (const node of body.nodes) {
    const [a, k] = node.args;
    const update = node.op === 'set' || node.op === 'put';
    const read = node.op === 'get' || node.op === 'at';
    if ((update || read) && (isP0(a) || inChain(a))) {
      if (k?.kind !== 'u32' || (read && !isP0(a))) return undefined;
      if (update) chain.add(node.id);
      if (node.args.slice(1).some((x) => isP0(x) || inChain(x))) return undefined;
      continue;
    }
    if (
      (node.op === 'rec' || node.op === 'arr') &&
      formatType(body.types.get(node.id) ?? 'u32') === formatType(st)
    ) {
      chain.add(node.id);
      continue;
    }
    if (node.args.some((x) => isP0(x) || inChain(x))) return undefined;
  }
  const ret = body.ret;
  if (!(isP0(ret) || inChain(ret))) return undefined;
  // A chain node may be the base of the next update or the result, nothing else.
  for (const node of body.nodes)
    for (const [i, x] of node.args.entries())
      if (inChain(x) && !((node.op === 'set' || node.op === 'put') && i === 0)) return undefined;
  const uses = new Map<string, number>();
  for (const node of body.nodes)
    for (const x of node.args) if (x.kind === 'node') uses.set(x.id, (uses.get(x.id) ?? 0) + 1);
  if (ret.kind === 'node') uses.set(ret.id, (uses.get(ret.id) ?? 0) + 1);
  for (const id of chain) if ((uses.get(id) ?? 0) > 1) return undefined;
  return chain;
}

/** Iteration bodies and predicates up to this many nodes are emitted inside the loop. */
const INLINE_BODY_NODES = 24;
/** Scalar calls of functions up to this many nodes are emitted at the call site. */
const INLINE_CALL_NODES = 8;
const INLINE_DEPTH = 3;
/** Inlined fold bodies up to this many nodes are unrolled when `WasmEmitOptions.unroll` > 1. */
const UNROLL_BODY_NODES = 12;

/** Per-function code generation choices (part of the emission cache key when not default). */
export interface WasmEmitOptions {
  /** simd128 i32x4 for fill runs. */
  readonly simd: boolean;
  /** Copies of a small inlined fold body per loop back edge (1: no unrolling). */
  readonly unroll: 1 | 2 | 4;
}

const DEFAULT_EMIT: WasmEmitOptions = { simd: true, unroll: 1 };

const isIterationShape = (fn: TypedFunc): boolean =>
  fn.params[0] !== undefined && !isPrimitive(fn.params[0]) && fn.params[1] === 'u32';

const hasOwnedVariant = (fn: TypedFunc): boolean =>
  isIterationShape(fn) && formatType(fn.result) === formatType(fn.params[0] as Type);

function operandType(fn: TypedFunc, o: Operand): Type {
  switch (o.kind) {
    case 'u32':
      return 'u32';
    case 'bool':
      return 'bool';
    case 'param':
      return fn.params[o.index] ?? 'u32';
    case 'node':
      return fn.types.get(o.id) ?? 'u32';
  }
}

function arrayType(fn: TypedFunc, o: Operand | undefined): { length: number; elem: Type } {
  if (o === undefined) throw new A0Error('wasm: missing array operand');
  const t = operandType(fn, o);
  if (isPrimitive(t) || t.kind !== 'arr') throw new A0Error('wasm: expected array operand');
  return t;
}

function recordType(fn: TypedFunc, o: Operand | undefined): readonly Type[] {
  if (o === undefined) throw new A0Error('wasm: missing record operand');
  const t = operandType(fn, o);
  if (isPrimitive(t) || t.kind !== 'rec') throw new A0Error('wasm: expected record operand');
  return t.fields;
}

const literalIndex = (o: Operand | undefined): number | undefined =>
  o?.kind === 'u32' ? o.value : undefined;

/** Bytes of a literal scalar array (u32 values, bools as 0/1) or undefined when not literal. */
function literalBytes(fn: TypedFunc, node: Node): Uint8Array | undefined {
  const t = fn.types.get(node.id);
  if (t === undefined || isPrimitive(t) || t.kind !== 'arr' || !isPrimitive(t.elem))
    return undefined;
  if (node.args.length < POOL_MIN_ELEMENTS) return undefined;
  const out = new Uint8Array(node.args.length * 4);
  const view = new DataView(out.buffer);
  for (const [i, a] of node.args.entries()) {
    if (a.kind === 'u32') view.setUint32(i * 4, a.value, true);
    else if (a.kind === 'bool') view.setUint32(i * 4, a.value ? 1 : 0, true);
    else return undefined;
  }
  return out;
}

class FunctionEmitter {
  readonly fn: TypedFunc;
  readonly variant: Variant;
  readonly code: Code;
  readonly host: InlineHost | undefined;
  readonly depth: number;
  readonly pool: string[];
  readonly poolIndex: Map<string, number>;
  /** Nodes that alias other storage, mapped to the root operand (a slot node or a parameter). */
  readonly aliases = new Map<string, Operand>();
  readonly locals = new Map<string, number>();
  readonly paramBase: number;
  readonly sret: number | undefined;
  #nextLocal: number;
  #fp: number | undefined;
  frame = 0;
  /** The node whose storage is the result address (value variant, aggregate result). */
  readonly retSlot: string | undefined;
  readonly options: WasmEmitOptions;
  /** Scalar nodes whose value is known at compile time (folded across an inlined boundary). */
  readonly consts = new Map<string, number>();
  /** Select arms evaluated on their own path (see optimize.ts `lazyArms`). */
  readonly lazy: ReturnType<typeof lazyArms>;
  readonly byId: ReadonlyMap<string, Node>;
  #nextVLocal = VBASE;
  /** Scalar-replaced state: the update-chain nodes and each one's words (see `scalarState`). */
  readonly #chain: ReadonlySet<string> | undefined;
  readonly #words = new Map<string, readonly ParamSource[]>();

  constructor(
    fn: TypedFunc,
    variant: Variant,
    pool: string[],
    poolIndex: Map<string, number>,
    host?: InlineHost,
    options: WasmEmitOptions = DEFAULT_EMIT,
  ) {
    this.fn = fn;
    this.options = options;
    this.lazy = lazyArms(fn);
    this.byId = new Map(fn.nodes.map((n) => [n.id, n]));
    this.#chain = host?.fields === undefined ? undefined : scalarState(fn);
    this.variant = variant;
    this.pool = pool;
    this.poolIndex = poolIndex;
    this.host = host;
    this.code = host === undefined ? new Code() : host.parent.code;
    this.depth = host === undefined ? 0 : host.parent.depth + 1;
    const aggregateResult = host === undefined && variant === 'value' && !isPrimitive(fn.result);
    this.sret = aggregateResult ? 0 : undefined;
    this.paramBase = aggregateResult ? 1 : 0;
    this.#nextLocal = this.paramBase + fn.params.length;
    this.#analyse();
    this.retSlot = this.#retSlot();
  }

  get paramCount(): number {
    return this.paramBase + this.fn.params.length;
  }

  get localCount(): number {
    return this.#nextLocal - this.paramCount;
  }

  #owned(i: number): boolean {
    return this.variant === 'owned' && i === 0;
  }

  /** The storage an operand denotes: an alias resolves to what it updated or copied. */
  root(o: Operand): Operand {
    return o.kind === 'node' ? (this.aliases.get(o.id) ?? o) : o;
  }

  #analyse(): void {
    const fn = this.fn;
    for (const [index, n] of fn.nodes.entries()) {
      const t = fn.types.get(n.id) ?? 'u32';
      if (isPrimitive(t)) continue;
      if (n.op === 'mov') this.aliases.set(n.id, this.root(n.args[0] as Operand));
      else if ((n.op === 'set' || n.op === 'put') && this.#mutable(n.args[0] as Operand, index, 0))
        this.aliases.set(n.id, this.root(n.args[0] as Operand));
      else if (
        (n.op === 'fold' || n.op === 'loop') &&
        this.#mutable(n.args[1] as Operand, index, 1)
      )
        this.aliases.set(n.id, this.root(n.args[1] as Operand));
    }
  }

  #mutable(o: Operand, index: number, position: number): boolean {
    return mutableHere(this.fn, o, index, position, (i) => this.#owned(i));
  }

  /** A node that owns a frame slot (not an alias, not a run-time address). */
  #ownsSlot(id: string): boolean {
    const n = this.fn.nodes.find((x) => x.id === id);
    if (n === undefined || this.aliases.has(id) || this.#chain?.has(id) === true) return false;
    return !(n.op === 'get' || n.op === 'at' || n.op === 'select' || n.op === 'mov');
  }

  #retSlot(): string | undefined {
    if (this.sret === undefined) return undefined;
    const root = this.root(this.fn.ret);
    return root.kind === 'node' && this.#ownsSlot(root.id) ? root.id : undefined;
  }

  newLocal(): number {
    return this.host === undefined ? this.#nextLocal++ : this.host.parent.newLocal();
  }

  /** A fresh v128 local (symbolic, from VBASE; see `Code.finish`). */
  newVLocal(): number {
    return this.host === undefined ? this.#nextVLocal++ : this.host.parent.newVLocal();
  }

  /** The local holding parameter `i` (an inlined body maps it to the host's local). */
  paramLocal(i: number): number {
    if (this.host === undefined) return this.paramBase + i;
    const src = this.host.params[i];
    if (src === undefined || !('local' in src))
      throw new A0Error('wasm: literal parameter has no local');
    return src.local;
  }

  /** Does emitting this function need frame storage (so it cannot be inlined into a host)? */
  needsFrame(): boolean {
    return this.fn.nodes.some(
      (n) => !isPrimitive(this.fn.types.get(n.id) ?? 'u32') && this.#ownsSlot(n.id),
    );
  }

  fp(): number {
    if (this.#fp === undefined) this.#fp = this.newLocal();
    return this.#fp;
  }

  /** Bind a node's local: a fresh frame slot (or the result address) for slot-owning nodes. */
  bindSlot(id: string, t: Type): number {
    if (id === this.retSlot) {
      this.locals.set(id, this.sret as number);
      return this.sret as number;
    }
    const offset = this.frame;
    this.frame += align(bytesOf(t), 4);
    // The first slot is the frame pointer itself.
    if (offset === 0) {
      this.locals.set(id, this.fp());
      return this.fp();
    }
    const local = this.newLocal();
    this.locals.set(id, local);
    this.code.local(OP.localGet, this.fp());
    this.code.i32(offset);
    this.code.op(OP.add);
    this.code.local(OP.localSet, local);
    return local;
  }

  localOf(o: Operand): number {
    if (o.kind === 'param') return this.paramLocal(o.index);
    if (o.kind !== 'node') throw new A0Error('wasm: literal has no local');
    const root = this.root(o);
    if (root.kind === 'param') return this.paramLocal(root.index);
    if (root.kind !== 'node') throw new A0Error('wasm: literal has no local');
    const local = this.locals.get(root.id);
    if (local === undefined) throw new A0Error(`wasm: unbound node ${o.id}`);
    return local;
  }

  /** Push an operand: a scalar value, a token address, or an aggregate address. */
  push(o: Operand): void {
    const k = this.#constOf(o);
    if (k !== undefined) this.code.i32(k);
    else {
      const src = this.#paramSource(o);
      if (src !== undefined && 'value' in src) this.code.i32(src.value);
      else this.code.local(OP.localGet, this.localOf(o));
    }
  }

  #paramSource(o: Operand): ParamSource | undefined {
    if (this.host === undefined) return undefined;
    const root = this.root(o);
    return root.kind === 'param' ? this.host.params[root.index] : undefined;
  }

  /** The compile-time value of a scalar operand, when known (literal, literal source, folded). */
  #constOf(o: Operand): number | undefined {
    if (o.kind === 'u32') return o.value;
    if (o.kind === 'bool') return o.value ? 1 : 0;
    if (o.kind === 'node') {
      const k = this.consts.get(o.id);
      if (k !== undefined) return k;
    }
    const src = this.#paramSource(o);
    return src !== undefined && 'value' in src ? src.value : undefined;
  }

  /** An operand as the parameter source of a function inlined here. */
  #source(o: Operand): ParamSource {
    const k = this.#constOf(o);
    if (k !== undefined) return { value: k };
    return this.#paramSource(o) ?? { local: this.localOf(o) };
  }

  /**
   * Emit `callee` (variant `variant`) at this point with the given parameter sources when it is
   * small, io-free, and needs no frame; its scalar result (value variant) is left on the stack.
   * Returns false, having emitted nothing, when it must be called instead.
   */
  #tryInline(
    callee: TypedFunc,
    variant: Variant,
    params: readonly ParamSource[],
    limit: number,
    loop: Pick<InlineHost, 'induction' | 'fields' | 'carry' | 'indexBound'> = {},
  ): boolean {
    if (!this.#canInline(callee, variant, params, limit, loop.fields)) return false;
    const host: InlineHost = { parent: this, params, ...loop };
    new FunctionEmitter(
      callee,
      variant,
      this.pool,
      this.poolIndex,
      host,
      this.options,
    ).emitInline();
    return true;
  }

  /** Is `id` of `callee`, inlined as an owned body here, an in-place update? Emits nothing. */
  #inPlace(callee: TypedFunc, id: string, params: readonly ParamSource[]): boolean {
    const host: InlineHost = { parent: this, params };
    return new FunctionEmitter(
      callee,
      'owned',
      this.pool,
      this.poolIndex,
      host,
      this.options,
    ).aliases.has(id);
  }

  /** Would `#tryInline` emit `callee` in place (small, io-free, no frame)? Emits nothing. */
  #canInline(
    callee: TypedFunc,
    variant: Variant,
    params: readonly ParamSource[],
    limit: number,
    fields?: readonly number[],
  ): boolean {
    if (this.depth >= INLINE_DEPTH || callee.nodes.length > limit) return false;
    if (variant === 'value' && !isPrimitive(callee.result)) return false;
    if (callee.params.some(containsIo) || [...callee.types.values()].some(containsIo)) return false;
    const host: InlineHost = { parent: this, params, ...(fields === undefined ? {} : { fields }) };
    return !new FunctionEmitter(
      callee,
      variant,
      this.pool,
      this.poolIndex,
      host,
      this.options,
    ).needsFrame();
  }

  /** The body of an inlined function: its nodes, then its result (see `#tryInline`). */
  emitInline(): void {
    this.#emitNodes();
    const fields = this.host?.fields;
    if (this.#chain !== undefined && fields !== undefined) {
      // New state words: all read before any field local is written (a swap stays exact).
      const ret = this.fn.ret;
      const words = ret.kind === 'node' ? this.#words.get(ret.id) : undefined;
      if (words === undefined) return;
      const changed = words.flatMap((w, k) =>
        'local' in w && w.local === fields[k] ? [] : [{ w, k }],
      );
      for (const { w } of changed) {
        if ('local' in w) this.code.local(OP.localGet, w.local);
        else this.code.i32(w.value);
      }
      for (const { k } of changed.reverse()) this.code.local(OP.localSet, fields[k] as number);
      return;
    }
    const root = this.root(this.fn.ret);
    if (this.variant === 'owned') {
      if (!(root.kind === 'param' && root.index === 0)) {
        this.code.local(OP.localGet, this.paramLocal(0));
        this.push(this.fn.ret);
        this.copy(bytesOf(this.fn.result));
      }
    } else {
      this.push(this.fn.ret);
    }
  }

  /** Every node in order, except those a lazy select arm emits on its own path. */
  #emitNodes(): void {
    for (const n of this.fn.nodes) if (!this.lazy.owner.has(n.id)) this.emitNode(n);
  }

  /** Is the aggregate literal `id` only the initial state of a fold that overwrites it all? */
  #deadInit(id: string): boolean {
    const fn = this.fn;
    if (fn.ret.kind === 'node' && fn.ret.id === id) return false;
    const users = fn.nodes.filter((n) => n.args.some((a) => a.kind === 'node' && a.id === id));
    const user = users[0];
    if (users.length !== 1 || user === undefined) return false;
    const init = user.args[1];
    return (
      init?.kind === 'node' &&
      init.id === id &&
      user.args.filter((a) => a.kind === 'node' && a.id === id).length === 1 &&
      this.aliases.has(user.id) &&
      overwritesState(fn, user)
    );
  }

  /** dst src n memory.copy with the operands already pushed. */
  copy(n: number): void {
    this.code.i32(n);
    this.code.op(...MEMORY_COPY);
  }

  /**
   * Push the address of element `idx` of the array `arr` (base plus the dynamic part of the
   * index) and return the static byte offset to add (a literal index folds entirely).
   */
  elementAddress(arr: Operand, idx: Operand | undefined, elemBytes: number): number {
    const { length } = arrayType(this.fn, arr);
    this.push(arr);
    const lit = literalIndex(idx);
    if (lit !== undefined) return (lit % length) * elemBytes;
    if (idx === undefined) throw new A0Error('wasm: missing index');
    this.push(idx);
    const root = this.root(idx);
    const bound = this.host?.indexBound;
    const inRange =
      root.kind === 'param' && root.index === 1 && bound !== undefined && bound <= length;
    if (inRange) {
      // The trip index never reaches the length: no wrap.
    } else if ((length & (length - 1)) === 0) {
      this.code.i32(length - 1);
      this.code.op(OP.and);
    } else {
      this.code.i32(length);
      this.code.op(OP.rem_u);
    }
    if (elemBytes !== 1) {
      const log = Math.log2(elemBytes);
      this.code.i32(Number.isInteger(log) ? log : elemBytes);
      this.code.op(Number.isInteger(log) ? OP.shl : OP.mul);
    }
    this.code.op(OP.add);
    return 0;
  }

  /** Store the operand `v` of type `t` at the pushed address plus `offset`. */
  storeAt(t: Type, v: Operand, offset: number): void {
    if (isPrimitive(t)) {
      this.push(v);
      this.code.mem(OP.store, offset);
    } else {
      if (offset !== 0) {
        this.code.i32(offset);
        this.code.op(OP.add);
      }
      this.push(v);
      this.copy(bytesOf(t));
    }
  }

  emitNode(node: Node): void {
    const fn = this.fn;
    const t = fn.types.get(node.id) ?? 'u32';
    const c = this.code;
    const induced = this.host?.induction?.get(node.id);
    if (induced !== undefined) {
      this.locals.set(node.id, induced);
      return;
    }
    if (this.host?.carry?.get === node.id) {
      this.locals.set(node.id, this.host.carry.local);
      return;
    }
    const fields = this.host?.fields;
    if (this.#chain !== undefined && fields !== undefined) {
      const [base, k] = node.args;
      const width = fields.length;
      const onP0 = base?.kind === 'param' && base.index === 0;
      if ((node.op === 'at' || node.op === 'get') && onP0 && k?.kind === 'u32') {
        this.locals.set(node.id, fields[k.value % width] as number);
        return;
      }
      if (this.#chain.has(node.id)) {
        if (node.op === 'rec' || node.op === 'arr') {
          this.#words.set(
            node.id,
            node.args.map((a) => this.#source(a)),
          );
        } else {
          const from = onP0
            ? fields.map((local) => ({ local }))
            : (this.#words.get((base as { id: string }).id) ?? []);
          const at = (k as { value: number }).value % width;
          const value = this.#source(node.args[2] as Operand);
          this.#words.set(
            node.id,
            from.map((w, i) => (i === at ? value : w)),
          );
        }
        return;
      }
    }
    if (this.aliases.has(node.id)) {
      // In place: one element store (set/put), a loop in the initial value's storage, or nothing (mov).
      if (node.op === 'set' || node.op === 'put') {
        this.#storeElement(node, node.args[0] as Operand);
        const carry = this.host?.carry;
        if (carry?.set === node.id) {
          this.push(node.args[2] as Operand);
          c.local(OP.localSet, carry.local);
        }
      } else if (node.op === 'fold' || node.op === 'loop') this.#iteration(node);
      return;
    }
    if (node.op === 'fold' || node.op === 'loop') {
      this.#iteration(node);
      return;
    }
    const [a, b] = node.args;
    const set = (): void => c.local(OP.localSet, this.#bindScalar(node.id));
    switch (node.op) {
      case 'mov':
        this.push(a as Operand);
        set();
        return;
      case 'add':
      case 'sub':
      case 'mul':
      case 'and':
      case 'or':
      case 'xor':
      case 'shl':
      case 'shr':
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
      case 'gt':
      case 'ge': {
        const x = this.#constOf(a as Operand);
        const y = this.#constOf(b as Operand);
        if (x !== undefined && y !== undefined && operandType(fn, a as Operand) === 'u32') {
          const v = evalOp(node.op, [x, y]);
          this.consts.set(node.id, typeof v === 'boolean' ? (v ? 1 : 0) : (v as number));
          return;
        }
        this.push(a as Operand);
        this.push(b as Operand);
        c.op(BINARY[node.op] as number);
        set();
        return;
      }
      case 'div':
      case 'rem': {
        // The divisor is replaced by 1 when zero so div_u never traps; the total result is selected.
        const zero = this.newLocal();
        this.push(b as Operand);
        c.op(OP.eqz);
        c.local(OP.localSet, zero);
        if (node.op === 'div') c.i32(-1);
        else this.push(a as Operand);
        this.push(a as Operand);
        this.push(b as Operand);
        c.local(OP.localGet, zero);
        c.op(OP.or);
        c.op(node.op === 'div' ? OP.div_u : OP.rem_u);
        c.local(OP.localGet, zero);
        c.op(OP.select);
        set();
        return;
      }
      case 'select': {
        const k = this.#constOf(a as Operand);
        if (k !== undefined) {
          this.push((k !== 0 ? b : node.args[2]) as Operand);
          set();
          return;
        }
        const arms = this.lazy.arms.get(node.id);
        if (arms !== undefined) {
          // Each costly arm is computed on its own path only.
          this.push(a as Operand);
          c.op(OP.if, I32);
          for (const id of arms[0]) this.emitNode(this.byId.get(id) as Node);
          this.push(b as Operand);
          c.op(OP.else);
          for (const id of arms[1]) this.emitNode(this.byId.get(id) as Node);
          this.push(node.args[2] as Operand);
          c.op(OP.end);
          set();
          return;
        }
        this.push(b as Operand);
        this.push(node.args[2] as Operand);
        this.push(a as Operand);
        c.op(OP.select);
        set();
        return;
      }
      case 'call': {
        const callee = fn.calls.get(node.callee ?? '');
        if (callee === undefined) throw new A0Error(`wasm: unknown callee ${node.callee}`);
        if (isPrimitive(t)) {
          const params = node.args.map((arg) => this.#source(arg));
          if (!this.#tryInline(callee, 'value', params, INLINE_CALL_NODES)) {
            for (const arg of node.args) this.push(arg);
            c.call(`a0_${callee.name}`);
          }
          set();
        } else {
          const local = this.bindSlot(node.id, t);
          c.local(OP.localGet, local);
          for (const arg of node.args) this.push(arg);
          c.call(`a0_${callee.name}`);
        }
        return;
      }
      case 'arr': {
        const local = this.bindSlot(node.id, t);
        // Dead initial contents (a later fold writes every element first): storage only.
        if (this.#deadInit(node.id)) return;
        const elem = arrayType(fn, { kind: 'node', id: node.id }).elem;
        const literal = literalBytes(fn, node);
        if (literal !== undefined) {
          c.local(OP.localGet, local);
          if (literal.every((x) => x === 0)) {
            c.i32(0);
            c.i32(literal.length);
            c.op(...MEMORY_FILL);
          } else {
            c.poolAddress(this.#poolEntry(literal));
            this.copy(literal.length);
          }
          return;
        }
        const size = bytesOf(elem);
        for (const [i, arg] of node.args.entries()) {
          c.local(OP.localGet, local);
          this.storeAt(elem, arg, i * size);
        }
        return;
      }
      case 'rec': {
        const local = this.bindSlot(node.id, t);
        const fields = recordType(fn, { kind: 'node', id: node.id });
        let offset = 0;
        for (const [i, arg] of node.args.entries()) {
          const ft = fields[i] as Type;
          c.local(OP.localGet, local);
          this.storeAt(ft, arg, offset);
          offset += bytesOf(ft);
        }
        return;
      }
      case 'get': {
        const { elem } = arrayType(fn, a);
        const offset = this.elementAddress(a as Operand, b, bytesOf(elem));
        if (isPrimitive(elem)) {
          c.mem(OP.load, offset);
        } else if (offset !== 0) {
          c.i32(offset);
          c.op(OP.add);
        }
        set();
        return;
      }
      case 'at': {
        const fields = recordType(fn, a);
        const k = literalIndex(b) ?? 0;
        const offset = fields.slice(0, k).reduce((n, f) => n + bytesOf(f), 0);
        this.push(a as Operand);
        if (isPrimitive(fields[k] as Type)) {
          c.mem(OP.load, offset);
        } else if (offset !== 0) {
          c.i32(offset);
          c.op(OP.add);
        }
        set();
        return;
      }
      case 'set':
      case 'put': {
        // Copy the container into this node's storage, then update one element there.
        const local = this.bindSlot(node.id, t);
        c.local(OP.localGet, local);
        this.push(a as Operand);
        this.copy(bytesOf(t));
        this.#storeElement(node, { kind: 'node', id: node.id });
        return;
      }
      case 'read': {
        // (u32, io): the word read, then the token.
        const local = this.bindSlot(node.id, t);
        c.local(OP.localGet, local);
        this.push(a as Operand);
        c.call(IO_READ);
        c.mem(OP.store, 0);
        c.local(OP.localGet, local);
        this.push(a as Operand);
        c.mem(OP.store, 4);
        return;
      }
      case 'write':
        this.push(a as Operand);
        this.push(b as Operand);
        c.call(IO_WRITE);
        this.push(a as Operand);
        set();
        return;
      case 'puts': {
        const { length } = arrayType(fn, b);
        this.push(a as Operand);
        this.push(b as Operand);
        c.i32(length);
        c.call(IO_PUTS);
        this.push(a as Operand);
        set();
        return;
      }
    }
  }

  #bindScalar(id: string): number {
    const local = this.newLocal();
    this.locals.set(id, local);
    return local;
  }

  #poolEntry(data: Uint8Array): number {
    const key = Buffer.from(data).toString('base64');
    const known = this.poolIndex.get(key);
    if (known !== undefined) return known;
    const index = this.pool.length;
    this.pool.push(key);
    this.poolIndex.set(key, index);
    return index;
  }

  /** `set`/`put`: store element/field `args[1]` of the storage `target` to `args[2]`. */
  #storeElement(node: Node, target: Operand): void {
    const value = node.args[2] as Operand;
    if (node.op === 'set') {
      const { elem } = arrayType(this.fn, node.args[0]);
      const offset = this.elementAddress(target, node.args[1], bytesOf(elem));
      this.storeAt(elem, value, offset);
    } else {
      const fields = recordType(this.fn, node.args[0]);
      const k = literalIndex(node.args[1]) ?? 0;
      const offset = fields.slice(0, k).reduce((n, f) => n + bytesOf(f), 0);
      this.push(target);
      this.storeAt(fields[k] as Type, value, offset);
    }
  }

  /** fold/loop: a counted loop calling the body (owned variant for aggregate state). */
  #iteration(node: Node): void {
    const fn = this.fn;
    const c = this.code;
    const t = fn.types.get(node.id) ?? 'u32';
    const [count, init, ...extra] = node.args;
    if (count === undefined || init === undefined) throw new A0Error('wasm: malformed iteration');
    const body = fn.calls.get(node.callee ?? '');
    if (body === undefined) throw new A0Error(`wasm: unknown body ${node.callee}`);
    const pred = node.op === 'loop' ? fn.calls.get(node.pred ?? '') : undefined;
    if (node.op === 'loop' && pred === undefined)
      throw new A0Error(`wasm: unknown predicate ${node.pred}`);
    const aggregate = !isPrimitive(t);
    // The initial value is dead when every element is written before any trip reads it.
    const deadInit = overwritesState(fn, node);
    // State: a scalar local, the aliased storage, or a slot initialised by copying.
    let state: number;
    if (aggregate) {
      if (this.aliases.has(node.id)) {
        state = this.localOf({ kind: 'node', id: node.id });
      } else {
        state = this.bindSlot(node.id, t);
        if (!deadInit) {
          c.local(OP.localGet, state);
          this.push(init);
          this.copy(bytesOf(t));
        }
      }
    } else {
      state = this.#bindScalar(node.id);
      this.push(init);
      c.local(OP.localSet, state);
    }
    const i = this.newLocal();
    const variant: Variant = aggregate ? 'owned' : 'value';
    const lit = count.kind === 'u32' ? count.value : undefined;
    // Fill runs: four elements per trip with simd128, the rest by the scalar loop below.
    let start = 0;
    const run = this.options.simd && aggregate ? fillRun(fn, node) : undefined;
    if (run !== undefined && run.count >= 4) {
      start = run.count - (run.count % 4);
      this.#vectorFill(run, state, start, extra);
    }
    c.i32(start);
    c.local(OP.localSet, i);
    if (lit !== undefined && start >= lit) return;
    const sources = (): ParamSource[] => [
      { local: state },
      { local: i },
      ...extra.map((e) => this.#source(e)),
    ];
    // Scalar replacement: a small aggregate state lives in locals for the whole loop.
    const width =
      aggregate && !isPrimitive(t) ? (t.kind === 'arr' ? t.length : t.fields.length) : 0;
    const small = node.op === 'fold' && aggregate && scalarState(body) !== undefined;
    const probe = small ? Array.from({ length: width }, () => state) : undefined;
    const inlineBody = this.#canInline(body, variant, sources(), INLINE_BODY_NODES, probe);
    let fields: number[] | undefined;
    if (small && inlineBody) {
      fields = [];
      for (let k = 0; k < width; k += 1) {
        const local = this.newLocal();
        c.local(OP.localGet, state);
        c.mem(OP.load, k * 4);
        c.local(OP.localSet, local);
        fields.push(local);
      }
    }
    // Strength reduction: `p1 * K` in an inlined body is an induction variable stepping by K.
    const induction = new Map<string, { local: number; step: number }>();
    if (inlineBody) {
      for (const n of body.nodes) {
        if (n.op !== 'mul') continue;
        const [x, y] = n.args;
        const isIndex = (o: Operand | undefined): boolean => o?.kind === 'param' && o.index === 1;
        const k =
          isIndex(x) && y?.kind === 'u32' ? y : isIndex(y) && x?.kind === 'u32' ? x : undefined;
        if (k === undefined || k.kind !== 'u32') continue;
        const local = this.newLocal();
        c.i32(Math.imul(start, k.value));
        c.local(OP.localSet, local);
        induction.set(n.id, { local, step: k.value });
      }
    }
    const inductionLocals = new Map([...induction].map(([id, v]) => [id, v.local]));
    // The previous element in a local (in-place array state, inlined body).
    const carried = aggregate && inlineBody && fields === undefined ? carriedRead(body) : undefined;
    let carry: InlineHost['carry'];
    if (carried !== undefined && this.#inPlace(body, carried.set, sources())) {
      const local = this.newLocal();
      const { length } = t as { length: number };
      c.local(OP.localGet, state);
      c.mem(OP.load, (((start - 1) >>> 0) % length) * 4);
      c.local(OP.localSet, local);
      carry = { ...carried, local };
    }
    const loopHost: Pick<InlineHost, 'induction' | 'fields' | 'carry' | 'indexBound'> = {
      induction: inductionLocals,
      ...(fields === undefined ? {} : { fields }),
      ...(carry === undefined ? {} : { carry }),
      ...(lit === undefined ? {} : { indexBound: lit }),
    };
    const args = (): void => {
      c.local(OP.localGet, state);
      c.local(OP.localGet, i);
      for (const e of extra) this.push(e);
    };
    /** One trip: predicate exit (to the enclosing block, `depth` labels out), body, steps. */
    const trip = (depth: number): void => {
      if (pred !== undefined) {
        const bound = lit === undefined ? {} : { indexBound: lit };
        if (!this.#tryInline(pred, 'value', sources(), INLINE_BODY_NODES, bound)) {
          args();
          c.call(`a0_${pred.name}`);
        }
        c.op(OP.eqz);
        c.op(OP.br_if, depth);
      }
      if (!inlineBody || !this.#tryInline(body, variant, sources(), INLINE_BODY_NODES, loopHost)) {
        args();
        c.call(aggregate ? `a0o_${body.name}` : `a0_${body.name}`);
      }
      if (!aggregate) c.local(OP.localSet, state);
      for (const { local, step } of induction.values()) {
        c.local(OP.localGet, local);
        c.i32(step);
        c.op(OP.add);
        c.local(OP.localSet, local);
      }
      c.local(OP.localGet, i);
      c.i32(1);
      c.op(OP.add);
      c.local(OP.localSet, i);
    };
    /**
     * A rotated counted loop from the current i up to `limit` (pushed by `limit`, or the
     * literal `limitLit`), `copies` trips per back edge: the trip test sits at the bottom,
     * guarded once on entry unless the bound is a literal above the start.
     */
    const counted = (
      limit: () => void,
      limitLit: number | undefined,
      from: number,
      copies: number,
    ): void => {
      const guard = !(limitLit !== undefined && limitLit > from);
      const exit = guard || pred !== undefined;
      if (exit) c.op(OP.block, VOID);
      if (guard) {
        c.local(OP.localGet, i);
        limit();
        c.op(OP.ge_u);
        c.op(OP.br_if, 0);
      }
      c.loopOpen();
      for (let k = 0; k < copies; k += 1) trip(1);
      c.local(OP.localGet, i);
      limit();
      c.op(OP.lt_u);
      c.op(OP.br_if, 0);
      c.loopClose();
      if (exit) c.op(OP.end);
    };
    // Unrolling: a small inlined fold body runs UNROLL copies per back edge, then a remainder
    // loop finishes the last count mod UNROLL trips.
    const unroll =
      node.op === 'fold' && inlineBody && body.nodes.length <= UNROLL_BODY_NODES
        ? this.options.unroll
        : 1;
    const pushCount = (): void => this.push(count);
    if (unroll === 1 || (lit !== undefined && lit - start < unroll)) {
      counted(pushCount, lit, start, 1);
    } else if (lit !== undefined) {
      const main = start + (lit - start) - ((lit - start) % unroll);
      counted(() => c.i32(main), main, start, unroll);
      if (main < lit) counted(pushCount, lit, main, 1);
    } else {
      // Variable count (start is 0 here: fill runs have literal counts).
      const bound = this.newLocal();
      this.push(count);
      c.i32(-unroll);
      c.op(OP.and);
      c.local(OP.localSet, bound);
      counted(() => c.local(OP.localGet, bound), undefined, start, unroll);
      counted(pushCount, undefined, start, 1);
    }
    // The scalar-replaced state goes back to its storage once, after the loop.
    for (const [k, local] of (fields ?? []).entries()) {
      c.local(OP.localGet, state);
      c.local(OP.localGet, local);
      c.mem(OP.store, k * 4);
    }
  }

  /**
   * simd128 form of a fill run (see optimize.ts `fillRun`): elements [0, end) of the array at
   * `state`, four per trip, the index vector stepping by four.
   */
  #vectorFill(run: FillRun, state: number, end: number, extra: readonly Operand[]): void {
    const c = this.code;
    const vconst = (lanes: readonly number[]): void => {
      c.simd(SIMD.const);
      const b = new Uint8Array(16);
      const view = new DataView(b.buffer);
      for (const [k, v] of lanes.entries()) view.setUint32(k * 4, v >>> 0, true);
      c.op(...b);
    };
    const index = this.newVLocal();
    vconst([0, 1, 2, 3]);
    c.local(OP.localSet, index);
    // Loop-invariant extras as splats, once before the loop.
    const splats = new Map<number, number>();
    for (const n of run.nodes)
      for (const a of [...n.args, run.value])
        if (a.kind === 'param' && a.index >= 2 && !splats.has(a.index)) {
          const v = this.newVLocal();
          this.push(extra[a.index - 2] as Operand);
          c.simd(SIMD.splat);
          c.local(OP.localSet, v);
          splats.set(a.index, v);
        }
    const ptr = this.newLocal();
    c.local(OP.localGet, state);
    c.local(OP.localSet, ptr);
    const lanes = new Map<string, number>();
    const pushLanes = (o: Operand): void => {
      if (o.kind === 'u32') vconst([o.value, o.value, o.value, o.value]);
      else if (o.kind === 'param')
        c.local(OP.localGet, o.index === 1 ? index : (splats.get(o.index) as number));
      else if (o.kind === 'node') c.local(OP.localGet, lanes.get(o.id) as number);
    };
    /** A shift amount: the same in every lane, so a scalar. */
    const pushScalar = (o: Operand): void => {
      if (o.kind === 'u32') c.i32(o.value);
      else if (o.kind === 'param') this.push(extra[o.index - 2] as Operand);
    };
    const VOP: Readonly<Record<string, number>> = {
      add: SIMD.add,
      sub: SIMD.sub,
      mul: SIMD.mul,
      and: SIMD.and,
      or: SIMD.or,
      xor: SIMD.xor,
      shl: SIMD.shl,
      shr: SIMD.shr_u,
    };
    c.loopOpen();
    for (const n of run.nodes) {
      const [a, b] = n.args as [Operand, Operand];
      pushLanes(a);
      if (n.op === 'shl' || n.op === 'shr') pushScalar(b);
      else pushLanes(b);
      c.simd(VOP[n.op] as number);
      const v = this.newVLocal();
      c.local(OP.localSet, v);
      lanes.set(n.id, v);
    }
    c.local(OP.localGet, ptr);
    pushLanes(run.value);
    // v128.store with a 4-byte alignment hint (frames are 4-aligned) and offset 0.
    c.simd(SIMD.store);
    c.op(2, 0);
    c.local(OP.localGet, index);
    vconst([4, 4, 4, 4]);
    c.simd(SIMD.add);
    c.local(OP.localSet, index);
    c.local(OP.localGet, ptr);
    c.i32(16);
    c.op(OP.add);
    c.local(OP.localTee, ptr);
    c.local(OP.localGet, state);
    c.i32(end * 4);
    c.op(OP.add);
    c.op(OP.lt_u);
    c.op(OP.br_if, 0);
    c.loopClose();
  }

  /** Emit the whole variant and return its record. */
  emit(): VariantRecord {
    const fn = this.fn;
    this.#emitNodes();
    const c = this.code;
    const ret = fn.ret;
    const root = this.root(ret);
    if (this.variant === 'owned') {
      // The state is already updated in place when the result is p0's storage; otherwise store it.
      if (!(root.kind === 'param' && root.index === 0)) {
        c.local(OP.localGet, this.paramLocal(0));
        this.push(ret);
        this.copy(bytesOf(fn.result));
      }
    } else if (this.sret !== undefined) {
      if (this.retSlot === undefined) {
        c.local(OP.localGet, this.sret);
        this.push(ret);
        this.copy(bytesOf(fn.result));
      }
    } else {
      this.push(ret);
    }
    const frame = align(this.frame, STACK_ALIGN);
    const all = new Code();
    if (frame > 0) {
      const fp = this.fp();
      all.op(OP.globalGet, 0);
      all.i32(frame);
      all.op(OP.sub);
      all.local(OP.localTee, fp);
      all.op(OP.globalSet, 0);
    }
    all.append(c);
    if (frame > 0) {
      all.local(OP.localGet, this.fp());
      all.i32(frame);
      all.op(OP.add);
      all.op(OP.globalSet, 0);
    }
    const { parts, locals, vlocals } = all.finish(this.paramCount);
    const symbol = this.variant === 'owned' ? `a0o_${fn.name}` : `a0_${fn.name}`;
    return {
      symbol,
      ...(this.variant === 'value' ? { exportAs: symbol } : {}),
      params: this.paramCount,
      result: this.variant === 'value' && isPrimitive(fn.result),
      locals,
      ...(vlocals > 0 ? { vlocals } : {}),
      frame,
      code: parts,
    };
  }
}

const BINARY: Readonly<Record<string, number>> = {
  add: OP.add,
  sub: OP.sub,
  mul: OP.mul,
  and: OP.and,
  or: OP.or,
  xor: OP.xor,
  shl: OP.shl,
  shr: OP.shr_u,
  eq: OP.eq,
  ne: OP.ne,
  lt: OP.lt_u,
  le: OP.le_u,
  gt: OP.gt_u,
  ge: OP.ge_u,
};

/** One function's variants as a JSON record (the unit of the emission caches). */
export function emitWasmFunction(fn: TypedFunc, options: WasmEmitOptions = DEFAULT_EMIT): string {
  const pool: string[] = [];
  const poolIndex = new Map<string, number>();
  const emitter = (v: Variant): FunctionEmitter =>
    new FunctionEmitter(fn, v, pool, poolIndex, undefined, options);
  const variants = [emitter('value').emit()];
  if (hasOwnedVariant(fn)) variants.push(emitter('owned').emit());
  const record: FnRecord = { name: fn.name, pool, variants };
  return JSON.stringify(record);
}

// ---------------------------------------------------------------------------
// Runtime helpers (io) and module assembly
// ---------------------------------------------------------------------------

interface Fn {
  readonly symbol: string;
  readonly exportAs?: string;
  readonly params: number;
  readonly result: boolean;
  readonly locals: number;
  readonly vlocals?: number;
  readonly code: readonly Part[];
}

/** u32 a0_read(io t): input[position++] while position < min(ninput, IN), else 0. */
function ioRead(inCap: number): Fn {
  const c = new Code();
  const ninput = inCap * 4;
  const position = ninput + 4;
  c.local(OP.localGet, 0);
  c.mem(OP.load, position);
  c.local(OP.localGet, 0);
  c.mem(OP.load, ninput);
  c.op(OP.lt_u);
  // Also bound by the capacity: a host may set ninput above it.
  c.local(OP.localGet, 0);
  c.mem(OP.load, position);
  c.i32(inCap);
  c.op(OP.lt_u);
  c.op(OP.and);
  c.op(OP.if, I32);
  c.local(OP.localGet, 0);
  c.local(OP.localGet, 0);
  c.mem(OP.load, position);
  c.i32(4);
  c.op(OP.mul);
  c.op(OP.add);
  c.mem(OP.load, 0);
  c.local(OP.localGet, 0);
  c.local(OP.localGet, 0);
  c.mem(OP.load, position);
  c.i32(1);
  c.op(OP.add);
  c.mem(OP.store, position);
  c.op(OP.else);
  c.i32(0);
  c.op(OP.end);
  return { symbol: IO_READ, params: 1, result: true, locals: 0, code: c.finish().parts };
}

/** void a0_write(io t, u32 v): output[noutput++] = v while noutput < OUT. */
function ioWrite(inCap: number, outCap: number): Fn {
  const c = new Code();
  const output = (inCap + 2) * 4;
  const noutput = output + outCap * 4;
  c.local(OP.localGet, 0);
  c.mem(OP.load, noutput);
  c.i32(outCap);
  c.op(OP.lt_u);
  c.op(OP.if, VOID);
  c.local(OP.localGet, 0);
  c.local(OP.localGet, 0);
  c.mem(OP.load, noutput);
  c.i32(4);
  c.op(OP.mul);
  c.op(OP.add);
  c.local(OP.localGet, 1);
  c.mem(OP.store, output);
  c.local(OP.localGet, 0);
  c.local(OP.localGet, 0);
  c.mem(OP.load, noutput);
  c.i32(1);
  c.op(OP.add);
  c.mem(OP.store, noutput);
  c.op(OP.end);
  return { symbol: IO_WRITE, params: 2, result: false, locals: 0, code: c.finish().parts };
}

/** void a0_puts(io t, u32 *e, u32 n): write(n), then every element. */
function ioPuts(): Fn {
  const c = new Code();
  c.local(OP.localGet, 0);
  c.local(OP.localGet, 2);
  c.call(IO_WRITE);
  c.i32(0);
  c.local(OP.localSet, 3);
  c.op(OP.block, VOID);
  c.loopOpen();
  c.local(OP.localGet, 3);
  c.local(OP.localGet, 2);
  c.op(OP.ge_u);
  c.op(OP.br_if, 1);
  c.local(OP.localGet, 0);
  c.local(OP.localGet, 1);
  c.local(OP.localGet, 3);
  c.i32(4);
  c.op(OP.mul);
  c.op(OP.add);
  c.mem(OP.load, 0);
  c.call(IO_WRITE);
  c.local(OP.localGet, 3);
  c.i32(1);
  c.op(OP.add);
  c.local(OP.localSet, 3);
  c.op(OP.br, 0);
  c.loopClose();
  c.op(OP.end);
  return { symbol: IO_PUTS, params: 3, result: false, locals: 1, code: c.finish().parts };
}

function section(id: number, payload: readonly number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function vec(items: readonly (readonly number[])[]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function name(text: string): number[] {
  const b = Buffer.from(text, 'utf8');
  return [...uleb(b.length), ...b];
}

export interface WasmLayout {
  readonly ioInputCapacity: number;
  readonly ioOutputCapacity: number;
  /**
   * Functions the host calls (A0 names). When given, only these are exported and functions no
   * export reaches (for instance ones every call site inlined) are left out of the module;
   * absent, every function is exported (the shape site/app.ts and tools/verify.ts drive).
   */
  readonly exports?: readonly string[];
}

/**
 * Resolve every function record into one wasm32 binary: helpers, then each function's variants
 * in program order; the constant pool at POOL_BASE; the shadow stack sized to the longest frame
 * chain; `__heap_base` just above it.
 */
export function assembleWasm(
  bodies: readonly string[],
  program: TypedProgram,
  layout: WasmLayout,
  version: string,
): Uint8Array {
  const records = bodies.map((b) => JSON.parse(b) as FnRecord);
  const io = program.functions.some(
    (fn) =>
      containsIo(fn.result) ||
      fn.params.some(containsIo) ||
      [...fn.types.values()].some(containsIo),
  );

  // Constant pool: deduplicated across functions, 4-aligned.
  const poolAddress = new Map<string, number>();
  const poolBytes: number[] = [];
  for (const r of records) {
    for (const entry of r.pool) {
      if (poolAddress.has(entry)) continue;
      const data = Buffer.from(entry, 'base64');
      poolAddress.set(entry, POOL_BASE + poolBytes.length);
      poolBytes.push(...data);
      while (poolBytes.length % 4 !== 0) poolBytes.push(0);
    }
  }

  // Function index space.
  const fns: Fn[] = io
    ? [
        ioRead(layout.ioInputCapacity),
        ioWrite(layout.ioInputCapacity, layout.ioOutputCapacity),
        ioPuts(),
      ]
    : [];
  const frames = new Map<string, number>();
  const callees = new Map<string, Set<string>>();
  for (const r of records) {
    let frame = 0;
    const out = new Set<string>();
    for (const v of r.variants) {
      frame = Math.max(frame, v.frame);
      for (const p of v.code) {
        if (typeof p === 'object' && 'call' in p) {
          const target = symbolFunction(p.call);
          if (target !== undefined) out.add(target);
        }
      }
      fns.push({
        symbol: v.symbol,
        ...(v.exportAs === undefined ? {} : { exportAs: v.exportAs }),
        params: v.params,
        result: v.result,
        locals: v.locals,
        ...(v.vlocals === undefined ? {} : { vlocals: v.vlocals }),
        code: v.code.map((p) =>
          typeof p === 'object' && 'pool' in p
            ? Buffer.from([
                OP.const,
                ...sleb(poolAddress.get(r.pool[p.pool] as string) as number),
              ]).toString('base64')
            : p,
        ),
      });
    }
    frames.set(r.name, frame);
    callees.set(r.name, out);
  }
  if (layout.exports !== undefined) {
    // Keep what the exported functions reach through calls; export only those.
    const roots = new Set(layout.exports.map((n) => `a0_${n}`));
    const bySymbol = new Map(fns.map((f) => [f.symbol, f]));
    const reached = new Set<string>();
    const stack = [...roots];
    for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
      const f = bySymbol.get(s);
      if (f === undefined || reached.has(s)) continue;
      reached.add(s);
      for (const p of f.code) if (typeof p === 'object' && 'call' in p) stack.push(p.call);
    }
    for (const r of roots)
      if (!reached.has(r)) throw new A0Error(`wasm: exported function ${r.slice(3)} not found`);
    const kept = fns
      .filter((f) => reached.has(f.symbol))
      .map(({ exportAs: _exportAs, ...f }) =>
        roots.has(f.symbol) ? { ...f, exportAs: f.symbol } : f,
      );
    fns.splice(0, fns.length, ...kept);
  }
  const index = new Map(fns.map((f, i) => [f.symbol, i] as const));

  // Stack: the deepest frame chain through the acyclic call graph.
  const depth = new Map<string, number>();
  const depthOf = (fnName: string): number => {
    const known = depth.get(fnName);
    if (known !== undefined) return known;
    let deepest = 0;
    for (const callee of callees.get(fnName) ?? []) deepest = Math.max(deepest, depthOf(callee));
    const d = (frames.get(fnName) ?? 0) + deepest;
    depth.set(fnName, d);
    return d;
  };
  const stackSize = Math.max(
    STACK_ALIGN,
    align(
      records.reduce((n, r) => Math.max(n, depthOf(r.name)), 0),
      STACK_ALIGN,
    ),
  );
  const stackBase = align(POOL_BASE + poolBytes.length, STACK_ALIGN);
  const heapBase = stackBase + stackSize;
  const pages = Math.max(1, Math.ceil(heapBase / PAGE));

  // Types: every signature is i32^n -> (i32 | nothing).
  const types: number[][] = [];
  const typeIndex = new Map<string, number>();
  const typeOf = (f: Fn): number => {
    const key = `${f.params}:${f.result ? 1 : 0}`;
    const known = typeIndex.get(key);
    if (known !== undefined) return known;
    const i = types.length;
    types.push([
      0x60,
      ...uleb(f.params),
      ...Array.from({ length: f.params }, () => I32),
      ...(f.result ? [1, I32] : [0]),
    ]);
    typeIndex.set(key, i);
    return i;
  };
  const funcTypes = fns.map(typeOf);

  const bodiesOut = fns.map((f) => {
    const code: number[] = [];
    for (const p of f.code) {
      if (typeof p === 'string') code.push(...Buffer.from(p, 'base64'));
      else if ('call' in p) {
        const target = index.get(p.call);
        if (target === undefined) throw new A0Error(`wasm: unresolved call to ${p.call}`);
        code.push(OP.call, ...uleb(target));
      } else throw new A0Error('wasm: unresolved constant');
    }
    const groups: number[][] = [];
    if (f.locals > 0) groups.push([...uleb(f.locals), I32]);
    if ((f.vlocals ?? 0) > 0) groups.push([...uleb(f.vlocals ?? 0), V128]);
    const locals = [...uleb(groups.length), ...groups.flat()];
    const body = [...locals, ...code, OP.end];
    return [...uleb(body.length), ...body];
  });

  const exports: number[][] = [
    [...name('memory'), 0x02, 0],
    [...name('__heap_base'), 0x03, 1],
    ...fns.flatMap((f, i) =>
      f.exportAs === undefined ? [] : [[...name(f.exportAs), 0x00, ...uleb(i)]],
    ),
  ];

  const module: number[] = [
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(0, [...name('a0'), ...Buffer.from(version, 'utf8')]),
    ...section(1, vec(types)),
    ...section(3, vec(funcTypes.map((t) => uleb(t)))),
    ...section(5, vec([[0x00, ...uleb(pages)]])),
    // globals: 0 = __stack_pointer (mutable), 1 = __heap_base (immutable)
    ...section(
      6,
      vec([
        [I32, 0x01, OP.const, ...sleb(heapBase), OP.end],
        [I32, 0x00, OP.const, ...sleb(heapBase), OP.end],
      ]),
    ),
    ...section(7, vec(exports)),
    ...section(10, vec(bodiesOut)),
    ...(poolBytes.length > 0
      ? section(
          11,
          vec([
            [0x00, OP.const, ...sleb(POOL_BASE), OP.end, ...uleb(poolBytes.length), ...poolBytes],
          ]),
        )
      : []),
  ];
  return Uint8Array.from(module);
}

/** The bytes of a module `compile(program, 'wasm')` produced (its text is the base64 form). */
export function wasmModuleBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}
