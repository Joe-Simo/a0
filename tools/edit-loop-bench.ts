/**
 * Edit-loop validation latency: for each accepted set-C edit, the wall-clock time from
 * "model reply received" to "edit applied and the whole program known to type-check".
 * This is the inner-loop cost an AI agent pays after every edit, before tests run.
 *
 * Inputs are the actual accepted replies of the set-C collections
 * (results/ai-edit-experiment.c.{sonnet,haiku}-min.json; the reply texts are the scripted
 * reply files results/ai-edit-experiment.c.{sonnet,haiku}-min.replies.json). Every
 * accepted trial in those collections was accepted on its first reply, so the timed reply
 * is the first reply of each accepted trial. Go has no collected replies: its edits are
 * hand translations of the reference edits (tools/edit-loop-go.ts).
 *
 * Timed paths (each sample includes extracting the reply's code block and applying it):
 *   a0.structured     EditSession.apply in-process (parse edit, type-check, commit)
 *   a0.conventional   parseAndValidate of the whole replied file, in-process
 *   ts.cold           write file + `tsc --noEmit -p` (new Node process)
 *   ts.warm           LanguageService kept alive in-process: new file version, then
 *                     syntactic + semantic diagnostics (the best case for TypeScript)
 *   rust.cold         write file + `rustc --emit=metadata --crate-type lib` (check only)
 *   rust.warm         write src/lib.rs + `cargo check` in a crate already checked once
 *   go.build.cold     `go build` with an empty GOCACHE
 *   go.build.warm     `go build` with a warm GOCACHE (a unique comment defeats the
 *                     content cache, so the package itself is always recompiled)
 *   go.vet.warm       `go vet` with the warm GOCACHE
 * Warm paths are reset to the original program (untimed) before each sample, so every
 * sample is one incremental edit from the same starting point.
 *
 * Python/mypy is not measured when mypy is not installed (recorded in the report).
 * Env: A0_EDIT_LOOP_REPS (default 7).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { formatDiagnostic, parseAndValidate, type Type, type Value } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { runTool } from '../src/toolchain.js';
import { applyTs, extractBlock } from './ai-edit-apply.js';
import { TASKS_A } from './ai-edit-tasks-a.js';
import { TASKS_B, type Task } from './ai-edit-tasks-b.js';
import { buildTasksC } from './ai-edit-tasks-c.js';
import { GO_EDITS, goFile } from './edit-loop-go.js';
import { writeReport } from './scrub-results.js';

type Kind =
  | 'a0.structured'
  | 'a0.conventional'
  | 'ts.cold'
  | 'ts.warm'
  | 'rust.cold'
  | 'rust.warm'
  | 'go.build.cold'
  | 'go.build.warm'
  | 'go.vet.warm';

const KINDS: readonly Kind[] = [
  'a0.structured',
  'a0.conventional',
  'ts.cold',
  'ts.warm',
  'rust.cold',
  'rust.warm',
  'go.build.cold',
  'go.build.warm',
  'go.vet.warm',
];

/** Which collected cell supplies the reply (and the output tokens) for each path. */
const CELL: Readonly<Record<Kind, string | undefined>> = {
  'a0.structured': 'a0/structured',
  'a0.conventional': 'a0/conventional',
  'ts.cold': 'ts/structured',
  'ts.warm': 'ts/structured',
  'rust.cold': 'rust/structured',
  'rust.warm': 'rust/structured',
  'go.build.cold': undefined,
  'go.build.warm': undefined,
  'go.vet.warm': undefined,
};

/** Assumed model output rate for the derived end-to-end figure (tokens per second). */
const OUTPUT_TOKENS_PER_SECOND = 80;

interface CollectionTrial {
  readonly task: string;
  readonly representation: string;
  readonly protocol: string;
  readonly accepted: boolean | null;
  readonly attempts: readonly {
    readonly status: string;
    readonly outputTokensLocal: Record<string, number>;
  }[];
}

