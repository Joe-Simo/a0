/**
 * The reject corpus: programs and edit replies the checker must reject, each with the diagnostic it
 * must raise and the text it becomes once fixed.
 *
 *   corpus/reject/NAME.a0         a program; line 1 is `# err: A0nnnn LINE` (LINE is the 1-based line of
 *                                 the diagnostic in this file, `-` when it has none)
 *   corpus/reject/NAME.fixed.a0   the expected fixed program (the text without the header)
 *   corpus/reject/NAME.edit       an edit-protocol reply over `# base: FILE` (a program in
 *                                 corpus/reject/bases/) with `# fn: NAME` open; line 1 is `# err: ...`
 *   corpus/reject/NAME.fixed.edit the expected fixed reply
 *
 * For every case: the code and line match the header; when the diagnostic carries exact fixes,
 * applying them (the loop behind `fix all` and `a0 check --fix`) gives exactly the fixed file;
 * when it carries only a suggestion, applying its first edit does (or, with no edit, the fixed
 * file is written by hand); and the fixed file is accepted. `--coverage` lists the exact fixes of
 * src/diagnostics.ts EXACT_FIXES that no case exercises.
 *
 *   node dist/tools/reject-corpus.js            check every case
 *   node dist/tools/reject-corpus.js --bless    rewrite the `# err:` lines and the fixed files
 *   node dist/tools/reject-corpus.js --coverage also print the coverage line
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A0Error, formatProgram, parseAndValidate } from '../src/core.js';
import { EXACT_FIXES } from '../src/diagnostics.js';
import { EditSession } from '../src/edit.js';
import { applyEdit, diagnosticLine, fixAll } from '../src/fix.js';

/** corpus/reject at the repository root, from dist/tools or tools. */
export const CORPUS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ...(dirname(fileURLToPath(import.meta.url)).endsWith(join('dist', 'tools'))
    ? ['..', '..']
    : ['..']),
  'corpus',
  'reject',
);

export interface Case {
  readonly name: string;
  readonly kind: 'a0' | 'edit';
  readonly path: string;
  readonly fixedPath: string;
  readonly text: string;
}

const HEADER = /^# err: (A0[0-9]{3}) (\d+|-)$/;
const HEADER_LINES = /^# (err|base|fn):/;

export function loadCases(dir: string = CORPUS_DIR): Case[] {
  return readdirSync(dir)
    .filter(
      (f) =>
        (f.endsWith('.a0') && !f.endsWith('.fixed.a0')) ||
        (f.endsWith('.edit') && !f.endsWith('.fixed.edit')),
    )
    .sort()
    .map((f): Case => {
      const kind = f.endsWith('.edit') ? 'edit' : 'a0';
      const name = f.slice(0, f.length - (kind === 'edit' ? 5 : 3));
      return {
        name,
        kind,
        path: join(dir, f),
        fixedPath: join(dir, `${name}.fixed.${kind}`),
        text: readFileSync(join(dir, f), 'utf8'),
      };
    });
}

const ensureNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);
const stripHeader = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !HEADER_LINES.test(l))
    .join('\n');

function openSession(c: Case): EditSession {
  const base = /^# base: (\S+)$/m.exec(c.text)?.[1];
  const fn = /^# fn: (\S+)$/m.exec(c.text)?.[1];
  if (base === undefined || fn === undefined)
    throw new Error(`${c.name}: an .edit case needs # base: and # fn:`);
  const s = new EditSession(
    parseAndValidate(readFileSync(join(dirname(c.path), 'bases', base), 'utf8')),
  );
  s.open(fn, { scope: 'deps' });
  s.openProgram();
  return s;
}

/** The program text a case's text is accepted as (a program, or a reply over the base). */
function accept(c: Case, text: string): string {
  if (c.kind === 'a0') return formatProgram(parseAndValidate(text));
  const s = openSession(c);
  s.apply(text);
  return formatProgram(s.program);
}

/** What a case produced: the diagnostic, and the text its fix gives. */
export interface Outcome {
  readonly id: string | undefined;
  readonly line: number | null;
  readonly applicability: string | undefined;
  /** The text after the fix (every exact fix, or the diagnostic's first edit), header removed. */
  readonly fixed: string | undefined;
  /** `code/rule` of each exact fix applied. */
  readonly exercised: readonly string[];
  readonly problem?: string;
}

