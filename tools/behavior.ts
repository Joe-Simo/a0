/**
 * Behavior tests, written once and run on every target. The table of small programs is
 * tools/behavior-spec.ts (programs and argument rows, no expected values) and
 * tools/behavior-table.ts (the same rows with the expected values inline). The expected values are
 * never typed: `--regen` takes each from the reference interpreter, requires the independent BigInt
 * oracle (tools/corpus.ts) to give the same value (and the same io output), and writes the file.
 *
 * Execution reuses the machinery of tools/verify.ts (the same `check*` functions, drivers and
 * comparison as the corpus verification) and of the dotnet, Metal and self-hosting tools; nothing
 * here compiles or compares by itself. Each target runs the whole table in one build, so the cost
 * is one toolchain invocation per target, not one per program.
 *
 * A backend that cannot run part of the table says so in SKIPS, with a reason. The skip list is
 * rendered into results/behavior.json as `skipLedger` and as a program-by-target `coverage`
 * matrix; test/behavior.test.ts fails when a program is neither passed nor in the ledger, when the
 * ledger names something that does not exist, and when the checked-in results disagree with it.
 * A target that cannot run here (tool missing) is recorded `blocked`, never as a pass.
 *
 * Usage: bun run behavior [-- --regen | --targets=a,b | --no-write | --probe-skips]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { type CParallel, compile } from '../src/backends.js';
import {
  A0Error,
  isScalar,
  makeIo,
  parseAndValidate,
  run,
  type TypedFunc,
  type TypedProgram,
  type Value,
  validate,
} from '../src/core.js';
import { formatTrap } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { parallelC } from '../src/parallel.js';
import {
  findArmGcc,
  findAvrGcc,
  findClang,
  findClangPlusPlus,
  findQemuRiscv64,
  findQemuSystemArm,
  findRiscv64Gcc,
} from '../src/toolchain.js';
import { BEHAVIOR_SPEC, type BehaviorProgramSpec, type BehaviorRow } from './behavior-spec.js';
import { BEHAVIOR_TABLE } from './behavior-table.js';
import { type Case, oracleRun, oracleToValue } from './corpus.js';
import { checkDotnet } from './dotnet-verify.js';
import { checkMetal } from './gpu-verify.js';
import { writeReport } from './scrub-results.js';
import { selfHostedC } from './selfhost-c.js';
import { checkSelfHostedArm64 } from './selfhost-verify.js';
import {
  checkArm32,
  checkArm64,
  checkAvr,
  checkInterpreter,
  checkJs,
  checkJvm,
  checkNative,
  checkOptimizer,
  checkRiscv64,
  checkWasm,
  checkWasmDirect,
  checkX86_64,
  gccCompilerRow,
  ioCaps,
  type TargetReport,
} from './verify.js';

// --- the skip ledger -------------------------------------------------------------------------

export interface Skip {
  readonly target: string;
  /** A program name of the table, or '*' for every program. */
  readonly program: string;
  /** One function of that program; absent means the whole program. */
  readonly fn?: string;
  readonly reason: string;
}

const NO_IO = (target: string, what: string): Skip => ({
  target,
  program: 'io',
  reason: `${what} refuses io tokens (the backend has no io runtime; the check functions of tools/verify.ts exclude io the same way)`,
});

const SELFHOST_SCALAR =
  'compiler/emit_arm64.a0 is scalar-only: every node of the function and its callees must be u32 or bool';

/**
 * Everything a target does not run, and why. An entry is a coverage gap, never silent: it appears
 * in results/behavior.json and the tests pin this list to the rendered ledger.
 */
/** The strict and checked-op programs of the table: only some targets implement them yet. */
const strictPrograms = (): string[] =>
  BEHAVIOR_SPEC.filter((s) => s.profile === 'strict' || s.checkedOps === true).map((s) => s.name);

