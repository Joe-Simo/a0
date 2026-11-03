export function utf8Cases(): Buffer[] {
  const values = new Map<string, Buffer>();
  const add = (value: Buffer) => values.set(value.toString('hex'), value);
  add(Buffer.alloc(0));
  for (let a = 0; a < 256; a++) {
    add(Buffer.from([a]));
    for (let b = 0; b < 256; b++) add(Buffer.from([a, b]));
  }
  for (const point of [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff]) {
    const bytes = Buffer.from(String.fromCodePoint(point));
    add(bytes);
    for (let n = 0; n < bytes.length; n++) add(bytes.subarray(0, n));
    for (let pos = 0; pos < bytes.length; pos++)
      for (let value = 0; value < 256; value++) {
        const mutated = Buffer.from(bytes);
        mutated[pos] = value;
        add(mutated);
      }
  }
  let state = 0x4729ac31;
  for (let n = 0; n < 512; n++) {
    const bytes = Buffer.alloc(n % 33);
    for (let i = 0; i < bytes.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[i] = state & 255;
    }
    add(bytes);
  }
  return [...values.values()];
}
