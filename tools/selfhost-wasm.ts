/**
 * The wasm32 pipeline written in A0, driven from here: the optimizer (compiler/optimize.a0, from
 * compiler/optimize.a0s by tools/a0s.ts), the shape analyses and loop fusion (compiler/shape.a0,
 * from compiler/shape.a0m by tools/a0m.ts) and the wasm emitter (compiler/emit_wasm.a0), entry
 * `emitwasmio` of compiler/boot.a0 (read its header for the modes and result codes). They port
 * src/optimize.ts and src/wasm.ts: the module must equal `compile(program, 'wasm')` byte for byte
 * with the default options (optimizer, fusion, simd) and with `{ optimize: false }`.
 *
 * - Build (`buildWasmTool`): the bootstrap's C seed a0c-stage1 (tools/bootstrap.ts: the A0
 *   compiler through the TypeScript C backend) compiles the closure of `emitwasmio` in chunks;
 *   clang builds that C into `a0w`. So the tool that runs is A0 compiled by A0.
 * - This file only encodes, orders, splits and supplies bodies; it holds no A0 semantics.
 * - The optimizer runs a function a time (mode 7, `a0OptimizeProgram`): a single A0 value (a
 *   fold state included) is at most 65536 words, so a run cannot loop over functions holding
 *   their tables. The functions are optimized in program order; each run gets the function and
 *   the facts about its callees, and when it needs a body (to inline, unroll or evaluate) it
 *   stops with code 7 and the function indices, and the run is repeated with those optimized
 *   bodies (and what they reach) supplied. The optimized bodies replace the program's functions.
 * - The (optimized) program is emitted a chunk of functions at a time, as the checked tables in
 *   the A0 front end's layout (mode 2, `a0WasmFromTables`) or as formatted source through the A0
 *   front end (mode 1, `a0WasmFromSource`; a ret of a literal of 2^28 or more is bound to a node
 *   first, the front end cannot pack it). A chunk is the most functions that fit one run; one
 *   that turns out too big (code 4: the room fusion needs, the bodies supplied) is cut in two.
 *   Per function the shape analyses, loop fusion and the emitter run inside the chunk run
 *   (compiler/boot.a0 `wxorch`); when any of them needs the body of a function outside the chunk
 *   the run ends with code 7 and the indices, and is repeated with those bodies supplied (an
 *   opaque external row carries only its node count). Each chunk returns a record (POOL, META,
 *   CODE words) per function and a trailer with the index, stack depth and iteration bound of its
 *   functions, which are passed back with later chunks that call them. The linker (mode 3) gets
 *   every POOL, then every META, then every CODE, and writes the module.
 * - The check (`bun run selfhost:wasm`): the corpus, the examples and site/page.a0 and docs.a0,
 *   unoptimized and optimized, as tables and as source, each compared byte for byte with
 *   src/wasm.ts, and the optimized IR of every function against src/optimize.ts. Writes
 *   results/selfhost-wasm.json.
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
  formatFunction,
  formatProgram,
  formatType,
  type Node,
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
  PRELUDE,
  planChunks,
  runStageChunk,
  STAGE_INPUT,
  STAGE_OUTPUT,
} from './bootstrap.js';
import { generateCorpus } from './corpus.js';
import { frontEndFits, IR_OPS, irOp } from './ref-parse.js';
import { writeReport } from './scrub-results.js';

/** io capacities of `a0w` in words (a chunk's tables, the linker's whole input; the module). */
export const WASM_TOOL_INPUT = 1 << 21;
export const WASM_TOOL_OUTPUT = 1 << 22;
/** Table capacities of compiler/emit_wasm.a0 for one chunk (and of an eval program). */
const CAP = { nodes: 2816, operands: 32768, fns: 822, types: 8320, tlist: 8320, names: 51200 };
/** `emitwasmio` modes. */
export const MODE = { source: 1, tables: 2, link: 3, optimize: 7, image: 8 } as const;
/** The result code of an optimized chunk that needs more bodies. */
const NEEDS_BODIES = 7;
/** The result code of a chunk that does not fit a table. */
const CAPACITY = 4;

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

/** One chunk's output: per function its POOL, META and CODE words, then (index, depth, bound). */
interface ChunkOutput {
  readonly records: readonly { pool: Uint32Array; meta: Uint32Array; code: Uint32Array }[];
  readonly calls: [number, number, number][];
  readonly variants: number;
}

/**
 * The output of `wachunk` (code 0): per function a record (the word counts of its POOL, META and
 * CODE, then those words), then (index, depth, bound) per function, the chunk's variant count
 * and its function count.
 */
