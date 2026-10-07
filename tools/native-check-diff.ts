/**
 * The differential of the native checker (`a0 check` of dist/native/a0, tools/native-check.ts)
 * against the TypeScript checker (src/link.ts `link`, the path of `a0 check` in src/cli.ts) on
 * whole files of any size.
 *
 * A program is accepted by both or rejected by both with the same diagnostic class (parse,
 * structure, type, limit) and, when the TypeScript checker names a line, the same line of the
 * same file. A program the native checker cannot represent exits 65 ("unsupported", see
 * tools/native/a0.c `give_up`) and is listed with the reason; the command line then uses the
 * TypeScript checker, so a decline is never a wrong answer. `--lines` output (what the
 * TypeScript CLI prints for an accepted program) must be byte-identical.
 *
 * The program set: the compiler's own sources and the site programs (whole files, linked through
 * their `use` lines), the examples, the reject corpus, the generated corpus closures and kernels,
 * the front-end source set of tools/front-end-sources.ts, the 14 application-scale edit results
 * of tools/app-edit-tasks.ts, and mutants of the linked front end (a seeded edit of one line of a
 * program of 200 KB or more, so that the error falls in a late chunk).
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { A0Error, formatProgram, parseAndValidate } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { link } from '../src/link.js';
import { runTool } from '../src/toolchain.js';
import { extractBlock } from './ai-edit-apply.js';
import { startPrograms } from './app-edit-bench.js';
import { APP_TASKS } from './app-edit-tasks.js';
import { CORPUS_FUNCTIONS, CORPUS_SEED, closures, generateCorpus, makeRng } from './corpus.js';
import { KERNELS } from './exec-bench-kernels.js';
import { frontEndSources } from './front-end-sources.js';
import { ILL_TYPED } from './ref-check.js';

export interface Verdict {
  readonly ok: boolean;
  /** parse, structure, type or limit */
  readonly code?: string;
  readonly id?: string;
  readonly file?: string;
  readonly line?: number | null;
  /** A checker error: the function and node the diagnostic names (`f.a`, `f.ret`, `f`). */
  readonly at?: string;
}

export interface Program {
  readonly label: string;
  readonly path: string;
  /**
   * Two errors in one program: the checkers agree that it is rejected, but may name different ones
   * first (the self-hosted parser reports an undefined node, a parameter out of range and an op's
   * arity where src/core.ts reports them after the whole parse), so only the verdict is compared.
   */
  readonly mixed?: true;
}

const CODES = ['ok', 'parse', 'structure', 'type', 'limit'];

const norm = (p: string): string => resolve(p).replaceAll('\\', '/').toLowerCase();

/** What the TypeScript checker says about a file (the check path of src/cli.ts). */
export async function reference(path: string): Promise<Verdict> {
  try {
    await link(path, (p) => Promise.resolve(readFileSync(p, 'utf8')));
    return { ok: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, code: 'unreadable' };
    if (!(e instanceof A0Error)) throw e;
    const m = /^(.+?):(\d+): /.exec(e.message);
    // the validator names `fn.node` (or `fn`, `fn.ret`) first in its message; a parse error does not
    const named = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?[:. ]/.exec(
      m === null ? e.message : e.message.slice(m[0].length),
    );
    return {
      ok: false,
      code: e.code,
      ...(e.id === undefined ? {} : { id: e.id }),
      ...(named === null || e.code === 'parse' || /^(line|expected)\b/.test(named[0])
        ? {}
        : { at: named[2] === undefined ? named[1] : `${named[1]}.${named[2]}` }),
      ...(m === null
        ? { line: e.line ?? null }
        : { file: norm(m[1] as string), line: Number(m[2]) }),
    };
  }
}

export type Native =
  | { readonly kind: 'verdict'; readonly verdict: Verdict; readonly stderr: string }
  | { readonly kind: 'unsupported'; readonly why: string };

/** What the native checker says about a file. */
export function native(exe: string, path: string): Native {
  const r = runTool(exe, ['check', path], { timeoutMs: 600_000 });
  if (r.status === 0) return { kind: 'verdict', verdict: { ok: true }, stderr: '' };
  if (r.status === 65) {
    return { kind: 'unsupported', why: /unsupported \(([^)]*)\)/.exec(r.stderr)?.[1] ?? r.stderr };
  }
  if (r.status === 64)
    return { kind: 'verdict', verdict: { ok: false, code: 'unreadable' }, stderr: r.stderr };
  const m = /\((.+):(\d+)\)\s*$/m.exec(r.stderr);
  const code = r.status === null ? undefined : CODES[r.status];
  if (code === undefined || m === null)
    throw new Error(`${path}: unexpected native result (${r.status}): ${r.stderr.slice(0, 300)}`);
  const at = /^a0-at: (.*)$/m.exec(r.stderr);
  return {
    kind: 'verdict',
    verdict: {
      ok: false,
      code,
      file: norm(m[1] as string),
      line: Number(m[2]),
      ...(at === null ? {} : { at: at[1] as string }),
    },
    stderr: r.stderr,
  };
}

