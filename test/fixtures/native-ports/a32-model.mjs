// Independent ARM A32 integer instruction model consuming linked ELF32 bytes.
import assert from 'node:assert/strict';

const sx = (n, b) => Number(BigInt.asIntN(b, BigInt(n))),
  ror = (x, n) => (n === 0 ? x >>> 0 : ((x >>> n) | (x << (32 - n))) >>> 0);
export class A32 {
  constructor(elf) {
    this.mem = Buffer.alloc(64 << 20);
    this.r = Array(16).fill(0);
    this.N = 0;
    this.Z = 0;
    this.C = 0;
    this.V = 0;
    this.instructions = 0;
    this.symbols = new Map();
    assert.equal(elf.toString('hex', 0, 4), '7f454c46');
    assert.equal(elf[4], 1);
    assert.equal(elf.readUInt16LE(18), 40);
    assert.ok(elf.readUInt32LE(36) & 0x400, 'hard float ELF marker');
    const ph = elf.readUInt32LE(28),
      pn = elf.readUInt16LE(44),
      ps = elf.readUInt16LE(42);
    for (let i = 0; i < pn; i++) {
      const p = ph + i * ps;
      if (elf.readUInt32LE(p) !== 1) continue;
      elf.copy(
        this.mem,
        elf.readUInt32LE(p + 8),
        elf.readUInt32LE(p + 4),
        elf.readUInt32LE(p + 4) + elf.readUInt32LE(p + 16),
      );
    }
    const sh = elf.readUInt32LE(32),
      sn = elf.readUInt16LE(48),
      ss = elf.readUInt16LE(46);
    for (let i = 0; i < sn; i++) {
      const h = sh + i * ss;
      if (elf.readUInt32LE(h + 4) !== 2) continue;
      const off = elf.readUInt32LE(h + 16),
        len = elf.readUInt32LE(h + 20),
        link = elf.readUInt32LE(h + 24),
        ent = elf.readUInt32LE(h + 36),
        so = elf.readUInt32LE(sh + link * ss + 16);
      for (let a = off; a < off + len; a += ent) {
        const no = elf.readUInt32LE(a),
          end = elf.indexOf(0, so + no),
          name = elf.toString('utf8', so + no, end),
          addr = elf.readUInt32LE(a + 4);
        if (name && addr) this.symbols.set(name, addr);
      }
    }
  }
  load(a, n) {
    a >>>= 0;
    assert.ok(a + n <= this.mem.length, `load ${a}/${n}`);
    assert.equal(a % n, 0, `alignment load ${a}/${n}`);
    return n === 4 ? this.mem.readUInt32LE(a) : this.mem[a];
  }
  store(a, n, v) {
    a >>>= 0;
    assert.ok(a + n <= this.mem.length, `store ${a}/${n}`);
    assert.equal(a % n, 0, `alignment store ${a}/${n}`);
    if (n === 4) this.mem.writeUInt32LE(v >>> 0, a);
    else this.mem[a] = v & 255;
  }
  condition(c) {
    return [
      this.Z,
      !this.Z,
      this.C,
      !this.C,
      this.N,
      !this.N,
      this.V,
      !this.V,
      this.C && !this.Z,
      !this.C || this.Z,
      this.N === this.V,
      this.N !== this.V,
      !this.Z && this.N === this.V,
      this.Z || this.N !== this.V,
      true,
      false,
    ][c];
  }
  reg(i) {
    return i === 15 ? (this.pc + 8) >>> 0 : this.r[i] >>> 0;
  }
  shift(x, type, n, reg = false) {
    x >>>= 0;
    if (reg && n === 0) return [x, this.C];
    if (!reg && n === 0) {
      if (type === 0) return [x, this.C];
      if (type === 1 || type === 2) n = 32;
      else return [((this.C << 31) | (x >>> 1)) >>> 0, x & 1];
    }
    if (type === 0) return [n < 32 ? (x << n) >>> 0 : 0, n <= 32 ? (x >>> (32 - n)) & 1 : 0];
    if (type === 1) return [n < 32 ? x >>> n : 0, n <= 32 ? (x >>> (n - 1)) & 1 : 0];
    if (type === 2)
      return [
        n < 32 ? (x >> n) >>> 0 : x & 0x80000000 ? 0xffffffff : 0,
        n < 32 ? (x >>> (n - 1)) & 1 : x >>> 31,
      ];
    n %= 32;
    return [ror(x, n), n === 0 ? x >>> 31 : (x >>> (n - 1)) & 1];
  }
  operand(w) {
    if ((w >>> 25) & 1) {
      const n = ((w >>> 8) & 15) * 2,
        v = ror(w & 255, n);
      return [v, n === 0 ? this.C : v >>> 31];
    }
    const x = this.reg(w & 15),
      type = (w >>> 5) & 3,
      isreg = (w >>> 4) & 1,
      n = isreg ? this.reg((w >>> 8) & 15) & 255 : (w >>> 7) & 31;
    return this.shift(x, type, n, !!isreg);
  }
  flags(v) {
    this.N = v >>> 31;
    this.Z = Number(v >>> 0 === 0);
  }
  add(a, b, c = 0, set = false) {
    const full = a + b + c,
      v = full >>> 0;
    if (set) {
      this.flags(v);
      this.C = Number(full > 0xffffffff);
      this.V = Number((~(a ^ b) & (a ^ v)) >>> 31 !== 0);
    }
    return v;
  }
  sub(a, b, borrow = 0, set = false) {
    const v = (a - b - borrow) >>> 0;
    if (set) {
      this.flags(v);
      this.C = Number(a >= b + borrow);
      this.V = Number(((a ^ b) & (a ^ v)) >>> 31 !== 0);
    }
    return v;
  }
  call(name, args, { sret, stack = 0x3f00000, maxInstructions = 10000000 } = {}) {
    this.r.fill(0);
    this.r[13] = stack;
    this.r[14] = 0xfff0;
    const saved = Array.from({ length: 8 }, (_, j) => [j + 4, (0x12345670 + j) >>> 0]);
    for (const [i, v] of saved) this.r[i] = v;
    const actual = sret === undefined ? args : [sret, ...args];
    actual.forEach((v, i) => {
      v = Number(v) >>> 0;
      if (i < 4) this.r[i] = v;
      else this.store(stack + (i - 4) * 4, 4, v);
    });
    this.pc = this.symbols.get(name);
    assert.ok(this.pc, `symbol ${name}`);
    let n = 0;
    while (this.pc !== 0xfff0) {
      assert.ok(n++ < maxInstructions, `fuel ${name} @${this.pc}`);
      this.step();
    }
    this.instructions += n;
    assert.equal(this.r[13], stack, 'SP restored');
    for (const [i, v] of saved) assert.equal(this.r[i], v, `saved r${i}`);
    return this.r[0] >>> 0;
  }
  step() {
    const p = this.pc,
      w = this.mem.readUInt32LE(p);
    let next = p + 4;
    if (!this.condition(w >>> 28)) {
      this.pc = next;
      return;
    }
    if ((w & 0x0ffffff0) === 0x012fff10) {
      const target = this.reg(w & 15);
      assert.equal(target & 1, 0, 'A32 return');
      this.pc = target & ~3;
      return;
    }
    if ((w & 0x0e000000) === 0x0a000000) {
      if ((w >>> 24) & 1) {
        assert.equal(this.r[13] % 8, 0, 'AAPCS call alignment');
        this.r[14] = p + 4;
      }
      this.pc = (p + 8 + (sx(w & 0xffffff, 24) << 2)) >>> 0;
      return;
    }
    if ((w & 0x0ff00000) === 0x03000000 || (w & 0x0ff00000) === 0x03400000) {
      const d = (w >>> 12) & 15,
        imm = (((w >>> 16) & 15) << 12) | (w & 4095);
      this.r[d] = w & 0x00400000 ? ((this.r[d] & 65535) | (imm << 16)) >>> 0 : imm;
      this.pc = next;
      return;
    }
    if ((w & 0x0ff0f0f0) === 0x0730f010) {
      const d = (w >>> 16) & 15,
        a = this.reg(w & 15),
        b = this.reg((w >>> 8) & 15);
      this.r[d] = b === 0 ? 0 : Math.floor(a / b) >>> 0;
      this.pc = next;
      return;
    }
    if ((w & 0x0f8000f0) === 0x00800090) {
      const lo = (w >>> 12) & 15,
        hi = (w >>> 16) & 15,
        product = BigInt(this.reg(w & 15)) * BigInt(this.reg((w >>> 8) & 15));
      this.r[lo] = Number(product & 0xffffffffn);
      this.r[hi] = Number(product >> 32n);
      this.pc = next;
      return;
    }
    if ((w & 0x0ff000f0) === 0x00600090) {
      const d = (w >>> 16) & 15,
        a = this.reg((w >>> 12) & 15),
        x = this.reg(w & 15),
        y = this.reg((w >>> 8) & 15);
      this.r[d] = (a - Math.imul(x, y)) >>> 0;
      this.pc = next;
      return;
    }
    if ((w & 0x0fc000f0) === 0x00000090) {
      const d = (w >>> 16) & 15,
        v =
          (Math.imul(this.reg(w & 15), this.reg((w >>> 8) & 15)) +
            ((w >>> 21) & 1 ? this.reg((w >>> 12) & 15) : 0)) >>>
          0;
      this.r[d] = v;
      if ((w >>> 20) & 1) this.flags(v);
      this.pc = next;
      return;
    }
    if ((w & 0x0e000000) === 0x08000000) {
      const base = (w >>> 16) & 15,
        up = (w >>> 23) & 1,
        pre = (w >>> 24) & 1,
        load = (w >>> 20) & 1,
        regs = Array.from({ length: 16 }, (_, i) => i).filter((i) => (w >>> i) & 1),
        original = this.reg(base),
        n = regs.length;
      let addr = up ? original + (pre ? 4 : 0) : original - 4 * n + (pre ? 0 : 4);
      for (const i of regs) {
        if (load) {
          const v = this.load(addr, 4);
          if (i === 15) next = v & ~3;
          else this.r[i] = v;
        } else this.store(addr, 4, this.reg(i));
        addr += 4;
      }
      if ((w >>> 21) & 1) this.r[base] = (original + (up ? 4 * n : -4 * n)) >>> 0;
      this.pc = next;
      return;
    }
    if ((w & 0x0c000000) === 0x04000000) {
      const rn = (w >>> 16) & 15,
        rd = (w >>> 12) & 15,
        pre = (w >>> 24) & 1,
        up = (w >>> 23) & 1,
        load = (w >>> 20) & 1,
        byte = (w >>> 22) & 1,
        off = (w >>> 25) & 1 ? this.operand(w & ~(1 << 25))[0] : w & 4095,
        base = this.reg(rn),
        changed = (base + (up ? off : -off)) >>> 0,
        addr = pre ? changed : base;
      if (load) {
        const v = this.load(addr, byte ? 1 : 4);
        if (rd === 15) next = v & ~3;
        else this.r[rd] = v;
      } else this.store(addr, byte ? 1 : 4, this.reg(rd));
      if (!pre || (w >>> 21) & 1) this.r[rn] = changed;
      this.pc = next;
      return;
    }
    if ((w & 0x0c000000) === 0) {
      const op = (w >>> 21) & 15,
        sets = (w >>> 20) & 1,
        rn = (w >>> 16) & 15,
        rd = (w >>> 12) & 15,
        a = this.reg(rn),
        [b, carry] = this.operand(w);
      let v,
        arithmetic = false,
        write = true;
      switch (op) {
        case 0:
          v = a & b;
          break;
        case 1:
          v = a ^ b;
          break;
        case 2:
          v = this.sub(a, b, 0, sets);
          arithmetic = true;
          break;
        case 3:
          v = this.sub(b, a, 0, sets);
          arithmetic = true;
          break;
        case 4:
          v = this.add(a, b, 0, sets);
          arithmetic = true;
          break;
        case 5:
          v = this.add(a, b, this.C, sets);
          arithmetic = true;
          break;
        case 6:
          v = this.sub(a, b, 1 - this.C, sets);
          arithmetic = true;
          break;
        case 8:
          v = a & b;
          write = false;
          break;
        case 9:
          v = a ^ b;
          write = false;
          break;
        case 10:
          v = this.sub(a, b, 0, true);
          arithmetic = true;
          write = false;
          break;
        case 11:
          v = this.add(a, b, 0, true);
          arithmetic = true;
          write = false;
          break;
        case 12:
          v = a | b;
          break;
        case 13:
          v = b;
          break;
        case 14:
          v = a & ~b;
          break;
        case 15:
          v = ~b;
          break;
        default:
          throw Error(`DP ${op}`);
      }
      v >>>= 0;
      if (sets && !arithmetic) {
        this.flags(v);
        this.C = carry;
      }
      if (write) {
        if (rd === 15) next = v & ~3;
        else this.r[rd] = v;
      }
      this.pc = next;
      return;
    }
    throw Error(`Unsupported A32 instruction ${w.toString(16)} at ${p.toString(16)}`);
  }
}
export function verifyModel() {
  const m = Object.create(A32.prototype);
  m.mem = Buffer.alloc(256);
  m.r = Array(16).fill(0);
  m.N = m.Z = m.C = m.V = 0;
  m.pc = 0;
  const words = [0xe30f0fff, 0xe34f0fff, 0xe3a01001, 0xe0902001, 0xe3a03000, 0x23a03001];
  words.forEach((w, i) => {
    m.mem.writeUInt32LE(w >>> 0, i * 4);
  });
  for (let i = 0; i < words.length; i++) m.step();
  assert.equal(m.r[0], 0xffffffff);
  assert.equal(m.r[2], 0);
  assert.equal(m.r[3], 1);
  assert.equal(m.C, 1);
  return { fixedInstructionWords: words.length, misalignmentTraps: true };
}
