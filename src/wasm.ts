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
 * Code shape: fold/loop bodies and predicates of up to INLINE_BODY_NODES nodes, and scalar
 * calls of functions of up to INLINE_CALL_NODES nodes, are emitted in place when they need no
 * frame and no io (literal arguments become constants); counted loops are rotated (one entry
 * guard, a `br_if` back edge); element addresses scale by a shift. Each body then goes through
 * `Code.finish`: a value read once across balanced code stays on the operand stack (`stackify`),
 * other set/get pairs become `local.tee`, dead stores are dropped, and locals with disjoint live
 * ranges share an index.
 *
 * Strict profile (`profile strict`): a node that can trap carries a check, and a trap is the wasm
 * `unreachable` after the runtime has recorded what the interpreter's trap line is made of. The
 * module keeps the C runtime's shadow stack in a static area (functions that can trap `enter`
 * and `leave` a frame; a fold or loop that can trap names its node and trip), and exports the
 * same record the C-derived module does: the immutable i32 globals `a0_trap_kind`, `a0_trap_n`,
 * `a0_trap_at`, `a0_trap_trip` (addresses of u32 words: a pointer to a NUL-terminated kind, the
 * frame count, the frame the innermost fold or loop is in, its trip) and `a0_chain`, `a0_node`
 * (addresses of arrays of pointers to NUL-terminated names). A trapped instance is discarded. A
 * canonical module has no such area and is byte for byte what it was.
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
import {
  callTraps,
  emitFused,
  type FillRun,
  fillRun,
  lazyArms,
  mayTrapFn,
  overwritesState,
  siteOf,
} from './optimize.js';

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
  unreachable: 0x00,
  and: 0x71,
  or: 0x72,
  xor: 0x73,
  shl: 0x74,
  shr_u: 0x76,
  rotl: 0x77,
  rotr: 0x78,
} as const;
const VOID = 0x40;
const I64_EXTEND_U = 0xad;
const I64_MUL = 0x7e;
const I64_CONST = 0x42;
const I64_SHR_U = 0x88;
const I64_EQZ = 0x50;
const I32 = 0x7f;
const V128 = 0x7b;
/** simd128 opcodes (after the 0xfd prefix). */
const SIMD = {
  load: 0x00,
  store: 0x0b,
  const: 0x0c,
  splat: 0x11,
  extract: 0x1b,
  replace: 0x1c,
  eq: 0x37,
  ne: 0x38,
  lt_u: 0x3a,
  gt_u: 0x3c,
  le_u: 0x3e,
  ge_u: 0x40,
  and: 0x4e,
  or: 0x50,
  xor: 0x51,
  bitselect: 0x52,
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

/**
 * A run of bytes, a call to a symbol, the address of a constant-pool entry (an i32.const), or the
 * address of a NUL-terminated name in the strict runtime's static area (an i32.const).
 */
type Part =
  | string
  | { readonly call: string }
  | { readonly pool: number }
  | { readonly str: string };

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
/** The strict profile's `read`: the same, but exhausted input traps. */
const IO_SREAD = 'io:sread';
/** Strict runtime helpers (see `strictRuntime`): frames, fold marks, and the trap itself. */
const RT_ENTER = 'rt:enter';
const RT_LEAVE = 'rt:leave';
const RT_MARK = 'rt:mark';
const RT_IDX = 'rt:idx';
const RT_TRAP = 'rt:trap';
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
  | { readonly str: string }
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
 * keeps a value on the operand stack instead of a `local.set x; local.get x` pair when the get
 * is the only read and the code between them is balanced (`stackify`), turns a set followed by
 * a get of the same local into a `local.tee`, drops dead stores, and renumbers the non-parameter
 * locals so ones with disjoint live ranges share an index (a range that touches a loop covers
 * the whole loop, for the back edge).
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

  /** The address of the NUL-terminated name `text` in the strict runtime's area. */
  str(text: string): void {
    this.ins.push({ str: text });
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

/**
 * Stack effect of an instruction-list entry: `net` is its change of depth and `low` the lowest
 * depth it reaches relative to its start (for a run, the least of its instructions' depth before
 * their pops minus those pops). An entry with no known effect (a call, a loop, a branch, an i64
 * instruction, a simd instruction other than v128.const, v128.store, i32x4.splat, extract_lane,
 * replace_lane and the lane-wise `SLP_OPS`) is a barrier: `undefined`.
 */
interface Effect {
  readonly net: number;
  readonly low: number;
}
const PUSH: Effect = { net: 1, low: 0 };
const POP: Effect = { net: -1, low: -1 };
const TEE: Effect = { net: 0, low: -1 };

/** The index after the LEB128 immediate that starts at `at`. */
function skipLeb(bytes: readonly number[], at: number): number {
  let p = at;
  while (((bytes[p] as number) & 0x80) !== 0) p += 1;
  return p + 1;
}

/** Stack effect of a run of bytes (its instructions one after another), or a barrier. */
function runEffect(bytes: readonly number[]): Effect | undefined {
  let net = 0;
  let low = 0;
  let p = 0;
  while (p < bytes.length) {
    const op = bytes[p] as number;
    p += 1;
    let pops = 0;
    let pushes = 0;
    if (op === 0x1a) {
      pops = 1;
    } else if (op === 0x1b) {
      pops = 3;
      pushes = 1;
    } else if (op === 0x23) {
      pushes = 1;
      p = skipLeb(bytes, p);
    } else if (op === 0x24) {
      pops = 1;
      p = skipLeb(bytes, p);
    } else if (op === 0x28) {
      pops = 1;
      pushes = 1;
      p = skipLeb(bytes, skipLeb(bytes, p));
    } else if (op === 0x36) {
      pops = 2;
      p = skipLeb(bytes, skipLeb(bytes, p));
    } else if (op === 0x41) {
      pushes = 1;
      p = skipLeb(bytes, p);
    } else if (op === 0x45 || (op >= 0x67 && op <= 0x69)) {
      pops = 1;
      pushes = 1;
    } else if ((op >= 0x46 && op <= 0x4f) || (op >= 0x6a && op <= 0x78)) {
      pops = 2;
      pushes = 1;
    } else if (op === 0xfc && bytes[p] === 0x0a) {
      pops = 3;
      p += 3;
    } else if (op === 0xfc && bytes[p] === 0x0b) {
      pops = 3;
      p += 2;
    } else if (op === 0xfd) {
      const v = bytes[p] as number;
      p = skipLeb(bytes, p);
      if (v === SIMD.const) {
        pushes = 1;
        p += 16;
      } else if (v === SIMD.store) {
        pops = 2;
        p = skipLeb(bytes, skipLeb(bytes, p));
      } else if (v === SIMD.splat) {
        pops = 1;
        pushes = 1;
      } else if (v === SIMD.extract || v === SIMD.replace) {
        pops = v === SIMD.extract ? 1 : 2;
        pushes = 1;
        p += 1;
      } else if (Object.values(SLP_OPS).includes(v)) {
        pops = 2;
        pushes = 1;
      } else return undefined;
    } else {
      return undefined;
    }
    low = Math.min(low, net - pops);
    net += pushes - pops;
  }
  return { net, low };
}

/** Stack effect of one instruction-list entry (see `Effect`). */
function effectOf(x: Ins): Effect | undefined {
  if ('bytes' in x) return runEffect(x.bytes);
  if ('local' in x) return x.local === 'get' ? PUSH : x.local === 'set' ? POP : TEE;
  if ('pool' in x || 'str' in x) return PUSH;
  return undefined;
}

/**
 * Peephole over local accesses (see `Code`); parameters are left alone.
 *
 * A set whose value is read once is removed together with that get, the value staying on the
 * operand stack. The set's range runs to the next set or tee of its local, or to the end of the
 * body; the pair is a candidate when the range holds exactly one get, in the same run of
 * straight-line code (no barrier between them), and the local has no earlier get in the outermost
 * loop around the set (a read through the back edge). A candidate is taken when the code between
 * the two is balanced (it leaves the depth the set left, so the get's value sits where the stack
 * expects it) and never pops into the value, and its span does not end inside the span of an
 * earlier taken pair (pairs are taken in order of their sets). A set followed by a get of the
 * same local becomes a `local.tee` when its pair is not taken; a set with no get anywhere is a
 * drop, and a tee with no get vanishes.
 */
function stackify(input: readonly Ins[], params: number): Ins[] {
  const { gets } = localCounts(input);
  const n = input.length;
  const effects = input.map(effectOf);
  // Depth before each entry (from its run's start), and the candidate pairs: pairTo[set] = get.
  const depth: number[] = new Array<number>(n).fill(0);
  const pairTo: number[] = new Array<number>(n).fill(-1);
  // Per local: its open range (the set, its run, the gets read so far: 0, 1 or 2 for "more
  // than one or not in the set's run", the one get, and whether the loop allows the pair).
  interface Range {
    readonly set: number;
    readonly run: number;
    reads: number;
    get: number;
    readonly loopOk: boolean;
  }
  const ranges = new Map<number, Range>();
  const last = new Map<number, number>();
  const endRange = (x: number): void => {
    const r = ranges.get(x);
    if (r === undefined) return;
    if (r.reads === 1 && r.loopOk) pairTo[r.set] = r.get;
    ranges.delete(x);
  };
  let d = 0;
  let run = 0;
  let loopDepth = 0;
  let loopStart = 0;
  for (let k = 0; k < n; k += 1) {
    const x = input[k] as Ins;
    depth[k] = d;
    if ('loop' in x) {
      if (x.loop === 'open') {
        if (loopDepth === 0) loopStart = k;
        loopDepth += 1;
      } else {
        loopDepth -= 1;
      }
    }
    const e = effects[k];
    if (e === undefined) {
      run += 1;
      d = 0;
      continue;
    }
    d += e.net;
    if (!('local' in x) || x.index < params) continue;
    if (x.local === 'get') {
      const r = ranges.get(x.index);
      if (r !== undefined) {
        if (r.reads === 0 && r.run === run) {
          r.reads = 1;
          r.get = k;
        } else {
          r.reads = 2;
        }
      }
      last.set(x.index, k);
    } else if (x.local === 'set') {
      endRange(x.index);
      const before = last.get(x.index) ?? -1;
      ranges.set(x.index, {
        set: k,
        run,
        reads: 0,
        get: -1,
        loopOk: before < (loopDepth > 0 ? loopStart : k),
      });
    } else {
      endRange(x.index);
    }
  }
  for (const x of [...ranges.keys()]) endRange(x);

  // Take the pairs in order of their sets; a span that ends inside a taken span is refused.
  const removed = new Set<number>();
  const ends = new Set<number>();
  for (let p = 0; p < n; p += 1) {
    const q = pairTo[p] as number;
    if (q < 0) continue;
    const after = (depth[p] as number) + (effects[p] as Effect).net;
    // Taken gets right before this one (`get a; get b; add` with both sets taken): their values
    // are already piled on the stack in set order, so this value only has to land on top of them.
    let first = q;
    while (ends.has(first - 1)) first -= 1;
    let ok = first > p && depth[first] === after;
    for (let k = p + 1; ok && k < first; k += 1) {
      if ((depth[k] as number) + (effects[k] as Effect).low < after || ends.has(k)) ok = false;
    }
    if (!ok) continue;
    removed.add(p);
    removed.add(q);
    ends.add(q);
  }

  const out: Ins[] = [];
  for (let i = 0; i < n; i += 1) {
    const x = input[i] as Ins;
    if (removed.has(i)) continue;
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
 * A rotate: `or (shl x s) (shr x t)` with the two distances summing to 0 (mod 32), in either
 * order (the rule of the arm64 backend). wasm takes a shift distance mod 32, so the pair is exactly
 * `i32.rotl x s` when t is `sub 32 s`, and `i32.rotr x t` when s is `sub 32 t`; two literal
 * distances rotate by the right one (`right` below). The shifts (and the `sub`) are used by the
 * `or` alone, so they are not emitted.
 */
interface Rotate {
  readonly x: Operand;
  /** The distance operand: the left distance for `i32.rotl`, the right one for `i32.rotr`. */
  readonly by: Operand;
  readonly left: boolean;
}
interface Rotates {
  /** The `or` nodes that are rotates. */
  readonly at: ReadonlyMap<string, Rotate>;
  /** The shift and `sub` nodes a rotate absorbs. */
  readonly owned: ReadonlySet<string>;
}
const ROTATES = new WeakMap<TypedFunc, Rotates>();

function rotatesOf(fn: TypedFunc): Rotates {
  const cached = ROTATES.get(fn);
  if (cached !== undefined) return cached;
  const uses = new Map<string, { consumer: Node | undefined }[]>();
  const useOf = (o: Operand, consumer: Node | undefined): void => {
    if (o.kind !== 'node') return;
    uses.set(o.id, [...(uses.get(o.id) ?? []), { consumer }]);
  };
  for (const n of fn.nodes) for (const o of n.args) useOf(o, n);
  useOf(fn.ret, undefined);
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  /** The node behind operand `o` when its single use is by `consumer`. */
  const soleUse = (o: Operand | undefined, consumer: Node): Node | undefined => {
    if (o?.kind !== 'node') return undefined;
    const list = uses.get(o.id) ?? [];
    return list.length === 1 && list[0]?.consumer === consumer ? byId.get(o.id) : undefined;
  };
  /** `sub L s` with L = 0 (mod 32), used by `user` alone. */
  const subOf = (o: Operand, user: Node): Node | undefined => {
    const d = soleUse(o, user);
    return d?.op === 'sub' && d.args[0]?.kind === 'u32' && d.args[0].value % 32 === 0
      ? d
      : undefined;
  };
  const same = (p: Operand, q: Operand): boolean =>
    sameOp(p, q) || (p.kind === 'u32' && q.kind === 'u32' && p.value === q.value);
  const at = new Map<string, Rotate>();
  const owned = new Set<string>();
  for (const n of fn.nodes) {
    if (n.op !== 'or') continue;
    const pa = soleUse(n.args[0] as Operand, n);
    const pb = soleUse(n.args[1] as Operand, n);
    const [l, r] =
      pa?.op === 'shl' && pb?.op === 'shr'
        ? [pa, pb]
        : pa?.op === 'shr' && pb?.op === 'shl'
          ? [pb, pa]
          : [undefined, undefined];
    if (l === undefined || r === undefined) continue;
    const x = l.args[0] as Operand;
    if (!same(x, r.args[0] as Operand)) continue;
    const ls = l.args[1] as Operand;
    const rs = r.args[1] as Operand;
    let plan: Rotate | undefined;
    let extra: Node | undefined;
    if (ls.kind === 'u32' && rs.kind === 'u32') {
      if (((ls.value & 31) + (rs.value & 31)) % 32 === 0)
        plan = { x, by: { kind: 'u32', value: rs.value & 31 }, left: false };
    } else {
      const rsub = subOf(rs, r);
      const lsub = subOf(ls, l);
      if (rsub !== undefined && same(rsub.args[1] as Operand, ls)) {
        plan = { x, by: ls, left: true };
        extra = rsub;
      } else if (lsub !== undefined && same(lsub.args[1] as Operand, rs)) {
        plan = { x, by: rs, left: false };
        extra = lsub;
      }
    }
    if (plan === undefined) continue;
    at.set(n.id, plan);
    owned.add(l.id);
    owned.add(r.id);
    if (extra !== undefined) owned.add(extra.id);
  }
  const result = { at, owned };
  ROTATES.set(fn, result);
  return result;
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
  readonly carry?: {
    readonly get: string;
    readonly set: string;
    readonly local: number;
    /** A `select` that is the carried element on every trip (see `guardedCarry`). */
    readonly select?: string;
  };
  /**
   * A sliding read of an extra argument (see `slidingRead`): `cur` (reading pK at p1) is the
   * local `curLocal`, and `next` (reading pK at p1 + 1) is bound to `nextLocal`, which the host
   * moves to `curLocal` after each trip.
   */
  readonly slide?: {
    readonly cur: string;
    readonly next: string;
    readonly curLocal: number;
    readonly nextLocal: number;
  };
  /** p1 is the host's trip index, below this literal bound (so p1 needs no masking below it). */
  readonly indexBound?: number;
}

/** A carried read: the read, the store that feeds it, and the read's index on trip p1. */
interface CarriedRead {
  readonly get: string;
  readonly set: string;
  readonly first: Affine;
}

/** An index s * p1 + c + t * pK (pK a scalar extra parameter, K >= 2; t is 0, 1 or -1), mod 2^32. */
interface Affine {
  readonly s: number;
  readonly c: number;
  readonly k: number;
  readonly t: number;
}

/** An operand as an affine index, given the affine forms of the nodes before it. */
function affineOf(
  o: Operand | undefined,
  nodes: ReadonlyMap<string, Affine | undefined>,
): Affine | undefined {
  if (o === undefined) return undefined;
  if (o.kind === 'u32') return { s: 0, c: o.value, k: 0, t: 0 };
  if (o.kind === 'param') {
    if (o.index === 1) return { s: 1, c: 0, k: 0, t: 0 };
    // An extra parameter used as an index or an add/sub operand is a u32 in a valid program.
    if (o.index >= 2) return { s: 0, c: 0, k: o.index, t: 1 };
    return undefined;
  }
  return o.kind === 'node' ? nodes.get(o.id) : undefined;
}

/** The affine form (in p1 and at most one extra parameter) of every add/sub node of `body`. */
function affineNodes(body: TypedFunc): Map<string, Affine | undefined> {
  const out = new Map<string, Affine | undefined>();
  for (const n of body.nodes) {
    const a = affineOf(n.args[0], out);
    const b = affineOf(n.args[1], out);
    if ((n.op !== 'add' && n.op !== 'sub') || a === undefined || b === undefined) {
      out.set(n.id, undefined);
      continue;
    }
    const sign = n.op === 'add' ? 1 : -1;
    const t = a.t + sign * b.t;
    const k = a.t !== 0 ? a.k : b.k;
    if ((a.t !== 0 && b.t !== 0 && a.k !== b.k) || (t !== 0 && Math.abs(t) !== 1)) {
      out.set(n.id, undefined);
      continue;
    }
    out.set(n.id, {
      s: (a.s + sign * b.s) >>> 0,
      c: (a.c + sign * b.c) >>> 0,
      k: t === 0 ? 0 : k,
      t,
    });
  }
  return out;
}

/**
 * A fold or loop body over array state whose result is `set X w v` (its last store) and which
 * reads `get p0 r` where r at trip p1 + 1 is w at trip p1 (both affine in p1, see `affineNodes`):
 * trip i + 1 reads the value trip i stored last, so a backend may carry v in a local instead of
 * reloading it. The elements are scalars.
 */
function carriedRead(body: TypedFunc): CarriedRead | undefined {
  const ret = body.ret;
  if (ret.kind !== 'node') return undefined;
  const set = body.nodes.find((n) => n.id === ret.id);
  const st = body.params[0];
  if (set?.op !== 'set' || st === undefined || isPrimitive(st) || st.kind !== 'arr')
    return undefined;
  if (!isPrimitive(st.elem)) return undefined;
  const forms = affineNodes(body);
  const w = affineOf(set.args[1], forms);
  if (w === undefined) return undefined;
  for (const n of body.nodes) {
    if (n.op !== 'get' || n.args[0]?.kind !== 'param' || n.args[0].index !== 0) continue;
    const r = affineOf(n.args[1], forms);
    if (r === undefined || r.s !== w.s || r.k !== w.k || r.t !== w.t) continue;
    if ((r.c + r.s) >>> 0 === w.c) return { get: n.id, set: set.id, first: r };
  }
  return undefined;
}

/**
 * The carried read `get` (see `carriedRead`) guarded on the first trip: its only use is
 * `select (eq p1 first) K get`, the literal K standing in on the trip `first` the loop starts at.
 * With the carried local starting at K instead of the element before `first`, that select is
 * the carried local on every trip, so the compare and the select vanish from the loop.
 */
function guardedCarry(
  body: TypedFunc,
  get: string,
  first: number,
): { select: string; first: number } | undefined {
  const isGet = (o: Operand | undefined): boolean => o?.kind === 'node' && o.id === get;
  const users = body.nodes.filter((n) => n.args.some(isGet));
  const sel = users[0];
  if (users.length !== 1 || sel?.op !== 'select') return undefined;
  // A select that leads a select group is emitted with its group (see optimize.ts `lazyArms`).
  if (lazyArms(body).groups.has(sel.id)) return undefined;
  const [cond, k, other] = sel.args;
  if (k?.kind !== 'u32' || !isGet(other) || sel.args.filter(isGet).length !== 1) return undefined;
  if (cond?.kind !== 'node') return undefined;
  const eq = body.nodes.find((n) => n.id === cond.id);
  const [x, y] = eq?.args ?? [];
  const isIndex = (o: Operand | undefined): boolean => o?.kind === 'param' && o.index === 1;
  const isFirst = (o: Operand | undefined): boolean => o?.kind === 'u32' && o.value === first;
  if (eq?.op !== 'eq' || !((isIndex(x) && isFirst(y)) || (isIndex(y) && isFirst(x))))
    return undefined;
  return { select: sel.id, first: k.value };
}

/**
 * A fold body reading an extra aggregate argument pK (K >= 2, never updated by the loop) of
 * scalar elements both at p1 and at `add p1 1`: trip i + 1's read at p1 is trip i's read at
 * p1 + 1 (both indices wrap mod the length), so a backend may carry that value in a local
 * instead of reloading it. The read at p1 + 1 must run on every trip (not in a lazy select arm).
 */
function slidingRead(body: TypedFunc): { cur: string; next: string; param: number } | undefined {
  const defs = new Map(body.nodes.map((n) => [n.id, n]));
  const lazy = lazyArms(body).owner;
  const isParam = (o: Operand | undefined, i: number): boolean =>
    o?.kind === 'param' && o.index === i;
  const isOne = (o: Operand | undefined): boolean => o?.kind === 'u32' && o.value === 1;
  for (const cur of body.nodes) {
    const p = cur.args[0];
    if (cur.op !== 'get' || p?.kind !== 'param' || p.index < 2 || !isParam(cur.args[1], 1))
      continue;
    const t = body.params[p.index];
    if (t === undefined || isPrimitive(t) || t.kind !== 'arr' || !isPrimitive(t.elem)) continue;
    for (const next of body.nodes) {
      const j = next.args[1];
      if (next.op !== 'get' || !isParam(next.args[0], p.index) || j?.kind !== 'node') continue;
      const d = defs.get(j.id);
      const [x, y] = d?.args ?? [];
      const plusOne =
        d?.op === 'add' && ((isParam(x, 1) && isOne(y)) || (isOne(x) && isParam(y, 1)));
      if (plusOne && !lazy.has(next.id)) return { cur: cur.id, next: next.id, param: p.index };
    }
  }
  return undefined;
}

/** i32x4 forms (after the 0xfd prefix) of the lane operations of a reduction body. */
const REDUCE_OPS: Readonly<Record<string, number>> = {
  add: SIMD.add,
  sub: SIMD.sub,
  mul: SIMD.mul,
  and: SIMD.and,
  or: SIMD.or,
  xor: SIMD.xor,
  shl: SIMD.shl,
  shr: SIMD.shr_u,
  eq: SIMD.eq,
  ne: SIMD.ne,
  lt: SIMD.lt_u,
  gt: SIMD.gt_u,
  le: SIMD.le_u,
  ge: SIMD.ge_u,
};

/** A reduction body has at most this many lane nodes (each one's lanes take a v128 local). */
const REDUCE_MAX_NODES = 32;

/** A reduction fold body (see `reduceRun`). */
interface ReduceRun {
  readonly op: string;
  readonly value: string;
  readonly nodes: readonly Node[];
  readonly bound: number;
}

/**
 * A scalar fold body `acc op f(p1, ...)` (op add, xor, or or and, acc = p0 read nowhere else)
 * whose other nodes are lane operations over the index p1, reads `get pK p1` of extra u32
 * arrays (K >= 2), loop-invariant u32 extras, literals, compares (a bool lane is a mask of all
 * ones or zero) and selects; no `mul` reads p1 (an induction variable) and the body cannot
 * trap. Trips are independent apart from op, which is associative and commutative, so a
 * backend may run four trips at once in i32x4 lanes and fold the lanes into the state after.
 * `nodes` are the body nodes but the last (the reduction), `value` the node op folds in, and
 * `bound` the shortest array read (0 when none): a vector trip never reads past it.
 */
function reduceRun(body: TypedFunc): ReduceRun | undefined {
  const [p0, p1] = body.params;
  if (p0 !== 'u32' || p1 !== 'u32' || body.result !== 'u32' || mayTrapFn(body)) return undefined;
  const last = body.nodes[body.nodes.length - 1];
  const ret = body.ret;
  if (last === undefined || ret.kind !== 'node' || ret.id !== last.id) return undefined;
  if (!(last.op === 'add' || last.op === 'xor' || last.op === 'or' || last.op === 'and'))
    return undefined;
  const isParam = (o: Operand | undefined, i: number): boolean =>
    o?.kind === 'param' && o.index === i;
  const [x, y] = last.args;
  const value = isParam(x, 0) ? y : isParam(y, 0) ? x : undefined;
  if (value?.kind !== 'node') return undefined;
  const nodes = body.nodes.slice(0, -1);
  if (nodes.length > REDUCE_MAX_NODES) return undefined;
  const lanes = new Set<string>();
  const u32 = (o: Operand): boolean => operandType(body, o) === 'u32';
  const uniform = (o: Operand): boolean =>
    o.kind === 'u32' || (o.kind === 'param' && o.index >= 2 && body.params[o.index] === 'u32');
  const lane = (o: Operand): boolean =>
    o.kind === 'u32' ||
    o.kind === 'bool' ||
    isParam(o, 1) ||
    uniform(o) ||
    (o.kind === 'node' && lanes.has(o.id));
  let bound = 0;
  for (const n of nodes) {
    const t = body.types.get(n.id);
    if (t !== 'u32' && t !== 'bool') return undefined;
    const args = n.args;
    if (n.op === 'get') {
      const [a, i] = args;
      const at = a?.kind === 'param' && a.index >= 2 ? body.params[a.index] : undefined;
      if (at === undefined || isPrimitive(at) || at.kind !== 'arr' || at.elem !== 'u32')
        return undefined;
      if (at.length < 4 || !isParam(i, 1)) return undefined;
      bound = bound === 0 ? at.length : Math.min(bound, at.length);
    } else if (n.op === 'select') {
      if (!args.every(lane)) return undefined;
    } else if (REDUCE_OPS[n.op] !== undefined) {
      if (!args.every(lane)) return undefined;
      const [a, b] = args as [Operand, Operand];
      if ((n.op === 'shl' || n.op === 'shr') && !uniform(b)) return undefined;
      if (n.op === 'mul' && (isParam(a, 1) || isParam(b, 1))) return undefined;
      const order = n.op === 'lt' || n.op === 'gt' || n.op === 'le' || n.op === 'ge';
      if (order && !(u32(a) && u32(b))) return undefined;
    } else return undefined;
    lanes.add(n.id);
  }
  if (!lanes.has(value.id) || body.types.get(value.id) !== 'u32') return undefined;
  return { op: last.op, value: value.id, nodes, bound };
}

/** Operations with no effect and no trap in an inlined body (one that can trap is never inlined). */
const PURE_OPS: ReadonlySet<string> = new Set([
  'mov',
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'select',
  'get',
  'at',
]);

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
  // A loop predicate (scalar result) only reads the state; a body returns the new state.
  if (!isPrimitive(body.result) && !(isP0(ret) || inChain(ret))) return undefined;
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

/** Lane-wise u32 operations simd128 packs (see `slpPlan`). */
const SLP_OPS: Readonly<Record<string, number>> = {
  add: SIMD.add,
  sub: SIMD.sub,
  mul: SIMD.mul,
  and: SIMD.and,
  or: SIMD.or,
  xor: SIMD.xor,
  shl: SIMD.shl,
  shr: SIMD.shr_u,
};
const SLP_COMMUTES = new Set(['add', 'mul', 'and', 'or', 'xor']);
/** Packs a function makes at most: one v128 local each, the capacity of compiler/wasm_code.a0. */
const SLP_MAX_PACKS = 128;

/** One side of a pack's operation: another pack, one value in every lane, or four values. */
type SlpKid =
  | { readonly pack: SlpPack }
  | { readonly same: Operand }
  | { readonly lanes: readonly Operand[] };

interface SlpPack {
  readonly lanes: readonly string[];
  readonly op: string;
  readonly kids: SlpKid[];
  /** Index of the node after which the pack's inputs exist (-1: at the start). */
  ready: number;
  /** Lanes whose scalar value is read (extracted into an i32 local when the pack is made). */
  readonly demand: Set<number>;
}

interface SlpPlan {
  /** The packs, kids before the packs that read them. */
  readonly packs: readonly SlpPack[];
  /** Pack-only nodes (not emitted as scalars): the pack and lane that holds each. */
  readonly holder: ReadonlyMap<string, { readonly pack: SlpPack; readonly lane: number }>;
  /** Packs by their lanes joined with ',' (array literal groups are stored from them). */
  readonly byLanes: ReadonlyMap<string, SlpPack>;
  /**
   * Operations of parameters and literals read once, by a splat or lane build: computed there
   * rather than at their place.
   */
  readonly inline: ReadonlySet<string>;
}

const operandKey = (o: Operand): string =>
  o.kind === 'node' ? o.id : o.kind === 'param' ? `p${o.index}` : `${o.kind}${String(o.value)}`;

/**
 * Superword packs of a function: groups of four isomorphic lane-wise u32 operations, seeded by
 * the four-element groups of u32 array literals and grown through their operands, each done as
 * one i32x4 operation. A lane operand that is the same in every lane is a splat; four other
 * values are built with replace_lane. A lane node read as a scalar before its pack's inputs
 * exist is also emitted as a scalar; other scalar reads are lanes extracted once.
 */
function slpPlan(fn: TypedFunc, skip: (id: string) => boolean): SlpPlan {
  const index = new Map<string, number>();
  const byId = new Map<string, Node>();
  for (const [k, n] of fn.nodes.entries()) {
    index.set(n.id, k);
    byId.set(n.id, n);
  }
  const byLanes = new Map<string, SlpPack>();
  const packs: SlpPack[] = [];
  const isU32 = (o: Operand): boolean => o.kind !== 'bool' && operandType(fn, o) === 'u32';
  const opOf = (o: Operand): string => (o.kind === 'node' ? (byId.get(o.id)?.op ?? '') : o.kind);
  const lanesOk = (ops: readonly Operand[]): Node[] | undefined => {
    const nodes: Node[] = [];
    for (const o of ops) {
      if (o.kind !== 'node' || skip(o.id) || nodes.some((n) => n.id === o.id)) return undefined;
      const n = byId.get(o.id);
      if (n === undefined || SLP_OPS[n.op] === undefined || n.op !== opOf(ops[0] as Operand))
        return undefined;
      if (fn.types.get(n.id) !== 'u32' || !n.args.every(isU32)) return undefined;
      nodes.push(n);
    }
    return nodes;
  };
  const kid = (ops: readonly Operand[]): SlpKid => {
    const k0 = operandKey(ops[0] as Operand);
    if (ops.every((o) => operandKey(o) === k0)) return { same: ops[0] as Operand };
    const p = build(ops);
    return p === undefined ? { lanes: ops } : { pack: p };
  };
  const build = (ops: readonly Operand[]): SlpPack | undefined => {
    const nodes = lanesOk(ops);
    if (nodes === undefined) return undefined;
    const lanes = nodes.map((n) => n.id);
    const known = byLanes.get(lanes.join());
    if (known !== undefined) return known;
    if (byLanes.size >= SLP_MAX_PACKS) return undefined;
    const op = (nodes[0] as Node).op;
    const shift = op === 'shl' || op === 'shr';
    const k = operandKey;
    let swap = nodes.map(() => false);
    if (shift) {
      const r0 = k((nodes[0] as Node).args[1] as Operand);
      if (!nodes.every((n) => k(n.args[1] as Operand) === r0)) return undefined;
    } else if (SLP_COMMUTES.has(op)) {
      // Orient each lane: a value common to every lane goes left (one splat, made first); otherwise each
      // lane's sides follow the operations of lane 0's.
      const [l0, r0] = (nodes[0] as Node).args as [Operand, Operand];
      const common = [r0, l0].find((c) => nodes.every((n) => n.args.some((a) => k(a) === k(c))));
      swap = nodes.map((n) => {
        const [a, b] = n.args as [Operand, Operand];
        if (common !== undefined) return k(b) === k(common) && k(a) !== k(common);
        if (k(a) === k(l0) || k(b) === k(r0)) return false;
        if (k(b) === k(l0) || k(a) === k(r0)) return true;
        return (
          !(opOf(a) === opOf(l0) && opOf(b) === opOf(r0)) &&
          opOf(b) === opOf(l0) &&
          opOf(a) === opOf(r0)
        );
      });
    }
    const side = (s: number): Operand[] =>
      nodes.map((n, i) => n.args[(swap[i] ? 1 - s : s) as 0 | 1] as Operand);
    const pack: SlpPack = { lanes, op, kids: [], ready: -1, demand: new Set() };
    byLanes.set(lanes.join(), pack);
    pack.kids.push(kid(side(0)), shift ? { same: side(1)[0] as Operand } : kid(side(1)));
    packs.push(pack);
    return pack;
  };
  for (const n of fn.nodes) {
    if (n.op !== 'arr' || arrayType(fn, { kind: 'node', id: n.id }).elem !== 'u32') continue;
    for (let g = 0; g + 4 <= n.args.length; g += 4) build(n.args.slice(g, g + 4));
  }
  // Kids are pushed before their parents, so `packs` is already in emission order.
  const users = new Map<string, number[]>();
  const use = (id: string, at: number): void => {
    users.set(id, [...(users.get(id) ?? []), at]);
  };
  for (const [k, n] of fn.nodes.entries()) {
    // An array literal group stored from its pack reads no lane.
    const stored = new Set<number>();
    if (n.op === 'arr')
      for (let g = 0; g + 4 <= n.args.length; g += 4) {
        const ids = n.args.slice(g, g + 4).map((a) => (a.kind === 'node' ? a.id : ''));
        if (byLanes.has(ids.join())) for (let i = g; i < g + 4; i += 1) stored.add(i);
      }
    for (const [i, a] of n.args.entries()) if (a.kind === 'node' && !stored.has(i)) use(a.id, k);
  }
  if (fn.ret.kind === 'node') use(fn.ret.id, fn.nodes.length);
  const packed = new Map<string, { pack: SlpPack; lane: number }>();
  for (const p of packs)
    for (const [lane, id] of p.lanes.entries())
      if (!packed.has(id)) packed.set(id, { pack: p, lane });
  // Nodes emitted as scalars anyway (read before their pack exists), grown to a fixed point.
  const scalar = new Set<string>();
  const leafReads = (p: SlpPack): Operand[] =>
    p.kids.flatMap((kd) => ('pack' in kd ? [] : 'same' in kd ? [kd.same] : kd.lanes));
  for (;;) {
    let grew = false;
    // Ready points, depth first; a leaf read of a lane of a pack still being resolved (a cycle)
    // makes that lane a scalar.
    const state = new Map<SlpPack, number>();
    const resolve = (p: SlpPack): number => {
      if (state.get(p) === 2) return p.ready;
      state.set(p, 1);
      let r = -1;
      for (const kd of p.kids) if ('pack' in kd) r = Math.max(r, resolve(kd.pack));
      for (const o of leafReads(p)) {
        if (o.kind !== 'node') continue;
        const h = packed.get(o.id);
        if (h !== undefined && !scalar.has(o.id) && state.get(h.pack) === 1) {
          scalar.add(o.id);
          grew = true;
        }
        r = Math.max(
          r,
          h === undefined || scalar.has(o.id) ? (index.get(o.id) ?? -1) : resolve(h.pack),
        );
      }
      p.ready = r;
      state.set(p, 2);
      return r;
    };
    for (const p of packs) resolve(p);
    if (grew) continue;
    for (const [id, h] of packed) {
      if (scalar.has(id)) continue;
      if (
        (users.get(id) ?? []).some(
          (u) => u <= h.pack.ready && !packed.has(fn.nodes[u]?.id ?? ''),
        ) ||
        (users.get(id) ?? []).some((u) => scalar.has(fn.nodes[u]?.id ?? '') && u <= h.pack.ready)
      ) {
        scalar.add(id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  const holder = new Map<string, { pack: SlpPack; lane: number }>();
  for (const [id, h] of packed) if (!scalar.has(id)) holder.set(id, h);
  // Scalar reads of pack-only nodes: by scalar nodes and by the leaves of packs.
  const read = (id: string): void => {
    const h = holder.get(id);
    if (h !== undefined) h.pack.demand.add(h.lane);
  };
  for (const [id, us] of users)
    if (us.some((u) => u >= fn.nodes.length || !holder.has(fn.nodes[u]?.id ?? ''))) read(id);
  const leafCount = new Map<string, number>();
  for (const p of packs)
    for (const o of leafReads(p))
      if (o.kind === 'node') leafCount.set(o.id, (leafCount.get(o.id) ?? 0) + 1);
  const inline = new Set<string>();
  for (const [id, count] of leafCount) {
    const n = byId.get(id) as Node;
    if (
      count === 1 &&
      !packed.has(id) &&
      !skip(id) &&
      SLP_OPS[n.op] !== undefined &&
      n.args.every((a) => a.kind === 'param' || a.kind === 'u32') &&
      (users.get(id) ?? []).every((u) => holder.has(fn.nodes[u]?.id ?? ''))
    )
      inline.add(id);
  }
  return { packs, holder, byLanes, inline };
}

/** A kid of four lanes in a form one vector operation turns into another of the form. */
interface KidForm {
  readonly op: string;
  readonly x: number;
  readonly c: readonly number[];
}
const KID_FORM_OPS: Readonly<Record<string, true>> = { shl: true, shr: true, add: true, sub: true };

/**
 * The amount s with g = f op s lane-wise (const and add: every lane's literal grows by s; sub:
 * the subtrahends grow by s; shl and shr: the shift counts grow by s, all below 32), else
 * undefined.
 */
function kidShift(f: KidForm, g: KidForm): number | undefined {
  if (f.op !== g.op || f.x !== g.x) return undefined;
  const s = ((g.c[0] as number) - (f.c[0] as number)) >>> 0;
  for (let i = 0; i < 4; i += 1) {
    const a = f.c[i] as number;
    const b = g.c[i] as number;
    if ((b - a) >>> 0 !== s) return undefined;
    if ((f.op === 'shl' || f.op === 'shr') && (a >= 32 || b >= 32)) return undefined;
  }
  return (f.op === 'shl' || f.op === 'shr') && s >= 32 ? undefined : s;
}

/** Iteration bodies and predicates up to this many nodes are emitted inside the loop. */
const INLINE_BODY_NODES = 24;
/** Scalar calls of functions up to this many nodes are emitted at the call site. */
const INLINE_CALL_NODES = 8;
/** A scalar call of a function with frame slots is emitted in place up to this many nodes. */
const INLINE_FRAME_NODES = 16;
const INLINE_DEPTH = 3;
/** Inlined fold bodies up to this many nodes are unrolled when `WasmEmitOptions.unroll` > 1. */
const UNROLL_BODY_NODES = 12;
/** Copies per back edge of a literal-count loop that carries the previous element. */
const CARRY_UNROLL = 4;

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
  /** Rotates among the `or` nodes, and the shift nodes they absorb (see `rotatesOf`). */
  readonly rot: Rotates;
  readonly byId: ReadonlyMap<string, Node>;
  #nextVLocal = VBASE;
  /** Scalar-replaced state: the update-chain nodes and each one's words (see `scalarState`). */
  readonly #chain: ReadonlySet<string> | undefined;
  readonly #words = new Map<string, readonly ParamSource[]>();
  /** simd128 packs of lane-wise operations (see `slpPlan`) and their v128 locals. */
  #slp: SlpPlan | undefined;
  readonly #vec = new Map<SlpPack, number>();

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
    this.rot = rotatesOf(fn);
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
    if (host === undefined && this.options.simd)
      this.#slp = slpPlan(
        fn,
        (id) =>
          this.lazy.owner.has(id) ||
          this.rot.owned.has(id) ||
          this.rot.at.has(id) ||
          this.aliases.has(id),
      );
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

  #frameOwner(): FunctionEmitter {
    return this.host === undefined ? this : this.host.parent.#frameOwner();
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
    // An inlined body's slots live in the outermost host's frame.
    const owner = this.#frameOwner();
    const offset = owner.frame;
    owner.frame += align(bytesOf(t), 4);
    // The first slot is the frame pointer itself.
    if (offset === 0) {
      this.locals.set(id, owner.fp());
      return owner.fp();
    }
    const local = this.newLocal();
    this.locals.set(id, local);
    this.code.local(OP.localGet, owner.fp());
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
    loop: Pick<InlineHost, 'induction' | 'fields' | 'carry' | 'slide' | 'indexBound'> = {},
    frameOk = false,
  ): boolean {
    if (!this.#canInline(callee, variant, params, limit, loop.fields, frameOk)) return false;
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
    frameOk = false,
  ): boolean {
    if (this.depth >= INLINE_DEPTH || callee.nodes.length > (frameOk ? INLINE_FRAME_NODES : limit))
      return false;
    // A body that can trap keeps its frame (the trap line names it): it is called, never inlined.
    if (mayTrapFn(callee)) return false;
    if (variant === 'value' && !isPrimitive(callee.result)) return false;
    if (callee.params.some(containsIo) || [...callee.types.values()].some(containsIo)) return false;
    const host: InlineHost = { parent: this, params, ...(fields === undefined ? {} : { fields }) };
    // `frameOk` asks for the framed callees only (the frameless ones are tried first), and only
    // loop-free ones: a loop nested in the host's loop keeps the outer values live across it,
    // which costs the inner loop its registers (measured: xs4k).
    if (frameOk && callee.nodes.some((n) => n.op === 'fold' || n.op === 'loop')) return false;
    return (
      new FunctionEmitter(
        callee,
        variant,
        this.pool,
        this.poolIndex,
        host,
        this.options,
      ).needsFrame() === frameOk
    );
  }

  /** The body of an inlined function: its nodes, then its result (see `#tryInline`). */
  emitInline(): void {
    this.#emitNodes();
    const fields = this.host?.fields;
    if (this.#chain !== undefined && fields !== undefined && !isPrimitive(this.fn.result)) {
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

  /**
   * A rotate (see `rotatesOf`): its value when both operands are known, else one `i32.rotl` or
   * `i32.rotr` of the two operands. `i32.rotl` by k is `shl k` or `shr (32 - k)`, which is the
   * same as the shift pair for every distance (wasm takes distances mod 32).
   */
  #emitRotate(id: string, rot: Rotate): void {
    const x = this.#constOf(rot.x);
    const by = this.#constOf(rot.by);
    if (x !== undefined && by !== undefined) {
      const k = rot.left ? by & 31 : (32 - (by & 31)) & 31;
      this.consts.set(id, k === 0 ? x >>> 0 : ((x << k) | (x >>> (32 - k))) >>> 0);
      return;
    }
    this.push(rot.x);
    this.push(rot.by);
    this.code.op(rot.left ? OP.rotl : OP.rotr);
    this.code.local(OP.localSet, this.#bindScalar(id));
  }

  /** Every node in order, except those a lazy select arm emits on its own path. */
  #emitNodes(): void {
    const slp = this.#slp;
    if (slp !== undefined && slp.packs.length > 0) {
      const at = (k: number): void => {
        for (const p of slp.packs) if (p.ready === k) this.#emitPack(p);
      };
      at(-1);
      for (const [k, n] of this.fn.nodes.entries()) {
        const skip = slp.holder.has(n.id) || slp.inline.has(n.id);
        if (!skip && !this.lazy.owner.has(n.id) && !this.rot.owned.has(n.id)) this.emitNode(n);
        at(k);
      }
      return;
    }
    const live = this.host === undefined ? undefined : this.#liveInline();
    for (const n of this.fn.nodes)
      if (!this.lazy.owner.has(n.id) && !this.rot.owned.has(n.id) && (live?.has(n.id) ?? true))
        this.emitNode(n);
  }

  /**
   * The nodes an inlined body still needs: its result and every node with an effect, and what
   * they read. A node the host computes (an induction variable, the carried element) reads
   * nothing, so a pure node only it used (the `sub p1 1` of a carried read, the compare of a
   * guarded carry) is dead and emitted not at all, rather than computed and dropped.
   */
  #liveInline(): Set<string> {
    const host = this.host;
    const fn = this.fn;
    const byHost = (id: string): boolean =>
      host?.induction?.has(id) === true || host?.carry?.get === id || host?.carry?.select === id;
    const live = new Set<string>();
    const mark = (o: Operand): void => {
      if (o.kind === 'node') live.add(o.id);
    };
    mark(fn.ret);
    for (let k = fn.nodes.length - 1; k >= 0; k -= 1) {
      const n = fn.nodes[k] as Node;
      // The next read of a sliding pair runs every trip: the host moves it to the cur local.
      if (!PURE_OPS.has(n.op) || host?.slide?.next === n.id) live.add(n.id);
      if (live.has(n.id) && !byHost(n.id)) for (const a of n.args) mark(a);
    }
    return live;
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
  elementAddress(
    arr: Operand,
    idx: Operand | undefined,
    elemBytes: number,
    checked = false,
  ): number {
    const { length } = arrayType(this.fn, arr);
    this.push(arr);
    const lit = literalIndex(idx);
    if (lit !== undefined) {
      // Strict: a literal index at or past the length is the trap (the access after it is dead).
      if (checked && lit >= length) this.#trap(0);
      return (lit % length) * elemBytes;
    }
    if (idx === undefined) throw new A0Error('wasm: missing index');
    const root = this.root(idx);
    const bound = this.host?.indexBound;
    const inRange =
      root.kind === 'param' && root.index === 1 && bound !== undefined && bound <= length;
    this.push(idx);
    if (inRange) {
      // The trip index never reaches the length: no wrap.
    } else if (checked) {
      // Strict: an index at or past the length traps before anything is read or written; an
      // index that passes the test needs no wrap.
      const t = this.newLocal();
      this.code.local(OP.localTee, t);
      this.code.i32(length);
      this.code.op(OP.ge_u);
      this.code.op(OP.if, VOID);
      this.#trap(0);
      this.code.op(OP.end);
      this.code.local(OP.localGet, t);
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

  /** Raise the strict trap `kind` (0 bounds, 1 divzero, 2 input): the runtime records it, then `unreachable`. */
  #trap(kind: number): void {
    this.code.i32(kind);
    this.code.call(RT_TRAP);
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
    if (this.host?.carry?.get === node.id || this.host?.carry?.select === node.id) {
      this.locals.set(node.id, this.host.carry.local);
      return;
    }
    if (this.host?.slide?.cur === node.id) {
      this.locals.set(node.id, this.host.slide.curLocal);
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
    const slide = this.host?.slide;
    const set = (): void => {
      if (slide?.next === node.id) {
        this.locals.set(node.id, slide.nextLocal);
        c.local(OP.localSet, slide.nextLocal);
      } else c.local(OP.localSet, this.#bindScalar(node.id));
    };
    const rotate = this.rot.at.get(node.id);
    if (rotate !== undefined) {
      this.#emitRotate(node.id, rotate);
      return;
    }
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
        if (fn.profile === 'strict') {
          // Strict: a zero divisor is the trap; a divisor proved nonzero is a plain div_u.
          if (siteOf(fn, node) === 'divzero') {
            this.push(b as Operand);
            c.op(OP.eqz);
            c.op(OP.if, VOID);
            this.#trap(1);
            c.op(OP.end);
          }
          this.push(a as Operand);
          this.push(b as Operand);
          c.op(node.op === 'div' ? OP.div_u : OP.rem_u);
          set();
          return;
        }
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
        const group = this.lazy.groups.get(node.id);
        if (group !== undefined) {
          // The group's selects (see optimize.ts `lazyArms`): one branch, each side's nodes on
          // its own path, every select's local written on both.
          const members = group.members.map((id) => this.byId.get(id) as Node);
          const locals = members.map((m) => this.#bindScalar(m.id));
          const side = (k: 0 | 1): void => {
            for (const id of group.arms[k]) this.emitNode(this.byId.get(id) as Node);
            for (const [j, m] of members.entries()) {
              this.push(m.args[k + 1] as Operand);
              c.local(OP.localSet, locals[j] as number);
            }
          };
          if (k !== undefined) {
            // A known condition: its side only.
            side(k !== 0 ? 0 : 1);
            return;
          }
          this.push(a as Operand);
          c.op(OP.if, VOID);
          side(0);
          c.op(OP.else);
          side(1);
          c.op(OP.end);
          return;
        }
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
          // A framed callee brings its slots into this frame: no call, no stack pointer round trip.
          if (
            !this.#tryInline(callee, 'value', params, INLINE_CALL_NODES) &&
            !this.#tryInline(callee, 'value', params, INLINE_CALL_NODES, {}, true)
          ) {
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
          const group = node.args.slice(i - (i % 4), i - (i % 4) + 4);
          const ids = group.map((x) => (x.kind === 'node' ? x.id : ''));
          const pack = group.length === 4 ? this.#slp?.byLanes.get(ids.join()) : undefined;
          if (pack !== undefined) {
            if (i % 4 === 0) {
              c.local(OP.localGet, local);
              c.local(OP.localGet, this.#vec.get(pack) as number);
              c.simd(SIMD.store);
              c.op(2, ...uleb(i * size));
            }
            continue;
          }
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
        const offset = this.elementAddress(
          a as Operand,
          b,
          bytesOf(elem),
          siteOf(fn, node) === 'bounds',
        );
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
      case 'cadd':
      case 'csub': {
        // (value, ok) into a record slot: the wrapped result, and no carry (borrow).
        const slot = this.bindSlot(node.id, t);
        const sum = this.newLocal();
        this.push(a as Operand);
        this.push(b as Operand);
        c.op(node.op === 'cadd' ? OP.add : OP.sub);
        c.local(OP.localSet, sum);
        c.local(OP.localGet, slot);
        c.local(OP.localGet, sum);
        c.mem(OP.store, 0);
        c.local(OP.localGet, slot);
        if (node.op === 'cadd') {
          c.local(OP.localGet, sum);
          this.push(a as Operand);
        } else {
          this.push(a as Operand);
          this.push(b as Operand);
        }
        c.op(OP.ge_u);
        c.mem(OP.store, 4);
        return;
      }
      case 'cmul': {
        // ok: the exact 64-bit product has no bit above the low 32.
        const slot = this.bindSlot(node.id, t);
        c.local(OP.localGet, slot);
        this.push(a as Operand);
        this.push(b as Operand);
        c.op(OP.mul);
        c.mem(OP.store, 0);
        c.local(OP.localGet, slot);
        this.push(a as Operand);
        c.op(I64_EXTEND_U);
        this.push(b as Operand);
        c.op(I64_EXTEND_U);
        c.op(I64_MUL, I64_CONST, 32, I64_SHR_U, I64_EQZ);
        c.mem(OP.store, 4);
        return;
      }
      case 'cdiv':
      case 'crem': {
        // The divisor is replaced by 1 when zero so div_u never traps; (0, false) is selected.
        const slot = this.bindSlot(node.id, t);
        const zero = this.newLocal();
        this.push(b as Operand);
        c.op(OP.eqz);
        c.local(OP.localSet, zero);
        c.local(OP.localGet, slot);
        c.i32(0);
        this.push(a as Operand);
        this.push(b as Operand);
        c.local(OP.localGet, zero);
        c.op(OP.or);
        c.op(node.op === 'cdiv' ? OP.div_u : OP.rem_u);
        c.local(OP.localGet, zero);
        c.op(OP.select);
        c.mem(OP.store, 0);
        c.local(OP.localGet, slot);
        c.local(OP.localGet, zero);
        c.op(OP.eqz);
        c.mem(OP.store, 4);
        return;
      }
      case 'cget': {
        // (a[i], true) when i is below the length, (0, false) otherwise.
        const slot = this.bindSlot(node.id, t);
        const { length } = arrayType(fn, a);
        const ok = this.newLocal();
        this.push(b as Operand);
        c.i32(length);
        c.op(OP.lt_u);
        c.local(OP.localSet, ok);
        c.local(OP.localGet, slot);
        c.local(OP.localGet, ok);
        c.op(OP.if, I32);
        this.push(a as Operand);
        this.push(b as Operand);
        c.i32(2);
        c.op(OP.shl);
        c.op(OP.add);
        c.mem(OP.load, 0);
        c.op(OP.else);
        c.i32(0);
        c.op(OP.end);
        c.mem(OP.store, 0);
        c.local(OP.localGet, slot);
        c.local(OP.localGet, ok);
        c.mem(OP.store, 4);
        return;
      }
      case 'read': {
        // (u32, io): the word read, then the token.
        const local = this.bindSlot(node.id, t);
        c.local(OP.localGet, local);
        this.push(a as Operand);
        c.call(fn.profile === 'strict' ? IO_SREAD : IO_READ);
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

  /**
   * One pack's i32x4 operation (after the packs it reads), then its lanes read by scalar nodes
   * extracted into locals. A splat or lane build reads a pack-only lane straight from its pack.
   */
  #emitPack(p: SlpPack): void {
    if (this.#vec.has(p)) return;
    const c = this.code;
    const leaves = p.kids.flatMap((k) => ('pack' in k ? [] : 'same' in k ? [k.same] : k.lanes));
    for (const k of p.kids) if ('pack' in k) this.#emitPack(k.pack);
    for (const o of leaves) {
      const h = o.kind === 'node' ? this.#slp?.holder.get(o.id) : undefined;
      if (h !== undefined) this.#emitPack(h.pack);
    }
    const scalar = (o: Operand): void => {
      const h = o.kind === 'node' ? this.#slp?.holder.get(o.id) : undefined;
      if (o.kind === 'node' && this.#slp?.inline.has(o.id)) {
        const n = this.byId.get(o.id) as Node;
        this.push(n.args[0] as Operand);
        this.push(n.args[1] as Operand);
        c.op(BINARY[n.op] as number);
      } else if (h === undefined || h.pack.demand.has(h.lane)) this.push(o);
      else {
        c.local(OP.localGet, this.#vec.get(h.pack) as number);
        c.simd(SIMD.extract);
        c.op(h.lane);
      }
    };
    const lanes = (k: SlpKid): void => {
      if (!('lanes' in k)) return;
      if (k.lanes.every((o) => o.kind === 'u32')) {
        c.simd(SIMD.const);
        const b = new Uint8Array(16);
        const view = new DataView(b.buffer);
        for (const [i, o] of k.lanes.entries())
          view.setUint32(i * 4, (o as { value: number }).value >>> 0, true);
        c.op(...b);
      } else
        for (const [i, o] of k.lanes.entries()) {
          scalar(o);
          if (i === 0) c.simd(SIMD.splat);
          else {
            c.simd(SIMD.replace);
            c.op(i);
          }
        }
    };
    for (const [side, k] of p.kids.entries()) {
      if ('pack' in k) c.local(OP.localGet, this.#vec.get(k.pack) as number);
      else if ('same' in k) {
        scalar(k.same);
        if (!(k === p.kids[1] && (p.op === 'shl' || p.op === 'shr'))) c.simd(SIMD.splat);
      } else if (!this.#formKid(p, side, lanes)) lanes(k);
    }
    c.simd(SLP_OPS[p.op] as number);
    const v = this.newVLocal();
    c.local(OP.localSet, v);
    this.#vec.set(p, v);
    for (const lane of [...p.demand].sort()) {
      c.local(OP.localGet, v);
      c.simd(SIMD.extract);
      c.op(lane);
      c.local(OP.localSet, this.#bindScalar(p.lanes[lane] as string));
    }
  }

  /** The packs in the order `#emitPack` makes them (kids and the packs of leaves first). */
  #packOrder(): SlpPack[] {
    const slp = this.#slp as SlpPlan;
    const order: SlpPack[] = [];
    const seen = new Set<SlpPack>();
    const visit = (p: SlpPack): void => {
      if (seen.has(p)) return;
      seen.add(p);
      for (const k of p.kids) if ('pack' in k) visit(k.pack);
      for (const k of p.kids)
        for (const o of 'pack' in k ? [] : 'same' in k ? [k.same] : k.lanes) {
          const h = o.kind === 'node' ? slp.holder.get(o.id) : undefined;
          if (h !== undefined) visit(h.pack);
        }
      order.push(p);
    };
    for (let k = -1; k < this.fn.nodes.length; k += 1)
      for (const p of slp.packs) if (p.ready === k) visit(p);
    return order;
  }

  /**
   * The form of a kid built from four lanes: constant lanes (op 'const'), or four inline
   * operations of one parameter and a literal each (`x shl c`, `x shr c`, `x add c`, `x sub c`).
   */
  #kidForm(p: SlpPack, side: number): KidForm | undefined {
    const k = p.kids[side];
    if (k === undefined || !('lanes' in k)) return undefined;
    if (k.lanes.every((o) => o.kind === 'u32'))
      return { op: 'const', x: -1, c: k.lanes.map((o) => (o as { value: number }).value >>> 0) };
    let op = '';
    let x = -1;
    const c: number[] = [];
    // A lane that is the parameter itself is `x op 0`.
    const bare = (o: Operand): boolean => o.kind === 'param' && o.index === x;
    for (const o of k.lanes) {
      if (o.kind === 'param') continue;
      if (o.kind !== 'node' || !this.#slp?.inline.has(o.id)) return undefined;
      const n = this.byId.get(o.id) as Node;
      const [a, b] = n.args;
      if (KID_FORM_OPS[n.op] === undefined || a?.kind !== 'param' || b?.kind !== 'u32')
        return undefined;
      if (op !== '' && (n.op !== op || a.index !== x)) return undefined;
      op = n.op;
      x = a.index;
    }
    if (op === '' || !k.lanes.every((o) => o.kind === 'node' || bare(o))) return undefined;
    for (const o of k.lanes)
      c.push(
        o.kind === 'node'
          ? ((this.byId.get(o.id) as Node).args[1] as { value: number }).value >>> 0
          : 0,
      );
    return { op, x, c };
  }

  /** Kids built from lanes kept in a v128 local: the form built and the local. */
  readonly #kept: { readonly form: KidForm; readonly local: number }[] = [];
  /** Kids in emission order (see `#packOrder`). */
  #kidOrder: { readonly p: SlpPack; readonly side: number }[] | undefined;

  /**
   * A kid in a form (see `#kidForm`): one operation on a kept kid of the form whose lanes
   * differ by one amount (`kidShift`), else, when a kid not yet made can be derived from it,
   * built and kept. A shift's base is the kid of the smallest counts among those it derives
   * from, made here ahead of its own pack. False: built as usual.
   */
  #formKid(p: SlpPack, side: number, build: (k: SlpKid) => void): boolean {
    const f = this.#kidForm(p, side);
    if (f === undefined) return false;
    for (const kept of this.#kept) {
      const s = kidShift(kept.form, f);
      if (s !== undefined) {
        this.#deriveKid(kept.local, f.op, s);
        return true;
      }
    }
    if (this.#kidOrder === undefined)
      this.#kidOrder = this.#packOrder().flatMap((q) =>
        q.kids.map((_, qs) => ({ p: q, side: qs })),
      );
    const order = this.#kidOrder;
    const at = order.findIndex((e) => e.p === p && e.side === side);
    let best = { p, side, form: f };
    let used = false;
    for (const e of order.slice(at + 1)) {
      const g = this.#kidForm(e.p, e.side);
      if (g === undefined) continue;
      if (kidShift(f, g) !== undefined) used = true;
      if (
        (f.op === 'shl' || f.op === 'shr') &&
        kidShift(g, f) !== undefined &&
        (g.c[0] as number) < (best.form.c[0] as number)
      )
        best = { ...e, form: g };
    }
    if (!used && best.p === p && best.side === side) return false;
    build(best.p.kids[best.side] as SlpKid);
    const local = this.newVLocal();
    this.#kept.push({ form: best.form, local });
    if (best.p === p && best.side === side) this.code.local(OP.localTee, local);
    else {
      this.code.local(OP.localSet, local);
      this.#deriveKid(local, f.op, kidShift(best.form, f) as number);
    }
    return true;
  }

  /** A kept kid's local, then the operation by s that makes a kid of its form (none for 0). */
  #deriveKid(local: number, op: string, s: number): void {
    const c = this.code;
    c.local(OP.localGet, local);
    if (s === 0) return;
    c.i32(s | 0);
    if (op === 'shl' || op === 'shr') c.simd(op === 'shl' ? SIMD.shl : SIMD.shr_u);
    else {
      c.simd(SIMD.splat);
      c.simd(op === 'sub' ? SIMD.sub : SIMD.add);
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
      const offset = this.elementAddress(
        target,
        node.args[1],
        bytesOf(elem),
        siteOf(this.fn, node) === 'bounds',
      );
      this.storeAt(elem, value, offset);
    } else {
      const fields = recordType(this.fn, node.args[0]);
      const k = literalIndex(node.args[1]) ?? 0;
      const offset = fields.slice(0, k).reduce((n, f) => n + bytesOf(f), 0);
      this.push(target);
      this.storeAt(fields[k] as Type, value, offset);
    }
  }

  /**
   * fold/loop: a counted loop calling the body (owned variant for aggregate state). Strict: a
   * loop whose body can trap names its node and each trip in the frame, so a trap line has the
   * interpreter's `at` and `trip`.
   */
  #iteration(node: Node): void {
    const marked = this.host === undefined && mayTrapFn(this.fn) && callTraps(this.fn, node);
    if (marked) {
      this.code.str(node.id);
      this.code.call(RT_MARK);
    }
    this.#iterate(node, marked);
    if (marked) {
      this.code.i32(0);
      this.code.call(RT_MARK);
    }
  }

  #iterate(node: Node, marked: boolean): void {
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
    // Reductions: four trips per vector trip with simd128 while every lane's read is in range,
    // then the rest by the scalar loop below, from the counter the vector loop left.
    const red = this.options.simd && !aggregate && node.op === 'fold' ? reduceRun(body) : undefined;
    const vectorTo =
      red === undefined ? undefined : this.#vectorReduce(red, state, i, count, extra);
    if (vectorTo !== undefined) start = vectorTo;
    if (lit !== undefined && start >= lit) return;
    const sources = (): ParamSource[] => [
      { local: state },
      { local: i },
      ...extra.map((e) => this.#source(e)),
    ];
    // Scalar replacement: a small aggregate state lives in locals for the whole loop.
    const width =
      aggregate && !isPrimitive(t) ? (t.kind === 'arr' ? t.length : t.fields.length) : 0;
    // A loop's predicate reads the same state: it must take its words from the locals too.
    const smallBody = aggregate && scalarState(body) !== undefined;
    const probe = smallBody ? Array.from({ length: width }, () => state) : undefined;
    const small =
      smallBody &&
      (pred === undefined ||
        (scalarState(pred) !== undefined &&
          this.#canInline(pred, 'value', sources(), INLINE_BODY_NODES, probe)));
    const inlineBody = this.#canInline(
      body,
      variant,
      sources(),
      INLINE_BODY_NODES,
      small ? probe : undefined,
    );
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
    // Strength reduction: `p1 * K` in an inlined body is an induction variable stepping by K,
    // where K is a literal or a loop-invariant extra (a constant, or a host local the loop never
    // writes).
    const induction = new Map<string, { local: number; step: ParamSource }>();
    if (inlineBody) {
      const params = sources();
      const isIndex = (o: Operand | undefined): boolean => o?.kind === 'param' && o.index === 1;
      const stepOf = (o: Operand | undefined): ParamSource | undefined => {
        if (o?.kind === 'u32') return { value: o.value };
        if (o?.kind === 'param' && o.index >= 2) return params[o.index];
        return undefined;
      };
      for (const n of body.nodes) {
        if (n.op !== 'mul') continue;
        const [x, y] = n.args;
        const k = isIndex(x) ? stepOf(y) : isIndex(y) ? stepOf(x) : undefined;
        if (k === undefined) continue;
        const local = this.newLocal();
        if ('value' in k) c.i32(Math.imul(start, k.value));
        else if (start === 0) c.i32(0);
        else {
          c.local(OP.localGet, k.local);
          c.i32(start);
          c.op(OP.mul);
        }
        c.local(OP.localSet, local);
        induction.set(n.id, { local, step: k });
      }
    }
    const inductionLocals = new Map([...induction].map(([id, v]) => [id, v.local]));
    // The previous element in a local (in-place array state, inlined body).
    const carried = aggregate && inlineBody && fields === undefined ? carriedRead(body) : undefined;
    let carry: InlineHost['carry'];
    if (carried !== undefined && this.#inPlace(body, carried.set, sources())) {
      const local = this.newLocal();
      const { length } = t as { length: number };
      const guard = guardedCarry(body, carried.get, start);
      // The read's index on the first trip: s * start + c (+/- the extra parameter).
      const { s, c: k0, k, t: sign } = carried.first;
      const index = (Math.imul(s, start) + k0) >>> 0;
      if (guard !== undefined) {
        c.i32(guard.first);
      } else if (sign === 0) {
        c.local(OP.localGet, state);
        c.mem(OP.load, (index % length) * 4);
      } else {
        c.local(OP.localGet, state);
        c.i32(index);
        const src = sources()[k] as ParamSource;
        if ('value' in src) c.i32(src.value);
        else c.local(OP.localGet, src.local);
        c.op(sign > 0 ? OP.add : OP.sub);
        if ((length & (length - 1)) === 0) {
          c.i32(length - 1);
          c.op(OP.and);
        } else {
          c.i32(length);
          c.op(OP.rem_u);
        }
        c.i32(2);
        c.op(OP.shl);
        c.op(OP.add);
        c.mem(OP.load, 0);
      }
      c.local(OP.localSet, local);
      carry = {
        get: carried.get,
        set: carried.set,
        local,
        ...(guard === undefined ? {} : { select: guard.select }),
      };
    }
    // A sliding read of an extra argument: the element at the start index before the loop.
    const sliding = node.op === 'fold' && inlineBody ? slidingRead(body) : undefined;
    let slide: InlineHost['slide'];
    const slideFrom =
      sliding === undefined ? undefined : this.#source(extra[sliding.param - 2] as Operand);
    if (sliding !== undefined && slideFrom !== undefined && 'local' in slideFrom) {
      const { length } = body.params[sliding.param] as { length: number };
      const curLocal = this.newLocal();
      const nextLocal = this.newLocal();
      c.local(OP.localGet, slideFrom.local);
      c.mem(OP.load, (start % length) * 4);
      c.local(OP.localSet, curLocal);
      slide = { cur: sliding.cur, next: sliding.next, curLocal, nextLocal };
    }
    const loopHost: Pick<InlineHost, 'induction' | 'fields' | 'carry' | 'slide' | 'indexBound'> = {
      induction: inductionLocals,
      ...(fields === undefined ? {} : { fields }),
      ...(carry === undefined ? {} : { carry }),
      ...(slide === undefined ? {} : { slide }),
      ...(lit === undefined ? {} : { indexBound: lit }),
    };
    const args = (): void => {
      c.local(OP.localGet, state);
      c.local(OP.localGet, i);
      for (const e of extra) this.push(e);
    };
    /** One trip: predicate exit (to the enclosing block, `depth` labels out), body, steps. */
    const trip = (depth: number): void => {
      if (marked) {
        c.local(OP.localGet, i);
        c.call(RT_IDX);
      }
      if (pred !== undefined) {
        const bound = {
          ...(lit === undefined ? {} : { indexBound: lit }),
          ...(fields === undefined ? {} : { fields }),
        };
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
      } else if (slide !== undefined) {
        c.local(OP.localGet, slide.nextLocal);
        c.local(OP.localSet, slide.curLocal);
      }
      if (!aggregate) c.local(OP.localSet, state);
      for (const { local, step } of induction.values()) {
        c.local(OP.localGet, local);
        if ('value' in step) c.i32(step.value);
        else c.local(OP.localGet, step.local);
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
    // loop finishes the last count mod UNROLL trips. A literal-count loop with a carried
    // previous element is unrolled by CARRY_UNROLL whatever the option: each trip's add waits
    // on the last one, so the counter, compare and address work of every trip sits on top of a
    // serial chain that V8 does not unroll away.
    const unroll =
      vectorTo === undefined &&
      node.op === 'fold' &&
      inlineBody &&
      body.nodes.length <= UNROLL_BODY_NODES
        ? carry !== undefined && lit !== undefined
          ? CARRY_UNROLL
          : this.options.unroll
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
   * simd128 form of a reduction (see `reduceRun`) for the fold of `count` trips whose scalar
   * state is the local `state` and counter the local `i` (0 here): four lanes per trip up to
   * the count, or the shortest array read, rounded down to a multiple of four (a variable bound
   * is computed into a local), the lanes then folded into the state in order. Returns the
   * counter's value after the vector loop when known (a literal count; -1 otherwise, the
   * scalar loop then guards on the counter), or undefined, having emitted nothing, when a
   * literal count leaves no vector trip.
   */
  #vectorReduce(
    red: ReduceRun,
    state: number,
    i: number,
    count: Operand,
    extra: readonly Operand[],
  ): number | undefined {
    const c = this.code;
    const lit = count.kind === 'u32' ? count.value : undefined;
    let staticTo: number | undefined;
    if (lit !== undefined) {
      const m = red.bound === 0 ? lit : Math.min(lit, red.bound);
      staticTo = m - (m % 4);
      if (staticTo === 0) return undefined;
    }
    const vconst = (lanes: readonly number[]): void => {
      c.simd(SIMD.const);
      const b = new Uint8Array(16);
      const view = new DataView(b.buffer);
      for (const [k, v] of lanes.entries()) view.setUint32(k * 4, v >>> 0, true);
      c.op(...b);
    };
    const splat = (v: number): void => vconst([v, v, v, v]);
    const limit = this.newLocal();
    if (staticTo !== undefined) c.i32(staticTo);
    else {
      this.push(count);
      if (red.bound !== 0) {
        c.i32(red.bound);
        this.push(count);
        c.i32(red.bound);
        c.op(OP.lt_u);
        c.op(OP.select);
      }
      c.i32(-4);
      c.op(OP.and);
    }
    c.local(OP.localSet, limit);
    const acc = this.newVLocal();
    splat(red.op === 'and' ? 0xffffffff : 0);
    c.local(OP.localSet, acc);
    const isIndex = (o: Operand): boolean => o.kind === 'param' && o.index === 1;
    const reads = (n: Node): readonly Operand[] =>
      n.op === 'get' ? [] : n.op === 'shl' || n.op === 'shr' ? [n.args[0] as Operand] : n.args;
    let index: number | undefined;
    if (red.nodes.some((n) => reads(n).some(isIndex))) {
      index = this.newVLocal();
      vconst([0, 1, 2, 3]);
      c.local(OP.localSet, index);
    }
    // Loop-invariant extras as splats, once before the loop.
    const splats = new Map<number, number>();
    for (const n of red.nodes)
      for (const a of reads(n))
        if (a.kind === 'param' && a.index >= 2 && !splats.has(a.index)) {
          const v = this.newVLocal();
          this.push(extra[a.index - 2] as Operand);
          c.simd(SIMD.splat);
          c.local(OP.localSet, v);
          splats.set(a.index, v);
        }
    const lanes = new Map<string, number>();
    const pushLanes = (o: Operand): void => {
      if (o.kind === 'u32') splat(o.value);
      else if (o.kind === 'bool') splat(o.value ? 0xffffffff : 0);
      else if (o.kind === 'param')
        c.local(OP.localGet, o.index === 1 ? (index as number) : (splats.get(o.index) as number));
      else if (o.kind === 'node') c.local(OP.localGet, lanes.get(o.id) as number);
    };
    const guard = staticTo === undefined;
    if (guard) {
      c.op(OP.block, VOID);
      c.local(OP.localGet, i);
      c.local(OP.localGet, limit);
      c.op(OP.ge_u);
      c.op(OP.br_if, 0);
    }
    c.loopOpen();
    for (const n of red.nodes) {
      const [a, b, s] = n.args as [Operand, Operand, Operand];
      if (n.op === 'get') {
        this.push(extra[(a as { index: number }).index - 2] as Operand);
        c.local(OP.localGet, i);
        c.i32(2);
        c.op(OP.shl);
        c.op(OP.add);
        // v128.load with a 4-byte alignment hint and offset 0.
        c.simd(SIMD.load);
        c.op(2, 0);
      } else if (n.op === 'select' && s.kind === 'u32' && s.value === 0) {
        // A zero second arm: the first arm's lanes under the mask.
        pushLanes(b);
        pushLanes(a);
        c.simd(SIMD.and);
      } else if (n.op === 'select') {
        pushLanes(b);
        pushLanes(s);
        pushLanes(a);
        c.simd(SIMD.bitselect);
      } else {
        pushLanes(a);
        // A shift amount is the same in every lane: a literal or an extra, as a scalar.
        if (n.op === 'shl' || n.op === 'shr')
          this.push(b.kind === 'param' ? (extra[b.index - 2] as Operand) : b);
        else pushLanes(b);
        c.simd(REDUCE_OPS[n.op] as number);
      }
      const v = this.newVLocal();
      c.local(OP.localSet, v);
      lanes.set(n.id, v);
    }
    c.local(OP.localGet, acc);
    c.local(OP.localGet, lanes.get(red.value) as number);
    c.simd(REDUCE_OPS[red.op] as number);
    c.local(OP.localSet, acc);
    if (index !== undefined) {
      c.local(OP.localGet, index);
      splat(4);
      c.simd(SIMD.add);
      c.local(OP.localSet, index);
    }
    c.local(OP.localGet, i);
    c.i32(4);
    c.op(OP.add);
    c.local(OP.localTee, i);
    c.local(OP.localGet, limit);
    c.op(OP.lt_u);
    c.op(OP.br_if, 0);
    c.loopClose();
    if (guard) c.op(OP.end);
    // The lanes into the state, in lane order.
    c.local(OP.localGet, state);
    for (let k = 0; k < 4; k += 1) {
      c.local(OP.localGet, acc);
      c.simd(SIMD.extract);
      c.op(k);
      c.op(BINARY[red.op] as number);
    }
    c.local(OP.localSet, state);
    return staticTo ?? -1;
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
    // Strict: a function that can trap keeps a frame on the runtime's shadow stack (its name).
    const framed = mayTrapFn(fn);
    if (framed) {
      all.str(fn.name);
      all.call(RT_ENTER);
    }
    if (frame > 0) {
      const fp = this.fp();
      all.op(OP.globalGet, 0);
      all.i32(frame);
      all.op(OP.sub);
      all.local(OP.localTee, fp);
      all.op(OP.globalSet, 0);
    }
    all.append(c);
    if (framed) all.call(RT_LEAVE);
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
  // Small record state lives in locals here, so recurrence producers fuse too.
  return emitFused(fn, (f) => emitWasmRecord(f, options), { recordState: true });
}

function emitWasmRecord(fn: TypedFunc, options: WasmEmitOptions): string {
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
function ioRead(inCap: number, strict: number | undefined = undefined): Fn {
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
  // Strict: exhausted input is the trap (kind 2); the value after it is dead.
  if (strict !== undefined) {
    c.i32(strict);
    c.call(RT_TRAP);
  }
  c.i32(0);
  c.op(OP.end);
  return {
    symbol: strict === undefined ? IO_READ : IO_SREAD,
    params: 1,
    result: true,
    locals: 0,
    code: c.finish().parts,
  };
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

/** Where the strict runtime's static area puts each thing (see `strictArea`). */
interface Area {
  readonly kind: number;
  readonly n: number;
  readonly at: number;
  readonly trip: number;
  readonly depth: number;
  /** Three 8-byte slots: `bounds`, `divzero`, `input`, each NUL-padded. */
  readonly kinds: number;
  readonly chain: number;
  readonly node: number;
  readonly trp: number;
  readonly names: Map<string, number>;
  /** The names laid out from here (4-aligned), then the area ends. */
  readonly stringsBase: number;
  readonly strings: Uint8Array;
  readonly end: number;
}

const STRICT_KINDS = ['bounds', 'divzero', 'input'] as const;

/**
 * The strict runtime's area at `base`: the record the host decodes (kind pointer, frame count,
 * innermost marked frame, its trip), the depth, the three kind names, the shadow stack arrays
 * (`chain`, `node`, `trp`, `frames` words each) and the NUL-terminated names the code refers to.
 */
function strictArea(base: number, frames: number, names: ReadonlySet<string>): Area {
  const kind = base;
  const kinds = base + 20;
  const chain = align(kinds + 24, STACK_ALIGN);
  const node = chain + 4 * frames;
  const trp = node + 4 * frames;
  const stringsBase = trp + 4 * frames;
  const text: number[] = [];
  const at = new Map<string, number>();
  for (const name of [...names].sort()) {
    at.set(name, stringsBase + text.length);
    text.push(...Buffer.from(name, 'utf8'), 0);
  }
  while (text.length % 4 !== 0) text.push(0);
  return {
    kind,
    n: base + 4,
    at: base + 8,
    trip: base + 12,
    depth: base + 16,
    kinds,
    chain,
    node,
    trp,
    names: at,
    stringsBase,
    strings: Uint8Array.from(text),
    end: align(stringsBase + text.length, 4),
  };
}

/** The strict runtime's helpers: frames (`enter`, `leave`), fold marks (`mark`, `idx`) and `trap`. */
function strictRuntime(a: Area): Fn[] {
  const word = (c: Code, local: number): void => {
    // local << 2, the byte offset of word `local`
    c.local(OP.localGet, local);
    c.i32(2);
    c.op(OP.shl);
  };
  // enter(name): chain[depth] = name; node[depth] = 0; depth += 1
  const enter = new Code();
  enter.i32(0);
  enter.mem(OP.load, a.depth);
  enter.local(OP.localSet, 1);
  word(enter, 1);
  enter.local(OP.localGet, 0);
  enter.mem(OP.store, a.chain);
  word(enter, 1);
  enter.i32(0);
  enter.mem(OP.store, a.node);
  enter.i32(0);
  enter.local(OP.localGet, 1);
  enter.i32(1);
  enter.op(OP.add);
  enter.mem(OP.store, a.depth);
  // leave(): depth -= 1
  const leave = new Code();
  leave.i32(0);
  leave.i32(0);
  leave.mem(OP.load, a.depth);
  leave.i32(1);
  leave.op(OP.sub);
  leave.mem(OP.store, a.depth);
  // mark(node) / idx(trip): the innermost frame's node pointer / trip
  const frameStore = (offset: number): Code => {
    const c = new Code();
    c.i32(0);
    c.mem(OP.load, a.depth);
    c.i32(1);
    c.op(OP.sub);
    c.i32(2);
    c.op(OP.shl);
    c.local(OP.localGet, 0);
    c.mem(OP.store, offset);
    return c;
  };
  // trap(kind): find the innermost frame that marks a fold, record the line's fields, reset the stack, unreachable
  const t = new Code();
  t.i32(0);
  t.mem(OP.load, a.depth);
  t.local(OP.localSet, 1); // n
  t.i32(-1);
  t.local(OP.localSet, 2); // at
  t.i32(0);
  t.local(OP.localSet, 3); // trip
  t.local(OP.localGet, 1);
  t.local(OP.localSet, 4); // k
  t.op(OP.block, VOID);
  t.loopOpen();
  t.local(OP.localGet, 4);
  t.op(OP.eqz);
  t.op(OP.br_if, 1);
  t.local(OP.localGet, 4);
  t.i32(1);
  t.op(OP.sub);
  t.local(OP.localSet, 4);
  word(t, 4);
  t.mem(OP.load, a.node);
  t.op(OP.if, VOID);
  t.local(OP.localGet, 4);
  t.local(OP.localSet, 2);
  word(t, 4);
  t.mem(OP.load, a.trp);
  t.local(OP.localSet, 3);
  t.op(OP.br, 2);
  t.op(OP.end);
  t.op(OP.br, 0);
  t.loopClose();
  t.op(OP.end);
  t.i32(0);
  t.local(OP.localGet, 0);
  t.i32(8);
  t.op(OP.mul);
  t.i32(a.kinds);
  t.op(OP.add);
  t.mem(OP.store, a.kind);
  t.i32(0);
  t.local(OP.localGet, 1);
  t.mem(OP.store, a.n);
  t.i32(0);
  t.local(OP.localGet, 2);
  t.mem(OP.store, a.at);
  t.i32(0);
  t.local(OP.localGet, 3);
  t.mem(OP.store, a.trip);
  t.i32(0);
  t.i32(0);
  t.mem(OP.store, a.depth);
  t.op(OP.unreachable);
  return [
    { symbol: RT_ENTER, params: 1, result: false, locals: 1, code: enter.finish().parts },
    { symbol: RT_LEAVE, params: 0, result: false, locals: 0, code: leave.finish().parts },
    {
      symbol: RT_MARK,
      params: 1,
      result: false,
      locals: 0,
      code: frameStore(a.node).finish().parts,
    },
    {
      symbol: RT_IDX,
      params: 1,
      result: false,
      locals: 0,
      code: frameStore(a.trp).finish().parts,
    },
    { symbol: RT_TRAP, params: 1, result: false, locals: 4, code: t.finish().parts },
  ];
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

  // Strict runtime: a static area before the constant pool, only in a module whose code uses it
  // (a canonical module has none, so its layout is unchanged).
  const names = new Set<string>();
  for (const r of records)
    for (const v of r.variants)
      for (const p of v.code) if (typeof p === 'object' && 'str' in p) names.add(p.str);
  const strictOn = records.some((r) =>
    r.variants.some((v) =>
      v.code.some(
        (p) => typeof p === 'object' && 'call' in p && (p.call === RT_TRAP || p.call === IO_SREAD),
      ),
    ),
  );
  const area = strictOn ? strictArea(POOL_BASE, program.functions.length + 1, names) : undefined;
  const poolBase = area === undefined ? POOL_BASE : area.end;

  // Constant pool: deduplicated across functions, 4-aligned.
  const poolAddress = new Map<string, number>();
  const poolBytes: number[] = [];
  for (const r of records) {
    for (const entry of r.pool) {
      if (poolAddress.has(entry)) continue;
      const data = Buffer.from(entry, 'base64');
      poolAddress.set(entry, poolBase + poolBytes.length);
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
  if (area !== undefined) {
    if (io) fns.push(ioRead(layout.ioInputCapacity, 2));
    fns.push(...strictRuntime(area));
  }
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
            : typeof p === 'object' && 'str' in p
              ? Buffer.from([
                  OP.const,
                  ...sleb((area as Area).names.get(p.str) as number),
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
  const stackBase = align(poolBase + poolBytes.length, STACK_ALIGN);
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

  // The strict runtime's record as immutable i32 globals (their values are addresses), after
  // __stack_pointer (0) and __heap_base (1).
  const trapGlobals: [string, number][] =
    area === undefined
      ? []
      : [
          ['a0_trap_kind', area.kind],
          ['a0_trap_n', area.n],
          ['a0_trap_at', area.at],
          ['a0_trap_trip', area.trip],
          ['a0_chain', area.chain],
          ['a0_node', area.node],
        ];
  const exports: number[][] = [
    [...name('memory'), 0x02, 0],
    [...name('__heap_base'), 0x03, 1],
    ...trapGlobals.map(([n], k) => [...name(n), 0x03, ...uleb(2 + k)]),
    ...fns.flatMap((f, i) =>
      f.exportAs === undefined ? [] : [[...name(f.exportAs), 0x00, ...uleb(i)]],
    ),
  ];

  // Data: the constant pool, then the strict area's kind names and its NUL-terminated names.
  const segment = (at: number, bytes: readonly number[]): number[] => [
    0x00,
    OP.const,
    ...sleb(at),
    OP.end,
    ...uleb(bytes.length),
    ...bytes,
  ];
  const segments: number[][] = [];
  if (poolBytes.length > 0) segments.push(segment(poolBase, poolBytes));
  if (area !== undefined) {
    segments.push(
      segment(
        area.kinds,
        STRICT_KINDS.flatMap((k) => [
          ...Buffer.from(k, 'utf8'),
          ...new Array<number>(8 - k.length).fill(0),
        ]),
      ),
    );
    if (area.strings.length > 0) segments.push(segment(area.stringsBase, [...area.strings]));
  }

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
        ...trapGlobals.map(([, v]): number[] => [I32, 0x00, OP.const, ...sleb(v), OP.end]),
      ]),
    ),
    ...section(7, vec(exports)),
    ...section(10, vec(bodiesOut)),
    ...(segments.length > 0 ? section(11, vec(segments)) : []),
  ];
  return Uint8Array.from(module);
}

/** The bytes of a module `compile(program, 'wasm')` produced (its text is the base64 form). */
export function wasmModuleBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}
