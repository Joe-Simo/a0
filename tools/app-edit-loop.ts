/**
 * Tool-loop arm of the application-scale edit benchmark
 * (docs/history/2026-10-06-app-edit-loop-preregistration.md). The tasks, start programs, hidden tests
 * and primers are those of the one-shot arm (tools/app-edit-tasks.ts, sealed; tools/app-edit-bench.ts);
 * what changes is the protocol: a fresh subagent gets only a scratch working directory and a small
 * `tool` script, works with the tool for at most BUDGET runs, and says done. The harness then scores the
 * final state of the working directory with the hidden tests, which the tool never shows.
 *
 *   bun tools/app-edit-loop.ts setup OUTDIR [a0|ts]
 *       one scratch directory per task and side: OUTDIR/<side>/<task>/ with TASK.md, GUIDE.md, the
 *       start program (front.a0 or front.ts), the `tool` script and its log (.loop/); the exact
 *       subagent prompt per task in OUTDIR/<side>/prompts/<task>.txt
 *   bun tools/app-edit-loop.ts exec DIR COMMAND [ARGS...]
 *       what `tool` runs (one tool run: counted, logged, refused beyond the budget)
 *   bun tools/app-edit-loop.ts score OUTDIR [a0|ts] [model]
 *       score the final states with the hidden tests and write
 *       results/app-edit-loop/report.<model>.<side>.json (through tools/scrub-results.ts)
 *   bun tools/app-edit-loop.ts self-check [OUT.json]
 *       through the tool interface, per task and side: the start state fails, the reference edit
 *       applied with `tool apply` passes, the wrong edit applies and fails; the budget is enforced
 *
 * Wording arm (docs/history/2026-10-06-app-edit-wording-preregistration.md), A0 side only:
 *   bun tools/app-edit-loop.ts setup OUTDIR a0 --arm wording --variant current|revised
 *       as above, but TASK.md holds only the instruction (no view, no handle open), SKILL.md holds the
 *       variant's skill text (experiments/wording/<variant>/SKILL.md) and `./tool help` carries the
 *       variant's descriptions of view and program (experiments/wording/<variant>/tools.json)
 *   bun tools/app-edit-loop.ts score OUTDIR a0 MODEL --arm wording --variant current|revised
 *       writes results/app-edit-wording/report.<model>.<variant>.json
 *
 * Run from the repository root. Nothing here calls a model, uses the network or needs a key.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { getEncoding } from 'js-tiktoken';
import {
  A0Error,
  checkArgument,
  formatProgram,
  formatType,
  LIMITS,
  parseAndValidate,
  run,
  type TypedProgram,
  type Value,
} from '../src/core.js';
import { EditSession, revision } from '../src/edit.js';
import { explain } from '../src/explain.js';
import {
  A0_PROTOCOL,
  a0FrontEnd,
  applyDiff,
  checkStart,
  type Programs,
  prompt,
  runTests,
  type Side,
  startPrograms,
  TS_FILE,
  TS_PROTOCOL,
  taskSetSha256,
  tsFrontEnd,
} from './app-edit-bench.js';
import { APP_TASKS, type AppTask, START_SHA256 } from './app-edit-tasks.js';
import { writeReport as writeScrubbed } from './scrub-results.js';

/** Tool runs per subject (justified in the pre-registration). */
export const BUDGET = 12;
export const A0_FILE = 'front.a0';
const fileOf = (side: Side): string => (side === 'a0' ? A0_FILE : TS_FILE);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const enc = getEncoding('o200k_base');
export const tok = (s: string): number => enc.encode(s).length;

/**
 * The exact subagent prompt (the same on both sides). `<dir>` is replaced by the working directory;
 * the token count uses the text with the placeholder, so path lengths do not enter the measure.
 */
export const SUBAGENT_PROMPT = `You are making one change to a program. Your working directory is <dir>. First read <dir>/TASK.md and <dir>/GUIDE.md with the Read tool; together they are everything you need. Then make the change using only the tool in that directory, run with the Bash tool as: cd "<dir>" && ./tool COMMAND ARGS (./tool help lists the commands; text for apply goes on standard input, for example with a quoted heredoc). You have at most ${BUDGET} tool runs; the tool counts them and refuses more. Do not read, write or list any other file or directory, do not edit any file directly, and use no other tool. When the change is complete, or you cannot do better, reply with the single word done.`;

