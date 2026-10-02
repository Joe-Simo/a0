/**
 * Builds the sealed task set G (tools/ai-edit-tasks-g.ts) from two neutral files written by two
 * authors that never saw the language or the other sets:
 *
 *   tasks    (author 1) per task: instruction, starting program, reference, plausible wrong edits and
 *            the hidden tests, as language-neutral JSON programs (statements `{id, op, args}`);
 *   examples (author 2, who saw only the instruction and the starting program, never the tests,
 *            the reference or the wrong edits) per task: candidate examples of what the function
 *            does that the change leaves alone (`preserved`), candidates of what it does now that
 *            the change alters (`stale`), and candidate `post` properties.
 *
 * This tool only changes the format (JSON program to the language's text) and checks everything
 * with the reference interpreter: the starting program fails a hidden test, the reference passes all
 * of them, every wrong edit fails one; a preserved example is true of both the starting program and
 * the reference and is not a hidden test; a stale example is true of the starting program and false
 * of the reference; a post property holds on the starting program, the reference and every hidden
 * test input. A candidate that fails a check is dropped and listed; nothing is repaired by hand.
 *
 *   node dist/tools/ai-edit-tasks-g-gen.js TASKS.json EXAMPLES.json [--write]   (--write: tools/ai-edit-tasks-g.ts)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { formatType, parseAndValidate, run, type TypedFunc, type Value } from '../src/core.js';

type Arg = string | number | boolean;
interface NStmt {
  id: string;
  op: string;
  args: Arg[];
}
interface NFunc {
  name: string;
  params: string[];
  result: string;
  body: NStmt[];
  ret: Arg;
}
interface NProgram {
  functions: NFunc[];
}
interface NTest {
  fn: string;
  args: Value[];
  expected: Value;
}
interface NTask {
  id: string;
  kind: string;
  wrongEditKind: string;
  target: string;
  instruction: string;
  start: NProgram;
  reference: NProgram;
  wrongEdits: NProgram[];
  tests: NTest[];
  note: string;
}
interface NExamples {
  id: string;
  preserved: { args: Value[]; expected: Value }[];
  stale: { args: Value[]; expected: Value }[];
  post: { op: string; args: Arg[] }[];
}

const arg = (a: Arg): string => String(a);
function a0Text(p: NProgram): string {
  return `${p.functions
    .map((f) => {
      const body = f.body.map((s) => `${s.id} ${s.op} ${s.args.map(arg).join(' ')}`.trimEnd());
      return [
        `fn ${f.name} ${f.params.join(' ')} -> ${f.result}`.replace(
          'fn ' + f.name + '  ->',
          `fn ${f.name} ->`,
        ),
        ...body,
        `ret ${arg(f.ret)}`,
        'end',
      ].join('\n');
    })
    .join('\n')}\n`;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const norm = (v: Value): unknown => (typeof v === 'boolean' ? v : v);

const [tasksPath, examplesPath, ...flags] = process.argv.slice(2);
if (tasksPath === undefined || examplesPath === undefined) throw new Error('usage: TASKS EXAMPLES');
const tasks = (JSON.parse(readFileSync(tasksPath, 'utf8')) as { tasks: NTask[] }).tasks;
// Several example files (comma separated) are concatenated per task, in the order given.
const examples = new Map<string, NExamples>();
for (const path of examplesPath.split(',')) {
  for (const e of (JSON.parse(readFileSync(path, 'utf8')) as { tasks: NExamples[] }).tasks) {
    const old = examples.get(e.id);
    examples.set(
      e.id,
      old === undefined
        ? e
        : {
            id: e.id,
            preserved: [...old.preserved, ...e.preserved],
            stale: [...old.stale, ...e.stale],
            post: [...old.post, ...(e.post ?? [])],
          },
    );
  }
}

const problems: string[] = [];
const out: string[] = [];
for (const t of tasks) {
  const start = a0Text(t.start);
  const reference = a0Text(t.reference);
  const wrongs = t.wrongEdits.map(a0Text);
  const fail = (m: string): void => void problems.push(`${t.id}: ${m}`);
  let ts: ReturnType<typeof parseAndValidate>;
  let tr: ReturnType<typeof parseAndValidate>;
  try {
    ts = parseAndValidate(start);
    tr = parseAndValidate(reference);
    for (const w of wrongs) parseAndValidate(w);
  } catch (e) {
    fail(`program does not validate: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const check = (p: ReturnType<typeof parseAndValidate>, test: NTest): boolean => {
    const f = p.byName.get(test.fn) as TypedFunc | undefined;
    if (f === undefined) return false;
    try {
      return same(norm(run(f, test.args)), norm(test.expected));
    } catch {
      return false;
    }
  };
  const refFails = t.tests.filter((x) => !check(tr, x));
  if (refFails.length > 0)
    fail(
      `reference fails tests ${refFails.map((x) => JSON.stringify([x.fn, x.args, x.expected])).join(' ')}`,
    );
  if (t.tests.every((x) => check(ts, x))) fail('starting program passes every test');
  wrongs.forEach((w, i) => {
    const p = parseAndValidate(w);
    if (t.tests.every((x) => check(p, x))) fail(`wrong edit ${i} passes every test`);
  });
  if (t.tests.length < 8) fail(`only ${t.tests.length} tests`);
  const target = ts.byName.get(t.target) as TypedFunc | undefined;
  const refTarget = tr.byName.get(t.target) as TypedFunc | undefined;
  if (target === undefined || refTarget === undefined) {
    fail(`target ${t.target} missing`);
    continue;
  }
  const ex = examples.get(t.id);
  const dropped: string[] = [];
  const hidden = new Set(
    t.tests.filter((x) => x.fn === t.target).map((x) => JSON.stringify(x.args)),
  );
  const run1 = (f: TypedFunc, args: Value[]): unknown => {
    try {
      return norm(run(f, args));
    } catch {
      return 'TRAP';
    }
  };
  const preserved: { args: Value[]; result: Value }[] = [];
  for (const c of ex?.preserved ?? []) {
    const k = JSON.stringify(c.args);
    if (hidden.has(k)) dropped.push(`preserved ${k}: equals a hidden test`);
    else if (!same(run1(target, c.args), norm(c.expected)))
      dropped.push(`preserved ${k}: false on the start`);
    else if (!same(run1(refTarget, c.args), norm(c.expected)))
      dropped.push(`preserved ${k}: false on the reference`);
    else if (!preserved.some((p) => JSON.stringify(p.args) === k))
      preserved.push({ args: c.args, result: c.expected });
  }
  const stale: { args: Value[]; result: Value }[] = [];
  for (const c of ex?.stale ?? []) {
    const k = JSON.stringify(c.args);
    if (hidden.has(k)) dropped.push(`stale ${k}: equals a hidden test`);
    else if (!same(run1(target, c.args), norm(c.expected)))
      dropped.push(`stale ${k}: false on the start`);
    else if (same(run1(refTarget, c.args), norm(c.expected)))
      dropped.push(`stale ${k}: still true on the reference`);
    else stale.push({ args: c.args, result: c.expected });
  }
  // post: holds on start and reference at every hidden input and every kept example input
  const inputs = [
    ...t.tests.filter((x) => x.fn === t.target).map((x) => x.args),
    ...preserved.map((p) => p.args),
  ];
  const post: string[] = [];
  for (const c of ex?.post ?? []) {
    const text = `${c.op} ${c.args.map(arg).join(' ')}`;
    // evaluate via a one-off function: fn chk <params of target + result> -> bool
    const pt = [...target.params, target.result].map((x) => formatType(x));
    const src = `fn chk ${pt.join(' ')} -> bool\nr ${text.replace(/\br\b/g, `p${target.params.length}`)}\nret r\nend\n`;
    try {
      const chk = parseAndValidate(src).byName.get('chk') as TypedFunc;
      const holds = (f: TypedFunc): boolean =>
        inputs.every((a) => {
          const r = run1(f, a);
          if (r === 'TRAP') return false;
          try {
            return run(chk, [...a, r as Value]) === true;
          } catch {
            return false;
          }
        });
      if (!holds(target)) dropped.push(`post ${text}: false on the start`);
      else if (!holds(refTarget)) dropped.push(`post ${text}: false on the reference`);
      else post.push(text);
    } catch (e) {
      dropped.push(`post ${text}: ${e instanceof Error ? e.message.slice(0, 80) : 'invalid'}`);
    }
  }
  if (preserved.length < 3) fail(`only ${preserved.length} valid preserved examples (need 3)`);
  if (stale.length < 1)
    problems.push(
      `${t.id}: (dropped candidate) no valid stale example: left out of the stale cell`,
    );
  if (post.length < 1) fail('no valid post');
  for (const d of dropped) problems.push(`${t.id}: (dropped candidate) ${d}`);
  out.push(
    `  {\n    id: ${JSON.stringify(t.id)},\n    kind: ${JSON.stringify(t.kind)},\n    target: ${JSON.stringify(t.target)},\n    wrongEditKind: ${JSON.stringify(t.wrongEditKind)},\n    note: ${JSON.stringify(t.note)},\n    instruction: ${JSON.stringify(t.instruction)},\n    a0Source: ${JSON.stringify(start)},\n    tsSource: '',\n    rustSource: '',\n    tests: ${JSON.stringify(t.tests.map((x) => ({ fn: x.fn, args: x.args, expected: x.expected })))},\n    reference: { a0: ${JSON.stringify(reference)}, ts: '', rust: '' },\n    wrongEdits: ${JSON.stringify(wrongs)},\n    specs: {\n      preserved: ${JSON.stringify(preserved)},\n      stale: ${JSON.stringify(stale[0] ?? null)},\n      post: ${JSON.stringify(post[0] ?? null)},\n      candidates: ${JSON.stringify({ preserved: ex?.preserved.length ?? 0, stale: ex?.stale.length ?? 0, post: ex?.post.length ?? 0, droppedCandidates: dropped.length })},\n    },\n  },`,
  );
}

const header = `/**
 * Held-out task set G for the spec-line experiment (results/spec-lines.json): twelve or more
 * tasks in which a plausible wrong edit exists. Generated by tools/ai-edit-tasks-g-gen.ts from two
 * language-neutral files (the tasks and hidden tests by an author who never saw the language or
 * the other sets; the examples and post properties by a second author who never saw the hidden
 * tests, the reference or the wrong edits). SHA-256 sealed in ai-edit-tasks-g.sha256 before any
 * subject ran: never alter this file.
 */

