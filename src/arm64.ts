/**
 * Direct native backend: AArch64 assembly for macOS on Apple silicon (Darwin arm64 ABI).
 * A0 reaches the machine through this code generator plus the system assembler and linker
 * only; no C is generated for the program.
 *
 * Scope: functions over u32 and bool, fixed-size arrays and records of them (value
 * semantics), every scalar op with A0's exact meaning, `call`, `fold`, and `loop` as real
 * loops with literal or variable trip counts. io functions are refused (the C path covers
 * them).
 *
 * Representation: every value is a sequence of 32-bit words. u32 is one word, bool is one
 * word holding 0 or 1, an array is its elements back to back, a record its fields in order.
 *
 * Code shape (second version):
 * - Small callees (at most INLINE_MAX_NODES nodes, nested to INLINE_MAX_DEPTH) are inlined
 *   at `call`, `fold`, and `loop` sites: the body's nodes are emitted in the caller's frame
 *   with its parameters bound to the caller's values, so an iteration is a branch, not a
 *   call. Larger callees are called out of line.
 * - Scalars live in registers. A linear scan over definition order gives each u32/bool
 *   value a home among the callee-saved w19-w28 (spilled to a stack slot when they run
 *   out); a function with no residual call is a leaf and also uses w0-w7, keeping parameter
 *   i in w_i. Loop state and counters are ordinary scalars, so a scalar fold is a register
 *   loop. Callee-saved registers survive residual calls, so nothing is saved around a call.
 * - Aggregates live in stack slots. A `set`/`put` on a value that is provably unshared (the
 *   same `mutableHere` analysis as the JavaScript backend: a fresh allocation or the owned
 *   iteration state, read only by `get`/`at` before this node, not returned) writes the
 *   element in place and the result aliases the container's slot; `mov` and an inlined
 *   callee's result alias likewise. A fold over an array therefore updates one element per
 *   iteration instead of copying the array twice per iteration.
 *
 * Calling convention (compatible with AAPCS64/Darwin for scalar signatures, so C can call
 * `_a0_<name>` directly):
 * - Each parameter takes the next of x0..x7: a scalar as its value in the w register (bool
 *   zero-extended to 0/1), an aggregate as a pointer to a caller-owned slot that the caller
 *   never changes. The callee copies aggregate parameters into its own slots on entry and
 *   never writes through the pointer.
 * - After eight, parameters go to the stack at Darwin's natural packing: u32 4 bytes
 *   (align 4), bool 1 byte, pointer 8 bytes (align 8), starting at the caller's sp.
 * - A scalar result returns in w0. An aggregate result is written through x8 (the sret
 *   pointer), after all parameters were copied, so x8 may alias an argument slot (fold
 *   state updates rely on this).
 *
 * Frame layout (sp is fixed after the prologue; all slots are addressed from sp):
 *
 *     incoming stack parameters     x29 + 16 + ...
 *     saved x29, x30                <- x29
 *     value slots (S bytes)         sp + O ... sp + O + S - 1
 *       (callee-saved register save area, sret pointer, aggregates, spilled scalars)
 *     outgoing stack arguments      sp ... sp + O - 1
 *
 * S and O are rounded to 16. Frames above 4 KiB are probed one page at a time in the
 * prologue. Scratch: w9-w15 data, x16/x17 addresses; x17 is reserved for large-offset
 * addressing.
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
} from './core.js';

function refuse(message: string): never {
  throw new A0Error(`arm64: ${message}`, undefined, {
    code: 'structure',
    fix: 'compile io functions with the c target; the arm64 backend covers io-free functions',
  });
}

/** Size of a value in 32-bit words. */
function words(t: Type): number {
  if (t === 'u32' || t === 'bool') return 1;
  if (t === 'io') return refuse('io values are not supported by this backend');
  if (t.kind === 'arr') return t.length * words(t.elem);
  return t.fields.reduce((n, f) => n + words(f), 0);
}

const align = (n: number, a: number): number => Math.ceil(n / a) * a;

const INLINE_MAX_NODES = 48;
const INLINE_MAX_DEPTH = 6;
const CALLEE_SAVED = ['w19', 'w20', 'w21', 'w22', 'w23', 'w24', 'w25', 'w26', 'w27', 'w28'];
const ARG_REGS = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];

const FRESH_OPS = new Set<Op>(['arr', 'rec', 'set', 'put']);

function sameOp(x: Operand, y: Operand): boolean {
  return (
    (x.kind === 'node' && y.kind === 'node' && x.id === y.id) ||
    (x.kind === 'param' && y.kind === 'param' && x.index === y.index)
  );
}

