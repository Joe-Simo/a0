// Test-only structural IR encoding; raw-source tests do not use this encoder.
import { irOp } from '../../../dist/tools/ref-parse.js';
export function tables(program) {
  const types = [1, 0, 0, 2, 0, 0, 3, 0, 0],
    tlist = [0],
    fns = [],
    nodes = [0, 0, 0, 0, 0, 0, 0, 0],
    args = [3, 0, 3, 0, 3, 0],
    pool = [];
  const intern = (t) => {
    if (t === 'u32') return 0;
    if (t === 'bool') return 1;
    if (t === 'io') return 2;
    if (t.kind === 'arr') {
      const elem = intern(t.elem);
      for (let i = 0; i < types.length; i += 3)
        if (types[i] === 4 && types[i + 1] === t.length && types[i + 2] === elem) return i / 3;
      types.push(4, t.length, elem);
      return types.length / 3 - 1;
    }
    const fields = t.fields.map(intern);
    for (let i = 0; i < types.length; i += 3)
      if (
        types[i] === 5 &&
        types[i + 2] === fields.length &&
        fields.every((v, k) => tlist[types[i + 1] + k] === v)
      )
        return i / 3;
    const first = tlist.length;
    for (const field of fields) tlist.push(field);
    types.push(5, first, fields.length);
    return types.length / 3 - 1;
  };
  const name = (s) => {
    const data = Buffer.from(s);
    const off = pool.length;
    for (const b of data) pool.push(b);
    return [off, data.length];
  };
  const firstNodes = new Map(program.functions.map((f) => [f.name, 0]));
  let nextNode = 1;
  for (const f of program.functions) {
    firstNodes.set(f.name, nextNode);
    nextNode += f.nodes.length;
  }
  for (const fn of program.functions) {
    const first = firstNodes.get(fn.name);
    const operand = (a) =>
      a.kind === 'node'
        ? [1, first + fn.nodes.findIndex((n) => n.id === a.id)]
        : a.kind === 'param'
          ? [2, a.index]
          : a.kind === 'u32'
            ? [3, a.value]
            : [4, a.value ? 1 : 0];
    const ps = fn.params.map(intern),
      pi = tlist.length;
    tlist.push(...ps, 0);
    const result = intern(fn.result);
    const ret = operand(fn.ret);
    fns.push(
      ...name(fn.name),
      ps.length,
      pi,
      result,
      first,
      fn.nodes.length,
      ...ret,
      fn.profile === 'strict' ? 1 : 0,
    );
    for (const n of fn.nodes) {
      const ai = args.length / 2;
      for (const a of n.args) args.push(...operand(a));
      for (let i = n.args.length; i < 3; i++) args.push(3, 0);
      const callee = n.callee ? program.functions.findIndex((f) => f.name === n.callee) : 0,
        pred = n.pred ? program.functions.findIndex((f) => f.name === n.pred) : 0;
      nodes.push(
        irOp(n.op),
        n.args.length,
        ai,
        callee,
        pred,
        intern(fn.types.get(n.id)),
        ...name(n.id),
      );
    }
  }
  return {
    types,
    tlist,
    fns,
    nodes,
    args,
    pool,
    counts: [program.functions.length, types.length / 3, nodes.length / 8],
  };
}
