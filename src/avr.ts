/**
 * Direct native backend: AVR assembly for the ATmega328P (Arduino Uno), GNU as syntax, on the
 * avr-gcc calling convention so a C program built with avr-gcc calls `a0_<name>` directly.
 * A0 reaches the microcontroller through this code generator plus avr-as and avr-ld only; no
 * C is generated for the program.
 *
 * Scope: functions over u32 and bool, small fixed-size arrays and records of them (value
 * semantics), every scalar op with A0's exact meaning, `call`, `fold`, and `loop`. io
 * functions are refused (`structure`), and so is anything that does not fit the part: one
 * aggregate above AGGREGATE_MAX_BYTES, a frame above FRAME_MAX_BYTES, or more argument bytes
 * than the avr-gcc registers carry (`limit`).
 *
 * Representation: a u32 is four bytes, little-endian; a bool is one byte holding 0 or 1; an
 * array is its elements back to back and a record its fields in order, with no padding.
 *
 * Code shape: the AVR is an 8-bit machine, so every value lives in a frame slot addressed
 * from the frame pointer Y (ldd/std reach Y+63; farther slots go through Z). An operation
 * loads its operands into r22-r25 (A) and r18-r21 (B), computes, and stores the result. add,
 * sub, and, or, xor, compares, select, and constant shifts are inline byte sequences with
 * carry chains; mul (shift-and-add), div/rem (one restoring divider whose zero-divisor
 * behaviour is A0's: quotient all ones, remainder the dividend), variable shifts (count
 * masked to five bits), and block copies are helper routines emitted once per module, only
 * when referenced. Values are immutable, so `mov`, `at`, and a literal-index `get` are
 * aliases of the source slot and emit nothing; `set`/`put` copy. `call`, `fold`, and `loop`
 * call the callee out of line.
 *
 * Calling convention (avr-gcc): each parameter takes the next registers downward from r25,
 * its size rounded up to even: a u32 in four registers (lowest byte in the lowest), a bool in
 * one (the low register of its pair), an aggregate as a 16-bit pointer to a caller-owned
 * copy the callee never changes. A u32 result returns in r22-r25 and a bool in r24; an
 * aggregate result is written through a hidden pointer that comes first (r24:r25), so from C
 * such a function is `void a0_f(T *out, const T *p0, ...)`. The callee copies aggregate
 * parameters into its frame on entry and writes the result last, so `out` may alias an
 * argument (fold state updates rely on this). r0 and r18-r27, r30, r31 are scratch; r1 is
 * zero on every call and return; r2-r17 and r28-r29 are preserved (argument registers below
 * r18 that this function loads for its own calls are saved in its prologue). Each function
 * and helper sits in its own `.text.<symbol>` section, so `--gc-sections` keeps only what a
 * program reaches.
 */

import {
  A0Error,
  containsIo,
  isPrimitive,
  type Operand,
  type Type,
  type TypedFunc,
} from './core.js';
import { optimizeFunction } from './optimize.js';

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

/** avr-gcc register placement: the lowest register of each parameter (a hidden sret pointer first). */
function argLayout(params: readonly Type[], sret: boolean, where: string): number[] {
  let cursor = 26;
  if (sret) cursor -= 2;
  return params.map((t) => {
    const size = isPrimitive(t) ? bytesOf(t) : 2;
    cursor -= (size + 1) & ~1;
    if (cursor < 8)
      refuse(
        `${where}: parameters need more than the 18 argument registers (r8-r25); stack arguments are not supported`,
        'limit',
      );
    return cursor;
  });
}

const A = [22, 23, 24, 25];
const B = [18, 19, 20, 21];
const REM = [26, 27, 30, 31];

type Val =
  | { readonly kind: 'lit'; readonly value: number; readonly type: 'u32' | 'bool' }
  | { readonly kind: 'key'; readonly key: string; readonly type: Type };

