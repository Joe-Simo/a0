/**
 * AArch64 instruction encoder: Darwin arm64 assembly text (the dialect written by src/arm64.ts,
 * by the A0 emitter compiler/emit_arm64.a0 and by the stage runtime of tools/bootstrap-arm64.ts)
 * to instruction words, without the system assembler. It is the reference for the encoder
 * written in A0 (compiler/asm_arm64.a0) and is checked against clang's assembler instruction by
 * instruction (tools/bootstrap-macho.ts).
 *
 * A module is one text section plus zero-fill (bss) symbols. Branches to labels of the module
 * are resolved here; a reference the assembler cannot resolve (a branch to a symbol the module
 * does not define, and every `@PAGE` / `@PAGEOFF` reference) is encoded with a zero immediate
 * and listed as a relocation, which is exactly what clang writes into its object file. The
 * linker (src/macho.ts) resolves the relocations.
 *
 * Accepted: labels (`name:`, numeric `1:` with `1f` / `1b` references), `.text`,
 * `.section __TEXT,__text,...`, `.globl`, `.p2align` (padding with nop),
 * `.subsections_via_symbols`, `.zerofill __DATA,__bss,sym,size,align`, comments (`//`, `;`),
 * and the instructions ldr str ldrb strb (unsigned offset, pre/post index, register offset),
 * ldp stp (x w q), movz movk movn mov, add sub adds subs cmp cmn (immediate, shifted and
 * extended register, `@PAGEOFF`), and orr eor ands (register, bitmask immediate), lsl lsr asr
 * (register, immediate), mul madd msub umaddl udiv sdiv, csel csinc csinv csneg cset csetm,
 * b bl b.<cond> cbz cbnz, adrp, ret br blr, movi (`v.2d, #0`), nop. Anything else is an error
 * naming the line.
 */

export type RelocKind = 'branch26' | 'page21' | 'pageoff12';

export interface Relocation {
  /** Byte offset of the instruction in the text section. */
  readonly offset: number;
  readonly kind: RelocKind;
  readonly symbol: string;
}

