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
 *   front end (mode 1, `a0WasmFromSource`; a ret of a literal of 2^28 or more is a kind-5 operand). A chunk is the most functions that fit one run; one
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
  assertTargetSupports,
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
import { findClang, runTool, spawnWithInput, type ToolInfo } from '../src/toolchain.js';
import { type WasmLayout, wasmModuleBytes } from '../src/wasm.js';
import { BEHAVIOR_SPEC } from './behavior-spec.js';
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
import { KERNELS } from './exec-bench-kernels.js';
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
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
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
#ifdef _WIN32
  /* the words are binary: no newline or end-of-file translation */
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
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
  const r = spawnWithInput(exe, input, { timeout: 600_000, maxBuffer: 1 << 28 });
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
  // the A0 emitter implements the canonical profile and no checked op (as its drivers refuse)
  assertTargetSupports('a0w', source);
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
  const text = (i: number): string => `${formatFunction(fns[i] as Func)}\n`;
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
  // the A0 emitter implements the canonical profile and no checked op (as its drivers refuse)
  assertTargetSupports('a0w', source);
  const opt = optimize ? a0OptimizeProgram(exe, source) : undefined;
  const program = opt === undefined ? source : optimizedProgram(source, opt.bodies);
  const fns = program.functions;
  const tail = optionWords(options);
  const calls = new Map<string, [number, number, number]>();
  const outputs: ChunkOutput[] = [];
  const prelude = preludeOf(fns);
  const text = formatProgram({ functions: fns });
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
        : sourceChunk(fns, from, to, supplied, prelude);
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

const FILL_ZEROS = Array.from({ length: 16 }, () => '0').join(' ');
/**
 * Sliding reads of an extra argument (src/wasm.ts `slidingRead`): at p1 and p1 + 1 in an array
 * fold body and a scalar one (either operand order, more trips than elements), a next read in a
 * select arm, and a scalar callee with gets inlined after such a loop (no stale loop-host words).
 */
const SLIDE_SOURCE = `fn sfill u32x16 u32 u32 -> u32x16
v mul p1 p2
w xor v 77
n set p0 p1 w
ret n
end
fn ssmooth u32x16 u32 u32x16 -> u32x16
j add p1 1
u get p2 p1
v get p2 j
w add u v
s shr w 1
n set p0 p1 s
ret n
end
fn sdiff u32 u32 u32x16 -> u32
j add 1 p1
u get p2 p1
v get p2 j
d xor u v
r add p0 d
ret r
end
fn slazy u32 u32 u32x16 -> u32
j add p1 1
u get p2 p1
v get p2 j
m mul v 3
c lt u 40
s select c m u
r add p0 s
ret r
end
fn spick u32x16 u32 -> u32
a get p0 p1
j add p1 1
b get p0 j
s sub a b
ret s
end
fn slide u32 u32 -> u32
z arr ${FILL_ZEROS}
a fold sfill 16 z p0
z2 arr ${FILL_ZEROS}
b fold ssmooth 16 z2 a
c fold sdiff 21 p1 b
d fold slazy 16 c a
e call spick b p1
r add d e
ret r
end`;

/**
 * Reductions run four trips a vector trip (src/wasm.ts `reduceRun`): add, and, xor and or folds
 * over array reads, the index, compares, bool and u32 selects (a zero second arm is a mask), shifts
 * by a literal and by an extra, literal counts below, at and above the array length and a
 * variable count (which wraps past the length), and `te`, a reduction with no array.
 */
const REDUCE_SOURCE = `fn fill u32x16 u32 u32 -> u32x16
m mul p1 p2
x xor m 2654435761
s shr x 3
n set p0 p1 s
ret n
end
fn r1 u32 u32 u32x16 u32 -> u32
v get p2 p1
w xor v p3
c lt w p1
s select c v w
r add p0 s
ret r
end
fn r2 u32 u32 u32x16 -> u32
v get p2 p1
o or v p1
r and p0 o
ret r
end
fn r3 u32 u32 u32x16 u32 -> u32
v get p2 p1
s shl v 3
t shr v p3
x xor s t
r xor x p0
ret r
end
fn r4 u32 u32 u32x16 -> u32
v get p2 p1
c eq v 0
d ne p1 5
e or c d
f select e true false
g select f 7 9
r or p0 g
ret r
end
fn r5 u32 u32 u32 -> u32
a add p1 p2
m mul a 3
r add p0 m
ret r
end
fn r6 u32 u32 u32x16 u32x16 -> u32
v get p2 p1
w get p3 p1
c ge v w
d and c true
s select d 1 0
r add p0 s
ret r
end
fn t1 u32 u32 -> u32
z arr 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
a fold fill 16 z p0
n and p0 31
k1 fold r1 n p1 a p1
k2 fold r2 13 k1 a
k3 fold r3 n k2 a p1
k4 fold r4 3 k3 a
k5 fold r5 20 k4 p0
q and p1 7
k6 fold r6 q k5 a a
k7 fold r1 16 k6 a p0
k8 fold r4 n k7 a
ret k8
end
`;

