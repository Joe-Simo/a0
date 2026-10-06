/**
 * x86-64 instruction encoder: AT&T assembly text in the dialect src/x86_64.ts writes (its
 * function bodies, its module head and tail, and the strict profile's trap runtime of
 * src/native-trap.ts, for Linux and macOS) to machine code, without a system assembler. It is
 * the reference for the encoder written in A0 (compiler/asm_x86_64.a0); test/asm-x86_64.test.ts
 * checks it against clang's assembler instruction by instruction (and, for Linux texts, a whole
 * module at a time).
 *
 * A module is one text section plus zero-fill (bss) symbols. Branches and RIP-relative
 * references to labels of the text section are resolved here; a reference to anything else (a
 * symbol the module does not define, or a bss symbol) is encoded with a zero field and listed as
 * a relocation whose value is `S - (P + 4)` for the 4-byte field at P. Branches to labels are
 * always the rel32 forms (what clang writes with `-mrelax-all`; no branch relaxation), and
 * `.p2align` pads code with LLVM's multi-byte nops (at most 10 bytes each).
 *
 * Accepted: labels (`name:`, numeric `1:` with `1f` / `1b` references), comments (`#` outside a
 * string), `.text`, `.bss`, `.section __TEXT,__text...`, `.section .note.GNU-stack...` (an
 * empty section: nothing may follow in it), `.globl`, `.type`, `.size` (no effect),
 * `.subsections_via_symbols`, `.p2align`, `.balign`, `.zero` (bss), `.zerofill
 * __DATA,__bss,sym,size,align`, `.asciz` (text), and the instructions listed in `MNEMONICS`
 * with the operand forms of `plan`. Operands are registers, `$` immediates (decimal or 0x hex),
 * memory `disp(base,index,scale)` with 64-bit registers (or `sym(%rip)` / `disp(%rip)`), and
 * branch targets; an operand holds no whitespace. Anything else is an error naming the line.
 */

export type X86RelocKind = 'branch32' | 'pcrel32';

export interface X86Relocation {
  /** Byte offset of the 4-byte field in the text section. */
  readonly offset: number;
  readonly kind: X86RelocKind;
  readonly symbol: string;
}

export interface X86BssSymbol {
  readonly name: string;
  readonly offset: number;
}

export interface X86Module {
  /** The text section. */
  readonly bytes: readonly number[];
  /** Named text labels and their byte offsets, in definition order. */
  readonly labels: ReadonlyMap<string, number>;
  /** Zero-fill symbols in definition order (a `.zerofill`, or a label in `.bss`). */
  readonly bss: readonly X86BssSymbol[];
  readonly bssSize: number;
  /** Largest bss alignment (log2). */
  readonly bssAlign: number;
  readonly relocations: readonly X86Relocation[];
  /** Line number (1-based) of every byte, for per-instruction reports. */
  readonly lines: readonly number[];
}

/** Encoding classes; the A0 encoder uses the same numbers. */
export const Cls = {
  Alu: 1,
  Test: 2,
  Mov: 3,
  Movabs: 4,
  Movzb: 5,
  Lea: 6,
  Imul: 7,
  Grp3: 8,
  Grp5: 9,
  Shift: 10,
  PushPop: 11,
  Fixed: 12,
  JmpCall: 13,
  Jcc: 14,
  Setcc: 15,
  Cmov: 16,
  SseRm: 17,
  Movups: 18,
  SseShift: 19,
  Pshufd: 20,
  Movd: 21,
} as const;
type ClsCode = (typeof Cls)[keyof typeof Cls];

/** A mnemonic: class, parameter (digit, opcode or condition), operand size, extra. */
export interface Mnemonic {
  readonly cls: ClsCode;
  readonly param: number;
  readonly size: number;
  readonly extra: number;
}

const CONDS = [
  'o',
  'no',
  'b',
  'ae',
  'e',
  'ne',
  'be',
  'a',
  's',
  'ns',
  'p',
  'np',
  'l',
  'ge',
  'le',
  'g',
];

