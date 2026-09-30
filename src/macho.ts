/**
 * Minimal Mach-O arm64 executable writer (the reference for compiler/macho.a0, which must write
 * the same bytes) and a reader for the text section of a Mach-O object file (used to compare
 * the encoder with clang's assembler).
 *
 * Layout of the executable (every segment 16 KiB aligned, as arm64 macOS requires):
 * - `__PAGEZERO` (4 GiB, no access).
 * - `__TEXT` from file offset 0: the header and load commands, `__text` at TEXT_OFFSET, then
 *   `__stubs` (three 12-byte stubs `adrp x16 / ldr x16 / br x16` through the GOT).
 * - `__DATA_CONST` (one page): `__got`, three pointers bound by dyld to libSystem's `_mmap`,
 *   `_read` and `_write` through chained fixups (DYLD_CHAINED_PTR_64_OFFSET bind entries).
 * - `__DATA`: `__bss`, zero fill, no file bytes.
 * - `__LINKEDIT`: the chained-fixups blob, then the ad-hoc code signature.
 * Load commands: the five segments, LC_DYLD_CHAINED_FIXUPS, LC_SYMTAB and LC_DYSYMTAB (empty),
 * LC_LOAD_DYLINKER, LC_BUILD_VERSION (macOS 11.0), LC_MAIN, LC_LOAD_DYLIB libSystem,
 * LC_CODE_SIGNATURE.
 *
 * The code signature is what `ld` writes for a linker-signed ad-hoc binary: a SuperBlob with
 * one CodeDirectory (version 0x20400, flags adhoc | linker-signed, SHA-256 of every 4096-byte
 * page of the file before the signature, no special slots, identifier IDENTIFIER, the executable
 * segment `__TEXT` flagged as the main binary's).
 */

import { createHash } from 'node:crypto';
import type { Arm64Module } from './arm64enc.js';

/** The libSystem symbols the executable binds, in GOT and stub order. */
export const IMPORTS = ['_mmap', '_read', '_write'] as const;
export const IDENTIFIER = 'a0c';
const BASE = 0x1_0000_0000;
const SEG = 0x4000;
const PAGE = 4096;
const NCMDS = 13;
const SIZEOFCMDS = 72 + 232 + 152 + 152 + 72 + 16 + 24 + 80 + 32 + 24 + 24 + 56 + 16;
/** File offset of `__text`: the header and load commands, rounded to 16. */
export const TEXT_OFFSET = Math.ceil((32 + SIZEOFCMDS) / 16) * 16;
const FIXUPS_SIZE = 112;
const CD_HEADER = 88;

const align = (v: number, a: number): number => Math.ceil(v / a) * a;

class Writer {
  readonly bytes: Buffer;
  at = 0;
  constructor(size: number) {
    this.bytes = Buffer.alloc(size);
  }
  u32(v: number): this {
    this.bytes.writeUInt32LE(v >>> 0, this.at);
    this.at += 4;
    return this;
  }
  u64(v: number): this {
    this.bytes.writeUInt32LE(v % 2 ** 32, this.at);
    this.bytes.writeUInt32LE(Math.floor(v / 2 ** 32), this.at + 4);
    this.at += 8;
    return this;
  }
  name16(s: string): this {
    this.bytes.write(s, this.at, 'latin1');
    this.at += 16;
    return this;
  }
  str(s: string, size: number): this {
    this.bytes.write(s, this.at, 'latin1');
    this.at += size;
    return this;
  }
  segment(
    name: string,
    vmaddr: number,
    vmsize: number,
    fileoff: number,
    filesize: number,
    prot: number,
    nsects: number,
    flags: number,
  ): this {
    return this.u32(0x19)
      .u32(72 + 80 * nsects)
      .name16(name)
      .u64(vmaddr)
      .u64(vmsize)
      .u64(fileoff)
      .u64(filesize)
      .u32(prot)
      .u32(prot)
      .u32(nsects)
      .u32(flags);
  }
  section(
    sect: string,
    seg: string,
    addr: number,
    size: number,
    offset: number,
    alignLog: number,
    flags: number,
    reserved2 = 0,
  ): this {
    return this.name16(sect)
      .name16(seg)
      .u64(addr)
      .u64(size)
      .u32(offset)
      .u32(alignLog)
      .u32(0)
      .u32(0)
      .u32(flags)
      .u32(0)
      .u32(reserved2)
      .u32(0);
  }
}

