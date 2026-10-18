/** Stable numeric instruction codes of the internal word IR, independent of source syntax. */
export const IR_OPS = [
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
] as const;

/** Accepted op spellings: udiv is div, urem is rem. */
const IR_ALIASES: Readonly<Record<string, string>> = { udiv: 'div', urem: 'rem' };

/** Op code of DESIGN.md 7a (1-based), aliases included; 0 when the word is not an op. */
export function irOp(name: string): number {
  return (IR_OPS as readonly string[]).indexOf(IR_ALIASES[name] ?? name) + 1;
}