/**
 * Select groups (src/optimize.ts `lazyArms`): selects sharing a condition emitted as one branch,
 * at top level (`g1`), in an inlined fold body whose condition is a known constant on one fold
 * and not on the other (`gb`), in an owned body with a carried read (`gc`), and as the leader of a
 * group that is also the carried read's guarded select (`gk`: the group wins).
 */
const SELECT_GROUP_SOURCE = `fn g1 u32 u32 -> u32
c lt p0 p1
a mul p0 p1
b add a 7
x select c b p0
d xor p0 p1
e mul d 5
f shl e 3
y select c p1 f
z select c 3 d
s add x y
t add s z
ret t
end
fn gb u32 u32 u32 -> u32
c eq p2 0
a mul p0 p1
b add a 7
x select c b p0
d xor p0 p1
e mul d 5
f shl e 3
g add f p1
y select c p1 g
s add x y
ret s
end
fn t2 u32 u32 -> u32
r fold gb 9 p0 0
q and p1 255
s fold gb q r 1
ret s
end
fn gc u32x8 u32 -> u32x8
c eq p1 0
j sub p1 1
t get p0 j
m mul t 7
n xor m 99
o shl n 2
s select c 5 o
u select c 9 n
w add s u
q set p0 p1 w
ret q
end
fn t3 u32 u32 -> u32
z arr 1 2 3 4 5 6 7 8
a fold gc 8 z
b and p0 7
v get a b
ret v
end
fn gk u32x8 u32 -> u32x8
c eq p1 0
j sub p1 1
t get p0 j
m mul p1 7
n1 xor m 99
n2 mul n1 3
n3 shl n2 2
n4 add n3 p1
s select c n4 m
w select c 3 t
x add s w
r set p0 p1 x
ret r
end
fn t4 u32 u32 -> u32
z arr 1 2 3 4 5 6 7 8
a fold gk 8 z
b and p0 7
v get a b
ret v
end
`;

/**
 * Folds whose carried previous-element read is `select (eq p1 0) K get` (src/wasm.ts
 * `guardedCarry`): the carry starts as K; `twice` reads the carried value outside the select,
 * so it keeps the load.
 */
const CARRY_SELECT_SOURCE = `fn pfx u32x8 u32 -> u32x8
c eq p1 0
j sub p1 1
t get p0 j
u select c 7 t
s get p0 p1
v mul u 3
w add v s
n set p0 p1 w
ret n
end
fn psum u32x64 u32 -> u32x64
c eq p1 0
j sub p1 1
t get p0 j
u select c 0 t
s get p0 p1
v add u s
n set p0 p1 v
ret n
end
fn twice u32x8 u32 -> u32x8
c eq p1 0
j sub p1 1
t get p0 j
u select c 5 t
s get p0 p1
v add u s
w xor v t
n set p0 p1 w
ret n
end
fn main u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b fold pfx 8 a
c fold twice 8 b
z arr ${Array.from({ length: 64 }, () => 'p1').join(' ')}
d fold psum 64 z
e get c 7
f get d 63
g add e f
ret g
end
`;

/**
 * Carried-element folds unrolled by 4 (src/wasm.ts `CARRY_UNROLL`): a literal count with a
 * remainder (7: one 4-copy phase, then 3 single trips), a count below 4 (no unrolling), a count
 * that is a multiple of 4, and a variable count (the option decides).
 */
const CARRY_UNROLL_SOURCE = `fn pfx u32x16 u32 -> u32x16
c eq p1 0
j sub p1 1
t get p0 j
u select c 1 t
s get p0 p1
v add u s
n set p0 p1 v
ret n
end
fn main u32 u32 -> u32
z arr ${Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 'p0' : 'p1')).join(' ')}
a fold pfx 7 z
b fold pfx 3 a
c fold pfx 16 b
k and p1 15
d fold pfx k c
e get a 6
f get b 2
g get c 15
h get d 9
r add e f
r2 add r g
r3 xor r2 h
ret r3
end
`;

/**
 * Stores forwarded to the next trip's read (src/wasm.ts `carriedRead`): an insertion sort sinking
 * by swaps in a `loop` (read at p2 - p1, last store at p2 - p1 - 1; length 10, so the first-trip
 * index wraps by rem), a fold storing at p1 + 3 that the next trip reads at p1 + 2, and one reading
 * at p1 - p2 (a coefficient of -1 on the extra) with that extra a local and a literal.
 */
