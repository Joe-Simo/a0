/**
 * The use-aware dense loader: the reference for reading A0 programs in dense form when they `use`
 * other files, and the comparison that checks it against the canonical path.
 *
 * A dense file calls functions that the files it `use`s define, and a call's arity is needed to
 * read it, so the dense text of a file cannot be parsed on its own (`parseDense` says
 * `unknown function`). The loader does what the canonical path does (src/link.ts): every used file
 * is loaded once, dependencies first, and each file is parsed with the parameter counts of the
 * functions its uses reach. `loadDense` is `link` with every file read as dense text.
 * `denseForms` writes the dense form of a canonical file tree with the same `use` lines and the
 * same arities, so the two paths can be compared file by file.
 *
 * The comparison covers every .a0 file of corpus/, examples/, compiler/ and site/:
 *   program  an accepted file (also corpus/reject/*.fixed.a0 and the bases). The dense tree of the
 *            file is loaded by the dense loader; its canonical text (formatProgram), its program
 *            revision and the revision of every function must equal the canonical path's. The
 *            dense form of the linked program must also read back to the same text and revision.
 *   reject   corpus/reject/NAME.a0 must be rejected by the canonical reader with its header id.
 *            Parity: the dense reader must reject it with the same A0 id. Two readings are kept:
 *            `dense` reads the file as written (the strict reading); `denseForm`, when the file
 *            parses, reads the dense form of the parsed program (the validator's rejects, without
 *            the surface). A mismatch is categorized: the dense surface accepts a spelling that
 *            canonical rejects (`dense-accepts`), the dense reader's error has no A0 id
 *            (`dense-no-id`), two different ids (`different-id`), the dense form cannot be
 *            written (`no-dense-form`), or the canonical reader accepts (`canonical-accepts`).
 * Everything found is written to results/dense-loader.json; an unmatched file carries its reason.
 *
 *   node dist/tools/dense-loader.js [--out=results/dense-loader.json]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A0Error, formatProgram, type Program, parse } from '../src/core.js';
import { formatDense, parseDense } from '../src/dense.js';
import { EXACT_FIXES } from '../src/diagnostics.js';
import { programRevision, revision } from '../src/edit.js';
import { type Linked, link } from '../src/link.js';
import { reportJson } from './scrub-results.js';

/** Reads the text of one file; the loader keys every file by `keyOf(path)`. */
export type Read = (path: string) => Promise<string>;

/** The key link uses for a path: its realpath when it exists, else the resolved path. */
export async function keyOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw e;
  }
}

/**
 * The dense form of every file the entries use (the entries included), keyed by `keyOf`. Each
 * file's own text is written as dense text with its `use` lines kept and its calls printed with the
 * parameter counts of the functions its uses reach (the arities a dense reader needs). Files shared
 * by several entries are written once. `failures` gets the error of every entry whose tree cannot
 * be written, so one bad file does not stop the others.
 */
