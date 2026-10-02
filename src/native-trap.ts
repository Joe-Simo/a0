/**
 * The strict profile's trap runtime for the direct native backends (arm64, x86-64).
 *
 * A function that can trap (`mayTrapFn`) keeps a frame on a shadow stack in zero-filled data:
 * 32 bytes each, `{name, node, trip}` (the function's name, the fold or loop it is iterating as
 * a node-id string or 0, and its trip). The code at a trapping site is a compare and a branch
 * to one cold stub per function and kind, which loads the kind and jumps to the module's one
 * reporter. The reporter reads the stack and writes exactly the line the reference interpreter
 * and the C runtime print (`formatTrap`: `runtime: trap bounds fn=.. at=f.n trip=3 chain=a>b
 * fix: ..`) to stderr with the write system call, then exits with status 3. It uses no libc.
 *
 * Only the two traps these backends can raise exist here: `bounds` (0) and `divzero` (1); the
 * backends refuse io, so the `input` trap has no site.
 */

import type { TypedFunc } from './core.js';
import { TRAP_FIX } from './diagnostics.js';
import { mayTrapFn } from './optimize.js';

/** Size in bytes of one shadow-stack frame: name pointer, node pointer, trip (padded). */
export const FRAME_BYTES = 32;
/** Bytes before the first frame: the current depth in bytes (a 64-bit word) and padding. */
export const FRAME_BASE = 16;

/** The trap kinds in the numbering the stubs use. */
export const NATIVE_TRAPS = [
  ['bounds', TRAP_FIX.bounds],
  ['divzero', TRAP_FIX.divzero],
] as const;

export type NativeTrapKind = 'bounds' | 'divzero';
export const trapIndex = (kind: NativeTrapKind): number => (kind === 'bounds' ? 0 : 1);

/** What a module needs of the runtime: the frame area and the line buffer, sized from its functions. */
export interface TrapModule {
  readonly stackBytes: number;
  readonly bufferBytes: number;
}

/** The runtime a module of `program` needs, or undefined when no function of it can trap. */
export function trapModuleOf(program: {
  readonly functions: readonly TypedFunc[];
}): TrapModule | undefined {
  if (!program.functions.some(mayTrapFn)) return undefined;
  const depth = program.functions.length + 1;
  const names = program.functions.reduce((n, f) => n + f.name.length + 1, 0);
  const ids = Math.max(1, ...program.functions.flatMap((f) => f.nodes.map((n) => n.id.length)));
  return {
    stackBytes: FRAME_BASE + FRAME_BYTES * depth,
    bufferBytes: 1024 + 3 * (names + depth * (ids + 2)),
  };
}

/** The texts the reporter copies, as `[label suffix, text]`. */
function texts(): readonly (readonly [string, string])[] {
  return [
    ['head', 'runtime: trap '],
    ['k0', NATIVE_TRAPS[0][0]],
    ['k1', NATIVE_TRAPS[1][0]],
    ['fn', ' fn='],
    ['at', ' at='],
    ['trip', ' trip='],
    ['none', '- trip=-'],
    ['chain', ' chain='],
    ['fix', ' fix: '],
    ['f0', NATIVE_TRAPS[0][1]],
    ['f1', NATIVE_TRAPS[1][1]],
  ];
}

const asciz = (s: string): string => `\t.asciz ${JSON.stringify(s)}`;

/**
 * AArch64 (Darwin): `_a0_trap` takes the kind in w16. The state `_a0_ts` is the depth in bytes
 * at offset 0 and the frames from offset 16. Zero-fill data comes last; strings sit after the code.
 */