function mnemonicTable(): [string, Mnemonic][] {
  const out: [string, Mnemonic][] = [];
  const add = (name: string, cls: ClsCode, param: number, size: number, extra = 0): void => {
    out.push([name, { cls, param, size, extra }]);
  };
  const sized = (sizes: string): [string, number][] =>
    [...sizes].map((s) => [s, s === 'b' ? 8 : s === 'l' ? 32 : 64]);
  for (const [name, d] of [
    ['add', 0],
    ['or', 1],
    ['and', 4],
    ['sub', 5],
    ['xor', 6],
    ['cmp', 7],
  ] as const)
    for (const [s, n] of sized('lq')) add(name + s, Cls.Alu, d, n);
  for (const [s, n] of sized('lqb')) add(`test${s}`, Cls.Test, 0, n);
  for (const [s, n] of sized('lqb')) add(`mov${s}`, Cls.Mov, 0, n);
  add('movabsq', Cls.Movabs, 0, 64);
  add('movzbl', Cls.Movzb, 0, 32);
  for (const [s, n] of sized('lq')) add(`lea${s}`, Cls.Lea, 0, n);
  for (const [s, n] of sized('lq')) add(`imul${s}`, Cls.Imul, 0, n);
  for (const [name, d] of [
    ['neg', 3],
    ['mul', 4],
    ['div', 6],
  ] as const)
    for (const [s, n] of sized('lq')) add(name + s, Cls.Grp3, d, n);
  for (const [name, d] of [
    ['inc', 0],
    ['dec', 1],
  ] as const)
    for (const [s, n] of sized('lq')) add(name + s, Cls.Grp5, d, n);
  for (const [name, d] of [
    ['rol', 0],
    ['ror', 1],
    ['shl', 4],
    ['shr', 5],
    ['sar', 7],
  ] as const)
    for (const [s, n] of sized('lq')) add(name + s, Cls.Shift, d, n);
  add('pushq', Cls.PushPop, 0x50, 64);
  add('popq', Cls.PushPop, 0x58, 64);
  add('ret', Cls.Fixed, 0xc3, 0);
  add('syscall', Cls.Fixed, 0x050f, 0);
  add('jmp', Cls.JmpCall, 0xe9, 0);
  add('call', Cls.JmpCall, 0xe8, 0);
  for (const [c, cc] of CONDS.entries()) add(`j${cc}`, Cls.Jcc, c, 0);
  for (const [c, cc] of CONDS.entries()) add(`set${cc}`, Cls.Setcc, c, 8);
  for (const [c, cc] of CONDS.entries())
    for (const [s, n] of sized('lq')) add(`cmov${cc}${s}`, Cls.Cmov, c, n);
  for (const [name, opc, p66] of [
    ['xorps', 0x57, 0],
    ['movdqa', 0x6f, 1],
    ['paddd', 0xfe, 1],
    ['psubd', 0xfa, 1],
    ['pand', 0xdb, 1],
    ['por', 0xeb, 1],
    ['pxor', 0xef, 1],
    ['pmuludq', 0xf4, 1],
    ['punpcklqdq', 0x6c, 1],
    ['punpckldq', 0x62, 1],
  ] as const)
    add(name, Cls.SseRm, opc, 0, p66);
  add('movups', Cls.Movups, 0, 0);
  // digit, the immediate form's opcode, and the register form's opcode (0: none) shifted by 8
  add('pslld', Cls.SseShift, 6, 0, 0x72 | (0xf2 << 8));
  add('psrld', Cls.SseShift, 2, 0, 0x72 | (0xd2 << 8));
  add('psrldq', Cls.SseShift, 3, 0, 0x73);
  add('pshufd', Cls.Pshufd, 0, 0);
  add('movd', Cls.Movd, 0, 0);
  return out;
}

/** Every mnemonic of the encoder in table order (the A0 encoder's table is the same). */
export const MNEMONICS: readonly (readonly [string, Mnemonic])[] = mnemonicTable();
const MNEMONIC = new Map(MNEMONICS);

class AsmError extends Error {}

function fail(message: string): never {
  throw new AsmError(message);
}

// --- operands ------------------------------------------------------------------------------

interface Reg {
  readonly k: 'reg';
  /** 8, 32, 64, or 128 (xmm). */
  readonly cls: number;
  readonly n: number;
}
interface Imm {
  readonly k: 'imm';
  readonly v: bigint;
}
interface Mem {
  readonly k: 'mem';
  /** 0-15, or 16 for rip. */
  readonly base: number;
  /** 0-15, or -1 for none. */
  readonly index: number;
  readonly scale: number;
  readonly disp: bigint;
  /** The symbol of `sym(%rip)`. */
  readonly sym: string | undefined;
}
type Target =
  | { readonly k: 'lab'; readonly name: string }
  | { readonly k: 'num'; readonly n: number; readonly dir: 'f' | 'b' };
