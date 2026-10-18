/** Shared source and executable-contract aggregate grammar, recovered from the frozen frontend experiment. */
const blank = (c: string | undefined) => c !== undefined && /\s/.test(c);
export interface AggregateCursor {
  readonly text: string;
  pos: number;
}
export interface AggregatePolicy<T> {
  readonly maxElements: number;
  atom(): T;
  fail(message: string, offset?: number): never;
}
export function aggregate<T>(
  cursor: AggregateCursor,
  policy: AggregatePolicy<T>,
): { kind: 'arr' | 'rec'; items: T[] } {
  const { text } = cursor;
  const start = cursor.pos;
  const open = text[cursor.pos];
  if (open !== '[' && open !== '(')
    return policy.fail('an aggregate must start with [ or (', cursor.pos);
  const array = open === '[';
  const close = array ? ']' : ')';
  cursor.pos += 1;
  const ws = () => {
    const from = cursor.pos;
    while (blank(text[cursor.pos])) cursor.pos += 1;
    return cursor.pos !== from;
  };
  ws();
  if (text[cursor.pos] === close)
    return policy.fail('an aggregate needs at least one element', cursor.pos);
  const items: T[] = [];
  let singletonComma = false;
  for (;;) {
    const from = cursor.pos;
    const item = policy.atom();
    if (cursor.pos <= from) throw new Error('aggregate atom parser did not consume input');
    items.push(item);
    if (items.length > policy.maxElements)
      return policy.fail('aggregate exceeds the language element budget', from);
    const spaced = ws();
    if (text[cursor.pos] === '*') {
      if (!array || items.length !== 1)
        return policy.fail('repetition requires one array element', cursor.pos);
      cursor.pos += 1;
      ws();
      const countStart = cursor.pos;
      const digits = /^[1-9][0-9]*/.exec(text.slice(cursor.pos))?.[0];
      if (digits === undefined)
        return policy.fail('array repeat count must be a positive decimal integer', countStart);
      cursor.pos += digits.length;
      const count = Number(digits);
      if (!Number.isSafeInteger(count) || count > policy.maxElements)
        return policy.fail('array repeat count exceeds the language element budget', countStart);
      ws();
      if (text[cursor.pos] !== close)
        return policy.fail('array repetition must end at ]', cursor.pos);
      cursor.pos += 1;
      return { kind: 'arr', items: new Array(count).fill(item) };
    }
    if (text[cursor.pos] === ',') {
      cursor.pos += 1;
      ws();
      if (text[cursor.pos] === close) {
        if (array || items.length !== 1)
          return policy.fail('only a single-field record takes a trailing comma', cursor.pos - 1);
        singletonComma = true;
      } else continue;
    }
    if (text[cursor.pos] === close) {
      cursor.pos += 1;
      break;
    }
    if (cursor.pos >= text.length) return policy.fail(`missing '${close}'`, cursor.pos);
    if (!spaced) return policy.fail(`expected whitespace, comma or '${close}'`, cursor.pos);
  }
  if (!array && items.length === 1 && !singletonComma)
    return policy.fail('a single-field record needs its trailing comma', start);
  return { kind: array ? 'arr' : 'rec', items };
}
/** Canonical aggregate spelling; repetition is used for three or more equal elements. */
export function formatAggregate<T>(
  kind: 'arr' | 'rec',
  items: readonly T[],
  atom: (item: T) => string,
): string {
  const words = items.map(atom);
  if (kind === 'rec') return `(${words.join(' ')}${words.length === 1 ? ',' : ''})`;
  const repeat = words.length >= 3 && words.every((word) => word === words[0]);
  return `[${repeat ? `${words[0]}*${words.length}` : words.join(' ')}]`;
}