/** `target` does not implement `profile strict` (or the checked ops) yet: each such program is skipped. */
const NO_STRICT = (target: string, why: string): Skip[] =>
  strictPrograms().map((program) => ({
    target,
    program,
    reason: `strict profile not yet implemented${why} (a strict program and the checked ops are refused with A0713)`,
  }));

export const SKIPS: readonly Skip[] = [
  {
    target: 'systemverilog',
    program: '*',
    reason:
      'SystemVerilog is validated by `bun run hw` (results/hardware.json) with its own testbench harness; the behavior table is not fanned out to it yet',
  },
  NO_IO('arm64', 'the direct AArch64 backend'),
  NO_IO('x86_64', 'the direct x86-64 backend'),
  NO_IO('riscv64', 'the direct RISC-V backend'),
  NO_IO('avr', 'the AVR backend'),
  NO_IO('arm32', 'the 32-bit ARM backend'),
  NO_IO('metal', 'Metal (a GPU kernel has no io stream)'),
  { target: 'selfhost-arm64', program: 'array', reason: SELFHOST_SCALAR },
  { target: 'selfhost-arm64', program: 'record', reason: SELFHOST_SCALAR },
  { target: 'selfhost-arm64', program: 'text', reason: SELFHOST_SCALAR },
  { target: 'selfhost-arm64', program: 'io', reason: SELFHOST_SCALAR },
  { target: 'selfhost-arm64', program: 'iterate', fn: 'fill_sum', reason: SELFHOST_SCALAR },
  ...NO_STRICT('java', ''),
  ...NO_STRICT('dotnet', ''),
  ...NO_STRICT('wasm-c', ': the freestanding wasm build has no stdio for the trap line'),
  ...NO_STRICT('wasm-direct', ''),
  ...NO_STRICT('arm64', ''),
  ...NO_STRICT('x86_64', ''),
  ...NO_STRICT('riscv64', ''),
  ...NO_STRICT('avr', ''),
  ...NO_STRICT('arm32', ''),
  ...NO_STRICT('metal', ''),
  ...NO_STRICT('selfhost-c', ': compiler/emit_c.a0 does not know it'),
  ...NO_STRICT('selfhost-arm64', ': compiler/emit_arm64.a0 does not know it'),
];

// --- the table --------------------------------------------------------------------------------

export interface TargetDef {
  readonly id: string;
  readonly label: string;
  readonly run: (program: TypedProgram, cases: readonly Case[]) => Promise<TargetReport>;
}

