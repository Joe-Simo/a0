import assert from 'node:assert/strict';

const offsets = [32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 71, 74];
const ops = [
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
export function decode(b, source) {
  let i = 0;
  const word = () => {
    assert.ok(i + 4 <= b.length);
    const v = b.readUInt32LE(i);
    i += 4;
    return v;
  };
  const status = word(),
    state = Array.from({ length: 128 }, word),
    tables = new Map();
  for (const off of offsets) {
    const n = word();
    tables.set(off, Array.from({ length: n }, word));
  }
  const ns = word();
  const symbols = Array.from({ length: ns }, () =>
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      Uint8Array.from(Array.from({ length: word() }, word)),
    ),
  );
  assert.equal(i, b.length);
  const raw = new TextEncoder().encode(source),
    span = (a, n) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw.subarray(a, a + n));
  const table = (o) => tables.get(o);
  const row = (o, width, index) => table(o).slice(width * index, width * (index + 1));
  const typeCache = new Map();
  const type = (id) => {
    const cached = typeCache.get(id);
    if (cached) return cached;
    const r = row(68, 5, id);
    let t;
    if (r[0] === 0) t = 'u32';
    else if (r[0] === 1) t = 'bool';
    else if (r[0] === 2) t = 'io';
    else if (r[0] === 3) t = { kind: 'arr', elem: type(r[1]), length: r[2] };
    else {
      assert.equal(r[0], 4);
      t = {
        kind: 'rec',
        fields: table(71)
          .slice(r[1], r[1] + r[2])
          .map(type),
      };
    }
    typeCache.set(id, t);
    return t;
  };
  const operand = (id) => {
    const r = row(47, 5, id);
    if (r[0] === 0) return { kind: 'node', id: symbols[r[1]] };
    if (r[0] === 1)
      return {
        kind: 'param',
        index: r[4] & 4 ? Number(span(r[2], r[3]).slice(1)) : r[1],
      };
    if (r[0] === 2) return { kind: 'u32', value: r[1] };
    assert.equal(r[0], 3);
    return { kind: 'bool', value: r[1] !== 0 };
  };
  const comment = (id) => {
    const r = row(38, 3, id);
    return span(r[0], r[1]);
  };
  const comments = (lineID) => {
    const l = row(32, 10, lineID);
    const leading = Array.from({ length: l[9] }, (_, j) => comment(l[8] + j));
    const trailing = l[7] === 0xffffffff ? undefined : comment(l[7]);
    return leading.length || trailing !== undefined
      ? {
          ...(leading.length ? { leading } : {}),
          ...(trailing === undefined ? {} : { trailing }),
        }
      : undefined;
  };
  const node = (id) => {
    const r = row(44, 14, id);
    const c = r[11] & 1 ? undefined : comments(r[6]);
    return {
      id: symbols[r[0]],
      op: ops[r[1]],
      args: Array.from({ length: r[3] }, (_, j) => operand(r[2] + j)),
      ...(r[4] === 0xffffffff ? {} : { callee: symbols[r[4]] }),
      ...(r[5] === 0xffffffff ? {} : { pred: symbols[r[5]] }),
      ...(r[11] & 2
        ? {
            text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(
              Uint8Array.from(Array.from({ length: r[3] }, (_, j) => operand(r[2] + j).value)),
            ),
          }
        : {}),
      ...(c === undefined ? {} : { comments: c }),
    };
  };
  const functions = Array.from({ length: table(41).length / 14 }, (_, id) => {
    const r = row(41, 14, id),
      c = comments(r[7]),
      rc = comments(r[8]),
      ec = comments(r[9]);
    return {
      name: symbols[r[0]],
      params: table(50)
        .slice(r[1], r[1] + r[2])
        .map(type),
      result: type(r[3]),
      nodes: Array.from({ length: r[5] }, (_, j) => node(r[4] + j)),
      ret: operand(r[6]),
      ...(c === undefined ? {} : { comments: c }),
      ...(rc === undefined ? {} : { retComments: rc }),
      ...(ec === undefined ? {} : { endComments: ec }),
    };
  });
  const tail = Array.from({ length: state[26] }, (_, j) => comment(state[25] + j));
  if (functions.length && tail.length) Object.assign(functions.at(-1), { afterComments: tail });
  const uses = Array.from({ length: table(53).length / 3 }, (_, id) => {
    const r = row(53, 3, id);
    return span(r[0], r[1]);
  });
  const uc = Array.from({ length: uses.length }, (_, id) => comments(row(53, 3, id)[2]));
  const pc = state[24] === 0xffffffff ? undefined : comments(state[24]);
  const program = {
    functions,
    uses,
    ...(state[8] ? { profile: 'strict' } : {}),
    ...(pc === undefined ? {} : { profileComments: pc }),
    ...(uc.some((c) => c !== undefined) ? { useComments: uc } : {}),
    ...(!functions.length && tail.length ? { tailComments: tail } : {}),
  };
  return { status, state, tables, symbols, program };
}
