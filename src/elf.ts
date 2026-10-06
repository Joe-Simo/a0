/**
 * Linux ELF64 executable writer: a static, position-dependent program with one read-execute segment
 * (the headers and the code) and an optional zero-filled read-write segment, no section headers, no
 * dynamic linking and no C library; the program talks to the kernel with system calls. It is the
 * reference for the writer in A0 (compiler/elf.a0), in the way src/macho.ts is for compiler/macho.a0.
 *
 * Layout: ELF header (64 bytes), program headers (56 bytes each), then the code at file offset 0x80;
 * the first segment maps the file from offset 0 at the virtual address BASE, so an address in the code
 * is BASE + file offset. The entry point is an offset inside the code.
 */

export type ElfMachine = 'x86_64' | 'aarch64';

export interface ElfOptions {
  readonly machine: ElfMachine;
  /** The code and read-only data; the caller computes absolute addresses from `ELF_BASE + ELF_CODE_OFFSET`. */
  readonly code: Uint8Array;
  /** Offset of the entry point inside `code`. */
  readonly entry: number;
  /** Zero-filled read-write bytes after the file image (0 for none). */
  readonly bss?: number;
}

export const ELF_BASE = 0x400000;
export const ELF_CODE_OFFSET = 0x80;
const PAGE = 0x1000;
const EM: Record<ElfMachine, number> = { x86_64: 62, aarch64: 183 };

class Out {
  readonly bytes: number[] = [];
  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
  }
  u32(v: number): void {
    this.u16(v);
    this.u16(v >>> 16);
  }
  u64(v: number): void {
    this.u32(v >>> 0);
    this.u32(Math.floor(v / 0x100000000));
  }
}

/** The bytes of an executable. */
export function buildElf(opts: ElfOptions): Uint8Array {
  const bss = opts.bss ?? 0;
  const phnum = bss > 0 ? 2 : 1;
  const fileSize = ELF_CODE_OFFSET + opts.code.length;
  if (opts.entry < 0 || opts.entry >= Math.max(1, opts.code.length)) {
    throw new Error('elf: the entry point is outside the code');
  }
  const o = new Out();
  // identification: magic, 64-bit, little endian, version 1, System V ABI
  for (const b of [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]) o.u8(b);
  for (let i = 0; i < 8; i += 1) o.u8(0);
  o.u16(2); // executable
  o.u16(EM[opts.machine]);
  o.u32(1);
  o.u64(ELF_BASE + ELF_CODE_OFFSET + opts.entry);
  o.u64(64); // program headers follow the header
  o.u64(0); // no section headers
  o.u32(0); // flags
  o.u16(64);
  o.u16(56);
  o.u16(phnum);
  o.u16(0);
  o.u16(0);
  o.u16(0);
  // PT_LOAD, read and execute, from the start of the file
  const phdr = (
    flags: number,
    offset: number,
    vaddr: number,
    filesz: number,
    memsz: number,
  ): void => {
    o.u32(1);
    o.u32(flags);
    o.u64(offset);
    o.u64(vaddr);
    o.u64(vaddr);
    o.u64(filesz);
    o.u64(memsz);
    o.u64(PAGE);
  };
  phdr(5, 0, ELF_BASE, fileSize, fileSize);
  if (bss > 0) {
    // the zero-filled segment starts on the next page after the image
    const vaddr = ELF_BASE + Math.ceil(fileSize / PAGE) * PAGE + PAGE + (fileSize % PAGE);
    phdr(6, fileSize, vaddr, 0, bss);
  }
  while (o.bytes.length < ELF_CODE_OFFSET) o.u8(0);
  for (const b of opts.code) o.u8(b);
  return Uint8Array.from(o.bytes);
}

const i32 = (v: number): number[] => [
  v & 0xff,
  (v >>> 8) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 24) & 0xff,
];

/** A program that writes `message` to standard output and exits with code 0, in the machine's own code. */
export function helloElf(machine: ElfMachine, message: string): Uint8Array {
  const msg = Uint8Array.from(Buffer.from(message, 'latin1'));
  const c: number[] = [];
  if (machine === 'x86_64') {
    c.push(0xb8, ...i32(1)); // mov eax, 1 (write)
    c.push(0xbf, ...i32(1)); // mov edi, 1 (stdout)
    const leaAt = c.length;
    c.push(0x48, 0x8d, 0x35, ...i32(0)); // lea rsi, [rip + message]
    c.push(0xba, ...i32(msg.length)); // mov edx, length
    c.push(0x0f, 0x05); // syscall
    c.push(0xb8, ...i32(60)); // mov eax, 60 (exit)
    c.push(0x31, 0xff); // xor edi, edi
    c.push(0x0f, 0x05); // syscall
    const rel = c.length - (leaAt + 7);
    const p = i32(rel);
    for (let i = 0; i < 4; i += 1) c[leaAt + 3 + i] = p[i] as number;
  } else {
    // aarch64: x8 = syscall number, x0..x2 arguments, svc #0
    const word = (w: number): void => {
      c.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff);
    };
    word(0xd2800020); // mov x0, #1
    word(0x10000001); // adr x1, message (patched below)
    word(0xd2800002 | (msg.length << 5)); // mov x2, #length
    word(0xd2800808); // mov x8, #64 (write)
    word(0xd4000001); // svc #0
    word(0xd2800000); // mov x0, #0
    word(0xd2800ba8); // mov x8, #93 (exit)
    word(0xd4000001); // svc #0
    // adr x1 at byte 4: offset to the message at byte 32 is 28
    const adr = (0x10000001 | ((28 & 3) << 29) | (((28 >> 2) & 0x7ffff) << 5)) >>> 0;
    c[4] = adr & 0xff;
    c[5] = (adr >>> 8) & 0xff;
    c[6] = (adr >>> 16) & 0xff;
    c[7] = (adr >>> 24) & 0xff;
  }
  for (const b of msg) c.push(b);
  return buildElf({ machine, code: Uint8Array.from(c), entry: 0 });
}