const CARRY_FWD_SOURCE = `fn swp u32x10 u32 u32 -> u32x10
j sub p2 p1
i1 sub j 1
u get p0 i1
v get p0 j
b set p0 j u
c set b i1 v
ret c
end
fn swpok u32x10 u32 u32 -> bool
j sub p2 p1
i1 sub j 1
u get p0 i1
v get p0 j
g gt u v
ret g
end
fn ins u32x10 u32 -> u32x10
r loop swpok swp p1 p0 p1
ret r
end
fn ahd u32x12 u32 u32 -> u32x12
j add p1 2
v get p0 j
w mul v 3
x add w p2
k add p1 3
n set p0 k x
ret n
end
fn back u32x16 u32 u32 -> u32x16
r sub p1 p2
v get p0 r
x mul v 5
w add r 1
n set p0 w x
ret n
end
fn main u32 u32 -> u32
a arr p0 p1 7 3 p1 9 0 p0 3000000000 5
s fold ins 10 a
b arr p0 1 2 3 4 5 6 7 8 9 10 p1
t fold ahd 9 b p1
c arr ${Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 'p1' : String(i))).join(' ')}
k and p0 7
u fold back k c p1
w fold back 5 u 3
q rem p1 10
e get s q
f get t 11
g get w 6
h get s 0
r add e f
r2 add r g
r3 xor r2 h
ret r3
end
`;

/**
 * Small `loop` state in locals (src/wasm.ts `scalarState`, the predicate reading the words too): a
 * lower-bound search with (lo, hi) record state over an array extra and a variable count (an
 * update chain whose second `put` has a chain node for its base: every word carries over), a
 * three-word array state rebuilt by `arr` (a swap) with a predicate on an extra, and a predicate
 * reading the state at a variable index (no scalar replacement: the state stays in storage).
 */
const LOOP_STATE_SOURCE = `fn lbok (u32,u32) u32 u32x16 u32 -> bool
lo at p0 0
hi at p0 1
c lt lo hi
ret c
end
fn lbst (u32,u32) u32 u32x16 u32 -> (u32,u32)
lo at p0 0
hi at p0 1
s add lo hi
m shr s 1
v get p2 m
c lt v p3
m1 add m 1
nlo select c m1 lo
nhi select c hi m
r put p0 0 nlo
r2 put r 1 nhi
ret r2
end
fn rot u32x3 u32 u32 -> u32x3
a get p0 0
b get p0 1
c get p0 2
d add a p2
r arr b c d
ret r
end
fn rotok u32x3 u32 u32 -> bool
a get p0 0
g lt a p2
ret g
end
fn vok u32x4 u32 u32 -> bool
k and p1 3
v get p0 k
g lt v p2
ret g
end
fn vst u32x4 u32 u32 -> u32x4
a get p0 0
b add a p1
n set p0 0 b
ret n
end
fn main u32 u32 -> u32
t arr 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 31
st rec 0 16
k and p0 7
n add k 4
r loop lbok lbst n st t p1
lo at r 0
w arr p0 1 2
q loop rotok rot 9 w p1
q0 get q 0
q2 get q 2
x arr p1 0 4 9
y loop vok vst 6 x 5
y0 get y 0
a add lo q0
b xor a q2
c add b y0
ret c
end
`;

/**
 * In-place updates through borrows and records (src/wasm.ts `mutableHere`, `#recContainer`): a
 * binary-heap sift-down whose step updates the `at` borrow of its record state and rebuilds the
 * record in that state's storage (`sdstep`, run by a `loop` in `pop`, itself a fold), folds
 * chained on a fold result (`bump`), and the cases kept as copies: a nested row written back
 * into its container (`rowstep`: the container is named again after the row's update), an old
 * borrow read after the update (`keepold`), a record of two aggregate fields (`twin`: its own
 * slot, and its first `set` copies, as the other field's borrow is read after it) and the value
 * variant of a call (`valuevar`).
 */
