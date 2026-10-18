/** Physical reply ownership, independent of A0 grammar and edit transaction policy. */
import { type Func, utf8Length } from './core.js';

export interface EditSourceOrigin {
  readonly line: number;
  readonly byteStart: number;
  readonly utf16Start: number;
  readonly raw: string;
  /** Selected contiguous substring of the original physical row. */
  readonly start: number;
  readonly end: number;
}

export interface EditSourceOwner {
  readonly fn: Func;
  readonly kind: 'header' | 'node' | 'ret' | 'end' | 'example' | 'pre' | 'post';
  readonly index?: number;
}

export interface EditSourceLine {
  readonly text: string;
  readonly origin?: EditSourceOrigin;
  /** An untouched row emitted from the pre-edit function; never an invented reply location. */
  readonly owner?: EditSourceOwner;
}

export function editSourceLines(raw: string): EditSourceLine[] {
  let byteStart = 0,
    utf16Start = 0;
  return raw.split('\n').map((physical, index) => {
    const text = physical.endsWith('\r') ? physical.slice(0, -1) : physical;
    const row = {
      text,
      origin: { line: index + 1, byteStart, utf16Start, raw: text, start: 0, end: text.length },
    };
    byteStart += utf8Length(physical) + 1;
    utf16Start += physical.length + 1;
    return row;
  });
}

export function editSourceSlice(
  row: EditSourceLine,
  start: number,
  end = row.text.length,
): EditSourceLine {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > row.text.length
  )
    throw new Error('invalid edit reply substring');
  return {
    text: row.text.slice(start, end),
    ...(row.origin === undefined
      ? {}
      : {
          origin: { ...row.origin, start: row.origin.start + start, end: row.origin.start + end },
        }),
    ...(row.owner === undefined ? {} : { owner: row.owner }),
  };
}

/** Only contiguous source-preserving rewrites retain their original executable-fix ownership. */
export function editSourceText(row: EditSourceLine, text: string): EditSourceLine {
  if (text === row.text) return row;
  const at = row.text.indexOf(text);
  return at >= 0 ? editSourceSlice(row, at, at + text.length) : { text };
}

export function cleanEditSource(raw: string): EditSourceLine[] {
  return editSourceLines(raw).filter((row) => !/^\s*```[A-Za-z0-9_-]*\s*$/.test(row.text));
}

export function editSourceJoin(rows: readonly EditSourceLine[]): string {
  return rows.map((row) => row.text).join('\n');
}
