/**
 * Cross-toolchain execution checks. Each path executes the generated code on the
 * full case set and compares against the independent BigInt oracle. Missing tools
 * are recorded as "blocked", never as passes. Writes results/verification.json.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { AVR_FLASH_BYTES, AVR_SRAM_BYTES, avrStackBytes } from '../src/avr.js';
import {
  C_IO_INPUT_CAPACITY,
  C_IO_OUTPUT_CAPACITY,
  type CParallel,
  compile,
  cSignature,
  JAVA_CLASS,
  usesIo,
} from '../src/backends.js';

import {
  formatProgram,
  makeIo,
  run,
  type TypedFunc,
  type TypedProgram,
  type Value,
} from '../src/core.js';
import { optimize } from '../src/optimize.js';
import { parallelC, planProgram } from '../src/parallel.js';
import {
  compileWasm,
  findArmGcc,
  findAvrGcc,
  findClang,
  findClangPlusPlus,
  findGcc,
  findJava,
  findJavac,
  findQemuRiscv64,
  findQemuSystemArm,
  findRiscv64Gcc,
  findSimavr,
  findWasmClang,
  runTool,
  type ToolInfo,
  type ToolResult,
  withTempDir,
} from '../src/toolchain.js';
import { wasmModuleBytes } from '../src/wasm.js';
import {
  type Case,
  CORPUS_SEED,
  corpusSha256,
  generateCases,
  generateCorpus,
  hasIoParam,
  INPUT_SEED,
  ioFreeSubset,
  isDriverCallable,
} from './corpus.js';

export interface TargetReport {
  status: 'passed' | 'failed' | 'blocked' | 'unverified';
  cases: number;
  detail: string;
  tool?: string | undefined;
  elapsedMs?: number | undefined;
  failures?: string[] | undefined;
}

const fmt = (v: Value): string => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

/** Expected line: result, then the output words for io functions. */
function expectedLine(c: Case): string {
  return c.expectedOutput === undefined
    ? fmt(c.expected)
    : [fmt(c.expected), ...c.expectedOutput.map(String)].join(' ');
}

/** Run one case in-process (interpreter or optimized graph), threading an io state when needed. */
function runCase(fn: TypedFunc, c: Case): string {
  if (c.input === undefined) return fmt(run(fn, c.args));
  const state = makeIo(c.input);
  const result = fmt(run(fn, [...c.args, state]));
  return [result, ...state.output.map(String)].join(' ');
}

function compareAll(
  cases: readonly Case[],
  actual: readonly string[],
  label: string,
): TargetReport {
  const failures: string[] = [];
  cases.forEach((c, i) => {
    const got = actual[i]?.trim();
    if (got !== expectedLine(c)) {
      failures.push(
        `${c.functionName}(${c.args.map(fmt).join(',')}${c.input ? ` | in ${c.input.join(',')}` : ''}) expected ${expectedLine(c)} got ${got ?? '<missing>'}`,
      );
    }
  });
  return failures.length === 0
    ? { status: 'passed', cases: cases.length, detail: label }
    : { status: 'failed', cases: cases.length, detail: label, failures: failures.slice(0, 20) };
}

function timed(report: TargetReport, start: number): TargetReport {
  return { ...report, elapsedMs: performance.now() - start };
}

function blocked(tool: ToolInfo, detail: string): TargetReport {
  return { status: 'blocked', cases: 0, detail: `${detail}: ${tool.name} not found` };
}

// --- interpreter / optimizer ------------------------------------------------

export function checkInterpreter(program: TypedProgram, cases: readonly Case[]): TargetReport {
  const start = performance.now();
  const actual = cases.map((c) => runCase(program.byName.get(c.functionName) as TypedFunc, c));
  return timed(compareAll(cases, actual, 'Reference interpreter vs BigInt oracle'), start);
}

export function checkOptimizer(
  program: TypedProgram,
  cases: readonly Case[],
): TargetReport & { before: number; after: number } {
  const start = performance.now();
  const { program: opt, stats } = optimize(program);
  const actual = cases.map((c) => runCase(opt.byName.get(c.functionName) as TypedFunc, c));
  return {
    ...timed(compareAll(cases, actual, 'Optimized graph vs BigInt oracle'), start),
    before: stats.before,
    after: stats.after,
  };
}

// --- JavaScript --------------------------------------------------------------

export async function checkJs(
  program: TypedProgram,
  cases: readonly Case[],
): Promise<TargetReport> {
  const start = performance.now();
  const js = compile(program, 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  )) as Record<string, (...a: Value[]) => Value> & {
    a0_make_io: (input: number[]) => { output: number[] };
  };
  const actual = cases.map((c) => {
    const f = mod[c.functionName];
    if (typeof f !== 'function') return '<missing>';
    if (c.input === undefined) return fmt(f(...c.args));
    const state = mod.a0_make_io([...c.input]);
    const result = fmt(f(...c.args, state as unknown as Value));
    return [result, ...state.output.map(String)].join(' ');
  });
  return timed(
    compareAll(cases, actual, 'Executed emitted ES module in Node; public input guards retained.'),
    start,
  );
}

// --- native C / C++ ----------------------------------------------------------

/**
 * The C test harness. `header` supplies the functions: by default the generated C module is
 * included; the arm64 path passes extern prototypes of the `_a0_*` symbols in the linked
 * object instead (scalar signatures, so the Darwin C ABI and the backend's ABI coincide).
 */
/** io buffer capacities large enough for every case (the backend defaults are the floor). */
export function ioCaps(cases: readonly Case[]): {
  ioInputCapacity: number;
  ioOutputCapacity: number;
} {
  let inCap = C_IO_INPUT_CAPACITY;
  let outCap = C_IO_OUTPUT_CAPACITY;
  for (const c of cases) {
    if (c.input !== undefined) inCap = Math.max(inCap, c.input.length + 1);
    if (c.expectedOutput !== undefined) outCap = Math.max(outCap, c.expectedOutput.length + 1);
  }
  return { ioInputCapacity: inCap, ioOutputCapacity: outCap };
}

export function cDriver(program: TypedProgram, header = '#include "module.c"'): string {
  const dispatch = program.functions.map((fn, i) => {
    if (!isDriverCallable(fn)) return `    case ${i}: printf("skip\\n"); break;`;
    const io = hasIoParam(fn);
    const scalars = io ? fn.params.slice(0, -1) : fn.params;
    const args = scalars
      .map((t, p) =>
        t === 'u32' ? `(uint32_t)strtoul(tok[${p}], NULL, 10)` : `(bool)(tok[${p}][0] == '1')`,
      )
      .concat(io ? ['&io'] : [])
      .join(', ');
    const print = fn.result === 'u32' ? 'printf("%u", (unsigned)r);' : 'printf("%d", r ? 1 : 0);';
    const setup = io
      ? `memset(&io, 0, sizeof io); { const uint32_t cap = (uint32_t)(sizeof io.input / sizeof io.input[0]), avail = (uint32_t)(m - ${scalars.length + 1}), want = (uint32_t)strtoul(tok[${scalars.length}], NULL, 10); io.ninput = want < cap ? want : cap; if (io.ninput > avail) io.ninput = avail; } for (uint32_t k = 0; k < io.ninput; k++) io.input[k] = (uint32_t)strtoul(tok[${scalars.length + 1}u + k], NULL, 10); `
      : '';
    const flush = io
      ? ' for (uint32_t k = 0; k < io.noutput; k++) printf(" %u", (unsigned)io.output[k]);'
      : '';
    const need = scalars.length + (io ? 1 : 0);
    return `    case ${i}: { if (m < ${need}) { printf("?\\n"); break; } ${setup}${fn.result === 'u32' ? 'uint32_t' : 'bool'} r = a0_${fn.name}(${args}); ${print}${flush} printf("\\n"); break; }`;
  });
  return `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
${header}
int main(void) {
  static char line[1 << 21]; /* one case per line: up to 2^18 words (a 131072-byte front-end source) */
${usesIo(program) ? '  static a0_io io; (void)io;\n' : ''}  while (fgets(line, sizeof line, stdin)) {
    static char *tok[1 << 18]; int n = 0;
    for (char *p = strtok(line, " \\n"); p && n < (1 << 18); p = strtok(NULL, " \\n")) tok[n++] = p;
    if (n < 1) continue;
    int idx = atoi(tok[0]);
    memmove(tok, tok + 1, sizeof(char*) * (size_t)(n - 1));
    const int m = n - 1; (void)m;
    switch (idx) {
${dispatch.join('\n')}
    default: printf("?\\n");
    }
  }
  return 0;
}
`;
}

