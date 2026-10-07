/**
 * Harvest of the op names and syntax variants models wrote that the checker rejected, from every recorded run in results/
 * (reports with `trials[].attempts[].failures`, plus the recorded scripted replies next to them). Deterministic: no model call.
 *
 *   bun tools/invented-ops.ts      writes results/invented-ops.json
 *
 * Counted per model (read from the file name) and per rejection: one count for every recorded attempt whose first failure is
 * "unknown operation 'X'" or "unknown callee 'X'" (the word X in op position). Failure texts repeated in one trial's top-level
 * `failures` list are not counted twice (only `attempts[].failures[0]` is read). The "meant" column is a fixed reading of the
 * word by context (the op a model in A0's vocabulary means by it); it is the table `MEANT` below, stated before the fixes
 * were written, not derived from any later run.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeReport } from './scrub-results.js';

/** The op each invented word stands for, by the usual reading; undefined = no single op. */
export const MEANT: Readonly<Record<string, string>> = {
  mod: 'rem',
  umod: 'rem',
  neq: 'ne',
  equ: 'eq',
  lte: 'le',
  gte: 'ge',
  sel: 'select',
  ule: 'le',
  uge: 'ge',
  ult: 'lt',
  ugt: 'gt',
  max: 'select (gt)',
  min: 'select (lt)',
  not: 'xor with true (bool) or no single op',
  neg: 'sub 0 x',
  abs: 'no single op',
  cmp: 'comparison op (which one is not known)',
  mov: 'mov',
  move: 'mov',
  set: 'set',
  let: 'prefix to drop',
  const: 'prefix to drop',
  return: 'ret',
  jmp: 'no op (assembly style)',
  jz: 'no op (assembly style)',
  jne: 'no op (assembly style)',
  jge: 'no op (assembly style)',
  mul: 'mul',
};

function walk(dir: string, out: string[]): void {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.json')) out.push(p);
  }
}

interface Attempt {
  failures?: unknown;
}
interface Trial {
  attempts?: Attempt[];
}

const files: string[] = [];
walk('results', files);
const counts = new Map<string, { haiku: number; sonnet: number; other: number }>();
const scanned: string[] = [];
for (const file of files.sort()) {
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const trials = (j as { trials?: Trial[] }).trials;
  if (!Array.isArray(trials)) continue;
  const model = /haiku/i.test(file) ? 'haiku' : /sonnet/i.test(file) ? 'sonnet' : 'other';
  let any = false;
  for (const t of trials) {
    for (const a of t.attempts ?? []) {
      const first = Array.isArray(a.failures) ? a.failures[0] : undefined;
      if (typeof first !== 'string') continue;
      const m = /unknown (?:operation|callee) '([^']+)'/.exec(first);
      if (m === null) continue;
      const word = m[1] as string;
      const row = counts.get(word) ?? { haiku: 0, sonnet: 0, other: 0 };
      row[model] += 1;
      counts.set(word, row);
      any = true;
    }
  }
  if (any) scanned.push(file);
}
/** A rejected word that is a number or a lone letter is a malformed line (a missing id), not an invented op. */
const kindOf = (word: string): string =>
  /^[0-9]+$/.test(word) || /^p[0-9]+$/.test(word) || /^[a-z]$/.test(word)
    ? 'malformed line (the word is an operand or an id, the op is missing)'
    : Object.hasOwn(MEANT, word)
      ? 'invented op name'
      : 'undefined helper name or unlisted invention';

// Surface forms in the recorded A0 replies (all scripted-reply files): lines ending in `;`, `return`, a `let`/`const`/`var` prefix,
// a code fence, and an operator symbol in op position. Counted per model from the file name.
const forms = new Map<string, { haiku: number; sonnet: number; other: number }>();
const bump = (key: string, model: 'haiku' | 'sonnet' | 'other'): void => {
  const row = forms.get(key) ?? { haiku: 0, sonnet: 0, other: 0 };
  row[model] += 1;
  forms.set(key, row);
};
let replyFiles = 0;
let replyCount = 0;
for (const file of files.sort()) {
  if (!/replies.*\.json$/.test(file)) continue;
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const model = /haiku/i.test(file) ? 'haiku' : /sonnet/i.test(file) ? 'sonnet' : 'other';
  let any = false;
  for (const [key, list] of Object.entries(j as Record<string, unknown>)) {
    if (!key.includes('/a0/') || !Array.isArray(list)) continue;
    for (const reply of list) {
      if (typeof reply !== 'string') continue;
      any = true;
      replyCount += 1;
      for (const raw of reply.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const w = line.split(/\s+/);
        if (/;\s*$/.test(line)) bump('trailing semicolon', model);
        if (w[0] === 'return') bump('return instead of ret', model);
        if (/^(let|const|var)$/.test(w[0] ?? '')) bump('let/const/var prefix', model);
        if (line.startsWith('```')) bump('code fence', model);
        if (w[1] !== undefined && /^[=!<>+\-*/%&|^]+$/.test(w[1]))
          bump(`symbol ${w[1]} in op position`, model);
      }
    }
  }
  if (any) replyFiles += 1;
}
const formRows = [...forms.entries()]
  .map(([form, c]) => ({ form, ...c, total: c.haiku + c.sonnet + c.other }))
  .sort((a, b) => b.total - a.total || a.form.localeCompare(b.form));

const rows = [...counts.entries()]
  .map(([word, c]) => ({
    word,
    kind: kindOf(word),
    meant: MEANT[word] ?? null,
    haiku: c.haiku,
    sonnet: c.sonnet,
    other: c.other,
    total: c.haiku + c.sonnet + c.other,
  }))
  .sort((a, b) => b.total - a.total || a.word.localeCompare(b.word));
await writeReport('results/invented-ops.json', {
  generatedAt: new Date().toISOString(),
  tool: 'tools/invented-ops.ts',
  meaning:
    'Words in op position the checker rejected as an unknown operation or callee, counted per recorded attempt and model (from the file name) over every report in results/.',
  filesWithRejections: scanned.length,
  rows,
  surfaceForms: {
    replyFiles,
    replies: replyCount,
    note: 'Most `>>`, `<<` rows come from the dense-syntax runs of set a (replies in dense-bodies, dense-lean, dense), whose lines write `s >> A 16`, not the canonical syntax; the canonical-syntax runs (primer-v3, primer-v4, dense-default canon) have none.',
    rows: formRows,
  },
});
for (const r of formRows)
  console.log(`${r.total}	h${r.haiku}	s${r.sonnet}	o${r.other}	${r.form}`);
for (const r of rows)
  console.log(
    `${r.total}\th${r.haiku}\ts${r.sonnet}\to${r.other}\t${r.word}\t-> ${r.meant ?? '?'}`,
  );