export interface MachOLayout {
  readonly textSize: number;
  readonly stubsOffset: number;
  readonly textSegSize: number;
  readonly constOffset: number;
  readonly dataVm: number;
  readonly dataVmSize: number;
  readonly linkeditOffset: number;
  readonly linkeditVm: number;
  readonly signatureOffset: number;
  readonly signatureSize: number;
  readonly pages: number;
  readonly fileSize: number;
}

/** The layout for a text section of `textSize` bytes and `bssSize` bytes of zero fill. */
export function machOLayout(textSize: number, bssSize: number): MachOLayout {
  const stubsOffset = TEXT_OFFSET + textSize;
  const textSegSize = align(stubsOffset + 12 * IMPORTS.length, SEG);
  const constOffset = textSegSize;
  const dataVm = constOffset + SEG;
  const dataVmSize = align(bssSize, SEG);
  const linkeditOffset = constOffset + SEG;
  const linkeditVm = dataVm + dataVmSize;
  const signatureOffset = align(linkeditOffset + FIXUPS_SIZE, 16);
  const pages = Math.ceil(signatureOffset / PAGE);
  const signatureSize = 20 + CD_HEADER + IDENTIFIER.length + 1 + 32 * pages;
  return {
    textSize,
    stubsOffset,
    textSegSize,
    constOffset,
    dataVm,
    dataVmSize,
    linkeditOffset,
    linkeditVm,
    signatureOffset,
    signatureSize,
    pages,
    fileSize: signatureOffset + signatureSize,
  };
}

/**
 * Link an encoded module into a signed executable whose entry is the text label `entry`.
 * Relocations: `branch26` to a label of the module or to an import (through its stub),
 * `page21` / `pageoff12` to a label or a bss symbol.
 */
