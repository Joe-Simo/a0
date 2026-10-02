/**
 * Direct native backend: AVR assembly for the ATmega328P (Arduino Uno), GNU as syntax, on the
 * avr-gcc calling convention so a C program built with avr-gcc calls `a0_<name>` directly.
 * A0 reaches the microcontroller through this code generator plus avr-as and avr-ld only; no
 * C is generated for the program.
 *
 * Scope: functions over u32 and bool, small fixed-size arrays and records of them (value
 * semantics), every scalar op with A0's exact meaning, `call`, `fold`, and `loop`. io
 * functions are refused (`structure`), and so is anything that does not fit the part: one
 * aggregate above AGGREGATE_MAX_BYTES or a frame above FRAME_MAX_BYTES (`limit`).
 *
 * Representation: a u32 is four bytes, little-endian; a bool is one byte holding 0 or 1; an
 * array is its elements back to back and a record its fields in order, with no padding.
 *
 * Register allocation: every scalar (u32, bool, and the hidden result pointer) is a virtual
 * register with a live interval over the node order; a linear scan gives it a home in the
 * register file (a u32 takes an aligned group of four of r2-r25, a pointer an even pair, a
 * bool one register) or, when none is free, a spill slot near the frame pointer Y. Values
 * live across a call or helper routine avoid the registers it clobbers (r18-r27, r30, r31
 * and the callee's argument registers), so they sit in the callee-saved r2-r17, which the
 * prologue saves when used; fold and loop state and counters live there for the whole loop.
 * Hints place a result in its dying operand's registers, parameters where they arrive, and
 * call results where they return, so most moves disappear. r0, r26, r27 (X), r30, r31 (Z)
 * are never homes: they are the byte temporaries and pointers of the emitted sequences.
 *
 * Code shape: add, sub, and, or, xor, compares, select, and shifts are inline byte
 * sequences on the carry chain, peepholed per byte (immediate forms on r16-r31, the zero
 * register r1 for zero bytes, identity bytes skipped, movw for aligned pairs, byte moves for
 * multiples of eight bits, swap for nibbles, branch-free booleans, a compare fused into the
 * select that consumes it). Variable shifts are an inline counted loop. mul uses the
 * hardware 8x8 multiplier in one helper (ten `mul`s for the low 32 bits); div/rem share a
 * restoring divider whose zero-divisor behaviour is A0's (quotient all ones, remainder the
 * dividend); mul/div/rem by a power-of-two literal become shifts and masks. Aggregates live
 * in the frame; `mov`, `at`, and a literal-index `get` of an aggregate alias the source
 * slot; copies are inline (unrolled or a counted loop).
 *
 * Inlining, under word budgets that keep flash small: a `call` of a small callee (or of one
 * called once by the caller) is spliced into the caller before planning; a fold/loop whose
 * scalar-state body (plus predicate) is small is planned in place between the loop head and
 * the latch, its state, counter, count and extras live across the whole loop, and the body
 * result may take the state's registers once the state is last read. A literal trip count
 * below 2^8 (2^16) keeps the counter in one (two) bytes. Everything else calls out of line.
 *
 * Calling convention (avr-gcc): each parameter takes the next registers downward from r25,
 * its size rounded up to even: a u32 in four registers (lowest byte in the lowest), a bool in
 * one (the low register of its pair), an aggregate as a 16-bit pointer to a caller-owned
 * copy the callee never changes. The first parameter that does not fit above r8, and every
 * one after it, goes on the stack in order at unpadded sizes (the caller pushes the last
 * byte first and pops after the call). A u32 result returns in r22-r25 and a bool in r24; an
 * aggregate result is written through a hidden pointer that comes first (r24:r25), so from C
 * such a function is `void a0_f(T *out, const T *p0, ...)`. The callee copies aggregate
 * parameters into its frame on entry and writes the result last, so `out` may alias an
 * argument (fold state updates rely on this). r0 and r18-r27, r30, r31 are scratch; r1 is
 * zero on every call and return; r2-r17 and r28-r29 are preserved. Each function and helper
 * sits in its own `.text.<symbol>` section, so `--gc-sections` keeps only what a program
 * reaches.
 */

import {
  A0Error,
  containsIo,
  isPrimitive,
  type Node,
  type Op,
  type Operand,
  type Type,
  type TypedFunc,
  validateFunction,
} from './core.js';
import { callTraps, mayTrapFn, optimizeFunction, type StrictSite, siteOf } from './optimize.js';
import { frameCapacity, trapNodes } from './trap-host.js';

/** Largest single aggregate, in bytes (byte-sized element offsets; SRAM is 2 KiB). */
export const AVR_AGGREGATE_MAX_BYTES = 255;
/** Largest frame of one function, in bytes. */
export const AVR_FRAME_MAX_BYTES = 1024;
/** ATmega328P memories. */
export const AVR_SRAM_BYTES = 2048;
export const AVR_FLASH_BYTES = 32768;

function refuse(message: string, code: 'structure' | 'limit' = 'structure'): never {
  throw new A0Error(`avr: ${message}`, undefined, {
    code,
    fix:
      code === 'limit'
        ? 'keep aggregates and frames small enough for the ATmega328P, or use the c target'
        : 'compile io functions with the c target; the avr backend covers io-free functions',
  });
}

/** Size of a value in bytes. */
function bytesOf(t: Type): number {
  if (t === 'u32') return 4;
  if (t === 'bool') return 1;
  if (t === 'io') return refuse('io values are not supported by this backend');
  if (t.kind === 'arr') return t.length * bytesOf(t.elem);
  return t.fields.reduce((n, f) => n + bytesOf(f), 0);
}

// --- inlining ---------------------------------------------------------------------------

/** A callee is inlined at every call site when its estimated code is at most this many words. */
export const AVR_INLINE_CALL_WORDS = 24;
/** A callee called once by a caller is inlined there up to this many words. */
export const AVR_INLINE_ONCE_WORDS = 48;
/** A fold/loop body (plus its predicate) is emitted inside the loop up to this many words. */
export const AVR_INLINE_BODY_WORDS = 64;

function usesIo(f: TypedFunc): boolean {
  return (
    containsIo(f.result) || f.params.some(containsIo) || [...f.types.values()].some(containsIo)
  );
}

/** Rough code size of `f`'s body in instruction words (the unit of the inlining budgets). */
function costWords(f: TypedFunc): number {
  let words = 0;
  for (const n of f.nodes) {
    const t = f.types.get(n.id) ?? 'u32';
    const size = bytesOf(t);
    const lit = n.args[1]?.kind === 'u32';
    switch (n.op) {
      case 'mov':
        break;
      case 'add':
      case 'sub':
      case 'and':
      case 'or':
      case 'xor':
        words += size;
        break;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
      case 'gt':
      case 'ge':
        words += 5;
        break;
      case 'shl':
      case 'shr':
        words += lit ? 4 : 12;
        break;
      case 'mul':
      case 'div':
      case 'rem':
        words += 10;
        break;
      case 'select':
        words += isPrimitive(t) ? 2 + size : 12;
        break;
      case 'get':
      case 'at':
        words += lit ? size : 8 + size;
        break;
      case 'set':
      case 'put':
      case 'arr':
      case 'rec':
        words += 8 + size;
        break;
      case 'call':
        words += 12;
        break;
      case 'cadd':
      case 'csub':
      case 'cmul':
      case 'cdiv':
      case 'crem':
      case 'cget':
        words += 24;
        break;
      case 'fold':
      case 'loop':
        words += 30;
        break;
      case 'read':
      case 'write':
      case 'puts':
        words += 12;
    }
  }
  return words;
}

const inlined = new WeakMap<TypedFunc, TypedFunc>();

/**
 * `fn` with small callees (and callees it calls once, up to a larger budget) spliced in
 * place of their `call` nodes, each callee's own calls inlined first. The result is the same
 * function, validated again; a callee not inlined keeps its out-of-line call.
 */
export function inlineCalls(fn: TypedFunc): TypedFunc {
  const known = inlined.get(fn);
  if (known !== undefined) return known;
  let result = fn;
  if (!usesIo(fn)) {
    const sites = new Map<string, number>();
    for (const n of fn.nodes)
      if (n.op === 'call' && n.callee !== undefined)
        sites.set(n.callee, (sites.get(n.callee) ?? 0) + 1);
    const calls = new Map(fn.calls);
    const nodes: Node[] = [];
    let changed = false;
    // Strict: the function's own nodes keep their ids (a trap names the fold it was in); spliced
    // ones take ids that no node of it has. Canonical names every node `v<index>` as before.
    const strict = fn.profile === 'strict';
    const taken = new Set(fn.nodes.map((n) => n.id));
    let serial = 0;
    const idFor = (n: Node, top: boolean): string => {
      if (!strict) return `v${nodes.length}`;
      if (top) return n.id;
      let id = `v${serial}`;
      while (taken.has(id)) {
        serial += 1;
        id = `v${serial}`;
      }
      serial += 1;
      return id;
    };
    const worth = (callee: TypedFunc): boolean => {
      // Strict: a body that can trap keeps its frame (the trap line names it), so it is called.
      if (usesIo(callee) || mayTrapFn(callee)) return false;
      const w = costWords(inlineCalls(callee));
      return (
        w <= AVR_INLINE_CALL_WORDS || (sites.get(callee.name) === 1 && w <= AVR_INLINE_ONCE_WORDS)
      );
    };
    const splice = (f: TypedFunc, params: readonly Operand[], top: boolean): Operand => {
      const ids = new Map<string, Operand>();
      const map = (o: Operand): Operand => {
        if (o.kind === 'param') return params[o.index] ?? refuse(`unknown parameter p${o.index}`);
        if (o.kind === 'node') return ids.get(o.id) ?? refuse(`unknown node ${o.id}`);
        return o;
      };
      for (const n of f.nodes) {
        const args = n.args.map(map);
        const callee =
          n.op === 'call' && n.callee !== undefined ? f.calls.get(n.callee) : undefined;
        if (top && callee !== undefined && worth(callee)) {
          ids.set(n.id, splice(inlineCalls(callee), args, false));
          changed = true;
          continue;
        }
        if (n.op === 'mov') {
          ids.set(n.id, args[0] ?? refuse('mov needs an operand'));
          continue;
        }
        for (const name of [n.callee, n.pred]) {
          const g = name === undefined ? undefined : f.calls.get(name);
          if (name !== undefined && g !== undefined) calls.set(name, g);
        }
        const id = idFor(n, f === fn);
        nodes.push({ ...n, id, args });
        ids.set(n.id, { kind: 'node', id });
      }
      return map(f.ret);
    };
    const ret = splice(
      fn,
      fn.params.map((_, index): Operand => ({ kind: 'param', index })),
      true,
    );
    if (changed)
      try {
        result = validateFunction(
          { name: fn.name, params: fn.params, result: fn.result, nodes, ret },
          calls,
          undefined,
          fn.profile,
        );
      } catch {
        result = fn;
      }
  }
  inlined.set(fn, result);
  return result;
}

/** Whether a fold/loop over `body` (and `pred`) is emitted inside the loop instead of called. */
function inlineBody(body: TypedFunc, pred: TypedFunc | undefined): boolean {
  const fs = pred === undefined ? [body] : [body, pred];
  return (
    isPrimitive(body.result) &&
    fs.every(
      (f) =>
        !usesIo(f) && !mayTrapFn(f) && f.nodes.every((n) => n.op !== 'fold' && n.op !== 'loop'),
    ) &&
    fs.reduce((s, f) => s + costWords(f), 0) <= AVR_INLINE_BODY_WORDS
  );
}

/** Where one argument travels: its lowest register, or its byte offset among the stack arguments. */
interface ArgSlot {
  readonly reg?: number;
  readonly stack?: number;
  readonly size: number;
}

/** avr-gcc placement of `params` (a hidden result pointer in r24:r25 first when `sret`). */
function argLayout(
  params: readonly Type[],
  sret: boolean,
): { slots: ArgSlot[]; stackBytes: number } {
  let cursor = sret ? 24 : 26;
  let stack = 0;
  let spilled = false;
  const slots = params.map((t): ArgSlot => {
    const size = isPrimitive(t) ? bytesOf(t) : 2;
    const next = cursor - ((size + 1) & ~1);
    if (!spilled && next >= 8) {
      cursor = next;
      return { reg: next, size };
    }
    spilled = true;
    stack += size;
    return { stack: stack - size, size };
  });
  return { slots, stackBytes: stack };
}

/** Registers an out-of-line call writes that the callee need not preserve for its caller. */
const SCRATCH: readonly number[] = [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 30, 31];

/** Argument registers of `callee` (including a hidden result pointer). */
function argRegisters(callee: TypedFunc): number[] {
  const sret = !isPrimitive(callee.result);
  const regs = sret ? [24, 25] : [];
  for (const s of argLayout(callee.params, sret).slots)
    if (s.reg !== undefined) for (let k = 0; k < s.size; k += 1) regs.push(s.reg + k);
  return regs;
}