export interface Row {
  readonly label: string;
  readonly bytes: number;
  readonly reference: Verdict;
  readonly native: Verdict | 'unsupported';
  readonly why?: string;
  /** `same`, `unsupported` or the way they differ */
  readonly outcome: string;
}

/** Whether the native verdict equals the reference: accept or reject, class, and line. */
export function agree(ref: Verdict, nat: Verdict): string {
  if (ref.ok !== nat.ok)
    return `reference ${ref.ok ? 'accepts' : `rejects (${ref.code})`}, native ${nat.ok ? 'accepts' : `rejects (${nat.code})`}`;
  if (ref.ok) return 'same';
  // The self-hosted parser files some parse-phase errors under structure (A0014 too few operands),
  // so a token-located error compares as one class; a checker error (it names a node) exactly.
  // The checker phase of the native one also reports the arity of an op (A0014), which the
  // TypeScript parser reports first: compared by line then.
  const family = (c: string | undefined): string | undefined =>
    c === 'parse' || c === 'structure' ? 'parse-phase' : c;
  const arity = ref.code === 'parse' && nat.code === 'structure';
  const sameClass =
    nat.at === undefined || arity ? family(ref.code) === family(nat.code) : ref.code === nat.code;
  if (!sameClass) return `class ${ref.code} against ${nat.code}`;
  if (nat.at !== undefined && !arity) {
    // the TypeScript linker maps a node error to a line by the wording of its message (some
    // name the function's header), so the diagnostic is compared by the node it names
    if (ref.at !== undefined && ref.at !== nat.at) return `at ${ref.at} against ${nat.at}`;
    if (ref.file !== undefined && ref.file !== nat.file)
      return `file ${ref.file} against ${nat.file}`;
    return 'same';
  }
  if (ref.line !== null && ref.line !== undefined) {
    if (ref.file !== undefined && ref.file !== nat.file)
      return `file ${ref.file} against ${nat.file}`;
    // a node id defined twice: the linker shows the first definition, the parser stops at the second
    const dupId = ref.id === 'A0303' && (nat.line as number) >= ref.line;
    if (ref.line !== nat.line && !dupId) return `line ${ref.line} against ${nat.line}`;
  }
  return 'same';
}

export async function compare(exe: string, p: Program): Promise<Row> {
  const bytes = readFileSync(p.path).length;
  const ref = await reference(p.path);
  const nat = native(exe, p.path);
  if (nat.kind === 'unsupported')
    return {
      label: p.label,
      bytes,
      reference: ref,
      native: 'unsupported',
      why: nat.why,
      outcome: 'unsupported',
    };
  const outcome = p.mixed === true && !ref.ok && !nat.verdict.ok ? 'same' : agree(ref, nat.verdict);
  let result = outcome;
  if (outcome === 'same' && ref.ok) {
    // the lines of an accepted program: what the TypeScript CLI prints
    const lines = runTool(exe, ['check', '--lines', p.path], { timeoutMs: 600_000 });
    const expected = await tsLines(p.path);
    if (lines.stdout !== expected) result = 'lines differ';
  }
  return { label: p.label, bytes, reference: ref, native: nat.verdict, outcome: result };
}

/** The stdout of `a0 check FILE` for an accepted program (src/cli.ts). */
async function tsLines(path: string): Promise<string> {
  const { formatType } = await import('../src/core.js');
  const { revision } = await import('../src/edit.js');
  const program = (await link(path, (p) => Promise.resolve(readFileSync(p, 'utf8')))).program;
  return `${program.functions
    .map(
      (fn) =>
        `${fn.name} (${fn.params.map(formatType).join(', ')}) -> ${formatType(fn.result)}: ${fn.nodes.length} nodes, rev ${revision(fn).slice(0, 12)}`,
    )
    .join('\n')}\n`;
}

// --- the program set ------------------------------------------------------------------