export const TARGETS: readonly TargetDef[] = [
  {
    id: 'interpreter',
    label: 'reference interpreter',
    run: async (p, c) => checkInterpreter(p, c),
  },
  {
    id: 'optimizer',
    label: 'optimized graph (src/optimize.ts)',
    run: async (p, c) => checkOptimizer(p, c),
  },
  { id: 'js', label: 'JavaScript (ES module in Node)', run: checkJs },
  {
    id: 'c-clang',
    label: 'C via clang (UBSan, -Werror)',
    run: (p, c) => checkNative(p, c, findClang(), false, 'native C via clang'),
  },
  {
    id: 'c-gcc',
    label: 'C via the gcc driver',
    run: (p, c) => {
      const row = gccCompilerRow();
      return checkNative(p, c, row.tool, false, row.label);
    },
  },
  {
    id: 'cpp',
    label: 'C-compatible output as C++17 via clang++',
    run: (p, c) =>
      checkNative(p, c, findClangPlusPlus(), true, 'C-compatible output compiled as C++17'),
  },
  {
    id: 'c-parallel',
    label: 'C with automatic parallel folds forced on',
    run: (p, c) =>
      checkNative(
        p,
        c,
        findClang(),
        false,
        'native C via clang with automatic parallel folds forced on',
        compile(p, 'c', {
          ...ioCaps(c),
          cParallel: parallelC({ mode: 'auto', force: true }) as CParallel,
        }).text,
      ),
  },
  { id: 'java', label: 'Java (javac, JVM)', run: checkJvm },
  { id: 'dotnet', label: 'C# (.NET SDK)', run: checkDotnet },
  { id: 'wasm-c', label: 'WebAssembly via clang and wasm-ld', run: checkWasm },
  { id: 'wasm-direct', label: 'WebAssembly from the direct backend', run: checkWasmDirect },
  {
    id: 'arm64',
    label: 'AArch64 assembly (direct backend)',
    run: (p, c) => checkArm64(p, c, findClang()),
  },
  {
    id: 'x86_64',
    label: 'x86-64 assembly (direct backend)',
    run: (p, c) => checkX86_64(p, c, findClang()),
  },
  {
    id: 'riscv64',
    label: 'RISC-V 64 (direct backend, qemu)',
    run: (p, c) => checkRiscv64(p, c, findRiscv64Gcc(), findQemuRiscv64()),
  },
  {
    id: 'avr',
    label: 'AVR (direct backend, simavr)',
    run: (p, c) => checkAvr(p, c, findAvrGcc(), findClang()),
  },
  {
    id: 'arm32',
    label: '32-bit ARM (direct backend, qemu-system-arm)',
    run: (p, c) => checkArm32(p, c, findArmGcc(), findQemuSystemArm()),
  },
  { id: 'metal', label: 'Metal Shading Language on the GPU', run: (p, c) => checkMetal(p, c) },
  {
    id: 'systemverilog',
    label: 'SystemVerilog (see the skip ledger)',
    run: async () => ({ status: 'blocked', cases: 0, detail: 'skipped for every program' }),
  },
  {
    id: 'selfhost-c',
    label: 'C written by compiler/emit_c.a0 (interpreter), built by clang',
    run: async (p, c) => {
      const emitter = (await link('compiler/emit_c.a0', (f) => readFile(f, 'utf8'))).program;
      const emitted = selfHostedC(emitter, p);
      return checkNative(
        p,
        c,
        findClang(),
        false,
        `C from compiler/emit_c.a0 (${emitted.chunks} chunk(s))`,
        emitted.text,
      );
    },
  },
  {
    id: 'selfhost-arm64',
    label: 'AArch64 written by compiler/emit_arm64.a0 (interpreter), assembled by clang',
    run: async (p, c) => {
      const emitter = (await link('compiler/emit_arm64.a0', (f) => readFile(f, 'utf8'))).program;
      const r = await checkSelfHostedArm64(emitter, p, c);
      // The emitter's own refusals are not silent: anything it skipped beyond the ledger fails.
      return r.skipped.length === 0
        ? r
        : {
            ...r,
            status: 'failed',
            detail: `${r.detail}; undeclared skips: ${r.skipped.map((s) => `${s.fn} (${s.reason})`).join(', ')}`,
          };
    },
  },
];

// --- rows, programs and cases --------------------------------------------------------------------

const rowKey = (name: string, fn: string): string => `${name}/${fn}`;

/** The case a table row stands for. */
export function caseOf(row: BehaviorRow): Case {
  return {
    functionName: row.fn,
    args: row.args,
    expected: row.expected,
    ...(row.trap === undefined ? {} : { expectedTrap: row.trap }),
    ...(row.input === undefined ? {} : { input: row.input, expectedOutput: row.output ?? [] }),
  };
}

export function programOf(spec: BehaviorProgramSpec): TypedProgram {
  return parseAndValidate(spec.source);
}

const STRICT_HEAD = 'profile strict\n';

/**
 * All the programs as one namespace, in table order; a name used twice is an error. The
 * profile is program-wide, so a strict program's directive is hoisted: the specs given must
 * agree on it (the table is run as one canonical group and one strict group, `profileGroups`).
 */
