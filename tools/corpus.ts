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
  // `iterates` marks functions that fold (transitively); they are never used as fold bodies,
  // which keeps generated iteration depth at one and evaluation cost bounded.
  const signatures: { name: string; params: Type[]; result: Type; iterates: boolean }[] = [];
  for (let f = 0; f < count; f += 1) {
    // Occasionally shape this function as a predicate twin of an earlier body-shaped function
    // (same parameters, bool result) so the generator can pair them in a `loop`.
    const twinCandidates = signatures.filter(
      (f) =>
        !f.iterates && f.params.length >= 2 && f.params[1] === 'u32' && f.result === f.params[0],
    );
    const twin =
      twinCandidates.length > 0 && rng() % 3 === 0 ? pick(rng, twinCandidates) : undefined;
    const paramCount = twin === undefined ? 1 + (rng() % 4) : twin.params.length;
    const params: Type[] =
      twin === undefined
        ? Array.from({ length: paramCount }, (_, i) =>
            i === 0 || rng() % 5 !== 0 ? 'u32' : 'bool',
          )
        : [...twin.params];
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
      } else if (roll === 9 && signatures.length > 0 && rng() % 3 === 0) {
        // Fold over an earlier function shaped (state, u32, extra...) -> state, literal trip count.
        const bodies = signatures.filter(
          (f) =>
            !f.iterates &&
            f.params.length >= 2 &&
            f.params[1] === 'u32' &&
            f.result === f.params[0],
        );
        const body = bodies.length > 0 ? pick(rng, bodies) : undefined;
        const extraT = body === undefined ? [] : body.params.slice(2);
        if (body !== undefined && extraT.every((t) => slots.some((s) => s.type === t))) {
          const stateT = body.params[0] as Type;
          const init = stateT === 'u32' ? u32Arg() : pick(rng, boolSlots()).operand;
          const count: Operand = { kind: 'u32', value: rng() % 9 };
          const extra = extraT.map((t) =>
            t === 'u32' ? u32Arg() : pick(rng, boolSlots()).operand,
          );
          const preds = signatures.filter(
            (f) =>
              !f.iterates &&
              f.result === 'bool' &&
              f.params.length === body.params.length &&
              f.params.every((t, k) => t === body.params[k]),
          );
          if (preds.length > 0 && rng() % 2 === 0) {
            const pred = pick(rng, preds);
            nodes.push({
              id,
              op: 'loop',
              pred: pred.name,
              callee: body.name,
              args: [count, init, ...extra],
            });
          } else {
            nodes.push({ id, op: 'fold', callee: body.name, args: [count, init, ...extra] });
          }
          slots.push({ operand: { kind: 'node', id }, type: stateT });
          continue;
        }
        op = 'mov';
        const s = pick(rng, slots);
        args = [s.operand];
        type = s.type;
      } else if (roll === 9 && signatures.length > 0 && rng() % 2 === 0) {
        // Call an earlier function whose parameter types can all be satisfied.
        const callee = pick(rng, signatures);
        const usable = callee.params.every((t) => slots.some((s) => s.type === t));
        if (usable) {
          const callArgs = callee.params.map((t) =>
            t === 'u32' ? u32Arg() : pick(rng, boolSlots()).operand,
          );
          nodes.push({ id, op: 'call', callee: callee.name, args: callArgs });
          slots.push({ operand: { kind: 'node', id }, type: callee.result });
          continue;
        }
        op = 'mov';
        const s = pick(rng, slots);
        args = [s.operand];
        type = s.type;
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
    const result: Type = twin !== undefined ? 'bool' : rng() % 4 === 0 ? 'bool' : 'u32';
    const candidates = slots.filter((s) => s.type === result && s.operand.kind === 'node');
    const ret =
      candidates.length > 0
        ? (candidates[candidates.length - 1] as Slot).operand
        : (slots.find((s) => s.type === result) as Slot).operand;
    const text = formatProgram({ functions: [{ name: `g${f}`, params, result, nodes, ret }] });
    functions.push(text.trimEnd());
    const iterates = nodes.some(
      (n) =>
        n.op === 'fold' ||
        n.op === 'loop' ||
        (n.op === 'call' && (signatures.find((s) => s.name === n.callee)?.iterates ?? false)),
    );
    signatures.push({ name: `g${f}`, params, result, iterates });
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
    case 'call':
    case 'fold':
    case 'loop':
      throw new Error(`oracle: ${op} is handled by oracleRun`);
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
  for (const node of fn.nodes) {
    if (node.op === 'call') {
      const callee = fn.calls.get(node.callee ?? '');
      if (callee === undefined) throw new Error(`oracle: unknown callee ${node.callee ?? ''}`);
      // The oracle evaluates callees with itself, never with the interpreter.
      env.set(node.id, oracleRun(callee, node.args.map(read).map(oracleToValue)));
    } else if (node.op === 'fold' || node.op === 'loop') {
      const body = fn.calls.get(node.callee ?? '');
      const pred = node.op === 'loop' ? fn.calls.get(node.pred ?? '') : undefined;
      if (body === undefined)
        throw new Error(`oracle: unknown ${node.op} body ${node.callee ?? ''}`);
      if (node.op === 'loop' && pred === undefined)
        throw new Error('oracle: unknown loop predicate');
      const [count, init, ...extra] = node.args.map(read);
      if (typeof count !== 'bigint' || init === undefined)
        throw new Error(`oracle: bad ${node.op}`);
      let state: OracleValue = init;
      for (let i = 0n; i < count; i += 1n) {
        const callArgs = [state, i, ...extra].map(oracleToValue);
        if (pred !== undefined && oracleRun(pred, callArgs) !== true) break;
        state = oracleRun(body, callArgs);
      }
      env.set(node.id, state);
    } else {
      env.set(node.id, oracleOp(node.op, node.args.map(read)));
    }
  }
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
