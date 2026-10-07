/**
 * The word key of the A0 front end (compiler/parse.a0, `scanb`): the first six characters of a
 * word, a-z as 1..26, 0-9 as 27..36 and `_` as 37, summed as `code * 37^position`; a word longer
 * than six characters has key 0. `kwcode` and `opcode` compare this key (`eq p0 524` is `fn`).
 * View-only: nothing here is part of the canonical program text or of any revision.
 */

import { type Func, OPS } from './core.js';

const CODES = 'abcdefghijklmnopqrstuvwxyz0123456789_';

/** The key of a word, or undefined when it has a character outside `[a-z0-9_]`. */
export function wordKey(word: string): number | undefined {
  if (word.length === 0 || [...word].some((c) => !CODES.includes(c))) return undefined;
  if (word.length > 6) return 0;
  let key = 0;
  let pow = 1;
  for (const c of word) {
    key += (CODES.indexOf(c) + 1) * pow;
    pow *= 37;
  }
  return key;
}

/** Words a front end compares against: syntax words, operations, types, spec and file words. */
export const KNOWN_WORDS: readonly string[] = [
  ...new Set([
    ...OPS,
    'cadd',
    'csub',
    'cmul',
    'cdiv',
    'crem',
    'cget',
    'fn',
    'ret',
    'end',
    'patch',
    'true',
    'false',
    'use',
    'import',
    'mod',
    'text',
    'ex',
    'pre',
    'post',
    'u32',
    'u8',
    'u16',
    'u64',
    'i32',
    'bool',
    'io',
  ]),
];

const BY_KEY = new Map<number, string[]>();
for (const w of KNOWN_WORDS) {
  const k = wordKey(w);
  if (k !== undefined) BY_KEY.set(k, [...(BY_KEY.get(k) ?? []), w]);
}

/** The rule, once per legend, so the key of a word not listed (`import`) can be computed. */
export const KEY_RULE =
  '(key: first 6 chars, a-z=1..26 0-9=27..36 _=37, sum of code*37^i from i=0; longer words 0)';

/**
 * A comment line naming the word behind every integer literal compared with `eq`/`ne` in these
 * functions that is the key of a known word (`# keys: 524=fn`), or '' when there is none.
 */
export function keyLegend(fns: readonly Func[]): string {
  const seen = new Map<number, string>();
  for (const fn of fns)
    for (const n of fn.nodes) {
      if (n.op !== 'eq' && n.op !== 'ne') continue;
      for (const a of n.args) {
        if (a.kind !== 'u32' || a.value === 0) continue;
        const words = BY_KEY.get(a.value);
        if (words !== undefined) seen.set(a.value, words.join('|'));
      }
    }
  if (seen.size === 0) return '';
  return `# keys: ${[...seen].map(([k, w]) => `${k}=${w}`).join(' ')} ${KEY_RULE}`;
}
