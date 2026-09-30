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
 * ARMv7VE cores such as Cortex-A7/A15, absent on Cortex-A8/A9), so by default `div`, `rem`,
 * and index reduction modulo a non-power-of-two length call a local shift-subtract routine
 * (`.La0_udivmod`, 32 iterations, emitted once per module when used) that also gives A0's
 * zero-divisor values (quotient all ones, remainder the dividend). The opt-in `udiv` option
 * (`Arm32Options`, module `.arch armv7ve`) emits hardware `udiv` + `mls` instead; ARMv7-A
 * defines a zero divisor to give quotient 0 (no trap on A-profile), so `mls` already yields
 * the dividend as the remainder and the quotient is fixed to all ones by a flag-predicated
 * `mvneq` (the comparison precedes the divide). ARM mode rather than Thumb-2 keeps every
 * instruction unconditional-or-predicated without IT blocks. No VFP or NEON instruction is
 * emitted, so the float ABI never matters for these integer-only signatures; the module is
 * marked hard-float (Tag_ABI_VFP_args) to link with gnueabihf code.
 *
 * Code shape (the AArch64 backend's second version, on a 16-register machine):
 * - Small callees (at most INLINE_MAX_NODES nodes, nested to INLINE_MAX_DEPTH) are inlined
 *   at `call`, `fold`, and `loop` sites; larger callees are called out of line.
 * - Scalars live in registers. A linear scan over definition order gives each u32/bool value
 *   a home; when none is free, the value with the smallest use weight (uses scaled by 8 per
 *   loop level) among the live ones goes to a stack slot. Homes: r4-r11 in every function
 *   (there is no frame pointer: slots are addressed from sp, which is fixed after the
 *   prologue); in a leaf (no out-of-line call, no divide routine) also lr, which is saved
 *   anyway once anything is pushed; in a leaf without aggregates first r0-r3 (parameters
 *   stay where they arrive; the scratch roles are the registers among r12, r3-r0 that no
 *   value uses, and the plan is abandoned if its code needs a role it lacks), then r0 and
 *   r1 with r12, r3, and r2 as scratch. A leaf that needs no callee-saved home and no slot
 *   has no prologue at all and returns with `bx lr`.
 * - Fusions: a compare whose only use is a scalar select's condition sets the flags for that
 *   select's predicated moves (a literal arm is an immediate); `add` of a single-use `mul`
 *   is `mla`; a single-use shift by a literal feeding add/sub/and/orr/eor is that op's
 *   shifter operand (`rsb` when it is the minuend). A counter with a literal trip count
 *   indexes an array at least that long without `ubfx`/division; a literal array of more
 *   than 16 equal words is a loop of post-indexed stores.
 * - Literals that need a register inside a loop (movw/movt constants, operands without an
 *   immediate form, variable trip counts written as literals) are materialized once before
 *   the outermost loop when a register is free over the whole loop.
 * - Scalar fold/loop state stays in its register: the inlined body's result shares the
 *   state's home when the state is not read after that result is defined, so no copy ends
 *   an iteration. Loops are rotated (test at the bottom, entered by a branch to the test
 *   unless the literal trip count is positive).
 * - `or (shl x a) (shr x b)` with complementary distances (literals summing to 0 mod 32, or
 *   one written as `sub 32k other`) is one `ror`; single-use shift nodes are not emitted.
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
 *     incoming stack parameters     sp + F + 4 * P + 4k
 *     pushed registers (P words)    used r4-r11, lr, and r12 as padding to 8 bytes (none in a
 *                                   leaf that uses no callee-saved home)
 *     value slots (S bytes)         sp + O ... sp + O + S - 1
 *       (sret pointer, aggregate pointers, aggregates, spilled scalars)
 *     outgoing stack arguments      sp ... sp + O - 1
 *
 * F = O + S; S and O are rounded to 8, so sp keeps AAPCS's 8-byte alignment at every call.
 * Frames above 4 KiB are probed one page at a time in the prologue. Scratch (default): r0/r1
 * operands and index, r2 results, shift masks and copy counter, r3 data, r12 addresses, lr
 * large offsets (so lr is a home only when every offset fits the 12-bit immediate).
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
const CALLEE_SAVED = ['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11'];
/** Large-offset scratch (only where no home is lr). */
const FAR = 'lr';
const UDIVMOD = '.La0_udivmod';

/**
 * Scratch roles of one function: operands A/B, result/mask D, data T, address ADDR. A plan
 * may leave roles unassigned; emitting code that needs one abandons that plan (MissingRole).
 */
interface Roles {
  readonly A?: string | undefined;
  readonly B?: string | undefined;
  readonly D?: string | undefined;
  readonly T?: string | undefined;
  readonly ADDR?: string | undefined;
}
const DEFAULT_ROLES: Roles = { A: 'r0', B: 'r1', D: 'r2', T: 'r3', ADDR: 'r12' };
/** A leaf without aggregates: r0/r1 become homes, only three scratch registers remain. */
const SCALAR_LEAF_ROLES: Roles = { A: 'r12', B: 'r3', D: 'r2' };

/** Thrown when a register plan lacks a scratch role its code needs; the next plan is tried. */
class MissingRole extends Error {}

const missing = (): never => {
  throw new MissingRole('scratch role');
};

/** Uses of each node id in `fn` (node arguments and the returned operand). */
function useCounts(fn: TypedFunc): Map<string, number> {
  const uses = new Map<string, number>();
  const count = (o: Operand): void => {
    if (o.kind === 'node') uses.set(o.id, (uses.get(o.id) ?? 0) + 1);
  };
  for (const n of fn.nodes) for (const o of n.args) count(o);
  count(fn.ret);
  return uses;
}

const COMPARES = new Set<Op>(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const SHIFTABLE = new Set<Op>(['add', 'sub', 'and', 'or', 'xor']);

/** A shifted second operand: `op d, x, y, <kind> #amount`. */
interface ShiftedOperand {
  /** Index of the argument that is the shift node. */
  readonly arg: number;
  readonly src: Operand;
  readonly kind: 'lsl' | 'lsr';
  readonly amount: number;
}

/** Node fusions of one function (computed once, identical in both emission passes). */
interface Fusion {
  /** Compare nodes whose only use is the condition of a scalar select (its flags). */
  readonly cmp: Set<string>;
  /** `add` nodes with a single-use `mul` operand: `mla`; value = index of the mul argument. */
  readonly mla: Map<string, number>;
  /** ALU nodes with a single-use literal-distance shift operand. */
  readonly shifted: Map<string, ShiftedOperand>;
  /** Nodes emitted by their consumer (the absorbed mul and shift nodes). */
  readonly skip: Set<string>;
}

const FUSIONS = new WeakMap<TypedFunc, Fusion>();

function fusionOf(fn: TypedFunc): Fusion {
  const cached = FUSIONS.get(fn);
  if (cached !== undefined) return cached;
  const rot = rotatesOf(fn);
  const uses = useCounts(fn);
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const single = (o: Operand | undefined): Node | undefined =>
    o?.kind === 'node' && uses.get(o.id) === 1 && !rot.skip.has(o.id) && !rot.fused.has(o.id)
      ? byId.get(o.id)
      : undefined;
  const cmp = new Set<string>();
  const mla = new Map<string, number>();
  const shifted = new Map<string, ShiftedOperand>();
  const skip = new Set<string>();
  for (const n of fn.nodes) {
    if (rot.fused.has(n.id) || rot.skip.has(n.id)) continue;
    const t = fn.types.get(n.id);
    if (n.op === 'select') {
      const d = single(n.args[0]);
      if (d !== undefined && COMPARES.has(d.op) && t !== undefined && isPrimitive(t)) cmp.add(d.id);
      continue;
    }
    if (n.op === 'add') {
      const k = [0, 1].find((j) => single(n.args[j])?.op === 'mul');
      if (k !== undefined) {
        mla.set(n.id, k);
        skip.add((n.args[k] as { id: string }).id);
        continue;
      }
    }
    if (!SHIFTABLE.has(n.op)) continue;
    // The second operand first (no operand swap needed), then the first for commutative ops
    // and for sub (as rsb).
    for (const j of [1, 0]) {
      const s = single(n.args[j]);
      const dist = s?.args[1];
      if (s === undefined || (s.op !== 'shl' && s.op !== 'shr') || dist?.kind !== 'u32') continue;
      if ((dist.value & 31) === 0 || s.args[0]?.kind === 'u32') continue;
      const other = n.args[1 - j];
      if (other === undefined || (other.kind === 'node' && skip.has(other.id))) continue;
      shifted.set(n.id, {
        arg: j,
        src: s.args[0] as Operand,
        kind: s.op === 'shl' ? 'lsl' : 'lsr',
        amount: dist.value & 31,
      });
      skip.add(s.id);
      break;
    }
  }
  const result = { cmp, mla, shifted, skip };
  FUSIONS.set(fn, result);
  return result;
}

/** The condition that holds exactly when `cc` does not. */
const INVERSE: Readonly<Record<string, string>> = {
  eq: 'ne',
  ne: 'eq',
  lo: 'hs',
  hs: 'lo',
  hi: 'ls',
  ls: 'hi',
};

/** Code generation options. */
export interface Arm32Options {
  /** ARMv7VE: hardware `udiv`/`mls` instead of the divide routine (Cortex-A7/A15/A17). */
  readonly udiv?: boolean;
}

/** An `or` node that is a rotate: `ror` of `src` by `amount` (a literal distance or an operand). */
interface Rotate {
  readonly src: Operand;
  readonly amount: Operand | number;
}

const ROTATES = new WeakMap<TypedFunc, { fused: Map<string, Rotate>; skip: Set<string> }>();

/**
 * `or (shl x a) (shr x b)` (either order) is `ror x, b` when a + b = 0 (mod 32): both literal,
 * or one of them the node `sub L other` with L = 0 (mod 32). At a = 0 both shifts give x and
 * so does the rotate. Shift nodes whose only use is the `or` are skipped.
 */
function rotatesOf(fn: TypedFunc): { fused: Map<string, Rotate>; skip: Set<string> } {
  const cached = ROTATES.get(fn);
  if (cached !== undefined) return cached;
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const defOf = (o: Operand): Node | undefined => (o.kind === 'node' ? byId.get(o.id) : undefined);
  const complement = (p: Operand, q: Operand): boolean => {
    const d = defOf(q);
    const l = d?.args[0];
    const r = d?.args[1];
    return (
      d?.op === 'sub' &&
      l?.kind === 'u32' &&
      (l.value & 31) === 0 &&
      r !== undefined &&
      sameOp(r, p)
    );
  };
  const uses = (id: string): number =>
    fn.nodes.reduce(
      (s, n) => s + n.args.filter((a) => a.kind === 'node' && a.id === id).length,
      fn.ret.kind === 'node' && fn.ret.id === id ? 1 : 0,
    );
  const fused = new Map<string, Rotate>();
  const skip = new Set<string>();
  for (const n of fn.nodes) {
    if (n.op !== 'or') continue;
    const [x, y] = n.args as [Operand, Operand];
    const dx = defOf(x);
    const dy = defOf(y);
    if (dx === undefined || dy === undefined) continue;
    const pair =
      dx.op === 'shl' && dy.op === 'shr'
        ? [dx, dy]
        : dx.op === 'shr' && dy.op === 'shl'
          ? [dy, dx]
          : undefined;
    if (pair === undefined) continue;
    const [left, right] = pair as [Node, Node];
    const src = left.args[0] as Operand;
    if (!sameOp(src, right.args[0] as Operand)) continue;
    const a1 = left.args[1] as Operand;
    const a2 = right.args[1] as Operand;
    let amount: Operand | number | undefined;
    if (a1.kind === 'u32' && a2.kind === 'u32') {
      if (((a1.value + a2.value) & 31) === 0) amount = a2.value & 31;
    } else if (complement(a1, a2) || complement(a2, a1)) amount = a2;
    if (amount === undefined) continue;
    fused.set(n.id, { src, amount });
    for (const s of [left, right]) if (uses(s.id) === 1) skip.add(s.id);
  }
  const result = { fused, skip };
  ROTATES.set(fn, result);
  return result;
}

const FRESH_OPS = new Set<Op>(['arr', 'rec', 'set', 'put']);

function sameOp(x: Operand, y: Operand): boolean {
  return (
    (x.kind === 'node' && y.kind === 'node' && x.id === y.id) ||
    (x.kind === 'param' && y.kind === 'param' && x.index === y.index)
  );
}

/** The AArch64 backend's in-place analysis (see src/arm64.ts). */
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

/** A loop being emitted: its liveness region and the literals read inside it. */
interface LoopRegion {
  readonly id: string;
  readonly start: number;
  readonly used: Set<string>;
  readonly lits: Map<number, number>;
}

const SWAPPED: Readonly<Record<string, string>> = {
  eq: 'eq',
  ne: 'ne',
  lo: 'hi',
  ls: 'hs',
  hi: 'lo',
  hs: 'ls',
};

const litKey = (loop: string, value: number): string => `lit:${loop}:${value >>> 0}`;

class FunctionEmitter {
  out: string[] = [];
  #dry = true;
  #pos = 0;
  #labels = 0;
  readonly #defs = new Map<string, { pos: number; type: Type }>();
  readonly #last = new Map<string, number>();
  readonly #weight = new Map<string, number>();
  #loops: LoopRegion[] = [];
  readonly #alias = new Map<string, string>();
  readonly #regs = new Map<string, string>();
  readonly #slots = new Map<string, number>();
  /** Inlined fold/loop results that may share the scalar state's home. */
  readonly #share = new Map<string, string>();
  /** Hoisted literal keys per outermost loop, with their values. */
  readonly #hoisted = new Map<string, { key: string; value: number }[]>();
  #slotBytes = 0;
  #outgoing = 0;
  #saved: string[] = [];
  /** Cleared by any `bl` (an out-of-line call or the divide routine). */
  #leaf = true;
  /** Set by any aggregate value, parameter, or result. */
  #aggregates = false;
  #roles: Roles = DEFAULT_ROLES;
  /** Fold/loop counters with a literal trip count: key -> exclusive upper bound. */
  readonly #bound = new Map<string, number>();
  /** Compares fused into their select: key -> condition code and operands. */
  readonly #fusedCmp = new Map<string, { cond: string; x: Val; y: Val }>();

  constructor(
    readonly fn: TypedFunc,
    readonly options: Arm32Options,
  ) {}

  // In the dry pass the roles are placeholders (no code is kept); in emission a missing role
  // abandons the register plan.
  get #A(): string {
    return this.#roles.A ?? (this.#dry ? 'r0' : missing());
  }
  get #B(): string {
    return this.#roles.B ?? (this.#dry ? 'r1' : missing());
  }
  get #D(): string {
    return this.#roles.D ?? (this.#dry ? 'r2' : missing());
  }
  get #T(): string {
    return this.#roles.T ?? (this.#dry ? 'r3' : missing());
  }
  get #ADDR(): string {
    return this.#roles.ADDR ?? (this.#dry ? 'r12' : missing());
  }

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

  #weigh(key: string): void {
    this.#weight.set(key, (this.#weight.get(key) ?? 0) + 8 ** Math.min(this.#loops.length, 4));
  }

  #def(key: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    this.#weigh(key);
    if (!isPrimitive(type)) {
      this.#aggregates = true;
      this.#alloc(key, 4 * words(type));
    }
  }

  #defAlias(key: string, target: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    this.#alias.set(key, this.#canon(target));
  }

  #use(v: Val): void {
    if (!this.#dry || v.kind !== 'key') return;
    this.#last.set(v.key, this.#pos);
    this.#weigh(v.key);
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

  /** reg = base + off (reg itself holds a non-immediate offset; reg never equals base). */
  #addr(reg: string, base: string, off: number): void {
    if (isArmImm(off)) this.#emit(`add ${reg}, ${base}, #${off}`);
    else this.#emit(...movImm(reg, off), `add ${reg}, ${base}, ${reg}`);
  }

  /** Copy `n` words from [src + so] to [dst + d]. Uses r0-r3 and lr; bases are sp or r12. */
  #copy(dst: string, d: number, src: string, so: number, n: number): void {
    if (dst === src && d === so) return;
    if (n <= 16) {
      for (let k = 0; k < n; k += 1) {
        this.#mem('ldr', this.#T, src, so + 4 * k);
        this.#mem('str', this.#T, dst, d + 4 * k);
      }
      return;
    }
    const top = this.#label();
    this.#addr(this.#A, src, so);
    this.#addr(this.#B, dst, d);
    this.#emit(...movImm(this.#D, n), `${top}:`);
    this.#emit(
      `ldr ${this.#T}, [${this.#A}], #4`,
      `str ${this.#T}, [${this.#B}], #4`,
      `subs ${this.#D}, ${this.#D}, #1`,
      `bne ${top}`,
    );
  }

  /**
   * A register holding scalar `v`: its home register, a literal hoisted out of the enclosing
   * loops, or `scratch` after materializing (a register, or a scratch role resolved only when
   * it is needed, so a plan without that role can still read register operands). Callers
   * never write the returned register.
   */
  #read(v: Val, role: string): string {
    const pick = (): string =>
      role === 'A' ? this.#A : role === 'B' ? this.#B : role === 'D' ? this.#D : role;
    if (v.kind === 'lit') {
      const outer = this.#loops[0];
      if (outer !== undefined) {
        const value = v.value >>> 0;
        if (this.#dry)
          outer.lits.set(value, (outer.lits.get(value) ?? 0) + 8 ** this.#loops.length);
        else {
          const reg = this.#regs.get(litKey(outer.id, value));
          if (reg !== undefined) return reg;
        }
      }
      const scratch = pick();
      this.#emit(...movImm(scratch, v.value));
      return scratch;
    }
    const home = this.#home(v.key);
    if ('reg' in home) return home.reg;
    const scratch = pick();
    this.#mem('ldr', scratch, 'sp', home.slot);
    return scratch;
  }

  #into(dst: string, v: Val): void {
    const r = this.#read(v, dst);
    if (r !== dst) this.#emit(`mov ${dst}, ${r}`);
  }

  /**
   * Write scalar `key` with `produce(d)`: d is the home register (which may also be a source
   * register: every producer reads its sources before it writes d, or writes d only on
   * mutually exclusive conditions), or D, which is then stored to the slot.
   */
  #set(key: string, produce: (d: string) => void): void {
    const home = this.#home(key);
    if ('reg' in home) {
      produce(home.reg);
      return;
    }
    produce(this.#D);
    this.#mem('str', this.#D, 'sp', home.slot);
  }

  /** Store `v` (any type) at [base + off]. */
  #place(v: Val, base: string, off: number): void {
    if (v.kind === 'lit') {
      this.#emit(...movImm(this.#T, v.value));
      this.#mem('str', this.#T, base, off);
      return;
    }
    if (isPrimitive(v.type)) {
      this.#mem('str', this.#read(v, this.#T), base, off);
      return;
    }
    this.#copy(base, off, 'sp', this.#slot(v.key), words(v.type));
  }

  /**
   * A = index operand mod n; returns the register-offset operand that scales it by
   * elementBytes (`A, lsl #k` for a power of two). Uses r0-r3 (the divide routine) and lr.
   */
  #scaledIndex(idx: Val, n: number, elemBytes: number): string {
    const bound = idx.kind === 'key' ? this.#bound.get(idx.key) : undefined;
    if (bound !== undefined && bound <= n && (elemBytes & (elemBytes - 1)) === 0) {
      // A counter already below the length: scale its home register directly.
      const r = this.#read(idx, this.#A);
      return elemBytes > 1 ? `${r}, lsl #${Math.log2(elemBytes)}` : r;
    }
    const [A, B] = [this.#A, this.#B];
    if (n === 1) this.#emit(`mov ${A}, #0`);
    else if ((n & (n - 1)) === 0)
      this.#emit(`ubfx ${A}, ${this.#read(idx, A)}, #0, #${Math.log2(n)}`);
    else if (this.options.udiv === true) {
      const r = this.#read(idx, A);
      const q = this.#T;
      this.#emit(...movImm(B, n), `udiv ${q}, ${r}, ${B}`, `mls ${A}, ${q}, ${B}, ${r}`);
    } else {
      this.#leaf = false;
      this.#into(A, idx);
      this.#emit(...movImm(B, n), `bl ${UDIVMOD}`, `mov ${A}, ${B}`);
    }
    if ((elemBytes & (elemBytes - 1)) !== 0) {
      this.#emit(...movImm(B, elemBytes), `mul ${A}, ${A}, ${B}`);
      return A;
    }
    return elemBytes > 1 ? `${A}, lsl #${Math.log2(elemBytes)}` : A;
  }

  /** The base register of slot offset `off`: sp itself at 0, else ADDR = sp + off. */
  #slotBase(off: number): string {
    if (off === 0) return 'sp';
    this.#addr(this.#ADDR, 'sp', off);
    return this.#ADDR;
  }

  // --- calls and inlining ------------------------------------------------------------------

  #inlinable(callee: TypedFunc, env: Env): boolean {
    return callee.nodes.length <= INLINE_MAX_NODES && env.depth < INLINE_MAX_DEPTH;
  }

  /** Residual out-of-line call: arguments per the convention, result into `dst`. */
  #call(name: string, callee: TypedFunc, args: readonly Val[], dst: string): void {
    this.#leaf = false;
    const sret = !isPrimitive(callee.result);
    const { places, bytes } = argLayout(callee.params, sret);
    this.#outgoing = Math.max(this.#outgoing, bytes);
    for (const a of args) this.#use(a);
    // Stack arguments first: they go through r3, which may also carry a register argument.
    args.forEach((a, k) => {
      const at = (places[k] as ArgPlace).stack;
      if (at === undefined) return;
      if (a.kind === 'lit' || isPrimitive(a.type))
        this.#mem('str', this.#read(a, this.#T), 'sp', at);
      else {
        this.#addr(this.#T, 'sp', this.#slot(a.key));
        this.#mem('str', this.#T, 'sp', at);
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
    if (!sret) this.#set(dst, (d) => this.#emit(`mov ${d}, r0`));
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
      else if (this.#dry && ret.kind === 'key') {
        // The loop state may give its register to the body's result when the state is not
        // read after that result is defined (the last iteration step is then no copy).
        const def = this.#defs.get(ret.key);
        const loop = this.#loops.at(-1);
        if (
          def !== undefined &&
          loop !== undefined &&
          def.pos > loop.start &&
          (this.#last.get(result) ?? 0) <= def.pos
        )
          this.#share.set(ret.key, result);
      }
      this.#set(result, (d) => this.#into(d, ret));
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
    const rot = rotatesOf(env.fn);
    if (rot.skip.has(n.id)) return;
    const fusion = fusionOf(env.fn);
    if (fusion.skip.has(n.id)) return;
    const t = env.fn.types.get(n.id) ?? refuse(`untyped node ${n.id}`);
    const key = `${env.prefix}n_${n.id}`;
    const [A, B] = ['A', 'B'];
    this.#pos += 1;
    const scalar = (produce: (d: string) => void): void => {
      this.#def(key, t);
      this.#set(key, produce);
    };
    const rotate = rot.fused.get(n.id);
    if (rotate !== undefined) {
      const src = this.#resolve(env, rotate.src);
      this.#use(src);
      const amount = rotate.amount;
      if (typeof amount === 'number') {
        const ra = this.#read(src, A);
        scalar((d) => this.#emit(amount === 0 ? `mov ${d}, ${ra}` : `ror ${d}, ${ra}, #${amount}`));
        return;
      }
      const by = this.#resolve(env, amount);
      this.#use(by);
      const ra = this.#read(src, A);
      const rb = this.#read(by, B);
      scalar((d) => this.#emit(`ror ${d}, ${ra}, ${rb}`));
      return;
    }
    const vals = n.args.map((o) => this.#resolve(env, o));
    const [a, b, c] = vals;
    if (n.op !== 'fold' && n.op !== 'loop') for (const v of vals) this.#use(v);
    const bin = (insn: string, commutes: boolean, imm: boolean): void => {
      const sh = fusion.shifted.get(n.id);
      if (sh !== undefined) {
        // `op d, x, y, <shift>`; a shifted first operand of sub is `rsb`.
        const src = this.#resolve(env, sh.src);
        this.#use(src);
        const other = (sh.arg === 1 ? a : b) as Val;
        const op = sh.arg === 0 && insn === 'sub' ? 'rsb' : insn;
        const rx = this.#read(other, A);
        const ry = this.#read(src, B);
        scalar((d) => this.#emit(`${op} ${d}, ${rx}, ${ry}, ${sh.kind} #${sh.amount}`));
        return;
      }
      let [x, y] = [a as Val, b as Val];
      if (commutes && x.kind === 'lit' && y.kind !== 'lit') [x, y] = [y, x];
      if (imm && insn === 'sub' && x.kind === 'lit' && y.kind !== 'lit' && isArmImm(x.value)) {
        const v = x.value;
        const ry = this.#read(y, B);
        scalar((d) => this.#emit(`rsb ${d}, ${ry}, #${v}`));
        return;
      }
      const rx = this.#read(x, A);
      if (imm && y.kind === 'lit' && isArmImm(y.value)) {
        const v = y.value;
        scalar((d) => this.#emit(`${insn} ${d}, ${rx}, #${v}`));
        return;
      }
      const ry = this.#read(y, B);
      scalar((d) => this.#emit(`${insn} ${d}, ${rx}, ${ry}`));
    };
    // A register-specified shift uses the low byte of the distance; A0 masks it to five bits
    // (into D, which is never a source register and is the result register only for a slot).
    const shift = (insn: string): void => {
      const ra = this.#read(a as Val, A);
      if (b?.kind === 'lit') {
        const s = b.value & 31;
        scalar((d) => this.#emit(s === 0 ? `mov ${d}, ${ra}` : `${insn} ${d}, ${ra}, #${s}`));
        return;
      }
      const rb = this.#read(b as Val, B);
      const m = this.#D;
      scalar((d) => this.#emit(`and ${m}, ${rb}, #31`, `${insn} ${d}, ${ra}, ${m}`));
    };
    const cmp = (cond: string): void => {
      let [x, y, cc] = [a as Val, b as Val, cond];
      if (x.kind === 'lit' && y.kind !== 'lit') [x, y, cc] = [y, x, SWAPPED[cond] as string];
      if (fusion.cmp.has(n.id)) {
        // The select that consumes it compares and moves under the condition.
        this.#fusedCmp.set(key, { cond: cc, x, y });
        return;
      }
      const rx = this.#read(x, A);
      const ry = y.kind === 'lit' && isArmImm(y.value) ? `#${y.value}` : this.#read(y, B);
      scalar((d) => this.#emit(`cmp ${rx}, ${ry}`, `mov ${d}, #0`, `mov${cc} ${d}, #1`));
    };
    const divide = (quotient: boolean): void => {
      if (this.options.udiv === true) {
        const ra = this.#read(a as Val, A);
        const rb = this.#read(b as Val, B);
        scalar((d) => {
          // A zero divisor: udiv gives 0 (ARMv7-A), so mls leaves the dividend; the quotient
          // becomes all ones under the flags of a comparison made before the divide.
          if (quotient) this.#emit(`cmp ${rb}, #0`, `udiv ${d}, ${ra}, ${rb}`, `mvneq ${d}, #0`);
          else {
            const q = d !== ra && d !== rb ? d : this.#D;
            this.#emit(`udiv ${q}, ${ra}, ${rb}`, `mls ${d}, ${q}, ${rb}, ${ra}`);
          }
        });
        return;
      }
      this.#leaf = false;
      this.#into('r0', a as Val);
      this.#into('r1', b as Val);
      this.#emit(`bl ${UDIVMOD}`);
      const r = quotient ? 'r0' : 'r1';
      scalar((d) => this.#emit(`mov ${d}, ${r}`));
    };
    const aggregateOf = (v: Val, what: string): { key: string; type: Type } => {
      if (v.kind !== 'key' || isPrimitive(v.type)) refuse(`${n.op} needs ${what}`);
      return { key: v.key, type: v.type };
    };
    switch (n.op) {
      case 'mov': {
        const v = a as Val;
        if (v.kind === 'key' && !isPrimitive(v.type)) this.#defAlias(key, v.key, t);
        else scalar((d) => this.#into(d, v));
        return;
      }
      case 'add': {
        const k = fusion.mla.get(n.id);
        if (k === undefined) {
          bin('add', true, true);
          return;
        }
        // add (mul x y) z = mla d, x, y, z (the mul node is not emitted on its own).
        const mulId = (n.args[k] as { id: string }).id;
        const mul = env.fn.nodes.find((m) => m.id === mulId) as Node;
        const [x, y] = mul.args.map((o) => this.#resolve(env, o)) as [Val, Val];
        this.#use(x);
        this.#use(y);
        const z = vals[1 - k] as Val;
        const rx = this.#read(x, A);
        const ry = this.#read(y, B);
        const rz = this.#read(z, 'D');
        scalar((d) => this.#emit(`mla ${d}, ${rx}, ${ry}, ${rz}`));
        return;
      }
      case 'sub':
        bin('sub', false, true);
        return;
      case 'mul':
        bin('mul', true, false);
        return;
      case 'and':
        bin('and', true, true);
        return;
      case 'or':
        bin('orr', true, true);
        return;
      case 'xor':
        bin('eor', true, true);
        return;
      case 'shl':
        shift('lsl');
        return;
      case 'shr':
        shift('lsr');
        return;
      case 'div':
        divide(true);
        return;
      case 'rem':
        divide(false);
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
        if (isPrimitive(t)) {
          // The condition sets the flags first; loading the arms (mov/movw/ldr) keeps them.
          const fused = a?.kind === 'key' ? this.#fusedCmp.get(a.key) : undefined;
          let cc = 'ne';
          if (fused === undefined) this.#emit(`cmp ${this.#read(a as Val, A)}, #0`);
          else {
            this.#use(fused.x);
            this.#use(fused.y);
            const rx = this.#read(fused.x, A);
            const y = fused.y;
            const ry =
              y.kind === 'lit' && isArmImm(y.value) ? `#${y.value >>> 0}` : this.#read(y, B);
            this.#emit(`cmp ${rx}, ${ry}`);
            cc = fused.cond;
          }
          // An arm that is an encodable literal is moved as an immediate.
          const arm = (v: Val, role: string): string =>
            v.kind === 'lit' && isArmImm(v.value) ? `#${v.value >>> 0}` : this.#read(v, role);
          const rb = arm(b as Val, A);
          const rc = arm(c as Val, B);
          const inv = INVERSE[cc] as string;
          scalar((d) => {
            if (d !== rb) this.#emit(`mov${cc} ${d}, ${rb}`);
            if (d !== rc) this.#emit(`mov${inv} ${d}, ${rc}`);
          });
          return;
        }
        const rc = this.#read(a as Val, this.#T);
        this.#def(key, t);
        this.#addr(this.#A, 'sp', this.#slot(aggregateOf(b as Val, 'a value').key));
        this.#addr(this.#B, 'sp', this.#slot(aggregateOf(c as Val, 'a value').key));
        this.#emit(
          `cmp ${rc}, #0`,
          `movne ${this.#ADDR}, ${this.#A}`,
          `moveq ${this.#ADDR}, ${this.#B}`,
        );
        this.#copy('sp', this.#slot(key), this.#ADDR, 0, words(t));
        return;
      }
      case 'arr':
      case 'rec': {
        // Elements past the 12-bit offset range are stored through ADDR, advanced 4 KiB at a
        // time; a literal already in T (runs of equal constants) is not materialized again.
        this.#def(key, t);
        let base = 'sp';
        let bias = 0;
        let held: number | undefined;
        let off = this.#slot(key);
        const first = vals[0];
        if (
          vals.length > 16 &&
          first?.kind === 'lit' &&
          vals.every((v) => v.kind === 'lit' && v.value === first.value)
        ) {
          // A long run of one constant: a loop of four post-indexed stores per trip.
          const T = this.#T;
          const trips = Math.floor(vals.length / 4);
          const top = this.#label();
          this.#addr(this.#ADDR, 'sp', off);
          this.#emit(...movImm(T, first.value), ...movImm(this.#D, trips), `${top}:`);
          for (let k = 0; k < 4; k += 1) this.#emit(`str ${T}, [${this.#ADDR}], #4`);
          this.#emit(`subs ${this.#D}, ${this.#D}, #1`, `bne ${top}`);
          for (let k = trips * 4; k < vals.length; k += 1)
            this.#emit(`str ${T}, [${this.#ADDR}], #4`);
          return;
        }
        for (const v of vals) {
          const size = 4 * words(v.type);
          if (off - bias + size > 4096) {
            const delta = off - bias;
            if (base === 'sp') this.#addr(this.#ADDR, 'sp', off);
            else if (isArmImm(delta)) this.#emit(`add ${this.#ADDR}, ${this.#ADDR}, #${delta}`);
            else {
              this.#emit(...movImm(this.#T, delta), `add ${this.#ADDR}, ${this.#ADDR}, ${this.#T}`);
              held = undefined;
            }
            base = this.#ADDR;
            bias = off;
          }
          if (v.kind === 'lit') {
            if (held !== v.value >>> 0) this.#emit(...movImm(this.#T, v.value));
            held = v.value >>> 0;
            this.#mem('str', this.#T, base, off - bias);
          } else {
            this.#place(v, base, off - bias);
            held = undefined;
          }
          off += size;
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
          if (isPrimitive(t)) scalar((d) => this.#mem('ldr', d, 'sp', off));
          else {
            this.#def(key, t);
            this.#copy('sp', this.#slot(key), 'sp', off, ew);
          }
          return;
        }
        const idxOp = this.#scaledIndex(b as Val, at.length, ew * 4);
        const from = this.#slotBase(base);
        if (isPrimitive(t)) scalar((d) => this.#emit(`ldr ${d}, [${from}, ${idxOp}]`));
        else {
          this.#def(key, t);
          this.#emit(`add ${this.#ADDR}, ${from}, ${idxOp}`);
          this.#copy('sp', this.#slot(key), this.#ADDR, 0, ew);
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
        const idxOp = this.#scaledIndex(b as Val, at.length, ew * 4);
        const into = this.#slotBase(dst);
        const cv = c as Val;
        if (cv.kind === 'lit' || isPrimitive(cv.type)) {
          this.#emit(`str ${this.#read(cv, this.#T)}, [${into}, ${idxOp}]`);
          return;
        }
        this.#emit(`add ${this.#ADDR}, ${into}, ${idxOp}`);
        this.#place(cv, this.#ADDR, 0);
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
          if (isPrimitive(t)) scalar((d) => this.#mem('ldr', d, 'sp', from));
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
      case 'loop':
        this.#loop(env, n, index, key, t, vals);
        return;
      case 'read':
      case 'write':
      case 'puts':
        refuse(`${n.op} is an io operation`);
        return;
    }
  }

  /**
   * fold/loop as a rotated loop: [b test] top: [pred; beq done] body; i += 1; test: cmp i, n;
   * blo top; done:. The entry branch is omitted for a positive literal trip count.
   */
  #loop(env: Env, n: Node, index: number, key: string, t: Type, vals: readonly Val[]): void {
    const [count, init, ...extras] = vals as [Val, Val, ...Val[]];
    const [A, B] = ['A', 'B'];
    const name = n.callee as string;
    const callee = env.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
    const pred = n.pred === undefined ? undefined : env.fn.calls.get(n.pred);
    const counter = `${env.prefix}i_${n.id}`;
    const state: Val = { kind: 'key', key, type: t };
    const cval: Val = { kind: 'key', key: counter, type: 'u32' };
    this.#use(init);
    for (const e of extras) this.#use(e);
    if (isPrimitive(t)) {
      this.#def(key, t);
      this.#set(key, (d) => this.#into(d, init));
    } else if (
      init.kind === 'key' &&
      mutableHere(env.fn, n.args[1] as Operand, index, 1, env.ownedP0)
    )
      this.#defAlias(key, init.key, t);
    else {
      this.#def(key, t);
      this.#place(init, 'sp', this.#slot(key));
    }
    this.#def(counter, 'u32');
    this.#set(counter, (d) => this.#emit(`mov ${d}, #0`));
    if (count.kind === 'lit' && count.value > 0) this.#bound.set(counter, count.value);
    if (!this.#dry && this.#loops.length === 0)
      for (const h of this.#hoisted.get(key) ?? []) {
        const reg = this.#regs.get(h.key);
        if (reg !== undefined) this.#emit(...movImm(reg, h.value));
      }
    this.#loops.push({ id: key, start: this.#pos, used: new Set(), lits: new Map() });
    const top = this.#label();
    const test = this.#label();
    const done = this.#label();
    if (!(count.kind === 'lit' && count.value > 0)) this.#emit(`b ${test}`);
    this.#emit(`${top}:`);
    this.#use(count);
    this.#use(cval);
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
      this.#emit(`cmp ${this.#read(pv, A)}, #0`, `beq ${done}`);
    }
    if (this.#inlinable(callee, env)) this.#inline(env, callee, args, true, key, t, n.id, 'store');
    else this.#call(name, callee, args, key);
    this.#use(cval);
    this.#use(count);
    const cr = this.#read(cval, A);
    this.#set(counter, (d) => this.#emit(`add ${d}, ${cr}, #1`));
    this.#emit(`${test}:`);
    const ci = this.#read(cval, A);
    const limit =
      count.kind === 'lit' && isArmImm(count.value) ? `#${count.value}` : this.#read(count, B);
    this.#emit(`cmp ${ci}, ${limit}`, `blo ${top}`, `${done}:`);
    this.#pos += 1;
    this.#use(state);
    this.#use(cval);
    const region = this.#loops.pop();
    if (region === undefined || !this.#dry) return;
    for (const k of region.used) {
      const def = this.#defs.get(k);
      if (def !== undefined && def.pos < region.start)
        this.#last.set(k, Math.max(this.#last.get(k) ?? 0, this.#pos));
    }
    if (this.#loops.length > 0) return;
    const hoisted: { key: string; value: number }[] = [];
    for (const [value, w] of region.lits) {
      const k = litKey(region.id, value);
      this.#defs.set(k, { pos: region.start, type: 'u32' });
      this.#last.set(k, this.#pos);
      this.#weight.set(k, w);
      hoisted.push({ key: k, value });
    }
    this.#hoisted.set(region.id, hoisted);
  }

  // --- register allocation ---------------------------------------------------------------

  /**
   * Linear scan over definition order into `pool`; when every register is taken, the live
   * value (or the new one) with the smallest use weight is spilled for its whole life. A
   * body result marked in #share takes its loop state's register. Hoisted literals then take
   * a register that is free over their whole loop, if there is one (no new push in a leaf).
   */
  #allocate(pool: readonly string[]): void {
    this.#regs.clear();
    const lastOf = (k: string): number => this.#last.get(k) ?? this.#defs.get(k)?.pos ?? 0;
    const weight = (k: string): number => this.#weight.get(k) ?? 0;
    const lits = new Set([...this.#hoisted.values()].flat().map((h) => h.key));
    const keys = [...this.#defs.entries()]
      .filter(([k, d]) => isPrimitive(d.type) && !this.#alias.has(k) && !lits.has(k))
      .sort((x, y) => x[1].pos - y[1].pos);
    const active = new Map<string, string>();
    const pinned = new Set<string>();
    for (const [key, d] of keys) {
      for (const [r, k] of active) if (lastOf(k) <= d.pos) active.delete(r);
      const target = this.#share.get(key);
      const tr = target === undefined ? undefined : this.#regs.get(target);
      if (target !== undefined && tr !== undefined && active.get(tr) === target) {
        this.#regs.set(key, tr);
        pinned.add(target);
        continue;
      }
      const free = pool.find((r) => !active.has(r));
      if (free !== undefined) {
        active.set(free, key);
        this.#regs.set(key, free);
        continue;
      }
      let victim: [string, string] | undefined;
      for (const [r, k] of active)
        if (!pinned.has(k) && (victim === undefined || weight(k) < weight(victim[1])))
          victim = [r, k];
      if (victim !== undefined && weight(victim[1]) < weight(key)) {
        this.#regs.delete(victim[1]);
        active.set(victim[0], key);
        this.#regs.set(key, victim[0]);
      }
    }
    const spans = new Map<string, [number, number][]>();
    for (const [k, r] of this.#regs) {
      const d = this.#defs.get(k)?.pos ?? 0;
      spans.set(r, [...(spans.get(r) ?? []), [d, lastOf(k)]]);
    }
    const pushes = !this.#leaf || [...this.#regs.values()].some((r) => !r.match(/^r[0-3]$/));
    const order = [...lits].sort((x, y) => weight(y) - weight(x));
    for (const k of order) {
      const s = this.#defs.get(k)?.pos ?? 0;
      const e = lastOf(k);
      const reg = pool.find(
        (r) =>
          (pushes || /^r[0-3]$/.test(r)) &&
          (spans.get(r) ?? []).every(([a, b]) => !(a < e && s < b)),
      );
      if (reg === undefined) continue;
      this.#regs.set(k, reg);
      spans.set(reg, [...(spans.get(reg) ?? []), [s, e]]);
    }
    const used = new Set(this.#regs.values());
    this.#saved = [...CALLEE_SAVED, 'lr'].filter((r) => used.has(r));
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
    const { places, bytes: incomingBytes } = argLayout(fn.params, sret);
    // Pass 1 (dry): positions, liveness, weights, aliases, aggregate slots, outgoing area,
    // leaf-ness, hoistable literals.
    this.#dry = true;
    this.#pos = 0;
    if (sret) this.#aggregates = true;
    for (const [i, t] of fn.params.entries()) this.#def(`p${i}`, t);
    this.#body(env);
    this.#pos += 1;
    const ret = this.#resolve(env, fn.ret);
    this.#use(ret);
    if (sret) this.#alloc('sret', 4);
    fn.params.forEach((t, i) => {
      if (!isPrimitive(t) && (places[i] as ArgPlace).reg !== undefined) this.#alloc(`ptr${i}`, 4);
    });
    this.#outgoing = align(this.#outgoing, 8);
    // Register pools, most registers first; lr (and r0/r1) only while every sp offset fits
    // the 12-bit immediate, since lr is the large-offset scratch.
    const plans: { pool: string[]; roles: Roles | 'free'; near: boolean }[] = [];
    // A scalar leaf with every argument register a home: parameters stay where they arrive;
    // the scratch roles are whichever of r12, r3-r0 no value uses (a plan whose code needs a
    // role it lacks is abandoned for the next).
    if (this.#leaf && !this.#aggregates)
      plans.push({
        pool: ['r0', 'r1', 'r2', 'r3', ...CALLEE_SAVED, 'lr'],
        roles: 'free',
        near: true,
      });
    if (this.#leaf && !this.#aggregates)
      plans.push({
        pool: ['r0', 'r1', ...CALLEE_SAVED, 'lr'],
        roles: SCALAR_LEAF_ROLES,
        near: true,
      });
    if (this.#leaf) plans.push({ pool: [...CALLEE_SAVED, 'lr'], roles: DEFAULT_ROLES, near: true });
    plans.push({ pool: CALLEE_SAVED, roles: DEFAULT_ROLES, near: false });
    const aggregateBytes = this.#slotBytes;
    const slots = new Map(this.#slots);
    for (const [p, plan] of plans.entries()) {
      const last = p === plans.length - 1;
      this.#slotBytes = aggregateBytes;
      this.#slots.clear();
      for (const [k, v] of slots) this.#slots.set(k, v);
      this.#allocate(plan.pool);
      for (const [k, d] of this.#defs)
        if (
          isPrimitive(d.type) &&
          !this.#regs.has(k) &&
          !this.#alias.has(k) &&
          !k.startsWith('lit:')
        )
          this.#alloc(k, 4);
      const frame = this.#outgoing + align(this.#slotBytes, 8);
      const saved = this.#saved.filter((r) => r !== 'lr');
      const pushed =
        this.#leaf && this.#saved.length === 0
          ? []
          : [...saved, ...(saved.length % 2 === 0 ? ['r12'] : []), 'lr'];
      if (plan.roles === 'free') {
        const homes = new Set(this.#regs.values());
        const [A, B, D] = ['r12', 'r3', 'r2', 'r1', 'r0'].filter((r) => !homes.has(r));
        this.#roles = { A, B, D };
      } else this.#roles = plan.roles;
      if (!last && plan.near && frame + 4 * pushed.length + incomingBytes > 4095) continue;
      try {
        return this.#finish(env, ret, frame, pushed);
      } catch (e) {
        if (last || !(e instanceof MissingRole)) throw e;
      }
    }
    return refuse('internal: no register plan');
  }

  /** Pass 2: emission under the chosen register plan. */
  #finish(env: Env, ret: Val, frame: number, pushed: readonly string[]): string {
    const fn = this.fn;
    const sret = !isPrimitive(fn.result);
    const { places } = argLayout(fn.params, sret);
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
    if (pushed.length > 0) this.#emit(`push {${pushed.join(', ')}}`);
    // r0-r3 still hold arguments here: the prologue uses only r12 and lr.
    if (frame > 4096) {
      const pages = Math.floor(frame / 4096);
      const probe = this.#label();
      this.#emit(...movImm('r12', pages), `${probe}:`);
      this.#emit('sub sp, sp, #4096', 'str r12, [sp]', 'subs r12, r12, #1', `bne ${probe}`);
      if (frame % 4096 > 0) {
        const rest = frame % 4096;
        if (isArmImm(rest)) this.#emit(`sub sp, sp, #${rest}`);
        else this.#emit(...movImm('r12', rest), 'sub sp, sp, r12');
      }
    } else if (frame > 0) {
      if (isArmImm(frame)) this.#emit(`sub sp, sp, #${frame}`);
      else this.#emit(...movImm('r12', frame), 'sub sp, sp, r12');
    }
    // Register arguments leave r0-r3 before any copy (which uses r0-r3): the sret pointer and
    // aggregate pointers to slots, scalars to slots, then one parallel move to their homes.
    if (sret) this.#mem('str', 'r0', 'sp', this.#slot('sret'));
    const moves: { dst: string; src: string }[] = [];
    fn.params.forEach((t, i) => {
      const r = (places[i] as ArgPlace).reg;
      if (r === undefined) return;
      if (!isPrimitive(t)) {
        this.#mem('str', `r${r}`, 'sp', this.#slot(`ptr${i}`));
        return;
      }
      if (!this.#last.has(`p${i}`)) return;
      if (t === 'bool') this.#emit(`and r${r}, r${r}, #1`);
      const home = this.#home(`p${i}`);
      if ('reg' in home) moves.push({ dst: home.reg, src: `r${r}` });
      else this.#mem('str', `r${r}`, 'sp', home.slot);
    });
    this.#parallelMove(moves.filter((m) => m.dst !== m.src));
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (isPrimitive(t)) {
        if (place.stack === undefined || !this.#last.has(`p${i}`)) return;
        const at = incoming + place.stack;
        this.#set(`p${i}`, (d) => {
          this.#mem(t === 'bool' ? 'ldrb' : 'ldr', d, 'sp', at);
          if (t === 'bool') this.#emit(`and ${d}, ${d}, #1`);
        });
        return;
      }
      const addr = this.#ADDR;
      if (place.reg !== undefined) this.#mem('ldr', addr, 'sp', this.#slot(`ptr${i}`));
      else this.#mem('ldr', addr, 'sp', incoming + (place.stack as number));
      this.#copy('sp', this.#slot(`p${i}`), addr, 0, words(t));
    });
    this.#body(env);
    this.#pos += 1;
    if (!sret) this.#into('r0', ret);
    else {
      this.#mem('ldr', this.#ADDR, 'sp', this.#slot('sret'));
      this.#place(ret, this.#ADDR, 0);
    }
    if (frame > 0) {
      if (isArmImm(frame)) this.#emit(`add sp, sp, #${frame}`);
      else this.#emit(...movImm('r12', frame), 'add sp, sp, r12');
    }
    if (pushed.length === 0) this.#emit('bx lr');
    else this.#emit(`pop {${pushed.slice(0, -1).join(', ')}, pc}`);
    this.out.push(`\t.size ${sym}, .-${sym}`);
    return this.out.join('\n');
  }

  /** Sequentialize simultaneous register moves; r12 (free in the prologue) breaks cycles. */
  #parallelMove(moves: { dst: string; src: string }[]): void {
    const pending = [...moves];
    while (pending.length > 0) {
      const k = pending.findIndex((m) => !pending.some((o) => o.src === m.dst));
      if (k >= 0) {
        const [m] = pending.splice(k, 1) as [{ dst: string; src: string }];
        this.#emit(`mov ${m.dst}, ${m.src}`);
        continue;
      }
      const blocked = (pending[0] as { dst: string }).dst;
      this.#emit(`mov r12, ${blocked}`);
      for (const o of pending) if (o.src === blocked) o.src = 'r12';
    }
  }
}

/** Emit one function as ARMv7-A Linux assembly (a `.globl a0_<name>` block). */
export function emitArm32Function(fn: TypedFunc, options: Arm32Options = {}): string {
  return new FunctionEmitter(fn, options).emit();
}

/** Assemble function blocks into one .s module for GNU as / clang (arm-linux-gnueabihf). */
export function assembleArm32(
  bodies: readonly string[],
  compilerVersion: string,
  options: Arm32Options = {},
): string {
  const routine = bodies.some((b) => b.includes(UDIVMOD)) ? `\n\n${UDIVMOD_ROUTINE}` : '';
  const arch = options.udiv === true ? 'armv7ve' : 'armv7-a';
  const isa = options.udiv === true ? 'ARMv7VE' : 'ARMv7-A';
  return `@ Generated by A0 ${compilerVersion}. ${isa} (ARM mode) Linux assembly, AAPCS hard-float (gnueabihf); exact u32/bool semantics.\n\t.syntax unified\n\t.arch ${arch}\n\t.fpu vfpv3-d16\n\t.eabi_attribute Tag_ABI_VFP_args, 1\n\t.arm\n\t.text\n\n${bodies.join('\n\n')}${routine}\n\n\t.section .note.GNU-stack,"",%progbits\n`;
}