export async function denseForms(
  entries: readonly string[],
  read: Read,
  failures: Map<string, string> = new Map(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const closure = new Map<string, ReadonlyMap<string, number>>();
  const visiting = new Set<string>();
  const visit = async (path: string): Promise<ReadonlyMap<string, number>> => {
    const abs = await keyOf(path);
    const done = closure.get(abs);
    if (done !== undefined) return done;
    if (visiting.has(abs)) throw new Error(`use cycle through ${abs}`);
    visiting.add(abs);
    try {
      const program: Program = parse(await read(abs));
      const known = new Map<string, number>();
      for (const use of program.uses ?? []) {
        for (const [name, n] of await visit(resolve(dirname(abs), use))) known.set(name, n);
      }
      out.set(abs, formatDense(program, { known }));
      const all = new Map([
        ...known,
        ...program.functions.map((f) => [f.name, f.params.length] as const),
      ]);
      closure.set(abs, all);
      return all;
    } finally {
      visiting.delete(abs);
    }
  };
  for (const entry of entries) {
    try {
      await visit(entry);
    } catch (e) {
      failures.set(entry, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

/** A reader over dense texts keyed by `keyOf`; a file that has no dense text is an error. */
export function denseReader(dense: ReadonlyMap<string, string>): Read {
  return async (path) => {
    const text = dense.get(path);
    if (text === undefined) throw new Error(`no dense text for ${path}`);
    return text;
  };
}

/**
 * The dense loader: `entry` and everything it uses, every file read as dense text. Parsing is
 * use-aware exactly as in the canonical linker, and the result is validated as a whole.
 */
export function loadDense(entry: string, read: Read, root: string): Promise<Linked> {
  return link(entry, read, { root, dense: true });
}

/** The canonical path: the same entry read as canonical text. */
export function loadCanonical(entry: string, root: string): Promise<Linked> {
  return link(entry, (p) => readFile(p, 'utf8'), { root });
}

/** Repository root, from dist/tools or tools. */
export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ...(dirname(fileURLToPath(import.meta.url)).endsWith(join('dist', 'tools'))
    ? ['..', '..']
    : ['..']),
);

/** The directories whose .a0 files are compared. */
export const SCOPE: readonly string[] = ['corpus', 'examples', 'compiler', 'site'];

/** Every .a0 file under the scope directories, sorted (no dist, results, node_modules, dot dirs). */
export function listSources(root: string = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === 'dist' || name === 'results' || name.startsWith('.'))
        continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.a0')) out.push(p);
    }
  };
  for (const d of SCOPE) walk(join(root, d));
  return out.sort();
}

/** `corpus/reject/NAME.a0`: a program the checker must reject (not a fixed or base program). */
export function isReject(abs: string, root: string = ROOT): boolean {
  const rel = relative(root, abs).split(sep).join('/');
  return rel.startsWith('corpus/reject/') && !rel.endsWith('.fixed.a0') && !rel.includes('/bases/');
}

/** The reject header `# err: A0nnnn LINE` on line 1 of a corpus/reject file. */
function headerId(text: string): string | null {
  return /^# err: (A0[0-9]{3}) /.exec(text.split('\n')[0] ?? '')?.[1] ?? null;
}

/** A load's outcome: the program, or the diagnostic that rejected it (`id` null: no A0 id). */
export type Attempt =
  | { readonly ok: true; readonly linked: Linked }
  | {
      readonly ok: false;
      readonly id: string | null;
      readonly line: number | null;
      /** The message without the file path and line the linker adds. */
      readonly message: string;
    };

/**
 * The line and the message of a diagnostic. A0Error keeps the line apart from its message; a
 * diagnostic the linker rewrote names `path:LINE: ` inside the message, which is split off here.
 */
function located(e: A0Error): { line: number | null; message: string } {
  if (e.line !== undefined) return { line: e.line, message: e.detail };
  const m = /^(.*?):(\d+): ([\s\S]*)$/.exec(e.detail);
  if (m === null) return { line: null, message: e.detail };
  return { line: Number(m[2]), message: m[3] as string };
}

/** Runs a load and turns a rejection into its diagnostic; anything that is not a diagnostic rethrows. */
async function attempt(load: () => Promise<Linked>): Promise<Attempt> {
  try {
    return { ok: true, linked: await load() };
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
    return { ok: false, id: e.id ?? null, ...located(e) };
  }
}

const EXACT_FIX_IDS: ReadonlySet<string> = new Set(EXACT_FIXES.map((f) => f.id));

export interface ProgramOutcome {
  readonly path: string;
  readonly kind: 'program';
  readonly status: 'match' | 'unmatched';
  /** Files the entry loads (itself and its uses, transitively). */
  readonly loaded: number;
  readonly functions: number;
  /** The canonical path's program revision (absent when the canonical reader rejects the entry). */
  readonly programRevision?: string;
  /** The dense form of the linked program reads back to the same text and revisions. */
  readonly linkedDense: 'match' | 'unmatched';
  readonly reason?: string;
}

export interface Diagnostic {
  readonly accepted: boolean;
  readonly id?: string | null;
  readonly line?: number | null;
  readonly message?: string;
}

export interface RejectReading {
  readonly status: 'match' | 'unmatched';
  readonly category?: string;
  readonly reason?: string;
  /** What the dense reader said (absent when no dense text could be written). */
  readonly dense?: Diagnostic;
}

export interface RejectOutcome {
  readonly path: string;
  readonly kind: 'reject';
  readonly status: 'match' | 'unmatched';
  readonly category?: string;
  readonly reason?: string;
  readonly header: string | null;
  readonly canonical: Diagnostic;
  /** What the dense reader said about the file as written (the strict reading above). */
  readonly dense?: Diagnostic;
  /** Present when the file parses: the dense reader reads the dense form of the parsed program. */
  readonly denseForm?: RejectReading;
}

export type FileOutcome = ProgramOutcome | RejectOutcome;

function diagnosticOf(a: Attempt): Diagnostic {
  return a.ok
    ? { accepted: true }
    : { accepted: false, id: a.id, line: a.line, message: a.message };
}

/** Why two programs differ, or undefined when their canonical text and every revision agree. */
export function mismatch(a: Program, b: Program): string | undefined {
  if (formatProgram(a) !== formatProgram(b)) return 'canonical text differs';
  if (programRevision(a) !== programRevision(b)) return 'program revision differs';
  if (a.functions.length !== b.functions.length) return 'function count differs';
  for (const [i, f] of a.functions.entries()) {
    const g = b.functions[i];
    if (g === undefined || g.name !== f.name) return `function order differs at ${f.name}`;
    if (revision(f) !== revision(g)) return `revision of ${f.name} differs`;
  }
  return undefined;
}

/** The dense form of a linked program reads back to the same canonical text and revisions. */
function linkedDenseReason(program: Program): string | undefined {
  try {
    return mismatch(program, parseDense(formatDense(program)));
  } catch (e) {
    if (e instanceof A0Error) return `dense form of the linked program: ${e.message}`;
    throw e;
  }
}

/** Compares one accepted program: the dense path against the canonical path, text and revisions. */
export function judgeProgram(path: string, canonical: Linked, dense: Attempt): ProgramOutcome {
  const linkedReason = linkedDenseReason(canonical.program);
  const base = {
    path,
    kind: 'program' as const,
    loaded: canonical.sources.length,
    functions: canonical.program.functions.length,
    programRevision: programRevision(canonical.program),
    linkedDense: linkedReason === undefined ? ('match' as const) : ('unmatched' as const),
  };
  const reason = dense.ok
    ? mismatch(canonical.program, dense.linked.program)
    : `dense reader: ${dense.id ?? 'no id'} ${dense.message}`;
  const problems = [reason, linkedReason].filter((r): r is string => r !== undefined);
  if (problems.length > 0) return { ...base, status: 'unmatched', reason: problems.join('; ') };
  return { ...base, status: 'match' };
}

/**
 * Parity of one reject: the dense reader must reject with the same A0 id the canonical reader
 * rejects with. A canonical reader that accepts a reject file is a category of its own.
 */
export function judgeReject(canonical: Attempt, dense: Attempt): RejectReading {
  const d = diagnosticOf(dense);
  if (canonical.ok)
    return {
      status: 'unmatched',
      category: 'canonical-accepts',
      reason: 'the canonical reader accepts a file the checker must reject',
      dense: d,
    };
  if (dense.ok)
    return {
      status: 'unmatched',
      category: 'dense-accepts',
      reason: `the dense reader accepts the text the canonical reader rejects with ${canonical.id}${
        canonical.id !== null && EXACT_FIX_IDS.has(canonical.id)
          ? ' (a spelling the dense view reads by design: an exact fix)'
          : ''
      }`,
      dense: d,
    };
  if (dense.id === null)
    return {
      status: 'unmatched',
      category: 'dense-no-id',
      reason: `the dense reader rejects with no diagnostic id (${dense.message}); canonical ${canonical.id}`,
      dense: d,
    };
  if (dense.id !== canonical.id)
    return {
      status: 'unmatched',
      category: 'different-id',
      reason: `canonical rejects with ${canonical.id}, dense with ${dense.id}`,
      dense: d,
    };
  return { status: 'match', dense: d };
}

/** A reject file, read by the canonical reader and by the dense reader (as written and as a form). */
export async function compareReject(path: string, root: string = ROOT): Promise<RejectOutcome> {
  const abs = await keyOf(path);
  const text = readFileSync(abs, 'utf8');
  const canonical = await attempt(() => loadCanonical(abs, root));
  const asWritten = await attempt(() => loadDense(abs, (p) => readFile(p, 'utf8'), root));
  const reading = judgeReject(canonical, asWritten);
  let denseForm: RejectOutcome['denseForm'];
  let parsed: Program | undefined;
  try {
    parsed = parse(text);
  } catch (e) {
    if (!(e instanceof A0Error)) throw e;
  }
  if (parsed !== undefined) {
    try {
      const form = formatDense(parsed);
      const formDiag = await attempt(() =>
        loadDense(abs, denseReader(new Map([[abs, form]])), root),
      );
      denseForm = judgeReject(canonical, formDiag);
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
      denseForm = {
        status: 'unmatched',
        category: 'no-dense-form',
        reason: `the dense form cannot be written: ${located(e).message}`,
      };
    }
  }
  const rel = relative(root, abs).split(sep).join('/');
  return {
    path: rel,
    kind: 'reject',
    status: reading.status,
    ...(reading.category === undefined ? {} : { category: reading.category }),
    ...(reading.reason === undefined ? {} : { reason: reading.reason }),
    header: headerId(text),
    canonical: diagnosticOf(canonical),
    ...(reading.dense === undefined ? {} : { dense: reading.dense }),
    ...(denseForm === undefined ? {} : { denseForm }),
  };
}

export interface Report {
  readonly tool: string;
  readonly reader: string;
  readonly scope: readonly string[];
  readonly summary: {
    readonly programs: number;
    readonly programsMatched: number;
    readonly programsUnmatched: number;
    readonly programReasons: Readonly<Record<string, number>>;
    readonly rejects: number;
    readonly rejectsMatched: number;
    readonly rejectsUnmatched: number;
    readonly rejectCategories: Readonly<Record<string, number>>;
    readonly rejectsHeaderMatched: number;
    readonly rejectsParsed: number;
    readonly rejectsFormMatched: number;
    readonly rejectFormCategories: Readonly<Record<string, number>>;
  };
  readonly files: readonly FileOutcome[];
}

function countBy(values: readonly (string | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) if (v !== undefined) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Runs the whole comparison over the repository and returns the report. */
export async function runComparison(root: string = ROOT): Promise<Report> {
  const sources = listSources(root).map((p) => resolve(p));
  const programs = sources.filter((p) => !isReject(p, root));
  const rejects = sources.filter((p) => isReject(p, root));
  const failures = new Map<string, string>();
  const dense = await denseForms(programs, (p) => readFile(p, 'utf8'), failures);
  const denseRead = denseReader(dense);
  const files: FileOutcome[] = [];
  for (const abs of programs) {
    const rel = relative(root, abs).split(sep).join('/');
    const canonical = await attempt(() => loadCanonical(abs, root));
    if (!canonical.ok) {
      files.push({
        path: rel,
        kind: 'program',
        status: 'unmatched',
        loaded: 0,
        functions: 0,
        linkedDense: 'unmatched',
        reason: `canonical reader: ${canonical.id} ${canonical.message}`,
      });
      continue;
    }
    const buildError = failures.get(abs);
    const loaded =
      buildError === undefined
        ? await attempt(() => loadDense(abs, denseRead, root))
        : { ok: false as const, id: null, line: null, message: `dense form: ${buildError}` };
    files.push(judgeProgram(rel, canonical.linked, loaded));
  }
  for (const abs of rejects) files.push(await compareReject(abs, root));

  const progs = files.filter((f): f is ProgramOutcome => f.kind === 'program');
  const rej = files.filter((f): f is RejectOutcome => f.kind === 'reject');
  const forms = rej.flatMap((f) => (f.denseForm === undefined ? [] : [f.denseForm]));
  return {
    tool: 'tools/dense-loader.ts',
    reader:
      'dense: each file of the entry tree written as dense text (its use lines kept, its calls typed by the arities its uses reach) and loaded by link with dense: true. canonical: link on the .a0 files. rejects: the dense reader reads the file as written (and the dense form of the parsed program, when the file parses).',
    scope: [...SCOPE],
    summary: {
      programs: progs.length,
      programsMatched: progs.filter((f) => f.status === 'match').length,
      programsUnmatched: progs.filter((f) => f.status === 'unmatched').length,
      programReasons: countBy(progs.map((f) => (f.status === 'unmatched' ? f.reason : undefined))),
      rejects: rej.length,
      rejectsMatched: rej.filter((f) => f.status === 'match').length,
      rejectsUnmatched: rej.filter((f) => f.status === 'unmatched').length,
      rejectCategories: countBy(rej.map((f) => f.category)),
      rejectsHeaderMatched: rej.filter(
        (f) => f.canonical.accepted === false && f.canonical.id === f.header,
      ).length,
      rejectsParsed: forms.length,
      rejectsFormMatched: forms.filter((f) => f.status === 'match').length,
      rejectFormCategories: countBy(forms.map((f) => f.category)),
    },
    files,
  };
}

function main(): void {
  const out =
    process.argv.find((a) => a.startsWith('--out='))?.slice(6) ??
    join(ROOT, 'results', 'dense-loader.json');
  runComparison()
    .then((report) => {
      writeFileSync(out, reportJson(report), 'utf8');
      const s = report.summary;
      process.stderr.write(
        `programs ${s.programsMatched}/${s.programs} matched; rejects ${s.rejectsMatched}/${s.rejects} matched (form ${s.rejectsFormMatched}/${s.rejectsParsed}); wrote ${out}\n`,
      );
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
