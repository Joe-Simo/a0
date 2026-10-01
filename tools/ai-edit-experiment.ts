/**
 * Gate A harness: the controlled 2x2 AI-edit experiment.
 *
 *   representation: A0 | TypeScript        x    protocol: conventional | structured
 *
 * Task sets: A (13 tasks, harness author), B (12 held-out tasks), C (the set-B tasks embedded
 * in one 40-function program per representation, tools/ai-edit-tasks-c.ts); select with
 * A0_EXPERIMENT_TASKSET=a|b|c|all.
 *
 * A0 cell options: A0_EXPERIMENT_GUIDE (primer file),
 * A0_EXPERIMENT_PRIMER=always|none|lazy|rules|rules-merged,
 * A0_EXPERIMENT_PROGRAM_VIEW=all|deps
 * (program handle scope), A0_EXPERIMENT_SYSTEM=separate|merged (protocol paragraph after the
 * primer, or folded into the primer's EDIT line). A0_EXPERIMENT_OUT sets the report path.
 *
 * Each cell gives the model the same task, the same acceptance tests, and an
 * equally capable edit protocol; whole-task accounting records setup (language
 * instructions + protocol instructions), view, output, tool calls, validation
 * failures, repairs, wall time, and provider-reported usage. Unknown reasoning
 * usage is recorded as null, never zero.
 *
 * Modes:
 *   default (dry run): builds every prompt, validates the reference solutions
 *     against the acceptance tests locally, and records local tokenizer counts.
 *     No model is called. Writes results/ai-edit-experiment.json with status
 *     "unrun".
 *   live: requires A0_ALLOW_PAID_MODEL_CALLS=1 AND Anthropic credentials. Calls
 *     claude-opus-5-5 (override with A0_EXPERIMENT_MODEL) for N trials per cell.
 *     Never runs implicitly.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { getEncoding } from 'js-tiktoken';
import {
  formatDiagnostic,
  formatProgram,
  parseAndValidate,
  run,
  type Type,
  type TypedFunc,
  type TypedProgram,
  type Value,
} from '../src/core.js';
import { EditSession, formatRejection } from '../src/edit.js';
import { runTool, withTempDir } from '../src/toolchain.js';
import {
  type AppliedEdit,
  applyTs,
  extractBlock,
  numbered,
  PROTOCOL_LINE_EDIT,
  type Protocol,
} from './ai-edit-apply.js';
import {
  acceptLang,
  isLang,
  LANG_B,
  LANG_COMPILE_PREFIX,
  LANG_SEMANTICS,
  LANGS,
  type Lang,
  langFile,
} from './ai-edit-langs.js';
import { TASKS_A } from './ai-edit-tasks-a.js';
import { TASKS_B } from './ai-edit-tasks-b.js';
import { buildTasksC } from './ai-edit-tasks-c.js';
import { TASKS_D } from './ai-edit-tasks-d.js';
import { TASKS_E } from './ai-edit-tasks-e.js';
import { TASKS_F } from './ai-edit-tasks-f.js';

type Representation = 'a0' | 'ts' | 'rust' | Lang;

interface AcceptanceCase {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly expected: Value;
}

interface Task {
  readonly id: string;
  readonly kind: 'targeted-edit' | 'multi-node-edit' | 'comprehension-edit' | 'create';
  /** Function the structured A0 view opens (default: the first function). */
  readonly target?: string;
  readonly instruction: string;
  readonly a0Source: string;
  readonly tsSource: string;
  readonly rustSource: string;
  readonly tests: readonly AcceptanceCase[];
  /** Reference solutions, used only to validate the harness itself. */
  readonly reference: { readonly a0: string; readonly ts: string; readonly rust: string };
  /** Whole files in the further languages (sets B and C only). */
  readonly langs?: Readonly<Record<Lang, { readonly source: string; readonly reference: string }>>;
}

/** The original file of `task` in `rep` (throws when the task has no such translation). */
function sourceOf(task: Task, rep: Representation): string {
  if (rep === 'a0') return task.a0Source;
  if (rep === 'ts') return task.tsSource;
  if (rep === 'rust') return task.rustSource;
  const l = task.langs?.[rep];
  if (l === undefined) throw new Error(`${task.id}: no ${rep} translation`);
  return l.source;
}

// --- Instructions (counted as setup cost; identical across trials) ------------

const PROTOCOL_CONVENTIONAL =
  'Reply with the complete updated source file and nothing else, inside one ```code block.';
// A0_EXPERIMENT_A0_VIEW=numbered numbers the body lines of the e0 view so replies can address
// them (`N line`, `N-`, `N+ line`); measured 2026-09-30 with MODEL_GUIDE.lines.txt, it raised
// output per edit and lowered acceptance, so the default view stays unnumbered.
const A0_NUMBERED_VIEW = process.env.A0_EXPERIMENT_A0_VIEW === 'numbered';
const PROTOCOL_STRUCTURED_A0 = `The view starts with edit handles. Reply with only the edit lines the guide describes (${A0_NUMBERED_VIEW ? 'numbered or ' : ''}instruction lines edit the shown function; \`fn\` blocks or \`-fn name\` edit the program), bare: no code fence, no handle line.`;
// Primer-free A0 structured protocol (A0_EXPERIMENT_PRIMER=none|lazy): the edit rules of the
// guide's EDIT line, stated on their own, so the system text is the edit protocol only and the
// language itself must be inferred from the view.
const PROTOCOL_STRUCTURED_A0_SELF =
  'The view starts with edit handles. Reply with only edit lines, bare: no code fence, no handle line. `id op ...` replaces or inserts before ret; `-id` deletes; `ret x`; a `fn ...` block adds or replaces a function; `-fn name` removes one.';