const INPLACE_SOURCE = `fn sdok (u32x8,u32) u32 u32 -> bool
h at p0 0
j at p0 1
l shl j 1
r add l 1
inl le l p2
inr le r p2
lv get h l
rv get h r
rl lt rv lv
pr and inr rl
c select pr r l
cv get h c
jv get h j
g lt cv jv
ok and inl g
ret ok
end
fn sdstep (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
j at p0 1
l shl j 1
r add l 1
inr le r p2
lv get h l
rv get h r
rl lt rv lv
pr and inr rl
c select pr r l
cv get h c
jv get h j
a set h j cv
b set a c jv
s rec b c
ret s
end
fn pop (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
n sub 7 p1
top get h 1
last get h n
a set h 1 last
m sub n 1
st rec a 1
r loop sdok sdstep 3 st m
b at r 0
x xor acc top
y mul x 33
o rec b y
ret o
end
fn rowstep u32x4x4 u32 u32 -> u32x4x4
i shr p1 2
j and p1 3
row get p0 i
v get row j
w mul v p2
x add w p1
nrow set row j x
g set p0 i nrow
ret g
end
fn keepold (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
h2 at p0 0
a set h 1 p1
x get h2 1
o rec a x
ret o
end
fn twin (u32x4,u32x4,u32) u32 -> (u32x4,u32x4,u32)
f at p0 0
g at p0 1
k at p0 2
a set f 1 p1
b set g 2 k
o rec a b p1
ret o
end
fn bump u32x8 u32 u32 -> u32x8
v get p0 p1
w add v p2
n set p0 p1 w
ret n
end
fn valuevar (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
a set h 2 p1
o rec a p1
ret o
end
fn inplace u32 u32 -> u32
z arr 0 p0 p1 5 9 2 7 4
q fold bump 8 z p1
r fold bump 8 q p0
c set r 3 77
st rec c 5
s fold pop 7 st
k at s 1
hz at s 0
e get hz 2
g arr 1 2 3 4
gz arr g g g g
m fold rowstep 16 gz p0
m2 get m 2
m3 get m2 1
t1 rec r 9
t2 fold keepold 3 t1
t3 at t2 1
w arr p0 1 2 3
w2 arr 4 p1 6 7
tw rec w w2 p1
tw2 fold twin 2 tw
tw3 at tw2 1
tw4 get tw3 2
vv call valuevar t1 p1
vv1 at vv 0
vv2 get vv1 2
hz2 at t1 0
vv3 get hz2 2
o1 add k e
o2 add o1 m3
o3 add o2 t3
o4 add o3 tw4
o5 add o4 vv2
o6 add o5 vv3
ret o6
end
`;

/**
 * Reads that a lazy select arm emits after an in-place update (src/wasm.ts `liveAfter`): an
 * element read before a `set` of a literal array (`lzr`) and of a fold result (`lzf`), and a read
 * of the `at` borrow of the owned record state before a `set` through it (`lzb`), each used only
 * by the costly arm of a later select. The updates stay copies.
 */
const LAZY_READ_SOURCE = `fn fl u32x8 u32 u32 -> u32x8
a mul p1 p2
b xor a p1
n set p0 p1 b
ret n
end
fn lzr u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
v get a 2
w0 mul v 7
w1 div w0 3
w2 rem w1 5
w3 mul w2 w1
w4 div w3 p1
b set a 2 99
c lt p0 p1
s select c w4 p0
x get b 2
r add s x
ret r
end
fn lzf u32 u32 -> u32
z arr 0 0 0 0 0 0 0 0
a fold fl 8 z p0
v get a p1
w0 mul v 7
w1 div w0 3
w2 rem w1 5
w3 mul w2 w1
w4 div w3 p1
b set a p1 99
c lt p0 p1
s select c w4 p0
x get b 2
r add s x
ret r
end
fn lzb (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
k at p0 1
v get h p1
w0 mul v 7
w1 div w0 3
w2 rem w1 5
w3 mul w2 w1
w4 div w3 k
a set h p1 k
c lt p1 k
s select c w4 p1
o rec a s
ret o
end
fn lzd u32 u32 -> u32
z arr p0 p1 3 4 5 6 7 8
st rec z p1
r fold lzb 5 st
q at r 0
q1 get q 3
q2 at r 1
o add q1 q2
ret o
end
fn lazy u32 u32 -> u32
a call lzr p0 p1
b call lzf p1 p0
c call lzd p0 p1
d add a b
e add d c
ret e
end
`;

/**
 * Element pointers (src/wasm.ts `#pointers`, `affineInRange`) and rotated loops: two reads of one
 * extra one apart (one pointer), a stride of -1 beside a lone read at the bare trip index (that
 * one keeps its indexed address), five arrays (two read at p1 + 1 through pointers, two at the
 * bare trip index, the fifth past the group cap), reads at n - p1 and p1 - n + 12 (coefficients
 * of the extra 1 and -1) under a count that is that extra (the outer trip index below 12, a
 * local; a parameter with a literal source), accesses that stay indexed (a stride of 2, p1 + 1 on
 * the last trip, a count with no bound), prefix sums in place, a search whose predicate alone
 * reads through a pointer, and rotated loops whose predicate is called (too large) or whose body
 * is called.
 */
