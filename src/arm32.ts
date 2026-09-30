/**
 * Direct native backend: 32-bit ARM assembly (ARMv7-A, A32 "ARM mode" instructions, AAPCS
 * with the hard-float variant, GNU/Linux ELF: arm-linux-gnueabihf, the Raspberry Pi 2/3
 * 32-bit userland). A0 reaches the machine through this code generator plus an assembler and
 * linker only; no C is generated for the program.
 *
 * Scope: the same as the AArch64 backend (src/arm64.ts). Functions over u32 and bool,
 * fixed-size arrays and records of them (value semantics), every scalar op with A0's exact
 * meaning, `call`, `fold`, and `loop` as real loops with literal or variable trip counts.
 * io functions are refused (the C path covers them).
 *
 * Representation: every value is a sequence of 32-bit words. u32 is one word and maps
 * directly onto a 32-bit register (no masking anywhere: ARM arithmetic wraps modulo 2^32),
 * bool is one word holding 0 or 1, an array is its elements back to back, a record its
 * fields in order.
 *
 * Instruction set choice: ARMv7-A baseline. UDIV/SDIV are optional on ARMv7-A (present on
 * ARMv7VE cores such as Cortex-A7/A15, absent on Cortex-A8/A9), so `div`, `rem`, and index
 * reduction modulo a non-power-of-two length call a local shift-subtract routine
 * (`.La0_udivmod`, 32 iterations, emitted once per module when used) that also gives A0's
 * zero-divisor values (quotient all ones, remainder the dividend). ARM mode rather than
 * Thumb-2 keeps every instruction unconditional-or-predicated without IT blocks. No VFP or
 * NEON instruction is emitted, so the float ABI never matters for these integer-only
 * signatures; the module is marked hard-float (Tag_ABI_VFP_args) to link with gnueabihf code.
 *
 * Code shape (the AArch64 backend's second version, on a 16-register machine):
 * - Small callees (at most INLINE_MAX_NODES nodes, nested to INLINE_MAX_DEPTH) are inlined
 *   at `call`, `fold`, and `loop` sites; larger callees are called out of line.
 * - Scalars live in registers. A linear scan over definition order gives each u32/bool
 *   value a home among the callee-saved r4-r10 (spilled to a stack slot when they run out).
 *   r0-r3, r12, and lr are scratch in every function (r0-r3 because the divide routine and
 *   calls use them), r11 is the frame pointer.
 * - Aggregates live in stack slots and are updated in place when provably unshared (the
 *   same `mutableHere` analysis as the JavaScript and AArch64 backends).
 *
 * Calling convention (AAPCS for scalar signatures, so C can call `a0_<name>` directly):
 * - An aggregate result is written through a hidden pointer passed in r0; each parameter
 *   then takes the next of r0-r3: a scalar as its value (bool 0/1), an aggregate as a
 *   pointer to a caller-owned slot that the caller never changes. The callee copies
 *   aggregate parameters into its own slots on entry and never writes through the pointer.
 * - After the registers, parameters go to the stack, one word each, from the caller's sp.
 * - A scalar result returns in r0. The sret result is written after all parameters were
 *   copied, so it may alias an argument slot (fold state updates rely on this).
 *
 * Frame layout (sp is fixed after the prologue; all slots are addressed from sp):
 *
 *     incoming stack parameters     r11 + 4 * P + 4k
 *     pushed registers (P words)    <- r11: used r4-r10, r11, lr, and r12 as padding to 8 bytes
 *     value slots (S bytes)         sp + O ... sp + O + S - 1
 *       (sret pointer, aggregate pointers, aggregates, spilled scalars)
 *     outgoing stack arguments      sp ... sp + O - 1
 *
 * S and O are rounded to 8, so sp keeps AAPCS's 8-byte alignment at every call. Frames above
 * 4 KiB are probed one page at a time in the prologue. Scratch: r0/r1 operands and index,
 * r2 results and copy counter, r3 data, r12 addresses, lr large offsets.
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
  throw new A0Error(`arm32: ${message}`, undefined, {
    code: 'structure',
    fix: 'compile io functions with the c target; the arm32 backend covers io-free functions',
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
const CALLEE_SAVED = ['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'];
/** Scratch roles. */
const A = 'r0';
const B = 'r1';
const D = 'r2';
const T = 'r3';
const ADDR = 'r12';
const FAR = 'lr';
const UDIVMOD = '.La0_udivmod';