type Operand = Reg | Imm | Mem | Target;

const LOW = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const BYTE = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil'];

/** A register name (without `%`); `rip` is a memory base only. */
export function x86Register(name: string): Reg | undefined {
  const low = LOW.indexOf(name.slice(1));
  if (name.length === 3 && low >= 0 && name[0] === 'r') return { k: 'reg', cls: 64, n: low };
  if (name.length === 3 && low >= 0 && name[0] === 'e') return { k: 'reg', cls: 32, n: low };
  const b = BYTE.indexOf(name);
  if (b >= 0) return { k: 'reg', cls: 8, n: b };
  const m = /^r([89]|1[0-5])([db]?)$/.exec(name);
  if (m !== null)
    return { k: 'reg', cls: m[2] === 'd' ? 32 : m[2] === 'b' ? 8 : 64, n: Number(m[1]) };
  const x = /^xmm([0-9]|1[0-5])$/.exec(name);
  if (x !== null) return { k: 'reg', cls: 128, n: Number(x[1]) };
  return undefined;
}

/** -?[0-9]+ or -?0x[0-9a-fA-F]+, at most 64 bits of magnitude. */
function number(word: string): bigint | undefined {
  let v: bigint;
  if (/^-?[0-9]+$/.test(word)) v = BigInt(word);
  else if (/^-?0x[0-9a-fA-F]+$/.test(word))
    v = word.startsWith('-') ? -BigInt(word.slice(1)) : BigInt(word);
  else return undefined;
  if ((v < 0n ? -v : v) >= 1n << 64n) return undefined;
  return v;
}

const LABEL = /^[A-Za-z0-9_.$]+$/;
/** A symbol an operand names: label bytes, not starting with a digit (`0x1f` is an address). */
const SYMBOL = /^[A-Za-z_.$][A-Za-z0-9_.$]*$/;

function memory(text: string): Mem {
  const open = text.indexOf('(');
  if (!text.endsWith(')')) fail(`bad memory operand ${text}`);
  const before = text.slice(0, open);
  const inside = text.slice(open + 1, -1).split(',');
  if (inside.length > 3) fail(`bad memory operand ${text}`);
  const reg = (s: string | undefined): Reg | 'rip' => {
    if (s === undefined || !s.startsWith('%')) fail(`bad memory operand ${text}`);
    if (s === '%rip') return 'rip';
    const r = x86Register(s.slice(1));
    if (r === undefined || r.cls !== 64) fail(`bad address register ${s}`);
    return r;
  };
  const base = reg(inside[0]);
  let index = -1;
  let scale = 1;
  if (inside.length >= 2) {
    const i = reg(inside[1]);
    if (i === 'rip' || base === 'rip' || i.n === 4) fail(`bad index register ${inside[1]}`);
    index = i.n;
  }
  if (inside.length === 3) {
    scale = Number(inside[2]);
    if (!['1', '2', '4', '8'].includes(inside[2] as string)) fail(`bad scale ${inside[2]}`);
  }
  let disp = 0n;
  let sym: string | undefined;
  if (before !== '') {
    const v = number(before);
    if (v !== undefined) {
      if (v < -(1n << 31n) || v >= 1n << 31n) fail(`displacement out of range: ${before}`);
      disp = v;
    } else if (base === 'rip' && SYMBOL.test(before)) sym = before;
    else fail(`bad displacement ${before}`);
  }
  return { k: 'mem', base: base === 'rip' ? 16 : base.n, index, scale, disp, sym };
}

function operand(text: string): Operand {
  if (text === '' || /\s/.test(text)) fail(`bad operand '${text}'`);
  if (text.startsWith('%')) {
    const r = x86Register(text.slice(1));
    if (r === undefined) fail(`unknown register ${text}`);
    return r;
  }
  if (text.startsWith('$')) {
    const v = number(text.slice(1));
    if (v === undefined) fail(`bad immediate ${text}`);
    return { k: 'imm', v };
  }
  if (text.includes('(')) return memory(text);
  const m = /^([0-9]+)([fb])$/.exec(text);
  if (m !== null) {
    if (Number(m[1]) >= 2 ** 32) fail(`numeric label too large: ${text}`);
    return { k: 'num', n: Number(m[1]), dir: m[2] as 'f' | 'b' };
  }
  if (SYMBOL.test(text)) return { k: 'lab', name: text };
  fail(`bad operand '${text}'`);
}