/** The help text of the tool, per side: it opens TASK.md and is printed by `./tool help`. */
export function toolHelp(side: Side): string {
  if (side === 'a0')
    return `The program is ${A0_FILE} (the A0 lexer and parser, linked into one program). Change it only through ./tool (at most ${BUDGET} runs, each one counted):
./tool view FUNCTION        open a function: a handle line (e0, e1, ...), the function, its callees' signatures
./tool program [TARGET]     open a program handle (g0, g1, ...): every signature, or those around TARGET
./tool apply < EDIT         apply edit lines (first line: an open handle) as GUIDE.md describes; prints the new view,
                            or a JSON diagnostic (id, message, expected/actual, fix, applicability); a rejected edit
                            changes nothing, and the edit \`fix all\` then applies every exact fix of it
./tool check                validate the program: one line per function with its revision
./tool revision FUNCTION    the revision of a function
./tool explain A0nnnn       explain a diagnostic id
./tool run FUNCTION ARGS    run a function on JSON arguments (u32 numbers, booleans, arrays) in the interpreter
./tool lex '"TEXT"'         run the lexer (lexsrc) on TEXT, a JSON string: [kind, start, length] per token
./tool parse '"TEXT"'       run the parser (parseio) on TEXT, a JSON string: the word IR as JSON
./tool help                 this text
Handles opened at the start (shown below): <HANDLES>.`;
  return `The program is ${TS_FILE} (the lexer and parser). Change it only through ./tool (at most ${BUDGET} runs, each one counted):
./tool show [FROM [TO]]     print lines FROM..TO of ${TS_FILE} with line numbers (default: the whole file)
./tool apply < DIFF         apply a unified diff of ${TS_FILE} as GUIDE.md describes (hunks found by their old text);
                            prints what was applied, or why nothing was applied
./tool check                type-check ${TS_FILE} (tsc, strict): the diagnostics, or ok
./tool lex '"TEXT"'         run refLex on TEXT, a JSON string: [kind, start, length] per token
./tool parse '"TEXT"'       run refParse on TEXT, a JSON string: the word IR as JSON
./tool help                 this text
The whole file at the start is shown below.`;
}

// --- Wording arm ------------------------------------------------------------------

export const VARIANTS = ['current', 'revised'] as const;
export type Variant = (typeof VARIANTS)[number];
/** The variant files, read from the repository root (setup and score run there). */
const WORDING_DIR = join('experiments', 'wording');

/** The variant texts: the skill file and the one-line descriptions of a0_open and a0_program. */
export function wordingTexts(variant: Variant): { skill: string; open: string; program: string } {
  const dir = join(WORDING_DIR, variant);
  const tools = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8')) as Record<string, string>;
  const open = tools.a0_open;
  const program = tools.a0_program;
  if (open === undefined || program === undefined)
    throw new Error(`${dir}/tools.json is incomplete`);
  return { skill: readFileSync(join(dir, 'SKILL.md'), 'utf8'), open, program };
}

/** The wording arm's subagent prompt: the loop arm's, with SKILL.md read alongside. */
export const WORDING_PROMPT = SUBAGENT_PROMPT.replace(
  'First read <dir>/TASK.md and <dir>/GUIDE.md with the Read tool',
  'First read <dir>/TASK.md, <dir>/SKILL.md and <dir>/GUIDE.md with the Read tool',
);

/** `./tool help` in the wording arm: the loop arm's commands, view and program described by the variant. */
export function wordingHelp(w: { readonly open: string; readonly program: string }): string {
  return `The program is ${A0_FILE} (the A0 lexer and parser, linked into one program). Change it only through ./tool (at most ${BUDGET} runs, each one counted). view is the MCP tool a0_open (scope deps) and program is a0_program:
./tool view FUNCTION        a0_open: ${w.open}
./tool program [TARGET]     a0_program: ${w.program}
./tool apply < EDIT         apply edit lines (first line: an open handle) as GUIDE.md describes; prints the new view,
                            or a JSON diagnostic (id, message, expected/actual, fix, applicability); a rejected edit
                            changes nothing, and the edit \`fix all\` then applies every exact fix of it
./tool check                validate the program: one line per function with its revision
./tool revision FUNCTION    the revision of a function
./tool explain A0nnnn       explain a diagnostic id
./tool run FUNCTION ARGS    run a function on JSON arguments (u32 numbers, booleans, arrays) in the interpreter
./tool lex '"TEXT"'         run the lexer (lexsrc) on TEXT, a JSON string: [kind, start, length] per token
./tool parse '"TEXT"'       run the parser (parseio) on TEXT, a JSON string: the word IR as JSON
./tool help                 this text
No handle is open at the start.`;
}

/** TASK.md of the wording arm: the instruction and the name of the function to start from, no view. */
export const wordingTaskText = (task: AppTask): string =>
  `# Task\n\n${task.instruction}\n\nThe function to change is \`${task.a0Targets[0]}\`.\n`;

/** The program views a subject asked for, from its log: `bare` (every signature) or the target. */
export function programViews(log: readonly LogEntry[]): string[] {
  return log.filter((e) => !e.refused && e.argv[0] === 'program').map((e) => e.argv[1] ?? 'bare');
}

// --- State and log ------------------------------------------------------------------

type Open =
  | { readonly kind: 'fn'; readonly name: string }
  | { readonly kind: 'prog'; readonly target?: string };

export interface LoopState {
  readonly side: Side;
  readonly task: string;
  readonly budget: number;
  /** Set only in the wording arm. */
  readonly variant?: Variant;
  /** Wording arm: the variant's descriptions of view and program, for `./tool help`. */
  readonly wording?: { readonly open: string; readonly program: string };
  calls: number;
  refused: number;
  /** A0: the views opened in this session, in order (replayed to rebuild the edit session). */
  opens: Open[];
  /** A0: the last rejected edit, for `fix all`. */
  rejected?: string | undefined;
  /** SHA-256 of the program as the tool last wrote it. */
  sha: string;
}

