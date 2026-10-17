/** Shared deterministic names for implicit IR nodes; source readers do not own the sequence. */
import { ALL_OPS, isValidIdentifier } from './core.js';
import { A0Error } from './diagnostics.js';
/** Words that are never an unescaped id: ops, aliases, structure words and type names. */
export const RESERVED_BINDINGS = new Set<string>([
  ...ALL_OPS,
  'udiv',
  'urem',
  'text',
  'fn',
  'ret',
  'end',
  'use',
  'patch',
  'true',
  'false',
]);

/** The i-th default id: a..z, aa..zz, aaa.. (skipping words that would be ambiguous). */
export function* defaultNames(taken: ReadonlySet<string>): Generator<string> {
  for (let len = 1; len <= 4; len += 1) {
    const idx = new Array<number>(len).fill(0);
    for (;;) {
      const name = idx.map((c) => String.fromCharCode(97 + c)).join('');
      if (!taken.has(name) && isValidIdentifier(name) && !RESERVED_BINDINGS.has(name)) yield name;
      let k = len - 1;
      while (k >= 0 && idx[k] === 25) {
        idx[k] = 0;
        k -= 1;
      }
      if (k < 0) break;
      idx[k] = (idx[k] as number) + 1;
    }
  }
  throw new A0Error('too many nodes for default names', undefined, { code: 'limit' });
}
