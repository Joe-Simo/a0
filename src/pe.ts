/**
 * Windows PE32+ (x86-64) executable writer: a console program with a hand-built import table for the
 * functions it needs from KERNEL32.dll, and no linker, assembler or C runtime. It is the reference for
 * the writer in A0 (compiler/pe.a0), in the way src/macho.ts is for compiler/macho.a0.
 *
 * Layout (file alignment 0x200, section alignment 0x1000, image base 0x140000000, fixed address):
 *   headers      file 0x000, 0x200 bytes: DOS header (e_lfanew = 0x40), PE signature, COFF header,
 *                optional header with 16 data directories, two section headers
 *   .text        RVA 0x1000, file 0x200: the code and read-only data supplied by the caller
 *   .idata       RVA after .text: import directory, import lookup table, import address table,
 *                hint/name entries and the DLL name; the loader fills the address table
 *
 * The caller supplies the text section as a function of the layout, because instructions refer to the
 * address table by RIP-relative offsets: `text(ctx)` is called twice (once to learn its size, once with
 * the final addresses) and must return the same number of bytes both times.
 */

export interface PeLayout {
  /** RVA of the first byte of .text. */
  readonly textRva: number;
  /** RVA of the 8-byte import address table slot of an imported function. */
  iat(name: string): number;
}

export interface PeOptions {
  /** Functions imported from KERNEL32.dll, in table order. */
  readonly imports: readonly string[];
  /** The .text bytes; see the file comment. */
  readonly text: (layout: PeLayout) => Uint8Array;
  /** Offset of the entry point inside .text. */
  readonly entry: number;
}

const IMAGE_BASE = 0x140000000n;
const SECTION_ALIGN = 0x1000;
const FILE_ALIGN = 0x200;
const TEXT_RVA = 0x1000;
const DLL = 'KERNEL32.dll';

const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a;

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
  u64(v: bigint): void {
    this.u32(Number(v & 0xffffffffn));
    this.u32(Number((v >> 32n) & 0xffffffffn));
  }
  ascii(s: string, pad = 0): void {
    for (const ch of s) this.u8(ch.charCodeAt(0));
    for (let i = s.length; i < pad; i += 1) this.u8(0);
  }
  zeros(n: number): void {
    for (let i = 0; i < n; i += 1) this.u8(0);
  }
  padTo(n: number): void {
    if (this.bytes.length > n)
      throw new Error(`pe: content of ${this.bytes.length} bytes overruns ${n}`);
    this.zeros(n - this.bytes.length);
  }
}

/** The .idata section for the given imports at the given RVA: its bytes and the RVA of each IAT slot. */
function importSection(
  imports: readonly string[],
  rva: number,
): { bytes: number[]; iat: Map<string, number> } {
  const n = imports.length;
  const dirSize = 2 * 20; // one descriptor and the terminator
  const iltRva = rva + dirSize;
  const iatRva = iltRva + (n + 1) * 8;
  let pos = iatRva + (n + 1) * 8;
  const hintRva = new Map<string, number>();
  for (const name of imports) {
    hintRva.set(name, pos);
    pos += alignUp(2 + name.length + 1, 2);
  }
  const dllRva = pos;
  const o = new Out();
  // import descriptor: OriginalFirstThunk, TimeDateStamp, ForwarderChain, Name, FirstThunk
  o.u32(iltRva);
  o.u32(0);
  o.u32(0);
  o.u32(dllRva);
  o.u32(iatRva);
  o.zeros(20);
  for (const name of imports) o.u64(BigInt(hintRva.get(name) as number)); // ILT
  o.u64(0n);
  for (const name of imports) o.u64(BigInt(hintRva.get(name) as number)); // IAT before binding
  o.u64(0n);
  for (const name of imports) {
    o.u16(0); // hint
    o.ascii(name);
    o.u8(0);
    if (o.bytes.length % 2 === 1) o.u8(0);
  }
  o.ascii(DLL);
  o.u8(0);
  const iat = new Map<string, number>();
  imports.forEach((name, i) => iat.set(name, iatRva + i * 8));
  return { bytes: o.bytes, iat };
}