function caseInput(program: TypedProgram, cases: readonly Case[]): string {
  const index = new Map(program.functions.map((f, i) => [f.name, i] as const));
  return `${cases
    .map((c) => {
      const tokens = [String(index.get(c.functionName)), ...c.args.map(fmt)];
      if (c.input !== undefined) tokens.push(String(c.input.length), ...c.input.map(String));
      return tokens.join(' ');
    })
    .join('\n')}\n`;
}

export async function checkNative(
  program: TypedProgram,
  cases: readonly Case[],
  tool: ToolInfo,
  asCpp: boolean,
  label: string,
  /** C module to test instead of the TypeScript emitter's (tools/selfhost-c.ts). */
  source?: string,
): Promise<TargetReport> {
  if (tool.path === undefined) return blocked(tool, label);
  const start = performance.now();
  const cSource = source ?? compile(program, 'c', ioCaps(cases)).text;
  return withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.c'), cSource, 'utf8');
    const driver = join(dir, asCpp ? 'driver.cpp' : 'driver.c');
    await writeFile(driver, cDriver(program), 'utf8');
    const exe = join(dir, 'driver');
    const args = [
      asCpp ? '-std=c++17' : '-std=c11',
      '-O1',
      '-Wall',
      '-Wextra',
      '-Wno-unused-parameter',
      '-Werror',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      '-o',
      exe,
      driver,
    ];
    let build = runTool(tool.path as string, args, { cwd: dir });
    let sanitizer = 'undefined-behavior sanitizer enabled';
    if (!build.ok && /ubsan/.test(build.stderr)) {
      // GNU GCC on macOS ships no libubsan; rerun without the sanitizer and say so.
      build = runTool(
        tool.path as string,
        args.filter((a) => !a.startsWith('-fsanitize') && !a.startsWith('-fno-sanitize')),
        { cwd: dir },
      );
      sanitizer = 'sanitizer UNAVAILABLE for this compiler (libubsan missing); plain build';
    }
    if (!build.ok)
      return {
        status: 'failed',
        cases: 0,
        detail: `${label}: build failed`,
        tool: tool.version,
        failures: [build.stderr.slice(0, 2000)],
      };
    const exec = runTool(exe, [], { input: caseInput(program, cases), cwd: dir });
    if (!exec.ok)
      return {
        status: 'failed',
        cases: 0,
        detail: `${label}: execution failed`,
        tool: tool.version,
        failures: [exec.stderr.slice(0, 2000)],
      };
    const actual = exec.stdout.trim().split('\n');
    return {
      ...timed(
        compareAll(
          cases,
          actual,
          `${label}; ${sanitizer}; C++ path compiles the C-compatible output, not a C++ frontend.`,
        ),
        start,
      ),
      tool: tool.version,
    };
  });
}

// --- native arm64 (direct assembly, no C for the program) ----------------------

/**
 * Assemble `asm` (Darwin arm64, `_a0_<name>` symbols with the C-compatible scalar
 * convention) with `clang -x assembler`, link it with the C test driver of `program`, and
 * execute `cases` against the oracle. Shared by the TypeScript backend's check and the
 * self-hosted emitter's (tools/selfhost-verify.ts).
 */
export async function checkArm64Assembly(
  program: TypedProgram,
  asm: string,
  cases: readonly Case[],
  tool: ToolInfo,
  label: string,
): Promise<TargetReport> {
  if (tool.path === undefined) return blocked(tool, 'arm64');
  const protos = [
    '#include <stdint.h>',
    '#include <stdbool.h>',
    ...program.functions.filter(isDriverCallable).map((f) => `extern ${cSignature(f)};`),
  ].join('\n');
  const fail = (what: string, stderr: string): TargetReport => ({
    status: 'failed',
    cases: 0,
    detail: `arm64: ${what}`,
    tool: tool.version,
    failures: [stderr.slice(0, 2000)],
  });
  const report = await withTempDir(async (dir): Promise<TargetReport> => {
    await writeFile(join(dir, 'module.s'), asm, 'utf8');
    await writeFile(join(dir, 'driver.c'), cDriver(program, protos), 'utf8');
    const as = runTool(
      tool.path as string,
      ['-c', '-x', 'assembler', '-o', 'module.o', 'module.s'],
      {
        cwd: dir,
      },
    );
    if (!as.ok) return fail(`${label}: assembly failed`, as.stderr);
    const link = runTool(
      tool.path as string,
      ['-std=c11', '-O1', '-Wall', '-Wextra', '-Werror', '-o', 'driver', 'driver.c', 'module.o'],
      { cwd: dir },
    );
    if (!link.ok) return fail(`${label}: driver build/link failed`, link.stderr);
    const exec = runTool(join(dir, 'driver'), [], { input: caseInput(program, cases), cwd: dir });
    if (!exec.ok) return fail(`${label}: execution failed`, exec.stderr);
    return compareAll(cases, exec.stdout.trim().split('\n'), label);
  });
  return { ...report, tool: tool.version };
}

export async function checkArm64(
  program: TypedProgram,
  cases: readonly Case[],
  tool: ToolInfo,
): Promise<TargetReport & { skippedIoFunctions: number; skippedIoCases: number }> {
  const subset = ioFreeSubset(program);
  const keep = new Set(subset.functions.map((f) => f.name));
  const own = cases.filter((c) => keep.has(c.functionName));
  const skipped = {
    skippedIoFunctions: program.functions.length - subset.functions.length,
    skippedIoCases: cases.length - own.length,
  };
  const label = `native arm64 assembly (src/arm64.ts) via ${'`clang -x assembler`'}, linked with the C test driver; ${skipped.skippedIoFunctions} io functions (${skipped.skippedIoCases} cases) skipped: io is out of scope for this backend`;
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return {
      status: 'blocked',
      cases: 0,
      detail: `arm64: needs macOS on Apple silicon, found ${process.platform}-${process.arch}`,
      ...skipped,
    };
  if (tool.path === undefined) return { ...blocked(tool, 'arm64'), ...skipped };
  const start = performance.now();
  // Both the optimized emission and the unoptimized one (every source op reaches the backend).
  let report: TargetReport | undefined;
  for (const optimize of [true, false]) {
    const asm = compile(subset, 'arm64', { optimize }).text;
    const level = optimize ? 'optimized' : 'unoptimized';
    const r = await checkArm64Assembly(subset, asm, own, tool, `${level}: ${label}`);
    if (r.status !== 'passed') return { ...r, ...skipped };
    report = r;
  }
  return {
    ...timed(
      {
        ...(report as TargetReport),
        detail: `${label}; optimized and unoptimized emissions each executed on every case`,
      },
      start,
    ),
    tool: tool.version,
    ...skipped,
  };
}

