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
 * that is provably unshared (a fresh allocation or the owned state, read only by `get`/`at`
 * before this node and no aggregate one of them read after it, never returned) stores one element and the node aliases the container; a
 * fold or loop whose initial value is unshared runs in that value's storage. An aggregate
 * `get`/`at` result aliases into its container (no copy), which is why such reads count as
 * sharing for the analysis; `mov` aliases; `select` chooses an address at run time.
 *
 * Per-function emission (`emitWasmFunction`) is a JSON record of the function's variants with
 * their code as byte runs plus symbolic call and constant-pool references; `assembleWasm`
 * resolves them into function indices and data addresses, so the per-function cache holds
 * exactly one function's work. Literal arrays of four or more scalars are copied from a
 * deduplicated constant pool (all-zero ones are filled).
 */

import {
  A0Error,
  borrowLive,
  containsIo,
  formatType,
  isPrimitive,
  type Node,
  type Op,
  type Operand,
  type Type,
  type TypedFunc,
  type TypedProgram,
} from './core.js';

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

class Code {
  readonly parts: Part[] = [];
  #buf: number[] = [];

  op(...b: readonly number[]): void {
    this.#buf.push(...b);
  }

  i32(v: number): void {
    this.op(OP.const, ...sleb(v));
  }

  local(op: number, index: number): void {
    this.op(op, ...uleb(index));
  }

  /** i32.load / i32.store with a 4-aligned static offset. */
  mem(op: number, offset: number): void {
    this.op(op, 2, ...uleb(offset));
  }

  #flush(): void {
    if (this.#buf.length > 0) {
      this.parts.push(Buffer.from(this.#buf).toString('base64'));
      this.#buf = [];
    }
  }

  call(symbol: string): void {
    this.#flush();
    this.parts.push({ call: symbol });
  }

  poolAddress(index: number): void {
    this.#flush();
    this.parts.push({ pool: index });
  }

  finish(): Part[] {
    this.#flush();
    return this.parts;
  }
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
 * as the C and native backends: an aggregate-typed `get`/`at` result aliases into its
 * container here (a borrowed read), so the container is updated in place only when no such
 * borrow is read after this node (`borrowLive`).
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
      if (!((n.op === 'get' || n.op === 'at') && k === 0)) return false;
    }
  }
  const writes = fn.nodes[index]?.op === 'set' || fn.nodes[index]?.op === 'put';
  return !borrowLive(fn, o, index, writes);
}

// ---------------------------------------------------------------------------
// Function emission
// ---------------------------------------------------------------------------

