/** Edit application shared by the AI-edit experiment and the edit-loop benchmark. */

export type Protocol = 'conventional' | 'structured';

/**
 * System text of the numbered line-edit protocol (every non-A0 structured cell). Stated
 * explicitly because two readings of the earlier text cost most first attempts of the 48-language
 * collection: leading indentation was dropped from replacement text (the text after the number),
 * and several new lines were inserted with consecutive numbers (`+8 a`, `+9 b`, which anchor
 * `a` after line 8 and `b` after line 9) instead of repeating one number. `applyTs` below is the
 * reference semantics; test/ai-edit-apply.test.ts pins both.
 */
export const PROTOCOL_LINE_EDIT =
  'You are shown a view whose first line is an edit handle (e.g. e0) and whose remaining lines are numbered. Reply with only edit lines, each starting with a line number of the view: `<number> <text>` replaces that line with <text>, `+<number> <text>` inserts <text> as a new line after that line (use +0 for the top; to insert several lines, repeat the same number once per new line, they are inserted in order), `-<number>` deletes that line. <text> is the whole line exactly as it should appear, after the single space following the number, including its leading indentation. A line may be replaced or deleted once. Nothing else, bare: no code fence, no handle line.';

export function numbered(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((l, i) => `${i + 1} ${l}`)
    .join('\n');
}

export function extractBlock(reply: string): string {
  const m = /```[a-z0-9]*\n([\s\S]*?)```/.exec(reply);
  return `${(m ? (m[1] ?? '') : reply).trimEnd()}\n`;
}

export interface AppliedEdit {
  readonly source: string;
  readonly error?: string;
}

export function applyTs(
  protocol: Protocol,
  source: string,
  reply: string,
  handle: string,
): AppliedEdit {
  const body = extractBlock(reply);
  if (protocol === 'conventional') return { source: body };
  const all = body.trimEnd().split('\n');
  // The handle line is optional (one handle is open): edit lines start with a digit, `+`, or
  // `-`, so a first line that looks like a handle is unambiguous.
  const first = all[0] ?? '';
  if (/^[a-z]+[0-9]+$/.test(first) && first !== handle)
    return { source, error: `expected handle ${handle}, got '${first}'` };
  const lines = first === handle ? all : [handle, ...all];
  const out: (string | null)[] = source.trimEnd().split('\n');
  const inserts = new Map<number, string[]>();
  const seen = new Set<number>();
  for (const l of lines.slice(1)) {
    const m = /^([+-]?)(\d+) ?(.*)$/.exec(l);
    if (!m) return { source, error: `bad edit line: ${l}` };
    const n = Number(m[2]);
    const mode = m[1] ?? '';
    if (mode === '+') {
      // Positions past the end append, in order (a model numbering new lines sequentially).
      const at = Math.min(n, out.length);
      inserts.set(at, [...(inserts.get(at) ?? []), m[3] ?? '']);
      continue;
    }
    if (seen.has(n) || n < 1) return { source, error: `bad or duplicate line number ${n}` };
    seen.add(n);
    if (n > out.length) {
      // A replacement past the end appends, like an insert past the end.
      if (mode !== '-') inserts.set(out.length, [...(inserts.get(out.length) ?? []), m[3] ?? '']);
      continue;
    }
    out[n - 1] = mode === '-' ? null : (m[3] ?? '');
  }
  const result: string[] = [...(inserts.get(0) ?? [])];
  out.forEach((line, i) => {
    if (line !== null) result.push(line);
    result.push(...(inserts.get(i + 1) ?? []));
  });
  return { source: `${result.join('\n')}\n` };
}
