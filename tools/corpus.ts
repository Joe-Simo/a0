/**
 * Deterministic generated corpus of straight-line functions plus an independent
 * BigInt oracle. The oracle does not share code with the interpreter or backends:
 * it re-implements the v0.1 semantics over BigInt so that a shared bug in the
 * Number-based evaluator cannot mask itself.
 *
 * This is differential-test input, not application evidence.
 */

import { createHash } from 'node:crypto';
import {
  formatProgram,
  type Node,
  OP_ARITY,
  type Op,
  type Operand,
  parseAndValidate,
  type Type,
  type TypedProgram,
  type Value,
} from '../src/core.js';

export const CORPUS_SEED = 0xa0beef;
export const INPUT_SEED = 0x12345678;
export const CORPUS_FUNCTIONS = 48;

/** xorshift32; deterministic across platforms. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

const U32_OPS: readonly Op[] = ['add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr'];
const CMP_OPS: readonly Op[] = ['eq', 'lt'];

interface Slot {
  readonly operand: Operand;
  readonly type: Type;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const v = items[rng() % items.length];
  if (v === undefined) throw new Error('empty pick');
  return v;
}

export function generateCorpus(seed = CORPUS_SEED, count = CORPUS_FUNCTIONS): TypedProgram {
  const rng = makeRng(seed);
  const functions: string[] = [];
  for (let f = 0; f < count; f += 1) {
    const paramCount = 1 + (rng() % 4);
    const params: Type[] = Array.from({ length: paramCount }, (_, i) =>
      i === 0 || rng() % 5 !== 0 ? 'u32' : 'bool',
    );
    const slots: Slot[] = params.map((type, index) => ({
      operand: { kind: 'param', index },
      type,
    }));
    const u32Slots = (): Slot[] => slots.filter((s) => s.type === 'u32');
    const boolSlots = (): Slot[] => slots.filter((s) => s.type === 'bool');
    const nodeCount = 20 + (rng() % 60);
    const nodes: Node[] = [];
    const literal = (): Operand => {
      const choices = [
        0,
        1,
        2,
        31,
        32,
        33,
        0x7fff_ffff,
        0x8000_0000,
        0xffff_fffe,
        0xffff_ffff,
        rng(),
      ];
      return { kind: 'u32', value: pick(rng, choices) };
    };
    const u32Arg = (): Operand => (rng() % 4 === 0 ? literal() : pick(rng, u32Slots()).operand);
    for (let n = 0; n < nodeCount; n += 1) {
      const id = `n${n}`;
      const roll = rng() % 10;
      let op: Op;
      let args: Operand[];
      let type: Type;
      if (roll < 6) {
        op = pick(rng, U32_OPS);
        args = [u32Arg(), u32Arg()];
        type = 'u32';
      } else if (roll < 8) {
        op = pick(rng, CMP_OPS);
        args = [u32Arg(), u32Arg()];
        type = 'bool';
      } else if (roll === 8 && boolSlots().length > 0) {
        op = 'select';
        const cond = pick(rng, boolSlots()).operand;
        if (rng() % 2 === 0) {
          args = [cond, u32Arg(), u32Arg()];
          type = 'u32';
        } else {
          args = [cond, pick(rng, boolSlots()).operand, pick(rng, boolSlots()).operand];
          type = 'bool';
        }
      } else {
        op = 'mov';
        const s = pick(rng, slots);
        args = [s.operand];
        type = s.type;
      }
      if (args.length !== OP_ARITY[op]) throw new Error('generator arity bug');
      nodes.push({ id, op, args });
      slots.push({ operand: { kind: 'node', id }, type });
    }
    // Result: last u32 node combined with everything, so nothing is trivially dead.
    const result: Type = rng() % 4 === 0 ? 'bool' : 'u32';
    const candidates = slots.filter((s) => s.type === result && s.operand.kind === 'node');
    const ret =
      candidates.length > 0
        ? (candidates[candidates.length - 1] as Slot).operand
        : (slots.find((s) => s.type === result) as Slot).operand;
    const text = formatProgram({ functions: [{ name: `g${f}`, params, result, nodes, ret }] });
    functions.push(text.trimEnd());
  }
  return parseAndValidate(`${functions.join('\n\n')}\n`);
}

// ---------------------------------------------------------------------------
// Independent BigInt oracle
// ---------------------------------------------------------------------------

const MASK = (1n << 32n) - 1n;

export type OracleValue = bigint | boolean;

function big(v: OracleValue | undefined, where: string): bigint {
  if (typeof v !== 'bigint') throw new Error(`oracle ${where}: expected u32`);
  return v;
}

export function oracleOp(op: Op, args: readonly OracleValue[]): OracleValue {
  const [a, b, c] = args;
  switch (op) {
    case 'mov':
      if (a === undefined) throw new Error('oracle mov');
      return a;
    case 'add':
      return (big(a, op) + big(b, op)) & MASK;
    case 'sub':
      return (big(a, op) - big(b, op) + (1n << 32n)) & MASK;
    case 'mul':
      return (big(a, op) * big(b, op)) & MASK;
    case 'and':
      return big(a, op) & big(b, op);
    case 'or':
      return big(a, op) | big(b, op);
    case 'xor':
      return big(a, op) ^ big(b, op);
    case 'shl':
      return (big(a, op) << (big(b, op) & 31n)) & MASK;
    case 'shr':
      return big(a, op) >> (big(b, op) & 31n);
    case 'eq':
      return big(a, op) === big(b, op);
    case 'lt':
      return big(a, op) < big(b, op);
    case 'select':
      if (typeof a !== 'boolean' || b === undefined || c === undefined)
        throw new Error('oracle select');
      return a ? b : c;
  }
}

export function oracleRun(
  fn: TypedProgram['functions'][number],
  args: readonly Value[],
): OracleValue {
  const env = new Map<string, OracleValue>();
  const read = (o: Operand): OracleValue => {
    switch (o.kind) {
      case 'u32':
        return BigInt(o.value);
      case 'bool':
        return o.value;
      case 'param': {
        const v = args[o.index];
        return typeof v === 'boolean' ? v : BigInt(v ?? 0);
      }
      case 'node': {
        const v = env.get(o.id);
        if (v === undefined) throw new Error(`oracle unbound ${o.id}`);
        return v;
      }
    }
  };
  for (const node of fn.nodes) env.set(node.id, oracleOp(node.op, node.args.map(read)));
  return read(fn.ret);
}

export function oracleToValue(v: OracleValue): Value {
  return typeof v === 'boolean' ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const BOUNDARY = [0, 1, 2, 31, 32, 0x7fff_ffff, 0x8000_0000, 0xffff_fffe, 0xffff_ffff];

export interface Case {
  readonly functionName: string;
  readonly args: readonly Value[];
  readonly expected: Value;
}

export function generateCases(
  program: TypedProgram,
  seed = INPUT_SEED,
  randomPerFunction = 100,
): Case[] {
  const rng = makeRng(seed);
  const cases: Case[] = [];
  for (const fn of program.functions) {
    const argSets: Value[][] = [];
    // Boundary sweep: each u32 parameter takes each boundary value while the rest are 0/false.
    for (const [index, type] of fn.params.entries()) {
      const values: Value[] = type === 'u32' ? BOUNDARY : [true, false];
      for (const v of values) {
        argSets.push(fn.params.map((t, i) => (i === index ? v : t === 'u32' ? 0 : false)));
      }
    }
    // All-boundary combinations for small arity.
    if (fn.params.length <= 2) {
      const lists = fn.params.map((t): Value[] => (t === 'u32' ? BOUNDARY : [true, false]));
      const combos = lists.reduce<Value[][]>(
        (acc, list) => acc.flatMap((prefix) => list.map((v) => [...prefix, v])),
        [[]],
      );
      argSets.push(...combos);
    }
    for (let i = 0; i < randomPerFunction; i += 1) {
      argSets.push(fn.params.map((t) => (t === 'u32' ? rng() : rng() % 2 === 0)));
    }
    for (const args of argSets) {
      cases.push({ functionName: fn.name, args, expected: oracleToValue(oracleRun(fn, args)) });
    }
  }
  return cases;
}

export function corpusSha256(program: TypedProgram): string {
  return createHash('sha256').update(formatProgram(program), 'utf8').digest('hex');
}
