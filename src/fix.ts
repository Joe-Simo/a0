/**
 * Applying the edits a diagnostic carries (src/diagnostics.ts `FixEdit`) to the text it was raised
 * on: a source file or an edit-protocol reply. `fixAll` is the loop behind `fix all` (edit
 * protocol), `a0 check --fix` and the reject corpus: raise the diagnostic, apply its exact edits,
 * raise the next one, until the text is accepted or a diagnostic has no exact fix left.
 */

import { lineComment, normalizeLine } from './core.js';
import { A0Error, type FixEdit } from './diagnostics.js';

/** The words of a line's code part (comment removed). */
const words = (raw: string): string[] =>
  normalizeLine(raw)
    .split(' ')
    .filter((w) => w.length > 0);

/** Index of the first line in `[from, to)` for which `match` holds, or -1. */
function find(
  lines: readonly string[],
  from: number,
  to: number,
  match: (raw: string) => boolean,
): number {
  for (let i = from; i < to; i += 1) if (match(lines[i] as string)) return i;
  return -1;
}

/** The code part of a raw line with every word equal to `from` (after the first) replaced. */
function renameWords(raw: string, from: string, to: string): string {
  const comment = lineComment(raw);
  const code = comment === undefined ? raw : raw.slice(0, raw.length - comment.length);
  let first = true;
  const out = code
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s*$/.test(part)) return part;
      if (first) {
        first = false;
        return part;
      }
      return part === from ? to : part;
    })
    .join('');
  return comment === undefined ? out : `${out}${comment}`;
}

/**
 * Apply one edit; undefined when the line it targets is not in the text (the text changed since
 * the diagnostic, or the edit belongs to another file).
 */
export function applyEdit(text: string, edit: FixEdit): string | undefined {
  const lines = text.split(/\r?\n/);
  if (edit.op === 'lines') {
    const hint = edit.line === undefined ? -1 : edit.line - 1;
    const at =
      hint >= 0 && hint < lines.length && normalizeLine(lines[hint] as string) === edit.text
        ? hint
        : find(lines, 0, lines.length, (raw) => normalizeLine(raw) === edit.text);
    if (at < 0) return undefined;
    const raw = lines[at] as string;
    const comment = lineComment(raw);
    const replacement = edit.to === '' ? [] : edit.to.split('\n');
    if (comment !== undefined && replacement.length > 0)
      replacement[replacement.length - 1] = `${replacement[replacement.length - 1]} ${comment}`;
    lines.splice(at, 1, ...replacement);
    return lines.join('\n');
  }
  // rename: the `fn` block when there is one (an edit reply has none), else the whole text.
  const header = find(lines, 0, lines.length, (raw) => {
    const w = words(raw);
    return w[0] === 'fn' && w[1] === edit.fn;
  });
  const from = header < 0 ? 0 : header + 1;
  let to = lines.length;
  if (header >= 0) {
    const end = find(lines, from, lines.length, (raw) => normalizeLine(raw) === 'end');
    if (end >= 0) to = end + 1;
  }
  const at = find(lines, from, to, (raw) => {
    const w = words(raw);
    return w[0] === edit.node && w.slice(1).includes(edit.from);
  });
  if (at < 0) return undefined;
  lines[at] = renameWords(lines[at] as string, edit.from, edit.to);
  return lines.join('\n');
}

/** An exact edit that was applied, with the diagnostic row that carried it. */
export interface AppliedFix {
  readonly id: string | undefined;
  readonly edit: FixEdit;
}

export interface FixOutcome {
  /** The text after every exact fix that applied. */
  readonly text: string;
  /** The exact edits applied, in order. */
  readonly applied: readonly AppliedFix[];
  /** The diagnostic that stopped the loop (no exact fix), or undefined when `check` accepted the text. */
  readonly error?: A0Error;
}

/**
 * Repeat `check(text)`; while it throws a diagnostic whose fix is `exact`, apply the edits and
 * check again. Returns when the text is accepted (no `error`) or a diagnostic has no exact fix
 * (`error`), or after `limit` rounds. Never throws anything but non-diagnostic errors.
 */
export function fixAll(text: string, check: (text: string) => void, limit = 64): FixOutcome {
  const applied: AppliedFix[] = [];
  let current = text;
  for (let round = 0; round <= limit; round += 1) {
    try {
      check(current);
      return { text: current, applied };
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
      if (e.applicability !== 'exact' || e.edits.length === 0 || round === limit)
        return { text: current, applied, error: e };
      let next = current;
      let ok = true;
      for (const edit of e.edits) {
        const done = applyEdit(next, edit);
        if (done === undefined) {
          ok = false;
          break;
        }
        next = done;
        applied.push({ id: e.id, edit });
      }
      if (!ok || next === current) return { text: current, applied, error: e };
      current = next;
    }
  }
  return { text: current, applied };
}

/**
 * The 1-based line of `source` a diagnostic is about: its own line (parse errors), else the line of
 * the function header or node named in a validator message (`fn.node: ...`), else null.
 */
export function diagnosticLine(source: string, e: A0Error): number | null {
  if (e.line !== undefined) return e.line;
  const m = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?[:.]/.exec(e.message);
  if (m === null) return null;
  const lines = source.split(/\r?\n/);
  const header = lines.findIndex((l) => {
    const w = words(l);
    return w[0] === 'fn' && w[1] === m[1];
  });
  if (header < 0) return null;
  if (m[2] === undefined) return header + 1;
  const end = lines.findIndex((l, i) => i > header && normalizeLine(l) === 'end');
  const at = find(lines, header + 1, end < 0 ? lines.length : end, (raw) => words(raw)[0] === m[2]);
  return (at < 0 ? header : at) + 1;
}