const POINTER_SOURCE = `fn sum2 u32 u32 u32x16 -> u32
v get p2 p1
j add p1 1
w get p2 j
x add v w
r add p0 x
ret r
end
fn rev u32 u32 u32x16 -> u32
j sub 15 p1
v get p2 j
u get p2 p1
m mul p0 3
x add m v
r xor x u
ret r
end
fn five u32 u32 u32x8 u32x8 u32x8 u32x8 u32x8 -> u32
j add p1 1
a get p2 j
b get p3 j
c get p4 p1
d get p5 p1
e get p6 p1
s1 add a b
s2 add c d
s3 add s1 s2
s4 xor s3 e
m mul p0 5
r add m s4
ret r
end
fn tail u32 u32 u32x16 u32 -> u32
k sub p3 p1
v get p2 k
k1 sub k 1
w get p2 k1
x mul v w
r add p0 x
ret r
end
fn head u32 u32 u32x16 u32 -> u32
k sub p1 p3
k2 add k 12
v get p2 k2
r add p0 v
ret r
end
fn outer u32 u32 u32x16 -> u32
a fold tail p1 p0 p2 p1
b fold head p1 a p2 p1
ret b
end
fn mid u32 u32 u32x16 u32 -> u32
s fold tail p3 p0 p2 p3
ret s
end
fn bad u32 u32 u32x16 -> u32
j add p1 p1
v get p2 j
k add p1 1
w get p2 k
x add v w
r add p0 x
ret r
end
fn scan u32x16 u32 -> u32x16
j add p1 1
a get p0 p1
b get p0 j
c add a b
r set p0 j c
ret r
end
fn neq u32 u32 u32x16 u32 -> bool
j sub 15 p1
v get p2 j
g ne v p3
ret g
end
fn cnt u32 u32 u32x16 u32 -> u32
r add p0 1
ret r
end
fn big u32x16 u32 u32 -> bool
k and p1 15
v get p0 k
m0 mul v 3
x0 xor m0 p2
m1 mul x0 5
x1 xor m1 p2
m2 mul x1 7
x2 xor m2 p2
m3 mul x2 9
x3 xor m3 p2
m4 mul x3 11
x4 xor m4 p2
m5 mul x4 13
x5 xor m5 p2
m6 mul x5 15
x6 xor m6 p2
m7 mul x6 17
x7 xor m7 p2
m8 mul x7 19
x8 xor m8 p2
m9 mul x8 21
x9 xor m9 p2
m10 mul x9 23
x10 xor m10 p2
m11 mul x10 25
x11 xor m11 p2
g lt x11 2000000000
ret g
end
fn bstep u32x16 u32 u32 -> u32x16
v get p0 p1
w add v p2
r set p0 p1 w
ret r
end
fn small u32x16 u32 u32 -> bool
v get p0 p1
g lt v p2
ret g
end
fn heavy u32x16 u32 u32 -> u32x16
k and p1 15
v get p0 k
h0 mul v 5
h1 mul h0 6
h2 mul h1 7
h3 mul h2 8
h4 mul h3 9
h5 mul h4 10
h6 mul h5 11
h7 mul h6 12
h8 mul h7 13
h9 mul h8 14
h10 mul h9 15
h11 mul h10 16
h12 mul h11 17
h13 mul h12 18
h14 mul h13 19
h15 mul h14 20
h16 mul h15 21
h17 mul h16 22
h18 mul h17 23
h19 mul h18 24
h20 mul h19 25
h21 mul h20 26
h22 mul h21 27
h23 mul h22 28
h24 mul h23 29
h25 mul h24 30
r set p0 k h25
ret r
end
fn main u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8 9 10 11 12 13 14 15 p1
s1 fold sum2 15 p0 a
s2 fold rev 16 s1 a
b arr p0 1 2 3 4 5 6 7
c arr p1 2 3 4 5 6 7 8
d arr 3 p0 4 5 6 7 8 9
e arr 4 5 p1 6 7 8 9 10
f arr 5 6 7 p0 8 9 10 11
s3 fold five 7 s2 b c d e f
s4 fold outer 12 s3 a
s5 fold bad 16 s4 a
s6 fold mid 3 s5 a 7
k and p0 15
s7 fold sum2 k s6 a
t fold scan 15 a
q and p1 15
z get t q
f1 loop neq cnt 16 0 a p1
g loop big bstep 16 a p1
h loop small heavy 16 a p1
i loop small bstep k a p1
g1 get g 3
h1 get h 5
i1 get i 7
y1 add s7 z
y2 xor y1 f1
y3 add y2 g1
y4 xor y3 h1
y5 add y4 i1
ret y5
end
`;

/**
 * A fill fused into an in-place prefix fold (the exec-bench prefix1k shape): an induction
 * variable stepping by a parameter, the carried previous element guarded on the first trip, and
 * the dead index arithmetic of the carried read; `pfx2` reads the carried element twice (no guard).
 */
const PREFIX_SOURCE = `fn fill u32x64 u32 u32 u32 -> u32x64
m mul p1 p2
v add m p3
n set p0 p1 v
ret n
end
fn pfx u32x64 u32 -> u32x64
c eq p1 0
j sub p1 1
t get p0 j
u select c 0 t
s get p0 p1
v add u s
n set p0 p1 v
ret n
end
fn pfx2 u32x64 u32 -> u32x64
j sub p1 1
t get p0 j
w xor t 3
s get p0 p1
v add t s
x add v w
n set p0 p1 x
ret n
end
fn main u32 u32 -> u32
z arr 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
a fold fill 64 z p0 p1
b fold pfx 64 a
c fold pfx2 64 b
q and p1 63
r get c q
w get c 63
s add r w
ret s
end
`;

