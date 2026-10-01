/**
 * Stage 4b of self-hosting (DESIGN.md 7a): the C emitter written in A0 (compiler/emit_c.a0).
 * For the verification corpus and every example, the program's word IR is built in the
 * checker's chunks (the table sizes of compiler/check.a0), the A0 checker types each chunk in
 * the reference interpreter, and the A0 `emitc` writes the chunk's C (typedefs of the types the
 * chunk added, then its functions). The concatenated C is compiled with clang (UBSan, -Werror)
 * against the standard test driver of tools/verify.ts and must give the independent oracle's
 * result on every case. Writes results/selfhost-c.json.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { C_IO_INPUT_CAPACITY, C_IO_OUTPUT_CAPACITY, compile } from '../src/backends.js';
import {
  type Func,
  makeIo,
  type Operand,
  parseAndValidate,
  run,
  type Type,
  type TypedFunc,
  type TypedProgram,
} from '../src/core.js';
import { link } from '../src/link.js';
import { findClang } from '../src/toolchain.js';
import { generateCases, generateCorpus } from './corpus.js';
import { irOp } from './ref-parse.js';
import { checkNative, ioCaps, type TargetReport } from './verify.js';

/** Table sizes of compiler/check.a0 and compiler/emit_c.a0 (pool and sym are the parser's). */
const SIZES = {
  types: 768,
  tlist: 1024,
  fns: 1024,
  nodes: 4096,
  args: 8192,
  ntys: 1024,
  fstat: 256,
  pool: 512,
  sym: 512,
};
const FUEL = { fuel: 1e12 };

/** Page counts of the emitter's tables (the front end's: 128 words a page, types 384). */
const EMIT_PAGES = {
  types: 65,
  tlist: 65,
  fns: 45,
  nodes: 128,
  args: 512,
  ntys: 24,
  pool: 400,
  fnm: 16,
};

/** A table as `count` pages of `size` words (element i at page i / size). */
const paged = (t: readonly number[], count: number, size = 128): number[][] => {
  if (t.length > count * size)
    throw new Error(`table of ${t.length} words exceeds ${count * size}`);
  return Array.from({ length: count }, (_, p) => pad(t.slice(p * size, p * size + size), size));
};

const pad = (t: readonly number[], n: number): number[] => {
  if (t.length > n) throw new Error(`table of ${t.length} words exceeds ${n}`);
  return [...t, ...new Array(n - t.length).fill(0)];
};

interface Headers {
  readonly types: number[];
  readonly tlist: number[];
  readonly pool: number[];
  readonly sym: number[];
  /** Per function: name sym, parameter count, first parameter, result type. */
  readonly heads: [number, number, number, number][];
}

/** Every header of the program as word IR: types (triples), parameter lists, interned names. */
function encodeHeaders(fns: readonly Func[]): Headers {
  const types = [1, 0, 0, 2, 0, 0, 3, 0, 0];
  const tlist: number[] = [];
  const intern = (t: Type): number => {
    if (t === 'u32') return 0;
    if (t === 'bool') return 1;
    if (t === 'io') return 2;
    if (t.kind === 'arr') {
      const elem = intern(t.elem);
      for (let i = 0; i < types.length / 3; i += 1)
        if (types[i * 3] === 4 && types[i * 3 + 1] === t.length && types[i * 3 + 2] === elem)
          return i;
      types.push(4, t.length, elem);
      return types.length / 3 - 1;
    }
    const fields = t.fields.map(intern);
    for (let i = 0; i < types.length / 3; i += 1) {
      if (types[i * 3] !== 5 || types[i * 3 + 2] !== fields.length) continue;
      const a = types[i * 3 + 1] as number;
      if (fields.every((f, k) => tlist[a + k] === f)) return i;
    }
    types.push(5, tlist.length, fields.length);
    tlist.push(...fields);
    return types.length / 3 - 1;
  };
  const pool: number[] = [];
  const sym: number[] = [];
  const heads = fns.map((fn): [number, number, number, number] => {
    const params = fn.params.map(intern);
    const first = tlist.length;
    tlist.push(...params);
    const result = intern(fn.result);
    const name = [...Buffer.from(fn.name)];
    sym.push(pool.length, name.length);
    pool.push(...name);
    return [sym.length / 2 - 1, params.length, first, result];
  });
  return { types, tlist, pool, sym, heads };
}