/** Operands split at the commas outside parentheses. */
function operands(text: string): Operand[] {
  if (text.trim() === '') return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  if (parts.length > 3) fail('too many operands');
  return parts.map((p) => operand(p.trim()));
}

// --- instruction plans ---------------------------------------------------------------------

/** Everything the byte emitter needs: prefix, REX, opcode, ModRM operands, immediate, branch. */
interface Plan {
  readonly p66: boolean;
  readonly w: boolean;
  readonly esc: boolean;
  readonly opc: number;
  /** ModRM reg field (0-15), or undefined for an opcode without ModRM. */
  readonly reg: number | undefined;
  /** ModRM r/m operand, or the register added to the opcode (+r forms). */
  readonly rm: Reg | Mem | undefined;
  readonly immSize: number;
  readonly imm: bigint;
  readonly target: Target | undefined;
  /** A REX prefix even when no bit is set (spl, bpl, sil, dil). */
  readonly force?: boolean;
}

const isReg = (o: Operand | undefined, cls: number): o is Reg => o?.k === 'reg' && o.cls === cls;
const isMem = (o: Operand | undefined): o is Mem => o?.k === 'mem';
const isRm = (o: Operand | undefined, cls: number): o is Reg | Mem => isReg(o, cls) || isMem(o);
const isTarget = (o: Operand | undefined): o is Target => o?.k === 'lab' || o?.k === 'num';

/** The immediate checked against the operand size: 8 bits, 32 (signed or not) or 64 sign-extended 32. */
function immediate(o: Imm, size: number): bigint {
  const v = o.v;
  const [lo, hi] =
    size === 8
      ? [-128n, 255n]
      : size === 32
        ? [-(1n << 31n), (1n << 32n) - 1n]
        : [-(1n << 31n), (1n << 31n) - 1n];
  if (v < lo || v > hi) fail(`immediate out of range: ${v}`);
  return v;
}

/** Does the immediate fit the sign-extended 8-bit form for an operation of `size` bits? */
function fits8(v: bigint, size: number): boolean {
  const s = BigInt.asIntN(size === 64 ? 64 : 32, v);
  return s >= -128n && s <= 127n;
}

const base = {
  p66: false,
  w: false,
  esc: false,
  reg: undefined,
  rm: undefined,
  immSize: 0,
  imm: 0n,
  target: undefined,
};

function plan(m: Mnemonic, xs: readonly Operand[]): Plan {
  const force = xs.some((o) => o.k === 'reg' && o.cls === 8 && o.n >= 4 && o.n < 8);
  return { ...planOf(m, xs), force };
}

