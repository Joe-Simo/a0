/** The assembly runtime of the arm64 stages (tools/bootstrap-arm64.ts, tools/bootstrap-macho.ts). */

import { STAGE_INPUT, STAGE_OUTPUT } from './bootstrap.js';

export const ENTRY = 'emitachunkio';
/** Virtual size of the stack the runtime maps for the compiler (aggregates live on it). */
export const STACK_GIB = 4;

/** Two instructions that put the 32-bit `v` into register `r`. */
const mov32 = (r: string, v: number): string =>
  `\tmovz ${r}, #${v & 0xffff}\n\tmovk ${r}, #${v >>> 16}, lsl #16\n`;

/**
 * The runtime of an arm64 stage, in assembly: `_main` reads stdin (little-endian words) into
 * the io input, maps a stack, runs the compiler on it, then writes the text bytes (the low byte
 * of each output word before the trailer) and the trailer words (4 bytes each), as the C stage
 * main does. The exit status is the diagnostic code; 64 input over capacity, 65 output capacity
 * reached, 66 a failed system call. The io helpers keep x19-x28 (the emitted code's
 * callee-saved registers) and use only caller-saved ones.
 */
export function runtime(): string {
  const inBytes = STAGE_INPUT * 4;
  const outBytes = STAGE_OUTPUT * 4;
  return `// Runtime of the arm64 stages (tools/bootstrap-arm64.ts): _main and the io of the emitted code.
\t.text
\t.globl _main
\t.p2align 2
_main:
\tstp x29, x30, [sp, #-16]!
\tmov x29, sp
\tstp x19, x20, [sp, #-16]!
\tstp x21, x22, [sp, #-16]!
\tadrp x19, _a0_in@PAGE
\tadd x19, x19, _a0_in@PAGEOFF
\tmov x20, #0
1:\tmov x0, #0
\tadd x1, x19, x20
${mov32('x2', inBytes + 4)}\tsub x2, x2, x20
\tcbz x2, 3f
\tbl _read
\tcmp x0, #0
\tb.lt 4f
\tb.eq 2f
\tadd x20, x20, x0
\tb 1b
2:${mov32('x9', inBytes)}\tcmp x20, x9
\tb.hi 3f
\tlsr x20, x20, #2
\tadrp x9, _a0_io@PAGE
\tadd x9, x9, _a0_io@PAGEOFF
\tstr w20, [x9]
\tmov x0, #0
\tmovz x1, #${STACK_GIB}, lsl #32
\tmov x2, #3
\tmov x3, #0x1002
\tmovn x4, #0
\tmov x5, #0
\tbl _mmap
\tcmn x0, #1
\tb.eq 4f
\tmovz x9, #${STACK_GIB}, lsl #32
\tadd x9, x0, x9
\tmov x21, sp
\tmov sp, x9
\tbl _a0_${ENTRY}
\tmov sp, x21
\tmov w22, w0
\tadrp x9, _a0_io@PAGE
\tadd x9, x9, _a0_io@PAGEOFF
\tldr w10, [x9, #8]
${mov32('w11', STAGE_OUTPUT)}\tcmp w10, w11
\tb.hs 5f
\tadrp x12, _a0_out@PAGE
\tadd x12, x12, _a0_out@PAGEOFF
\tmov w13, #0
\tcbz w10, 6f
\tsub w14, w10, #1
\tldr w13, [x12, w14, uxtw #2]
6:\tmov w14, #0
\tcmp w10, w13
\tb.ls 7f
\tsub w14, w10, w13
\tsub w14, w14, #1
7:\tadrp x15, _a0_bytes@PAGE
\tadd x15, x15, _a0_bytes@PAGEOFF
\tmov x16, x15
\tmov w17, #0
8:\tcmp w17, w10
\tb.hs 10f
\tldr w1, [x12, w17, uxtw #2]
\tstrb w1, [x16], #1
\tcmp w17, w14
\tb.lo 11f
\tlsr w2, w1, #8
\tstrb w2, [x16], #1
\tlsr w2, w1, #16
\tstrb w2, [x16], #1
\tlsr w2, w1, #24
\tstrb w2, [x16], #1
11:\tadd w17, w17, #1
\tb 8b
10:\tmov x19, x15
\tsub x20, x16, x15
12:\tcbz x20, 13f
\tmov x0, #1
\tmov x1, x19
\tmov x2, x20
\tbl _write
\tcmp x0, #0
\tb.le 4f
\tadd x19, x19, x0
\tsub x20, x20, x0
\tb 12b
13:\tmov w0, w22
\tb 9f
3:\tmov w0, #64
\tb 9f
5:\tmov w0, #65
\tb 9f
4:\tmov w0, #66
9:\tsub sp, x29, #32
\tldp x21, x22, [sp], #16
\tldp x19, x20, [sp], #16
\tldp x29, x30, [sp], #16
\tret

\t.globl _a0rt_read
\t.p2align 2
_a0rt_read:
\tadrp x16, _a0_io@PAGE
\tadd x16, x16, _a0_io@PAGEOFF
\tldr w9, [x16, #4]
\tldr w10, [x16]
\tcmp w9, w10
\tb.hs 1f
\tadrp x17, _a0_in@PAGE
\tadd x17, x17, _a0_in@PAGEOFF
\tldr w0, [x17, w9, uxtw #2]
\tadd w9, w9, #1
\tstr w9, [x16, #4]
\tret
1:\tmov w0, #0
\tret

\t.globl _a0rt_write
\t.p2align 2
_a0rt_write:
\tadrp x16, _a0_io@PAGE
\tadd x16, x16, _a0_io@PAGEOFF
\tldr w9, [x16, #8]
${mov32('w10', STAGE_OUTPUT)}\tcmp w9, w10
\tb.hs 1f
\tadrp x17, _a0_out@PAGE
\tadd x17, x17, _a0_out@PAGEOFF
\tstr w0, [x17, w9, uxtw #2]
\tadd w9, w9, #1
\tstr w9, [x16, #8]
1:\tret

\t.globl _a0rt_puts
\t.p2align 2
_a0rt_puts:
\tstp x29, x30, [sp, #-16]!
\tmov x29, sp
\tstp x19, x20, [sp, #-16]!
\tmov x19, x0
\tmov w20, w1
\tmov w0, w1
\tbl _a0rt_write
1:\tcbz w20, 2f
\tldr w0, [x19], #4
\tbl _a0rt_write
\tsub w20, w20, #1
\tb 1b
2:\tldp x19, x20, [sp], #16
\tldp x29, x30, [sp], #16
\tret

\t.zerofill __DATA,__bss,_a0_io,16,4
\t.zerofill __DATA,__bss,_a0_in,${inBytes + 4},4
\t.zerofill __DATA,__bss,_a0_out,${outBytes},4
\t.zerofill __DATA,__bss,_a0_bytes,${outBytes},4
`;
}
