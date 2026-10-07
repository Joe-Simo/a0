/**
 * Failure taxonomy over every recorded A0 subject trial in results/ (docs/design/failure-taxonomy.md).
 *
 * Reads every report under results/ that has a `trials` array of A0 trials (ai-edit-experiment.*, set-*,
 * primer-ablation, shipped, selection, dense-rounds, app-edit*, ...), skips scripted oracle runs, the
 * one-shot duplicates (`report1.*`) and a base file that has a `-retry` or `-repair` file (the later file
 * supersedes it), and classifies each trial whose FIRST attempt was not accepted by the root cause of the
 * harness's first rejection message. The class is a rule over the message text and the attempt status
 * (the rules are below and are a labelled reading, not a measurement of the model's intent); the
 * diagnostic id is found by matching the message against the DIAGNOSTICS table of src/diagnostics.ts.
 * "Repaired" is the recorded `accepted` flag after the one repair. Writes results/failure-taxonomy.json.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIAGNOSTICS, type DiagId } from '../src/diagnostics.js';
import { writeReport } from './scrub-results.js';

export const CLASSES = [
  'syntax slip',
  'ordering',
  'id reuse',
  'type/width mismatch',
  'misunderstood semantics',
  'protocol misuse',
  'view gap',
  'budget exhaustion',
  'other',
] as const;
export type FailureClass = (typeof CLASSES)[number];

interface Row {
  file: string;
  model: string;
  task: string;
  oneShot: boolean | null;
  accepted: boolean | null;
  status: string;
  message: string;
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name).replaceAll('\\', '/');
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.json')) out.push(p);
  }
}

interface RawTrial {
  task?: string;
  representation?: string;
  acceptedOneShot: boolean | null;
  accepted: boolean | null;
  attempts?: { status: string; failures?: string[] }[];
  failures?: string[];
}

export function collect(root = 'results'): Row[] {
  const files: string[] = [];
  walk(root, files);
  const have = new Set(files);
  const rows: Row[] = [];
  for (const p of files) {
    const b = p.slice(p.lastIndexOf('/') + 1);
    if (/replies|scripted|^report1\.|\.failures\.|dump|summary/.test(b)) continue;
    if (['-retry', '-repair'].some((s) => have.has(p.replace(/\.json$/, `${s}.json`)))) continue;
    let j: { trials?: RawTrial[] };
    try {
      j = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(j.trials)) continue;
    const model = /haiku/i.test(p) ? 'haiku' : /sonnet/i.test(p) ? 'sonnet' : 'unknown';
    for (const t of j.trials) {
      if (!t.task) continue;
      const rep = t.representation ?? '';
      if (rep !== '' && !/^(a0|dense|canon)/.test(rep)) continue;
      if (t.acceptedOneShot === true) continue;
      const a = t.attempts?.[0];
      rows.push({
        file: p,
        model,
        task: t.task,
        oneShot: t.acceptedOneShot,
        accepted: t.accepted,
        status: a?.status ?? '?',
        message: (a?.failures?.[0] ?? t.failures?.[0] ?? '').toString(),
      });
    }
  }
  return rows;
}

/** Words a model writes as if they were ops (none is an A0 op, see MODEL_GUIDE.txt): a callee of these names is a slip, not an ordering fault. */
const OP_ALIASES = new Set(
  'sel mod not min max lte gte lt gt le ge ult ugt ule uge cmp neg equ eq2 div abs sqrt umod ne2 inc dec'.split(
    ' ',
  ),
);

const matchers = (Object.keys(DIAGNOSTICS) as DiagId[])
  .filter(
    (id) =>
      (DIAGNOSTICS[id] as { message: string }).message.replace(/\{\d+\}/g, '').trim().length >= 8,
  )
  .map((id) => {
    const spec = DIAGNOSTICS[id] as { message: string; fix?: string };
    const body = spec.message
      .replace(/[.*+?^$|\\[\]()]/g, '\\$&')
      .replace(/\{\d+\}/g, '.+?')
      .replace(/\s+/g, '\\s+');
    return {
      id,
      re: new RegExp(`^(?:[a-z]+: )?(?:line \\d+: )?(?:[\\w.']+: )?${body}`, 'i'),
      spec,
    };
  });

export function diagIdOf(message: string): DiagId | null {
  for (const m of matchers) if (m.re.test(message)) return m.id;
  return null;
}

