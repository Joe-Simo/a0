/**
 * Direct native backend: RISC-V RV64 assembly for the LP64 ABI (Linux, or a bare-metal
 * newlib environment; the code is integer-only, RV64IM). A0 reaches the machine through
 * this code generator plus an assembler and linker only; no C is generated for the program.
 *
 * Scope and semantics are those of the AArch64 backend (src/arm64.ts): functions over u32
 * and bool, fixed-size arrays and records of them (value semantics), every scalar op with
 * A0's exact meaning, `call`, `fold`, and `loop` as real loops. io functions are refused.
 *
 * Representation: every value is a sequence of 32-bit words. A register scalar holds its
 * u32 sign-extended to 64 bits, RV64's canonical form: `lw`, `li`, and every W-form
 * instruction (`addw`, `subw`, `mulw`, `sllw`, `srlw`, `divuw`, `remuw`) produce it, the
 * bitwise ops preserve it, and the psABI passes and returns `uint32_t` that way. Sign
 * extension preserves unsigned order between 32-bit values, so `sltu` on canonical
 * registers is A0's unsigned comparison. `divuw` yields all ones for a zero divisor and
 * `remuw` the dividend, exactly A0's rules, with no fix-up.
 *
 * Code shape, register allocation, inlining, in-place updates, and the calling convention
 * for aggregates (by pointer in argument registers; an aggregate result through a pointer
 * in a0, which shifts the parameters to a1 onward) follow src/arm64.ts. Scalar homes are
 * the callee-saved s1-s11, plus a0-a7 in a leaf. Scratch: t0-t5 data and pointers; t6 is
 * reserved for out-of-range addressing (load/store offsets are 12-bit).
 *
 * Frame layout (sp is fixed after the prologue; all slots are addressed from sp):
 *
 *     incoming stack parameters     s0 + 16 + 8k (one XLEN slot each)
 *     saved s0, ra                  <- s0
 *     value slots (S bytes)         sp + O ... sp + O + S - 1
 *     outgoing stack arguments      sp ... sp + O - 1
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
  throw new A0Error(`riscv64: ${message}`, undefined, {
    code: 'structure',
    fix: 'compile io functions with the c target; the riscv64 backend covers io-free functions',
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
const CALLEE_SAVED = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
const ARG_REGS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
/** Reserved for addresses beyond the 12-bit offset range. */
const ADDR = 't6';

const FRESH_OPS = new Set<Op>(['arr', 'rec', 'set', 'put']);

function sameOp(x: Operand, y: Operand): boolean {
  return (
    (x.kind === 'node' && y.kind === 'node' && x.id === y.id) ||
    (x.kind === 'param' && y.kind === 'param' && x.index === y.index)
  );
}

/**
 * May the aggregate operand `o` be updated in place by the node at `index`? The same
 * analysis as the JavaScript and AArch64 backends: sound when the value is provably
 * unshared (a fresh allocation or the owned state parameter p0), every other use is a
 * `get`/`at` read before `index`, and it is not returned.
 */
function mutableHere(
  fn: TypedFunc,
  o: Operand,
  index: number,
  position: number,
  ownedP0: boolean,
): boolean {
  if (o.kind === 'node') {
    const def = fn.nodes.find((n) => n.id === o.id);
    if (def === undefined || !FRESH_OPS.has(def.op)) return false;
  } else if (!(o.kind === 'param' && o.index === 0 && ownedP0)) {
    return false;
  }
  if (sameOp(fn.ret, o)) return false;
  for (const [j, n] of fn.nodes.entries()) {
    for (const [k, arg] of n.args.entries()) {
      if (!sameOp(arg, o)) continue;
      // The updating node itself may name `o` only as its target: a fold whose initial value is
      // also an extra argument reads that value on every trip, so the state needs its own copy.
      if (j === index) {
        if (k !== position) return false;
        continue;
      }
      if (j > index) return false;
      if (!((n.op === 'get' || n.op === 'at') && k === 0)) return false;
    }
  }
  return true;
}

/** Where each parameter travels: an argument register index, or a byte offset in the stack area. */
interface ArgPlace {
  readonly reg?: number;
  readonly stack?: number;
}