// --- native x86-64 (direct assembly; under Rosetta on Apple silicon) ------------

/** How this host can build and run x86-64 code: natively, through Rosetta, or not at all. */
function x86Host(clang: string): { arch: string[]; runner: string[] } | string {
  if (process.arch === 'x64' && (process.platform === 'darwin' || process.platform === 'linux'))
    return { arch: [], runner: [] };
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return `needs macOS or Linux on x86-64, or macOS on Apple silicon with Rosetta; found ${process.platform}-${process.arch}`;
  if (!runTool('/usr/bin/arch', ['-x86_64', '/usr/bin/true']).ok)
    return 'Rosetta 2 is not installed (softwareupdate --install-rosetta)';
  const probe = runTool(clang, ['-arch', 'x86_64', '-x', 'c', '-o', '/dev/null', '-'], {
    input: 'int main(void) { return 0; }\n',
  });
  if (!probe.ok)
    return `clang cannot build for x86_64 (no x86_64 SDK slice): ${probe.stderr.slice(0, 200)}`;
  return { arch: ['-arch', 'x86_64'], runner: ['/usr/bin/arch', '-x86_64'] };
}

export async function checkX86_64(
  program: TypedProgram,
  cases: readonly Case[],
  tool: ToolInfo,
): Promise<TargetReport & { skippedIoFunctions: number; skippedIoCases: number }> {
  const subset = ioFreeSubset(program);
  const keep = new Set(subset.functions.map((f) => f.name));
  const own = cases.filter((c) => keep.has(c.functionName));
  const skipped = {
    skippedIoFunctions: program.functions.length - subset.functions.length,
    skippedIoCases: cases.length - own.length,
  };
  const label = `native x86-64 assembly (src/x86_64.ts) via ${'`clang -x assembler`'}, linked with the C test driver; ${skipped.skippedIoFunctions} io functions (${skipped.skippedIoCases} cases) skipped: io is out of scope for this backend`;
  if (tool.path === undefined) return { ...blocked(tool, 'x86_64'), ...skipped };
  const host = x86Host(tool.path);
  if (typeof host === 'string')
    return { status: 'blocked', cases: 0, detail: `x86_64: ${host}`, ...skipped };
  const how =
    host.runner.length === 0 ? 'executed natively' : 'executed under Rosetta 2 (arch -x86_64)';
  const start = performance.now();
  const protos = [
    '#include <stdint.h>',
    '#include <stdbool.h>',
    ...subset.functions.filter(isDriverCallable).map((f) => `extern ${cSignature(f)};`),
  ].join('\n');
  const fail = (what: string, stderr: string): TargetReport & typeof skipped => ({
    status: 'failed',
    cases: 0,
    detail: `x86_64: ${what}`,
    tool: tool.version,
    failures: [stderr.slice(0, 2000)],
    ...skipped,
  });
  let report: TargetReport | undefined;
  for (const optimize of [true, false]) {
    const asm = compile(subset, 'x86_64', { optimize }).text;
    const level = optimize ? 'optimized' : 'unoptimized';
    const r = await withTempDir(async (dir): Promise<TargetReport> => {
      await writeFile(join(dir, 'module.s'), asm, 'utf8');
      await writeFile(join(dir, 'driver.c'), cDriver(subset, protos), 'utf8');
      const as = runTool(
        tool.path as string,
        [...host.arch, '-c', '-x', 'assembler', '-o', 'module.o', 'module.s'],
        { cwd: dir },
      );
      if (!as.ok) return fail(`${level}: assembly failed`, as.stderr);
      const link = runTool(
        tool.path as string,
        [
          ...host.arch,
          '-std=c11',
          '-O1',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-o',
          'driver',
          'driver.c',
          'module.o',
        ],
        { cwd: dir },
      );
      if (!link.ok) return fail(`${level}: driver build/link failed`, link.stderr);
      const [cmd, ...pre] =
        host.runner.length === 0 ? [join(dir, 'driver')] : [...host.runner, join(dir, 'driver')];
      const exec = runTool(cmd as string, pre, { input: caseInput(subset, own), cwd: dir });
      if (!exec.ok) return fail(`${level}: execution failed`, exec.stderr);
      return compareAll(own, exec.stdout.trim().split('\n'), `${level}: ${label}`);
    });
    if (r.status !== 'passed') return { ...r, tool: tool.version, ...skipped };
    report = r;
  }
  return {
    ...timed(
      {
        ...(report as TargetReport),
        detail: `${label}; ${how}; optimized and unoptimized emissions each executed on every case`,
      },
      start,
    ),
    tool: tool.version,
    ...skipped,
  };
}

// --- native AVR (direct assembly for the ATmega328P, run under libsimavr) --------------

/**
 * The simulator host: loads an ATmega328P ELF into libsimavr, captures every byte the
 * firmware sends on UART0 into the output file, and runs until the firmware sleeps with
 * interrupts off (simavr's graceful stop). Exit 5 means the simulated part crashed.
 */
const AVR_HOST = `#include <stdio.h>
#include <simavr/sim_avr.h>
#include <simavr/sim_elf.h>
#include <simavr/avr_uart.h>
static void uart_out(struct avr_irq_t *irq, uint32_t v, void *p) { (void)irq; fputc((int)(v & 0xff), (FILE *)p); }
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  elf_firmware_t f = {0};
  if (elf_read_firmware(argv[1], &f) != 0) return 3;
  avr_t *avr = avr_make_mcu_by_name("atmega328p");
  if (avr == NULL) return 4;
  avr_init(avr);
  avr->frequency = 16000000;
  avr_load_firmware(avr, &f);
  FILE *out = fopen(argv[2], "w");
  if (out == NULL) return 6;
  uint32_t flags = 0;
  avr_ioctl(avr, AVR_IOCTL_UART_GET_FLAGS('0'), &flags);
  flags &= ~(uint32_t)AVR_UART_FLAG_STDIO;
  avr_ioctl(avr, AVR_IOCTL_UART_SET_FLAGS('0'), &flags);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_OUTPUT), uart_out, out);
  int state;
  do state = avr_run(avr); while (state != cpu_Done && state != cpu_Crashed);
  fclose(out);
  return state == cpu_Done ? 0 : 5;
}
`;

