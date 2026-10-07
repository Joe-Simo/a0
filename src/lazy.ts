/**
 * Lazy teaching: the rules a primer would carry on every call, paid only when a call needs them
 * (docs/history/2026-10-07-primer-v4-lazy-preregistration.md). Three surfaces, all off unless
 * `A0_LAZY_HINTS=on` (the V3 primer's diagnostics are unchanged without it):
 *
 *   - the view of a function that uses `fold` ends with a one-line legend of it
 *     (the key legend of src/wordkey.ts is the precedent): the example is paid only where the construct is used;
 *   - a rejection that names the op it failed on (a type, arity or operand error) ends with that op's signature;
 *   - an unknown op or callee lists every op with its operands, and the first rejection of a session ends with a
 *     rule card (once per session, not on every rejection).
 */

import type { Func } from './core.js';
import { A0Error } from './diagnostics.js';

/** True when the lazy hints are on (the primer that leaves these rules out is in use). */
export const lazyHints = (): boolean => process.env.A0_LAZY_HINTS === 'on';

/** The operands and meaning of each op a reply may use, one short line each. */
export const OP_SIGNATURE: Readonly<Record<string, string>> = {
  mov: 'mov a: a copy of a',
  add: 'add a b: u32 u32 -> u32, wraps mod 2^32',
  sub: 'sub a b: u32 u32 -> u32, wraps mod 2^32',
  mul: 'mul a b: u32 u32 -> u32, wraps mod 2^32',
  and: 'and a b: u32 u32 -> u32, or bool bool -> bool',
  or: 'or a b: u32 u32 -> u32, or bool bool -> bool',
  xor: 'xor a b: u32 u32 -> u32, or bool bool -> bool',
  shl: 'shl a n: u32 u32 -> u32, the distance is n & 31',
  shr: 'shr a n: u32 u32 -> u32 (logical), the distance is n & 31',
  div: 'div a b: u32 u32 -> u32; b = 0 gives 4294967295',
  rem: 'rem a b: u32 u32 -> u32; b = 0 gives a',
  eq: 'eq a b: two u32 or two bool -> bool',
  ne: 'ne a b: two u32 or two bool -> bool',
  lt: 'lt a b: u32 u32 -> bool, unsigned',
  le: 'le a b: u32 u32 -> bool, unsigned',
  gt: 'gt a b: u32 u32 -> bool, unsigned',
  ge: 'ge a b: u32 u32 -> bool, unsigned',
  select: 'select c x y: c is bool, x and y have the same type; gives x if c else y',
  call: 'call F a...: F is defined above, one argument per parameter',
  fold: 'fold F n s a...: n a number; state = s, then for i < n: state = F(state, i, a...)',
  loop: 'loop P F n s a...: while P(state, i, a...) holds, state = F(state, i, a...), at most n times; P and F are defined above',
  arr: 'arr e...: an array of the operands',
  rec: 'rec e...: a record of the operands',
  get: 'get arr i: the element at i mod length',
  set: 'set arr i v: a copy with element i mod length replaced',
  at: 'at rec k: field k of the record, k a number',
  put: 'put rec k v: a copy with field k replaced',
  text: 'text "s": the array of the bytes of s',
  read: 'read t: a record (word, io): at r 0 is the word, at r 1 the new token',
  write: 'write t v: the new token; appends v to the output',
  puts: 'puts t arr: the new token; appends the length and the elements',
};

/** Diagnostics that name the node whose op was misused (a type or arity fault), by id. */
const OP_FAULTS: ReadonlySet<string> = new Set([
  'A0201',
  'A0202',
  'A0203',
  'A0204',
  'A0205',
  'A0208',
  'A0209',
  'A0210',
  'A0211',
  'A0212',
  'A0213',
  'A0214',
  'A0215',
  'A0216',
  'A0217',
  'A0219',
  'A0220',
  'A0221',
  'A0222',
  'A0306',
  'A0307',
]);

/** Every op with its operands, for an unknown op or callee (about 110 tokens, paid only then). */
export const OP_TABLE =
  'ops: add sub mul and or xor shl shr div rem a b | eq ne lt le gt ge a b -> bool | select c x y | mov a | call F a... | fold F n s a... (state=s; i<n: state=F(state,i,a...)) | loop P F n s a... (F while P(state,i,a...), at most n times) | arr e... | rec e... | get a i | set a i v | at r k | put r k v | text "s" | read t (record: at r 0 word, at r 1 new token) | write t v | puts t a (io tokens are used once)';

/** The rule card: the first rejection of a session ends with it, later ones do not. */
export const RULE_CARD =
  'rules: one op per line (a sub-result gets its own earlier line); args are earlier ids, pN, numbers, true, false; callees are defined above their callers; bare lines edit only the shown function';

const withFix = (e: A0Error, fix: string): A0Error =>
  new A0Error(e.detail, e.line, { ...e.detailOf(), fix });

/**
 * The lazy form of a rejection. `reply` is the text of the rejected edit (the op of a failing node is read from it),
 * `first` is true for the first rejection of the session.
 */
export function lazyDiagnostic(e: A0Error, reply: string, first: boolean): A0Error {
  let fix = e.fix;
  const unknownOp =
    (e.id === 'A0011' && fix?.startsWith('use one of') === true) ||
    (e.id === 'A0102' && fix?.includes('is neither an op nor a function') === true);
  if (unknownOp) {
    const name = /unknown (?:operation|callee) '([^']*)'/.exec(e.detail)?.[1] ?? '';
    fix = `${name === '' ? 'that word' : `'${name}'`} is neither an op nor a function defined above: ${OP_TABLE}`;
  } else if (e.id !== undefined && OP_FAULTS.has(e.id)) {
    const node = /^[a-z][a-z0-9_]*\.([a-z0-9_]+)\b/.exec(e.detail)?.[1];
    const op =
      node === undefined
        ? undefined
        : reply
            .split(/\r?\n/)
            .map((l) => l.trim().split(/\s+/))
            .find((w) => w[0] === node)?.[1];
    const sig = op === undefined ? undefined : OP_SIGNATURE[op];
    if (sig !== undefined) fix = `${fix ?? ''}${fix === undefined ? '' : '; '}${sig}`;
  }
  if (first) fix = `${fix ?? ''}${fix === undefined ? '' : ' | '}${RULE_CARD}`;
  return fix === e.fix ? e : withFix(e, fix ?? '');
}

const FOLD_LEGEND = '# fold F n s a...: state = s; for i < n: state = F(state, i, a...)';

/**
 * One legend line when a shown function uses `fold`, or '' (the V3 primer spelled fold out on every call; `loop` and io were
 * never in it and their diagnostics carry them, so they get no legend).
 */
export function constructLegend(fns: readonly Func[]): string {
  for (const fn of fns) for (const n of fn.nodes) if (n.op === 'fold') return FOLD_LEGEND;
  return '';
}