export function linkMachO(mod: Arm64Module, entry: string): Buffer {
  const textSize = mod.words.length * 4;
  const L = machOLayout(textSize, mod.bssSize);
  const w = new Writer(L.fileSize);
  const entryOffset = mod.labels.get(entry);
  if (entryOffset === undefined) throw new Error(`macho: entry ${entry} is not defined`);
  const bss = new Map(mod.bss.map((b) => [b.name, b.offset]));

  // Header and load commands.
  w.u32(0xfeedfacf).u32(0x0100000c).u32(0).u32(2).u32(NCMDS).u32(SIZEOFCMDS).u32(0x200085).u32(0);
  w.segment('__PAGEZERO', 0, BASE, 0, 0, 0, 0, 0);
  w.segment('__TEXT', BASE, L.textSegSize, 0, L.textSegSize, 5, 2, 0);
  w.section('__text', '__TEXT', BASE + TEXT_OFFSET, textSize, TEXT_OFFSET, 2, 0x80000400);
  w.section(
    '__stubs',
    '__TEXT',
    BASE + L.stubsOffset,
    12 * IMPORTS.length,
    L.stubsOffset,
    2,
    0x80000408,
    12,
  );
  w.segment('__DATA_CONST', BASE + L.constOffset, SEG, L.constOffset, SEG, 3, 1, 0x10);
  w.section('__got', '__DATA_CONST', BASE + L.constOffset, 8 * IMPORTS.length, L.constOffset, 3, 6);
  w.segment('__DATA', BASE + L.dataVm, L.dataVmSize, 0, 0, 3, 1, 0);
  w.section('__bss', '__DATA', BASE + L.dataVm, mod.bssSize, 0, mod.bssAlign, 1);
  const linkeditSize = L.fileSize - L.linkeditOffset;
  w.segment(
    '__LINKEDIT',
    BASE + L.linkeditVm,
    align(linkeditSize, SEG),
    L.linkeditOffset,
    linkeditSize,
    1,
    0,
    0,
  );
  w.u32(0x80000034).u32(16).u32(L.linkeditOffset).u32(FIXUPS_SIZE);
  w.u32(0x2).u32(24).u32(0).u32(0).u32(0).u32(0);
  w.u32(0xb).u32(80);
  for (let i = 0; i < 18; i += 1) w.u32(0);
  w.u32(0xe).u32(32).u32(12).str('/usr/lib/dyld', 20);
  w.u32(0x32).u32(24).u32(1).u32(0x000b0000).u32(0x000b0000).u32(0);
  w.u32(0x80000028)
    .u32(24)
    .u64(TEXT_OFFSET + entryOffset)
    .u64(0);
  w.u32(0xc)
    .u32(56)
    .u32(24)
    .u32(2)
    .u32(0x054f0000)
    .u32(0x00010000)
    .str('/usr/lib/libSystem.B.dylib', 32);
  w.u32(0x1d).u32(16).u32(L.signatureOffset).u32(L.signatureSize);
  if (w.at !== 32 + SIZEOFCMDS) throw new Error('macho: load command size mismatch');

  // __text with the relocations applied, then the stubs.
  const words = [...mod.words];
  for (const r of mod.relocations) {
    const index = r.offset / 4;
    const pc = TEXT_OFFSET + r.offset;
    const label = mod.labels.get(r.symbol);
    const imp = IMPORTS.indexOf(r.symbol as (typeof IMPORTS)[number]);
    let target: number;
    if (label !== undefined) target = TEXT_OFFSET + label;
    else if (r.kind === 'branch26' && imp >= 0) target = L.stubsOffset + 12 * imp;
    else if (r.kind !== 'branch26' && bss.has(r.symbol))
      target = L.dataVm + (bss.get(r.symbol) as number);
    else throw new Error(`macho: undefined symbol ${r.symbol}`);
    const word = words[index] as number;
    if (r.kind === 'branch26') words[index] = (word | (((target - pc) / 4) & 0x3ffffff)) >>> 0;
    else if (r.kind === 'page21') words[index] = (word | pageBits(target, pc)) >>> 0;
    else words[index] = (word | ((target & 0xfff) << 10)) >>> 0;
  }
  w.at = TEXT_OFFSET;
  for (const word of words) w.u32(word);
  for (let i = 0; i < IMPORTS.length; i += 1) {
    const pc = L.stubsOffset + 12 * i;
    const got = L.constOffset + 8 * i;
    w.u32((0x90000010 | pageBits(got, pc)) >>> 0);
    w.u32((0xf9400210 | (((got & 0xfff) / 8) << 10)) >>> 0);
    w.u32(0xd61f0200);
  }

  // GOT: chained bind pointers (bind, next in 4-byte strides, import ordinal).
  w.at = L.constOffset;
  for (let i = 0; i < IMPORTS.length; i += 1) {
    const next = i + 1 < IMPORTS.length ? 2 : 0;
    w.u32(i).u32((0x80000000 | (next << 19)) >>> 0);
  }

  // Chained fixups.
  w.at = L.linkeditOffset;
  w.u32(0).u32(32).u32(80).u32(92).u32(IMPORTS.length).u32(1).u32(0).u32(0);
  w.u32(5).u32(0).u32(0).u32(24).u32(0).u32(0);
  w.u32(24)
    .u32(0x4000 | (6 << 16))
    .u64(L.constOffset)
    .u32(0)
    .u32(1);
  let nameOffset = 1;
  for (const name of IMPORTS) {
    w.u32((1 | (nameOffset << 9)) >>> 0);
    nameOffset += name.length + 1;
  }
  w.str(`\0${IMPORTS.join('\0')}\0`, FIXUPS_SIZE - 92);

  // Code signature.
  const sig = L.signatureOffset;
  const hashes: Buffer[] = [];
  for (let p = 0; p < L.pages; p += 1)
    hashes.push(
      createHash('sha256')
        .update(w.bytes.subarray(p * PAGE, Math.min((p + 1) * PAGE, sig)))
        .digest(),
    );
  const b = w.bytes;
  const cd = sig + 20;
  const cdLength = CD_HEADER + IDENTIFIER.length + 1 + 32 * L.pages;
  b.writeUInt32BE(0xfade0cc0, sig);
  b.writeUInt32BE(L.signatureSize, sig + 4);
  b.writeUInt32BE(1, sig + 8);
  b.writeUInt32BE(0, sig + 12);
  b.writeUInt32BE(20, sig + 16);
  const fields = [
    0xfade0c02,
    cdLength,
    0x20400,
    0x20002,
    CD_HEADER + IDENTIFIER.length + 1,
    CD_HEADER,
    0,
    L.pages,
    sig,
  ];
  for (const [i, v] of fields.entries()) b.writeUInt32BE(v, cd + 4 * i);
  b.writeUInt8(32, cd + 36);
  b.writeUInt8(2, cd + 37);
  b.writeUInt8(0, cd + 38);
  b.writeUInt8(12, cd + 39);
  // spare2, scatter, team, spare3, codeLimit64 (0); execSegBase 0; execSegLimit; flags 1.
  b.writeUInt32BE(L.textSegSize, cd + 76);
  b.writeUInt32BE(1, cd + 84);
  b.write(`${IDENTIFIER}\0`, cd + CD_HEADER, 'latin1');
  for (const [i, h] of hashes.entries()) h.copy(b, cd + CD_HEADER + IDENTIFIER.length + 1 + 32 * i);
  return b;
}

