/**
 * Direct native backend: x86-64 assembly (System V AMD64 ABI, AT&T syntax as clang and GNU
 * as accept it) for macOS and Linux. A0 reaches the machine through this code generator plus
 * the system assembler and linker only; no C is generated for the program.
 *
 * Scope: the same as the AArch64 backend (src/arm64.ts). Functions over u32 and bool,
 * fixed-size arrays and records of them (value semantics), every scalar op with A0's exact
 * meaning, `call`, `fold`, and `loop` as real loops with literal or variable trip counts.
 * io functions are refused (the C path covers them).
 *
 * Representation: every value is a sequence of 32-bit words. u32 is one word, bool is one
 * word holding 0 or 1, an array is its elements back to back, a record its fields in order.
 *
 * Code shape (the AArch64 backend's second version, on x86-64):
 * - Small callees (at most INLINE_MAX_NODES nodes, nested to INLINE_MAX_DEPTH) are inlined
 *   at `call`, `fold`, and `loop` sites; larger callees are called out of line.
 * - Scalars live in registers. A linear scan over definition order gives each u32/bool
 *   value a home among the callee-saved ebx, r12d-r15d (spilled to a stack slot when they
 *   run out); a function with no residual call is a leaf and also uses edi, esi, r8d, r9d,
 *   keeping a parameter in its arrival register when it arrives in one of those. edx and ecx
 *   are never homes: `div`/`rem` need eax:edx and a variable shift needs cl.
 * - Aggregates live in stack slots and are updated in place when provably unshared (the
 *   same `mutableHere` analysis as the JavaScript and AArch64 backends).
 *
 * Calling convention (System V AMD64 for scalar signatures, so C can call `a0_<name>`
 * directly; `_a0_<name>` on macOS):
 * - An aggregate result is returned through the hidden sret pointer in rdi (first integer
 *   argument), which the callee also returns in rax; each parameter then takes the next of
 *   rdi, rsi, rdx, rcx, r8, r9: a scalar as its value (bool 0/1 in the low byte, upper bits
 *   ignored), an aggregate as a pointer to a caller-owned slot that the caller never changes.
 *   The callee copies aggregate parameters into its own slots on entry.
 * - After six, parameters go to the stack, one eightbyte each, starting at the caller's rsp.
 * - A scalar result returns in eax. The sret result is written after all parameters were
 *   copied, so it may alias an argument slot (fold state updates rely on this).
 *
 * Frame layout (rsp is fixed after the prologue; all slots are addressed from rsp):
 *
 *     incoming stack parameters     rbp + 16 + 8k
 *     return address                rbp + 8
 *     saved rbp                     <- rbp
 *     value slots (S bytes)         rsp + O ... rsp + O + S - 1
 *       (callee-saved register save area, sret pointer, aggregates, spilled scalars)
 *     outgoing stack arguments      rsp ... rsp + O - 1
 *
 * S and O are rounded to 16, so rsp is 16-byte aligned at every call. Frames above 4 KiB
 * are probed one page at a time in the prologue. Scratch: eax (data), r10/r11 (addresses
 * and operands), ecx and edx (shift count, division, copy counter).
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

export type X86Platform = 'darwin' | 'linux';

/** The platform whose symbol and section conventions the emitted assembly follows. */
export const HOST_X86_PLATFORM: X86Platform = process.platform === 'linux' ? 'linux' : 'darwin';

