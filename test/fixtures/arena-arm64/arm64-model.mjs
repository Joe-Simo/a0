import assert from 'node:assert/strict';
export function machoObject(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
  assert.equal(bytes.readUInt32LE(4), 0x100000c);
  const count = bytes.readUInt32LE(16),
    sections = [],
    symbols = new Map(),
    entries = [];
  let p = 32,
    tab;
  for (let i = 0; i < count; i++) {
    const cmd = bytes.readUInt32LE(p),
      size = bytes.readUInt32LE(p + 4);
    if (cmd === 0x19) {
      const ns = bytes.readUInt32LE(p + 64);
      for (let j = 0; j < ns; j++) {
        const s = p + 72 + 80 * j;
        sections.push({
          name: bytes
            .subarray(s, s + 16)
            .toString()
            .replace(/\0.*/, ''),
          address: Number(bytes.readBigUInt64LE(s + 32)),
          size: Number(bytes.readBigUInt64LE(s + 40)),
          offset: bytes.readUInt32LE(s + 48),
          relocationOffset: bytes.readUInt32LE(s + 56),
          relocations: bytes.readUInt32LE(s + 60),
          zeroFill: (bytes.readUInt32LE(s + 64) & 255) === 1,
        });
      }
    }
    if (cmd === 2)
      tab = {
        symoff: bytes.readUInt32LE(p + 8),
        nsyms: bytes.readUInt32LE(p + 12),
        stroff: bytes.readUInt32LE(p + 16),
      };
    p += size;
  }
  assert.ok(tab);
  for (let i = 0; i < tab.nsyms; i++) {
    const n = tab.symoff + i * 16,
      off = tab.stroff + bytes.readUInt32LE(n),
      end = bytes.indexOf(0, off),
      name = bytes.subarray(off, end).toString(),
      entry = { name, value: Number(bytes.readBigUInt64LE(n + 8)), section: bytes[n + 5] };
    symbols.set(name, entry.value);
    entries.push(entry);
  }
  const text = sections.find((s) => s.name === '__text');
  assert.ok(text);
  const code = Buffer.from(bytes.subarray(text.offset, text.offset + text.size));
  for (let i = 0; i < text.relocations; i++) {
    const p = text.relocationOffset + i * 8,
      off = bytes.readInt32LE(p),
      r = bytes.readUInt32LE(p + 4),
      type = r >>> 28;
    assert.ok(off >= 0 && off + 4 <= code.length);
    assert.equal((r >>> 27) & 1, 1);
    assert.equal((r >>> 25) & 3, 2);
    const target = entries[r & 0xffffff];
    assert.ok(target && target.section > 0, 'defined object symbol required, no helper hook');
    let w = code.readUInt32LE(off);
    const address = text.address + off;
    if (type === 2) {
      assert.equal((r >>> 24) & 1, 1);
      const addend = sx(w & 0x3ffffff, 26) * 4,
        delta = target.value + addend - address;
      assert.ok(delta % 4 === 0);
      assert.ok(delta >= -134217728 && delta < 134217728);
      w = ((w & 0xfc000000) | ((delta / 4) & 0x3ffffff)) >>> 0;
    } else if (type === 3) {
      assert.equal((r >>> 24) & 1, 1);
      const addend = sx((((w >>> 5) & 0x7ffff) << 2) | ((w >>> 29) & 3), 21) * 4096,
        delta = Math.floor((target.value + addend) / 4096) - Math.floor(address / 4096);
      assert.ok(delta >= -1048576 && delta < 1048576);
      w = ((w & 0x9f00001f) | ((delta & 3) << 29) | (((delta >>> 2) & 0x7ffff) << 5)) >>> 0;
    } else if (type === 4) {
      assert.equal((r >>> 24) & 1, 0);
      assert.equal((w >>> 22) & 1, 0);
      const value = (target.value + ((w >>> 10) & 4095)) & 4095;
      w = ((w & 0xffc003ff) | (value << 10)) >>> 0;
    } else throw Error(`unsupported actual MachO relocation${type}`);
    code.writeUInt32LE(w, off);
  }
  return {
    bytes: code,
    base: text.address,
    symbols,
    sections,
    resolvedRelocations: text.relocations,
  };
}
const _MASK64 = (1n << 64n) - 1n;
const sx = (x, b) => (x >= 2 ** (b - 1) ? x - 2 ** b : x);
export class Arm64Model {
  constructor(object) {
    this.object = object;
    this.instructions = 0;
  }
  call(name, args, types, config = {}) {
    const obj = this.object,
      regs = Array(31).fill(0n),
      memory = new Map(),
      sentinel = 0xfffffff0n;
    let sp = 0x20000000n,
      pc = obj.symbols.get(`_a0_${name}`),
      flags = { n: false, z: false, c: false, v: false };
    assert.notEqual(pc, undefined, name);
    regs[30] = sentinel;
    for (let i = 19; i <= 29; i++) regs[i] = 0x89abcdef00000000n + BigInt(i);
    const saved = regs.slice(19, 30),
      initialSp = sp;
    const wordCount = (t) =>
        typeof t === 'string'
          ? 1
          : t.kind === 'arr'
            ? t.length * wordCount(t.elem)
            : t.fields.reduce((a, t) => a + wordCount(t), 0),
      flatten = (t, v) =>
        typeof t === 'string'
          ? [Number(v)]
          : t.kind === 'arr'
            ? v.flatMap((x) => flatten(t.elem, x))
            : t.fields.flatMap((t, i) => flatten(t, v[i]));
    const argMemory = [],
      startBuffers = 0x10000000n;
    let nextBuffer = startBuffers;
    const zero = (a) =>
        obj.sections.some(
          (s) => s.zeroFill && a >= BigInt(s.address) && a < BigInt(s.address + s.size),
        ),
      text = (a) => a >= BigInt(obj.base) && a < BigInt(obj.base + obj.bytes.length);
    let stderr = '';
    const valid = (a) =>
      zero(a) ||
      text(a) ||
      (a >= 0x18000000n && a < 0x20010000n) ||
      (a >= startBuffers && a < nextBuffer);
    const read = (a, n) => {
        let v = 0n;
        for (let i = 0; i < n; i++) {
          const p = a + BigInt(i);
          assert.ok(valid(p), 'model mapped data address');
          assert.ok(memory.has(p) || zero(p) || text(p), 'native read before initialization');
          const byte = memory.has(p)
            ? memory.get(p)
            : text(p)
              ? obj.bytes[Number(p) - obj.base]
              : 0;
          v |= BigInt(byte) << BigInt(i * 8);
        }
        return v;
      },
      write = (a, v, n) => {
        for (let i = 0; i < n; i++) {
          const p = a + BigInt(i);
          assert.ok(valid(p) && !text(p), 'model mapped writable address');
          memory.set(p, Number((v >> BigInt(i * 8)) & 255n));
        }
      };
    let offset = 0;
    args.forEach((v, i) => {
      const t = types[i],
        aggregate = typeof t !== 'string';
      let value;
      if (aggregate) {
        const flat = flatten(t, v),
          address = nextBuffer,
          reserved = Math.max(
            flat.length * 4,
            config.sretAliasParam === i ? wordCount(config.resultType) * 4 : 0,
          );
        nextBuffer += BigInt(Math.ceil(reserved / 16) * 16);
        flat.forEach((w, k) => {
          write(address + BigInt(k * 4), BigInt(w), 4);
        });
        argMemory[i] = { address, initial: flat };
        value = address;
      } else value = BigInt(Number(v));
      if (i < 8) regs[i] = value;
      else {
        const width = aggregate ? 8 : t === 'bool' ? 1 : 4;
        offset = Math.ceil(offset / width) * width;
        write(sp + BigInt(offset), value, width);
        offset += width;
      }
    });
    let resultAddress;
    if (config.resultType && typeof config.resultType !== 'string') {
      if (config.sretAliasParam !== undefined) {
        assert.ok(argMemory[config.sretAliasParam]);
        resultAddress = argMemory[config.sretAliasParam].address;
      } else {
        resultAddress = nextBuffer;
        nextBuffer += BigInt(Math.ceil((wordCount(config.resultType) * 4) / 16) * 16);
      }
      regs[8] = resultAddress;
    }
    const decode = (t, address) => {
      if (typeof t === 'string') return Number(read(address, 4));
      if (t.kind === 'arr')
        return Array.from({ length: t.length }, (_, i) =>
          decode(t.elem, address + BigInt(i * wordCount(t.elem) * 4)),
        );
      let off = 0;
      return t.fields.map((t) => {
        const v = decode(t, address + BigInt(off));
        off += wordCount(t) * 4;
        return v;
      });
    };
    const get = (r, base = false) => (r === 31 ? (base ? sp : 0n) : regs[r]),
      put = (r, v, bits = 64, base = false) => {
        v = BigInt.asUintN(bits, v);
        if (r === 31) {
          if (base) sp = v;
        } else regs[r] = v;
      };
    const cond = (c) => {
      const { n, z, c: carry, v } = flags;
      const b = [z, carry, n, v, carry && !z, n === v, n === v && !z, true][c >> 1];
      return c & 1 && !(c >> 1 === 7) ? !b : b;
    };
    const arithmetic = (a, b, sub, bits, set) => {
      const modulus = 1n << BigInt(bits),
        mask = modulus - 1n,
        raw = sub ? a - b : a + b,
        result = raw & mask;
      if (set) {
        const sign = 1n << BigInt(bits - 1);
        flags = {
          n: !!(result & sign),
          z: result === 0n,
          c: sub ? a >= b : raw >= modulus,
          v: sub ? !!((a ^ b) & (a ^ result) & sign) : !!(~(a ^ b) & (a ^ result) & sign),
        };
      }
      return result;
    };
    let steps = 0;
    for (;;) {
      assert.ok(
        ++steps < (config.maxSteps ?? 1000000),
        'bounded independent model instruction observation',
      );
      this.instructions++;
      if (BigInt(pc) === sentinel) {
        assert.deepEqual(regs.slice(19, 30), saved, 'callee-saved ARM64 registers');
        assert.equal(sp, initialSp, 'stack restored');
        const value =
          resultAddress === undefined
            ? Number(regs[0] & 0xffffffffn)
            : decode(config.resultType, resultAddress);
        const parameters = argMemory.map((m, i) => (m ? decode(types[i], m.address) : args[i]));
        for (let i = 0; i < argMemory.length; i++)
          if (argMemory[i] && config.sretAliasParam !== i)
            assert.deepEqual(
              flatten(types[i], parameters[i]),
              argMemory[i].initial,
              'aggregate input remains unchanged',
            );
        return config.inspect ? { value, parameters } : value;
      }
      assert.ok(pc >= obj.base && pc + 4 <= obj.base + obj.bytes.length, 'PC text bounds');
      const w = obj.bytes.readUInt32LE(pc - obj.base),
        next = pc + 4,
        d = w & 31,
        n = (w >>> 5) & 31,
        m = (w >>> 16) & 31,
        bits = w >>> 31 ? 64 : 32;
      pc = next;
      if (w === 0xd4001001) {
        const syscall = Number(regs[16]);
        if (syscall === 4) {
          assert.equal(regs[0], 2n, 'Darwin stderr descriptor');
          for (let i = 0; i < Number(regs[2]); i++)
            stderr += String.fromCharCode(Number(read(regs[1] + BigInt(i), 1)));
          regs[0] = regs[2];
          continue;
        }
        if (syscall === 1) return { exit: Number(regs[0]), stderr };
        throw Error(`unsupported Darwin syscall${syscall}`);
      }
      if ((w & 0x1f000000) === 0x10000000) {
        const delta = BigInt(sx((((w >>> 5) & 0x7ffff) << 2) | ((w >>> 29) & 3), 21));
        put(d, w >>> 31 ? (BigInt(next - 4) & ~4095n) + (delta << 12n) : BigInt(next - 4) + delta);
        continue;
      }
      if ((w & 0xfffffc1f) >>> 0 === 0xd65f0000) {
        pc = Number(get(n));
        continue;
      }
      if ((w & 0x7c000000) === 0x14000000) {
        if (w >>> 31) regs[30] = BigInt(next);
        pc = next - 4 + sx(w & 0x3ffffff, 26) * 4;
        continue;
      }
      if ((w & 0xff000010) >>> 0 === 0x54000000) {
        if (cond(w & 15)) pc = next - 4 + sx((w >>> 5) & 0x7ffff, 19) * 4;
        continue;
      }
      if ((w & 0x7e000000) === 0x34000000) {
        const zero = BigInt.asUintN(bits, get(d)) === 0n;
        if (zero !== !!(w & 0x1000000)) pc = next - 4 + sx((w >>> 5) & 0x7ffff, 19) * 4;
        continue;
      }
      if ((w & 0x1f800000) === 0x12800000) {
        const op = (w >>> 29) & 3,
          shift = BigInt(((w >>> 21) & 3) * 16),
          imm = BigInt((w >>> 5) & 65535) << shift;
        put(d, op === 2 ? imm : op === 3 ? (get(d) & ~(65535n << shift)) | imm : ~imm, bits);
        continue;
      }
      if ((w & 0x1f000000) === 0x11000000) {
        const sub = !!(w & 0x40000000),
          set = !!(w & 0x20000000),
          imm = BigInt((w >>> 10) & 4095) << BigInt(w & 0x400000 ? 12 : 0);
        put(d, arithmetic(BigInt.asUintN(bits, get(n, true)), imm, sub, bits, set), bits, !set);
        continue;
      }
      if ((w & 0x1f000000) === 0x0b000000) {
        const sub = !!(w & 0x40000000),
          set = !!(w & 0x20000000),
          ext = !!(w & 0x200000);
        let b = get(m);
        if (ext) b = BigInt.asUintN(((w >>> 13) & 7) === 3 ? 64 : 32, b) << BigInt((w >>> 10) & 7);
        else b = BigInt.asUintN(bits, b) << BigInt((w >>> 10) & 63);
        put(d, arithmetic(BigInt.asUintN(bits, get(n, ext)), b, sub, bits, set), bits, ext && !set);
        continue;
      }
      if ((w & 0x1f000000) === 0x0a000000) {
        const op = (w >>> 29) & 3,
          inv = !!(w & 0x200000);
        let b = BigInt.asUintN(bits, get(m)) << BigInt((w >>> 10) & 63);
        if (inv) b = ~b;
        const a = get(n),
          v = op === 0 || op === 3 ? a & b : op === 1 ? a | b : a ^ b;
        put(d, v, bits);
        if (op === 3)
          flags = {
            ...flags,
            n: !!(v & (1n << BigInt(bits - 1))),
            z: BigInt.asUintN(bits, v) === 0n,
          };
        continue;
      }
      if ((w & 0x7f800000) === 0x12000000) {
        assert.equal((w >>> 10) & 63, 0, 'subset logical immediate #1');
        put(d, get(n) & 1n, bits);
        continue;
      }
      if ((w & 0x3fe00000) === 0x1a800000) {
        const pass = cond((w >>> 12) & 15);
        let v = pass ? get(n) : get(m);
        if (!pass) {
          if (w & 0x40000000) v = ~v;
          if (w & 0x400) v += 1n;
        }
        put(d, v, bits);
        continue;
      }
      if ((w & 0x7fe0fc00) === 0x1ac00800) {
        const b = BigInt.asUintN(bits, get(m));
        put(d, b ? BigInt.asUintN(bits, get(n)) / b : 0n, bits);
        continue;
      }
      if ((w & 0x7fe0f800) === 0x1ac02000) {
        const amount = Number(get(m) & BigInt(bits - 1)),
          right = !!(w & 0x400);
        put(
          d,
          right ? BigInt.asUintN(bits, get(n)) >> BigInt(amount) : get(n) << BigInt(amount),
          bits,
        );
        continue;
      }
      if ((w & 0xffe00000) >>> 0 === 0x9ba00000) {
        const a = (w >>> 10) & 31,
          product = (get(n) & 0xffffffffn) * (get(m) & 0xffffffffn);
        put(d, get(a) + product);
        continue;
      }
      if ((w & 0x7f800000) === 0x53000000) {
        const r = (w >>> 16) & 63,
          k = (w >>> 10) & 63;
        assert.equal(k, bits - 1, 'current decoded UBFM LSR alias');
        put(d, BigInt.asUintN(bits, get(n)) >> BigInt(r), bits);
        continue;
      }
      if ((w & 0x7fe00000) === 0x1b000000) {
        const a = (w >>> 10) & 31,
          sub = !!(w & 0x8000),
          product = BigInt.asUintN(bits, get(n)) * BigInt.asUintN(bits, get(m));
        put(d, sub ? get(a) - product : get(a) + product, bits);
        continue;
      }
      if ((w & 0x3a000000) === 0x28000000) {
        assert.equal((w >>> 26) & 1, 0, 'scalar pair');
        const load = !!(w & 0x400000),
          size = ((w >>> 30) & 3) === 2 ? 8 : 4,
          at = (w >>> 23) & 3,
          offset = BigInt(sx((w >>> 15) & 127, 7) * size),
          base = get(n, true),
          addr = at === 1 ? base : base + offset,
          t = (w >>> 10) & 31;
        if (load) {
          put(d, read(addr, size));
          put(t, read(addr + BigInt(size), size));
        } else {
          write(addr, get(d), size);
          write(addr + BigInt(size), get(t), size);
        }
        if (at === 1 || at === 3) put(n, base + offset, 64, true);
        continue;
      }
      if ((w & 0x3b000000) === 0x39000000) {
        const size = 1 << ((w >>> 30) & 3),
          addr = get(n, true) + BigInt(((w >>> 10) & 4095) * size),
          load = !!(w & 0x400000);
        if (load) put(d, read(addr, size));
        else write(addr, get(d), size);
        continue;
      }
      if ((w & 0x3b200c00) === 0x38200800) {
        const size = 1 << ((w >>> 30) & 3),
          load = !!(w & 0x400000),
          option = (w >>> 13) & 7,
          raw = option === 2 ? get(m) & 0xffffffffn : get(m),
          addr = get(n, true) + (raw << BigInt(w & 0x1000 ? (w >>> 30) & 3 : 0));
        if (load) put(d, read(addr, size));
        else write(addr, get(d), size);
        continue;
      }
      if ((w & 0x3b200000) === 0x38000000) {
        const size = 1 << ((w >>> 30) & 3),
          load = !!(w & 0x400000),
          mode = (w >>> 10) & 3,
          offset = BigInt(sx((w >>> 12) & 511, 9)),
          base = get(n, true),
          addr = mode === 1 ? base : base + offset;
        if (load) put(d, read(addr, size));
        else write(addr, get(d), size);
        if (mode === 1 || mode === 3) put(n, base + offset, 64, true);
        continue;
      }
      throw Error(
        'unsupported actual ARM64 instruction0x' +
          w.toString(16) +
          ' at0x' +
          (next - 4).toString(16),
      );
    }
  }
}