const PROTOCOL_STRUCTURED_TS = PROTOCOL_LINE_EDIT;
const RUST_SEMANTICS =
  'Integers are u32 with wrapping arithmetic (use wrapping_add/wrapping_sub/wrapping_mul; shifts are masked to 5 bits); comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must compile with rustc, edition 2021.';
const PROTOCOL_STRUCTURED_RUST = PROTOCOL_STRUCTURED_TS;
const TS_SEMANTICS =
  'Numbers are unsigned 32-bit integers: every arithmetic result must be normalized with >>> 0, use Math.imul for multiplication, and comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend.';

/**
 * System-text layout of the A0 cells. 'separate': the primer followed by the protocol
 * paragraph (the recorded design). 'merged': one text; the primer's `EDIT:` line carries the
 * reply format, so no protocol paragraph is appended. Structured: the `EDIT:` line gains the
 * code-block rule. Conventional: the `EDIT:` line (edit syntax the cell never uses) is
 * replaced by the whole-file rule. Works for any primer with one `EDIT:` line.
 */
type SystemLayout = 'separate' | 'merged';

const MERGED_STRUCTURED_SUFFIX = ' Nothing else, inside one ```code block.';

function mergedA0System(
  guide: string,
  protocol: Protocol,
): { system: string; languagePrimer: string; workflowPrimer: string } {
  const lines = guide.replace(/\n+$/, '').split('\n');
  const edits = lines.flatMap((l, i) => (l.startsWith('EDIT:') ? [i] : []));
  const idx = edits[0];
  if (idx === undefined || edits.length !== 1)
    throw new Error('merged system layout needs exactly one primer line starting with "EDIT:"');
  const workflowPrimer =
    protocol === 'conventional'
      ? PROTOCOL_CONVENTIONAL
      : `${lines[idx] ?? ''}${MERGED_STRUCTURED_SUFFIX}`;
  // The protocol line keeps its place in the one text; the buckets split it out for accounting.
  return {
    system: lines.map((l, i) => (i === idx ? workflowPrimer : l)).join('\n'),
    languagePrimer: lines.filter((_, i) => i !== idx).join('\n'),
    workflowPrimer,
  };
}

// --- Views and edit application -----------------------------------------------

const A0_DIAGNOSE_CORE = process.env.A0_EXPERIMENT_DIAGNOSE === 'core';

function applyA0(
  rep: Representation,
  protocol: Protocol,
  source: string,
  reply: string,
  session?: EditSession,
): AppliedEdit {
  void rep;
  const body = extractBlock(reply);
  if (protocol === 'conventional') {
    try {
      parseAndValidate(body);
      return { source: body };
    } catch (e) {
      return { source, error: formatDiagnostic(e) };
    }
  }
  if (session === undefined) return { source, error: 'no session' };
  try {
    const next = session.apply(body);
    return { source: formatProgram(next) };
  } catch (e) {
    // A0_EXPERIMENT_DIAGNOSE=core: the rejection also lists the minimal failing subset of the
    // reply's lines, each with its fix (EditSession.diagnose).
    const rejection = A0_DIAGNOSE_CORE ? session.diagnose(body) : undefined;
    const core = rejection === undefined ? '' : `\n${formatRejection(rejection)}`;
    return { source, error: `${formatDiagnostic(e)}${core}` };
  }
}

// --- Acceptance -----------------------------------------------------------------

