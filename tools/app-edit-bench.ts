/**
 * Application-scale edit benchmark (docs/history/2026-10-06-app-edit-preregistration.md): a realistic
 * maintenance edit inside an application-sized program, A0 against TypeScript. The application is the
 * A0 front end, lexer and parser: compiler/parse.a0 linked with compiler/lex.a0 (106 functions) on the
 * A0 side, its TypeScript reference tools/ref-parse.ts (refLex, refParse: the same token grammar and the
 * same word IR, test/core.test.ts checks they agree) on the TypeScript side. The 14 sealed tasks are in
 * tools/app-edit-tasks.ts (tools/app-edit-tasks.sha256).
 *
 * A0 side: the shipped MODEL_GUIDE.min.txt plus the structured protocol paragraph of
 * tools/ai-edit-experiment.ts; the view is each target function under an e handle (dependency scope)
 * and the program handle with one signature line per function; the reply is edit lines applied by
 * EditSession (src/edit.ts). TypeScript side: one neutral sentence of the reply format; the view is
 * the whole file; the reply is a unified diff (hunks located by their old text, the @@ line numbers
 * only break ties). A rejected reply (refused edit, or hidden tests failing) is rolled back on both
 * sides and answered with the harness's rejection message; one repair is allowed.
 *
 *   bun tools/app-edit-bench.ts self-check [OUT.json]
 *       reference solutions pass, start programs fail, wrong-but-plausible edits fail (both sides)
 *   bun tools/app-edit-bench.ts dump OUT.json [a0|ts]
 *       the exact prompts (system + request) per task and side: `{ "<task>/<side>/<protocol>": {system, user} }`,
 *       the dump format of tools/ai-edit-subjects.ts
 *   bun tools/app-edit-bench.ts run REPLIES.json OUT.json [a0|ts] [model]
 *       score scripted replies (`{ key: [first, repair?] }`, tools/ai-edit-subjects.ts collect) and write
 *       the report (the trial shape of tools/ai-edit-experiment.ts, through tools/scrub-results.ts)
 *
 * Nothing here calls a model.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import {
  formatDiagnostic,
  formatProgram,
  makeIo,
  parseAndValidate,
  run,
  type TypedFunc,
  type TypedProgram,
} from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { link } from '../src/link.js';
import { extractBlock } from './ai-edit-apply.js';
import { APP_TASKS, type AppTask, type AppTest, START_SHA256 } from './app-edit-tasks.js';
import { refParse as originalRefParse, type WordIr } from './ref-parse.js';
import { writeReport as writeScrubbed } from './scrub-results.js';

async function writeReport(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeScrubbed(path, value);
}

export type Side = 'a0' | 'ts';
export const PROTOCOL: Record<Side, string> = { a0: 'structured', ts: 'diff' };

/**
 * The structured A0 protocol paragraph of tools/ai-edit-experiment.ts (default view), with its last clause
 * (no handle line) replaced by the rule for several e handles, which three tasks of this set open.
 */
export const A0_PROTOCOL =
  'The view starts with edit handles. Reply with only the edit lines the guide describes (instruction lines edit the shown function; `fn` blocks or `-fn name` edit the program), bare: no code fence; when several e handles are shown, a handle line (e0, e1, ...) starts the lines that edit that function.';
/** The TypeScript side's whole primer: one neutral sentence of the reply format. */
export const TS_PROTOCOL =
  'Reply with only a unified diff of front.ts (`--- a/front.ts`, `+++ b/front.ts`, then `@@` hunks whose context and removed lines match the file exactly), bare: no code fence.';
export const TS_FILE = 'front.ts';
/** Where the TypeScript program ends in tools/ref-parse.ts: the lexer and parser, not the suggestions after them. */
const TS_CUT = '// --- Self-hosted spelling suggestions reference';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// --- The two start programs --------------------------------------------------------

export interface Programs {
  readonly a0: string;
  readonly ts: string;
}

export async function startPrograms(): Promise<Programs> {
  const linked = await link('compiler/parse.a0', (p) => readFile(p, 'utf8'));
  const a0 = formatProgram(parseAndValidate(linked.text));
  const full = await readFile('tools/ref-parse.ts', 'utf8');
  const cut = full.indexOf(TS_CUT);
  if (cut < 0) throw new Error('tools/ref-parse.ts: suggestions section not found');
  const ts = `${full.slice(0, cut).trimEnd()}\n`;
  return { a0, ts };
}