/** Node and argument tables of functions [from, to); the fns table with their bodies' ranges. */
function encodeBodies(
  fns: readonly Func[],
  heads: Headers['heads'],
  from: number,
  to: number,
): { fns: number[]; nodes: number[]; args: number[] } {
  const table: number[] = [];
  const nodes: number[] = [];
  const args: number[] = [];
  fns.forEach((fn, fi) => {
    const operand = (o: Operand): [number, number] =>
      o.kind === 'node'
        ? [1, fn.nodes.findIndex((n) => n.id === o.id)]
        : o.kind === 'param'
          ? [2, o.index]
          : o.kind === 'u32'
            ? [3, o.value]
            : [4, o.value ? 1 : 0];
    const inChunk = fi >= from && fi < to;
    const firstNode = nodes.length / 6;
    if (inChunk)
      for (const n of fn.nodes) {
        const callee = n.callee === undefined ? 0 : fns.findIndex((g) => g.name === n.callee);
        const pred = n.pred === undefined ? 0 : fns.findIndex((g) => g.name === n.pred);
        nodes.push(0, irOp(n.op), n.args.length, args.length / 2, callee, pred);
        for (const a of n.args) args.push(...operand(a));
      }
    const [rk, rv] = operand(fn.ret);
    if (rv >= 2 ** 28) throw new Error(`${fn.name}: ret literal does not fit the IR's 28 bits`);
    const [name, nparams, first, result] = heads[fi] as [number, number, number, number];
    table.push(name, nparams, first, result, firstNode, inChunk ? fn.nodes.length : 0);
    table.push(rk * 2 ** 28 + rv);
  });
  return { fns: table, nodes, args };
}

/** Chunks [from, to) whose bodies fit the node and argument tables. */
function chunks(fns: readonly Func[]): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  while (from < fns.length) {
    let to = from;
    let nn = 0;
    let na = 0;
    while (to < fns.length) {
      const fn = fns[to] as Func;
      const a = fn.nodes.reduce((n, x) => n + x.args.length, 0);
      if (nn + fn.nodes.length > SIZES.nodes / 6 || na + a > SIZES.args / 2) break;
      nn += fn.nodes.length;
      na += a;
      to += 1;
    }
    if (to === from) throw new Error(`${(fns[from] as Func).name} does not fit the tables`);
    out.push([from, to]);
    from = to;
  }
  return out;
}

type CheckState = [number[], number[], number[], number[], number, number, number[], ...unknown[]];

/** The A0 C emitter's output for a whole program, chunk by chunk. */
export function selfHostedC(
  emitter: TypedProgram,
  program: TypedProgram,
): { text: string; chunks: number } {
  const check = emitter.byName.get('check') as TypedFunc;
  const emitc = emitter.byName.get('emitc') as TypedFunc;
  const fns = program.functions;
  if (fns.length * 7 > SIZES.fns) throw new Error('too many functions for the fns table');
  const h = encodeHeaders(fns);
  let types = h.types;
  let tlist = h.tlist;
  let fstat: number[] = [];
  const bytes: number[] = [];
  const parts = chunks(fns);
  // The emitter's name table: the pool start and length of each function's name.
  const fnm = h.heads.flatMap(([name]) => [
    h.sym[name * 2] as number,
    h.sym[name * 2 + 1] as number,
  ]);
  // Types below tfrom already have typedefs; the first chunk also emits the header types.
  let tfrom = 3;
  for (const [from, to] of parts) {
    const body = encodeBodies(fns, h.heads, from, to);
    const s = run(
      check,
      [
        pad(types, SIZES.types),
        pad(tlist, SIZES.tlist),
        pad(body.fns, SIZES.fns),
        pad(body.nodes, SIZES.nodes),
        pad(body.args, SIZES.args),
        pad(fstat, SIZES.fstat),
        types.length / 3,
        tlist.length,
        to,
        from,
      ],
      FUEL,
    ) as CheckState;
    if (s[10] !== 0) throw new Error(`A0 checker rejected functions ${from}..${to}: ${s[10]}`);
    const ntypes = s[4];
    types = s[0].slice(0, ntypes * 3);
    tlist = s[1].slice(0, s[5]);
    fstat = (s[9] as number[]).slice(0, to);
    const io = makeIo([]);
    run(
      emitc,
      [
        io,
        paged(types, EMIT_PAGES.types, 384),
        paged(tlist, EMIT_PAGES.tlist),
        paged(body.fns, EMIT_PAGES.fns),
        paged(body.nodes, EMIT_PAGES.nodes),
        paged(body.args, EMIT_PAGES.args),
        paged(s[6], EMIT_PAGES.ntys),
        paged(h.pool, EMIT_PAGES.pool),
        paged(fnm, EMIT_PAGES.fnm),
        ntypes,
        tfrom,
        from,
        to,
        from === 0 ? 1 : 0,
      ],
      FUEL,
    );
    bytes.push(...io.output);
    tfrom = ntypes;
  }
  return { text: Buffer.from(bytes).toString('latin1'), chunks: parts.length };
}

