import { ALL_OPS, type Func, type Node, OP_ARITY, type Program } from '../../../src/core.js';

const scalar = (value: number) => ({ kind: 'u32' as const, value });
const base: Func = {
  name: 'f',
  params: [],
  result: 'u32',
  nodes: [],
  ret: scalar(0),
};
export interface IrDiagnosticCase {
  readonly name: string;
  readonly program: Program;
  readonly id: number;
}

/** Hand-built values independent of the A0 renderer and its native record layout. */
export function irDiagnosticCases(): IrDiagnosticCase[] {
  const rows: IrDiagnosticCase[] = [];
  const own = (name: string, fn: Func, id: number): void => {
    rows.push({ name, program: { functions: [fn] }, id });
  };
  const node = (name: string, entry: Node, id: number): void => {
    own(name, { ...base, nodes: [entry] }, id);
  };
  rows.push({
    name: 'duplicate function before body',
    program: {
      functions: [base, { ...base, nodes: [{ id: 'Bad', op: 'mov', args: [] }] }],
    },
    id: 21,
  });
  for (const name of ['', 'Bad', 'fn', 'a'.repeat(65), 'λ😀', 'a b', 'a\n', 'a\0', 'a"\\'])
    own(`function ${JSON.stringify(name)}`, { ...base, name }, 301);
  for (const id of ['', 'Bad', 'p0', 'ret', 'a'.repeat(65), 'λ😀', 'a\t', 'a\0', 'a"\\'])
    node(`identifier ${JSON.stringify(id)}`, { id, op: 'add', args: [] }, 302);
  node(
    'callee on mov before predicate and arity',
    {
      id: 'x',
      op: 'mov',
      callee: '',
      pred: 'missing',
      args: [],
    },
    304,
  );
  for (const op of ['call', 'fold', 'loop'] as const)
    node(`missing ${op} callee`, { id: 'x', op, args: [] }, 304);
  node('predicate on mov before arity', { id: 'x', op: 'mov', pred: '', args: [] }, 305);
  node(
    'missing loop predicate before unknown callee',
    {
      id: 'x',
      op: 'loop',
      callee: 'missing',
      args: [],
    },
    305,
  );
  for (const op of ALL_OPS) {
    if (['call', 'fold', 'loop'].includes(op) || OP_ARITY[op] < 0) continue;
    node(
      `wrong ${op} arity`,
      {
        id: 'x',
        op,
        args: Array.from({ length: OP_ARITY[op] + 1 }, () => scalar(0)),
      },
      306,
    );
  }
  for (const op of ['arr', 'rec'] as const) node(`empty ${op}`, { id: 'x', op, args: [] }, 307);
  own(
    'function name before parameter bound',
    {
      ...base,
      name: 'Bad',
      params: Array(65).fill('u32'),
    },
    301,
  );
  own(
    'identifier before duplicate and malformed call',
    {
      ...base,
      nodes: [
        { id: 'p0', op: 'call', args: [] },
        { id: 'p0', op: 'mov', args: [] },
      ],
    },
    302,
  );
  rows.push({
    name: 'earlier name before later duplicate',
    program: { functions: [{ ...base, name: 'Bad' }, base, base] },
    id: 301,
  });
  rows.push({
    name: 'second function owns its failing node',
    program: {
      functions: [
        { ...base, name: 'first', nodes: [{ id: 'valid', op: 'mov', args: [scalar(0)] }] },
        { ...base, nodes: [{ id: 'Bad', op: 'mov', args: [scalar(0)] }] },
      ],
    },
    id: 302,
  });
  return rows;
}