/** Firmware for one function: its cases in program memory, one decimal result line each on UART0. */
function avrDriver(fn: TypedFunc, cases: readonly Case[]): string {
  const width = Math.max(1, fn.params.length);
  const rows = cases.map((c) => {
    const words =
      c.args.length === 0 ? [0] : c.args.map((v) => (v === true ? 1 : v === false ? 0 : v));
    return `  {${words.map((v) => `${String(v)}UL`).join(', ')}},`;
  });
  const args = fn.params
    .map((t, p) => `${t === 'bool' ? '(bool)' : ''}pgm_read_dword(&cases[i][${p}])`)
    .join(', ');
  const print =
    fn.result === 'bool'
      ? "tx(r ? '1' : '0');"
      : 'char buf[11]; ultoa(r, buf, 10); for (char *s = buf; *s; s++) tx(*s);';
  return `#include <avr/interrupt.h>
#include <avr/io.h>
#include <avr/pgmspace.h>
#include <avr/sleep.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
extern ${cSignature(fn)};
static const uint32_t cases[${cases.length}][${width}] PROGMEM = {
${rows.join('\n')}
};
static void tx(char c) {
  loop_until_bit_is_set(UCSR0A, UDRE0);
  UDR0 = (uint8_t)c;
}
int main(void) {
  UCSR0A = _BV(U2X0);
  UBRR0 = 0;
  UCSR0B = _BV(TXEN0);
  for (uint16_t i = 0; i < ${cases.length}u; i++) {
    ${fn.result === 'bool' ? 'bool' : 'uint32_t'} r = a0_${fn.name}(${args});
    ${print}
    tx('\\n');
  }
  cli();
  sleep_enable();
  sleep_cpu();
  for (;;) {
  }
}
`;
}

/** SRAM kept for the driver's own data, bss, and frame; the rest is the stack budget. */
const AVR_DRIVER_RESERVE = 128;

export async function checkAvr(
  program: TypedProgram,
  cases: readonly Case[],
  avrGcc: ToolInfo,
  clang: ToolInfo,
): Promise<
  TargetReport & {
    skippedIoFunctions: number;
    skippedIoCases: number;
    skippedLimitFunctions: number;
    skippedLimitCases: number;
    skips: string[];
  }
> {
  const subset = ioFreeSubset(program);
  const keep = new Set(subset.functions.map((f) => f.name));
  const own = cases.filter((c) => keep.has(c.functionName));
  const skipped = {
    skippedIoFunctions: program.functions.length - subset.functions.length,
    skippedIoCases: cases.length - own.length,
    skippedLimitFunctions: 0,
    skippedLimitCases: 0,
    skips: [] as string[],
  };
  const label = `native AVR assembly for the ATmega328P (src/avr.ts) via avr-as, linked with an avr-gcc C driver per function (cases in program memory, results on UART0), executed under libsimavr; ${skipped.skippedIoFunctions} io functions (${skipped.skippedIoCases} cases) skipped: io is out of scope for this backend`;
  if (avrGcc.path === undefined)
    return {
      status: 'blocked',
      cases: 0,
      detail: 'avr: avr-gcc not found (brew install avr-gcc avr-binutils simavr)',
      ...skipped,
    };
  const simavr = findSimavr();
  if (simavr.prefix === undefined)
    return {
      status: 'blocked',
      cases: 0,
      detail: 'avr: libsimavr not found (brew install simavr, or set A0_SIMAVR_PREFIX)',
      ...skipped,
    };
  if (clang.path === undefined) return { ...blocked(clang, 'avr simulator host'), ...skipped };
  const tool = `${avrGcc.version}; ${simavr.version ?? 'simavr'}`;
  const start = performance.now();
  const fail = (what: string, stderr: string): TargetReport & typeof skipped => ({
    status: 'failed',
    cases: 0,
    detail: `avr: ${what}`,
    tool,
    failures: [stderr.slice(0, 2000)],
    ...skipped,
  });
  const budget = AVR_SRAM_BYTES - AVR_DRIVER_RESERVE;
  const prefix = simavr.prefix;
  return withTempDir(async (dir) => {
    await writeFile(join(dir, 'host.c'), AVR_HOST, 'utf8');
    const host = runTool(
      clang.path as string,
      [
        '-O1',
        `-I${join(prefix, 'include')}`,
        '-o',
        'host',
        'host.c',
        `-L${join(prefix, 'lib')}`,
        '-lsimavr',
        '-lelf',
      ],
      { cwd: dir },
    );
    if (!host.ok) return fail('simulator host build failed', host.stderr);
    let ran = 0;
    for (const optimize of [true, false]) {
      const level = optimize ? 'optimized' : 'unoptimized';
      const asm = compile(subset, 'avr', { optimize }).text;
      await writeFile(join(dir, 'module.s'), asm, 'utf8');
      const as = runTool(
        avrGcc.path as string,
        ['-mmcu=atmega328p', '-c', '-x', 'assembler', '-o', 'module.o', 'module.s'],
        { cwd: dir },
      );
      if (!as.ok) return fail(`${level}: assembly failed`, as.stderr);
      const levelSkips: string[] = [];
      let levelSkipCases = 0;
      let levelRan = 0;
      for (const fn of subset.functions) {
        const mine = own.filter((c) => c.functionName === fn.name);
        if (mine.length === 0 || !isDriverCallable(fn)) continue;
        const stack = avrStackBytes(fn, optimize);
        if (stack > budget) {
          levelSkips.push(
            `${fn.name}: static stack bound ${stack} bytes exceeds the ${budget} bytes of SRAM left beside the driver`,
          );
          levelSkipCases += mine.length;
          continue;
        }
        await writeFile(join(dir, 'driver.c'), avrDriver(fn, mine), 'utf8');
        const link = runTool(
          avrGcc.path as string,
          [
            '-mmcu=atmega328p',
            '-std=c11',
            '-Os',
            '-Wall',
            '-Wextra',
            '-Werror',
            '-Wl,--gc-sections',
            '-o',
            'fw.elf',
            'driver.c',
            'module.o',
          ],
          { cwd: dir },
        );
        if (!link.ok) {
          if (/overflow|will not fit/.test(link.stderr)) {
            levelSkips.push(`${fn.name}: does not fit the ${AVR_FLASH_BYTES}-byte flash`);
            levelSkipCases += mine.length;
            continue;
          }
          return fail(`${level}: driver build/link failed for ${fn.name}`, link.stderr);
        }
        const exec = runTool(join(dir, 'host'), ['fw.elf', 'out.txt'], { cwd: dir });
        if (!exec.ok)
          return fail(
            `${level}: simulation of ${fn.name} failed (status ${String(exec.status)})`,
            exec.stderr,
          );
        const lines = (await readFile(join(dir, 'out.txt'), 'utf8')).trim().split('\n');
        const r = compareAll(mine, lines, `${level}: ${label}`);
        if (r.status !== 'passed') return { ...r, tool, ...skipped };
        levelRan += mine.length;
      }
      if (optimize) {
        ran = levelRan;
        skipped.skips = levelSkips;
        skipped.skippedLimitFunctions = levelSkips.length;
        skipped.skippedLimitCases = levelSkipCases;
      } else if (levelRan !== ran)
        return fail(
          'optimized and unoptimized emissions ran different case counts',
          `${ran} vs ${levelRan}; unoptimized skips: ${levelSkips.join('; ')}`,
        );
    }
    const limits =
      skipped.skippedLimitFunctions === 0
        ? 'every io-free function fits the part'
        : `${skipped.skippedLimitFunctions} functions (${skipped.skippedLimitCases} cases) skipped for ATmega328P limits`;
    return {
      ...timed(
        {
          status: 'passed',
          cases: ran,
          detail: `${label}; ${limits}; optimized and unoptimized emissions each executed on every case run`,
        },
        start,
      ),
      tool,
      ...skipped,
    };
  });
}