export function arm64TrapRuntime(mod: TrapModule): string {
  const S = (k: string): string => `La0r_${k}`;
  const lines: string[] = [
    '_a0_cpy:',
    '1:\tldrb w11, [x10], #1',
    '\tcbz w11, 2f',
    '\tstrb w11, [x9], #1',
    '\tb 1b',
    '2:\tret',
    '_a0_dec:',
    '\tmov w11, w10',
    '\tmov w12, #10',
    '\tmov w13, #1',
    '1:\tcmp w11, #10',
    '\tb.lo 2f',
    '\tudiv w11, w11, w12',
    '\tadd w13, w13, #1',
    '\tb 1b',
    '2:\tadd x14, x9, x13',
    '\tmov x15, x14',
    '\tmov w11, w10',
    '3:\tudiv w16, w11, w12',
    '\tmsub w17, w16, w12, w11',
    '\tadd w17, w17, #48',
    '\tstrb w17, [x15, #-1]!',
    '\tmov w11, w16',
    '\tcbnz w11, 3b',
    '\tmov x9, x14',
    '\tret',
    '_a0_trap:',
    '\tmov w20, w16',
    '\tadrp x9, _a0_tb@PAGE',
    '\tadd x9, x9, _a0_tb@PAGEOFF',
    '\tmov x23, x9',
    `\tadr x10, ${S('head')}`,
    '\tbl _a0_cpy',
    '\tcbnz w20, 1f',
    `\tadr x10, ${S('k0')}`,
    `\tadr x24, ${S('f0')}`,
    '\tb 2f',
    `1:\tadr x10, ${S('k1')}`,
    `\tadr x24, ${S('f1')}`,
    '2:\tbl _a0_cpy',
    `\tadr x10, ${S('fn')}`,
    '\tbl _a0_cpy',
    '\tadrp x21, _a0_ts@PAGE',
    '\tadd x21, x21, _a0_ts@PAGEOFF',
    '\tldr x22, [x21]',
    `\tadd x25, x21, #${FRAME_BASE}`,
    '\tadd x26, x25, x22',
    `\tldur x10, [x26, #-${FRAME_BYTES}]`,
    '\tbl _a0_cpy',
    `\tadr x10, ${S('at')}`,
    '\tbl _a0_cpy',
    '\tmov x27, x26',
    '3:\tcmp x27, x25',
    '\tb.ls 5f',
    `\tsub x27, x27, #${FRAME_BYTES}`,
    '\tldr x11, [x27, #8]',
    '\tcbz x11, 3b',
    '\tldr x10, [x27]',
    '\tbl _a0_cpy',
    '\tmov w11, #46',
    '\tstrb w11, [x9], #1',
    '\tldr x10, [x27, #8]',
    '\tbl _a0_cpy',
    `\tadr x10, ${S('trip')}`,
    '\tbl _a0_cpy',
    '\tldr w10, [x27, #16]',
    '\tbl _a0_dec',
    '\tb 6f',
    `5:\tadr x10, ${S('none')}`,
    '\tbl _a0_cpy',
    `6:\tadr x10, ${S('chain')}`,
    '\tbl _a0_cpy',
    '\tmov x27, x25',
    '7:\tcmp x27, x26',
    '\tb.hs 9f',
    '\tcmp x27, x25',
    '\tb.eq 8f',
    '\tmov w11, #62',
    '\tstrb w11, [x9], #1',
    '8:\tldr x10, [x27]',
    '\tbl _a0_cpy',
    `\tadd x27, x27, #${FRAME_BYTES}`,
    '\tb 7b',
    `9:\tadr x10, ${S('fix')}`,
    '\tbl _a0_cpy',
    '\tmov x10, x24',
    '\tbl _a0_cpy',
    '\tmov w11, #10',
    '\tstrb w11, [x9], #1',
    '\tmov x0, #2',
    '\tmov x1, x23',
    '\tsub x2, x9, x23',
    '\tmov x16, #4',
    '\tsvc #0x80',
    '\tmov x0, #3',
    '\tmov x16, #1',
    '\tsvc #0x80',
    ...texts().flatMap(([k, t]) => [`${S(k)}:`, asciz(t)]),
    '\t.p2align 2',
    `\t.zerofill __DATA,__bss,_a0_ts,${mod.stackBytes},4`,
    `\t.zerofill __DATA,__bss,_a0_tb,${mod.bufferBytes},4`,
  ];
  return lines.join('\n');
}

/**
 * x86-64: `a0_trap` takes the kind in eax (`_a0_trap` on macOS). The state and the frames are
 * laid out as on arm64; the system call numbers are the platform's.
 */