function planOf(m: Mnemonic, xs: readonly Operand[]): Plan {
  const [a, b, c] = xs;
  const n = xs.length;
  const size = m.size;
  const w = size === 64;
  const bad = (): never => fail('bad operands');
  switch (m.cls) {
    case Cls.Alu:
      if (n !== 2) return bad();
      if (a?.k === 'imm' && isRm(b, size)) {
        const v = immediate(a, size);
        if (fits8(v, size))
          return { ...base, w, opc: 0x83, reg: m.param, rm: b, immSize: 1, imm: v };
        if (b.k === 'reg' && b.n === 0)
          return { ...base, w, opc: m.param * 8 + 5, immSize: 4, imm: v };
        return { ...base, w, opc: 0x81, reg: m.param, rm: b, immSize: 4, imm: v };
      }
      if (isReg(a, size) && isRm(b, size))
        return { ...base, w, opc: m.param * 8 + 1, reg: a.n, rm: b };
      if (isMem(a) && isReg(b, size)) return { ...base, w, opc: m.param * 8 + 3, reg: b.n, rm: a };
      return bad();
    case Cls.Test:
      if (n !== 2) return bad();
      if (a?.k === 'imm' && isRm(b, size)) {
        const v = immediate(a, size);
        const k = size === 8 ? 1 : 4;
        if (b.k === 'reg' && b.n === 0)
          return { ...base, w, opc: size === 8 ? 0xa8 : 0xa9, immSize: k, imm: v };
        return { ...base, w, opc: size === 8 ? 0xf6 : 0xf7, reg: 0, rm: b, immSize: k, imm: v };
      }
      if (isReg(a, size) && isRm(b, size))
        return { ...base, w, opc: size === 8 ? 0x84 : 0x85, reg: a.n, rm: b };
      return bad();
    case Cls.Mov:
      if (n !== 2) return bad();
      if (size === 64 && isReg(a, 64) && isReg(b, 128))
        return { ...base, p66: true, w, esc: true, opc: 0x6e, reg: b.n, rm: a };
      if (size === 64 && isReg(a, 128) && isReg(b, 64))
        return { ...base, p66: true, w, esc: true, opc: 0x7e, reg: a.n, rm: b };
      if (a?.k === 'imm' && isRm(b, size)) {
        const v = immediate(a, size);
        const k = size === 8 ? 1 : 4;
        if (b.k === 'reg' && size !== 64)
          return {
            ...base,
            opc: (size === 8 ? 0xb0 : 0xb8) + (b.n & 7),
            rm: b,
            immSize: k,
            imm: v,
          };
        return { ...base, w, opc: size === 8 ? 0xc6 : 0xc7, reg: 0, rm: b, immSize: k, imm: v };
      }
      if (isReg(a, size) && isRm(b, size))
        return { ...base, w, opc: size === 8 ? 0x88 : 0x89, reg: a.n, rm: b };
      if (isMem(a) && isReg(b, size))
        return { ...base, w, opc: size === 8 ? 0x8a : 0x8b, reg: b.n, rm: a };
      return bad();
    case Cls.Movabs:
      if (n !== 2 || a?.k !== 'imm' || !isReg(b, 64)) return bad();
      if (a.v < -(1n << 63n) || a.v >= 1n << 64n) fail(`immediate out of range: ${a.v}`);
      return { ...base, w, opc: 0xb8 + (b.n & 7), rm: b, immSize: 8, imm: a.v };
    case Cls.Movzb:
      if (n !== 2 || !isRm(a, 8) || !isReg(b, 32)) return bad();
      return { ...base, esc: true, opc: 0xb6, reg: b.n, rm: a };
    case Cls.Lea:
      if (n !== 2 || !isMem(a) || !isReg(b, size)) return bad();
      return { ...base, w, opc: 0x8d, reg: b.n, rm: a };
    case Cls.Imul:
      if (n === 2 && isRm(a, size) && isReg(b, size))
        return { ...base, w, esc: true, opc: 0xaf, reg: b.n, rm: a };
      if (n === 3 && a?.k === 'imm' && isRm(b, size) && isReg(c, size)) {
        const v = immediate(a, size);
        const short = fits8(v, size);
        return {
          ...base,
          w,
          opc: short ? 0x6b : 0x69,
          reg: c.n,
          rm: b,
          immSize: short ? 1 : 4,
          imm: v,
        };
      }
      return bad();
    case Cls.Grp3:
    case Cls.Grp5:
      if (n !== 1 || !isRm(a, size)) return bad();
      return { ...base, w, opc: m.cls === Cls.Grp3 ? 0xf7 : 0xff, reg: m.param, rm: a };
    case Cls.Shift:
      if (n !== 2 || !isRm(b, size)) return bad();
      if (a?.k === 'imm') {
        const v = immediate(a, 8);
        if (v === 1n) return { ...base, w, opc: 0xd1, reg: m.param, rm: b };
        return { ...base, w, opc: 0xc1, reg: m.param, rm: b, immSize: 1, imm: v };
      }
      if (isReg(a, 8) && a.n === 1) return { ...base, w, opc: 0xd3, reg: m.param, rm: b };
      return bad();
    case Cls.PushPop:
      if (n !== 1 || !isReg(a, 64)) return bad();
      return { ...base, opc: m.param + (a.n & 7), rm: a };
    case Cls.Fixed:
      if (n !== 0) return bad();
      return m.param > 0xff ? { ...base, esc: true, opc: m.param >> 8 } : { ...base, opc: m.param };
    case Cls.JmpCall:
      if (n !== 1 || !isTarget(a)) return bad();
      return { ...base, opc: m.param, target: a };
    case Cls.Jcc:
      if (n !== 1 || !isTarget(a)) return bad();
      return { ...base, esc: true, opc: 0x80 + m.param, target: a };
    case Cls.Setcc:
      if (n !== 1 || !isRm(a, 8)) return bad();
      return { ...base, esc: true, opc: 0x90 + m.param, reg: 0, rm: a };
    case Cls.Cmov:
      if (n !== 2 || !isRm(a, size) || !isReg(b, size)) return bad();
      return { ...base, w, esc: true, opc: 0x40 + m.param, reg: b.n, rm: a };
    case Cls.SseRm:
      if (n !== 2 || !isRm(a, 128) || !isReg(b, 128)) return bad();
      return { ...base, p66: m.extra === 1, esc: true, opc: m.param, reg: b.n, rm: a };
    case Cls.Movups:
      if (n === 2 && isRm(a, 128) && isReg(b, 128))
        return { ...base, esc: true, opc: 0x10, reg: b.n, rm: a };
      if (n === 2 && isReg(a, 128) && isMem(b))
        return { ...base, esc: true, opc: 0x11, reg: a.n, rm: b };
      return bad();
    case Cls.SseShift:
      if (n !== 2 || !isReg(b, 128)) return bad();
      if (a?.k === 'imm') {
        const v = immediate(a, 8);
        return {
          ...base,
          p66: true,
          esc: true,
          opc: m.extra & 0xff,
          reg: m.param,
          rm: b,
          immSize: 1,
          imm: v,
        };
      }
      if (m.extra >> 8 !== 0 && isRm(a, 128))
        return { ...base, p66: true, esc: true, opc: m.extra >> 8, reg: b.n, rm: a };
      return bad();
    case Cls.Pshufd:
      if (n !== 3 || a?.k !== 'imm' || !isRm(b, 128) || !isReg(c, 128)) return bad();
      return {
        ...base,
        p66: true,
        esc: true,
        opc: 0x70,
        reg: c.n,
        rm: b,
        immSize: 1,
        imm: immediate(a, 8),
      };
    case Cls.Movd:
      if (n === 2 && isRm(a, 32) && isReg(b, 128))
        return { ...base, p66: true, esc: true, opc: 0x6e, reg: b.n, rm: a };
      if (n === 2 && isReg(a, 128) && isRm(b, 32))
        return { ...base, p66: true, esc: true, opc: 0x7e, reg: a.n, rm: b };
      return bad();
  }
}

