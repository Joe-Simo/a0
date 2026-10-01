/**
 * The wasm32 emitter written in A0 (compiler/emit_wasm.a0, entry `emitwasmio` of
 * compiler/boot.a0): the port of src/wasm.ts, with the optimizer written in A0
 * (compiler/optimize.a0, the port of src/optimize.ts) in front of it. Unoptimized, its module
 * must be byte-identical to `compile(program, 'wasm', { optimize: false })`; optimized, to
 * `compile(program, 'wasm')` with the default options, and the optimized IR to
 * `optimizeFunction` node for node.
 *
 * - Build (`buildWasmTool`): the bootstrap's C seed a0c-stage1 (tools/bootstrap.ts: the A0
 *   compiler through the TypeScript C backend) compiles the closure of `emitwasmio` in chunks;
 *   clang builds that C into `a0w`. So the emitter that runs is A0 compiled by A0.
 * - A program is emitted a chunk of functions at a time. This file only orders, splits and
 *   supplies bodies: a chunk is either formatted source through the A0 front end (mode 1, or 4
 *   optimized: the chunks of tools/bootstrap.ts `planChunks`) or the checked tables of the
 *   TypeScript front end in the A0 front end's layout (mode 2, or 5 optimized, used for
 *   sources over the A0 front end's 16384-byte limit: site/page.a0 has functions of 64 KB).
 *   Each chunk returns its POOL, META and CODE words and a trailer with the index, stack depth
 *   and iteration bound of its functions, which are passed back, unread here, with the later
 *   chunks that call them. The linker (mode 3) gets every POOL, then every META, then every
 *   CODE, and writes the module.
 * - The optimizer evaluates calls and folds with literal operands on the original bodies, which
 *   a chunk does not hold (its external callees are stubs or empty entries): it gets a
 *   separate eval program (the functions it has asked for, with every function they reach, in
 *   program order) and the map of chunk functions to it. It starts empty; when a body it needs
 *   is absent the chunk ends with code 7 and the chunk functions it needs, and the chunk is run
 *   again with their closures added. Mode 6 writes the optimized IR of a table chunk, compared
 *   here with `optimizeFunction` (same nodes in the same order, same operands, same ret).
 * - The check (`bun run selfhost:wasm`): the corpus, the examples and site/page.a0 and docs.a0,
 *   unoptimized and optimized, as tables and, wherever the A0 front end accepts the chunks, as
 *   source, each compared byte for byte with src/wasm.ts. Writes results/selfhost-wasm.json.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  C_IO_INPUT_CAPACITY,
  C_IO_OUTPUT_CAPACITY,
  COMPILER_VERSION,
  compile,
} from '../src/backends.js';
import {
  type Func,
  formatProgram,
  type Operand,
  parseAndValidate,
  type Type,
  type TypedFunc,
  type TypedProgram,
} from '../src/core.js';
import { link } from '../src/link.js';
import { optimizeFunction } from '../src/optimize.js';
import { findClang, runTool, type ToolInfo } from '../src/toolchain.js';
import { type WasmLayout, wasmModuleBytes } from '../src/wasm.js';
import {
  BUILD_DIR,
  buildStage,
  type Chunk,
  CLANG_BUILD,
  closure,
  emitChunked,
  FRONT_END_BYTES,
  PRELUDE,
  planChunks,
  runStageChunk,
  STAGE_INPUT,
  STAGE_OUTPUT,
} from './bootstrap.js';
import { generateCorpus } from './corpus.js';
import { irOp } from './ref-parse.js';

/** io capacities of `a0w` in words (a chunk's tables, the linker's whole input; the module). */
export const WASM_TOOL_INPUT = 1 << 21;
export const WASM_TOOL_OUTPUT = 1 << 22;
/** Table capacities of compiler/emit_wasm.a0 for one chunk (and of an eval program). */
const CAP = { nodes: 2730, operands: 32768, fns: 822, types: 8320, tlist: 8320, names: 16512 };
/** `emitwasmio` modes. */
const MODE = { source: 1, tables: 2, link: 3, sourceOpt: 4, tablesOpt: 5, ir: 6 } as const;
/** The result code of an optimized chunk that needs more bodies. */
const NEEDS_BODIES = 7;