export interface LogEntry {
  readonly n: number;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly output: string;
  readonly exitCode: number;
  readonly refused: boolean;
  readonly sha: string;
}

const statePath = (dir: string): string => join(dir, '.loop', 'state.json');
const logPath = (dir: string): string => join(dir, '.loop', 'log.jsonl');

async function readState(dir: string): Promise<LoopState> {
  return JSON.parse(await readFile(statePath(dir), 'utf8')) as LoopState;
}

export async function readLog(dir: string): Promise<LogEntry[]> {
  const text = await readFile(logPath(dir), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LogEntry);
}

const taskById = (id: string): AppTask => {
  const t = APP_TASKS.find((x) => x.id === id);
  if (t === undefined) throw new Error(`unknown task ${id}`);
  return t;
};

// --- Setup --------------------------------------------------------------------------

/** The A0 session as the subject's tool sees it: every view opened so far, replayed in order. */
function a0Session(source: string, opens: readonly Open[]): EditSession {
  const session = new EditSession(parseAndValidate(source));
  for (const o of opens) {
    try {
      if (o.kind === 'fn') session.open(o.name, { scope: 'deps' });
      else
        session.openProgram(
          o.target === undefined ? { scope: 'all' } : { scope: 'deps', target: o.target },
        );
    } catch {
      // a function removed by a later edit: its handle is gone, as in a live session
    }
  }
  return session;
}

const initialOpens = (task: AppTask): Open[] => [
  ...task.a0Targets.map((name) => ({ kind: 'fn' as const, name })),
  { kind: 'prog' as const, target: task.a0Targets[0] as string },
];

function handlesText(task: AppTask): string {
  const fns = task.a0Targets.map((f, i) => `e${i} ${f}`);
  return [...fns, 'g0 the program'].join(', ');
}

/** TASK.md: the tool help, then the one-shot arm's request (the instruction and the view or file). */
export function taskText(side: Side, task: AppTask, programs: Programs, guide: string): string {
  const user = prompt(side, task, programs, guide).user;
  const help = toolHelp(side).replace('<HANDLES>', handlesText(task));
  return `# Task\n\n${help}\n\n${user}`;
}

/** GUIDE.md: exactly the one-shot arm's system text of that side. */
export const guideText = (side: Side, task: AppTask, programs: Programs, guide: string): string =>
  prompt(side, task, programs, guide).system;

function toolScript(): string {
  const self = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  const runner = process.execPath.replace(/\\/g, '/');
  return `#!/bin/sh\n# One counted tool run of the app-edit tool-loop arm.\ndir=$(cd "$(dirname "$0")" && pwd)\nexec "${runner}" "${self}" exec "$dir" "$@"\n`;
}

export async function setupTask(
  dir: string,
  side: Side,
  task: AppTask,
  programs: Programs,
  guide: string,
): Promise<void> {
  await mkdir(join(dir, '.loop'), { recursive: true });
  const program = programs[side];
  await writeFile(join(dir, fileOf(side)), program, 'utf8');
  await writeFile(join(dir, 'TASK.md'), taskText(side, task, programs, guide), 'utf8');
  await writeFile(join(dir, 'GUIDE.md'), guideText(side, task, programs, guide), 'utf8');
  await writeFile(join(dir, 'tool'), toolScript(), 'utf8');
  await chmod(join(dir, 'tool'), 0o755).catch(() => undefined);
  const state: LoopState = {
    side,
    task: task.id,
    budget: BUDGET,
    calls: 0,
    refused: 0,
    opens: side === 'a0' ? initialOpens(task) : [],
    sha: sha(program),
  };
  await writeFile(statePath(dir), JSON.stringify(state, null, 1), 'utf8');
  await writeFile(logPath(dir), '', 'utf8');
}

export async function setupWordingTask(
  dir: string,
  task: AppTask,
  programs: Programs,
  guide: string,
  variant: Variant,
): Promise<void> {
  await mkdir(join(dir, '.loop'), { recursive: true });
  await writeFile(join(dir, A0_FILE), programs.a0, 'utf8');
  await writeFile(join(dir, 'TASK.md'), wordingTaskText(task), 'utf8');
  await writeFile(join(dir, 'GUIDE.md'), guideText('a0', task, programs, guide), 'utf8');
  await writeFile(join(dir, 'SKILL.md'), wordingTexts(variant).skill, 'utf8');
  await writeFile(join(dir, 'tool'), toolScript(), 'utf8');
  await chmod(join(dir, 'tool'), 0o755).catch(() => undefined);
  const state: LoopState = {
    side: 'a0',
    task: task.id,
    budget: BUDGET,
    variant,
    wording: { open: wordingTexts(variant).open, program: wordingTexts(variant).program },
    calls: 0,
    refused: 0,
    opens: [],
    sha: sha(programs.a0),
  };
  await writeFile(statePath(dir), JSON.stringify(state, null, 1), 'utf8');
  await writeFile(logPath(dir), '', 'utf8');
}

// --- The tool -----------------------------------------------------------------------