export function wholeSource(specs: readonly BehaviorProgramSpec[] = BEHAVIOR_SPEC): string {
  const seen = new Map<string, string>();
  for (const spec of specs)
    for (const fn of programOf(spec).functions) {
      const other = seen.get(fn.name);
      if (other !== undefined)
        throw new Error(`function ${fn.name} is defined by both ${other} and ${spec.name}`);
      seen.set(fn.name, spec.name);
    }
  const strict = specs.filter((s) => s.profile === 'strict').length;
  if (strict !== 0 && strict !== specs.length)
    throw new Error('wholeSource: the programs must all be strict or all canonical');
  const body = specs.map((s) => (strict > 0 ? s.source.slice(STRICT_HEAD.length) : s.source));
  return `${strict > 0 ? STRICT_HEAD : ''}${body.join('')}`;
}

/** The table's programs by profile: the canonical group first, then the strict group. */
export function profileGroups(): {
  profile: 'canonical' | 'strict';
  specs: BehaviorProgramSpec[];
}[] {
  return (['canonical', 'strict'] as const)
    .map((profile) => ({
      profile,
      specs: BEHAVIOR_SPEC.filter((s) => (s.profile ?? 'canonical') === profile),
    }))
    .filter((g) => g.specs.length > 0);
}

export interface RowValue {
  readonly expected: Value;
  readonly output?: readonly number[];
  /** The trap line, when the strict profile traps on this row (the oracle has no traps). */
  readonly trap?: string;
}

/**
 * One row's expected value from the reference interpreter, checked against the BigInt oracle.
 * Throws on any disagreement (value or io output): a table with disagreeing sources is not written.
 */
export function deriveRow(
  fn: TypedFunc,
  args: readonly Value[],
  input: readonly number[] | undefined,
  label: string,
): RowValue {
  const io = fn.params[fn.params.length - 1] === 'io';
  if (io !== (input !== undefined)) throw new Error(`${label}: input words iff a trailing io`);
  if (fn.profile === 'strict') {
    // A trap is the interpreter's own result: the BigInt oracle has no traps, so a row that
    // traps carries the line; a row that does not must still equal the oracle's value.
    try {
      run(fn, io ? [...args, makeIo(input ?? [])] : args);
    } catch (e) {
      if (e instanceof A0Error && e.trap !== undefined && e.code === 'runtime')
        return { expected: 0, trap: formatTrap(e.trap) };
      throw e;
    }
  }
  if (input === undefined) {
    const interp = run(fn, args);
    const oracle = oracleToValue(oracleRun(fn, args));
    if (interp !== oracle) throw new Error(`${label}: interpreter ${interp} vs oracle ${oracle}`);
    return { expected: interp };
  }
  const a = makeIo(input);
  const interp = run(fn, [...args, a]);
  const b = makeIo(input);
  const oracle = oracleToValue(oracleRun(fn, [...args, b]));
  if (interp !== oracle || a.output.join(',') !== b.output.join(','))
    throw new Error(
      `${label}: interpreter ${interp} [${a.output}] vs oracle ${oracle} [${b.output}]`,
    );
  return { expected: interp, output: [...a.output] };
}

/** Every row of the spec with values from the interpreter and the oracle. */
export function deriveTable(
  specs: readonly BehaviorProgramSpec[] = BEHAVIOR_SPEC,
): Record<string, BehaviorRow[]> {
  const out: Record<string, BehaviorRow[]> = {};
  for (const spec of specs) {
    const program = programOf(spec);
    const rows: BehaviorRow[] = [];
    for (const call of spec.calls) {
      const fn = program.byName.get(call.fn);
      if (fn === undefined) throw new Error(`${spec.name}: no function ${call.fn}`);
      if (
        !fn.params.slice(0, fn.params.length - (spec.io ? 1 : 0)).every(isScalar) ||
        !isScalar(fn.result)
      )
        throw new Error(`${rowKey(spec.name, call.fn)}: not driver-callable (scalar signature)`);
      for (const r of call.rows) {
        const v = deriveRow(
          fn,
          r.args,
          r.input,
          `${rowKey(spec.name, call.fn)}(${r.args.join(',')})`,
        );
        rows.push({
          fn: call.fn,
          args: r.args,
          ...(r.input === undefined ? {} : { input: r.input }),
          expected: v.expected,
          ...(v.output === undefined ? {} : { output: v.output }),
          ...(v.trap === undefined ? {} : { trap: v.trap }),
        });
      }
    }
    out[spec.name] = rows;
  }
  return out;
}