// --- native RISC-V RV64 (direct assembly; bare-metal under qemu-system-riscv64) ---

/**
 * The bare-metal runtime that lets the unchanged C test driver run on QEMU's `virt` board:
 * the few libc entry points it calls, over the NS16550 UART (0x10000000) for stdout and the
 * case input assembled into the image with `.incbin` for stdin, and the SiFive test device
 * (0x100000) for exit. No newlib is needed; the A0 functions themselves call none of it.
 */
const RV_SHIM_HEADERS: Readonly<Record<string, string>> = {
  'stdio.h': `#pragma once
#include <stddef.h>
typedef struct a0_file FILE;
extern FILE *stdin;
char *fgets(char *s, int n, FILE *f);
int printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
`,
  'stdlib.h': `#pragma once
#include <stddef.h>
unsigned long strtoul(const char *s, char **end, int base);
int atoi(const char *s);
`,
  'string.h': `#pragma once
#include <stddef.h>
char *strtok(char *s, const char *delim);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int c, size_t n);
void *memcpy(void *d, const void *s, size_t n);
`,
};

const RV_SHIM_C = `#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct a0_file { int unused; };
static struct a0_file in_file;
FILE *stdin = &in_file;
extern const char a0_input[], a0_input_end[];
static const char *in_pos = a0_input;
#define UART ((volatile unsigned char *)0x10000000UL)
static void put(char c) { while ((UART[5] & 0x20) == 0) {} UART[0] = (unsigned char)c; }
char *fgets(char *s, int n, FILE *f) {
  (void)f;
  if (in_pos >= a0_input_end || n < 2) return NULL;
  int i = 0;
  while (i < n - 1 && in_pos < a0_input_end) { char c = *in_pos++; s[i++] = c; if (c == '\\n') break; }
  s[i] = 0;
  return s;
}
static void put_u(unsigned long v) { char b[24]; int k = 0; do { b[k++] = (char)('0' + v % 10); v /= 10; } while (v); while (k) put(b[--k]); }
int printf(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  for (const char *p = fmt; *p; p++) {
    if (*p != '%') { put(*p); continue; }
    p++;
    if (*p == 'u') put_u(va_arg(ap, unsigned));
    else if (*p == 'd') { int v = va_arg(ap, int); if (v < 0) { put('-'); put_u(0UL - (unsigned long)(long)v); } else put_u((unsigned long)v); }
    else if (*p == '%') put('%');
    else if (*p == 0) break;
  }
  va_end(ap);
  return 0;
}
unsigned long strtoul(const char *s, char **end, int base) {
  (void)base; unsigned long v = 0;
  while (*s >= '0' && *s <= '9') v = v * 10 + (unsigned long)(*s++ - '0');
  if (end) *end = (char *)s;
  return v;
}
int atoi(const char *s) { return (int)strtoul(s, NULL, 10); }
static int is_delim(char c, const char *d) { for (; *d; d++) if (*d == c) return 1; return 0; }
char *strtok(char *s, const char *d) {
  static char *next;
  if (s == NULL) s = next;
  if (s == NULL) return NULL;
  while (*s && is_delim(*s, d)) s++;
  if (*s == 0) { next = NULL; return NULL; }
  char *t = s;
  while (*s && !is_delim(*s, d)) s++;
  if (*s) *s++ = 0;
  next = s;
  return t;
}
void *memmove(void *d, const void *s, size_t n) {
  unsigned char *dp = d; const unsigned char *sp = s;
  if (dp < sp) for (size_t i = 0; i < n; i++) dp[i] = sp[i];
  else for (size_t i = n; i > 0; i--) dp[i - 1] = sp[i - 1];
  return d;
}
void *memcpy(void *d, const void *s, size_t n) { return memmove(d, s, n); }
void *memset(void *d, int c, size_t n) { unsigned char *p = d; for (size_t i = 0; i < n; i++) p[i] = (unsigned char)c; return d; }
int main(void);
void a0_cstart(void);
void a0_cstart(void) {
  int code = main();
  *(volatile unsigned *)0x100000UL = code == 0 ? 0x5555u : ((unsigned)code << 16) | 0x3333u;
  for (;;) {}
}
`;

const RV_START_S = `\t.section .text.start, "ax"
\t.globl _start
_start:
\tla sp, a0_stack_top
\tcall a0_cstart
\t.section .rodata
\t.globl a0_input
\t.globl a0_input_end
a0_input:
\t.incbin "input.txt"
a0_input_end:
\t.bss
\t.balign 16
\t.space 8 << 20
a0_stack_top:
`;

const RV_LINK_LD = `ENTRY(_start)
SECTIONS {
  . = 0x80000000;
  .text : { *(.text.start) *(.text .text.*) }
  .rodata : { *(.rodata .rodata.* .srodata .srodata.*) }
  .data : { *(.data .data.* .sdata .sdata.*) }
  .bss : { *(.bss .bss.* .sbss .sbss.* COMMON) }
}
`;

export async function checkRiscv64(
  program: TypedProgram,
  cases: readonly Case[],
  gcc: ToolInfo,
  qemu: ToolInfo,
): Promise<TargetReport & { skippedIoFunctions: number; skippedIoCases: number }> {
  const subset = ioFreeSubset(program);
  const keep = new Set(subset.functions.map((f) => f.name));
  const own = cases.filter((c) => keep.has(c.functionName));
  const skipped = {
    skippedIoFunctions: program.functions.length - subset.functions.length,
    skippedIoCases: cases.length - own.length,
  };
  const label = `native RISC-V RV64 assembly (src/riscv64.ts) via ${'`riscv64-elf-gcc -march=rv64gc -mabi=lp64`'}, linked with the C test driver over a bare-metal libc shim (UART out, embedded input), executed under qemu-system-riscv64 (virt board, no firmware); ${skipped.skippedIoFunctions} io functions (${skipped.skippedIoCases} cases) skipped: io is out of scope for this backend`;
  if (gcc.path === undefined) return { ...blocked(gcc, 'riscv64'), ...skipped };
  if (qemu.path === undefined) return { ...blocked(qemu, 'riscv64'), ...skipped };
  const tool = `${gcc.version}; ${qemu.version}`;
  const start = performance.now();
  const protos = [
    '#include <stdint.h>',
    '#include <stdbool.h>',
    ...subset.functions.filter(isDriverCallable).map((f) => `extern ${cSignature(f)};`),
  ].join('\n');
  const fail = (what: string, stderr: string): TargetReport & typeof skipped => ({
    status: 'failed',
    cases: 0,
    detail: `riscv64: ${what}`,
    tool,
    failures: [stderr.slice(0, 2000)],
    ...skipped,
  });
  let report: TargetReport | undefined;
  for (const optimize of [true, false]) {
    const asm = compile(subset, 'riscv64', { optimize }).text;
    const level = optimize ? 'optimized' : 'unoptimized';
    const r = await withTempDir(async (dir): Promise<TargetReport> => {
      await mkdir(join(dir, 'include'));
      for (const [name, text] of Object.entries(RV_SHIM_HEADERS))
        await writeFile(join(dir, 'include', name), text, 'utf8');
      await writeFile(join(dir, 'module.s'), asm, 'utf8');
      await writeFile(join(dir, 'driver.c'), cDriver(subset, protos), 'utf8');
      await writeFile(join(dir, 'shim.c'), RV_SHIM_C, 'utf8');
      await writeFile(join(dir, 'start.S'), RV_START_S, 'utf8');
      await writeFile(join(dir, 'link.ld'), RV_LINK_LD, 'utf8');
      await writeFile(join(dir, 'input.txt'), caseInput(subset, own), 'utf8');
      const build = runTool(
        gcc.path as string,
        [
          '-march=rv64gc',
          '-mabi=lp64',
          '-mcmodel=medany',
          '-ffreestanding',
          '-fno-builtin',
          '-nostdlib',
          '-static',
          '-std=c11',
          '-O1',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Iinclude',
          '-Tlink.ld',
          '-o',
          'driver.elf',
          'start.S',
          'shim.c',
          'driver.c',
          'module.s',
          '-lgcc',
        ],
        { cwd: dir },
      );
      if (!build.ok) return fail(`${level}: build/link failed`, build.stderr);
      const exec = runTool(
        qemu.path as string,
        [
          '-machine',
          'virt',
          '-bios',
          'none',
          '-m',
          '256M',
          '-display',
          'none',
          '-monitor',
          'none',
          '-serial',
          'stdio',
          '-kernel',
          'driver.elf',
        ],
        { cwd: dir, timeoutMs: 600_000 },
      );
      if (!exec.ok) return fail(`${level}: execution failed (status ${exec.status})`, exec.stderr);
      return compareAll(
        own,
        exec.stdout.replace(/\r/g, '').trim().split('\n'),
        `${level}: ${label}`,
      );
    });
    if (r.status !== 'passed') return { ...r, tool, ...skipped };
    report = r;
  }
  return {
    ...timed(
      {
        ...(report as TargetReport),
        detail: `${label}; optimized and unoptimized emissions each executed on every case`,
      },
      start,
    ),
    tool,
    ...skipped,
  };
}