/** The start programs must be the ones the task set was sealed on. */
export function checkStart(p: Programs): void {
  const got = { a0: sha(p.a0), ts: sha(p.ts) };
  if (got.a0 !== START_SHA256.a0 || got.ts !== START_SHA256.ts)
    throw new Error(
      `start programs changed since the set was sealed: ${JSON.stringify(got)} against ${JSON.stringify(START_SHA256)}`,
    );
}

// --- Views ----------------------------------------------------------------------

function a0Session(source: string, task: AppTask): { session: EditSession; view: string } {
  const session = new EditSession(parseAndValidate(source));
  const views = task.a0Targets.map((f) => session.open(f, { scope: 'deps' }).text);
  // the sealed arm lists every signature of the program; A0_PROGRAM_VIEW=deps (the deps-view arm,
  // docs/history/2026-10-06-app-edit-deps-preregistration.md) lists only those the first target reaches
  const scope = process.env.A0_PROGRAM_VIEW === 'deps' ? 'deps' : 'all';
  views.push(session.openProgram({ scope, target: task.a0Targets[0] as string }).text);
  return { session, view: views.join('\n') };
}

export function prompt(
  side: Side,
  task: AppTask,
  programs: Programs,
  guide: string,
): { system: string; user: string } {
  if (side === 'a0') {
    const { view } = a0Session(programs.a0, task);
    return {
      system: `${guide.trimEnd()}\n\n${A0_PROTOCOL}`,
      user: `${task.instruction}\n\n${view}`,
    };
  }
  return { system: TS_PROTOCOL, user: `${task.instruction}\n\n${TS_FILE}\n${programs.ts}` };
}

// --- Unified diff ---------------------------------------------------------------

/**
 * Apply a unified diff to `source`. Each hunk's old side (context and `-` lines) must occur in the file
 * after the previous hunk (trailing spaces ignored); among several occurrences the one nearest the
 * hunk's `@@ -N` line is taken. A hunk with no old lines inserts at line N.
 */
export function applyDiff(source: string, reply: string): { source: string; error?: string } {
  const lines = extractBlock(reply).replace(/\r/g, '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const file = source.replace(/\n$/, '').split('\n');
  const hunks: { at: number; old: string[]; neu: string[] }[] = [];
  let cur: { at: number; old: string[]; neu: string[] } | undefined;
  for (const l of lines) {
    if (cur === undefined && /^(---|\+\+\+|diff |index )/.test(l)) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
    if (h !== null) {
      cur = { at: Number(h[1]), old: [], neu: [] };
      hunks.push(cur);
      continue;
    }
    if (/^@@/.test(l)) return { source, error: `bad hunk header: ${l}` };
    if (cur === undefined)
      return { source, error: `text before the first hunk: ${l.slice(0, 80)}` };
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ')) {
      cur.old.push(l.slice(1));
      cur.neu.push(l.slice(1));
    } else if (l.startsWith('-')) cur.old.push(l.slice(1));
    else if (l.startsWith('+')) cur.neu.push(l.slice(1));
    else return { source, error: `bad diff line: ${l.slice(0, 80)}` };
  }
  if (hunks.length === 0) return { source, error: 'no hunk in the reply' };
  const out = [...file];
  let from = 0;
  let shift = 0;
  for (const [n, h] of hunks.entries()) {
    const want = h.old.map((x) => x.trimEnd());
    let pos = -1;
    if (want.length === 0) pos = Math.min(Math.max(h.at - 1 + shift, from), out.length);
    else {
      const hint = h.at - 1 + shift;
      for (let i = from; i + want.length <= out.length; i += 1) {
        let ok = true;
        for (let k = 0; k < want.length && ok; k += 1)
          ok = (out[i + k] as string).trimEnd() === want[k];
        if (ok && (pos < 0 || Math.abs(i - hint) < Math.abs(pos - hint))) pos = i;
      }
    }
    if (pos < 0)
      return {
        source,
        error: `hunk ${n + 1} (@@ -${h.at}): its context and removed lines do not occur in ${TS_FILE} after the previous hunk`,
      };
    out.splice(pos, h.old.length, ...h.neu);
    from = pos + h.neu.length;
    shift += h.neu.length - h.old.length;
  }
  return { source: `${out.join('\n')}\n` };
}

// --- Running the hidden tests -----------------------------------------------------

interface FrontEnd {
  lex(src: string): number[];
  parse(src: string): WordIr;
}

