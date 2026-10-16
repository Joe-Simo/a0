// Independent RV64IM instruction model. It consumes linked ELF machine bytes, never A0 IR.
// Purpose: executable machine-model evidence, not a hardware/QEMU claim.
import assert from 'node:assert/strict';

const U = (x) => BigInt.asUintN(64, x),
  S = (x) => BigInt.asIntN(64, x),
  W = (x) => U(BigInt.asIntN(32, x));
const sx = (x, n) => BigInt.asIntN(n, BigInt(x));
export class RV64 {
  constructor(elf) {
    this.mem = Buffer.alloc(64 << 20);
    this.r = Array(32).fill(0n);
    this.symbols = new Map();
    this.instructions = 0;
    assert.equal(elf.toString('hex', 0, 4), '7f454c46');
    assert.equal(elf[4], 2);
    assert.equal(elf.readUInt16LE(18), 243);
    const ph = Number(elf.readBigUInt64LE(32)),
      pn = elf.readUInt16LE(56),
      ps = elf.readUInt16LE(54);
    for (let i = 0; i < pn; i++) {
      const p = ph + i * ps;
      if (elf.readUInt32LE(p) !== 1) continue;
      const off = Number(elf.readBigUInt64LE(p + 8)),
        v = Number(elf.readBigUInt64LE(p + 16)),
        size = Number(elf.readBigUInt64LE(p + 32));
      elf.copy(this.mem, v, off, off + size);
    }
    const sh = Number(elf.readBigUInt64LE(40)),
      sn = elf.readUInt16LE(60),
      ss = elf.readUInt16LE(58);
    for (let i = 0; i < sn; i++) {
      const h = sh + i * ss;
      if (elf.readUInt32LE(h + 4) !== 2) continue;
      const off = Number(elf.readBigUInt64LE(h + 24)),
        len = Number(elf.readBigUInt64LE(h + 32)),
        link = elf.readUInt32LE(h + 40),
        ent = Number(elf.readBigUInt64LE(h + 56));
      const st = sh + link * ss,
        so = Number(elf.readBigUInt64LE(st + 24));
      for (let a = off; a < off + len; a += ent) {
        const no = elf.readUInt32LE(a),
          end = elf.indexOf(0, so + no),
          name = elf.toString('utf8', so + no, end),
          addr = Number(elf.readBigUInt64LE(a + 8));
        if (name && addr) this.symbols.set(name, addr);
      }
    }
  }
  load(a, n, signed = false) {
    a = Number(a);
    assert.ok(a >= 0 && a + n <= this.mem.length, `load ${a}/${n}`);
    assert.equal(a % n, 0, `misaligned load ${a}/${n}`);
    if (n === 8) return this.mem.readBigUInt64LE(a);
    const x = n === 4 ? this.mem.readUInt32LE(a) : n === 2 ? this.mem.readUInt16LE(a) : this.mem[a];
    return signed ? U(sx(x, n * 8)) : BigInt(x);
  }
  store(a, n, v) {
    a = Number(a);
    assert.ok(a >= 0 && a + n <= this.mem.length, `store ${a}/${n}`);
    assert.equal(a % n, 0, `misaligned store ${a}/${n}`);
    v = BigInt.asUintN(n * 8, v);
    if (n === 8) this.mem.writeBigUInt64LE(v, a);
    else if (n === 4) this.mem.writeUInt32LE(Number(v), a);
    else if (n === 2) this.mem.writeUInt16LE(Number(v), a);
    else this.mem[a] = Number(v);
  }
  call(name, args, { sret, stack = 0x3f00000, maxInstructions = 10000000 } = {}) {
    this.r.fill(0n);
    this.r[2] = BigInt(stack);
    this.r[1] = 0xfff0n;
    const saved = [8, 9, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27].map((i) => [
      i,
      0x1234567800000000n + BigInt(i),
    ]);
    for (const [i, v] of saved) this.r[i] = v;
    const actual = sret === undefined ? args : [BigInt(sret), ...args];
    actual.forEach((x, i) => {
      const v = typeof x === 'bigint' ? U(x) : W(BigInt(Number(x)));
      if (i < 8) this.r[10 + i] = v;
      else this.store(stack + (i - 8) * 8, 8, v);
    });
    this.pc = this.symbols.get(name);
    assert.ok(this.pc, `symbol ${name}`);
    let count = 0;
    while (this.pc !== 0xfff0) {
      assert.ok(count++ < maxInstructions, `fuel ${name} @${this.pc}`);
      this.step();
    }
    this.instructions += count;
    assert.equal(this.r[2], BigInt(stack), 'stack restored');
    for (const [i, v] of saved) assert.equal(this.r[i], v, `callee saved x${i}`);
    if (sret === undefined) assert.equal(this.r[10], W(this.r[10]), 'LP64 canonical u32 return');
    return Number(this.r[10] & 0xffffffffn);
  }
  step() {
    const p = this.pc,
      w = this.mem.readUInt32LE(p),
      op = w & 127,
      rd = (w >>> 7) & 31,
      f3 = (w >>> 12) & 7,
      rs1 = (w >>> 15) & 31,
      rs2 = (w >>> 20) & 31,
      f7 = w >>> 25,
      a = this.r[rs1],
      b = this.r[rs2];
    let next = p + 4,
      v,
      write = true;
    const imm = sx(w >>> 20, 12);
    switch (op) {
      case 0x37:
        v = sx(w & 0xfffff000, 32);
        break;
      case 0x17:
        v = BigInt(p) + sx(w & 0xfffff000, 32);
        break;
      case 0x6f: {
        const n =
          ((w >>> 31) << 20) |
          (((w >>> 12) & 255) << 12) |
          (((w >>> 20) & 1) << 11) |
          (((w >>> 21) & 1023) << 1);
        v = BigInt(p + 4);
        next = p + Number(sx(n, 21));
        break;
      }
      case 0x67:
        if (rd === 1) assert.equal(this.r[2] % 16n, 0n, 'call stack alignment');
        v = BigInt(p + 4);
        next = Number((a + imm) & ~1n);
        break;
      case 0x63: {
        const n =
          ((w >>> 31) << 12) |
          (((w >>> 7) & 1) << 11) |
          (((w >>> 25) & 63) << 5) |
          (((w >>> 8) & 15) << 1);
        const take =
          f3 === 0
            ? a === b
            : f3 === 1
              ? a !== b
              : f3 === 4
                ? S(a) < S(b)
                : f3 === 5
                  ? S(a) >= S(b)
                  : f3 === 6
                    ? a < b
                    : f3 === 7
                      ? a >= b
                      : undefined;
        assert.notEqual(take, undefined);
        if (take) next = p + Number(sx(n, 13));
        write = false;
        break;
      }
      case 0x03: {
        const widths = { 0: 1, 1: 2, 2: 4, 3: 8, 4: 1, 5: 2, 6: 4 };
        assert.ok(widths[f3]);
        v = this.load(a + imm, widths[f3], f3 < 3);
        break;
      }
      case 0x23: {
        const n = ((w >>> 25) << 5) | ((w >>> 7) & 31);
        assert.ok(f3 <= 3);
        this.store(a + sx(n, 12), 1 << f3, b);
        write = false;
        break;
      }
      case 0x13:
        switch (f3) {
          case 0:
            v = a + imm;
            break;
          case 2:
            v = BigInt(S(a) < imm);
            break;
          case 3:
            v = BigInt(a < U(imm));
            break;
          case 4:
            v = a ^ U(imm);
            break;
          case 6:
            v = a | U(imm);
            break;
          case 7:
            v = a & U(imm);
            break;
          case 1:
            v = a << BigInt((w >>> 20) & 63);
            break;
          case 5:
            v = (w >>> 30) & 1 ? S(a) >> BigInt((w >>> 20) & 63) : a >> BigInt((w >>> 20) & 63);
            break;
          default:
            throw Error('opimm');
        }
        break;
      case 0x1b:
        switch (f3) {
          case 0:
            v = W(a + imm);
            break;
          case 1:
            v = W(a << BigInt((w >>> 20) & 31));
            break;
          case 5:
            v = W(
              ((w >>> 30) & 1 ? BigInt.asIntN(32, a) : BigInt.asUintN(32, a)) >>
                BigInt((w >>> 20) & 31),
            );
            break;
          default:
            throw Error('opimmw');
        }
        break;
      case 0x33:
      case 0x3b: {
        const word = op === 0x3b,
          x = word ? BigInt.asUintN(32, a) : a,
          y = word ? BigInt.asUintN(32, b) : b,
          shift = y & BigInt(word ? 31 : 63);
        if (f7 === 1) {
          if (f3 === 0) v = x * y;
          else if (f3 === 5) v = y === 0n ? (word ? 0xffffffffn : 0xffffffffffffffffn) : x / y;
          else if (f3 === 7) v = y === 0n ? x : x % y;
          else throw Error(`M instruction ${f3}`);
        } else
          switch (f3) {
            case 0:
              v = f7 === 32 ? x - y : x + y;
              break;
            case 1:
              v = x << shift;
              break;
            case 2:
              v = BigInt(S(a) < S(b));
              break;
            case 3:
              v = BigInt(a < b);
              break;
            case 4:
              v = a ^ b;
              break;
            case 5:
              v = f7 === 32 ? (word ? BigInt.asIntN(32, a) : S(a)) >> shift : x >> shift;
              break;
            case 6:
              v = a | b;
              break;
            case 7:
              v = a & b;
              break;
            default:
              throw Error('op');
          }
        if (word) v = W(v);
        break;
      }
      case 0x0f:
        write = false;
        break;
      default:
        throw Error(`Unsupported instruction 0x${w.toString(16)} at0x${p.toString(16)}`);
    }
    if (write && rd) this.r[rd] = U(v);
    this.r[0] = 0n;
    this.pc = next;
  }
}
// Fixed machine-code vectors independent of the emitter and assembler.
export function verifyModel() {
  const m = Object.create(RV64.prototype);
  m.mem = Buffer.alloc(256);
  m.r = Array(32).fill(0n);
  m.pc = 0;
  const code = [0xfff00293, 0x00100313, 0x006283bb, 0x0262d43b, 0x0262f4bb, 0x00038513];
  code.forEach((v, i) => {
    m.mem.writeUInt32LE(v >>> 0, i * 4);
  });
  for (let i = 0; i < code.length; i++) m.step();
  assert.equal(m.r[5], 0xffffffffffffffffn);
  assert.equal(m.r[7], 0n);
  assert.equal(m.r[8], 0xffffffffffffffffn);
  assert.equal(m.r[9], 0n);
  assert.equal(m.r[10], 0n);
  return { fixedInstructionVectors: code.length, misalignmentTraps: true };
}