const FILL_READ_SOURCE = `fn fadd u32x16 u32 u32 -> u32x16
v add p1 p2
n set p0 p1 v
ret n
end
fn fxor u32x16 u32 u32 -> u32x16
w mul p1 p2
v xor w 5
n set p0 p1 v
ret n
end
fn fcost u32x16 u32 u32 -> u32x16
w mul p1 p2
u mul w p1
v add u 9
n set p0 p1 v
ret n
end
fn whole u32 u32 -> u32
z arr ${FILL_ZEROS}
a fold fadd 16 z p0
x get a p1
y get a 3
s add x y
ret s
end
fn masked u32 u32 -> u32
z arr ${FILL_ZEROS}
a fold fxor 12 z p0
m and p1 7
x get a m
ret x
end
fn kept u32 u32 -> u32
z arr ${FILL_ZEROS}
a fold fadd 12 z p0
x get a p1
y get a 13
s add x y
ret s
end
fn costly u32 u32 -> u32
z arr ${FILL_ZEROS}
a fold fcost 16 z p0
x get a p1
ret x
end
`;

/**
 * Lane builds of one form (src/wasm.ts `#kidForm`): shl, shr, add and sub of one parameter by
 * literals, and constant lanes, derived from a kept build by one operation; a shift's base built
 * ahead of its own pack, a lane that is the parameter itself, counts of 32 or more (not derived),
 * and builds equal to a kept one.
 */
const FORMS_SOURCE = `fn forms u32 u32 u32 -> u32
u00 shl p0 4
w00 add p1 10
y00 xor u00 w00
u01 shl p0 5
w01 add p1 11
y01 xor u01 w01
u02 shl p0 6
w02 add p1 12
y02 xor u02 w02
u03 shl p0 7
w03 add p1 13
y03 xor u03 w03
u10 shl p0 1
w10 add p1 20
y10 xor u10 w10
u11 shl p0 2
w11 add p1 21
y11 xor u11 w11
u12 shl p0 3
w12 add p1 22
y12 xor u12 w12
u13 shl p0 4
w13 add p1 23
y13 xor u13 w13
u20 shl p0 30
w20 add p1 13
y20 xor u20 w20
u21 shl p0 31
w21 add p1 12
y21 xor u21 w21
u22 shl p0 32
w22 add p1 11
y22 xor u22 w22
u23 shl p0 33
w23 add p1 10
y23 xor u23 w23
u30 sub p2 1
w30 mul p0 3
y30 xor u30 w30
u31 sub p2 2
w31 mul p0 4
y31 xor u31 w31
u32 sub p2 3
w32 mul p0 5
y32 xor u32 w32
u33 sub p2 4
w33 mul p0 6
y33 xor u33 w33
u40 sub p2 5
w40 mul p0 7
y40 xor u40 w40
u41 sub p2 6
w41 mul p0 8
y41 xor u41 w41
u42 sub p2 7
w42 mul p0 9
y42 xor u42 w42
u43 sub p2 8
w43 mul p0 10
y43 xor u43 w43
w50 mul p0 3
y50 xor p1 w50
u51 shr p1 1
w51 mul p0 4
y51 xor u51 w51
u52 shr p1 2
w52 mul p0 5
y52 xor u52 w52
u53 shr p1 3
w53 mul p0 6
y53 xor u53 w53
u60 shr p1 8
w60 add p1 10
y60 xor u60 w60
u61 shr p1 9
w61 add p1 11
y61 xor u61 w61
u62 shr p1 10
w62 add p1 12
y62 xor u62 w62
u63 shr p1 11
w63 add p1 13
y63 xor u63 w63
u70 shr p1 4
w70 mul p0 4294967295
y70 xor u70 w70
u71 shr p1 5
w71 mul p0 0
y71 xor u71 w71
u72 shr p1 6
w72 mul p0 1
y72 xor u72 w72
u73 shr p1 7
w73 mul p0 2
y73 xor u73 w73
a arr y00 y01 y02 y03 y10 y11 y12 y13 y20 y21 y22 y23 y30 y31 y32 y33 y40 y41 y42 y43 y50 y51 y52 y53 y60 y61 y62 y63 y70 y71 y72 y73
i and p2 31
x get a i
z get a 5
r add x z
ret r
end
`;

/**
 * Superword packs (src/wasm.ts `slpPlan`): u32 array literals whose four-element groups are
 * isomorphic lane-wise operations, grown through their operands: splats of a common operand,
 * lanes oriented by their operands' operations, shift amounts the same in every lane, a sub,
 * lane builds with replace_lane, constant lanes, lanes read as scalars (extracted once), groups
 * of an inner pack stored from it, and a regrouping of the same nodes.
 */