const q = (v: unknown): string => JSON.stringify(v).replace(/"/g, "'");

/** The text of tools/behavior-table.ts for a derived table. */
export function renderTable(table: Readonly<Record<string, readonly BehaviorRow[]>>): string {
  const lines = [
    '// GENERATED by `bun run behavior -- --regen` (tools/behavior.ts). Do not edit: every expected value',
    '// comes from the reference interpreter and is confirmed by the BigInt oracle (tools/corpus.ts).',
    "import type { BehaviorRow } from './behavior-spec.js';",
    '',
    'export const BEHAVIOR_TABLE: Readonly<Record<string, readonly BehaviorRow[]>> = {',
  ];
  for (const [name, rows] of Object.entries(table)) {
    lines.push(`  ${name}: [`);
    for (const r of rows)
      lines.push(
        `    { fn: '${r.fn}', args: ${q(r.args)}, ${r.input === undefined ? '' : `input: ${q(r.input)}, `}expected: ${q(r.expected)}${r.output === undefined ? '' : `, output: ${q(r.output)}`}${r.trap === undefined ? '' : `, trap: ${q(r.trap)}`} },`,
      );
    lines.push('  ],');
  }
  lines.push('};', '');
  return lines.join('\n');
}

export function tableSha256(): string {
  return createHash('sha256')
    .update(JSON.stringify(BEHAVIOR_TABLE))
    .update(
      profileGroups()
        .map((g) => wholeSource(g.specs))
        .join('\n'),
    )
    .digest('hex');
}

// --- selection: what a target runs --------------------------------------------------------------

/** The part of a selection that runs under one profile (a program has one profile). */
export interface SelectionGroup {
  readonly profile: 'canonical' | 'strict';
  readonly program: TypedProgram;
  readonly cases: Case[];
}

export interface Selection {
  /** The canonical group's program (the table's strict programs are in `groups`). */
  readonly program: TypedProgram;
  /** Every case of every group. */
  readonly cases: Case[];
  readonly groups: SelectionGroup[];
  /** Per table program: every function ran, only some did, or none did. */
  readonly coverage: Record<string, 'full' | 'partial' | 'none'>;
  /** The ledger entries that applied, plus functions dropped because a callee was skipped. */
  readonly skipped: { program: string; fn?: string; reason: string; derived?: boolean }[];
}

function skipsFor(target: string): Skip[] {
  return SKIPS.filter((s) => s.target === target);
}

/** What `target` runs of the table, after its skip entries. `only` limits the programs (probing). */
export function select(
  target: string,
  options: { only?: readonly string[]; ignoreSkips?: boolean } = {},
): Selection {
  const wholes = profileGroups().map((g) => ({
    profile: g.profile,
    specs: g.specs,
    whole: parseAndValidate(wholeSource(g.specs)),
  }));
  const owner = new Map<string, string>();
  for (const spec of BEHAVIOR_SPEC)
    for (const fn of programOf(spec).functions) owner.set(fn.name, spec.name);
  const skips = options.ignoreSkips === true ? [] : skipsFor(target);
  const dropped = new Map<string, string>();
  const skipped: Selection['skipped'] = [];
  for (const spec of BEHAVIOR_SPEC) {
    if (options.only !== undefined && !options.only.includes(spec.name)) {
      for (const f of programOf(spec).functions) dropped.set(f.name, 'not selected');
      continue;
    }
    for (const s of skips) {
      if (s.program !== '*' && s.program !== spec.name) continue;
      skipped.push({
        program: spec.name,
        ...(s.fn === undefined ? {} : { fn: s.fn }),
        reason: s.reason,
      });
      for (const f of programOf(spec).functions)
        if (s.fn === undefined || s.fn === f.name) dropped.set(f.name, s.reason);
    }
  }
  // A function that calls a dropped one cannot run either (function names are unique table-wide).
  for (let changed = true; changed; ) {
    changed = false;
    for (const { whole } of wholes)
      for (const f of whole.functions) {
        if (dropped.has(f.name)) continue;
        const callee = [...f.calls.keys()].find((c) => dropped.has(c));
        if (callee !== undefined) {
          dropped.set(f.name, `calls skipped function ${callee}`);
          skipped.push({
            program: owner.get(f.name) as string,
            fn: f.name,
            reason: `calls skipped function ${callee}`,
            derived: true,
          });
          changed = true;
        }
      }
  }
  const cases: Case[] = [];
  const groups: SelectionGroup[] = [];
  const coverage: Selection['coverage'] = {};
  for (const { profile, specs, whole } of wholes) {
    const kept = whole.functions.filter((f) => !dropped.has(f.name));
    const program = validate({
      ...(profile === 'strict' ? { profile: 'strict' as const } : {}),
      functions: kept,
    });
    const own: Case[] = [];
    for (const spec of specs) {
      const rows = BEHAVIOR_TABLE[spec.name] ?? [];
      const callable = [...new Set(rows.map((r) => r.fn))];
      const live2 = callable.filter((n) => !dropped.has(n));
      coverage[spec.name] =
        live2.length === callable.length ? 'full' : live2.length === 0 ? 'none' : 'partial';
      for (const r of rows) if (!dropped.has(r.fn)) own.push(caseOf(r));
    }
    cases.push(...own);
    groups.push({ profile, program, cases: own });
  }
  const canonical = groups.find((g) => g.profile === 'canonical');
  return { program: (canonical as SelectionGroup).program, cases, groups, coverage, skipped };
}

// --- running -------------------------------------------------------------------------------------

export interface TargetResult {
  readonly id: string;
  readonly label: string;
  readonly status: 'passed' | 'failed' | 'blocked' | 'skipped';
  readonly cases: number;
  readonly detail: string;
  readonly tool?: string | undefined;
  readonly elapsedMs: number;
  readonly failures?: string[] | undefined;
  /** Per program: passed, partial (some functions skipped), skipped, blocked or failed. */
  readonly programs: Record<string, 'passed' | 'partial' | 'skipped' | 'blocked' | 'failed'>;
}

/** One report for the profile groups of a target: failed beats blocked beats passed. */
function mergeReports(reports: readonly TargetReport[]): TargetReport {
  const first = reports[0] as TargetReport;
  if (reports.length === 1) return first;
  const status = reports.some((r) => r.status === 'failed')
    ? 'failed'
    : reports.some((r) => r.status === 'blocked')
      ? 'blocked'
      : first.status;
  return {
    status,
    cases: reports.reduce((n, r) => n + r.cases, 0),
    detail: first.detail,
    tool: first.tool,
    elapsedMs: reports.reduce((n, r) => n + (r.elapsedMs ?? 0), 0),
    failures: reports.flatMap((r) => r.failures ?? []),
  };
}

export async function runTarget(def: TargetDef): Promise<TargetResult> {
  const start = performance.now();
  const sel = select(def.id);
  const programs = (status: 'passed' | 'blocked' | 'failed'): TargetResult['programs'] =>
    Object.fromEntries(
      Object.entries(sel.coverage).map(([name, c]) => [
        name,
        c === 'none'
          ? 'skipped'
          : c === 'partial'
            ? status === 'passed'
              ? 'partial'
              : status
            : status,
      ]),
    );
  if (sel.cases.length === 0)
    return {
      id: def.id,
      label: def.label,
      status: 'skipped',
      cases: 0,
      detail: 'every program is in the skip ledger',
      elapsedMs: 0,
      programs: programs('passed'),
    };
  const reports: TargetReport[] = [];
  for (const g of sel.groups) {
    if (g.cases.length === 0) continue;
    try {
      reports.push(await def.run(g.program, g.cases));
    } catch (e) {
      reports.push({
        status: 'failed',
        cases: 0,
        detail: 'the check threw',
        failures: [e instanceof Error ? (e.stack ?? e.message) : String(e)],
      });
    }
  }
  const report = mergeReports(reports);
  const status =
    report.status === 'passed' ? 'passed' : report.status === 'blocked' ? 'blocked' : 'failed';
  let perProgram = programs(status);
  if (status === 'failed' && report.failures !== undefined) {
    // Attribute the failure: a program is failed when one of its functions appears in a failure line.
    const failed = new Set<string>();
    for (const spec of BEHAVIOR_SPEC)
      for (const call of spec.calls)
        if (report.failures.some((f) => f.startsWith(`${call.fn}(`))) failed.add(spec.name);
    if (failed.size > 0)
      perProgram = Object.fromEntries(
        Object.entries(perProgram).map(([name, st]) => [
          name,
          st === 'skipped' ? st : failed.has(name) ? 'failed' : 'passed',
        ]),
      );
  }
  return {
    id: def.id,
    label: def.label,
    status,
    cases: report.cases,
    detail: report.detail,
    tool: report.tool,
    elapsedMs: Math.round(report.elapsedMs ?? performance.now() - start),
    failures: report.failures,
    programs: perProgram,
  };
}

export interface BehaviorReport {
  readonly generatedAt: string;
  readonly node: string;
  readonly platform: string;
  readonly table: {
    readonly programs: number;
    readonly functions: number;
    readonly rows: number;
    readonly sha256: string;
    readonly oracle: string;
  };
  readonly programs: { name: string; about: string; rows: number }[];
  readonly summary: Record<'passed' | 'failed' | 'blocked' | 'skipped', number>;
  readonly targets: TargetResult[];
  /** Explicit coverage gaps: every (target, program[, function]) the table does not run, and why. */
  readonly skipLedger: Skip[];
  readonly coverage: Record<string, Record<string, TargetResult['programs'][string]>>;
}

export function summarize(targets: readonly TargetResult[]): BehaviorReport['summary'] {
  const s = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const t of targets) s[t.status] += 1;
  return s;
}