const A = [22, 23, 24, 25];
const B = [18, 19, 20, 21];
const T = [26, 27, 30, 31];

const byteOf = (n: number, k: number): number => (n >>> (8 * k)) & 0xff;
const lo = (n: number): number => n & 0xff;
const hi = (n: number): number => (n >> 8) & 0xff;
const neg16 = (n: number): number => -n & 0xffff;
const isPow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
const log2 = (n: number): number => 31 - Math.clz32(n);

/** Allocation order per size: caller-saved first (no prologue cost), then callee-saved. */
const STARTS: Readonly<Record<1 | 2 | 4, readonly number[]>> = {
  4: [22, 18, 2, 6, 10, 14],
  2: [24, 22, 20, 18, 2, 4, 6, 8, 10, 12, 14, 16],
  1: [24, 25, 22, 23, 18, 19, 20, 21, 16, 17, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
};

type Home =
  | { readonly kind: 'reg'; readonly r: number }
  | { readonly kind: 'slot'; readonly off: number };

interface VReg {
  readonly name: string;
  size: 1 | 2 | 4;
  /** A u32 value (its home may hold fewer bytes when the high ones are known zero). */
  readonly wide: boolean;
  readonly def: number;
  end: number;
  used: boolean;
  home?: Home;
  readonly forbid: Set<number>;
  /** Preferred lowest registers, or values whose home to share. */
  readonly hints: (number | VReg)[];
  /** The register a parameter arrives in. */
  arrival?: number;
  /** Bytes known to be zero (bit k for byte k): never read from the home, never necessarily written. */
  zero: number;
  /** A loop state this body result may share exactly (the state is not read after it is defined). */
  coalesce?: VReg;
}

type Scalar = 'u32' | 'bool';

type Val =
  | { readonly kind: 'lit'; readonly value: number; readonly type: Scalar }
  | { readonly kind: 'v'; readonly v: VReg; readonly type: Scalar }
  | {
      readonly kind: 'agg';
      readonly rel: number;
      readonly type: Type;
      /** A parameter aggregate read in place through this pointer (rel from it); else in the frame. */
      readonly base?: VReg;
    }
  | {
      readonly kind: 'cmp';
      readonly op: Op;
      readonly a: Val;
      readonly b: Val;
      /** Set when the condition is the T flag (a bit test stored by `bst`): its branch condition. */
      readonly t?: 'ts' | 'tc';
    };

type BSrc =
  | { readonly k: 'r'; readonly r: number }
  | { readonly k: 'lit'; readonly b: number }
  | { readonly k: 'slot'; readonly off: number };
type BDst = { readonly k: 'r'; readonly r: number } | { readonly k: 'slot'; readonly off: number };
interface Move {
  readonly d: BDst;
  readonly s: BSrc;
}

/** One node after planning: its effective op (power-of-two mul/div/rem lowered) and operands. */
interface Planned {
  readonly id: string;
  readonly op: Op;
  readonly vals: readonly Val[];
  readonly type: Type;
  readonly callee: string | undefined;
  readonly pred: string | undefined;
  readonly fused: boolean;
  /** Strict: the trap this node can raise itself (an unproved index or divisor), if any. */
  readonly site?: StrictSite;
  /** An `and` with a power of two whose only use is a fused test: `bst` of that bit. */
  readonly bit?: { readonly x: Val; readonly bit: number };
  /** Part of an inlined fold/loop body or predicate: emitted by its loop, not in sequence. */
  readonly inner?: boolean;
  /** A fold/loop whose predicate and body are inlined: their planned ranges and results. */
  readonly inl?: {
    readonly predFrom: number;
    readonly bodyFrom: number;
    readonly bodyTo: number;
    readonly predRet: Val | undefined;
    readonly bodyRet: Val;
  };
}

/** Signals that an inlined loop met spills past Y+63; the function is emitted again without. */
class FarSpill extends Error {}

const COMPARES = new Set<Op>(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const INVERSE: Readonly<Record<string, string>> = {
  lo: 'sh',
  sh: 'lo',
  eq: 'ne',
  ne: 'eq',
  ts: 'tc',
  tc: 'ts',
};

class AvrEmitter {
  out: string[] = [];
  readonly #vals = new Map<string, Val>();
  readonly #vregs: VReg[] = [];
  readonly #planned: Planned[] = [];
  readonly #state = new Map<string, VReg>();
  readonly #counters = new Map<string, VReg>();
  readonly #bitCandidates = new Map<
    VReg,
    { id: string; prefix: string; index: number; x: Val; bit: number }
  >();
  readonly #saved = new Set<number>();
  readonly #clobbers: { pos: number; set: readonly number[]; through: VReg[] }[] = [];
  readonly #calls: Map<string, TypedFunc>;
  /** Functions this emission calls out of line. */
  readonly called = new Map<string, TypedFunc>();
  #pos = 0;
  #inlinedLoops = 0;
  readonly fn: TypedFunc;
  #aggSize = 0;
  #spillSize = 0;
  #labels = 0;
  #sretV: VReg | undefined;
  #retVal: Val | undefined;
  frameBytes = 0;
  pushes = 0;
  outgoing = 0;

  /** Strict: this function can trap, so it keeps a frame on the shadow stack. */
  readonly #framed: boolean;

  constructor(
    source: TypedFunc,
    readonly inlineLoops = true,
    inlineCallSites = true,
  ) {
    this.fn = inlineCallSites ? inlineCalls(source) : source;
    this.#calls = new Map(this.fn.calls);
    this.#framed = mayTrapFn(this.fn);
  }

  #callee(name: string | undefined): TypedFunc {
    return (
      (name === undefined ? undefined : this.#calls.get(name)) ?? refuse(`unknown callee ${name}`)
    );
  }

  #emit(...lines: string[]): void {
    for (const l of lines) this.out.push(l.endsWith(':') ? l : `\t${l}`);
  }

  #label(): string {
    this.#labels += 1;
    return `.La0_${this.fn.name}_${this.#labels}`;
  }

  /** Run `f` with a fresh output buffer and return what it emitted. */
  #capture(f: () => void): string[] {
    const saved = this.out;
    this.out = [];
    f();
    const got = this.out;
    this.out = saved;
    return got;
  }

  // --- planning -------------------------------------------------------------------------

  #newV(name: string, size: 1 | 2 | 4, def: number, hints: (number | VReg)[] = []): VReg {
    const v: VReg = {
      name,
      size,
      wide: size === 4,
      def,
      end: def,
      used: false,
      forbid: new Set(),
      hints,
      zero: 0,
    };
    this.#vregs.push(v);
    return v;
  }

  /** Bytes of a loop counter known zero: it runs from 0 to at most a literal count. */
  #counterZero(count: Val): number {
    if (count.kind !== 'lit') return 0;
    let m = 0;
    for (let k = 0; k < 4; k += 1) if (count.value >>> (8 * k) === 0) m |= 1 << k;
    return m;
  }

  #aggAlloc(bytes: number): number {
    const rel = this.#aggSize;
    this.#aggSize += bytes;
    return rel;
  }

  /** Operand `o` of a node in scope `prefix` (the function, or an inlined body) with `params`. */
  #resolve(o: Operand, params: readonly Val[], prefix: string): Val {
    switch (o.kind) {
      case 'u32':
        return { kind: 'lit', value: o.value >>> 0, type: 'u32' };
      case 'bool':
        return { kind: 'lit', value: o.value ? 1 : 0, type: 'bool' };
      case 'param':
        return params[o.index] ?? refuse(`unknown parameter p${o.index}`);
      case 'node':
        return this.#vals.get(`n_${prefix}${o.id}`) ?? refuse(`unknown node ${o.id}`);
    }
  }

  /** Bytes of scalar `v` known to be zero. */
  #zeroOf(v: Val): number {
    if (v.kind === 'v') return v.v.zero;
    if (v.kind !== 'lit') return 0;
    let m = 0;
    for (let k = 0; k < bytesOf(v.type); k += 1) if (byteOf(v.value, k) === 0) m |= 1 << k;
    return m;
  }

  #use(val: Val, pos: number): void {
    const v = val.kind === 'v' ? val.v : val.kind === 'agg' ? val.base : undefined;
    if (v !== undefined) {
      v.end = Math.max(v.end, pos);
      v.used = true;
    } else if (val.kind === 'cmp') refuse('a fused compare has one consumer');
  }

  /** The register value `val` depends on: its own, or the pointer of an in-place aggregate. */
  #regOf(val: Val | undefined): VReg[] {
    if (val?.kind === 'v') return [val.v];
    if (val?.kind === 'agg' && val.base !== undefined) return [val.base];
    return [];
  }

  #plan(): void {
    const fn = this.fn;
    const sret = !isPrimitive(fn.result);
    const layout = argLayout(fn.params, sret);
    if (sret) {
      this.#sretV = this.#newV('sret', 2, 0, [24]);
      this.#sretV.arrival = 24;
    }
    // Aggregate parameters are read in place through their pointers (values are immutable,
    // and the result is written last), so nothing is copied on entry.
    fn.params.forEach((t, i) => {
      const reg = layout.slots[i]?.reg;
      const size = isPrimitive(t) ? (bytesOf(t) as 1 | 4) : 2;
      const v = this.#newV(`p${i}`, size, 0, reg === undefined ? [] : [reg]);
      if (reg !== undefined) v.arrival = reg;
      if (isPrimitive(t)) this.#vals.set(`p${i}`, { kind: 'v', v, type: t as Scalar });
      else this.#vals.set(`p${i}`, { kind: 'agg', rel: 0, type: t, base: v });
    });
    const params = fn.params.map((_, i) => this.#vals.get(`p${i}`) as Val);
    const ret = this.#planScope(fn, params, '', false);
    const RET = this.#pos + 2;
    this.#retVal = ret;
    this.#use(ret, RET);
    if (ret.kind === 'v') ret.v.hints.unshift(fn.result === 'bool' ? 24 : 22);
    if (this.#sretV !== undefined) {
      this.#sretV.end = RET;
      this.#sretV.used = true;
    }
    for (const v of this.#vregs) v.end = Math.max(v.end, v.def + 1);
    for (const c of this.#clobbers) {
      for (const v of this.#vregs)
        if (v.def < c.pos && c.pos < v.end) for (const r of c.set) v.forbid.add(r);
      for (const v of c.through) for (const r of c.set) v.forbid.add(r);
    }
  }

  /**
   * Plan the nodes of `f` (the function itself, or a body inlined into a loop under node-id
   * prefix `prefix`) with its parameters bound to `params`; returns its result. With
   * `branchRet`, a compare that is the last node and the result is fused into the branch
   * that consumes it.
   */
  #planScope(f: TypedFunc, params: readonly Val[], prefix: string, branchRet: boolean): Val {
    const nodes = f.nodes;
    // A compare whose only consumer is the next node's select condition is fused into it.
    const refs = new Map<string, number>();
    const count = (o: Operand): void => {
      if (o.kind === 'node') refs.set(o.id, (refs.get(o.id) ?? 0) + 1);
    };
    for (const n of nodes) for (const o of n.args) count(o);
    count(f.ret);
    const clobbers = this.#clobbers;
    nodes.forEach((n, i) => {
      const t = f.types.get(n.id) ?? refuse(`untyped node ${n.id}`);
      if (!isPrimitive(t) && bytesOf(t) > AVR_AGGREGATE_MAX_BYTES)
        refuse(
          `node ${n.id} is a ${bytesOf(t)}-byte aggregate; the limit is ${AVR_AGGREGATE_MAX_BYTES} bytes of the ATmega328P's 2 KiB SRAM`,
          'limit',
        );
      const id = `${prefix}${n.id}`;
      const key = `n_${id}`;
      this.#pos += 2;
      const pos = this.#pos;
      let op = n.op;
      let vals = n.args.map((o) => this.#resolve(o, params, prefix));
      // Power-of-two literals: mul becomes shl, div shr, rem and.
      const [x, y] = vals as [Val, Val];
      if (op === 'mul' && x.kind === 'lit' && isPow2(x.value)) vals = [y, x];
      const [a0, b0] = vals as [Val, Val];
      if ((op === 'mul' || op === 'div' || op === 'rem') && b0.kind === 'lit' && isPow2(b0.value)) {
        vals =
          op === 'rem'
            ? [a0, { kind: 'lit', value: b0.value - 1, type: 'u32' }]
            : [a0, { kind: 'lit', value: log2(b0.value), type: 'u32' }];
        op = op === 'mul' ? 'shl' : op === 'div' ? 'shr' : 'and';
      }
      const [a, b] = vals as [Val, Val];
      const next = nodes[i + 1];
      const fused =
        COMPARES.has(op) &&
        refs.get(n.id) === 1 &&
        ((next !== undefined &&
          next.op === 'select' &&
          next.args[0]?.kind === 'node' &&
          next.args[0].id === n.id &&
          isPrimitive(f.types.get(next.id) ?? 'io') &&
          f.types.get(next.id) !== 'io') ||
          (branchRet && next === undefined && f.ret.kind === 'node' && f.ret.id === n.id));
      const inner = prefix === '' ? {} : { inner: true };
      const site = siteOf(f, n);
      this.#planned.push({
        id,
        op,
        vals,
        type: t,
        callee: n.callee,
        pred: n.pred,
        fused,
        ...(site === undefined ? {} : { site }),
        ...inner,
      });
      const scalar = (hints: (number | VReg)[] = [], def = pos): VReg => {
        const v = this.#newV(key, bytesOf(t) as 1 | 4, def, hints);
        this.#vals.set(key, { kind: 'v', v, type: t as Scalar });
        return v;
      };
      const fresh = (): void => {
        if (isPrimitive(t)) scalar();
        else this.#vals.set(key, { kind: 'agg', rel: this.#aggAlloc(bytesOf(t)), type: t });
      };
      const vOf = (v: Val | undefined): VReg[] => (v?.kind === 'v' ? [v.v] : []);
      const useAll = (): void => {
        for (const v of vals) this.#use(v, pos);
      };
      switch (op) {
        case 'mov':
          this.#vals.set(key, a);
          return;
        case 'eq':
        case 'ne':
        case 'lt':
        case 'le':
        case 'gt':
        case 'ge':
          if (fused) {
            // `and x 2^k` compared with zero, used only here: a bit test through the T flag.
            const [p, q] = a.kind === 'lit' ? [b, a] : [a, b];
            const cand = p.kind === 'v' ? this.#bitCandidates.get(p.v) : undefined;
            if (
              (op === 'eq' || op === 'ne') &&
              q.kind === 'lit' &&
              q.value === 0 &&
              cand !== undefined &&
              cand.prefix === prefix &&
              refs.get(cand.id) === 1 &&
              n.args.some((o) => o.kind === 'node' && o.id === cand.id) &&
              this.#planned.slice(cand.index + 1).every((m) => m.bit === undefined)
            ) {
              const and = this.#planned[cand.index] as Planned;
              this.#planned[cand.index] = { ...and, bit: { x: cand.x, bit: cand.bit } };
              this.#vals.set(key, { kind: 'cmp', op, a, b, t: op === 'eq' ? 'tc' : 'ts' });
              return;
            }
            this.#vals.set(key, { kind: 'cmp', op, a, b });
            this.#use(a, pos + 2);
            this.#use(b, pos + 2);
            return;
          }
          scalar();
          useAll();
          return;
        case 'add':
        case 'and':
        case 'or':
        case 'xor': {
          const v = scalar([...vOf(a), ...vOf(b)]);
          const za = this.#zeroOf(a);
          const zb = this.#zeroOf(b);
          v.zero = op === 'and' ? za | zb : op === 'add' ? 0 : za & zb;
          const [m, x] = a.kind === 'lit' ? [a, b] : [b, a];
          if (op === 'and' && m.kind === 'lit' && isPow2(m.value) && x.kind === 'v')
            this.#bitCandidates.set(v, {
              id: n.id,
              prefix,
              index: this.#planned.length - 1,
              x,
              bit: log2(m.value),
            });
          useAll();
          return;
        }
        case 'sub':
        case 'shl':
        case 'shr': {
          const v = scalar(vOf(a));
          if (op !== 'sub' && b.kind === 'lit') {
            const bytes = (b.value & 31) >> 3;
            v.zero = op === 'shl' ? (1 << bytes) - 1 : (0xf0 >> bytes) & 0xf;
          }
          useAll();
          return;
        }
        case 'mul':
        case 'div':
        case 'rem':
          scalar([22]);
          useAll();
          clobbers.push({ pos, set: SCRATCH, through: [] });
          return;
        case 'select': {
          const [, sx, sy] = vals as [Val, Val, Val];
          if (isPrimitive(t))
            scalar([...vOf(sx), ...vOf(sy)]).zero = this.#zeroOf(sx) & this.#zeroOf(sy);
          else fresh();
          if (a.kind !== 'cmp') this.#use(a, pos);
          this.#use(sx, pos);
          this.#use(sy, pos);
          return;
        }
        case 'arr':
        case 'rec':
          fresh();
          useAll();
          return;
        case 'get':
        case 'at': {
          if (a.kind !== 'agg') refuse(`${op} needs an aggregate`);
          const at0 = a.type;
          if (isPrimitive(at0)) refuse(`${op} needs an aggregate`);
          if (b.kind === 'lit') {
            const off =
              at0.kind === 'arr'
                ? (b.value % at0.length) * bytesOf(at0.elem)
                : at0.fields.slice(0, b.value).reduce((s, f) => s + bytesOf(f), 0);
            if (!isPrimitive(t)) this.#vals.set(key, { ...a, rel: a.rel + off, type: t });
            else {
              scalar();
              this.#use(a, pos);
            }
            return;
          }
          if (op === 'at' || at0.kind !== 'arr') refuse('at needs a literal field');
          fresh();
          this.#use(a, pos);
          this.#use(b, pos);
          if (!isPow2(at0.length) && site !== 'bounds')
            clobbers.push({ pos, set: SCRATCH, through: this.#regOf(a) });
          return;
        }
        case 'set':
        case 'put': {
          if (a.kind !== 'agg' || isPrimitive(a.type)) refuse(`${op} needs an aggregate`);
          fresh();
          useAll();
          if (
            op === 'set' &&
            a.type.kind === 'arr' &&
            b.kind !== 'lit' &&
            !isPow2(a.type.length) &&
            site !== 'bounds'
          )
            clobbers.push({ pos, set: SCRATCH, through: this.#regOf(vals[2]) });
          return;
        }
        // The checked ops: a (u32,bool) record in the frame, built through r18-r27, r30, r31.
        case 'cadd':
        case 'csub':
        case 'cmul':
        case 'cdiv':
        case 'crem':
        case 'cget':
          fresh();
          useAll();
          // The multiply is checked by dividing its product back: both operands are read again.
          if (op === 'cmul') {
            this.#use(a, pos + 1);
            this.#use(b, pos + 1);
          }
          clobbers.push({ pos, set: SCRATCH, through: op === 'cget' ? this.#regOf(a) : [] });
          return;
        case 'call': {
          const callee = this.#callee(n.callee);
          if (isPrimitive(t)) scalar([t === 'bool' ? 24 : 22]);
          else fresh();
          const cl = argLayout(callee.params, !isPrimitive(callee.result));
          vals.forEach((v, k) => {
            const r = cl.slots[k]?.reg;
            if (r !== undefined) for (const u of this.#regOf(v)) u.hints.push(r);
          });
          useAll();
          const regs = argRegisters(callee);
          for (const r of regs) if (r < 18) this.#saved.add(r);
          clobbers.push({ pos, set: [...SCRATCH, ...regs.filter((r) => r < 18)], through: [] });
          return;
        }
        case 'fold':
        case 'loop': {
          const body = this.#callee(n.callee);
          const pred = n.pred === undefined ? undefined : this.#callee(n.pred);
          const [count, init, ...extras] = vals as [Val, Val, ...Val[]];
          const bodyI = inlineCalls(body);
          const predI = pred === undefined ? undefined : inlineCalls(pred);
          if (this.inlineLoops && prefix === '' && isPrimitive(t) && inlineBody(bodyI, predI)) {
            // The predicate and body are planned in place between the loop head and the latch;
            // state, counter, count and extras stay live across the whole loop (the back edge).
            this.#inlinedLoops += 1;
            for (const g of [bodyI, ...(predI === undefined ? [] : [predI])])
              for (const [name, h] of g.calls) this.#calls.set(name, h);
            const s = scalar([], pos - 1);
            this.#state.set(id, s);
            const counter = this.#newV(`i_${id}`, 4, pos - 1);
            counter.zero = this.#counterZero(count);
            counter.used = true;
            this.#counters.set(id, counter);
            this.#use(init, pos);
            const index = this.#planned.length - 1;
            const bound: Val[] = [
              { kind: 'v', v: s, type: t as Scalar },
              { kind: 'v', v: counter, type: 'u32' },
              ...extras,
            ];
            const predFrom = this.#planned.length;
            const predRet =
              predI === undefined ? undefined : this.#planScope(predI, bound, `${id}.p.`, true);
            if (predRet !== undefined && predRet.kind !== 'cmp') this.#use(predRet, this.#pos + 1);
            const bodyFrom = this.#planned.length;
            const bodyRet = this.#planScope(bodyI, bound, `${id}.b.`, false);
            const bodyTo = this.#planned.length;
            this.#pos += 2;
            const latch = this.#pos;
            // The body's result may take the state's registers once the state is last read.
            if (
              bodyRet.kind === 'v' &&
              bodyRet.v !== s &&
              bodyRet.v.def > pos &&
              bodyRet.v.def >= s.end
            )
              bodyRet.v.coalesce = s;
            this.#use(bodyRet, latch);
            for (const v of [count, ...extras]) this.#use(v, latch + 1);
            s.end = Math.max(s.end, latch + 1);
            counter.end = latch + 1;
            const head = this.#planned[index] as Planned;
            this.#planned[index] = {
              ...head,
              inl: { predFrom, bodyFrom, bodyTo, predRet, bodyRet },
            };
            return;
          }
          const through: VReg[] = [];
          if (isPrimitive(t)) {
            const s = scalar([], pos - 1);
            this.#state.set(id, s);
            through.push(s);
          } else fresh();
          const counter = this.#newV(`i_${id}`, 4, pos - 1);
          counter.zero = this.#counterZero(vals[0] as Val);
          counter.end = pos;
          counter.used = true;
          this.#counters.set(id, counter);
          through.push(counter);
          useAll();
          through.push(...this.#regOf(vals[0]), ...extras.flatMap((e) => this.#regOf(e)));
          const regs = [...argRegisters(body), ...(pred === undefined ? [] : argRegisters(pred))];
          for (const r of regs) if (r < 18) this.#saved.add(r);
          clobbers.push({ pos, set: [...SCRATCH, ...regs.filter((r) => r < 18)], through });
          return;
        }
        case 'read':
        case 'write':
        case 'puts':
          refuse(`${op} is an io operation`);
      }
    });
    return this.#resolve(f.ret, params, prefix);
  }

  /** Linear scan in definition order: a hinted, then a free register group, else a spill slot. */
  #allocate(): void {
    // A u32 whose high bytes are known zero keeps only its low bytes in registers.
    for (const v of this.#vregs) {
      if (!v.wide) continue;
      let live = 0;
      for (let k = 0; k < 4; k += 1) if (!((v.zero >> k) & 1)) live = k + 1;
      v.size = live <= 1 ? 1 : live === 2 ? 2 : 4;
    }
    const order = [...this.#vregs].sort((x, y) => x.def - y.def);
    const done: VReg[] = [];
    for (const v of order) {
      const busy = new Set<number>();
      const others = new Set<number>();
      const slots: { off: number; size: number; exact?: boolean }[] = [];
      for (const u of done) {
        if (!(u.def < v.end && v.def < u.end) || u.home === undefined) continue;
        if (u.home.kind === 'reg')
          for (let k = 0; k < u.size; k += 1) {
            busy.add(u.home.r + k);
            if (u !== v.coalesce) others.add(u.home.r + k);
          }
        else slots.push({ off: u.home.off, size: u.size });
      }
      const starts = STARTS[v.size];
      // Operands dying where v is defined may share its registers only exactly (u32 byte
      // sequences read operand byte k after writing result byte j < k).
      const dying = done.filter(
        (u) => u.end === v.def && u.wide && v.wide && u.home?.kind === 'reg',
      );
      const fits = (r: number): boolean => {
        if (v.size === 4 ? r % 2 !== 0 || r < 2 || r > 22 : !starts.includes(r)) return false;
        for (let k = 0; k < v.size; k += 1)
          if (busy.has(r + k) || v.forbid.has(r + k)) return false;
        for (const u of dying) {
          const ur = (u.home as { r: number }).r;
          if (r !== ur && r < ur + u.size && ur < r + v.size) return false;
        }
        return true;
      };
      const hinted = v.hints.map((h) =>
        typeof h === 'number' ? h : h.home?.kind === 'reg' ? h.home.r : -1,
      );
      // Registers that cost nothing: caller-saved, already saved, or where a parameter arrived.
      const cheap = (r: number): boolean =>
        r === v.arrival ||
        Array.from({ length: v.size }, (_, k) => r + k).every((q) => q >= 18 || this.#saved.has(q));
      // A loop body result takes its state's registers when nothing else holds them.
      const co = v.coalesce?.home;
      const merged =
        co?.kind === 'reg' &&
        v.size <= (v.coalesce as VReg).size &&
        Array.from({ length: v.size }, (_, k) => co.r + k).every(
          (q) => !others.has(q) && !v.forbid.has(q),
        )
          ? co.r
          : undefined;
      const r =
        merged ??
        [...hinted.filter(cheap), ...starts.filter(cheap), ...hinted, ...starts].find(fits);
      if (r !== undefined) v.home = { kind: 'reg', r };
      else {
        // Slots of operands dying here are shared only exactly, as registers are.
        for (const u of done)
          if (u.end === v.def && u.home?.kind === 'slot')
            slots.push({ off: u.home.off, size: u.size, exact: true });
        let off = 1;
        for (;;) {
          const clash = slots.find(
            (s) => off < s.off + s.size && s.off < off + v.size && !(s.exact && s.off === off),
          );
          if (clash === undefined) break;
          off = clash.off + clash.size;
        }
        this.#spillSize = Math.max(this.#spillSize, off + v.size - 1);
        v.home = { kind: 'slot', off };
      }
      done.push(v);
      // A callee-saved register is saved only when written: a parameter left where it arrived is not.
      if (v.home.kind === 'reg' && v.home.r !== v.arrival)
        for (let k = 0; k < v.size; k += 1) if (v.home.r + k < 18) this.#saved.add(v.home.r + k);
    }
    // Spills past Y+63: a reload area at Y+1 stages a node's far operands and result, so
    // every operation addresses its scalars from Y.
    if (this.#spillSize > 63) {
      if (this.#inlinedLoops > 0) throw new FarSpill();
      let area = 0;
      for (const n of this.#planned)
        area = Math.max(
          area,
          this.#touched(n).reduce((s, v) => s + v.size, 0),
        );
      for (const v of this.#vregs)
        if (v.home?.kind === 'slot') v.home = { kind: 'slot', off: v.home.off + area };
      this.#spillSize += area;
    }
  }

  /** Scalar registers node `n` reads or writes (operands, result, loop counter). */
  #touched(n: Planned): VReg[] {
    const seen = new Set<VReg>();
    const add = (x: Val | undefined): void => {
      if (x?.kind === 'v') seen.add(x.v);
      else if (x?.kind === 'agg' && x.base !== undefined) seen.add(x.base);
      else if (x?.kind === 'cmp') {
        add(x.a);
        add(x.b);
      }
    };
    for (const x of n.vals) add(x);
    if (n.op !== 'mov') add(this.#vals.get(`n_${n.id}`));
    const c = this.#counters.get(n.id);
    if (c !== undefined) seen.add(c);
    return [...seen];
  }

  #far(v: VReg): boolean {
    return v.home?.kind === 'slot' && v.home.off + v.size - 1 > 63;
  }

  /** Emit node `n`, staging far-slot operands into the reload area and far results back out. */
  #nodeStaged(n: Planned): void {
    const far = this.#touched(n).filter((v) => this.#far(v));
    if (n.fused || far.length === 0) {
      this.#node(n);
      return;
    }
    const map = new Map<VReg, VReg>();
    let next = 1;
    for (const v of far) {
      map.set(v, { ...v, home: { kind: 'slot', off: next }, forbid: new Set(), hints: [] });
      next += v.size;
    }
    const sub = (x: Val): Val => {
      if (x.kind === 'v') return { ...x, v: map.get(x.v) ?? x.v };
      if (x.kind === 'agg' && x.base !== undefined)
        return { ...x, base: map.get(x.base) ?? x.base };
      if (x.kind === 'cmp') return { ...x, a: sub(x.a), b: sub(x.b) };
      return x;
    };
    const key = `n_${n.id}`;
    const self = this.#vals.get(key);
    const result = self?.kind === 'v' && n.op !== 'mov' ? self.v : undefined;
    const counter = this.#counters.get(n.id);
    const state = this.#state.get(n.id);
    const copy = (v: VReg, out: boolean): void => {
      const far0 = (this.#home(v) as { off: number }).off;
      const near = (this.#home(map.get(v) as VReg) as { off: number }).off;
      this.#pointer(30, far0);
      for (let k = 0; k < v.size; k += 1)
        this.#emit(
          ...(out
            ? [`ldd r0, Y+${near + k}`, `std Z+${k}, r0`]
            : [`ldd r0, Z+${k}`, `std Y+${near + k}, r0`]),
        );
    };
    for (const v of far) if (v !== result && v !== counter) copy(v, false);
    const swap = <K, V>(m: Map<K, V>, k: K, v: V | undefined): void => {
      if (v !== undefined) m.set(k, v);
    };
    if (self !== undefined && self.kind !== 'agg') swap(this.#vals, key, sub(self));
    if (state !== undefined) swap(this.#state, n.id, map.get(state));
    if (counter !== undefined) swap(this.#counters, n.id, map.get(counter));
    const bit = n.bit === undefined ? undefined : { ...n.bit, x: sub(n.bit.x) };
    this.#node({ ...n, vals: n.vals.map(sub), ...(bit === undefined ? {} : { bit }) });
    if (self !== undefined) this.#vals.set(key, self);
    if (state !== undefined) this.#state.set(n.id, state);
    if (counter !== undefined) this.#counters.set(n.id, counter);
    if (result !== undefined && map.has(result)) copy(result, true);
  }

  // --- values and moves -----------------------------------------------------------------

  #home(v: VReg): Home {
    return v.home ?? refuse(`no home for ${v.name}`);
  }

  #abs(rel: number): number {
    return 1 + this.#spillSize + rel;
  }

  #scalar(v: Val): Exclude<Val, { kind: 'agg' } | { kind: 'cmp' }> {
    if (v.kind === 'agg' || v.kind === 'cmp') refuse('expected a scalar');
    return v;
  }

  /** A register name holding byte `k` of scalar `v`, loading into `tmp` (r16-r31) if needed; flags are kept. */
  #byte(v0: Val, k: number, tmp: number): string {
    const v = this.#scalar(v0);
    if (v.kind === 'lit') {
      const b = byteOf(v.value, k);
      if (b === 0) return 'r1';
      this.#emit(`ldi r${tmp}, ${b}`);
      return `r${tmp}`;
    }
    if ((v.v.zero >> k) & 1) return 'r1';
    const h = this.#home(v.v);
    if (h.kind === 'reg') return `r${h.r + k}`;
    this.#emit(`ldd r${tmp}, Y+${h.off + k}`);
    return `r${tmp}`;
  }

  #src(v0: Val, k: number): BSrc {
    const v = this.#scalar(v0);
    if (v.kind === 'lit') return { k: 'lit', b: byteOf(v.value, k) };
    if ((v.v.zero >> k) & 1) return { k: 'lit', b: 0 };
    const h = this.#home(v.v);
    return h.kind === 'reg' ? { k: 'r', r: h.r + k } : { k: 'slot', off: h.off + k };
  }

  #dst(h: Home, k: number): BDst {
    return h.kind === 'reg' ? { k: 'r', r: h.r + k } : { k: 'slot', off: h.off + k };
  }

  #sameHome(h: Home, v: Val): boolean {
    if (v.kind !== 'v') return false;
    const g = this.#home(v.v);
    return (
      g.kind === h.kind &&
      (h.kind === 'reg' ? g.kind === 'reg' && g.r === h.r : g.kind === 'slot' && g.off === h.off)
    );
  }

  /** Moves done as if at once: register cycles break through r0; only mov/movw/ldi/ldd/std, so flags survive. */
  #parallel(moves: readonly Move[], litTmp = 26): void {
    // A slot past Y+63 goes through Z (only outside operations: entry, return, calls).
    let zbase: number | undefined;
    const ref = (off: number): string => {
      if (off <= 63) return `Y+${off}`;
      if (zbase === undefined || off < zbase || off - zbase > 63) {
        this.#pointer(30, off);
        zbase = off;
      }
      return `Z+${off - zbase}`;
    };
    const pend: { d: BDst; s: number }[] = [];
    const rest: Move[] = [];
    for (const m of moves) {
      if (m.s.k !== 'r') rest.push(m);
      else if (!(m.d.k === 'r' && m.d.r === m.s.r)) pend.push({ d: m.d, s: m.s.r });
    }
    const readBy = (r: number, except: object): boolean =>
      pend.some((p) => p !== except && p.s === r);
    while (pend.length > 0) {
      const p = pend.find((q) => q.d.k === 'slot' || !readBy(q.d.r, q));
      if (p === undefined) {
        const first = pend[0] as { d: BDst; s: number };
        const r = (first.d as { r: number }).r;
        this.#emit(`mov r0, r${r}`);
        for (const q of pend) if (q.s === r) q.s = 0;
        continue;
      }
      pend.splice(pend.indexOf(p), 1);
      if (p.d.k === 'slot') {
        this.#emit(`std ${ref(p.d.off)}, r${p.s}`);
        continue;
      }
      const d = p.d.r;
      if (d % 2 === 0 && p.s % 2 === 0) {
        const q = pend.find((m) => m.d.k === 'r' && m.d.r === d + 1 && m.s === p.s + 1);
        if (q !== undefined && !readBy(d + 1, q)) {
          pend.splice(pend.indexOf(q), 1);
          this.#emit(`movw r${d}, r${p.s}`);
          continue;
        }
      }
      this.#emit(`mov r${d}, r${p.s}`);
    }
    let cached: number | undefined;
    const lit = (b: number): string => {
      if (b === 0) return 'r1';
      if (cached !== b) this.#emit(`ldi r${litTmp}, ${b}`);
      cached = b;
      return `r${litTmp}`;
    };
    for (const m of rest) {
      if (m.s.k === 'lit') {
        if (m.d.k === 'r' && m.d.r >= 16 && m.s.b !== 0) this.#emit(`ldi r${m.d.r}, ${m.s.b}`);
        else if (m.d.k === 'r') this.#emit(`mov r${m.d.r}, ${lit(m.s.b)}`);
        else this.#emit(`std ${ref(m.d.off)}, ${lit(m.s.b)}`);
      } else if (m.s.k === 'slot') {
        if (m.d.k === 'r') this.#emit(`ldd r${m.d.r}, ${ref(m.s.off)}`);
        else {
          this.#emit(`ldd r0, ${ref(m.s.off)}`);
          this.#emit(`std ${ref(m.d.off)}, r0`);
        }
      }
    }
  }

  /** Scalar `s` into home `d`. */
  #move(d: Home, size: number, s: Val, litTmp = 26, skip = 0): void {
    const moves: Move[] = [];
    for (let k = 0; k < size; k += 1)
      if (!((skip >> k) & 1)) moves.push({ d: this.#dst(d, k), s: this.#src(s, k) });
    this.#parallel(moves, litTmp);
  }

  /** Registers `regs` into home `d`. */
  #fromRegs(d: Home, regs: readonly number[]): void {
    this.#parallel(regs.map((r, k) => ({ d: this.#dst(d, k), s: { k: 'r', r } })));
  }

  // --- frame memory ---------------------------------------------------------------------

  /** r(pair):r(pair+1) = Y + off. */
  #pointer(pair: 26 | 30, off: number): void {
    this.#emit(`movw r${pair}, r28`);
    if (off === 0) return;
    if (off <= 63) this.#emit(`adiw r${pair}, ${off}`);
    else this.#emit(`subi r${pair}, ${lo(neg16(off))}`, `sbci r${pair + 1}, ${hi(neg16(off))}`);
  }

  /** Base register and displacement reaching frame bytes [off, off+n): Y when near, else Z. */
  #frame(off: number, n: number): { base: string; disp: number } {
    if (off + n - 1 <= 63) return { base: 'Y', disp: off };
    this.#pointer(30, off);
    return { base: 'Z', disp: 0 };
  }

  #loadFrame(d: Home, size: number, off: number): void {
    const m = this.#frame(off, size);
    for (let k = 0; k < size; k += 1) {
      if (d.kind === 'reg') this.#emit(`ldd r${d.r + k}, ${m.base}+${m.disp + k}`);
      else this.#emit(`ldd r0, ${m.base}+${m.disp + k}`, `std Y+${d.off + k}, r0`);
    }
  }

  #storeFrame(off: number, v: Val): void {
    const size = bytesOf(this.#scalar(v).type);
    const m = this.#frame(off, size);
    for (let k = 0; k < size; k += 1)
      this.#emit(`std ${m.base}+${m.disp + k}, ${this.#byte(v, k, 26)}`);
  }

  /** r1 = n (1-255), the counter of a copy loop; r1 returns to zero when the loop ends. */
  #counter(n: number, tmp: 26 | 30): void {
    this.#emit(`ldi r${tmp}, ${n}`, `mov r1, r${tmp}`);
  }

  /** X = source, Z = destination, r1 = count already set. */
  #copyLoop(): void {
    const top = this.#label();
    this.#emit(`${top}:`, 'ld r0, X+', 'st Z+, r0', 'dec r1', `brne ${top}`);
  }

  /** Copy `n` bytes between frame offsets. */
  #copy(dst: number, src: number, n: number): void {
    if (dst === src || n === 0) return;
    if (n <= 8 && dst + n - 1 <= 63 && src + n - 1 <= 63) {
      for (let k = 0; k < n; k += 1) this.#emit(`ldd r0, Y+${src + k}`, `std Y+${dst + k}, r0`);
      return;
    }
    this.#counter(n, 26);
    this.#pointer(26, src);
    this.#pointer(30, dst);
    this.#copyLoop();
  }

  /** Place value `v` of any type at frame offset `off`. */
  #place(v: Val, off: number): void {
    if (v.kind !== 'agg') {
      this.#storeFrame(off, v);
      return;
    }
    const n = bytesOf(v.type);
    if (v.base === undefined) {
      this.#copy(off, this.#abs(v.rel), n);
      return;
    }
    if (n <= 8 && off + n - 1 <= 63) {
      this.#aggPtr(26, v);
      for (let k = 0; k < n; k += 1) this.#emit('ld r0, X+', `std Y+${off + k}, r0`);
      return;
    }
    this.#counter(n, 26);
    this.#aggPtr(26, v);
    this.#pointer(30, off);
    this.#copyLoop();
  }

  /** r(pair) = the address of byte `extra` of aggregate `v` (a frame slot, or in place through its pointer). */
  #aggPtr(pair: 26 | 30, v: Val, extra = 0): void {
    if (v.kind !== 'agg') refuse('expected an aggregate');
    if (v.base === undefined) {
      this.#pointer(pair, this.#abs(v.rel) + extra);
      return;
    }
    const h = this.#home(v.base);
    if (h.kind === 'reg') this.#emit(`movw r${pair}, r${h.r}`);
    else if (h.off + 1 <= 63)
      this.#emit(`ldd r${pair}, Y+${h.off}`, `ldd r${pair + 1}, Y+${h.off + 1}`);
    else {
      this.#pointer(30, h.off);
      this.#emit('ldd r0, Z+0', `ldd r${pair + 1}, Z+1`, `mov r${pair}, r0`);
    }
    const off = v.rel + extra;
    if (off === 0) return;
    if (off <= 63) this.#emit(`adiw r${pair}, ${off}`);
    else this.#emit(`subi r${pair}, ${lo(neg16(off))}`, `sbci r${pair + 1}, ${hi(neg16(off))}`);
  }

  // --- operations -----------------------------------------------------------------------

  /** d = a op b over `w` bytes for add, sub, and, or, xor. */
  #bytewise(op: Op, d: Home, a0: Val, b0: Val, w: number, dz: number): void {
    let a = a0;
    let b = b0;
    const comm = op !== 'sub';
    if (comm && a.kind === 'lit' && b.kind !== 'lit') [a, b] = [b, a];
    if (comm && this.#sameHome(d, b) && !this.#sameHome(d, a)) [a, b] = [b, a];
    if (d.kind === 'reg' && this.#sameHome(d, b) && !this.#sameHome(d, a)) {
      // sub into the subtrahend's own registers.
      if (a.kind === 'lit') {
        // c - x = ~x + (c + 1)
        this.#move(d, w, b);
        for (let k = 0; k < w; k += 1) this.#emit(`com r${d.r + k}`);
        const self: VReg = {
          name: 'self',
          size: 4,
          wide: true,
          def: 0,
          end: 0,
          used: true,
          home: d,
          forbid: new Set(),
          hints: [],
          zero: 0,
        };
        const c1 = (a.value + 1) >>> 0;
        if (c1 !== 0)
          this.#bytewise(
            'add',
            d,
            { kind: 'v', v: self, type: 'u32' },
            { kind: 'lit', value: c1, type: 'u32' },
            w,
            0,
          );
        return;
      }
      for (let k = 0; k < w; k += 1) {
        const ak = this.#byte(a, k, 26);
        if (ak !== 'r26') this.#emit(`mov r26, ${ak}`);
        this.#emit(
          `${k === 0 ? 'sub' : 'sbc'} r26, ${this.#byte(b, k, 27)}`,
          `mov r${d.r + k}, r26`,
        );
      }
      return;
    }
    const inReg = d.kind === 'reg';
    if (inReg) this.#move(d, w, a, 26, dz);
    const work = (k: number): number => {
      if (inReg) return d.r + k;
      const ak = this.#byte(a, k, 26);
      if (ak !== 'r26') this.#emit(`mov r26, ${ak}`);
      return 26;
    };
    const flush = (k: number, r: number): void => {
      if (!inReg) this.#emit(`std Y+${d.off + k}, r${r}`);
    };
    const keep = (k: number): void => {
      if (!inReg) flush(k, work(k));
    };
    const lit = b.kind === 'lit' ? b.value : undefined;
    if (op === 'and' || op === 'or' || op === 'xor') {
      const mn = op === 'xor' ? 'eor' : op;
      for (let k = 0; k < w; k += 1) {
        if ((dz >> k) & 1) continue;
        if (lit === undefined && op !== 'and' && (this.#zeroOf(b) >> k) & 1) {
          keep(k);
          continue;
        }
        if (lit === undefined) {
          const r = work(k);
          this.#emit(`${mn} r${r}, ${this.#byte(b, k, 27)}`);
          flush(k, r);
          continue;
        }
        const bk = byteOf(lit, k);
        if ((op === 'and' && bk === 0xff) || (op !== 'and' && bk === 0)) {
          keep(k);
          continue;
        }
        if (op === 'and' && bk === 0) {
          this.#emit(inReg ? `mov r${d.r + k}, r1` : `std Y+${d.off + k}, r1`);
          continue;
        }
        if (op === 'or' && bk === 0xff) {
          const r = inReg ? d.r + k : 26;
          if (r >= 16) this.#emit(`ldi r${r}, 255`);
          else this.#emit('ldi r27, 255', `mov r${r}, r27`);
          flush(k, r);
          continue;
        }
        const r = work(k);
        if (op === 'xor' && bk === 0xff) this.#emit(`com r${r}`);
        else if (r >= 16 && op !== 'xor')
          this.#emit(`${op === 'and' ? 'andi' : 'ori'} r${r}, ${bk}`);
        else this.#emit(`ldi r27, ${bk}`, `${mn} r${r}, r27`);
        flush(k, r);
      }
      return;
    }
    // add / sub on the carry chain
    if (lit === undefined) {
      for (let k = 0; k < w; k += 1) {
        const r = work(k);
        const mn = op === 'add' ? (k === 0 ? 'add' : 'adc') : k === 0 ? 'sub' : 'sbc';
        this.#emit(`${mn} r${r}, ${this.#byte(b, k, 27)}`);
        flush(k, r);
      }
      return;
    }
    let f = 0;
    while (f < w && byteOf(lit, f) === 0) f += 1;
    for (let k = 0; k < f; k += 1) keep(k);
    if (f === w) return;
    let imm = true;
    if (inReg) for (let k = f; k < w; k += 1) if (d.r + k < 16) imm = false;
    const c = op === 'add' ? -lit >>> 0 : lit;
    for (let k = f; k < w; k += 1) {
      const r = work(k);
      if (imm) this.#emit(`${k === f ? 'subi' : 'sbci'} r${r}, ${byteOf(c, k)}`);
      else {
        const bk = byteOf(lit, k);
        const s = bk === 0 ? 'r1' : 'r27';
        if (bk !== 0) this.#emit(`ldi r27, ${bk}`);
        const mn = op === 'add' ? (k === f ? 'add' : 'adc') : k === f ? 'sub' : 'sbc';
        this.#emit(`${mn} r${r}, ${s}`);
      }
      flush(k, r);
    }
  }

  /** Compare for `op`; returns the condition (lo, sh, eq, ne) that is true when the compare holds. */
  #cmp(op: Op, a: Val, b: Val): string {
    let [x, y, cond] =
      op === 'lt'
        ? [a, b, 'lo']
        : op === 'ge'
          ? [a, b, 'sh']
          : op === 'gt'
            ? [b, a, 'lo']
            : op === 'le'
              ? [b, a, 'sh']
              : [a, b, op];
    if ((cond === 'eq' || cond === 'ne') && x.kind === 'lit' && y.kind !== 'lit') [x, y] = [y, x];
    const w = bytesOf(this.#scalar(x).type);
    // Bytes zero in both operands leave every flag of the chain as the lower bytes set it.
    const both = this.#zeroOf(x) & this.#zeroOf(y);
    let first = true;
    for (let k = 0; k < w; k += 1) {
      if ((both >> k) & 1) continue;
      const xk = this.#byte(x, k, 26);
      if (first && y.kind === 'lit' && xk !== 'r1' && Number(xk.slice(1)) >= 16)
        this.#emit(`cpi ${xk}, ${byteOf(y.value, k)}`);
      else this.#emit(`${first ? 'cp' : 'cpc'} ${xk}, ${this.#byte(y, k, 27)}`);
      first = false;
    }
    if (first) this.#emit('cp r1, r1');
    return cond;
  }

  /** d = (condition holds) as 0 or 1, without branches for lo/sh. */
  #setBool(d: Home, cond: string): void {
    const r = d.kind === 'reg' ? d.r : 26;
    if (cond === 'lo') this.#emit(`mov r${r}, r1`, `rol r${r}`);
    else if (cond === 'sh') this.#emit(`sbc r${r}, r${r}`, `inc r${r}`);
    else {
      const skip = this.#label();
      this.#emit(`mov r${r}, r1`, `br${INVERSE[cond]} ${skip}`, `inc r${r}`, `${skip}:`);
    }
    if (d.kind === 'slot') this.#emit(`std Y+${d.off}, r26`);
  }

  /** Test condition `c` (a fused compare or a bool); returns the branch condition for true. */
  #test(c: Val): string {
    if (c.kind === 'cmp') return c.t ?? this.#cmp(c.op, c.a, c.b);
    this.#emit(`tst ${this.#byte(c, 0, 26)}`);
    return 'ne';
  }

  #select(d: Home, size: number, c: Val, x: Val, y: Val, dz: number): void {
    if (c.kind === 'lit') {
      this.#move(d, size, c.value !== 0 ? x : y, 26, dz);
      return;
    }
    const same =
      (x.kind === 'v' && y.kind === 'v' && x.v === y.v) ||
      (x.kind === 'lit' && y.kind === 'lit' && x.value === y.value);
    if (same) {
      this.#move(d, size, x, 26, dz);
      return;
    }
    const cond = this.#test(c);
    const skip = this.#label();
    if (this.#sameHome(d, x)) {
      // d keeps x when the condition holds: x's known-zero bytes the result needs become real.
      const zx = this.#zeroOf(x) & ~dz;
      for (let k = 0; k < size; k += 1)
        if ((zx >> k) & 1)
          this.#emit(d.kind === 'reg' ? `mov r${d.r + k}, r1` : `std Y+${d.off + k}, r1`);
      this.#emit(`br${cond} ${skip}`);
      this.#move(d, size, y, 26, dz);
    } else {
      this.#move(d, size, y, 26, dz);
      this.#emit(`br${INVERSE[cond]} ${skip}`);
      this.#move(d, size, x, 26, dz);
    }
    this.#emit(`${skip}:`);
  }

  #shift(d: Home, a: Val, b: Val, left: boolean): void {
    const inReg = d.kind === 'reg';
    const W = inReg ? [d.r, d.r + 1, d.r + 2, d.r + 3] : T;
    const step = (live: readonly number[]): void => {
      const order = left ? live : [...live].reverse();
      order.forEach((r, j) => {
        this.#emit(`${j === 0 ? (left ? 'lsl' : 'lsr') : left ? 'rol' : 'ror'} r${r}`);
      });
    };
    if (b.kind === 'lit') {
      // Whole bytes move as one parallel move of the surviving bytes; the shifted-in bytes
      // are known zero (never written); the remaining bits step over the live bytes only.
      const k = b.value & 31;
      const bytes = k >> 3;
      let bits = k & 7;
      const idx = [0, 1, 2, 3].filter((i) => (left ? i >= bytes : i <= 3 - bytes));
      this.#parallel(
        idx.map((i) => ({
          d: { k: 'r', r: W[i] as number },
          s: this.#src(a, left ? i - bytes : i + bytes),
        })),
      );
      const live = idx.map((i) => W[i] as number);
      const only = live[0] as number;
      if (live.length === 1 && bits >= 4 && only >= 16) {
        this.#emit(`swap r${only}`, `andi r${only}, ${left ? 0xf0 : 0x0f}`);
        bits -= 4;
      }
      for (let s = 0; s < bits; s += 1) step(live);
      if (!inReg) for (const i of idx) this.#emit(`std Y+${d.off + i}, r${W[i]}`);
      return;
    }
    // Slot result: the value steps in r26, r27, r30, r31 with the count in r1 (zero again at
    // the end), so bytes 1-3 load before r1 stops being zero and byte 0 after the count.
    if (!inReg)
      for (let k = 1; k < 4; k += 1) {
        const s = this.#byte(a, k, T[k] as number);
        if (s !== `r${T[k]}`) this.#emit(`mov r${T[k]}, ${s}`);
      }
    const cnt = this.#byte(b, 0, 26);
    if (cnt !== 'r26') this.#emit(`mov r26, ${cnt}`);
    this.#emit('andi r26, 31');
    let ctr = 'r26';
    if (!inReg) {
      this.#emit('mov r1, r26');
      ctr = 'r1';
      const s0 = this.#byte(a, 0, 26);
      if (s0 === 'r1') this.#emit('ldi r26, 0');
      else if (s0 !== 'r26') this.#emit(`mov r26, ${s0}`);
    } else this.#move(d, 4, a, 27);
    const top = this.#label();
    const done = this.#label();
    this.#emit(`breq ${done}`, `${top}:`);
    step(W);
    this.#emit(`dec ${ctr}`, `brne ${top}`, `${done}:`);
    if (!inReg) for (let k = 0; k < 4; k += 1) this.#emit(`std Y+${d.off + k}, r${W[k]}`);
  }

  /** r26 = (index mod n) * elemBytes, for a variable index (the aggregate is at most 255 bytes). */
  #elementOffset(idx: Val, n: number, es: number, checked = false): void {
    if (isPow2(n) || checked) {
      const s = this.#byte(idx, 0, 26);
      if (s !== 'r26') this.#emit(`mov r26, ${s}`);
      // Strict, after the bounds check: the index is below n (at most 255), no reduction.
      if (!checked) this.#emit(`andi r26, ${n - 1}`);
    } else {
      this.#parallel([
        ...A.map((r, k) => ({ d: { k: 'r', r } as BDst, s: this.#src(idx, k) })),
        ...B.map((r, k) => ({
          d: { k: 'r', r } as BDst,
          s: { k: 'lit', b: byteOf(n, k) } as BSrc,
        })),
      ]);
      this.#emit('call __a0_udivmod32');
    }
    if (es === 1) return;
    if (isPow2(es)) for (let s = 0; s < log2(es); s += 1) this.#emit('lsl r26');
    else this.#emit(`ldi r27, ${es}`, 'mul r26, r27', 'mov r26, r0', 'clr r1');
  }

  /** Z = address of aggregate `v` (span bytes) + r26 - displacement; returns the displacement. */
  #elementPointer(v: Val, span: number): number {
    if (v.kind !== 'agg') refuse('expected an aggregate');
    if (v.base !== undefined) {
      this.#aggPtr(30, v);
      this.#emit('add r30, r26', 'adc r31, r1');
      return 0;
    }
    const base = this.#abs(v.rel);
    this.#emit('movw r30, r28', 'add r30, r26', 'adc r31, r1');
    if (base + span - 1 <= 63) return base;
    this.#emit(`subi r30, ${lo(neg16(base))}`, `sbci r31, ${hi(neg16(base))}`);
    return 0;
  }

  // --- strict profile: the frame stack and the trap checks (src/trap-host.ts) ---------------
  // The macros use r26, r27, r30 and r31 only (never homes), so they fit anywhere between nodes.

  /** Push this function's frame (r26:r27 = its word address): no fold marked, the trip left unset. */
  #enter(): void {
    const sym = `a0_${this.fn.name}`;
    this.#emit(`ldi r26, lo8(gs(${sym}))`, `ldi r27, hi8(gs(${sym}))`, 'call __a0_enter');
  }

  #leave(): void {
    this.#emit('call __a0_leave');
  }

  /** Z = the current frame. */
  #topFrame(): void {
    this.#emit('call __a0_top');
  }

  /** Name the fold or loop this frame is iterating by its ordinal (0: none). */
  #markNode(ordinal: number): void {
    this.#topFrame();
    if (ordinal === 0) this.#emit('std Z+2, r1');
    else this.#emit(`ldi r26, ${ordinal}`, 'std Z+2, r26');
  }

  /** Record the trip the marked fold or loop is on. */
  #markTrip(counter: Val): void {
    this.#topFrame();
    for (let k = 0; k < 4; k += 1) this.#emit(`std Z+${3 + k}, ${this.#byte(counter, k, 26)}`);
  }

  /** Strict: trap `bounds` unless the index operand is below `n`. */
  #guardIndex(idx: Val, n: number): void {
    if (idx.kind === 'lit') {
      if (idx.value >>> 0 >= n) this.#emit('jmp A0_trap_bounds');
      return;
    }
    const ok = this.#label();
    const cond = this.#cmp('lt', idx, { kind: 'lit', value: n, type: 'u32' });
    this.#emit(`br${cond} ${ok}`, 'jmp A0_trap_bounds', `${ok}:`);
  }

  /** Strict: trap `divzero` when the divisor is zero. */
  #guardDivisor(d: Val): void {
    if (d.kind === 'lit') {
      if (d.value === 0) this.#emit('jmp A0_trap_divzero');
      return;
    }
    const ok = this.#label();
    const cond = this.#cmp('eq', d, { kind: 'lit', value: 0, type: 'u32' });
    this.#emit(`br${INVERSE[cond]} ${ok}`, 'jmp A0_trap_divzero', `${ok}:`);
  }

  /** Store registers (or r1 for zero) at frame bytes [off, off + regs.length). */
  #storeBytes(off: number, regs: readonly string[]): void {
    const m = this.#frame(off, regs.length);
    for (const [k, r] of regs.entries()) this.#emit(`std ${m.base}+${m.disp + k}, ${r}`);
  }

  /** The checked op `n` of the frame record at `off`: the value in r22-r25 and ok in r26 or a flag test. */
  #checked(n: Planned, off: number): void {
    const [a, b] = n.vals as [Val, Val];
    const loadAB = (): void =>
      this.#parallel([
        ...A.map((r, k) => ({ d: { k: 'r', r } as BDst, s: this.#src(a, k) })),
        ...B.map((r, k) => ({ d: { k: 'r', r } as BDst, s: this.#src(b, k) })),
      ]);
    const okFromCarry = (): string[] => ['clr r26', 'rol r26', 'ldi r27, 1', 'eor r26, r27'];
    switch (n.op) {
      case 'cadd':
      case 'csub': {
        loadAB();
        const mn = n.op === 'cadd' ? ['add', 'adc'] : ['sub', 'sbc'];
        for (let k = 0; k < 4; k += 1) this.#emit(`${k === 0 ? mn[0] : mn[1]} r${A[k]}, r${B[k]}`);
        this.#emit(...okFromCarry());
        this.#storeBytes(off, ['r22', 'r23', 'r24', 'r25', 'r26']);
        return;
      }
      case 'cmul': {
        // The product fits exactly when it is zero or dividing it back by a gives b.
        const done = this.#label();
        loadAB();
        this.#emit('call __a0_mul32');
        this.#storeBytes(off, ['r22', 'r23', 'r24', 'r25']);
        this.#emit('ldi r26, 1');
        this.#storeBytes(off + 4, ['r26']);
        const zero = this.#cmp('eq', a, { kind: 'lit', value: 0, type: 'u32' });
        this.#emit(`br${zero} ${done}`);
        this.#parallel(B.map((r, k) => ({ d: { k: 'r', r } as BDst, s: this.#src(a, k) })));
        this.#emit('call __a0_udivmod32');
        this.#parallel(B.map((r, k) => ({ d: { k: 'r', r } as BDst, s: this.#src(b, k) })));
        this.#emit('cp r22, r18', 'cpc r23, r19', 'cpc r24, r20', 'cpc r25, r21', `breq ${done}`);
        this.#storeBytes(off + 4, ['r1']);
        this.#emit(`${done}:`);
        return;
      }
      case 'cdiv':
      case 'crem': {
        const zero = this.#label();
        const done = this.#label();
        const cond = this.#cmp('eq', b, { kind: 'lit', value: 0, type: 'u32' });
        this.#emit(`br${cond} ${zero}`);
        loadAB();
        this.#emit('call __a0_udivmod32');
        if (n.op === 'crem') this.#emit('movw r22, r26', 'movw r24, r30');
        this.#storeBytes(off, ['r22', 'r23', 'r24', 'r25']);
        this.#emit('ldi r26, 1');
        this.#storeBytes(off + 4, ['r26']);
        this.#emit(`rjmp ${done}`, `${zero}:`);
        this.#storeBytes(off, ['r1', 'r1', 'r1', 'r1', 'r1']);
        this.#emit(`${done}:`);
        return;
      }
      case 'cget': {
        if (a.kind !== 'agg' || isPrimitive(a.type) || a.type.kind !== 'arr')
          refuse('cget needs an array');
        const length = a.type.length;
        const es = bytesOf(a.type.elem);
        if (b.kind === 'lit') {
          if (b.value >>> 0 >= length) {
            this.#storeBytes(off, ['r1', 'r1', 'r1', 'r1', 'r1']);
            return;
          }
          this.#aggPtr(30, a, (b.value % length) * es);
          for (let k = 0; k < 4; k += 1) this.#emit(`ldd r${A[k]}, Z+${k}`);
          this.#emit('ldi r26, 1');
          this.#storeBytes(off, ['r22', 'r23', 'r24', 'r25', 'r26']);
          return;
        }
        const done = this.#label();
        this.#storeBytes(off, ['r1', 'r1', 'r1', 'r1', 'r1']);
        const cond = this.#cmp('lt', b, { kind: 'lit', value: length, type: 'u32' });
        this.#emit(`br${INVERSE[cond]} ${done}`);
        this.#elementOffset(b, length, es);
        const disp = this.#elementPointer(a, bytesOf(a.type));
        for (let k = 0; k < 4; k += 1) this.#emit(`ldd r${A[k]}, Z+${disp + k}`);
        this.#emit('ldi r26, 1');
        this.#storeBytes(off, ['r22', 'r23', 'r24', 'r25', 'r26']);
        this.#emit(`${done}:`);
        return;
      }
      default:
        refuse(`internal: ${n.op} is not a checked op`);
    }
  }

  // --- calls ------------------------------------------------------------------------------

  /** Out-of-line call of `name`; a scalar result goes to `d`, an aggregate one to frame offset `agg`. */
  #call(name: string, callee: TypedFunc, args: readonly Val[], d?: Home, agg?: number): void {
    const sret = !isPrimitive(callee.result);
    const { slots, stackBytes } = argLayout(callee.params, sret);
    for (let j = args.length - 1; j >= 0; j -= 1) {
      const s = slots[j] as ArgSlot;
      const a = args[j] as Val;
      if (s.stack === undefined) continue;
      if (a.kind === 'agg') {
        this.#aggPtr(30, a);
        this.#emit('push r31', 'push r30');
      } else for (let k = s.size - 1; k >= 0; k -= 1) this.#emit(`push ${this.#byte(a, k, 26)}`);
    }
    this.outgoing = Math.max(this.outgoing, stackBytes);
    const moves: Move[] = [];
    const pointers: { r: number; off: number }[] = [];
    const offsets: { r: number; off: number }[] = [];
    args.forEach((a, j) => {
      const s = slots[j] as ArgSlot;
      if (s.reg === undefined) return;
      if (a.kind === 'agg' && a.base === undefined)
        pointers.push({ r: s.reg, off: this.#abs(a.rel) });
      else if (a.kind === 'agg') {
        // An in-place aggregate passes its own pointer on (plus its offset).
        const h = this.#home(a.base as VReg);
        for (let k = 0; k < 2; k += 1)
          moves.push({
            d: { k: 'r', r: s.reg + k },
            s: h.kind === 'reg' ? { k: 'r', r: h.r + k } : { k: 'slot', off: h.off + k },
          });
        if (a.rel !== 0) offsets.push({ r: s.reg, off: a.rel });
      } else
        for (let k = 0; k < s.size; k += 1)
          moves.push({ d: { k: 'r', r: s.reg + k }, s: this.#src(a, k) });
    });
    this.#parallel(moves);
    for (const p of offsets) {
      if (p.r >= 16 && p.r !== 24)
        this.#emit(`subi r${p.r}, ${lo(neg16(p.off))}`, `sbci r${p.r + 1}, ${hi(neg16(p.off))}`);
      else if (p.r === 24 && p.off <= 63) this.#emit(`adiw r24, ${p.off}`);
      else {
        this.#emit(
          `movw r30, r${p.r}`,
          `subi r30, ${lo(neg16(p.off))}`,
          `sbci r31, ${hi(neg16(p.off))}`,
          `movw r${p.r}, r30`,
        );
      }
    }
    for (const p of pointers) {
      this.#pointer(30, p.off);
      this.#emit(`movw r${p.r}, r30`);
    }
    if (sret) {
      this.#pointer(30, agg ?? refuse('aggregate call result needs a slot'));
      this.#emit('movw r24, r30');
    }
    this.called.set(name, callee);
    this.#emit(`call a0_${name}`);
    if (stackBytes > 0 && stackBytes <= 6)
      for (let k = 0; k < stackBytes; k += 1) this.#emit('pop r0');
    else if (stackBytes > 0) {
      this.#emit('in r26, 0x3d', 'in r27, 0x3e');
      if (stackBytes <= 63) this.#emit(`adiw r26, ${stackBytes}`);
      else this.#emit(`subi r26, ${lo(neg16(stackBytes))}`, `sbci r27, ${hi(neg16(stackBytes))}`);
      this.#emit('in r0, 0x3f', 'cli', 'out 0x3e, r27', 'out 0x3f, r0', 'out 0x3d, r26');
    }
    if (d !== undefined && !sret) this.#fromRegs(d, callee.result === 'bool' ? [24] : A);
  }

  // --- nodes ------------------------------------------------------------------------------

  #node(n: Planned): void {
    const t = n.type;
    const key = `n_${n.id}`;
    const [a, b, c] = n.vals as [Val, Val, Val];
    const self = this.#vals.get(key);
    const dz = self?.kind === 'v' ? self.v.zero : 0;
    const d = (): Home => (self?.kind === 'v' ? this.#home(self.v) : refuse(`no home for ${key}`));
    const aggOff = (): number =>
      self?.kind === 'agg' ? this.#abs(self.rel) : refuse(`no slot for ${key}`);
    if (n.bit !== undefined) {
      this.#emit(`bst ${this.#byte(n.bit.x, n.bit.bit >> 3, 26)}, ${n.bit.bit & 7}`);
      return;
    }
    switch (n.op) {
      case 'mov':
        return;
      case 'add':
      case 'sub':
      case 'and':
      case 'or':
      case 'xor':
        this.#bytewise(n.op, d(), a, b, bytesOf(t), dz);
        return;
      case 'cadd':
      case 'csub':
      case 'cmul':
      case 'cdiv':
      case 'crem':
      case 'cget':
        this.#checked(n, aggOff());
        return;
      case 'mul':
      case 'div':
      case 'rem':
        if (n.site === 'divzero') this.#guardDivisor(b);
        this.#parallel([
          ...A.map((r, k) => ({ d: { k: 'r', r } as BDst, s: this.#src(a, k) })),
          ...B.map((r, k) => ({ d: { k: 'r', r } as BDst, s: this.#src(b, k) })),
        ]);
        this.#emit(`call ${n.op === 'mul' ? '__a0_mul32' : '__a0_udivmod32'}`);
        this.#fromRegs(d(), n.op === 'rem' ? T : A);
        return;
      case 'shl':
      case 'shr':
        this.#shift(d(), a, b, n.op === 'shl');
        return;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'ge':
      case 'gt':
      case 'le':
        if (!n.fused) this.#setBool(d(), this.#cmp(n.op, a, b));
        return;
      case 'select': {
        if (isPrimitive(t)) {
          this.#select(d(), bytesOf(t), a, b, c, dz);
          return;
        }
        const dst = aggOff();
        const other = this.#label();
        const done = this.#label();
        const cond = this.#test(a);
        this.#emit(`br${cond} ${other}`);
        this.#place(c, dst);
        this.#emit(`rjmp ${done}`, `${other}:`);
        this.#place(b, dst);
        this.#emit(`${done}:`);
        return;
      }
      case 'arr':
      case 'rec': {
        let off = aggOff();
        for (const v of n.vals) {
          this.#place(v, off);
          off += bytesOf(v.kind === 'agg' ? v.type : this.#scalar(v).type);
        }
        return;
      }
      case 'get':
      case 'at': {
        if (a.kind !== 'agg' || isPrimitive(a.type)) refuse(`${n.op} needs an aggregate`);
        if (n.site === 'bounds' && a.type.kind === 'arr') this.#guardIndex(b, a.type.length);
        if (b.kind === 'lit') {
          if (!isPrimitive(t)) return; // alias
          const off =
            a.type.kind === 'arr'
              ? (b.value % a.type.length) * bytesOf(a.type.elem)
              : a.type.fields.slice(0, b.value).reduce((s, f) => s + bytesOf(f), 0);
          if (a.base === undefined) this.#loadFrame(d(), bytesOf(t), this.#abs(a.rel) + off);
          else {
            this.#aggPtr(30, a, off);
            const h = d();
            for (let k = 0; k < bytesOf(t); k += 1)
              this.#emit(
                ...(h.kind === 'reg'
                  ? [`ldd r${h.r + k}, Z+${k}`]
                  : [`ldd r0, Z+${k}`, `std Y+${h.off + k}, r0`]),
              );
          }
          return;
        }
        if (a.type.kind !== 'arr') refuse('at needs a literal field');
        const es = bytesOf(a.type.elem);
        this.#elementOffset(b, a.type.length, es, n.site === 'bounds');
        const disp = this.#elementPointer(a, bytesOf(a.type));
        if (isPrimitive(t)) {
          const h = d();
          for (let k = 0; k < es; k += 1) {
            if (h.kind === 'reg') this.#emit(`ldd r${h.r + k}, Z+${disp + k}`);
            else this.#emit(`ldd r0, Z+${disp + k}`, `std Y+${h.off + k}, r0`);
          }
        } else {
          if (disp !== 0) this.#emit(`adiw r30, ${disp}`);
          this.#emit('movw r26, r30');
          this.#counter(es, 30);
          this.#pointer(30, aggOff());
          this.#copyLoop();
        }
        return;
      }
      case 'set':
      case 'put': {
        if (a.kind !== 'agg' || isPrimitive(a.type)) refuse(`${n.op} needs an aggregate`);
        const rt = a.type;
        const dst = aggOff();
        // Strict: the index is checked before anything is copied or written.
        if (n.site === 'bounds' && rt.kind === 'arr') this.#guardIndex(b, rt.length);
        this.#place(a, dst);
        if (b.kind === 'lit') {
          const off =
            rt.kind === 'arr'
              ? (b.value % rt.length) * bytesOf(rt.elem)
              : (rt.fields[b.value] === undefined ? refuse('field out of range') : 0) +
                rt.fields.slice(0, b.value).reduce((s, f) => s + bytesOf(f), 0);
          this.#place(c, dst + off);
          return;
        }
        if (rt.kind !== 'arr') refuse('put needs a literal field');
        const es = bytesOf(rt.elem);
        this.#elementOffset(b, rt.length, es, n.site === 'bounds');
        const disp = this.#elementPointer(self as Val, bytesOf(rt));
        if (c.kind === 'agg') {
          if (disp !== 0) this.#emit(`adiw r30, ${disp}`);
          this.#counter(es, 26);
          this.#aggPtr(26, c);
          this.#copyLoop();
        } else
          for (let k = 0; k < es; k += 1) this.#emit(`std Z+${disp + k}, ${this.#byte(c, k, 27)}`);
        return;
      }
      case 'call': {
        const name = n.callee as string;
        const callee = this.#callee(name);
        if (isPrimitive(t)) this.#call(name, callee, n.vals, d());
        else this.#call(name, callee, n.vals, undefined, aggOff());
        return;
      }
      case 'fold':
      case 'loop':
        this.#loop(n);
        return;
      case 'read':
      case 'write':
      case 'puts':
        refuse(`${n.op} is an io operation`);
    }
  }

  /** fold/loop: state and counter stay in their (callee-saved) homes across every body call. */
  #loop(n: Planned): void {
    const [count, init, ...extras] = n.vals as [Val, Val, ...Val[]];
    const name = n.callee as string;
    const body = this.#callee(name);
    const pred = n.pred === undefined ? undefined : this.#callee(n.pred);
    const counterV = this.#counters.get(n.id) ?? refuse('loop counter');
    const counterH = this.#home(counterV);
    const counter: Val = { kind: 'v', v: counterV, type: 'u32' };
    const stateV = this.#state.get(n.id);
    const self = this.#vals.get(`n_${n.id}`) ?? refuse('loop state');
    let state: Val;
    if (stateV !== undefined) {
      const h = this.#home(stateV);
      this.#move(h, stateV.size, init);
      state = { kind: 'v', v: stateV, type: n.type as Scalar };
    } else {
      if (self.kind !== 'agg') refuse('loop state');
      this.#place(init, this.#abs(self.rel));
      state = self;
    }
    this.#move(counterH, counterV.size, { kind: 'lit', value: 0, type: 'u32' });
    const args = [state, counter, ...extras];
    const top = this.#label();
    const test = this.#label();
    const done = this.#label();
    const inl = n.inl;
    // Strict: this frame names the fold it is iterating (its ordinal), and each trip, for a trap in its body.
    const node = this.fn.nodes.find((x) => x.id === n.id);
    const marked =
      this.#framed && n.inner !== true && node !== undefined && callTraps(this.fn, node)
        ? trapNodes(this.fn).findIndex((x) => x.id === n.id) + 1
        : 0;
    const lines = this.#capture(() => {
      if (marked !== 0) this.#markTrip(counter);
      if (inl !== undefined) {
        // Inlined: the predicate's nodes and its branch, the body's nodes, the state update.
        if (inl.predRet !== undefined) {
          for (let k = inl.predFrom; k < inl.bodyFrom; k += 1)
            this.#nodeStaged(this.#planned[k] as Planned);
          const cond = this.#test(inl.predRet);
          const go = this.#label();
          this.#emit(`br${cond} ${go}`, `rjmp ${done}`, `${go}:`);
        }
        for (let k = inl.bodyFrom; k < inl.bodyTo; k += 1)
          this.#nodeStaged(this.#planned[k] as Planned);
        const sv = stateV ?? refuse('inlined loop state');
        this.#move(this.#home(sv), sv.size, inl.bodyRet);
        this.#increment(counterH, counterV.size);
        return;
      }
      if (pred !== undefined) {
        this.#call(n.pred as string, pred, args);
        const go = this.#label();
        this.#emit('tst r24', `brne ${go}`, `rjmp ${done}`, `${go}:`);
      }
      if (stateV !== undefined) this.#call(name, body, args, this.#home(stateV));
      else this.#call(name, body, args, undefined, this.#abs((self as { rel: number }).rel));
      this.#increment(counterH, counterV.size);
    });
    // A literal count of at least one runs the first iteration without testing.
    if (marked !== 0) this.#markNode(marked);
    if (!(count.kind === 'lit' && count.value > 0)) this.#emit(`rjmp ${test}`);
    this.#emit(`${top}:`);
    this.out.push(...lines);
    this.#emit(`${test}:`);
    this.#cmp('lt', counter, count);
    const words = wordsOf(lines) + 8;
    if (words <= 60) this.#emit(`brlo ${top}`);
    else this.#emit(`brsh ${done}`, `rjmp ${top}`);
    this.#emit(`${done}:`);
    if (marked !== 0) this.#markNode(0);
  }

  /** Counter `h` (its low `size` bytes; the rest are known zero) plus one. */
  #increment(h: Home, size: number): void {
    if (h.kind === 'slot') {
      for (let k = 0; k < size; k += 1)
        this.#emit(
          `ldd r26, Y+${h.off + k}`,
          `${k === 0 ? 'subi' : 'sbci'} r26, 255`,
          `std Y+${h.off + k}, r26`,
        );
      return;
    }
    if (size === 1) {
      this.#emit(`inc r${h.r}`);
      return;
    }
    if (h.r >= 16) {
      for (let k = 0; k < size; k += 1) this.#emit(`${k === 0 ? 'subi' : 'sbci'} r${h.r + k}, 255`);
      return;
    }
    this.#emit('sec');
    for (let k = 0; k < size; k += 1) this.#emit(`adc r${h.r + k}, r1`);
  }

  // --- function -------------------------------------------------------------------------

  emit(): string {
    const fn = this.fn;
    if (
      containsIo(fn.result) ||
      fn.params.some(containsIo) ||
      [...fn.types.values()].some(containsIo)
    )
      refuse(`function ${fn.name} uses io; io functions are out of scope for this backend`);
    for (const t of [...fn.params, fn.result])
      if (!isPrimitive(t) && bytesOf(t) > AVR_AGGREGATE_MAX_BYTES)
        refuse(
          `function ${fn.name} has a ${bytesOf(t)}-byte aggregate in its signature; the limit is ${AVR_AGGREGATE_MAX_BYTES} bytes`,
          'limit',
        );
    this.#plan();
    this.#allocate();
    const frame = this.#spillSize + this.#aggSize;
    if (frame > AVR_FRAME_MAX_BYTES)
      refuse(
        `function ${fn.name} needs a ${frame}-byte frame; the limit is ${AVR_FRAME_MAX_BYTES} bytes of the ATmega328P's 2 KiB SRAM`,
        'limit',
      );
    const sret = !isPrimitive(fn.result);
    const layout = argLayout(fn.params, sret);
    const needsFrame = frame > 0 || layout.stackBytes > 0;
    const saved = [...this.#saved].sort((x, y) => x - y);
    const pushes = saved.length + (needsFrame ? 2 : 0);
    const stackBase = frame + pushes + 3;
    const entry: Move[] = [];
    const sretV = this.#sretV;
    if (sretV !== undefined)
      for (let k = 0; k < 2; k += 1)
        entry.push({ d: this.#dst(this.#home(sretV), k), s: { k: 'r', r: 24 + k } });
    fn.params.forEach((_, i) => {
      const s = layout.slots[i] as ArgSlot;
      const v = this.#regOf(this.#vals.get(`p${i}`))[0];
      if (v === undefined || !v.used || s.reg === undefined) return;
      for (let k = 0; k < s.size; k += 1)
        entry.push({ d: this.#dst(this.#home(v), k), s: { k: 'r', r: s.reg + k } });
    });
    this.#parallel(entry);
    fn.params.forEach((_, i) => {
      const s = layout.slots[i] as ArgSlot;
      const v = this.#regOf(this.#vals.get(`p${i}`))[0];
      if (v === undefined || !v.used || s.stack === undefined) return;
      const h = this.#home(v);
      const base = stackBase + s.stack;
      this.#parallel(
        Array.from({ length: s.size }, (_, k) => ({
          d: this.#dst(h, k),
          s: { k: 'slot', off: base + k },
        })),
      );
    });
    if (this.#framed) this.#enter();
    for (const n of this.#planned) if (n.inner !== true) this.#nodeStaged(n);
    const ret = this.#retVal ?? refuse('no return value');
    if (!sret) this.#fromValue(fn.result === 'bool' ? [24] : A, ret);
    else {
      if (ret.kind !== 'agg') refuse('an aggregate literal cannot be returned');
      const h = this.#home(sretV as VReg);
      this.#counter(bytesOf(fn.result), 26);
      this.#aggPtr(26, ret);
      if (h.kind === 'reg') this.#emit(`movw r30, r${h.r}`);
      else {
        const m = this.#frame(h.off, 2);
        this.#emit(
          `ldd r0, ${m.base}+${m.disp}`,
          `ldd r31, ${m.base}+${m.disp + 1}`,
          'mov r30, r0',
        );
      }
      this.#copyLoop();
    }
    if (this.#framed) this.#leave();
    this.frameBytes = frame;
    this.pushes = pushes;
    const body = this.out.splice(0);
    const sym = `a0_${fn.name}`;
    const setSp = ['in r0, 0x3f', 'cli', 'out 0x3e, r29', 'out 0x3f, r0', 'out 0x3d, r28'];
    this.out.push(
      `\t.section .text.${sym},"ax",@progbits`,
      `\t.globl ${sym}`,
      `\t.type ${sym}, @function`,
      `${sym}:`,
    );
    this.#emit(...saved.map((r) => `push r${r}`));
    const small = frame <= 6;
    if (needsFrame) {
      this.#emit('push r28', 'push r29');
      if (small) {
        for (let k = 0; k + 1 < frame; k += 2) this.#emit('rcall .');
        if (frame % 2 === 1) this.#emit('push r1');
        this.#emit('in r28, 0x3d', 'in r29, 0x3e');
      } else {
        this.#emit('in r28, 0x3d', 'in r29, 0x3e');
        if (frame <= 63) this.#emit(`sbiw r28, ${frame}`);
        else this.#emit(`subi r28, ${lo(frame)}`, `sbci r29, ${hi(frame)}`);
        this.#emit(...setSp);
      }
    }
    this.out.push(...body);
    if (needsFrame) {
      if (small) for (let k = 0; k < frame; k += 1) this.#emit('pop r0');
      else {
        if (frame <= 63) this.#emit(`adiw r28, ${frame}`);
        else this.#emit(`subi r28, ${lo(neg16(frame))}`, `sbci r29, ${hi(neg16(frame))}`);
        this.#emit(...setSp);
      }
      this.#emit('pop r29', 'pop r28');
    }
    this.#emit(...[...saved].reverse().map((r) => `pop r${r}`), 'ret');
    const lines = peephole(this.out);
    // rjmp reaches +-2 KiW; a longer function takes jmp.
    const long = lines.filter((l) => l.startsWith('\t') && !l.startsWith('\t.')).length > 1800;
    this.out = long ? lines.map((l) => l.replace(/^\trjmp \.La0_/, '\tjmp .La0_')) : lines;
    this.out.push(`\t.size ${sym}, .-${sym}`);
    return this.out.join('\n');
  }

  /** Scalar `v` into the fixed registers `regs`. */
  #fromValue(regs: readonly number[], v: Val): void {
    this.#parallel(regs.map((r, k) => ({ d: { k: 'r', r }, s: this.#src(v, k) })));
  }
}

/** Program words of emitted lines (labels take none; call, jmp, lds, sts take two). */
function wordsOf(lines: readonly string[]): number {
  let words = 0;
  for (const l of lines) {
    if (l.endsWith(':') || l.startsWith('\t.')) continue;
    words += /^\t(call|jmp|lds|sts) /.test(l) ? 2 : 1;
  }
  return words;
}

/** Drop self-moves and jumps to the next line. */
function peephole(lines: readonly string[]): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    const m = /^\t(mov|movw) r(\d+), r(\d+)$/.exec(l);
    if (m !== null && m[2] === m[3]) return;
    const j = /^\trjmp (\S+)$/.exec(l);
    if (j !== null && lines[i + 1] === `${j[1]}:`) return;
    out.push(l);
  });
  return out;
}

/**
 * Emit one function as AVR assembly (a `.globl a0_<name>` block in `.text.a0_<name>`). With
 * `inline: false`, every call, fold and loop calls its callee out of line.
 */
export function emitAvrFunction(fn: TypedFunc, options: { inline?: boolean } = {}): string {
  return emitted(fn, options.inline ?? true).text;
}

/** An emission of `fn`: inlined loops first, again without them when those meet far spills. */
function emitted(fn: TypedFunc, inline = true): { e: AvrEmitter; text: string } {
  const e = new AvrEmitter(fn, inline, inline);
  try {
    return { e, text: e.emit() };
  } catch (err) {
    if (!(err instanceof FarSpill)) throw err;
    const plain = new AvrEmitter(fn, false, inline);
    return { e: plain, text: plain.emit() };
  }
}

/**
 * Static upper bound on the SRAM stack one call of `fn` uses (frames, saved registers, return
 * addresses, outgoing stack arguments, and helper calls, through every callee), for the
 * emission `compile` produces.
 */
export function avrStackBytes(fn: TypedFunc, optimize = true): number {
  const memo = new Map<string, number>();
  const walk = (f: TypedFunc): number => {
    const known = memo.get(f.name);
    if (known !== undefined) return known;
    const source = optimize ? optimizeFunction(f).fn : f;
    const { e } = emitted(source);
    let deepest = 2; // a helper's return address
    for (const callee of e.called.values()) deepest = Math.max(deepest, walk(callee));
    const total = 2 + e.pushes + e.frameBytes + e.outgoing + deepest;
    memo.set(f.name, total);
    return total;
  };
  return walk(fn);
}

/**
 * The folds and loops of `fn` that a strict trap can name, in the order of their ordinals (the
 * node byte of a frame is 1 + the index here), for the emission `compile` produces: a harness
 * decodes the record with it. Empty for a function that keeps no frame.
 */
export function avrTrapNodes(fn: TypedFunc, optimize = true): string[] {
  const source = optimize ? optimizeFunction(fn).fn : fn;
  return trapNodes(inlineCalls(source)).map((n) => n.id);
}

/** The bytes of one frame of the strict runtime: word address, node ordinal, trip (u32). */
export const AVR_FRAME_BYTES = 7;

const HELPERS: Readonly<Record<string, readonly string[]>> = {
  // The strict profile's frame stack (see avrTrapRuntime): push a frame for the function at word
  // address r26:r27, pop one, and point Z at the current one. They touch r26, r27, r30, r31 only.
  __a0_enter: [
    'lds r30, A0_fp',
    'lds r31, A0_fp+1',
    'st Z+, r26',
    'st Z+, r27',
    'st Z+, r1',
    'adiw r30, 4',
    'sts A0_fp, r30',
    'sts A0_fp+1, r31',
    'ret',
  ],
  __a0_leave: [
    'lds r30, A0_fp',
    'lds r31, A0_fp+1',
    'sbiw r30, 7',
    'sts A0_fp, r30',
    'sts A0_fp+1, r31',
    'ret',
  ],
  __a0_top: ['lds r30, A0_fp', 'lds r31, A0_fp+1', 'sbiw r30, 7', 'ret'],
  // r22-r25 = r22-r25 * r18-r21 (low 32 bits) on the hardware multiplier: the ten byte
  // products whose weight is below 2^32, accumulated by column into r26, r27, r30, r31.
  __a0_mul32: [
    'mul r22, r21',
    'mov r31, r0',
    'mul r23, r20',
    'add r31, r0',
    'mul r24, r19',
    'add r31, r0',
    'mul r25, r18',
    'add r31, r0',
    'mul r22, r20',
    'mov r30, r0',
    'add r31, r1',
    'mul r23, r19',
    'add r30, r0',
    'adc r31, r1',
    'mul r24, r18',
    'add r30, r0',
    'adc r31, r1',
    'clr r21',
    'mul r22, r18',
    'movw r26, r0',
    'mul r22, r19',
    'add r27, r0',
    'adc r30, r1',
    'adc r31, r21',
    'mul r23, r18',
    'add r27, r0',
    'adc r30, r1',
    'adc r31, r21',
    'clr r1',
    'movw r22, r26',
    'movw r24, r30',
    'ret',
  ],
  // Restoring division: r22-r25 / r18-r21, quotient in r22-r25, remainder in r26, r27, r30,
  // r31. A zero divisor subtracts zero every step: quotient all ones, remainder the dividend,
  // which is A0's definition.
  __a0_udivmod32: [
    'ldi r26, 32',
    'mov r0, r26',
    'clr r26',
    'clr r27',
    'movw r30, r26',
    '.La0_div_step:',
    'lsl r22',
    'rol r23',
    'rol r24',
    'rol r25',
    'rol r26',
    'rol r27',
    'rol r30',
    'rol r31',
    'brcs .La0_div_sub',
    'cp r26, r18',
    'cpc r27, r19',
    'cpc r30, r20',
    'cpc r31, r21',
    'brlo .La0_div_next',
    '.La0_div_sub:',
    'sub r26, r18',
    'sbc r27, r19',
    'sbc r30, r20',
    'sbc r31, r21',
    'ori r22, 1',
    '.La0_div_next:',
    'dec r0',
    'brne .La0_div_step',
    'ret',
  ],
};

/** Assemble function blocks into one .s module for avr-as (helpers appended as referenced). */
export function assembleAvr(bodies: readonly string[], compilerVersion: string): string {
  const text = bodies.join('\n\n');
  const helpers = Object.entries(HELPERS)
    .filter(([name]) => new RegExp(`call ${name}\\b`).test(text))
    .map(([name, lines]) =>
      [
        `\t.section .text.${name},"ax",@progbits`,
        `\t.type ${name}, @function`,
        `${name}:`,
        ...lines.map((l) => (l.endsWith(':') ? l : `\t${l}`)),
        `\t.size ${name}, .-${name}`,
      ].join('\n'),
    );
  if (
    /\b(__a0_enter|A0_trap_bounds|A0_trap_divzero)\b/.test(text) ||
    helpers.some((h) => /A0_fp/.test(h))
  )
    helpers.push(avrTrapRuntime(frameCapacity(bodies)));
  return `; Generated by A0 ${compilerVersion}. AVR (ATmega328P) assembly, avr-gcc calling convention; exact u32/bool semantics.\n${[text, ...helpers].join('\n\n')}\n`;
}

/**
 * The strict profile's runtime (src/trap-host.ts): the frame stack in SRAM (`A0_frames`, 2 bytes
 * of pointer `A0_fp` in .data, `AVR_FRAME_BYTES` per frame), and the stubs a failed check jumps
 * to. A stub empties the stack and calls the host's `A0_trap(uint8_t kind, const uint8_t *end)`
 * (kind in r24, the end of the frames at the trap in r22:r23), which never returns.
 */
function avrTrapRuntime(frames: number): string {
  return [
    '; The host provides A0_trap(uint8_t kind, const uint8_t *end), which never returns: see src/trap-host.ts.',
    // avr-libc's startup copies .data and clears .bss only when something references these.
    '\t.global __do_copy_data',
    '\t.global __do_clear_bss',
    '\t.section .data',
    '\t.globl A0_fp',
    'A0_fp:',
    '\t.word A0_frames',
    '\t.section .bss',
    '\t.globl A0_frames',
    'A0_frames:',
    `\t.zero ${AVR_FRAME_BYTES * frames}`,
    '\t.section .text.A0_trap,"ax",@progbits',
    '\t.globl A0_trap_bounds',
    '\t.globl A0_trap_divzero',
    'A0_trap_bounds:',
    '\tldi r24, 0',
    '\trjmp .LA0_trap',
    'A0_trap_divzero:',
    '\tldi r24, 1',
    '.LA0_trap:',
    '\tldi r25, 0',
    '\tlds r22, A0_fp',
    '\tlds r23, A0_fp+1',
    '\tldi r30, lo8(A0_frames)',
    '\tldi r31, hi8(A0_frames)',
    '\tsts A0_fp, r30',
    '\tsts A0_fp+1, r31',
    '\tjmp A0_trap',
  ].join('\n');
}
