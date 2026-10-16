const assert={equal:(a,b)=>{if(a!==b)throw Error('invalid frontend IR');},ok:(value,message)=>{if(!value)throw Error(message??'invalid frontend IR');}};
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
export function decodeData(status,state,tables,symbols,source,specTables=new Map()) {
  const raw = new TextEncoder().encode(source),
    span = (a, n) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw.subarray(a, a + n));
  const table = (o) => tables.get(o);
  const row = (o, width, index) => table(o).subarray(width * index, width * (index + 1));
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
        fields: Array.from(table(71).subarray(r[1], r[1] + r[2]), type),
      };
    }
    typeCache.set(id, t);
    return t;
  };
  const operand = (id, storage=tables) => {
    const r = storage.get(storage===tables?47:50).subarray(id*5,id*5+5);
    if (r[0] === 0) return { kind: 'node', id: symbols[r[1]] };
    if (r[0] === 1)
      return { kind: 'param', index: r[4] & 4 ? Number(span(r[2], r[3]).slice(1)) : r[1] };
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
    const trailing = l[7] === 4294967295 ? undefined : comment(l[7]);
    return leading.length || trailing !== undefined
      ? { ...(leading.length ? { leading } : {}), ...(trailing === undefined ? {} : { trailing }) }
      : undefined;
  };
  const node = (id, storage=tables) => {
    const data=storage.get(storage===tables?44:47);
    const r = data.subarray(id*14,id*14+14);
    const c = r[11] & 1 ? undefined : comments(r[6]);
    return {
      id: symbols[r[0]],
      op: ops[r[1]],
      args: Array.from({ length: r[3] }, (_, j) => operand(r[2] + j,storage)),
      ...(r[4] === 4294967295 ? {} : { callee: symbols[r[4]] }),
      ...(r[5] === 4294967295 ? {} : { pred: symbols[r[5]] }),
      ...(r[11] & 2
        ? {
            text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(
              Uint8Array.from(Array.from({ length: r[3] }, (_, j) => operand(r[2] + j,storage).value)),
            ),
          }
        : {}),
      ...(c === undefined ? {} : { comments: c }),
    };
  };

  const specsByFunction = new Map();
  if (specTables.has(62)) {
    const sr=(offset,width,id)=>specTables.get(offset).subarray(id*width,(id+1)*width);
    const literals=[];
    const children=specTables.get(35);
    for(let id=0;id<specTables.get(32).length/6;id++) {
      const r=sr(32,6,id);
      let value;
      if(r[0]===1)value={kind:'u32',value:r[1]};
      else if(r[0]===2)value={kind:'bool',value:r[1]!==0};
      else {
        assert.ok(r[0]===3||r[0]===4,'invalid literal kind');
        const items=Array.from(children.subarray(r[2],r[2]+r[3]),child=>{
          assert.ok(child<id,'literal children precede parents');return literals[child];
        });
        value={kind:r[0]===3?'arr':'rec',items};
      }
      literals.push(value);
    }
    const example=id=>{
      const r=sr(41,8,id),c=comments(r[5]);
      return {args:Array.from(specTables.get(38).subarray(r[2],r[2]+r[3]),id=>literals[id]),result:literals[r[4]],...(c===undefined?{}:{comments:c})};
    };
    const contract=id=>node(sr(44,7,id)[3],specTables);
    for(let id=0;id<specTables.get(62).length/5;id++) {
      const r=sr(62,5,id);
      specsByFunction.set(r[0],{examples:Array.from({length:r[2]},(_,i)=>example(r[1]+i)),...(r[3]===4294967295?{}:{pre:contract(r[3])}),...(r[4]===4294967295?{}:{post:contract(r[4])})});
    }
  }

  const functions = Array.from({ length: table(41).length / 14 }, (_, id) => {
    const r = row(41, 14, id),
      c = comments(r[7]),
      rc = comments(r[8]),
      ec = comments(r[9]);
    return {
      name: symbols[r[0]],
      params: Array.from(table(50).subarray(r[1], r[1] + r[2]), type),
      result: type(r[3]),
      nodes: Array.from({ length: r[5] }, (_, j) => node(r[4] + j)),
      ret: operand(r[6]),
      ...(specsByFunction.has(id)?{spec:specsByFunction.get(id)}:{}),
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
  const pc = state[24] === 4294967295 ? undefined : comments(state[24]);
  const program = {
    functions,
    uses,
    ...(state[8] ? { profile: 'strict' } : {}),
    ...(pc === undefined ? {} : { profileComments: pc }),
    ...(uc.some((c) => c !== undefined) ? { useComments: uc } : {}),
    ...(!functions.length && tail.length ? { tailComments: tail } : {}),
  };
  return { status, state, tables, symbols, program, type };
}