const SLP_SOURCE = `fn lanes u32 u32 u32 -> u32
e0 mul p0 3
e1 mul p0 5
e2 mul p0 7
e3 mul p0 9
f0 shr p1 1
g0 xor e0 f0
z xor g0 p2
f1 shr p1 2
f2 shr p1 3
f3 shr p1 4
g1 xor f1 e1
g2 xor e2 f2
g3 xor e3 f3
h0 shl g0 5
h1 shl g1 5
h2 shl g2 5
h3 shl g3 5
k0 sub h0 p2
k1 sub h1 p2
k2 sub h2 p2
k3 sub h3 p2
m0 add k0 10
m1 add k1 20
m2 add 30 k2
m3 add k3 40
w0 and m0 p0
w1 and m1 p1
w2 and p2 m2
w3 and m3 9
v0 or w0 k1
v1 or w1 k0
v2 or w2 k3
v3 or w3 k2
a arr m0 m1 m2 m3 k0 k1 k2 k3 v0 v1
b arr w0 w1 w2 w3 v0 v1 v2 v3
c arr k1 k0 k3 k2
i and p2 7
j and p0 3
x get a i
y get b i
q get c j
s add k1 z
t add s x
u add t y
r add u q
ret r
end
fn shifts u32 u32 -> u32
a0 add p0 1
a1 add p0 2
a2 add p0 3
a3 add p0 4
b0 shr a0 p1
b1 shr a1 p1
b2 shr a2 p1
b3 shr a3 p1
c0 shl a0 1
c1 shl a1 2
c2 shl a2 3
c3 shl a3 4
d0 mul b0 c0
d1 mul c1 b1
d2 mul b2 c2
d3 mul b3 c3
n arr d0 d1 d2 d3 b0 b1 b2 b3
i and p0 7
j and p1 7
e get n i
f get n j
r xor e f
ret r
end
`;