export function buildReport(targets: readonly TargetResult[]): BehaviorReport {
  const rows = Object.values(BEHAVIOR_TABLE).reduce((n, r) => n + r.length, 0);
  return {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    table: {
      programs: BEHAVIOR_SPEC.length,
      functions: profileGroups().reduce(
        (n, g) => n + parseAndValidate(wholeSource(g.specs)).functions.length,
        0,
      ),
      rows,
      sha256: tableSha256(),
      oracle:
        'expected values: reference interpreter, confirmed by the independent BigInt oracle (tools/corpus.ts) when the table was generated',
    },
    programs: BEHAVIOR_SPEC.map((s) => ({
      name: s.name,
      about: s.about,
      rows: (BEHAVIOR_TABLE[s.name] ?? []).length,
    })),
    summary: summarize(targets),
    targets: [...targets],
    skipLedger: [...SKIPS],
    coverage: Object.fromEntries(targets.map((t) => [t.id, t.programs] as const)),
  };
}

/** Problems with the ledger and the table themselves, before anything runs. */
export function validateLedger(): string[] {
  const problems: string[] = [];
  const ids = new Set(TARGETS.map((t) => t.id));
  const names = new Map(BEHAVIOR_SPEC.map((s) => [s.name, programOf(s)] as const));
  const seen = new Set<string>();
  for (const s of SKIPS) {
    const key = `${s.target}|${s.program}|${s.fn ?? ''}`;
    if (seen.has(key)) problems.push(`duplicate skip ${key}`);
    seen.add(key);
    if (!ids.has(s.target)) problems.push(`skip names unknown target ${s.target}`);
    if (s.reason.trim().length < 20) problems.push(`skip ${key} has no real reason`);
    if (s.program !== '*') {
      const p = names.get(s.program);
      if (p === undefined) problems.push(`skip ${key} names unknown program`);
      else if (s.fn !== undefined && !p.byName.has(s.fn))
        problems.push(`skip ${key} names unknown function`);
    }
  }
  for (const spec of BEHAVIOR_SPEC)
    if ((BEHAVIOR_TABLE[spec.name] ?? []).length === 0)
      problems.push(`program ${spec.name} has no rows in tools/behavior-table.ts (run --regen)`);
  return problems;
}