const FRESH_OPS = new Set<Op>(['arr', 'rec', 'set', 'put']);

function sameOp(x: Operand, y: Operand): boolean {
  return (
    (x.kind === 'node' && y.kind === 'node' && x.id === y.id) ||
    (x.kind === 'param' && y.kind === 'param' && x.index === y.index)
  );
}

/** The AArch64 backend's in-place analysis (see src/arm64.ts). */
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
}

/** AAPCS placement; an aggregate result takes r0 first. `bytes` is the stack area used. */
function argLayout(params: readonly Type[], sret: boolean): { places: ArgPlace[]; bytes: number } {
  let next = sret ? 1 : 0;
  let offset = 0;
  const places = params.map((): ArgPlace => {
    if (next < 4) return { reg: next++ };
    const place: ArgPlace = { stack: offset };
    offset += 4;
    return place;
  });
  return { places, bytes: offset };
}

/** Is `v` an A32 modified immediate (an 8-bit value rotated right by an even amount)? */
export function isArmImm(v: number): boolean {
  const x = v >>> 0;
  for (let r = 0; r < 32; r += 2) {
    const rotl = r === 0 ? x : ((x << r) | (x >>> (32 - r))) >>> 0;
    if (rotl <= 0xff) return true;
  }
  return false;
}

/** 32-bit immediate materialization: one mov/mvn when encodable, else movw (+ movt). */
function movImm(reg: string, value: number): string[] {
  const v = value >>> 0;
  if (isArmImm(v)) return [`mov ${reg}, #${v}`];
  if (isArmImm(~v >>> 0)) return [`mvn ${reg}, #${~v >>> 0}`];
  const out = [`movw ${reg}, #${v & 0xffff}`];
  if (v >>> 16 !== 0) out.push(`movt ${reg}, #${v >>> 16}`);
  return out;
}