/** The C main of `a0w`: stdin words (little-endian) are the io input, stdout the output words. */
export const toolMain = `#include <pthread.h>
#include <stdio.h>
#define A0_IO_INPUT_CAPACITY ${WASM_TOOL_INPUT}u
#define A0_IO_OUTPUT_CAPACITY ${WASM_TOOL_OUTPUT}u
#include "emitter.c"
static a0_io io;
static uint32_t code;
static void *run(void *arg) {
  (void)arg;
  code = a0_emitwasmio(&io);
  return NULL;
}
int main(void) {
  unsigned char b[4];
  uint32_t n = 0;
  while (fread(b, 1, 4, stdin) == 4) {
    if (n == A0_IO_INPUT_CAPACITY) {
      fprintf(stderr, "a0w: input over %u words\\n", A0_IO_INPUT_CAPACITY);
      return 64;
    }
    io.input[n++] = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
  }
  io.ninput = n;
  pthread_attr_t attr;
  pthread_t thread;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, (size_t)1u << 30);
  if (pthread_create(&thread, &attr, run, NULL) != 0 || pthread_join(thread, NULL) != 0) {
    fprintf(stderr, "a0w: cannot run the emitter thread\\n");
    return 66;
  }
  if (io.noutput >= A0_IO_OUTPUT_CAPACITY) {
    fprintf(stderr, "a0w: output capacity reached\\n");
    return 65;
  }
  fwrite(io.output, 4, io.noutput, stdout);
  return (int)code;
}
`;

export interface WasmTool {
  readonly exe: string;
  /** The C seed that compiled it (tools/bootstrap.ts `emitchunkio`). */
  readonly stage1: string;
  readonly functions: number;
  readonly sourceBytes: number;
  readonly cBytes: number;
  readonly chunks: number;
  readonly emitMs: number;
  readonly buildMs: number;
}

/** a0c-stage1 (the C seed of tools/bootstrap.ts) compiles `emitwasmio`; clang builds `a0w`. */
export async function buildWasmTool(clang: ToolInfo): Promise<WasmTool> {
  const linked = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
  const seed = parseAndValidate(closure(linked.functions, 'emitchunkio'));
  const seedC = compile(seed, 'c', {
    ioInputCapacity: STAGE_INPUT,
    ioOutputCapacity: STAGE_OUTPUT,
  }).text;
  const [stage1] = await buildStage(clang, 'a0c-stage1', seedC);
  const source = closure(linked.functions, 'emitwasmio');
  const e = emitChunked(source, (c, b) => runStageChunk(stage1, c, b));
  if (e.code !== 0)
    throw new Error(`a0c-stage1 rejected emitwasmio: code ${e.code} (${e.failed?.own.join(' ')})`);
  const dir = join(BUILD_DIR, 'a0w');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'emitter.c'), e.text, 'utf8');
  await writeFile(join(dir, 'main.c'), toolMain, 'utf8');
  const start = performance.now();
  const r = runTool(clang.path as string, [...CLANG_BUILD, '-o', 'a0w', 'main.c'], {
    cwd: dir,
    timeoutMs: 1_800_000,
  });
  if (!r.ok) throw new Error(`a0w build failed:\n${r.stderr.slice(0, 4000)}`);
  return {
    exe: join(dir, 'a0w'),
    stage1,
    functions: parseAndValidate(source).functions.length,
    sourceBytes: Buffer.byteLength(source),
    cBytes: Buffer.byteLength(e.text),
    chunks: e.chunks,
    emitMs: Math.round(e.ms),
    buildMs: Math.round(performance.now() - start),
  };
}

