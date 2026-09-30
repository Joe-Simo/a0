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
 * Each parameter and each node owns one immutable stack slot (a straightforward per-node
 * allocator); registers are temporaries only, so no callee-saved register is used.
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
 *     outgoing stack arguments      sp ... sp + O - 1
 *
 * S and O are rounded to 16. Frames above 4 KiB are probed with ___chkstk_darwin. Scratch:
 * w9-w15 data, x16/x17 addresses; x17 is reserved for large-offset addressing.
 */

import {
  A0Error,
  containsIo,
  isPrimitive,
  type Node,
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

class FunctionEmitter {
  readonly out: string[] = [];
  readonly #slots = new Map<string, number>();
  #slotBytes = 0;
  #outgoing = 0;
  #labels = 0;
  #sretSlot = -1;

  constructor(readonly fn: TypedFunc) {}

  #emit(...lines: string[]): void {
    for (const l of lines) this.out.push(l.endsWith(':') ? l : `\t${l}`);
  }

  #label(): string {
    this.#labels += 1;
    return `La0_${this.fn.name}_${this.#labels}`;
  }

  #alloc(key: string, bytes: number): number {
    const off = this.#slotBytes;
    this.#slotBytes = align(this.#slotBytes + bytes, 4);
    this.#slots.set(key, off);
    return off;
  }

  /** Byte offset from sp of a named slot. */
  #slot(key: string): number {
    const off = this.#slots.get(key);
    if (off === undefined) throw new A0Error(`arm64: no slot for ${key}`);
    return this.#outgoing + off;
  }

  #typeOf(o: Operand): Type {
    switch (o.kind) {
      case 'u32':
        return 'u32';
      case 'bool':
        return 'bool';
      case 'param':
        return this.fn.params[o.index] ?? refuse(`unknown parameter p${o.index}`);
      case 'node':
        return this.fn.types.get(o.id) ?? refuse(`unknown node ${o.id}`);
    }
  }

  #slotOf(o: Operand): number {
    if (o.kind === 'param') return this.#slot(`p${o.index}`);
    if (o.kind === 'node') return this.#slot(`n_${o.id}`);
    return refuse('a literal has no slot');
  }

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

  /** Load a scalar operand into a w register. */
  #load(reg: string, o: Operand): void {
    if (o.kind === 'u32') this.#emit(...movImm(reg, o.value));
    else if (o.kind === 'bool') this.#emit(`movz ${reg}, #${o.value ? 1 : 0}`);
    else this.#mem('ldr', reg, 'sp', this.#slotOf(o));
  }

  /** Store operand `o` (any type) at [base + off]. */
  #place(o: Operand, base: string, off: number): void {
    const t = this.#typeOf(o);
    if (o.kind === 'u32' || o.kind === 'bool') {
      this.#load('w9', o);
      this.#mem('str', 'w9', base, off);
    } else this.#copy(base, off, 'sp', this.#slotOf(o), words(t));
  }

  /** w10 = (index operand mod n) * elementBytes, zero-extended into x10. */
  #scaledIndex(idx: Operand, n: number, elemBytes: number): void {
    this.#load('w10', idx);
    if (n === 1) this.#emit('movz w10, #0');
    else if ((n & (n - 1)) === 0) this.#emit(`and w10, w10, #${n - 1}`);
    else this.#emit(...movImm('w11', n), 'udiv w12, w10, w11', 'msub w10, w12, w11, w10');
    this.#emit(...movImm('w11', elemBytes), 'umull x10, w10, w11');
  }

  /** Call `callee` with argument operands (or the counter slot `i`) and store to `dst`. */
  #call(name: string, args: readonly (Operand | 'counter')[], counter: number, dst: number): void {
    const callee = this.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
    const { places } = argLayout(callee.params);
    args.forEach((a, k) => {
      const place = places[k] as ArgPlace;
      const t: Type = a === 'counter' ? 'u32' : this.#typeOf(a);
      if (place.reg !== undefined) {
        const r = place.reg;
        if (a === 'counter') this.#mem('ldr', `w${r}`, 'sp', counter);
        else if (isPrimitive(t)) this.#load(`w${r}`, a);
        else this.#addr(`x${r}`, 'sp', this.#slotOf(a));
        return;
      }
      const at = place.stack as number;
      if (a === 'counter') {
        this.#mem('ldr', 'w9', 'sp', counter);
        this.#mem('str', 'w9', 'sp', at);
      } else if (isPrimitive(t)) {
        this.#load('w9', a);
        this.#mem(t === 'bool' ? 'strb' : 'str', 'w9', 'sp', at);
      } else {
        this.#addr('x9', 'sp', this.#slotOf(a));
        this.#mem('str', 'x9', 'sp', at);
      }
    });
    if (!isPrimitive(callee.result)) this.#addr('x8', 'sp', dst);
    this.#emit(`bl _a0_${name}`);
    if (isPrimitive(callee.result)) this.#mem('str', 'w0', 'sp', dst);
  }

  #node(n: Node): void {
    const t = this.fn.types.get(n.id) ?? refuse(`untyped node ${n.id}`);
    const dst = this.#slot(`n_${n.id}`);
    const [a, b, c] = n.args;
    const bin = (insn: string): void => {
      this.#load('w10', a as Operand);
      this.#load('w11', b as Operand);
      this.#emit(`${insn} w12, w10, w11`);
      this.#mem('str', 'w12', 'sp', dst);
    };
    const cmp = (cond: string): void => {
      this.#load('w10', a as Operand);
      this.#load('w11', b as Operand);
      this.#emit('cmp w10, w11', `cset w12, ${cond}`);
      this.#mem('str', 'w12', 'sp', dst);
    };
    switch (n.op) {
      case 'mov':
        this.#place(a as Operand, 'sp', dst);
        return;
      case 'add':
      case 'sub':
      case 'mul':
      case 'and':
      case 'xor':
        bin(n.op === 'and' ? 'and' : n.op === 'xor' ? 'eor' : n.op);
        return;
      case 'or':
        bin('orr');
        return;
      // LSLV/LSRV on W registers use the distance modulo 32: A0's five-bit mask.
      case 'shl':
        bin('lsl');
        return;
      case 'shr':
        bin('lsr');
        return;
      case 'div':
        // UDIV yields 0 for a zero divisor; A0 requires all ones.
        this.#load('w10', a as Operand);
        this.#load('w11', b as Operand);
        this.#emit('udiv w12, w10, w11', 'cmp w11, #0', 'csinv w12, w12, wzr, ne');
        this.#mem('str', 'w12', 'sp', dst);
        return;
      case 'rem':
        // a - (a / b) * b; a zero divisor gives quotient 0, hence the dividend (A0's rule).
        this.#load('w10', a as Operand);
        this.#load('w11', b as Operand);
        this.#emit('udiv w12, w10, w11', 'msub w12, w12, w11, w10');
        this.#mem('str', 'w12', 'sp', dst);
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
        // Both operands are already computed values; select picks one.
        this.#load('w9', a as Operand);
        if (isPrimitive(t)) {
          this.#load('w10', b as Operand);
          this.#load('w11', c as Operand);
          this.#emit('cmp w9, #0', 'csel w12, w10, w11, ne');
          this.#mem('str', 'w12', 'sp', dst);
        } else {
          this.#addr('x10', 'sp', this.#slotOf(b as Operand));
          this.#addr('x11', 'sp', this.#slotOf(c as Operand));
          this.#emit('cmp w9, #0', 'csel x16, x10, x11, ne');
          this.#copy('sp', dst, 'x16', 0, words(t));
        }
        return;
      }
      case 'arr':
      case 'rec': {
        let off = dst;
        for (const arg of n.args) {
          this.#place(arg, 'sp', off);
          off += 4 * words(this.#typeOf(arg));
        }
        return;
      }
      case 'get': {
        const at = this.#typeOf(a as Operand);
        if (isPrimitive(at) || at.kind !== 'arr') {
          refuse('get needs an array');
          return;
        }
        const ew = words(at.elem);
        const base = this.#slotOf(a as Operand);
        if (b?.kind === 'u32') {
          this.#copy('sp', dst, 'sp', base + (b.value % at.length) * ew * 4, ew);
          return;
        }
        this.#scaledIndex(b as Operand, at.length, ew * 4);
        this.#addr('x16', 'sp', base);
        this.#emit('add x16, x16, x10');
        this.#copy('sp', dst, 'x16', 0, ew);
        return;
      }
      case 'set': {
        const at = this.#typeOf(a as Operand);
        if (isPrimitive(at) || at.kind !== 'arr') {
          refuse('set needs an array');
          return;
        }
        const ew = words(at.elem);
        this.#copy('sp', dst, 'sp', this.#slotOf(a as Operand), words(at));
        if (b?.kind === 'u32') {
          this.#place(c as Operand, 'sp', dst + (b.value % at.length) * ew * 4);
          return;
        }
        this.#scaledIndex(b as Operand, at.length, ew * 4);
        this.#addr('x16', 'sp', dst);
        this.#emit('add x16, x16, x10');
        this.#place(c as Operand, 'x16', 0);
        return;
      }
      case 'at':
      case 'put': {
        const rt = this.#typeOf(a as Operand);
        if (isPrimitive(rt) || rt.kind !== 'rec' || b?.kind !== 'u32')
          refuse(`${n.op} needs a record and a literal field`);
        const field = rt.fields[b.value] ?? refuse('field out of range');
        const off = 4 * rt.fields.slice(0, b.value).reduce((s, f) => s + words(f), 0);
        const src = this.#slotOf(a as Operand);
        if (n.op === 'at') {
          this.#copy('sp', dst, 'sp', src + off, words(field));
          return;
        }
        this.#copy('sp', dst, 'sp', src, words(rt));
        this.#place(c as Operand, 'sp', dst + off);
        return;
      }
      case 'call':
        this.#call(n.callee as string, n.args, 0, dst);
        return;
      case 'fold':
      case 'loop': {
        const [count, init, ...extra] = n.args;
        const counter = this.#slot(`i_${n.id}`);
        const top = this.#label();
        const done = this.#label();
        this.#place(init as Operand, 'sp', dst);
        this.#mem('str', 'wzr', 'sp', counter);
        this.#emit(`${top}:`);
        this.#mem('ldr', 'w9', 'sp', counter);
        this.#load('w10', count as Operand);
        this.#emit('cmp w9, w10', `b.hs ${done}`);
        const args: (Operand | 'counter')[] = [{ kind: 'node', id: n.id }, 'counter', ...extra];
        if (n.op === 'loop') {
          this.#call(n.pred as string, args, counter, this.#slot(`c_${n.id}`));
          this.#mem('ldr', 'w9', 'sp', this.#slot(`c_${n.id}`));
          this.#emit(`cbz w9, ${done}`);
        }
        this.#call(n.callee as string, args, counter, dst);
        this.#mem('ldr', 'w9', 'sp', counter);
        this.#emit('add w9, w9, #1');
        this.#mem('str', 'w9', 'sp', counter);
        this.#emit(`b ${top}`, `${done}:`);
        return;
      }
      case 'read':
      case 'write':
      case 'puts':
        refuse(`${n.op} is an io operation`);
        return;
    }
  }

  emit(): string {
    const fn = this.fn;
    if (
      containsIo(fn.result) ||
      fn.params.some(containsIo) ||
      [...fn.types.values()].some(containsIo)
    )
      refuse(`function ${fn.name} uses io; io functions are out of scope for this backend`);
    // Slots: parameters, the sret pointer, every node (plus loop counters and predicate results).
    // The 8-byte sret slot comes first so it is 8-aligned (slots start 16-aligned at sp + O).
    if (!isPrimitive(fn.result)) this.#sretSlot = this.#alloc('sret', 8);
    for (const [i, t] of fn.params.entries()) this.#alloc(`p${i}`, 4 * words(t));
    for (const n of fn.nodes) {
      this.#alloc(`n_${n.id}`, 4 * words(fn.types.get(n.id) ?? 'u32'));
      if (n.op === 'fold' || n.op === 'loop') this.#alloc(`i_${n.id}`, 4);
      if (n.op === 'loop') this.#alloc(`c_${n.id}`, 4);
      if (n.op === 'call' || n.op === 'fold' || n.op === 'loop') {
        const callee = fn.calls.get(n.callee as string);
        if (callee !== undefined)
          this.#outgoing = Math.max(this.#outgoing, argLayout(callee.params).bytes);
        const pred = n.pred === undefined ? undefined : fn.calls.get(n.pred);
        if (pred !== undefined)
          this.#outgoing = Math.max(this.#outgoing, argLayout(pred.params).bytes);
      }
    }
    this.#outgoing = align(this.#outgoing, 16);
    const slotBytes = align(this.#slotBytes, 16);
    const frame = this.#outgoing + slotBytes;
    const sym = `_a0_${fn.name}`;
    this.out.push(`\t.globl ${sym}`, '\t.p2align 2', `${sym}:`);
    this.#emit('stp x29, x30, [sp, #-16]!', 'mov x29, sp');
    if (frame > 0) {
      this.#emit(...movImm('x9', frame));
      if (frame > 4096) this.#emit('bl ___chkstk_darwin', ...movImm('x9', frame));
      this.#emit('sub sp, sp, x9');
    }
    // Incoming parameters into their slots.
    const { places } = argLayout(fn.params);
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      const slot = this.#slot(`p${i}`);
      if (place.reg !== undefined) {
        if (isPrimitive(t)) {
          if (t === 'bool') this.#emit(`and w${place.reg}, w${place.reg}, #1`);
          this.#mem('str', `w${place.reg}`, 'sp', slot);
        } else this.#copy('sp', slot, `x${place.reg}`, 0, words(t));
        return;
      }
      const incoming = frame + 16 + (place.stack as number);
      if (isPrimitive(t)) {
        this.#mem(t === 'bool' ? 'ldrb' : 'ldr', 'w9', 'sp', incoming);
        if (t === 'bool') this.#emit('and w9, w9, #1');
        this.#mem('str', 'w9', 'sp', slot);
      } else {
        this.#mem('ldr', 'x12', 'sp', incoming);
        this.#copy('sp', slot, 'x12', 0, words(t));
      }
    });
    if (this.#sretSlot >= 0) this.#mem('str', 'x8', 'sp', this.#slot('sret'));
    for (const n of fn.nodes) this.#node(n);
    if (isPrimitive(fn.result)) this.#load('w0', fn.ret);
    else {
      this.#mem('ldr', 'x12', 'sp', this.#slot('sret'));
      this.#place(fn.ret, 'x12', 0);
    }
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