// --- native 32-bit ARM (direct assembly; ARMv7-A under qemu-system-arm) ----------------

/**
 * Boot shim for the bare-metal run: an identity-mapped MMU (1 MiB sections; RAM from
 * 0x40000000 normal write-back memory, below it strongly-ordered device memory), because
 * with the MMU off every access is strongly ordered and newlib's unaligned word loads fault;
 * then CP10/CP11 access and FPEXC.EN for the hard-float newlib; then newlib's `_start`.
 */
const ARM32_BOOT = `\t.syntax unified
\t.arch armv7-a
\t.fpu vfpv3-d16
\t.eabi_attribute Tag_ABI_VFP_args, 1
\t.arm
\t.text
\t.globl a0_boot
\t.type a0_boot, %function
a0_boot:
\tldr r0, =a0_ttb
\tmov r1, #0
1:\tlsl r2, r1, #20
\tcmp r1, #0x400
\tldrlo r3, =0xc02
\tldrhs r3, =0x1c0e
\torr r2, r2, r3
\tstr r2, [r0, r1, lsl #2]
\tadd r1, r1, #1
\tcmp r1, #0x1000
\tbne 1b
\tmcr p15, 0, r0, c2, c0, 0
\tmov r1, #0
\tmcr p15, 0, r1, c2, c0, 2
\tldr r1, =0x55555555
\tmcr p15, 0, r1, c3, c0, 0
\tmov r1, #0
\tmcr p15, 0, r1, c8, c7, 0
\tdsb
\tisb
\tmrc p15, 0, r1, c1, c0, 0
\tbic r1, r1, #2
\torr r1, r1, #0x5
\torr r1, r1, #0x1000
\tmcr p15, 0, r1, c1, c0, 0
\tisb
\tmrc p15, 0, r0, c1, c0, 2
\torr r0, r0, #0xf00000
\tmcr p15, 0, r0, c1, c0, 2
\tisb
\tmov r0, #0x40000000
\tvmsr fpexc, r0
\tb _start
\t.ltorg
\t.data
\t.balign 16384
a0_ttb:
\t.space 16384
\t.section .note.GNU-stack,"",%progbits
`;

/** The driver's cases arrive in a host file over semihosting (the console gives no stdin EOF). */
const ARM32_CASES = `static void a0_cases(void) __attribute__((constructor));
static void a0_cases(void) { if (freopen("cases.txt", "r", stdin) == NULL) exit(2); }`;

/** Arm GNU Toolchain flags: ARMv7-A, hard float, newlib with semihosting (librdimon). */
const ARM32_CFLAGS = ['-march=armv7-a+fp', '-mfloat-abi=hard', '-mfpu=vfpv3-d16'];

/**
 * Build `module.s` + `driver.c` in `dir` with the boot shim into a bare-metal ARMv7-A image and
 * run it on an emulated Cortex-A7; the driver's stdout comes back over semihosting.
 */
export async function runArm32(
  gcc: string,
  qemu: string,
  dir: string,
): Promise<{ stage: 'build' | 'run'; result: ToolResult }> {
  await writeFile(join(dir, 'boot.s'), ARM32_BOOT, 'utf8');
  const build = runTool(
    gcc,
    [
      ...ARM32_CFLAGS,
      '-std=c11',
      '-O1',
      '-Wall',
      '-Wextra',
      '-Werror',
      '--specs=rdimon.specs',
      '-Wl,-Ttext-segment=0x40010000',
      '-Wl,-e,a0_boot',
      '-o',
      'driver.elf',
      'boot.s',
      'module.s',
      'driver.c',
    ],
    { cwd: dir },
  );
  if (!build.ok) return { stage: 'build', result: build };
  const result = runTool(
    qemu,
    [
      '-M',
      'virt',
      '-cpu',
      'cortex-a7',
      '-m',
      '256',
      '-display',
      'none',
      '-monitor',
      'none',
      '-serial',
      'none',
      '-semihosting-config',
      'enable=on,target=native',
      '-kernel',
      'driver.elf',
    ],
    { cwd: dir, input: '', timeoutMs: 600_000 },
  );
  return { stage: 'run', result };
}

