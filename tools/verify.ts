/**
 * Cross-toolchain execution checks. Each path executes the generated code on the
 * full case set and compares against the independent BigInt oracle. Missing tools
 * are recorded as "blocked", never as passes. Writes results/verification.json.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  C_IO_INPUT_CAPACITY,
  C_IO_OUTPUT_CAPACITY,
  compile,
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
import {
  compileWasm,
  findClang,
  findClangPlusPlus,
  findGcc,
  findJava,
  findJavac,
  findWasmClang,
  runTool,
  type ToolInfo,
  withTempDir,
} from '../src/toolchain.js';
import {
  type Case,
  CORPUS_SEED,
  corpusSha256,
  generateCases,
  generateCorpus,
  hasIoParam,
  INPUT_SEED,
  isDriverCallable,
} from './corpus.js';

interface TargetReport {
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

function checkInterpreter(program: TypedProgram, cases: readonly Case[]): TargetReport {
  const start = performance.now();
  const actual = cases.map((c) => runCase(program.byName.get(c.functionName) as TypedFunc, c));
  return timed(compareAll(cases, actual, 'Reference interpreter vs BigInt oracle'), start);
}

function checkOptimizer(
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

async function checkJs(program: TypedProgram, cases: readonly Case[]): Promise<TargetReport> {
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

function cDriver(program: TypedProgram): string {
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
      ? `memset(&io, 0, sizeof io); io.ninput = (uint32_t)strtoul(tok[${scalars.length}], NULL, 10); for (uint32_t k = 0; k < io.ninput; k++) io.input[k] = (uint32_t)strtoul(tok[${scalars.length + 1}u + k], NULL, 10); `
      : '';
    const flush = io
      ? ' for (uint32_t k = 0; k < io.noutput; k++) printf(" %u", (unsigned)io.output[k]);'
      : '';
    return `    case ${i}: { ${setup}${fn.result === 'u32' ? 'uint32_t' : 'bool'} r = a0_${fn.name}(${args}); ${print}${flush} printf("\\n"); break; }`;
  });
  return `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "module.c"
int main(void) {
  char line[4096];
${usesIo(program) ? '  static a0_io io;\n' : ''}  while (fgets(line, sizeof line, stdin)) {
    char *tok[80]; int n = 0;
    for (char *p = strtok(line, " \\n"); p && n < 80; p = strtok(NULL, " \\n")) tok[n++] = p;
    if (n < 1) continue;
    int idx = atoi(tok[0]);
    memmove(tok, tok + 1, sizeof(char*) * (size_t)(n - 1));
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
      const base = `${index.get(c.functionName)} ${c.args.map(fmt).join(' ')}`;
      return c.input === undefined ? base : `${base} ${c.input.length} ${c.input.join(' ')}`;
    })
    .join('\n')}\n`;
}

async function checkNative(
  program: TypedProgram,
  cases: readonly Case[],
  tool: ToolInfo,
  asCpp: boolean,
  label: string,
): Promise<TargetReport> {
  if (tool.path === undefined) return blocked(tool, label);
  const start = performance.now();
  const cSource = compile(program, 'c').text;
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

// --- WebAssembly -------------------------------------------------------------

async function checkWasm(program: TypedProgram, cases: readonly Case[]): Promise<TargetReport> {
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
    const build = await compileWasm(compile(program, 'c').text);
    const { instance } = await WebAssembly.instantiate(build.bytes as BufferSource, {});
    const exports = instance.exports as Record<string, unknown>;
    // io state lives in linear memory at __heap_base with the C struct layout:
    // input[256], ninput, position, output[1024], noutput (all u32).
    const memory = exports.memory as WebAssembly.Memory | undefined;
    const heapBase = (exports.__heap_base as WebAssembly.Global | undefined)?.value as
      | number
      | undefined;
    const IN = C_IO_INPUT_CAPACITY;
    const OUT = C_IO_OUTPUT_CAPACITY;
    const actual = cases.map((c) => {
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

async function checkJvm(program: TypedProgram, cases: readonly Case[]): Promise<TargetReport> {
  const javac = findJavac();
  const java = findJava();
  if (javac.path === undefined) return blocked(javac, 'jvm');
  if (java.path === undefined) return blocked(java, 'jvm');
  const start = performance.now();
  return withTempDir(async (dir) => {
    await writeFile(join(dir, `${JAVA_CLASS}.java`), compile(program, 'java').text, 'utf8');
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

async function main(): Promise<void> {
  const program = generateCorpus();
  const cases = generateCases(program);
  const interpreter = checkInterpreter(program, cases);
  const optimizer = checkOptimizer(program, cases);
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
      native_c_gcc: await checkNative(
        program,
        cases,
        findGcc(),
        false,
        'native C via gcc (on macOS `gcc` may be Apple clang; see tool field)',
      ),
      native_cpp_clang: await checkNative(
        program,
        cases,
        findClangPlusPlus(),
        true,
        'C-compatible output compiled as C++17 via clang++',
      ),
      webassembly: await checkWasm(program, cases),
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

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