function splitChunk(out: Uint32Array): ChunkOutput {
  const k = out[out.length - 1] as number;
  const variants = out[out.length - 2] as number;
  const t = out.length - 2 - 3 * k;
  const calls = Array.from({ length: k }, (_, i): [number, number, number] => [
    out[t + 3 * i] as number,
    out[t + 3 * i + 1] as number,
    out[t + 3 * i + 2] as number,
  ]);
  const records: ChunkOutput['records'][number][] = [];
  let at = 0;
  for (let i = 0; i < k; i += 1) {
    const [np, nm, nc] = [out[at] as number, out[at + 1] as number, out[at + 2] as number];
    at += 3;
    records.push({
      pool: out.subarray(at, at + np),
      meta: out.subarray(at + np, at + np + nm),
      code: out.subarray(at + np + nm, at + np + nm + nc),
    });
    at += np + nm + nc;
  }
  return { records, calls, variants };
}

/** The module from the chunks' outputs (mode 3): every POOL, then every META, then every CODE. */
function linkChunks(exe: string, chunks: readonly ChunkOutput[], layout: WasmLayout): Uint8Array {
  const version = [...Buffer.from(COMPILER_VERSION, 'utf8')];
  const functions = chunks.reduce((n, c) => n + c.calls.length, 0);
  const words: number[] = [3, version.length, ...version];
  words.push(layout.ioInputCapacity, layout.ioOutputCapacity, functions);
  // The export list: 0 = every function exported, n + 1 = n names (length, then the bytes).
  if (layout.exports === undefined) words.push(0);
  else {
    words.push(layout.exports.length + 1);
    for (const name of layout.exports) {
      const bytes = Buffer.from(name, 'utf8');
      words.push(bytes.length, ...bytes);
    }
  }
  for (const c of chunks) for (const r of c.records) for (const w of r.pool) words.push(w);
  words.push(0);
  for (const c of chunks) for (const r of c.records) for (const w of r.meta) words.push(w);
  for (const c of chunks) for (const r of c.records) for (const w of r.code) words.push(w);
  const r = runTool32(exe, words);
  if (r.code === 6)
    throw new Error(
      `wasm: an exported function is not in the program (${layout.exports?.join(', ')})`,
    );
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
export interface ChunkTables {
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
 * An external function has a row with its body only when the emitter asked for it (`supplied`,
 * code 7: program indices); its own callees outside the chunk are then external too.
 */
export function encodeChunk(
  fns: readonly TypedFunc[],
  from: number,
  to: number,
  supplied: ReadonlySet<number> = new Set(),
): ChunkTables {
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const external = new Set<number>();
  const reach = (fn: TypedFunc): void => {
    for (const n of fn.nodes)
      for (const c of [n.callee, n.pred]) {
        const i = c === undefined ? undefined : (index.get(c) as number);
        if (i !== undefined && (i < from || i >= to)) external.add(i);
      }
  };
  for (const fn of fns.slice(from, to)) reach(fn);
  for (const g of [...supplied].sort((a, b) => b - a)) {
    external.add(g);
    reach(fns[g] as TypedFunc);
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
  const withBody = space.filter((g) => (g >= from && g < to) || supplied.has(g));
  const body = encodeBodies(
    withBody.map((g) => fns[g] as TypedFunc),
    (name) => (name === undefined ? 0 : (local.get(index.get(name) as number) ?? 0)),
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
      // opaque: the emitter reads only its node count (word 5) and asks for small bodies
      table.push(fn.literalIterations * 2, 0, 0, 0, 0, fn.nodes.length, 0);
      continue;
    }
    const params = fn.params.map((t) => intern(tb, t));
    const first = tb.tlist.length;
    tb.tlist.push(...params);
    const result = intern(tb, fn.result);
    for (const n of fn.nodes) ntys.push(intern(tb, fn.types.get(n.id) ?? 'u32'));
    table.push(1 + fn.literalIterations * 2, params.length, first, result, ...row);
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

// --- the optimizer: one a0w run per function (mode 7) ----------------------------------------

/**
 * A function body as the driver keeps it between runs: operands as (kind, value) pairs with
 * node references as positions, callees as program indices (-1 for none). The optimized body
 * of a function is all a later function needs of it (src/optimize.ts `optimizedCallee`).
 */
export interface BNode {
  readonly op: number;
  readonly callee: number;
  readonly pred: number;
  readonly type: Type;
  readonly args: readonly (readonly [number, number])[];
}
export interface Body {
  readonly params: readonly Type[];
  readonly result: Type;
  readonly nodes: readonly BNode[];
  readonly ret: readonly [number, number];
  /** `literalIterations` of the function (src/core.ts validateFunction). */
  readonly li: number;
}

/** A checked function as a body (callees as program indices). */
function bodyOf(fn: TypedFunc, index: ReadonlyMap<string, number>): Body {
  const ids = new Map(fn.nodes.map((n, i) => [n.id, i] as const));
  const at = (name: string | undefined): number =>
    name === undefined ? -1 : (index.get(name) as number);
  return {
    params: fn.params,
    result: fn.result,
    li: fn.literalIterations,
    nodes: fn.nodes.map((n) => ({
      op: irOp(n.op),
      callee: at(n.callee),
      pred: at(n.pred),
      type: fn.types.get(n.id) as Type,
      args: n.args.map((a) => operandPair(ids, a)),
    })),
    ret: operandPair(ids, fn.ret),
  };
}

/** A body as a checked-function-shaped record, for the table and source encoders. */
function funcOf(body: Body, name: string, names: readonly string[]): TypedFunc {
  const operand = ([k, v]: readonly [number, number]): Operand =>
    k === 1
      ? { kind: 'node', id: `n${v}` }
      : k === 2
        ? { kind: 'param', index: v }
        : k === 3
          ? { kind: 'u32', value: v }
          : { kind: 'bool', value: v !== 0 };
  const nodes = body.nodes.map((n, i) => ({
    id: `n${i}`,
    op: IR_OPS[n.op - 1] as Node['op'],
    args: n.args.map(operand),
    ...(n.callee >= 0 && (n.op === 19 || n.op === 20 || n.op === 21)
      ? { callee: names[n.callee] as string }
      : {}),
    ...(n.op === 21 ? { pred: names[n.pred] as string } : {}),
  }));
  return {
    name,
    params: body.params,
    result: body.result,
    nodes,
    ret: operand(body.ret),
    types: new Map(body.nodes.map((n, i) => [`n${i}`, n.type] as const)),
    staticIterations: 1,
    literalIterations: body.li,
    calls: new Map(),
  };
}

/** The types of a type table (triples and the field list), in index order. */
function decodeTypes(types: readonly number[], tlist: readonly number[]): Type[] {
  const out: Type[] = [];
  for (let i = 0; i < types.length; i += 3) {
    const [tag, a, b] = [types[i] as number, types[i + 1] as number, types[i + 2] as number];
    out.push(
      tag === 1
        ? 'u32'
        : tag === 2
          ? 'bool'
          : tag === 3
            ? 'io'
            : tag === 4
              ? { kind: 'arr', length: a, elem: out[b] as Type }
              : { kind: 'rec', fields: tlist.slice(a, a + b).map((f) => out[f] as Type) },
    );
  }
  return out;
}

/**
 * One function of a run's space: its body (always known here), and whether the run gets it
 * (otherwise the run sees only the facts of `summary`, and asks for the body when it needs it).
 */
interface Entry {
  readonly g: number;
  readonly body: Body;
  readonly supplied: boolean;
}

const wordsOf = (t: Type): number =>
  typeof t === 'string'
    ? 1
    : t.kind === 'arr'
      ? Math.min(65, t.length * wordsOf(t.elem))
      : Math.min(
          65,
          t.fields.reduce((n, f) => n + wordsOf(f), 0),
        );
const hasIo = (t: Type): boolean =>
  t === 'io' ||
  (typeof t !== 'string' && (t.kind === 'arr' ? hasIo(t.elem) : t.fields.some(hasIo)));
const isScalarType = (t: Type): boolean => t === 'u32' || t === 'bool';

/**
 * The facts about a function's types the optimizer's inlining and unrolling decisions read
 * (node count; bit 0 all parameters scalar, 1 result scalar, 2 all node types scalar, 3 some
 * type holds io, 4 result and node types at most 64 words each): data, not decisions.
 */
function summary(b: Body): [number, number] {
  const all = [b.result, ...b.nodes.map((n) => n.type)];
  const flags =
    (b.params.every(isScalarType) ? 1 : 0) |
    (isScalarType(b.result) ? 2 : 0) |
    (b.nodes.every((n) => isScalarType(n.type)) ? 4 : 0) |
    ([...b.params, ...all].some(hasIo) ? 8 : 0) |
    (all.every((t) => wordsOf(t) <= 64) ? 16 : 0);
  return [b.nodes.length, flags];
}

/** The words of mode 7 after the mode: the tables of the space, the summaries, the function. */
function encodeSpace(entries: readonly Entry[], own: number, image: boolean) {
  const local = new Map(entries.map((e, i) => [e.g, i] as const));
  const tb: Tables = {
    types: [1, 0, 0, 2, 0, 0, 3, 0, 0],
    typeIndex: new Map([
      ['u32', 0],
      ['bool', 1],
      ['io', 2],
    ]),
    tlist: [],
  };
  const table: number[] = [];
  const nodes: number[] = [];
  const ntys: number[] = [];
  const args: number[] = [];
  const sums: number[] = [];
  for (const e of entries) {
    const b = e.body;
    sums.push(...summary(b));
    if (!e.supplied) {
      table.push(b.li * 2, 0, 0, 0, 0, 0, 0);
      continue;
    }
    const params = b.params.map((t) => intern(tb, t));
    const first = tb.tlist.length;
    tb.tlist.push(...params);
    const result = intern(tb, b.result);
    const firstNode = nodes.length / 6;
    for (const n of b.nodes) {
      ntys.push(intern(tb, n.type));
      nodes.push(
        0,
        n.op,
        n.args.length,
        args.length / 2,
        n.callee < 0 ? 0 : (local.get(n.callee) as number),
        n.pred < 0 ? 0 : (local.get(n.pred) as number),
      );
      for (const [k, v] of n.args) args.push(k, v);
    }
    const ret = packRet([b.ret[0], b.ret[1]], args);
    table.push(1 + b.li * 2, params.length, first, result, firstNode, b.nodes.length, ret);
  }
  const fits =
    nodes.length / 6 <= CAP.nodes &&
    args.length / 2 <= CAP.operands &&
    entries.length <= CAP.fns &&
    tb.types.length / 3 <= CAP.types &&
    tb.tlist.length <= CAP.tlist;
  const words = [
    tb.types.length / 3,
    ...tb.types,
    tb.tlist.length,
    ...tb.tlist,
    entries.length,
    ...table,
    nodes.length / 6,
    ...nodes,
    ...ntys,
    args.length / 2,
    ...args,
    ...(image ? [] : sums),
    local.get(own) as number,
    // the stage word: 0 runs every pass of the optimizer (compiler/optimize.a0s `ozone`)
    ...(image ? [] : [0]),
  ];
  return { words, tb, fits };
}

/** The optimized body in a run's output words (code 0): nodes, ret, literal iterations. */
function decodeBody(
  out: Uint32Array,
  types: readonly Type[],
  space: readonly number[],
  orig: Body,
): Body {
  let at = 0;
  const n = out[at++] as number;
  const nodes: BNode[] = [];
  for (let i = 0; i < n; i += 1) {
    const op = out[at++] as number;
    const na = out[at++] as number;
    const callee = out[at++] as number;
    const pred = out[at++] as number;
    const type = types[out[at++] as number] as Type;
    const args: [number, number][] = [];
    for (let j = 0; j < na; j += 1) {
      args.push([out[at] as number, out[at + 1] as number]);
      at += 2;
    }
    nodes.push({
      op,
      callee: op === 19 || op === 20 || op === 21 ? (space[callee] as number) : -1,
      pred: op === 21 ? (space[pred] as number) : -1,
      type,
      args,
    });
  }
  const ret: [number, number] = [out[at] as number, out[at + 1] as number];
  return { params: orig.params, result: orig.result, nodes, ret, li: out[at + 2] as number };
}

/** The optimized body in the image of mode 8 (compiler/optimize.a0 `ozopt1`). */
function decodeImage(
  out: Uint32Array,
  types: readonly Type[],
  space: readonly number[],
  orig: Body,
): Body {
  const n = out[1] as number;
  const nodes: BNode[] = [];
  let pair = 8 + 5 * n;
  for (let i = 0; i < n; i += 1) {
    const at = 8 + 5 * i;
    const op = out[at] as number;
    const args: [number, number][] = [];
    for (let j = 0; j < (out[at + 1] as number); j += 1, pair += 2)
      args.push([out[pair] as number, out[pair + 1] as number]);
    nodes.push({
      op,
      callee: op === 19 || op === 20 || op === 21 ? (space[out[at + 2] as number] as number) : -1,
      pred: op === 21 ? (space[out[at + 3] as number] as number) : -1,
      type: types[out[at + 4] as number] as Type,
      args,
    });
  }
  return {
    params: orig.params,
    result: orig.result,
    nodes,
    ret: [out[2] as number, out[3] as number],
    li: out[4] as number,
  };
}

/** The requested chunk functions of a code-7 output (indices, then their count). */
function requested(out: Uint32Array): number[] {
  const k = out[out.length - 1] as number;
  return [...out.subarray(out.length - 1 - k, out.length - 1)];
}

export interface OptimizedProgram {
  readonly bodies: readonly Body[];
  /** a0w runs, including the reruns that supplied more callee bodies. */
  readonly runs: number;
}

const OPTIMIZED = new WeakMap<TypedProgram, OptimizedProgram>();

/**
 * The optimizer written in A0, function by function in program order: each run gets the
 * function (original body) and the optimized bodies of its callees; when it needs another
 * body (to evaluate a call with literal operands) it stops with code 7 and the indices, and
 * the run is repeated with those bodies and everything they reach. With `reference` the
 * callee bodies are those of src/optimize.ts instead of the A0 results (each function is then
 * checked on its own); with `image` the runs are mode 8 (the table entry `ozopt1`, which
 * computes the summaries itself and asks for every callee body).
 */
export function a0OptimizeProgram(
  exe: string,
  program: TypedProgram,
  reference?: readonly Body[],
  /** Bodies to use for functions that do not fit a run (a check only: the result is then not A0's). */
  fallback?: readonly Body[],
  image = false,
): OptimizedProgram {
  const plain = reference === undefined && fallback === undefined && !image;
  const known = plain ? OPTIMIZED.get(program) : undefined;
  if (known !== undefined) return known;
  const done = optimizeProgram(exe, program, reference, fallback, image);
  if (plain) OPTIMIZED.set(program, done);
  return done;
}

function optimizeProgram(
  exe: string,
  program: TypedProgram,
  reference: readonly Body[] | undefined,
  fallback: readonly Body[] | undefined,
  image: boolean,
): OptimizedProgram {
  const fns = program.functions;
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const bodies: Body[] = [];
  let runs = 0;
  for (let g = 0; g < fns.length; g += 1) {
    const orig = bodyOf(fns[g] as TypedFunc, index);
    const lib = (f: number): Body => (reference ?? bodies)[f] as Body;
    const refs = (b: Body): number[] =>
      b.nodes.flatMap((n) => [n.callee, n.pred]).filter((c) => c >= 0);
    const supplied = new Set<number>();
    for (;;) {
      const all = new Set<number>([g, ...refs(orig)]);
      for (const f of supplied) {
        all.add(f);
        for (const c of refs(lib(f))) all.add(c);
      }
      const space = [...all].sort((a, b) => a - b);
      const entries = space.map(
        (f): Entry =>
          f === g
            ? { g, body: orig, supplied: true }
            : { g: f, body: lib(f), supplied: supplied.has(f) },
      );
      const enc = encodeSpace(entries, g, image);
      if (!enc.fits) {
        if (fallback === undefined)
          throw new Error(`${(fns[g] as Func).name}: callee closure does not fit`);
        bodies.push(fallback[g] as Body);
        break;
      }
      const r = runTool32(exe, [image ? MODE.image : MODE.optimize, ...enc.words]);
      runs += 1;
      if (r.code === 0) {
        const types = decodeTypes(enc.tb.types, enc.tb.tlist);
        bodies.push((image ? decodeImage : decodeBody)(r.out, types, space, orig));
        break;
      }
      if (r.code !== NEEDS_BODIES)
        throw new Error(`a0w optimizer: code ${r.code} on ${(fns[g] as Func).name}`);
      const before = supplied.size;
      const wanted = image ? [...r.out.subarray(7, 7 + (r.out[6] as number))] : requested(r.out);
      const stack = wanted.map((c) => space[c] as number);
      while (stack.length > 0) {
        const f = stack.pop() as number;
        if (f === g || supplied.has(f)) continue;
        supplied.add(f);
        stack.push(...refs(lib(f)));
      }
      if (supplied.size === before)
        throw new Error(`a0w requested bodies it already has on ${(fns[g] as Func).name}`);
    }
  }
  return { bodies, runs };
}

/** src/optimize.ts on every function, as bodies. */
export function typescriptBodies(program: TypedProgram): Body[] {
  const index = new Map(program.functions.map((f, i) => [f.name, i] as const));
  return program.functions.map((f) => bodyOf(optimizeFunction(f).fn, index));
}

/** The checked program an optimized run stands for (for the emitters). */
export function optimizedProgram(program: TypedProgram, bodies: readonly Body[]): TypedProgram {
  const names = program.functions.map((f) => f.name);
  const functions = bodies.map((b, i) => funcOf(b, names[i] as string, names));
  return { functions, byName: new Map(functions.map((f) => [f.name, f] as const)) };
}

const bodyKey = (b: Body): string =>
  JSON.stringify([
    b.nodes.map((n) => [n.op, n.callee, n.pred, formatType(n.type), n.args]),
    b.ret,
    b.li,
  ]);

export interface IrCheck {
  readonly functions: number;
  readonly identical: number;
  readonly runs: number;
  /** The first function whose optimized IR differs. */
  readonly firstDifference?: string;
  /** Functions no run can take (over the table capacities); not counted identical. */
  readonly notRun: readonly string[];
}

/**
 * The A0 optimizer's IR against src/optimize.ts: every function on its own (with the
 * reference callee bodies) and the whole chain (A0 results feeding later runs).
 */
export function a0IrCheck(exe: string, program: TypedProgram): IrCheck {
  const fns = program.functions;
  const want = typescriptBodies(program);
  const notRun: string[] = [];
  let chain: OptimizedProgram;
  try {
    chain = a0OptimizeProgram(exe, program);
  } catch {
    // A function does not fit a run: the rest is checked with its reference body in its place.
    chain = a0OptimizeProgram(exe, program, undefined, want);
    for (const [g, f] of fns.entries()) if (chain.bodies[g] === want[g]) notRun.push(f.name);
  }
  let identical = 0;
  let firstDifference: string | undefined;
  for (const [g, f] of fns.entries()) {
    if (notRun.includes(f.name)) continue;
    if (bodyKey(chain.bodies[g] as Body) === bodyKey(want[g] as Body)) identical += 1;
    else firstDifference ??= f.name;
  }
  return {
    functions: fns.length,
    identical,
    runs: chain.runs,
    notRun,
    ...(firstDifference === undefined ? {} : { firstDifference }),
  };
}

/** The largest chunk of table encodings from `from` on. */
function nextChunk(fns: readonly TypedFunc[], from: number): number {
  let to = from + 1;
  if (!encodeChunk(fns, from, to).fits)
    throw new Error(`${(fns[from] as Func).name} does not fit the tables`);
  while (to < fns.length && encodeChunk(fns, from, to + 1).fits) to += 1;
  return to;
}

export interface ModuleRun {
  readonly bytes: Uint8Array;
  readonly chunks: number;
  /** Runs of optimized chunks, including the reruns that supplied bodies. */
  readonly runs: number;
}

/** Options of the emitters that tests vary (src/wasm.ts `WasmEmitOptions`; defaults: simd on, 1). */
export interface EmitOptions {
  readonly simd?: boolean;
  readonly unroll?: 1 | 2 | 4;
}

/** The trailing words of mode 2: the simd option (2: off) and the unroll option (0: 1). */
const optionWords = (o: EmitOptions): number[] => [
  o.simd === false ? 2 : 1,
  o.unroll === 1 ? 0 : (o.unroll ?? 0),
];

/** What a chunk of the emitter adds to the module: its output and the runs it took. */
interface Emitted {
  readonly out: ChunkOutput;
  readonly runs: number;
  /** The functions the chunk covers: [from, to). */
  readonly to: number;
}

/**
 * Functions [from, to) as one run of mode 2. The emitter asks (code 7) for the bodies of external
 * functions it needs (its own requests, the shape analyses', the fusion's): the run is repeated
 * with their rows and bodies in the tables. Undefined when a table of the chunk is full (the
 * chunk is too big, also with the room loop fusion needs): the caller cuts it.
 */
function emitTables(
  exe: string,
  fns: readonly TypedFunc[],
  from: number,
  to: number,
  base: number,
  calls: ReadonlyMap<number, [number, number]>,
  tail: readonly number[],
): Emitted | undefined {
  const supplied = new Set<number>();
  let chunk = encodeChunk(fns, from, to);
  let runs = 0;
  for (;;) {
    if (!chunk.fits) return undefined;
    const table = chunk.before.flatMap((g) => calls.get(g) as [number, number]);
    const r = runTool32(exe, [
      MODE.tables,
      base,
      chunk.before.length,
      ...table,
      ...chunk.words,
      ...tail,
    ]);
    runs += 1;
    if (r.code === 0) return { out: splitChunk(r.out), runs, to };
    if (r.code === CAPACITY) return undefined;
    if (r.code !== NEEDS_BODIES) throw new Error(`a0w: code ${r.code} on functions ${from}..${to}`);
    const before = supplied.size;
    for (const c of requested(r.out)) supplied.add(chunk.space[c] as number);
    if (supplied.size === before)
      throw new Error(`a0w requested bodies it already has on functions ${from}..${to}`);
    chunk = encodeChunk(fns, from, to, supplied);
  }
}

/**
 * The A0 emitter's module for a checked program, chunk by chunk as tables (mode 2), after the
 * optimizer written in A0 when `optimize`. A chunk is the most functions that fit the tables of
 * one run; one that turns out too big (loop fusion, or the bodies the emitter asked for, need
 * room) is cut in two.
 */
export function a0WasmFromTables(
  exe: string,
  source: TypedProgram,
  layout: WasmLayout,
  optimize = false,
  options: EmitOptions = {},
): ModuleRun {
  const opt = optimize ? a0OptimizeProgram(exe, source) : undefined;
  const program = opt === undefined ? source : optimizedProgram(source, opt.bodies);
  const fns = program.functions;
  const calls = new Map<number, [number, number]>();
  const outputs: ChunkOutput[] = [];
  const tail = optionWords(options);
  let base = 0;
  let from = 0;
  let runs = opt?.runs ?? 0;
  while (from < fns.length) {
    let to = nextChunk(fns, from);
    let done = emitTables(exe, fns, from, to, base, calls, tail);
    while (done === undefined) {
      if (to - from < 2) throw new Error(`${(fns[from] as Func).name} and its callees do not fit`);
      to = from + Math.ceil((to - from) / 2);
      done = emitTables(exe, fns, from, to, base, calls, tail);
    }
    runs += done.runs;
    for (const [i, [idx, depth]] of done.out.calls.entries()) calls.set(from + i, [idx, depth]);
    outputs.push(done.out);
    base += done.out.variants;
    from = to;
  }
  return { bytes: linkChunks(exe, outputs, layout), chunks: outputs.length, runs };
}

// --- mode 1: source through the A0 front end --------------------------------------------

/** A chunk of source for mode 1 (see `sourceChunk`). */
interface SourceChunk extends Chunk {
  /** Functions before `cfrom` are stubs, [cfrom, own) bodies supplied for the emitter. */
  readonly cfrom: number;
  /** The node counts of the functions before `cfrom` (the optimized callees' sizes). */
  readonly counts: readonly number[];
  readonly ownStart: number;
  readonly ownEnd: number;
}

const signatureOf = (f: Func): string => formatFunction(f).split('\n')[0] as string;

/**
 * Functions [from, to) of the (optimized) program as the source of one chunk of mode 1: a
 * prelude function naming every header type of the program, a stub for each callee outside the
 * chunk, the full bodies of the callees in `supplied` (what the emitter asked for), then the
 * chunk's functions. A program within the capacities of the front end is one chunk as written.
 */
function sourceChunk(
  fns: readonly TypedFunc[],
  forms: readonly TypedFunc[],
  from: number,
  to: number,
  supplied: ReadonlySet<number>,
  prelude: string,
): SourceChunk {
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const callees = (f: Func): number[] =>
    f.nodes.flatMap((n) =>
      [n.callee, n.pred].flatMap((c) => {
        const i = c === undefined ? undefined : index.get(c);
        return i !== undefined && (i < from || i >= to) ? [i] : [];
      }),
    );
  const bodies = [...supplied].sort((a, b) => a - b);
  const called = new Set<number>();
  for (const f of fns.slice(from, to)) for (const i of callees(f)) called.add(i);
  for (const g of bodies) for (const i of callees(fns[g] as Func)) called.add(i);
  const stubs = [...called].filter((i) => !supplied.has(i)).sort((a, b) => a - b);
  const text = (i: number): string => `${formatFunction(forms[i] as Func)}\n`;
  const source = [
    prelude,
    ...stubs.map((i) => `${signatureOf(fns[i] as Func)}\nret 0\nend\n`),
    ...bodies.map(text),
    ...Array.from({ length: to - from }, (_, k) => text(from + k)),
  ].join('');
  return {
    source,
    head: from === 0,
    strict: false,
    before: [
      PRELUDE,
      ...stubs.map((i) => (fns[i] as Func).name),
      ...bodies.map((i) => (fns[i] as Func).name),
    ],
    own: fns.slice(from, to).map((f) => f.name),
    cfrom: 1 + stubs.length,
    counts: [1, ...stubs.map((i) => (fns[i] as TypedFunc).nodes.length)],
    ownStart: from,
    ownEnd: to,
  };
}

/**
 * A function as the A0 front end takes it. The front end packs the ret operand as kind * 2^28 plus
 * value (compiler/parse.a0), which cannot hold a u32 literal of 2^28 or more (the tables of
 * mode 2 use a kind-5 operand for it): such a ret is bound to a node first.
 */
function frontEndForm(f: TypedFunc): TypedFunc {
  if (f.ret.kind !== 'u32' || f.ret.value < 2 ** 28) return f;
  const id = 'a0retlit';
  return { ...f, nodes: [...f.nodes, { id, op: 'mov', args: [f.ret] }], ret: { kind: 'node', id } };
}

/** The header types of a program, in a fixed order, as the prelude function of its chunks. */
function preludeOf(fns: readonly Func[]): string {
  const types: string[] = [];
  for (const f of fns)
    for (const t of signatureOf(f)
      .split(' ')
      .slice(2)
      .filter((w) => w !== '->'))
      if (!types.includes(t)) types.push(t);
  return `fn ${PRELUDE} ${types.join(' ')} -> u32\nret 0\nend\n`;
}

/**
 * The A0 emitter's module for a program source through the A0 front end (mode 1), after the
 * optimizer written in A0 when `optimize`. A program within the capacities of the front end is
 * one chunk as written; a larger one is cut at function boundaries: each chunk has stubs for
 * its callees outside it, and the bodies of the callees the emitter asks for (code 7) as checked
 * functions that are not emitted; a chunk that is too big (front end capacity, tables of the
 * emitter) is cut in two.
 */
export function a0WasmFromSource(
  exe: string,
  source: TypedProgram,
  layout: WasmLayout,
  optimize = false,
  options: EmitOptions = {},
): { bytes?: Uint8Array; code: number; chunks: number; runs: number; failed?: Chunk } {
  const opt = optimize ? a0OptimizeProgram(exe, source) : undefined;
  const program = opt === undefined ? source : optimizedProgram(source, opt.bodies);
  const fns = program.functions;
  const tail = optionWords(options);
  const calls = new Map<string, [number, number, number]>();
  const outputs: ChunkOutput[] = [];
  const forms = fns.map(frontEndForm);
  const prelude = preludeOf(fns);
  const text = formatProgram({ functions: forms });
  // the chunks of tools/bootstrap.ts planChunks are the first guess of where to cut
  const plan = planChunks(text);
  const planned =
    plan[0] !== undefined && plan[0].own.length === 0
      ? [fns.length]
      : plan.map((c) => c.own.length);
  const ends = planned.map((_, i) => planned.slice(0, i + 1).reduce((a, b) => a + b, 0));
  let runs = opt?.runs ?? 0;
  let base = 0;
  let failed: SourceChunk | undefined;
  let code = 0;
  /** One chunk through the A0 front end and the emitter: its output, or undefined when too big. */
  const run = (from: number, to: number): ChunkOutput | undefined => {
    const supplied = new Set<number>();
    const whole = plan[0] !== undefined && plan[0].own.length === 0;
    for (;;) {
      const chunk: SourceChunk = whole
        ? {
            source: text,
            head: true,
            strict: false,
            before: [],
            own: [],
            cfrom: 0,
            counts: [],
            ownStart: from,
            ownEnd: to,
          }
        : sourceChunk(fns, forms, from, to, supplied, prelude);
      if (!whole && !frontEndFits(chunk.source)) return undefined;
      const bytes = [...Buffer.from(chunk.source)];
      const none: [number, number, number] = [0, 0, 0];
      const before = chunk.before.map((name): [number, number, number] =>
        name === PRELUDE ? none : (calls.get(name) ?? none),
      );
      const words = [bytes.length, ...bytes, chunk.head ? 1 : 0, 0, before.length];
      words.push(...before.map(([, , bound]) => bound), base);
      for (const [idx, depth] of before) words.push(idx, depth);
      words.push(chunk.cfrom, ...chunk.counts);
      const r = runTool32(exe, [MODE.source, ...words, ...tail]);
      runs += 1;
      if (r.code === 0) return splitChunk(r.out);
      if (r.code === CAPACITY) return undefined;
      if (r.code === NEEDS_BODIES) {
        const space = [...chunk.before, ...chunk.own];
        const index = new Map(fns.map((f, i) => [f.name, i] as const));
        const before = supplied.size;
        for (const c of requested(r.out)) supplied.add(index.get(space[c] as string) as number);
        if (supplied.size > before) continue;
      }
      failed = chunk;
      code = r.code;
      return undefined;
    }
  };
  let from = 0;
  while (from < fns.length) {
    let to = ends.find((e) => e > from) ?? fns.length;
    let out = run(from, to);
    while (out === undefined && failed === undefined) {
      if (to - from < 2) throw new Error(`${(fns[from] as Func).name} does not fit a chunk`);
      to = from + Math.ceil((to - from) / 2);
      out = run(from, to);
    }
    if (out === undefined)
      return { code, chunks: outputs.length + 1, runs, failed: failed as Chunk };
    for (const [i, name] of fns.slice(from, to).entries())
      calls.set(name.name, out.calls[i] as [number, number, number]);
    outputs.push(out);
    base += out.variants;
    from = to;
  }
  return { bytes: linkChunks(exe, outputs, layout), code: 0, chunks: outputs.length, runs };
}

/** The reference: src/wasm.ts on the program, unoptimized or with the default optimization. */
export function typescriptWasm(
  program: TypedProgram,
  layout: WasmLayout,
  optimize = false,
  options: EmitOptions = {},
): Uint8Array {
  return wasmModuleBytes(
    compile(program, 'wasm', {
      ...(optimize ? {} : { optimize: false }),
      ioInputCapacity: layout.ioInputCapacity,
      ioOutputCapacity: layout.ioOutputCapacity,
      ...(layout.exports === undefined ? {} : { wasmExports: layout.exports }),
      ...(options.simd === false ? { wasmSimd: false } : {}),
      ...(options.unroll === undefined ? {} : { wasmUnroll: options.unroll }),
    }).text,
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
    readonly error?: string;
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
  let tables: ModuleRun;
  try {
    tables = a0WasmFromTables(tool.exe, program, layout, optimize);
  } catch (err) {
    // A function over the table capacities (site/page.a0 `session`): reported, not fatal.
    return {
      moduleBytes: reference.length,
      tables: {
        chunks: 0,
        runs: 0,
        ms: Math.round(performance.now() - t0),
        identical: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
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
  const tables = `tables: ${t.identical ? 'identical' : t.error !== undefined ? `ERROR ${t.error}` : `DIFFERS at byte ${t.firstDifference}`} (${t.chunks} chunk(s), ${t.runs} run(s), ${t.ms} ms)`;
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
      `${label.padEnd(14)} IR ${ir.identical}/${ir.functions} functions identical to src/optimize.ts${ir.firstDifference === undefined ? '' : ` (first difference: ${ir.firstDifference})`}${ir.notRun.length > 0 ? ` (not run, over the table capacities: ${ir.notRun.join(' ')})` : ''} (${ir.ms} ms)\n`,
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
      'wasm32 emitter written in A0 (compiler/emit_wasm.a0; entry emitwasmio in compiler/boot.a0), the port of src/wasm.ts, with the optimizer written in A0 (compiler/optimize.a0, generated from compiler/optimize.a0s by tools/a0s.ts), the port of src/optimize.ts',
    method:
      'a0c-stage1 (the bootstrap C seed) compiles the closure of emitwasmio in chunks; clang builds that C into a0w. The optimizer runs one function a run (mode 7), in program order, each run given the optimized bodies of the callees it asks for (code 7, then rerun); its output is compared function by function with optimizeFunction (nodes in order, ops, operands, callee, predicate, node type, ret, literal iterations). Each program is then emitted a chunk of functions at a time from the optimized (or the original) program, as the checked tables of the TypeScript front end in the A0 front end layout (mode 2) and, where every chunk fits the A0 front end (131072 source bytes a chunk), as formatted source through the A0 lexer, parser and checker (mode 1); a0w links the chunks into the module (mode 3). Unoptimized modules are compared byte for byte with src/wasm.ts on the unoptimized program, optimized ones with compile(program, wasm) (default options: src/optimize.ts).',
    tool,
    programs: reports,
    failed: failed.length,
  };
  await mkdir('results', { recursive: true });
  await writeReport(join('results', 'selfhost-wasm.json'), report);
  process.stdout.write(`${reports.length - failed.length}/${reports.length} programs identical\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