/** Structural equality over u32/bool/arrays/records (typed arrays count as arrays). */
function sameValue(a: unknown, b: unknown): boolean {
  const isArr = (x: unknown): x is ArrayLike<unknown> =>
    Array.isArray(x) || x instanceof Uint32Array || x instanceof Uint8Array;
  if (isArr(a) && isArr(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'number' && typeof b === 'boolean') return a === (b ? 1 : 0);
  if (typeof a === 'boolean' && typeof b === 'number') return (a ? 1 : 0) === b;
  return a === b;
}

function fmt(v: Value): string {
  return typeof v === 'boolean' ? String(v) : String(v);
}

async function acceptA0(source: string, tests: readonly AcceptanceCase[]): Promise<string[]> {
  const failures: string[] = [];
  let program: ReturnType<typeof parseAndValidate>;
  try {
    program = parseAndValidate(source);
  } catch (e) {
    return [`invalid A0: ${formatDiagnostic(e)}`];
  }
  for (const t of tests) {
    const fn = program.byName.get(t.fn) as TypedFunc | undefined;
    if (fn === undefined) {
      failures.push(`missing function ${t.fn}`);
      continue;
    }
    try {
      const got = run(fn, t.args);
      if (!sameValue(got, t.expected))
        failures.push(
          `${t.fn}(${t.args.map(fmt).join(',')}) = ${fmt(got)}, expected ${fmt(t.expected)}`,
        );
    } catch (e) {
      failures.push(`${t.fn}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failures;
}

/** Rust literal for an A0 value of type `t`: arrays as `[..]`, records as tuples. */
function rustLiteral(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return `${v}u32`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    if (t !== undefined && typeof t !== 'string' && t.kind === 'arr')
      return `[${v.map((x) => rustLiteral(x, t.elem)).join(', ')}]`;
    const fields = t !== undefined && typeof t !== 'string' && t.kind === 'rec' ? t.fields : [];
    return `(${v.map((x, i) => rustLiteral(x, fields[i])).join(', ')})`;
  }
  return '0u32';
}

async function acceptRust(
  source: string,
  tests: readonly AcceptanceCase[],
  typed: TypedProgram,
): Promise<string[]> {
  // Single file: the candidate source plus a generated main that checks every case. The
  // A0 reference program supplies the value shapes (array vs record) for the literals.
  const checks = tests.map((t, i) => {
    const fn = typed.byName.get(t.fn);
    const args = t.args.map((a, k) => rustLiteral(a, fn?.params[k])).join(', ');
    return `    { let got = ${t.fn}(${args}); if got != ${rustLiteral(t.expected, fn?.result)} { println!("FAIL ${i} {:?}", got); } }`;
  });
  const main = `\n#[allow(dead_code)]\nfn main() {\n${checks.join('\n')}\n    println!("DONE");\n}\n`;
  return withTempDir(async (dir) => {
    const file = join(dir, 'candidate.rs');
    await writeFile(file, `${source}${main}`, 'utf8');
    const rustc = `${process.env.HOME ?? ''}/.cargo/bin/rustc`;
    const build = runTool(
      rustc,
      ['--edition', '2021', '-O', '-A', 'warnings', '-o', join(dir, 'candidate'), file],
      { cwd: dir, timeoutMs: 300_000 },
    );
    if (!build.ok) return [`rustc: ${build.stderr.slice(0, 500)}`];
    const run = runTool(join(dir, 'candidate'), [], { cwd: dir, timeoutMs: 60_000 });
    if (!run.ok) return [`run: ${run.stderr.slice(0, 300)}`];
    const failures = run.stdout
      .split('\n')
      .filter((l) => l.startsWith('FAIL'))
      .map((l) => {
        const [, idx, got] = l.split(' ');
        const t = tests[Number(idx)];
        return t === undefined
          ? l
          : `${t.fn}(${t.args.map(fmt).join(',')}) = ${got}, expected ${fmt(t.expected)}`;
      });
    if (!run.stdout.includes('DONE')) failures.push('program did not finish');
    return failures;
  });
}

async function acceptTs(source: string, tests: readonly AcceptanceCase[]): Promise<string[]> {
  // Type-check with tsc, then execute the checked JS in a separate Node process.
  return withTempDir(async (dir) => {
    const file = join(dir, 'mod.ts');
    await writeFile(file, source, 'utf8');
    const tsc = join(process.cwd(), 'node_modules', '.bin', 'tsc');
    // Self-contained project: no ambient @types, only the ES library.
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'es2022',
          moduleResolution: 'bundler',
          lib: ['es2022'],
          types: [],
          typeRoots: [],
          outDir: dir,
        },
        files: ['mod.ts'],
      }),
      'utf8',
    );
    const check = runTool(tsc, ['-p', join(dir, 'tsconfig.json')], { cwd: dir });
    if (!check.ok) return [`tsc: ${check.stdout.slice(0, 500)}`];
    const js = await readFile(join(dir, 'mod.js'), 'utf8');
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )) as Record<string, (...a: Value[]) => Value>;
    const failures: string[] = [];
    for (const t of tests) {
      const f = mod[t.fn];
      if (typeof f !== 'function') {
        failures.push(`missing export ${t.fn}`);
        continue;
      }
      try {
        const got = f(...t.args);
        if (!sameValue(got, t.expected))
          failures.push(
            `${t.fn}(${t.args.map(fmt).join(',')}) = ${fmt(got)}, expected ${fmt(t.expected)}`,
          );
      } catch (e) {
        failures.push(`${t.fn}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return failures;
  });
}

// --- Cells ------------------------------------------------------------------------

/**
 * A0 language primer policy: 'always' (default) sends the guide in every call's system text;
 * 'none' sends only the edit protocol; 'lazy' sends no primer on the first attempt and the
 * lazy primer (MODEL_GUIDE.tiny.txt) with the repair message after an invalid reply;
 * 'rules' sends the guide (A0_EXPERIMENT_GUIDE, e.g. MODEL_GUIDE.rules.txt: only the language
 * rules models get wrong without a primer) followed by the self-contained edit protocol of
 * 'none', so the protocol is stated once and the guide carries no EDIT line;
 * 'rules-merged' sends the guide alone (e.g. MODEL_GUIDE.rules-merged.txt: the rules and the
 * edit protocol in one text), structured cells only.
 */
type PrimerMode = 'always' | 'none' | 'lazy' | 'rules' | 'rules-merged';

interface Cell {
  readonly representation: Representation;
  readonly protocol: Protocol;
  /** Language primer: what the model must know about the language (bucket 1). */
  readonly languagePrimer: string;
  /** Workflow primer: the edit protocol instructions (bucket 2). */
  readonly workflowPrimer: string;
  readonly system: string;
  readonly view: string;
}

async function buildCell(
  task: Task,
  representation: Representation,
  protocol: Protocol,
  guide: string,
  programScope: 'all' | 'deps' = 'all',
  layout: SystemLayout = 'separate',
  primerMode: PrimerMode = 'always',
): Promise<{ cell: Cell; session?: EditSession; handle: string }> {
  const handle = 'e0';
  if (representation === 'a0') {
    if (primerMode === 'rules-merged' && protocol !== 'structured')
      throw new Error('A0_EXPERIMENT_PRIMER=rules-merged carries the structured protocol only');
    const withPrimer =
      primerMode === 'always' || primerMode === 'rules' || primerMode === 'rules-merged';
    const protocolText =
      protocol === 'conventional'
        ? PROTOCOL_CONVENTIONAL
        : primerMode === 'always'
          ? PROTOCOL_STRUCTURED_A0
          : PROTOCOL_STRUCTURED_A0_SELF;
    if (!withPrimer) guide = '';
    if (primerMode === 'rules' || primerMode === 'rules-merged') guide = guide.trimEnd();
    const { system, ...primers } =
      primerMode === 'always' && layout === 'merged'
        ? mergedA0System(guide, protocol)
        : primerMode === 'rules-merged'
          ? { system: guide, languagePrimer: guide, workflowPrimer: '' }
          : {
              system: withPrimer ? `${guide}\n\n${protocolText}` : protocolText,
              languagePrimer: guide,
              workflowPrimer: protocolText,
            };
    if (protocol === 'structured') {
      // Two handles per view: e0 edits the target function, g1 edits the program (add,
      // replace, or remove whole functions, e.g. for signature changes). The reply's first
      // line selects which one is used.
      const session = new EditSession(parseAndValidate(task.a0Source));
      const fnName = task.target ?? parseAndValidate(task.a0Source).functions[0]?.name ?? '';
      const fnView = session.open(fnName, { scope: 'deps', numbered: A0_NUMBERED_VIEW }).text; // e0
      const progView = session.openProgram({ scope: programScope, target: fnName }).text; // g0
      const view = `${fnView}\n${progView}`;
      return { cell: { representation, protocol, ...primers, system, view }, session, handle };
    }
    return { cell: { representation, protocol, ...primers, system, view: task.a0Source }, handle };
  }
  const src = sourceOf(task, representation);
  const semantics =
    representation === 'rust'
      ? RUST_SEMANTICS
      : representation === 'ts'
        ? TS_SEMANTICS
        : LANG_SEMANTICS[representation];
  // Every non-A0 language uses the same numbered line-edit protocol as TypeScript.
  const structured = representation === 'rust' ? PROTOCOL_STRUCTURED_RUST : PROTOCOL_STRUCTURED_TS;
  const protocolText = protocol === 'conventional' ? PROTOCOL_CONVENTIONAL : structured;
  const system = `${semantics}\n\n${protocolText}`;
  const view = protocol === 'conventional' ? src : `${handle}\n${numbered(src)}`;
  return {
    cell: {
      representation,
      protocol,
      languagePrimer: semantics,
      workflowPrimer: protocolText,
      system,
      view,
    },
    handle,
  };
}

/**
 * Failure taxonomy per attempt (after MultiPL-E's status classes, extended for edit
 * protocols): `protocol` = the reply did not follow the edit protocol (bad handle, bad
 * line reference, stale revision); `compile` = the resulting program does not parse or
 * type-check (A0 validator, tsc, rustc); `missing` = a function the tests need is absent;
 * `runtime` = a test raised or the program did not finish; `wrong-output` = a test
 * returned a different value; `no-reply` = no model output for this attempt.
 */
type AttemptStatus =
  | 'ok'
  | 'protocol'
  | 'compile'
  | 'missing'
  | 'runtime'
  | 'wrong-output'
  | 'no-reply';

interface Attempt {
  readonly status: AttemptStatus;
  readonly failures: readonly string[];
  readonly outputTokensLocal: Record<string, number>;
  /** The exact repair message sent after this attempt (absent on the last attempt). */
  readonly repair?: string;
}

function classify(
  applied: AppliedEdit,
  protocol: Protocol,
  failures: readonly string[],
): AttemptStatus {
  if (applied.error !== undefined) return protocol === 'structured' ? 'protocol' : 'compile';
  if (failures.length === 0) return 'ok';
  const f = failures[0] ?? '';
  if (/^(invalid A0:|tsc:|rustc:)/.test(f) || LANG_COMPILE_PREFIX.test(f)) return 'compile';
  if (failures.some((x) => x.startsWith('missing '))) return 'missing';
  if (failures.some((x) => /=.*, expected /.test(x))) return 'wrong-output';
  return 'runtime';
}

interface Trial {
  readonly task: string;
  readonly kind: Task['kind'];
  readonly representation: Representation;
  readonly protocol: Protocol;
  readonly trial: number;
  readonly setupTokensLocal: Record<string, number>;
  readonly viewTokensLocal: Record<string, number>;
  /**
   * Whole-task token buckets (o200k, local counts), never merged: language primer and
   * workflow primer are charged once per model call (they travel in the system prompt);
   * tool context is the task text, the view, and every repair message; output is every
   * model reply.
   */
  readonly tokenBucketsLocal: {
    readonly languagePrimer: number;
    readonly workflowPrimer: number;
    readonly toolContext: number;
    readonly output: number;
    readonly total: number;
  } | null;
  readonly outputTokensLocal: Record<string, number> | null;
  readonly providerUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  readonly reasoningTokens: null;
  readonly modelCalls: number;
  readonly validationFailures: number;
  /** Accepted on the first reply, before any repair message. */
  readonly acceptedOneShot: boolean | null;
  /** Accepted within maxRepairs repair rounds. */
  readonly accepted: boolean | null;
  readonly attempts: readonly Attempt[];
  readonly failures: readonly string[];
  readonly wallMs: number | null;
}

interface ReplyResult {
  readonly reply: string;
  readonly usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Runs one trial: up to 1 + maxRepairs replies from `ask`, each applied and accepted. */
async function runTrial(
  task: Task,
  representation: Representation,
  protocol: Protocol,
  cell: Cell,
  session: EditSession | undefined,
  handle: string,
  maxRepairs: number,
  count: (text: string) => Record<string, number>,
  ask: (messages: Anthropic.MessageParam[]) => Promise<ReplyResult | undefined>,
  lazyPrimer?: string,
): Promise<
  Omit<
    Trial,
    | 'task'
    | 'kind'
    | 'representation'
    | 'protocol'
    | 'trial'
    | 'setupTokensLocal'
    | 'viewTokensLocal'
    | 'reasoningTokens'
  >
> {
  const start = performance.now();
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `${task.instruction}\n\n${cell.view}` },
  ];
  let source = sourceOf(task, representation);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;
  let calls = 0;
  let toolContext = count(`${task.instruction}\n\n${cell.view}`).o200k_base ?? 0;
  const attempts: Attempt[] = [];
  let failures: string[] = [];
  let accepted = false;
  let outputText = '';
  let lazyPrimerTokens = 0;
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const res = await ask(messages);
    if (res === undefined) {
      // No further reply available (scripted mode): keep the last real rejection as the outcome.
      if (attempt === 0) {
        attempts.push({ status: 'no-reply', failures: ['no reply'], outputTokensLocal: count('') });
        failures = ['no reply'];
      }
      break;
    }
    calls += 1;
    if (res.usage !== undefined) {
      sawUsage = true;
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      usage.cacheRead += res.usage.cacheRead;
      usage.cacheWrite += res.usage.cacheWrite;
    }
    outputText += res.reply;
    const applied =
      representation === 'a0'
        ? applyA0(representation, protocol, source, res.reply, session)
        : applyTs(protocol, source, res.reply, handle);
    failures =
      applied.error !== undefined
        ? [applied.error]
        : representation === 'a0'
          ? await acceptA0(applied.source, task.tests)
          : representation === 'rust'
            ? await acceptRust(applied.source, task.tests, parseAndValidate(task.reference.a0))
            : representation === 'ts'
              ? await acceptTs(applied.source, task.tests)
              : await acceptLang(
                  representation,
                  applied.source,
                  task.tests,
                  parseAndValidate(task.reference.a0),
                );
    attempts.push({
      status: classify(applied, protocol, failures),
      failures,
      outputTokensLocal: count(res.reply),
    });
    if (failures.length === 0) {
      accepted = true;
      source = applied.source;
      break;
    }
    messages.push({ role: 'assistant', content: res.reply });
    // An edit that applied but failed acceptance consumed its handles and changed the
    // program: send the fresh view (function handle and program handle, as at the start).
    let nextView: string | undefined;
    if (
      protocol === 'structured' &&
      representation === 'a0' &&
      session !== undefined &&
      applied.error === undefined
    ) {
      // Handles are stable: show the current text under the same e0 / g0.
      nextView = `${session.view('e0')}\n${session.view('g0')}`;
    }
    const rejection = `Rejected:\n${failures.join('\n')}\n${nextView !== undefined ? `\nCurrent view:\n${nextView}` : ''}\nTry again.`;
    // Lazy primer: sent once, with the first repair after a reply the checker could not accept
    // as A0 (protocol or compile failure); charged to the language-primer bucket.
    const status = attempts[attempts.length - 1]?.status;
    const sendPrimer =
      lazyPrimer !== undefined &&
      lazyPrimerTokens === 0 &&
      (status === 'protocol' || status === 'compile');
    if (sendPrimer) lazyPrimerTokens = count(lazyPrimer).o200k_base ?? 0;
    const repair = sendPrimer ? `${lazyPrimer}\n\n${rejection}` : rejection;
    attempts[attempts.length - 1] = { ...(attempts[attempts.length - 1] as Attempt), repair };
    toolContext += count(rejection).o200k_base ?? 0;
    messages.push({ role: 'user', content: repair });
  }
  const languagePrimer = (count(cell.languagePrimer).o200k_base ?? 0) * calls + lazyPrimerTokens;
  const workflowPrimer = (count(cell.workflowPrimer).o200k_base ?? 0) * calls;
  const output = count(outputText).o200k_base ?? 0;
  return {
    tokenBucketsLocal: {
      languagePrimer,
      workflowPrimer,
      toolContext,
      output,
      total: languagePrimer + workflowPrimer + toolContext + output,
    },
    outputTokensLocal: count(outputText),
    providerUsage: sawUsage ? usage : null,
    modelCalls: calls,
    validationFailures: attempts.filter((a) => a.status !== 'ok').length,
    acceptedOneShot: attempts[0]?.status === 'ok',
    accepted,
    attempts,
    failures,
    wallMs: performance.now() - start,
  };
}

function cellNames(
  reps: readonly Representation[],
  protocols: readonly Protocol[],
): readonly string[] {
  return reps.flatMap((r) => protocols.map((p) => `${r}/${p}`));
}

async function main(): Promise<void> {
  const live = process.env.A0_ALLOW_PAID_MODEL_CALLS === '1';
  const model = process.env.A0_EXPERIMENT_MODEL ?? 'claude-opus-5-5';
  const trialsPerCell = Number(process.env.A0_EXPERIMENT_TRIALS ?? '3');
  // A0_EXPERIMENT_PRIMER=none|lazy|rules|rules-merged: see PrimerMode. All allow exactly one repair (the retry
  // with the checker's message); the default keeps the guide in every call and two repairs.
  const primerEnv = process.env.A0_EXPERIMENT_PRIMER ?? 'always';
  if (
    primerEnv !== 'always' &&
    primerEnv !== 'none' &&
    primerEnv !== 'lazy' &&
    primerEnv !== 'rules' &&
    primerEnv !== 'rules-merged'
  )
    throw new Error(`unknown A0_EXPERIMENT_PRIMER ${primerEnv}`);
  const primerMode: PrimerMode = primerEnv;
  const maxRepairs = primerMode === 'always' ? 2 : 1;
  // The language primer is the dominant A0 cost; A0_EXPERIMENT_GUIDE selects an alternative
  // (e.g. MODEL_GUIDE.min.txt) so live runs can compare acceptance against primer size.
  // Task set: 'a' (the original 13, written by the harness author), 'b' (12 written by an
  // agent that had not seen set a or the corpus), 'c' (the 12 set-B tasks, each embedded in
  // the same deterministic 40-function program; see ai-edit-tasks-c.ts), or 'all' (a + b).
  // 'c400' / 'c1000' / 'c4000': the same twelve tasks in a deterministic program of 400 /
  // 1000 / 4000 functions (generated filler, see generateFiller); any 'cN' with N >= 40 up to
  // LIMITS.maxFunctions (65536 since a0c-0.1.14) is accepted.
  const setName = process.env.A0_EXPERIMENT_TASKSET ?? 'a';
  const scaledMatch = /^c([0-9]*)$/.exec(setName);
  const scaled =
    scaledMatch === null ? undefined : scaledMatch[1] === '' ? 40 : Number(scaledMatch[1]);
  // Program handle of the structured A0 cell: 'all' lists every signature; 'deps' lists the
  // target, its transitive callees, and its direct callers (EditSession.openProgram scope).
  const programScope = process.env.A0_EXPERIMENT_PROGRAM_VIEW === 'deps' ? 'deps' : 'all';
  // Representations to run (A0_EXPERIMENT_REPS, comma-separated; default a0,ts,rust). The
  // further languages (LANGS in ai-edit-langs.ts) exist for sets b and c*.
  const reps = (process.env.A0_EXPERIMENT_REPS ?? 'a0,ts,rust').split(',').map((r) => {
    if (r === 'a0' || r === 'ts' || r === 'rust' || isLang(r)) return r as Representation;
    throw new Error(`unknown representation ${r}`);
  });
  // Protocols to run (A0_EXPERIMENT_PROTOCOLS, comma-separated; default both).
  const protocols = (process.env.A0_EXPERIMENT_PROTOCOLS ?? 'conventional,structured')
    .split(',')
    .map((p) => {
      if (p === 'conventional' || p === 'structured') return p as Protocol;
      throw new Error(`unknown protocol ${p}`);
    });
  const withLangs = (t: Task): Task => {
    const perTask = LANG_B[t.id];
    if (perTask === undefined) return t;
    const langs = Object.fromEntries(
      LANGS.map((l) => [
        l,
        { source: langFile(l, perTask[l].source), reference: langFile(l, perTask[l].reference) },
      ]),
    ) as NonNullable<Task['langs']>;
    return { ...t, langs };
  };

  // A0 system text: 'separate' (primer + protocol paragraph) or 'merged' (the protocol lives in
  // the primer's EDIT line; see mergedA0System). TS and Rust cells are unaffected.
  const systemLayout: SystemLayout =
    process.env.A0_EXPERIMENT_SYSTEM === 'merged' ? 'merged' : 'separate';
  const TASKS: readonly Task[] =
    setName === 'b'
      ? (TASKS_B as readonly Task[]).map(withLangs)
      : setName === 'd'
        ? (TASKS_D as unknown as readonly Task[])
        : setName === 'e'
          ? (TASKS_E as unknown as readonly Task[])
          : setName === 'f'
            ? (TASKS_F as unknown as readonly Task[])
            : scaled !== undefined
              ? buildTasksC(TASKS_A, TASKS_B, scaled)
              : setName === 'all'
                ? [...TASKS_A, ...(TASKS_B as readonly Task[])]
                : TASKS_A;
  // What each protocol sends. Set C makes the asymmetry visible: the structured A0 cell
  // sends the scoped view of the target function plus the program's signature lines, while
  // the structured TypeScript and Rust cells send the whole numbered file, since locating
  // the function is part of the job for an agent editing a real file.
  const method = {
    conventional: 'whole file in every representation; reply is the whole updated file',
    structured: {
      a0:
        programScope === 'deps'
          ? 'dependency-scoped view of the target function (body + one signature line per callee) under handle e0, plus the dependency-scoped program handle g0 (a comment line with the function count, then the signatures of the target, its transitive callees, and its direct callers); g0 edits the whole program; reply is handle + edit lines'
          : 'dependency-scoped view of the target function (body + one signature line per callee) under handle e0, plus the program handle g0 with one signature line per function; reply is handle + edit lines',
      ...Object.fromEntries(
        (['ts', 'rust', ...LANGS] as const).map((r) => [
          r,
          'whole file, numbered, under handle e0; reply is handle + line edits (replace/insert/delete by line number)',
        ]),
      ),
    },
    note:
      scaled !== undefined
        ? `set ${setName}: every task shares one ${scaled}-function program per representation (same names, semantics, and order); the structured A0 view is per-function while the structured and conventional TS/Rust views are the whole file, which is what an agent editing a real file reads`
        : 'sets A/B: each task file holds only the functions the task needs, so whole-file and scoped views are close in size',
  };
  const guidePath = process.env.A0_EXPERIMENT_GUIDE ?? 'MODEL_GUIDE.min.txt';
  const guide = await readFile(guidePath, 'utf8');
  const lazyPrimerPath = process.env.A0_EXPERIMENT_LAZY_GUIDE ?? 'MODEL_GUIDE.tiny.txt';
  const lazyPrimer =
    primerMode === 'lazy' ? (await readFile(lazyPrimerPath, 'utf8')).trimEnd() : undefined;
  const encoders = {
    o200k_base: getEncoding('o200k_base'),
    cl100k_base: getEncoding('cl100k_base'),
  } as const;
  const count = (text: string): Record<string, number> =>
    Object.fromEntries(Object.entries(encoders).map(([k, e]) => [k, e.encode(text).length]));

  // Harness self-check: reference solutions must pass acceptance in every cell.
  const selfCheck: Record<string, string[]> = {};
  for (const task of TASKS) {
    const typedRef = parseAndValidate(task.reference.a0);
    for (const lang of reps.filter(isLang)) {
      const l = task.langs?.[lang];
      if (l === undefined) throw new Error(`${task.id}: no ${lang} translation`);
      selfCheck[`${task.id}/${lang}`] = await acceptLang(lang, l.reference, task.tests, typedRef);
      selfCheck[`${task.id}/${lang}-original-must-fail`] =
        (await acceptLang(lang, l.source, task.tests, typedRef)).length > 0
          ? []
          : ['original already passes'];
    }
    if (!reps.includes('a0') && !reps.includes('ts') && !reps.includes('rust')) continue;
    selfCheck[`${task.id}/a0`] = await acceptA0(task.reference.a0, task.tests);
    selfCheck[`${task.id}/ts`] = await acceptTs(task.reference.ts, task.tests);
    selfCheck[`${task.id}/a0-original-must-fail`] =
      (await acceptA0(task.a0Source, task.tests)).length > 0 ? [] : ['original already passes'];
    selfCheck[`${task.id}/ts-original-must-fail`] =
      (await acceptTs(task.tsSource, task.tests)).length > 0 ? [] : ['original already passes'];
    selfCheck[`${task.id}/rust`] = await acceptRust(task.reference.rust, task.tests, typedRef);
    selfCheck[`${task.id}/rust-original-must-fail`] =
      (await acceptRust(task.rustSource, task.tests, typedRef)).length > 0
        ? []
        : ['original already passes'];
  }
  const selfCheckOk = Object.values(selfCheck).every((f) => f.length === 0);

  const client = live ? new Anthropic() : undefined;
  // Scripted replies (e.g. an in-session model answering from a prompt dump): a JSON map
  // "task/representation/protocol" -> reply[] consumed one per attempt. Token counts of
  // replies are local (js-tiktoken); provider usage is null.
  const repliesPath = process.env.A0_EXPERIMENT_REPLIES;
  const scripted: Record<string, string[]> | undefined =
    repliesPath === undefined
      ? undefined
      : (JSON.parse(await readFile(repliesPath, 'utf8')) as Record<string, string[]>);
  const dumpPath = process.env.A0_EXPERIMENT_DUMP;
  const dump: Record<string, { system: string; user: string }> = {};
  const trials: Trial[] = [];
  for (const task of TASKS) {
    for (const representation of reps) {
      for (const protocol of protocols) {
        for (let t = 0; t < (live ? trialsPerCell : 1); t += 1) {
          const { cell, session, handle } = await buildCell(
            task,
            representation,
            protocol,
            guide,
            programScope,
            systemLayout,
            primerMode,
          );
          const base = {
            task: task.id,
            kind: task.kind,
            representation,
            protocol,
            trial: t,
            setupTokensLocal: count(cell.system),
            viewTokensLocal: count(cell.view),
            reasoningTokens: null,
          } as const;
          const cellKey = `${task.id}/${representation}/${protocol}`;
          dump[cellKey] = { system: cell.system, user: `${task.instruction}\n\n${cell.view}` };
          if (scripted !== undefined) {
            const answers = [...(scripted[cellKey] ?? [])];
            const result = await runTrial(
              task,
              representation,
              protocol,
              cell,
              session,
              handle,
              maxRepairs,
              count,
              async () => {
                const reply = answers.shift();
                return reply === undefined ? undefined : { reply };
              },
              representation === 'a0' ? lazyPrimer : undefined,
            );
            trials.push({ ...base, ...result });
            continue;
          }
          if (client === undefined) {
            trials.push({
              ...base,
              tokenBucketsLocal: null,
              outputTokensLocal: null,
              providerUsage: null,
              modelCalls: 0,
              validationFailures: 0,
              acceptedOneShot: null,
              accepted: null,
              attempts: [],
              failures: [],
              wallMs: null,
            });
            continue;
          }
          const result = await runTrial(
            task,
            representation,
            protocol,
            cell,
            session,
            handle,
            maxRepairs,
            count,
            async (messages) => {
              const res = await client.messages.create({
                model,
                max_tokens: 4096,
                system: [{ type: 'text', text: cell.system, cache_control: { type: 'ephemeral' } }],
                messages,
              });
              return {
                reply: res.content
                  .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n'),
                usage: {
                  input: res.usage.input_tokens,
                  output: res.usage.output_tokens,
                  cacheRead: res.usage.cache_read_input_tokens ?? 0,
                  cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
                },
              };
            },
            representation === 'a0' ? lazyPrimer : undefined,
          );
          trials.push({ ...base, ...result });
        }
      }
    }
  }

  if (dumpPath !== undefined)
    await writeFile(dumpPath, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');
  // Mean context per cell (o200k): the view alone (always available) and the whole tool
  // context of the first attempt (task text + view + repairs; scripted or live runs only).
  const contextTokensByCell = Object.fromEntries(
    cellNames(reps, protocols).map((cellName) => {
      const [representation, protocol] = cellName.split('/');
      const rows = trials.filter(
        (t) => t.representation === representation && t.protocol === protocol,
      );
      const mean = (xs: number[]): number | null =>
        xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
      return [
        cellName,
        {
          trials: rows.length,
          meanView: mean(rows.map((t) => t.viewTokensLocal.o200k_base ?? 0)),
          meanToolContext: mean(
            rows.flatMap((t) =>
              t.tokenBucketsLocal === null ? [] : [t.tokenBucketsLocal.toolContext],
            ),
          ),
        },
      ];
    }),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    status: live
      ? 'run'
      : scripted !== undefined
        ? `run with scripted replies from ${repliesPath} (subject: ${process.env.A0_EXPERIMENT_SUBJECT ?? 'unspecified'})`
        : 'unrun (paid model calls not authorized: set A0_ALLOW_PAID_MODEL_CALLS=1 with Anthropic credentials)',
    model: live ? model : null,
    languagePrimer:
      primerMode === 'always'
        ? guidePath
        : primerMode === 'none'
          ? 'none (A0 system text is the edit protocol only; one repair)'
          : primerMode === 'rules'
            ? `${guidePath} followed by the self-contained edit protocol (one repair)`
            : primerMode === 'rules-merged'
              ? `${guidePath} alone: rules and edit protocol in one text (one repair)`
              : `lazy: none on the first attempt, ${lazyPrimerPath} with the repair after a protocol or compile rejection (one repair)`,
    primerMode,
    taskSet: setName,
    programView: programScope,
    systemLayout,
    a0View: A0_NUMBERED_VIEW ? 'numbered' : 'plain',
    method,
    tokenizerNote:
      'setup/view/output token counts are local js-tiktoken counts (OpenAI encodings), not the vendor tokenizer; providerUsage carries the billed counts when live.',
    design: {
      cells: cellNames(reps, protocols),
      heldConstant: [
        'model',
        'task text',
        'acceptance tests',
        'max repairs',
        'max_tokens',
        'system prompt caching',
      ],
      setupCounted:
        'A0 cells carry MODEL_GUIDE.txt as language instructions; TS and Rust cells carry a u32 semantics note; all carry their protocol instructions. Rust acceptance compiles with rustc -O and runs generated checks; the further languages (Python, Go, Java, C#, C++, Kotlin, Swift, Ruby, PHP, Haskell, OCaml, Elixir, Zig) carry their own u32 semantics note and are accepted by their own toolchain (build or static check, then a generated driver run; tools/ai-edit-langs.ts, tools/edit-langs/).',
      unknowns: 'Hidden reasoning tokens are not reported by the API and are recorded as null.',
    },
    // Task-set manifest: SHA-256 over every task's sources, instruction, and tests, so a
    // run attests exactly which held-out set it used (a sealed set must reproduce this hash).
    taskSetSha256: createHash('sha256')
      .update(
        JSON.stringify(
          TASKS.map((t) => [t.id, t.instruction, t.a0Source, t.tsSource, t.rustSource, t.tests]),
        ),
      )
      .digest('hex'),
    // The same over the further languages' original files, when they are run.
    ...(reps.some(isLang)
      ? {
          langTaskSetSha256: createHash('sha256')
            .update(
              JSON.stringify(
                TASKS.map((t) => [t.id, reps.filter(isLang).map((l) => t.langs?.[l]?.source)]),
              ),
            )
            .digest('hex'),
        }
      : {}),
    representations: reps,
    protocols,
    tasks: TASKS.map((t) => ({ id: t.id, kind: t.kind, tests: t.tests.length })),
    harnessSelfCheck: { ok: selfCheckOk, details: selfCheck },
    contextTokensByCell,
    trials,
  };
  // A0_EXPERIMENT_OUT names the report file (default results/ai-edit-experiment.json).
  const outPath = process.env.A0_EXPERIMENT_OUT ?? join('results', 'ai-edit-experiment.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`status: ${report.status}\nself-check: ${selfCheckOk ? 'ok' : 'FAILED'}\n`);
  for (const tr of trials) {
    process.stdout.write(
      `${tr.task.padEnd(12)} ${tr.representation}/${tr.protocol.padEnd(12)} setup o200k=${tr.setupTokensLocal.o200k_base} view o200k=${tr.viewTokensLocal.o200k_base}${tr.accepted === null ? '' : ` one-shot=${tr.acceptedOneShot} accepted=${tr.accepted} calls=${tr.modelCalls} total=${tr.tokenBucketsLocal?.total} status=${tr.attempts.map((a) => a.status).join(',')}`}\n`,
    );
  }
  for (const [cellName, c] of Object.entries(contextTokensByCell))
    process.stdout.write(
      `mean ${cellName.padEnd(18)} view o200k=${c.meanView} toolContext o200k=${c.meanToolContext ?? 'n/a'} (${c.trials} trials)\n`,
    );
  if (!selfCheckOk) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