function pack(bytes: readonly number[]): number[][] {
  const words = Array.from(
    { length: Math.ceil(bytes.length / 4) },
    (_, w) =>
      ((bytes[w * 4] ?? 0) |
        ((bytes[w * 4 + 1] ?? 0) << 8) |
        ((bytes[w * 4 + 2] ?? 0) << 16) |
        ((bytes[w * 4 + 3] ?? 0) << 24)) >>>
      0,
  );
  return Array.from({ length: 64 }, (_, p) =>
    Array.from({ length: 512 }, (_, i) => words[p * 512 + i] ?? 0),
  );
}

function decodeIr(w: readonly number[]): WordIr {
  let i = 2;
  const table = (): number[] => {
    const n = w[i] ?? 0;
    i += 1 + n;
    return w.slice(i - n, i);
  };
  const [pool, sym, types, tlist, fns, nodes, args, uses] = [0, 1, 2, 3, 4, 5, 6, 7].map(table);
  return {
    code: w[0] ?? 0,
    tok: w[1] ?? 0,
    pool: pool ?? [],
    sym: sym ?? [],
    types: types ?? [],
    tlist: tlist ?? [],
    fns: fns ?? [],
    nodes: nodes ?? [],
    args: args ?? [],
    uses: uses ?? [],
  };
}

export function a0FrontEnd(program: TypedProgram): FrontEnd {
  const lexsrc = program.byName.get('lexsrc') as TypedFunc | undefined;
  const parseio = program.byName.get('parseio') as TypedFunc | undefined;
  if (lexsrc === undefined || parseio === undefined)
    throw new Error('missing function lexsrc or parseio');
  return {
    lex(src) {
      const bytes = [...Buffer.from(src)];
      const r = run(lexsrc, [pack(bytes), bytes.length]) as [number[][], number];
      return r[0].flat().slice(0, r[1]);
    },
    parse(src) {
      const io = makeIo([Buffer.byteLength(src), ...Buffer.from(src)]);
      run(parseio, [io]);
      return decodeIr(io.output);
    },
  };
}

let tsCompiler: typeof import('typescript') | undefined;