/**
 * May the aggregate operand `o` be updated in place by the node at `index`? The same
 * analysis as the JavaScript backend: sound when the value is provably unshared (a fresh
 * allocation or the owned state parameter p0), every other use is a `get`/`at` read before
 * `index`, and it is not returned.
 */
function mutableHere(fn: TypedFunc, o: Operand, index: number, ownedP0: boolean): boolean {
  if (o.kind === 'node') {
    const def = fn.nodes.find((n) => n.id === o.id);
    if (def === undefined || !FRESH_OPS.has(def.op)) return false;
  } else if (!(o.kind === 'param' && o.index === 0 && ownedP0)) {
    return false;
  }
  if (sameOp(fn.ret, o)) return false;
  for (const [j, n] of fn.nodes.entries()) {
    if (j === index) continue;
    for (const [k, arg] of n.args.entries()) {
      if (!sameOp(arg, o)) continue;
      if (j > index) return false;
      if (!((n.op === 'get' || n.op === 'at') && k === 0)) return false;
    }
  }
  return true;
}

/** Where each parameter travels: a register index, or a byte offset in the stack area. */
interface ArgPlace {
  readonly reg?: number;
  readonly stack?: number;
  readonly size: 1 | 4 | 8;
}

/** Darwin arm64 placement for a parameter list; `bytes` is the stack area used. */
function argLayout(params: readonly Type[]): { places: ArgPlace[]; bytes: number } {
  let next = 0;
  let offset = 0;
  const places = params.map((t): ArgPlace => {
    const size = isPrimitive(t) ? (t === 'bool' ? 1 : 4) : 8;
    if (next < 8) return { reg: next++, size };
    offset = align(offset, size);
    const place: ArgPlace = { stack: offset, size };
    offset += size;
    return place;
  });
  return { places, bytes: offset };
}

/** 32/64-bit immediate materialization with movz/movk. */
function movImm(reg: string, value: number): string[] {
  const lo = value & 0xffff;
  const hi = Math.floor(value / 0x10000) & 0xffff;
  const out = [`movz ${reg}, #${lo}`];
  if (hi !== 0) out.push(`movk ${reg}, #${hi}, lsl #16`);
  return out;
}

/** Is `v` encodable as a 32-bit logical immediate (a rotated run of ones repeating with period 2..32)? */
function isLogicalImm32(v: number): boolean {
  const x = v >>> 0;
  if (x === 0 || x === 0xffffffff) return false;
  for (const size of [2, 4, 8, 16, 32]) {
    const mask = size === 32 ? 0xffffffff : (1 << size) - 1;
    const elem = x & mask;
    let ok = true;
    for (let i = size; i < 32 && ok; i += size) ok = ((x >>> i) & mask) === elem;
    if (!ok) continue;
    // elem must be a rotation of a contiguous run of ones within `size` bits.
    let r = elem;
    let rotated = 0;
    while ((r & 1) === 1 && rotated < size) {
      r = ((r >>> 1) | ((r & 1) << (size - 1))) & mask;
      rotated += 1;
    }
    if (rotated === size) return false;
    // Now r has a zero at bit 0: a run of ones must be contiguous.
    const lowest = r & -r;
    return ((r + lowest) & r) === 0;
  }
  return false;
}

/** A value in the emitter: a literal, or a named key whose home is a register or a slot. */
type Val =
  | { readonly kind: 'lit'; readonly value: number; readonly type: 'u32' | 'bool' }
  | { readonly kind: 'key'; readonly key: string; readonly type: Type };

/** One function body being emitted, either the top level or an inlined callee. */
interface Env {
  readonly fn: TypedFunc;
  /** Key prefix that keeps this instance's node keys apart from every other's. */
  readonly prefix: string;
  /** What each parameter of `fn` is bound to. */
  readonly params: readonly Val[];
  /** Whether p0 is an aggregate this instance owns (the iteration state or an unshared argument). */
  readonly ownedP0: boolean;
  readonly depth: number;
}

type Home = { readonly reg: string } | { readonly slot: number };

class FunctionEmitter {
  out: string[] = [];
  #dry = true;
  #pos = 0;
  #labels = 0;
  readonly #defs = new Map<string, { pos: number; type: Type }>();
  readonly #last = new Map<string, number>();
  #loops: { start: number; used: Set<string> }[] = [];
  readonly #alias = new Map<string, string>();
  readonly #regs = new Map<string, string>();
  readonly #slots = new Map<string, number>();
  #slotBytes = 0;
  #outgoing = 0;
  #leaf = true;
  #saved: string[] = [];

  constructor(readonly fn: TypedFunc) {}