// --- main ----------------------------------------------------------------------------------------

async function regen(): Promise<void> {
  const table = deriveTable();
  const path = join('tools', 'behavior-table.ts');
  await writeFile(path, renderTable(table), 'utf8');
  const biome = spawnSync(join('node_modules', '.bin', 'biome'), ['format', '--write', path], {
    encoding: 'utf8',
  });
  if (biome.status !== 0) throw new Error(`biome format failed: ${biome.stderr}`);
  const rows = Object.values(table).reduce((n, r) => n + r.length, 0);
  process.stdout.write(`wrote ${path}: ${Object.keys(table).length} programs, ${rows} rows\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--regen')) return regen();
  const problems = validateLedger();
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  const only = args
    .find((a) => a.startsWith('--targets='))
    ?.slice(10)
    .split(',');
  const defs = TARGETS.filter((t) => only === undefined || only.includes(t.id));
  if (args.includes('--probe-skips')) {
    // Run each skipped (target, program) with the skip ignored: a skip that now passes is stale.
    for (const s of SKIPS) {
      const def = TARGETS.find((t) => t.id === s.target);
      if (
        def === undefined ||
        s.program === '*' ||
        (only !== undefined && !only.includes(s.target))
      )
        continue;
      const sel = select(s.target, { only: [s.program], ignoreSkips: true });
      const parts: TargetReport[] = [];
      for (const g of sel.groups.filter((x) => x.cases.length > 0))
        parts.push(
          await def.run(g.program, g.cases).catch(
            (e: unknown): TargetReport => ({
              status: 'failed',
              cases: 0,
              detail: e instanceof Error ? e.message : String(e),
            }),
          ),
        );
      const r = mergeReports(parts);
      // A check that drops what it cannot run (io on the direct backends) reports fewer cases than
      // it was given: that is the skip still in force, not a pass.
      const ran = r.status === 'passed' && r.cases >= sel.cases.length;
      process.stdout.write(
        `${s.target.padEnd(16)} ${s.program.padEnd(10)} ${s.fn ?? ''} -> ${r.status}, ${r.cases} of ${sel.cases.length} cases${ran ? ' (skip is stale: remove it)' : ''}\n`,
      );
    }
    return;
  }
  const results: TargetResult[] = [];
  for (const def of defs) {
    const r = await runTarget(def);
    results.push(r);
    process.stdout.write(
      `${r.id.padEnd(16)} ${r.status.padEnd(8)} ${String(r.cases).padStart(5)} cases  ${String(r.elapsedMs).padStart(6)} ms  ${r.detail.slice(0, 90)}\n`,
    );
    for (const f of r.failures?.slice(0, 5) ?? []) process.stdout.write(`    ${f.slice(0, 400)}\n`);
  }
  const report = buildReport(results);
  if (!args.includes('--no-write') && only === undefined) {
    await mkdir('results', { recursive: true });
    await writeReport(join('results', 'behavior.json'), report);
  }
  process.stdout.write(
    `behavior: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.blocked} blocked, ${report.summary.skipped} skipped; ${SKIPS.length} skip entries in the ledger\n`,
  );
  process.exit(report.summary.failed > 0 ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
