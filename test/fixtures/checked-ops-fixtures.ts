import type { Case } from '../../tools/corpus.js';

const ARITH = ['cadd', 'csub', 'cmul', 'cdiv', 'crem'] as const;
const EDGE = [0, 1, 2, 3, 7, 65535, 65536, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
const ARRAY = [0, 0xffffffff, 0x80000000];
export const CHECKED_SOURCE = `${ARITH.map(
  (op) => `fn ${op}_pair u32 u32 -> (u32,bool)
r ${op} p0 p1
ret r
end
fn ${op}_v u32 u32 -> u32
r call ${op}_pair p0 p1
v at r 0
ret v
end
fn ${op}_ok u32 u32 -> bool
r call ${op}_pair p0 p1
v at r 1
ret v
end
fn ${op}_both u32 u32 -> u32
r call ${op}_pair p0 p1
v at r 0
ok at r 1
mask select ok 2779096485 1515870810
out xor v mask
ret out
end
`,
).join('')}fn get_pair u32x3 u32 -> (u32,bool)
r cget p0 p1
ret r
end
fn get_v u32 -> u32
a arr 0 4294967295 2147483648
r call get_pair a p0
v at r 0
ret v
end
fn get_ok u32 -> bool
a arr 0 4294967295 2147483648
r call get_pair a p0
v at r 1
ret v
end
fn get_node_v u32 -> u32
a arr 0 4294967295 2147483648
r cget a p0
v at r 0
ret v
end
fn get_node_ok u32 -> bool
a arr 0 4294967295 2147483648
r cget a p0
v at r 1
ret v
end
fn get_literal_oob -> u32
a arr 4 5 6
r cget a 4294967295
v at r 0
ret v
end
fn get_literal_last -> bool
a arr 4 5 6
r cget a 2
v at r 1
ret v
end
fn step (u32,bool) u32 u32 -> (u32,bool)
v at p0 0
r cadd v p2
ret r
end
fn repeated_v u32 u32 -> u32
s rec p0 true
r fold step 5 s p1
v at r 0
ret v
end
fn repeated_ok u32 u32 -> bool
s rec p0 true
r fold step 5 s p1
v at r 1
ret v
end
fn tuple_flow_v u32 u32 -> u32
a cadd p0 p1
b cmul p0 p1
ok at a 1
selected select ok a b
c put selected 0 77
old at selected 0
fresh at c 0
tail at a 0
t xor old fresh
out xor t tail
ret out
end
fn tuple_flow_ok u32 u32 -> bool
a csub p0 p1
b cdiv p0 p1
cond at a 1
selected select cond a b
c put selected 1 true
old at selected 1
fresh at c 1
out xor old fresh
ret out
end
fn get_snapshot u32 -> u32
a arr 0 4294967295 2147483648
r cget a p0
b set a 0 7
value at r 0
old get a 0
fresh get b 0
t xor value old
out xor t fresh
ret out
end
`;

/** Independent integer arithmetic, including the full multiplication product. */
function expected(op: (typeof ARITH)[number], a: number, b: number): [number, boolean] {
  const x = BigInt(a);
  const y = BigInt(b);
  if (op === 'cdiv' || op === 'crem')
    return b === 0 ? [0, false] : [Number(op === 'cdiv' ? x / y : x % y), true];
  const value = op === 'cadd' ? x + y : op === 'csub' ? x - y : x * y;
  return [Number(BigInt.asUintN(32, value)), value >= 0n && value <= 0xffffffffn];
}

export function checkedCases(): Case[] {
  const out: Case[] = [];
  for (const op of ARITH)
    for (const a of EDGE)
      for (const b of EDGE) {
        const [value, ok] = expected(op, a, b);
        out.push({ functionName: `${op}_v`, args: [a, b], expected: value });
        out.push({ functionName: `${op}_ok`, args: [a, b], expected: ok });
        out.push({
          functionName: `${op}_both`,
          args: [a, b],
          expected: (value ^ (ok ? 0xa5a5a5a5 : 0x5a5a5a5a)) >>> 0,
        });
      }
  for (const i of EDGE) {
    for (const name of ['get', 'get_node']) {
      out.push({ functionName: `${name}_v`, args: [i], expected: ARRAY[i] ?? 0 });
      out.push({ functionName: `${name}_ok`, args: [i], expected: i < ARRAY.length });
    }
  }
  for (const i of EDGE)
    out.push({ functionName: 'get_snapshot', args: [i], expected: ((ARRAY[i] ?? 0) ^ 7) >>> 0 });
  out.push({ functionName: 'get_literal_oob', args: [], expected: 0 });
  out.push({ functionName: 'get_literal_last', args: [], expected: true });
  for (const a of EDGE)
    for (const b of EDGE) {
      let value = a;
      let ok = true;
      for (let i = 0; i < 5; i++) [value, ok] = expected('cadd', value, b);
      out.push({ functionName: 'repeated_v', args: [a, b], expected: value });
      out.push({ functionName: 'repeated_ok', args: [a, b], expected: ok });
      const add = expected('cadd', a, b);
      const mul = expected('cmul', a, b);
      const selected = add[1] ? add : mul;
      out.push({
        functionName: 'tuple_flow_v',
        args: [a, b],
        expected: (selected[0] ^ 77 ^ add[0]) >>> 0,
      });
      const sub = expected('csub', a, b);
      const div = expected('cdiv', a, b);
      const selectedFlag = sub[1] ? sub[1] : div[1];
      out.push({ functionName: 'tuple_flow_ok', args: [a, b], expected: !selectedFlag });
    }
  return out;
}