const lo = (n: number): number => n & 0xff;
const hi = (n: number): number => (n >> 8) & 0xff;
const neg16 = (n: number): number => -n & 0xffff;

class AvrEmitter {
  readonly out: string[] = [];
  readonly #slots = new Map<string, number>();
  #size = 0;
  #labels = 0;
  readonly #saved = new Set<number>();
  frameBytes = 0;
  pushes = 0;

  constructor(readonly fn: TypedFunc) {}

  #emit(...lines: string[]): void {
    for (const l of lines) this.out.push(l.endsWith(':') ? l : `\t${l}`);
  }

  #label(): string {
    this.#labels += 1;
    return `.La0_${this.fn.name}_${this.#labels}`;
  }

  #alloc(key: string, bytes: number): number {
    const off = this.#size + 1;
    this.#size += bytes;
    this.#slots.set(key, off);
    return off;
  }

  #slot(key: string): number {
    return this.#slots.get(key) ?? refuse(`no slot for ${key}`);
  }

  #resolve(o: Operand): Val {
    switch (o.kind) {
      case 'u32':
        return { kind: 'lit', value: o.value >>> 0, type: 'u32' };
      case 'bool':
        return { kind: 'lit', value: o.value ? 1 : 0, type: 'bool' };
      case 'param':
        return {
          kind: 'key',
          key: `p${o.index}`,
          type: this.fn.params[o.index] ?? refuse(`unknown parameter p${o.index}`),
        };
      case 'node':
        return {
          kind: 'key',
          key: `n_${o.id}`,
          type: this.fn.types.get(o.id) ?? refuse(`unknown node ${o.id}`),
        };
    }
  }

  // --- memory ---------------------------------------------------------------------------

  /** Address `n` bytes at frame offset `off`: Y+off when ldd/std reach, else Z = Y+off. */
  #mem(off: number, n: number): (k: number) => string {
    if (off + n - 1 <= 63) return (k) => `Y+${off + k}`;
    this.#pointer(30, off);
    return (k) => (k === 0 ? 'Z' : `Z+${k}`);
  }

  /** r(pair):r(pair+1) = Y + off, for pair 26 (X) or 30 (Z). */
  #pointer(pair: 26 | 30, off: number): void {
    this.#emit(`movw r${pair}, r28`);
    if (off !== 0)
      this.#emit(`subi r${pair}, ${lo(neg16(off))}`, `sbci r${pair + 1}, ${hi(neg16(off))}`);
  }

  #load(regs: readonly number[], off: number): void {
    const m = this.#mem(off, regs.length);
    regs.forEach((r, k) => {
      const at = m(k);
      this.#emit(at === 'Z' ? `ld r${r}, Z` : `ldd r${r}, ${at}`);
    });
  }

  #store(regs: readonly number[], off: number): void {
    const m = this.#mem(off, regs.length);
    regs.forEach((r, k) => {
      const at = m(k);
      this.#emit(at === 'Z' ? `st Z, r${r}` : `std ${at}, r${r}`);
    });
  }

  /** One byte constant into any register (ldi reaches r16-r31 only). */
  #imm(reg: number, byte: number): void {
    if (reg >= 16) this.#emit(`ldi r${reg}, ${byte}`);
    else if (byte === 0) this.#emit(`mov r${reg}, r1`);
    else this.#emit(`ldi r30, ${byte}`, `mov r${reg}, r30`);
  }

  /** Scalar `v` into `regs` (one register for bool, four for u32). */
  #read(v: Val, regs: readonly number[]): void {
    if (v.kind === 'lit') {
      regs.forEach((r, k) => {
        this.#imm(r, (v.value >>> (8 * k)) & 0xff);
      });
      return;
    }
    this.#load(regs, this.#slot(v.key));
  }

  /** Copy `n` bytes between frame offsets. */
  #copy(dst: number, src: number, n: number): void {
    if (dst === src || n === 0) return;
    if (n <= 12) {
      for (let k = 0; k < n; k += 4) {
        const regs = A.slice(0, Math.min(4, n - k));
        this.#load(regs, src + k);
        this.#store(regs, dst + k);
      }
      return;
    }
    this.#pointer(26, src);
    this.#pointer(30, dst);
    this.#copyCall(n);
  }

  /** X = source, Z = destination already set: copy `n` bytes. */
  #copyCall(n: number): void {
    this.#emit(`ldi r24, ${lo(n)}`, `ldi r25, ${hi(n)}`, 'call __a0_copy');
  }

  /** Place value `v` of any type at frame offset `off`. */
  #place(v: Val, off: number): void {
    if (v.kind === 'lit' || isPrimitive(v.type)) {
      const regs = A.slice(0, bytesOf(v.type));
      this.#read(v, regs);
      this.#store(regs, off);
      return;
    }
    this.#copy(off, this.#slot(v.key), bytesOf(v.type));
  }

  /** Branch to `target` when `cc` holds, at any distance. */
  #branchFar(inverse: string, target: string): void {
    const skip = this.#label();
    this.#emit(`${inverse} ${skip}`, `jmp ${target}`, `${skip}:`);
  }

  /** r20 = (index mod n) * elemBytes, for a variable index (the aggregate is at most 255 bytes). */
  #elementOffset(idx: Val, n: number, elemBytes: number): void {
    if ((n & (n - 1)) === 0) {
      this.#read(idx, [20]);
      this.#emit(`andi r20, ${n - 1}`);
    } else {
      this.#read(idx, A);
      this.#read({ kind: 'lit', value: n, type: 'u32' }, B);
      this.#emit('call __a0_udivmod32', 'mov r20, r26');
    }
    if (elemBytes > 1) this.#emit(`ldi r21, ${elemBytes}`, 'mul r20, r21', 'mov r20, r0', 'clr r1');
  }

  // --- calls ------------------------------------------------------------------------------

  /** Out-of-line call of `name` with `args`; the result goes to frame offset `dst`. */
  #call(name: string, callee: TypedFunc, args: readonly Val[], dst: number): void {
    const sret = !isPrimitive(callee.result);
    const places = argLayout(callee.params, sret, `call to ${name}`);
    args.forEach((a, k) => {
      const r = places[k] as number;
      const width = a.kind === 'lit' || isPrimitive(a.type) ? bytesOf(a.type) : 2;
      for (let j = 0; j < width; j += 1) if (r + j < 18) this.#saved.add(r + j);
      const regs = Array.from({ length: width }, (_, j) => r + j);
      if (a.kind === 'lit' || isPrimitive(a.type)) this.#read(a, regs);
      else {
        this.#pointer(30, this.#slot(a.key));
        this.#emit(`movw r${r}, r30`);
      }
    });
    if (sret) {
      this.#pointer(30, dst);
      this.#emit('movw r24, r30');
    }
    this.#emit(`call a0_${name}`);
    if (!sret) this.#store(callee.result === 'bool' ? [24] : A, dst);
  }

  // --- nodes ------------------------------------------------------------------------------

  #node(n: TypedFunc['nodes'][number]): void {
    const t = this.fn.types.get(n.id) ?? refuse(`untyped node ${n.id}`);
    const key = `n_${n.id}`;
    const vals = n.args.map((o) => this.#resolve(o));
    const [a, b, c] = vals as [Val, Val, Val];
    if (!isPrimitive(t) && bytesOf(t) > AVR_AGGREGATE_MAX_BYTES)
      refuse(
        `node ${n.id} is a ${bytesOf(t)}-byte aggregate; the limit is ${AVR_AGGREGATE_MAX_BYTES} bytes of the ATmega328P's 2 KiB SRAM`,
        'limit',
      );
    const fresh = (): number => this.#alloc(key, bytesOf(t));
    const alias = (off: number): void => {
      this.#slots.set(key, off);
    };
    const width = (v: Val): number[] => A.slice(0, bytesOf(v.type));
    const operands = (): number => {
      const w = bytesOf(a.type);
      this.#read(a, A.slice(0, w));
      this.#read(b, B.slice(0, w));
      return w;
    };
    const bytewise = (first: string, rest: string): void => {
      const w = operands();
      for (let k = 0; k < w; k += 1) this.#emit(`${k === 0 ? first : rest} r${A[k]}, r${B[k]}`);
      this.#store(A.slice(0, w), fresh());
    };
    const compare = (swap: boolean, branch: string): void => {
      const w = operands();
      const [x, y] = swap ? [B, A] : [A, B];
      for (let k = 0; k < w; k += 1) this.#emit(`${k === 0 ? 'cp' : 'cpc'} r${x[k]}, r${y[k]}`);
      const done = this.#label();
      this.#emit('ldi r26, 1', `${branch} ${done}`, 'ldi r26, 0', `${done}:`);
      this.#store([26], fresh());
    };
    const helper = (name: string, result: readonly number[]): void => {
      this.#read(a, A);
      this.#read(b, B);
      this.#emit(`call ${name}`);
      if (result === REM) this.#emit('movw r22, r26', 'movw r24, r30');
      this.#store(A, fresh());
    };
    const shift = (left: boolean): void => {
      if (b.kind === 'lit') {
        const k = b.value & 31;
        this.#read(a, A);
        const bytes = k >> 3;
        const order = left ? [3, 2, 1, 0] : [0, 1, 2, 3];
        if (bytes > 0)
          for (const i of order) {
            const from = left ? i - bytes : i + bytes;
            if (from >= 0 && from <= 3) this.#emit(`mov r${A[i]}, r${A[from]}`);
            else this.#emit(`clr r${A[i]}`);
          }
        for (let s = 0; s < (k & 7); s += 1)
          this.#emit(
            ...(left
              ? ['lsl r22', 'rol r23', 'rol r24', 'rol r25']
              : ['lsr r25', 'ror r24', 'ror r23', 'ror r22']),
          );
        this.#store(A, fresh());
        return;
      }
      this.#read(a, A);
      this.#read(b, [18]);
      this.#emit(`call ${left ? '__a0_shl32' : '__a0_shr32'}`);
      this.#store(A, fresh());
    };
    const aggregate = (v: Val, what: string): { off: number; type: Type } => {
      if (v.kind !== 'key' || isPrimitive(v.type)) refuse(`${n.op} needs ${what}`);
      return { off: this.#slot(v.key), type: v.type };
    };
    switch (n.op) {
      case 'mov':
        if (a.kind === 'key') alias(this.#slot(a.key));
        else this.#place(a, fresh());
        return;
      case 'add':
        bytewise('add', 'adc');
        return;
      case 'sub':
        bytewise('sub', 'sbc');
        return;
      case 'and':
        bytewise('and', 'and');
        return;
      case 'or':
        bytewise('or', 'or');
        return;
      case 'xor':
        bytewise('eor', 'eor');
        return;
      case 'mul':
        helper('__a0_mul32', A);
        return;
      case 'div':
        helper('__a0_udivmod32', A);
        return;
      case 'rem':
        helper('__a0_udivmod32', REM);
        return;
      case 'shl':
        shift(true);
        return;
      case 'shr':
        shift(false);
        return;
      case 'eq':
        compare(false, 'breq');
        return;
      case 'ne':
        compare(false, 'brne');
        return;
      case 'lt':
        compare(false, 'brlo');
        return;
      case 'ge':
        compare(false, 'brsh');
        return;
      case 'gt':
        compare(true, 'brlo');
        return;
      case 'le':
        compare(true, 'brsh');
        return;
      case 'select': {
        const dst = fresh();
        const other = this.#label();
        const done = this.#label();
        this.#read(a, [26]);
        this.#emit('tst r26');
        this.#branchFar('brne', other);
        this.#place(b, dst);
        this.#emit(`jmp ${done}`, `${other}:`);
        this.#place(c, dst);
        this.#emit(`${done}:`);
        return;
      }
      case 'arr':
      case 'rec': {
        let off = fresh();
        for (const v of vals) {
          this.#place(v, off);
          off += bytesOf(v.type);
        }
        return;
      }
      case 'get': {
        const src = aggregate(a, 'an array');
        if (isPrimitive(src.type) || src.type.kind !== 'arr') refuse('get needs an array');
        const es = bytesOf(src.type.elem);
        const len = src.type.length;
        if (b.kind === 'lit') {
          alias(src.off + (b.value % len) * es);
          return;
        }
        const dst = fresh();
        this.#elementOffset(b, len, es);
        this.#pointer(26, src.off);
        this.#emit('add r26, r20', 'adc r27, r1');
        if (isPrimitive(t)) {
          const regs = A.slice(0, es);
          for (const r of regs) this.#emit(`ld r${r}, X+`);
          this.#store(regs, dst);
        } else {
          this.#pointer(30, dst);
          this.#copyCall(es);
        }
        return;
      }
      case 'set': {
        const src = aggregate(a, 'an array');
        if (isPrimitive(src.type) || src.type.kind !== 'arr') refuse('set needs an array');
        const es = bytesOf(src.type.elem);
        const len = src.type.length;
        const dst = fresh();
        this.#copy(dst, src.off, bytesOf(src.type));
        if (b.kind === 'lit') {
          this.#place(c, dst + (b.value % len) * es);
          return;
        }
        this.#elementOffset(b, len, es);
        if (c.kind === 'lit' || isPrimitive(c.type)) {
          const regs = width(c);
          this.#read(c, regs);
          this.#pointer(26, dst);
          this.#emit('add r26, r20', 'adc r27, r1');
          for (const r of regs) this.#emit(`st X+, r${r}`);
        } else {
          this.#pointer(30, dst);
          this.#emit('add r30, r20', 'adc r31, r1');
          this.#pointer(26, this.#slot(c.key));
          this.#copyCall(es);
        }
        return;
      }
      case 'at':
      case 'put': {
        const src = aggregate(a, 'a record');
        const rt = src.type;
        if (isPrimitive(rt) || rt.kind !== 'rec' || b.kind !== 'lit')
          refuse(`${n.op} needs a record and a literal field`);
        if (rt.fields[b.value] === undefined) refuse('field out of range');
        const off = rt.fields.slice(0, b.value).reduce((s, f) => s + bytesOf(f), 0);
        if (n.op === 'at') {
          alias(src.off + off);
          return;
        }
        const dst = fresh();
        this.#copy(dst, src.off, bytesOf(rt));
        this.#place(c, dst + off);
        return;
      }
      case 'call': {
        const name = n.callee as string;
        const callee = this.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
        this.#call(name, callee, vals, fresh());
        return;
      }
      case 'fold':
      case 'loop': {
        const [count, init, ...extras] = vals as [Val, Val, ...Val[]];
        const name = n.callee as string;
        const callee = this.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
        const pred = n.pred === undefined ? undefined : this.fn.calls.get(n.pred);
        const state = fresh();
        this.#place(init, state);
        const counterKey = `i_${n.id}`;
        const counter = this.#alloc(counterKey, 4);
        this.#store([1, 1, 1, 1], counter);
        const top = this.#label();
        const body = this.#label();
        const done = this.#label();
        this.#emit(`${top}:`);
        this.#load(A, counter);
        this.#read(count, B);
        for (let k = 0; k < 4; k += 1) this.#emit(`${k === 0 ? 'cp' : 'cpc'} r${A[k]}, r${B[k]}`);
        this.#emit(`brlo ${body}`, `jmp ${done}`, `${body}:`);
        const args: Val[] = [
          { kind: 'key', key, type: t },
          { kind: 'key', key: counterKey, type: 'u32' },
          ...extras,
        ];
        if (pred !== undefined) {
          const flag = this.#alloc(`c_${n.id}`, 1);
          this.#call(n.pred as string, pred, args, flag);
          this.#load([24], flag);
          this.#emit('tst r24');
          this.#branchFar('brne', done);
        }
        this.#call(name, callee, args, state);
        this.#load(A, counter);
        this.#emit('subi r22, 255', 'sbci r23, 255', 'sbci r24, 255', 'sbci r25, 255');
        this.#store(A, counter);
        this.#emit(`jmp ${top}`, `${done}:`);
        return;
      }
      case 'read':
      case 'write':
      case 'puts':
        refuse(`${n.op} is an io operation`);
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
    for (const t of [...fn.params, fn.result])
      if (!isPrimitive(t) && bytesOf(t) > AVR_AGGREGATE_MAX_BYTES)
        refuse(
          `function ${fn.name} has a ${bytesOf(t)}-byte aggregate in its signature; the limit is ${AVR_AGGREGATE_MAX_BYTES} bytes`,
          'limit',
        );
    const sret = !isPrimitive(fn.result);
    const places = argLayout(fn.params, sret, `function ${fn.name}`);
    // Entry: every incoming register goes to the frame first (the copy helper uses r24-r27,
    // r30, r31, which may still hold arguments), then aggregates are copied in.
    const sretSlot = sret ? this.#alloc('sret', 2) : 0;
    if (sret) this.#store([24, 25], sretSlot);
    const pointers: { i: number; slot: number }[] = [];
    fn.params.forEach((t, i) => {
      const r = places[i] as number;
      if (isPrimitive(t)) {
        this.#store(
          Array.from({ length: bytesOf(t) }, (_, j) => r + j),
          this.#alloc(`p${i}`, bytesOf(t)),
        );
        return;
      }
      const slot = this.#alloc(`pp${i}`, 2);
      this.#store([r, r + 1], slot);
      pointers.push({ i, slot });
    });
    for (const { i, slot } of pointers) {
      const size = bytesOf(fn.params[i] as Type);
      const own = this.#alloc(`p${i}`, size);
      this.#load([24, 25], slot);
      this.#emit('movw r26, r24');
      this.#pointer(30, own);
      this.#copyCall(size);
    }
    for (const n of fn.nodes) this.#node(n);
    const ret = this.#resolve(fn.ret);
    if (!sret) {
      this.#read(ret, fn.result === 'bool' ? [24] : A);
      if (fn.result === 'bool') this.#emit('clr r25');
    } else {
      if (ret.kind !== 'key') refuse('an aggregate literal cannot be returned');
      this.#load([24, 25], sretSlot);
      this.#emit('movw r30, r24');
      this.#pointer(26, this.#slot(ret.key));
      this.#copyCall(bytesOf(fn.result));
    }
    const frame = this.#size;
    if (frame > AVR_FRAME_MAX_BYTES)
      refuse(
        `function ${fn.name} needs a ${frame}-byte frame; the limit is ${AVR_FRAME_MAX_BYTES} bytes of the ATmega328P's 2 KiB SRAM`,
        'limit',
      );
    const saved = [...this.#saved].sort((x, y) => x - y);
    this.frameBytes = frame;
    this.pushes = 2 + saved.length;
    const body = this.out.splice(0);
    const sym = `a0_${fn.name}`;
    const setSp = ['in r0, 0x3f', 'cli', 'out 0x3e, r29', 'out 0x3f, r0', 'out 0x3d, r28'];
    this.out.push(
      `\t.section .text.${sym},"ax",@progbits`,
      `\t.globl ${sym}`,
      `\t.type ${sym}, @function`,
      `${sym}:`,
    );
    this.#emit(...saved.map((r) => `push r${r}`), 'push r28', 'push r29');
    this.#emit('in r28, 0x3d', 'in r29, 0x3e');
    if (frame > 0) this.#emit(`subi r28, ${lo(frame)}`, `sbci r29, ${hi(frame)}`, ...setSp);
    this.out.push(...body);
    if (frame > 0)
      this.#emit(`subi r28, ${lo(neg16(frame))}`, `sbci r29, ${hi(neg16(frame))}`, ...setSp);
    this.#emit('pop r29', 'pop r28', ...saved.reverse().map((r) => `pop r${r}`), 'ret');
    this.out.push(`\t.size ${sym}, .-${sym}`);
    return this.out.join('\n');
  }
}

/** Emit one function as AVR assembly (a `.globl a0_<name>` block in `.text.a0_<name>`). */
export function emitAvrFunction(fn: TypedFunc): string {
  return new AvrEmitter(fn).emit();
}

/**
 * Static upper bound on the SRAM stack one call of `fn` uses (frames, saved registers, return
 * addresses, and helper calls, through every callee), for the emission `compile` produces.
 */
export function avrStackBytes(fn: TypedFunc, optimize = true): number {
  const memo = new Map<string, number>();
  const walk = (f: TypedFunc): number => {
    const known = memo.get(f.name);
    if (known !== undefined) return known;
    const source = optimize ? optimizeFunction(f).fn : f;
    const e = new AvrEmitter(source);
    e.emit();
    let deepest = 2; // a helper's return address
    for (const callee of source.calls.values()) deepest = Math.max(deepest, walk(callee));
    const total = 2 + e.pushes + e.frameBytes + deepest;
    memo.set(f.name, total);
    return total;
  };
  return walk(fn);
}

const HELPERS: Readonly<Record<string, readonly string[]>> = {
  // r22-r25 = r22-r25 * r18-r21 (low 32 bits): shift and add, 32 steps.
  __a0_mul32: [
    'ldi r26, 32',
    'mov r0, r26',
    'clr r26',
    'clr r27',
    'clr r30',
    'clr r31',
    '.La0_mul_step:',
    'sbrs r18, 0',
    'rjmp .La0_mul_shift',
    'add r26, r22',
    'adc r27, r23',
    'adc r30, r24',
    'adc r31, r25',
    '.La0_mul_shift:',
    'lsl r22',
    'rol r23',
    'rol r24',
    'rol r25',
    'lsr r21',
    'ror r20',
    'ror r19',
    'ror r18',
    'dec r0',
    'brne .La0_mul_step',
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
    'clr r30',
    'clr r31',
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
  // r22-r25 <<= r18 & 31.
  __a0_shl32: [
    'andi r18, 31',
    'breq .La0_shl_done',
    '.La0_shl_step:',
    'lsl r22',
    'rol r23',
    'rol r24',
    'rol r25',
    'dec r18',
    'brne .La0_shl_step',
    '.La0_shl_done:',
    'ret',
  ],
  // r22-r25 >>= r18 & 31 (logical).
  __a0_shr32: [
    'andi r18, 31',
    'breq .La0_shr_done',
    '.La0_shr_step:',
    'lsr r25',
    'ror r24',
    'ror r23',
    'ror r22',
    'dec r18',
    'brne .La0_shr_step',
    '.La0_shr_done:',
    'ret',
  ],
  // Copy r24:r25 (> 0) bytes from X to Z.
  __a0_copy: [
    '.La0_copy_step:',
    'ld r0, X+',
    'st Z+, r0',
    'sbiw r24, 1',
    'brne .La0_copy_step',
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
  return `; Generated by A0 ${compilerVersion}. AVR (ATmega328P) assembly, avr-gcc calling convention; exact u32/bool semantics.\n${[text, ...helpers].join('\n\n')}\n`;
}