export function run(c: Case): Outcome {
  let first: A0Error | undefined;
  try {
    accept(c, c.text);
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    first = e;
  }
  if (first === undefined)
    return {
      id: undefined,
      line: null,
      applicability: undefined,
      fixed: undefined,
      exercised: [],
      problem: 'accepted: a reject case must be rejected',
    };
  const head = {
    id: first.id,
    line: diagnosticLine(c.text, first),
    applicability: first.applicability,
  };
  if (first.applicability === 'exact') {
    const out = fixAll(c.text, (t) => {
      accept(c, t);
    });
    const exercised = out.applied.map((a) => `${a.id}/${a.edit.rule}`);
    if (out.error !== undefined)
      return {
        ...head,
        fixed: undefined,
        exercised,
        problem: `the exact fixes stop at ${out.error.id}: ${out.error.message}`,
      };
    // In an edit session `fix all` must land the same program as the fixed reply.
    if (c.kind === 'edit') {
      const s = openSession(c);
      try {
        s.apply(c.text);
      } catch {
        // the rejection is what `fix all` replays
      }
      s.apply('fix all');
      if (formatProgram(s.program) !== accept(c, out.text))
        return {
          ...head,
          fixed: stripHeader(out.text),
          exercised,
          problem: '`fix all` and the fixed reply disagree',
        };
    }
    return { ...head, fixed: stripHeader(out.text), exercised };
  }
  const edit = first.edits[0];
  const done = edit === undefined ? undefined : applyEdit(c.text, edit);
  return {
    ...head,
    fixed: done === undefined ? undefined : stripHeader(done),
    exercised: [],
  };
}

export interface CaseResult {
  readonly name: string;
  readonly problems: string[];
  readonly outcome: Outcome;
}

/** Check one case against its header and fixed file; with `bless`, rewrite them instead. */
export function check(c: Case, bless: boolean): CaseResult {
  const outcome = run(c);
  const problems: string[] = [];
  if (outcome.problem !== undefined) problems.push(outcome.problem);
  const lineText = outcome.line === null ? '-' : String(outcome.line);
  const first = c.text.split('\n')[0] ?? '';
  if (bless) {
    if (outcome.id !== undefined) {
      const header = `# err: ${outcome.id} ${lineText}`;
      if (first !== header)
        writeFileSync(
          c.path,
          `${header}\n${HEADER.test(first) ? c.text.slice(first.length + 1) : c.text}`,
        );
    }
    if (outcome.fixed !== undefined) writeFileSync(c.fixedPath, ensureNewline(outcome.fixed));
  } else {
    const want = HEADER.exec(first);
    if (want === null) problems.push(`line 1 must be \`# err: A0nnnn LINE\`, got '${first}'`);
    else {
      if (want[1] !== outcome.id) problems.push(`expected ${want[1]}, raised ${outcome.id}`);
      if (want[2] !== lineText)
        problems.push(`expected line ${want[2]}, the diagnostic is at ${lineText}`);
    }
  }
  let fixedFile: string;
  try {
    fixedFile = readFileSync(c.fixedPath, 'utf8');
  } catch {
    problems.push(`missing ${c.fixedPath} (write the fixed text, or run with --bless)`);
    return { name: c.name, problems, outcome };
  }
  try {
    accept(c, fixedFile);
  } catch (e) {
    problems.push(`the fixed text is rejected: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (
    !bless &&
    outcome.fixed !== undefined &&
    ensureNewline(outcome.fixed) !== ensureNewline(fixedFile)
  )
    problems.push(
      `${outcome.applicability === 'exact' ? 'the exact fixes' : 'the suggested edit'} give a different text than ${c.name}.fixed`,
    );
  return { name: c.name, problems, outcome };
}

/** The exact fixes (code/rule) no case exercises. */
export function uncovered(results: readonly CaseResult[]): string[] {
  const seen = new Set(results.flatMap((r) => r.outcome.exercised));
  return EXACT_FIXES.filter((f) => !seen.has(`${f.id}/${f.rule}`)).map(
    (f) => `${f.id}/${f.rule}: ${f.what}`,
  );
}

export function main(argv: readonly string[]): number {
  const bless = argv.includes('--bless');
  const results = loadCases().map((c) => check(c, bless));
  let bad = 0;
  for (const r of results)
    if (r.problems.length > 0) {
      bad += 1;
      process.stdout.write(`FAIL ${r.name}\n${r.problems.map((p) => `  ${p}`).join('\n')}\n`);
    }
  const missing = uncovered(results);
  if (argv.includes('--coverage') || missing.length > 0)
    process.stdout.write(
      missing.length === 0
        ? 'every exact fix is exercised by a case\n'
        : `exact fixes no case exercises:\n${missing.map((m) => `  ${m}`).join('\n')}\n`,
    );
  process.stdout.write(`${results.length} cases, ${bad} failing${bless ? ' (blessed)' : ''}\n`);
  return bad > 0 || missing.length > 0 ? 1 : 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  process.exit(main(process.argv.slice(2)));
}