/** The bytes of a console executable. */
export function buildPe(opts: PeOptions): Uint8Array {
  const probe = opts.text({ textRva: TEXT_RVA, iat: () => 0 });
  const textSize = probe.length;
  const textRaw = alignUp(textSize, FILE_ALIGN);
  const idataRva = TEXT_RVA + alignUp(textSize, SECTION_ALIGN);
  const idata = importSection(opts.imports, idataRva);
  const idataSize = idata.bytes.length;
  const idataRaw = alignUp(idataSize, FILE_ALIGN);
  const layout: PeLayout = {
    textRva: TEXT_RVA,
    iat(name: string): number {
      const v = idata.iat.get(name);
      if (v === undefined) throw new Error(`pe: ${name} is not imported`);
      return v;
    },
  };
  const text = opts.text(layout);
  if (text.length !== textSize)
    throw new Error('pe: the text section changed size between layouts');
  const sizeOfImage = idataRva + alignUp(idataSize, SECTION_ALIGN);

  const o = new Out();
  // DOS header
  o.ascii('MZ');
  o.zeros(0x3a);
  o.u32(0x40); // e_lfanew
  // PE signature and COFF header
  o.ascii('PE');
  o.u16(0);
  o.u16(0x8664); // machine: x86-64
  o.u16(2); // sections
  o.u32(0); // time stamp
  o.u32(0); // symbol table
  o.u32(0); // symbols
  o.u16(240); // size of the optional header
  o.u16(0x0022); // executable image, large address aware
  // optional header (PE32+)
  o.u16(0x20b);
  o.u8(14); // linker version
  o.u8(0);
  o.u32(textRaw); // size of code
  o.u32(idataRaw); // size of initialized data
  o.u32(0); // size of uninitialized data
  o.u32(TEXT_RVA + opts.entry); // entry point
  o.u32(TEXT_RVA); // base of code
  o.u64(IMAGE_BASE);
  o.u32(SECTION_ALIGN);
  o.u32(FILE_ALIGN);
  o.u16(6);
  o.u16(0); // OS version
  o.u16(0);
  o.u16(0); // image version
  o.u16(6);
  o.u16(0); // subsystem version
  o.u32(0); // win32 version
  o.u32(sizeOfImage);
  o.u32(FILE_ALIGN); // size of headers
  o.u32(0); // checksum
  o.u16(3); // console subsystem
  o.u16(0); // DLL characteristics: fixed address
  o.u64(0x100000n); // stack reserve
  o.u64(0x1000n); // stack commit
  o.u64(0x100000n); // heap reserve
  o.u64(0x1000n); // heap commit
  o.u32(0); // loader flags
  o.u32(16); // data directories
  for (let i = 0; i < 16; i += 1) {
    if (i === 1) {
      o.u32(idataRva);
      o.u32(idataSize);
    } else {
      o.u32(0);
      o.u32(0);
    }
  }
  // section headers
  const section = (
    name: string,
    vsize: number,
    rva: number,
    raw: number,
    ptr: number,
    flags: number,
  ): void => {
    o.ascii(name, 8);
    o.u32(vsize);
    o.u32(rva);
    o.u32(raw);
    o.u32(ptr);
    o.u32(0);
    o.u32(0);
    o.u16(0);
    o.u16(0);
    o.u32(flags);
  };
  section('.text', textSize, TEXT_RVA, textRaw, FILE_ALIGN, 0x60000020); // code, execute, read
  section('.idata', idataSize, idataRva, idataRaw, FILE_ALIGN + textRaw, 0xc0000040); // data, read, write
  o.padTo(FILE_ALIGN);
  for (const b of text) o.u8(b);
  o.padTo(FILE_ALIGN + textRaw);
  for (const b of idata.bytes) o.u8(b);
  o.padTo(FILE_ALIGN + textRaw + idataRaw);
  return Uint8Array.from(o.bytes);
}

/**
 * A console program that writes `message` to standard output and exits with code 0: the smallest
 * program that exercises the import table. x86-64 code, Win64 calling convention.
 */
export function helloPe(message: string): Uint8Array {
  const msg = Uint8Array.from(Buffer.from(message, 'latin1'));
  return buildPe({
    imports: ['GetStdHandle', 'WriteFile', 'ExitProcess'],
    entry: 0,
    text: (layout) => {
      const c: number[] = [];
      const at = (): number => layout.textRva + c.length;
      const rel32 = (target: number, instrEnd: number): number => (target - instrEnd) | 0;
      const push = (...b: number[]): void => {
        c.push(...b);
      };
      const i32 = (v: number): number[] => [
        v & 0xff,
        (v >>> 8) & 0xff,
        (v >>> 16) & 0xff,
        (v >>> 24) & 0xff,
      ];
      push(0x48, 0x83, 0xec, 0x28); // sub rsp, 40
      push(0xb9, ...i32(-11)); // mov ecx, STD_OUTPUT_HANDLE
      push(0xff, 0x15, ...i32(rel32(layout.iat('GetStdHandle'), at() + 6))); // call [GetStdHandle]
      push(0x48, 0x89, 0xc1); // mov rcx, rax
      const leaAt = c.length;
      push(0x48, 0x8d, 0x15, ...i32(0)); // lea rdx, [rip + message], patched below
      push(0x41, 0xb8, ...i32(msg.length)); // mov r8d, length
      push(0x4c, 0x8d, 0x4c, 0x24, 0x30); // lea r9, [rsp + 48] (bytes written)
      push(0x48, 0xc7, 0x44, 0x24, 0x20, ...i32(0)); // mov qword [rsp + 32], 0 (no overlapped)
      push(0xff, 0x15, ...i32(rel32(layout.iat('WriteFile'), at() + 6))); // call [WriteFile]
      push(0x31, 0xc9); // xor ecx, ecx
      push(0xff, 0x15, ...i32(rel32(layout.iat('ExitProcess'), at() + 6))); // call [ExitProcess]
      const msgRva = at();
      const patch = i32(rel32(msgRva, layout.textRva + leaAt + 7));
      for (let i = 0; i < 4; i += 1) c[leaAt + 3 + i] = patch[i] as number;
      for (const b of msg) c.push(b);
      return Uint8Array.from(c);
    },
  });
}