import type { Value } from '../src/core.js';

interface AcceptanceCase {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly expected: Value;
}

interface SpecExample {
  readonly args: readonly Value[];
  readonly result: Value;
}

export interface TaskG {
  readonly id: string;
  readonly kind: 'targeted-edit' | 'multi-node-edit' | 'comprehension-edit' | 'create';
  readonly target: string;
  readonly wrongEditKind: string;
  readonly note: string;
  readonly instruction: string;
  readonly a0Source: string;
  readonly tsSource: string;
  readonly rustSource: string;
  readonly tests: readonly AcceptanceCase[];
  readonly reference: { readonly a0: string; readonly ts: string; readonly rust: string };
  /** Plausible wrong edits (whole programs): each fails a hidden test; used for the catch analysis only. */
  readonly wrongEdits: readonly string[];
  readonly specs: {
    /** True of the starting program and of the reference; not a hidden test. In the author's order. */
    readonly preserved: readonly SpecExample[];
    /** True of the starting program, false of the reference (what the change alters). */
    readonly stale: SpecExample | null;
    /** A bool operation over the parameters and \`r\` that holds on the starting program and the reference. */
    readonly post: string;
    readonly candidates: {
      readonly preserved: number;
      readonly stale: number;
      readonly post: number;
      readonly droppedCandidates: number;
    };
  };
}

export const TASKS_G: readonly TaskG[] = [
`;
if (flags.includes('--write')) {
  if (problems.some((p) => !p.includes('(dropped candidate)')))
    process.stdout.write('NOT WRITTEN: problems remain\n');
  else writeFileSync('tools/ai-edit-tasks-g.ts', `${header}${out.join('\n')}\n];\n`);
}
process.stdout.write(`${problems.join('\n')}\n${tasks.length} tasks, ${out.length} built\n`);