/**
 * LP64 placement for a parameter list. An aggregate result takes a0 for its pointer, so
 * the parameters start at a1; every stack argument occupies one 8-byte slot.
 */
function argLayout(params: readonly Type[], result: Type): { places: ArgPlace[]; bytes: number } {
  let next = isPrimitive(result) ? 0 : 1;
  let offset = 0;
  const places = params.map((): ArgPlace => {
    if (next < 8) return { reg: next++ };
    const place: ArgPlace = { stack: offset };
    offset += 8;
    return place;
  });
  return { places, bytes: offset };
}

/** The signed 12-bit immediate that means u32 `v` in canonical form, if there is one. */
function imm12(v: number): number | undefined {
  const s = v | 0;
  return s >= -2048 && s <= 2047 ? s : undefined;
}

/** A value in the emitter: a literal, or a named key whose home is a register or a slot. */
type Val =
  | { readonly kind: 'lit'; readonly value: number; readonly type: 'u32' | 'bool' }
  | { readonly kind: 'key'; readonly key: string; readonly type: Type };

/** One function body being emitted, either the top level or an inlined callee. */
interface Env {
  readonly fn: TypedFunc;
  readonly prefix: string;
  readonly params: readonly Val[];
  readonly ownedP0: boolean;
  readonly depth: number;
}

type Home = { readonly reg: string } | { readonly slot: number };

