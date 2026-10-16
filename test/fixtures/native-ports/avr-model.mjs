// Independent ATmega328P integer instruction model over assembled ELF relocatable bytes.
import assert from 'node:assert/strict';

const sx = (v, b) => (v << (32 - b)) >> (32 - b);
export class AVR {
  constructor(elf) {
    assert.equal(elf.toString('hex', 0, 4), '7f454c46');
    assert.equal(elf[4], 1);
    assert.equal(elf.readUInt16LE(18), 83);
    this.mem = Buffer.alloc(65536);
    this.r = new Uint8Array(32);
    this.flags = 0;
    this.sp = 0x8ff;
    this.instructions = 0;
    this.symbols = new Map();
    const sh = elf.readUInt32LE(32),
      sn = elf.readUInt16LE(48),
      ss = elf.readUInt16LE(46),
      sections = [];
    let at = 0;
    for (let i = 0; i < sn; i++) {
      const h = sh + i * ss,
        sec = {
          type: elf.readUInt32LE(h + 4),
          flags: elf.readUInt32LE(h + 8),
          off: elf.readUInt32LE(h + 16),
          size: elf.readUInt32LE(h + 20),
          link: elf.readUInt32LE(h + 24),
          info: elf.readUInt32LE(h + 28),
          ent: elf.readUInt32LE(h + 36),
          addr: 0,
        };
      if (sec.flags & 4) {
        sec.addr = at;
        at += sec.size;
      }
      sections.push(sec);
    }
    assert.ok(at <= 32768, 'ATmega328P flash capacity');
    this.code = Buffer.alloc(at);
    for (const s of sections) if (s.flags & 4) elf.copy(this.code, s.addr, s.off, s.off + s.size);
    const sym = sections.find((s) => s.type === 2),
      str = sections[sym.link],
      syms = [];
    for (let o = sym.off; o < sym.off + sym.size; o += sym.ent) {
      const n = elf.readUInt32LE(o),
        end = elf.indexOf(0, str.off + n),
        name = elf.toString('utf8', str.off + n, end),
        index = elf.readUInt16LE(o + 14),
        value = elf.readUInt32LE(o + 4),
        addr = value + (sections[index]?.addr ?? 0);
      syms.push({ name, addr, index });
      if (name && index) this.symbols.set(name, addr);
    }
    this.relocations = [];
    for (const s of sections)
      if (s.type === 4) {
        for (let o = s.off; o < s.off + s.size; o += s.ent) {
          const off = elf.readUInt32LE(o) + sections[s.info].addr,
            info = elf.readUInt32LE(o + 4),
            type = info & 255,
            target = syms[info >>> 8],
            add = elf.readInt32LE(o + 8),
            v = target.addr + add;
          assert.notEqual(target.index, 0, `unresolved ${target.name}`);
          if (type === 18) {
            const word = v / 2;
            this.code.writeUInt16LE(
              (this.code.readUInt16LE(off) & 0xfe0e) |
                ((word >>> 13) & 0x1f0) |
                ((word >>> 16) & 1),
              off,
            );
            this.code.writeUInt16LE(word & 65535, off + 2);
          } else if (type === 3 || type === 2) {
            const bits = type === 3 ? 12 : 7,
              d = (v - off - 2) / 2,
              w = this.code.readUInt16LE(off);
            assert.ok(d >= -(1 << (bits - 1)) && d < 1 << (bits - 1), `branch range ${d}/${bits}`);
            this.code.writeUInt16LE(
              type === 3 ? (w & 0xf000) | (d & 4095) : (w & 0xfc07) | ((d & 127) << 3),
              off,
            );
          } else throw Error(`AVR relocation ${type}`);
          this.relocations.push({ type, off });
        }
      }
  }
  pair(r) {
    return this.r[r] | (this.r[r + 1] << 8);
  }
  setpair(r, v) {
    this.r[r] = v;
    this.r[r + 1] = v >>> 8;
  }
  flag(n) {
    return (this.flags >>> n) & 1;
  }
  setflag(n, v) {
    this.flags = (this.flags & ~(1 << n)) | (Number(!!v) << n);
  }
  push(v) {
    assert.ok(this.sp >= 0x100, 'SRAM stack underflow');
    this.mem[this.sp--] = v & 255;
  }
  pop() {
    return this.mem[++this.sp];
  }
  pushpc(pc) {
    assert.equal(pc % 2, 0);
    this.push(pc / 2);
    this.push((pc / 2) >>> 8);
  }
  poppc() {
    const hi = this.pop();
    return ((hi << 8) | this.pop()) * 2;
  }
  arithmetic(a, b, c, sub, chain = false) {
    const prevZ = this.flag(1),
      full = sub ? a - b - c : a + b + c,
      v = full & 255;
    const ov = sub ? (a ^ b) & (a ^ v) & 128 : ~(a ^ b) & (a ^ v) & 128;
    this.setflag(0, sub ? full < 0 : full > 255);
    this.setflag(1, v === 0 && (!chain || prevZ));
    this.setflag(2, v & 128);
    this.setflag(3, ov);
    this.setflag(4, this.flag(2) ^ this.flag(3));
    this.setflag(5, sub ? (a & 15) < (b & 15) + c : (a & 15) + (b & 15) + c > 15);
    return v;
  }
  logical(v) {
    v &= 255;
    this.setflag(1, v === 0);
    this.setflag(2, v & 128);
    this.setflag(3, 0);
    this.setflag(4, this.flag(2));
    return v;
  }
  ioRead(a) {
    return a === 61 ? this.sp & 255 : a === 62 ? this.sp >>> 8 : a === 63 ? this.flags : 0;
  }
  ioWrite(a, v) {
    if (a === 61) this.sp = (this.sp & 0xff00) | v;
    else if (a === 62) this.sp = (this.sp & 255) | (v << 8);
    else if (a === 63) this.flags = v;
    else throw Error(`io write ${a}`);
  }
  call(
    name,
    args,
    types = args.map(() => 1),
    { sret, stack = 0x8ff, maxInstructions = 10000000 } = {},
  ) {
    let avail = sret === undefined ? 26 : 24,
      stackBytes = 0;
    for (const t of types) {
      const size = t >= 4 ? 2 : t === 2 ? 1 : 4,
        even = (size + 1) & ~1;
      if (avail >= 8 + even) avail -= even;
      else {
        avail = 0;
        stackBytes += size;
      }
    }
    stack -= stackBytes;
    this.r.fill(0);
    this.flags = 0;
    this.sp = stack;
    const saved = [...Array.from({ length: 16 }, (_, i) => i + 2), 28, 29].map((i) => [
      i,
      (37 + i * 7) & 255,
    ]);
    for (const [i, v] of saved) this.r[i] = v;
    let hi = sret === undefined ? 26 : 24,
      stk = 0;
    const actual = [];
    args.forEach((value, i) => {
      const size = types[i] >= 4 ? 2 : types[i] === 2 ? 1 : 4,
        even = (size + 1) & ~1,
        fits = hi >= 8 + even;
      if (fits) {
        hi -= even;
        for (let k = 0; k < size; k++) this.r[hi + k] = (Number(value) >>> (8 * k)) & 255;
      } else {
        hi = 0;
        for (let k = 0; k < size; k++)
          this.mem[stack + 1 + stk + k] = (Number(value) >>> (8 * k)) & 255;
        stk += size;
      }
    });
    if (sret !== undefined) this.setpair(24, sret);
    for (const item of saved) item[1] = this.r[item[0]];
    this.pushpc(0xfffe);
    this.pc = this.symbols.get(name);
    assert.notEqual(this.pc, undefined, name);
    let n = 0;
    while (this.pc !== 0xfffe) {
      assert.ok(n++ < maxInstructions, `fuel ${name}@${this.pc.toString(16)}`);
      this.step();
    }
    this.instructions += n;
    assert.equal(this.sp, stack, 'SP restored');
    assert.equal(this.r[1], 0, 'zero register');
    for (const [i, v] of saved) assert.equal(this.r[i], v, `callee-saved r${i}`);
    return (this.r[22] | (this.r[23] << 8) | (this.r[24] << 16) | (this.r[25] << 24)) >>> 0;
  }
  step() {
    const p = this.pc,
      w = this.code.readUInt16LE(p),
      d = (w >>> 4) & 31,
      r = (w & 15) | ((w >>> 5) & 16),
      imm = (w & 15) | ((w >>> 4) & 240);
    let next = p + 2;
    if ((w & 0xf000) === 0xe000) {
      this.r[16 + ((w >>> 4) & 15)] = imm;
    } else if ((w & 0xff00) === 0x0100) {
      this.setpair(((w >>> 4) & 15) * 2, this.pair((w & 15) * 2));
    } else if ((w & 0xfc00) === 0x2c00) this.r[d] = this.r[r];
    else if ((w & 0xfe0f) === 0x920f) this.push(this.r[d]);
    else if ((w & 0xfe0f) === 0x900f) this.r[d] = this.pop();
    else if ((w & 0xf800) === 0xb000) this.r[d] = this.ioRead((w & 15) | ((w >>> 5) & 48));
    else if ((w & 0xf800) === 0xb800) this.ioWrite((w & 15) | ((w >>> 5) & 48), this.r[d]);
    else if (w === 0x94f8) this.setflag(7, 0);
    else if (w === 0x9508) next = this.poppc();
    else if ((w & 0xfe0e) === 0x940c || (w & 0xfe0e) === 0x940e) {
      const target = (((w & 1) << 16) | ((w & 0x1f0) << 13) | this.code.readUInt16LE(p + 2)) * 2;
      if ((w & 2) !== 0) {
        assert.equal(this.r[1], 0, 'zero register on call');
        this.pushpc(p + 4);
      }
      next = target;
    } else if ((w & 0xf000) === 0xc000) next = p + 2 + sx(w & 4095, 12) * 2;
    else if ((w & 0xfc00) === 0xf000 || (w & 0xfc00) === 0xf400) {
      const bit = w & 7,
        set = (w & 0x400) === 0;
      if (this.flag(bit) === Number(set)) next = p + 2 + sx((w >>> 3) & 127, 7) * 2;
    } else if ((w & 0xff00) === 0x9600) {
      const rr = 24 + ((w >>> 4) & 3) * 2,
        k = (w & 15) | ((w >>> 2) & 48),
        a = this.pair(rr),
        v = (a + k) & 65535;
      this.setpair(rr, v);
      this.setflag(0, v < a);
      this.setflag(1, v === 0);
      this.setflag(2, v & 0x8000);
      this.setflag(3, !(a & 0x8000) && v & 0x8000);
      this.setflag(4, this.flag(2) ^ this.flag(3));
    } else if ((w & 0xfe0f) === 0x9001 || (w & 0xfe0f) === 0x900c || (w & 0xfe0f) === 0x900d) {
      const mode = w & 15,
        pr = mode === 1 ? 30 : 26,
        addr = this.pair(pr);
      assert.ok(addr >= 0x100 && addr < 0x900, `SRAM load ${addr.toString(16)}`);
      this.r[d] = this.mem[addr];
      if (mode === 1 || mode === 13) this.setpair(pr, addr + 1);
    } else if ((w & 0xfe0f) === 0x9201 || (w & 0xfe0f) === 0x920c || (w & 0xfe0f) === 0x920d) {
      const mode = w & 15,
        pr = mode === 1 ? 30 : 26,
        addr = this.pair(pr);
      assert.ok(addr >= 0x100 && addr < 0x900, `SRAM store ${addr.toString(16)}`);
      this.mem[addr] = this.r[d];
      if (mode === 1 || mode === 13) this.setpair(pr, addr + 1);
    } else if ((w & 0xfc00) === 0x0c00) this.r[d] = this.arithmetic(this.r[d], this.r[r], 0, false);
    else if ((w & 0xfc00) === 0x1c00)
      this.r[d] = this.arithmetic(this.r[d], this.r[r], this.flag(0), false);
    else if ((w & 0xfc00) === 0x1800) this.r[d] = this.arithmetic(this.r[d], this.r[r], 0, true);
    else if ((w & 0xfc00) === 0x0800)
      this.r[d] = this.arithmetic(this.r[d], this.r[r], this.flag(0), true, true);
    else if ((w & 0xfc00) === 0x1400) this.arithmetic(this.r[d], this.r[r], 0, true);
    else if ((w & 0xfc00) === 0x0400)
      this.arithmetic(this.r[d], this.r[r], this.flag(0), true, true);
    else if ((w & 0xf000) === 0x5000) {
      const rr = 16 + ((w >>> 4) & 15);
      this.r[rr] = this.arithmetic(this.r[rr], imm, 0, true);
    } else if ((w & 0xf000) === 0x4000) {
      const rr = 16 + ((w >>> 4) & 15);
      this.r[rr] = this.arithmetic(this.r[rr], imm, this.flag(0), true, true);
    } else if ((w & 0xfc00) === 0x2000) this.r[d] = this.logical(this.r[d] & this.r[r]);
    else if ((w & 0xfc00) === 0x2400) this.r[d] = this.logical(this.r[d] ^ this.r[r]);
    else if ((w & 0xfc00) === 0x2800) this.r[d] = this.logical(this.r[d] | this.r[r]);
    else if ((w & 0xf000) === 0x6000) {
      const rr = 16 + ((w >>> 4) & 15);
      this.r[rr] = this.logical(this.r[rr] | imm);
    } else if ((w & 0xf000) === 0x7000) {
      const rr = 16 + ((w >>> 4) & 15);
      this.r[rr] = this.logical(this.r[rr] & imm);
    } else if ((w & 0xfe0f) === 0x940a) {
      const v = (this.r[d] - 1) & 255;
      this.r[d] = v;
      this.setflag(1, v === 0);
      this.setflag(2, v & 128);
      this.setflag(3, v === 127);
      this.setflag(4, this.flag(2) ^ this.flag(3));
    } else if ((w & 0xfe0f) === 0x9406 || (w & 0xfe0f) === 0x9407) {
      const old = this.r[d],
        c = this.flag(0),
        v = (old >>> 1) | (w & 1 ? c << 7 : 0);
      this.r[d] = v;
      this.setflag(0, old & 1);
      this.setflag(1, v === 0);
      this.setflag(2, v & 128);
      this.setflag(3, this.flag(2) ^ this.flag(0));
      this.setflag(4, this.flag(2) ^ this.flag(3));
    } else throw Error(`Unknown AVR instruction ${w.toString(16)} @${p.toString(16)}`);
    this.pc = next;
  }
}
export function verifyModel() {
  const m = Object.create(AVR.prototype);
  m.code = Buffer.from([0x8f, 0xef, 0x91, 0xe0, 0x89, 0x0f, 0x88, 0x27]);
  m.r = new Uint8Array(32);
  m.flags = 0;
  m.pc = 0;
  for (let i = 0; i < 4; i++) m.step();
  assert.equal(m.r[24], 0);
  assert.equal(m.flag(0), 1);
  assert.equal(m.flag(1), 1);
  return {
    goldenInstructions: 4,
    flashBytes: 32768,
    sramDataRange: [256, 2304],
    helperHooks: false,
  };
}
