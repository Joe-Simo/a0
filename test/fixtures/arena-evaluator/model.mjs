// Generic arena storage/protocol only; no language or compiler decisions.
import assert from 'node:assert/strict';
// Fixture storage/encoding only. The native A0 module makes every runtime decision.
export class Arena {
  constructor(max = 16000000) {
    this.max = max;
    this.words = 0;
    this.heap = [null];
  }
  alloc(n) {
    assert.ok(n > 0);
    if (n > this.max - this.words) return [4, 0];
    this.words += n;
    this.heap.push(new Uint32Array(n));
    return [0, this.heap.length - 1];
  }
  put(a) {
    if (!a.length) return [0, 0, 0];
    const [s, h] = this.alloc(a.length);
    assert.equal(s, 0);
    this.heap[h].set(a);
    return [h, a.length, a.length];
  }
  get(v) {
    return Array.from(this.heap[v[0]]?.slice(0, v[1]) ?? []);
  }
}
export function floatWords(x) {
  const b = new ArrayBuffer(8),
    v = new DataView(b);
  v.setFloat64(0, x, true);
  return [v.getUint32(0, true), v.getUint32(4, true)];
}
export function fromFloatWords(a) {
  const b = new ArrayBuffer(8),
    v = new DataView(b);
  v.setUint32(0, a[0], true);
  v.setUint32(4, a[1], true);
  return v.getFloat64(0, true);
}
export const OPS = [
  '',
  'mov',
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
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'select',
  'call',
  'fold',
  'loop',
  'arr',
  'rec',
  'text',
  'get',
  'set',
  'at',
  'put',
  'read',
  'write',
  'puts',
  'cadd',
  'csub',
  'cmul',
  'cdiv',
  'crem',
  'cget',
];
export function encodeIR(arena, program) {
  const state = new Uint32Array(128),
    types = [0, 0, 0, 0, 32, 1, 0, 0, 0, 1, 2, 0, 0, 1, 0],
    children = [],
    typeMap = new Map([
      ['u32', 0],
      ['bool', 1],
      ['io', 2],
    ]),
    symbols = new Map();
  function sym(s) {
    if (!symbols.has(s)) symbols.set(s, symbols.size);
    return symbols.get(s);
  }
  function tid(t) {
    if (typeof t === 'string') return typeMap.get(t);
    const key = JSON.stringify(t);
    if (typeMap.has(key)) return typeMap.get(key);
    let a,
      b,
      contains = 0,
      width = 0,
      kind;
    if (t.kind === 'arr') {
      kind = 3;
      a = tid(t.elem);
      b = t.length;
      contains = types[a * 5 + 3];
      width = Math.min(2097153, types[a * 5 + 4] * b);
    } else {
      kind = 4;
      const ids = t.fields.map(tid);
      a = children.length;
      b = ids.length;
      for (const id of ids) children.push(id);
      contains = ids.some((i) => types[i * 5 + 3]) ? 1 : 0;
      width = contains
        ? 0
        : Math.min(
            2097153,
            ids.reduce((n, i) => n + types[i * 5 + 4], 0),
          );
    }
    const id = types.length / 5;
    types.push(kind, a, b, contains, width);
    typeMap.set(key, id);
    return id;
  }
  const fs = [],
    ns = [],
    os = [],
    ps = [],
    nts = [],
    rs = [],
    index = new Map(program.functions.map((f, i) => [f.name, i]));
  function operand(o) {
    const ix = os.length / 5;
    const k = o.kind === 'node' ? 0 : o.kind === 'param' ? 1 : o.kind === 'u32' ? 2 : 3;
    os.push(
      k,
      k === 0 ? sym(o.id) : k === 1 ? o.index : k === 3 ? (o.value ? 1 : 0) : o.value,
      0,
      0,
      0,
    );
    return ix;
  }
  for (const f of program.functions) {
    const pf = ps.length;
    ps.push(...f.params.map(tid));
    const nf = ns.length / 14;
    for (const n of f.nodes) {
      const af = os.length / 5;
      n.args.forEach(operand);
      ns.push(
        sym(n.id),
        OPS.indexOf(n.op),
        af,
        n.args.length,
        n.callee === undefined ? 0xffffffff : sym(n.callee),
        n.pred === undefined ? 0xffffffff : sym(n.pred),
        n.line ?? 0,
        0,
        1,
        0,
        1,
        0,
        0,
        0,
      );
      nts.push(tid(f.types.get(n.id)));
      rs.push(index.get(n.callee) ?? 0xffffffff, index.get(n.pred) ?? 0xffffffff);
    }
    const ret = operand(f.ret);
    fs.push(
      sym(f.name),
      pf,
      f.params.length,
      tid(f.result),
      nf,
      f.nodes.length,
      ret,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    );
  }
  function vec(off, a) {
    state.set(arena.put(a), off);
  }
  vec(41, fs);
  vec(44, ns);
  vec(47, os);
  vec(50, ps);
  vec(68, types);
  vec(71, children);
  vec(97, nts);
  vec(100, rs);
  state[8] = program.functions.some((f) => f.profile === 'strict') ? 1 : 0;
  return {
    state,
    type: tid,
    functions: index,
    names: program.functions.map((f) => f.name),
    nodeNames: program.functions.flatMap((f) => f.nodes.map((n) => n.id)),
    tables: { fs, ns, os, ps, types, children, nts, rs },
  };
}
export function inputValue(arena, v, ioMap = new Map()) {
  if (typeof v === 'number')
    return [Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? 0 : 0xffffffff, v >>> 0];
  if (typeof v === 'boolean') return [1, v ? 1 : 0];
  if (Array.isArray(v)) {
    const a = v.flatMap((x) => inputValue(arena, x, ioMap));
    const h = arena.put([v.length, ...a])[0];
    return [3, h];
  }
  if (v && typeof v === 'object' && 'output' in v) {
    if (ioMap.has(v)) return [2, ioMap.get(v)];
    const input = arena.put(v.input),
      output = arena.put(v.output),
      h = arena.put([...input, v.position, ...output])[0];
    ioMap.set(v, h);
    return [2, h];
  }
  return [0xffffffff, 0];
}
export function valueOut(arena, type, payload) {
  if (type === 0) return payload;
  if (type === 1) return payload !== 0;
  if (type === 2) {
    const o = arena.heap[payload];
    return {
      ioHandle: payload,
      input: arena.get(Array.from(o.slice(0, 3))),
      position: o[3],
      output: arena.get(Array.from(o.slice(4, 7))),
    };
  }
  const a = arena.heap[payload],
    v = [];
  for (let i = 0; i < a[0]; i++) v.push(valueOut(arena, a[1 + i * 2], a[2 + i * 2]));
  return v;
}
