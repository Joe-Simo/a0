/** Edit application shared by the AI-edit experiment and the edit-loop benchmark. */

export type Protocol = 'conventional' | 'structured';

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