export interface BssSymbol {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export interface Arm64Module {
  /** The text section, one instruction word per element. */
  readonly words: readonly number[];
  /** Named text labels and their byte offsets. */
  readonly labels: ReadonlyMap<string, number>;
  /** Zero-fill symbols in declaration order, each aligned as declared. */
  readonly bss: readonly BssSymbol[];
  readonly bssSize: number;
  /** Largest bss alignment (log2). */
  readonly bssAlign: number;
  readonly relocations: readonly Relocation[];
  /** Line number (1-based) of every instruction word, for per-instruction reports. */
  readonly lines: readonly number[];
}

type Item =
  | { readonly k: 'R'; readonly cls: RegClass; readonly n: number }
  | { readonly k: 'I'; readonly v: bigint }
  | { readonly k: 'N'; readonly v: bigint }
  | { readonly k: '[' | ']' | '!' }
  | { readonly k: 'S'; readonly op: string }
  | { readonly k: 'C'; readonly c: number }
  | { readonly k: 'Y'; readonly name: string; mod: '' | 'PAGE' | 'PAGEOFF' }
  | { readonly k: 'L'; readonly n: number; readonly dir: 'f' | 'b' };

type RegClass = 'x' | 'w' | 'q' | 'v' | 'sp' | 'xzr' | 'wzr';

const CONDS: Readonly<Record<string, number>> = {
  eq: 0,
  ne: 1,
  hs: 2,
  cs: 2,
  lo: 3,
  cc: 3,
  mi: 4,
  pl: 5,
  vs: 6,
  vc: 7,
  hi: 8,
  ls: 9,
  ge: 10,
  lt: 11,
  gt: 12,
  le: 13,
  al: 14,
};
const SHIFTS = new Set(['lsl', 'lsr', 'asr', 'uxtw', 'uxtx', 'sxtw', 'sxtx']);
const NOP = 0xd503201f;

class AsmError extends Error {}

function fail(message: string): never {
  throw new AsmError(message);
}

function register(word: string): Item | undefined {
  if (word === 'sp') return { k: 'R', cls: 'sp', n: 31 };
  if (word === 'xzr') return { k: 'R', cls: 'xzr', n: 31 };
  if (word === 'wzr') return { k: 'R', cls: 'wzr', n: 31 };
  const m = /^([xwq])([0-9]{1,2})$/.exec(word);
  if (m !== null) {
    const n = Number(m[2]);
    if (n <= (m[1] === 'q' ? 31 : 30)) return { k: 'R', cls: m[1] as RegClass, n };
    return undefined;
  }
  const v = /^v([0-9]{1,2})\.2d$/.exec(word);
  if (v !== null && Number(v[1]) <= 31) return { k: 'R', cls: 'v', n: Number(v[1]) };
  return undefined;
}

function number(word: string): bigint | undefined {
  if (/^-?[0-9]+$/.test(word)) return BigInt(word);
  if (/^-?0x[0-9a-fA-F]+$/.test(word))
    return word.startsWith('-') ? -BigInt(word.slice(1)) : BigInt(word);
  return undefined;
}

/** The operand items of an operand string. */
function items(text: string): Item[] {
  const out: Item[] = [];
  const re = /\s*(?:([[\]!,@#])|([A-Za-z0-9_.$-]+))/y;
  let hash = false;
  let at = false;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  for (;;) {
    const start = re.lastIndex;
    if (/^\s*$/.test(text.slice(start))) break;
    m = re.exec(text);
    if (m === null) fail(`unexpected character in operands: ${text.slice(start)}`);
    const punct = m[1];
    const word = m[2];
    if (punct !== undefined) {
      if (punct === ',') continue;
      if (punct === '#') {
        hash = true;
        continue;
      }
      if (punct === '@') {
        at = true;
        continue;
      }
      out.push({ k: punct as '[' | ']' | '!' });
      continue;
    }
    const w = word as string;
    if (hash) {
      hash = false;
      const v = number(w);
      if (v === undefined) fail(`bad immediate #${w}`);
      out.push({ k: 'I', v });
      continue;
    }
    if (at) {
      at = false;
      const last = out[out.length - 1];
      if (last?.k !== 'Y' || (w !== 'PAGE' && w !== 'PAGEOFF')) fail(`bad @${w}`);
      last.mod = w;
      continue;
    }
    const reg = register(w);
    if (reg !== undefined) {
      out.push(reg);
      continue;
    }
    if (SHIFTS.has(w)) {
      out.push({ k: 'S', op: w });
      continue;
    }
    const c = CONDS[w];
    if (c !== undefined) {
      out.push({ k: 'C', c });
      continue;
    }
    const local = /^([0-9]+)([fb])$/.exec(w);
    if (local !== null) {
      out.push({ k: 'L', n: Number(local[1]), dir: local[2] as 'f' | 'b' });
      continue;
    }
    const v = number(w);
    if (v !== undefined) {
      out.push({ k: 'N', v });
      continue;
    }
    if (!/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(w)) fail(`bad operand ${w}`);
    out.push({ k: 'Y', name: w, mod: '' });
  }
  if (hash || at) fail('operand ends after # or @');
  return out;
}

const shape = (xs: readonly Item[]): string => xs.map((x) => x.k).join('');

type R = Extract<Item, { k: 'R' }>;

const isX = (r: R): boolean => r.cls === 'x' || r.cls === 'sp' || r.cls === 'xzr';
const isGp = (r: R): boolean => r.cls !== 'q' && r.cls !== 'v';
const sf = (r: R): number => (isX(r) ? 1 : 0);

function gp(r: Item | undefined, what: string): R {
  if (r?.k !== 'R' || !isGp(r)) fail(`${what}: expected a general register`);
  return r;
}

function sameWidth(...rs: R[]): void {
  const w = sf(rs[0] as R);
  for (const r of rs) if (sf(r) !== w) fail('mixed x and w registers');
}

function imm(item: Item | undefined): bigint {
  if (item?.k !== 'I') fail('expected an immediate');
  return item.v;
}

function inRange(v: bigint, lo: bigint, hi: bigint, what: string): number {
  if (v < lo || v > hi) fail(`${what} out of range: ${v}`);
  return Number(v);
}

/** The bitmask-immediate fields (N, immr, imms) of `value` for a `width`-bit register, if any. */
export function logicalImmediate(value: bigint, width: 32 | 64): number | undefined {
  const mask = (1n << BigInt(width)) - 1n;
  const v = value & mask;
  if (v === 0n || v === mask) return undefined;
  let size: number = width;
  for (;;) {
    const half = size / 2;
    if (half < 2) break;
    const hm = (1n << BigInt(half)) - 1n;
    if ((v & hm) !== ((v >> BigInt(half)) & hm)) break;
    size = half;
  }
  const sm = (1n << BigInt(size)) - 1n;
  const elt = v & sm;
  // Rotate right until the element is a run of ones starting at bit 0.
  for (let rot = 0; rot < size; rot += 1) {
    const r = ((elt >> BigInt(rot)) | (elt << BigInt(size - rot))) & sm;
    if (((r + 1n) & r) !== 0n) continue;
    const count = r.toString(2).length;
    const immr = (size - rot) % size;
    const imms = (~(size * 2 - 1) & 0x3f) | (count - 1);
    return ((size === 64 ? 1 : 0) << 12) | (immr << 6) | imms;
  }
  return undefined;
}

interface Target {
  readonly kind: 'label' | 'local';
  readonly name: string;
}

interface Encoded {
  readonly word: number;
  readonly branch?: { readonly target: Target; readonly form: 'b26' | 'b19' };
  readonly reloc?: { readonly kind: RelocKind; readonly symbol: string };
}

function branchTarget(item: Item | undefined): Target {
  if (item?.k === 'L') return { kind: 'local', name: `${item.n}${item.dir}` };
  if (item?.k === 'Y' && item.mod === '') return { kind: 'label', name: item.name };
  return fail('expected a branch target');
}

function memScale(rt: R, byte: boolean): number {
  if (byte) return 0;
  if (rt.cls === 'q') return 4;
  return isX(rt) ? 3 : 2;
}

function loadStore(mn: string, xs: Item[]): number {
  const load = mn.startsWith('ldr');
  const byte = mn.endsWith('b');
  const rt = xs[0];
  if (rt?.k !== 'R' || rt.cls === 'v' || rt.cls === 'sp') fail(`${mn}: bad register`);
  if (byte && (rt.cls === 'q' || isX(rt))) fail(`${mn}: needs a w register`);
  const scale = memScale(rt, byte);
  const v = rt.cls === 'q' ? 1 : 0;
  const size = rt.cls === 'q' ? 0 : scale;
  const opc = rt.cls === 'q' ? (load ? 3 : 2) : load ? 1 : 0;
  const base = (size << 30) | (v << 26) | (opc << 22);
  const rn = gp(xs[2], mn);
  if (!isX(rn) || rn.cls === 'xzr') fail(`${mn}: bad base register`);
  const s = shape(xs);
  if (s === 'R[R]' || s === 'R[RI]') {
    const off = s === 'R[R]' ? 0n : imm(xs[3]);
    const unit = 1n << BigInt(scale);
    if (off >= 0n && off % unit === 0n && off / unit <= 4095n)
      return (0x39000000 | base | (Number(off / unit) << 10) | (rn.n << 5) | rt.n) >>> 0;
    const u = inRange(off, -256n, 255n, `${mn} offset`);
    return (0x38000000 | base | ((u & 0x1ff) << 12) | (rn.n << 5) | rt.n) >>> 0;
  }
  if (s === 'R[R]I' || s === 'R[RI]!') {
    const off = inRange(imm(s === 'R[R]I' ? xs[4] : xs[3]), -256n, 255n, `${mn} offset`);
    const type = s === 'R[R]I' ? 1 : 3;
    return (0x38000000 | base | ((off & 0x1ff) << 12) | (type << 10) | (rn.n << 5) | rt.n) >>> 0;
  }
  if (s === 'R[RR]' || s === 'R[RRS]' || s === 'R[RRSI]') {
    const rm = gp(xs[3], mn);
    let option = 3;
    let sBit = 0;
    if (s !== 'R[RR]') {
      const ext = (xs[4] as Extract<Item, { k: 'S' }>).op;
      const opts: Record<string, number> = { uxtw: 2, lsl: 3, uxtx: 3, sxtw: 6, sxtx: 7 };
      const o = opts[ext];
      if (o === undefined) fail(`${mn}: bad extend ${ext}`);
      option = o;
      if (s === 'R[RRSI]') {
        const amount = imm(xs[5]);
        if (amount === BigInt(scale)) sBit = 1;
        else if (amount !== 0n) fail(`${mn}: bad shift amount`);
      } else if (ext === 'lsl') fail(`${mn}: lsl needs an amount`);
    }
    if ((option & 1) === 0 && isX(rm)) fail(`${mn}: w/uxtw index expected`);
    if ((option & 1) === 1 && !isX(rm)) fail(`${mn}: x index expected`);
    return (
      (0x38200800 | base | (rm.n << 16) | (option << 13) | (sBit << 12) | (rn.n << 5) | rt.n) >>> 0
    );
  }
  return fail(`${mn}: unsupported operands`);
}

function pair(mn: string, xs: Item[]): number {
  const load = mn === 'ldp';
  const r1 = xs[0];
  const r2 = xs[1];
  // The zero register is register 31 in Rt/Rt2 (stp wzr, wzr stores two zero words).
  const cls = (r: Item | undefined): RegClass | undefined =>
    r?.k !== 'R' ? undefined : r.cls === 'wzr' ? 'w' : r.cls === 'xzr' ? 'x' : r.cls;
  if (r1?.k !== 'R' || r2?.k !== 'R' || cls(r1) !== cls(r2)) fail(`${mn}: bad registers`);
  const c1 = cls(r1);
  if (c1 !== 'x' && c1 !== 'w' && c1 !== 'q') fail(`${mn}: bad registers`);
  const rn = gp(xs[3], mn);
  if (!isX(rn) || rn.cls === 'xzr') fail(`${mn}: bad base register`);
  const scale = c1 === 'q' ? 4 : c1 === 'x' ? 3 : 2;
  const opc = c1 === 'w' ? 0 : 2;
  const v = c1 === 'q' ? 1 : 0;
  const s = shape(xs);
  let mode: number;
  let off: bigint;
  if (s === 'RR[RI]!') [mode, off] = [3, imm(xs[4])];
  else if (s === 'RR[R]I') [mode, off] = [1, imm(xs[5])];
  else if (s === 'RR[RI]') [mode, off] = [2, imm(xs[4])];
  else if (s === 'RR[R]') [mode, off] = [2, 0n];
  else return fail(`${mn}: unsupported operands`);
  const unit = 1n << BigInt(scale);
  if (off % unit !== 0n) fail(`${mn}: misaligned offset`);
  const i7 = inRange(off / unit, -64n, 63n, `${mn} offset`);
  return (
    ((opc << 30) |
      (0b101 << 27) |
      (v << 26) |
      (mode << 23) |
      ((load ? 1 : 0) << 22) |
      ((i7 & 0x7f) << 15) |
      (r2.n << 10) |
      (rn.n << 5) |
      r1.n) >>>
    0
  );
}

function wide(opc: number, rd: R, value: number, hw: number): number {
  return ((sf(rd) << 31) | (opc << 29) | (0x25 << 23) | (hw << 21) | (value << 5) | rd.n) >>> 0;
}

function moveWide(mn: string, xs: Item[]): number {
  const rd = gp(xs[0], mn);
  const s = shape(xs);
  const v = inRange(imm(xs[1]), 0n, 0xffffn, `${mn} immediate`);
  let hw = 0;
  if (s === 'RISI') {
    const sh = xs[2] as Extract<Item, { k: 'S' }>;
    const amount = Number(imm(xs[3]));
    if (sh.op !== 'lsl' || amount % 16 !== 0 || amount / 16 > (isX(rd) ? 3 : 1))
      fail(`${mn}: bad shift`);
    hw = amount / 16;
  } else if (s !== 'RI') fail(`${mn}: unsupported operands`);
  return wide(mn === 'movn' ? 0 : mn === 'movz' ? 2 : 3, rd, v, hw);
}

function moveImmediate(rd: R, value: bigint): number {
  const width = isX(rd) ? 64 : 32;
  const mask = (1n << BigInt(width)) - 1n;
  const v = value & mask;
  for (let hw = 0; hw < width / 16; hw += 1)
    if ((v & ~(0xffffn << BigInt(hw * 16)) & mask) === 0n)
      return wide(2, rd, Number((v >> BigInt(hw * 16)) & 0xffffn), hw);
  const n = ~v & mask;
  for (let hw = 0; hw < width / 16; hw += 1)
    if ((n & ~(0xffffn << BigInt(hw * 16)) & mask) === 0n)
      return wide(0, rd, Number((n >> BigInt(hw * 16)) & 0xffffn), hw);
  const li = logicalImmediate(v, width);
  if (li === undefined) fail(`mov: immediate ${value} needs more than one instruction`);
  return ((sf(rd) << 31) | 0x320003e0 | (li << 10) | rd.n) >>> 0;
}

function mov(xs: Item[]): number {
  const s = shape(xs);
  const rd = gp(xs[0], 'mov');
  if (s === 'RI') return moveImmediate(rd, imm(xs[1]));
  if (s !== 'RR') fail('mov: unsupported operands');
  const rm = gp(xs[1], 'mov');
  sameWidth(rd, rm);
  if (rd.cls === 'sp' || rm.cls === 'sp') return (0x91000000 | (rm.n << 5) | rd.n) >>> 0;
  return ((sf(rd) << 31) | 0x2a0003e0 | (rm.n << 16) | rd.n) >>> 0;
}

function shiftCode(op: string): number {
  const c = ({ lsl: 0, lsr: 1, asr: 2 } as Record<string, number>)[op];
  if (c === undefined) fail(`bad shift ${op}`);
  return c;
}

/**
 * add sub adds subs; cmp / cmn are subs / adds with the zero register as destination; neg / negs
 * are sub / subs with the zero register as first source (shifted-register form only).
 */
function addSub(mn: string, xs0: Item[]): Encoded {
  let op = mn.startsWith('sub') || mn === 'cmp' || mn.startsWith('neg') ? 1 : 0;
  const flags =
    mn === 'adds' || mn === 'subs' || mn === 'cmp' || mn === 'cmn' || mn === 'negs' ? 1 : 0;
  const zr = (): Item => ({ k: 'R', cls: sf(gp(xs0[0], mn)) === 1 ? 'xzr' : 'wzr', n: 31 }) as Item;
  if ((mn === 'neg' || mn === 'negs') && xs0[1]?.k !== 'R') fail(`${mn}: needs a register`);
  const xs =
    mn === 'cmp' || mn === 'cmn'
      ? [zr(), ...xs0]
      : mn === 'neg' || mn === 'negs'
        ? [xs0[0] as Item, zr(), ...xs0.slice(1)]
        : xs0;
  const rd = gp(xs[0], mn);
  const rn = gp(xs[1], mn);
  sameWidth(rd, rn);
  const s = shape(xs);
  const top = (sf(rd) << 31) | (flags << 29);
  if (s === 'RRY') {
    const y = xs[2] as Extract<Item, { k: 'Y' }>;
    if (y.mod !== 'PAGEOFF' || op !== 0 || flags !== 0) fail(`${mn}: bad symbol operand`);
    return {
      word: (top | 0x11000000 | (rn.n << 5) | rd.n) >>> 0,
      reloc: { kind: 'pageoff12', symbol: y.name },
    };
  }
  if (s === 'RRI' || s === 'RRISI') {
    let v = imm(xs[2]);
    let sh = 0;
    if (s === 'RRISI') {
      const shift = xs[3] as Extract<Item, { k: 'S' }>;
      const amount = imm(xs[4]);
      if (shift.op !== 'lsl' || (amount !== 0n && amount !== 12n)) fail(`${mn}: bad shift`);
      sh = amount === 12n ? 1 : 0;
    }
    if (v < 0n) {
      v = -v;
      op ^= 1;
    }
    const i12 = inRange(v, 0n, 4095n, `${mn} immediate`);
    if (rd.cls === 'wzr' || rd.cls === 'xzr') {
      if (flags === 0) fail(`${mn}: zero register destination`);
    }
    return {
      word: (top | (op << 30) | 0x11000000 | (sh << 22) | (i12 << 10) | (rn.n << 5) | rd.n) >>> 0,
    };
  }
  if (s === 'RRR' || s === 'RRRSI') {
    const rm = gp(xs[2], mn);
    const extended = rn.cls === 'sp' || (rd.cls === 'sp' && flags === 0);
    if (extended) {
      if (s !== 'RRR') fail(`${mn}: shifted form with sp`);
      const option = isX(rm) ? 3 : 2;
      return {
        word:
          (top | (op << 30) | 0x0b200000 | (rm.n << 16) | (option << 13) | (rn.n << 5) | rd.n) >>>
          0,
      };
    }
    sameWidth(rd, rm);
    if (rm.cls === 'sp' || rd.cls === 'sp') fail(`${mn}: sp not allowed here`);
    let shift = 0;
    let amount = 0;
    if (s === 'RRRSI') {
      shift = shiftCode((xs[3] as Extract<Item, { k: 'S' }>).op);
      amount = inRange(imm(xs[4]), 0n, isX(rd) ? 63n : 31n, `${mn} shift`);
    }
    return {
      word:
        (top |
          (op << 30) |
          0x0b000000 |
          (shift << 22) |
          (rm.n << 16) |
          (amount << 10) |
          (rn.n << 5) |
          rd.n) >>>
        0,
    };
  }
  return fail(`${mn}: unsupported operands`);
}

function logical(mn: string, xs0: Item[]): number {
  const opc = ({ and: 0, orr: 1, eor: 2, ands: 3, tst: 3 } as Record<string, number>)[mn] as number;
  const xs =
    mn === 'tst'
      ? [{ k: 'R', cls: sf(gp(xs0[0], mn)) === 1 ? 'xzr' : 'wzr', n: 31 } as Item, ...xs0]
      : xs0;
  const rd = gp(xs[0], mn);
  const rn = gp(xs[1], mn);
  sameWidth(rd, rn);
  const s = shape(xs);
  if (s === 'RRI') {
    const li = logicalImmediate(imm(xs[2]), isX(rd) ? 64 : 32);
    if (li === undefined) fail(`${mn}: not a bitmask immediate`);
    return ((sf(rd) << 31) | (opc << 29) | 0x12000000 | (li << 10) | (rn.n << 5) | rd.n) >>> 0;
  }
  if (s === 'RRR' || s === 'RRRSI') {
    const rm = gp(xs[2], mn);
    sameWidth(rd, rm);
    let shift = 0;
    let amount = 0;
    if (s === 'RRRSI') {
      shift = shiftCode((xs[3] as Extract<Item, { k: 'S' }>).op);
      amount = inRange(imm(xs[4]), 0n, isX(rd) ? 63n : 31n, `${mn} shift`);
    }
    return (
      ((sf(rd) << 31) |
        (opc << 29) |
        0x0a000000 |
        (shift << 22) |
        (rm.n << 16) |
        (amount << 10) |
        (rn.n << 5) |
        rd.n) >>>
      0
    );
  }
  return fail(`${mn}: unsupported operands`);
}

function shift(mn: string, xs: Item[]): number {
  const rd = gp(xs[0], mn);
  const rn = gp(xs[1], mn);
  sameWidth(rd, rn);
  const s = shape(xs);
  if (s === 'RRR') {
    const rm = gp(xs[2], mn);
    sameWidth(rd, rm);
    const op2 = ({ lsl: 0, lsr: 1, asr: 2, ror: 3 } as Record<string, number>)[mn] as number;
    return ((sf(rd) << 31) | 0x1ac02000 | (rm.n << 16) | (op2 << 10) | (rn.n << 5) | rd.n) >>> 0;
  }
  if (s === 'RRI') {
    const width = isX(rd) ? 64 : 32;
    const a = inRange(imm(xs[2]), 0n, BigInt(width - 1), `${mn} amount`);
    // ror by an immediate is extr Rd, Rn, Rn, #a.
    if (mn === 'ror')
      return (
        ((isX(rd) ? (1 << 31) | (1 << 22) : 0) |
          0x13800000 |
          (rn.n << 16) |
          (a << 10) |
          (rn.n << 5) |
          rd.n) >>>
        0
      );
    const base = mn === 'asr' ? 0x13000000 : 0x53000000;
    const n = isX(rd) ? (1 << 31) | (1 << 22) : 0;
    const [immr, imms] = mn === 'lsl' ? [(width - a) % width, width - 1 - a] : [a, width - 1];
    return (base | n | (immr << 16) | (imms << 10) | (rn.n << 5) | rd.n) >>> 0;
  }
  return fail(`${mn}: unsupported operands`);
}

function multiply(mn: string, xs: Item[]): number {
  const s = shape(xs);
  const rd = gp(xs[0], mn);
  const rn = gp(xs[1], mn);
  const rm = gp(xs[2], mn);
  if (mn === 'umaddl' || mn === 'smaddl') {
    if (s !== 'RRRR') fail(`${mn}: unsupported operands`);
    const ra = gp(xs[3], mn);
    if (!isX(rd) || !isX(ra) || isX(rn) || isX(rm)) fail(`${mn}: needs x, w, w, x`);
    const u = mn === 'umaddl' ? 1 << 23 : 0;
    return (0x9b200000 | u | (rm.n << 16) | (ra.n << 10) | (rn.n << 5) | rd.n) >>> 0;
  }
  sameWidth(rd, rn, rm);
  if (mn === 'udiv' || mn === 'sdiv') {
    if (s !== 'RRR') fail(`${mn}: unsupported operands`);
    const o1 = mn === 'sdiv' ? 1 << 10 : 0;
    return ((sf(rd) << 31) | 0x1ac00800 | o1 | (rm.n << 16) | (rn.n << 5) | rd.n) >>> 0;
  }
  let ra = 31;
  if (mn === 'madd' || mn === 'msub') {
    if (s !== 'RRRR') fail(`${mn}: unsupported operands`);
    const r = gp(xs[3], mn);
    sameWidth(rd, r);
    ra = r.n;
  } else if (s !== 'RRR') fail(`${mn}: unsupported operands`);
  const o0 = mn === 'msub' ? 1 << 15 : 0;
  return ((sf(rd) << 31) | 0x1b000000 | o0 | (rm.n << 16) | (ra << 10) | (rn.n << 5) | rd.n) >>> 0;
}

function condSelect(mn: string, xs: Item[]): number {
  const table: Record<string, [number, number]> = {
    csel: [0, 0],
    csinc: [0, 1],
    csinv: [1, 0],
    csneg: [1, 1],
    cset: [0, 1],
    csetm: [1, 0],
  };
  const [op, o2] = table[mn] as [number, number];
  const s = shape(xs);
  const rd = gp(xs[0], mn);
  let rn: number;
  let rm: number;
  let cond: number;
  if (mn === 'cset' || mn === 'csetm') {
    if (s !== 'RC') fail(`${mn}: unsupported operands`);
    const c = (xs[1] as Extract<Item, { k: 'C' }>).c;
    if (c >= 14) fail(`${mn}: bad condition`);
    [rn, rm, cond] = [31, 31, c ^ 1];
  } else {
    if (s !== 'RRRC') fail(`${mn}: unsupported operands`);
    const a = gp(xs[1], mn);
    const b = gp(xs[2], mn);
    sameWidth(rd, a, b);
    [rn, rm, cond] = [a.n, b.n, (xs[3] as Extract<Item, { k: 'C' }>).c];
  }
  return (
    ((sf(rd) << 31) |
      (op << 30) |
      0x1a800000 |
      (rm << 16) |
      (cond << 12) |
      (o2 << 10) |
      (rn << 5) |
      rd.n) >>>
    0
  );
}

function encode(mn: string, xs: Item[]): Encoded {
  const s = shape(xs);
  switch (mn) {
    case 'ldr':
    case 'str':
    case 'ldrb':
    case 'strb':
      return { word: loadStore(mn, xs) };
    case 'ldp':
    case 'stp':
      return { word: pair(mn, xs) };
    case 'movz':
    case 'movk':
    case 'movn':
      return { word: moveWide(mn, xs) };
    case 'mov':
      return { word: mov(xs) };
    case 'add':
    case 'sub':
    case 'adds':
    case 'subs':
    case 'cmp':
    case 'cmn':
    case 'neg':
    case 'negs':
      return addSub(mn, xs);
    case 'and':
    case 'orr':
    case 'eor':
    case 'ands':
    case 'tst':
      return { word: logical(mn, xs) };
    case 'lsl':
    case 'lsr':
    case 'asr':
    case 'ror':
      return { word: shift(mn, xs) };
    case 'mul':
    case 'madd':
    case 'msub':
    case 'umaddl':
    case 'smaddl':
    case 'udiv':
    case 'sdiv':
      return { word: multiply(mn, xs) };
    case 'csel':
    case 'csinc':
    case 'csinv':
    case 'csneg':
    case 'cset':
    case 'csetm':
      return { word: condSelect(mn, xs) };
    case 'b':
    case 'bl':
      if (xs.length !== 1) fail(`${mn}: one target expected`);
      return {
        word: mn === 'b' ? 0x14000000 : 0x94000000,
        branch: { target: branchTarget(xs[0]), form: 'b26' },
      };
    case 'cbz':
    case 'cbnz': {
      if (xs.length !== 2) fail(`${mn}: register and target expected`);
      const rt = gp(xs[0], mn);
      const base = (sf(rt) << 31) | (mn === 'cbz' ? 0x34000000 : 0x35000000);
      return { word: (base | rt.n) >>> 0, branch: { target: branchTarget(xs[1]), form: 'b19' } };
    }
    case 'adrp': {
      const rd = gp(xs[0], mn);
      const y = xs[1];
      if (s !== 'RY' || y?.k !== 'Y' || y.mod !== 'PAGE' || !isX(rd)) fail('adrp: bad operands');
      return { word: (0x90000000 | rd.n) >>> 0, reloc: { kind: 'page21', symbol: y.name } };
    }
    case 'ret':
    case 'br':
    case 'blr': {
      const base = mn === 'ret' ? 0xd65f0000 : mn === 'br' ? 0xd61f0000 : 0xd63f0000;
      if (mn === 'ret' && s === '') return { word: (base | (30 << 5)) >>> 0 };
      if (s !== 'R') fail(`${mn}: bad operands`);
      const rn = gp(xs[0], mn);
      if (!isX(rn) || rn.cls === 'sp') fail(`${mn}: bad register`);
      return { word: (base | (rn.n << 5)) >>> 0 };
    }
    case 'movi': {
      const rd = xs[0];
      if (s !== 'RI' || rd?.k !== 'R' || rd.cls !== 'v' || imm(xs[1]) !== 0n)
        fail('movi: only v<n>.2d, #0');
      return { word: (0x6f00e400 | rd.n) >>> 0 };
    }
    case 'nop':
      if (s !== '') fail('nop: no operands');
      return { word: NOP };
    default: {
      if (mn.startsWith('b.')) {
        const c = CONDS[mn.slice(2)];
        if (c === undefined || xs.length !== 1) fail(`bad conditional branch ${mn}`);
        return { word: 0x54000000 | c, branch: { target: branchTarget(xs[0]), form: 'b19' } };
      }
      return fail(`unknown instruction ${mn}`);
    }
  }
}

interface Pending {
  readonly index: number;
  readonly target: Target;
  readonly form: 'b26' | 'b19';
  readonly line: number;
  /** For a local reference: its resolution (definition index among that label's). */
  readonly localDef?: number;
}

/** Encode assembly text into a module (see the file comment). Throws naming the line. */
export function assembleArm64Text(text: string): Arm64Module {
  const words: number[] = [];
  const lines: number[] = [];
  const labels = new Map<string, number>();
  const localDefs = new Map<number, number[]>();
  const bss: BssSymbol[] = [];
  let bssSize = 0;
  let bssAlign = 0;
  const relocations: Relocation[] = [];
  const pending: Pending[] = [];
  const src = text.split('\n');
  for (const [li, raw] of src.entries()) {
    const lineNo = li + 1;
    try {
      let line = raw;
      const c1 = line.indexOf('//');
      if (c1 >= 0) line = line.slice(0, c1);
      const c2 = line.indexOf(';');
      if (c2 >= 0) line = line.slice(0, c2);
      for (;;) {
        const m = /^\s*([A-Za-z0-9_.$]+):/.exec(line);
        if (m === null) break;
        const name = m[1] as string;
        const offset = words.length * 4;
        if (/^[0-9]+$/.test(name)) {
          const n = Number(name);
          const defs = localDefs.get(n) ?? [];
          defs.push(offset);
          localDefs.set(n, defs);
        } else {
          if (labels.has(name)) fail(`label ${name} defined twice`);
          labels.set(name, offset);
        }
        line = line.slice(m[0].length);
      }
      const body = line.trim();
      if (body === '') continue;
      const sp = body.search(/\s/);
      const mn = sp < 0 ? body : body.slice(0, sp);
      const rest = sp < 0 ? '' : body.slice(sp + 1);
      if (mn.startsWith('.')) {
        directive(mn, rest);
        continue;
      }
      const e = encode(mn, items(rest));
      const index = words.length;
      words.push(e.word);
      lines.push(lineNo);
      if (e.reloc !== undefined) relocations.push({ offset: index * 4, ...e.reloc });
      if (e.branch !== undefined) {
        const t = e.branch.target;
        if (t.kind === 'local') {
          const n = Number(t.name.slice(0, -1));
          const seen = localDefs.get(n)?.length ?? 0;
          pending.push({
            index,
            target: t,
            form: e.branch.form,
            line: lineNo,
            localDef: t.name.endsWith('b') ? seen - 1 : seen,
          });
        } else pending.push({ index, target: t, form: e.branch.form, line: lineNo });
      }
    } catch (err) {
      if (err instanceof AsmError)
        throw new Error(`arm64 encoder: line ${lineNo}: ${err.message}: ${raw.trim()}`);
      throw err;
    }
  }

  function directive(mn: string, rest: string): void {
    switch (mn) {
      case '.text':
      case '.subsections_via_symbols':
      case '.globl':
        return;
      case '.section':
        if (!rest.startsWith('__TEXT,__text')) fail(`section ${rest} is not supported`);
        return;
      case '.p2align': {
        const a = Number(rest.trim());
        if (!Number.isInteger(a) || a < 2 || a > 14) fail(`bad alignment ${rest}`);
        while ((words.length * 4) % 2 ** a !== 0) {
          words.push(NOP);
          lines.push(0);
        }
        return;
      }
      case '.zerofill': {
        const parts = rest.split(',').map((p) => p.trim());
        if (parts.length !== 5 || parts[0] !== '__DATA' || parts[1] !== '__bss')
          fail('zerofill: __DATA,__bss,sym,size,align expected');
        const size = Number(parts[3]);
        const align = Number(parts[4]);
        if (!Number.isInteger(size) || size < 0 || !Number.isInteger(align) || align > 14)
          fail('zerofill: bad size or alignment');
        const unit = 2 ** align;
        bssSize = Math.ceil(bssSize / unit) * unit;
        bss.push({ name: parts[2] as string, offset: bssSize, size });
        bssSize += size;
        bssAlign = Math.max(bssAlign, align);
        return;
      }
      default:
        fail(`unknown directive ${mn}`);
    }
  }

  for (const p of pending) {
    let target: number | undefined;
    if (p.target.kind === 'local') {
      const n = Number(p.target.name.slice(0, -1));
      target = localDefs.get(n)?.[p.localDef as number];
      if (target === undefined)
        throw new Error(`arm64 encoder: line ${p.line}: local label ${p.target.name} not found`);
    } else target = labels.get(p.target.name);
    const at = p.index * 4;
    if (target === undefined) {
      if (p.form !== 'b26')
        throw new Error(
          `arm64 encoder: line ${p.line}: conditional branch to undefined ${p.target.name}`,
        );
      relocations.push({ offset: at, kind: 'branch26', symbol: p.target.name });
      continue;
    }
    const delta = (target - at) / 4;
    const word = words[p.index] as number;
    words[p.index] =
      p.form === 'b26'
        ? (word | (delta & 0x3ffffff)) >>> 0
        : (word | ((delta & 0x7ffff) << 5)) >>> 0;
  }
  relocations.sort((a, b) => a.offset - b.offset);
  return { words, labels, bss, bssSize, bssAlign, relocations, lines };
}

/** The immediate field a relocation of `kind` fills (the rest of the word is fixed). */
export function relocationMask(kind: RelocKind): number {
  return kind === 'branch26' ? 0x03ffffff : kind === 'page21' ? 0x60ffffe0 : 0x003ffc00;
}