interface ProgramReport {
  readonly label: string;
  readonly functions: number;
  readonly chunks: number;
  readonly cases: number;
  readonly cBytes: number;
  readonly typescriptCBytes: number;
  readonly emitMs: number;
  readonly native_c_clang: TargetReport;
}

async function main(): Promise<void> {
  const emitter = (await link('compiler/emit_c.a0', (p) => readFile(p, 'utf8'))).program;
  const programs: [string, TypedProgram][] = [['corpus', generateCorpus()]];
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort())
    programs.push([f, parseAndValidate(await readFile(`examples/${f}`, 'utf8'))]);
  const reports: ProgramReport[] = [];
  for (const [label, program] of programs) {
    const cases = generateCases(program);
    const caps = ioCaps(cases);
    if (caps.ioInputCapacity > C_IO_INPUT_CAPACITY || caps.ioOutputCapacity > C_IO_OUTPUT_CAPACITY)
      throw new Error(`${label}: cases exceed the emitter's fixed io capacities`);
    const start = performance.now();
    const c = selfHostedC(emitter, program);
    const emitMs = Math.round(performance.now() - start);
    const native = await checkNative(
      program,
      cases,
      findClang(),
      false,
      'C from compiler/emit_c.a0 (reference interpreter) via clang',
      c.text,
    );
    reports.push({
      label,
      functions: program.functions.length,
      chunks: c.chunks,
      cases: cases.length,
      cBytes: Buffer.byteLength(c.text),
      typescriptCBytes: Buffer.byteLength(compile(program, 'c').text),
      emitMs,
      native_c_clang: native,
    });
    process.stdout.write(
      `${label.padEnd(12)} ${native.status.padEnd(8)} ${String(native.cases).padStart(5)} cases  ${program.functions.length} functions, ${c.chunks} chunk(s), ${Buffer.byteLength(c.text)} C bytes, emitted in ${emitMs} ms\n`,
    );
    for (const f of native.failures?.slice(0, 5) ?? [])
      process.stdout.write(`    ${f.slice(0, 600)}\n`);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    stage:
      'Self-hosting stage 4b: C emitter written in A0 (compiler/emit_c.a0, linked with check.a0, parse.a0, lex.a0)',
    method:
      'Word IR built per checker chunk; compiler/check.a0 types each chunk and compiler/emit_c.a0 `emitc` writes its C, both in the reference interpreter; the C is compiled by clang (-std=c11 -O1 -Wall -Wextra -Werror, UBSan) with the standard driver of tools/verify.ts and compared with the independent BigInt oracle of tools/corpus.ts.',
    scope:
      'The generated verification corpus and every example program (all within the front end table sizes). Byte equality with the TypeScript emitter is not required; observable results are.',
    programs: reports,
    totalCases: reports.reduce((n, r) => n + r.cases, 0),
    passedCases: reports.reduce(
      (n, r) => n + (r.native_c_clang.status === 'passed' ? r.native_c_clang.cases : 0),
      0,
    ),
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'selfhost-c.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`total ${report.passedCases}/${report.totalCases} cases\n`);
  process.exit(reports.every((r) => r.native_c_clang.status === 'passed') ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
