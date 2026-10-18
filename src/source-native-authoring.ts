/** Authoring metadata carried by existing schema1 line/comment tables, never source code. */
import type { Comments } from './core.js';
import { losslessSourceString } from './source-utf8.js';

export type NativeSourceMetadataIssue =
  | 'intermediate-tail'
  | 'empty-tail'
  | 'program-tail'
  | 'unrepresentable-comment';
export type NativeTextMetadataIssue = 'text-mismatch' | 'unrepresentable-text';
export interface NativeAuthoringAvailability {
  readonly source?: NativeSourceMetadataIssue;
  readonly text?: NativeTextMetadataIssue;
}
export interface NativeMetadataOwnership {
  readonly profileLine: number;
  readonly tailFirst: number;
  readonly tailCount: number;
}

const NONE = 0xffff_ffff;
const word = (value: number): number => {
  if (!Number.isInteger(value) || value < 0 || value > NONE)
    throw new Error('unrepresentable native authoring metadata extent');
  return value;
};

/** Real payload strings only; unavailable metadata cannot produce an apparently complete source. */
export function nativeCommentEncoder(span: (value: string) => readonly [number, number]) {
  const lines: number[] = [];
  const comments: number[] = [];
  let issue: NativeSourceMetadataIssue | undefined;
  const comment = (value: string): number | undefined => {
    try {
      losslessSourceString(value, 'native authoring comment');
    } catch {
      issue ??= 'unrepresentable-comment';
      return undefined;
    }
    const [start, length] = span(value);
    const id = word(comments.length / 3);
    word(comments.length + 3);
    // Bare Program has no original locations. Zero never pretends to be a source line.
    comments.push(start, length, 0);
    return id;
  };
  const tail = (values: readonly string[]): readonly [number, number] => {
    const first = word(comments.length / 3);
    for (const value of values) comment(value);
    return [first, word(comments.length / 3 - first)];
  };
  return {
    lines,
    comments,
    get issue(): NativeSourceMetadataIssue | undefined {
      return issue;
    },
    refuse(reason: NativeSourceMetadataIssue): void {
      issue ??= reason;
    },
    tail,
    line(value?: Comments): number {
      const [first, count] = tail(value?.leading ?? []);
      const trailing = value?.trailing === undefined ? NONE : (comment(value.trailing) ?? NONE);
      if (!count && trailing === NONE && lines.length) return 0;
      const id = word(lines.length / 10);
      word(lines.length + 10);
      lines.push(0, 0, 0, 0, 0, 0, 0, trailing, first, count);
      return id;
    },
  };
}