export async function checkArm32(
  program: TypedProgram,
  cases: readonly Case[],
  gcc: ToolInfo,
  qemu: ToolInfo,
): Promise<TargetReport & { skippedIoFunctions: number; skippedIoCases: number }> {
  const subset = ioFreeSubset(program);
  const keep = new Set(subset.functions.map((f) => f.name));
  const own = cases.filter((c) => keep.has(c.functionName));
  const skipped = {
    skippedIoFunctions: program.functions.length - subset.functions.length,
    skippedIoCases: cases.length - own.length,
  };
  const label = `native 32-bit ARM assembly (src/arm32.ts, ARMv7-A ARM mode, AAPCS hard-float) assembled and linked with the C test driver by ${'`arm-none-eabi-gcc`'} (newlib, semihosting), executed on an emulated Cortex-A7 (${'`qemu-system-arm -M virt`'}); ${skipped.skippedIoFunctions} io functions (${skipped.skippedIoCases} cases) skipped: io is out of scope for this backend`;
  if (gcc.path === undefined)
    return {
      ...blocked(
        gcc,
        'arm32 (install the Arm GNU Toolchain: brew install --cask gcc-arm-embedded, or set A0_ARM_GCC)',
      ),
      ...skipped,
    };
  if (qemu.path === undefined)
    return { ...blocked(qemu, 'arm32 (brew install qemu, or set A0_QEMU_SYSTEM_ARM)'), ...skipped };
  const start = performance.now();
  const protos = [
    '#include <stdint.h>',
    '#include <stdbool.h>',
    ...subset.functions.filter(isDriverCallable).map((f) => `extern ${cSignature(f)};`),
    ARM32_CASES,
  ].join('\n');
  const tools = `${gcc.version}; ${qemu.version}`;
  const fail = (what: string, stderr: string): TargetReport & typeof skipped => ({
    status: 'failed',
    cases: 0,
    detail: `arm32: ${what}`,
    tool: tools,
    failures: [stderr.slice(0, 2000)],
    ...skipped,
  });
  let report: TargetReport | undefined;
  for (const optimize of [true, false]) {
    const asm = compile(subset, 'arm32', { optimize }).text;
    const level = optimize ? 'optimized' : 'unoptimized';
    const r = await withTempDir(async (dir): Promise<TargetReport> => {
      await writeFile(join(dir, 'module.s'), asm, 'utf8');
      await writeFile(join(dir, 'driver.c'), cDriver(subset, protos), 'utf8');
      await writeFile(join(dir, 'cases.txt'), caseInput(subset, own), 'utf8');
      const run = await runArm32(gcc.path as string, qemu.path as string, dir);
      if (run.stage === 'build')
        return fail(`${level}: assembly/driver build/link failed`, run.result.stderr);
      const exec = run.result;
      if (!exec.ok) return fail(`${level}: execution failed (status ${exec.status})`, exec.stderr);
      return compareAll(own, exec.stdout.trim().split('\n'), `${level}: ${label}`);
    });
    if (r.status !== 'passed') return { ...r, tool: tools, ...skipped };
    report = r;
  }
  return {
    ...timed(
      {
        ...(report as TargetReport),
        detail: `${label}; optimized and unoptimized emissions each executed on every case`,
      },
      start,
    ),
    tool: tools,
    ...skipped,
  };
}

// --- WebAssembly -------------------------------------------------------------

/**
 * Instantiate a wasm32 module of the C-derived shape (`a0_<fn>` exports, `memory`,
 * `__heap_base`) and run every case. io state lives in linear memory at __heap_base with the
 * C struct layout: input[IN], ninput, position, output[OUT], noutput (all u32).
 */
export async function runWasmCases(
  program: TypedProgram,
  cases: readonly Case[],
  bytes: Uint8Array,
  caps: { ioInputCapacity: number; ioOutputCapacity: number },
): Promise<string[]> {
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
  const exports = instance.exports as Record<string, unknown>;
  const memory = exports.memory as WebAssembly.Memory | undefined;
  const heapBase = (exports.__heap_base as WebAssembly.Global | undefined)?.value as
    | number
    | undefined;
  const IN = caps.ioInputCapacity;
  const OUT = caps.ioOutputCapacity;
  return cases.map((c) => {
    const fn = exports[`a0_${c.functionName}`];
    if (typeof fn !== 'function') return '<missing>';
    const scalars = c.args.map((a) => (typeof a === 'boolean' ? (a ? 1 : 0) : (a as number) | 0));
    const type = (program.byName.get(c.functionName) as TypedFunc).result;
    if (c.input === undefined) {
      const raw = (fn as (...a: number[]) => number)(...scalars);
      return type === 'u32' ? String(raw >>> 0) : String(raw & 1);
    }
    if (memory === undefined || heapBase === undefined) return '<no memory>';
    const needed = heapBase + (IN + 2 + OUT + 1) * 4;
    if (memory.buffer.byteLength < needed)
      memory.grow(Math.ceil((needed - memory.buffer.byteLength) / 65536));
    const words = new Uint32Array(memory.buffer, heapBase, IN + 2 + OUT + 1);
    words.fill(0);
    c.input.forEach((w, k) => {
      words[k] = w;
    });
    words[IN] = c.input.length;
    const raw = (fn as (...a: number[]) => number)(...scalars, heapBase);
    const result = type === 'u32' ? String(raw >>> 0) : String(raw & 1);
    const nout = words[IN + 2 + OUT] as number;
    const out = Array.from(words.subarray(IN + 2, IN + 2 + nout), String);
    return [result, ...out].join(' ');
  });
}

export async function checkWasm(
  program: TypedProgram,
  cases: readonly Case[],
): Promise<TargetReport> {
  const clang = findWasmClang();
  if (clang.path === undefined || clang.wasmLd === undefined) {
    return {
      status: 'blocked',
      cases: 0,
      detail: `wasm: ${clang.path === undefined ? 'no clang' : 'no wasm-ld (install lld)'}`,
    };
  }
  const start = performance.now();
  try {
    const caps = ioCaps(cases);
    const build = await compileWasm(compile(program, 'c', caps).text);
    const actual = await runWasmCases(program, cases, build.bytes, caps);
    return {
      ...timed(
        compareAll(
          cases,
          actual,
          'Emitted C compiled by Clang/wasm-ld to wasm32; executed in Node WebAssembly runtime.',
        ),
        start,
      ),
      tool: `${clang.version}; ${build.linker}`,
    };
  } catch (err) {
    return {
      status: 'failed',
      cases: 0,
      detail: 'wasm build/execution error',
      failures: [err instanceof Error ? err.message : String(err)],
    };
  }
}

/**
 * A0's own wasm32 backend (src/wasm.ts): the binary module comes straight from the compiler,
 * with no C, Clang, or wasm-ld, and runs under the same host harness as the C-derived module.
 */
export async function checkWasmDirect(
  program: TypedProgram,
  cases: readonly Case[],
): Promise<TargetReport> {
  const start = performance.now();
  const label =
    'A0 wasm32 backend (src/wasm.ts): binary module emitted directly, no C/Clang/wasm-ld; executed in Node WebAssembly runtime with the C-derived harness';
  try {
    const caps = ioCaps(cases);
    let report: TargetReport | undefined;
    for (const optimize of [true, false]) {
      const bytes = wasmModuleBytes(compile(program, 'wasm', { ...caps, optimize }).text);
      const level = optimize ? 'optimized' : 'unoptimized';
      const r = compareAll(
        cases,
        await runWasmCases(program, cases, bytes, caps),
        `${level}: ${label}`,
      );
      if (r.status !== 'passed') return timed(r, start);
      report = r;
    }
    return {
      ...timed(
        {
          ...(report as TargetReport),
          detail: `${label}; optimized and unoptimized emissions each executed on every case`,
        },
        start,
      ),
      tool: `node ${process.version}`,
    };
  } catch (err) {
    return {
      status: 'failed',
      cases: 0,
      detail: 'wasm (direct): build/execution error',
      failures: [err instanceof Error ? err.message : String(err)],
    };
  }
}

// --- JVM ---------------------------------------------------------------------