function refuse(message: string): never {
  throw new A0Error(`x86_64: ${message}`, undefined, {
    code: 'structure',
    fix: 'compile io functions with the c target; the x86_64 backend covers io-free functions',
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
const CALLEE_SAVED = ['%ebx', '%r12d', '%r13d', '%r14d', '%r15d'];
/** Integer argument registers in order; a home only in a leaf, and never edx/ecx. */
const ARG_REGS = ['%edi', '%esi', '%edx', '%ecx', '%r8d', '%r9d'];
const LEAF_ARG_HOMES = ['%edi', '%esi', '%r8d', '%r9d'];

const FRESH_OPS = new Set<Op>(['arr', 'rec', 'set', 'put']);

/** The 64-bit name of a 32-bit register. */
function q(reg: string): string {
  if (/^%r\d+d$/.test(reg)) return reg.slice(0, -1);
  return `%r${reg.slice(2)}`;
}

/** A 32-bit immediate as the assembler wants it (signed). */
const imm = (v: number): string => `$${v | 0}`;

function sameOp(x: Operand, y: Operand): boolean {
  return (
    (x.kind === 'node' && y.kind === 'node' && x.id === y.id) ||
    (x.kind === 'param' && y.kind === 'param' && x.index === y.index)
  );
}

/**
 * May the aggregate operand `o` be updated in place by the node at `index`? Sound when the
 * value is provably unshared (a fresh allocation or the owned state parameter p0), every
 * other use is a `get`/`at` read before `index`, and it is not returned.
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

/** Where each parameter travels: an integer register index, or a byte offset in the stack area. */
interface ArgPlace {
  readonly reg?: number;
  readonly stack?: number;
}

/** System V placement for a parameter list (`sret` takes rdi); `bytes` is the stack area used. */
function argLayout(params: readonly Type[], sret: boolean): { places: ArgPlace[]; bytes: number } {
  let next = sret ? 1 : 0;
  let offset = 0;
  const places = params.map((): ArgPlace => {
    if (next < 6) return { reg: next++ };
    const place: ArgPlace = { stack: offset };
    offset += 8;
    return place;
  });
  return { places, bytes: offset };
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

  constructor(
    readonly fn: TypedFunc,
    readonly platform: X86Platform,
  ) {}

  #emit(...lines: string[]): void {
    if (this.#dry) return;
    for (const l of lines) this.out.push(l.endsWith(':') ? l : `\t${l}`);
  }

  #sym(name: string): string {
    return this.platform === 'darwin' ? `_a0_${name}` : `a0_${name}`;
  }

  #label(): string {
    this.#labels += 1;
    return `${this.platform === 'darwin' ? 'L' : '.L'}a0_${this.fn.name}_${this.#labels}`;
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

  /** Byte offset from rsp of a key's slot (aliases resolved). */
  #slot(key: string): number {
    const off = this.#slots.get(this.#canon(key));
    if (off === undefined) {
      if (this.#dry) return 0;
      throw new A0Error(`x86_64: no slot for ${key}`);
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

  /** `off(base)` as an AT&T memory operand; `base` is a 64-bit register name. */
  #m(base: string, off: number): string {
    return off === 0 ? `(${base})` : `${off}(${base})`;
  }

  /** dst = src (registers or memory operands), skipped when identical. */
  #mov(src: string, dst: string): void {
    if (src !== dst) this.#emit(`movl ${src}, ${dst}`);
  }

  /** Copy `n` words from [src + so] to [dst + d]. Uses eax, r10, r11, ecx. */
  #copy(dst: string, d: number, src: string, so: number, n: number): void {
    if (dst === src && d === so) return;
    if (n <= 16) {
      for (let k = 0; k < n; k += 1)
        this.#emit(
          `movl ${this.#m(src, so + 4 * k)}, %eax`,
          `movl %eax, ${this.#m(dst, d + 4 * k)}`,
        );
      return;
    }
    const top = this.#label();
    this.#emit(`leaq ${this.#m(src, so)}, %r10`, `leaq ${this.#m(dst, d)}, %r11`);
    this.#emit(`movl ${imm(n)}, %ecx`, `${top}:`);
    this.#emit('movl (%r10), %eax', 'movl %eax, (%r11)', 'addq $4, %r10', 'addq $4, %r11');
    this.#emit('decl %ecx', `jne ${top}`);
  }

  /** A 32-bit register holding scalar `v`: its home register, or `scratch` after materializing. */
  #read(v: Val, scratch: string): string {
    if (v.kind === 'lit') {
      this.#emit(`movl ${imm(v.value)}, ${scratch}`);
      return scratch;
    }
    const home = this.#home(v.key);
    if ('reg' in home) return home.reg;
    this.#emit(`movl ${this.#m('%rsp', home.slot)}, ${scratch}`);
    return scratch;
  }

  /** dst = scalar `v`. */
  #into(dst: string, v: Val): void {
    this.#mov(this.#read(v, dst), dst);
  }

  /**
   * Write scalar `key` with `produce(d)`, which leaves the value in register `d` and must
   * cope with `d` being one of its own source registers (a home may be read and written by
   * the same node); a slot-homed value goes through eax.
   */
  #set(key: string, produce: (d: string) => void): void {
    const home = this.#home(key);
    if ('reg' in home) {
      produce(home.reg);
      return;
    }
    produce('%eax');
    this.#emit(`movl %eax, ${this.#m('%rsp', home.slot)}`);
  }

  /** Store `v` (any type) at [base + off]. */
  #place(v: Val, base: string, off: number): void {
    if (v.kind === 'lit') {
      this.#emit(`movl ${imm(v.value)}, ${this.#m(base, off)}`);
      return;
    }
    if (isPrimitive(v.type)) {
      this.#emit(`movl ${this.#read(v, '%eax')}, ${this.#m(base, off)}`);
      return;
    }
    this.#copy(base, off, '%rsp', this.#slot(v.key), words(v.type));
  }

  /** r10 = (index operand mod n) * elementBytes. Uses eax, edx, r10. */
  #scaledIndex(idx: Val, n: number, elemBytes: number): void {
    if (n === 1) this.#emit('movl $0, %r10d');
    else if ((n & (n - 1)) === 0) {
      this.#into('%r10d', idx);
      this.#emit(`andl ${imm(n - 1)}, %r10d`);
    } else {
      this.#into('%eax', idx);
      this.#emit('xorl %edx, %edx', `movl ${imm(n)}, %r10d`, 'divl %r10d', 'movl %edx, %r10d');
    }
    if (elemBytes === 1) return;
    if ((elemBytes & (elemBytes - 1)) === 0) this.#emit(`shlq $${Math.log2(elemBytes)}, %r10`);
    else this.#emit(`imulq ${imm(elemBytes)}, %r10, %r10`);
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
    // Homes are callee-saved here (the function is not a leaf), so writing the argument
    // registers in order disturbs no source.
    args.forEach((a, k) => {
      const place = places[k] as ArgPlace;
      if (place.reg !== undefined) {
        const r = ARG_REGS[place.reg] as string;
        if (a.kind === 'lit' || isPrimitive(a.type)) this.#into(r, a);
        else this.#emit(`leaq ${this.#m('%rsp', this.#slot(a.key))}, ${q(r)}`);
        return;
      }
      const at = this.#m('%rsp', place.stack as number);
      if (a.kind === 'lit' || isPrimitive(a.type)) this.#into('%eax', a);
      else this.#emit(`leaq ${this.#m('%rsp', this.#slot(a.key))}, %rax`);
      this.#emit(`movq %rax, ${at}`);
    });
    if (sret) this.#emit(`leaq ${this.#m('%rsp', this.#slot(dst))}, %rdi`);
    this.#emit(`call ${this.#sym(name)}`);
    if (!sret) this.#set(dst, (d) => this.#mov('%eax', d));
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
      this.#set(result, (d) => this.#into(d, ret));
      return;
    }
    if (ret.kind !== 'key') refuse('an aggregate literal cannot be returned');
    if (sink === 'bind') {
      this.#defAlias(result, ret.key, type);
      return;
    }
    this.#copy('%rsp', this.#slot(result), '%rsp', this.#slot(ret.key), words(type));
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
    const scalar = (produce: (d: string) => void): void => {
      this.#def(key, t);
      this.#set(key, produce);
    };
    /** d = a op b for a two-operand instruction, with an immediate when b is a literal. */
    const bin = (insn: string, commutative: boolean): void => {
      const ra = this.#read(a as Val, '%r10d');
      const rb = b?.kind === 'lit' ? imm(b.value) : this.#read(b as Val, '%r11d');
      scalar((d) => {
        if (d === ra) this.#emit(`${insn} ${rb}, ${d}`);
        else if (d === rb && commutative) this.#emit(`${insn} ${ra}, ${d}`);
        else if (d === rb) this.#emit(`movl ${ra}, %eax`, `${insn} ${rb}, %eax`, `movl %eax, ${d}`);
        else this.#emit(`movl ${ra}, ${d}`, `${insn} ${rb}, ${d}`);
      });
    };
    // 32-bit shifts use the count modulo 32: A0's five-bit mask.
    const shift = (insn: string): void => {
      const ra = this.#read(a as Val, '%r10d');
      if (b?.kind === 'lit') {
        const k = b.value & 31;
        scalar((d) => {
          this.#mov(ra, d);
          if (k !== 0) this.#emit(`${insn} $${k}, ${d}`);
        });
        return;
      }
      this.#into('%ecx', b as Val);
      scalar((d) => {
        this.#mov(ra, d);
        this.#emit(`${insn} %cl, ${d}`);
      });
    };
    const cmp = (cc: string): void => {
      const ra = this.#read(a as Val, '%r10d');
      const rb = b?.kind === 'lit' ? imm(b.value) : this.#read(b as Val, '%r11d');
      scalar((d) => this.#emit(`cmpl ${rb}, ${ra}`, `set${cc} %al`, `movzbl %al, ${d}`));
    };
    /** eax = a / b, edx = a mod b; a zero divisor takes the `zero` path with eax = a. */
    const divide = (zero: string[], nonzero: string[]): void => {
      const rb = this.#read(b as Val, '%r11d');
      this.#into('%eax', a as Val);
      const z = this.#label();
      const done = this.#label();
      this.#emit(`testl ${rb}, ${rb}`, `je ${z}`, 'xorl %edx, %edx', `divl ${rb}`, ...nonzero);
      this.#emit(`jmp ${done}`, `${z}:`, ...zero, `${done}:`);
      scalar((d) => this.#mov('%eax', d));
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
      case 'add':
        bin('addl', true);
        return;
      case 'sub':
        bin('subl', false);
        return;
      case 'mul': {
        if (b?.kind === 'lit') {
          const ra = this.#read(a as Val, '%r10d');
          scalar((d) => this.#emit(`imull ${imm(b.value)}, ${ra}, ${d}`));
          return;
        }
        bin('imull', true);
        return;
      }
      case 'and':
        bin('andl', true);
        return;
      case 'or':
        bin('orl', true);
        return;
      case 'xor':
        bin('xorl', true);
        return;
      case 'shl':
        shift('shll');
        return;
      case 'shr':
        shift('shrl');
        return;
      case 'div':
        // DIV traps on a zero divisor; A0 requires all ones.
        divide(['movl $-1, %eax'], []);
        return;
      case 'rem':
        // The remainder is in edx; a zero divisor gives the dividend (A0's rule), still in eax.
        divide([], ['movl %edx, %eax']);
        return;
      case 'eq':
        cmp('e');
        return;
      case 'ne':
        cmp('ne');
        return;
      case 'lt':
        cmp('b');
        return;
      case 'le':
        cmp('be');
        return;
      case 'gt':
        cmp('a');
        return;
      case 'ge':
        cmp('ae');
        return;
      case 'select': {
        if (isPrimitive(t)) {
          const rc = this.#read(a as Val, '%r10d');
          const rb = this.#read(b as Val, '%r11d');
          const rcc = this.#read(c as Val, '%eax');
          scalar((d) => {
            this.#emit(`testl ${rc}, ${rc}`);
            if (d === rb) this.#emit(`cmovel ${rcc}, ${d}`);
            else {
              this.#mov(rcc, d);
              this.#emit(`cmovnel ${rb}, ${d}`);
            }
          });
          return;
        }
        this.#def(key, t);
        const rc = this.#read(a as Val, '%eax');
        this.#emit(
          `leaq ${this.#m('%rsp', this.#slot(aggregateOf(b as Val, 'a value').key))}, %r10`,
          `leaq ${this.#m('%rsp', this.#slot(aggregateOf(c as Val, 'a value').key))}, %r11`,
          `testl ${rc}, ${rc}`,
          'cmovneq %r10, %r11',
        );
        this.#copy('%rsp', this.#slot(key), '%r11', 0, words(t));
        return;
      }
      case 'arr':
      case 'rec': {
        this.#def(key, t);
        let off = this.#slot(key);
        for (const v of vals) {
          this.#place(v, '%rsp', off);
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
          if (isPrimitive(t)) scalar((d) => this.#emit(`movl ${this.#m('%rsp', off)}, ${d}`));
          else {
            this.#def(key, t);
            this.#copy('%rsp', this.#slot(key), '%rsp', off, ew);
          }
          return;
        }
        this.#scaledIndex(b as Val, at.length, ew * 4);
        if (isPrimitive(t)) scalar((d) => this.#emit(`movl ${base}(%rsp,%r10), ${d}`));
        else {
          this.#def(key, t);
          this.#emit(`leaq ${base}(%rsp,%r10), %r11`);
          this.#copy('%rsp', this.#slot(key), '%r11', 0, ew);
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
          this.#copy('%rsp', this.#slot(key), '%rsp', this.#slot(src.key), words(at));
        }
        const dst = this.#slot(key);
        if (b?.kind === 'lit') {
          this.#place(c as Val, '%rsp', dst + (b.value % at.length) * ew * 4);
          return;
        }
        this.#scaledIndex(b as Val, at.length, ew * 4);
        this.#emit(`leaq ${dst}(%rsp,%r10), %r11`);
        this.#place(c as Val, '%r11', 0);
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
          if (isPrimitive(t)) scalar((d) => this.#emit(`movl ${this.#m('%rsp', from)}, ${d}`));
          else {
            this.#def(key, t);
            this.#copy('%rsp', this.#slot(key), '%rsp', from, words(field));
          }
          return;
        }
        if (mutableHere(env.fn, n.args[0] as Operand, index, env.ownedP0))
          this.#defAlias(key, src.key, t);
        else {
          this.#def(key, t);
          this.#copy('%rsp', this.#slot(key), '%rsp', this.#slot(src.key), words(rt));
        }
        this.#place(c as Val, '%rsp', this.#slot(key) + off);
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
        if (isPrimitive(t)) scalar((d) => this.#into(d, init));
        else if (
          init.kind === 'key' &&
          mutableHere(env.fn, n.args[1] as Operand, index, env.ownedP0)
        )
          this.#defAlias(key, init.key, t);
        else {
          this.#def(key, t);
          this.#place(init, '%rsp', this.#slot(key));
        }
        this.#def(counter, 'u32');
        this.#set(counter, (d) => this.#emit(`movl $0, ${d}`));
        this.#loops.push({ start: this.#pos, used: new Set() });
        const top = this.#label();
        const done = this.#label();
        this.#emit(`${top}:`);
        this.#use(count);
        this.#use(cval);
        const ci = this.#read(cval, '%r10d');
        const limit = count.kind === 'lit' ? imm(count.value) : this.#read(count, '%r11d');
        this.#emit(`cmpl ${limit}, ${ci}`, `jae ${done}`);
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
          const rp = this.#read(pv, '%eax');
          this.#emit(`testl ${rp}, ${rp}`, `je ${done}`);
        }
        if (this.#inlinable(callee, env))
          this.#inline(env, callee, args, true, key, t, n.id, 'store');
        else this.#call(name, callee, args, key);
        this.#use(cval);
        const cr = this.#read(cval, '%eax');
        this.#set(counter, (d) => {
          this.#mov(cr, d);
          this.#emit(`addl $1, ${d}`);
        });
        this.#emit(`jmp ${top}`, `${done}:`);
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

  /** Linear scan over definition order: scalars get callee-saved homes (and edi/esi/r8d/r9d in a leaf). */
  #allocate(places: readonly ArgPlace[]): void {
    const pool = this.#leaf ? [...LEAF_ARG_HOMES, ...CALLEE_SAVED] : CALLEE_SAVED;
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
        const arrival = places[Number(p[1])]?.reg;
        const r = arrival === undefined ? undefined : ARG_REGS[arrival];
        if (r !== undefined && LEAF_ARG_HOMES.includes(r) && !busy.has(r)) reg = r;
      }
      if (reg === undefined) reg = pool.find((r) => !busy.has(r));
      if (reg === undefined) continue;
      busy.set(reg, last);
      this.#regs.set(key, reg);
    }
    const used = new Set([...this.#regs.values()].filter((r) => CALLEE_SAVED.includes(r)));
    this.#saved = CALLEE_SAVED.filter((r) => used.has(r)).map(q);
  }

  /** Sequentialize register-to-register moves whose sources may be other moves' targets. */
  #parallelMove(moves: { src: string; dst: string }[]): void {
    const pending = moves.filter((m) => m.src !== m.dst);
    while (pending.length > 0) {
      const i = pending.findIndex((m) => !pending.some((o) => o !== m && o.src === m.dst));
      if (i >= 0) {
        const [m] = pending.splice(i, 1) as [{ src: string; dst: string }];
        this.#emit(`movl ${m.src}, ${m.dst}`);
        continue;
      }
      // Every target is still a source: break the cycle through eax.
      const m = pending[0] as { src: string; dst: string };
      this.#emit(`movl ${m.src}, %eax`);
      m.src = '%eax';
    }
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
    // Pass 1 (dry): positions, liveness, aliases, aggregate slots, residual-call needs.
    this.#dry = true;
    this.#pos = 0;
    for (const [i, t] of fn.params.entries()) this.#def(`p${i}`, t);
    this.#body(env);
    this.#pos += 1;
    const ret = this.#resolve(env, fn.ret);
    this.#use(ret);
    this.#allocate(places);
    for (const [k, d] of this.#defs)
      if (isPrimitive(d.type) && !this.#regs.has(k) && !this.#alias.has(k)) this.#alloc(k, 4);
    if (this.#saved.length > 0) this.#alloc('save', 8 * this.#saved.length, 8);
    if (sret) this.#alloc('sret', 8, 8);
    // A parameter arriving in rcx is parked in a slot when an incoming aggregate is copied
    // by the word loop, which counts in ecx.
    const looped = fn.params.some((t) => !isPrimitive(t) && words(t) > 16);
    const parked = looped
      ? fn.params.findIndex((_, i) => ARG_REGS[places[i]?.reg ?? -1] === '%ecx')
      : -1;
    if (parked >= 0) this.#alloc('parked', 8, 8);
    this.#outgoing = align(this.#outgoing, 16);
    const frame = this.#outgoing + align(this.#slotBytes, 16);
    // Pass 2: emission.
    this.#dry = false;
    this.out = [];
    this.#labels = 0;
    this.#pos = 0;
    this.#loops = [];
    const sym = this.#sym(fn.name);
    this.out.push(`\t.globl ${sym}`, '\t.p2align 4');
    if (this.platform === 'linux') this.out.push(`\t.type ${sym},@function`);
    this.out.push(`${sym}:`);
    this.#emit('pushq %rbp', 'movq %rsp, %rbp');
    if (frame > 4096) {
      // Probe one page at a time so the guard page is never skipped.
      const pages = Math.floor(frame / 4096);
      const probe = this.#label();
      this.#emit(`movl ${imm(pages)}, %eax`, `${probe}:`);
      this.#emit('subq $4096, %rsp', 'movq $0, (%rsp)', 'decl %eax', `jne ${probe}`);
      if (frame % 4096 > 0) this.#emit(`subq $${frame % 4096}, %rsp`);
    } else if (frame > 0) this.#emit(`subq $${frame}, %rsp`);
    for (const [k, r] of this.#saved.entries())
      this.#emit(`movq ${r}, ${this.#m('%rsp', this.#slot('save') + 8 * k)}`);
    if (sret) this.#emit(`movq %rdi, ${this.#m('%rsp', this.#slot('sret'))}`);
    if (parked >= 0) this.#emit(`movq %rcx, ${this.#m('%rsp', this.#slot('parked'))}`);
    const incoming = (i: number): number => frame + 16 + (places[i]?.stack as number);
    // Incoming aggregates are copied first (the copy loop uses eax, ecx, r10, r11 only, so
    // the other pointer and scalar registers survive), then scalars move to their homes.
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (isPrimitive(t)) return;
      let base: string;
      if (i === parked) {
        this.#emit(`movq ${this.#m('%rsp', this.#slot('parked'))}, %r11`);
        base = '%r11';
      } else if (place.reg !== undefined) base = q(ARG_REGS[place.reg] as string);
      else {
        this.#emit(`movq ${this.#m('%rsp', incoming(i))}, %r11`);
        base = '%r11';
      }
      this.#copy('%rsp', this.#slot(`p${i}`), base, 0, words(t));
    });
    const moves: { src: string; dst: string }[] = [];
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      // A scalar nobody reads is left where it arrived: moving it could clobber a live one.
      if (!isPrimitive(t) || !this.#last.has(`p${i}`)) return;
      const home = this.#home(`p${i}`);
      if (place.reg === undefined) {
        // Stack scalars: one eightbyte each; bools carry their value in the low byte.
        const at = this.#m('%rsp', incoming(i));
        this.#set(`p${i}`, (d) => {
          this.#emit(t === 'bool' ? `movzbl ${at}, ${d}` : `movl ${at}, ${d}`);
        });
        return;
      }
      const r = ARG_REGS[place.reg] as string;
      const src = i === parked ? this.#m('%rsp', this.#slot('parked')) : r;
      if (t === 'bool' && i !== parked) this.#emit(`andl $1, ${r}`);
      if ('reg' in home) {
        moves.push({ src, dst: home.reg });
        return;
      }
      const at = this.#m('%rsp', home.slot);
      if (i === parked) this.#emit(`movl ${src}, %eax`, `movl %eax, ${at}`);
      else this.#emit(`movl ${src}, ${at}`);
    });
    this.#parallelMove(moves);
    if (parked >= 0 && this.#last.has(`p${parked}`)) {
      const t = fn.params[parked] as Type;
      const home = this.#home(`p${parked}`);
      if (t === 'bool')
        this.#emit(`andl $1, ${'reg' in home ? home.reg : this.#m('%rsp', home.slot)}`);
    }
    this.#body(env);
    this.#pos += 1;
    if (!sret) this.#into('%eax', ret);
    else {
      this.#emit(`movq ${this.#m('%rsp', this.#slot('sret'))}, %r11`);
      this.#place(ret, '%r11', 0);
      this.#emit(`movq ${this.#m('%rsp', this.#slot('sret'))}, %rax`);
    }
    for (const [k, r] of this.#saved.entries())
      this.#emit(`movq ${this.#m('%rsp', this.#slot('save') + 8 * k)}, ${r}`);
    this.#emit('movq %rbp, %rsp', 'popq %rbp', 'ret');
    if (this.platform === 'linux') this.out.push(`\t.size ${sym}, .-${sym}`);
    return this.out.join('\n');
  }
}

/** Emit one function as x86-64 assembly (a `.globl a0_<name>` block, `_a0_` on macOS). */
export function emitX86_64Function(
  fn: TypedFunc,
  platform: X86Platform = HOST_X86_PLATFORM,
): string {
  return new FunctionEmitter(fn, platform).emit();
}

/** Assemble function blocks into one .s module for `clang -x assembler` / `as`. */
export function assembleX86_64(
  bodies: readonly string[],
  compilerVersion: string,
  platform: X86Platform = HOST_X86_PLATFORM,
): string {
  const head =
    platform === 'darwin' ? '\t.section __TEXT,__text,regular,pure_instructions' : '\t.text';
  const tail =
    platform === 'darwin' ? '.subsections_via_symbols' : '\t.section .note.GNU-stack,"",@progbits';
  return `# Generated by A0 ${compilerVersion}. x86-64 (${platform}) assembly, System V AMD64 ABI, AT&T syntax; exact u32/bool semantics.\n${head}\n\n${bodies.join('\n\n')}\n\n${tail}\n`;
}