const parseText = (arg: string | undefined): string => {
  if (arg === undefined) throw new Error('missing TEXT (a JSON string, for example \'"a b\\n"\')');
  let v: unknown;
  try {
    v = JSON.parse(arg);
  } catch {
    throw new Error(`TEXT must be a JSON string such as '"a b\\n"', got ${arg.slice(0, 60)}`);
  }
  if (typeof v !== 'string') throw new Error('TEXT must be a JSON string');
  return v;
};

const triples = (flat: readonly number[]): string =>
  JSON.stringify(
    Array.from({ length: Math.floor(flat.length / 3) }, (_, i) => flat.slice(i * 3, i * 3 + 3)),
  );

/** A diagnostic as the MCP server returns it (src/mcp.ts `failure`): the JSON form of an A0 error. */
const a0Failure = (e: unknown): string =>
  e instanceof A0Error
    ? JSON.stringify(e.toJSON())
    : `error: ${e instanceof Error ? e.message : String(e)}`;

let tsCompiler: typeof import('typescript') | undefined;

/** tsc diagnostics of the file (the options of tools/app-edit-bench.ts tsFrontEnd), at most 20. */
export async function tsCheck(source: string): Promise<string[]> {
  tsCompiler ??= (await import('typescript')).default;
  const ts = tsCompiler;
  const dir = await mkdtemp(join(tmpdir(), 'a0-app-loop-'));
  try {
    const file = join(dir, TS_FILE);
    await writeFile(file, source, 'utf8');
    const req = createRequire(import.meta.url);
    const typeRoot = dirname(dirname(req.resolve('@types/node/package.json')));
    const program = ts.createProgram([file], {
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
    });
    const sf = program.getSourceFile(file);
    return ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === sf?.fileName)
      .slice(0, 20)
      .map((d) => {
        const at =
          d.file !== undefined && d.start !== undefined
            ? (() => {
                const p = d.file.getLineAndCharacterOfPosition(d.start);
                return `${TS_FILE}(${p.line + 1},${p.character + 1}): `;
              })()
            : '';
        return `${at}error TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
      });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run refLex or refParse of the (possibly ill-typed) file, as `tsx front.ts` would, bounded in time. */
async function tsRun(source: string, fn: 'refLex' | 'refParse', text: string): Promise<string> {
  tsCompiler ??= (await import('typescript')).default;
  const ts = tsCompiler;
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const ctx: Record<string, unknown> = {
    exports: {},
    module: { exports: {} },
    Buffer,
    TextEncoder,
    TextDecoder,
    __src: text,
  };
  runInNewContext(`${js}\n;globalThis.__out = JSON.stringify(${fn}(__src));`, ctx, {
    timeout: 10000,
  });
  const out = JSON.parse(ctx.__out as string) as unknown;
  return fn === 'refLex' ? triples(out as number[]) : JSON.stringify(out);
}

/** One tool run: returns the output and the exit code, and the new program text when it changed. */
async function a0Command(
  state: LoopState,
  source: string,
  argv: readonly string[],
  stdin: string,
  task: AppTask,
): Promise<{ output: string; code: number; source?: string }> {
  const [cmd, ...args] = argv;
  const session = a0Session(source, state.opens);
  if (state.rejected !== undefined) {
    try {
      session.apply(state.rejected);
    } catch {
      // replayed only to restore the session's last rejection for `fix all`
    }
  }
  const fnNamed = (name: string | undefined) => {
    if (name === undefined) throw new Error('missing FUNCTION');
    const fn = session.program.byName.get(name);
    if (fn === undefined) throw new Error(`no function ${name}`);
    return fn;
  };
  switch (cmd) {
    case 'help':
      return {
        output:
          state.variant === undefined
            ? toolHelp('a0').replace('<HANDLES>', handlesText(task))
            : wordingHelp(state.wording ?? wordingTexts(state.variant)),
        code: 0,
      };
    case 'view': {
      const name = args[0];
      if (name === undefined) throw new Error('usage: ./tool view FUNCTION');
      const v = session.open(name, { scope: 'deps' });
      state.opens.push({ kind: 'fn', name });
      return { output: v.text, code: 0 };
    }
    case 'program': {
      const target = args[0];
      const v = session.openProgram(
        target === undefined ? { scope: 'all' } : { scope: 'deps', target },
      );
      state.opens.push(target === undefined ? { kind: 'prog' } : { kind: 'prog', target });
      return { output: v.text, code: 0 };
    }
    case 'apply': {
      if (stdin.trim() === '') throw new Error('apply reads the edit from standard input');
      let next: TypedProgram;
      try {
        next = session.apply(stdin);
      } catch (e) {
        if (e instanceof A0Error && stdin.trim() !== 'fix all') state.rejected = stdin;
        return { output: a0Failure(e), code: 1 };
      }
      state.rejected = undefined;
      // The reply of src/mcp.ts a0_apply is the view under the edit's first line, else the whole
      // program. Here an edit with its handle line left out (the guide allows it when one e handle
      // is open) gets the view of that implied handle, not the whole program (the whole program):
      // the documented deviation of the pre-registration.
      const first = stdin
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      const live = (prefix: string): string[] =>
        Array.from({ length: state.opens.length }, (_, i) => `${prefix}${i}`).filter((h) => {
          try {
            session.view(h);
            return true;
          } catch {
            return false;
          }
        });
      const fns = live('e');
      const progs = live('g');
      const implied =
        fns.length === 1 ? fns[0] : fns.length === 0 && progs.length === 1 ? progs[0] : undefined;
      let view: string;
      try {
        view = session.view(first ?? '');
      } catch {
        view = implied === undefined ? formatProgram(next) : session.view(implied);
      }
      return { output: view, code: 0, source: formatProgram(next) };
    }
    case 'check':
      return {
        output: session.program.functions
          .map(
            (fn) =>
              `${fn.name} (${fn.params.map(formatType).join(', ')}) -> ${formatType(fn.result)}: ${fn.nodes.length} nodes, rev ${revision(fn).slice(0, 12)}`,
          )
          .join('\n'),
        code: 0,
      };
    case 'revision':
      return { output: revision(fnNamed(args[0])), code: 0 };
    case 'explain': {
      const text = args[0] === undefined ? undefined : explain(args[0]);
      if (text === undefined) throw new Error(`no explanation for ${args[0] ?? '(none)'}`);
      return { output: text.trimEnd(), code: 0 };
    }
    case 'run': {
      const fn = fnNamed(args[0]);
      const values = JSON.parse(args[1] ?? '[]') as Value[];
      if (!Array.isArray(values)) throw new Error('ARGS must be a JSON array');
      for (const [i, t] of fn.params.entries()) checkArgument(t, values[i] as Value, `p${i}`);
      return { output: JSON.stringify(run(fn, values, { fuel: LIMITS.defaultFuel })), code: 0 };
    }
    case 'lex':
      return { output: triples(a0FrontEnd(session.program).lex(parseText(args[0]))), code: 0 };
    case 'parse':
      return {
        output: JSON.stringify(a0FrontEnd(session.program).parse(parseText(args[0]))),
        code: 0,
      };
    default:
      throw new Error(`unknown command ${cmd ?? '(none)'}; ./tool help lists the commands`);
  }
}

async function tsCommand(
  source: string,
  argv: readonly string[],
  stdin: string,
): Promise<{ output: string; code: number; source?: string }> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'help':
      return { output: toolHelp('ts'), code: 0 };
    case 'show': {
      const lines = source.replace(/\n$/, '').split('\n');
      const from = Math.max(1, Number(args[0] ?? 1) || 1);
      const to = Math.min(lines.length, Number(args[1] ?? lines.length) || lines.length);
      const out: string[] = [];
      for (let i = from; i <= to; i += 1) out.push(`${i}\t${lines[i - 1]}`);
      return { output: out.join('\n'), code: 0 };
    }
    case 'apply': {
      if (stdin.trim() === '') throw new Error('apply reads the diff from standard input');
      const d = applyDiff(source, stdin);
      if (d.error !== undefined) return { output: `Nothing was applied: ${d.error}`, code: 1 };
      const hunks = stdin.split('\n').filter((l) => l.startsWith('@@')).length;
      return { output: `applied ${hunks} hunk(s) to ${TS_FILE}`, code: 0, source: d.source };
    }
    case 'check': {
      const diags = await tsCheck(source);
      return {
        output: diags.length === 0 ? 'ok' : diags.join('\n'),
        code: diags.length === 0 ? 0 : 1,
      };
    }
    case 'lex':
      return { output: await tsRun(source, 'refLex', parseText(args[0])), code: 0 };
    case 'parse':
      return { output: await tsRun(source, 'refParse', parseText(args[0])), code: 0 };
    default:
      throw new Error(`unknown command ${cmd ?? '(none)'}; ./tool help lists the commands`);
  }
}

const MAX_TOOL_OUTPUT = 1 << 20;

/** One tool run in DIR: counted, logged, refused beyond the budget. */
export async function execTool(
  dir: string,
  argv: readonly string[],
  stdin: string,
): Promise<{ output: string; code: number }> {
  const state = await readState(dir);
  const file = join(dir, fileOf(state.side));
  const source = await readFile(file, 'utf8');
  const n = state.calls + state.refused + 1;
  let result: { output: string; code: number; source?: string };
  let refused = false;
  if (state.calls >= state.budget) {
    refused = true;
    state.refused += 1;
    result = {
      output: `refused: the budget of ${state.budget} tool runs is used up; nothing was run. Reply done.`,
      code: 3,
    };
  } else {
    state.calls += 1;
    try {
      result =
        state.side === 'a0'
          ? await a0Command(state, source, argv, stdin, taskById(state.task))
          : await tsCommand(source, argv, stdin);
    } catch (e) {
      result = { output: a0Failure(e), code: 2 };
    }
    if (result.output.length > MAX_TOOL_OUTPUT)
      result = { ...result, output: `${result.output.slice(0, MAX_TOOL_OUTPUT)}\n(output cut)` };
  }
  if (result.source !== undefined) {
    await writeFile(file, result.source, 'utf8');
    state.sha = sha(result.source);
  }
  const left = state.budget - state.calls;
  const output = refused
    ? result.output
    : `${result.output}\n[tool run ${state.calls} of ${state.budget}; ${left} left]`;
  const entry: LogEntry = {
    n,
    argv,
    stdin,
    output,
    exitCode: result.code,
    refused,
    sha: state.sha,
  };
  await writeFile(logPath(dir), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  await writeFile(statePath(dir), JSON.stringify(state, null, 1), 'utf8');
  return { output, code: result.code };
}

// --- Scoring ------------------------------------------------------------------------

export interface LoopTrial {
  task: string;
  representation: Side;
  protocol: 'tool-loop';
  accepted: boolean;
  acceptedOneShot: null;
  failures: string[];
  toolCalls: number;
  refusedCalls: number;
  /** Tool runs plus the final reply. */
  modelCalls: number;
  editedOutsideTool: boolean;
  applies: { tried: number; accepted: number };
  setupTokensLocal: { o200k_base: number };
  tokenBucketsLocal: {
    languagePrimer: number;
    workflowPrimer: number;
    toolContext: number;
    output: number;
  };
  /** Secondary: the context each model call reads again (system, request, every earlier command and output). */
  rereadTokensLocal: { o200k_base: number };
  commands: string[];
  /** Wording arm only: the variant and the program views asked for (`bare` or the target). */
  variant?: Variant;
  programViews?: string[];
}

/**
 * Score one working directory. Tokens (o200k_base, local counts), in the cost model of
 * tools/app-edit-summary.ts: system = the subagent prompt + GUIDE.md + the tool help (weighted per
 * model call by the horizon); toolContext = the request (TASK.md after the help: instruction and view
 * or file) + every tool output as logged; output = every command line and its standard input.
 */
export async function scoreDir(dir: string, programs: Programs, guide: string): Promise<LoopTrial> {
  const state = await readState(dir);
  const task = taskById(state.task);
  const side = state.side;
  const log = await readLog(dir);
  const source = await readFile(join(dir, fileOf(side)), 'utf8');
  const editedOutsideTool = sha(source) !== state.sha;
  let failures: string[];
  if (editedOutsideTool) failures = ['the program file was changed outside the tool'];
  else if (side === 'a0') {
    try {
      failures = runTests(a0FrontEnd(parseAndValidate(source)), task.tests);
    } catch (e) {
      failures = [a0Failure(e)];
    }
  } else {
    const fe = await tsFrontEnd(source);
    failures = typeof fe === 'string' ? [fe] : runTests(fe, task.tests);
  }
  const p = prompt(side, task, programs, guide);
  const help = toolHelp(side).replace('<HANDLES>', handlesText(task));
  const v = state.variant;
  // wording arm: system = the prompt + GUIDE.md + SKILL.md (the help is a tool output there);
  // request = TASK.md as written
  const skill = v === undefined ? '' : wordingTexts(v).skill;
  const system =
    v === undefined
      ? tok(SUBAGENT_PROMPT) + tok(p.system) + tok(help)
      : tok(WORDING_PROMPT) + tok(p.system) + tok(skill);
  const request = v === undefined ? tok(p.user) : tok(wordingTaskText(task));
  const command = (e: LogEntry): string =>
    `./tool ${e.argv.join(' ')}${e.stdin === '' ? '' : `\n${e.stdin}`}`;
  const outs = log.map((e) => tok(e.output));
  const cmds = log.map((e) => tok(command(e)));
  let reread = 0;
  let sofar = system + request;
  for (let i = 0; i <= log.length; i += 1) {
    reread += sofar;
    if (i < log.length) sofar += (cmds[i] ?? 0) + (outs[i] ?? 0);
  }
  const applies = log.filter((e) => !e.refused && e.argv[0] === 'apply');
  return {
    task: task.id,
    representation: side,
    protocol: 'tool-loop',
    accepted: failures.length === 0,
    acceptedOneShot: null,
    failures,
    toolCalls: state.calls,
    refusedCalls: state.refused,
    modelCalls: log.length + 1,
    editedOutsideTool,
    applies: { tried: applies.length, accepted: applies.filter((e) => e.exitCode === 0).length },
    setupTokensLocal: { o200k_base: system },
    tokenBucketsLocal: {
      languagePrimer: side === 'a0' ? tok(guide.trimEnd()) * (log.length + 1) : 0,
      workflowPrimer:
        (v === undefined
          ? tok(SUBAGENT_PROMPT) + tok(help) + tok(side === 'a0' ? A0_PROTOCOL : TS_PROTOCOL)
          : tok(WORDING_PROMPT) + tok(skill) + tok(A0_PROTOCOL)) *
        (log.length + 1),
      toolContext: request + outs.reduce((a, b) => a + b, 0),
      output: cmds.reduce((a, b) => a + b, 0),
    },
    rereadTokensLocal: { o200k_base: reread },
    commands: log.map(
      (e) => `${e.argv.join(' ')}${e.refused ? ' (refused)' : ''} -> ${e.exitCode}`,
    ),
    ...(v === undefined ? {} : { variant: v, programViews: programViews(log) }),
  };
}

// --- Self-check ---------------------------------------------------------------------

export async function selfCheck(): Promise<{ ok: boolean; rows: Record<string, unknown>[] }> {
  const programs = await startPrograms();
  checkStart(programs);
  const guide = await readFile('MODEL_GUIDE.min.txt', 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'a0-app-loop-check-'));
  const rows: Record<string, unknown>[] = [];
  let ok = APP_TASKS.length === 14;
  try {
    for (const task of APP_TASKS)
      for (const side of ['a0', 'ts'] as const) {
        const dir = (name: string): string => join(root, side, task.id, name);
        // start: untouched
        await setupTask(dir('start'), side, task, programs, guide);
        const start = await scoreDir(dir('start'), programs, guide);
        // reference: one apply through the tool, then a check
        await setupTask(dir('ref'), side, task, programs, guide);
        const refApply = await execTool(dir('ref'), ['apply'], task.reference[side]);
        await execTool(dir('ref'), ['check'], '');
        const ref = await scoreDir(dir('ref'), programs, guide);
        // wrong: applies, fails the hidden tests
        await setupTask(dir('wrong'), side, task, programs, guide);
        const wrongApply = await execTool(dir('wrong'), ['apply'], task.wrong[side]);
        const wrong = await scoreDir(dir('wrong'), programs, guide);
        const row = {
          task: task.id,
          side,
          startFails: !start.accepted,
          referenceApplies: refApply.code === 0,
          referencePasses: ref.accepted,
          wrongApplies: wrongApply.code === 0,
          wrongFails: !wrong.accepted,
          referenceFailures: ref.failures.slice(0, 3),
          referenceTokens: ref.tokenBucketsLocal,
        };
        if (
          !(
            row.startFails &&
            row.referenceApplies &&
            row.referencePasses &&
            row.wrongApplies &&
            row.wrongFails
          )
        )
          ok = false;
        rows.push(row);
      }
    // budget: run BUDGET + 1 cheap commands; the last is refused and does not run
    const task = APP_TASKS[0] as AppTask;
    for (const side of ['a0', 'ts'] as const) {
      const d = join(root, side, 'budget');
      await setupTask(d, side, task, programs, guide);
      let last = { output: '', code: 0 };
      for (let i = 0; i <= BUDGET; i += 1) last = await execTool(d, ['help'], '');
      const state = await readState(d);
      const budgetOk = last.code === 3 && state.calls === BUDGET && state.refused === 1;
      if (!budgetOk) ok = false;
      rows.push({ task: 'budget', side, budgetEnforced: budgetOk });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return { ok, rows };
}

// --- Commands -----------------------------------------------------------------------

async function sealed(): Promise<string> {
  const text = await readFile('tools/app-edit-tasks.ts', 'utf8');
  const want = (await readFile('tools/app-edit-tasks.sha256', 'utf8')).split(/\s+/)[0];
  const got = taskSetSha256(text);
  if (got !== want) throw new Error(`tools/app-edit-tasks.ts does not match its seal (${got})`);
  return got;
}

const sidesOf = (s: string | undefined): Side[] => (s === 'a0' || s === 'ts' ? [s] : ['a0', 'ts']);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** `--arm wording --variant V` out of the arguments (exec takes none: the state says the arm). */
export function wordingFlags(argv: readonly string[]): { args: string[]; variant?: Variant } {
  const args: string[] = [];
  let arm: string | undefined;
  let variant: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--arm') arm = argv[++i];
    else if (a === '--variant') variant = argv[++i];
    else args.push(a);
  }
  if (arm === undefined && variant === undefined) return { args };
  if (arm !== 'wording') throw new Error(`unknown arm ${arm ?? '(none)'}; the only one is wording`);
  if (!(VARIANTS as readonly string[]).includes(variant ?? ''))
    throw new Error(`--variant must be one of ${VARIANTS.join(', ')}`);
  return { args, variant: variant as Variant };
}

async function wordingMain(
  cmd: string | undefined,
  args: string[],
  variant: Variant,
): Promise<void> {
  const taskSha = await sealed();
  const programs = await startPrograms();
  checkStart(programs);
  const guide = await readFile('MODEL_GUIDE.min.txt', 'utf8');
  if (args[1] !== undefined && args[1] !== 'a0') throw new Error('the wording arm is A0 only');
  const out = args[0];
  if (cmd === 'setup') {
    if (out === undefined) throw new Error('usage: setup OUTDIR a0 --arm wording --variant V');
    await mkdir(join(out, 'a0', 'prompts'), { recursive: true });
    for (const task of APP_TASKS) {
      const dir = resolve(out, 'a0', task.id);
      await setupWordingTask(dir, task, programs, guide, variant);
      await writeFile(
        join(out, 'a0', 'prompts', `${task.id}.txt`),
        WORDING_PROMPT.replaceAll('<dir>', dir.replace(/\\/g, '/')),
        'utf8',
      );
    }
    console.log(
      `wording ${variant}: ${APP_TASKS.length} working directories under ${join(out, 'a0')}`,
    );
    return;
  }
  if (cmd === 'score') {
    const model = args[2];
    if (out === undefined || model === undefined)
      throw new Error('usage: score OUTDIR a0 MODEL --arm wording --variant V');
    const check = await selfCheck();
    const trials: LoopTrial[] = [];
    for (const task of APP_TASKS) {
      const t = await scoreDir(join(out, 'a0', task.id), programs, guide);
      if (t.variant !== variant)
        throw new Error(`${task.id}: set up as ${t.variant ?? 'loop arm'}`);
      trials.push(t);
    }
    const path = `results/app-edit-wording/report.${model}.${variant}.json`;
    await mkdir(dirname(path), { recursive: true });
    await writeScrubbed(path, {
      generatedAt: new Date().toISOString(),
      tool: 'tools/app-edit-loop.ts score --arm wording',
      preRegistration: 'docs/history/2026-10-06-app-edit-wording-preregistration.md',
      model,
      side: 'a0',
      variant,
      budget: BUDGET,
      taskSetSha256: taskSha,
      startSha256: START_SHA256,
      harnessSelfCheck: { ok: check.ok },
      trials,
    });
    console.log(
      JSON.stringify({
        variant,
        trials: trials.length,
        accepted: trials.filter((t) => t.accepted).length,
        toolCalls: trials.reduce((a, t) => a + t.toolCalls, 0),
        bareListing: trials.filter((t) => t.programViews?.includes('bare')).length,
      }),
    );
    return;
  }
  throw new Error('the wording arm takes setup or score');
}

async function main(): Promise<void> {
  const [cmd, ...rawArgs] = process.argv.slice(2);
  if (cmd !== 'exec') {
    const f = wordingFlags(rawArgs);
    if (f.variant !== undefined) return wordingMain(cmd, f.args, f.variant);
  }
  const args = rawArgs;
  if (cmd === 'exec') {
    const [dir, ...argv] = args;
    if (dir === undefined) throw new Error('usage: exec DIR COMMAND [ARGS...]');
    const sub = argv[0];
    const stdin = sub === 'apply' ? await readStdin() : '';
    const r = await execTool(dir, argv, stdin);
    process.stdout.write(`${r.output}\n`);
    process.exitCode = r.code;
    return;
  }
  if (cmd === 'setup') {
    const out = args[0];
    if (out === undefined) throw new Error('usage: setup OUTDIR [a0|ts]');
    await sealed();
    const programs = await startPrograms();
    checkStart(programs);
    const guide = await readFile('MODEL_GUIDE.min.txt', 'utf8');
    for (const side of sidesOf(args[1])) {
      await mkdir(join(out, side, 'prompts'), { recursive: true });
      for (const task of APP_TASKS) {
        const dir = resolve(out, side, task.id);
        await setupTask(dir, side, task, programs, guide);
        await writeFile(
          join(out, side, 'prompts', `${task.id}.txt`),
          SUBAGENT_PROMPT.replaceAll('<dir>', dir.replace(/\\/g, '/')),
          'utf8',
        );
      }
      console.log(`${side}: ${APP_TASKS.length} working directories under ${join(out, side)}`);
    }
    return;
  }
  if (cmd === 'score') {
    const [out, sideText, model] = args;
    if (out === undefined) throw new Error('usage: score OUTDIR [a0|ts] [model]');
    const taskSha = await sealed();
    const programs = await startPrograms();
    checkStart(programs);
    const guide = await readFile('MODEL_GUIDE.min.txt', 'utf8');
    const check = await selfCheck();
    for (const side of sidesOf(sideText)) {
      const trials: LoopTrial[] = [];
      for (const task of APP_TASKS)
        trials.push(await scoreDir(join(out, side, task.id), programs, guide));
      const path = `results/app-edit-loop/report.${model ?? 'model'}.${side}.json`;
      await mkdir(dirname(path), { recursive: true });
      await writeScrubbed(path, {
        generatedAt: new Date().toISOString(),
        tool: 'tools/app-edit-loop.ts score',
        preRegistration: 'docs/history/2026-10-06-app-edit-loop-preregistration.md',
        model: model ?? null,
        side,
        budget: BUDGET,
        taskSetSha256: taskSha,
        startSha256: START_SHA256,
        harnessSelfCheck: { ok: check.ok },
        trials,
      });
      console.log(
        JSON.stringify({
          side,
          trials: trials.length,
          accepted: trials.filter((t) => t.accepted).length,
          toolCalls: trials.reduce((a, t) => a + t.toolCalls, 0),
          editedOutsideTool: trials.filter((t) => t.editedOutsideTool).length,
        }),
      );
    }
    return;
  }
  if (cmd === 'self-check') {
    const r = await selfCheck();
    for (const row of r.rows) console.log(JSON.stringify(row));
    console.log(`self-check ${r.ok ? 'ok' : 'FAILED'}`);
    if (args[0] !== undefined) {
      await mkdir(dirname(args[0]), { recursive: true });
      await writeScrubbed(args[0], {
        generatedAt: new Date().toISOString(),
        tool: 'tools/app-edit-loop.ts self-check',
        taskSetSha256: await sealed(),
        budget: BUDGET,
        ...r,
      });
    }
    if (!r.ok) process.exitCode = 1;
    return;
  }
  console.error(
    'usage: bun tools/app-edit-loop.ts setup OUTDIR [a0|ts] | exec DIR COMMAND ... | score OUTDIR [a0|ts] [model] | self-check [OUT]',
  );
  process.exitCode = 2;
}

if (/app-edit-loop\.[jt]s$/.test(process.argv[1] ?? '')) await main();