function javaDriver(program: TypedProgram): string {
  const dispatch = program.functions.map((fn, i) => {
    if (!isDriverCallable(fn)) return `        case ${i}: out.append("skip\\n"); break;`;
    const io = hasIoParam(fn);
    const scalars = io ? fn.params.slice(0, -1) : fn.params;
    const args = scalars
      .map((t, p) =>
        t === 'u32' ? `Integer.parseUnsignedInt(tok[${p + 1}])` : `tok[${p + 1}].equals("1")`,
      )
      .concat(io ? ['io'] : [])
      .join(', ');
    const print =
      fn.result === 'u32'
        ? `Integer.toUnsignedString(${JAVA_CLASS}.${fn.name}(${args}))`
        : `(${JAVA_CLASS}.${fn.name}(${args}) ? "1" : "0")`;
    const setup = io
      ? `int nin = Integer.parseInt(tok[${scalars.length + 1}]); int[] inw = new int[nin]; for (int k = 0; k < nin; k++) inw[k] = Integer.parseUnsignedInt(tok[${scalars.length + 2} + k]); ${JAVA_CLASS}.A0Io io = new ${JAVA_CLASS}.A0Io(inw); `
      : '';
    const flush = io
      ? ` for (int k = 0; k < io.noutput; k++) out.append(' ').append(Integer.toUnsignedString(io.output[k]));`
      : '';
    return `        case ${i}: { ${setup}out.append(${print});${flush} out.append('\\n'); break; }`;
  });
  return `import java.io.*;
public final class Driver {
  public static void main(String[] a) throws IOException {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    StringBuilder out = new StringBuilder();
    String line;
    while ((line = in.readLine()) != null) {
      String[] tok = line.trim().split(" ");
      if (tok.length < 1 || tok[0].isEmpty()) continue;
      switch (Integer.parseInt(tok[0])) {
${dispatch.join('\n')}
        default: out.append("?\\n");
      }
    }
    System.out.print(out);
  }
}
`;
}

export async function checkJvm(
  program: TypedProgram,
  cases: readonly Case[],
): Promise<TargetReport> {
  const javac = findJavac();
  const java = findJava();
  if (javac.path === undefined) return blocked(javac, 'jvm');
  if (java.path === undefined) return blocked(java, 'jvm');
  const start = performance.now();
  return withTempDir(async (dir) => {
    await writeFile(
      join(dir, `${JAVA_CLASS}.java`),
      compile(program, 'java', ioCaps(cases)).text,
      'utf8',
    );
    await writeFile(join(dir, 'Driver.java'), javaDriver(program), 'utf8');
    const build = runTool(
      javac.path as string,
      ['-Xlint:all', '-Werror', '-d', dir, `${JAVA_CLASS}.java`, 'Driver.java'],
      { cwd: dir },
    );
    if (!build.ok)
      return {
        status: 'failed',
        cases: 0,
        detail: 'jvm: javac failed',
        tool: javac.version,
        failures: [build.stderr.slice(0, 2000)],
      };
    const exec = runTool(java.path as string, ['-cp', dir, 'Driver'], {
      input: caseInput(program, cases),
      cwd: dir,
    });
    if (!exec.ok)
      return {
        status: 'failed',
        cases: 0,
        detail: 'jvm: execution failed',
        tool: java.version,
        failures: [exec.stderr.slice(0, 2000)],
      };
    return {
      ...timed(
        compareAll(
          cases,
          exec.stdout.trim().split('\n'),
          'Generated Java compiled with javac; bytecode executed on JVM.',
        ),
        start,
      ),
      tool: `${javac.version}; ${java.version}`,
    };
  });
}

// --- main --------------------------------------------------------------------

/**
 * The row for the compiler found by `findGcc`, named by what actually runs: on macOS `gcc` is
 * usually Apple clang, and a row labelled gcc would then misreport the compiler.
 */
function gccCompilerRow(): {
  readonly key: string;
  readonly tool: ToolInfo;
  readonly label: string;
} {
  const tool = findGcc();
  const identity = tool.version ?? 'unknown compiler';
  const isClang = /clang/i.test(identity);
  const key = !isClang
    ? 'native_c_gcc'
    : /apple/i.test(identity)
      ? 'native_c_apple_clang_via_gcc'
      : 'native_c_clang_via_gcc';
  const via = tool.path ?? 'gcc';
  const label = isClang
    ? `native C via ${via}, which is ${identity} (not GCC)`
    : `native C via ${via} (${identity})`;
  return { key, tool, label };
}

async function main(): Promise<void> {
  const program = generateCorpus();
  const cases = generateCases(program);
  const interpreter = checkInterpreter(program, cases);
  const optimizer = checkOptimizer(program, cases);
  const gccRow = gccCompilerRow();
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    functions: program.functions.length,
    inputCases: cases.length,
    instructions: optimizer.before,
    optimizedInstructions: optimizer.after,
    seed: `0x${CORPUS_SEED.toString(16)}`,
    inputSeed: `0x${INPUT_SEED.toString(16)}`,
    corpusSha256: corpusSha256(program),
    oracle: 'Independent BigInt arithmetic over unsigned 32-bit values and booleans',
    scope:
      'Deterministic generated straight-line arithmetic/bitwise/select corpus with boundary values. Differential testing, not exhaustive proof or real-application performance evidence.',
    targets: {
      interpreter,
      optimizer: {
        status: optimizer.status,
        cases: optimizer.cases,
        detail: optimizer.detail,
        elapsedMs: optimizer.elapsedMs,
        failures: optimizer.failures,
      } as TargetReport,
      javascript: await checkJs(program, cases),
      native_c_clang: await checkNative(program, cases, findClang(), false, 'native C via clang'),
      [gccRow.key]: await checkNative(program, cases, gccRow.tool, false, gccRow.label),
      native_cpp_clang: await checkNative(
        program,
        cases,
        findClangPlusPlus(),
        true,
        'C-compatible output compiled as C++17 via clang++',
      ),
      native_c_parallel: await checkNative(
        program,
        cases,
        findClang(),
        false,
        `native C via clang with automatic parallel folds forced on every recognized fold (src/parallel.ts; ${planProgram(program, 'auto').filter((r) => r.plan !== 'none').length} of ${planProgram(program, 'auto').length} corpus folds recognized)`,
        compile(program, 'c', {
          ...ioCaps(cases),
          cParallel: parallelC({ mode: 'auto', force: true }) as CParallel,
        }).text,
      ),
      native_arm64: await checkArm64(program, cases, findClang()),
      native_x86_64: await checkX86_64(program, cases, findClang()),
      native_riscv64: await checkRiscv64(program, cases, findRiscv64Gcc(), findQemuRiscv64()),
      native_avr: await checkAvr(program, cases, findAvrGcc(), findClang()),
      native_arm32: await checkArm32(program, cases, findArmGcc(), findQemuSystemArm()),
      webassembly: await checkWasm(program, cases),
      webassembly_direct: await checkWasmDirect(program, cases),
      jvm: await checkJvm(program, cases),
      systemverilog: {
        status: 'unverified',
        cases: 0,
        detail:
          'SystemVerilog is emitted here but validated separately by `bun run hw` (results/hardware.json).',
      } as TargetReport,
    },
    elapsedMeaning:
      'Includes emission/build/startup/checking for each path; not a comparative runtime benchmark.',
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'verification.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join('results', 'corpus.a0'), formatProgram(program), 'utf8');
  for (const [name, t] of Object.entries(report.targets)) {
    process.stdout.write(
      `${name.padEnd(18)} ${t.status.padEnd(10)} ${String(t.cases).padStart(6)} cases  ${t.detail}\n`,
    );
    if (t.failures) for (const f of t.failures) process.stdout.write(`    ${f}\n`);
  }
  const bad = Object.values(report.targets).some((t) => t.status === 'failed');
  process.exit(bad ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
