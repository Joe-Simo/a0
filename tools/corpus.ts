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
  containsIo,
  formatProgram,
  type IoState,
  isIoState,
  isPrimitive,
  isScalar,
  makeIo,
  type Node,
  OP_ARITY,
  type Op,
  type Operand,
  parseAndValidate,
  type Type,
  type TypedProgram,
  typeEquals,
  type Value,
  validate,
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

const AGGREGATE_TYPES: readonly Type[] = [
  { kind: 'arr', length: 2, elem: 'u32' },
  { kind: 'arr', length: 3, elem: 'u32' },
  { kind: 'arr', length: 4, elem: 'bool' },
  { kind: 'rec', fields: ['u32', 'bool'] },
  { kind: 'rec', fields: ['u32', 'u32', 'u32'] },
  { kind: 'arr', length: 2, elem: { kind: 'rec', fields: ['u32', 'bool'] } },
];

const U32_OPS: readonly Op[] = [
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'div',
  'rem',
];
const CMP_OPS: readonly Op[] = ['eq', 'lt'];
const BOOL_OPS: readonly Op[] = ['and', 'or', 'xor', 'eq'];

interface Slot {
  readonly operand: Operand;
  readonly type: Type;
}

const slotsOf = (slots: readonly Slot[], t: Type): Slot[] =>
  slots.filter((s) => typeEquals(s.type, t));

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
  const signatures: {
    name: string;
    params: Type[];
    result: Type;
    iterates: boolean;
    io: boolean;
    helper: boolean;
  }[] = [];
  for (let f = 0; f < count; f += 1) {
    // Occasionally shape this function as a predicate twin of an earlier body-shaped function
    // (same parameters, bool result) so the generator can pair them in a `loop`.
    const twinCandidates = signatures.filter(
      (f) =>
        !f.iterates &&
        !f.io &&
        f.params.length >= 2 &&
        f.params[1] === 'u32' &&
        typeEquals(f.result, f.params[0] as Type),
    );
    const twin =
      twinCandidates.length > 0 && rng() % 3 === 0 ? pick(rng, twinCandidates) : undefined;
    const paramCount = twin === undefined ? 1 + (rng() % 4) : twin.params.length;
    // Every fourth non-twin function takes one aggregate parameter (a helper reachable only via call).
    const aggregateParam: Type | undefined =
      twin === undefined && rng() % 4 === 0 ? pick(rng, AGGREGATE_TYPES) : undefined;
    const params: Type[] =
      twin === undefined
        ? Array.from({ length: paramCount }, (_, i) =>
            i === 0 || rng() % 5 !== 0 ? 'u32' : 'bool',
          )
        : [...twin.params];
    if (aggregateParam !== undefined) params.push(aggregateParam);
    // Every third plain function threads an io token as its last parameter. Half of those
    // return the token in a (u32,io) record (helpers); the rest return u32 (driver-callable).
    const withIo = twin === undefined && aggregateParam === undefined && rng() % 3 === 0;
    if (withIo) params.push('io');
    const ioHelper = withIo && rng() % 2 === 0;
    let token: Operand | undefined = withIo
      ? { kind: 'param', index: params.length - 1 }
      : undefined;
    const slots: Slot[] = params
      .map((type, index): Slot => ({ operand: { kind: 'param', index }, type }))
      .filter((s) => s.type !== 'io'); // tokens are threaded, never ordinary operands
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
      const roll = rng() % 14;
      if (roll >= 12 && token !== undefined) {
        // Effect step: read (then extract value and next token), write, or call an io helper.
        const helpers = signatures.filter(
          (f) => f.helper && f.params.every((t) => t === 'io' || slotsOf(slots, t).length > 0),
        );
        const u32Arrays = slots.filter(
          (s) => !isPrimitive(s.type) && s.type.kind === 'arr' && s.type.elem === 'u32',
        );
        const kind = rng() % 4;
        if (kind === 3 && u32Arrays.length > 0) {
          nodes.push({ id, op: 'puts', args: [token, pick(rng, u32Arrays).operand] });
          token = { kind: 'node', id };
          continue;
        }
        if (kind === 0) {
          nodes.push({ id, op: 'read', args: [token] });
          nodes.push({
            id: `${id}v`,
            op: 'at',
            args: [
              { kind: 'node', id },
              { kind: 'u32', value: 0 },
            ],
          });
          nodes.push({
            id: `${id}t`,
            op: 'at',
            args: [
              { kind: 'node', id },
              { kind: 'u32', value: 1 },
            ],
          });
          slots.push({ operand: { kind: 'node', id: `${id}v` }, type: 'u32' });
          token = { kind: 'node', id: `${id}t` };
        } else if (kind === 1 || helpers.length === 0) {
          nodes.push({ id, op: 'write', args: [token, u32Arg()] });
          token = { kind: 'node', id };
        } else {
          const h = pick(rng, helpers);
          const callArgs = h.params.map(
            (t): Operand =>
              t === 'io'
                ? (token as Operand)
                : t === 'u32'
                  ? u32Arg()
                  : pick(rng, slotsOf(slots, t)).operand,
          );
          nodes.push({ id, op: 'call', callee: h.name, args: callArgs });
          nodes.push({
            id: `${id}v`,
            op: 'at',
            args: [
              { kind: 'node', id },
              { kind: 'u32', value: 0 },
            ],
          });
          nodes.push({
            id: `${id}t`,
            op: 'at',
            args: [
              { kind: 'node', id },
              { kind: 'u32', value: 1 },
            ],
          });
          slots.push({ operand: { kind: 'node', id: `${id}v` }, type: 'u32' });
          token = { kind: 'node', id: `${id}t` };
        }
        continue;
      }
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
      } else if (roll >= 10) {
        // Aggregate operations: build, read, or update an array/record from existing slots.
        const aggSlots = slots.filter((s) => !isPrimitive(s.type));
        const choice = rng() % 4;
        if (choice === 0 || aggSlots.length === 0) {
          const t = pick(rng, AGGREGATE_TYPES);
          const elems: Type[] = isPrimitive(t)
            ? []
            : t.kind === 'arr'
              ? Array.from({ length: t.length }, () => t.elem)
              : [...t.fields];
          if (elems.every((e) => slotsOf(slots, e).length > 0)) {
            const buildArgs = elems.map((e) => pick(rng, slotsOf(slots, e)).operand);
            nodes.push({
              id,
              op: isPrimitive(t) || t.kind === 'arr' ? 'arr' : 'rec',
              args: buildArgs,
            });
            slots.push({ operand: { kind: 'node', id }, type: t });
            continue;
          }
        } else {
          const s = pick(rng, aggSlots);
          const st = s.type as Exclude<Type, 'u32' | 'bool' | 'io'>;
          if (st.kind === 'arr') {
            if (choice === 1 || slotsOf(slots, st.elem).length === 0) {
              nodes.push({ id, op: 'get', args: [s.operand, u32Arg()] });
              slots.push({ operand: { kind: 'node', id }, type: st.elem });
            } else {
              nodes.push({
                id,
                op: 'set',
                args: [s.operand, u32Arg(), pick(rng, slotsOf(slots, st.elem)).operand],
              });
              slots.push({ operand: { kind: 'node', id }, type: st });
            }
            continue;
          }
          const k = rng() % st.fields.length;
          const ft = st.fields[k] as Type;
          if (choice === 1 || slotsOf(slots, ft).length === 0) {
            nodes.push({ id, op: 'at', args: [s.operand, { kind: 'u32', value: k }] });
            slots.push({ operand: { kind: 'node', id }, type: ft });
          } else {
            nodes.push({
              id,
              op: 'put',
              args: [s.operand, { kind: 'u32', value: k }, pick(rng, slotsOf(slots, ft)).operand],
            });
            slots.push({ operand: { kind: 'node', id }, type: st });
          }
          continue;
        }
        op = 'mov';
        const s = pick(rng, slots);
        args = [s.operand];
        type = s.type;
      } else if (roll === 9 && boolSlots().length > 1) {
        // Boolean logic: and/or/xor/eq over two bool slots.
        op = pick(rng, BOOL_OPS);
        args = [pick(rng, boolSlots()).operand, pick(rng, boolSlots()).operand];
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
            !f.io &&
            f.params.length >= 2 &&
            f.params[1] === 'u32' &&
            typeEquals(f.result, f.params[0] as Type),
        );
        const body = bodies.length > 0 ? pick(rng, bodies) : undefined;
        const extraT = body === undefined ? [] : body.params.slice(2);
        if (
          body !== undefined &&
          extraT.every((t) => slotsOf(slots, t).length > 0) &&
          slotsOf(slots, body.params[0] as Type).length > 0
        ) {
          const stateT = body.params[0] as Type;
          const init = stateT === 'u32' ? u32Arg() : pick(rng, slotsOf(slots, stateT)).operand;
          const count: Operand = { kind: 'u32', value: rng() % 9 };
          const extra = extraT.map((t) =>
            t === 'u32' ? u32Arg() : pick(rng, slotsOf(slots, t)).operand,
          );
          const preds = signatures.filter(
            (f) =>
              !f.iterates &&
              !f.io &&
              f.result === 'bool' &&
              f.params.length === body.params.length &&
              f.params.every((t, k) => typeEquals(t, body.params[k] as Type)),
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
        const usable = callee.params.every((t) => slotsOf(slots, t).length > 0);
        if (usable) {
          const callArgs = callee.params.map((t) =>
            t === 'u32' ? u32Arg() : pick(rng, slotsOf(slots, t)).operand,
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
    const scalarResult: Type = twin !== undefined ? 'bool' : rng() % 4 === 0 ? 'bool' : 'u32';
    const result: Type = ioHelper ? { kind: 'rec', fields: ['u32', 'io'] } : scalarResult;
    const candidates = slots.filter(
      (s) => typeEquals(s.type, scalarResult) && s.operand.kind === 'node',
    );
    let ret =
      candidates.length > 0
        ? (candidates[candidates.length - 1] as Slot).operand
        : (slots.find((s) => typeEquals(s.type, scalarResult)) as Slot).operand;
    if (ioHelper && token !== undefined) {
      const u = slotsOf(slots, 'u32');
      nodes.push({ id: 'rio', op: 'rec', args: [(u[u.length - 1] as Slot).operand, token] });
      ret = { kind: 'node', id: 'rio' };
    }
    const text = formatProgram({ functions: [{ name: `g${f}`, params, result, nodes, ret }] });
    functions.push(text.trimEnd());
    const iterates = nodes.some(
      (n) =>
        n.op === 'fold' ||
        n.op === 'loop' ||
        (n.op === 'call' && (signatures.find((s) => s.name === n.callee)?.iterates ?? false)),
    );
    signatures.push({ name: `g${f}`, params, result, iterates, io: withIo, helper: ioHelper });
  }
  return parseAndValidate(`${functions.join('\n\n')}\n`);
}

// ---------------------------------------------------------------------------
// Independent BigInt oracle
// ---------------------------------------------------------------------------

const MASK = (1n << 32n) - 1n;

/** The oracle shares the io state object (its arithmetic stays independent; the stream is the environment). */
export interface OracleIo {
  readonly io: IoState;
}
export type OracleValue = bigint | boolean | OracleIo | readonly OracleValue[];
const isOracleIo = (v: OracleValue | undefined): v is OracleIo =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && 'io' in v;

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
      if (typeof a === 'boolean') return a && b === true;
      return big(a, op) & big(b, op);
    case 'or':
      if (typeof a === 'boolean') return a || b === true;
      return big(a, op) | big(b, op);
    case 'xor':
      if (typeof a === 'boolean') return a !== (b === true);
      return big(a, op) ^ big(b, op);
    case 'shl':
      return (big(a, op) << (big(b, op) & 31n)) & MASK;
    case 'shr':
      return big(a, op) >> (big(b, op) & 31n);
    case 'div':
      return big(b, op) === 0n ? MASK : big(a, op) / big(b, op);
    case 'rem':
      return big(b, op) === 0n ? big(a, op) : big(a, op) % big(b, op);
    case 'eq':
      if (typeof a === 'boolean') return a === b;
      return big(a, op) === big(b, op);
    case 'lt':
      return big(a, op) < big(b, op);
    case 'select':
      if (typeof a !== 'boolean' || b === undefined || c === undefined)
        throw new Error('oracle select');
      return a ? b : c;
    case 'arr':
    case 'rec':
      return [...args];
    case 'get': {
      if (!Array.isArray(a) || a.length === 0) throw new Error('oracle get');
      return a[Number(big(b, op) % BigInt(a.length))] as OracleValue;
    }
    case 'set': {
      if (!Array.isArray(a) || a.length === 0 || c === undefined) throw new Error('oracle set');
      const copy = [...a];
      copy[Number(big(b, op) % BigInt(a.length))] = c;
      return copy;
    }
    case 'at': {
      if (!Array.isArray(a)) throw new Error('oracle at');
      const v = a[Number(big(b, op))];
      if (v === undefined) throw new Error('oracle at range');
      return v;
    }
    case 'put': {
      if (!Array.isArray(a) || c === undefined) throw new Error('oracle put');
      const copy = [...a];
      copy[Number(big(b, op))] = c;
      return copy;
    }
    case 'read': {
      if (!isOracleIo(a)) throw new Error('oracle read');
      const v = a.io.input[a.io.position] ?? 0;
      if (a.io.position < a.io.input.length) a.io.position += 1;
      return [BigInt(v), a];
    }
    case 'write': {
      if (!isOracleIo(a)) throw new Error('oracle write');
      a.io.output.push(Number(big(b, op) & MASK));
      return a;
    }
    case 'puts': {
      if (!isOracleIo(a) || !Array.isArray(b)) throw new Error('oracle puts');
      a.io.output.push(b.length);
      for (const v of b) a.io.output.push(Number(big(v, op) & MASK));
      return a;
    }
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
      case 'param':
        return valueToOracle(args[o.index] ?? 0);
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
  if (isOracleIo(v)) return v.io;
  if (Array.isArray(v)) return v.map(oracleToValue);
  return typeof v === 'boolean' ? v : Number(v);
}

export function valueToOracle(v: Value): OracleValue {
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'boolean') return v;
  if (isIoState(v)) return { io: v };
  return v.map(valueToOracle);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const BOUNDARY = [0, 1, 2, 31, 32, 0x7fff_ffff, 0x8000_0000, 0xffff_fffe, 0xffff_ffff];

export interface Case {
  readonly functionName: string;
  /** Scalar arguments only; the io token, when present, is the last parameter and is built from `input`. */
  readonly args: readonly Value[];
  readonly expected: Value;
  /** Present for io functions: the input word stream and the expected output words. */
  readonly input?: readonly number[];
  readonly expectedOutput?: readonly number[];
}

/** Functions with only u32/bool parameters and result: the ones the drivers can call directly. */
export function hasScalarSignature(fn: TypedProgram['functions'][number]): boolean {
  return fn.params.every(isScalar) && isScalar(fn.result);
}

/** Scalar signature, optionally with a trailing io parameter (drivers supply the stream). */
export function isDriverCallable(fn: TypedProgram['functions'][number]): boolean {
  const last = fn.params[fn.params.length - 1];
  const scalars = last === 'io' ? fn.params.slice(0, -1) : fn.params;
  return scalars.every(isScalar) && isScalar(fn.result);
}

export function hasIoParam(fn: TypedProgram['functions'][number]): boolean {
  return fn.params[fn.params.length - 1] === 'io';
}

export function generateCases(
  program: TypedProgram,
  seed = INPUT_SEED,
  randomPerFunction = 100,
): Case[] {
  const rng = makeRng(seed);
  const cases: Case[] = [];
  for (const fn of program.functions) {
    if (!isDriverCallable(fn)) continue;
    const io = hasIoParam(fn);
    const scalarParams = io ? fn.params.slice(0, -1) : fn.params;
    const argSets: Value[][] = [];
    // Boundary sweep: each u32 parameter takes each boundary value while the rest are 0/false.
    for (const [index, type] of scalarParams.entries()) {
      const values: Value[] = type === 'u32' ? BOUNDARY : [true, false];
      for (const v of values) {
        argSets.push(scalarParams.map((t, i) => (i === index ? v : t === 'u32' ? 0 : false)));
      }
    }
    // All-boundary combinations for small arity.
    if (scalarParams.length <= 2) {
      const lists = scalarParams.map((t): Value[] => (t === 'u32' ? BOUNDARY : [true, false]));
      const combos = lists.reduce<Value[][]>(
        (acc, list) => acc.flatMap((prefix) => list.map((v) => [...prefix, v])),
        [[]],
      );
      argSets.push(...combos);
    }
    for (let i = 0; i < randomPerFunction; i += 1) {
      argSets.push(scalarParams.map((t) => (t === 'u32' ? rng() : rng() % 2 === 0)));
    }
    for (const args of argSets) {
      if (!io) {
        cases.push({ functionName: fn.name, args, expected: oracleToValue(oracleRun(fn, args)) });
        continue;
      }
      // Seeded input stream of 0..5 words; the oracle records the output words it produces.
      const input = Array.from({ length: rng() % 6 }, () => rng());
      const state = makeIo(input);
      const expected = oracleToValue(oracleRun(fn, [...args, state]));
      cases.push({
        functionName: fn.name,
        args,
        expected,
        input,
        expectedOutput: [...state.output],
      });
    }
  }
  return cases;
}

export function corpusSha256(program: TypedProgram): string {
  return createHash('sha256').update(formatProgram(program), 'utf8').digest('hex');
}

/** The largest prefix-closed subset without io tokens: what the combinational hardware backend accepts. */
export function ioFreeSubset(program: TypedProgram): TypedProgram {
  const keep = new Set<string>();
  for (const fn of program.functions) {
    const io =
      containsIo(fn.result) ||
      fn.params.some(containsIo) ||
      [...fn.types.values()].some(containsIo);
    if (!io && [...fn.calls.keys()].every((k) => keep.has(k))) keep.add(fn.name);
  }
  return validate({ functions: program.functions.filter((f) => keep.has(f.name)) });
}