/** The adrp immediate bits for a target and pc (file offsets; the image base is page aligned). */
function pageBits(target: number, pc: number): number {
  const delta = (Math.floor(target / PAGE) - Math.floor(pc / PAGE)) & 0x1fffff;
  return ((delta & 3) << 29) | ((delta >> 2) << 5);
}

export interface ObjectText {
  readonly words: readonly number[];
  /** Relocation (byte offset, type) of the text section, as clang wrote it. */
  readonly relocations: readonly { readonly offset: number; readonly type: number }[];
}

/** The `__text` section of a Mach-O arm64 object file and its relocations. */
export function readObjectText(obj: Buffer): ObjectText {
  if (obj.readUInt32LE(0) !== 0xfeedfacf) throw new Error('not a 64-bit Mach-O file');
  const ncmds = obj.readUInt32LE(16);
  let at = 32;
  for (let c = 0; c < ncmds; c += 1) {
    const cmd = obj.readUInt32LE(at);
    const size = obj.readUInt32LE(at + 4);
    if (cmd === 0x19) {
      const nsects = obj.readUInt32LE(at + 64);
      for (let s = 0; s < nsects; s += 1) {
        const sa = at + 72 + 80 * s;
        const name = obj.toString('latin1', sa, sa + 16).replace(/\0+$/, '');
        if (name !== '__text') continue;
        const bytes = Number(obj.readBigUInt64LE(sa + 40));
        const offset = obj.readUInt32LE(sa + 48);
        const reloff = obj.readUInt32LE(sa + 56);
        const nreloc = obj.readUInt32LE(sa + 60);
        const words: number[] = [];
        for (let i = 0; i < bytes; i += 4) words.push(obj.readUInt32LE(offset + i));
        const relocations: { offset: number; type: number }[] = [];
        for (let r = 0; r < nreloc; r += 1) {
          const address = obj.readInt32LE(reloff + 8 * r);
          const info = obj.readUInt32LE(reloff + 8 * r + 4);
          relocations.push({ offset: address, type: info >>> 28 });
        }
        return { words, relocations };
      }
    }
    at += size;
  }
  return { words: [], relocations: [] };
}