export function x86TrapRuntime(mod: TrapModule, platform: 'darwin' | 'linux'): string {
  const u = platform === 'darwin' ? '_' : '';
  const L = platform === 'darwin' ? 'L' : '.L';
  const S = (k: string): string => `${L}a0r_${k}`;
  const lines: string[] = [
    `${u}a0_cpy:`,
    '1:\tmovb (%rsi), %al',
    '\ttestb %al, %al',
    '\tje 2f',
    '\tmovb %al, (%rdi)',
    '\tincq %rdi',
    '\tincq %rsi',
    '\tjmp 1b',
    '2:\tret',
    `${u}a0_dec:`,
    '\tmovl %eax, %r11d',
    '\tmovl $10, %esi',
    '\tmovl $1, %ecx',
    '\tmovl %eax, %r10d',
    '1:\tcmpl $10, %r10d',
    '\tjb 2f',
    '\tmovl %r10d, %eax',
    '\txorl %edx, %edx',
    '\tdivl %esi',
    '\tmovl %eax, %r10d',
    '\tincl %ecx',
    '\tjmp 1b',
    '2:\taddq %rdi, %rcx',
    '\tmovq %rcx, %r8',
    '\tmovl %r11d, %eax',
    '3:\txorl %edx, %edx',
    '\tdivl %esi',
    '\taddl $48, %edx',
    '\tdecq %r8',
    '\tmovb %dl, (%r8)',
    '\ttestl %eax, %eax',
    '\tjne 3b',
    '\tmovq %rcx, %rdi',
    '\tret',
    `${u}a0_trap:`,
    '\tmovl %eax, %r12d',
    `\tleaq ${u}a0_tb(%rip), %rdi`,
    '\tmovq %rdi, %r13',
    `\tleaq ${S('head')}(%rip), %rsi`,
    `\tcall ${u}a0_cpy`,
    '\ttestl %r12d, %r12d',
    '\tjne 1f',
    `\tleaq ${S('k0')}(%rip), %rsi`,
    `\tleaq ${S('f0')}(%rip), %rbp`,
    '\tjmp 2f',
    `1:\tleaq ${S('k1')}(%rip), %rsi`,
    `\tleaq ${S('f1')}(%rip), %rbp`,
    `2:\tcall ${u}a0_cpy`,
    `\tleaq ${S('fn')}(%rip), %rsi`,
    `\tcall ${u}a0_cpy`,
    `\tleaq ${u}a0_ts(%rip), %r14`,
    '\tmovq (%r14), %r15',
    `\tleaq ${FRAME_BASE}(%r14), %rbx`,
    '\taddq %rbx, %r15',
    `\tmovq -${FRAME_BYTES}(%r15), %rsi`,
    `\tcall ${u}a0_cpy`,
    `\tleaq ${S('at')}(%rip), %rsi`,
    `\tcall ${u}a0_cpy`,
    '\tmovq %r15, %r14',
    '3:\tcmpq %rbx, %r14',
    '\tjbe 5f',
    `\tsubq $${FRAME_BYTES}, %r14`,
    '\tcmpq $0, 8(%r14)',
    '\tje 3b',
    '\tmovq (%r14), %rsi',
    `\tcall ${u}a0_cpy`,
    '\tmovb $46, (%rdi)',
    '\tincq %rdi',
    '\tmovq 8(%r14), %rsi',
    `\tcall ${u}a0_cpy`,
    `\tleaq ${S('trip')}(%rip), %rsi`,
    `\tcall ${u}a0_cpy`,
    '\tmovl 16(%r14), %eax',
    `\tcall ${u}a0_dec`,
    '\tjmp 6f',
    `5:\tleaq ${S('none')}(%rip), %rsi`,
    `\tcall ${u}a0_cpy`,
    `6:\tleaq ${S('chain')}(%rip), %rsi`,
    `\tcall ${u}a0_cpy`,
    '\tmovq %rbx, %r14',
    '7:\tcmpq %r15, %r14',
    '\tjae 9f',
    '\tcmpq %rbx, %r14',
    '\tje 8f',
    '\tmovb $62, (%rdi)',
    '\tincq %rdi',
    '8:\tmovq (%r14), %rsi',
    `\tcall ${u}a0_cpy`,
    `\taddq $${FRAME_BYTES}, %r14`,
    '\tjmp 7b',
    `9:\tleaq ${S('fix')}(%rip), %rsi`,
    `\tcall ${u}a0_cpy`,
    '\tmovq %rbp, %rsi',
    `\tcall ${u}a0_cpy`,
    '\tmovb $10, (%rdi)',
    '\tincq %rdi',
    '\tmovq %rdi, %rdx',
    '\tsubq %r13, %rdx',
    '\tmovq %r13, %rsi',
    '\tmovl $2, %edi',
    `\tmovl $${platform === 'darwin' ? '0x2000004' : '1'}, %eax`,
    '\tsyscall',
    '\tmovl $3, %edi',
    `\tmovl $${platform === 'darwin' ? '0x2000001' : '231'}, %eax`,
    '\tsyscall',
    ...texts().flatMap(([k, t]) => [`${S(k)}:`, asciz(t)]),
  ];
  if (platform === 'darwin')
    lines.push(
      '\t.p2align 2',
      `\t.zerofill __DATA,__bss,_a0_ts,${mod.stackBytes},4`,
      `\t.zerofill __DATA,__bss,_a0_tb,${mod.bufferBytes},4`,
    );
  else
    lines.push(
      '\t.bss',
      '\t.balign 16',
      'a0_ts:',
      `\t.zero ${mod.stackBytes}`,
      'a0_tb:',
      `\t.zero ${mod.bufferBytes}`,
      '\t.text',
    );
  return lines.join('\n');
}