/** A field to fill once labels are known: a rel32 branch, or a RIP-relative displacement. */
interface Fixup {
  /** Byte offset of the field within the instruction. */
  readonly at: number;
  readonly kind: X86RelocKind;
  readonly target: Target;
}

/** The bytes of a planned instruction. */
function emit(p: Plan): { bytes: number[]; fixup: Fixup | undefined } {
  const out: number[] = [];
  let fixup: Fixup | undefined;
  const rm = p.rm;
  const force = p.force === true;
  const r = p.reg === undefined ? 0 : p.reg >> 3;
  let x = 0;
  let bb = 0;
  if (rm?.k === 'reg') bb = rm.n >> 3;
  else if (rm?.k === 'mem') {
    if (rm.index >= 0) x = rm.index >> 3;
    if (rm.base < 16) bb = rm.base >> 3;
  }
  if (p.p66) out.push(0x66);
  const rex = 0x40 | (p.w ? 8 : 0) | (r << 2) | (x << 1) | bb;
  if (rex !== 0x40 || force) out.push(rex);
  if (p.esc) out.push(0x0f);
  out.push(p.opc);
  if (p.reg !== undefined && rm !== undefined) {
    const reg = (p.reg & 7) << 3;
    if (rm.k === 'reg') out.push(0xc0 | reg | (rm.n & 7));
    else if (rm.base === 16) {
      if (rm.sym !== undefined && p.immSize > 0)
        fail('a RIP-relative symbol with an immediate is not supported');
      out.push(reg | 5);
      if (rm.sym !== undefined)
        fixup = { at: out.length, kind: 'pcrel32', target: { k: 'lab', name: rm.sym } };
      out.push(...le(rm.disp, 4));
    } else {
      const sib = rm.index >= 0 || (rm.base & 7) === 4;
      const mod =
        rm.disp === 0n && (rm.base & 7) !== 5 ? 0 : rm.disp >= -128n && rm.disp <= 127n ? 1 : 2;
      if (sib) {
        const ss = [1, 2, 4, 8].indexOf(rm.scale);
        out.push(
          (mod << 6) | reg | 4,
          (ss << 6) | (((rm.index >= 0 ? rm.index : 4) & 7) << 3) | (rm.base & 7),
        );
      } else out.push((mod << 6) | reg | (rm.base & 7));
      if (mod === 1) out.push(...le(rm.disp, 1));
      if (mod === 2) out.push(...le(rm.disp, 4));
    }
  }
  if (p.immSize > 0) out.push(...le(p.imm, p.immSize));
  if (p.target !== undefined) {
    fixup = { at: out.length, kind: 'branch32', target: p.target };
    out.push(0, 0, 0, 0);
  }
  return { bytes: out, fixup };
}