/** The local divide routine: r0 = n, r1 = d -> r0 = n / d, r1 = n % d; clobbers r2, r3. */
const UDIVMOD_ROUTINE = [
  '\t.p2align 2',
  `${UDIVMOD}:`,
  '\tcmp r1, #0',
  '\tmoveq r1, r0',
  '\tmvneq r0, #0',
  '\tbxeq lr',
  '\tmov r2, #0',
  '\tmov r3, #32',
  '.La0_udivmod_loop:',
  // Shift the next dividend bit into the partial remainder (after k bits it is below 2^k,
  // so it fits in 32 bits) and the quotient bit in where the dividend bit left.
  '\tadds r0, r0, r0',
  '\tadc r2, r2, r2',
  '\tcmp r2, r1',
  '\tsubcs r2, r2, r1',
  '\torrcs r0, r0, #1',
  '\tsubs r3, r3, #1',
  '\tbne .La0_udivmod_loop',
  '\tmov r1, r2',
  '\tbx lr',
].join('\n');

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

  #alloc(key: string, bytes: number): number {
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

  #slot(key: string): number {
    const off = this.#slots.get(this.#canon(key));
    if (off === undefined) {
      if (this.#dry) return 0;
      throw new A0Error(`arm32: no slot for ${key}`);
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

  /** `op reg, [base, #off]` (A32 immediate offsets reach 4095), else through lr. */
  #mem(op: 'ldr' | 'str' | 'ldrb', reg: string, base: string, off: number): void {
    if (off >= 0 && off <= 4095) this.#emit(`${op} ${reg}, [${base}, #${off}]`);
    else this.#emit(...movImm(FAR, off), `${op} ${reg}, [${base}, ${FAR}]`);
  }

  /** reg = base + off. */
  #addr(reg: string, base: string, off: number): void {
    if (isArmImm(off)) this.#emit(`add ${reg}, ${base}, #${off}`);
    else this.#emit(...movImm(FAR, off), `add ${reg}, ${base}, ${FAR}`);
  }

  /** Copy `n` words from [src + so] to [dst + d]. Uses r0-r3 and lr; bases are sp or r12. */
  #copy(dst: string, d: number, src: string, so: number, n: number): void {
    if (dst === src && d === so) return;
    if (n <= 16) {
      for (let k = 0; k < n; k += 1) {
        this.#mem('ldr', T, src, so + 4 * k);
        this.#mem('str', T, dst, d + 4 * k);
      }
      return;
    }
    const top = this.#label();
    this.#addr(A, src, so);
    this.#addr(B, dst, d);
    this.#emit(...movImm(D, n), `${top}:`);
    this.#emit(`ldr ${T}, [${A}], #4`, `str ${T}, [${B}], #4`, `subs ${D}, ${D}, #1`, `bne ${top}`);
  }

  /** A register holding scalar `v`: its home register, or `scratch` after materializing. */
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

  #into(dst: string, v: Val): void {
    const r = this.#read(v, dst);
    if (r !== dst) this.#emit(`mov ${dst}, ${r}`);
  }

  /**
   * Write scalar `key` with `produce(d)`. A `direct` producer may target the home register
   * even when it is also a source; otherwise the value goes through r2.
   */
  #set(key: string, produce: (d: string) => void, direct = false): void {
    const home = this.#home(key);
    if ('reg' in home) {
      if (direct) {
        produce(home.reg);
        return;
      }
      produce(D);
      this.#emit(`mov ${home.reg}, ${D}`);
      return;
    }
    produce(D);
    this.#mem('str', D, 'sp', home.slot);
  }

  /** Store `v` (any type) at [base + off]. */
  #place(v: Val, base: string, off: number): void {
    if (v.kind === 'lit') {
      this.#emit(...movImm(T, v.value));
      this.#mem('str', T, base, off);
      return;
    }
    if (isPrimitive(v.type)) {
      this.#mem('str', this.#read(v, T), base, off);
      return;
    }
    this.#copy(base, off, 'sp', this.#slot(v.key), words(v.type));
  }

  /** r0 = (index operand mod n) * elementBytes. Uses r0-r3 (the divide routine) and lr. */
  #scaledIndex(idx: Val, n: number, elemBytes: number): void {
    this.#into(A, idx);
    if (n === 1) this.#emit(`mov ${A}, #0`);
    else if ((n & (n - 1)) === 0) this.#emit(`ubfx ${A}, ${A}, #0, #${Math.log2(n)}`);
    else this.#emit(...movImm(B, n), `bl ${UDIVMOD}`, `mov ${A}, ${B}`);
    if ((elemBytes & (elemBytes - 1)) === 0) {
      if (elemBytes > 1) this.#emit(`lsl ${A}, ${A}, #${Math.log2(elemBytes)}`);
    } else this.#emit(...movImm(B, elemBytes), `mul ${A}, ${A}, ${B}`);
  }

  // --- calls and inlining ------------------------------------------------------------------

  #inlinable(callee: TypedFunc, env: Env): boolean {
    return callee.nodes.length <= INLINE_MAX_NODES && env.depth < INLINE_MAX_DEPTH;
  }

  /** Residual out-of-line call: arguments per the convention, result into `dst`. */
  #call(name: string, callee: TypedFunc, args: readonly Val[], dst: string): void {
    const sret = !isPrimitive(callee.result);
    const { places, bytes } = argLayout(callee.params, sret);
    this.#outgoing = Math.max(this.#outgoing, bytes);
    for (const a of args) this.#use(a);
    // Stack arguments first: they go through r3, which may also carry a register argument.
    args.forEach((a, k) => {
      const at = (places[k] as ArgPlace).stack;
      if (at === undefined) return;
      if (a.kind === 'lit' || isPrimitive(a.type)) this.#mem('str', this.#read(a, T), 'sp', at);
      else {
        this.#addr(T, 'sp', this.#slot(a.key));
        this.#mem('str', T, 'sp', at);
      }
    });
    args.forEach((a, k) => {
      const r = (places[k] as ArgPlace).reg;
      if (r === undefined) return;
      if (a.kind === 'lit' || isPrimitive(a.type)) this.#into(`r${r}`, a);
      else this.#addr(`r${r}`, 'sp', this.#slot(a.key));
    });
    if (sret) this.#addr('r0', 'sp', this.#slot(dst));
    this.#emit(`bl a0_${name}`);
    if (!sret) this.#set(dst, (d) => this.#emit(`mov ${d}, r0`), true);
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
    const bin = (insn: string, imm = false): void => {
      const ra = this.#read(a as Val, A);
      if (imm && b?.kind === 'lit' && isArmImm(b.value)) {
        const v = b.value;
        scalar((d) => this.#emit(`${insn} ${d}, ${ra}, #${v}`), true);
        return;
      }
      const rb = this.#read(b as Val, B);
      scalar((d) => this.#emit(`${insn} ${d}, ${ra}, ${rb}`), true);
    };
    // A register-specified shift uses the low byte of the distance; A0 masks it to five bits.
    const shift = (insn: string): void => {
      const ra = this.#read(a as Val, A);
      if (b?.kind === 'lit') {
        const s = b.value & 31;
        scalar((d) => this.#emit(s === 0 ? `mov ${d}, ${ra}` : `${insn} ${d}, ${ra}, #${s}`), true);
        return;
      }
      const rb = this.#read(b as Val, B);
      this.#emit(`and ${T}, ${rb}, #31`);
      scalar((d) => this.#emit(`${insn} ${d}, ${ra}, ${T}`), true);
    };
    const cmp = (cond: string): void => {
      const ra = this.#read(a as Val, A);
      const rb = b?.kind === 'lit' && isArmImm(b.value) ? `#${b.value}` : this.#read(b as Val, B);
      scalar((d) => this.#emit(`cmp ${ra}, ${rb}`, `mov ${d}, #0`, `mov${cond} ${d}, #1`), true);
    };
    const divide = (result: 'r0' | 'r1'): void => {
      this.#into(A, a as Val);
      this.#into(B, b as Val);
      this.#emit(`bl ${UDIVMOD}`);
      scalar((d) => this.#emit(`mov ${d}, ${result}`), true);
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
        bin('add', true);
        return;
      case 'sub':
        bin('sub', true);
        return;
      case 'mul':
        bin('mul');
        return;
      case 'and':
        bin('and', true);
        return;
      case 'or':
        bin('orr', true);
        return;
      case 'xor':
        bin('eor', true);
        return;
      case 'shl':
        shift('lsl');
        return;
      case 'shr':
        shift('lsr');
        return;
      case 'div':
        divide('r0');
        return;
      case 'rem':
        divide('r1');
        return;
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
        const rc = this.#read(a as Val, T);
        if (isPrimitive(t)) {
          const rb = this.#read(b as Val, A);
          const rcc = this.#read(c as Val, B);
          scalar(
            (d) => this.#emit(`cmp ${rc}, #0`, `movne ${d}, ${rb}`, `moveq ${d}, ${rcc}`),
            true,
          );
          return;
        }
        this.#def(key, t);
        this.#addr(A, 'sp', this.#slot(aggregateOf(b as Val, 'a value').key));
        this.#addr(B, 'sp', this.#slot(aggregateOf(c as Val, 'a value').key));
        this.#emit(`cmp ${rc}, #0`, `movne ${ADDR}, ${A}`, `moveq ${ADDR}, ${B}`);
        this.#copy('sp', this.#slot(key), ADDR, 0, words(t));
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
        this.#addr(ADDR, 'sp', base);
        if (isPrimitive(t)) scalar((d) => this.#emit(`ldr ${d}, [${ADDR}, ${A}]`), true);
        else {
          this.#def(key, t);
          this.#emit(`add ${ADDR}, ${ADDR}, ${A}`);
          this.#copy('sp', this.#slot(key), ADDR, 0, ew);
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
        this.#addr(ADDR, 'sp', dst);
        this.#emit(`add ${ADDR}, ${ADDR}, ${A}`);
        this.#place(c as Val, ADDR, 0);
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
        this.#set(counter, (d) => this.#emit(`mov ${d}, #0`), true);
        this.#loops.push({ start: this.#pos, used: new Set() });
        const top = this.#label();
        const done = this.#label();
        this.#emit(`${top}:`);
        this.#use(count);
        this.#use(cval);
        const ci = this.#read(cval, T);
        const limit =
          count.kind === 'lit' && isArmImm(count.value) ? `#${count.value}` : this.#read(count, A);
        this.#emit(`cmp ${ci}, ${limit}`, `bhs ${done}`);
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
          this.#emit(`cmp ${this.#read(pv, T)}, #0`, `beq ${done}`);
        }
        if (this.#inlinable(callee, env))
          this.#inline(env, callee, args, true, key, t, n.id, 'store');
        else this.#call(name, callee, args, key);
        this.#use(cval);
        const cr = this.#read(cval, T);
        this.#set(counter, (d) => this.#emit(`add ${d}, ${cr}, #1`), true);
        this.#emit(`b ${top}`, `${done}:`);
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

  /** Linear scan over definition order: scalars get callee-saved homes r4-r10. */
  #allocate(): void {
    const keys = [...this.#defs.entries()]
      .filter(([k, d]) => isPrimitive(d.type) && !this.#alias.has(k))
      .sort((x, y) => x[1].pos - y[1].pos);
    const busy = new Map<string, number>();
    for (const [key, d] of keys) {
      const last = this.#last.get(key) ?? d.pos;
      for (const [r, l] of busy) if (l <= d.pos) busy.delete(r);
      const reg = CALLEE_SAVED.find((r) => !busy.has(r));
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
    const sret = !isPrimitive(fn.result);
    const { places } = argLayout(fn.params, sret);
    // Pass 1 (dry): positions, liveness, aliases, aggregate slots, outgoing area.
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
    if (sret) this.#alloc('sret', 4);
    fn.params.forEach((t, i) => {
      if (!isPrimitive(t) && (places[i] as ArgPlace).reg !== undefined) this.#alloc(`ptr${i}`, 4);
    });
    this.#outgoing = align(this.#outgoing, 8);
    const frame = this.#outgoing + align(this.#slotBytes, 8);
    const pushed = [...this.#saved, 'r11', ...(this.#saved.length % 2 === 1 ? ['r12'] : []), 'lr'];
    // Incoming stack parameters, relative to the final sp.
    const incoming = frame + 4 * pushed.length;
    // Pass 2: emission.
    this.#dry = false;
    this.out = [];
    this.#labels = 0;
    this.#pos = 0;
    this.#loops = [];
    const sym = `a0_${fn.name}`;
    this.out.push(`\t.globl ${sym}`, `\t.type ${sym}, %function`, '\t.p2align 2', `${sym}:`);
    this.#emit(`push {${pushed.join(', ')}}`, 'mov r11, sp');
    // r0-r3 still hold arguments here: the prologue uses only r12 and lr.
    if (frame > 4096) {
      const pages = Math.floor(frame / 4096);
      const probe = this.#label();
      this.#emit(...movImm(ADDR, pages), `${probe}:`);
      this.#emit(
        'sub sp, sp, #4096',
        `str ${ADDR}, [sp]`,
        `subs ${ADDR}, ${ADDR}, #1`,
        `bne ${probe}`,
      );
      if (frame % 4096 > 0) {
        const rest = frame % 4096;
        if (isArmImm(rest)) this.#emit(`sub sp, sp, #${rest}`);
        else this.#emit(...movImm(ADDR, rest), `sub sp, sp, ${ADDR}`);
      }
    } else if (frame > 0) {
      if (isArmImm(frame)) this.#emit(`sub sp, sp, #${frame}`);
      else this.#emit(...movImm(ADDR, frame), `sub sp, sp, ${ADDR}`);
    }
    // Register arguments leave r0-r3 before any copy (which uses r0-r3): scalars to their
    // homes, the sret pointer and aggregate pointers to slots.
    if (sret) this.#mem('str', 'r0', 'sp', this.#slot('sret'));
    fn.params.forEach((t, i) => {
      const r = (places[i] as ArgPlace).reg;
      if (r === undefined) return;
      if (!isPrimitive(t)) {
        this.#mem('str', `r${r}`, 'sp', this.#slot(`ptr${i}`));
        return;
      }
      if (t === 'bool') this.#emit(`and r${r}, r${r}, #1`);
      // Straight from the argument register: going through r2 would clobber a later argument.
      const home = this.#home(`p${i}`);
      if ('reg' in home) this.#emit(`mov ${home.reg}, r${r}`);
      else this.#mem('str', `r${r}`, 'sp', home.slot);
    });
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (isPrimitive(t)) {
        if (place.stack === undefined) return;
        const at = incoming + place.stack;
        this.#set(
          `p${i}`,
          (d) => {
            this.#mem(t === 'bool' ? 'ldrb' : 'ldr', d, 'sp', at);
            if (t === 'bool') this.#emit(`and ${d}, ${d}, #1`);
          },
          true,
        );
        return;
      }
      if (place.reg !== undefined) this.#mem('ldr', ADDR, 'sp', this.#slot(`ptr${i}`));
      else this.#mem('ldr', ADDR, 'sp', incoming + (place.stack as number));
      this.#copy('sp', this.#slot(`p${i}`), ADDR, 0, words(t));
    });
    this.#body(env);
    this.#pos += 1;
    if (!sret) this.#into('r0', ret);
    else {
      this.#mem('ldr', ADDR, 'sp', this.#slot('sret'));
      this.#place(ret, ADDR, 0);
    }
    this.#emit('mov sp, r11', `pop {${pushed.slice(0, -1).join(', ')}, pc}`);
    this.out.push(`\t.size ${sym}, .-${sym}`);
    return this.out.join('\n');
  }
}

/** Emit one function as ARMv7-A Linux assembly (a `.globl a0_<name>` block). */
export function emitArm32Function(fn: TypedFunc): string {
  return new FunctionEmitter(fn).emit();
}

/** Assemble function blocks into one .s module for GNU as / clang (arm-linux-gnueabihf). */
export function assembleArm32(bodies: readonly string[], compilerVersion: string): string {
  const routine = bodies.some((b) => b.includes(UDIVMOD)) ? `\n\n${UDIVMOD_ROUTINE}` : '';
  return `@ Generated by A0 ${compilerVersion}. ARMv7-A (ARM mode) Linux assembly, AAPCS hard-float (gnueabihf); exact u32/bool semantics.\n\t.syntax unified\n\t.arch armv7-a\n\t.fpu vfpv3-d16\n\t.eabi_attribute Tag_ABI_VFP_args, 1\n\t.arm\n\t.text\n\n${bodies.join('\n\n')}${routine}\n\n\t.section .note.GNU-stack,"",%progbits\n`;
}