const a0Files = (dir: string, skip: (f: string) => boolean = () => false): Program[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.a0') && !skip(f))
    .sort()
    .map((f) => ({ label: `${dir}/${f}`, path: join(dir, f) }));

/** Write programs given as text under `dir`; returns them as files. */
export function materialize(dir: string, texts: readonly (readonly [string, string])[]): Program[] {
  mkdirSync(dir, { recursive: true });
  return texts.map(([label, text], i) => {
    const path = join(
      dir,
      `${String(i).padStart(4, '0')}-${label.replace(/[^a-z0-9_.-]+/gi, '_')}.a0`,
    );
    writeFileSync(path, text, 'utf8');
    return { label, path };
  });
}

/** The 14 results of the application-scale edit tasks (the reference replies) and the start program. */
export async function appEditPrograms(): Promise<[string, string][]> {
  const programs = await startPrograms();
  const out: [string, string][] = [['app-edit/start', programs.a0]];
  for (const task of APP_TASKS) {
    const session = new EditSession(parseAndValidate(programs.a0));
    for (const f of task.a0Targets) session.open(f, { scope: 'deps' });
    session.openProgram({ scope: 'all', target: task.a0Targets[0] as string });
    const next = session.apply(extractBlock(task.reference.a0));
    out.push([`app-edit/${task.id}`, formatProgram(next)]);
  }
  return out;
}

/**
 * Mutants of a large linked program: one seeded edit of one line in the second half, so that the
 * diagnostic of the reference falls in a late chunk of the native check. Every kind of edit
 * changes a line without adding or removing a function, except `dup` (a function defined twice),
 * `late` (a callee moved below its caller by renaming) and `drop` (the ret line removed).
 */
export function mutants(text: string, count: number, seed: number): [string, string][] {
  const rng = makeRng(seed);
  const lines = text.split('\n');
  const out: [string, string][] = [];
  const bodyLine = (): number => {
    for (;;) {
      const i = Math.floor(lines.length / 2) + (rng() % Math.floor(lines.length / 2 - 2));
      const w = (lines[i] as string).trim().split(/\s+/);
      if (
        w.length >= 3 &&
        w[0] !== 'fn' &&
        w[0] !== 'ret' &&
        w[0] !== 'end' &&
        !w[0]?.startsWith('#')
      )
        return i;
    }
  };
  const kinds = [
    'op',
    'operand',
    'param',
    'ret',
    'arity',
    'type',
    'callee',
    'literal',
    'dup',
    'header',
    'drop',
    'token',
  ];
  for (let k = 0; k < count; k++) {
    const kind = kinds[k % kinds.length] as string;
    const copy = [...lines];
    const i = bodyLine();
    const w = (copy[i] as string).trim().split(/\s+/);
    switch (kind) {
      case 'op':
        w[1] = 'frobnicate';
        copy[i] = w.join(' ');
        break;
      case 'operand':
        w[w.length - 1] = 'nosuchnode';
        copy[i] = w.join(' ');
        break;
      case 'param':
        w[w.length - 1] = 'p99';
        copy[i] = w.join(' ');
        break;
      case 'ret': {
        let j = i;
        while (!(copy[j] as string).trim().startsWith('ret')) j += 1;
        copy[j] = 'ret nosuchnode';
        break;
      }
      case 'arity':
        copy[i] = w.slice(0, -1).join(' ');
        break;
      case 'type': {
        let j = i;
        while (!(copy[j] as string).startsWith('fn ')) j -= 1;
        copy[j] = (copy[j] as string).replace('-> u32', '-> bool');
        break;
      }
      case 'callee':
        if (w[1] === 'call' || w[1] === 'fold') w[2] = 'nosuchfn';
        else w[1] = 'call';
        copy[i] = w.join(' ');
        break;
      case 'literal':
        w[w.length - 1] = '4294967296';
        copy[i] = w.join(' ');
        break;
      case 'dup': {
        let j = i;
        while (!(copy[j] as string).startsWith('fn ')) j -= 1;
        copy.push(`fn ${(copy[j] as string).split(' ')[1]} -> u32`, 'ret 0', 'end');
        break;
      }
      case 'header': {
        let j = i;
        while (!(copy[j] as string).startsWith('fn ')) j -= 1;
        copy[j] = `${copy[j]} u32x`;
        break;
      }
      case 'drop': {
        let j = i;
        while (!(copy[j] as string).trim().startsWith('ret')) j += 1;
        copy.splice(j, 1);
        break;
      }
      default:
        copy[i] = `${copy[i]} @`;
    }
    out.push([`mutant-${kind}-${k}`, copy.join('\n')]);
  }
  return out;
}

/** Every program of the differential; texts are written under `dir`. */
export async function programSet(
  dir: string,
  mutantCount = 24,
  pairCount = 12,
): Promise<Program[]> {
  const corpus = generateCorpus(CORPUS_SEED, CORPUS_FUNCTIONS);
  const set: Program[] = [
    ...a0Files('compiler'),
    ...a0Files('site'),
    ...a0Files('examples'),
    ...a0Files('corpus/reject'),
    ...a0Files('corpus/reject/bases'),
  ];
  set.push(
    ...materialize(join(dir, 'texts'), [
      ...(await frontEndSources()),
      ...ILL_TYPED.map(([l, s]): [string, string] => [`ill-typed/${l}`, s]),
      ...closures('corpus', corpus),
      ...KERNELS.map((k): [string, string] => [`kernel/${k.name}`, k.a0]),
      ...(await appEditPrograms()),
    ]),
  );
  if (mutantCount > 0) {
    // the closure of compiler/check.a0 (207 KB): the front end's own checker, linked
    const linked = await link('compiler/check.a0', (p) => Promise.resolve(readFileSync(p, 'utf8')));
    set.push(...materialize(join(dir, 'mutants'), mutants(linked.text, mutantCount, 0xc0ffee)));
    // two edits of different kinds in one program
    const pairs: [string, string][] = [];
    for (let i = 0; i < pairCount; i += 1) {
      const first = mutants(linked.text, 12, 1000 + i)[i % 12] as [string, string];
      const second = mutants(first[1], 12, 5000 + i)[(i * 5 + 3) % 12] as [string, string];
      pairs.push([`pair-${first[0]}-${second[0]}`, second[1]]);
    }
    set.push(
      ...materialize(join(dir, 'pairs'), pairs).map((p): Program => ({ ...p, mixed: true })),
    );
  }
  return set;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'a0-native-diff-'));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export { relative };