/** Type-check the edited file (strict, the repository's index rules) and load it. */
export async function tsFrontEnd(source: string): Promise<FrontEnd | string> {
  tsCompiler ??= (await import('typescript')).default;
  const ts = tsCompiler;
  const dir = await mkdtemp(join(tmpdir(), 'a0-app-edit-'));
  try {
    const file = join(dir, TS_FILE);
    await writeFile(file, source, 'utf8');
    const req = createRequire(import.meta.url);
    const typeRoot = dirname(dirname(req.resolve('@types/node/package.json')));
    const options = {
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2023.d.ts'],
      types: ['node'],
      typeRoots: [typeRoot],
      noEmit: true,
      skipLibCheck: true,
    };
    const program = ts.createProgram([file], options);
    const diags = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === program.getSourceFile(file)?.fileName);
    if (diags.length > 0)
      return `tsc: ${diags
        .slice(0, 3)
        .map((d) => {
          const pos =
            d.file !== undefined && d.start !== undefined
              ? `${TS_FILE}(${d.file.getLineAndCharacterOfPosition(d.start).line + 1}): `
              : '';
          return pos + ts.flattenDiagnosticMessageText(d.messageText, ' ');
        })
        .join('\n')}`;
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    const out = join(dir, 'front.mjs');
    await writeFile(out, js, 'utf8');
    const mod = (await import(pathToFileURL(out).href)) as Record<string, unknown>;
    const lex = mod.refLex;
    const parse = mod.refParse;
    if (typeof lex !== 'function' || typeof parse !== 'function')
      return 'missing export refLex or refParse';
    return { lex: lex as FrontEnd['lex'], parse: parse as FrontEnd['parse'] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};
const label = (src: string): string =>
  JSON.stringify(src.length > 60 ? `${src.slice(0, 57)}...` : src);

/** The failing hidden tests (empty: accepted). Messages name the input, the expected and the actual value. */
export function runTests(fe: FrontEnd, tests: readonly AppTest[]): string[] {
  const failures: string[] = [];
  for (const t of tests) {
    try {
      if (t.kind === 'lex') {
        const got = fe.lex(t.src);
        if (JSON.stringify(got) !== JSON.stringify(t.expect))
          failures.push(`tokens of ${label(t.src)}: expected ${show(t.expect)}, got ${show(got)}`);
        continue;
      }
      const got = fe.parse(t.src);
      const want: Partial<WordIr> = t.kind === 'same' ? originalRefParse(t.src) : t.expect;
      for (const [k, v] of Object.entries(want)) {
        const g = got[k as keyof WordIr];
        if (JSON.stringify(g) !== JSON.stringify(v))
          failures.push(`parse of ${label(t.src)}: ${k} expected ${show(v)}, got ${show(g)}`);
      }
    } catch (e) {
      failures.push(
        `${t.kind} of ${label(t.src)}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      );
    }
  }
  return failures;
}

// --- One reply, one trial -----------------------------------------------------------

export interface Applied {
  readonly error?: string;
  readonly failures: string[];
}

/** Apply one reply to the start program of `side` and run the hidden tests. */
export async function judge(
  side: Side,
  task: AppTask,
  programs: Programs,
  reply: string,
): Promise<Applied> {
  if (side === 'a0') {
    const { session } = a0Session(programs.a0, task);
    let next: TypedProgram;
    try {
      next = session.apply(extractBlock(reply));
    } catch (e) {
      const error = formatDiagnostic(e, false);
      return { error, failures: [error] };
    }
    return { failures: runTests(a0FrontEnd(next), task.tests) };
  }
  const d = applyDiff(programs.ts, reply);
  if (d.error !== undefined) return { error: d.error, failures: [d.error] };
  const fe = await tsFrontEnd(d.source);
  if (typeof fe === 'string') return { error: fe, failures: [fe] };
  return { failures: runTests(fe, task.tests) };
}

export function rejection(side: Side, failures: readonly string[]): string {
  const shown = failures.slice(0, 6);
  const more = failures.length > shown.length ? `\n(${failures.length - shown.length} more)` : '';
  const what =
    side === 'a0'
      ? 'Nothing was applied: edit the views as first shown.'
      : `Nothing was applied: diff against ${TS_FILE} as first shown.`;
  return `Rejected:\n${shown.join('\n')}${more}\n${what}\nTry again.`;
}

// --- Commands -----------------------------------------------------------------------

const enc = getEncoding('o200k_base');
const tok = (s: string): number => enc.encode(s).length;

export function taskSetSha256(text: string): string {
  return sha(text);
}

async function sealed(): Promise<string> {
  const text = await readFile('tools/app-edit-tasks.ts', 'utf8');
  const want = (await readFile('tools/app-edit-tasks.sha256', 'utf8')).split(/\s+/)[0];
  const got = sha(text);
  if (got !== want) throw new Error(`tools/app-edit-tasks.ts does not match its seal (${got})`);
  return got;
}

export async function selfCheck(): Promise<{ ok: boolean; rows: Record<string, unknown>[] }> {
  const programs = await startPrograms();
  checkStart(programs);
  const rows: Record<string, unknown>[] = [];
  let ok = APP_TASKS.length === 14 && new Set(APP_TASKS.map((t) => t.id)).size === 14;
  const tsStart = await tsFrontEnd(programs.ts);
  if (typeof tsStart === 'string') throw new Error(`the TypeScript start program: ${tsStart}`);
  const start: Record<Side, FrontEnd> = {
    a0: a0FrontEnd(parseAndValidate(programs.a0)),
    ts: tsStart,
  };
  for (const task of APP_TASKS) {
    for (const side of ['a0', 'ts'] as const) {
      const ref = await judge(side, task, programs, task.reference[side]);
      const startFails = runTests(start[side], task.tests);
      const wrong = await judge(side, task, programs, task.wrong[side]);
      const row = {
        task: task.id,
        side,
        referencePasses: ref.failures.length === 0,
        startFails: startFails.length > 0,
        wrongFails: wrong.failures.length > 0,
        wrongApplies: wrong.error === undefined,
        referenceFailures: ref.failures.slice(0, 3),
        wrongFirstFailure: wrong.failures[0] ?? null,
      };
      if (!(row.referencePasses && row.startFails && row.wrongFails && row.wrongApplies))
        ok = false;
      rows.push(row);
    }
  }
  return { ok, rows };
}

/** `a0` or `ts` selects one side; anything else (`both`, empty) runs both. */
const sideArg = (s: string | undefined): Side | undefined =>
  s === 'a0' || s === 'ts' ? s : undefined;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const guide = await readFile('MODEL_GUIDE.min.txt', 'utf8');
  if (cmd === 'self-check') {
    const r = await selfCheck();
    for (const row of r.rows)
      console.log(
        `${String(row.task).padEnd(22)} ${String(row.side).padEnd(3)} ref ${row.referencePasses ? 'pass' : 'FAIL'}  start ${row.startFails ? 'fails' : 'PASSES'}  wrong ${row.wrongFails ? 'fails' : 'PASSES'}${row.wrongApplies ? '' : ' (NOT APPLIED)'}${row.referencePasses ? '' : `  ${JSON.stringify(row.referenceFailures)}`}`,
      );
    console.log(`self-check ${r.ok ? 'ok' : 'FAILED'}`);
    if (args[0] !== undefined)
      await writeReport(args[0], {
        generatedAt: new Date().toISOString(),
        tool: 'tools/app-edit-bench.ts self-check',
        taskSetSha256: await sealed(),
        ...r,
      });
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'dump') {
    const out = args[0] as string;
    const only = sideArg(args[1]);
    await sealed();
    const programs = await startPrograms();
    checkStart(programs);
    const dump: Record<string, { system: string; user: string }> = {};
    for (const task of APP_TASKS)
      for (const side of ['a0', 'ts'] as const)
        if (only === undefined || only === side)
          dump[`${task.id}/${side}/${PROTOCOL[side]}`] = prompt(side, task, programs, guide);
    await writeFile(out, JSON.stringify(dump, null, 1));
    console.log(`${Object.keys(dump).length} prompts`);
    return;
  }
  if (cmd === 'run') {
    const [repliesPath, out, sideText, model] = args as [
      string,
      string,
      string | undefined,
      string | undefined,
    ];
    const only = sideArg(sideText);
    const taskSha = await sealed();
    const programs = await startPrograms();
    checkStart(programs);
    const check = await selfCheck();
    const replies = JSON.parse(await readFile(repliesPath, 'utf8')) as Record<string, string[]>;
    const trials: Record<string, unknown>[] = [];
    for (const task of APP_TASKS)
      for (const side of ['a0', 'ts'] as const) {
        if (only !== undefined && only !== side) continue;
        const key = `${task.id}/${side}/${PROTOCOL[side]}`;
        const p = prompt(side, task, programs, guide);
        const rs = replies[key] ?? [];
        const attempts: Record<string, unknown>[] = [];
        let toolContext = tok(p.user);
        let output = 0;
        let accepted: boolean | null = null;
        let acceptedOneShot: boolean | null = null;
        let failures: string[] = rs.length === 0 ? ['no reply'] : [];
        for (const [n, reply] of rs.slice(0, 2).entries()) {
          output += tok(reply);
          const r = await judge(side, task, programs, reply);
          failures = r.failures;
          const ok = r.failures.length === 0;
          if (n === 0) acceptedOneShot = ok;
          accepted = ok;
          const a: Record<string, unknown> = {
            status: ok ? 'accepted' : r.error !== undefined ? 'refused' : 'tests',
            failures: r.failures,
            outputTokensLocal: { o200k_base: tok(reply) },
          };
          if (!ok) {
            a.repair = rejection(side, r.failures);
            if (n === 0 && rs.length > 1) toolContext += tok(a.repair as string);
          }
          attempts.push(a);
          if (ok) break;
        }
        const calls = attempts.length;
        const system = tok(p.system);
        trials.push({
          task: task.id,
          representation: side,
          protocol: PROTOCOL[side],
          modelCalls: calls,
          acceptedOneShot,
          accepted,
          failures,
          attempts,
          setupTokensLocal: { o200k_base: system },
          tokenBucketsLocal: {
            languagePrimer: side === 'a0' ? tok(guide.trimEnd()) * calls : 0,
            workflowPrimer: tok(side === 'a0' ? A0_PROTOCOL : TS_PROTOCOL) * calls,
            toolContext,
            output,
          },
        });
      }
    await writeReport(out, {
      generatedAt: new Date().toISOString(),
      tool: 'tools/app-edit-bench.ts run',
      preRegistration: 'docs/history/2026-10-06-app-edit-preregistration.md',
      model: model ?? null,
      side: only ?? 'both',
      taskSetSha256: taskSha,
      startSha256: START_SHA256,
      harnessSelfCheck: { ok: check.ok },
      trials,
    });
    console.log(
      JSON.stringify({
        trials: trials.length,
        oneShot: trials.filter((t) => t.acceptedOneShot === true).length,
        accepted: trials.filter((t) => t.accepted === true).length,
      }),
    );
    return;
  }
  console.error(
    'usage: bun tools/app-edit-bench.ts self-check [OUT] | dump OUT [a0|ts] | run REPLIES OUT [a0|ts] [model]',
  );
  process.exitCode = 2;
}

if (/app-edit-bench.[jt]s$/.test(process.argv[1] ?? '')) await main();