interface Edit {
  readonly task: Task;
  /** Reply text per cell key "rep/protocol" (accepted first replies only). */
  readonly replies: ReadonlyMap<string, string>;
  readonly outputTokens: ReadonlyMap<string, number>;
}

const TS_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts'],
  types: [],
  typeRoots: [],
  noEmit: true,
};

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: 'es2022',
    module: 'es2022',
    moduleResolution: 'bundler',
    lib: ['es2022'],
    types: [],
    typeRoots: [],
    noEmit: true,
  },
  files: ['mod.ts'],
});

// --- Warm TypeScript: one LanguageService over one in-memory file --------------------

class WarmTs {
  readonly #file: string;
  #text = '';
  #version = 0;
  readonly #service: ts.LanguageService;

  constructor(dir: string) {
    this.#file = join(dir, 'mod.ts');
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => TS_OPTIONS,
      getScriptFileNames: () => [this.#file],
      getScriptVersion: (f) => (f === this.#file ? String(this.#version) : '0'),
      getScriptSnapshot: (f) => {
        if (f === this.#file) return ts.ScriptSnapshot.fromString(this.#text);
        const text = ts.sys.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => dir,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => f === this.#file || ts.sys.fileExists(f),
      readFile: (f) => (f === this.#file ? this.#text : ts.sys.readFile(f)),
    };
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /** Replace the file and return its diagnostics (empty = type-checks). */
  check(text: string): readonly string[] {
    this.#text = text;
    this.#version += 1;
    const diags = [
      ...this.#service.getSyntacticDiagnostics(this.#file),
      ...this.#service.getSemanticDiagnostics(this.#file),
    ];
    return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  }
}

// --- Helpers ---------------------------------------------------------------------------

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

const median = (xs: readonly number[]): number =>
  quantile(
    [...xs].sort((a, b) => a - b),
    0.5,
  );
const round = (x: number, d = 3): number => Math.round(x * 10 ** d) / 10 ** d;

function uptime(): string {
  const r = runTool('/usr/bin/uptime', []);
  return r.stdout.trim();
}

/** Go literal for an A0 value of type `t` (fixed arrays; records as Pair / Tagged). */
function goLiteral(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return `uint32(${v})`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v) && t !== undefined && typeof t !== 'string') {
    if (t.kind === 'arr') return `[${v.length}]uint32{${v.map((x) => String(x)).join(', ')}}`;
    const fields = t.kind === 'rec' ? t.fields : [];
    const tagged = fields[1] === 'bool';
    return `${tagged ? 'Tagged' : 'Pair'}{${v.map((x, i) => goLiteral(x, fields[i])).join(', ')}}`;
  }
  return 'uint32(0)';
}

/** Runs the task's acceptance tests against the Go edit (untimed fidelity check). */
async function goAccept(task: Task, dir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const typed = parseAndValidate(task.reference.a0);
  const checks = task.tests.map((c, i) => {
    const fn = typed.byName.get(c.fn);
    const args = c.args.map((a, k) => goLiteral(a, fn?.params[k])).join(', ');
    return `\tif got := ${c.fn}(${args}); got != (${goLiteral(c.expected, fn?.result)}) {\n\t\tt.Errorf("case ${i}: %v", got)\n\t}`;
  });
  const test = `package project\n\nimport "testing"\n\nfunc TestAccept(t *testing.T) {\n${checks.join('\n')}\n}\n`;
  await writeFile(join(dir, 'lib.go'), goFile(GO_EDITS[task.id]), 'utf8');
  await writeFile(join(dir, 'accept_test.go'), test, 'utf8');
  const r = runTool('go', ['test', '-count=1', './...'], { cwd: dir, env, timeoutMs: 300_000 });
  await rm(join(dir, 'accept_test.go'));
  return r.ok ? [] : [`${task.id}: ${(r.stdout + r.stderr).slice(0, 400)}`];
}

async function loadEdits(model: string, tasks: readonly Task[]): Promise<Edit[]> {
  const collection = JSON.parse(
    await readFile(`results/ai-edit-experiment.c.${model}-min.json`, 'utf8'),
  ) as { trials: CollectionTrial[] };
  const replies = JSON.parse(
    await readFile(`results/ai-edit-experiment.c.${model}-min.replies.json`, 'utf8'),
  ) as Record<string, string[]>;
  return tasks.map((task) => {
    const r = new Map<string, string>();
    const tok = new Map<string, number>();
    for (const t of collection.trials) {
      if (t.task !== task.id || t.accepted !== true || t.attempts[0]?.status !== 'ok') continue;
      const cell = `${t.representation}/${t.protocol}`;
      const reply = replies[`${task.id}/${cell}`]?.[0];
      if (reply === undefined) throw new Error(`no recorded reply for ${task.id}/${cell}`);
      r.set(cell, reply);
      tok.set(cell, t.attempts[0].outputTokensLocal.o200k_base ?? 0);
    }
    return { task, replies: r, outputTokens: tok };
  });
}

// --- Main --------------------------------------------------------------------------------

interface Row {
  readonly kind: Kind;
  readonly tasks: number;
  readonly medianMs: number;
  readonly p90Ms: number;
  readonly totalMs: number;
  readonly medianRatioVsA0Structured: number;
  readonly totalRatioVsA0Structured: number;
  readonly endToEnd?: {
    readonly medianOutputTokens: number;
    readonly medianMs: number;
    readonly totalMs: number;
  };
}

async function main(): Promise<void> {
  const reps = Number(process.env.A0_EDIT_LOOP_REPS ?? '7');
  const tasks = buildTasksC(TASKS_A, TASKS_B);
  const home = process.env.HOME ?? '';
  const rustc = `${home}/.cargo/bin/rustc`;
  const cargo = `${home}/.cargo/bin/cargo`;
  const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  const goPath = runTool('/usr/bin/which', ['go']).stdout.trim();
  const mypy = runTool('/usr/bin/which', ['mypy']);
  const versions = {
    node: process.version,
    typescript: ts.version,
    rustc: runTool(rustc, ['--version']).stdout.trim(),
    cargo: runTool(cargo, ['--version']).stdout.trim(),
    go: goPath.length > 0 ? runTool(goPath, ['version']).stdout.trim() : null,
    mypy: mypy.ok ? runTool(mypy.stdout.trim(), ['--version']).stdout.trim() : null,
  };

  const root = await mkdtemp(join(tmpdir(), 'a0-edit-loop-'));
  try {
    const tsDir = join(root, 'ts');
    const rustDir = join(root, 'rust');
    const crate = join(root, 'crate');
    const goDir = join(root, 'go');
    const goCache = join(root, 'gocache');
    for (const d of [tsDir, rustDir, join(crate, 'src'), goDir, goCache])
      await mkdir(d, { recursive: true });
    await writeFile(join(tsDir, 'tsconfig.json'), TSCONFIG, 'utf8');
    await writeFile(
      join(crate, 'Cargo.toml'),
      '[package]\nname = "project"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
      'utf8',
    );
    await writeFile(join(goDir, 'go.mod'), 'module project\n\ngo 1.22\n', 'utf8');
    const goEnv = { ...process.env, GOCACHE: goCache, GOFLAGS: '-mod=mod', GOWORK: 'off' };
    const original = tasks[0] as Task;
    const warmTs = new WarmTs(tsDir);
    const resetWarm = async (): Promise<void> => {
      if (warmTs.check(original.tsSource).length > 0) throw new Error('original TS fails');
      await writeFile(join(crate, 'src', 'lib.rs'), original.rustSource, 'utf8');
      const c = runTool(cargo, ['check', '-q', '--offline'], { cwd: crate, timeoutMs: 300_000 });
      if (!c.ok) throw new Error(`cargo check (original): ${c.stderr}`);
    };
    // Prime every warm path on the original program (untimed).
    await resetWarm();
    await writeFile(join(goDir, 'lib.go'), goFile(), 'utf8');
    if (!runTool('go', ['vet', './...'], { cwd: goDir, env: goEnv, timeoutMs: 300_000 }).ok)
      throw new Error('go vet (original) failed');

    // Fidelity: the Go edits pass the same acceptance tests (untimed).
    const goFailures: string[] = [];
    if (goPath.length > 0)
      for (const t of tasks) goFailures.push(...(await goAccept(t, goDir, goEnv)));
    if (goFailures.length > 0)
      throw new Error(`Go translation fails acceptance:\n${goFailures.join('\n')}`);

    let uniq = 0;
    const measure = async (kind: Kind, edit: Edit): Promise<number | undefined> => {
      const cell = CELL[kind];
      const reply = cell === undefined ? undefined : edit.replies.get(cell);
      if (cell !== undefined && reply === undefined) return undefined;
      const task = edit.task;
      const fail = (why: string): never => {
        throw new Error(`${kind} ${task.id}: ${why}`);
      };
      switch (kind) {
        case 'a0.structured': {
          const session = new EditSession(parseAndValidate(task.a0Source));
          session.open(task.target ?? '', { scope: 'deps' });
          session.openProgram();
          const t0 = performance.now();
          try {
            session.apply(extractBlock(reply as string));
          } catch (e) {
            fail(formatDiagnostic(e));
          }
          return performance.now() - t0;
        }
        case 'a0.conventional': {
          const t0 = performance.now();
          try {
            parseAndValidate(extractBlock(reply as string));
          } catch (e) {
            fail(formatDiagnostic(e));
          }
          return performance.now() - t0;
        }
        case 'ts.cold': {
          const t0 = performance.now();
          const applied = applyTs('structured', task.tsSource, reply as string, 'e0');
          if (applied.error !== undefined) fail(applied.error);
          await writeFile(join(tsDir, 'mod.ts'), applied.source, 'utf8');
          const r = runTool(
            process.execPath,
            [tsc, '--noEmit', '-p', join(tsDir, 'tsconfig.json')],
            {
              cwd: tsDir,
            },
          );
          const ms = performance.now() - t0;
          if (!r.ok) fail(r.stdout.slice(0, 400));
          return ms;
        }
        case 'ts.warm': {
          const t0 = performance.now();
          const applied = applyTs('structured', task.tsSource, reply as string, 'e0');
          if (applied.error !== undefined) fail(applied.error);
          const diags = warmTs.check(applied.source);
          const ms = performance.now() - t0;
          if (diags.length > 0) fail(diags.join('; '));
          return ms;
        }
        case 'rust.cold': {
          const t0 = performance.now();
          const applied = applyTs('structured', task.rustSource, reply as string, 'e0');
          if (applied.error !== undefined) fail(applied.error);
          const file = join(rustDir, 'lib.rs');
          await writeFile(file, applied.source, 'utf8');
          const r = runTool(
            rustc,
            [
              '--edition',
              '2021',
              '--crate-type',
              'lib',
              '--crate-name',
              'project',
              '--emit=metadata',
              '-A',
              'warnings',
              '--out-dir',
              rustDir,
              file,
            ],
            { cwd: rustDir },
          );
          const ms = performance.now() - t0;
          if (!r.ok) fail(r.stderr.slice(0, 400));
          return ms;
        }
        case 'rust.warm': {
          const t0 = performance.now();
          const applied = applyTs('structured', task.rustSource, reply as string, 'e0');
          if (applied.error !== undefined) fail(applied.error);
          await writeFile(join(crate, 'src', 'lib.rs'), applied.source, 'utf8');
          const r = runTool(cargo, ['check', '-q', '--offline'], { cwd: crate });
          const ms = performance.now() - t0;
          if (!r.ok) fail(r.stderr.slice(0, 400));
          return ms;
        }
        case 'go.build.cold':
        case 'go.build.warm':
        case 'go.vet.warm': {
          uniq += 1;
          const env =
            kind === 'go.build.cold' ? { ...goEnv, GOCACHE: join(root, `gocold${uniq}`) } : goEnv;
          const args = kind === 'go.vet.warm' ? ['vet', './...'] : ['build', './...'];
          const t0 = performance.now();
          // The unique trailing comment changes the content hash, so the build cache can
          // never replay an earlier result for this package.
          await writeFile(
            join(goDir, 'lib.go'),
            `${goFile(GO_EDITS[task.id])}// sample ${uniq}\n`,
            'utf8',
          );
          const r = runTool('go', args, { cwd: goDir, env, timeoutMs: 300_000 });
          const ms = performance.now() - t0;
          if (!r.ok) fail(r.stderr.slice(0, 400));
          if (kind === 'go.build.cold') await rm(env.GOCACHE, { recursive: true, force: true });
          return ms;
        }
      }
    };

    const models = ['sonnet', 'haiku'] as const;
    const groups = new Map<string, Edit[]>();
    for (const m of models) groups.set(m, await loadEdits(m, tasks));
    // samples[model][kind][taskId] = ms[]
    const samples = new Map<string, Map<Kind, Map<string, number[]>>>();
    for (const m of models)
      samples.set(m, new Map(KINDS.map((k) => [k, new Map<string, number[]>()])));
    const load: { rep: number; before: string; after: string; loadavg: number[] }[] = [];
    // Warm-up round (discarded): JIT, file cache, toolchain binaries.
    for (const e of groups.get('sonnet') ?? []) {
      for (const k of KINDS) {
        await measure(k, e);
        if (k === 'ts.warm' || k === 'rust.warm') await resetWarm();
      }
    }
    for (let rep = 0; rep < reps; rep += 1) {
      const before = uptime();
      let slot = 0;
      for (const m of models) {
        for (const e of groups.get(m) ?? []) {
          // Interleave: rotate the path order per (rep, task) so no path always runs first.
          const order = KINDS.map((_, i) => KINDS[(i + rep + slot) % KINDS.length] as Kind);
          slot += 1;
          for (const k of order) {
            // Go and the reference edits do not depend on the model: measure them once
            // per rep, in the sonnet group.
            if (CELL[k] === undefined && m !== 'sonnet') continue;
            const ms = await measure(k, e);
            if (k === 'ts.warm' || k === 'rust.warm') await resetWarm();
            if (ms === undefined) continue;
            const byTask = samples.get(m)?.get(k);
            byTask?.set(e.task.id, [...(byTask.get(e.task.id) ?? []), ms]);
          }
        }
      }
      load.push({ rep, before, after: uptime(), loadavg: loadavg().map((x) => round(x, 2)) });
      process.stdout.write(`rep ${rep + 1}/${reps} done; ${load[load.length - 1]?.after}\n`);
    }

    const report: Record<string, unknown> = {};
    for (const m of models) {
      const edits = groups.get(m) ?? [];
      const perKind = samples.get(m) as Map<Kind, Map<string, number[]>>;
      const taskMedians = (k: Kind): Map<string, number> =>
        new Map(
          [...(perKind.get(k) ?? new Map<string, number[]>())].map(([id, xs]) => [id, median(xs)]),
        );
      const baseMedian = median([...taskMedians('a0.structured').values()]);
      const baseTotal = [...taskMedians('a0.structured').values()].reduce((a, b) => a + b, 0);
      const rows: Row[] = [];
      for (const k of KINDS) {
        const med = taskMedians(k);
        const vals = [...med.values()].sort((a, b) => a - b);
        if (vals.length === 0) continue;
        const total = vals.reduce((a, b) => a + b, 0);
        const cell = CELL[k];
        let endToEnd: Row['endToEnd'];
        if (cell !== undefined) {
          const e2e: number[] = [];
          const toks: number[] = [];
          for (const e of edits) {
            const tok = e.outputTokens.get(cell);
            const v = med.get(e.task.id);
            if (tok === undefined || v === undefined) continue;
            toks.push(tok);
            e2e.push((tok / OUTPUT_TOKENS_PER_SECOND) * 1000 + v);
          }
          endToEnd = {
            medianOutputTokens: median(toks),
            medianMs: round(median(e2e), 1),
            totalMs: round(
              e2e.reduce((a, b) => a + b, 0),
              1,
            ),
          };
        }
        rows.push({
          kind: k,
          tasks: vals.length,
          medianMs: round(quantile(vals, 0.5)),
          p90Ms: round(quantile(vals, 0.9)),
          totalMs: round(total),
          medianRatioVsA0Structured: round(quantile(vals, 0.5) / baseMedian, 1),
          totalRatioVsA0Structured: round(total / baseTotal, 1),
          ...(endToEnd === undefined ? {} : { endToEnd }),
        });
      }
      report[m] = {
        acceptedEditsPerCell: Object.fromEntries(
          ['a0/structured', 'a0/conventional', 'ts/structured', 'rust/structured'].map((c) => [
            c,
            edits.filter((e) => e.replies.has(c)).length,
          ]),
        ),
        rows,
        samplesMs: Object.fromEntries(
          [...perKind].map(([k, byTask]) => [
            k,
            Object.fromEntries([...byTask].map(([id, xs]) => [id, xs.map((x) => round(x))])),
          ]),
        ),
      };
    }

    const out = {
      generatedAt: new Date().toISOString(),
      what: 'wall-clock ms from "model reply received" to "edit applied and whole program known to type-check", per accepted set-C edit',
      inputs: {
        replies:
          'actual accepted replies of the set-C collections (results/ai-edit-experiment.c.{sonnet,haiku}-min.json; texts in results/ai-edit-experiment.c.{sonnet,haiku}-min.replies.json); every accepted trial was one-shot, so the timed reply is the first reply',
        tsAndRustProtocol:
          'TypeScript and Rust samples use the structured (line-edit) replies, applied to the 40-function file',
        go: 'no collected replies: hand translations of the reference edits (tools/edit-loop-go.ts), checked against the same acceptance tests before timing; measured once per rep (listed under sonnet)',
        python:
          versions.mypy === null
            ? 'not measured: mypy is not installed on this machine'
            : 'installed but not measured',
      },
      method: {
        reps,
        warmup: 'one discarded round over all sonnet edits and paths',
        interleave:
          'per rep, every task runs every path; the path order rotates by (rep + task slot)',
        perTaskStatistic: 'median of the reps',
        rowStatistics: 'median, p90 (linear interpolation) and sum over the per-task medians',
        warmReset:
          'ts.warm and rust.warm are reset to the original program (untimed) after each sample',
        endToEnd: `DERIVED, not measured: local o200k output tokens of the reply / ${OUTPUT_TOKENS_PER_SECOND} tok/s (assumed output rate) + measured validation median`,
      },
      machine: { versions, platform: `${process.platform} ${process.arch}` },
      load,
      ...report,
    };
    await writeReport('results/edit-loop.json', out);
    for (const m of models) {
      process.stdout.write(`\n${m}\n`);
      for (const r of (report[m] as { rows: Row[] }).rows)
        process.stdout.write(
          `${r.kind.padEnd(16)} n=${r.tasks} median=${r.medianMs}ms p90=${r.p90Ms}ms total=${r.totalMs}ms x${r.medianRatioVsA0Structured} (total x${r.totalRatioVsA0Structured})${r.endToEnd ? ` e2e median=${r.endToEnd.medianMs}ms` : ''}\n`,
        );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