  #emit(...lines: string[]): void {
    if (this.#dry) return;
    for (const l of lines) this.out.push(l.endsWith(':') ? l : `\t${l}`);
  }

  #label(): string {
    this.#labels += 1;
    return `La0_${this.fn.name}_${this.#labels}`;
  }

  // --- values, keys, homes -------------------------------------------------------------

  #alloc(key: string, bytes: number, alignment = 4): number {
    this.#slotBytes = align(this.#slotBytes, alignment);
    const off = this.#slotBytes;
    this.#slotBytes = align(this.#slotBytes + bytes, 4);
    this.#slots.set(key, off);
    return off;
  }

  #canon(key: string): string {
    let k = key;
    for (let a = this.#alias.get(k); a !== undefined; a = this.#alias.get(k)) k = a;
    return k;
  }

  /** Byte offset from sp of a key's slot (aliases resolved). */
  #slot(key: string): number {
    const off = this.#slots.get(this.#canon(key));
    if (off === undefined) {
      if (this.#dry) return 0;
      throw new A0Error(`arm64: no slot for ${key}`);
    }
    return this.#outgoing + off;
  }

  /** Define `key` at the current position; aggregates get a slot. */
  #def(key: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    if (!isPrimitive(type)) this.#alloc(key, 4 * words(type));
  }

  /** Define aggregate `key` as another name for `target`'s storage. */
  #defAlias(key: string, target: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    this.#alias.set(key, this.#canon(target));
  }

  /** Record a read of `v` at the current position (for liveness). */
  #use(v: Val): void {
    if (!this.#dry || v.kind !== 'key') return;
    this.#last.set(v.key, this.#pos);
    for (const l of this.#loops) l.used.add(v.key);
  }

  #home(key: string): Home {
    if (this.#dry) return { slot: 0 };
    const reg = this.#regs.get(key);
    return reg === undefined ? { slot: this.#slot(key) } : { reg };
  }

  #resolve(env: Env, o: Operand): Val {
    switch (o.kind) {
      case 'u32':
        return { kind: 'lit', value: o.value, type: 'u32' };
      case 'bool':
        return { kind: 'lit', value: o.value ? 1 : 0, type: 'bool' };
      case 'param':
        return env.params[o.index] ?? refuse(`unknown parameter p${o.index}`);
      case 'node':
        return {
          kind: 'key',
          key: `${env.prefix}n_${o.id}`,
          type: env.fn.types.get(o.id) ?? refuse(`unknown node ${o.id}`),
        };
    }
  }

  // --- low-level emission ----------------------------------------------------------------

  /** `op reg, [base, #off]` with a fallback through x17 for offsets out of range. */
  #mem(op: 'ldr' | 'str' | 'ldrb' | 'strb', reg: string, base: string, off: number): void {
    const scale = op.endsWith('b') ? 1 : reg.startsWith('x') ? 8 : 4;
    if (off >= 0 && off % scale === 0 && off / scale <= 4095) {
      this.#emit(`${op} ${reg}, [${base}, #${off}]`);
      return;
    }
    this.#emit(...movImm('x17', off), `add x17, ${base}, x17`, `${op} ${reg}, [x17]`);
  }

  /** reg = base + off. */
  #addr(reg: string, base: string, off: number): void {
    if (off <= 4095) this.#emit(`add ${reg}, ${base}, #${off}`);
    else this.#emit(...movImm('x17', off), `add ${reg}, ${base}, x17`);
  }

  /** Copy `n` words from [src + so] to [dst + d]. Uses w9, w13, x14, x15, x17. */
  #copy(dst: string, d: number, src: string, so: number, n: number): void {
    if (dst === src && d === so) return;
    if (n <= 16) {
      for (let k = 0; k < n; k += 1) {
        this.#mem('ldr', 'w9', src, so + 4 * k);
        this.#mem('str', 'w9', dst, d + 4 * k);
      }
      return;
    }
    const top = this.#label();
    this.#addr('x14', src, so);
    this.#addr('x15', dst, d);
    this.#emit(...movImm('w13', n), `${top}:`);
    this.#emit('ldr w9, [x14], #4', 'str w9, [x15], #4', 'subs w13, w13, #1', `b.ne ${top}`);
  }

  /** A w register holding scalar `v`: its home register, or `scratch` after materializing. */
  #read(v: Val, scratch: string): string {
    if (v.kind === 'lit') {
      this.#emit(...movImm(scratch, v.value));
      return scratch;
    }
    const home = this.#home(v.key);
    if ('reg' in home) return home.reg;
    this.#mem('ldr', scratch, 'sp', home.slot);
    return scratch;
  }

  /** dst = scalar `v`. */
  #into(dst: string, v: Val): void {
    const r = this.#read(v, dst);
    if (r !== dst) this.#emit(`mov ${dst}, ${r}`);
  }

  /**
   * Write scalar `key` with `produce(d)`, which leaves the value in register `d`. A `direct`
   * producer is a single instruction, so `d` may be the home register even when it is also a
   * source; otherwise the value goes through w12.
   */
  #set(key: string, produce: (d: string) => void, direct = false): void {
    const home = this.#home(key);
    if ('reg' in home) {
      if (direct) {
        produce(home.reg);
        return;
      }
      produce('w12');
      this.#emit(`mov ${home.reg}, w12`);
      return;
    }
    produce('w12');
    this.#mem('str', 'w12', 'sp', home.slot);
  }

  /** Store `v` (any type) at [base + off]. */
  #place(v: Val, base: string, off: number): void {
    if (v.kind === 'lit') {
      if (v.value === 0) this.#mem('str', 'wzr', base, off);
      else {
        this.#emit(...movImm('w9', v.value));
        this.#mem('str', 'w9', base, off);
      }
      return;
    }
    if (isPrimitive(v.type)) {
      this.#mem('str', this.#read(v, 'w9'), base, off);
      return;
    }
    this.#copy(base, off, 'sp', this.#slot(v.key), words(v.type));
  }

  /** x10 = (index operand mod n) * elementBytes. Uses w10-w12. */
  #scaledIndex(idx: Val, n: number, elemBytes: number): void {
    const r = this.#read(idx, 'w10');
    if (n === 1) this.#emit('movz w10, #0');
    else if ((n & (n - 1)) === 0) this.#emit(`and w10, ${r}, #${n - 1}`);
    else this.#emit(...movImm('w11', n), `udiv w12, ${r}, w11`, `msub w10, w12, w11, ${r}`);
    if ((elemBytes & (elemBytes - 1)) === 0) this.#emit(`lsl x10, x10, #${Math.log2(elemBytes)}`);
    else this.#emit(...movImm('w11', elemBytes), 'umull x10, w10, w11');
  }

  // --- calls and inlining ------------------------------------------------------------------

  #inlinable(callee: TypedFunc, env: Env): boolean {
    return callee.nodes.length <= INLINE_MAX_NODES && env.depth < INLINE_MAX_DEPTH;
  }

  /** Residual out-of-line call: arguments per the convention, result into `dst`. */
  #call(name: string, callee: TypedFunc, args: readonly Val[], dst: string): void {
    this.#leaf = false;
    const { places, bytes } = argLayout(callee.params);
    this.#outgoing = Math.max(this.#outgoing, bytes);
    for (const a of args) this.#use(a);
    args.forEach((a, k) => {
      const place = places[k] as ArgPlace;
      if (place.reg !== undefined) {
        const r = place.reg;
        if (a.kind === 'lit' || isPrimitive(a.type)) this.#into(`w${r}`, a);
        else this.#addr(`x${r}`, 'sp', this.#slot(a.key));
        return;
      }
      const at = place.stack as number;
      if (a.kind === 'lit' || isPrimitive(a.type)) {
        this.#into('w9', a);
        this.#mem(a.type === 'bool' ? 'strb' : 'str', 'w9', 'sp', at);
      } else {
        this.#addr('x9', 'sp', this.#slot(a.key));
        this.#mem('str', 'x9', 'sp', at);
      }
    });
    if (!isPrimitive(callee.result)) this.#addr('x8', 'sp', this.#slot(dst));
    this.#emit(`bl _a0_${name}`);
    if (isPrimitive(callee.result)) this.#set(dst, (d) => this.#emit(`mov ${d}, w0`), true);
  }

  /**
   * Inline `callee` with its parameters bound to `args`. `sink` 'bind' defines `result` from
   * the callee's return value (aliasing an aggregate); 'store' writes it into the existing
   * `result` (a loop state).
   */
  #inline(
    env: Env,
    callee: TypedFunc,
    args: readonly Val[],
    ownedP0: boolean,
    result: string,
    type: Type,
    tag: string,
    sink: 'bind' | 'store',
  ): void {
    const sub: Env = {
      fn: callee,
      prefix: `${env.prefix}${tag}.`,
      params: args,
      ownedP0,
      depth: env.depth + 1,
    };
    this.#body(sub);
    // The result is written after the body's last node, at a position of its own, so a dead
    // trailing node of the callee can never share the return value's register.
    this.#pos += 1;
    const ret = this.#resolve(sub, callee.ret);
    this.#use(ret);
    if (isPrimitive(type)) {
      if (sink === 'bind') this.#def(result, type);
      this.#set(result, (d) => this.#into(d, ret), true);
      return;
    }
    if (ret.kind !== 'key') refuse('an aggregate literal cannot be returned');
    if (sink === 'bind') {
      this.#defAlias(result, ret.key, type);
      return;
    }
    this.#copy('sp', this.#slot(result), 'sp', this.#slot(ret.key), words(type));
  }

  // --- nodes -------------------------------------------------------------------------------

  #body(env: Env): void {
    for (const [i, n] of env.fn.nodes.entries()) this.#node(env, n, i);
  }

  #node(env: Env, n: Node, index: number): void {
    const t = env.fn.types.get(n.id) ?? refuse(`untyped node ${n.id}`);
    const key = `${env.prefix}n_${n.id}`;
    const vals = n.args.map((o) => this.#resolve(env, o));
    const [a, b, c] = vals;
    this.#pos += 1;
    if (n.op !== 'fold' && n.op !== 'loop') for (const v of vals) this.#use(v);
    const scalar = (produce: (d: string) => void, direct = false): void => {
      this.#def(key, t);
      this.#set(key, produce, direct);
    };
    const bin = (insn: string, imm?: (v: number) => string | undefined): void => {
      const ra = this.#read(a as Val, 'w10');
      const literal = b?.kind === 'lit' && imm !== undefined ? imm(b.value) : undefined;
      if (literal !== undefined) {
        scalar((d) => this.#emit(`${insn} ${d}, ${ra}, ${literal}`), true);
        return;
      }
      const rb = this.#read(b as Val, 'w11');
      scalar((d) => this.#emit(`${insn} ${d}, ${ra}, ${rb}`), true);
    };
    const small = (v: number): string | undefined => (v <= 4095 ? `#${v}` : undefined);
    const logical = (v: number): string | undefined => (isLogicalImm32(v) ? `#${v}` : undefined);
    const shift = (v: number): string => `#${v & 31}`;
    const cmp = (cond: string): void => {
      const ra = this.#read(a as Val, 'w10');
      const rb = b?.kind === 'lit' && b.value <= 4095 ? `#${b.value}` : this.#read(b as Val, 'w11');
      scalar((d) => this.#emit(`cmp ${ra}, ${rb}`, `cset ${d}, ${cond}`), true);
    };
    const aggregateOf = (v: Val, what: string): { key: string; type: Type } => {
      if (v.kind !== 'key' || isPrimitive(v.type)) refuse(`${n.op} needs ${what}`);
      return { key: v.key, type: v.type };
    };
    switch (n.op) {
      case 'mov': {
        const v = a as Val;
        if (v.kind === 'key' && !isPrimitive(v.type)) this.#defAlias(key, v.key, t);
        else scalar((d) => this.#into(d, v), true);
        return;
      }
      case 'add':
        bin('add', small);
        return;
      case 'sub':
        bin('sub', small);
        return;
      case 'mul':
        bin('mul');
        return;
      case 'and':
        bin('and', logical);
        return;
      case 'or':
        bin('orr', logical);
        return;
      case 'xor':
        bin('eor', logical);
        return;
      // LSLV/LSRV on W registers use the distance modulo 32: A0's five-bit mask.
      case 'shl':
        bin('lsl', shift);
        return;
      case 'shr':
        bin('lsr', shift);
        return;
      case 'div': {
        // UDIV yields 0 for a zero divisor; A0 requires all ones.
        const ra = this.#read(a as Val, 'w10');
        const rb = this.#read(b as Val, 'w11');
        scalar((d) =>
          this.#emit(`udiv ${d}, ${ra}, ${rb}`, `cmp ${rb}, #0`, `csinv ${d}, ${d}, wzr, ne`),
        );
        return;
      }
      case 'rem': {
        // a - (a / b) * b; a zero divisor gives quotient 0, hence the dividend (A0's rule).
        const ra = this.#read(a as Val, 'w10');
        const rb = this.#read(b as Val, 'w11');
        scalar((d) => this.#emit(`udiv ${d}, ${ra}, ${rb}`, `msub ${d}, ${d}, ${rb}, ${ra}`));
        return;
      }
      case 'eq':
        cmp('eq');
        return;
      case 'ne':
        cmp('ne');
        return;
      case 'lt':
        cmp('lo');
        return;
      case 'le':
        cmp('ls');
        return;
      case 'gt':
        cmp('hi');
        return;
      case 'ge':
        cmp('hs');
        return;
      case 'select': {
        // Both operands are already computed values; select picks one.
        const rc = this.#read(a as Val, 'w9');
        if (isPrimitive(t)) {
          const rb = this.#read(b as Val, 'w10');
          const rcc = this.#read(c as Val, 'w11');
          scalar((d) => this.#emit(`cmp ${rc}, #0`, `csel ${d}, ${rb}, ${rcc}, ne`), true);
          return;
        }
        this.#def(key, t);
        this.#addr('x10', 'sp', this.#slot(aggregateOf(b as Val, 'a value').key));
        this.#addr('x11', 'sp', this.#slot(aggregateOf(c as Val, 'a value').key));
        this.#emit(`cmp ${rc}, #0`, 'csel x16, x10, x11, ne');
        this.#copy('sp', this.#slot(key), 'x16', 0, words(t));
        return;
      }
      case 'arr':
      case 'rec': {
        this.#def(key, t);
        let off = this.#slot(key);
        for (const v of vals) {
          this.#place(v, 'sp', off);
          off += 4 * words(v.type);
        }
        return;
      }
      case 'get': {
        const src = aggregateOf(a as Val, 'an array');
        const at = src.type;
        if (isPrimitive(at) || at.kind !== 'arr') refuse('get needs an array');
        const ew = words(at.elem);
        const base = this.#slot(src.key);
        if (b?.kind === 'lit') {
          const off = base + (b.value % at.length) * ew * 4;
          if (isPrimitive(t)) scalar((d) => this.#mem('ldr', d, 'sp', off), true);
          else {
            this.#def(key, t);
            this.#copy('sp', this.#slot(key), 'sp', off, ew);
          }
          return;
        }
        this.#scaledIndex(b as Val, at.length, ew * 4);
        this.#addr('x16', 'sp', base);
        if (isPrimitive(t)) scalar((d) => this.#emit(`ldr ${d}, [x16, x10]`), true);
        else {
          this.#def(key, t);
          this.#emit('add x16, x16, x10');
          this.#copy('sp', this.#slot(key), 'x16', 0, ew);
        }
        return;
      }
      case 'set': {
        const src = aggregateOf(a as Val, 'an array');
        const at = src.type;
        if (isPrimitive(at) || at.kind !== 'arr') refuse('set needs an array');
        const ew = words(at.elem);
        if (mutableHere(env.fn, n.args[0] as Operand, index, env.ownedP0))
          this.#defAlias(key, src.key, t);
        else {
          this.#def(key, t);
          this.#copy('sp', this.#slot(key), 'sp', this.#slot(src.key), words(at));
        }
        const dst = this.#slot(key);
        if (b?.kind === 'lit') {
          this.#place(c as Val, 'sp', dst + (b.value % at.length) * ew * 4);
          return;
        }
        this.#scaledIndex(b as Val, at.length, ew * 4);
        this.#addr('x16', 'sp', dst);
        this.#emit('add x16, x16, x10');
        this.#place(c as Val, 'x16', 0);
        return;
      }
      case 'at':
      case 'put': {
        const src = aggregateOf(a as Val, 'a record');
        const rt = src.type;
        if (isPrimitive(rt) || rt.kind !== 'rec' || b?.kind !== 'lit')
          refuse(`${n.op} needs a record and a literal field`);
        const field = rt.fields[b.value] ?? refuse('field out of range');
        const off = 4 * rt.fields.slice(0, b.value).reduce((s, f) => s + words(f), 0);
        if (n.op === 'at') {
          const from = this.#slot(src.key) + off;
          if (isPrimitive(t)) scalar((d) => this.#mem('ldr', d, 'sp', from), true);
          else {
            this.#def(key, t);
            this.#copy('sp', this.#slot(key), 'sp', from, words(field));
          }
          return;
        }
        if (mutableHere(env.fn, n.args[0] as Operand, index, env.ownedP0))
          this.#defAlias(key, src.key, t);
        else {
          this.#def(key, t);
          this.#copy('sp', this.#slot(key), 'sp', this.#slot(src.key), words(rt));
        }
        this.#place(c as Val, 'sp', this.#slot(key) + off);
        return;
      }
      case 'call': {
        const name = n.callee as string;
        const callee = env.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
        if (this.#inlinable(callee, env)) {
          const owned =
            a !== undefined &&
            a.kind === 'key' &&
            !isPrimitive(a.type) &&
            mutableHere(env.fn, n.args[0] as Operand, index, env.ownedP0);
          this.#inline(env, callee, vals, owned, key, t, n.id, 'bind');
          return;
        }
        this.#def(key, t);
        this.#call(name, callee, vals, key);
        return;
      }
      case 'fold':
      case 'loop': {
        const [count, init, ...extras] = vals as [Val, Val, ...Val[]];
        const name = n.callee as string;
        const callee = env.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
        const pred = n.pred === undefined ? undefined : env.fn.calls.get(n.pred);
        const counter = `${env.prefix}i_${n.id}`;
        const state: Val = { kind: 'key', key, type: t };
        const cval: Val = { kind: 'key', key: counter, type: 'u32' };
        // State: a scalar home, or the init slot itself when nothing else reads it.
        this.#use(init);
        for (const e of extras) this.#use(e);
        if (isPrimitive(t)) scalar((d) => this.#into(d, init), true);
        else if (
          init.kind === 'key' &&
          mutableHere(env.fn, n.args[1] as Operand, index, env.ownedP0)
        )
          this.#defAlias(key, init.key, t);
        else {
          this.#def(key, t);
          this.#place(init, 'sp', this.#slot(key));
        }
        this.#def(counter, 'u32');
        this.#set(counter, (d) => this.#emit(`movz ${d}, #0`), true);
        this.#loops.push({ start: this.#pos, used: new Set() });
        const top = this.#label();
        const done = this.#label();
        this.#emit(`${top}:`);
        this.#use(count);
        this.#use(cval);
        const ci = this.#read(cval, 'w9');
        const limit =
          count.kind === 'lit' && count.value <= 4095
            ? `#${count.value}`
            : this.#read(count, 'w10');
        this.#emit(`cmp ${ci}, ${limit}`, `b.hs ${done}`);
        const args: Val[] = [state, cval, ...extras];
        if (pred !== undefined) {
          const pkey = `${env.prefix}c_${n.id}`;
          if (this.#inlinable(pred, env))
            this.#inline(env, pred, args, false, pkey, 'bool', `${n.id}.p`, 'bind');
          else {
            this.#def(pkey, 'bool');
            this.#call(n.pred as string, pred, args, pkey);
          }
          const pv: Val = { kind: 'key', key: pkey, type: 'bool' };
          this.#use(pv);
          this.#emit(`cbz ${this.#read(pv, 'w9')}, ${done}`);
        }
        if (this.#inlinable(callee, env))
          this.#inline(env, callee, args, true, key, t, n.id, 'store');
        else this.#call(name, callee, args, key);
        this.#use(cval);
        const cr = this.#read(cval, 'w9');
        this.#set(counter, (d) => this.#emit(`add ${d}, ${cr}, #1`), true);
        this.#emit(`b ${top}`, `${done}:`);
        // Loop end: values from outside that the body reads stay live to here; so do the state and counter.
        this.#pos += 1;
        this.#use(state);
        this.#use(cval);
        const region = this.#loops.pop();
        if (region !== undefined && this.#dry) {
          for (const k of region.used) {
            const def = this.#defs.get(k);
            if (def !== undefined && def.pos < region.start)
              this.#last.set(k, Math.max(this.#last.get(k) ?? 0, this.#pos));
          }
        }
        return;
      }
      case 'read':
      case 'write':
      case 'puts':
        refuse(`${n.op} is an io operation`);
        return;
    }
  }

  // --- register allocation ---------------------------------------------------------------

  /** Linear scan over definition order: scalars get callee-saved homes (and w0-w7 in a leaf). */
  #allocate(): void {
    const pool = this.#leaf ? [...ARG_REGS, ...CALLEE_SAVED] : CALLEE_SAVED;
    const keys = [...this.#defs.entries()]
      .filter(([k, d]) => isPrimitive(d.type) && !this.#alias.has(k))
      .sort((x, y) => x[1].pos - y[1].pos);
    const busy = new Map<string, number>();
    for (const [key, d] of keys) {
      const last = this.#last.get(key) ?? d.pos;
      for (const [r, l] of busy) if (l <= d.pos) busy.delete(r);
      let reg: string | undefined;
      const p = /^p(\d+)$/.exec(key);
      if (this.#leaf && p !== null && Number(p[1]) < 8 && !busy.has(`w${p[1]}`)) reg = `w${p[1]}`;
      if (reg === undefined) reg = pool.find((r) => !busy.has(r));
      if (reg === undefined) continue;
      busy.set(reg, last);
      this.#regs.set(key, reg);
    }
    const used = new Set([...this.#regs.values()].filter((r) => CALLEE_SAVED.includes(r)));
    this.#saved = CALLEE_SAVED.filter((r) => used.has(r)).map((r) => `x${r.slice(1)}`);
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
    const env: Env = {
      fn,
      prefix: '',
      params: fn.params.map((t, i) => ({ kind: 'key', key: `p${i}`, type: t })),
      ownedP0: true,
      depth: 0,
    };
    // Pass 1 (dry): positions, liveness, aliases, aggregate slots, residual-call needs.
    this.#dry = true;
    this.#pos = 0;
    for (const [i, t] of fn.params.entries()) this.#def(`p${i}`, t);
    this.#body(env);
    this.#pos += 1;
    const ret = this.#resolve(env, fn.ret);
    this.#use(ret);
    this.#allocate();
    for (const [k, d] of this.#defs)
      if (isPrimitive(d.type) && !this.#regs.has(k) && !this.#alias.has(k)) this.#alloc(k, 4);
    if (this.#saved.length > 0) this.#alloc('save', 8 * this.#saved.length, 8);
    const sretSlot = !isPrimitive(fn.result) && !this.#leaf;
    if (sretSlot) this.#alloc('sret', 8, 8);
    this.#outgoing = align(this.#outgoing, 16);
    const frame = this.#outgoing + align(this.#slotBytes, 16);
    // Pass 2: emission.
    this.#dry = false;
    this.out = [];
    this.#labels = 0;
    this.#pos = 0;
    this.#loops = [];
    const sym = `_a0_${fn.name}`;
    this.out.push(`\t.globl ${sym}`, '\t.p2align 2', `${sym}:`);
    this.#emit('stp x29, x30, [sp, #-16]!', 'mov x29, sp');
    if (frame > 4096) {
      // Probe one page at a time so the guard page is never skipped.
      const pages = Math.floor(frame / 4096);
      const probe = this.#label();
      this.#emit(...movImm('w9', pages), `${probe}:`);
      this.#emit('sub sp, sp, #4096', 'str xzr, [sp]', 'subs w9, w9, #1', `b.ne ${probe}`);
      if (frame % 4096 > 0) this.#emit(`sub sp, sp, #${frame % 4096}`);
    } else if (frame > 0) this.#emit(`sub sp, sp, #${frame}`);
    for (const [k, r] of this.#saved.entries())
      this.#mem('str', r, 'sp', this.#slot('save') + 8 * k);
    if (sretSlot) this.#mem('str', 'x8', 'sp', this.#slot('sret'));
    // Incoming parameters: aggregates copied first (their pointers are in x0-x7, which
    // scalar homes may then reuse in a leaf), then register scalars, then stack scalars.
    const { places } = argLayout(fn.params);
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (isPrimitive(t)) return;
      if (place.reg !== undefined)
        this.#copy('sp', this.#slot(`p${i}`), `x${place.reg}`, 0, words(t));
      else {
        this.#mem('ldr', 'x12', 'sp', frame + 16 + (place.stack as number));
        this.#copy('sp', this.#slot(`p${i}`), 'x12', 0, words(t));
      }
    });
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (!isPrimitive(t) || place.reg === undefined) return;
      const r = `w${place.reg}`;
      if (t === 'bool') this.#emit(`and ${r}, ${r}, #1`);
      this.#set(
        `p${i}`,
        (d) => {
          if (d !== r) this.#emit(`mov ${d}, ${r}`);
        },
        true,
      );
    });
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (!isPrimitive(t) || place.stack === undefined) return;
      const incoming = frame + 16 + place.stack;
      this.#set(
        `p${i}`,
        (d) => {
          this.#mem(t === 'bool' ? 'ldrb' : 'ldr', d, 'sp', incoming);
          if (t === 'bool') this.#emit(`and ${d}, ${d}, #1`);
        },
        true,
      );
    });
    this.#body(env);
    this.#pos += 1;
    if (isPrimitive(fn.result)) this.#into('w0', ret);
    else if (this.#leaf) this.#place(ret, 'x8', 0);
    else {
      this.#mem('ldr', 'x12', 'sp', this.#slot('sret'));
      this.#place(ret, 'x12', 0);
    }
    for (const [k, r] of this.#saved.entries())
      this.#mem('ldr', r, 'sp', this.#slot('save') + 8 * k);
    this.#emit('mov sp, x29', 'ldp x29, x30, [sp], #16', 'ret');
    return this.out.join('\n');
  }
}

/** Emit one function as Darwin AArch64 assembly (a `.globl _a0_<name>` block). */
export function emitArm64Function(fn: TypedFunc): string {
  return new FunctionEmitter(fn).emit();
}

/** Assemble function blocks into one .s module for `clang -x assembler` / `as`. */
export function assembleArm64(bodies: readonly string[], compilerVersion: string): string {
  return `; Generated by A0 ${compilerVersion}. Darwin arm64 assembly; exact u32/bool semantics.\n\t.section __TEXT,__text,regular,pure_instructions\n\n${bodies.join('\n\n')}\n\n.subsections_via_symbols\n`;
}