/** `v` as `n` little-endian bytes (two's complement). */
function le(v: bigint, n: number): number[] {
  const u = BigInt.asUintN(8 * n, v);
  return Array.from({ length: n }, (_, i) => Number((u >> BigInt(8 * i)) & 0xffn));
}

/** LLVM's x86 nops of 1 to 10 bytes. */
const NOPS: readonly (readonly number[])[] = [
  [0x90],
  [0x66, 0x90],
  [0x0f, 0x1f, 0x00],
  [0x0f, 0x1f, 0x40, 0x00],
  [0x0f, 0x1f, 0x44, 0x00, 0x00],
  [0x66, 0x0f, 0x1f, 0x44, 0x00, 0x00],
  [0x0f, 0x1f, 0x80, 0x00, 0x00, 0x00, 0x00],
  [0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x66, 0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x66, 0x2e, 0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00],
];

/** Nop padding of `count` bytes: as many 10-byte nops as fit, then one for the rest. */
export function x86Nops(count: number): number[] {
  const out: number[] = [];
  for (let left = count; left > 0; left -= Math.min(left, 10))
    out.push(...(NOPS[Math.min(left, 10) - 1] as number[]));
  return out;
}

/** Encode one instruction (`mnemonic operands`), branches and RIP symbols left zero. */
export function encodeX86(mnemonic: string, text: string): number[] {
  const m = MNEMONIC.get(mnemonic);
  if (m === undefined) fail(`unknown mnemonic ${mnemonic}`);
  return emit(plan(m, operands(text))).bytes;
}

// --- module --------------------------------------------------------------------------------

/** The text before the first `#` outside a string. */
function uncomment(line: string): string {
  let str = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (str && c === '\\') i += 1;
    else if (c === '"') str = !str;
    else if (!str && c === '#') return line.slice(0, i);
  }
  return line;
}

/** The bytes of an .asciz string literal (escapes \\ \" \n \t), then a zero byte. */
function asciz(text: string): number[] {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) fail('bad string');
  const out: number[] = [];
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 0x5c) {
      const e = body[++i];
      const v = e === '\\' ? 0x5c : e === '"' ? 0x22 : e === 'n' ? 10 : e === 't' ? 9 : undefined;
      if (v === undefined) fail('bad escape in string');
      out.push(v);
    } else if (c === 0x22 || c < 32 || c > 126) fail('bad character in string');
    else out.push(c);
  }
  out.push(0);
  return out;
}

function alignNumber(word: string, max: number): number {
  const v = number(word);
  if (v === undefined || v < 0n || v > BigInt(max)) fail(`bad number ${word}`);
  return Number(v);
}