export function classify(r: Pick<Row, 'status' | 'message'>): { cls: FailureClass; sub: string } {
  const m = r.message;
  if (r.status === 'no-reply' || m === 'no reply')
    return { cls: 'other', sub: 'no reply from the subject' };
  if (m === '') return { cls: 'other', sub: 'no failure text recorded' };
  if (
    /unknown (function|callee|fold body|loop predicate)|(callee|callees) must be defined|defined above its caller|unknown .* body/.test(
      m,
    )
  ) {
    const name = /(?:callee|function|body|predicate) '([^']+)'/.exec(m)?.[1] ?? '';
    if (OP_ALIASES.has(name) || /^p\d+$/.test(name) || name.length === 1)
      return { cls: 'syntax slip', sub: 'unknown word (typo, reserved word or alias)' };
    return { cls: 'ordering', sub: 'callee defined after its caller (or never defined)' };
  }
  if (
    /duplicate (definition|edit)|edited twice|already (defined|used)|reads the first|sequence/.test(
      m,
    )
  )
    return { cls: 'id reuse', sub: 'id defined or edited twice (A0303, A0503 sequence rule)' };
  if (/trap (fuel|iter|io)b/.test(m)) return { cls: 'budget exhaustion', sub: 'run budget' };
  if (/^spec\b|spec of|ex lines/.test(m)) return { cls: 'other', sub: 'spec example limit' };
  if (
    /^(edit|patch|revision|handle):|invalid delete target|duplicate edit|names no value|edited twice|both removed and defined|stale|unknown handle|consumed/.test(
      m,
    )
  )
    return { cls: 'protocol misuse', sub: 'edit-body or handle misuse' };
  if (/^type:/.test(m) || /expected (u32|bool|\(.*\)).*got/.test(m))
    return { cls: 'type/width mismatch', sub: 'operand or result type' };
  if (/(= |got )\s*4294967\d{3}\b/.test(m) && !/expected 4294967\d{3}\b/.test(m))
    return { cls: 'type/width mismatch', sub: 'u32 wraparound (unsigned underflow or overflow)' };
  if (/expects \d+ (extra )?arguments|select expects|expects \d+ operands/.test(m))
    return { cls: 'syntax slip', sub: 'wrong operand/argument count' };
  if (/^(parse|structure):/.test(m)) {
    if (/is not an operation, a function, or a named value|unknown operation/.test(m))
      return { cls: 'syntax slip', sub: 'unknown word (typo, reserved word or alias)' };
    if (/nested operand|invalid operand|invalid node identifier|case|comma/.test(m))
      return { cls: 'syntax slip', sub: 'operand or id spelling (nesting, case, commas)' };
    if (/after a complete expression|expected `id op operands`/.test(m))
      return { cls: 'syntax slip', sub: 'extra tokens or missing op on a line' };
    if (/before ret|after ret|expected a result type|header|expected '/.test(m))
      return { cls: 'syntax slip', sub: 'function frame (header, ret, end)' };
    return { cls: 'syntax slip', sub: 'other grammar slip' };
  }
  if (
    /expected .*got|= .*expected|tokens of|parse of|code expected/.test(m) ||
    r.status === 'wrong-output' ||
    r.status === 'tests'
  )
    return { cls: 'misunderstood semantics', sub: 'wrong behaviour on the checked inputs' };
  return { cls: 'other', sub: 'unclassified' };
}

export interface ClassRow {
  cls: FailureClass;
  total: number;
  repaired: number;
  stillFailed: number;
  perModel: Record<string, { total: number; repaired: number }>;
  subs: Record<string, number>;
  ids: Record<string, number>;
}

/** `current`: the arms that ran the shipped wording (set-*, app-edit*, shipped/); `ablation`: every other arm (rejected wordings and variants included). */
export function scopeOf(file: string): 'current' | 'ablation' {
  return /^results\/(set-|app-edit|shipped\/)/.test(file) ? 'current' : 'ablation';
}

export function summarize(rows: Row[]): ClassRow[] {
  const by = new Map<FailureClass, ClassRow>();
  for (const c of CLASSES)
    by.set(c, { cls: c, total: 0, repaired: 0, stillFailed: 0, perModel: {}, subs: {}, ids: {} });
  for (const r of rows) {
    const { cls, sub } = classify(r);
    const c = by.get(cls) as ClassRow;
    c.total++;
    const ok = r.accepted === true;
    if (ok) c.repaired++;
    else c.stillFailed++;
    c.perModel[r.model] ??= { total: 0, repaired: 0 };
    const pm = c.perModel[r.model] as { total: number; repaired: number };
    pm.total++;
    if (ok) pm.repaired++;
    c.subs[sub] = (c.subs[sub] ?? 0) + 1;
    const id = diagIdOf(r.message) ?? '(no id)';
    c.ids[id] = (c.ids[id] ?? 0) + 1;
  }
  return [...by.values()];
}

async function main(): Promise<void> {
  const rows = collect();
  const table = summarize(rows);
  const tableCurrent = summarize(rows.filter((r) => scopeOf(r.file) === 'current'));
  const fixes: Record<string, string> = {};
  for (const c of table)
    for (const id of Object.keys(c.ids)) {
      const spec = (DIAGNOSTICS as Record<string, { message: string; fix?: string }>)[id];
      if (spec) fixes[id] = `${spec.message}${spec.fix ? ` | fix: ${spec.fix}` : ''}`;
    }
  await writeReport('results/failure-taxonomy.json', {
    generatedAt: new Date().toISOString(),
    tool: 'tools/failure-taxonomy.ts',
    meaning:
      'Every A0 subject trial under results/ whose first attempt was not accepted (one-shot failures), classified by the root cause of the first rejection message; repaired = accepted after the recorded repair. Trials repeat across ablation arms (the same task and subject type appear in many arms): counts are trials, not distinct tasks. The class rules are a reading of the message text (tools/failure-taxonomy.ts), not a measurement of intent.',
    trialsFirstAttemptNotAccepted: rows.length,
    notAcceptedAfterRepair: rows.filter((r) => r.accepted !== true).length,
    classes: table,
    currentArmsOnly: {
      meaning:
        'The same table over the arms that ran the shipped wording (results/set-*, results/app-edit*, results/shipped/).',
      trialsFirstAttemptNotAccepted: rows.filter((r) => scopeOf(r.file) === 'current').length,
      classes: tableCurrent,
    },
    diagnosticTexts: fixes,
  });
  for (const c of tableCurrent)
    console.log(
      `current ${c.cls.padEnd(24)} total ${c.total} repaired ${c.repaired} still ${c.stillFailed} ${JSON.stringify(c.perModel)}`,
    );
  for (const c of table)
    console.log(
      `${c.cls.padEnd(24)} total ${c.total} repaired ${c.repaired} still ${c.stillFailed} ${JSON.stringify(c.perModel)}`,
    );
  console.log(JSON.stringify(table, null, 1));
}

if (/failure-taxonomy\.[jt]s$/.test(process.argv[1] ?? '')) await main();