/** Run `a0w` on the input words: (result code, output words). */
function runTool32(exe: string, words: readonly number[]): { code: number; out: Uint32Array } {
  const input = Buffer.alloc(words.length * 4);
  for (const [i, w] of words.entries()) input.writeUInt32LE(w >>> 0, i * 4);
  const r = spawnSync(exe, [], { input, timeout: 600_000, maxBuffer: 1 << 28 });
  if (r.status === null || r.status > NEEDS_BODIES)
    throw new Error(`${exe} failed (${r.status ?? r.signal}): ${r.stderr?.toString() ?? ''}`);
  const out = new Uint32Array(r.stdout.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = r.stdout.readUInt32LE(i * 4);
  return { code: r.status, out };
}

/** One chunk's output: POOL META CODE, then (index, depth, bound) per function. */
interface ChunkOutput {
  readonly pool: Uint32Array;
  readonly meta: Uint32Array;
  readonly code: Uint32Array;
  readonly calls: [number, number, number][];
  readonly variants: number;
}

function splitChunk(out: Uint32Array): ChunkOutput {
  const k = out[out.length - 1] as number;
  const variants = out[out.length - 2] as number;
  const t = out.length - 2 - 3 * k;
  const calls = Array.from({ length: k }, (_, i): [number, number, number] => [
    out[t + 3 * i] as number,
    out[t + 3 * i + 1] as number,
    out[t + 3 * i + 2] as number,
  ]);
  const p = out[t - 2] as number;
  const m = out[t - 1] as number;
  return {
    pool: out.subarray(0, p),
    meta: out.subarray(p, p + m),
    code: out.subarray(p + m, t - 2),
    calls,
    variants,
  };
}

/** The module from the chunks' outputs (mode 3). */
function linkChunks(exe: string, chunks: readonly ChunkOutput[], layout: WasmLayout): Uint8Array {
  const version = [...Buffer.from(COMPILER_VERSION, 'utf8')];
  const functions = chunks.reduce((n, c) => n + c.calls.length, 0);
  const words: number[] = [3, version.length, ...version];
  words.push(layout.ioInputCapacity, layout.ioOutputCapacity, functions);
  for (const c of chunks) for (const w of c.pool) words.push(w);
  words.push(0);
  for (const c of chunks) for (const w of c.meta) words.push(w);
  for (const c of chunks) for (const w of c.code) words.push(w);
  const r = runTool32(exe, words);
  if (r.code !== 0) throw new Error(`a0w linker: code ${r.code} (a table is full)`);
  return Uint8Array.from(r.out, (w) => w & 255);
}

// --- mode 2: checked tables ---------------------------------------------------------------

interface Tables {
  readonly types: number[];
  readonly typeIndex: Map<string, number>;
  readonly tlist: number[];
}

function intern(tb: Tables, t: Type): number {
  const key = typeof t === 'string' ? t : JSON.stringify(t);
  const known = tb.typeIndex.get(key);
  if (known !== undefined) return known;
  let triple: [number, number, number];
  if (typeof t === 'string') throw new Error(`unknown type ${t}`);
  if (t.kind === 'arr') triple = [4, t.length, intern(tb, t.elem)];
  else {
    const fields = t.fields.map((f) => intern(tb, f));
    triple = [5, tb.tlist.length, fields.length];
    tb.tlist.push(...fields);
  }
  const index = tb.types.length / 3;
  tb.types.push(...triple);
  tb.typeIndex.set(key, index);
  return index;
}

/** An operand as its (kind, value) pair: node index in its function, parameter, u32, bool. */
function operandPair(ids: ReadonlyMap<string, number>, o: Operand): [number, number] {
  return o.kind === 'node'
    ? [1, ids.get(o.id) as number]
    : o.kind === 'param'
      ? [2, o.index]
      : o.kind === 'u32'
        ? [3, o.value]
        : [4, o.value ? 1 : 0];
}

/**
 * The packed ret word (kind * 2^28 + value). A u32 literal of 2^28 or more is kind 5: the
 * operand at args pair value, appended to `args`.
 */
function packRet(pair: [number, number], args: number[]): number {
  const [kind, value] = pair;
  if (value < 2 ** 28) return kind * 2 ** 28 + value;
  args.push(kind, value);
  return 5 * 2 ** 28 + (args.length / 2 - 1);
}

/** The function records, nodes and operands of `fns` (callees through `callee`). */
function encodeBodies(
  fns: readonly TypedFunc[],
  callee: (name: string | undefined) => number,
): { nodes: number[]; args: number[]; rows: Map<TypedFunc, [number, number, number]> } {
  const nodes: number[] = [];
  const args: number[] = [];
  const rows = new Map<TypedFunc, [number, number, number]>();
  for (const fn of fns) {
    const ids = new Map(fn.nodes.map((n, i) => [n.id, i] as const));
    const firstNode = nodes.length / 6;
    for (const n of fn.nodes) {
      nodes.push(0, irOp(n.op), n.args.length, args.length / 2, callee(n.callee), callee(n.pred));
      for (const a of n.args) args.push(...operandPair(ids, a));
    }
    rows.set(fn, [firstNode, fn.nodes.length, packRet(operandPair(ids, fn.ret), args)]);
  }
  return { nodes, args, rows };
}

/** A chunk as tables: the words of mode 2 after the call table, and how they were numbered. */
interface ChunkTables {
  /** Its callees outside the chunk, in program order (the call table's functions). */
  readonly before: number[];
  /** The chunk's function space: `before`, then its own functions (program indices). */
  readonly space: number[];
  readonly local: ReadonlyMap<number, number>;
  readonly tb: Tables;
  readonly words: number[];
  readonly fits: boolean;
}

/**
 * The tables of functions [from, to) of `fns` (mode 2 after the call table): the chunk's
 * function space is its callees outside the chunk (program order), then its own functions.
 */
function encodeChunk(fns: readonly TypedFunc[], from: number, to: number): ChunkTables {
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const external = new Set<number>();
  for (const fn of fns.slice(from, to))
    for (const n of fn.nodes)
      for (const c of [n.callee, n.pred]) {
        const i = c === undefined ? undefined : (index.get(c) as number);
        if (i !== undefined && (i < from || i >= to)) external.add(i);
      }
  const before = [...external].sort((a, b) => a - b);
  const space = [...before, ...Array.from({ length: to - from }, (_, i) => from + i)];
  const local = new Map(space.map((g, i) => [g, i] as const));
  const tb: Tables = {
    types: [1, 0, 0, 2, 0, 0, 3, 0, 0],
    typeIndex: new Map([
      ['u32', 0],
      ['bool', 1],
      ['io', 2],
    ]),
    tlist: [],
  };
  const own = fns.slice(from, to);
  const body = encodeBodies(own, (name) =>
    name === undefined ? 0 : (local.get(index.get(name) as number) ?? 0),
  );
  const table: number[] = [];
  const ntys: number[] = [];
  const names: number[] = [];
  const fnm: number[] = [];
  for (const g of space) {
    const fn = fns[g] as TypedFunc;
    const name = [...Buffer.from(fn.name)];
    fnm.push(names.length, name.length);
    names.push(...name);
    const row = body.rows.get(fn);
    if (row === undefined) {
      table.push(0, 0, 0, 0, 0, 0, 0);
      continue;
    }
    const params = fn.params.map((t) => intern(tb, t));
    const first = tb.tlist.length;
    tb.tlist.push(...params);
    const result = intern(tb, fn.result);
    for (const n of fn.nodes) ntys.push(intern(tb, fn.types.get(n.id) ?? 'u32'));
    table.push(0, params.length, first, result, ...row);
  }
  const { nodes, args } = body;
  const fits =
    nodes.length / 6 <= CAP.nodes &&
    args.length / 2 <= CAP.operands &&
    space.length <= CAP.fns &&
    tb.types.length / 3 <= CAP.types &&
    tb.tlist.length <= CAP.tlist &&
    names.length <= CAP.names;
  const words = [
    tb.types.length / 3,
    ...tb.types,
    tb.tlist.length,
    ...tb.tlist,
    space.length,
    ...table,
    nodes.length / 6,
    ...nodes,
    ...ntys,
    args.length / 2,
    ...args,
    names.length,
    ...names,
    ...fnm,
  ];
  return { before, space, local, tb, words, fits };
}

// --- the eval program of the optimizer ---------------------------------------------------

/** Add program function `g` and every function it reaches (calls, bodies, predicates). */
function addClosure(fns: readonly TypedFunc[], g: number, into: Set<number>): void {
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const stack = [g];
  while (stack.length > 0) {
    const i = stack.pop() as number;
    if (into.has(i)) continue;
    into.add(i);
    for (const n of (fns[i] as TypedFunc).nodes)
      for (const c of [n.callee, n.pred]) if (c !== undefined) stack.push(index.get(c) as number);
  }
}

/** The eval program of the functions `members` (program order): tables and eval indices. */
function encodeEval(fns: readonly TypedFunc[], members: ReadonlySet<number>) {
  const order = [...members].sort((a, b) => a - b);
  const evalIndex = new Map(order.map((g, i) => [g, i] as const));
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const body = encodeBodies(
    order.map((g) => fns[g] as TypedFunc),
    (name) => (name === undefined ? 0 : (evalIndex.get(index.get(name) as number) as number)),
  );
  const efn = order.flatMap((g) => {
    const fn = fns[g] as TypedFunc;
    return [0, fn.params.length, 0, 0, ...(body.rows.get(fn) as [number, number, number])];
  });
  const fits =
    order.length <= CAP.fns &&
    body.nodes.length / 6 <= CAP.nodes &&
    body.args.length / 2 <= CAP.operands;
  const words = [
    order.length,
    ...efn,
    body.nodes.length / 6,
    ...body.nodes,
    body.args.length / 2,
    ...body.args,
  ];
  return { words, evalIndex, order, fits };
}

/** The requested chunk functions of a code-7 output (indices, then their count). */
function requested(out: Uint32Array): number[] {
  const k = out[out.length - 1] as number;
  return [...out.subarray(out.length - 1 - k, out.length - 1)];
}

/**
 * Run an optimized chunk (the words before and after its eval program and map), supplying
 * the bodies it asks for: the eval program starts empty and grows by the closures of the
 * requested functions (`space` maps chunk functions to program indices, -1 for none).
 */
function runOptimized(
  exe: string,
  fns: readonly TypedFunc[],
  space: readonly number[],
  encode: (members: ReadonlySet<number>, evalIndex: ReadonlyMap<number, number>) => number[],
): { code: number; out: Uint32Array; rounds: number; members: Set<number> } {
  const members = new Set<number>();
  for (let rounds = 1; ; rounds += 1) {
    const ev = encodeEval(fns, members);
    const r = runTool32(exe, encode(members, ev.evalIndex));
    if (r.code !== NEEDS_BODIES) return { ...r, rounds, members };
    const before = members.size;
    for (const c of requested(r.out)) {
      const g = space[c];
      if (g === undefined || g < 0) throw new Error(`a0w requested chunk function ${c}`);
      addClosure(fns, g, members);
    }
    if (members.size === before) throw new Error('a0w requested bodies it already has');
    if (!encodeEval(fns, members).fits)
      throw new Error(`the eval program of ${members.size} functions does not fit its tables`);
  }
}

/** The eval program's words and the map, for mode 5/6 after the chunk's tables. */
function evalWords(
  fns: readonly TypedFunc[],
  space: readonly number[],
  members: ReadonlySet<number>,
  evalIndex: ReadonlyMap<number, number>,
): number[] {
  const ev = encodeEval(fns, members);
  return [...ev.words, ...space.map((g) => (evalIndex.get(g) ?? -1) + 1)];
}

/** The largest chunk of table encodings from `from` on. */
function nextChunk(fns: readonly TypedFunc[], from: number): { to: number; chunk: ChunkTables } {
  let to = from + 1;
  let chunk = encodeChunk(fns, from, to);
  if (!chunk.fits) throw new Error(`${(fns[from] as Func).name} does not fit the tables`);
  while (to < fns.length) {
    const next = encodeChunk(fns, from, to + 1);
    if (!next.fits) break;
    chunk = next;
    to += 1;
  }
  return { to, chunk };
}

export interface ModuleRun {
  readonly bytes: Uint8Array;
  readonly chunks: number;
  /** Runs of optimized chunks, including the reruns that supplied bodies. */
  readonly runs: number;
}

/**
 * The A0 emitter's module for a checked program, chunk by chunk as tables (mode 2; mode 5
 * with the optimizer in front of it when `optimize`).
 */
export function a0WasmFromTables(
  exe: string,
  program: TypedProgram,
  layout: WasmLayout,
  optimize = false,
): ModuleRun {
  const fns = program.functions;
  const calls = new Map<number, [number, number]>();
  const outputs: ChunkOutput[] = [];
  let base = 0;
  let from = 0;
  let runs = 0;
  while (from < fns.length) {
    const { to, chunk } = nextChunk(fns, from);
    const table = chunk.before.flatMap((g) => calls.get(g) as [number, number]);
    const head = [base, chunk.before.length, ...table, ...chunk.words];
    const r = optimize
      ? runOptimized(exe, fns, chunk.space, (members, evalIndex) => [
          MODE.tablesOpt,
          ...head,
          ...evalWords(fns, chunk.space, members, evalIndex),
        ])
      : { ...runTool32(exe, [MODE.tables, ...head]), rounds: 1 };
    runs += r.rounds;
    if (r.code !== 0) throw new Error(`a0w: code ${r.code} on functions ${from}..${to}`);
    const out = splitChunk(r.out);
    for (const [i, [idx, depth]] of out.calls.entries()) calls.set(from + i, [idx, depth]);
    outputs.push(out);
    base += out.variants;
    from = to;
  }
  return { bytes: linkChunks(exe, outputs, layout), chunks: outputs.length, runs };
}

/** src/optimize.ts on a chunk's own functions, in the words of mode 6. */
function typescriptIr(fns: readonly TypedFunc[], from: number, chunk: ChunkTables): number[] {
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const callee = (name: string | undefined): number =>
    name === undefined ? 0 : (chunk.local.get(index.get(name) as number) ?? 0);
  const words: number[] = [];
  for (let g = from; g < from + chunk.space.length - chunk.before.length; g += 1) {
    const fn = optimizeFunction(fns[g] as TypedFunc).fn;
    const ids = new Map(fn.nodes.map((n, i) => [n.id, i] as const));
    words.push(fn.nodes.length);
    for (const n of fn.nodes) {
      words.push(irOp(n.op), n.args.length, callee(n.callee), callee(n.pred));
      words.push(intern(chunk.tb, fn.types.get(n.id) ?? 'u32'));
      for (const a of n.args) words.push(...operandPair(ids, a));
    }
    words.push(...operandPair(ids, fn.ret));
  }
  return words;
}

export interface IrCheck {
  readonly functions: number;
  readonly identical: number;
  /** The first function whose optimized IR differs. */
  readonly firstDifference?: string;
}

/** The A0 optimizer's IR (mode 6) against src/optimize.ts, chunk by chunk as tables. */
export function a0IrCheck(exe: string, program: TypedProgram): IrCheck {
  const fns = program.functions;
  let from = 0;
  let identical = 0;
  let firstDifference: string | undefined;
  while (from < fns.length) {
    const { to, chunk } = nextChunk(fns, from);
    const head = [0, chunk.before.length, ...chunk.before.flatMap(() => [0, 0]), ...chunk.words];
    const r = runOptimized(exe, fns, chunk.space, (members, evalIndex) => [
      MODE.ir,
      ...head,
      ...evalWords(fns, chunk.space, members, evalIndex),
    ]);
    if (r.code !== 0) throw new Error(`a0w: code ${r.code} on functions ${from}..${to} (IR)`);
    const want = typescriptIr(fns, from, chunk);
    // Per function: its words are the node count, then per node 5 + 2 * operands, then 2.
    let a = 0;
    let b = 0;
    for (let g = from; g < to; g += 1) {
      const span = (w: ArrayLike<number>, at: number): number => {
        let end = at + 1;
        for (let k = 0; k < (w[at] as number); k += 1) end += 5 + 2 * (w[end + 1] as number);
        return end + 2 - at;
      };
      const la = span(r.out, a);
      const lb = span(want, b);
      const same =
        la === lb &&
        Array.from({ length: la }, (_, i) => r.out[a + i] === want[b + i]).every(Boolean);
      if (same) identical += 1;
      else firstDifference ??= (fns[g] as TypedFunc).name;
      a += la;
      b += lb;
    }
    from = to;
  }
  return {
    functions: fns.length,
    identical,
    ...(firstDifference === undefined ? {} : { firstDifference }),
  };
}

// --- mode 1: source through the A0 front end --------------------------------------------

/** The functions of a planned chunk in its function order (the whole program for one chunk). */
function chunkNames(chunk: Chunk, program: TypedProgram): string[] {
  return chunk.before.length + chunk.own.length === 0
    ? program.functions.map((f) => f.name)
    : [...chunk.before, ...chunk.own];
}

/**
 * The A0 emitter's module for a program source through the A0 front end (mode 1; mode 4 with
 * the optimizer when `optimize`, its eval program as formatted source).
 */
export function a0WasmFromSource(
  exe: string,
  program: TypedProgram,
  layout: WasmLayout,
  optimize = false,
): { bytes?: Uint8Array; code: number; chunks: number; runs: number; failed?: Chunk } {
  const fns = program.functions;
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const chunks = planChunks(formatProgram(program));
  const calls = new Map<string, [number, number, number]>();
  const outputs: ChunkOutput[] = [];
  let base = 0;
  let runs = 0;
  for (const chunk of chunks) {
    const bytes = [...Buffer.from(chunk.source)];
    const none: [number, number, number] = [0, 0, 0];
    const before = chunk.before.map((name): [number, number, number] =>
      name === PRELUDE ? none : (calls.get(name) ?? none),
    );
    const words = [bytes.length, ...bytes, chunk.head ? 1 : 0, 0, before.length];
    words.push(...before.map(([, , bound]) => bound), base);
    for (const [idx, depth] of before) words.push(idx, depth);
    const space = chunkNames(chunk, program).map((name) => index.get(name) ?? -1);
    const r = optimize
      ? runOptimized(exe, fns, space, (members, evalIndex) => {
          const order = [...members].sort((a, b) => a - b);
          const text = [
            ...Buffer.from(formatProgram({ functions: order.map((g) => fns[g] as Func) })),
          ];
          if (text.length > FRONT_END_BYTES)
            throw new Error(
              `the eval program of ${order.length} functions is over the source limit`,
            );
          const map = space.map((g) => (evalIndex.get(g) ?? -1) + 1);
          return [MODE.sourceOpt, ...words, text.length, ...text, map.length, ...map];
        })
      : { ...runTool32(exe, [MODE.source, ...words]), rounds: 1 };
    runs += r.rounds;
    if (r.code !== 0) return { code: r.code, chunks: chunks.length, runs, failed: chunk };
    const out = splitChunk(r.out);
    for (const [i, name] of chunk.own.entries())
      calls.set(name, out.calls[i] as [number, number, number]);
    outputs.push(out);
    base += out.variants;
  }
  return { bytes: linkChunks(exe, outputs, layout), code: 0, chunks: chunks.length, runs };
}

/** The reference: src/wasm.ts on the program, unoptimized or with the default optimization. */
export function typescriptWasm(
  program: TypedProgram,
  layout: WasmLayout,
  optimize = false,
): Uint8Array {
  return wasmModuleBytes(
    compile(program, 'wasm', optimize ? layout : { optimize: false, ...layout }).text,
  );
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The first byte where two modules differ, or -1. */
const firstDifference = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : Math.min(a.length, b.length);
};

/** One program through one path (unoptimized or optimized). */
interface PathReport {
  readonly moduleBytes: number;
  readonly tables: {
    readonly chunks: number;
    readonly runs: number;
    readonly ms: number;
    readonly identical: boolean;
    readonly firstDifference?: number;
  };
  readonly source?: {
    readonly chunks: number;
    readonly runs: number;
    readonly ms: number;
    readonly identical: boolean;
    readonly code: number;
    /** A chunk the A0 front end rejects: `emitchunkio` (a0c-stage1) gives the same code. */
    readonly sameCodeAsEmitchunkio?: boolean;
  };
  readonly sourceSkipped?: string;
}

interface ProgramReport {
  readonly label: string;
  readonly functions: number;
  readonly unoptimized: PathReport;
  readonly optimized: PathReport;
  /** The optimized IR of every function against src/optimize.ts `optimizeFunction`. */
  readonly ir: IrCheck & { readonly ms: number };
}

/** A program through the tables and the source path, against the TypeScript module. */
function checkPath(
  tool: WasmTool,
  program: TypedProgram,
  layout: WasmLayout,
  optimize: boolean,
): PathReport {
  const reference = typescriptWasm(program, layout, optimize);
  const t0 = performance.now();
  const tables = a0WasmFromTables(tool.exe, program, layout, optimize);
  const tablesMs = Math.round(performance.now() - t0);
  const tablesSame = same(tables.bytes, reference);
  let source: PathReport['source'];
  let sourceSkipped: string | undefined;
  try {
    const t1 = performance.now();
    const s = a0WasmFromSource(tool.exe, program, layout, optimize);
    const seedCode =
      s.failed === undefined
        ? undefined
        : runStageChunk(
            tool.stage1,
            s.failed,
            s.failed.before.map(() => 0),
          ).code;
    source = {
      chunks: s.chunks,
      runs: s.runs,
      ms: Math.round(performance.now() - t1),
      identical: s.bytes !== undefined && same(s.bytes, reference),
      code: s.code,
      ...(seedCode === undefined ? {} : { sameCodeAsEmitchunkio: seedCode === s.code }),
    };
  } catch (err) {
    sourceSkipped = err instanceof Error ? err.message : String(err);
  }
  return {
    moduleBytes: reference.length,
    tables: {
      chunks: tables.chunks,
      runs: tables.runs,
      ms: tablesMs,
      identical: tablesSame,
      ...(tablesSame ? {} : { firstDifference: firstDifference(tables.bytes, reference) }),
    },
    ...(source === undefined ? {} : { source }),
    ...(sourceSkipped === undefined ? {} : { sourceSkipped }),
  };
}

const pathFailed = (r: PathReport): boolean =>
  !r.tables.identical ||
  (r.source !== undefined &&
    (r.source.code === 0 ? !r.source.identical : r.source.sameCodeAsEmitchunkio !== true));

const describe = (r: PathReport): string => {
  const t = r.tables;
  const tables = `tables: ${t.identical ? 'identical' : `DIFFERS at byte ${t.firstDifference}`} (${t.chunks} chunk(s), ${t.runs} run(s), ${t.ms} ms)`;
  const s = r.source;
  const source =
    s === undefined
      ? `skipped (${r.sourceSkipped})`
      : s.identical
        ? `identical (${s.chunks} chunk(s), ${s.runs} run(s), ${s.ms} ms)`
        : s.sameCodeAsEmitchunkio === true
          ? `rejected by the A0 front end (code ${s.code}, as emitchunkio)`
          : `DIFFERS (code ${s.code})`;
  return `${String(r.moduleBytes).padStart(7)} bytes  ${tables}  source: ${source}`;
};

async function main(): Promise<void> {
  const clang = findClang();
  if (clang.path === undefined) throw new Error('clang not found');
  const tool = await buildWasmTool(clang);
  process.stdout.write(
    `a0w: emitwasmio closure ${tool.functions} functions (${tool.sourceBytes} source bytes), a0c-stage1 wrote ${tool.cBytes} C bytes in ${tool.chunks} chunks (${tool.emitMs} ms), clang -O2 ${tool.buildMs} ms\n`,
  );
  const small: WasmLayout = {
    ioInputCapacity: C_IO_INPUT_CAPACITY,
    ioOutputCapacity: C_IO_OUTPUT_CAPACITY,
  };
  const site: WasmLayout = { ioInputCapacity: 1024, ioOutputCapacity: 131072 };
  const programs: [string, TypedProgram, WasmLayout][] = [['corpus', generateCorpus(), small]];
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort())
    programs.push([f, parseAndValidate(await readFile(`examples/${f}`, 'utf8')), small]);
  for (const f of ['page.a0', 'docs.a0'])
    programs.push([
      `site/${f}`,
      (await link(join('site', f), (p) => readFile(p, 'utf8'), { root: '.' })).program,
      site,
    ]);
  const reports: ProgramReport[] = [];
  for (const [label, program, layout] of programs) {
    const unoptimized = checkPath(tool, program, layout, false);
    process.stdout.write(`${label.padEnd(14)} O0 ${describe(unoptimized)}\n`);
    const optimized = checkPath(tool, program, layout, true);
    process.stdout.write(`${label.padEnd(14)} O1 ${describe(optimized)}\n`);
    const t0 = performance.now();
    const ir = { ...a0IrCheck(tool.exe, program), ms: Math.round(performance.now() - t0) };
    process.stdout.write(
      `${label.padEnd(14)} IR ${ir.identical}/${ir.functions} functions identical to src/optimize.ts${ir.firstDifference === undefined ? '' : ` (first difference: ${ir.firstDifference})`} (${ir.ms} ms)\n`,
    );
    reports.push({ label, functions: program.functions.length, unoptimized, optimized, ir });
  }
  const failed = reports.filter(
    (r) =>
      pathFailed(r.unoptimized) || pathFailed(r.optimized) || r.ir.identical !== r.ir.functions,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    compilerVersion: COMPILER_VERSION,
    stage:
      'wasm32 emitter written in A0 (compiler/emit_wasm.a0; entry emitwasmio in compiler/boot.a0), the port of src/wasm.ts, with the optimizer written in A0 (compiler/optimize.a0), the port of src/optimize.ts',
    method:
      'a0c-stage1 (the bootstrap C seed) compiles the closure of emitwasmio in chunks; clang builds that C into a0w. Each program is emitted a chunk of functions at a time, as the checked tables of the TypeScript front end in the A0 front end layout (mode 2; 5 optimized) and, where every chunk fits the A0 front end (16384 source bytes a chunk), as formatted source through the A0 lexer, parser and checker (mode 1; 4 optimized); a0w links the chunks into the module (mode 3). Unoptimized modules are compared byte for byte with src/wasm.ts on the unoptimized program, optimized ones with compile(program, wasm) (default options: src/optimize.ts). The optimizer evaluates on an eval program of the bodies it requests (code 7, then rerun). Mode 6 writes the optimized IR of each table chunk, compared function by function with optimizeFunction (nodes in order, ops, operands, callee, predicate, node type, ret).',
    tool,
    programs: reports,
    failed: failed.length,
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'selfhost-wasm.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${reports.length - failed.length}/${reports.length} programs identical\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