export function assembleX86_64Text(text: string): X86Module {
  const bytes: number[] = [];
  const lines: number[] = [];
  const labels = new Map<string, number>();
  const bssNames = new Set<string>();
  const bss: X86BssSymbol[] = [];
  let bssSize = 0;
  let bssAlign = 0;
  const numeric = new Map<number, number[]>();
  const pending: { at: number; kind: X86RelocKind; target: Target; def: number; line: number }[] =
    [];
  let section: 'text' | 'bss' | 'note' = 'text';
  const relocations: X86Relocation[] = [];
  const src = text.split('\n');
  for (const [i, raw] of src.entries()) {
    const lineNo = i + 1;
    try {
      let rest = uncomment(raw);
      for (;;) {
        const m = /^\s*([A-Za-z0-9_.$]+):/.exec(rest);
        if (m === null) break;
        const name = m[1] as string;
        rest = rest.slice(m[0].length);
        if (section === 'note') fail('a label in an empty section');
        if (/^[0-9]+$/.test(name)) {
          if (section !== 'text') fail('a numeric label outside the text section');
          const n = Number(name);
          if (n >= 2 ** 32) fail('numeric label too large');
          numeric.set(n, [...(numeric.get(n) ?? []), bytes.length]);
          continue;
        }
        if (labels.has(name) || bssNames.has(name)) fail(`label ${name} defined twice`);
        if (section === 'text') labels.set(name, bytes.length);
        else {
          bssNames.add(name);
          bss.push({ name, offset: bssSize });
        }
      }
      const body = rest.trim();
      if (body === '') continue;
      const sp = body.search(/\s/);
      const word = sp < 0 ? body : body.slice(0, sp);
      const args = sp < 0 ? '' : body.slice(sp).trim();
      const push = (bs: readonly number[]): void => {
        for (const b of bs) {
          bytes.push(b);
          lines.push(lineNo);
        }
      };
      if (word.startsWith('.')) {
        const none = (): void => {
          if (args !== '') fail(`${word} takes no operands`);
        };
        if (section === 'note' && word !== '.text' && word !== '.bss' && word !== '.section')
          fail('nothing may follow in an empty section');
        const align = (log: number): void => {
          if (section === 'text') push(x86Nops((-bytes.length >>> 0) & ((1 << log) - 1)));
          else {
            bssSize = Math.ceil(bssSize / 2 ** log) * 2 ** log;
            bssAlign = Math.max(bssAlign, log);
          }
        };
        switch (word) {
          case '.text':
            none();
            section = 'text';
            break;
          case '.bss':
            none();
            section = 'bss';
            break;
          case '.section':
            if (args.startsWith('__TEXT,__text')) section = 'text';
            else if (args.startsWith('.note.GNU-stack')) section = 'note';
            else fail(`unsupported section ${args}`);
            break;
          case '.globl':
            if (!LABEL.test(args)) fail('bad .globl');
            break;
          case '.type':
          case '.size':
            if (args === '') fail(`${word} needs operands`);
            break;
          case '.subsections_via_symbols':
            none();
            break;
          case '.p2align':
            align(alignNumber(args, 14));
            break;
          case '.balign': {
            const v = alignNumber(args, 16384);
            if (v === 0 || (v & (v - 1)) !== 0) fail('.balign needs a power of two');
            align(Math.log2(v));
            break;
          }
          case '.zero':
            if (section !== 'bss') fail('.zero outside .bss');
            bssSize += alignNumber(args, 2 ** 32 - 1);
            if (bssSize >= 2 ** 32) fail('bss too large');
            break;
          case '.zerofill': {
            const parts = args.split(',').map((s) => s.trim());
            if (parts.length !== 5 || parts[0] !== '__DATA' || parts[1] !== '__bss')
              fail('bad .zerofill');
            const name = parts[2] as string;
            if (!LABEL.test(name) || /^[0-9]+$/.test(name)) fail('bad .zerofill symbol');
            const size = alignNumber(parts[3] as string, 2 ** 32 - 1);
            const log = alignNumber(parts[4] as string, 14);
            if (labels.has(name) || bssNames.has(name)) fail(`label ${name} defined twice`);
            bssSize = Math.ceil(bssSize / 2 ** log) * 2 ** log;
            bssAlign = Math.max(bssAlign, log);
            bssNames.add(name);
            bss.push({ name, offset: bssSize });
            bssSize += size;
            if (bssSize >= 2 ** 32) fail('bss too large');
            break;
          }
          case '.asciz':
            if (section !== 'text') fail('.asciz outside .text');
            push(asciz(args));
            break;
          default:
            fail(`unknown directive ${word}`);
        }
        continue;
      }
      if (section !== 'text') fail('an instruction outside the text section');
      const m = MNEMONIC.get(word);
      if (m === undefined) fail(`unknown mnemonic ${word}`);
      const { bytes: code, fixup } = emit(plan(m, operands(args)));
      if (fixup !== undefined) {
        const t = fixup.target;
        const def = t.k === 'num' ? (numeric.get(t.n)?.length ?? 0) - (t.dir === 'b' ? 1 : 0) : 0;
        if (t.k === 'num' && def < 0) fail(`no label ${t.n} before`);
        pending.push({
          at: bytes.length + fixup.at,
          kind: fixup.kind,
          target: t,
          def,
          line: lineNo,
        });
      }
      push(code);
    } catch (e) {
      if (e instanceof AsmError) throw new Error(`x86_64 encoder: line ${lineNo}: ${e.message}`);
      throw e;
    }
  }
  for (const p of pending) {
    const t = p.target;
    const at = t.k === 'num' ? numeric.get(t.n)?.[p.def] : labels.get(t.name);
    if (at === undefined) {
      if (t.k === 'num') throw new Error(`x86_64 encoder: line ${p.line}: no label ${t.n} after`);
      relocations.push({ offset: p.at, kind: p.kind, symbol: t.name });
      continue;
    }
    const v = le(BigInt(at - (p.at + 4)), 4);
    for (let k = 0; k < 4; k++) bytes[p.at + k] = v[k] as number;
  }
  return { bytes, labels, bss, bssSize, bssAlign, relocations, lines };
}