type Variant = 'value' | 'owned';

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
  readonly code = new Code();
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

  constructor(fn: TypedFunc, variant: Variant, pool: string[], poolIndex: Map<string, number>) {
    this.fn = fn;
    this.variant = variant;
    this.pool = pool;
    this.poolIndex = poolIndex;
    const aggregateResult = variant === 'value' && !isPrimitive(fn.result);
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
    if (n === undefined || this.aliases.has(id)) return false;
    return !(n.op === 'get' || n.op === 'at' || n.op === 'select' || n.op === 'mov');
  }

  #retSlot(): string | undefined {
    if (this.sret === undefined) return undefined;
    const root = this.root(this.fn.ret);
    return root.kind === 'node' && this.#ownsSlot(root.id) ? root.id : undefined;
  }

  newLocal(): number {
    return this.#nextLocal++;
  }

  fp(): number {
    if (this.#fp === undefined) this.#fp = this.newLocal();
    return this.#fp;
  }

  /** Bind a node's local: a fresh frame slot (or the result address) for slot-owning nodes. */
  bindSlot(id: string, t: Type): number {
    const local = this.newLocal();
    this.locals.set(id, local);
    if (id === this.retSlot) {
      this.code.local(OP.localGet, this.sret as number);
    } else {
      const offset = this.frame;
      this.frame += align(bytesOf(t), 4);
      this.code.local(OP.localGet, this.fp());
      if (offset !== 0) {
        this.code.i32(offset);
        this.code.op(OP.add);
      }
    }
    this.code.local(OP.localSet, local);
    return local;
  }

  localOf(o: Operand): number {
    if (o.kind === 'param') return this.paramBase + o.index;
    if (o.kind !== 'node') throw new A0Error('wasm: literal has no local');
    const root = this.root(o);
    if (root.kind === 'param') return this.paramBase + root.index;
    if (root.kind !== 'node') throw new A0Error('wasm: literal has no local');
    const local = this.locals.get(root.id);
    if (local === undefined) throw new A0Error(`wasm: unbound node ${o.id}`);
    return local;
  }

  /** Push an operand: a scalar value, a token address, or an aggregate address. */
  push(o: Operand): void {
    if (o.kind === 'u32') this.code.i32(o.value);
    else if (o.kind === 'bool') this.code.i32(o.value ? 1 : 0);
    else this.code.local(OP.localGet, this.localOf(o));
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
    if ((length & (length - 1)) === 0) {
      this.code.i32(length - 1);
      this.code.op(OP.and);
    } else {
      this.code.i32(length);
      this.code.op(OP.rem_u);
    }
    if (elemBytes !== 1) {
      this.code.i32(elemBytes);
      this.code.op(OP.mul);
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
    if (this.aliases.has(node.id)) {
      // In place: one element store (set/put), a loop in the initial value's storage, or nothing (mov).
      if (node.op === 'set' || node.op === 'put') this.#storeElement(node, node.args[0] as Operand);
      else if (node.op === 'fold' || node.op === 'loop') this.#iteration(node);
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
      case 'select':
        this.push(b as Operand);
        this.push(node.args[2] as Operand);
        this.push(a as Operand);
        c.op(OP.select);
        set();
        return;
      case 'call': {
        const callee = fn.calls.get(node.callee ?? '');
        if (callee === undefined) throw new A0Error(`wasm: unknown callee ${node.callee}`);
        if (isPrimitive(t)) {
          for (const arg of node.args) this.push(arg);
          c.call(`a0_${callee.name}`);
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
    // State: a scalar local, the aliased storage, or a slot initialised by copying.
    let state: number;
    if (aggregate) {
      if (this.aliases.has(node.id)) {
        state = this.localOf({ kind: 'node', id: node.id });
      } else {
        state = this.bindSlot(node.id, t);
        c.local(OP.localGet, state);
        this.push(init);
        this.copy(bytesOf(t));
      }
    } else {
      state = this.#bindScalar(node.id);
      this.push(init);
      c.local(OP.localSet, state);
    }
    const i = this.newLocal();
    c.i32(0);
    c.local(OP.localSet, i);
    c.op(OP.block, VOID);
    c.op(OP.loop, VOID);
    c.local(OP.localGet, i);
    this.push(count);
    c.op(OP.ge_u);
    c.op(OP.br_if, 1);
    const args = (): void => {
      c.local(OP.localGet, state);
      c.local(OP.localGet, i);
      for (const e of extra) this.push(e);
    };
    if (pred !== undefined) {
      args();
      c.call(`a0_${pred.name}`);
      c.op(OP.eqz);
      c.op(OP.br_if, 1);
    }
    args();
    if (aggregate) {
      c.call(`a0o_${body.name}`);
    } else {
      c.call(`a0_${body.name}`);
      c.local(OP.localSet, state);
    }
    c.local(OP.localGet, i);
    c.i32(1);
    c.op(OP.add);
    c.local(OP.localSet, i);
    c.op(OP.br, 0);
    c.op(OP.end);
    c.op(OP.end);
  }

  /** Emit the whole variant and return its record. */
  emit(): VariantRecord {
    const fn = this.fn;
    for (const n of fn.nodes) this.emitNode(n);
    const c = this.code;
    const ret = fn.ret;
    const root = this.root(ret);
    if (this.variant === 'owned') {
      // The state is already updated in place when the result is p0's storage; otherwise store it.
      if (!(root.kind === 'param' && root.index === 0)) {
        c.local(OP.localGet, this.paramBase);
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
    const body = c.finish();
    const frame = align(this.frame, STACK_ALIGN);
    const pro = new Code();
    const epi = new Code();
    if (frame > 0) {
      const fp = this.fp();
      pro.op(OP.globalGet, 0);
      pro.i32(frame);
      pro.op(OP.sub);
      pro.local(OP.localTee, fp);
      pro.op(OP.globalSet, 0);
      epi.local(OP.localGet, fp);
      epi.i32(frame);
      epi.op(OP.add);
      epi.op(OP.globalSet, 0);
    }
    const symbol = this.variant === 'owned' ? `a0o_${fn.name}` : `a0_${fn.name}`;
    return {
      symbol,
      ...(this.variant === 'value' ? { exportAs: symbol } : {}),
      params: this.paramCount,
      result: this.variant === 'value' && isPrimitive(fn.result),
      locals: this.localCount,
      frame,
      code: [...pro.finish(), ...body, ...epi.finish()],
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
export function emitWasmFunction(fn: TypedFunc): string {
  const pool: string[] = [];
  const poolIndex = new Map<string, number>();
  const variants = [new FunctionEmitter(fn, 'value', pool, poolIndex).emit()];
  if (hasOwnedVariant(fn)) variants.push(new FunctionEmitter(fn, 'owned', pool, poolIndex).emit());
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
  return { symbol: IO_READ, params: 1, result: true, locals: 0, code: c.finish() };
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
  return { symbol: IO_WRITE, params: 2, result: false, locals: 0, code: c.finish() };
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
  c.op(OP.loop, VOID);
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
  c.op(OP.end);
  c.op(OP.end);
  return { symbol: IO_PUTS, params: 3, result: false, locals: 1, code: c.finish() };
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
    const locals = f.locals > 0 ? [...uleb(1), ...uleb(f.locals), I32] : [0];
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
