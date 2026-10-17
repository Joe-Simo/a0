import type { Case } from '../../../tools/corpus.js';

export const ABI_SOURCE =
  'fn abi_mix u32 bool u32 bool u32 bool u32 bool u32 -> u32\nv0 mul p0 1\nv1 select p1 2 0\nv2 mul p2 3\nv3 select p3 4 0\nv4 mul p4 5\nv5 select p5 6 0\nv6 mul p6 7\nv7 select p7 8 0\nv8 mul p8 9\ns0 add v0 v1\ns1 add s0 v2\ns2 add s1 v3\ns3 add s2 v4\ns4 add s3 v5\ns5 add s4 v6\ns6 add s5 v7\ns7 add s6 v8\nret s7\nend\nfn abi_pack u32x3 u32 bool u32 u32 u32 u32 u32 -> (u32x3,u32,bool)\na set p0 p1 p7\ns0 add p3 p4\ns1 add p5 p6\ns2 add s0 s1\ns3 add s2 p1\nout rec a s3 p2\nret out\nend\nfn abi_call u32 -> u32\nm call abi_mix p0 true 3 false 5 true 7 true 9\na arr 11 12 13\nr call abi_pack a p0 true 17 19 23 29 m\nv at r 0\nx get v p0\nz at r 1\nout add x z\nret out\nend\nfn abi_step u32 u32 u32 u32 u32 u32 u32 u32 u32 -> u32\ns0 add p0 p1\ns1 add s0 p2\ns2 add s1 p3\ns3 add s2 p4\ns4 add s3 p5\ns5 add s4 p6\ns6 add s5 p7\ns7 add s6 p8\nret s7\nend\nfn abi_pred u32 u32 u32 u32 u32 u32 u32 u32 u32 -> bool\nout lt p1 p8\nret out\nend\nfn abi_iter u32 u32 u32 u32 u32 u32 u32 u32 u32 -> u32\nr fold abi_step p0 p1 p2 p3 p4 p5 p6 p7 p8\nret r\nend\nfn abi_loop u32 u32 u32 u32 u32 u32 u32 u32 u32 -> u32\nr loop abi_pred abi_step p0 p1 p2 p3 p4 p5 p6 p7 p8\nret r\nend\nfn abi_big u32 u32 -> u32\nrow arr p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0 p0\nbig arr row row row row row row row row row row row row row row row row\nchanged set row p1 7\nb2 set big p1 changed\noldrow get big p1\nnewrow get b2 p1\nold get oldrow p1\nfresh get newrow p1\nout add old fresh\nret out\nend\nfn abi_text u32 -> u32\na text "é#\\n"\nr get a p0\nret r\nend\n';

const MASK = 0xffffffffn;
const word = (value: bigint): number => Number(value & MASK);

export function abiCases(): Case[] {
  const cases: Case[] = [];
  for (const seed of [0, 1, 7, 0x80000000, 0xffffffff]) {
    cases.push({
      functionName: 'abi_call',
      args: [seed],
      expected: word(2n * BigInt(seed) + 268n),
    });
    cases.push({
      functionName: 'abi_big',
      args: [seed, 0xffffffff],
      expected: word(BigInt(seed) + 7n),
    });
    for (const count of [0, 1, 4, 11])
      for (const limit of [0, 3, 15])
        for (const loop of [false, true]) {
          const n = loop ? Math.min(count, limit) : count;
          cases.push({
            functionName: loop ? 'abi_loop' : 'abi_iter',
            args: [count, seed, 2, 3, 5, 7, 11, 13, limit],
            expected: word(
              BigInt(seed) + BigInt(n) * BigInt(41 + limit) + BigInt((n * (n - 1)) / 2),
            ),
          });
        }
  }
  const bytes = [195, 169, 35, 10];
  for (const index of [0, 1, 2, 3, 4, 0x7fffffff, 0x80000000, 0xffffffff])
    cases.push({ functionName: 'abi_text', args: [index], expected: bytes[index % 4] as number });
  cases.push({
    functionName: 'abi_mix',
    args: [0xffffffff, true, 3, false, 5, true, 7, true, 9],
    expected: 179,
  });
  return cases;
}