// Recurrences fused with their consumer (src/optimize.ts `fuseRecurrence`): the carried previous
// element seeded with the trip-0 arm (a parameter, a literal), and unseeded when the arms differ.
const REC_SEED_SOURCE = `fn rpar u32x16 u32 u32 -> u32x16
c eq p1 0
j sub p1 1
t get p0 j
s select c p2 t
a shl s 13
b xor s a
n set p0 p1 b
ret n
end
fn rlit u32x16 u32 u32 -> u32x16
c ne p1 0
j sub p1 1
t get p0 j
s select c t 7
a mul s 3
b add a p2
n set p0 p1 b
ret n
end
fn rmix u32x16 u32 u32 -> u32x16
c eq p1 0
j sub p1 1
t get p0 j
s select c p2 t
u select c 9 t
b xor s u
n set p0 p1 b
ret n
end
fn rstep u32 u32 u32x16 -> u32
v get p2 p1
w xor p0 v
m mul w 5
ret m
end
fn spar u32 u32 -> u32
z arr ${FILL_ZEROS}
a fold rpar 16 z p0
r fold rstep 16 p1 a
ret r
end
fn slit u32 u32 -> u32
z arr ${FILL_ZEROS}
a fold rlit 16 z p0
r fold rstep 16 p1 a
ret r
end
fn smix u32 u32 -> u32
z arr ${FILL_ZEROS}
a fold rmix 16 z p0
r fold rstep 16 p1 a
ret r
end
`;

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
  // u32 literals of 2^28 or more as a ret operand: kind-5 operands of the ret word (tools/behavior-spec.ts)
  const bigret = BEHAVIOR_SPEC.find((b) => b.name === 'bigret');
  if (bigret === undefined) throw new Error('behavior program bigret is missing');
  programs.push(['behavior/bigret', parseAndValidate(bigret.source), small]);
  // and as add, xor, compare and select operands, fold initial states and literal-only calls
  const biglit = BEHAVIOR_SPEC.find((b) => b.name === 'biglit');
  if (biglit === undefined) throw new Error('behavior program biglit is missing');
  programs.push(['behavior/biglit', parseAndValidate(biglit.source), small]);
  // chains of one associative op rotated by readiness (the latency model of optimize.ts `reassociate`)
  const chainrot = BEHAVIOR_SPEC.find((b) => b.name === 'chainrot');
  if (chainrot === undefined) throw new Error('behavior program chainrot is missing');
  programs.push(['behavior/chainrot', parseAndValidate(chainrot.source), small]);
  // reads of fill-run folds (src/optimize.ts `readThroughFills`): the wrapped whole-length form,
  // a masked index below a shorter count, and reads that keep the fold
  programs.push(['fillread', parseAndValidate(FILL_READ_SOURCE), small]);
  // sliding reads of an extra argument carried in a local (src/wasm.ts `slidingRead`)
  programs.push(['slide', parseAndValidate(SLIDE_SOURCE), small]);
  // a carried previous element that starts at the first-trip value (src/wasm.ts `guardedCarry`)
  programs.push(['carrysel', parseAndValidate(CARRY_SELECT_SOURCE), small]);
  // selects sharing a condition as one branch, and the exec-bench kernel rle4k (src/optimize.ts `lazyArms`)
  programs.push(['selgroup', parseAndValidate(SELECT_GROUP_SOURCE), small]);
  const rle4k = KERNELS.find((k) => k.name === 'rle4k');
  if (rle4k === undefined) throw new Error('exec-bench kernel rle4k is missing');
  programs.push(['bench/rle4k', parseAndValidate(rle4k.a0), small]);
  // reductions four trips a vector trip, and the exec-bench kernel sieve4k (src/wasm.ts `reduceRun`)
  programs.push(['reduce', parseAndValidate(REDUCE_SOURCE), small]);
  const sieve4k = KERNELS.find((k) => k.name === 'sieve4k');
  if (sieve4k === undefined) throw new Error('exec-bench kernel sieve4k is missing');
  programs.push(['bench/sieve4k', parseAndValidate(sieve4k.a0), small]);
  const prefix1k = KERNELS.find((k) => k.name === 'prefix1k');
  if (prefix1k === undefined) throw new Error('exec-bench kernel prefix1k is missing');
  programs.push(['bench/prefix1k', parseAndValidate(prefix1k.a0), small]);
  // superword packs: a crafted program, and the exec-bench kernel mat4 (the 4x4 products as
  // i32x4) with a variable trip count, so that the step stays a function of its own
  programs.push(['slp', parseAndValidate(SLP_SOURCE), small]);
  programs.push(['slpforms', parseAndValidate(FORMS_SOURCE), small]);
  const mat4 = KERNELS.find((k) => k.name === 'mat4');
  if (mat4 === undefined) throw new Error('exec-bench kernel mat4 is missing');
  const mat4n = mat4.a0.replace('r fold mulstep 8 a b', 'k and p1 7\nr fold mulstep k a b');
  if (mat4n === mat4.a0) throw new Error('exec-bench kernel mat4 has no fold of mulstep');
  programs.push(['bench/mat4n', parseAndValidate(mat4n), small]);
  programs.push(['recseed', parseAndValidate(REC_SEED_SOURCE), small]);
  programs.push(['prefix', parseAndValidate(PREFIX_SOURCE), small]);
  // carried-element folds unrolled by 4 (src/wasm.ts `CARRY_UNROLL`)
  programs.push(['carryunroll', parseAndValidate(CARRY_UNROLL_SOURCE), small]);
  // stores forwarded to the next trip's read, and the exec-bench kernel isort256 (src/wasm.ts `carriedRead`)
  programs.push(['carryfwd', parseAndValidate(CARRY_FWD_SOURCE), small]);
  // small loop state in locals, read by the predicate too, and the exec-bench kernel bsearch1k
  programs.push(['loopstate', parseAndValidate(LOOP_STATE_SOURCE), small]);
  // element pointers and rotated loops (src/wasm.ts `#pointers`, `counted`)
  programs.push(['pointers', parseAndValidate(POINTER_SOURCE), small]);
  const bsearch1k = KERNELS.find((k) => k.name === 'bsearch1k');
  if (bsearch1k === undefined) throw new Error('exec-bench kernel bsearch1k is missing');
  programs.push(['bench/bsearch1k', parseAndValidate(bsearch1k.a0), small]);
  const isort256 = KERNELS.find((k) => k.name === 'isort256');
  if (isort256 === undefined) throw new Error('exec-bench kernel isort256 is missing');
  programs.push(['bench/isort256', parseAndValidate(isort256.a0), small]);
  // set/put through borrows and records built in their container, and the exec-bench kernel heap256
  programs.push(['inplace', parseAndValidate(INPLACE_SOURCE), small]);
  programs.push(['lazyread', parseAndValidate(LAZY_READ_SOURCE), small]);
  const heap256 = KERNELS.find((k) => k.name === 'heap256');
  if (heap256 === undefined) throw new Error('exec-bench kernel heap256 is missing');
  programs.push(['bench/heap256', parseAndValidate(heap256.a0), small]);
  for (const f of ['page.a0', 'docs.a0'])
    programs.push([
      `site/${f}`,
      (await link(join('site', f), (p) => readFile(p, 'utf8'), { root: '.' })).program,
      site,
    ]);
  // A0_SELFHOST_ONLY=label,label: a quick local check of some programs; nothing is written then.
  const only = process.env.A0_SELFHOST_ONLY?.split(',');
  const reports: ProgramReport[] = [];
  for (const [label, program, layout] of programs) {
    if (only !== undefined && !only.includes(label)) continue;
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
  if (only === undefined) {
    await mkdir('results', { recursive: true });
    await writeReport(join('results', 'selfhost-wasm.json'), report);
  }
  process.stdout.write(`${reports.length - failed.length}/${reports.length} programs identical\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