type MemOp = 'lw' | 'sw' | 'lbu' | 'sb' | 'ld' | 'sd';

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
    return `.La0_${this.fn.name}_${this.#labels}`;
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
      throw new A0Error(`riscv64: no slot for ${key}`);
    }
    return this.#outgoing + off;
  }

  #def(key: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    if (!isPrimitive(type)) this.#alloc(key, 4 * words(type));
  }

  #defAlias(key: string, target: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    this.#alias.set(key, this.#canon(target));
  }

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

  /** `op reg, off(base)` with a fallback through t6 for offsets outside the 12-bit range. */
  #mem(op: MemOp, reg: string, base: string, off: number): void {
    if (off >= -2048 && off <= 2047) {
      this.#emit(`${op} ${reg}, ${off}(${base})`);
      return;
    }
    this.#emit(`li ${ADDR}, ${off}`, `add ${ADDR}, ${base}, ${ADDR}`, `${op} ${reg}, 0(${ADDR})`);
  }

  /** reg = base + off. */
  #addr(reg: string, base: string, off: number): void {
    if (off <= 2047) this.#emit(`addi ${reg}, ${base}, ${off}`);
    else this.#emit(`li ${ADDR}, ${off}`, `add ${reg}, ${base}, ${ADDR}`);
  }

  /** Copy `n` words from [src + so] to [dst + d]. Uses t0, t3, t4, t5, t6. */
  #copy(dst: string, d: number, src: string, so: number, n: number): void {
    if (dst === src && d === so) return;
    if (n <= 16) {
      for (let k = 0; k < n; k += 1) {
        this.#mem('lw', 't0', src, so + 4 * k);
        this.#mem('sw', 't0', dst, d + 4 * k);
      }
      return;
    }
    const top = this.#label();
    this.#addr('t4', src, so);
    this.#addr('t5', dst, d);
    this.#emit(`li t3, ${n}`, `${top}:`);
    this.#emit(
      'lw t0, 0(t4)',
      'sw t0, 0(t5)',
      'addi t4, t4, 4',
      'addi t5, t5, 4',
      'addi t3, t3, -1',
      `bnez t3, ${top}`,
    );
  }

  /** A register holding scalar `v`: its home register, or `scratch` after materializing. */
  #read(v: Val, scratch: string): string {
    if (v.kind === 'lit') {
      this.#emit(`li ${scratch}, ${v.value | 0}`);
      return scratch;
    }
    const home = this.#home(v.key);
    if ('reg' in home) return home.reg;
    this.#mem('lw', scratch, 'sp', home.slot);
    return scratch;
  }

  /** dst = scalar `v`. */
  #into(dst: string, v: Val): void {
    const r = this.#read(v, dst);
    if (r !== dst) this.#emit(`mv ${dst}, ${r}`);
  }

  /**
   * Write scalar `key` with `produce(d)`, which leaves the value in register `d`. A `direct`
   * producer reads its sources before writing `d`, so `d` may be the home register even when
   * it is also a source; otherwise the value goes through t3.
   */
  #set(key: string, produce: (d: string) => void, direct = false): void {
    const home = this.#home(key);
    if ('reg' in home) {
      if (direct) {
        produce(home.reg);
        return;
      }
      produce('t3');
      this.#emit(`mv ${home.reg}, t3`);
      return;
    }
    produce('t3');
    this.#mem('sw', 't3', 'sp', home.slot);
  }

  /** Store `v` (any type) at [base + off]. */
  #place(v: Val, base: string, off: number): void {
    if (v.kind === 'lit') {
      if (v.value === 0) this.#mem('sw', 'zero', base, off);
      else {
        this.#emit(`li t0, ${v.value | 0}`);
        this.#mem('sw', 't0', base, off);
      }
      return;
    }
    if (isPrimitive(v.type)) {
      this.#mem('sw', this.#read(v, 't0'), base, off);
      return;
    }
    this.#copy(base, off, 'sp', this.#slot(v.key), words(v.type));
  }

  /** t1 = (index operand mod n) * elementBytes. Uses t1-t3. */
  #scaledIndex(idx: Val, n: number, elemBytes: number): void {
    const r = this.#read(idx, 't1');
    if (n === 1) this.#emit('li t1, 0');
    else if ((n & (n - 1)) === 0) {
      const m = imm12(n - 1);
      if (m !== undefined) this.#emit(`andi t1, ${r}, ${m}`);
      else this.#emit(`li t2, ${n - 1}`, `and t1, ${r}, t2`);
    } else this.#emit(`li t2, ${n}`, `remuw t1, ${r}, t2`);
    // The index is now a non-negative 32-bit value; widen it to a byte offset.
    if ((elemBytes & (elemBytes - 1)) === 0) {
      const sh = Math.log2(elemBytes);
      if (sh > 0) this.#emit(`slli t1, t1, ${sh}`);
    } else this.#emit(`li t2, ${elemBytes}`, 'mul t1, t1, t2');
  }

  // --- calls and inlining ------------------------------------------------------------------

  #inlinable(callee: TypedFunc, env: Env): boolean {
    return callee.nodes.length <= INLINE_MAX_NODES && env.depth < INLINE_MAX_DEPTH;
  }

  /** Residual out-of-line call: arguments per the convention, result into `dst`. */
  #call(name: string, callee: TypedFunc, args: readonly Val[], dst: string): void {
    this.#leaf = false;
    const { places, bytes } = argLayout(callee.params, callee.result);
    this.#outgoing = Math.max(this.#outgoing, bytes);
    for (const a of args) this.#use(a);
    args.forEach((a, k) => {
      const place = places[k] as ArgPlace;
      if (place.reg !== undefined) {
        const r = `a${place.reg}`;
        if (a.kind === 'lit' || isPrimitive(a.type)) this.#into(r, a);
        else this.#addr(r, 'sp', this.#slot(a.key));
        return;
      }
      const at = place.stack as number;
      if (a.kind === 'lit' || isPrimitive(a.type)) this.#into('t0', a);
      else this.#addr('t0', 'sp', this.#slot(a.key));
      this.#mem('sd', 't0', 'sp', at);
    });
    if (!isPrimitive(callee.result)) this.#addr('a0', 'sp', this.#slot(dst));
    this.#emit(`call a0_${name}`);
    if (isPrimitive(callee.result)) this.#set(dst, (d) => this.#emit(`mv ${d}, a0`), true);
  }

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
    /** `insn d, a, b`, or `immInsn d, a, imm` when b is a literal that `imm` accepts. */
    const bin = (insn: string, immInsn?: string, imm?: (v: number) => number | undefined): void => {
      const ra = this.#read(a as Val, 't1');
      const literal = b?.kind === 'lit' && imm !== undefined ? imm(b.value) : undefined;
      if (literal !== undefined) {
        scalar((d) => this.#emit(`${immInsn} ${d}, ${ra}, ${literal}`), true);
        return;
      }
      const rb = this.#read(b as Val, 't2');
      scalar((d) => this.#emit(`${insn} ${d}, ${ra}, ${rb}`), true);
    };
    const shift = (v: number): number => v & 31;
    const negated = (v: number): number | undefined => imm12(-(v | 0));
    /** Unsigned comparison; `swap` computes b < a, `invert` negates the result. */
    const cmp = (swap: boolean, invert: boolean): void => {
      const ra = this.#read(a as Val, 't1');
      const lit = !swap && !invert && b?.kind === 'lit' ? imm12(b.value) : undefined;
      if (lit !== undefined) {
        scalar((d) => this.#emit(`sltiu ${d}, ${ra}, ${lit}`), true);
        return;
      }
      const rb = this.#read(b as Val, 't2');
      scalar((d) => {
        this.#emit(swap ? `sltu ${d}, ${rb}, ${ra}` : `sltu ${d}, ${ra}, ${rb}`);
        if (invert) this.#emit(`xori ${d}, ${d}, 1`);
      }, true);
    };
    const equality = (insn: 'seqz' | 'snez'): void => {
      const ra = this.#read(a as Val, 't1');
      const lit = b?.kind === 'lit' ? imm12(b.value) : undefined;
      if (lit !== undefined) {
        scalar((d) => this.#emit(`xori ${d}, ${ra}, ${lit}`, `${insn} ${d}, ${d}`), true);
        return;
      }
      const rb = this.#read(b as Val, 't2');
      scalar((d) => this.#emit(`xor ${d}, ${ra}, ${rb}`, `${insn} ${d}, ${d}`), true);
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
        bin('addw', 'addiw', imm12);
        return;
      case 'sub':
        bin('subw', 'addiw', negated);
        return;
      case 'mul':
        bin('mulw');
        return;
      case 'and':
        bin('and', 'andi', imm12);
        return;
      case 'or':
        bin('or', 'ori', imm12);
        return;
      case 'xor':
        bin('xor', 'xori', imm12);
        return;
      // SLLW/SRLW use the low five bits of the distance: A0's mask.
      case 'shl':
        bin('sllw', 'slliw', shift);
        return;
      case 'shr':
        bin('srlw', 'srliw', shift);
        return;
      // DIVUW gives all ones and REMUW the dividend for a zero divisor: A0's rules.
      case 'div':
        bin('divuw');
        return;
      case 'rem':
        bin('remuw');
        return;
      case 'eq':
        equality('seqz');
        return;
      case 'ne':
        equality('snez');
        return;
      case 'lt':
        cmp(false, false);
        return;
      case 'le':
        cmp(true, true);
        return;
      case 'gt':
        cmp(true, false);
        return;
      case 'ge':
        cmp(false, true);
        return;
      case 'select': {
        // Both operands are already computed values; select picks one.
        const rc = this.#read(a as Val, 't0');
        const other = this.#label();
        const end = this.#label();
        if (isPrimitive(t)) {
          const rb = this.#read(b as Val, 't1');
          const rcc = this.#read(c as Val, 't2');
          scalar((d) => {
            this.#emit(`beqz ${rc}, ${other}`, `mv ${d}, ${rb}`, `j ${end}`, `${other}:`);
            this.#emit(`mv ${d}, ${rcc}`, `${end}:`);
          }, true);
          return;
        }
        this.#def(key, t);
        this.#emit(`beqz ${rc}, ${other}`);
        this.#addr('t1', 'sp', this.#slot(aggregateOf(b as Val, 'a value').key));
        this.#emit(`j ${end}`, `${other}:`);
        this.#addr('t1', 'sp', this.#slot(aggregateOf(c as Val, 'a value').key));
        this.#emit(`${end}:`);
        this.#copy('sp', this.#slot(key), 't1', 0, words(t));
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
          if (isPrimitive(t)) scalar((d) => this.#mem('lw', d, 'sp', off), true);
          else {
            this.#def(key, t);
            this.#copy('sp', this.#slot(key), 'sp', off, ew);
          }
          return;
        }
        this.#scaledIndex(b as Val, at.length, ew * 4);
        this.#addr('t2', 'sp', base);
        this.#emit('add t1, t1, t2');
        if (isPrimitive(t)) scalar((d) => this.#emit(`lw ${d}, 0(t1)`), true);
        else {
          this.#def(key, t);
          this.#copy('sp', this.#slot(key), 't1', 0, ew);
        }
        return;
      }
      case 'set': {
        const src = aggregateOf(a as Val, 'an array');
        const at = src.type;
        if (isPrimitive(at) || at.kind !== 'arr') refuse('set needs an array');
        const ew = words(at.elem);
        if (mutableHere(env.fn, n.args[0] as Operand, index, 0, env.ownedP0))
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
        this.#addr('t2', 'sp', dst);
        this.#emit('add t1, t1, t2');
        this.#place(c as Val, 't1', 0);
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
          if (isPrimitive(t)) scalar((d) => this.#mem('lw', d, 'sp', from), true);
          else {
            this.#def(key, t);
            this.#copy('sp', this.#slot(key), 'sp', from, words(field));
          }
          return;
        }
        if (mutableHere(env.fn, n.args[0] as Operand, index, 0, env.ownedP0))
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
            mutableHere(env.fn, n.args[0] as Operand, index, 0, env.ownedP0);
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
          mutableHere(env.fn, n.args[1] as Operand, index, 1, env.ownedP0)
        )
          this.#defAlias(key, init.key, t);
        else {
          this.#def(key, t);
          this.#place(init, 'sp', this.#slot(key));
        }
        this.#def(counter, 'u32');
        this.#set(counter, (d) => this.#emit(`li ${d}, 0`), true);
        this.#loops.push({ start: this.#pos, used: new Set() });
        const top = this.#label();
        const done = this.#label();
        this.#emit(`${top}:`);
        this.#use(count);
        this.#use(cval);
        const ci = this.#read(cval, 't0');
        const limit = this.#read(count, 't1');
        this.#emit(`bgeu ${ci}, ${limit}, ${done}`);
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
          this.#emit(`beqz ${this.#read(pv, 't0')}, ${done}`);
        }
        if (this.#inlinable(callee, env))
          this.#inline(env, callee, args, true, key, t, n.id, 'store');
        else this.#call(name, callee, args, key);
        this.#use(cval);
        const cr = this.#read(cval, 't0');
        this.#set(counter, (d) => this.#emit(`addiw ${d}, ${cr}, 1`), true);
        this.#emit(`j ${top}`, `${done}:`);
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

  /** Linear scan over definition order: scalars get callee-saved homes (and a0-a7 in a leaf). */
  #allocate(): void {
    const pool = this.#leaf ? [...ARG_REGS, ...CALLEE_SAVED] : CALLEE_SAVED;
    const shift = isPrimitive(this.fn.result) ? 0 : 1;
    const keys = [...this.#defs.entries()]
      .filter(([k, d]) => isPrimitive(d.type) && !this.#alias.has(k))
      .sort((x, y) => x[1].pos - y[1].pos);
    const busy = new Map<string, number>();
    for (const [key, d] of keys) {
      const last = this.#last.get(key) ?? d.pos;
      for (const [r, l] of busy) if (l <= d.pos) busy.delete(r);
      let reg: string | undefined;
      const p = /^p(\d+)$/.exec(key);
      if (this.#leaf && p !== null) {
        const own = `a${Number(p[1]) + shift}`;
        if (ARG_REGS.includes(own) && !busy.has(own)) reg = own;
      }
      if (reg === undefined) reg = pool.find((r) => !busy.has(r));
      if (reg === undefined) continue;
      busy.set(reg, last);
      this.#regs.set(key, reg);
    }
    const used = new Set(this.#regs.values());
    this.#saved = CALLEE_SAVED.filter((r) => used.has(r));
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
    // The result pointer arrives in a0, which a leaf reuses as a home: it always gets a slot.
    const sretSlot = !isPrimitive(fn.result);
    if (sretSlot) this.#alloc('sret', 8, 8);
    this.#outgoing = align(this.#outgoing, 16);
    const frame = this.#outgoing + align(this.#slotBytes, 16);
    // Pass 2: emission.
    this.#dry = false;
    this.out = [];
    this.#labels = 0;
    this.#pos = 0;
    this.#loops = [];
    const sym = `a0_${fn.name}`;
    this.out.push(`\t.globl ${sym}`, `\t.type ${sym}, @function`, '\t.p2align 2', `${sym}:`);
    this.#emit('addi sp, sp, -16', 'sd s0, 0(sp)', 'sd ra, 8(sp)', 'mv s0, sp');
    if (frame > 4096) {
      // Probe one page at a time so a guard page is never skipped.
      const pages = Math.floor(frame / 4096);
      const probe = this.#label();
      this.#emit(`li t0, ${pages}`, `${probe}:`);
      this.#emit('addi sp, sp, -2048', 'addi sp, sp, -2048', 'sd zero, 0(sp)');
      this.#emit('addi t0, t0, -1', `bnez t0, ${probe}`);
      if (frame % 4096 > 0) this.#emit(`addi sp, sp, -${frame % 4096}`);
    } else if (frame > 2048) this.#emit(`li ${ADDR}, ${frame}`, `sub sp, sp, ${ADDR}`);
    else if (frame > 0) this.#emit(`addi sp, sp, -${frame}`);
    for (const [k, r] of this.#saved.entries())
      this.#mem('sd', r, 'sp', this.#slot('save') + 8 * k);
    if (sretSlot) this.#mem('sd', 'a0', 'sp', this.#slot('sret'));
    // Incoming parameters: aggregates copied first (their pointers are in a0-a7, which
    // scalar homes may then reuse in a leaf), then register scalars, then stack scalars.
    const { places } = argLayout(fn.params, fn.result);
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (isPrimitive(t)) return;
      if (place.reg !== undefined)
        this.#copy('sp', this.#slot(`p${i}`), `a${place.reg}`, 0, words(t));
      else {
        this.#mem('ld', 't3', 'sp', frame + 16 + (place.stack as number));
        this.#copy('sp', this.#slot(`p${i}`), 't3', 0, words(t));
      }
    });
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (!isPrimitive(t) || place.reg === undefined) return;
      const r = `a${place.reg}`;
      if (t === 'bool') this.#emit(`andi ${r}, ${r}, 1`);
      this.#set(
        `p${i}`,
        (d) => {
          if (d !== r) this.#emit(`mv ${d}, ${r}`);
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
          this.#mem(t === 'bool' ? 'lbu' : 'lw', d, 'sp', incoming);
          if (t === 'bool') this.#emit(`andi ${d}, ${d}, 1`);
        },
        true,
      );
    });
    this.#body(env);
    this.#pos += 1;
    if (isPrimitive(fn.result)) this.#into('a0', ret);
    else {
      this.#mem('ld', 't3', 'sp', this.#slot('sret'));
      this.#place(ret, 't3', 0);
    }
    for (const [k, r] of this.#saved.entries())
      this.#mem('ld', r, 'sp', this.#slot('save') + 8 * k);
    this.#emit('mv sp, s0', 'ld s0, 0(sp)', 'ld ra, 8(sp)', 'addi sp, sp, 16', 'ret');
    this.out.push(`\t.size ${sym}, .-${sym}`);
    return this.out.join('\n');
  }
}

/** Emit one function as RV64 assembly (a `.globl a0_<name>` block). */
export function emitRiscv64Function(fn: TypedFunc): string {
  return new FunctionEmitter(fn).emit();
}

/** Assemble function blocks into one .s module for a GNU or LLVM RISC-V assembler. */
export function assembleRiscv64(bodies: readonly string[], compilerVersion: string): string {
  return `# Generated by A0 ${compilerVersion}. RISC-V RV64 (LP64) assembly; exact u32/bool semantics.\n\t.text\n\n${bodies.join('\n\n')}\n\n\t.section .note.GNU-stack,"",@progbits\n`;
}
